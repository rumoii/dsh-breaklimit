// 状态组装与终端消息。宿主专有状态由上下文读取，补丁状态来自共用服务。
import { DSH_TARGET } from '../patch/index.js'
import { resolveHome } from '../patch/state.js'
import { sharedOperationLock } from '../patch/transaction.js'
import { lockFilePath } from '../patch/lock.js'
import { inspectPatches } from '../patch/service.js'
import { readInject } from '../context/inject-file.js'
import { resolveHostRootInfo } from './host-root.js'
import { currentMode, describeSandboxPolicy, sessionOf } from './seams.js'
import * as rules from '../context/rules.js'
import * as tiers from '../context/tiers.js'
import { promptMode, readMode, readModeExtension, readTail } from '../context/prompt.js'
import { describeLoader, readRuntimeLimits, recheckBudget } from './capabilities.js'

const name = 'rumo-dsh-breaklimit'

export function appliedSummary(state) {
  return {
    operationId: state.operationId,
    phase: state.phase ?? 'committed',
    updatedAt: state.updatedAt ?? null,
    files: Object.keys(state.files).length,
  }
}

const APPROVAL_NEVER = 'never'

/**
 * 从宿主的生效值算出审批接缝还能不能收到询问。
 *
 * 判据取宿主解析后的现值，不取本插件的声明：配置层是 bundle → profile patch →
 * home patch → 命令行覆盖，后三者都在所有 bundle 之上，本插件在 `cordis.patch.yml`
 * 里写的三档 ask 会被它们整体覆盖。所以这里只读 `permissionPresets` 与 `approval`
 * 两个服务的当前值，不做来源归因——归因需要知道是哪一层写的，而层序合并后那个信息
 * 已经不在了。
 *
 * 抽成纯函数是为了可测：`apply()` 需要真实的 Cordis 上下文，而这一段判定只是
 * 对普通数据的算术，仿一个上下文来测它只能证明仿造品的行为。
 *
 * @param {object} [input] - 纯数据，由调用方从宿主服务取好。
 * @param {null|object} [input.table] - `permissionPresets`：`names` 与逐档 resolve 结果；
 *   服务缺席时传 null。某一档 resolve 抛错时该档在 `resolved` 里是 `{ error }`。
 * @param {string|null} [input.current] - 当前会话的预设名。
 * @param {string|null} [input.mode] - 当前档位。
 * @param {string|null} [input.defaultPreset] - 部署默认预设名。
 * @param {string|null} [input.defaultPolicy] - `approval` 服务的 `config.policy`。
 * @returns {{ available: boolean, current: string|null, mode: string|null,
 *   defaultPreset: string|null, defaultPolicy: string|null,
 *   layers: Array<{ name: string, sandbox: string|null, approval: string|null }>,
 *   failures: Array<{ name: string, error: string }>,
 *   warnings: Array<{ code: string, preset: string|null, message: string }> }}
 *   `available` 为 false 表示宿主未提供 `permissionPresets`，此时档位表无从判定，
 *   但 `defaultPolicy` 仍然独立成立，不随它一起沉默。
 */
export function describePermissionLayers(input = {}) {
  const table = input.table ?? null
  const available = table !== null && Array.isArray(table.names)

  const layers = []
  const failures = []
  if (available) {
    for (const name of table.names) {
      const resolved = table.resolved?.[name]
      if (resolved === undefined) continue
      if (typeof resolved.error === 'string') {
        failures.push({ name, error: resolved.error })
        continue
      }
      layers.push({
        name,
        sandbox: typeof resolved.sandbox === 'string' ? resolved.sandbox : null,
        approval: typeof resolved.approval === 'string' ? resolved.approval : null,
      })
    }
  }

  const warnings = []
  const currentPreset = typeof input.current === 'string' ? input.current : null
  for (const layer of layers) {
    if (layer.approval !== APPROVAL_NEVER) continue
    const relation = currentPreset === null
      ? '当前会话档位未知'
      : currentPreset === layer.name ? '当前会话正处在这一档' : '当前会话不在这一档'
    warnings.push({
      code: 'preset_approval_never',
      preset: layer.name,
      message: `\`${layer.name}\` 档生效的 approval 是 never：宿主在审批瀑布之前直接判驳，本插件注册在 approval/request 上的接缝收不到任何询问（${relation}）。`,
    })
  }
  if (input.defaultPolicy === APPROVAL_NEVER) {
    warnings.push({
      code: 'default_policy_never',
      preset: null,
      message: '审批默认策略是 never：新会话的审批在宿主瀑布之前就被判驳，不会到达本插件。',
    })
  }

  return {
    available,
    current: input.current ?? null,
    mode: input.mode ?? null,
    defaultPreset: input.defaultPreset ?? null,
    defaultPolicy: input.defaultPolicy ?? null,
    layers,
    failures,
    warnings,
  }
}

