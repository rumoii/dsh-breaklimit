// 文件系统基础工具：内容哈希与原子写入。
//
// 原子写入用同目录临时文件加改名。改名在同一文件系统上是原子的，所以任何
// 时刻读到的要么是完整旧内容，要么是完整新内容——不会出现被截断的目标文件。
// 直接覆写会留下一个中间态窗口，而写坏的正是一个正在被宿主加载的文件。
// 断电下要守住同样的承诺，光有改名不够：临时文件写完先 fsync 再改名，改名后
// 尽力 fsync 目录（POSIX）；Windows 没有可 fsync 的目录句柄，跳过目录这一步，
// 改名本身的持久性由 NTFS 日志与同卷改名语义兜底。
//
// 读取分两档：`readTextOrNull` 把一切读失败压成 null，只给「读不到就没有」安全的
// 展示场景用；`readBytesStrict` 区分「文件不存在」与「存在但读不到」，凡是要据读取
// 结果做写入决策的地方必须用后者——把读失败当成不存在，正是「当成空清单整表替换、
// 当成新文件不留快照」这类数据丢失的共同起点。落点与快照一律按字节处理：文本解码
// 会把非 UTF-8 字节替换成 U+FFFD，用解码结果写回就会毁掉原文。

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 内容的 sha256 摘要。用于状态清单里的前后哈希比对。 */
export function hashText(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** 原始字节的 sha256 摘要。与 hashText 同格式：同一内容的两种表示给出同一个值。 */
export function hashBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function writeAtomic(file, content) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(file)}.bkl-${process.pid.toString(36)}-${Date.now().toString(36)}.tmp`)
  try {
    fs.writeFileSync(temp, content)
    // 改名只保证目录项切换是原子的，不保证内容已经落盘：断电时新名字可能指向
    // 一个没写完的文件。临时文件写完先 fsync 再改名，「要么完整落盘要么完全
    // 不存在」才在断电下也成立。
    fsyncFile(temp)
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // 清理失败不影响原始错误：原始错误才是调用方需要看到的那一个。
    }
    throw error
  }
  // 改名本身也要落盘才算数。这一步发生在改名成功之后，失败不影响已完成的写入，
  // 不重新抛出。
  fsyncDirBestEffort(dir)
}

/** fsync 单个文件，让写入的内容在改名前落盘。失败向上抛，由调用方清临时文件。 */
function fsyncFile(file) {
  // 句柄必须可写：Windows 对只读句柄的 fsync 报 EPERM，刚写完的临时文件用 r+ 打开。
  const fd = fs.openSync(file, 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // 关不掉句柄不改变「内容已经 fsync」这件事，也不该盖掉更早的错误。
    }
  }
}

/**
 * 目录 fsync，尽力而为：失败不抛。POSIX 上能拿目录句柄就做；Windows 打不开
 * 目录句柄（fs.openSync 对目录报 EPERM/EISDIR），跳过，改名的持久性由 NTFS
 * 日志与同卷改名语义兜底。
 */
function fsyncDirBestEffort(dir) {
  if (process.platform === 'win32') return
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // 尽力而为：拿不到目录句柄或文件系统不支持时跳过。
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // 清理失败不影响已落盘的内容。
      }
    }
  }
}

/**
 * 原子写入文本（utf8）。临时文件与目标同目录，保证改名不跨设备。
 * @param {string} file - 目标绝对路径。
 * @param {string} content - 完整内容。
 */
export function atomicWrite(file, content) {
  writeAtomic(file, content)
}

/**
 * 原子写入原始字节。落点与落点快照用它：写什么字节就是什么字节，不经文本编码。
 * @param {string} file - 目标绝对路径。
 * @param {Buffer} bytes - 完整内容。
 */
export function atomicWriteBytes(file, bytes) {
  writeAtomic(file, bytes)
}

/**
 * 严格读取原始字节，区分「不存在」与「读不到」。
 * @returns {{ kind: 'ok', bytes: Buffer, error: null }
 *   | { kind: 'missing', bytes: null, error: null }
 *   | { kind: 'unreadable', bytes: null, error: Error }}
 */
export function readBytesStrict(file) {
  try {
    return { kind: 'ok', bytes: fs.readFileSync(file), error: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', bytes: null, error: null }
    return { kind: 'unreadable', bytes: null, error }
  }
}

/**
 * 严格按 UTF-8 解码。解码失败返回 null，不返回带 U+FFFD 的替换文本——
 * 替换文本一旦被写回，原字节就没了。
 * @param {Buffer} bytes
 * @returns {string | null}
 */
export function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** 读文本，不存在或不可读时返回 null，让调用方区分"空文件"与"没有文件"。 */
export function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 文件大小，不存在时为 0。 */
export function sizeOf(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

/** 目录是否存在。 */
export function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
