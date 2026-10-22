// 规则服务：可切换的多套指令集。
//
// 一条规则是一份提示词正文加一个写入文件（AGENTS.md 或 CLAUDE.md）。激活做两件事：
// 把正文写进 `$DSH_HOME/<写入文件>`，并让 systemPrompt 段实时读到它。
//
// 两条通道都要，因为作用方式不同：写盘那一路会被宿主当用户全局指令加载，但受字节
// 预算限制；直接注入是无条件的，但只作用于提示词层。
//
// 存储（v2）：
//   breaklimit/rules.json           清单：规则元数据、激活态、落点快照、版本号
//   breaklimit/bodies/<id>.md       规则正文
//   breaklimit/landings/<target>.txt 激活前的原文（原字节，仅当那个文件本来就有内容）
//
// 落点与快照一律按字节处理：文本解码会把非 UTF-8 字节换成 U+FFFD，拿解码结果写回
// 就毁了原文。写入前比字节，内容没变就不重写；读失败（权限、占用）与「文件不存在」
// 严格分开，前者一律停手报错，不当成空文件处理。
//
// 落点的处置一律基于**激活那一刻的快照**，不基于当前元数据。快照记两件事：这个
// 文件是插件创建的（created），还是本来就有内容（原文存进 landings）。由此三种终态：
// 被外部改过就原样保留；我们创建的就删掉；本来就有的就写回原内容。
//
// 写序与互斥（#4 #6）：
//   落点正文可能被外部改动，而清单只有一个入口。所以写落点之前先把激活意图写进
//   清单（active/landing + pendingActivation 标记），落点写成功再清掉标记；任何一步
//   失败都回滚，绝不留下「落点已换、清单说没激活」。五个写入口都在同一把跨进程锁内
//   完成「读清单 → 改 → 写清单」，清单另有 revision 递增做第二道版本校验。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  atomicWrite,
  atomicWriteBytes,
  decodeUtf8,
  hashBytes,
  hashText,
  readBytesStrict,
} from '../patch/fsx.js'
import { acquireFileLock, releaseFileLock } from '../patch/lock.js'
import { breaklimitDir } from '../patch/state.js'

export const RULE_TARGETS = ['AGENTS.md', 'CLAUDE.md']
export const MAX_RULE_BYTES = 512 * 1024
export const INDEX_VERSION = 2

// 规则 id 同时是磁盘上的文件名，字符集因此收得比较窄：首字符字母或数字，其余只允许
// 字母、数字、点、下划线、连字符。这里写成显式判断而不是一条把长度编进量词的正则，
// 是为了让「长度上限」和「字符集」分成两件事读——它们约束的来源本来就不同。
const RULE_ID_MAX = 64
const RULE_ID_CHARS_RE = /^[a-zA-Z0-9._-]*$/

// 名字是给人看的展示文本，不落成文件名，所以不和 id 共用上限：id 受文件名约束，
// 名字只受展示约束，这里给得更宽。截断按码点计数而不是按 UTF-16 单元，否则 emoji
// 这类非 BMP 字符会被 slice 切成半个代理对，写进清单就是一个坏字符。
const NAME_LIMIT = 96

// 锁事务 id 与临时文件名的去重计数：同一毫秒内的连续调用不能撞名。
let lockSequence = 0
let writeSequence = 0

export function rulesIndexPath(home) {
  return path.join(breaklimitDir(home), 'rules.json')
}

/** 兼容旧名：激活态现在存在 rules.json 里。 */
export function rulesStatePath(home) {
  return rulesIndexPath(home)
}

export function bodiesDir(home) {
  return path.join(breaklimitDir(home), 'bodies')
}

export function landingsDir(home) {
  return path.join(breaklimitDir(home), 'landings')
}

export function ruleTextPath(home, id) {
  return path.join(bodiesDir(home), `${id}.md`)
}

export function landingPath(home, target) {
  if (!isValidTarget(target)) throw new Error(`目标文件名非法：${String(target)}`)
  return path.join(landingsDir(home), target)
}

/** 规则 id 同时是文件名，只允许字母开头的一小段安全字符。 */
export function isValidRuleId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > RULE_ID_MAX) return false
  if (!/[a-zA-Z0-9]/.test(id[0])) return false
  return RULE_ID_CHARS_RE.test(id.slice(1))
}

export function isValidTarget(target) {
  return typeof target === 'string' && RULE_TARGETS.includes(target)
}

/** 写入文件：`$DSH_HOME/<target>`。 */
export function targetPath(home, target) {
  if (!isValidTarget(target)) throw new Error(`目标文件名非法：${String(target)}`)
  return path.join(home, target)
}

function messageOf(error) {
  return String(error?.message ?? error)
}

/**
 * 结构化失败。`reason` 与 `message` 同值：HTTP 路由与宿主命令都读 `reason`，
 * 新调用方读 `code` 分流。
 */
function failure(code, message, extra = {}) {
  return { ok: false, code, message, reason: message, ...extra }
}

function corruptIndexFailure() {
  return failure('index_corrupt', '规则清单已损坏，插件已停止写入以保护原数据')
}

/** 清单不可用（损坏或读不到）时的统一守卫。读失败当成空清单正是整表替换的起点。 */
function indexUnusableFailure(index) {
  if (index.kind === 'corrupt') return corruptIndexFailure()
  if (index.kind === 'unreadable') {
    return failure('index_unreadable', `规则清单读不到，插件已停止写入以保护原数据：${index.error ?? '未知读取错误'}`)
  }
  return null
}

/** 清单版本冲突：读写之间有人改过 rules.json。 */
function conflictError() {
  const error = new Error('规则清单在读写之间被改动，本次写入已取消')
  error.code = 'conflict'
  return error
}

/**
 * 在规则锁内跑一段同步临界区。锁被占用时立即返回结构化失败，不排队。
 *
 * 锁文件与补丁事务共用 `$DSH_HOME/breaklimit/operation.lock`：两边改的是同一个
 * DSH_HOME，互相排斥本来就是对的。
 *
 * @param {string} home - $DSH_HOME。
 * @param {string} operation - 操作名，进事务 id 便于排查。
 * @param {() => object} run - 同步临界区。
 */
function withRulesLock(home, operation, run) {
  lockSequence += 1
  const operationId = `rules-${operation}-${process.pid.toString(36)}-${String(lockSequence)}`
  let handle
  try {
    handle = acquireFileLock(home, operationId)
  } catch (error) {
    return failure('locked', `获取规则锁失败：${messageOf(error)}`)
  }
  if (handle === null || typeof handle !== 'object' || handle.conflict !== undefined) {
    const holder = handle?.conflict?.holder ?? null
    const who = holder === null
      ? '另一个操作'
      : `另一个操作（${String(holder.operationId ?? '未知事务')}，pid ${String(holder.pid ?? '未知')}）`
    return failure('locked', `规则正在被${who}占用，本次操作已取消`)
  }
  try {
    return run()
  } finally {
    releaseFileLock(handle)
  }
}

