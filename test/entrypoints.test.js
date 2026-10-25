// 入口一致性：执行真实适配器，文件读写仅发生在隔离夹具。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { apply } from '../src/plugin.js'
import { run } from '../src/cli.js'
import { inspectPatches } from '../src/patch/service.js'
import { PATCHES } from '../src/patch/index.js'
import { writeDisabled } from '../src/patch/patch-selection.js'
import { applyPatches } from '../src/patch/transaction.js'
import { hashText } from '../src/patch/fsx.js'
import { readRuntimeLimits, switchTier } from '../src/host/capabilities.js'
import { tierConfigPath, writeTier } from '../src/context/tiers.js'

function fixture(t, beforeApply, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-entrypoints-'))
  const home = path.join(dir, 'home')
  const root = path.join(dir, 'host')
  fs.mkdirSync(root, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const commands = new Map()
  const tools = new Map()
  const handlers = new Map()
  let handler
  const ctx = {
    on(event, listener) { handlers.set(event, listener) },
    get() { return undefined },
    systemPrompt: { section() {} },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register(value) { commands.set(value.name, value) } } })
      if (names.includes('tools')) callback({ tools: { register(value) { tools.set(value.name, value) } } })
      if (names.includes('webServer')) callback({
        effect(fn) { fn() },
        webServer: { register(route) { handler = route.handler; return () => {} } },
      })
    },
  }
  beforeApply?.(ctx, home)
  apply(ctx, { ...config, hostRoot: root })
  return { home, root, commands, tools, handler, handlers, ctx }
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

function cli(args, env) {
  const original = process.stdout.write
  let text = ''
  process.stdout.write = (value) => { text += value; return true }
  try { return { code: run(args, env), text } }
  finally { process.stdout.write = original }
}

test('CLI、HTTP、宿主命令和模型工具读取同一份选择并应用', async (t) => {
  const { home, root, commands, tools, handler } = fixture(t)
  for (const patch of PATCHES) {
    const response = await request(handler, 'POST', '/patches/enabled', { id: patch.id, enabled: false })
    assert.equal(response.status, 200)
  }
  const expected = inspectPatches({ root, home }).preflight
  assert.equal(expected.ok, true)
  assert.deepEqual(expected.findings, [])
  const status = await request(handler, 'GET', '/status')
  assert.deepEqual(status.payload.data.preflight, expected)
  assert.equal(status.payload.data.http.mounted, true)
  const env = { DSH_HOME: home }
  assert.equal(cli(['--host-root', root, '--status'], env).code, 0)
  assert.match(commands.get('breaklimit').handler({ rawInput: 'status' }).text, /待写入 0/)
  assert.match(tools.get('breaklimit_status').execute({}, {}), /待写入 0/)
  assert.equal((await request(handler, 'POST', '/apply')).payload.ok, true)
  assert.equal(commands.get('breaklimit').handler({ rawInput: 'apply' }).kind, 'success')
  assert.match(tools.get('breaklimit_apply').execute({}, {}), /已|无需|没有/)
  assert.equal(cli(['--host-root', root, '--apply'], env).code, 0)
  assert.deepEqual(fs.readdirSync(root), [])
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'state.json')), false)
})

test('CLI 回退依据事务记录，不受之后禁用全部补丁影响', (t) => {
  const { home, root } = fixture(t)
  const before = 'const LIMIT = 1\n'
  const target = 'example.js'
  fs.writeFileSync(path.join(root, target), before)
  const result = applyPatches({
    root, home,
    patches: [{ id: 'fixture', kind: 'replace', title: 'Fixture', targets: [
      { path: target, before: 'LIMIT = 1', after: 'LIMIT = 2', expectHits: 1 },
    ] }],
    hashes: { fixture: { [target]: hashText(before) } },
  })
  assert.equal(result.ok, true)
  writeDisabled(home, PATCHES.map(patch => patch.id))
  const reverted = cli(['--host-root', root, '--revert'], { DSH_HOME: home })
  assert.equal(reverted.code, 0)
  assert.equal(fs.readFileSync(path.join(root, target), 'utf8'), before)
})

