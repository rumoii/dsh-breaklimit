// HTTP 失败路径脱敏与响应契约：真实 createHandler + 最小 req/res 桩，不起真实端口。
//
// fs 失败用「占位」制造：把目标路径做成目录（写入的 rename 必然失败），或把目标的父
// 路径做成文件（读得 ENOTDIR、建目录得 EEXIST，errno 文案都带绝对路径）。读目录在
// POSIX 上只回 EISDIR、errno 不带路径，那种失败断言不出脱敏是否生效，所以不用。
//
// DSH_HOME 有意带空格（John Doe）：旧的路径正则只匹配到第一个空格前，半脱敏会把
// Doe 之后的层级留在响应里。带空格的 home 让每个失败用例同时守住「含空格路径整段脱敏」。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createHandler, redactPathsInText } from '../src/serve/http.js'
import { knownPatchIds } from '../src/patch/patch-selection.js'

const HOME_SEGMENT = 'John Doe'

function fixture(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-redact-'))
  const home = path.join(dir, HOME_SEGMENT)
  fs.mkdirSync(home, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const handler = createHandler({ get() { return undefined } }, config, { enabled: true, counters: {} })
  return { home, dir, handler }
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

/** 整个响应的脱敏断言：盘符、用户目录、home 片段一个都不许出现。 */
function assertSanitized(payload, home, dir) {
  const text = JSON.stringify(payload)
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, text)
  assert.doesNotMatch(text, /[/\\]Users[/\\]/, text)
  assert.equal(text.includes(home), false, text)
  assert.equal(text.includes(HOME_SEGMENT), false, text)
  assert.equal(text.includes(path.basename(dir)), false, text)
}

test('PUT /alias 写失败：errno 原文脱敏，诊断里的 rename 与尾段还在', async (t) => {
  const { home, dir, handler } = fixture(t)
  // masks.json 的位置放一个目录：原子写的 rename 必然失败，errno 文案带全部路径。
  fs.mkdirSync(path.join(home, 'breaklimit', 'masks.json'), { recursive: true })

  const response = await request(handler, 'PUT', '/alias', { entries: [{ from: '甲', to: '乙' }] })

  assert.equal(response.status, 500)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'write_failed')
  assert.match(response.payload.message, /rename/u, response.payload.message)
  assert.match(response.payload.message, /…\//u, response.payload.message)
  assertSanitized(response.payload, home, dir)
})

test('POST /rules/save 写失败：reason 脱敏，写入正文失败的诊断还在', async (t) => {
  const { home, dir, handler } = fixture(t)
  // 正文路径放一个目录：写正文的 rename 必然失败。
  fs.mkdirSync(path.join(home, 'breaklimit', 'bodies', 'demo.md'), { recursive: true })

  const response = await request(handler, 'POST', '/rules/save', {
    id: 'demo', name: '演示', target: 'AGENTS.md', text: '正文\n',
  })

  assert.equal(response.status, 400)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'body_write_failed')
  assert.match(response.payload.message, /写入正文失败/u, response.payload.message)
  assert.match(response.payload.message, /rename/u, response.payload.message)
  assert.match(response.payload.message, /…\//u, response.payload.message)
  assertSanitized(response.payload, home, dir)
})

test('POST /rules/activate 写失败：reason 脱敏，快照处置的诊断还在', async (t) => {
  const { home, dir, handler } = fixture(t)
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '原有内容\n', 'utf8')
  await request(handler, 'POST', '/rules/save', {
    id: 'demo', name: '演示', target: 'AGENTS.md', text: '正文\n',
  })
  // landings 的位置放一个文件：快照读到 ENOTDIR、快照写/副本写建不出目录，errno 都带路径。
  fs.writeFileSync(path.join(home, 'breaklimit', 'landings'), '占位\n', 'utf8')

  const response = await request(handler, 'POST', '/rules/activate', { id: 'demo' })

  assert.equal(response.status, 400)
  assert.equal(response.payload.ok, false)
  // 失败分支随平台不同（读快照、存快照、存外部改动副本），code 统一回 rule_invalid，
  // 诊断在 message 里；断言共同契约：诊断语义还在、路径已折。
  assert.equal(response.payload.code, 'rule_invalid')
  assert.match(
    response.payload.message,
    /激活前原文快照读不到|保存激活前原文失败|保存落点外部改动副本失败/u,
    response.payload.message,
  )
  assert.match(response.payload.message, /…\//u, response.payload.message)
  assertSanitized(response.payload, home, dir)
})

test('POST /patches/enabled 未知 id：400 unknown_patch，不算写盘故障', async (t) => {
  const { handler } = fixture(t)

  const response = await request(handler, 'POST', '/patches/enabled', { id: 'no-such-patch', enabled: false })

  assert.equal(response.status, 400)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'unknown_patch')
  assert.match(response.payload.message, /no-such-patch/u)
})

