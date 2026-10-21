// 版本与更新路由：真实 createHandler + 最小 req/res 桩，不起真实端口。
// 出网一律不走真网络：代理环境清空后用注入的 globalThis.fetch，或用回环上的假代理。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createHandler } from '../src/serve/http.js'
import { localDay, readUpdateState, resetPendingAuto, resetProxyCache, updateStatePath, writeUpdateState } from '../src/context/update.js'

const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-http-update-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const previous = { DSH_HOME: process.env.DSH_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM }
  const proxyPrevious = {}
  process.env.DSH_HOME = home
  // git 的 http.proxy 可能真配了东西，指向不存在的配置文件让它读不到。
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'no-such-gitconfig')
  process.env.GIT_CONFIG_SYSTEM = path.join(dir, 'no-such-gitconfig')
  for (const name of PROXY_ENV) {
    proxyPrevious[name] = process.env[name]
    process.env[name] = ''
  }
  resetProxyCache()
  resetPendingAuto()
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    process.env.DSH_HOME = previous.DSH_HOME
    process.env.GIT_CONFIG_GLOBAL = previous.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_SYSTEM = previous.GIT_CONFIG_SYSTEM
    for (const name of PROXY_ENV) {
      if (proxyPrevious[name] === undefined) delete process.env[name]
      else process.env[name] = proxyPrevious[name]
    }
    resetProxyCache()
    resetPendingAuto()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const handler = createHandler({ get() { return undefined } }, {}, { enabled: true, counters: {} })
  return { home, handler }
}

function stubFetch(responses) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    if (next === undefined) throw new Error('测试没有准备这个请求的响应')
    return next
  }
  return calls
}

const releaseBody = JSON.stringify([
  { tag_name: 'v0.9.5', html_url: 'https://github.com/rumoii/dsh-breaklimit/releases/tag/v0.9.5' },
])

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

test('GET /update 报告状态文件的 kind', async (t) => {
  const { home, handler } = fixture(t)
  writeUpdateState(home, { autoCheckUpdates: false })
  let result = await request(handler, 'GET', '/update')
  assert.equal(result.status, 200)
  assert.equal(result.payload.data.updateState, 'ok')
  assert.equal(result.payload.data.autoCheckUpdates, false)

  fs.writeFileSync(updateStatePath(home), '{ not json', 'utf8')
  result = await request(handler, 'GET', '/update')
  assert.equal(result.status, 200)
  assert.equal(result.payload.data.updateState, 'corrupt', '损坏要透出给调用方，不能装作正常')
})

test('POST /update/dismiss 存归一化后的 x.y.z', async (t) => {
  const { home, handler } = fixture(t)
  const result = await request(handler, 'POST', '/update/dismiss', { version: 'v0.9.5' })
  assert.equal(result.status, 200)
  assert.equal(readUpdateState(home).state.dismissedVersion, '0.9.5', 'v 前缀要剥掉，否则与 latestVersion 永远不相等')
})

test('POST /update/dismiss 拒绝非三段版本', async (t) => {
  const { handler } = fixture(t)
  const result = await request(handler, 'POST', '/update/dismiss', { version: '0.9' })
  assert.equal(result.status, 400)
  assert.equal(result.payload.code, 'invalid_version')
})

test('POST /update/auto-check 校验 enabled 并落盘', async (t) => {
  const { home, handler } = fixture(t)
  const invalid = await request(handler, 'POST', '/update/auto-check', { enabled: 'yes' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.payload.code, 'invalid_enabled')

  const saved = await request(handler, 'POST', '/update/auto-check', { enabled: false })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.data.autoCheckUpdates, false)
  assert.equal(readUpdateState(home).state.autoCheckUpdates, false)
})

test('GET /update/auto 今天查过就不再联网', async (t) => {
  const { home, handler } = fixture(t)
  writeUpdateState(home, { lastAutoCheckDay: localDay() })
  const calls = stubFetch([])
  const result = await request(handler, 'GET', '/update/auto')
  assert.equal(result.status, 200)
  assert.equal(result.payload.data.lastError, null)
  assert.equal(calls.length, 0, '当天已查过时不该发任何请求')
})

test('POST /update/check 成功时回视图', async (t) => {
  const { home, handler } = fixture(t)
  stubFetch([{ status: 200, text: async () => releaseBody }])
  const result = await request(handler, 'POST', '/update/check', {})
  assert.equal(result.status, 200)
  assert.equal(result.payload.data.latestVersion, '0.9.5')
  assert.equal(readUpdateState(home).state.latestVersion, '0.9.5')
})

test('POST /update/check 响应不可解析时报 update_invalid', async (t) => {
  const { handler } = fixture(t)
  stubFetch([{ status: 200, text: async () => 'not json' }])
  const result = await request(handler, 'POST', '/update/check', {})
  assert.equal(result.status, 502)
  assert.equal(result.payload.code, 'update_invalid')
})

test('POST /update/check 内部失败回通用文案，不泄漏绝对路径', async (t) => {
  const { home, handler } = fixture(t)
  // 把 breaklimit 目录占位成文件：检查成功后写状态必然失败，错误文案自带绝对路径。
  fs.writeFileSync(path.join(home, 'breaklimit'), '占位成文件，让状态写不进去', 'utf8')
  stubFetch([{ status: 200, text: async () => releaseBody }])

  const result = await request(handler, 'POST', '/update/check', {})
  assert.equal(result.status, 502)
  assert.equal(result.payload.message, '检查更新失败。', 'fs 错误不能直接回给调用方')
  assert.ok(!result.payload.message.includes(home), '响应里不能出现本机路径')
})
