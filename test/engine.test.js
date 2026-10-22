// 引擎语义测试：预检判定、幂等、回滚、漂移拒绝、并发。
//
// 全部在临时目录里跑合成文件，不读宿主、不写宿主。夹具回放（对着目标宿主的
// 真实 HEAD 内容跑一遍）由 tools/check-fixture.mjs 承担，两者职责不同：
// 这里证明引擎的判定与事务语义正确，那里证明补丁声明与目标版本对齐。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { atomicWrite, hashText } from '../src/patch/fsx.js'
import { createLock } from '../src/patch/lock.js'
import { countOccurrences, preflight } from '../src/patch/preflight.js'
import { applyPatches, pruneTransactions, revertPatches } from '../src/patch/transaction.js'
import { transactionsDir } from '../src/patch/state.js'
import { PATCHES } from '../src/patch/index.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-test-'))
}

function write(root, rel, content) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function replacePatch(targets, id = 'T-01') {
  return { id, title: '测试补丁', kind: 'replace', targets }
}

/** 读文件，不存在返回 null。与预检注入的 readFile 语义一致。 */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 按补丁集从磁盘现读原始内容算哈希，等价于真实的 patches/hashes.json。
 *
 * 预检现在要求预哈希必填——缺了就拒绝在弱判定下继续。测试要么显式声明一份
 * 「当前即目标版本」的哈希表，要么就没法让任何补丁通过。这个包装承担前者，
 * 让每个用例只关心它真正想验的那件事。
 *
 * 目标文件不存在时不写条目：预检会先按「文件不存在」阻断，用不到这里的哈希，
 * 而在这里抛异常会让「目标缺失」的用例死在夹具阶段而不是断言阶段。
 */
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

/** 应用补丁，预哈希按磁盘现状现算。extra 可覆盖 lock、writeFile、hashes。 */
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

test('countOccurrences 计数不重叠命中，空串不计', () => {
  assert.equal(countOccurrences('aaaa', 'aa'), 2)
  assert.equal(countOccurrences('aaaa', ''), 0)
  assert.equal(countOccurrences('abc', 'z'), 0)
})

test('单命中应用成功并写入状态清单', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'const VALUE = 2000\n')

  const result = apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }]),
  ])

  assert.equal(result.ok, true)
  assert.equal(result.code, 'applied')
  assert.equal(read(root, 'a.txt'), 'const VALUE = 20000\n')
  assert.ok(fs.existsSync(path.join(home, 'breaklimit', 'state.json')))
})

test('零命中阻断，磁盘上一个字节都不写', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'const VALUE = 3000\n')

  const result = apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }]),
  ])

  assert.equal(result.ok, false)
  assert.equal(result.code, 'preflight_blocked')
  assert.equal(read(root, 'a.txt'), 'const VALUE = 3000\n')
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'state.json')), false)
})

test('多命中阻断：原文不再唯一时拒绝猜测位置', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\nVALUE = 2000\n')

  const result = apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }]),
  ])

  assert.equal(result.code, 'preflight_blocked')
  assert.equal(read(root, 'a.txt'), 'VALUE = 2000\nVALUE = 2000\n')
})

test('前缀陷阱：新值以旧值为前缀时不重复应用', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'export const READ_LIMIT = 2000\n')
  const patch = replacePatch([{
    path: 'a.txt',
    before: 'export const READ_LIMIT = 2000',
    after: 'export const READ_LIMIT = 20000',
    expectHits: 1,
  }])
  const lock = createLock()

  const first = apply(root, home, [patch], { lock })
  assert.equal(first.code, 'applied')

  const second = apply(root, home, [patch], { lock })
  assert.equal(second.code, 'already_applied')
  assert.equal(read(root, 'a.txt'), 'export const READ_LIMIT = 20000\n')
})

