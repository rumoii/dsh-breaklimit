// HTTP 规则路由：真实 createHandler + 最小 req/res 桩，不起真实端口。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { bodyLimitFor, createHandler } from '../src/serve/http.js'
import { savedMessage } from '../src/host/status.js'

function fixture(t, config = {}, runtime = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-http-rules-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const handler = createHandler({ get() { return undefined } }, config, { enabled: true, counters: {}, ...runtime })
  return { home, handler }
}

async function request(handler, method, route, body = {}, headers = {}) {
  const req = new EventEmitter()
  Object.assign(req, {
    method,
    url: `/breaklimit${route}`,
    headers: { host: 'localhost:3082', origin: 'http://localhost:3082', ...headers },
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

/** 不经过 JSON.stringify，直接喂一段原始正文，用来制造超过上限的请求体。 */
async function requestRaw(handler, route, raw, headers = {}) {
  const req = new EventEmitter()
  Object.assign(req, {
    method: 'POST',
    url: `/breaklimit${route}`,
    headers: { host: 'localhost:3082', origin: 'http://localhost:3082', ...headers },
  })
  let status
  let payload
  const res = {
    writeHead(value) { status = value },
    end(value) { payload = JSON.parse(value) },
  }
  const pending = handler(req, res)
  req.emit('data', Buffer.from(raw))
  req.emit('end')
  await pending
  return { status, payload }
}

function bodyPath(home, id) {
  return path.join(home, 'breaklimit', 'bodies', `${id}.md`)
}

/** 递归收集响应体里的所有字符串：脱敏要按「整个响应」断言，而不是只挑几个字段。 */
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsIn(item, out)
  return out
}

/** 绝对路径在响应里的三种痕迹：盘符、用户目录、`.dsh` 下的中间层级。 */
function assertNoAbsolutePath(payload) {
  for (const text of stringsIn(payload)) {
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, text)
    assert.doesNotMatch(text, /[/\\]Users[/\\]/, text)
    assert.doesNotMatch(text, /[/\\]home[/\\]/, text)
    assert.doesNotMatch(text, /\.dsh[/\\]breaklimit[/\\]/, text)
  }
}

test('小正文保存成功：响应带名字与写入文件，正文落盘', async (t) => {
  const { home, handler } = fixture(t)
  const text = `${'小'.repeat(300)}\n`
  assert.equal(Buffer.byteLength(text, 'utf8') >= 900, true)

  const response = await request(handler, 'POST', '/rules/save', {
    id: 'demo',
    name: '演示规则',
    target: 'AGENTS.md',
    text,
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.code, 'saved')
  assert.equal(response.payload.data.name, '演示规则')
  assert.equal(response.payload.data.target, 'AGENTS.md')
  assert.match(response.payload.message, /规则已保存/)
  assert.equal(fs.readFileSync(bodyPath(home, 'demo'), 'utf8'), text)
})

test('300 KiB 正文保存成功：旧的 256 KiB 请求体上限不再把它拦成内部错误', async (t) => {
  const { home, handler } = fixture(t)
  const text = `${'a'.repeat(300 * 1024)}\n`

  const response = await request(handler, 'POST', '/rules/save', {
    id: 'big',
    name: '大正文',
    target: 'AGENTS.md',
    text,
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.data.name, '大正文')
  assert.equal(fs.statSync(bodyPath(home, 'big')).size, Buffer.byteLength(text, 'utf8'))
})

test('超过请求体上限：413 too_large，且不落盘', async (t) => {
  const { home, handler } = fixture(t)
  // 字面量 4 MiB：明显超过按 6 倍转义余量推导出的上限，也不等于任何一个实现常量。
  const text = 'x'.repeat(4 * 1024 * 1024)
  const raw = JSON.stringify({ id: 'huge', name: '超大', target: 'AGENTS.md', text })

  const response = await requestRaw(handler, '/rules/save', raw)

  assert.equal(response.status, 413)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'too_large')
  assert.match(response.payload.message, /正文超过 \d+ 字节上限/)
  assert.equal(response.payload.message.includes(home), false)
  assert.equal(fs.existsSync(bodyPath(home, 'huge')), false)
})

test('上限体积的正文能装进请求体：控制字符按最坏转义算也进得来', async (t) => {
  const { home, handler } = fixture(t)
  // 524288 个控制字符：UTF-8 占 524288 字节，JSON 里展开成 3,145,790 字节的请求体。
  // 旧的 min(1 MiB, 2 倍) 上限把它挡成 413；按 6 倍余量推导才装得下。
  const text = String.fromCharCode(1).repeat(524288)

  const response = await request(handler, 'POST', '/rules/save', {
    id: 'escape',
    name: '最坏转义',
    target: 'AGENTS.md',
    text,
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(fs.statSync(bodyPath(home, 'escape')).size, 524288)
})

test('请求体放宽不等于正文上限放宽：多一个字节仍是 rule_invalid', async (t) => {
  const { home, handler } = fixture(t)
  const text = String.fromCharCode(1).repeat(524289)

  const response = await request(handler, 'POST', '/rules/save', {
    id: 'over',
    name: '超一个字节',
    target: 'AGENTS.md',
    text,
  })

  assert.equal(response.status, 400)
  assert.equal(response.payload.code, 'rule_invalid')
  assert.match(response.payload.message, /上限/)
  assert.equal(fs.existsSync(bodyPath(home, 'over')), false)
})

test('请求体上限按 6 倍转义余量推导，没有固定封顶', () => {
  // 字面量：载荷 × 6 + 64 KiB。
  assert.equal(bodyLimitFor(524288), 3211264)
  assert.equal(bodyLimitFor(1024), 1024 * 6 + 65536)
  // 载荷上限调大，请求体上限必须跟着涨。旧的 min(1 MiB, 载荷 × 2) 就是死在这一条上。
  assert.ok(bodyLimitFor(4 * 1024 * 1024) > 4 * 1024 * 1024)
})

test('savedMessage 两支：同步与未同步，且不把落点标志当对象解引用', () => {
  const synced = savedMessage({
    meta: { name: '演示', target: 'AGENTS.md' },
    landingSynced: true,
    landingStale: false,
    landingMoved: false,
  })
  assert.equal(typeof synced, 'string')
  assert.notEqual(synced.trim(), '')
  assert.match(synced, /已同步到写入文件/)
  assert.doesNotMatch(synced, /未同步/)

  const unsynced = savedMessage({
    meta: { name: '演示', target: 'AGENTS.md' },
    landingSynced: false,
    landingStale: false,
    landingMoved: false,
  })
  assert.match(unsynced, /未同步到写入文件/)
})

test('Host 栅栏：默认回环名单放行，名单外的 Host 在读路由上同样 403', async (t) => {
  const { home, handler } = fixture(t)
  fs.writeFileSync(path.join(home, 'breaklimit-inject.md'), '注入正文\n', 'utf8')

  const loopback = await request(handler, 'GET', '/status', {}, {
    host: '127.0.0.1:3081',
    origin: 'http://127.0.0.1:3081',
  })
  assert.equal(loopback.status, 200)

  // 读路由也受约束：GET /override 一次返回完整注入正文，rebinding 页面能读到它。
  for (const route of ['/status', '/override', '/patches', '/rules/status']) {
    const blocked = await request(handler, 'GET', route, {}, {
      host: 'evil.example:3081',
      origin: 'http://evil.example:3081',
    })
    assert.equal(blocked.status, 403, route)
    assert.equal(blocked.payload.ok, false, route)
    assert.equal(blocked.payload.code, 'host_not_allowed', route)
    assert.equal('data' in blocked.payload, false, route)
  }

  // rebinding 的形态：host 与 origin 完全一致，同源检查放行，Host 栅栏拦下。
  const fence = await request(handler, 'GET', '/override', {}, {
    host: 'evil.example:3081',
    origin: 'http://evil.example:3081',
  })
  assert.match(fence.payload.message, /allowedHosts/)
  assert.equal(JSON.stringify(fence.payload).includes('注入正文'), false)
})

test('写请求同受 Host 栅栏约束：合法 Origin 也救不回来，回环 Host 下契约不变', async (t) => {
  const { home, handler } = fixture(t)
  const body = { id: 'guard', name: '栅栏', target: 'AGENTS.md', text: '正文\n' }

  const blocked = await request(handler, 'POST', '/rules/save', body, {
    host: 'evil.example:3081',
    origin: 'http://evil.example:3081',
  })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.payload.code, 'host_not_allowed')
  assert.equal(fs.existsSync(bodyPath(home, 'guard')), false)

  const saved = await request(handler, 'POST', '/rules/save', body, {
    host: '127.0.0.1:3081',
    origin: 'http://127.0.0.1:3081',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.code, 'saved')
  assert.equal(fs.existsSync(bodyPath(home, 'guard')), true)
})

test('sec-fetch-site 为 cross-site 时 403 cross_site，缺失与其余取值放行', async (t) => {
  const { handler } = fixture(t)

  const blockedRead = await request(handler, 'GET', '/status', {}, { 'sec-fetch-site': 'cross-site' })
  assert.equal(blockedRead.status, 403)
  assert.equal(blockedRead.payload.ok, false)
  assert.equal(blockedRead.payload.code, 'cross_site')
  assert.equal('data' in blockedRead.payload, false)

  const blockedWrite = await request(handler, 'POST', '/enabled', { enabled: true }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(blockedWrite.status, 403)
  assert.equal(blockedWrite.payload.code, 'cross_site')

  for (const site of ['same-origin', 'same-site', 'none']) {
    const response = await request(handler, 'GET', '/status', {}, { 'sec-fetch-site': site })
    assert.equal(response.status, 200, site)
  }
  const missing = await request(handler, 'GET', '/status')
  assert.equal(missing.status, 200)
})

test('allowedHosts 不带端口匹配任意端口', async (t) => {
  const { handler } = fixture(t, { allowedHosts: ['nas.local'] })

  const viaName = await request(handler, 'GET', '/status', {}, { host: 'nas.local:8443', origin: 'http://nas.local:8443' })
  assert.equal(viaName.status, 200)

  const loopback = await request(handler, 'GET', '/status', {}, {
    host: '127.0.0.1:3081',
    origin: 'http://127.0.0.1:3081',
  })
  assert.equal(loopback.status, 403)
  assert.equal(loopback.payload.code, 'host_not_allowed')
  assert.doesNotMatch(loopback.payload.message, /默认回环名单/)
})

test('allowedHosts 带端口时要求端口相同', async (t) => {
  const { handler } = fixture(t, { allowedHosts: ['127.0.0.1:3081'] })

  const same = await request(handler, 'GET', '/status', {}, {
    host: '127.0.0.1:3081',
    origin: 'http://127.0.0.1:3081',
  })
  assert.equal(same.status, 200)

  const other = await request(handler, 'GET', '/status', {}, {
    host: '127.0.0.1:4000',
    origin: 'http://127.0.0.1:4000',
  })
  assert.equal(other.status, 403)
  assert.equal(other.payload.code, 'host_not_allowed')
})

test('500 只回 code：internal_error 不带上原始 message 与绝对路径，细节进 stderr', async (t) => {
  const leak = "EACCES: permission denied, open 'D:\\secret\\state.json'"
  const { handler } = fixture(t, {
    get injectFile() { throw new Error(leak) },
  })

  const original = process.stderr.write
  let logged = ''
  process.stderr.write = (chunk) => { logged += String(chunk); return true }
  let response
  try {
    response = await request(handler, 'GET', '/override')
  } finally {
    process.stderr.write = original
  }

  assert.equal(response.status, 500)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'internal_error')
  assert.equal(response.payload.message.includes(leak), false)
  assert.doesNotMatch(response.payload.message, /[A-Za-z]:[\\/]/)
  assert.doesNotMatch(JSON.stringify(response.payload), /secret/)
  assert.match(logged, /internal_error/)
  assert.match(logged, /secret/)
})

test('GET /override 在合法 Host 下仍返回 data.text 的完整注入正文', async (t) => {
  const { home, handler } = fixture(t)
  const file = path.join(home, 'breaklimit-inject.md')
  const text = '注入正文第一行\n第二行\n'
  fs.writeFileSync(file, text, 'utf8')

  const response = await request(handler, 'GET', '/override', {}, {
    host: '127.0.0.1:3081',
    origin: 'http://127.0.0.1:3081',
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.code, 'ok')
  // 路径在 HTTP 边界脱敏：CLI 与终端仍显示绝对路径，响应只留最后一段。
  assert.equal(response.payload.data.file, '…/breaklimit-inject.md')
  assert.equal(response.payload.data.text, text.trim())
})

test('GET /status 的成功响应不带绝对路径：hostRoot 与注入/锁文件只留最后一段', async (t) => {
  const { handler } = fixture(t, { hostRoot: 'C:\\Users\\someone\\projects\\deepseek-harness' })

  const response = await request(handler, 'GET', '/status')

  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.data.hostRoot, '…/deepseek-harness')
  assert.equal(response.payload.data.inject.file.startsWith('…/'), true)
  assert.equal(response.payload.data.lock.file.startsWith('…/'), true)
  assertNoAbsolutePath(response.payload)
})

test('GET /override 与 POST /override 的 data.file 同样脱敏，data.text 仍是写入的正文', async (t) => {
  const { home, handler } = fixture(t)
  const text = '注入正文第一行\n第二行\n'

  const saved = await request(handler, 'POST', '/override', { text })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.code, 'saved')
  assert.equal(saved.payload.data.file, '…/breaklimit-inject.md')
  assert.equal(saved.payload.data.file.includes(home), false)
  assertNoAbsolutePath(saved.payload)

  const response = await request(handler, 'GET', '/override')
  assert.equal(response.status, 200)
  assert.equal(response.payload.code, 'ok')
  assert.equal(response.payload.data.file, '…/breaklimit-inject.md')
  assert.equal(response.payload.data.file.includes(home), false)
  assert.equal(response.payload.data.text, text.trim())
  assertNoAbsolutePath(response.payload)
})

test('脱敏对 POSIX 路径同样成立：带尾斜杠的根与用户目录下的注入文件都只留最后一段', async (t) => {
  const { handler } = fixture(t, {
    hostRoot: '/srv/rumo/harness/workspace/',
    injectFile: '/home/rumo/.dsh/breaklimit/inject.md',
  })

  const status = await request(handler, 'GET', '/status')
  assert.equal(status.status, 200)
  assert.equal(status.payload.data.hostRoot, '…/workspace')
  assert.equal(status.payload.data.lock.file, '…/operation.lock')
  assertNoAbsolutePath(status.payload)

  // GET /override 只读：配置的注入文件不存在时也不会去建它。
  const override = await request(handler, 'GET', '/override')
  assert.equal(override.status, 200)
  assert.equal(override.payload.data.file, '…/inject.md')
  assertNoAbsolutePath(override.payload)
})

test('激活规则：正文写入的落点脱敏，响应里不带绝对路径', async (t) => {
  const { handler } = fixture(t)
  await request(handler, 'POST', '/rules/save', { id: 'demo', name: '演示', target: 'AGENTS.md', text: '正文\n' })

  const response = await request(handler, 'POST', '/rules/activate', { id: 'demo' })

  assert.equal(response.status, 200)
  assert.equal(response.payload.code, 'activated')
  assert.match(response.payload.message, /正文写入 …\/AGENTS\.md/u)
  assert.equal(response.payload.data.file, '…/AGENTS.md')
  assertNoAbsolutePath(response.payload)
})

test('删除激活中的规则：落点被外部改过时说明快照仍保留', async (t) => {
  const { home, handler } = fixture(t)
  // 落点原来就有内容，激活时才会留下原文快照；落点不存在时没有东西可存。
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '原有内容\n', 'utf8')
  await request(handler, 'POST', '/rules/save', { id: 'demo', name: '演示', target: 'AGENTS.md', text: '正文\n' })
  await request(handler, 'POST', '/rules/activate', { id: 'demo' })
  // 外部改动落点：删除时无法处置，快照与归属必须留下。
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '手改内容\n', 'utf8')

  const response = await request(handler, 'POST', '/rules/delete', { id: 'demo' })

  assert.equal(response.status, 200)
  assert.equal(response.payload.data.kept, true)
  assert.match(response.payload.message, /landings\/AGENTS\.md/u)
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'landings', 'AGENTS.md')), true)
  assertNoAbsolutePath(response.payload)
})


