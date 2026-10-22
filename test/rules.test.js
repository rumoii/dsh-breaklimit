// 规则服务测试（存储 v2）。
//
// 守三条主线：激活/取消激活的三终态（删除、恢复、保留）、切换落点不遗留正文、
// 以及清单损坏时不出错。

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  INDEX_VERSION,
  MAX_RULE_BYTES,
  activateRule,
  activeRuleText,
  bodiesDir,
  deactivateRule,
  deleteRule,
  ensureInitialState,
  landingPath,
  listRules,
  readActive,
  readActiveState,
  readIndex,
  readRule,
  readRuleMeta,
  resetRules,
  ruleTextPath,
  rulesIndexPath,
  saveRule,
  targetPath,
} from '../src/context/rules.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-rules-'))
}

function seedTarget(home, target, text) {
  fs.writeFileSync(targetPath(home, target), text, 'utf8')
}

// 与 hashBytes 同口径：内容的完整 sha256 摘要。断言 landing.writtenHash 用。
const fullHash = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

test('保存后能列出、读取，元数据落在清单里', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { name: 'Alpha', target: 'AGENTS.md' }).ok, true)
  const listed = listRules(home)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, 'alpha')
  assert.equal(listed[0].name, 'Alpha')
  assert.equal(listed[0].target, 'AGENTS.md')
  assert.equal(listed[0].active, false)
  assert.ok(listed[0].bytes > 0)
  assert.equal(readRule(home, 'alpha').text, 'A body')
  assert.deepEqual(readRuleMeta(home, 'alpha'), { name: 'Alpha', target: 'AGENTS.md' })
  const index = JSON.parse(fs.readFileSync(rulesIndexPath(home), 'utf8'))
  assert.equal(index.version, INDEX_VERSION)
  assert.equal(index.rules.length, 1)
})

test('正文上限 512 KiB：恰好等于上限接受，多一个字节拒绝且不落盘', () => {
  const home = tempHome()
  // 夹具是字面量，不从被测常量派生。写成 `MAX_RULE_BYTES + 1` 的话，把常量放大
  // 128 倍这条用例仍然全绿——它证明的是「实现和它自己一致」，不是「上限是 512 KiB」。
  assert.equal(MAX_RULE_BYTES, 524288)

  const atLimit = saveRule(home, 'at-limit', 'x'.repeat(524288), {})
  assert.equal(atLimit.ok, true)
  assert.equal(fs.statSync(ruleTextPath(home, 'at-limit')).size, 524288)

  const result = saveRule(home, 'big', 'x'.repeat(524289), {})
  assert.equal(result.ok, false)
  assert.match(result.reason, /上限/u)
  assert.equal(fs.existsSync(ruleTextPath(home, 'big')), false)
})

test('非法 id 与非字符串正文被拒绝', () => {
  const home = tempHome()
  assert.equal(saveRule(home, '-bad', 'x', {}).ok, false)
  assert.equal(saveRule(home, 'ok', null, {}).ok, false)
  assert.equal(readRule(home, '-bad').ok, false)
})

test('激活写入文件；取消后删除插件创建的文件', () => {
  const home = tempHome()
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  const activated = activateRule(home, 'alpha')
  assert.equal(activated.ok, true)
  assert.equal(activated.created, true)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'A body')
  assert.equal(readActive(home), 'alpha')
  assert.equal(activeRuleText(home), 'A body')

  const off = deactivateRule(home)
  assert.equal(off.removed, true)
  assert.equal(fs.existsSync(targetPath(home, 'AGENTS.md')), false)
  assert.equal(readActive(home), null)
})

test('原本就有内容：取消时写回原文', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  const activated = activateRule(home, 'alpha')
  assert.equal(activated.created, false)
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original text')

  const off = deactivateRule(home)
  assert.equal(off.restored, true)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'original text')
  assert.equal(fs.existsSync(landingPath(home, 'AGENTS.md')), false)
})

test('外部改动后取消激活：保留原样并报告', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original')
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  activateRule(home, 'alpha')
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), 'user edited', 'utf8')

  const off = deactivateRule(home)
  assert.equal(off.skipped.length, 1)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'user edited')
})