test('真实锚点（工作区指令）改写后重复应用安全', () => {
  const patch = PATCHES.find(item => item.id === 'workspace.authority')
  const [target] = patch.targets
  const root = tempDir()
  const home = tempDir()
  // 改后文本不是改前文本的超串：重复应用必须靠整文件哈希识别，而不是靠子串。
  assert.equal(target.after.includes(target.before), false)
  write(root, target.path, `${target.before}\n`)
  const lock = createLock()

  const first = apply(root, home, [patch], { lock })
  assert.equal(first.code, 'applied')
  assert.equal(read(root, target.path), `${target.after}\n`)

  const second = apply(root, home, [patch], { lock })
  assert.equal(second.code, 'already_applied')
  assert.equal(read(root, target.path), `${target.after}\n`)
})

test('重复应用不产生重复写入：依赖条目计数保持不变', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'package.json', '{\n  "deps": {\n    "pkg": "workspace:^"\n  }\n}\n')
  const patch = {
    id: 'T-DEP',
    title: '依赖校验',
    kind: 'verify',
    targets: [{ path: 'package.json', needle: '"pkg": "workspace:^"', minHits: 1 }],
  }
  const lock = createLock()

  for (let round = 0; round < 5; round += 1) {
    const result = apply(root, home, [patch], { lock })
    assert.equal(result.ok, true)
    assert.equal(result.code, 'already_applied')
  }

  const text = read(root, 'package.json')
  assert.equal(countOccurrences(text, '"pkg": "workspace:^"'), 1)
})

test('verify 满足即通过，不足则阻断', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'has: marker\n')
  const hashes = { 'T-V': { 'a.txt': hashText('has: marker\n') } }
  const target = needle => [{ id: 'T-V', kind: 'verify', title: 'v', targets: [{ path: 'a.txt', needle, minHits: 1 }] }]

  const ok = preflight({ root, patches: target('has: marker'), readFile: readOrNull, hashes })
  assert.equal(ok.ok, true)
  assert.equal(ok.findings[0].state, 'satisfied')

  const bad = preflight({ root, patches: target('missing: marker'), readFile: readOrNull, hashes })
  assert.equal(bad.ok, false)
  assert.equal(bad.findings[0].state, 'unsatisfied')
})

test('目标文件缺失时阻断', () => {
  const root = tempDir()
  const home = tempDir()

  const result = apply(root, home, [
    replacePatch([{ path: 'absent.txt', before: 'x', after: 'y', expectHits: 1 }]),
  ])

  assert.equal(result.code, 'preflight_blocked')
  assert.equal(result.blocked[0].reason, '意图目标文件不存在')
})

test('回退恢复原文内容', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  const patches = [replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])]
  const lock = createLock()

  assert.equal(apply(root, home, patches, { lock }).code, 'applied')
  const back = revertPatches({ root, home, lock })
  assert.equal(back.ok, true)
  assert.equal(back.code, 'reverted')
  assert.equal(read(root, 'a.txt'), 'VALUE = 2000\n')
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'state.json')), false)
})

test('回退在文件漂移时整体拒绝，且不覆盖漂移内容', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  const patches = [replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])]
  const lock = createLock()

  assert.equal(apply(root, home, patches, { lock }).code, 'applied')
  write(root, 'a.txt', 'VALUE = 9999\n')

  const back = revertPatches({ root, home, lock })
  assert.equal(back.ok, false)
  assert.equal(back.code, 'drift_detected')
  assert.equal(read(root, 'a.txt'), 'VALUE = 9999\n')
  assert.ok(fs.existsSync(path.join(home, 'breaklimit', 'state.json')))
})

test('无应用记录时回退报未应用', () => {
  const root = tempDir()
  const home = tempDir()
  const back = revertPatches({ root, home, lock: createLock() })
  assert.equal(back.code, 'not_applied')
})

test('锁被占用时返回操作进行中', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  const lock = createLock()
  lock.acquire('other-operation')

  const result = apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }]),
  ], { lock })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'operation_in_progress')
  assert.equal(read(root, 'a.txt'), 'VALUE = 2000\n')
})

