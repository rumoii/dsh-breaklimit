// 落点字节保真与读失败语义测试（P0 / P1-3 回归）。
//
// 守四条：非 UTF-8 落点在任何路径下字节零损失；内容不变不重写落点；「读不到」
// 一律停手报错而不是当成「文件不存在」继续写；读失败不许把 rules.json 换成空清单。
//
// 「读不到」的模拟方式是把目标路径做成目录：readFileSync 对目录抛 EISDIR，
// 与 ENOENT 天然可分，Windows / POSIX 行为一致，不依赖权限位。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  activateRule,
  deactivateRule,
  ensureInitialState,
  landingPath,
  readActive,
  readIndex,
  resetRules,
  ruleTextPath,
  rulesIndexPath,
  saveRule,
  targetPath,
} from '../src/context/rules.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-bytes-'))
}

// GBK 编码的「你好」+ 换行：非法 UTF-8 字节序列，文本往返会变成 U+FFFD。
const GBK_BYTES = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a])
// UTF-16LE 带 BOM 的旧编辑器产物。
const UTF16_BYTES = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('legacy notes\r\n', 'utf16le')])

function seedBytes(home, target, bytes) {
  fs.writeFileSync(targetPath(home, target), bytes)
}

function readBytes(file) {
  return fs.readFileSync(file)
}

function makeUnreadable(file) {
  fs.rmSync(file, { force: true })
  fs.mkdirSync(file, { recursive: true })
}

test('非 UTF-8 落点不收拢、字节原样、不建任何插件状态', () => {
  for (const bytes of [GBK_BYTES, UTF16_BYTES]) {
    const home = tempHome()
    seedBytes(home, 'AGENTS.md', bytes)
    const result = ensureInitialState(home)
    assert.equal(result.imported, null)
    assert.equal(result.error, undefined)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].reason, 'not_utf8')
    assert.deepEqual(readBytes(targetPath(home, 'AGENTS.md')), bytes)
    assert.equal(readIndex(home).kind, 'absent')
    assert.equal(fs.existsSync(landingPath(home, 'AGENTS.md')), false)
  }
})

test('UTF-8 收拢照常，且落点字节一致时不重写（文件 mtime 不变）', () => {
  const home = tempHome()
  seedBytes(home, 'AGENTS.md', 'existing instructions')
  const before = fs.statSync(targetPath(home, 'AGENTS.md')).mtimeMs
  const result = ensureInitialState(home)
  assert.equal(result.imported, 'default')
  assert.equal(readActive(home), 'default')
  assert.deepEqual(readBytes(targetPath(home, 'AGENTS.md')), Buffer.from('existing instructions', 'utf8'))
  assert.equal(fs.statSync(targetPath(home, 'AGENTS.md')).mtimeMs, before, '内容没变却重写了落点')
})

test('激活到非 UTF-8 落点：快照存原字节，取消激活后字节零损失', () => {
  const home = tempHome()
  seedBytes(home, 'AGENTS.md', GBK_BYTES)
  assert.equal(saveRule(home, 'alpha', 'rule body', { target: 'AGENTS.md' }).ok, true)
  const activated = activateRule(home, 'alpha')
  assert.equal(activated.ok, true)
  assert.equal(activated.created, false)
  // 快照必须是原字节，不是解码后的替换字符文本。
  assert.deepEqual(readBytes(landingPath(home, 'AGENTS.md')), GBK_BYTES)
  assert.deepEqual(readBytes(targetPath(home, 'AGENTS.md')), Buffer.from('rule body', 'utf8'))

  const off = deactivateRule(home)
  assert.equal(off.restored, true)
  assert.deepEqual(readBytes(targetPath(home, 'AGENTS.md')), GBK_BYTES, '取消激活后原字节没有回来')
})

test('规则正文与落点字节一致时激活不重写落点', () => {
  const home = tempHome()
  seedBytes(home, 'AGENTS.md', 'same content')
  assert.equal(saveRule(home, 'same', 'same content', { target: 'AGENTS.md' }).ok, true)
  const before = fs.statSync(targetPath(home, 'AGENTS.md')).mtimeMs
  const activated = activateRule(home, 'same')
  assert.equal(activated.ok, true)
  assert.equal(fs.statSync(targetPath(home, 'AGENTS.md')).mtimeMs, before, '内容没变却重写了落点')
})

test('落点读不到：激活停手报错，不建快照、不动清单', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'rule body', { target: 'AGENTS.md' }).ok, true)
  makeUnreadable(targetPath(home, 'AGENTS.md'))
  const activated = activateRule(home, 'alpha')
  assert.equal(activated.ok, false)
  assert.equal(activated.code, 'landing_unreadable')
  assert.equal(readActive(home), null)
  assert.equal(fs.existsSync(landingPath(home, 'AGENTS.md')), false)
  assert.deepEqual(readBytes(ruleTextPath(home, 'alpha')), Buffer.from('rule body', 'utf8'))
})

test('落点读不到：收拢直接报错，不当成空落点', () => {
  const home = tempHome()
  makeUnreadable(targetPath(home, 'AGENTS.md'))
  const result = ensureInitialState(home)
  assert.equal(result.imported, null)
  assert.match(String(result.error), /读不到/u)
  assert.equal(readIndex(home).kind, 'absent')
})

test('清单读不到：保存与取消激活都停手，绝不整表替换 rules.json', () => {
  const home = tempHome()
  makeUnreadable(rulesIndexPath(home))
  const saved = saveRule(home, 'alpha', 'rule body', { target: 'AGENTS.md' })
  assert.equal(saved.ok, false)
  assert.equal(saved.code, 'index_unreadable')
  assert.equal(fs.existsSync(ruleTextPath(home, 'alpha')), false, '清单不可用时不该写正文')
  const off = deactivateRule(home)
  assert.equal(off.ok, false)
  assert.equal(off.code, 'index_unreadable')
  assert.ok(fs.statSync(rulesIndexPath(home)).isDirectory(), 'rules.json 路径被替换掉了')
})

test('落点读不到：取消激活报 skipped 并保留归属，不删不写', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'rule body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  makeUnreadable(targetPath(home, 'AGENTS.md'))
  const off = deactivateRule(home)
  assert.equal(off.ok, true)
  assert.equal(off.kept, true)
  assert.equal(off.skipped.length, 1)
  assert.match(String(off.skipped[0].reason), /读不到/u)
  assert.equal(readActive(home), 'alpha', '归属应保留')
  assert.ok(fs.statSync(targetPath(home, 'AGENTS.md')).isDirectory(), '落点不应被动过')
  // 清理：把目录恢复成文件，reset 才能走完。
  fs.rmdirSync(targetPath(home, 'AGENTS.md'))
  const reset = resetRules(home)
  assert.equal(reset.ok, true)
})
