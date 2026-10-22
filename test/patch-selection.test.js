// 补丁选择状态测试。
//
// 这里守的是「坏配置不许把补丁全关掉」：配置缺失、损坏、字段类型不对、出现未知
// id，四种情况都必须退回安全的一侧。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SELECTION_VERSION, knownPatchIds, readDisabled, resolvePatches, selectionPath, setPatchEnabled, writeDisabled,
} from '../src/patch/patch-selection.js'
import { acquireFileLock, lockFilePath, releaseFileLock } from '../src/patch/lock.js'
import { PATCHES, patchesForMode } from '../src/patch/index.js'

const RECOMMENDED = patchesForMode('recommended')

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-selection-'))
}

function readLockHolder(home) {
  return JSON.parse(fs.readFileSync(lockFilePath(home), 'utf8'))
}

/**
 * 在改名落盘那一刻记录锁的持有者，用来证明「读-改-写」的写发生在锁内。
 * 改名是原子写的最后一步；锁文件本身不经这条路径。
 */
function watchLockAtWrite(home, records) {
  const original = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === selectionPath(home)) records.push(readLockHolder(home))
    return original(from, to)
  }
  return () => { fs.renameSync = original }
}

/** 让下一次向 file 的改名失败一次：模拟临界区中途的写盘故障。 */
function failNextWriteTo(file) {
  const original = fs.renameSync
  fs.renameSync = (from, to) => {
    fs.renameSync = original
    if (to !== file) return original(from, to)
    const error = new Error('模拟写盘失败')
    error.code = 'EIO'
    throw error
  }
  return () => { fs.renameSync = original }
}

function seed(home, content) {
  fs.mkdirSync(path.dirname(selectionPath(home)), { recursive: true })
  fs.writeFileSync(selectionPath(home), content, 'utf8')
}

test('配置缺失时全部启用', () => {
  const home = tempHome()
  const result = readDisabled(home)
  assert.equal(result.kind, 'default')
  assert.deepEqual(result.disabled, [])
  assert.equal(resolvePatches(home).length, RECOMMENDED.length)
})

test('读写往返，且结果总是排序去重', () => {
  const home = tempHome()
  writeDisabled(home, ['web.framing', 'output.trim', 'web.framing'])
  const result = readDisabled(home)
  assert.equal(result.kind, 'ok')
  assert.deepEqual(result.disabled, ['output.trim', 'web.framing'])
  assert.equal(resolvePatches(home).length, RECOMMENDED.length - 2)
})

test('JSON 损坏时退回全部启用', () => {
  const home = tempHome()
  seed(home, '{ this is not json')
  assert.equal(readDisabled(home).kind, 'corrupt')
  assert.deepEqual(readDisabled(home).disabled, [])
  assert.equal(resolvePatches(home).length, RECOMMENDED.length)
})

test('disabled 不是数组时退回全部启用', () => {
  const home = tempHome()
  seed(home, JSON.stringify({ disabled: 'output.trim' }))
  assert.equal(readDisabled(home).kind, 'corrupt')
  assert.deepEqual(readDisabled(home).disabled, [])
})

test('未知 id 与非字符串被丢掉，写回时也不留', () => {
  const home = tempHome()
  seed(home, JSON.stringify({ disabled: ['output.trim', 'P-99', 42, null] }))
  assert.deepEqual(readDisabled(home).disabled, ['output.trim'])
  assert.deepEqual(writeDisabled(home, ['P-99', 'read.limits', 7]).disabled, ['read.limits'])
})

test('全部禁用时返回空集', () => {
  const home = tempHome()
  writeDisabled(home, knownPatchIds())
  assert.equal(resolvePatches(home).length, 0)
})

test('resolvePatches 保持声明顺序', () => {
  const home = tempHome()
  writeDisabled(home, ['output.trim', 'web.framing'])
  const ids = resolvePatches(home).map(patch => patch.id)
  assert.deepEqual(ids, RECOMMENDED.map(patch => patch.id).filter(id => id !== 'output.trim' && id !== 'web.framing'))
})

test('完全解放模式包含只在它存在的补丁', () => {
  const home = tempHome()
  const ids = resolvePatches(home, 'unrestricted').map(patch => patch.id)
  assert.equal(ids.length, PATCHES.length)
  assert.equal(ids.includes('minimal.unfreeze'), true)
  assert.equal(resolvePatches(home, 'recommended').map(patch => patch.id).includes('minimal.unfreeze'), false)
})

test('resolvePatches 按模式给出对应的改后文本', () => {
  const home = tempHome()
  const patch = resolvePatches(home, 'unrestricted').find(item => item.id === 'output.trim')
  assert.match(patch.targets[0].after, /9007199254740991/u)
  const rec = resolvePatches(home, 'recommended').find(item => item.id === 'output.trim')
  assert.match(rec.targets[0].after, /262144/u)
})