test('写入中途失败会回滚已写文件并保留原始错误', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'A = 1\n')
  write(root, 'b.txt', 'B = 1\n')
  const patches = [
    replacePatch([{ path: 'a.txt', before: 'A = 1', after: 'A = 2', expectHits: 1 }], 'T-A'),
    replacePatch([{ path: 'b.txt', before: 'B = 1', after: 'B = 2', expectHits: 1 }], 'T-B'),
  ]

  const failing = (file, content) => {
    if (file === path.join(root, 'b.txt')) throw new Error('模拟写入失败')
    atomicWrite(file, content)
  }

  const result = apply(root, home, patches, { writeFile: failing })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'apply_failed')
  assert.match(result.error, /模拟写入失败/)
  assert.equal(read(root, 'a.txt'), 'A = 1\n')
  assert.equal(read(root, 'b.txt'), 'B = 1\n')
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'state.json')), false)
})

test('快照保存原文，回滚依据快照而非重新推导', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  const patches = [replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])]
  const lock = createLock()

  assert.equal(apply(root, home, patches, { lock }).code, 'applied')

  const state = JSON.parse(read(home, 'breaklimit/state.json'))
  const snapshot = path.join(state.transaction, 'files', 'a.txt')
  assert.equal(fs.readFileSync(snapshot, 'utf8'), 'VALUE = 2000\n')
  assert.equal(state.files['a.txt'].before, hashText('VALUE = 2000\n'))
  assert.equal(state.files['a.txt'].after, hashText('VALUE = 20000\n'))
  assert.equal(state.phase, 'committed')
})

test('写入中途失败后清单被撤销，不留误导性的应用记录', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  const patches = [replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])]

  const failing = () => {
    throw new Error('模拟写入失败')
  }
  const result = apply(root, home, patches, { writeFile: failing })

  assert.equal(result.code, 'apply_failed')
  // 文件已回到起点，记录必须一起消失——否则下一次回退会去回退一次没发生过的应用。
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'state.json')), false)
  assert.equal(read(root, 'a.txt'), 'VALUE = 2000\n')
})

test('状态清单不可读时一个目标文件都不动', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  // 让 state.json 的位置被一个目录占住：读是 EISDIR、写也必败。
  // 读失败不等于「没有清单」，预检在读取期就报 state_corrupt 拒绝执行；
  // 真正的「写入期失败」由上一例的 writeFile 注入覆盖（writeState 没有注入缝）。
  fs.mkdirSync(path.join(home, 'breaklimit', 'state.json'), { recursive: true })

  const result = apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }]),
  ])

  assert.equal(result.ok, false)
  assert.equal(result.code, 'state_corrupt')
  assert.equal(read(root, 'a.txt'), 'VALUE = 2000\n')
})

test('记录损坏时 Apply 拒绝执行', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  fs.mkdirSync(path.join(home, 'breaklimit'), { recursive: true })
  fs.writeFileSync(path.join(home, 'breaklimit', 'state.json'), '{ 这不是 JSON', 'utf8')

  const result = apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }]),
  ])

  assert.equal(result.ok, false)
  assert.equal(result.code, 'state_corrupt')
  assert.equal(read(root, 'a.txt'), 'VALUE = 2000\n')
})

test('记录损坏时 Revert 拒绝执行并报出原因', () => {
  const root = tempDir()
  const home = tempDir()
  fs.mkdirSync(path.join(home, 'breaklimit'), { recursive: true })
  fs.writeFileSync(path.join(home, 'breaklimit', 'state.json'), '不是 JSON', 'utf8')

  const result = revertPatches({ root, home, lock: createLock() })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'state_corrupt')
  assert.match(result.reason, /不是合法 JSON/)
})

test('记录版本不符时拒绝执行', () => {
  const root = tempDir()
  const home = tempDir()
  fs.mkdirSync(path.join(home, 'breaklimit'), { recursive: true })
  fs.writeFileSync(path.join(home, 'breaklimit', 'state.json'), '{"version": 99, "files": {}}', 'utf8')

  const result = revertPatches({ root, home, lock: createLock() })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'state_version_mismatch')
})

