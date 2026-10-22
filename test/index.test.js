// 宿主入口的纯函数测试。
//
// apply() 需要真实的 Cordis 上下文，属于模块集成层，不在单元测试里仿造——
// 仿出来的上下文只能证明仿造品的行为。这里测的是两处不依赖上下文的逻辑：
// 降级文本的改写判定，以及状态文本的组装。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appliedSummary, describePermissionLayers, formatStatusText, hardenInstructionText } from '../src/plugin.js'
import { buildStatus } from '../src/host/status.js'

// 以下两句照宿主 packages/context/agent-instructions/src/render.ts 抄录，不要按记忆改写。
// SOFT_INTRO 对应 AGENT_INSTRUCTIONS_INTRO（render.ts:18）；SOFT_SCOPE 对应
// additionalSectionText 生成的句子（render.ts:226）接 ADDITIONAL_INSTRUCTIONS_GUIDANCE（render.ts:217）。
// 路径只被反引号包住，外面没有圆括号——这一点写错过一次，代价是作用域句一条都改不动。
const SOFT_INTRO =
  'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
  + 'They do not override system, developer, or direct user instructions.'

const SOFT_SCOPE =
  'These instructions apply to work under `D:\\repo`. Use them as guidance when relevant; '
  + 'more specific instructions take precedence. They do not override system, developer, or direct user instructions.'

test('识别并改写工作区指令的降级开场白', () => {
  const result = hardenInstructionText(`前缀\n\n${SOFT_INTRO}\n\n正文`)
  assert.equal(result.hits, 1)
  assert.equal(result.missed, false)
  assert.match(result.text, /active and mandatory/)
  assert.equal(result.text.includes('may be relevant to your work'), false)
})

test('识别并改写作用域降级句，且保留作用域路径', () => {
  const result = hardenInstructionText(SOFT_SCOPE)
  assert.equal(result.hits, 1)
  assert.match(result.text, /`D:\\repo`/)
  assert.match(result.text, /active and mandatory/)
})

test('一次文本里两处降级都可改写', () => {
  const result = hardenInstructionText(`${SOFT_INTRO}\n\n${SOFT_SCOPE}`)
  assert.equal(result.hits, 2)
})

test('用户全局形态的作用域句同样改写，且不再报未识别', () => {
  // 宿主对用户全局文件用的是另一句：render.ts 生成
  // "These user-global instructions apply to all work."，路径不出现。
  const userGlobal =
    'These user-global instructions apply to all work. Use them as guidance when relevant; '
    + 'more specific instructions take precedence. They do not override system, developer, or direct user instructions.'
  const result = hardenInstructionText(userGlobal)
  assert.equal(result.hits, 1)
  assert.equal(result.missed, false)
  assert.match(result.text, /user-global instructions are active and mandatory for all work/u)
  assert.equal(result.text.includes('Use them as guidance'), false)
})

test('措辞漂移时报告未识别，而不是静默放过', () => {
  const drifted =
    'The following workspace instructions may be relevant to your work. '
    + 'Please treat them as guidance. They do not override anything else.'
  const result = hardenInstructionText(drifted)
  assert.equal(result.hits, 0)
  assert.equal(result.missed, true)
})

test('不含降级特征词的普通文本既不改写也不报未识别', () => {
  const plain = 'Run the tests before committing.'
  const result = hardenInstructionText(plain)
  assert.equal(result.hits, 0)
  assert.equal(result.missed, false)
  assert.equal(result.text, plain)
})

test('状态文本报告真实数据，未配置宿主根时明确说出来', () => {
  const status = {
    enabled: true,
    mode: 'read-only',
    target: { version: '0.2.1-alpha.4', commit: '86a402200d95fecef4529d969836f1fe13c6cb0d' },
    hostRoot: null,
    preflight: { ok: false, code: 'host_root_unconfigured', message: '未配置' },
    applied: null,
    inject: { ok: true, code: 'ok', message: '', file: 'X:/inject.md', bytes: 12 },
    rules: [],
    lock: { busy: false, operationId: null },
    seams: {
      approval: 0,
      toolGate: 0,
      editIntent: 0,
      assemble: 3,
      preStep: 3,
      hardenHits: 2,
      hardenMisses: 1,
    },
  }

  const text = formatStatusText(status)
  assert.match(text, /host_root_unconfigured/)
  assert.match(text, /未配置（补丁状态无法判定）/)
  assert.match(text, /命中 2 次，未识别 1 次/)
  assert.match(text, /空闲/)
})