test('POST /patches/enabled 写盘故障：500 write_failed，文案脱敏', async (t) => {
  const { home, dir, handler } = fixture(t)
  // patches.json 的位置放一个目录：选择配置写不进去。
  fs.mkdirSync(path.join(home, 'breaklimit', 'patches.json'), { recursive: true })

  const response = await request(handler, 'POST', '/patches/enabled', {
    id: knownPatchIds()[0],
    enabled: false,
  })

  assert.equal(response.status, 500)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'write_failed')
  assert.match(response.payload.message, /rename/u, response.payload.message)
  assert.match(response.payload.message, /…\//u, response.payload.message)
  assertSanitized(response.payload, home, dir)
})

test('路径脱敏：含空格路径整段折掉，/mnt、/data、/Volumes 认得', () => {
  // 半脱敏的原缺陷：只折到第一个空格，Doe 之后的层级留在外面。
  assert.equal(redactPathsInText("EPERM: rename 'C:\\Users\\John Doe\\work\\x'"), "EPERM: rename '…/x'")
  assert.equal(redactPathsInText('C:\\Users\\John Doe\\x'), '…/x')
  assert.equal(redactPathsInText('/home/John Doe/x.txt'), '…/x.txt')
  // POSIX 根名单补齐：/mnt、/data、/Volumes。
  assert.equal(redactPathsInText('/mnt/share/proj/a.txt'), '…/a.txt')
  assert.equal(redactPathsInText('/data/svc/run.log'), '…/run.log')
  assert.equal(redactPathsInText('/Volumes/USB/notes.md'), '…/notes.md')
  // 末段含空格的路径同样整段折掉：My App 是末段本身，输出 …/<末段>，不是没折的残余。
  assert.equal(redactPathsInText('C:\\Program Files\\My App'), '…/My App')
})

test('路径脱敏：句子空格后的普通词不被吞，引号外的句子原样保留', () => {
  // 空格后的词不含分隔符且是中文：路径到此为止，诊断语义完整。
  assert.equal(
    redactPathsInText('写入 C:\\Users\\John Doe\\.dsh\\AGENTS.md 失败：磁盘已满。'),
    '写入 …/AGENTS.md 失败：磁盘已满。',
  )
  assert.equal(redactPathsInText('/tmp/John Doe/x 失败'), '…/x 失败')
  // 没有路径的普通句子原样保留。
  assert.equal(redactPathsInText('正文超过上限 512000 字节，未做截断'), '正文超过上限 512000 字节，未做截断')
  // errno 的成对引号路径都折掉，引号外的英文句子词不受影响。
  assert.equal(
    redactPathsInText("EPERM: operation not permitted, rename 'C:\\tmp\\a.tmp' -> 'C:\\tmp\\a' failed"),
    "EPERM: operation not permitted, rename '…/a.tmp' -> '…/a' failed",
  )
})