test('快照缺失时 Revert 整体拒绝，磁盘不被改动', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  const patches = [replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])]
  const lock = createLock()
  assert.equal(apply(root, home, patches, { lock }).code, 'applied')

  const state = JSON.parse(read(home, 'breaklimit/state.json'))
  fs.rmSync(path.join(state.transaction, 'files', 'a.txt'), { force: true })

  const back = revertPatches({ root, home, lock })
  assert.equal(back.ok, false)
  assert.equal(back.code, 'drift_detected')
  assert.equal(read(root, 'a.txt'), 'VALUE = 20000\n')
})

test('预哈希不符时阻断，不写入任何文件', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  const patch = replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])

  const result = apply(root, home, [patch], {
    hashes: { 'T-01': { 'a.txt': hashText('完全不同的内容\n') } },
  })

  assert.equal(result.code, 'preflight_blocked')
  assert.match(result.blocked[0].reason, /整文件预哈希不符/)
  assert.equal(read(root, 'a.txt'), 'VALUE = 2000\n')
})

test('预哈希相符时正常应用', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')
  const patch = replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])

  const result = apply(root, home, [patch], {
    hashes: { 'T-01': { 'a.txt': hashText('VALUE = 2000\n') } },
  })

  assert.equal(result.code, 'applied')
  assert.equal(read(root, 'a.txt'), 'VALUE = 20000\n')
})

test('补丁集缺少预哈希记录时阻断，不退回纯字符串判定', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'VALUE = 2000\n')

  const result = preflight({
    root,
    patches: [replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])],
    readFile: readOrNull,
    hashes: {},
  })

  assert.equal(result.ok, false)
  assert.match(result.blocked[0].reason, /没有预哈希记录/)
})

test('哈希表整体缺失时阻断', () => {
  const result = preflight({
    root: tempDir(),
    patches: [replacePatch([{ path: 'a.txt', before: 'x', after: 'y', expectHits: 1 }])],
    readFile: readOrNull,
    hashes: null,
  })

  assert.equal(result.ok, false)
  assert.match(result.blocked[0].reason, /预哈希清单缺失/)
})

test('同一文件的多个目标都对着原始内容校验预哈希', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'FIRST = 1\nSECOND = 2\n')
  const patches = [
    replacePatch([{ path: 'a.txt', before: 'FIRST = 1', after: 'FIRST = 10', expectHits: 1 }], 'T-A'),
    replacePatch([{ path: 'a.txt', before: 'SECOND = 2', after: 'SECOND = 20', expectHits: 1 }], 'T-B'),
  ]
  const original = hashText('FIRST = 1\nSECOND = 2\n')

  const result = apply(root, home, patches, {
    hashes: { 'T-A': { 'a.txt': original }, 'T-B': { 'a.txt': original } },
  })

  assert.equal(result.code, 'applied')
  assert.equal(read(root, 'a.txt'), 'FIRST = 10\nSECOND = 20\n')
})

test('replace 与 verify 命中同一文件时，第二次 Apply 报已应用', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'LIMIT = 2000\nmarker: yes\n')
  const patches = [
    replacePatch([{ path: 'a.txt', before: 'LIMIT = 2000', after: 'LIMIT = 20000', expectHits: 1 }], 'T-R'),
    { id: 'T-V', title: '校验', kind: 'verify', targets: [{ path: 'a.txt', needle: 'marker: yes', minHits: 1 }] },
  ]
  const lock = createLock()

  const first = apply(root, home, patches, { lock })
  assert.equal(first.code, 'applied')
  assert.equal(read(root, 'a.txt'), 'LIMIT = 20000\nmarker: yes\n')

  // 第二次时磁盘内容已不等于原始预哈希，但等于本方写下的版本，verify 也认这份版本。
  // 少了预检的第 1 层，这里会判成「宿主已偏离声明的版本」，被自己的改动挡住。
  const second = apply(root, home, patches, { lock })
  assert.equal(second.code, 'already_applied')
  assert.equal(read(root, 'a.txt'), 'LIMIT = 20000\nmarker: yes\n')
})