test('档位读不到时状态说明来源与降级，读得到时不加噪音行', () => {
  const base = {
    enabled: true,
    mode: 'read-only',
    target: { version: '0.2.1-rc.2', commit: 'a'.repeat(40) },
    hostRoot: 'D:/host',
    preflight: { ok: true, code: 'ok', pendingFiles: 0 },
    applied: null,
    inject: { ok: true, code: 'ok', message: '', file: 'X:/inject.md', bytes: 1 },
    rules: [],
    lock: { busy: false, operationId: null },
    seams: { approval: 0, toolGate: 0, editIntent: 0, assemble: 0, preStep: 0, hardenHits: 0, hardenMisses: 0 },
  }
  const broken = formatStatusText({
    ...base,
    sandbox: { available: false, mode: null, error: '宿主未提供 sandboxPolicy' },
  })
  assert.match(broken, /档位来源\s+不可判定（宿主未提供 sandboxPolicy）/u)
  const usable = formatStatusText({
    ...base,
    sandbox: { available: true, mode: 'danger-full-access', error: null },
  })
  assert.equal(usable.includes('档位来源'), false)
})

test('状态文本列出预检阻断项', () => {
  const status = {
    enabled: false,
    mode: 'workspace-write',
    target: { version: '0.2.1-alpha.4', commit: '86a402200d95fecef4529d969836f1fe13c6cb0d' },
    hostRoot: 'D:/host',
    preflight: {
      ok: false,
      code: 'blocked',
      pendingFiles: 0,
      blocked: [{ patchId: 'P-05', path: 'packages/fs/x.ts', reason: '原文命中 0 次，期望 1 次' }],
    },
    // 字段名必须来自生产代码。手写对象曾经写下 appliedAt，而写入端写的是
    // updatedAt——两处各自漂移，状态里一直显示 undefined，测试却一直是绿的。
    applied: appliedSummary({
      operationId: 'tx-1',
      phase: 'committed',
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: { 'a.txt': { before: 'x', after: 'y' } },
    }),
    inject: { ok: false, code: 'inject_too_large', message: '超限', file: 'X:/inject.md', bytes: 999 },
    rules: [{ name: 'demo', title: '示例', kind: 'replace', enabled: true, targets: 1 }],
    lock: { busy: true, operationId: 'tx-2' },
    seams: {
      approval: 1,
      toolGate: 2,
      editIntent: 3,
      assemble: 4,
      preStep: 5,
      hardenHits: 6,
      hardenMisses: 0,
    },
  }

  const text = formatStatusText(status)
  assert.match(text, /P-05/)
  assert.match(text, /原文命中 0 次/)
  assert.match(text, /inject_too_large/)
  assert.match(text, /占用中（tx-2）/)
})

test('应用记录那一行显示真实时间，不出现 undefined', () => {
  const base = {
    enabled: true,
    mode: 'danger-full-access',
    target: { version: '0.2.1-alpha.4', commit: '86a402200d95fecef4529d969836f1fe13c6cb0d' },
    hostRoot: 'D:/host',
    preflight: { ok: true, code: 'ok', pendingFiles: 0, blocked: [] },
    inject: { ok: true, code: 'ok', message: '', file: 'X:/inject.md', bytes: 12 },
    rules: [],
    lock: { busy: false, operationId: null, file: 'X:/operation.lock' },
    seams: {
      approval: 0,
      escalation: 0,
      escalationRejected: 0,
      toolGate: 0,
      editIntent: 0,
      assemble: 0,
      preStep: 0,
      hardenHits: 0,
      hardenMisses: 0,
    },
  }

  const applied = appliedSummary({
    operationId: 'tx-9',
    phase: 'committed',
    updatedAt: '2026-03-04T05:06:07.000Z',
    files: { 'a.txt': {}, 'b.txt': {} },
  })
  const text = formatStatusText({ ...base, applied })

  assert.match(text, /tx-9（2 个文件，2026-03-04T05:06:07\.000Z）/)
  assert.equal(text.includes('undefined'), false)

  // 清单里没有时间时说出来，而不是让一个裸的 undefined 出现在面板上。
  const noTime = formatStatusText({ ...base, applied: appliedSummary({ operationId: 'tx-9', files: {} }) })
  assert.match(noTime, /时间未知/)

  assert.match(formatStatusText({ ...base, applied: null }), /应用记录      无/)
})

