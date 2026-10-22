// 审批分流测试：升级审批与普通审批走不同的路。
//
// 这一组盯的是只读档的硬边界。宿主允许 read-only 升到 workspace-write 甚至
// danger-full-access，所以"把审批整份交还宿主"等于没有边界；而"把什么都驳回"
// 又会连宿主自己的普通询问一起拒掉。两条都要验。
//
// 判定依据是 reason 前缀，所以这里也覆盖它不是前缀时的行为——一个以类似文字
// 开头的普通理由不能被误判成升级请求。

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { isolateHome } from './support/.helpers.mjs'

/** 最小可用的上下文：只记录监听器，并让档位可控。 */
function harness(t, mode) {
  const handlers = new Map()
  const ctx = {
    on(event, fn) {
      handlers.set(event, fn)
    },
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) }
      return undefined
    },
    inject() {},
    systemPrompt: { section() {} },
  }
  isolateHome(t)
  apply(ctx, { enabled: true })
  return handlers
}

async function decide(handlers, request) {
  const handler = handlers.get('approval/request')
  assert.equal(typeof handler, 'function', 'approval/request 监听器未注册')
  let delegated = false
  const next = async () => {
    delegated = true
    return 'unavailable'
  }
  const outcome = await handler(request, next)
  return { outcome, delegated }
}

const escalation = (mode = 'workspace-write') => ({
  reason: `escalate sandbox to ${mode}: 用户要求写入工作区`,
  agent: {},
})
const plain = () => ({ reason: 'tool requires approval', agent: {} })

test('完全权限档：升级与普通审批都放行', async (t) => {
  const handlers = harness(t, 'danger-full-access')
  assert.equal((await decide(handlers, escalation())).outcome, 'allowed-once')
  assert.equal((await decide(handlers, plain())).outcome, 'allowed-once')
})

test('只读档：升级审批被挡回，且不交给宿主', async (t) => {
  const handlers = harness(t, 'read-only')
  const result = await decide(handlers, escalation())
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.delegated, false)
})

test('只读档：普通审批交还宿主，不替宿主拒绝', async (t) => {
  const handlers = harness(t, 'read-only')
  const result = await decide(handlers, plain())
  assert.equal(result.delegated, true)
})

test('工作区档：升级到完全权限同样被挡回', async (t) => {
  const handlers = harness(t, 'workspace-write')
  const result = await decide(handlers, escalation('danger-full-access'))
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.delegated, false)
})

test('没有 reason 的审批按普通处理', async (t) => {
  const handlers = harness(t, 'read-only')
  const result = await decide(handlers, { agent: {} })
  assert.equal(result.delegated, true)
})

test('reason 只是以相似文字开头时不误判为升级', async (t) => {
  const handlers = harness(t, 'read-only')
  const result = await decide(handlers, { reason: 'escalate sandboxing later', agent: {} })
  assert.equal(result.delegated, true)
})

test('关闭接管后一切交还宿主', async (t) => {
  const handlers = new Map()
  const ctx = {
    on(event, fn) {
      handlers.set(event, fn)
    },
    get(name) {
      return name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : undefined
    },
    inject() {},
    systemPrompt: { section() {} },
  }
  isolateHome(t)
  apply(ctx, { enabled: false })

  const result = await decide(handlers, escalation())
  assert.equal(result.delegated, true)
})
