// 诊断类操作的纯函数部分：预检、升级核对、提示词差异、规则导入。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { diagnoseStatus, diffPrompt, formatUpgrade, importRule, ruleIdFromPath, upgradeReport } from '../src/host/inspect.js'
import { formatGuard as fmt, inspectTarget } from '../src/host/guard.js'

function tempDir(prefix = 'bkl-inspect-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function passingStatus() {
  return {
    enabled: true,
    promptMode: 'recommended',
    preflight: {
      code: 'ok', selectedPatches: 1, pendingFiles: 0, blocked: [],
      findings: [{ state: 'applied' }],
    },
    stateProblem: null,
    applied: { updatedAt: '2026-01-01T00:00:00.000Z' },
    processStartedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    loader: { hasCtxLoader: true, hasRootLoader: false, entries: ['bash-sandbox'], error: null },
    budgetExpected: {
      shell: { timeoutMs: 1, maxTimeoutMs: 2, maxOutputBytes: 3 },
      subagents: { maxDepth: 4 },
    },
    budget: {
      shell: { timeoutMs: 1, maxTimeoutMs: 2, maxOutputBytes: 3 },
      subagents: { maxDepth: 4 },
    },
    budgetApply: { skipped: [], mismatched: [], unverified: [] },
    inject: { ok: true, code: 'ok', message: '' },
    tier: { source: 'disk' },
    injection: { inert: false },
    maskRead: { error: null, source: 'disk' },
    masks: { configured: 1, hits: 1, lastHits: 1, lastAt: 1 },
    seams: {
      assemble: 1, preStep: 1, hardenHits: 1, hardenMisses: 0,
      approval: 0, toolGate: 1, editIntent: 0,
    },
    modeSource: 'session',
    sandbox: { available: true },
    permission: {
      available: true,
      current: 'danger-full-access',
      layers: [{ name: 'danger-full-access', approval: 'ask' }],
      warnings: [],
    },
  }
}

function diagnosticLayer(status, id) {
  return diagnoseStatus(status).layers.find(layer => layer.id === id)
}

test('五层诊断：正面证据完整时全部通过，累计观测标明范围', () => {
  const report = diagnoseStatus(passingStatus())
  assert.deepEqual(report.layers.map(layer => [layer.id, layer.state]), [
    ['disk', 'pass'],
    ['process', 'pass'],
    ['assembly', 'pass'],
    ['request', 'pass'],
    ['execution', 'pass'],
  ])
  assert.equal(diagnosticLayer(passingStatus(), 'request').scope, 'process_cumulative')
  assert.equal(diagnosticLayer(passingStatus(), 'execution').scope, 'process_cumulative')
})

test('五层诊断：预检允许应用不等于已生效，待重启装载保持未知', () => {
  const status = passingStatus()
  status.preflight.pendingFiles = 2
  status.preflight.findings = [{ state: 'pending' }]
  assert.equal(diagnosticLayer(status, 'disk').state, 'fail')
  assert.equal(diagnosticLayer(status, 'process').state, 'unknown')

  status.preflight.pendingFiles = 0
  status.preflight.findings = [{ state: 'applied' }]
  status.applied.updatedAt = '2026-01-03T00:00:00.000Z'
  assert.equal(diagnosticLayer(status, 'process').state, 'unknown', '应用后尚未重启时不凭预算匹配推断代码已装载')

  status.applied.updatedAt = null
  assert.equal(diagnosticLayer(status, 'process').state, 'unknown', '缺少应用时间时同样保持未知')

  status.preflight.selectedPatches = 0
  status.preflight.findings = []
  assert.equal(diagnosticLayer(status, 'disk').state, 'not_applicable')
})

test('五层诊断：Loader 与预算必须分别有正面证据', () => {
  const missingLoader = passingStatus()
  missingLoader.loader = { hasCtxLoader: false, hasRootLoader: false, entries: [], error: '/workspace/private/loader' }
  assert.equal(diagnosticLayer(missingLoader, 'process').state, 'unknown')
  assert.doesNotMatch(diagnosticLayer(missingLoader, 'process').detail ?? '', /\/workspace\/private/u)

  const earlyPreflight = passingStatus()
  earlyPreflight.preflight = { code: 'host_root_unconfigured' }
  assert.equal(diagnosticLayer(earlyPreflight, 'process').state, 'unknown')

  const mismatch = passingStatus()
  mismatch.budget.shell.timeoutMs = 99
  assert.equal(diagnosticLayer(mismatch, 'process').state, 'fail')

  const unverified = passingStatus()
  unverified.budgetApply.unverified = ['subagent：读回不可用']
  assert.equal(diagnosticLayer(unverified, 'process').state, 'unknown')
})

test('五层诊断：损坏记录与进行中事务给出不同恢复动作', () => {
  const corrupt = passingStatus()
  corrupt.stateProblem = { kind: 'corrupt' }
  corrupt.preflight = { code: 'state_corrupt' }
  assert.equal(diagnosticLayer(corrupt, 'disk').state, 'fail')
  assert.equal(diagnosticLayer(corrupt, 'disk').action, 'check-state')

  const busy = passingStatus()
  busy.preflight = { code: 'recovery_required' }
  busy.lock = { busy: true }
  assert.equal(diagnosticLayer(busy, 'disk').state, 'unknown')
  assert.equal(diagnosticLayer(busy, 'disk').action, 'refresh')

  const recovery = passingStatus()
  recovery.preflight = { code: 'recovery_required' }
  recovery.lock = { busy: false }
  assert.equal(diagnosticLayer(recovery, 'disk').state, 'fail')
  assert.equal(diagnosticLayer(recovery, 'disk').action, 'check-recovery')
})

