// 诊断类操作：宿主升级向导、提示词差异、规则导入。
//
// 三件事都只有两个动作——读文件、调领域模块，不直接碰宿主源码，也不写规则以外
// 的任何位置。输出给人看，所以每条结论都带可复核的依据（文件、行号、字节）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readTextOrNull } from '../patch/fsx.js'
import { readTier } from '../context/tiers.js'
import { promptMode, readModeExtension } from '../context/prompt.js'
import * as rules from '../context/rules.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_INJECT = path.join(HERE, '..', 'context', 'inject.md')

/** 在宿主文件里找一段原文，找不到时给出「最近的替代位置」提示。 */
function locate(text, before) {
  if (text.includes(before)) return { found: true }
  const firstLine = before.split('\n')[0].trim()
  const anchor = firstLine.slice(0, 48)
  const index = anchor.length > 8 ? text.indexOf(anchor) : -1
  if (index < 0) return { found: false, hint: `连片段 ${JSON.stringify(anchor)} 也找不到` }
  const line = text.slice(0, index).split('\n').length
  const actual = text.split('\n')[line - 1].trim()
  return { found: false, hint: `第 ${String(line)} 行现在是 ${JSON.stringify(actual.slice(0, 80))}` }
}

/**
 * 宿主升级向导：逐条核对声明的原文是否还在。
 *
 * @param {string} root - 宿主源码树。
 * @param {ReadonlyArray<object>} patches - 当前模式下的补丁声明。
 * @returns {{ ok: boolean, checked: number, missing: Array<{ id: string, path: string, hint: string }> }}
 */
export function upgradeReport(root, patches) {
  const missing = []
  let checked = 0
  for (const patch of patches) {
    for (const target of patch.targets) {
      checked += 1
      const absolute = path.join(root, ...target.path.split('/'))
      const text = readTextOrNull(absolute)
      if (text === null) {
        missing.push({ id: patch.id, path: target.path, hint: '文件不存在' })
        continue
      }
      const verdict = locate(text, target.before ?? target.needle ?? '')
      if (!verdict.found) missing.push({ id: patch.id, path: target.path, hint: verdict.hint ?? '原文不在了' })
    }
  }
  return { ok: missing.length === 0, checked, missing }
}

/** 升级向导的人读输出。 */
export function formatUpgrade(report) {
  const lines = [`核对 ${String(report.checked)} 个目标，失配 ${String(report.missing.length)} 个`]
  for (const item of report.missing.slice(0, 20)) {
    lines.push(`  ${item.id}  ${item.path}`)
    lines.push(`    ${item.hint}`)
  }
  if (report.missing.length > 20) lines.push(`  其余 ${String(report.missing.length - 20)} 条省略`)
  if (!report.ok) lines.push('修复：先确认宿主里那句话变成了什么，再决定改声明还是重采哈希；不要只重采哈希。')
  return lines.join('\n')
}

/**
 * 当前头部正文与包内默认正文的差异。
 *
 * @param {string} current - 当前生效的头部文本。
 * @param {string} [baseline] - 对照文本，默认包内 inject.md。
 */
export function diffPrompt(current, baseline = readTextOrNull(DEFAULT_INJECT) ?? '') {
  const a = baseline.split('\n')
  const b = String(current ?? '').split('\n')
  const setA = new Set(a)
  const setB = new Set(b)
  const added = b.filter(line => line.trim() !== '' && !setA.has(line))
  const removed = a.filter(line => line.trim() !== '' && !setB.has(line))
  return {
    baselineLines: a.length,
    currentLines: b.length,
    baselineBytes: Buffer.byteLength(baseline, 'utf8'),
    currentBytes: Buffer.byteLength(String(current ?? ''), 'utf8'),
    added,
    removed,
  }
}

