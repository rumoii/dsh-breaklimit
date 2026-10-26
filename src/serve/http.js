// HTTP 适配层；路由、响应与宿主挂载前缀保持兼容。
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describePatches } from '../patch/index.js'
import { knownPatchIds, readDisabled, setPatchEnabled } from '../patch/patch-selection.js'
import { resolveHome } from '../patch/state.js'
import { atomicWrite, sizeOf } from '../patch/fsx.js'
import { revertPatches } from '../patch/transaction.js'
import { applySelectedPatches } from '../patch/service.js'
import { userInjectPath, maxInjectBytes, readInject } from '../context/inject-file.js'
import { resolveHostRoot } from '../host/host-root.js'
import { buildStatus, savedMessage } from '../host/status.js'
import { promptMode, readMode, readModeExtension } from '../context/prompt.js'
import { switchTier, resolveBudgets } from '../host/capabilities.js'
import * as rules from '../context/rules.js'
import * as tiers from '../context/tiers.js'
import { readMasks, writeMasks, masksPath, MAX_MASKS, MAX_MASK_TERM } from '../host/masks.js'
import * as update from '../context/update.js'

export const ROUTE_PREFIX = '/breaklimit'

// 请求体上限由它所承载的最大载荷推导，HTTP 层不另立数字，也不设不随载荷变化的固定
// 封顶——一旦封顶，调大规则正文上限就不再抬高清求体上限，合法正文会被 413 挡在门外。
//
// 转义余量按最坏情况算：JSON 字符串里的控制字符展开成 `\u00XX`，1 个 UTF-8 字节占
// 6 个 ASCII 字符。信封余量盖住 id、name、target 与括号，实测 3.1 MB 的请求体里它只占
// 62 字节。
const JSON_ESCAPE_MAX = 6
const ENVELOPE_BYTES = 64 * 1024

/** 承载 payloadBytes 字节载荷所需的请求体上限。 */
export function bodyLimitFor(payloadBytes) {
  return payloadBytes * JSON_ESCAPE_MAX + ENVELOPE_BYTES
}

const TOO_LARGE = 'too_large'

// Host 栅栏与 sec-fetch-site 判定。
//
// 宿主的认证只覆盖 `frontend-static` 与 `/api`：挂在 `/breaklimit` 前缀上的路由
// 在 `match()` 阶段直接交给 handler，不经过登录校验。单靠下面 isSameOrigin 也
// 挡不住 DNS rebinding——页面在 evil.example 下时浏览器天然发出 host 与 origin
// 一致的请求，第三项检查永远通过。这里补上宿主对 `/api` 用的另外两项。
const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]']
const HOST_NOT_ALLOWED = 'host_not_allowed'
const CROSS_SITE = 'cross_site'
// 500 只回 code：细节进宿主日志，响应体不带路径与原始 message。
const INTERNAL_MESSAGE = '内部错误，细节已写入宿主日志。'
const WRITE_FAILED_MESSAGE = '写入失败，细节已写入宿主日志。'

/**
 * 拆 `Host` 头或名单项：`{ name, port }`，`port` 为 null 表示没带端口。
 * `127.0.0.1:3081`、`[::1]:3081` 与裸主机名都在这里归一。名字统一小写，
 * 端口只认数字。解析不了返回 null——宁可拒，不猜。
 */
function parseAuthority(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (text === '') return null
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end === -1) return null
    const name = text.slice(0, end + 1)
    const rest = text.slice(end + 1)
    if (rest === '') return { name, port: null }
    if (!rest.startsWith(':')) return null
    const port = rest.slice(1)
    return /^\d{1,5}$/.test(port) ? { name, port } : null
  }
  const colon = text.lastIndexOf(':')
  if (colon === -1) return { name: text, port: null }
  const name = text.slice(0, colon)
  const port = text.slice(colon + 1)
  if (name === '' || /^\d{1,5}$/.test(port) === false) return null
  return { name, port }
}

/**
 * `allowedHosts` 解析。名单项可以带端口：不带端口匹配该主机的任意端口，带端口
 * 则要求端口相同。非字符串与解析不了的项直接丢弃；一条都不剩就退回默认回环名单
 * ——退回的方向是更严，不会把谁悄悄放进来。
 */
function allowedHostsFrom(config) {
  const configured = config?.allowedHosts
  const specs = []
  if (Array.isArray(configured)) {
    for (const item of configured) {
      const parsed = parseAuthority(item)
      if (parsed !== null) specs.push(parsed)
    }
  }
  if (specs.length > 0) return { specs, explicit: true }
  return { specs: DEFAULT_ALLOWED_HOSTS.map((item) => parseAuthority(item)), explicit: false }
}

function hostAllowed(value, specs) {
  const host = parseAuthority(value)
  if (host === null) return false
  return specs.some((spec) => spec.name === host.name && (spec.port === null || spec.port === host.port))
}

/**
 * 名单外的 Host 一律 403。默认名单生效时把配置要求写进 message：宿主绑定在非
 * 回环地址时，界面与 API 都只能靠显式配置 `allowedHosts` 进来，不能静默放行。
 */