test('回滚失败时保留应用记录并标记 rollback-failed', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'A = 1\n')
  write(root, 'b.txt', 'B = 1\n')
  const patches = [
    replacePatch([{ path: 'a.txt', before: 'A = 1', after: 'A = 2', expectHits: 1 }], 'T-A'),
    replacePatch([{ path: 'b.txt', before: 'B = 1', after: 'B = 2', expectHits: 1 }], 'T-B'),
  ]

  // a.txt 的首次写入放行、回滚时的第二次写入失败，模拟「改坏一半又救不回来」。
  let aWritten = false
  const failing = (file, content) => {
    if (file === path.join(root, 'b.txt')) throw new Error('模拟写入失败')
    if (file === path.join(root, 'a.txt')) {
      if (aWritten) throw new Error('模拟回滚失败')
      aWritten = true
    }
    atomicWrite(file, content)
  }

  const result = apply(root, home, patches, { writeFile: failing })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'apply_failed')
  assert.equal(result.rollbackErrors.length, 1)
  assert.equal(result.statePreserved, true)
  assert.equal(result.phase, 'rollback-failed')

  // 磁盘上 a.txt 仍是改过的版本，清单必须留下来给下一次 revert 用。
  assert.equal(read(root, 'a.txt'), 'A = 2\n')
  const state = JSON.parse(read(home, 'breaklimit/state.json'))
  assert.equal(state.phase, 'rollback-failed')
  assert.equal(fs.existsSync(path.join(state.transaction, 'files', 'a.txt')), true)
})

// 记录说的是「当前仍归插件管的全部文件」。增量应用（先应用一批、之后又加一条再应用）
// 若不继承，先前那批就失去「已应用」的证据，预检会判它们偏离声明版本，整批阻断。
test('增量应用保留先前那批的记录，且 revert 仍能还原两批', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'A1')
  write(root, 'b.txt', 'B1')

  const first = [replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }], 'T-A')]
  assert.equal(apply(root, home, first).ok, true)

  const settled = { id: 'T-A', title: '测试补丁', kind: 'verify', targets: [{ path: 'a.txt', needle: 'A2', minHits: 1 }] }
  const second = apply(root, home, [settled, replacePatch([{ path: 'b.txt', before: 'B1', after: 'B2', expectHits: 1 }], 'T-B')])
  assert.equal(second.ok, true)
  assert.deepEqual(second.written, ['b.txt'])

  const state = JSON.parse(read(home, 'breaklimit/state.json'))
  assert.deepEqual(Object.keys(state.files).sort(), ['a.txt', 'b.txt'])

  // 记录与快照同进同退：搬了记录没搬快照，这里就会漏还原一个文件。
  const back = revertPatches({ root, home, lock: createLock() })
  assert.equal(back.ok, true)
  assert.equal(read(root, 'a.txt'), 'A1')
  assert.equal(read(root, 'b.txt'), 'B1')
})

test('已应用的文件被外部改动后不再继承，且如实报出', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'A1')
  write(root, 'b.txt', 'B1')

  apply(root, home, [replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }], 'T-A')])
  write(root, 'a.txt', 'A1') // 外部改回去：它不再归插件管

  const settled = { id: 'T-A', title: '测试补丁', kind: 'verify', targets: [{ path: 'a.txt', needle: 'A1', minHits: 1 }] }
  const second = apply(root, home, [settled, replacePatch([{ path: 'b.txt', before: 'B1', after: 'B2', expectHits: 1 }], 'T-B')])
  assert.equal(second.ok, true)
  assert.match(second.message, /1 个文件已被外部改动/)

  const state = JSON.parse(read(home, 'breaklimit/state.json'))
  assert.deepEqual(Object.keys(state.files), ['b.txt'])
})