test('冷启动档位故障修复后，真实装配补交同档预算并避免重复提交', async (t) => {
  const budgets = {
    recommended: { timeoutMs: 1111000, maxTimeoutMs: 1111000, maxOutputBytes: 111111, maxDepth: 1 },
    unrestricted: { timeoutMs: 2222000, maxTimeoutMs: 2222000, maxOutputBytes: 222222, maxDepth: 7 },
  }
  const calls = []
  const configs = {}
  let releaseFirst
  const first = new Promise(resolve => { releaseFirst = resolve })
  const { home, handlers, ctx } = fixture(t, (ctx, home) => {
    fs.mkdirSync(path.dirname(tierConfigPath(home)), { recursive: true })
    fs.writeFileSync(tierConfigPath(home), '{broken')
    const entries = ['bash-sandbox', 'pwsh-sandbox', 'subagent'].map(id => ({
      id: `host:${id}`,
      disabled: false,
      options: { config: {} },
      async update(options) {
        calls.push(id)
        if (calls.length === 1) await first
        configs[id] = options.config
      },
    }))
    ctx.root = { loader: { resolve() { throw new Error('absent') }, entries: () => entries } }
    ctx.get = name => {
      const config = name === 'shell' ? configs['pwsh-sandbox'] : configs.subagent
      return config ? { config: Object.fromEntries(Object.entries(config).map(([key, value]) => [key, { get: () => value }])) } : undefined
    }
  }, { budgets })
  assert.deepEqual(calls, [], '冷启动配置不可信时不提交猜测档位')

  writeTier(home, 'unrestricted')
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const assemble = () => handlers.get('system-prompt/assemble')(assembly, {}, async () => assembly)
  await Promise.all([assemble(), assemble()])
  const concurrentCalls = calls.length
  writeTier(home, 'recommended')
  await Promise.all([assemble(), assemble()])
  assert.equal(calls.length, concurrentCalls, '进行中和已排队档位的重复读取都不能增加提交')
  releaseFirst()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(concurrentCalls, 1, '同一进行中的补提交必须去重')
  assert.equal(calls.length, 6, '提交期间读到的新档位必须排在后面并收敛到最新值')
  assert.deepEqual(readRuntimeLimits(ctx), {
    shell: { timeoutMs: 1111000, maxTimeoutMs: 1111000, maxOutputBytes: 111111 },
    subagents: { maxDepth: 1 },
  })
})

test('连续显式切档与装配竞态最终按最新档位提交', async (t) => {
  const budgets = {
    recommended: { timeoutMs: 1111000, maxTimeoutMs: 1111000, maxOutputBytes: 111111, maxDepth: 1 },
    unrestricted: { timeoutMs: 2222000, maxTimeoutMs: 2222000, maxOutputBytes: 222222, maxDepth: 7 },
  }
  const calls = []
  const configs = {}
  let releaseFirst, enteredFirst
  const first = new Promise(resolve => { releaseFirst = resolve })
  const started = new Promise(resolve => { enteredFirst = resolve })
  const { home, handlers, ctx } = fixture(t, (ctx, home) => {
    fs.mkdirSync(path.dirname(tierConfigPath(home)), { recursive: true })
    fs.writeFileSync(tierConfigPath(home), '{broken')
    const entries = ['bash-sandbox', 'pwsh-sandbox', 'subagent'].map(id => ({
      id: `host:${id}`,
      disabled: false,
      options: { config: {} },
      async update(options) {
        calls.push(id)
        if (calls.length === 1) { enteredFirst(); await first }
        configs[id] = options.config
      },
    }))
    ctx.root = { loader: { resolve() { throw new Error('absent') }, entries: () => entries } }
    ctx.get = name => {
      const config = name === 'shell' ? configs['pwsh-sandbox'] : configs.subagent
      return config ? { config: Object.fromEntries(Object.entries(config).map(([key, value]) => [key, { get: () => value }])) } : undefined
    }
  }, { budgets })

  const unrestricted = switchTier(ctx, home, 'unrestricted', budgets)
  const recommended = switchTier(ctx, home, 'recommended', budgets)
  await started
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  await handlers.get('system-prompt/assemble')(assembly, {}, async () => assembly)
  releaseFirst()
  await Promise.all([unrestricted, recommended])
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(JSON.parse(fs.readFileSync(tierConfigPath(home), 'utf8')).tier, 'recommended')
  assert.equal(calls.length, 9, '两次显式切档与一次装配补交都应完成')
  assert.deepEqual(readRuntimeLimits(ctx), {
    shell: { timeoutMs: 1111000, maxTimeoutMs: 1111000, maxOutputBytes: 111111 },
    subagents: { maxDepth: 1 },
  }, '排队中的旧档位不得最后覆盖最新档位')
})
