// 状态清单重建的判据与链路测试。
//
// 场景是真实发生过的那一个：宿主上躺着本方写入的内容，应用记录连同快照一起没了。
// 旧实现只认事务目录里的快照，于是这种树两头堵死——重建不出记录，apply 被
// 「整文件预哈希不符」整批阻断，revert 因为没有记录直接报未应用。
//
// 断言对齐的是契约，不是当前产出：
//   盘上 = 原文 + 本方声明      →  采纳，原文来源记为 git HEAD
//   盘上多一处改动              →  拒绝，理由指向「还含有其他改动」
//   声明哈希不认这份原文        →  拒绝
//   哈希表采自另一棵树          →  git 来源拒绝，快照来源照采纳（快照自带证明）
//   一个都没采纳                →  不写清单，返回失败语义（退出码 2），已有记录与备份原样保留
//   部分采纳                    →  照写清单，退出码 1，并列出未采纳清单
//   备份                        →  带时间戳、永不覆盖，第二次重建后第一次的备份仍在
//   重建之后                    →  预检认成 applied，apply 不再写盘，revert 还能还原

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { hashText, readTextOrNull } from '../src/patch/fsx.js'
import { createLock } from '../src/patch/lock.js'
import { preflight } from '../src/patch/preflight.js'
import { readState, statePath } from '../src/patch/state.js'
import { applyPatches, revertPatches } from '../src/patch/transaction.js'
import { replaceVariantsByPath } from '../src/patch/index.js'
import { adoptionOutcome, backupTarget, judgeAdoption, rebuildState } from '../tools/rebuild-state.mjs'

const PATCH_ID = 'T-01'
const ORIGINAL = 'VALUE = 2000\n'
const PATCHED = 'VALUE = 20000\n'
const ORIGINAL_B = 'OTHER = 1\n'
const HEAD_COMMIT = 'abc123'

function patchSet() {
  return [{
    id: PATCH_ID,
    title: '测试补丁',
    kind: 'replace',
    targets: [{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }],
  }]
}

function hashTable() {
  return { [PATCH_ID]: { 'a.txt': hashText(ORIGINAL) } }
}

function patchSetTwo() {
  return [{
    id: PATCH_ID,
    title: '测试补丁',
    kind: 'replace',
    targets: [
      { path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 },
      { path: 'b.txt', before: 'OTHER = 1', after: 'OTHER = 2', expectHits: 1 },
    ],
  }]
}

function hashTableTwo() {
  return { [PATCH_ID]: { 'a.txt': hashText(ORIGINAL), 'b.txt': hashText(ORIGINAL_B) } }
}