test('五层诊断：装配区分关闭、未观测与最终注入被丢弃', () => {
  const disabled = passingStatus()
  disabled.enabled = false
  assert.equal(diagnosticLayer(disabled, 'assembly').state, 'not_applicable')

  const unobserved = passingStatus()
  unobserved.seams.assemble = 0
  unobserved.injection.inert = null
  assert.equal(diagnosticLayer(unobserved, 'assembly').state, 'unknown')

  const dropped = passingStatus()
  dropped.injection.inert = true
  assert.equal(diagnosticLayer(dropped, 'assembly').state, 'fail')
})

test('五层诊断：请求前处理不把累计未识别数当成当前失败', () => {
  const status = passingStatus()
  status.seams.hardenMisses = 2
  assert.equal(diagnosticLayer(status, 'request').state, 'pass')

  status.seams.preStep = 0
  assert.equal(diagnosticLayer(status, 'request').state, 'unknown')

  const unavailable = passingStatus()
  unavailable.maskRead = { error: '词表不可用', source: 'unavailable' }
  assert.equal(diagnosticLayer(unavailable, 'request').state, 'fail')
})

test('五层诊断：只按当前会话权限判失败，不以接缝计数推断工具成功', () => {
  const otherPreset = passingStatus()
  otherPreset.permission.layers.push({ name: 'read-only', approval: 'never' })
  otherPreset.permission.warnings = [{ code: 'preset_approval_never', preset: 'read-only' }]
  assert.equal(diagnosticLayer(otherPreset, 'execution').state, 'pass')

  const currentPreset = passingStatus()
  currentPreset.permission.layers[0].approval = 'never'
  assert.equal(diagnosticLayer(currentPreset, 'execution').state, 'fail')

  const unobserved = passingStatus()
  unobserved.seams.toolGate = 0
  assert.equal(diagnosticLayer(unobserved, 'execution').state, 'unknown')

  const defaultOnly = passingStatus()
  defaultOnly.modeSource = 'default'
  assert.equal(diagnosticLayer(defaultOnly, 'execution').state, 'unknown')
})

test('五层诊断：旧状态缺少新增字段时降级为未知且不抛错', () => {
  const report = diagnoseStatus({})
  assert.equal(report.layers.length, 5)
  assert.ok(report.layers.every(layer => layer.state === 'unknown'))
})

test('预检统计文件数与字节数，并判定是否在工作区内', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), '0123456789')
  const report = inspectTarget({ target: dir, cwd: dir })
  assert.equal(report.ok, true)
  assert.equal(report.isDir, true)
  assert.equal(report.files, 2)
  assert.equal(report.bytes, 15)
  assert.equal(report.inside, true)
  assert.equal(report.gitRepo, false, '临时目录不是 git 仓库')
  assert.equal(report.dirty, null)
})

test('预检报告写清规模与工作区位置', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
  const text = fmt(inspectTarget({ target: dir, cwd: dir }))
  assert.match(text, /目录/u)
  assert.match(text, /1 个文件/u)
  assert.match(text, /在内/u)
})

test('路径不可读时返回失败而不是抛错', () => {
  const report = inspectTarget({ target: path.join(tempDir(), 'nope'), cwd: tempDir() })
  assert.equal(report.ok, false)
  assert.match(report.reason, /不可读/u)
  assert.match(fmt(report), /预检失败/u)
})

test('升级核对：原文还在就通过，不在就指出位置', () => {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'a'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a', 'keep.txt'), 'const LIMIT = 1\n')
  fs.writeFileSync(path.join(root, 'a', 'moved.txt'), 'something else entirely\n')
  const patches = [
    { id: 'ok', targets: [{ path: 'a/keep.txt', before: 'const LIMIT = 1' }] },
    { id: 'gone', targets: [{ path: 'a/moved.txt', before: 'const LIMIT = 2' }] },
    { id: 'absent', targets: [{ path: 'a/missing.txt', before: 'x' }] },
  ]
  const report = upgradeReport(root, patches)
  assert.equal(report.checked, 3)
  assert.equal(report.ok, false)
  assert.deepEqual(report.missing.map(item => item.id).sort(), ['absent', 'gone'])
  assert.match(formatUpgrade(report), /失配 2 个/u)
})

test('提示词差异只数非空行，并给出新增与删除', () => {
  const diff = diffPrompt('alpha\nbeta\n', 'alpha\ngamma\n')
  assert.deepEqual(diff.added, ['beta'])
  assert.deepEqual(diff.removed, ['gamma'])
  assert.equal(diff.currentLines, 3)
})

test('规则 id 从文件名推导，非法字符被收敛', () => {
  assert.equal(ruleIdFromPath('/x/My Rules.md'), 'my-rules')
  assert.equal(ruleIdFromPath('/x/中文.md'), 'imported')
})

test('导入规则：写入成功，空文件与非 md 之外的情况分别报错', () => {
  const home = tempDir()
  const source = path.join(tempDir(), 'imported-rule.md')
  fs.writeFileSync(source, '# Rule\n\nbody text\n')
  const ok = importRule(home, source)
  assert.equal(ok.ok, true)
  assert.equal(ok.id, 'imported-rule')
  assert.ok(ok.bytes > 0)

  const empty = path.join(tempDir(), 'empty.md')
  fs.writeFileSync(empty, '   \n')
  assert.equal(importRule(home, empty).ok, false)

  assert.equal(importRule(home, path.join(home, 'nope.md')).ok, false)
})