/**
 * 元数据归一，**只服务读取路径**：非法 target 回落到 `RULE_TARGETS[0]`，一份带坏字段的
 * 旧清单仍能读出来（见 `readIndex`）。
 *
 * 写入路径不许靠这里兜底：`saveRule` / `activateRule` 用 `hasInvalidTarget` 拒绝，否则
 * 调用方以为写到了 `CLAUDE.md` 或某个指定文件，实际被静默改写成 `AGENTS.md`。
 */
function normalizeMeta(id, meta) {
  const rawName = meta?.name
  const name = typeof rawName === 'string' && rawName.trim() !== ''
    ? [...rawName.trim()].slice(0, NAME_LIMIT).join('')
    : id
  const target = isValidTarget(meta?.target) ? meta.target : RULE_TARGETS[0]
  return { name, target }
}

/** 写入路径的判定：没给 target 不算非法（沿用旧值或回落），给了但不是允许的文件才算。 */
function hasInvalidTarget(meta) {
  return meta !== null
    && typeof meta === 'object'
    && meta.target !== undefined
    && !isValidTarget(meta.target)
}

/** 写入路径遇到非法 target 的结构化失败；读取路径不返回它。 */
function invalidTargetFailure(target) {
  return failure(
    'invalid_target',
    `非法 target：${String(target)}；只能是 ${RULE_TARGETS.join(' / ')}。`,
  )
}

/** writtenHash 的持久化格式：`hashBytes` 的完整输出（`sha256:<64 位十六进制>`）。 */
const WRITTEN_HASH_RE = /^sha256:[0-9a-f]{64}$/u

/**
 * 落点快照。字段不全或类型不对时返回 null——读不出来就当没有，保守处理。
 *
 * `writtenHash` 是我们写进落点的字节哈希，比对「落点还是不是我们写的」以它为基线。
 * 旧清单没有这个字段、或值不是合法摘要，一律解析成 null：基线编不出来，比对退回
 * 与活正文比较的旧行为。
 */
function normalizeLanding(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isValidTarget(raw.target)) return null
  if (typeof raw.created !== 'boolean') return null
  return {
    target: raw.target,
    created: raw.created,
    writtenHash: WRITTEN_HASH_RE.test(raw.writtenHash) ? raw.writtenHash : null,
  }
}

/**
 * 未提交的激活意图。字段不全就返回 null——读不出意图时按「没有未完成激活」处理，
 * 落点处置仍然只看 landings 快照，不靠意图推断。
 */
function normalizePending(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isValidRuleId(raw.id) || !isValidTarget(raw.target)) return null
  const previous = raw.previous !== null && typeof raw.previous === 'object'
    ? { id: raw.previous.id ?? null, landing: normalizeLanding(raw.previous.landing) }
    : null
  return {
    id: raw.id,
    target: raw.target,
    created: raw.created === true,
    snapshot: raw.snapshot === true,
    previous,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
  }
}

function emptyIndex() {
  return { version: INDEX_VERSION, revision: 0, rules: [], active: null, landing: null, pendingActivation: null }
}

/**
 * 读清单。文件缺失、损坏、版本不符一律退回空清单：偏好坏了不该让插件不可用。
 * 「读不到」（权限、占用、句柄耗尽）单独报 `unreadable` 并带上原因：它与「文件
 * 不存在」只差一步，混同就会让调用方把读失败当成空清单整表替换掉。
 *
 * `revision` 是写入版本号，缺省按 0 读；`pendingActivation` 是未提交的激活意图，
 * 只用于诊断与恢复，处置落点时不用它。
 *
 * `invalidTargets` 是读取期的诊断，不进清单：记录 target 非法、被回落成 `AGENTS.md`
 * 的那些规则。列表照常展示（清单坏了不该让插件不可用），但 `activateRule` 拿它拒绝
 * 激活——按回落值写盘就是静默改写。
 *
 * @param {string} home - $DSH_HOME。
 * @returns {{ version: number, revision: number,
 *   rules: Array<{id:string,name:string,target:string,activatedAt:string|null}>,
 *   active: string | null, landing: object | null, pendingActivation: object | null,
 *   invalidTargets: Array<{ id: string, target: unknown }>,
 *   kind: 'ok' | 'absent' | 'corrupt' | 'unreadable' }}
 */
export function readIndex(home) {
  const raw = readBytesStrict(rulesIndexPath(home))
  if (raw.kind === 'unreadable') {
    return { ...emptyIndex(), invalidTargets: [], kind: 'unreadable', error: messageOf(raw.error) }
  }
  if (raw.kind === 'missing') return { ...emptyIndex(), invalidTargets: [], kind: 'absent' }
  let parsed
  try {
    // 不是合法 UTF-8 的字节解码成替换字符后也可能凑出合法 JSON（名字乱码但结构还在），
    // 所以先严格解码：解不开就按损坏处理，停写保护。
    const text = decodeUtf8(raw.bytes)
    if (text === null) throw new Error('不是合法 UTF-8')
    parsed = JSON.parse(text)
  } catch {
    return { ...emptyIndex(), invalidTargets: [], kind: 'corrupt' }
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== INDEX_VERSION) {
    return { ...emptyIndex(), invalidTargets: [], kind: 'corrupt' }
  }
  const revision = Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0
  const seen = new Set()
  const invalidTargets = []
  const rules = []
  for (const entry of Array.isArray(parsed.rules) ? parsed.rules : []) {
    const id = entry?.id
    if (!isValidRuleId(id) || seen.has(id)) continue
    seen.add(id)
    const meta = normalizeMeta(id, entry)
    if (hasInvalidTarget(entry)) invalidTargets.push({ id, target: entry.target })
    rules.push({
      id,
      name: meta.name,
      target: meta.target,
      activatedAt: typeof entry?.activatedAt === 'string' ? entry.activatedAt : null,
    })
  }
  const active = isValidRuleId(parsed.active) && seen.has(parsed.active) ? parsed.active : null
  return {
    version: INDEX_VERSION,
    revision,
    rules,
    active,
    landing: normalizeLanding(parsed.landing),
    pendingActivation: normalizePending(parsed.pendingActivation),
    invalidTargets,
    kind: 'ok',
  }
}