test('跨落点收尾失败时 HTTP 如实报告新激活与待处理状态，后续状态可见', async t => {
  const { home, handler } = fixture(t)
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'ORIGINAL')
  await request(handler, 'POST', '/rules/save', { id: 'alpha', text: 'A', target: 'AGENTS.md' })
  await request(handler, 'POST', '/rules/save', { id: 'beta', text: 'B', target: 'CLAUDE.md' })
  await request(handler, 'POST', '/rules/activate', { id: 'alpha' })
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === path.join(home, 'AGENTS.md')) throw new Error('old target busy')
    return rename(from, to)
  }
  try {
    const activated = await request(handler, 'POST', '/rules/activate', { id: 'beta' })
    assert.equal(activated.status, 200)
    assert.equal(activated.payload.data.cleanupPending, true)
    assert.match(activated.payload.message, /新规则已生效.*收尾尚未完成/)
    assertNoAbsolutePath(activated.payload)
    const status = await request(handler, 'GET', '/status')
    assert.equal(status.payload.data.activeRule, 'beta')
    assert.equal(status.payload.data.pendingActivation.phase, 'cleanup')
    const blocked = await request(handler, 'POST', '/rules/activate', { id: '' })
    assert.equal(blocked.status, 409)
  } finally { fs.renameSync = rename }
  const off = await request(handler, 'POST', '/rules/activate', { id: '' })
  assert.equal(off.payload.code, 'deactivated')
  assert.equal(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), 'ORIGINAL')
  assert.equal(fs.existsSync(path.join(home, 'CLAUDE.md')), false)
})

test('status.ensure 的失败文案出网前脱敏：errno 原文不带出绝对路径', async (t) => {
  const { handler } = fixture(t, {}, {
    ensure: { error: String.raw`规则清单读不到，已跳过收拢：EACCES: permission denied, open 'C:\Users\rumo\.dsh\rules.json'` },
  })
  const status = await request(handler, 'GET', '/status')
  assert.equal(status.status, 200)
  assert.equal(typeof status.payload.data.ensure.error, 'string')
  assert.equal(status.payload.data.ensure.error.includes(String.raw`C:\Users`), false, 'ensure.error 不应带出盘符与用户目录')
  assertNoAbsolutePath(status.payload)
})