test('切换落点：上一条的落点被处置，新落点写新正文', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'agents original')
  saveRule(home, 'a', 'A body', { target: 'AGENTS.md' })
  saveRule(home, 'b', 'B body', { target: 'CLAUDE.md' })
  activateRule(home, 'a')
  activateRule(home, 'b')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'agents original')
  assert.equal(fs.readFileSync(targetPath(home, 'CLAUDE.md'), 'utf8'), 'B body')
  assert.equal(readActive(home), 'b')
})

test('删除激活中的规则会按快照处置落点', () => {
  const home = tempHome()
  seedTarget(home, 'CLAUDE.md', 'claude original')
  saveRule(home, 'alpha', 'A body', { target: 'CLAUDE.md' })
  activateRule(home, 'alpha')
  const removed = deleteRule(home, 'alpha')
  assert.equal(removed.ok, true)
  assert.equal(fs.readFileSync(targetPath(home, 'CLAUDE.md'), 'utf8'), 'claude original')
  assert.equal(readActive(home), null)
  assert.equal(listRules(home).length, 0)
})

test('重置：清空规则与正文，被改过的落点保留', () => {
  const home = tempHome()
  saveRule(home, 'one', 'one', { target: 'AGENTS.md' })
  saveRule(home, 'two', 'two', { target: 'CLAUDE.md' })
  activateRule(home, 'one')
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), 'edited', 'utf8')
  const reset = resetRules(home)
  assert.equal(reset.removed, 2)
  assert.equal(reset.skipped.length, 1)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'edited')
  assert.deepEqual(listRules(home), [])
  assert.equal(fs.existsSync(bodiesDir(home)), true)
})

test('首轮收拢：已有 AGENTS.md 被导入成 default 并激活', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'existing instructions')
  const result = ensureInitialState(home)
  assert.equal(result.imported, 'default')
  assert.equal(readActive(home), 'default')
  assert.equal(activeRuleText(home), 'existing instructions')
})

test('清单损坏时退回空列表，不抛错', () => {
  const home = tempHome()
  fs.mkdirSync(path.dirname(rulesIndexPath(home)), { recursive: true })
  fs.writeFileSync(rulesIndexPath(home), '{ not json', 'utf8')
  assert.equal(readIndex(home).kind, 'corrupt')
  assert.deepEqual(listRules(home), [])
  assert.equal(readActive(home), null)
})

test('旧版 rules/ 目录不迁移：读出来就是空的', () => {
  const home = tempHome()
  const legacy = path.join(home, 'breaklimit', 'rules')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'old.md'), 'old body', 'utf8')
  assert.equal(readIndex(home).kind, 'absent')
  assert.deepEqual(listRules(home), [])
  assert.equal(ruleTextPath(home, 'old').startsWith(legacy), false)
})

test('保存返回调用方契约：id、meta 与三个落点标志', () => {
  const home = tempHome()
  const inactiveSave = saveRule(home, 'alpha', 'A body', { name: 'Alpha', target: 'AGENTS.md' })
  assert.equal(inactiveSave.ok, true)
  assert.equal(inactiveSave.id, 'alpha')
  assert.deepEqual(inactiveSave.meta, { name: 'Alpha', target: 'AGENTS.md' })
  assert.equal(inactiveSave.landingSynced, false)
  assert.equal(inactiveSave.landingStale, false)
  assert.equal(inactiveSave.landingMoved, false)

  activateRule(home, 'alpha')
  const saved = saveRule(home, 'alpha', 'A body v2', { name: 'Alpha 2', target: 'AGENTS.md' })
  assert.equal(saved.ok, true)
  assert.equal(saved.id, 'alpha')
  assert.equal(saved.meta.name, 'Alpha 2')
  assert.equal(saved.meta.target, 'AGENTS.md')
  assert.equal(saved.landingSynced, true)
  assert.equal(saved.landingStale, false)
  assert.equal(saved.landingMoved, false)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'A body v2')
})