/**
 * 写清单，带版本校验。
 *
 * 期望版本与实际不符时抛 `code='conflict'`，一个字节都不写。校验发生在临时文件
 * 落盘之后、改名之前：窗口尽量窄。这不是原子的比较交换，同进程并发靠锁挡住；
 * 这一层挡的是不守锁的写者（手工编辑、另一个版本的工具）。
 *
 * @param {string} home - $DSH_HOME。
 * @param {object} index - 新清单内容。
 * @param {number} [expectedRevision] - 读到的版本号；缺省时按当前版本自增。
 * @param {object} [options] - 写入选项。
 * @param {boolean} [options.allowCorruptOverwrite] - 是否允许覆写损坏的清单（仅恢复流程可用）。
 * @returns {number} 写入后的版本号。
 */
function writeIndex(home, index, expectedRevision, { allowCorruptOverwrite = false } = {}) {
  const current = readIndex(home)
  if (current.kind === 'unreadable') {
    const error = new Error(`规则清单读不到，插件已停止写入以保护原数据：${current.error ?? '未知读取错误'}`)
    error.code = 'index_unreadable'
    throw error
  }
  if (current.kind === 'corrupt' && !allowCorruptOverwrite) {
    const error = new Error('规则清单已损坏，插件已停止写入以保护原数据')
    error.code = 'index_corrupt'
    throw error
  }
  const file = rulesIndexPath(home)
  const revision = expectedRevision === undefined
    ? current.revision + 1
    : expectedRevision + 1
  const payload = {
    version: INDEX_VERSION,
    revision,
    rules: index.rules,
    active: index.active ?? null,
    // 落点归属不跟 active 绑定：删除激活中的规则时落点可能没法处置，此时 active 已清空
    // 而 landing 要留着，否则 `landings/<target>.txt` 失去唯一入口（#5 同类问题）。
    // 需要清空归属的入口（取消激活、正常删除、重置）显式写 null。
    landing: index.landing ?? null,
    pendingActivation: index.pendingActivation ?? null,
  }
  writeSequence += 1
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.bkl-${process.pid.toString(36)}-${Date.now().toString(36)}-${String(writeSequence)}.tmp`,
  )
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    if (expectedRevision !== undefined && readIndex(home).revision !== expectedRevision) {
      throw conflictError()
    }
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // 清理失败不盖住原始错误。
    }
    throw error
  }
  return revision
}

/** 把 writeIndex 的抛出翻成调用方读的失败形状。 */
function indexWriteFailure(error, what, extra = {}) {
  if (error?.code === 'conflict') {
    return failure('conflict', `${what}失败：${messageOf(error)}`, extra)
  }
  if (error?.code === 'index_unreadable' || error?.code === 'index_corrupt') {
    return failure(error.code, `${what}失败：${messageOf(error)}`, extra)
  }
  return failure('index_write_failed', `${what}失败：${messageOf(error)}`, extra)
}

/**
 * 读激活态。
 *
 * `landing` 是激活那一刻的落点快照；没有它时必须选择「不动落点」，而不是按元数据
 * 推断——推断正是这一整类问题的来源。
 *
 * `id` 为 null 时 `landing` 仍可能非空：删除激活中的规则、落点又没被处置时，归属留在
 * 清单里，快照还能从这里找到（`landingPath(home, landing.target)`）。
 */
export function readActiveState(home) {
  const index = readIndex(home)
  return { id: index.active, landing: index.landing }
}

/** 当前激活的规则 id；没有或读不出则为 null。 */
export function readActive(home) {
  return readIndex(home).active
}

export function readRuleMeta(home, id) {
  const entry = readIndex(home).rules.find(rule => rule.id === id)
  return normalizeMeta(id, entry ?? {})
}

/** 列出全部规则，含大小与激活态。 */
export function listRules(home) {
  const index = readIndex(home)
  return index.rules
    .map((rule) => {
      let bytes = 0
      try {
        bytes = fs.statSync(ruleTextPath(home, rule.id)).size
      } catch {
        // 正文缺失时 size 记 0，规则仍然列出，便于用户看到并修。
      }
      return { id: rule.id, name: rule.name, target: rule.target, bytes, active: index.active === rule.id }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function readRule(home, id) {
  if (!isValidRuleId(id)) return { ok: false, code: 'invalid_id', reason: `非法规则 id：${id}` }
  const raw = readBytesStrict(ruleTextPath(home, id))
  if (raw.kind === 'missing') return { ok: false, code: 'rule_missing', reason: `规则不存在：${id}` }
  if (raw.kind === 'unreadable') {
    return { ok: false, code: 'rule_unreadable', reason: `规则正文读不到：${id}`, error: messageOf(raw.error) }
  }
  const text = decodeUtf8(raw.bytes)
  if (text === null) return { ok: false, code: 'rule_unreadable', reason: `规则正文不是合法 UTF-8：${id}` }
  return { ok: true, text }
}

/** 当前激活规则的正文；没有则为空串。 */
export function activeRuleText(home) {
  const id = readActive(home)
  if (id === null) return ''
  const loaded = readRule(home, id)
  return loaded.ok ? loaded.text : ''
}

/**
 * 当前激活规则的正文；读不到则为 `null`。
 *
 * 与 `activeRuleText` 的差别是这里区分「正文是空串」和「正文看不到」：`settleLanding`
 * 收到 `null` 表示无法确认落点里的内容归谁，收到空串表示我们写进去的就是空文件。
 * 判定用 `readRule().ok`，不看字符串真假值。
 */
function activeRuleTextOrNull(home) {
  const id = readActive(home)
  if (id === null) return null
  const loaded = readRule(home, id)
  return loaded.ok ? loaded.text : null
}

/**
 * 保存（新建或覆盖）一条规则。
 *
 * 正在激活的规则同步落点之前先读落点当前字节，与**我们写进落点的字节哈希**
 * （`index.landing.writtenHash`）比对：一致才同步（`landingSynced`）；不一致说明落点
 * 被外部改过，跳过同步、保留外部内容（`landingStale`）。旧清单记录没有 writtenHash
 * 时退回拿保存前的旧正文比对（旧正文读不出来同样按不确定处理）。哈希基线的意义：
 * 一次同步失败（正文与清单已写新、落点还是旧的）之后，下一次保存仍认得出落点里是
 * 我们写的内容，能接着同步，不会永久卡在 stale。
 *
 * 同步成功后把新的字节哈希随清单持久化；哈希记录写不进去就把落点退回同步前的字节，
 * 保住「哈希与落点内容同进退」，同样不制造永久 stale。
 *
 * 激活中的规则落点不迁移：正文写进 `index.landing` 记录的落点（物理事实），返回的
 * `meta.target` 报实际生效的落点；与请求的 target 不一致时 `landingMoved` 为 true
 * （语义：本次保存请求的落点与实际生效落点不同）。
 *
 * @returns {{ ok: true, id: string, meta: { name: string, target: string },
 *   landingSynced: boolean, landingStale: boolean, landingMoved: boolean, revision: number }
 *   | { ok: false, code: string, message: string, reason: string }}
 */
export function saveRule(home, id, text, meta) {
  if (!isValidRuleId(id)) return { ok: false, reason: `非法规则 id：${id}` }
  if (typeof text !== 'string') return { ok: false, reason: '正文必须是字符串' }
  if (Buffer.byteLength(text, 'utf8') > MAX_RULE_BYTES) {
    return { ok: false, reason: `正文超过上限 ${String(MAX_RULE_BYTES)} 字节，未做截断` }
  }
  if (hasInvalidTarget(meta)) return invalidTargetFailure(meta.target)
  return withRulesLock(home, 'save', () => saveRuleLocked(home, id, text, meta))
}

function saveRuleLocked(home, id, text, meta) {
  const index = readIndex(home)
  const unusable = indexUnusableFailure(index)
  if (unusable !== null) return unusable
  const existing = index.rules.find(rule => rule.id === id)
  const normalized = normalizeMeta(id, meta ?? existing ?? {})
  const previousBody = readRule(home, id)
  const previousText = previousBody.ok ? previousBody.text : null

  try {
    fs.mkdirSync(bodiesDir(home), { recursive: true })
    atomicWrite(ruleTextPath(home, id), text)
  } catch (error) {
    return failure('body_write_failed', `写入正文失败：${messageOf(error)}`, {
      bodyWritten: false,
      indexWritten: false,
      landingSynced: false,
    })
  }

  const entry = {
    id,
    name: normalized.name,
    target: normalized.target,
    activatedAt: existing?.activatedAt ?? null,
  }
  const rules = existing === undefined
    ? [...index.rules, entry]
    : index.rules.map(rule => (rule.id === id ? entry : rule))
  let revision
  try {
    revision = writeIndex(home, { ...index, rules }, index.revision)
  } catch (error) {
    return indexWriteFailure(error, '写入清单', {
      bodyWritten: true,
      indexWritten: false,
      landingSynced: false,
    })
  }

  // 激活中的规则落点不迁移：正文写进 index.landing 记录的落点（物理事实），返回的
  // meta.target 也报它；请求的 target 与实际生效落点不一致时 landingMoved 为 true。
  const effectiveTarget = index.active === id
    ? (index.landing?.target ?? normalized.target)
    : normalized.target

  // 正在激活的规则被改正文时，同步落点；顺序是「清单 → 落点」，因为这一步失败留下
  // 的是「清单已记新正文、落点仍是旧的」，下一次保存或取消激活能看到并处理。
  let landingSynced = false
  let landingStale = false
  if (index.active === id) {
    const current = readTargetState(home, effectiveTarget)
    if (current.kind === 'unreadable') {
      // 读不到落点就不同步、也不判「被改过」：把事实报出去，内容一个字节不动。
      return failure('landing_unreadable', `写入文件读不到，未做同步：${messageOf(current.error)}`, {
        bodyWritten: true,
        indexWritten: true,
        landingSynced: false,
      })
    }
    // 「我们写进落点的是什么」以 writtenHash 为基线。活正文当基线时，一次同步失败后
    // 正文与落点分了家，之后每次保存都判「被改过」，永远恢复不了。
    const writtenHash = index.landing?.writtenHash ?? null
    const previousBytes = previousText === null ? null : Buffer.from(previousText, 'utf8')
    const unchanged = current.kind === 'ok' && (writtenHash === null
      ? previousBytes !== null && current.bytes.equals(previousBytes)
      : hashBytes(current.bytes) === writtenHash)
    if (unchanged) {
      const nextBytes = Buffer.from(text, 'utf8')
      if (!current.bytes.equals(nextBytes)) {
        try {
          atomicWriteBytes(targetPath(home, effectiveTarget), nextBytes)
        } catch (error) {
          return failure('landing_write_failed', `同步写入文件失败：${messageOf(error)}`, {
            bodyWritten: true,
            indexWritten: true,
            landingSynced: false,
          })
        }
      }
      // 同步成功才把新的字节哈希写进清单：哈希先落盘、落点后写的话，落点一失败基线
      // 就指着没写进去的内容，比对从此对不上。
      if (index.landing !== null) {
        try {
          revision = writeIndex(home, {
            ...index,
            rules,
            landing: { ...index.landing, writtenHash: hashBytes(nextBytes) },
          }, revision)
        } catch (error) {
          // 哈希记录写不进去就把落点退回同步前的字节：writtenHash 与落点内容必须同
          // 进退，否则下一次保存会把我们自己写的内容误判成外部改动，永久 stale。
          const landingRestored = restoreLanding(home, effectiveTarget, current.bytes)
          return indexWriteFailure(error, '记录落点内容哈希', {
            bodyWritten: true,
            indexWritten: true,
            landingSynced: false,
            landingRestored,
          })
        }
      }
      landingSynced = true
    } else {
      landingStale = true
    }
  }
  return {
    ok: true,
    id,
    meta: { name: normalized.name, target: effectiveTarget },
    landingSynced,
    landingStale,
    landingMoved: effectiveTarget !== normalized.target,
    revision,
  }
}

/**
 * 读落点当前内容（字节级）。missing / unreadable / ok 三态分开：「读不到」绝不能
 * 当成「文件不存在」，否则插件会把一个看不见的文件当自己创建的，既不留快照，
 * 撤销时还会把它删掉。
 */
function readTargetState(home, target) {
  return readBytesStrict(targetPath(home, target))
}

/** 已经算好的内容摘要（如 `landing.writtenHash`）：直接截短成指纹，不重算。 */
function prehashed(digest) {
  return { digest }
}

/**
 * 落点内容指纹（sha256 前 16 位）。用于告诉用户「被改动」到底差在哪：
 * `expected` 是插件认为该文件应当有的内容，`actual` 是它现在的内容。
 * 文本拿不到就记 null，不编一个哈希出来。
 */
function fingerprint(value) {
  const digest = value !== null && typeof value === 'object' && !Buffer.isBuffer(value)
    && typeof value.digest === 'string'
    ? value.digest
    : typeof value === 'string'
      ? hashText(value)
      : Buffer.isBuffer(value)
        ? hashBytes(value)
        : null
  if (digest === null) return null
  // hashText/hashBytes 同格式：同一内容的文本与字节表示给出同一个值，两侧可比。
  // 只要十六进制那段的前 16 位。
  return digest.replace(/^sha256:/u, '').slice(0, 16)
}

/** 一条跳过记录。原因与两侧指纹一起报，用户据此判断是不是自己改的。 */
function skipEntry(file, reason, expected, actual) {
  return { path: file, reason, expected: fingerprint(expected), actual: fingerprint(actual) }
}

/**
 * 处置一个落点快照。
 *
 * 「落点内容还是不是我们写的」以 `landing.writtenHash`（写进落点的字节哈希）为基线；
 * 旧清单记录没有它时退回拿 `ourText`（活正文）比对。判定与报出去的 expected 指纹
 * 都跟基线走。
 *
 * @param {string} home - $DSH_HOME。
 * @param {{ target: string, created: boolean, writtenHash?: string | null } | null} landing - 快照。
 * @param {string | null} ourText - 旧记录（无 writtenHash）的比对基线：我们认为落点里应当是的正文。
 * @returns {{ removed: boolean, restored: boolean,
 *   skipped: Array<{ path: string, reason: string, expected: string | null, actual: string | null }> }}
 */
function settleLanding(home, landing, ourText) {
  const result = { removed: false, restored: false, skipped: [] }
  if (landing === null) return result
  const file = targetPath(home, landing.target)
  const current = readTargetState(home, landing.target)
  const ourBytes = typeof ourText === 'string' ? Buffer.from(ourText, 'utf8') : null
  const writtenHash = landing.writtenHash ?? null
  const expected = writtenHash === null ? ourText : prehashed(writtenHash)

  if (current.kind === 'unreadable') {
    // 读不到就什么都不动：它可能还在、也可能已被改动，两种都不许推断。
    result.skipped.push(skipEntry(file, '当前内容读不到，保留原样', expected, null))
    return result
  }
  if (current.kind === 'missing') {
    // 落点已经不在了：插件创建的视为达成，别人删的不认领。
    if (landing.created) result.removed = true
    return result
  }
  const currentBytes = current.bytes
  const ours = writtenHash === null
    ? ourBytes !== null && currentBytes.equals(ourBytes)
    : hashBytes(currentBytes) === writtenHash
  if (!ours) {
    // 两侧都记：用户能看到插件写进去的是什么、现在是什么。
    result.skipped.push(skipEntry(file, '内容已被改动，保留原样', expected, currentBytes))
    return result
  }
  if (landing.created) {
    try {
      fs.rmSync(file, { force: true })
      result.removed = true
    } catch {
      // 删除失败与内容无关：没有「应当是什么」可比，只报现状。
      result.skipped.push(skipEntry(file, '删除失败', null, currentBytes))
    }
    return result
  }
  const before = readBytesStrict(landingPath(home, landing.target))
  if (before.kind !== 'ok') {
    // 原文丢了或读不到就绝不覆盖，报出来让人处理。
    result.skipped.push(skipEntry(
      file,
      before.kind === 'missing' ? '找不到激活前的原文，保留现状' : '激活前的原文读不到，保留现状',
      null,
      currentBytes,
    ))
    return result
  }
  try {
    atomicWriteBytes(file, before.bytes)
    fs.rmSync(landingPath(home, landing.target), { force: true })
    result.restored = true
  } catch {
    // 写回失败：expected 是没写成功的那份原文，actual 是落点当前内容。
    result.skipped.push(skipEntry(file, '写回原文失败', before.bytes, currentBytes))
  }
  return result
}

/**
 * landings/ 里的带时间戳副本名：`<target>.<用途>-<时间戳>-<pid>-<序号>.txt`。
 * 与快照同目录；不与 landings/<target>.txt 抢入口。
 */
function landingCopyPath(home, target, purpose) {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  writeSequence += 1
  return path.join(
    landingsDir(home),
    `${target}.${purpose}-${stamp}-${process.pid.toString(36)}-${String(writeSequence)}.txt`,
  )
}

/**
 * 外部改动副本：把即将被激活覆盖、又不在任何插件副本里的字节存一份。
 * 与快照同目录；名字带目标名与时间戳，不与 landings/<target>.txt 抢入口。
 */
function writeExternalCopy(home, target, bytes) {
  fs.mkdirSync(landingsDir(home), { recursive: true })
  const file = landingCopyPath(home, target, 'external')
  atomicWriteBytes(file, bytes)
  return file
}

/**
 * 孤儿快照保留副本：landings/<target> 有快照、归属却不在（index.landing 指向别处或
 * 已清空）时，把它搬成带时间戳的副本，再让新快照进 canonical 路径。那份孤儿快照是
 * 「某个落点首次接管前原文」的唯一副本，被新快照冲掉就永久丢了。
 */
function keepOrphanSnapshot(home, target) {
  fs.mkdirSync(landingsDir(home), { recursive: true })
  const file = landingCopyPath(home, target, 'kept')
  fs.renameSync(landingPath(home, target), file)
  return file
}

/** 删除本次刚写的落点快照；没写就什么都不做。 */
function discardSnapshot(home, target, written) {
  if (!written) return
  try {
    fs.rmSync(landingPath(home, target), { force: true })
  } catch {
    // 删不掉就留着：它记的正是落点原来的内容，多一份不是丢失。
  }
}

/** 把落点恢复成写之前的内容：原来没有文件就删掉，有就按原字节写回。 */
function restoreLanding(home, target, existing) {
  try {
    const file = targetPath(home, target)
    if (existing === null) fs.rmSync(file, { force: true })
    else atomicWriteBytes(file, existing)
    return true
  } catch {
    return false
  }
}

/** 回滚清单。失败时调用方要如实报出来，不能装作回滚成功。 */
function rollbackIndex(home, previousIndex, expectedRevision) {
  try {
    writeIndex(home, previousIndex, expectedRevision)
    return true
  } catch {
    return false
  }
}

/**
 * 激活一条规则：写激活意图 → 写落点 → 提交意图。
 *
 * 顺序不能倒。落点先写，清单写失败时落点已是新正文而 active 是 null，
 * `landings/<target>.txt` 就失去唯一入口，用户原文永久不可恢复（#4）。先写意图，
 * 任何一步失败都能回滚到「落点原样、清单原样」；进程在中间被杀也留得下
 * `active`/`landing` 与 `pendingActivation`，恢复入口不丢。
 *
 * 接管新落点之前先处置上一条激活规则的落点，否则 A@AGENTS 切到 B@CLAUDE 会把 A 的
 * 正文永久留在 AGENTS.md 里。
 *
 * 同落点切换时，`landings/<target>.txt` 保存的是**插件第一次接管该落点时的原文**：
 * 只要这份快照还在就沿用，不拿当前落点内容覆盖它。返回值里的 `snapshotKept` 说明
 * 本次是否沿用了已有快照，供上层把提示语说准。没归属的孤儿快照（切换落点时旧落点
 * 被判 skipped，快照失去归属）不被新快照冲掉：先搬成带时间戳的保留副本，路径从
 * 返回值的 `keptCopy` 报出。
 *
 * 激活会覆盖落点上的外部改动（这就是激活的语义），但不丢字节：被覆盖的内容不属于
 * 任何插件副本（≠ 新正文、≠ 快照原文、≠ 上一条激活规则的正文）时，先存副本再覆盖，
 * 路径从返回值的 `externalCopy` 报出；副本写不出来就取消激活，宁可不覆盖。
 */
export function activateRule(home, id) {
  if (!isValidRuleId(id)) return { ok: false, reason: `非法规则 id：${id}` }
  return withRulesLock(home, 'activate', () => activateRuleLocked(home, id))
}

function activateRuleLocked(home, id) {
  const index = readIndex(home)
  const unusable = indexUnusableFailure(index)
  if (unusable !== null) return unusable
  const loaded = readRule(home, id)
  if (!loaded.ok) return loaded
  // 清单里这条的 target 非法、读取时回落成 AGENTS.md：按回落值激活就是静默改写。
  const badTarget = index.invalidTargets.find(item => item.id === id)
  if (badTarget !== undefined) return invalidTargetFailure(badTarget.target)
  const entry = index.rules.find(rule => rule.id === id)
  const meta = normalizeMeta(id, entry ?? {})
  const file = targetPath(home, meta.target)
  const previous = index.active === null ? null : { id: index.active, landing: index.landing }

  // 同一条规则、同一个落点：保留最初的快照。若在这里重新记一次，取消激活就会把
  // 我们刚写进去的正文当成「用户原有内容」恢复回去。
  const sameRuleSameTarget = index.active === id
    && index.landing !== null
    && index.landing.target === meta.target

  let previousLanding = { removed: false, restored: false, skipped: [] }
  if (!sameRuleSameTarget && index.active !== null) {
    // 同一条规则换落点时正文刚从磁盘读出来，直接用它；否则读激活中那条的正文。
    const previousText = index.active === id ? loaded.text : activeRuleTextOrNull(home)
    previousLanding = settleLanding(home, index.landing, previousText)
  }

  const existingState = readTargetState(home, meta.target)
  if (existingState.kind === 'unreadable') {
    // 落点读不到就整件事不做：快照存不了、内容比不了，写下去就是盲覆盖。
    return failure('landing_unreadable', `写入文件读不到，激活已取消：${messageOf(existingState.error)}`)
  }
  const existing = existingState.kind === 'ok' ? existingState.bytes : null

  // 落点仍归插件管、快照也还在：这份快照记的是插件第一次接管该落点时的原文。
  // 此时不能拿当前落点内容覆盖它——用户手改过落点，再激活另一条到同一落点，就会把
  // 第一次激活前的原文从插件目录里彻底冲掉。正常切换走到这里时 settleLanding 已经把
  // 原文写回落点并删掉快照，读不到快照，仍按下面的流程记新的。
  //
  // `active` 为 null 但 `landing` 还在，是「删除激活规则时落点没被处置」留下的归属：
  // 快照归这个落点，重新激活到同一落点时同样不能覆盖它。
  const slotOwned = !sameRuleSameTarget
    && index.landing !== null
    && index.landing.target === meta.target
  const snapshotState = readBytesStrict(landingPath(home, meta.target))
  if (snapshotState.kind === 'unreadable') {
    // 快照读不到就停：这时任何写入都可能让「唯一一份原文」失去恢复路径。
    return failure('snapshot_unreadable', `激活前原文快照读不到，激活已取消：${messageOf(snapshotState.error)}`)
  }
  const snapshotKept = slotOwned && snapshotState.kind === 'ok'
  const nextBytes = Buffer.from(loaded.text, 'utf8')
  // writtenHash：我们写进落点的字节哈希。内容本就一致、没重写也算——落点里就是它。
  const writtenHash = hashBytes(nextBytes)
  const landing = sameRuleSameTarget || snapshotKept
    ? { ...index.landing, writtenHash }
    : { target: meta.target, created: existing === null, writtenHash }
  let snapshotWritten = false
  let keptCopy = null
  if (!sameRuleSameTarget && !snapshotKept && existing !== null) {
    // canonical 路径上若有快照却没归属（slotOwned 为 false），它是孤儿：切换落点时
    // 旧落点被判 skipped，丢掉归属的「首次接管前原文」唯一副本。先搬成保留副本再写
    // 新快照，不许拿新快照把它冲掉；搬不走就取消激活，宁可不写。
    if (snapshotState.kind === 'ok') {
      try {
        keptCopy = keepOrphanSnapshot(home, meta.target)
      } catch (error) {
        return failure('snapshot_failed', `保留无归属的旧快照失败，激活已取消：${messageOf(error)}`)
      }
    }
    try {
      fs.mkdirSync(landingsDir(home), { recursive: true })
      atomicWriteBytes(landingPath(home, meta.target), existing)
      snapshotWritten = true
    } catch (error) {
      return failure('snapshot_failed', `保存激活前原文失败：${messageOf(error)}`, { keptCopy })
    }
  }

  const rules = index.rules.map(rule => (rule.id === id
    ? { ...rule, activatedAt: new Date().toISOString() }
    : rule))
  const intent = {
    ...index,
    rules,
    active: id,
    landing,
    pendingActivation: {
      id,
      target: meta.target,
      created: landing.created,
      snapshot: snapshotWritten,
      previous,
      startedAt: new Date().toISOString(),
    },
  }

  let intentRevision
  try {
    intentRevision = writeIndex(home, intent, index.revision)
  } catch (error) {
    // 意图没落盘，落点还没动。本次快照没有主人，删掉。
    discardSnapshot(home, meta.target, snapshotWritten)
    return indexWriteFailure(error, '写入激活意图', { keptCopy })
  }

  // 被覆盖的字节不在任何插件副本里时先存副本（见 activateRule 的 doc）。
  let externalCopy = null
  if (existing !== null && !existing.equals(nextBytes)) {
    const covered = []
    // 本次刚写的快照存的就是现有字节；沿用的快照记的是首次接管时的原文。
    if (snapshotWritten) covered.push(existing)
    else if (snapshotState.kind === 'ok') covered.push(snapshotState.bytes)
    const previousText = index.active === null ? null : activeRuleTextOrNull(home)
    if (previousText !== null) covered.push(Buffer.from(previousText, 'utf8'))
    if (!covered.some(bytes => bytes.equals(existing))) {
      try {
        externalCopy = writeExternalCopy(home, meta.target, existing)
      } catch (error) {
        const rolledBack = rollbackIndex(home, index, intentRevision)
        discardSnapshot(home, meta.target, snapshotWritten)
        const note = rolledBack ? '' : '；清单回滚失败，激活意图仍留在 pendingActivation'
        return failure('external_copy_failed', `保存落点外部改动副本失败，激活已取消：${messageOf(error)}${note}`, { rolledBack, keptCopy })
      }
    }
  }
  try {
    // 内容没变就不重写：重写看似无害，但落点可能是非 UTF-8 的旧文件，文本往返
    // 一次字节就毁了；字节相等时写与不写对宿主完全等价。
    if (existing === null || !existing.equals(nextBytes)) atomicWriteBytes(file, nextBytes)
  } catch (error) {
    const rolledBack = rollbackIndex(home, index, intentRevision)
    discardSnapshot(home, meta.target, snapshotWritten)
    const note = rolledBack ? '' : '；清单回滚失败，激活意图仍留在 pendingActivation'
    return failure('landing_write_failed', `写入 ${file} 失败：${messageOf(error)}${note}`, { rolledBack, keptCopy })
  }

  let revision
  try {
    revision = writeIndex(home, { ...intent, pendingActivation: null }, intentRevision)
  } catch (error) {
    // 落点已经是新正文。先恢复落点，再决定动不动清单：顺序反了就会留下
    // 「落点已改、清单说没激活」，这正是 #4 要消灭的状态。
    const landingRestored = restoreLanding(home, meta.target, existing)
    if (error?.code === 'conflict') {
      // 外部写者改过清单。读回来看 pendingActivation 还是不是本次意图：是就撤销这次
      // 激活意图（只动本次激活写进清单的字段，不覆盖外部写者的其他改动）；不是就
      // 不再碰它，把真实状态（当前激活是谁、落点已还原）原样报出去。
      const now = readIndex(home)
      const intentStillOurs = now.kind === 'ok'
        && now.pendingActivation !== null
        && now.pendingActivation.id === id
        && now.pendingActivation.target === meta.target
      const rolledBack = intentStillOurs
        ? rollbackIndex(home, {
            ...now,
            rules: now.rules.map(rule => (rule.id === id
              ? { ...rule, activatedAt: index.rules.find(item => item.id === id)?.activatedAt ?? null }
              : rule)),
            active: index.active,
            landing: index.landing,
            pendingActivation: null,
          }, now.revision)
        : false
      // activeNow 是处置之后的真实激活态：回滚成功就是复原后的值，否则是外部写者留下的值。
      const activeNow = rolledBack ? index.active : (now.kind === 'ok' ? now.active : null)
      let note
      if (rolledBack) note = '；清单里的激活意图已撤销，状态已复原'
      else if (now.kind !== 'ok') note = '；清单当前不可用，无法回滚，落点已还原'
      else if (intentStillOurs) note = `；清单回滚失败，激活意图仍留在 pendingActivation；当前激活：${activeNow ?? '无'}，落点已还原`
      else note = `；清单已被外部改动，未回滚；当前激活：${activeNow ?? '无'}，落点已还原`
      return failure('conflict', `提交激活失败：${messageOf(error)}${note}`, {
        landingRestored,
        rolledBack,
        activeNow,
      })
    }
    const rolledBack = landingRestored && rollbackIndex(home, index, intentRevision)
    const note = rolledBack ? '' : '；清单回滚失败，激活意图仍留在 pendingActivation'
    return failure(
      'index_write_failed',
      `提交激活失败：${messageOf(error)}${note}`,
      { landingRestored, rolledBack },
    )
  }

  return {
    ok: true,
    id,
    name: meta.name,
    target: meta.target,
    file,
    bytes: Buffer.byteLength(loaded.text, 'utf8'),
    created: landing.created,
    previousLanding,
    snapshotKept,
    externalCopy,
    keptCopy,
    revision,
  }
}

/**
 * 取消激活：按快照把落点还原到激活前的样子。
 *
 * 落点内容被改过（`settleLanding` 报了 skipped）时不注销记录：快照与所有权都留着，
 * 否则 `landings/<target>.txt` 失去入口，用户原文再没有恢复路径（#5）。返回值里的
 * `kept` 说明记录是否保留，`active` 是操作后的真实状态。
 *
 * 没有激活规则、清单里却还留着落点归属（删除时落点没被处置）时，取消激活也不清它：
 * 这时没有激活态可注销，清掉归属只会让快照重新变成孤儿。
 */
export function deactivateRule(home) {
  return withRulesLock(home, 'deactivate', () => {
    const index = readIndex(home)
    const unusable = indexUnusableFailure(index)
    if (unusable !== null) return unusable
    const skipped = []
    let settlement = { removed: false, restored: false, skipped: [] }
    if (index.active !== null) {
      settlement = settleLanding(home, index.landing, activeRuleTextOrNull(home))
      skipped.push(...settlement.skipped)
    }
    const kept = index.active !== null && skipped.length > 0
    const landingKept = kept || index.active === null ? index.landing : null
    let revision
    try {
      revision = writeIndex(home, {
        ...index,
        active: kept ? index.active : null,
        landing: landingKept,
        pendingActivation: null,
      }, index.revision)
    } catch (error) {
      return indexWriteFailure(error, '取消激活')
    }
    return {
      ok: true,
      active: kept,
      kept,
      previous: index.active,
      landingKept,
      removed: settlement.removed,
      restored: settlement.restored,
      skipped,
      revision,
    }
  })
}

/**
 * 删除一条规则；删的是激活中的那条时先按快照处置落点。
 *
 * 落点没被处置（被外部改过、找不到原文、删不掉）时，规则照删，但 `landing` 归属留在
 * 清单里（此时 `active` 已是 null）：否则 `landings/<target>.txt` 留在盘上却没有任何
 * 入口读得到它。这与取消激活的 `kept` 是同一套语义：`kept` 说明归属是否保留，
 * `skipped` 原样报出，`landingKept` 是仍记在清单里的那份归属。
 */
export function deleteRule(home, id) {
  if (!isValidRuleId(id)) return { ok: false, reason: `非法规则 id：${id}` }
  return withRulesLock(home, 'delete', () => {
    const index = readIndex(home)
    const unusable = indexUnusableFailure(index)
    if (unusable !== null) return unusable
    const wasActive = index.active === id
    const settlement = wasActive
      ? settleLanding(home, index.landing, activeRuleTextOrNull(home))
      : { removed: false, restored: false, skipped: [] }
    const kept = wasActive && settlement.skipped.length > 0
    const landingKept = kept ? index.landing : null
    const rules = index.rules.filter(rule => rule.id !== id)
    let revision
    try {
      // 先改清单再删正文：正文删掉、清单没写进去才是孤儿文件。
      revision = writeIndex(home, {
        ...index,
        rules,
        active: wasActive ? null : index.active,
        // 没处置掉就保留归属；其余照旧：删的是激活规则则清空，不是激活规则就不动。
        landing: wasActive && !kept ? null : index.landing,
        pendingActivation: index.pendingActivation?.id === id ? null : (index.pendingActivation ?? null),
      }, index.revision)
    } catch (error) {
      return indexWriteFailure(error, '删除规则')
    }
    try {
      fs.rmSync(ruleTextPath(home, id), { force: true })
    } catch (error) {
      return failure('body_remove_failed', `清单已更新，但正文删除失败：${messageOf(error)}`, { revision })
    }
    return {
      ok: true,
      id,
      kept,
      landing: wasActive ? settlement : null,
      landingKept,
      skipped: settlement.skipped,
      removed: settlement.removed,
      restored: settlement.restored,
      revision,
    }
  })
}

/**
 * 清空全部规则。激活中的那条先按快照处置落点，再写空清单、删正文。
 *
 * 这里不保留激活记录：规则本身要全删掉，留下一条指向已删规则的记录没有恢复意义。
 * 被改过的落点快照仍然留在 landings/ 里，文件本身也保持原样。
 */
export function resetRules(home) {
  return withRulesLock(home, 'reset', () => {
    const index = readIndex(home)
    const unusable = indexUnusableFailure(index)
    if (unusable !== null) return unusable
    const skipped = []
    if (index.active !== null) {
      const settlement = settleLanding(home, index.landing, activeRuleTextOrNull(home))
      skipped.push(...settlement.skipped)
    }
    try {
      writeIndex(home, emptyIndex(), index.revision)
    } catch (error) {
      return indexWriteFailure(error, '清空规则')
    }
    let removed = 0
    for (const rule of index.rules) {
      try {
        fs.rmSync(ruleTextPath(home, rule.id), { force: true })
        removed += 1
      } catch {
        // 删不掉就留着，清单已经清空，下次保存会覆盖。
      }
    }
    return { ok: true, removed, skipped, active: null }
  })
}

/**
 * 首轮收拢。
 *
 * 写入文件里已有内容、却还没有任何规则时，把它导入成 default 并激活：一份已经存在的
 * AGENTS.md 不该因为装了插件就失去作用。只读写入文件、只写插件自己的目录；内容与落点
 * 字节一致时不重写落点，非 UTF-8 的落点跳过收拢、原样保留（见 skipped）。
 */
export function ensureInitialState(home) {
  const index = readIndex(home)
  if (index.kind === 'corrupt') return { active: null, imported: null, corrupt: true }
  if (index.kind === 'unreadable') {
    return { active: null, imported: null, error: `规则清单读不到，已跳过收拢：${index.error ?? '未知读取错误'}` }
  }
  if (index.rules.length > 0) return { active: index.active, imported: null, skipped: [] }
  const skipped = []
  for (const target of RULE_TARGETS) {
    const state = readTargetState(home, target)
    if (state.kind === 'unreadable') {
      // 读失败不是「没有文件」：不收拢、也不碰下一个落点，把事实如实报出去。
      return { active: null, imported: null, error: `写入文件读不到，已跳过收拢：${target}`, skipped }
    }
    if (state.kind === 'missing') continue
    const text = decodeUtf8(state.bytes)
    if (text === null) {
      // 非 UTF-8 的旧文件（GBK、UTF-16）照原样留着：收拢会把它解码成替换字符写回，
      // 原字节与快照一起毁掉。不导入、不激活、不动它一个字节。
      skipped.push({ target, reason: 'not_utf8', message: '内容不是合法 UTF-8，已跳过收拢，文件保持原样' })
      continue
    }
    if (text.trim() === '') continue
    const id = 'default'
    const saved = saveRule(home, id, text, { name: '默认规则', target })
    if (!saved.ok) return { active: null, imported: null, error: saved.reason, skipped }
    const activated = activateRule(home, id)
    return { active: activated.ok ? id : null, imported: id, skipped }
  }
  return { active: null, imported: null, skipped }
}

/**
 * 恢复损坏的规则清单：将损坏的 rules.json 备份到 $DSH_HOME/dsh-breaklimit-backup/<时间戳>/rules.json，
 * 校验字节一致后，重置为空清单结构。
 *
 * @param {string} home - $DSH_HOME。
 * @returns {{ ok: true, backupPath: string, backupBytes: number, rulesIndex: 'ok' }
 *   | { ok: false, code: string, message: string, reason: string }}
 */
export function recoverCorruptIndex(home) {
  return withRulesLock(home, 'recover', () => {
    const current = readIndex(home)
    if (current.kind !== 'corrupt') {
      return failure('index_not_corrupt', '规则清单未损坏，无需恢复')
    }
    const file = rulesIndexPath(home)
    if (!fs.existsSync(file)) {
      return failure('index_missing', '规则清单文件不存在')
    }
    let original
    try {
      original = fs.readFileSync(file)
    } catch (error) {
      return failure('stat_failed', `读取原清单信息失败：${messageOf(error)}`)
    }

    // 目录名用本地时间：用户是照着自己看到的时间去磁盘上找的，UTC 会差一个时区，
    // 明明刚点完却看到一个几小时前的目录名。日期与时刻之间留一个连字符，8 位数字
    // 和 6 位数字连写会读不出切分点。
    const now = new Date()
    const pad = value => String(value).padStart(2, '0')
    const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const backupRoot = path.join(home, 'dsh-breaklimit-backup')
    let backupDir = null
    let backupFile

    try {
      fs.mkdirSync(backupRoot, { recursive: true })
      const preferred = path.join(backupRoot, stamp)
      try {
        fs.mkdirSync(preferred)
        backupDir = preferred
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        backupDir = fs.mkdtempSync(`${preferred}-`)
      }
      backupFile = path.join(backupDir, 'rules.json')
      fs.copyFileSync(file, backupFile, fs.constants.COPYFILE_EXCL)
      if (!fs.readFileSync(backupFile).equals(original)) {
        throw new Error('备份字节与原清单不符')
      }
      if (!fs.readFileSync(file).equals(original)) {
        throw new Error('原清单在备份期间被改动')
      }
    } catch (error) {
      try {
        if (backupDir !== null) fs.rmSync(backupDir, { recursive: true, force: true })
      } catch {
        // 清理失败不盖住原始错误。
      }
      return failure('backup_failed', `备份原清单失败：${messageOf(error)}`)
    }

    try {
      writeIndex(home, emptyIndex(), undefined, { allowCorruptOverwrite: true })
    } catch (error) {
      return failure('reset_failed', `重置空清单失败：${messageOf(error)}`)
    }

    return {
      ok: true,
      backupPath: backupFile,
      backupBytes: original.length,
      rulesIndex: 'ok',
    }
  })
}