function hostRejectionMessage(value, explicit) {
  const seen = typeof value === 'string' && value.trim() !== '' ? value.trim() : '（缺失）'
  if (explicit) return `Host ${seen} 不在 allowedHosts 名单内。`
  return `Host ${seen} 不在默认回环名单内（127.0.0.1、localhost、[::1]）。宿主绑定在非回环地址时必须显式配置 allowedHosts。`
}

/** `cross-site` 一律拒；缺失与 same-origin / same-site / none 放行。 */
function isCrossSite(req) {
  const site = req.headers?.['sec-fetch-site']
  return typeof site === 'string' && site.trim().toLowerCase() === 'cross-site'
}

function logInternal(code, error) {
  const detail = String(error?.stack ?? error?.message ?? error)
  process.stderr.write(`[breaklimit] ${code}: ${detail}\n`)
}

function isSameOrigin(req, method) {
  const origin = req.headers.origin
  const host = req.headers.host
  const isWrite = method !== 'GET' && method !== 'HEAD'
  if (origin === undefined) return isWrite === false
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 读请求体。超过 `limit` 时拒收，并在错误上打 `too_large` 标记，让路由层回 413 而不是
 * 把它当成内部错误——超限是调用方可以修正的处境，不是本方的故障。上限由调用方按本次
 * 装载的配置算出，见 createHandler。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', (chunk) => {
      if (rejected) return
      size += chunk.length
      if (size > limit) {
        rejected = true
        const error = new Error(`正文超过 ${String(limit)} 字节上限`)
        error.code = TOO_LARGE
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 统一响应外壳。校验失败 400，目标漂移与并发冲突 409，其余内部失败 500。 */
function envelope(status, code, message, data) {
  const ok = status >= 200 && status < 300
  const body = { ok, code, message }
  if (data !== undefined) body.data = data
  if (typeof data?.operationId === 'string') body.operationId = data.operationId
  return { status, body }
}

function parseJsonBody(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ? null : parsed
  } catch {
    return null
  }
}

// 引擎结果到 HTTP 状态的映射。冲突与内部失败的区分不是措辞问题：前者是调用方
// 可以修正的处境（并发、漂移），后者是本方自己的问题（写不进磁盘、记录损坏），
// 把它们都压成 400 会让真正的故障看起来像用户的输入错误。
const CONFLICT_CODES = new Set(['operation_in_progress', 'drift_detected', 'recovery_required'])
const INTERNAL_CODES = new Set(['apply_failed', 'revert_failed', 'state_corrupt', 'state_version_mismatch', 'io_failed'])

function redactDetails(value, knownPaths = []) {
  if (typeof value === 'string') {
    const exact = knownPaths.reduce((text, file) => redactPathInText(text, file), value)
    return redactPathsInText(exact)
  }
  if (Array.isArray(value)) return value.map(item => redactDetails(item, knownPaths))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDetails(item, knownPaths)]))
  }
  return value
}

export function redactStatusDiagnostics(status, home) {
  return redactDetails(status.diagnostics, [
    status.hostRoot,
    status.inject?.file,
    status.lock?.file,
    status.rulesIndexPath,
    masksPath(home),
  ])
}

function fromOperation(result) {
  // 失败结果的 message / error 里会带 errno 文案的绝对路径，出网前统一脱敏。
  // 状态码与 code 不动：调用方靠它们分流，不靠文案。
  const view = redactDetails(result)
  if (result.ok === true) return envelope(200, result.code, view.message, view)
  if (CONFLICT_CODES.has(result.code)) return envelope(409, result.code, view.message, view)
  if (INTERNAL_CODES.has(result.code)) return envelope(500, result.code, view.message, view)
  return envelope(400, result.code, view.message, view)
}

// 规则域失败到 HTTP 状态的映射。并发冲突（规则锁被占用 locked、清单 revision 冲突
// conflict）与清单损坏（index_corrupt）是「换个时机重试或先恢复」的处境，报 409；
// 输入类失败与其余失败保持 400。只让状态码如实分类，信封 code 沿各路由原样：save 与
// recover-corrupt 透传失败 code，activate / delete / reset 统一回 rule_invalid
// （index_corrupt 除外，保留原 code），并发冲突在这些路由上同样以 409 报出。
const RULE_CONFLICT_CODES = new Set(['locked', 'conflict', 'index_corrupt'])

function rulesFailureStatus(code) {
  return RULE_CONFLICT_CODES.has(code) ? 409 : 400
}

/** 从当前进程的命令行还原一条可以直接粘贴的重启命令。 */
function restartCommand() {
  const origin = process.argv
  if (!Array.isArray(origin) || origin.length === 0) return null
  const quote = (text) => (/\s/.test(text) ? `"${text}"` : text)
  return origin.map(quote).join(' ')
}