/** 差异的人读输出。 */
export function formatDiff(report) {
  const lines = [
    `默认正文   ${String(report.baselineLines)} 行 / ${String(report.baselineBytes)} 字节`,
    `当前正文   ${String(report.currentLines)} 行 / ${String(report.currentBytes)} 字节`,
    `新增行 ${String(report.added.length)}，删除行 ${String(report.removed.length)}`,
  ]
  for (const line of report.added.slice(0, 8)) lines.push(`  + ${line.slice(0, 120)}`)
  for (const line of report.removed.slice(0, 8)) lines.push(`  - ${line.slice(0, 120)}`)
  if (report.added.length + report.removed.length > 16) lines.push('  （只显示前 16 行差异）')
  return lines.join('\n')
}

/** 从文件名推出一个合法规则 id。 */
export function ruleIdFromPath(source) {
  const base = path.basename(String(source)).replace(/\.md$/iu, '')
  const id = base.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
  return id === '' || !/^[a-z0-9]/u.test(id) ? 'imported' : id
}

/**
 * 把一份现成的 AGENTS.md 导入成规则，不激活。
 *
 * @param {string} home - $DSH_HOME。
 * @param {string} source - 源文件路径。
 * @param {object} [options] - id 与落点覆盖。
 * @returns {{ ok: boolean, id?: string, bytes?: number, reason?: string }}
 */
export function importRule(home, source, options = {}) {
  const absolute = path.resolve(String(source ?? ''))
  const text = readTextOrNull(absolute)
  if (text === null) return { ok: false, reason: `读不到 ${absolute}` }
  if (text.trim() === '') return { ok: false, reason: `${absolute} 是空文件` }
  const id = options.id ?? ruleIdFromPath(absolute)
  if (!rules.isValidRuleId(id)) return { ok: false, reason: `非法规则 id：${id}` }
  const target = options.target ?? 'AGENTS.md'
  if (!rules.isValidTarget(target)) return { ok: false, reason: `非法落点：${target}` }
  const saved = rules.saveRule(home, id, text, { name: path.basename(absolute), target })
  if (!saved.ok) return { ok: false, reason: saved.reason ?? '保存失败' }
  return { ok: true, id, bytes: Buffer.byteLength(text, 'utf8') }
}

/** 当前模式的附加段字节数，供 diff 与诊断共用。 */
export function extensionBytes(home) {
  const mode = promptMode(readTier(home).tier)
  return Buffer.byteLength(readModeExtension(mode), 'utf8')
}

