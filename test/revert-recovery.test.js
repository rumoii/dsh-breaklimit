// 回退恢复链的回归测试：快照校验、增量应用失败、回退中断重试、补偿失败。
//
// 全部在临时 root + 临时 home 里跑合成文件，不读宿主、不写宿主。夹具形状与
// test/engine.test.js 一致：同一个 createLock、同样的 apply / revert 入参，
// 不另造一套 API。
//
// 断言对齐的是目标契约，不是当前实现的产出：
//   快照内容 ≠ record.before  →  snapshot_corrupt，且目标一个字节都不动
//   增量应用写入失败          →  apply_failed + statePreserved + 旧记录还在
//   回退中断后重试            →  只补写未恢复的文件，restored 含先前已恢复的
//   补偿失败                  →  revert_failed + recoveryErrors + 如实报 restored
//   备份写盘失败              →  revert_failed + 目标未动 + 记录仍处于 committed
// 缺陷修好之前，这五条应当是红的；红了才说明用例真的在验那件事。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import { atomicWrite, hashText } from '../src/patch/fsx.js'
import { createLock } from '../src/patch/lock.js'
import { applyPatches, revertPatches } from '../src/patch/transaction.js'
import { readState, statePath } from '../src/patch/state.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-revert-'))
}

function write(root, rel, content) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function replacePatch(targets, id = 'T-01') {
  return { id, title: '测试补丁', kind: 'replace', targets }
}

/** 按磁盘现状现算预哈希，与 engine.test.js 的同名夹具同义。 */
function hashesOf(root, patches) {
  const table = {}
  for (const patch of patches) {
    table[patch.id] = {}
    for (const target of patch.targets) {
      const text = readOrNull(path.join(root, target.path))
      if (text === null) continue
      table[patch.id][target.path] = hashText(text)
    }
  }
  return table
}

function apply(root, home, patches, extra = {}) {
  return applyPatches({
    root,
    home,
    patches,
    lock: createLock(),
    hashes: hashesOf(root, patches),
    ...extra,
  })
}

/**
 * 包一层 writeFile：照常落盘，同时记下写进宿主根的那些文件。
 *
 * 回退的备份快照写在事务目录里，只有真正改宿主的那几次写入才该被记进来——
 * 「只写回 b.txt」这种断言必须排除快照写入，否则永远数不对。
 */
function tracingWrites(root, intercept = () => null) {
  const rootDir = path.resolve(root)
  const rootWrites = []
  const writeFile = (file, content) => {
    const verdict = intercept(file, content)
    if (verdict instanceof Error) throw verdict
    atomicWrite(file, content)
    if (path.dirname(path.resolve(file)) === rootDir) rootWrites.push(path.basename(file))
  }
  return { writeFile, rootWrites }
}

test('回退写入返回但内容不符时保留恢复记录，修复写入器后可重试', t => {
  const root = tempDir()
  const home = tempDir()
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }) })
  write(root, 'a.txt', 'A1\n')
  const patches = [replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }])]
  assert.equal(apply(root, home, patches).ok, true)
  const result = revertPatches({ root, home, writeFile(file, content) {
    if (file === path.join(root, 'a.txt')) return
    atomicWrite(file, content)
  } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'revert_failed')
  assert.equal(readState(home).kind, 'ok')
  assert.equal(read(root, 'a.txt'), 'A2\n')
  assert.equal(revertPatches({ root, home }).ok, true)
  assert.equal(read(root, 'a.txt'), 'A1\n')
})

test('失败补偿返回但未恢复内容时如实报告，并保留重试所需记录', t => {
  const root = tempDir()
  const home = tempDir()
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }) })
  write(root, 'a.txt', 'A1\n')
  write(root, 'b.txt', 'B1\n')
  const patches = [replacePatch([
    { path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 },
    { path: 'b.txt', before: 'B1', after: 'B2', expectHits: 1 },
  ])]
  assert.equal(apply(root, home, patches).ok, true)
  const result = revertPatches({ root, home, writeFile(file, content) {
    if (file === path.join(root, 'b.txt')) throw new Error('simulated revert failure')
    if (file === path.join(root, 'a.txt') && String(content) === 'A2\n') return
    atomicWrite(file, content)
  } })
  assert.equal(result.ok, false)
  assert.equal(result.recoveryErrors.length, 1)
  assert.match(result.recoveryErrors[0], /复校验失败/)
  assert.deepEqual(result.restored, ['a.txt'])
  assert.equal(readState(home).kind, 'ok')
  assert.equal(revertPatches({ root, home }).ok, true)
  assert.equal(read(root, 'a.txt'), 'A1\n')
  assert.equal(read(root, 'b.txt'), 'B1\n')
})