/**
 * 本插件的注入是否真的进入了宿主的最终系统提示。
 *
 * 数据来自 `registerSeams` 写入的最近一次装配。`injectionDropped` 只有在宿主落盘的
 * system/message 被观测到之后才会从 `'unknown'` 变成布尔值——complete 标记在插件
 * 可见范围内读不到，装配点只能记未知，不伪造判定。
 *
 * @param {object|undefined} lastAssembly - `runtime.lastAssembly`。
 * @returns {{ inert: boolean|null, reason: string }}
 *   `inert` 为 true 表示注入没有进入宿主最终系统提示词；null 表示判不出来。
 */
export function describeInjection(lastAssembly) {
  if (lastAssembly === undefined || lastAssembly === null) {
    return { inert: null, reason: '尚未观测到提示词装配' }
  }
  if (lastAssembly.injected !== true) {
    return { inert: null, reason: '本插件当前没有注入文本' }
  }
  if (!Array.isArray(lastAssembly.markers) || lastAssembly.markers.length === 0) {
    return { inert: null, reason: '注入文本里找不到可用作判据的稳定片段' }
  }
  if (lastAssembly.injectionDropped === true) {
    return {
      inert: true,
      reason: '宿主最终写入会话的系统提示词里没有本插件的注入文本；minimal preset 的 complete 段就是这个效果',
    }
  }
  if (lastAssembly.injectionDropped === false) {
    return { inert: false, reason: '宿主最近一次写入会话的系统提示词包含本插件的注入文本' }
  }
  return {
    inert: null,
    reason: '宿主不暴露 complete 标记，装配点判不出来；尚未观测到落盘的 system/message',
  }
}

export function buildStatus(ctx, config, runtime) {
  const home = resolveHome()
  const hostRootInfo = resolveHostRootInfo(config)
  const hostRoot = hostRootInfo.root
  const mode = readMode(home)
  const { state: loaded, preflight: preflightSummary } = inspectPatches({ root: hostRoot, home, mode })

  return {
    plugin: name,
    promptMode: mode,
    budget: readRuntimeLimits(ctx),
    budgetApply: recheckBudget(ctx),
    loader: describeLoader(ctx),
    enabled: runtime.enabled,
    injection: describeInjection(runtime.lastAssembly),
    target: DSH_TARGET,
    hostRoot,
    hostRootSource: hostRootInfo.source,
    mode: currentMode(ctx, sessionOf(runtime.holder)),
    sandbox: describeSandboxPolicy(ctx, sessionOf(runtime.holder)),
    seams: {
      approval: runtime.counters.approval,
      escalation: runtime.counters.escalation,
      escalationRejected: runtime.counters.escalationRejected,
      toolGate: runtime.counters.toolGate,
      editIntent: runtime.counters.editIntent,
      assemble: runtime.counters.assemble,
      preStep: runtime.counters.preStep,
      hardenHits: runtime.counters.hardenHits,
      hardenMisses: runtime.counters.hardenMisses,
    },
    inject: (() => {
      const injected = readInject(config)
      return { ok: injected.ok, code: injected.code, message: injected.message, file: injected.file, bytes: injected.bytes }
    })(),
    tier: (() => {
      const injected = readInject(config)
      const base = injected.ok ? injected.text : ''
      const info = tiers.resolveTierInfo(home, base, readModeExtension(promptMode(tiers.readTier(home).tier)))
      const tail = readTail()
      return {
        active: info.tier,
        kind: info.kind,
        available: info.available,
        bytes: info.bytes,
        tailBytes: Buffer.byteLength(tail, 'utf8'),
        combinedBytes: info.bytes + Buffer.byteLength(tail, 'utf8'),
      }
    })(),
    applied: loaded.kind !== 'ok' ? null : appliedSummary(loaded.state),
    stateProblem: loaded.kind === 'ok' || loaded.kind === 'absent'
      ? null
      : { kind: loaded.kind, reason: loaded.reason ?? null },
    preflight: preflightSummary,
    lock: {
      busy: sharedOperationLock().busy,
      operationId: sharedOperationLock().operationId,
      file: lockFilePath(home),
    },
    http: { mounted: runtime.httpMounted },
    activeRule: rules.readActive(home),
    rules: rules.listRules(home),
    rulesIndex: rules.readIndex(home).kind,
    rulesIndexPath: rules.rulesIndexPath(home),
    // 权限分层取自宿主服务解析后的现值：本插件在 `cordis.patch.yml` 里声明的三档 ask
    // 会被 profile、home 与命令行三层整体覆盖，只有宿主自己的结果才说明接缝还收不收得到询问。
    permission: (() => {
      const presets = ctx.get('permissionPresets')
      const approval = ctx.get('approval')
      const session = sessionOf(runtime.holder)

      let table = null
      if (presets !== undefined && Array.isArray(presets.names) && typeof presets.resolve === 'function') {
        const resolved = {}
        for (const presetName of presets.names) {
          try {
            const spec = presets.resolve(presetName)
            resolved[presetName] = { sandbox: spec?.sandbox, approval: spec?.approval }
          } catch (error) {
            resolved[presetName] = { error: String(error?.message ?? error) }
          }
        }
        table = { names: [...presets.names], resolved }
      }

      let current = null
      if (presets !== undefined && typeof presets.current === 'function' && session !== undefined) {
        try {
          current = presets.current(session)
        } catch {
          current = null
        }
      }

      return describePermissionLayers({
        table,
        current,
        mode: currentMode(ctx, session),
        defaultPreset: typeof presets?.defaultPreset === 'string' ? presets.defaultPreset : null,
        defaultPolicy: typeof approval?.config?.policy === 'string' ? approval.config.policy : null,
      })
    })(),
  }
}