test('setPatchEnabled 幂等，并拒绝未知 id', () => {
  const home = tempHome()
  setPatchEnabled(home, 'read.limits', false)
  assert.deepEqual(readDisabled(home).disabled, ['read.limits'])
  setPatchEnabled(home, 'read.limits', false)
  assert.deepEqual(readDisabled(home).disabled, ['read.limits'])
  setPatchEnabled(home, 'read.limits', true)
  assert.deepEqual(readDisabled(home).disabled, [])
  assert.throws(() => setPatchEnabled(home, 'P-99', false), /Unknown patch id/u)
})

test('写出的配置带当前版本号', () => {
  const home = tempHome()
  writeDisabled(home, ['read.limits'])
  const raw = JSON.parse(fs.readFileSync(selectionPath(home), 'utf8'))
  assert.equal(raw.version, SELECTION_VERSION)
  assert.equal(readDisabled(home).kind, 'ok')
})

test('没有版本字段的旧配置按当前版本接受', () => {
  const home = tempHome()
  seed(home, JSON.stringify({ disabled: ['output.trim'] }))
  const result = readDisabled(home)
  assert.equal(result.kind, 'ok')
  assert.deepEqual(result.disabled, ['output.trim'])
})

test('版本不符时退回全部启用，并报 version_mismatch', () => {
  const home = tempHome()
  seed(home, JSON.stringify({ version: SELECTION_VERSION + 1, disabled: ['output.trim'] }))
  const result = readDisabled(home)
  assert.equal(result.kind, 'version_mismatch')
  assert.deepEqual(result.disabled, [])
  assert.equal(resolvePatches(home).length, RECOMMENDED.length)
})

// 以下用例守 setPatchEnabled「读-改-写」的跨进程互斥：锁文件与补丁事务、规则写入同一把。

test('setPatchEnabled：跨进程锁被占用时抛 code locked，禁用集一个不丢', () => {
  const home = tempHome()
  setPatchEnabled(home, 'read.limits', false)
  const before = fs.readFileSync(selectionPath(home), 'utf8')

  const handle = acquireFileLock(home, 'other-op')
  try {
    assert.throws(
      () => setPatchEnabled(home, 'output.trim', false),
      (error) => {
        assert.equal(error.code, 'locked')
        assert.match(error.message, /占用/u)
        return true
      },
    )
    assert.throws(() => setPatchEnabled(home, 'P-99', false), /Unknown patch id/u, '输入错误先于锁判定')
  } finally {
    releaseFileLock(handle)
  }

  assert.equal(fs.readFileSync(selectionPath(home), 'utf8'), before, '锁被占用时一个字节都不动')
  assert.deepEqual(readDisabled(home).disabled, ['read.limits'])
})

test('setPatchEnabled：读改写在锁内完成，切换合并进禁用集', () => {
  const home = tempHome()
  setPatchEnabled(home, 'read.limits', false)

  const records = []
  const restore = watchLockAtWrite(home, records)
  let result
  try {
    result = setPatchEnabled(home, 'output.trim', false)
  } finally {
    restore()
  }

  assert.equal(records.length, 1)
  assert.equal(records[0].pid, process.pid, '写入那一刻锁在本进程手里')
  assert.equal(fs.existsSync(lockFilePath(home)), false, '写完释放')
  assert.deepEqual(result.disabled, ['output.trim', 'read.limits'])
  assert.deepEqual(readDisabled(home).disabled, ['output.trim', 'read.limits'], '两次切换都保住')
})

test('setPatchEnabled：临界区抛错也释放锁，下一次切换立刻成功', () => {
  const home = tempHome()
  setPatchEnabled(home, 'read.limits', false)
  const before = fs.readFileSync(selectionPath(home), 'utf8')

  const restore = failNextWriteTo(selectionPath(home))
  try {
    assert.throws(
      () => setPatchEnabled(home, 'output.trim', false),
      (error) => {
        assert.equal(error.code, 'EIO', '写盘故障保持原有失败形状，不是 locked')
        return true
      },
    )
  } finally {
    restore()
  }

  assert.equal(fs.existsSync(lockFilePath(home)), false, '异常路径不泄漏锁')
  assert.equal(fs.readFileSync(selectionPath(home), 'utf8'), before, '写失败不动已有字段')
  const next = setPatchEnabled(home, 'output.trim', false)
  assert.deepEqual(next.disabled, ['output.trim', 'read.limits'], '不用等、不用清锁，下一次切换直接成功')
})