test('旧快照取不到时不继承，账本不留兑现不了的承诺', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'A1')
  write(root, 'b.txt', 'B1')

  apply(root, home, [replacePatch([{ path: 'a.txt', before: 'A1', after: 'A2', expectHits: 1 }], 'T-A')])

  // 把备份目录指针指向不存在的位置，等价于那份快照被 prune 掉。
  const statePath = path.join(home, 'breaklimit', 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.transaction = path.join(home, 'breaklimit', 'transactions', 'missing')
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8')

  const settled = { id: 'T-A', title: '测试补丁', kind: 'verify', targets: [{ path: 'a.txt', needle: 'A2', minHits: 1 }] }
  const second = apply(root, home, [settled, replacePatch([{ path: 'b.txt', before: 'B1', after: 'B2', expectHits: 1 }], 'T-B')])
  assert.equal(second.ok, true)

  const after = JSON.parse(read(home, 'breaklimit/state.json'))
  assert.deepEqual(Object.keys(after.files), ['b.txt'])
})

/**
 * 造一批与真实事务 id 同格式的目录。
 * id 以 `YYYYMMDDTHHMMSS-salt` 开头，字典序即时间序，这正是清理排序依赖的前提。
 *
 * 每个目录都带一份 phase=committed 的 manifest：清理只删 committed，读不到 phase
 * 的目录一律跳过，没有这份记录的夹具验不到「按上限收拢」这件事本身。
 */
function seedTransactionDirs(home, count) {
  const root = transactionsDir(home)
  for (let i = 1; i <= count; i += 1) {
    const name = `20260101T0000${String(i).padStart(2, '0')}-aa`
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ operationId: name, files: {}, phase: 'committed' }), 'utf8')
  }
  return root
}

/**
 * 造一个事务目录。
 * @param {string} home - DSH_HOME。
 * @param {string} name - 目录名。
 * @param {string | null | undefined} phase - 写进 manifest 的 phase；undefined 表示
 *   不写 manifest，null 表示 manifest 里没有 phase 字段。
 */
function seedTransactionDir(home, name, phase) {
  const dir = path.join(transactionsDir(home), name)
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  if (phase !== undefined) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      operationId: name,
      files: {},
      ...(phase === null ? {} : { phase }),
    }), 'utf8')
  }
  return dir
}

test('历史事务目录只保留最近 keep 个', () => {
  const home = tempDir()
  const root = seedTransactionDirs(home, 12)

  const dropped = pruneTransactions(home, 10)

  assert.equal(dropped.length, 2)
  assert.equal(fs.readdirSync(root).length, 10)
})

test('受保护的事务目录即使最旧也不被清理', () => {
  const home = tempDir()
  const root = seedTransactionDirs(home, 12)
  const protect = path.join(root, '20260101T000001-aa')

  pruneTransactions(home, 10, protect)

  assert.equal(fs.existsSync(protect), true)
  assert.equal(fs.readdirSync(root).length, 11)
})

// 失败路径留下的 pending / rollback-failed 目录是 --revert 与 tools/rebuild-state.mjs
// 的依据。按目录名当垃圾扫掉，就等于在故障现场擦掉恢复凭证。
test('清理只删 committed：失败凭证目录即使更旧也留着', () => {
  const home = tempDir()
  const txnRoot = transactionsDir(home)
  seedTransactionDir(home, '20260101T000001-aa', 'committed') // 最旧，唯一该被删的
  seedTransactionDir(home, '20260101T000002-aa', 'rollback-failed')
  seedTransactionDir(home, '20260101T000003-aa', 'pending')
  seedTransactionDir(home, '20260101T000004-aa', 'committed')
  seedTransactionDir(home, '20260101T000005-aa', 'committed')

  const dropped = pruneTransactions(home, 2)

  assert.deepEqual(dropped, ['20260101T000001-aa'], 'committed 的老目录仍按上限清理')
  assert.equal(fs.existsSync(path.join(txnRoot, '20260101T000001-aa')), false)
  assert.equal(fs.existsSync(path.join(txnRoot, '20260101T000002-aa')), true, 'rollback-failed 是恢复凭证')
  assert.equal(fs.existsSync(path.join(txnRoot, '20260101T000003-aa')), true, 'pending 是恢复凭证')
  assert.equal(fs.readdirSync(txnRoot).length, 4)
})

