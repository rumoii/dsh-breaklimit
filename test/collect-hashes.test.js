// collect-hashes 的归属校验。
//
// 此前哈希表的 dsh 块永远写死 DSH_TARGET 的版本与提交，与实际采样的树无关：
// 从别的树采出的哈希表会被 reconcile 当成「给这棵树采的」（假绿），真机预检
// 才报「预哈希不符」。现在采集前先验宿主 HEAD 等于 DSH_TARGET.commit，不符就
// 报错且不生成哈希表；生成的记录写实际采样来源。

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildHashesPayload, ownershipMismatch } from '../tools/collect-hashes.mjs'
import { DSH_TARGET } from '../src/patch/index.js'

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HASHES_FILE = path.join(PACKAGE_ROOT, 'src', 'patch', 'hashes.json')

/** 一棵与 DSH_TARGET 无关的临时 git 树。 */
function wrongTree(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-collect-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000 })
  git(['init', '--quiet'])
  git(['config', 'user.name', 'Collect test'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['-c', 'user.name=Collect test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'seed'])
  return { repo, head: git(['rev-parse', 'HEAD']).trim() }
}

test('collect-hashes 对错树报错退出，不写哈希表', (t) => {
  const { repo, head } = wrongTree(t)
  assert.notEqual(head, DSH_TARGET.commit, '临时树不该碰巧就是目标提交')
  const before = fs.readFileSync(HASHES_FILE)
  try {
    const result = spawnSync(process.execPath, ['tools/collect-hashes.mjs', repo], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 30000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /不是同一份提交/)
    assert.match(result.stderr, new RegExp(head))
    assert.deepEqual(fs.readFileSync(HASHES_FILE), before, '错树不得改写哈希表')
  } finally {
    // 回归时也不给仓库留下被改写的哈希表。
    fs.writeFileSync(HASHES_FILE, before)
  }
})

test('collect-hashes 缺参数退出 2', () => {
  const result = spawnSync(process.execPath, ['tools/collect-hashes.mjs'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(result.status, 2)
})

test('归属校验只认 DSH_TARGET 钉住的那份提交', () => {
  assert.equal(ownershipMismatch(DSH_TARGET.commit), null)
  assert.notEqual(ownershipMismatch('0'.repeat(40)), null)
})

test('生成的记录写实际采样来源，不写死声明值', () => {
  const sampled = 'a'.repeat(40)
  const payload = buildHashesPayload(sampled, {}, '2026-10-18T00:00:00.000Z')
  assert.equal(payload.dsh.commit, sampled, 'dsh.commit 必须是实际采样的 HEAD')
  assert.equal(payload.dsh.version, DSH_TARGET.version)
  assert.equal(payload.generatedAt, '2026-10-18T00:00:00.000Z')
})