test('状态文本如实反映提示词档位', () => {
  const base = {
    enabled: true,
    mode: 'danger-full-access',
    target: { version: '0.2.1-alpha.4', commit: '86a402200d95fecef4529d969836f1fe13c6cb0d' },
    hostRoot: 'D:/host',
    preflight: { ok: true, code: 'ok', pendingFiles: 0, blocked: [] },
    inject: { ok: true, code: 'ok', message: '', file: 'X:/inject.md', bytes: 120 },
    tier: { active: 'recommended', available: ['recommended', 'unrestricted'], bytes: 560 },
    rules: [],
    lock: { busy: false, operationId: null, file: 'X:/operation.lock' },
    seams: {
      approval: 0,
      escalation: 0,
      escalationRejected: 0,
      toolGate: 0,
      editIntent: 0,
      assemble: 0,
      preStep: 0,
      hardenHits: 0,
      hardenMisses: 0,
    },
  }
  const text = formatStatusText(base)
  assert.match(text, /提示词档位\s+recommended（可选：recommended\/unrestricted，560 字节）/)
})

const ASK_TABLE = {
  names: ['read-only', 'workspace-write', 'danger-full-access'],
  resolved: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
  },
}

test('三档全 ask 且默认策略是 ask 时不报告警', () => {
  const result = describePermissionLayers({
    table: ASK_TABLE,
    current: 'danger-full-access',
    mode: 'danger-full-access',
    defaultPreset: 'danger-full-access',
    defaultPolicy: 'ask',
  })
  assert.equal(result.available, true)
  assert.equal(result.layers.length, 3)
  assert.equal(result.warnings.length, 0)
})

test('某一档生效 approval 是 never 时点名该档', () => {
  const table = {
    names: ASK_TABLE.names,
    resolved: {
      ...ASK_TABLE.resolved,
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    },
  }
  const result = describePermissionLayers({ table, defaultPolicy: 'ask' })
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0].code, 'preset_approval_never')
  assert.equal(result.warnings[0].preset, 'danger-full-access')
})

test('审批默认策略是 never 时独立告警，preset 为空', () => {
  const result = describePermissionLayers({ table: ASK_TABLE, defaultPolicy: 'never' })
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0].code, 'default_policy_never')
  assert.equal(result.warnings[0].preset, null)
})

test('档位告警与默认策略告警同时成立时顺序固定', () => {
  const table = {
    names: ['danger-full-access'],
    resolved: { 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } },
  }
  const result = describePermissionLayers({ table, defaultPolicy: 'never' })
  assert.deepEqual(result.warnings.map(item => item.code), ['preset_approval_never', 'default_policy_never'])
})

test('宿主未提供 permissionPresets 时报不可用，默认策略仍独立成立', () => {
  const result = describePermissionLayers({ table: null, defaultPolicy: 'never' })
  assert.equal(result.available, false)
  assert.equal(result.layers.length, 0)
  assert.deepEqual(result.warnings.map(item => item.code), ['default_policy_never'])
})

test('无入参时不抛错，一律报不可用且无告警', () => {
  const result = describePermissionLayers()
  assert.equal(result.available, false)
  assert.equal(result.defaultPolicy, null)
  assert.equal(result.warnings.length, 0)
})

test('某一档解析失败只影响该档，其余档照常判定', () => {
  const table = {
    names: ['read-only', 'broken', 'danger-full-access'],
    resolved: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      broken: { error: 'permission: unknown preset "broken"' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    },
  }
  const result = describePermissionLayers({ table, defaultPolicy: 'ask' })
  assert.deepEqual(result.failures, [{ name: 'broken', error: 'permission: unknown preset "broken"' }])
  assert.deepEqual(result.layers.map(layer => layer.name), ['read-only', 'danger-full-access'])
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0].preset, 'danger-full-access')
})