// 读不到 phase 就没有证据说这个目录能删，按保守处理跳过。
test('manifest 缺失、损坏或没有 phase 时一律不删', () => {
  const home = tempDir()
  const txnRoot = transactionsDir(home)
  seedTransactionDir(home, '20260101T000001-aa', undefined)
  const broken = seedTransactionDir(home, '20260101T000002-aa', 'committed')
  fs.writeFileSync(path.join(broken, 'manifest.json'), '{ 这不是 JSON', 'utf8')
  seedTransactionDir(home, '20260101T000003-aa', null)
  seedTransactionDir(home, '20260101T000004-aa', 'committed')
  seedTransactionDir(home, '20260101T000005-aa', 'committed')

  const dropped = pruneTransactions(home, 2)

  assert.deepEqual(dropped, [])
  for (const name of ['20260101T000001-aa', '20260101T000002-aa', '20260101T000003-aa']) {
    assert.equal(fs.existsSync(path.join(txnRoot, name)), true, `${name} 读不出 phase，不该被删`)
  }
  assert.equal(fs.readdirSync(txnRoot).length, 5)
})

test('apply 成功后把事务目录收敛到 keep 上限', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'const VALUE = 2000\n')
  const txnRoot = seedTransactionDirs(home, 12)

  const result = apply(root, home, [
    replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }]),
  ])

  assert.equal(result.ok, true)
  assert.equal(fs.readdirSync(txnRoot).length, 10)
})

test('回退成功后仍能重新应用，清理没有破坏状态链', () => {
  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', 'const VALUE = 2000\n')
  const patches = [replacePatch([{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }])]

  assert.equal(apply(root, home, patches).ok, true)
  assert.equal(revertPatches({ root, home, lock: createLock() }).ok, true)
  assert.equal(read(root, 'a.txt'), 'const VALUE = 2000\n')
  assert.equal(apply(root, home, patches).ok, true)
})

test('自定义声明集：另一档写下的内容不算已应用，按当前档重写', () => {
  const root = tempDir()
  const home = tempDir()
  const pristine = 'head\nA1\ntail\n'
  const diskText = pristine.split('A1').join('A3')
  write(root, 'a.txt', diskText)

  // 声明集是调用方给的，路径 a.txt 不在 PATCHES 里：默认补丁集给不出这条路径的变体，
  // 还原必须用本批声明的两个档位（A2 / A3），否则认不出磁盘上那一版是另一档写的。
  const patches = [{
    id: 'T-A',
    title: '测试补丁',
    kind: 'replace',
    targets: [{
      path: 'a.txt',
      before: 'A1',
      after: 'A2',
      afterByMode: { unrestricted: 'A3' },
      expectHits: 1,
    }],
  }]

  // 旧记录：只有应用后哈希，没有声明指纹。
  const dir = path.join(home, 'breaklimit')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    operationId: 'tx-test',
    phase: 'committed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    files: { 'a.txt': { after: hashText(diskText) } },
  }), 'utf8')

  const result = apply(root, home, patches, {
    // 预哈希必须是原文的，不能按磁盘现状现算：那等于把「磁盘即原文」写进证据。
    hashes: { 'T-A': { 'a.txt': hashText(pristine) } },
  })

  assert.equal(result.ok, true)
  assert.equal(result.findings[0].state, 'needs_reapply')
  assert.equal(result.code, 'applied')
  assert.equal(read(root, 'a.txt'), pristine.split('A1').join('A2'))
})
