// 原子写的 fsync 契约测试（复审 P2-2：此前 fsync 只被顺带执行，没有断言钉住）。
//
// 守三条：临时文件 fsync 先于 rename；rename 后尽力 fsync 目录（Windows 无目录
// 句柄可 fsync，跳过并留注释）；fsync 失败时临时文件清掉、原始错误抛出。
//
// 打桩方式是就地替换 node:fs 的方法（fsx.js 与本测试看同一个模块对象），跑完恢复。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { atomicWrite, atomicWriteBytes } from '../src/patch/fsx.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-fsync-'))
}

function withSpy(t, impl) {
  const events = []
  const originalFsync = fs.fsyncSync
  const originalRename = fs.renameSync
  fs.fsyncSync = (fd) => { events.push('fsync'); return impl?.fsync ? impl.fsync(fd) : originalFsync(fd) }
  fs.renameSync = (from, to) => { events.push('rename'); return originalRename(from, to) }
  t.after(() => {
    fs.fsyncSync = originalFsync
    fs.renameSync = originalRename
  })
  return events
}

test('临时文件 fsync 先于 rename；目录 fsync 在 rename 之后（Windows 跳过）', (t) => {
  const dir = tempDir()
  const events = withSpy(t)
  const file = path.join(dir, 'target.txt')

  atomicWrite(file, '内容')

  assert.equal(fs.readFileSync(file, 'utf8'), '内容')
  const firstFsync = events.indexOf('fsync')
  const rename = events.indexOf('rename')
  assert.ok(firstFsync >= 0, 'fsync 一次都没有调用')
  assert.ok(rename > firstFsync, `fsync 必须先于 rename：${events.join(' → ')}`)
  if (process.platform === 'win32') {
    assert.equal(events.filter(name => name === 'fsync').length, 1, 'Windows 不做目录 fsync')
  } else {
    assert.ok(events.lastIndexOf('fsync') > rename, 'rename 后应再 fsync 目录')
  }
})

test('字节写入走同一套 fsync 顺序', (t) => {
  const dir = tempDir()
  const events = withSpy(t)
  const file = path.join(dir, 'target.bin')

  atomicWriteBytes(file, Buffer.from([1, 2, 3]))

  assert.deepEqual(fs.readFileSync(file), Buffer.from([1, 2, 3]))
  assert.ok(events.indexOf('fsync') < events.indexOf('rename'), events.join(' → '))
})

test('fsync 失败：临时文件清掉、原始错误抛出', (t) => {
  const dir = tempDir()
  const boom = new Error('模拟 fsync 失败')
  withSpy(t, { fsync() { throw boom } })
  const file = path.join(dir, 'target.txt')

  assert.throws(() => atomicWrite(file, '内容'), (error) => error === boom)
  assert.equal(fs.existsSync(file), false, '失败后不应留下目标文件')
  assert.deepEqual(fs.readdirSync(dir), [], '失败后不应留下临时文件')
})
