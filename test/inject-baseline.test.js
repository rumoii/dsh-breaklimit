// 自定义正文的基线记录：陈旧判定、缺失与损坏的分流、恢复内置后的状态。
//
// 这些用例盯的是一次真实缺陷的两半：保存自定义正文后插件升级，内置正文的改进
// 再也进不来，而界面只说「正在用你的版本」；以及恢复内置之后，界面把内置正文
// 报成用户的版本。前者靠基线判定，后者靠「文件存在」与「正文生效」分开。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BASELINE_FILE,
  baselinePath,
  baselineState,
  builtinFingerprint,
  readBaseline,
  removeBaseline,
  writeBaseline,
} from '../src/context/inject-baseline.js'
import { PACKAGE_INJECT_PATH } from '../src/context/inject-file.js'

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-inject-baseline-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

const FAKE_HASH = `sha256:${'0'.repeat(64)}`

test('builtinFingerprint 对内置正文按字节取指纹，两次调用一致', () => {
  const first = builtinFingerprint()
  const second = builtinFingerprint()
  assert.notEqual(first, null)
  assert.match(first.hash, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(first.bytes, fs.statSync(PACKAGE_INJECT_PATH).size)
  assert.deepEqual(first, second)
})

test('builtinFingerprint 读不到文件时返回 null，不伪造指纹', () => {
  assert.equal(builtinFingerprint(() => { throw new Error('ENOENT') }), null)
})

test('保存时的基线等于当前内置：判定为 current', (t) => {
  const home = fixture(t)
  writeBaseline(home, builtinFingerprint())
  assert.equal(readBaseline(home).kind, 'ok')
  assert.equal(baselineState(home, { active: true }).state, 'current')
})

test('基线不等于当前内置：判定为 stale，并带回两侧版本', (t) => {
  const home = fixture(t)
  writeBaseline(home, { hash: FAKE_HASH, bytes: 1, plugin: '0.9.4' })
  const state = baselineState(home, { active: true })
  assert.equal(state.state, 'stale')
  assert.equal(state.saved.plugin, '0.9.4')
  assert.equal(state.builtin.plugin, builtinFingerprint().plugin)
})

test('没有基线记录：判不出新旧，报 unknown 而不是 stale', (t) => {
  const home = fixture(t)
  assert.equal(readBaseline(home).kind, 'absent')
  const state = baselineState(home, { active: true })
  assert.equal(state.state, 'unknown')
  assert.equal(state.reason, 'no_baseline')
})

test('用户文件没在生效时，基线不参与判定', (t) => {
  const home = fixture(t)
  writeBaseline(home, { hash: FAKE_HASH, bytes: 1, plugin: '0.9.4' })
  assert.equal(baselineState(home, { active: false }).state, 'absent')
})

test('基线记录损坏：报 unknown 并带原因，不抛异常', (t) => {
  const home = fixture(t)
  fs.mkdirSync(path.dirname(baselinePath(home)), { recursive: true })
  fs.writeFileSync(baselinePath(home), '{not json')
  const read = readBaseline(home)
  assert.equal(read.kind, 'corrupt')
  const state = baselineState(home, { active: true })
  assert.equal(state.state, 'unknown')
  assert.match(String(state.reason), /JSON/u)
})

test('基线记录非 UTF-8：按损坏处理，不做替换字符解码', (t) => {
  const home = fixture(t)
  fs.mkdirSync(path.dirname(baselinePath(home)), { recursive: true })
  fs.writeFileSync(baselinePath(home), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]))
  assert.equal(readBaseline(home).kind, 'corrupt')
})

test('基线记录版本不符：拒绝按当前格式解读', (t) => {
  const home = fixture(t)
  const builtin = builtinFingerprint()
  fs.mkdirSync(path.dirname(baselinePath(home)), { recursive: true })
  fs.writeFileSync(baselinePath(home), JSON.stringify({ version: 99, builtin }))
  const read = readBaseline(home)
  assert.equal(read.kind, 'corrupt')
  assert.match(read.reason, /version|版本/u)
})

test('基线记录字段不全：拒绝，不把半个对象当成哈希相等', (t) => {
  const home = fixture(t)
  fs.mkdirSync(path.dirname(baselinePath(home)), { recursive: true })
  fs.writeFileSync(baselinePath(home), JSON.stringify({ version: 1, builtin: { hash: 'sha256:abc' } }))
  assert.equal(readBaseline(home).kind, 'corrupt')
})

test('记录文件名固定为 inject-baseline.json，与正文分开放', (t) => {
  const home = fixture(t)
  assert.equal(path.basename(baselinePath(home)), BASELINE_FILE)
  assert.equal(path.dirname(baselinePath(home)), path.join(home, 'breaklimit'))
})

test('removeBaseline 之后回到 absent，重复删除不报错', (t) => {
  const home = fixture(t)
  writeBaseline(home, builtinFingerprint())
  removeBaseline(home)
  assert.equal(readBaseline(home).kind, 'absent')
  removeBaseline(home)
  assert.equal(readBaseline(home).kind, 'absent')
})