/**
 * 保存成功后的一句话。
 *
 * 这一批只有两种结局：规则正被激活，正文同时写进写入文件；或者规则没激活，正文只
 * 进规则库。`landingStale` 与 `landingMoved` 恒为 false（外部改动检测与挪落点都不
 * 在这一版里），没有第三种分支可走，所以不写。
 */
export function savedMessage(saved) {
  return saved.landingSynced === true
    ? '规则已保存，正文已同步到写入文件。'
    : '规则已保存，正文未同步到写入文件。'
}

/**
 * 应用记录那一行的值。字段名与 `appliedSummary` 对齐，时间缺失时说出来而不是
 * 让一个裸的 undefined 出现在面板上。
 */
function appliedLine(applied) {
  if (applied === null || applied === undefined) return '无'
  return `${applied.operationId}（${String(applied.files)} 个文件，${applied.updatedAt ?? '时间未知'}）`
}

/** 操作结果的可读文本。 */
export function formatOperationText(result) {
  const lines = [result.message]
  if (Array.isArray(result.written) && result.written.length > 0) {
    lines.push('写入：', ...result.written.map(item => `  ${item}`))
  }
  if (Array.isArray(result.restored) && result.restored.length > 0) {
    lines.push('回退：', ...result.restored.map(item => `  ${item}`))
  }
  if (Array.isArray(result.drifted) && result.drifted.length > 0) {
    lines.push('漂移：', ...result.drifted.map(item => `  ${item.path}  ${item.reason}`))
  }
  if (Array.isArray(result.blocked) && result.blocked.length > 0) {
    lines.push('阻断：', ...result.blocked.map(item => `  ${item.patchId}  ${item.path}  ${item.reason}`))
  }
  return lines.join('\n')
}

/** 宿主的 live auto 档名（`permission-presets` 的 `AUTO_PRESET`）；它被追加在配置档之后。 */
const AUTO_PRESET_NAME = 'auto'

/**
 * 档位计数。宿主的 `names` 会把当时 live 的 auto 追加在配置档之后，两者要分开说，
 * 否则「4 档」会被读成配置文件里写了四档。
 */
function layerCountText(layers) {
  const auto = layers.filter(layer => layer.name === AUTO_PRESET_NAME).length
  const configured = layers.length - auto
  return auto === 0 ? `${String(configured)} 档配置` : `${String(configured)} 档配置 + auto`
}

/** 权限分层的一行摘要。逐条告警由调用方在其后展开。 */
function permissionLine(permission) {
  if (permission === undefined || permission === null) return '  权限分层      未采集'
  if (!permission.available) {
    const tail = permission.defaultPolicy === null ? '' : `，审批默认策略 ${permission.defaultPolicy}`
    return `  权限分层      不可判定（宿主未提供 permissionPresets）${tail}`
  }
  const never = permission.layers.filter(layer => layer.approval === 'never').map(layer => layer.name)
  const failed = permission.failures.length === 0 ? '' : `，${String(permission.failures.length)} 档解析失败`
  const verdict = never.length === 0 ? 'approval 均为 ask' : `approval 为 never：${never.join('、')}`
  return `  权限分层      ${layerCountText(permission.layers)}，${verdict}${failed}`
}

