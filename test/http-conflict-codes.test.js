// 并发冲突状态码：清单 revision 冲突与规则锁被占用回 409，输入非法仍是 400。
//
// 冲突按真实 writeIndex 窗口制造：临时文件落盘后、改名之前，不守锁的写者换掉清单
// （见 rules.js 的版本校验），与 test/rules-written-hash.test.js 同做法；锁冲突用
// src/patch/lock.js 的 acquireFileLock 手持。路由走真实 createHandler + 最小 req/res
// 桩（同 test/http-rules.test.js）。断言落在 HTTP 状态与信封 code 上：调用方靠它们把
// 「有人在并发操作，重试即可」与「你输入错了」分开。
//
// 信封 code 维持各路由原值（硬约束）：/rules/save 透传失败 code（locked / conflict），
// activate / delete / reset 的失败 code 统一塌缩为 rule_invalid（既有契约，见
// test/http-redaction.test.js），这三条路由上只把状态码改成 409，用例一并钉住。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createHandler } from '../src/serve/http.js'
import { acquireFileLock, releaseFileLock } from '../src/patch/lock.js'
import { rulesIndexPath } from '../src/context/rules.js'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-conflict-codes-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const handler = createHandler({ get() { return undefined } }, {}, { enabled: true, counters: {} })
  return { home, handler }
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

function bodyPath(home, id) {
  return path.join(home, 'breaklimit', 'bodies', `${id}.md`)
}

function readIndexFile(home) {
  return JSON.parse(fs.readFileSync(rulesIndexPath(home), 'utf8'))
}

/**
 * 在第 n 次 rules.json 临时文件落盘时把清单换成外部版本，模拟不守锁的写者。
 * 变换点正是 writeIndex 的冲突窗口（临时文件落盘后、改名之前的版本校验）。
 * transforms：{ 第几次临时文件落盘: (当前清单) => 外部清单 }。
 */
function externalIndexWrites(home, transforms) {
  const originalWrite = fs.writeFileSync
  let count = 0
  fs.writeFileSync = (file, data, ...rest) => {
    const written = originalWrite(file, data, ...rest)
    if (String(file).includes('.rules.json.bkl-')) {
      count += 1
      const transform = transforms[count]
      if (transform !== undefined) {
        const current = JSON.parse(fs.readFileSync(rulesIndexPath(home), 'utf8'))
        originalWrite(rulesIndexPath(home), `${JSON.stringify(transform(current), null, 2)}\n`, 'utf8')
      }
    }
    return written
  }
  return () => { fs.writeFileSync = originalWrite }
}

test('清单 revision 冲突：POST /rules/save 回 409 conflict，外部写者的版本不被覆盖', async (t) => {
  const { home, handler } = fixture(t)
  // 先建好清单，才有可被外部换掉的 rules.json。
  const seed = await request(handler, 'POST', '/rules/save', { id: 'seed', name: '种子', target: 'AGENTS.md', text: '种子正文\n' })
  assert.equal(seed.status, 200)

  // 本次保存的清单写入撞进冲突窗口：外部写者把 revision 改成 99 并塞进一条别的规则。
  const restore = externalIndexWrites(home, {
    1: current => ({
      ...current,
      revision: 99,
      rules: [...current.rules, { id: 'external', name: '外部', target: 'AGENTS.md', activatedAt: null }],
    }),
  })
  let response
  try {
    response = await request(handler, 'POST', '/rules/save', { id: 'beta', name: '乙', target: 'AGENTS.md', text: 'B 正文\n' })
  } finally {
    restore()
  }

  assert.equal(response.status, 409)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'conflict')
  assert.match(response.payload.message, /读写之间/u, response.payload.message)
  // 正文已落盘、清单一个字节没写：外部写者的版本原样还在。
  assert.equal(response.payload.data.bodyWritten, true)
  assert.equal(response.payload.data.indexWritten, false)
  assert.equal(readIndexFile(home).revision, 99)
  assert.equal(readIndexFile(home).rules.some(rule => rule.id === 'external'), true)
})

test('规则锁被占用：POST /rules/save 回 409 locked，不排队也不落盘', async (t) => {
  const { home, handler } = fixture(t)
  const handle = acquireFileLock(home, 'holder-conflict-codes')
  assert.equal('conflict' in handle, false, '本次应持锁成功')
  t.after(() => releaseFileLock(handle))

  const response = await request(handler, 'POST', '/rules/save', { id: 'demo', name: '演示', target: 'AGENTS.md', text: '正文\n' })

  assert.equal(response.status, 409)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'locked')
  assert.match(response.payload.message, /占用/u, response.payload.message)
  assert.equal(response.payload.data.bodyWritten, false)
  assert.equal(fs.existsSync(bodyPath(home, 'demo')), false)
})

test('输入非法仍是 400：非法规则 target 不跟着改报 409', async (t) => {
  const { home, handler } = fixture(t)

  const response = await request(handler, 'POST', '/rules/save', {
    id: 'demo', name: '演示', target: 'BOOT.INI', text: '正文\n',
  })

  assert.equal(response.status, 400)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'invalid_target')
  assert.equal(fs.existsSync(bodyPath(home, 'demo')), false)
})

test('输入非法仍是 400：激活不存在的规则回 400，不借并发冲突改报 409', async (t) => {
  const { handler } = fixture(t)

  const response = await request(handler, 'POST', '/rules/activate', { id: 'nope' })

  assert.equal(response.status, 400)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.code, 'rule_invalid')
})

test('activate（含取消激活）/delete/reset 的锁冲突同样 409，信封 code 维持 rule_invalid', async (t) => {
  const { home, handler } = fixture(t)
  const handle = acquireFileLock(home, 'holder-conflict-codes')
  assert.equal('conflict' in handle, false, '本次应持锁成功')
  t.after(() => releaseFileLock(handle))

  const deactivate = await request(handler, 'POST', '/rules/activate', {})
  const remove = await request(handler, 'POST', '/rules/delete', { id: 'demo' })
  const reset = await request(handler, 'POST', '/rules/reset', {})

  for (const [name, response] of [['deactivate', deactivate], ['delete', remove], ['reset', reset]]) {
    assert.equal(response.status, 409, name)
    assert.equal(response.payload.ok, false, name)
    assert.equal(response.payload.code, 'rule_invalid', name)
    assert.match(response.payload.message, /占用/u, name)
  }
})
