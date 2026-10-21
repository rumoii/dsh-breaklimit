// 预算提交的两条边界：只覆盖预算键（没有既有 config 时按空对象合并），
// 以及同后缀条目必须唯一且启用。全部用假宿主，不碰真实 Loader，也不对真实宿主提交预算。
import assert from 'node:assert/strict'
import test from 'node:test'

import { MODE_BUDGETS, applyModeBudget, recheckBudget } from '../src/host/capabilities.js'

function slot(value) {
  return { get() { return value } }
}

/** 服务侧读数，用来喂 readRuntimeLimits。缺省时不提供 get。 */
function limitsFor(target) {
  return {
    shell: {
      config: {
        timeoutMs: slot(target.timeoutMs),
        maxTimeoutMs: slot(target.maxTimeoutMs),
        maxOutputBytes: slot(target.maxOutputBytes),
      },
    },
    subagents: { config: { maxDepth: slot(target.maxDepth) } },
  }
}

/**
 * 假宿主：resolve 一律失败，条目只能靠 `:id` 后缀收集——正是缺陷 2 的现场。
 * 每个条目的 update 调用都记进 calls，用来断言「没有提交」。
 */
function fakeHost(specs, limits) {
  const calls = []
  const entries = specs.map((spec) => {
    const entry = {
      id: spec.id,
      options: spec.options,
      disabled: spec.disabled,
      async update(options) {
        calls.push({ id: spec.id, options })
        if (spec.reject !== undefined) throw new Error(spec.reject)
      },
    }
    return entry
  })
  const ctx = {
    root: { loader: { resolve() { throw new Error('根树里解析不到短名') }, entries: () => entries } },
    get(name) {
      if (limits === undefined) return undefined
      return limits[name]
    },
  }
  return { ctx, calls }
}

test('提交时合并条目现有 config，用户设过的键不被冲回默认', async () => {
  const { ctx, calls } = fakeHost([
    { id: 'include:host:bash-sandbox', options: { config: { timeoutMs: 1000 } } },
    { id: 'include:host:pwsh-sandbox', options: { config: { timeoutMs: 1000 } } },
    { id: 'include:host:subagent', options: { config: { maxActiveSubagents: 3 } } },
  ], limitsFor(MODE_BUDGETS.unrestricted))

  const result = await applyModeBudget(ctx, 'unrestricted')
  const sub = calls.find((call) => call.id.endsWith(':subagent'))
  assert.equal(sub.options.config.maxActiveSubagents, 3, 'maxActiveSubagents 必须留在提交的 config 里')
  assert.equal(sub.options.config.maxDepth, MODE_BUDGETS.unrestricted.maxDepth)
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.mismatched, [], '读回值与目标一致时不该有偏差')
})

test('条目没有现有 config 时照常提交，config 只含预算键', async () => {
  const { ctx, calls } = fakeHost([
    { id: 'include:host:bash-sandbox' },
    { id: 'include:host:pwsh-sandbox' },
    { id: 'include:host:subagent' },
  ], limitsFor(MODE_BUDGETS.recommended))

  const result = await applyModeBudget(ctx, 'recommended')
  assert.deepEqual(result.applied.sort(), ['bash-sandbox', 'pwsh-sandbox', 'subagent'])
  assert.deepEqual(result.skipped, [])
  const sub = calls.find((call) => call.id.endsWith(':subagent'))
  assert.deepEqual(sub.options.config, { maxDepth: MODE_BUDGETS.recommended.maxDepth })
  const shell = calls.find((call) => call.id.endsWith(':bash-sandbox'))
  assert.deepEqual(Object.keys(shell.options.config).sort(), ['maxOutputBytes', 'maxTimeoutMs', 'timeoutMs'])
})