/** git 读取假件：落盘与备份用例不碰真实仓库，只验证写不写、怎么备份、退出码是多少。 */
function fakeGit(headFiles) {
  return (args) => {
    if (args[0] === 'rev-parse') return `${HEAD_COMMIT}\n`
    if (args[0] === 'show' && args[1].startsWith('HEAD:')) {
      const relative = args[1].slice('HEAD:'.length)
      if (Object.hasOwn(headFiles, relative)) return headFiles[relative]
      throw new Error(`no such path: ${relative}`)
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
}

/** 一份各项都成立的输入，用例只改需要打歪的那一项。 */
function verdict(overrides = {}) {
  return judgeAdoption({
    head: ORIGINAL,
    current: PATCHED,
    snapshot: null,
    declaredHash: hashText(ORIGINAL),
    headCommit: HEAD_COMMIT,
    manifestCommit: HEAD_COMMIT,
    variants: replaceVariantsByPath(patchSet()).get('a.txt') ?? [],
    ...overrides,
  })
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-rebuild-'))
}

function write(root, rel, content) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

test('无快照时，盘上内容等于原文加本方声明即采纳，来源记为 git HEAD', () => {
  const adopted = verdict()

  assert.equal(adopted.accepted, true)
  assert.equal(adopted.source, 'head')
  assert.equal(adopted.before, hashText(ORIGINAL))
  assert.equal(adopted.after, hashText(PATCHED))
  // 记录里的 before 就是回退时要写进宿主的字节，必须是声明的那一版原文。
  assert.equal(adopted.snapshot, ORIGINAL)
})

test('盘上内容含声明之外的改动时拒绝采纳', () => {
  const rejected = verdict({ current: `${PATCHED}EXTRA = 1\n` })

  assert.equal(rejected.accepted, false)
  assert.match(rejected.reason, /还含有其他改动/)
})

test('哈希表不认 HEAD 这份原文时拒绝采纳', () => {
  const rejected = verdict({ declaredHash: hashText('OTHER = 1\n') })

  assert.equal(rejected.accepted, false)
  assert.match(rejected.reason, /预哈希与 HEAD 内容不符/)
})

test('哈希表采自另一个提交时，git 来源拒绝采纳', () => {
  const rejected = verdict({ manifestCommit: 'deadbee' })

  assert.equal(rejected.accepted, false)
  assert.match(rejected.reason, /哈希表记录的是 commit deadbee/)
})

test('快照自身等于原文时照采纳，不受哈希表提交号影响', () => {
  // 快照就是应用前的原文，它的存在本身就是证据；commit 只是没有快照时的兜底判据。
  const adopted = verdict({ snapshot: { text: ORIGINAL, from: 'txn-1' }, manifestCommit: 'deadbee' })

  assert.equal(adopted.accepted, true)
  assert.equal(adopted.source, 'snapshot')
})

test('退出码判定：零采纳不写退出 2，部分采纳写退出 1，全部采纳写退出 0', () => {
  assert.deepEqual(adoptionOutcome(0, 2), { write: false, exitCode: 2 })
  assert.deepEqual(adoptionOutcome(1, 1), { write: true, exitCode: 1 })
  assert.deepEqual(adoptionOutcome(3, 0), { write: true, exitCode: 0 })
})

test('一个都没采纳时不写清单，返回失败语义，不留下任何写入', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', ORIGINAL) // 与 HEAD 相同：这份改动不在，全部目标未采纳

  const result = rebuildState({
    hostRoot: root,
    home,
    patches: patchSet(),
    hashes: hashTable(),
    manifest: { dsh: { commit: HEAD_COMMIT } },
    git: fakeGit({ 'a.txt': ORIGINAL }),
  })

  assert.equal(result.written, false)
  assert.equal(result.exitCode, 2)
  assert.deepEqual(Object.keys(result.accepted), [])
  assert.equal(result.rejected.length, 1)
  assert.equal(fs.existsSync(statePath(home)), false, '零采纳时不得生成 state.json')
  assert.equal(fs.existsSync(path.join(home, 'breaklimit')), false, '零采纳时不该留下任何写入')
})

test('零采纳时已有的 state.json 与旧备份原样保留', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', ORIGINAL)
  write(home, 'breaklimit/state.json', '{"keep":"record"}\n')
  write(home, 'breaklimit/state.json.bak-OLD', '{"keep":"backup"}\n')

  const result = rebuildState({
    hostRoot: root,
    home,
    patches: patchSet(),
    hashes: hashTable(),
    manifest: { dsh: { commit: HEAD_COMMIT } },
    git: fakeGit({ 'a.txt': ORIGINAL }),
  })

  assert.equal(result.written, false)
  assert.equal(result.exitCode, 2)
  assert.equal(read(home, 'breaklimit/state.json'), '{"keep":"record"}\n', '已有的恢复记录不得被毁掉')
  const backups = fs.readdirSync(path.join(home, 'breaklimit')).filter((name) => name.startsWith('state.json.bak'))
  assert.deepEqual(backups, ['state.json.bak-OLD'], '零采纳时不得新增或覆盖任何备份')
  assert.equal(read(home, 'breaklimit/state.json.bak-OLD'), '{"keep":"backup"}\n')
})

test('备份永不覆盖已有文件：冲突时取下一个名字', () => {
  const home = tempDir()
  const destination = statePath(home)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  write(home, 'breaklimit/state.json.bak-TEST', 'first')
  write(home, 'breaklimit/state.json.bak-TEST-2', 'second')

  assert.equal(backupTarget(destination, 'TEST'), `${destination}.bak-TEST-3`, '冲突时必须取下一个名字')
  assert.equal(backupTarget(destination, 'NEXT'), `${destination}.bak-NEXT`, '不冲突时用带时间戳的名字')
  assert.equal(read(home, 'breaklimit/state.json.bak-TEST'), 'first', '已有备份不得被覆盖')
  assert.equal(read(home, 'breaklimit/state.json.bak-TEST-2'), 'second', '已有备份不得被覆盖')
})

test('第二次重建后第一次的备份仍在，两份备份互不覆盖', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', PATCHED)
  write(home, 'breaklimit/state.json', 'OLD-RECORD')

  const args = {
    hostRoot: root,
    home,
    patches: patchSet(),
    hashes: hashTable(),
    manifest: { dsh: { commit: HEAD_COMMIT } },
    git: fakeGit({ 'a.txt': ORIGINAL }),
  }
  const first = rebuildState(args)
  const second = rebuildState(args)

  assert.ok(first.backup !== null && second.backup !== null)
  assert.notEqual(first.backup, second.backup, '两次备份必须落在两个名字上')
  assert.equal(fs.readFileSync(first.backup, 'utf8'), 'OLD-RECORD', '第一次的备份必须原样保留')
  assert.equal(
    JSON.parse(fs.readFileSync(second.backup, 'utf8')).operationId,
    path.basename(first.dir),
    '第二次备份的是第一次重建出的清单，不是覆盖后的残骸',
  )
  const backups = fs.readdirSync(path.join(home, 'breaklimit')).filter((name) => name.startsWith('state.json.bak'))
  assert.equal(backups.length, 2, '两次重建必须留下两份备份')
})

