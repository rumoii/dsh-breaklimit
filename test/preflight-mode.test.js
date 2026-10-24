// 档位切换后的预检判定。
//
// 真实形态：推荐档应用过 cordis preset 的修剪行，切到完全解放后磁盘上仍是本方写的
// 内容，整文件哈希与记录一致——只比哈希永远判「已应用」，预检不报冲突、不回退、
// 不重写，档位停在旧取值上。声明指纹把「谁写的」与「按哪份声明写的」分开。
//
// 全部在临时目录里跑合成文件，不读写真实宿主。声明用真实的那一份：档位差异
// （afterByMode）只存在于真实声明里，自己编一份测不到它。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { hashText } from '../src/patch/fsx.js'
import { PATCHES, patchesForMode, replaceVariantsByPath, resolvedAfter } from '../src/patch/index.js'
import { declarationFingerprint, preflight } from '../src/patch/preflight.js'
import { inspectPatches } from '../src/patch/service.js'

const REASON_OTHER = '已应用的是上一次声明的版本（可能是另一档），需先回退再应用'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-mode-'))
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

/** 按模式解析后的补丁集，等价于 resolvePatches 在没有禁用配置时的产物。 */
function resolvedPatches(mode) {
  return patchesForMode(mode).map(patch => ({
    ...patch,
    targets: patch.targets.map(target => ({ ...target, after: resolvedAfter(target, mode) })),
  }))
}

/** 唯一一条有真实档位差异的补丁：output.trim 的 afterByMode 就是切档对象。 */
function trimCase() {
  const patch = PATCHES.find(item => item.id === 'output.trim')
  const [raw] = patch.targets
  return {
    id: patch.id,
    path: raw.path,
    before: raw.before,
    target: mode => ({ ...raw, after: resolvedAfter(raw, mode) }),
    patch: mode => ({ ...patch, targets: [{ ...raw, after: resolvedAfter(raw, mode) }] }),
  }
}

function writeState(home, files) {
  const dir = path.join(home, 'breaklimit')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    operationId: 'tx-test',
    phase: 'committed',
    transaction: path.join(home, 'breaklimit', 'transactions', 'fixture'),
    updatedAt: '2026-01-01T00:00:00.000Z',
    files,
  }), 'utf8')
}

/**
 * 按模式铺一整份宿主根，每个目标文件都写着自己的原文片段。
 *
 * 合成文件对不上真实 hashes.json，所以未应用的目标一律判冲突——这里要的正是
 * 「冲突与 applied_other 并存」，两个计数必须分得开。
 */
function seedHost(root, mode) {
  const patches = resolvedPatches(mode)
  const pristine = new Map()
  for (const patch of patches) {
    for (const target of patch.targets) {
      pristine.set(target.path, `${pristine.get(target.path) ?? ''}${target.before ?? ''}\n`)
    }
  }
  for (const [rel, text] of pristine) write(root, rel, text)
  return { patches, pristine }
}