test('快照内容与记录不符时拒绝回退，目标文件一个字节都不动', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  const patches = [replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])]
  const lock = createLock()

  assert.equal(apply(root, home, patches, { lock }).code, 'applied')

  const state = JSON.parse(read(home, 'breaklimit/state.json'))
  const snapshot = path.join(state.transaction, 'files', 'a.txt')
  assert.equal(fs.readFileSync(snapshot, 'utf8'), 'VALUE = 2000\n')
  // 快照被改坏：它的哈希已经不等于记录里的 before。照着它写回去就是把损坏内容
  // 盖上「已回退」的章，还顺手删掉唯一能说明原文是什么的记录。
  fs.writeFileSync(snapshot, 'CORRUPTED = 1\n', 'utf8')

  const back = revertPatches({ root, home, lock })

  assert.equal(back.ok, false)
  assert.equal(back.code, 'snapshot_corrupt')
  assert.ok(Array.isArray(back.drifted) && back.drifted.length > 0, 'drifted 必须指出对不上的文件')
  assert.equal(read(root, 'a.txt'), 'VALUE = 20000\n')
  // 整体拒绝意味着现场未被碰过：记录还在，下一次才有得试。
  assert.equal(readState(home).kind, 'ok')
})

test('增量应用写入失败时保留旧记录，revert 仍能还原前一批', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'A1\n')
  write(root, 'b.txt', 'B1\n')
  const lock = createLock()

  assert.equal(apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }], 'T-A'),
  ], { lock }).code, 'applied')

  // 第二批只让 b.txt 的写入失败：a.txt 的补丁已经是目标状态，不会重写。
  const bFile = path.join(root, 'b.txt')
  const failing = (file, content) => {
    if (file === bFile) throw new Error('模拟写入失败')
    atomicWrite(file, content)
  }
  const second = apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }], 'T-A'),
    replacePatch([{ path: 'b.txt', before: 'B1', after: 'B2', expectHits: 1 }], 'T-B'),
  ], { lock, writeFile: failing })

  assert.equal(second.ok, false)
  assert.equal(second.code, 'apply_failed')
  // A 仍然留在宿主上。删掉记录等于让 A 失去「本方写的」证据：revert 报未应用，
  // 再 apply 被自己的改动挡住，现场从此无法收敛。
  assert.equal(second.statePreserved, true, 'A 仍在宿主上，记录不能删')
  assert.equal(second.phase, 'rollback-failed')

  const persisted = readState(home)
  assert.equal(persisted.kind, 'ok', 'state 文件必须仍然存在')
  assert.ok(persisted.state.files['a.txt'], '清单里必须仍然有 A 的记录')
  assert.equal(read(root, 'b.txt'), 'B1\n')

  const back = revertPatches({ root, home, lock })
  assert.equal(back.ok, true)
  assert.equal(back.code, 'reverted')
  assert.equal(read(root, 'a.txt'), 'A1\n')
})

test('回退中断后重试：只补写未恢复的文件，restored 含先前已恢复的', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'A1\n')
  write(root, 'b.txt', 'B1\n')
  const lock = createLock()

  assert.equal(apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }], 'T-A'),
    replacePatch([{ path: 'b.txt', before: 'B1', after: 'B2', expectHits: 1 }], 'T-B'),
  ], { lock }).code, 'applied')

  // 崩溃现场：回退已把 a.txt 写回原文，进程在写 b.txt 之前被杀。
  // phase 与已恢复清单必须落盘，否则重试既认不出 a.txt 已经回过，也报不出它。
  const state = JSON.parse(read(home, 'breaklimit/state.json'))
  state.phase = 'reverting'
  state.revert = { restored: ['a.txt'] }
  fs.writeFileSync(statePath(home), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  write(root, 'a.txt', 'A1\n')

  const { writeFile, rootWrites } = tracingWrites(root)
  const back = revertPatches({ root, home, lock, writeFile })

  assert.equal(back.ok, true)
  assert.equal(back.code, 'reverted')
  assert.ok(Array.isArray(back.restored), 'restored 必须是数组')
  assert.deepEqual([...back.restored].sort(), ['a.txt', 'b.txt'])
  // 已恢复的文件再写一遍就是拿「原文」覆盖可能存在的后续改动，只许补写 b.txt。
  assert.deepEqual(rootWrites, ['b.txt'])
  assert.equal(read(root, 'a.txt'), 'A1\n')
  assert.equal(read(root, 'b.txt'), 'B1\n')
  assert.equal(fs.existsSync(statePath(home)), false, '收敛后清单必须删除')
})