test('部分采纳时照写清单，退出码 1，并列出未采纳清单', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', PATCHED) // 本方写入 → 采纳
  write(root, 'b.txt', ORIGINAL_B) // 与原文相同，这份改动不在 → 拒绝

  const result = rebuildState({
    hostRoot: root,
    home,
    patches: patchSetTwo(),
    hashes: hashTableTwo(),
    manifest: { dsh: { commit: HEAD_COMMIT } },
    git: fakeGit({ 'a.txt': ORIGINAL, 'b.txt': ORIGINAL_B }),
  })

  assert.equal(result.written, true)
  assert.equal(result.exitCode, 1)
  assert.deepEqual(Object.keys(result.accepted), ['a.txt'])
  assert.deepEqual(result.rejected.map(([relative]) => relative), ['b.txt'], '未采纳清单必须留在返回结构里')

  const persisted = readState(home)
  assert.equal(persisted.kind, 'ok')
  assert.deepEqual(Object.keys(persisted.state.files), ['a.txt'], '清单只记采纳的文件')
})

test('重建之后预检认成 applied，apply 不再写盘，revert 还原成原文', (t) => {
  if (!gitAvailable()) {
    t.skip('这台机器上没有可用的 git，重建链路无法端到端验证')
    return
  }

  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', ORIGINAL)
  initRepo(root, ['a.txt'])

  // 宿主上已经是本方写入的内容，记录与快照都不在。
  write(root, 'a.txt', PATCHED)

  // 重建前的处境，就是界面报「11 处和补丁预期对不上」那一个：盘上明明是本方写的，
  // 没有记录就没法证明，预检整批阻断。
  const blocked = preflight({
    root,
    patches: patchSet(),
    readFile: readTextOrNull,
    hashes: hashTable(),
    appliedRecords: {},
    variantsByPath: replaceVariantsByPath(patchSet()),
  })
  assert.equal(blocked.ok, false, '没有记录时必须阻断，这是要修的那个症状')
  assert.match(blocked.blocked[0].reason, /整文件预哈希不符/)

  const result = rebuildState({
    hostRoot: root,
    home,
    patches: patchSet(),
    hashes: hashTable(),
    manifest: { dsh: { commit: headCommit(root) } },
  })

  assert.deepEqual(Object.keys(result.accepted), ['a.txt'])
  assert.equal(result.headCount, 1)
  assert.equal(result.snapshotCount, 0)

  const persisted = readState(home)
  assert.equal(persisted.kind, 'ok', '重建必须留下可读的清单')
  assert.equal(persisted.state.files['a.txt'].before, hashText(ORIGINAL))
  assert.equal(
    fs.readFileSync(path.join(persisted.state.transaction, 'files', 'a.txt'), 'utf8'),
    ORIGINAL,
    '快照必须是声明的那一版原文',
  )

  // 预检：重建前这里报「整文件预哈希不符」，重建后必须认成本方写入。
  const appliedRecords = {}
  for (const [file, record] of Object.entries(persisted.state.files)) {
    appliedRecords[file] = { before: record.before, after: record.after }
  }
  const check = preflight({
    root,
    patches: patchSet(),
    readFile: readTextOrNull,
    hashes: hashTable(),
    appliedRecords,
    variantsByPath: replaceVariantsByPath(patchSet()),
  })
  assert.equal(check.ok, true, '重建后预检不该再阻断')
  assert.equal(check.findings[0].state, 'applied')
  assert.equal(check.changes.size, 0, '已是目标状态，不该有待写入的文件')

  const again = applyPatches({ root, home, patches: patchSet(), lock: createLock(), hashes: hashTable() })
  assert.equal(again.code, 'already_applied')
  assert.deepEqual(again.written, [])
  assert.equal(read(root, 'a.txt'), PATCHED, 'apply 不得改动已验证的内容')

  const back = revertPatches({ root, home, lock: createLock() })
  assert.equal(back.code, 'reverted')
  assert.equal(read(root, 'a.txt'), ORIGINAL, '重建出来的记录必须让 revert 真的还原成原文')
})

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
}

function initRepo(root, files) {
  git(root, ['init'])
  for (const file of files) git(root, ['add', file])
  git(root, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base'])
}

function headCommit(root) {
  return git(root, ['rev-parse', 'HEAD']).trim()
}