/** 目录是否存在，供命令做前置判断。 */
export function fileExists(target) {
  try {
    fs.accessSync(target, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

const CURRENT = 'current_value'
const CUMULATIVE = 'process_cumulative'
const LAST_OBSERVATION = 'last_observation'

function diagnosticLayer(id, state, scope, action = null, detail = null, evidence = {}, warnings = []) {
  return { id, state, scope, action, detail, evidence, warnings }
}

function seamCount(status, name) {
  const value = status.seams?.[name]
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function diskDiagnosis(status) {
  const pre = status.preflight
  if (status.stateProblem || pre?.code === 'state_corrupt' || pre?.code === 'state_version_mismatch') {
    return diagnosticLayer('disk', 'fail', CURRENT, 'check-state', pre?.message ?? status.stateProblem?.reason ?? null)
  }
  if (pre?.code === 'recovery_required') {
    if (status.lock?.busy === true) return diagnosticLayer('disk', 'unknown', CURRENT, 'refresh', '另一项应用或回退正在当前进程中进行。')
    return diagnosticLayer('disk', 'fail', CURRENT, 'check-recovery', pre.message ?? null)
  }
  if (pre?.code === 'host_root_unconfigured' || pre?.code === 'tier_config_unavailable' || !pre) {
    return diagnosticLayer('disk', 'unknown', CURRENT, 'check-host-root', pre?.message ?? null)
  }
  if (!Number.isFinite(pre.selectedPatches)) return diagnosticLayer('disk', 'unknown', CURRENT, 'refresh')
  if (pre.selectedPatches === 0) return diagnosticLayer('disk', 'not_applicable', CURRENT, null, null, { selectedPatches: 0 })
  const evidence = {
    selectedPatches: pre.selectedPatches,
    pendingFiles: pre.pendingFiles,
    blockedFiles: Array.isArray(pre.blocked) ? pre.blocked.length : null,
  }
  if (pre.code === 'blocked' || (Array.isArray(pre.blocked) && pre.blocked.length > 0)) {
    return diagnosticLayer('disk', 'fail', CURRENT, 'patches', pre.message ?? null, evidence)
  }
  if (pre.code === 'ok' && pre.pendingFiles > 0) {
    return diagnosticLayer('disk', 'fail', CURRENT, 'apply', '补丁尚未写入磁盘；预检通过只表示允许应用。', evidence)
  }
  const findings = pre.findings
  if (pre.code !== 'ok' || pre.pendingFiles !== 0 || !Array.isArray(findings) || findings.length === 0) {
    return diagnosticLayer('disk', 'unknown', CURRENT, 'refresh', null, evidence)
  }
  if (findings.some(item => !['applied', 'satisfied'].includes(item?.state))) {
    return diagnosticLayer('disk', 'unknown', CURRENT, 'refresh', null, evidence)
  }
  return diagnosticLayer('disk', 'pass', CURRENT, null, null, evidence)
}

const BUDGET_KEYS = [
  ['shell', 'timeoutMs'],
  ['shell', 'maxTimeoutMs'],
  ['shell', 'maxOutputBytes'],
  ['subagents', 'maxDepth'],
]

function processDiagnosis(status) {
  const loader = status.loader
  const budgetApply = status.budgetApply
  const mismatched = Array.isArray(budgetApply?.mismatched) ? budgetApply.mismatched : []
  const skipped = Array.isArray(budgetApply?.skipped)
    ? budgetApply.skipped.filter(reason => typeof reason === 'string' && !reason.endsWith('条目已禁用'))
    : []
  const unverified = Array.isArray(budgetApply?.unverified) ? budgetApply.unverified : []
  const evidence = {
    loaderEntries: Array.isArray(loader?.entries) ? loader.entries.length : null,
    mismatched: mismatched.length,
    skipped: skipped.length,
    unverified: unverified.length,
  }
  const failure = [...mismatched, ...skipped]
  if (failure.length > 0) {
    return diagnosticLayer('process', 'fail', CURRENT, 'retry-tier', '预算提交或读回与当前模式不一致。', evidence)
  }
  for (const [service, key] of BUDGET_KEYS) {
    const expected = status.budgetExpected?.[service]?.[key]
    const actual = status.budget?.[service]?.[key]
    if (!Number.isFinite(expected)) return diagnosticLayer('process', 'unknown', CURRENT, 'refresh', null, evidence)
    if (actual === null || actual === undefined) return diagnosticLayer('process', 'unknown', CURRENT, 'refresh', null, evidence)
    if (actual !== expected) {
      return diagnosticLayer('process', 'fail', CURRENT, 'retry-tier', `${service}.${key} 预期 ${String(expected)}，实际 ${String(actual)}`, evidence)
    }
  }
  if (status.preflight?.code !== 'ok'
    || !Number.isFinite(status.preflight.pendingFiles)
    || !Number.isFinite(status.preflight.selectedPatches)) {
    return diagnosticLayer('process', 'unknown', CURRENT, 'refresh', '补丁预检不完整，无法判断当前进程的装载基础。', evidence)
  }
  if (status.preflight.pendingFiles > 0) {
    return diagnosticLayer('process', 'unknown', CURRENT, 'restart', '磁盘存在待写入变化；当前进程是否装载新补丁无法判定。', evidence)
  }
  const appliedAt = Date.parse(status.applied?.updatedAt)
  const processStartedAt = status.processStartedAt
  evidence.appliedAt = Number.isFinite(appliedAt) ? appliedAt : null
  evidence.processStartedAt = Number.isFinite(processStartedAt) ? processStartedAt : null
  if (status.preflight.selectedPatches > 0
    && (!Number.isFinite(appliedAt) || !Number.isFinite(processStartedAt) || appliedAt > processStartedAt)) {
    return diagnosticLayer('process', 'unknown', CURRENT, 'restart', '应用记录不早于当前进程启动，重启后的补丁装载无法判定。', evidence)
  }
  if (unverified.length > 0) {
    return diagnosticLayer('process', 'unknown', CURRENT, 'refresh', '预算提交尚有未核实项。', evidence)
  }
  const loaderReadable = loader?.error === null && Array.isArray(loader.entries)
    && (loader.hasCtxLoader === true || loader.hasRootLoader === true)
  if (!loaderReadable || !['recommended', 'unrestricted'].includes(status.promptMode)) {
    return diagnosticLayer('process', 'unknown', CURRENT, 'refresh', 'Loader 或当前提示词模式不可读。', evidence)
  }
  return diagnosticLayer('process', 'pass', CURRENT, null, null, evidence)
}

function assemblyDiagnosis(status) {
  if (status.enabled === false) return diagnosticLayer('assembly', 'not_applicable', LAST_OBSERVATION)
  if (status.inject?.ok === false) {
    return diagnosticLayer('assembly', 'fail', LAST_OBSERVATION, 'edit-prompt', status.inject.message ?? status.inject.code ?? null)
  }
  if (status.tier?.source === 'unavailable') {
    return diagnosticLayer('assembly', 'fail', LAST_OBSERVATION, 'check-tier', status.tier.error ?? null)
  }
  if (status.injection?.inert === true) {
    return diagnosticLayer('assembly', 'fail', LAST_OBSERVATION, 'check-host-preset', status.injection.reason ?? null)
  }
  if (status.inject?.ok !== true || typeof status.tier?.source !== 'string'
    || seamCount(status, 'assemble') === 0 || status.injection?.inert !== false) {
    return diagnosticLayer('assembly', 'unknown', LAST_OBSERVATION, 'run-session', status.injection?.reason ?? null)
  }
  return diagnosticLayer('assembly', 'pass', LAST_OBSERVATION, null, null, {
    assemblies: seamCount(status, 'assemble'),
  }, status.tier.source === 'cached' ? ['tier_cached'] : [])
}

function requestDiagnosis(status) {
  if (status.enabled === false) return diagnosticLayer('request', 'not_applicable', CUMULATIVE)
  const evidence = {
    preStep: seamCount(status, 'preStep'),
    hardenHits: seamCount(status, 'hardenHits'),
    hardenMisses: seamCount(status, 'hardenMisses'),
    maskHits: Number.isFinite(status.masks?.hits) ? status.masks.hits : 0,
    lastMaskHits: Number.isFinite(status.masks?.lastHits) ? status.masks.lastHits : 0,
    lastMaskAt: Number.isFinite(status.masks?.lastAt) ? status.masks.lastAt : 0,
    configuredMasks: Number.isFinite(status.masks?.configured) ? status.masks.configured : null,
  }
  if (status.maskRead?.source === 'unavailable') {
    return diagnosticLayer('request', 'fail', CUMULATIVE, 'check-masks', status.maskRead.error ?? null, evidence)
  }
  if (evidence.preStep === 0 || !status.maskRead || evidence.configuredMasks === null) {
    return diagnosticLayer('request', 'unknown', CUMULATIVE, 'run-session', null, evidence)
  }
  const warnings = []
  if (evidence.hardenMisses > 0) warnings.push('harden_misses_cumulative')
  if (status.maskRead.error) warnings.push('mask_read_warning')
  return diagnosticLayer('request', 'pass', CUMULATIVE, null, null, evidence, warnings)
}

function executionDiagnosis(status) {
  if (status.enabled === false) return diagnosticLayer('execution', 'not_applicable', CUMULATIVE)
  const evidence = {
    approval: seamCount(status, 'approval'),
    toolGate: seamCount(status, 'toolGate'),
    editIntent: seamCount(status, 'editIntent'),
    currentPreset: typeof status.permission?.current === 'string' ? status.permission.current : null,
  }
  if (status.modeSource !== 'session' || status.sandbox?.available !== true || status.permission?.available !== true) {
    return diagnosticLayer('execution', 'unknown', CUMULATIVE, 'run-session', '当前会话档位或权限预设不可判定。', evidence)
  }
  const current = status.permission.layers?.find(layer => layer?.name === status.permission.current)
  if (!current || typeof current.approval !== 'string') {
    return diagnosticLayer('execution', 'unknown', CUMULATIVE, 'check-permissions', null, evidence)
  }
  if (current.approval === 'never') {
    return diagnosticLayer('execution', 'fail', CUMULATIVE, 'check-permissions', '当前会话预设会在审批接缝之前拒绝请求。', evidence)
  }
  if (evidence.approval + evidence.toolGate + evidence.editIntent === 0) {
    return diagnosticLayer('execution', 'unknown', CUMULATIVE, 'run-session', null, evidence)
  }
  return diagnosticLayer('execution', 'pass', CUMULATIVE, null, null, evidence)
}

/** 只归纳现有状态，不补探针，也不把进程累计观测归因到单次请求。 */
export function diagnoseStatus(status) {
  return {
    layers: [
      diskDiagnosis(status),
      processDiagnosis(status),
      assemblyDiagnosis(status),
      requestDiagnosis(status),
      executionDiagnosis(status),
    ],
  }
}

const DIAGNOSTIC_NAMES = {
  disk: '磁盘补丁',
  process: '进程装载与运行时预算',
  assembly: '系统提示装配',
  request: '请求前处理观测',
  execution: '执行权限与接缝观测',
}
const DIAGNOSTIC_STATES = { pass: '通过', fail: '未生效', unknown: '不可判定', not_applicable: '不适用' }
const DIAGNOSTIC_ACTIONS = {
  apply: '检查并应用所选补丁，随后重启宿主。',
  'check-state': '先检查 state.json 与恢复记录；记录不可信时不要尝试回退。',
  'check-recovery': '先确认没有其他应用或回退正在运行，再按可信事务记录恢复。',
  patches: '查看补丁预检与漂移明细，不要绕过守卫强写。',
  'check-host-root': '检查宿主根与当前提示词档位配置。',
  restart: '完成磁盘写入后重启宿主，再重新检查。',
  'retry-tier': '用 /breaklimit tier <模式> 重新提交预算并读回核对。',
  refresh: '重新读取状态；保持未知时不要当成已生效。',
  'edit-prompt': '修复注入文件后重新检查。',
  'check-tier': '修复提示词档位配置后重新检查。',
  'check-host-preset': '检查宿主 preset 是否丢弃了注入段。',
  'check-masks': '修复词表配置后重试；不要按空词表继续。',
  'run-session': '在目标会话执行一次实际任务后重新读取观测。',
  'check-permissions': '检查当前会话预设与 approval 策略。',
}

export function formatDiagnosticText(report) {
  const lines = ['五层运行时诊断（只读观测）']
  for (const layer of report?.layers ?? []) {
    const scope = layer.scope === CUMULATIVE ? '；进程累计' : layer.scope === LAST_OBSERVATION ? '；最近观测' : ''
    lines.push(`  ${DIAGNOSTIC_NAMES[layer.id] ?? layer.id}  ${DIAGNOSTIC_STATES[layer.state] ?? '不可判定'}${scope}`)
    if (layer.detail) lines.push(`    ${layer.detail}`)
    const entries = Object.entries(layer.evidence ?? {})
    if (entries.length > 0) lines.push(`    证据  ${entries.map(([key, value]) => `${key}=${String(value)}`).join('，')}`)
    if (layer.action) lines.push(`    下一步  ${DIAGNOSTIC_ACTIONS[layer.action] ?? '重新检查状态。'}`)
    if (layer.warnings?.length > 0) lines.push(`    告警  ${layer.warnings.join('、')}`)
  }
  return lines.join('\n')
}