test('补偿失败时报出 recoveryErrors，restored 只含真正恢复成功的文件', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'A1\n')
  write(root, 'b.txt', 'B1\n')
  const lock = createLock()

  assert.equal(apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }], 'T-A'),
    replacePatch([{ path: 'b.txt', before: 'B1', after: 'B2', expectHits: 1 }], 'T-B'),
  ], { lock }).code, 'applied')

  // a.txt 的恢复直接失败；b.txt 的恢复成功、补偿（写回回退前内容）失败。
  const aFile = path.join(root, 'a.txt')
  const bFile = path.join(root, 'b.txt')
  const { writeFile } = tracingWrites(root, (file, content) => {
    if (file === aFile) return new Error('模拟恢复失败')
    if (file === bFile && String(content) === 'B2\n') return new Error('模拟补偿失败')
    return null
  })

  const back = revertPatches({ root, home, lock, writeFile })

  assert.equal(back.ok, false)
  assert.equal(back.code, 'revert_failed')
  assert.equal(back.phase, 'reverting')
  assert.ok(Array.isArray(back.recoveryErrors) && back.recoveryErrors.length > 0, '补偿失败必须报出来')
  // b.txt 的恢复写入成功且补偿没写回去，磁盘上它就是原文；a.txt 没恢复成功。
  assert.ok(Array.isArray(back.restored), 'restored 必须是数组')
  assert.deepEqual([...back.restored].sort(), ['b.txt'])
  // 补偿没成功还说「已把 N 个文件恢复」就是假报告，现场的下一步会被它带偏。
  assert.doesNotMatch(back.message, /已把\s*\d+\s*个[^，。；]*恢复/)

  assert.equal(read(root, 'a.txt'), 'A2\n')
  assert.equal(read(root, 'b.txt'), 'B1\n')
  // 回退没走完，记录必须停在 reverting，下一次才能接着收敛。
  const persisted = readState(home)
  assert.equal(persisted.kind, 'ok', '回退失败后必须留下记录')
  assert.equal(persisted.state.phase, 'reverting')
})

test('备份写盘失败时返回 revert_failed，目标与记录都原样不动', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'A1\n')
  write(root, 'b.txt', 'B1\n')
  const lock = createLock()

  assert.equal(apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }], 'T-A'),
    replacePatch([{ path: 'b.txt', before: 'B1', after: 'B2', expectHits: 1 }], 'T-B'),
  ], { lock }).code, 'applied')

  // 回退在碰目标文件之前只会写备份快照，它们落在事务目录里。让第一批这样的写入抛错：
  // 备份没写成，阶段二就不该开始，两个目标文件必须一个字节都不动。
  const rootDir = path.resolve(root)
  const { writeFile } = tracingWrites(root, (file) => {
    if (path.dirname(path.resolve(file)) !== rootDir) return new Error('模拟备份写入失败')
    return null
  })

  const back = revertPatches({ root, home, lock, writeFile })

  assert.equal(back.ok, false, '备份失败不能抛异常，必须返回结构化结果')
  assert.equal(back.code, 'revert_failed')
  assert.match(back.error, /模拟备份写入失败/, '原始错误文本必须保留')
  assert.match(back.message, /未修改任何目标文件/)
  assert.equal(read(root, 'a.txt'), 'A2\n')
  assert.equal(read(root, 'b.txt'), 'B2\n')
  // 阶段一读到的记录原样留着：phase 仍是 committed，下一次面对的是同一份记录。
  const persisted = readState(home)
  assert.equal(persisted.kind, 'ok')
  assert.equal(persisted.state.phase, 'committed')

  // 锁必须已经释放：同一个 lock 立刻能再拿到，否则进程内锁停在 busy，只能重启宿主。
  const retry = revertPatches({ root, home, lock })
  assert.equal(retry.ok, true, '失败路径必须释放进程内锁，第二次调用才能立刻拿到')
  assert.equal(retry.code, 'reverted')
  assert.equal(read(root, 'a.txt'), 'A1\n')
  assert.equal(read(root, 'b.txt'), 'B1\n')
})