test('记录指纹与当前声明一致时判已应用', () => {
  const root = tempDir()
  const trim = trimCase()
  const pristine = `head\n${trim.before}\ntail\n`
  write(root, trim.path, pristine)
  const hashes = { [trim.id]: { [trim.path]: hashText(pristine) } }
  const appliedText = pristine.split(trim.before).join(trim.target('recommended').after)
  write(root, trim.path, appliedText)

  const result = preflight({
    root,
    patches: [trim.patch('recommended')],
    readFile: readOrNull,
    hashes,
    appliedRecords: {
      [trim.path]: {
        after: hashText(appliedText),
        declaration: declarationFingerprint(trim.id, trim.target('recommended')),
      },
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.findings[0].state, 'applied')
  assert.equal(result.changes.size, 0)
})

test('记录指向另一档声明时判 applied_other 并并入阻断', () => {
  const root = tempDir()
  const trim = trimCase()
  const pristine = `head\n${trim.before}\ntail\n`
  write(root, trim.path, pristine)
  const hashes = { [trim.id]: { [trim.path]: hashText(pristine) } }
  // 推荐档应用过：磁盘上是推荐档取值，记录里是推荐档指纹。
  const appliedText = pristine.split(trim.before).join(trim.target('recommended').after)
  write(root, trim.path, appliedText)

  // 当前声明已切到完全解放，afterByMode 给出另一段文本，指纹随之改变。
  const result = preflight({
    root,
    patches: [trim.patch('unrestricted')],
    readFile: readOrNull,
    hashes,
    appliedRecords: {
      [trim.path]: {
        after: hashText(appliedText),
        declaration: declarationFingerprint(trim.id, trim.target('recommended')),
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.findings[0].state, 'applied_other')
  assert.equal(result.findings[0].reason, REASON_OTHER)
  assert.deepEqual(result.blocked, [{ patchId: trim.id, path: trim.path, reason: REASON_OTHER }])
  // 不重写：旧档内容不进入写入集，先回退是人的决定，不是预检的。
  assert.equal(result.changes.size, 0)
})

test('service 把 applied_other 计为阻断，计数与冲突分开', () => {
  const root = tempDir()
  const home = tempDir()
  const { pristine } = seedHost(root, 'unrestricted')
  const trim = trimCase()

  const appliedText = pristine.get(trim.path).split(trim.before).join(trim.target('recommended').after)
  write(root, trim.path, appliedText)
  writeState(home, {
    [trim.path]: {
      before: hashText(pristine.get(trim.path)),
      after: hashText(appliedText),
      declaration: declarationFingerprint(trim.id, trim.target('recommended')),
    },
  })

  const { preflight: pre } = inspectPatches({ root, home, mode: 'unrestricted' })
  const finding = pre.findings.find(item => item.path === trim.path)

  assert.equal(finding.state, 'applied_other')
  assert.equal(pre.ok, false)
  assert.equal(pre.code, 'blocked')
  assert.deepEqual(pre.blocked.find(item => item.path === trim.path), {
    patchId: trim.id,
    path: trim.path,
    reason: REASON_OTHER,
  })
  assert.equal(pre.modeMismatchFiles, 1)
  assert.equal(pre.blockedFiles, pre.blocked.length)
  assert.equal(pre.conflictFiles, pre.blockedFiles - 1)
  assert.equal(pre.pendingFiles, 0)
  assert.match(pre.message, /1 个目标应用的是上一次声明的版本/)
  assert.match(pre.message, /个目标与声明不符（冲突或缺失）/)
})

test('没有应用记录时行为不变：命中数正确判待应用，不符判冲突', () => {
  const root = tempDir()
  const trim = trimCase()
  const pristine = `head\n${trim.before}\ntail\n`
  write(root, trim.path, pristine)

  const pending = preflight({
    root,
    patches: [trim.patch('recommended')],
    readFile: readOrNull,
    hashes: { [trim.id]: { [trim.path]: hashText(pristine) } },
  })
  assert.equal(pending.ok, true)
  assert.equal(pending.findings[0].state, 'pending')
  assert.equal(pending.changes.size, 1)

  // 原文出现两次：命中数守卫判冲突，磁盘不动。
  const doubled = tempDir()
  const twice = `${trim.before}\n${trim.before}\n`
  write(doubled, trim.path, twice)
  const conflict = preflight({
    root: doubled,
    patches: [trim.patch('recommended')],
    readFile: readOrNull,
    hashes: { [trim.id]: { [trim.path]: hashText(twice) } },
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.findings[0].state, 'conflict')
  assert.equal(conflict.changes.size, 0)
})

test('旧调用方只传 appliedHashes 字符串：不抛错，也不再声称已应用', () => {
  const root = tempDir()
  const trim = trimCase()
  const pristine = `head\n${trim.before}\ntail\n`
  write(root, trim.path, pristine)
  // 记录是推荐档写的，当前声明在完全解放档：只有字符串哈希、又没有全档变体，
  // 还原不出声明的原文，也就无从判断按哪份声明写的。判据不成立时宁可阻断，
  // 不拿「正向改写恰好没改动任何字节」当已应用的证据。
  const appliedText = pristine.split(trim.before).join(trim.target('recommended').after)
  write(root, trim.path, appliedText)

  const result = preflight({
    root,
    patches: [trim.patch('unrestricted')],
    readFile: readOrNull,
    hashes: { [trim.id]: { [trim.path]: hashText(pristine) } },
    appliedHashes: { [trim.path]: hashText(appliedText) },
  })

  assert.equal(result.findings[0].state, 'conflict')
  assert.equal(result.ok, false)
  assert.equal(result.changes.size, 0)
  assert.equal(result.blocked.length, 1)
})

test('记录缺声明指纹（旧记录）且档位已切：判 needs_reapply，不谎报已应用', () => {
  const root = tempDir()
  const trim = trimCase()
  const pristine = `head\n${trim.before}\ntail\n`
  write(root, trim.path, pristine)
  const appliedText = pristine.split(trim.before).join(trim.target('recommended').after)
  write(root, trim.path, appliedText)

  const result = preflight({
    root,
    patches: [trim.patch('unrestricted')],
    readFile: readOrNull,
    hashes: { [trim.id]: { [trim.path]: hashText(pristine) } },
    appliedRecords: { [trim.path]: { after: hashText(appliedText) } },
    // 真实调用方（service / transaction）都会传全档变体；缺了它就无法还原另一档
    // 写下的内容，判定会退回「只要记录哈希等于磁盘就放过」的旧行为。
    variantsByPath: replaceVariantsByPath(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.findings[0].state, 'needs_reapply')
  assert.equal(result.changes.size, 1)
  assert.equal(result.changes.get(trim.path).after, pristine.split(trim.before).join(trim.target('unrestricted').after))
})

test('真实宿主的记录形状（只有 before/after）在推荐档下全部判已应用', () => {
  const root = tempDir()
  const home = tempDir()
  const { patches, pristine } = seedHost(root, 'recommended')

  // 逐目标应用，顺序与 apply 一致；之后按整文件现状写记录，与真实 state.json 同形。
  for (const patch of patches) {
    for (const target of patch.targets) {
      const base = read(root, target.path)
      write(root, target.path, base.split(target.before).join(target.after))
    }
  }
  const files = {}
  for (const [rel, text] of pristine) {
    files[rel] = { before: hashText(text), after: hashText(read(root, rel)) }
  }
  writeState(home, files)

  // 预哈希必须与自己铺的这份合成宿主对得上：真实 hashes.json 记的是宿主原文的哈希，
  // 拿它去判合成文本，旧记录那条判据永远还原不出声明的原文。
  const hashes = {}
  for (const patch of patches) {
    hashes[patch.id] = {}
    for (const target of patch.targets) hashes[patch.id][target.path] = hashText(pristine.get(target.path))
  }

  const { preflight: pre } = inspectPatches({ root, home, mode: 'recommended', hashes })

  assert.equal(pre.ok, true)
  assert.equal(pre.code, 'ok')
  assert.equal(pre.modeMismatchFiles, 0)
  assert.equal(pre.blockedFiles, 0)
  assert.equal(pre.pendingFiles, 0)
  assert.deepEqual([...new Set(pre.findings.map(item => item.state))], ['applied'])
  assert.equal(Object.keys(files).length, new Set(patches.flatMap(item => item.targets.map(target => target.path))).size)
  assert.equal(pre.findings.length, patches.reduce((sum, item) => sum + item.targets.length, 0))
})
