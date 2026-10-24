// 提示词模式测试。
//
// 两档：recommended / unrestricted。验证持久化、旧值回退与「共用正文 + 附加段」的拼装。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_TIER,
  TIERS,
  buildTierPrompt,
  isValidTier,
  readTier,
  resolveTierInfo,
  tierConfigPath,
  writeTier,
} from '../src/context/tiers.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-tiers-'))
}

const SAMPLE_BASE = '# Shared body\n\nFull prompt.'
const SAMPLE_EXT = '## Mode: unrestricted\n\nNo pre-emptive restraint.'

test('只有两档，且只接受合法模式', () => {
  assert.deepEqual([...TIERS], ['recommended', 'unrestricted'])
  assert.equal(isValidTier('recommended'), true)
  assert.equal(isValidTier('unrestricted'), true)
  assert.equal(isValidTier('lean'), false, '旧档位必须失效')
  assert.equal(isValidTier('architect'), false)
  assert.equal(isValidTier('autonomous'), false)
  assert.equal(isValidTier(''), false)
  assert.equal(isValidTier(null), false)
})

test('无配置时返回默认模式 recommended', () => {
  const home = tempHome()
  const result = readTier(home)
  assert.equal(result.kind, 'default')
  assert.equal(result.tier, DEFAULT_TIER)
  assert.equal(DEFAULT_TIER, 'recommended')
})

test('写入后能准确读回', () => {
  const home = tempHome()
  assert.equal(writeTier(home, 'unrestricted').ok, true)
  const readRes = readTier(home)
  assert.equal(readRes.kind, 'ok')
  assert.equal(readRes.tier, 'unrestricted')
})

test('拒绝非法模式', () => {
  const home = tempHome()
  assert.throws(() => writeTier(home, 'super-god-mode'), /Invalid tier/)
})

test('损坏的配置回退到默认模式', () => {
  const home = tempHome()
  const confPath = tierConfigPath(home)
  fs.mkdirSync(path.dirname(confPath), { recursive: true })
  fs.writeFileSync(confPath, '{ corrupt json !!!', 'utf8')
  const res = readTier(home)
  assert.equal(res.kind, 'corrupt')
  assert.equal(res.tier, DEFAULT_TIER)
})

test('旧档位名视为非法并回退', () => {
  const home = tempHome()
  const confPath = tierConfigPath(home)
  fs.mkdirSync(path.dirname(confPath), { recursive: true })
  fs.writeFileSync(confPath, JSON.stringify({ tier: 'architect' }), 'utf8')
  const res = readTier(home)
  assert.equal(res.kind, 'corrupt')
  assert.equal(res.tier, DEFAULT_TIER)
})

test('拼装：共用正文在前，附加段在后', () => {
  const both = buildTierPrompt('unrestricted', SAMPLE_BASE, SAMPLE_EXT)
  assert.equal(both, `${SAMPLE_BASE}\n\n${SAMPLE_EXT}`)
  assert.equal(buildTierPrompt('recommended', SAMPLE_BASE, ''), SAMPLE_BASE)
  assert.equal(buildTierPrompt('recommended', '', SAMPLE_EXT), SAMPLE_EXT)
  assert.equal(buildTierPrompt('recommended', '', ''), '')
})

test('resolveTierInfo 返回模式、字节数与可用列表', () => {
  const home = tempHome()
  writeTier(home, 'unrestricted')
  const info = resolveTierInfo(home, SAMPLE_BASE, SAMPLE_EXT)
  assert.equal(info.tier, 'unrestricted')
  assert.equal(info.kind, 'ok')
  assert.deepEqual(info.available, TIERS)
  assert.equal(info.bytes, Buffer.byteLength(info.text, 'utf8'))
  assert.match(info.text, /Shared body/u)
  assert.match(info.text, /No pre-emptive restraint/u)
})

test('配置损坏时带出不可用状态，候选正文不代表生效', () => {
  const home = tempHome()
  const confPath = tierConfigPath(home)
  fs.mkdirSync(path.dirname(confPath), { recursive: true })
  fs.writeFileSync(confPath, '{ corrupt json !!!', 'utf8')
  const info = resolveTierInfo(home, SAMPLE_BASE, '')
  assert.equal(info.kind, 'corrupt')
  assert.equal(info.source, 'unavailable')
  assert.equal(info.tier, DEFAULT_TIER)
  assert.equal(info.text, SAMPLE_BASE)
})


test('档位读失败沿用同实例可信快照，其他实例不能借用', () => {
  const home = tempHome(), runtime = {}
  writeTier(home, 'unrestricted')
  assert.equal(readTier(home, runtime).tier, 'unrestricted')
  fs.writeFileSync(tierConfigPath(home), '{broken')
  assert.equal(readTier(home, runtime).tier, 'unrestricted')
  assert.equal(readTier(home, runtime).source, 'cached')
  assert.notEqual(readTier(home, {}).source, 'cached')
})