test('当前预设为 custom 时原样报出且不影响告警', () => {
  const result = describePermissionLayers({ table: ASK_TABLE, current: 'custom', defaultPolicy: 'ask' })
  assert.equal(result.current, 'custom')
  assert.equal(result.warnings.length, 0)
})

// 状态文本层的固定骨架，只服务权限分层这两个用例；各自套不同的 permission 值。
const STATUS_BASE = {
  enabled: true,
  mode: 'danger-full-access',
  target: { version: '0.2.1-alpha.4', commit: '86a402200d95fecef4529d969836f1fe13c6cb0d' },
  hostRoot: 'D:/host',
  preflight: { ok: false, code: 'blocked', pendingFiles: 0, blocked: [] },
  applied: null,
  inject: { ok: true, code: 'ok', message: '', file: 'X:/inject.md', bytes: 120 },
  tier: { active: 'recommended', available: ['recommended', 'unrestricted'], bytes: 1200 },
  rules: [],
  lock: { busy: false, operationId: null, file: 'X:/operation.lock' },
  seams: {
    approval: 0,
    escalation: 0,
    escalationRejected: 0,
    toolGate: 0,
    editIntent: 0,
    assemble: 0,
    preStep: 0,
    hardenHits: 0,
    hardenMisses: 0,
  },
}

const NEVER_TABLE = {
  names: ['read-only', 'workspace-write', 'danger-full-access'],
  resolved: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  },
}

test('状态文本把 never 档的权限告警连点名与当前档位一起报出来', () => {
  const permission = describePermissionLayers({
    table: NEVER_TABLE,
    current: 'danger-full-access',
    mode: 'danger-full-access',
    defaultPreset: 'danger-full-access',
    defaultPolicy: 'never',
  })
  const text = formatStatusText({ ...STATUS_BASE, permission })
  assert.match(text, /权限分层\s+3 档配置，approval 为 never：danger-full-access/)
  assert.match(text, /权限告警\s+.*`danger-full-access` 档生效的 approval 是 never/)
  assert.match(text, /权限告警\s+.*当前会话正处在这一档/)
  assert.match(text, /权限告警\s+.*新会话的审批在宿主瀑布之前就被判驳/)
})

test('live auto 档与配置档分开计数，并说明当前档位不在告警档上', () => {
  const permission = describePermissionLayers({
    table: {
      names: [...NEVER_TABLE.names, 'auto'],
      resolved: { ...NEVER_TABLE.resolved, auto: { sandbox: 'danger-full-access', approval: 'ask' } },
    },
    current: 'read-only',
    defaultPolicy: 'ask',
  })
  const text = formatStatusText({ ...STATUS_BASE, permission })
  assert.match(text, /权限分层\s+3 档配置 \+ auto/)
  assert.match(text, /权限告警\s+.*当前会话不在这一档/)
})

test('宿主未提供预设表时状态文本如实报不可判定，并保留默认策略', () => {
  const permission = describePermissionLayers({ table: null, defaultPolicy: 'never' })
  const text = formatStatusText({ ...STATUS_BASE, permission })
  assert.match(text, /权限分层\s+不可判定（宿主未提供 permissionPresets），审批默认策略 never/)
  assert.match(text, /权限告警\s+.*新会话的审批在宿主瀑布之前就被判驳/)
})

test('档位配置损坏时状态文本报出来，并说明当前按缺省档生效', () => {
  const text = formatStatusText({ ...STATUS_BASE, tier: { ...STATUS_BASE.tier, kind: 'corrupt' } })
  assert.match(text, /档位问题\s+tier_config_corrupt/)
  assert.match(text, /按缺省档 recommended 生效/)
})

test('档位缺失时回落到默认档，不显示已移除的档名', () => {
  const { tier, ...withoutTier } = STATUS_BASE
  const text = formatStatusText(withoutTier)
  assert.match(text, /提示词档位\s+recommended（可选：recommended\/unrestricted/u)
  assert.doesNotMatch(text, /architect|autonomous/u)
})

