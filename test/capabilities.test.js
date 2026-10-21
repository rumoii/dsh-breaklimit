// 执行层预算的读数：全部用假上下文，不碰真实宿主。
import assert from 'node:assert/strict'
import test from 'node:test'

import { MODE_BUDGETS, RUNTIME_TARGET, applyModeBudget, readRuntimeLimits, resolveBudgets } from '../src/host/capabilities.js'

function volatileSlot(initial) {
  // 宿主的 Volatile 只有 get()。这里刻意不提供 set()，以免测试掩盖这一点。
  return { value: initial, get() { return this.value } }
}

function fakeCtx({ shell = true, subagents = true } = {}) {
  const shellConfig = {
    timeoutMs: volatileSlot(1200000),
    maxTimeoutMs: volatileSlot(1200000),
    maxOutputBytes: volatileSlot(524288),
  }
  const subConfig = { maxDepth: volatileSlot(2) }
  return {
    get(name) {
      if (name === 'shell' && shell) return { config: shellConfig }
      if (name === 'subagents' && subagents) return { config: subConfig }
      return undefined
    },
  }
}

test('读回执行层预算的当前值', () => {
  const now = readRuntimeLimits(fakeCtx())
  assert.deepEqual(now, {
    shell: { timeoutMs: 1200000, maxTimeoutMs: 1200000, maxOutputBytes: 524288 },
    subagents: { maxDepth: 2 },
  })
})

test('读回的值与期望值一致时没有偏差', () => {
  const now = readRuntimeLimits(fakeCtx())
  assert.equal(now.shell.timeoutMs, RUNTIME_TARGET.timeoutMs)
  assert.equal(now.shell.maxTimeoutMs, RUNTIME_TARGET.maxTimeoutMs)
  assert.equal(now.shell.maxOutputBytes, RUNTIME_TARGET.maxOutputBytes)
  assert.equal(now.subagents.maxDepth, RUNTIME_TARGET.maxDepth)
})

test('服务缺席时读回 null，而不是抛错', () => {
  const now = readRuntimeLimits({ get: () => undefined })
  assert.equal(now.shell.timeoutMs, null)
  assert.equal(now.shell.maxTimeoutMs, null)
  assert.equal(now.shell.maxOutputBytes, null)
  assert.equal(now.subagents.maxDepth, null)
})

test('字段不是 Volatile（没有 get）时读回 null', () => {
  const now = readRuntimeLimits({ get: (name) => (name === 'shell' ? { config: { timeoutMs: 100 } } : undefined) })
  assert.equal(now.shell.timeoutMs, null)
})

test('两档预算提交到两个 shell 行与 subagent 行', async () => {
  const calls = []
  const ctx = {
    loader: {
      resolve(id) {
        if (id === 'missing') throw new Error('no entry')
        return { async update(options) { calls.push({ id, config: options.config }) } }
      },
    },
  }
  const result = await applyModeBudget(ctx, 'unrestricted')
  assert.deepEqual(result.applied.sort(), ['bash-sandbox', 'pwsh-sandbox', 'subagent'])
  const shell = calls.find(call => call.id === 'pwsh-sandbox')
  assert.equal(shell.config.timeoutMs, MODE_BUDGETS.unrestricted.timeoutMs)
  assert.equal(shell.config.maxTimeoutMs, MODE_BUDGETS.unrestricted.maxTimeoutMs)
  assert.equal(shell.config.maxOutputBytes, MODE_BUDGETS.unrestricted.maxOutputBytes)
  const sub = calls.find(call => call.id === 'subagent')
  assert.equal(sub.config.maxDepth, 5)
  assert.equal(Object.keys(sub.config).length, 1, 'subagent 只提交 maxDepth，别拖进别的字段')
})

test('条目不存在时记跳过，不影响其它条目', async () => {
  const ctx = {
    loader: {
      resolve(id) {
        if (id === 'subagent') throw new Error('no entry')
        return { async update() {} }
      },
    },
  }
  const result = await applyModeBudget(ctx, 'recommended')
  assert.equal(result.applied.length, 2)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0], /条目不存在/u)
})

test('没有 loader 时全部跳过，不抛错', async () => {
  const result = await applyModeBudget({}, 'recommended')
  assert.equal(result.applied.length, 0)
  assert.equal(result.skipped.length, 3)
})

test('resolveBudgets 缺配置时回落到内置两档', () => {
  assert.equal(resolveBudgets({}), MODE_BUDGETS)
  assert.equal(resolveBudgets(undefined), MODE_BUDGETS)
  const custom = {
    recommended: { ...MODE_BUDGETS.recommended },
    unrestricted: { ...MODE_BUDGETS.unrestricted },
  }
  assert.equal(resolveBudgets({ budgets: custom }), custom)
})

test('配置里的预算被提交，不拿内置值顶替', async () => {
  const calls = []
  const ctx = {
    loader: {
      resolve(id) {
        return { async update(options) { calls.push({ id, config: options.config }) } }
      },
    },
  }
  const budgets = {
    recommended: { timeoutMs: 11, maxTimeoutMs: 22, maxOutputBytes: 33, maxDepth: 44 },
    unrestricted: MODE_BUDGETS.unrestricted,
  }
  await applyModeBudget(ctx, 'recommended', budgets)
  const shell = calls.find(call => call.id === 'bash-sandbox')
  assert.deepEqual(shell.config, { timeoutMs: 11, maxTimeoutMs: 22, maxOutputBytes: 33 })
  const sub = calls.find(call => call.id === 'subagent')
  assert.deepEqual(sub.config, { maxDepth: 44 })
})