// HTTP 边界脱敏。
//
// 绝对路径在本机使用者手里是必要信息：`--status` 与终端输出要指明改的是哪棵树、注入的
// 是哪个文件。但同一份数据出现在 HTTP 响应里就是另一回事——挂在 `/breaklimit` 前缀上的
// 路由在宿主认证之外（见上文 Host 栅栏），任何能连到该端口的进程都能读到盘符、用户名与
// 目录层级。所以脱敏放在这一层做，不放进 `buildStatus`：那是 CLI 与终端共用的数据源，
// 在那里改，本机使用者就看不到自己的路径了。这一层只决定「响应里给谁看什么」，不改变
// 状态本身。
//
// 形态：只留最后一段，前面折成 `…`，分隔统一为 `/`。盘符、用户目录、中间层级一律不出现。
//
// 例外是「用户要按这个路径去磁盘上找文件」的字段：`redactPath` 只留最后一段，
// `dsh-breaklimit-backup/<时间戳>/rules.json` 会被砍成 `…/rules.json`，用户拿着它
// 找不到备份。这类字段用 `relHomePath`：同样不暴露盘符与用户名，但保留 `$DSH_HOME`
// 以下的全部层级，前端补上 `$DSH_HOME/` 前缀即可直接粘贴到资源管理器。
function redactPath(value) {
  if (typeof value !== 'string') return value
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part !== '' && part !== '.')
  if (parts.length < 2) return value
  return `…/${parts[parts.length - 1]}`
}

/**
 * 相对 `$DSH_HOME` 的路径，分隔统一为 `/`。用于必须让用户照着去找文件的字段。
 *
 * 不在根内的路径退回 `redactPath`：宁可只给最后一段，也不把盘符或用户名漏出去。
 * 根目录本身返回空串，`$DSH_HOME/` 由前端拼。
 *
 * @param {unknown} value - 绝对路径。
 * @param {string} root - `$DSH_HOME`。
 * @returns {unknown} 相对路径；不是字符串或不在根内时按 `redactPath` 处理。
 */
function relHomePath(value, root) {
  if (typeof value !== 'string' || value === '') return value
  if (typeof root !== 'string' || root === '') return redactPath(value)
  const normalize = text => text.replace(/\\/g, '/').replace(/\/+$/u, '')
  const target = normalize(value)
  const base = normalize(root)
  if (target === base) return ''
  if (!target.startsWith(`${base}/`)) return redactPath(value)
  return target.slice(base.length + 1)
}

// 少数消息把路径写进了正文：`readInject` 的失败信息形如 `注入文件不可读：<绝对路径>`。
// 只改 `file` 字段会留下正文里那一份，所以按同一个路径替换掉它的出现。
function redactPathInText(text, file) {
  if (typeof text !== 'string' || text === '' || typeof file !== 'string' || file === '') return text
  return text.split(file).join(redactPath(file))
}

// errno 文案自带路径：`EPERM: operation not permitted, rename 'C:\...\state.json.tmp'`。
// 这类文本没有固定形状，按绝对路径的模式整段替换：盘符开头的 Windows 路径，以及常见
// 根目录开头的 POSIX 路径（/mnt、/data、/Volumes 与 home/Users 等同列在根名单里）。
// 误伤面很小（消息里本来就只会出现这两种形状的路径）。
//
// 路径里可以有空格（`C:\Users\John Doe\x`），句子词也可以跟在空格后面（`写入 … 失败：…`）。
// 只按句读截断会把句子词一起吞掉，只按空格截断会把第一个空格之后的 `Doe\x` 留在响应里
// ——那是半脱敏，比不脱敏更坏。空格因此按后面那个词决定断续：
//   1. 词里还有路径分隔符（`Doe\work\x`），路径没走完，整段继续；
//   2. 词里没有分隔符、但含中文（`失败`），这是句子词，到此为止；
//   3. 其余的词（无分隔符、非中文）与路径末段无法区分，宁可保守：并进路径一起折掉，
//      免得半脱敏把用户目录的后半截留在响应里。errno 文案的路径都带引号，引号边界
//      先断开，这种形状下的句子词不受影响。
const PATH_BOUNDARY = `'"）)，。；：！？、`
const PATH_SEGMENT = String.raw`[^\s${PATH_BOUNDARY}]`
const BRIDGED_WORD = String.raw`(?:${PATH_SEGMENT}*[\\/]${PATH_SEGMENT}*|[^\s${PATH_BOUNDARY}\p{Script=Han}]+)`
const ABSOLUTE_PATH_RE = new RegExp(
  String.raw`(?:[A-Za-z]:[\\/]|\/(?:home|Users|srv|tmp|root|var|opt|mnt|data|Volumes)\/)${PATH_SEGMENT}*(?:[ \t]+${BRIDGED_WORD})*`,
  'gu',
)

// 供测试按调用面断言脱敏行为；产品代码只在本层内部使用。
export function redactPathsInText(text) {
  if (typeof text !== 'string' || text === '') return text
  return text.replace(ABSOLUTE_PATH_RE, match => redactPath(match))
}