/** 错误文本压成一行，超长截断。状态输出不展开堆栈。 */
function shortError(error) {
  const text = String(error ?? '').replace(/\s+/gu, ' ').trim()
  if (text === '') return '未知原因'
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

/** 状态文本。只输出标量，不序列化任何宿主活对象。 */
export function formatStatusText(status) {
  const seams = status.seams
  const pre = status.preflight
  const lines = [
    'rumo-dsh-breaklimit',
    `  接管开关      ${status.enabled ? '开' : '关'}`,
    `  当前档位      ${status.mode}`,
    permissionLine(status.permission),
    `  目标宿主      ${status.target.version} @ ${status.target.commit.slice(0, 12)}`,
    `  宿主根        ${status.hostRoot ?? '未配置（补丁状态无法判定）'}${status.hostRootSource === 'derived' ? '（由宿主进程推导）' : ''}`,
    `  补丁预检      ${pre.code}${pre.pendingFiles === undefined ? '' : `，待写入 ${String(pre.pendingFiles)} 个文件`}`,
    `  应用记录      ${appliedLine(status.applied)}`,
    `  提示词档位    ${status.tier?.active ?? tiers.DEFAULT_TIER}（可选：${status.tier?.available ? status.tier.available.join('/') : tiers.TIERS.join('/')}，${String(status.tier?.bytes ?? status.inject.bytes)} 字节）`,
    `  注入文件      ${status.inject.file}`,
    `  注入大小      ${String(status.inject.bytes)} 字节`,
    `  注入状态      ${status.inject.ok ? '可读' : `${status.inject.code}：${status.inject.message}`}`,
    `  激活规则      ${status.activeRule ?? '无'}`,
    `  用户规则      ${String(status.rules.length)} 份`,
    `  HTTP 接口     ${status.http?.mounted === true ? '已挂载' : '未挂载（该组合没有 webServer 服务）'}`,
    // 升级请求本身就走审批瀑布，所以「审批」统计的是进入瀑布的请求总数，
    // 与「升级」不是并列关系而是包含关系。分开列会让人读成"1 次普通审批 + 1 次升级"，
    // 所以只在有升级时把明细折进括号，零升级时保持旧格式不变。
    `  接缝调用      审批请求 ${String(seams.approval)}${seams.escalation > 0 ? `（其中升级 ${String(seams.escalation)}，挡回 ${String(seams.escalationRejected)}）` : ''}｜工具门 ${String(seams.toolGate)}｜编辑门 ${String(seams.editIntent)}｜装配 ${String(seams.assemble)}｜步骤前 ${String(seams.preStep)}`,
    `  声明改写      命中 ${String(seams.hardenHits)} 次，未识别 ${String(seams.hardenMisses)} 次`,
    `  操作锁        ${status.lock.busy ? `占用中（${String(status.lock.operationId)}）` : '空闲'}`,
  ]
  if (status.sandbox !== undefined && status.sandbox !== null && status.sandbox.available === false) {
    // 分流逻辑在同样情况下按 read-only 处理，这里把那一次的降级原因说出来。
    lines.push(`  档位来源      不可判定（${shortError(status.sandbox.error)}），审批与工具门按 read-only 处理`)
  }
  if (status.injection?.inert === true) {
    lines.push(`  注入告警      ${status.injection.reason}`)
  }
  if (status.tier?.kind === 'corrupt') {
    lines.push(`  档位问题      tier_config_corrupt：$DSH_HOME/breaklimit/tier.json 读不出或内容非法，当前按缺省档 ${String(status.tier.active)} 生效`)
  }
  if (status.rulesIndex === 'corrupt') {
    lines.push('  规则问题      rules_index_corrupt：$DSH_HOME/breaklimit/rules.json 读不出或版本不符，已停止写入以保护原数据')
  }
  if (status.stateProblem !== null && status.stateProblem !== undefined) {
    lines.push(`  记录问题      ${status.stateProblem.kind}${status.stateProblem.reason === null ? '' : `：${status.stateProblem.reason}`}`)
  }
  if (Array.isArray(status.permission?.warnings) && status.permission.warnings.length > 0) {
    for (const warning of status.permission.warnings) {
      lines.push(`  权限告警      ${warning.message}`)
    }
  }
  if (pre.blocked !== undefined && pre.blocked.length > 0) {
    lines.push('  预检阻断：')
    for (const item of pre.blocked) {
      lines.push(`    ${item.patchId}  ${item.path}  ${item.reason}`)
    }
  }
  return lines.join('\n')
}