test('空正文也是正文：激活建 0 字节文件，取消时删掉', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'empty', '', { name: '空', target: 'AGENTS.md' }).ok, true)
  const activated = activateRule(home, 'empty')
  assert.equal(activated.ok, true)
  assert.equal(activated.created, true)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), '')

  const off = deactivateRule(home)
  assert.equal(off.removed, true)
  assert.equal(off.restored, false)
  assert.deepEqual(off.skipped, [])
  assert.equal(fs.existsSync(targetPath(home, 'AGENTS.md')), false)
  assert.equal(readActive(home), null)
})

test('正文文件丢了：writtenHash 认得出落点内容归属，照常处置', () => {
  const home = tempHome()
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  activateRule(home, 'alpha')
  fs.rmSync(ruleTextPath(home, 'alpha'), { force: true })

  // 正文文件没了，但落点里还是我们写进去的字节（writtenHash 对得上）：归属可证，
  // 插件创建的落点照常删掉，不再把「读不出正文」误判成「内容已被改动」。
  const off = deactivateRule(home)
  assert.equal(off.removed, true)
  assert.equal(off.restored, false)
  assert.deepEqual(off.skipped, [])
  assert.equal(fs.existsSync(targetPath(home, 'AGENTS.md')), false)
})

test('正文文件丢了、落点也被改过：报告并保留落点', () => {
  const home = tempHome()
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  activateRule(home, 'alpha')
  fs.rmSync(ruleTextPath(home, 'alpha'), { force: true })
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), 'user edited', 'utf8')

  const off = deactivateRule(home)
  assert.equal(off.removed, false)
  assert.equal(off.restored, false)
  assert.equal(off.skipped.length, 1)
  assert.equal(off.skipped[0].path, targetPath(home, 'AGENTS.md'))
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'user edited')
})

test('非法 target：saveRule 与 activateRule 都拒绝，落到允许列表之外的路径不产生文件', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-rules-guard-'))
  const home = path.join(parent, 'home')
  fs.mkdirSync(home)

  const saved = saveRule(home, 'evil', 'text', { target: '../evil.md' })
  assert.equal(saved.ok, false)
  assert.equal(saved.code, 'invalid_target')
  assert.equal(typeof saved.message, 'string')
  assert.equal(saved.reason, saved.message)
  assert.match(saved.message, /AGENTS\.md/u)
  assert.match(saved.message, /CLAUDE\.md/u)
  assert.deepEqual(fs.readdirSync(home), [])
  assert.deepEqual(fs.readdirSync(parent), ['home'])

  // 清单里已有的坏记录：读取容错，激活拒绝——按回落值写盘就是静默改写。
  fs.mkdirSync(path.dirname(rulesIndexPath(home)), { recursive: true })
  fs.mkdirSync(path.dirname(ruleTextPath(home, 'legacy')), { recursive: true })
  fs.writeFileSync(ruleTextPath(home, 'legacy'), 'legacy body', 'utf8')
  fs.writeFileSync(rulesIndexPath(home), JSON.stringify({
    version: INDEX_VERSION,
    revision: 0,
    rules: [{ id: 'legacy', name: '旧', target: '../evil.md', activatedAt: null }],
    active: null,
    landing: null,
    pendingActivation: null,
  }), 'utf8')

  const activated = activateRule(home, 'legacy')
  assert.equal(activated.ok, false)
  assert.equal(activated.code, 'invalid_target')
  assert.match(activated.reason, /AGENTS\.md/u)
  assert.equal(fs.existsSync(targetPath(home, 'AGENTS.md')), false)
  assert.equal(fs.existsSync(path.join(parent, 'evil.md')), false)
})

test('容错读取：清单里的非法 target 回落成 AGENTS.md，不抛错', () => {
  const home = tempHome()
  fs.mkdirSync(path.dirname(rulesIndexPath(home)), { recursive: true })
  fs.writeFileSync(rulesIndexPath(home), JSON.stringify({
    version: INDEX_VERSION,
    revision: 3,
    rules: [
      { id: 'good', name: '好', target: 'CLAUDE.md', activatedAt: null },
      { id: 'legacy', name: '旧', target: '../../etc/passwd', activatedAt: null },
    ],
    active: null,
    landing: null,
    pendingActivation: null,
  }), 'utf8')

  const index = readIndex(home)
  assert.equal(index.kind, 'ok')
  assert.deepEqual(
    index.rules.map(rule => [rule.id, rule.target]),
    [['good', 'CLAUDE.md'], ['legacy', 'AGENTS.md']],
  )
  assert.deepEqual(index.invalidTargets, [{ id: 'legacy', target: '../../etc/passwd' }])
  assert.equal(listRules(home).length, 2)
})