test('档位配置正常时不出现档位问题行', () => {
  const text = formatStatusText({ ...STATUS_BASE, tier: { ...STATUS_BASE.tier, kind: 'ok' } })
  assert.doesNotMatch(text, /档位问题/)
})

// 状态组装（buildStatus）里 modeSource 的归因与 defaultPreset 的降级。
//
// buildStatus 要拿宿主服务，这里按 seams-order.test.js 的先例桩一个只实现 get() 的
// ctx。返回的服务形状照宿主公开接口（sandboxPolicy.resolve、permissionPresets 的
// defaultPreset getter），断言的是本插件自己的归因与降级分支，不是宿主行为——
// 仿造品证明不了宿主的解析语义，只能证明我们怎么读它。DSH_HOME 指向本用例建的
// 临时目录，不碰真实的 ~/.dsh。

const COUNTERS = {
  approval: 0, escalation: 0, escalationRejected: 0, toolGate: 0, editIntent: 0,
  assemble: 0, preStep: 0, hardenHits: 0, hardenMisses: 0,
}

const stubRuntime = (extra = {}) => ({ enabled: true, counters: { ...COUNTERS }, ...extra })

/** 临时 DSH_HOME 里跑一次真实组装；删除前确认前缀与位置，只清本用例建的目录。 */
function buildWithStub(services, runtime) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-status-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return buildStatus({ get: (key) => services[key] }, {}, runtime)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (home.includes('bkl-status-') && home.startsWith(os.tmpdir())) fs.rmSync(home, { recursive: true, force: true })
  }
}

// 部署默认档是 danger-full-access（bundle.yml）：有会话时按会话档位解析，没会话时
// 宿主 policy.resolve 落的是部署默认档。
const sessionAwarePolicy = {
  resolve: ({ session } = {}) => (session === undefined ? { mode: 'danger-full-access' } : { mode: 'read-only' }),
}

test('状态组装：拿着会话且解析得出档位时 modeSource 是 session', () => {
  const status = buildWithStub(
    { sandboxPolicy: sessionAwarePolicy },
    stubRuntime({ holder: { agent: { session: {} } } }),
  )
  assert.equal(status.mode, 'read-only')
  assert.equal(status.modeSource, 'session')
})

test('状态组装：会话不可得时落在部署默认档，modeSource 是 default，mode 仍如实报出', () => {
  const status = buildWithStub(
    { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } },
    stubRuntime(),
  )
  assert.equal(status.mode, 'danger-full-access')
  assert.equal(status.modeSource, 'default')
})

test('状态组装：档位解析不出来时 modeSource 同样降级为 default', () => {
  const status = buildWithStub(
    { sandboxPolicy: { resolve: () => { throw new Error('sandbox: broken') } } },
    stubRuntime({ holder: { agent: { session: {} } } }),
  )
  assert.equal(status.mode, 'read-only')
  assert.equal(status.modeSource, 'default')
})

test('宿主 defaultPreset getter 抛错时降级为 null，状态组装与格式化都不挂', () => {
  const presets = {
    names: ['read-only', 'danger-full-access'],
    resolve: (presetName) => ({ sandbox: presetName, approval: 'ask' }),
    current: () => 'read-only',
    get defaultPreset() { throw new Error('permission: unknown preset "gone"') },
  }
  const status = buildWithStub(
    { sandboxPolicy: sessionAwarePolicy, permissionPresets: presets },
    stubRuntime({ holder: { agent: { session: {} } } }),
  )
  assert.equal(status.permission.defaultPreset, null)
  // GET /status 的数据源照常组装，终端文本照常格式化，mode 行语义不变。
  assert.match(formatStatusText(status), /当前档位\s+read-only/u)
})

test('defaultPreset 读得到时原样报出', () => {
  const status = buildWithStub(
    {
      sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
      permissionPresets: {
        names: ['read-only'],
        resolve: () => ({ sandbox: 'read-only', approval: 'ask' }),
        current: () => null,
        defaultPreset: 'danger-full-access',
      },
    },
    stubRuntime(),
  )
  assert.equal(status.permission.defaultPreset, 'danger-full-access')
})