test('同后缀命中多个候选（一禁用一启用）时记歧义，不提交', async () => {
  const { ctx, calls } = fakeHost([
    { id: 'include:decoy:subagent', disabled: true, options: { config: { maxActiveSubagents: 3 } } },
    { id: 'include:host:subagent', disabled: false, options: { config: { maxActiveSubagents: 3 } } },
  ], limitsFor(MODE_BUDGETS.recommended))

  const result = await applyModeBudget(ctx, 'recommended')
  assert.equal(calls.length, 0, '歧义候选不许提交')
  const reason = result.skipped.find((text) => text.startsWith('subagent'))
  assert.match(reason, /同后缀条目/u)
  assert.match(reason, /include:decoy:subagent/u)
  assert.match(reason, /include:host:subagent/u)
})

test('唯一且启用的候选：调用 update，提交的 config 含预算键', async () => {
  const { ctx, calls } = fakeHost([
    { id: 'include:host:subagent', disabled: false, options: { config: { maxActiveSubagents: 3 } } },
  ], limitsFor(MODE_BUDGETS.recommended))

  const result = await applyModeBudget(ctx, 'recommended')
  assert.deepEqual(result.applied, ['subagent'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.config.maxDepth, MODE_BUDGETS.recommended.maxDepth)
})

test('唯一候选但条目已禁用：记 skipped，不提交', async () => {
  const { ctx, calls } = fakeHost([
    { id: 'include:host:subagent', disabled: true, options: { config: { maxActiveSubagents: 3 } } },
  ], limitsFor(MODE_BUDGETS.recommended))

  const result = await applyModeBudget(ctx, 'recommended')
  assert.equal(calls.length, 0)
  assert.match(result.skipped.find((text) => text.startsWith('subagent')), /条目已禁用/u)
})

test('提交成功但读回值与目标不一致：记进 mismatched，不静默', async () => {
  const { ctx } = fakeHost([
    { id: 'include:host:subagent', disabled: false, options: { config: { maxActiveSubagents: 3 } } },
  ], limitsFor({ ...MODE_BUDGETS.recommended, maxDepth: 3 }))

  const result = await applyModeBudget(ctx, 'recommended')
  assert.equal(result.applied.includes('subagent'), true)
  assert.match(result.mismatched.find((text) => text.startsWith('subagent')), /maxDepth/u)
})

test('装载期读回不可用：记 unverified，不冒充不一致', async () => {
  const { ctx } = fakeHost([
    { id: 'include:host:subagent', disabled: false, options: { config: { maxActiveSubagents: 3 } } },
  ])

  const result = await applyModeBudget(ctx, 'recommended')
  assert.equal(result.applied.includes('subagent'), true)
  assert.deepEqual(result.mismatched, [], '装载期服务未就绪不等于写错')
  assert.match(result.unverified.find((text) => text.startsWith('subagent')), /读回不可用/u)
})

test('复核：服务就绪且读数一致后，unverified 不再挂着', async () => {
  const { ctx } = fakeHost([
    { id: 'include:host:subagent', disabled: false, options: { config: {} } },
  ])
  const applied = await applyModeBudget(ctx, 'recommended')
  assert.equal(applied.unverified.length, 1)

  const ready = { get: name => limitsFor(MODE_BUDGETS.recommended)[name] }
  const checked = recheckBudget(ready, applied)
  assert.deepEqual(checked.unverified, [])
  assert.deepEqual(checked.mismatched, [])
})

test('复核：读到值与目标不符时转进 mismatched', async () => {
  const { ctx } = fakeHost([
    { id: 'include:host:subagent', disabled: false, options: { config: {} } },
  ])
  const applied = await applyModeBudget(ctx, 'recommended')
  const wrong = { get: name => limitsFor({ ...MODE_BUDGETS.recommended, maxDepth: 3 })[name] }
  const checked = recheckBudget(wrong, applied)
  assert.deepEqual(checked.unverified, [])
  assert.match(checked.mismatched[0], /maxDepth/u)
})

test('复核：没有提交记录时原样返回', () => {
  assert.equal(recheckBudget({ get: () => undefined }, null), null)
})
