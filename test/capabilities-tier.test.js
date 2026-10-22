// 切档入口的预算传参：命令与 POST /tier 切档时，交给 applyModeBudget 的必须是
// config.budgets 的覆盖值，漏传就会静默落回内置 MODE_BUDGETS，doctor 随即误报不一致。
// 走真实调用链：真命令处理器与真 createHandler 路由，假宿主只负责收下提交的 config。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'

import { MODE_BUDGETS } from '../src/host/capabilities.js'
import { registerCommands } from '../src/host/commands.js'
import { createHandler } from '../src/serve/http.js'

// 与内置两档处处不同的一份完整预算：一旦提交值落回内置或错档，断言立刻翻车。
const CUSTOM_BUDGETS = Object.freeze({
  recommended: Object.freeze({
    timeoutMs: 1111000,
    maxTimeoutMs: 1111000,
    maxOutputBytes: 111111,
    maxDepth: 1,
  }),
  unrestricted: Object.freeze({
    timeoutMs: 2222000,
    maxTimeoutMs: 2222000,
    maxOutputBytes: 222222,
    maxDepth: 7,
  }),
})

function fixture(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // 假宿主：resolve 一律失败，条目靠 `:id` 后缀收集（与 capabilities-budget 同款打桩）。
  // update 不改任何真实服务，只把提交上来的 config 记进 calls 供断言。
  const calls = []
  const entries = ['bash-sandbox', 'pwsh-sandbox', 'subagent'].map((short) => ({
    id: `include:host:${short}`,
    options: { config: {} },
    disabled: false,
    async update(options) {
      calls.push({ id: `include:host:${short}`, options })
    },
  }))
  const ctx = {
    root: {
      loader: {
        resolve() { throw new Error('根树里解析不到短名') },
        entries: () => entries,
      },
    },
    get() { return undefined },
  }
  return { home, ctx, calls }
}

/** 命令入口的 applyModeBudget 是 void 提交，等它跑完再断言。 */
async function flushSubmissions() {
  await new Promise((resolve) => setImmediate(resolve))
}

/** 按条目短名取出本次提交的 config。 */
function submittedBy(calls) {
  return Object.fromEntries(calls.map((call) => [call.id, call.options.config]))
}

async function request(handler, method, route, body = {}) {
  const req = new EventEmitter()
  Object.assign(req, {
    method,
    url: `/breaklimit${route}`,
    headers: { host: 'localhost:3082', origin: 'http://localhost:3082' },
  })
  let status
  let payload
  const res = {
    writeHead(value) { status = value },
    end(value) { payload = JSON.parse(value) },
  }
  const pending = handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await pending
  return { status, payload }
}

test('命令入口切档：提交的预算是 config.budgets 覆盖值，不是内置 MODE_BUDGETS', async (t) => {
  const { ctx, calls } = fixture(t, 'bkl-cap-tier-cmd-')
  const commands = new Map()
  ctx.inject = (names, callback) => {
    if (names.includes('commands')) callback({ commands: { register(value) { commands.set(value.name, value) } } })
  }
  registerCommands(ctx, { budgets: CUSTOM_BUDGETS }, { enabled: true, counters: {} })

  const result = commands.get('breaklimit').handler({ rawInput: 'tier unrestricted' })
  assert.equal(result.kind, 'success')
  await flushSubmissions()

  const submitted = submittedBy(calls)
  const want = CUSTOM_BUDGETS.unrestricted
  const shell = ['include:host:bash-sandbox', 'include:host:pwsh-sandbox']
  for (const id of shell) {
    assert.deepEqual(
      submitted[id],
      { timeoutMs: want.timeoutMs, maxTimeoutMs: want.maxTimeoutMs, maxOutputBytes: want.maxOutputBytes },
      `${id} 必须提交 config.budgets 的覆盖值`,
    )
    assert.notEqual(submitted[id].timeoutMs, MODE_BUDGETS.unrestricted.timeoutMs)
  }
  assert.deepEqual(submitted['include:host:subagent'], { maxDepth: want.maxDepth })
  assert.notEqual(submitted['include:host:subagent'].maxDepth, MODE_BUDGETS.unrestricted.maxDepth)
  // 不是错拿了另一档的覆盖值。
  assert.notEqual(submitted['include:host:subagent'].maxDepth, CUSTOM_BUDGETS.recommended.maxDepth)
})

test('POST /tier 切档：提交的预算是 config.budgets 覆盖值，不是内置 MODE_BUDGETS', async (t) => {
  const { ctx, calls } = fixture(t, 'bkl-cap-tier-http-')
  const handler = createHandler(ctx, { budgets: CUSTOM_BUDGETS }, { enabled: true, counters: {} })

  const { status, payload } = await request(handler, 'POST', '/tier', { tier: 'unrestricted' })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.data.tier, 'unrestricted')

  const submitted = submittedBy(calls)
  const want = CUSTOM_BUDGETS.unrestricted
  const shell = ['include:host:bash-sandbox', 'include:host:pwsh-sandbox']
  for (const id of shell) {
    assert.deepEqual(
      submitted[id],
      { timeoutMs: want.timeoutMs, maxTimeoutMs: want.maxTimeoutMs, maxOutputBytes: want.maxOutputBytes },
      `${id} 必须提交 config.budgets 的覆盖值`,
    )
    assert.notEqual(submitted[id].timeoutMs, MODE_BUDGETS.unrestricted.timeoutMs)
  }
  assert.deepEqual(submitted['include:host:subagent'], { maxDepth: want.maxDepth })
  assert.notEqual(submitted['include:host:subagent'].maxDepth, MODE_BUDGETS.unrestricted.maxDepth)
  assert.notEqual(submitted['include:host:subagent'].maxDepth, CUSTOM_BUDGETS.recommended.maxDepth)
})