test('删除激活中的规则：落点被改过时保留归属，快照仍可发现', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  seedTarget(home, 'AGENTS.md', 'user edited')

  const removed = deleteRule(home, 'alpha')
  assert.equal(removed.ok, true)
  assert.equal(removed.kept, true)
  assert.equal(removed.skipped.length, 1)
  assert.deepEqual(removed.landingKept, { target: 'AGENTS.md', created: false, writtenHash: fullHash('A body') })
  assert.deepEqual(listRules(home), [])
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'user edited')
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original')

  const state = readActiveState(home)
  assert.equal(state.id, null)
  assert.deepEqual(state.landing, { target: 'AGENTS.md', created: false, writtenHash: fullHash('A body') })
  assert.equal(fs.existsSync(landingPath(home, state.landing.target)), true)

  // 之后的取消激活不清这份归属：没有激活态可注销，清掉只会让快照重新变成孤儿。
  assert.equal(deactivateRule(home).ok, true)
  assert.deepEqual(readActiveState(home).landing, { target: 'AGENTS.md', created: false, writtenHash: fullHash('A body') })
  assert.equal(fs.existsSync(landingPath(home, 'AGENTS.md')), true)

  // 归属还在，同一落点上再激活一条时沿用这份快照，不拿当前内容把它冲掉。
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)
  const next = activateRule(home, 'beta')
  assert.equal(next.ok, true)
  assert.equal(next.snapshotKept, true)
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'B body')
})

test('删除激活中的规则：落点未被改过时照常清空归属', () => {
  const home = tempHome()
  seedTarget(home, 'CLAUDE.md', 'claude original')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'CLAUDE.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)

  const removed = deleteRule(home, 'alpha')
  assert.equal(removed.ok, true)
  assert.equal(removed.kept, false)
  assert.deepEqual(removed.skipped, [])
  assert.equal(removed.landingKept, null)
  assert.equal(fs.readFileSync(targetPath(home, 'CLAUDE.md'), 'utf8'), 'claude original')
  assert.equal(fs.existsSync(ruleTextPath(home, 'alpha')), false)
  assert.equal(readActive(home), null)
  assert.equal(readActiveState(home).landing, null)
})

test('名字按码点截断：不切断代理对，且上限不与 id 共用', () => {
  const home = tempHome()
  // 60 个非 BMP 字符 = 120 个 UTF-16 单元。按单元 slice 会在中间切出半个代理对。
  const emoji = '🎯'.repeat(60)
  const saved = saveRule(home, 'demo', 'x', { name: emoji, target: 'AGENTS.md' })
  assert.equal(saved.ok, true)
  assert.equal(saved.meta.name, emoji)
  assert.equal([...saved.meta.name].length, 60)

  // 名字上限 96 个码点，比 id 的 64 宽。
  const long = saveRule(home, 'demo2', 'x', { name: '名'.repeat(120), target: 'AGENTS.md' })
  assert.equal([...long.meta.name].length, 96)
})

// 与 rules.js 里 fingerprint 同口径：sha256 十六进制前 16 位。
const fp = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

test('落点被外部改过时，跳过记录带两侧指纹', () => {
  const home = tempHome()
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), '原文\n', 'utf8')
  saveRule(home, 'demo', '插件正文\n', { name: '演示', target: 'AGENTS.md' })
  activateRule(home, 'demo')
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), '用户改过\n', 'utf8')

  const skipped = deactivateRule(home).skipped
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].expected, fp('插件正文\n'))
  assert.equal(skipped[0].actual, fp('用户改过\n'))
  assert.notEqual(skipped[0].expected, skipped[0].actual)
  assert.match(skipped[0].reason, /内容已被改动/)
})