test('GET /rules/status 透出 pendingActivation：中断的激活意图原样给出，没有时为 null', async (t) => {
  const { home, handler } = fixture(t)

  const empty = await request(handler, 'GET', '/rules/status')
  assert.equal(empty.status, 200)
  assert.equal(empty.payload.data.pendingActivation, null)

  const pending = {
    id: 'demo',
    target: 'AGENTS.md',
    created: true,
    snapshot: true,
    previous: null,
    startedAt: '2026-01-01T00:00:00.000Z',
  }
  fs.mkdirSync(path.join(home, 'breaklimit'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'breaklimit', 'rules.json'),
    JSON.stringify({ version: 2, revision: 3, rules: [], active: null, landing: null, pendingActivation: pending }),
    'utf8',
  )

  const response = await request(handler, 'GET', '/rules/status')
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.data.pendingActivation, pending)
})

test('POST /rules/delete 保留归属文案：快照沿用与自行处置说准，不再提取消激活', async (t) => {
  const { home, handler } = fixture(t)
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '原有内容\n', 'utf8')
  await request(handler, 'POST', '/rules/save', {
    id: 'demo', name: '演示', target: 'AGENTS.md', text: '正文\n',
  })
  await request(handler, 'POST', '/rules/activate', { id: 'demo' })
  // 外部改动落点：删除时无法处置，快照与归属必须留下。
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '手改内容\n', 'utf8')

  const response = await request(handler, 'POST', '/rules/delete', { id: 'demo' })

  assert.equal(response.status, 200)
  assert.equal(response.payload.data.kept, true)
  assert.match(response.payload.message, /快照仍保留在 landings\/AGENTS\.md/u)
  assert.match(response.payload.message, /重新激活到同一落点时会沿用这份快照/u)
  assert.match(response.payload.message, /也可自行处理该文件/u)
  assert.doesNotMatch(response.payload.message, /取消激活时可据此处置/u)
})

test('激活成功响应：keptCopy 只出相对路径，全文无绝对路径', async (t) => {
  const { home, dir, handler } = fixture(t)
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '原有内容\n', 'utf8')
  await request(handler, 'POST', '/rules/save', { id: 'a', name: 'A', target: 'AGENTS.md', text: 'A 正文\n' })
  await request(handler, 'POST', '/rules/activate', { id: 'a' })
  // 外部改动后切到别的落点：AGENTS 的首接快照成孤儿（归属丢给 CLAUDE.md）。
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '外部改动\n', 'utf8')
  await request(handler, 'POST', '/rules/save', { id: 'b', name: 'B', target: 'CLAUDE.md', text: 'B 正文\n' })
  await request(handler, 'POST', '/rules/activate', { id: 'b' })
  // 再激活回 AGENTS：孤儿快照先搬保留副本，keptCopy 随成功结果报出。
  await request(handler, 'POST', '/rules/save', { id: 'c', name: 'C', target: 'AGENTS.md', text: 'C 正文\n' })
  const response = await request(handler, 'POST', '/rules/activate', { id: 'c' })

  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(typeof response.payload.data.keptCopy, 'string')
  assert.equal(path.isAbsolute(response.payload.data.keptCopy), false, response.payload.data.keptCopy)
  assert.match(response.payload.data.keptCopy, /kept-/u, response.payload.data.keptCopy)
  // 成功路径同样过脱敏断言：keptCopy、externalCopy、file 一个绝对路径都不许出网。
  assertSanitized(response.payload, home, dir)
})

test('POST /rules/delete 写失败：正文删除失败的 errno 原文脱敏', async (t) => {
  const { home, dir, handler } = fixture(t)
  await request(handler, 'POST', '/rules/save', { id: 'gamma', name: 'G', target: 'AGENTS.md', text: '正文\n' })
  // 正文位置换成目录：删除正文必然失败，errno 文案带全部路径。
  fs.rmSync(path.join(home, 'breaklimit', 'bodies', 'gamma.md'))
  fs.mkdirSync(path.join(home, 'breaklimit', 'bodies', 'gamma.md'))

  const response = await request(handler, 'POST', '/rules/delete', { id: 'gamma' })

  assert.equal(response.status, 400)
  assert.equal(response.payload.ok, false)
  assert.match(response.payload.message, /正文删除失败/u, response.payload.message)
  assert.match(response.payload.message, /…\//u, response.payload.message)
  assertSanitized(response.payload, home, dir)
})