test('回退备份阶段读不到目标时整体拒绝，不能用空串充当恢复副本', () => {
  const root = tempDir(), home = tempDir()
  write(root, 'a.txt', 'A1')
  assert.equal(apply(root, home, [replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }])]).ok, true)
  const file = path.join(root, 'a.txt'), original = fs.readFileSync
  let reads = 0
  fs.readFileSync = (target, ...args) => {
    if (String(target) === file && ++reads === 2) { const error = new Error('backup read denied'); error.code = 'EACCES'; throw error }
    return original(target, ...args)
  }
  let result
  try { result = revertPatches({ root, home }) } finally { fs.readFileSync = original }
  assert.equal(result.code, 'revert_failed')
  assert.equal(read(root, 'a.txt'), 'A2')
  assert.equal(readState(home).state.phase, 'committed')
  assert.equal(revertPatches({ root, home }).ok, true)
})

test('UTF-8 BOM 与多字节正文应用回退后逐字节一致，账本写 v2', () => {
  const root = tempDir(), home = tempDir()
  const bytes = Buffer.from('\ufeff中文 A1\r\n', 'utf8')
  fs.writeFileSync(path.join(root, 'a.txt'), bytes)
  assert.equal(apply(root, home, [replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }])]).ok, true)
  assert.equal(readState(home).state.version, 2)
  assert.equal(revertPatches({ root, home }).ok, true)
  assert.deepEqual(fs.readFileSync(path.join(root, 'a.txt')), bytes)
})

for (const change of [state => { state.files['../outside'] = { before: 'a', after: 'b' } }, state => { state.files['a.txt'] = null }, state => { state.transaction = 123 }]) {
  test('非法账本拒绝回退并保护原文件', () => {
    const root = tempDir(), home = tempDir()
    write(root, 'a.txt', 'A1')
    apply(root, home, [replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }])])
    const state = readState(home).state
    change(state)
    fs.writeFileSync(statePath(home), JSON.stringify(state))
    assert.equal(revertPatches({ root, home }).code, 'state_corrupt')
    assert.equal(read(root, 'a.txt'), 'A2')
  })
}


test('读取 v1 记录后回退失败，新恢复进度必须用 v2 保留', () => {
  const root = tempDir(), home = tempDir()
  write(root, 'a.txt', 'A1')
  apply(root, home, [replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }])])
  const old = readState(home).state
  old.version = 1
  fs.writeFileSync(statePath(home), JSON.stringify(old))
  const result = revertPatches({ root, home, writeFile(file, content) {
    if (file === path.join(root, 'a.txt')) throw new Error('interrupted revert')
    atomicWrite(file, content)
  } })
  assert.equal(result.code, 'revert_failed')
  assert.equal(readState(home).state.version, 2)
  assert.equal(revertPatches({ root, home }).ok, true)
})


test('真实回退子进程写回首个目标后退出，重试按磁盘续做', () => {
  const root = tempDir(), home = tempDir()
  write(root, 'a.txt', 'A1'); write(root, 'b.txt', 'B1')
  apply(root, home, [replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }, { path: 'b.txt', before: 'B1', after: 'B2', expectHits: 1 }])])
  const transaction = new URL('../src/patch/transaction.js', import.meta.url).href
  const fsx = new URL('../src/patch/fsx.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { revertPatches } from ${JSON.stringify(transaction)};
    import { atomicWrite } from ${JSON.stringify(fsx)};
    revertPatches({root:${JSON.stringify(root)},home:${JSON.stringify(home)},writeFile(file,bytes){atomicWrite(file,bytes);if(file===${JSON.stringify(path.join(root,'a.txt'))})process.exit(24)}});
  `], { encoding: 'utf8' })
  assert.equal(child.status, 24, child.stderr)
  const expired = new Date(Date.now()-60000)
  fs.utimesSync(path.join(home,'breaklimit','operation.lock'),expired,expired)
  assert.equal(read(root,'a.txt'),'A1')
  assert.equal(read(root,'b.txt'),'B2')
  assert.equal(revertPatches({root,home}).ok,true)
  assert.equal(read(root,'b.txt'),'B1')
})