/** 落点处置结果里的 `skipped[].path` 也是绝对路径，一并脱敏。 */
function redactSettlement(settlement) {
  if (settlement === null || typeof settlement !== 'object') return settlement
  const skipped = Array.isArray(settlement.skipped)
    ? settlement.skipped.map(item => (item !== null && typeof item === 'object'
      ? { ...item, path: redactPath(item.path) }
      : item))
    : settlement.skipped
  return { ...settlement, skipped }
}

function buildRoutes(ctx, config, runtime, bodyLimit) {
  const home = () => resolveHome()

  const requireHostRoot = () => {
    const root = resolveHostRoot(config)
    if (root === null) {
      return {
        error: envelope(
          400,
          'host_root_unconfigured',
          '未配置宿主根。设置 hostRoot 或环境变量 DSH_BREAKLIMIT_HOST_ROOT 后再试。',
        ),
      }
    }
    return { root }
  }

  // 档位字节数只能有一个来源。头部正文是「共用正文 + 该档附加段」，漏掉附加段会让
  // 同一个状态在 GET /tier 与 POST /tier 上给出两个数，用户据此判断不了切档成没成。
  const currentTierInfo = () => {
    const injected = readInject(config)
    const base = injected.ok ? injected.text : ''
    const mode = promptMode(tiers.readTier(home(), runtime).tier)
    return tiers.resolveTierInfo(home(), base, readModeExtension(mode), runtime)
  }

  return {
    // 目标词表：请求交给模型之前把真实目标名换成占位名。
    // 读接口连最近一次命中一起返回，前端据此区分「没配」「配了但没命中」「在起作用」。
    'GET /alias': () => {
      const { entries, error } = readMasks(home())
      const last = runtime.maskLast ?? { hits: 0, at: 0 }
      return envelope(200, 'ok', error ?? '', {
        entries,
        file: redactPath(masksPath(home())),
        limits: { maxEntries: MAX_MASKS, maxTerm: MAX_MASK_TERM },
        hits: runtime.counters.maskHits ?? 0,
        lastHits: last.hits,
        lastAt: last.at,
      })
    },

    // 整表覆盖写。词表很小，逐条增删会让前端和后端各维护一份状态，
    // 直接整表提交，后端负责去重和校验。幂等。
    'PUT /alias': async (req) => {
      const parsed = parseJsonBody(await readBody(req, bodyLimit))
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      if (!Array.isArray(parsed.entries)) {
        return envelope(400, 'invalid_request', '需要 entries 数组，每项含 from 与 to。')
      }
      const result = writeMasks(home(), parsed.entries)
      // 失败文案是 errno 原文，自带 masks.json 的绝对路径，出网前脱敏。
      if (!result.ok) return envelope(500, 'write_failed', redactPathsInText(result.error ?? '写入失败。'))
      return envelope(200, 'saved', '', {
        entries: result.entries,
        file: redactPath(masksPath(home())),
      })
    },

    // 响应里的三处路径在这里折成 `…/最后一段`；`preflight`、`injection` 等其余结构原样
    // 透出（它们的 path 相对宿主根，不含盘符与用户目录）。
    'GET /status': () => {
      const status = buildStatus(ctx, config, runtime)
      return envelope(200, 'ok', '', {
        ...status,
        diagnostics: redactStatusDiagnostics(status, home()),
        hostRoot: redactPath(status.hostRoot),
        stateProblem: redactDetails(status.stateProblem),
        budgetApply: redactDetails(status.budgetApply),
        inject: {
          ...status.inject,
          file: redactPath(status.inject.file),
          message: redactPathInText(status.inject.message, status.inject.file),
        },
        lock: { ...status.lock, file: redactPath(status.lock.file) },
        // 装载期收拢结果的失败文案是 errno 原文，可能带盘符与用户目录；
        // 出网前同样脱敏（status.ensure 仅在失败态携带 error 字符串）。
        ensure: status.ensure !== null && status.ensure !== undefined && typeof status.ensure.error === 'string'
          ? { ...status.ensure, error: redactPathsInText(status.ensure.error) }
          : status.ensure,
        // 清单路径要能让用户去磁盘上找：只留 `…/rules.json` 等于没给。
        rulesIndexPath: relHomePath(status.rulesIndexPath, home()),
      })
    },

    // 补丁清单：每条改什么、影响哪些文件、当前是否参与应用。只读。
    // 只读一次配置：清单内容与可读性结论都取自同一次读取。
    'GET /patches': () => {
      const selection = readDisabled(home())
      return envelope(200, 'ok', '', {
        ...describePatches(selection.disabled, readMode(home(), runtime)),
        selectionKind: selection.kind,
      })
    },

    /**
     * 补丁开关。只决定「下次应用哪些」，不碰宿主源码树上的任何文件；回滚按快照
     * 还原，与此处的配置无关。幂等：把同一个状态设两次没有额外副作用。
     */
    'POST /patches/enabled': async (req) => {
      const parsed = parseJsonBody(await readBody(req, bodyLimit))
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      if (typeof parsed.id !== 'string' || typeof parsed.enabled !== 'boolean') {
        return envelope(400, 'invalid_request', '需要 id 字符串与 enabled 布尔值。')
      }
      // 未知 id 是调用方的输入错误（400），写盘故障是本方的问题（500）。setPatchEnabled
      // 对前者抛固定文案、对后者抛 errno，靠已知 id 名单分开，不猜错误文案的形状。
      if (!knownPatchIds().includes(parsed.id)) {
        return envelope(400, 'unknown_patch', 'Unknown patch id: `' + parsed.id + '`')
      }
      try {
        const result = setPatchEnabled(home(), parsed.id, parsed.enabled)
        return envelope(200, 'toggled', parsed.enabled ? `已启用 ${parsed.id}。` : `已禁用 ${parsed.id}。`, {
          id: parsed.id,
          enabled: parsed.enabled,
          disabled: result.disabled,
        })
      } catch (error) {
        // errno 文案自带 patches.json 的绝对路径：细节进宿主日志，响应只给脱敏后的原文。
        logInternal('write_failed', error)
        return envelope(500, 'write_failed', redactPathsInText(String(error?.message ?? error)))
      }
    },

    'POST /apply': async () => {
      const { root, error } = requireHostRoot()
      if (error !== undefined) return error
      return fromOperation(applySelectedPatches({ root, home: home(), mode: readMode(home(), runtime) }))
    },

    'POST /revert': () => {
      const { root, error } = requireHostRoot()
      if (error !== undefined) return error
      return fromOperation(revertPatches({ root, home: home() }))
    },

    'GET /override': () => {
      const file = userInjectPath(config)
      const loaded = readInject(config)
      return envelope(200, 'ok', '', {
        file: redactPath(file),
        bytes: sizeOf(file),
        userFileExists: fs.existsSync(file),
        effective: {
          ok: loaded.ok,
          code: loaded.code,
          message: redactPathInText(loaded.message, loaded.file),
        },
        text: loaded.ok ? loaded.text : '',
      })
    },

    'POST /override': async (req) => {
      const raw = await readBody(req, bodyLimit)
      const parsed = parseJsonBody(raw)
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      if (typeof parsed.text !== 'string') {
        return envelope(400, 'invalid_text', '需要 text 字段且为字符串。')
      }
      const limit = maxInjectBytes(config)
      if (Buffer.byteLength(parsed.text, 'utf8') > limit) {
        return envelope(400, 'too_large', `内容超过上限 ${String(limit)} 字节。`)
      }
      const file = userInjectPath(config)
      try {
        atomicWrite(file, parsed.text)
      } catch (error) {
        logInternal('write_failed', error)
        return envelope(500, 'write_failed', WRITE_FAILED_MESSAGE)
      }
      return envelope(200, 'saved', '注入文本已保存。', { file: redactPath(file), bytes: sizeOf(file) })
    },

    'GET /tier': () => {
      const info = currentTierInfo()
      return envelope(200, 'ok', '', {
        tier: info.source === 'unavailable' ? null : info.tier,
        source: info.source ?? 'disk',
        error: info.error ?? null,
        available: info.available,
        bytes: info.bytes,
      })
    },

    'POST /tier': async (req) => {
      const raw = await readBody(req, bodyLimit)
      const parsed = parseJsonBody(raw)
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      if (typeof parsed.tier !== 'string' || !tiers.isValidTier(parsed.tier)) {
        return envelope(400, 'invalid_tier', `非法档位。必须为：${tiers.TIERS.join(', ')}。`)
      }
      try {
        const submission = await switchTier(ctx, home(), parsed.tier, resolveBudgets(config))
        const info = currentTierInfo()
        return envelope(200, submission.verified ? 'saved' : 'tier_saved_budget_unconfirmed', submission.verified ? `提示词档位已切换为 ${parsed.tier}。` : '档位已保存，预算生效未确认。', {
          budget: redactDetails(submission.budget),
          budgetVerified: submission.verified,
          tier: info.tier,
          available: info.available,
          bytes: info.bytes,
        })
      } catch (error) {
        logInternal('write_failed', error)
        return envelope(500, 'write_failed', WRITE_FAILED_MESSAGE)
      }
    },


    // 宿主没有向插件暴露重启接口：重启由部署侧的启动器（或 Desktop 的 Electron
    // 主进程）负责。插件能做的只有退出，而一个退出了却不会被拉起的进程等于把
    // 服务停掉。所以这里不自杀，只返回一条能直接粘贴的重启命令。
    'POST /restart': () => {
      const command = restartCommand()
      return envelope(200, 'manual_restart_required', '本插件不自行重启宿主。用下面的命令重启，或按你平时的方式启动 DSH。', {
        command,
        hint: '宿主核心与 Desktop 都没有向插件暴露重启接口，重启必须发生在宿主之外。',
      })
    },

    'GET /rules/status': () => {
      const index = rules.readIndex(home())
      return envelope(200, 'ok', '', {
        active: rules.readActive(home()),
        rules: rules.listRules(home()),
        rulesIndex: index.kind,
        rulesIndexPath: relHomePath(rules.rulesIndexPath(home()), home()),
        // 激活意图或 phase=cleanup 的提交后收尾记录，
        // 不含绝对路径，原样透出；没有未完成激活时为 null。
        pendingActivation: index.pendingActivation ?? null,
      })
    },

    'GET /rules/read': (req) => {
      const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? ''
      const loaded = rules.readRule(home(), id)
      if (!loaded.ok) return envelope(400, 'rule_unreadable', loaded.reason)
      const meta = rules.readRuleMeta(home(), id)
      return envelope(200, 'ok', '', {
        id,
        name: meta.name,
        target: meta.target,
        text: loaded.text,
        active: rules.readActive(home()) === id,
      })
    },

    'POST /rules/save': async (req) => {
      const parsed = parseJsonBody(await readBody(req, bodyLimit))
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      const saved = rules.saveRule(home(), parsed.id, parsed.text, { name: parsed.name, target: parsed.target })
      if (!saved.ok) {
        // 失败 reason 来自 messageOf(error)，含 $DSH_HOME 下的绝对路径，出网前脱敏。
        if (saved.code === 'index_corrupt') return envelope(409, 'index_corrupt', redactPathsInText(saved.reason))
        return envelope(rulesFailureStatus(saved.code), saved.code ?? 'rule_invalid', redactPathsInText(saved.reason), {
          bodyWritten: saved.bodyWritten === true,
          indexWritten: saved.indexWritten === true,
          landingSynced: saved.landingSynced === true,
          // 哈希记录写失败且落点回退也失败时，调用方必须知道落点现在不是同步前的内容。
          landingRestored: saved.landingRestored === true,
        })
      }
      // 成功契约：{ ok, id, meta: { name, target }, landingSynced, landingStale, landingMoved }。
      // 三个落点标志是布尔量，不是对象。meta 缺席时回落到请求里的值，不因为对端还没
      // 跟上就报 500——正文此时已经落盘，500 会让调用方以为没写成。
      const id = saved.id ?? parsed.id
      return envelope(200, 'saved', savedMessage(saved), {
        id,
        name: saved.meta?.name ?? parsed.name ?? id,
        target: saved.meta?.target ?? parsed.target ?? null,
        landingSynced: saved.landingSynced === true,
        landingStale: saved.landingStale === true,
        landingMoved: saved.landingMoved === true,
      })
    },

    // 带 id 激活那一条；不带 id 表示取消激活。
    'POST /rules/activate': async (req) => {
      const parsed = parseJsonBody(await readBody(req, bodyLimit))
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      if (parsed.id !== undefined && typeof parsed.id !== 'string') return envelope(400, 'invalid_id', 'id 必须是字符串。')
      if (parsed.id === undefined || parsed.id === '') {
        const cleared = rules.deactivateRule(home())
        if (!cleared.ok) {
          if (cleared.code === 'index_corrupt') return envelope(409, 'index_corrupt', redactPathsInText(cleared.reason))
          return envelope(rulesFailureStatus(cleared.code), 'rule_invalid', redactPathsInText(cleared.reason))
        }
        const view = { ...cleared, skipped: redactSettlement(cleared).skipped }
        if (cleared.kept === true) {
          const files = view.skipped.map(item => item.path).join('、')
          return envelope(200, 'deactivate_kept', `落点被外部改过，激活记录与快照已保留，没有取消激活：${files}。`, view)
        }
        const parts = ['已取消激活']
        if (cleared.restored) parts.push('落点已还原为原有内容')
        else if (cleared.removed) parts.push('落点文件已清除')
        if (cleared.skipped.length > 0) parts.push(`${String(cleared.skipped.length)} 个落点文件被改过，已保留`)
        // 删除激活规则时落点没被处置，归属会留在清单里；此时应读 landingKept 而不是 kept。
        if (cleared.landingKept != null) parts.push(`快照仍记在 landings/${cleared.landingKept.target}`)
        return envelope(200, 'deactivated', `${parts.join('；')}。`, view)
      }
      const done = rules.activateRule(home(), parsed.id)
      if (!done.ok) {
        if (done.code === 'index_corrupt') return envelope(409, 'index_corrupt', redactPathsInText(done.reason))
        return envelope(rulesFailureStatus(done.code), 'rule_invalid', redactPathsInText(done.reason))
      }
      // 新规则生效与旧落点收尾分开报告。skipped 的含义分两种，不能一律说「副本已保留」：
      // 同落点切换时旧内容会被本次激活覆盖（覆盖前内容有 externalCopy 副本）；
      // 跨落点收尾时旧落点未被覆盖也未还原，保持现状，且部分原因（原文缺失/读不到）
      // 根本没有可恢复的副本，不能让人误以为原文可追回。
      const skipped = done.previousLanding?.skipped ?? []
      const switched = done.cleanupPending === true
        ? '；新规则已生效，旧落点收尾尚未完成，状态记录与原文快照已保留'
        : skipped.length > 0
          ? done.differentTarget === true
            ? '；上一条落点未被覆盖也未还原，保持现状；处置明细见 skipped'
            : '；同一落点上的外部改动已被本次激活覆盖'
              + (done.externalCopy != null ? '，覆盖前的内容留了副本' : '')
              + (done.snapshotKept === true ? '，首次接管时的原文快照仍在' : '')
          : done.previousLanding?.restored === true
            ? '；上一条的落点已还原'
            : done.previousLanding?.removed === true
              ? '；上一条的落点已清除'
              : ''
      const externalCopy = typeof done.externalCopy === 'string'
        ? relHomePath(done.externalCopy, home())
        : null
      // keptCopy（孤儿快照保留副本）与 externalCopy 同一处置：都是 $DSH_HOME 下
      // 的绝对路径，只出相对路径（覆盖 ...done 带进来的原值）。
      const keptCopy = typeof done.keptCopy === 'string'
        ? relHomePath(done.keptCopy, home())
        : null
      const view = {
        ...done,
        file: redactPath(done.file),
        previousLanding: redactSettlement(done.previousLanding),
        externalCopy,
        keptCopy,
      }
      // 被覆盖的外部改动存了副本这件事必须说出来：激活看似「丢了改动」，其实副本在。
      const copied = externalCopy === null ? '' : `；落点上的外部改动已存副本 ${externalCopy}`
      return envelope(200, 'activated', `已激活「${done.name}」，正文写入 ${view.file}${switched}${copied}。`, view)
    },

    'POST /rules/delete': async (req) => {
      const parsed = parseJsonBody(await readBody(req, bodyLimit))
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      const done = rules.deleteRule(home(), parsed.id)
      if (!done.ok) {
        // 失败 reason 含 errno 原文与绝对路径，出网前脱敏（与 save/activate 同口径）。
        if (done.code === 'index_corrupt') return envelope(409, 'index_corrupt', redactPathsInText(done.reason))
        return envelope(rulesFailureStatus(done.code), 'rule_invalid', redactPathsInText(done.reason))
      }
      // 落点被外部改过时快照不随规则删除清除，归属留在清单里；这一条必须说出来，
      // 否则用户以为删干净了，而盘上还躺着一份他不知道的原文。
      const kept = done.kept === true
      const message = kept
        ? `规则已删除；落点被外部改过，快照仍保留在 landings/${String(done.landingKept?.target ?? '')}，重新激活到同一落点时会沿用这份快照，也可自行处理该文件。`
        : '规则已删除。'
      return envelope(200, 'deleted', message, { id: parsed.id, kept, landingKept: done.landingKept ?? null })
    },

    'POST /rules/reset': () => {
      const done = rules.resetRules(home())
      if (!done.ok) {
        if (done.code === 'index_corrupt') return envelope(409, 'index_corrupt', redactPathsInText(done.reason))
        return envelope(rulesFailureStatus(done.code), 'rule_invalid', redactPathsInText(done.reason))
      }
      return envelope(200, 'reset', `已清空规则，移除 ${String(done.removed)} 个文件。`, { ...done, skipped: redactSettlement(done).skipped })
    },

    'POST /rules/recover-corrupt': () => {
      const recovered = rules.recoverCorruptIndex(home())
      if (!recovered.ok) {
        return envelope(rulesFailureStatus(recovered.code), recovered.code ?? 'recovery_failed', redactPathsInText(recovered.reason))
      }
      return envelope(200, 'recovered', '规则清单已备份并重置为空清单。', {
        // 相对 `$DSH_HOME`：前端补前缀后是一个能直接粘贴进资源管理器的路径。
        backupPath: relHomePath(recovered.backupPath, home()),
        backupBytes: recovered.backupBytes,
        rulesIndex: recovered.rulesIndex,
      })
    },

    // 接管开关的前端入口。与命令面板的 on/off 等价，幂等：把同一个值设两次
    // 没有任何额外副作用。
    'POST /enabled': async (req) => {
      const parsed = parseJsonBody(await readBody(req, bodyLimit))
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      if (typeof parsed.enabled !== 'boolean') {
        return envelope(400, 'invalid_enabled', '需要 enabled 字段且为布尔值。')
      }
      runtime.enabled = parsed.enabled
      return envelope(200, 'toggled', runtime.enabled ? '接管已开启。' : '接管已关闭。', {
        enabled: runtime.enabled,
      })
    },

    // 版本与更新。GET 的几条都不联网，只有 check 与 auto 会发请求。
    'GET /update': () => {
      const { kind, state } = update.readUpdateState(home())
      const currentVersion = update.readInstalledVersion()
      return envelope(200, 'ok', '', {
        ...update.viewOf(state, currentVersion),
        updateState: kind,
        proxy: update.proxySource(),
        releasesUrl: update.RELEASES_URL,
      })
    },

    // 每天最多一次。设置面板与浮窗都调它，去重在模块内完成：同一天第二次调用直接
    // 返回落盘结果，不发请求。
    'GET /update/auto': async () => {
      const result = await update.autoCheck({ home: home(), currentVersion: update.readInstalledVersion() })
      return envelope(200, 'ok', '', { ...result, proxy: update.proxySource() })
    },

    'POST /update/check': async () => {
      try {
        const result = await update.manualCheck({ home: home(), currentVersion: update.readInstalledVersion() })
        return envelope(200, 'ok', '', { ...result, proxy: update.proxySource() })
      } catch (error) {
        if (error instanceof update.UpdateError) {
          return envelope(502, error.code, error.message, { proxy: update.proxySource() })
        }
        // 非 UpdateError 是本方的内部故障（fs 报错等），文案自带绝对路径，不出网。
        logInternal('update_check_failed', error)
        return envelope(502, 'update_unreachable', '检查更新失败。', { proxy: update.proxySource() })
      }
    },

    // 开关切换立即落盘，不伴随保存按钮，也不触发联网。
    'POST /update/auto-check': async (req) => {
      const parsed = parseJsonBody(await readBody(req, bodyLimit))
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      if (typeof parsed.enabled !== 'boolean') {
        return envelope(400, 'invalid_enabled', '需要 enabled 字段且为布尔值。')
      }
      const next = update.writeUpdateState(home(), { autoCheckUpdates: parsed.enabled })
      return envelope(200, 'saved', parsed.enabled ? '已开启每天自动检查。' : '已关闭每天自动检查。', {
        ...update.viewOf(next, update.readInstalledVersion()),
      })
    },

    'POST /update/dismiss': async (req) => {
      const parsed = parseJsonBody(await readBody(req, bodyLimit))
      if (parsed === null) return envelope(400, 'invalid_json', '请求体不是合法 JSON。')
      const version = update.parseVersion(parsed.version)
      if (version === null) {
        return envelope(400, 'invalid_version', '需要 x.y.z 格式的 version 字段。')
      }
      // 归一化后落盘：latestVersion 不带 v 前缀，存原串会与它永远不相等，忽略永不生效。
      const next = update.writeUpdateState(home(), { dismissedVersion: version.join('.') })
      return envelope(200, 'saved', '已忽略这个版本。', {
        ...update.viewOf(next, update.readInstalledVersion()),
      })
    },
  }
}

