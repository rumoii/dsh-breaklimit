// 目标词表：校验、去重、替换优先级、坏文件回退。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { masksPath, maskText, normalizeEntries, readMasks, validEntry, writeMasks, MAX_MASK_TERM } from '../src/host/masks.js'

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-masks-'))
  fs.mkdirSync(path.join(home, 'breaklimit'), { recursive: true })
  return home
}

test('非法条目被拒绝：空白、自映射、超长', () => {
  assert.equal(validEntry({ from: '', to: 'TARGET' }), false)
  assert.equal(validEntry({ from: '   ', to: 'TARGET' }), false)
  assert.equal(validEntry({ from: '百度贴吧', to: '  ' }), false)
  assert.equal(validEntry({ from: 'TARGET', to: 'TARGET' }), false)
  assert.equal(validEntry({ from: 'a'.repeat(MAX_MASK_TERM + 1), to: 'TARGET' }), false)
  assert.equal(validEntry({ from: '百度贴吧', to: 'TARGET' }), true)
  assert.equal(validEntry(null), false)
})

test('去重按 from，后写的覆盖先写的', () => {
  const list = normalizeEntries([
    { from: '百度贴吧', to: 'TARGET' },
    { from: '贴吧', to: 'X' },
    { from: '百度贴吧', to: 'Y' },
    { from: '', to: 'Z' },
  ])
  assert.deepEqual(list, [
    { from: '百度贴吧', to: 'Y' },
    { from: '贴吧', to: 'X' },
  ])
})

test('长词优先：百度贴吧 不会先被 百度 切碎', () => {
  const entries = [
    { from: '百度', to: 'B' },
    { from: '百度贴吧', to: 'TARGET' },
  ]
  const verdict = maskText('我想攻破百度贴吧', entries)
  // 命中数是 1 而不是 2：长词先替换掉之后，短词在文本里已经不存在了。
  // 如果顺序反了，这里会得到「我想攻破BTARGET」和两次命中。
  assert.equal(verdict.text, '我想攻破TARGET')
  assert.equal(verdict.hits, 1)
  assert.deepEqual(verdict.matched, ['百度贴吧'])
})

test('未命中返回原文与零命中', () => {
  const verdict = maskText('读一下 AGENTS.md', [{ from: '百度贴吧', to: 'TARGET' }])
  assert.equal(verdict.text, '读一下 AGENTS.md')
  assert.equal(verdict.hits, 0)
  assert.deepEqual(verdict.matched, [])
})

test('空词表与空文本原样返回', () => {
  assert.deepEqual(maskText('随便一句话', []), { text: '随便一句话', hits: 0, matched: [] })
  assert.deepEqual(maskText('', [{ from: 'a', to: 'b' }]), { text: '', hits: 0, matched: [] })
})

test('读写往返，文件不存在时是空表而不是错误', () => {
  const home = tempHome()
  assert.deepEqual(readMasks(home), { entries: [], error: null })
  const saved = writeMasks(home, [{ from: '百度贴吧', to: 'TARGET' }])
  assert.equal(saved.ok, true)
  assert.equal(fs.existsSync(masksPath(home)), true)
  assert.deepEqual(readMasks(home).entries, [{ from: '百度贴吧', to: 'TARGET' }])
})

test('坏文件不静默当成空表：报错并保留空列表', () => {
  const home = tempHome()
  fs.writeFileSync(masksPath(home), '{ not json', 'utf8')
  const read = readMasks(home)
  assert.deepEqual(read.entries, [])
  assert.equal(typeof read.error, 'string')
})


test('词表不可读可用同实例快照但必须报告错误，冷实例没有可信词表', () => {
  const home = tempHome(), runtime = {}
  writeMasks(home, [{ from: 'REAL', to: 'ALIAS' }])
  readMasks(home, runtime)
  fs.writeFileSync(masksPath(home), '{broken')
  const cached = readMasks(home, runtime)
  assert.equal(cached.entries[0]?.to, 'ALIAS')
  assert.equal(cached.source, 'cached')
  assert.ok(cached.error)
  assert.equal(readMasks(home, {}).unavailable, true)
})