export function createHandler(ctx, config, runtime) {
  // 上限按本次装载的配置算一次：规则正文与注入上限都要装得下，后者可配置。
  const bodyLimit = bodyLimitFor(Math.max(rules.MAX_RULE_BYTES, maxInjectBytes(config)))
  const routes = buildRoutes(ctx, config, runtime, bodyLimit)

  return async function handler(req, res) {
    try {
      // 栅栏放在路由分派之前：读路由同样受约束。`GET /override` 一次返回完整的
      // 注入正文，rebinding 页面能读到它，所以读与写没有宽严之分。
      const allowed = allowedHostsFrom(config)
      const host = req.headers?.host
      if (!hostAllowed(host, allowed.specs)) {
        sendJson(res, 403, {
          ok: false,
          code: HOST_NOT_ALLOWED,
          message: hostRejectionMessage(host, allowed.explicit),
        })
        return
      }
      if (isCrossSite(req)) {
        sendJson(res, 403, { ok: false, code: CROSS_SITE, message: '跨站请求被拒绝：sec-fetch-site 为 cross-site。' })
        return
      }

      const method = (req.method ?? 'GET').toUpperCase()
      if (!isSameOrigin(req, method)) {
        sendJson(res, 403, { ok: false, code: 'cross_origin', message: '写接口仅接受同源请求。' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname.replace(/\/+$/, '') || ROUTE_PREFIX
      const relative = pathname === ROUTE_PREFIX ? '/status' : pathname.slice(ROUTE_PREFIX.length)
      const key = `${method} ${relative}`
      const run = routes[key]

      if (run === undefined) {
        // GET 与 POST 在只读动作上等价，读类接口不必要求调用方区分动词。
        const fallback = routes[`GET ${relative}`]
        if (method === 'GET' && fallback !== undefined) {
          const result = await fallback(req)
          sendJson(res, result.status, result.body)
          return
        }
        sendJson(res, 404, { ok: false, code: 'not_found', message: `未知接口 ${key}` })
        return
      }

      const result = await run(req)
      sendJson(res, result.status, result.body)
    } catch (error) {
      if (error?.code === TOO_LARGE) {
        sendJson(res, 413, { ok: false, code: TOO_LARGE, message: String(error.message) })
        return
      }
      if (error?.code === 'tier_config_unavailable') {
        sendJson(res, 409, { ok: false, code: error.code, message: error.message })
        return
      }
      // 原始 message 会带出 $DSH_HOME 之类的绝对路径，只留在宿主日志里。
      logInternal('internal_error', error)
      sendJson(res, 500, { ok: false, code: 'internal_error', message: INTERNAL_MESSAGE })
    }
  }
}
