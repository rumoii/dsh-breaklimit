// 自定义提示词的读取。超限时报错而不是截断，见 readInject 的说明。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHome } from '../patch/state.js'
import { readTextOrNull } from '../patch/fsx.js'

const DEFAULT_MAX_INJECT_BYTES = 512 * 1024
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_INJECT = path.join(HERE, 'inject.md')

export function userInjectPath(config) {
  const configured = typeof config?.injectFile === 'string' ? config.injectFile.trim() : ''
  return configured || path.join(resolveHome(), 'breaklimit-inject.md')
}

export function maxInjectBytes(config) {
  const configured = config?.maxInjectBytes
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_INJECT_BYTES
}

/**
 * 读注入文件的完整内容。
 *
 * 与旧实现的关键差别：超限时返回错误而不是截断。一份被悄悄砍掉一半的注入
 * 文本会让上层拿着半截指令工作，而使用者以为自己写的东西全部生效了。
 */
export function readInject(config) {
  const limit = maxInjectBytes(config)
  const user = userInjectPath(config)
  let file = user
  let stat
  try {
    stat = fs.statSync(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, code: 'inject_unreadable', message: `注入文件不可读：${file}`, text: '', file, bytes: 0 }
    }
  }
  if (stat === undefined || (stat.isFile() && stat.size === 0)) {
    file = PACKAGE_INJECT
    try {
      stat = fs.statSync(file)
    } catch {
      return { ok: false, code: 'inject_missing', message: `注入文件不可读：${file}`, text: '', file, bytes: 0 }
    }
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'inject_not_file', message: `注入路径不是文件：${file}`, text: '', file, bytes: 0 }
  }
  if (stat.size > limit) {
    return {
      ok: false,
      code: 'inject_too_large',
      message: `注入文件 ${String(stat.size)} 字节，超过上限 ${String(limit)} 字节；未做截断。`,
      text: '',
      file,
      bytes: stat.size,
    }
  }
  const raw = readTextOrNull(file)
  if (raw === null) {
    return { ok: false, code: 'inject_unreadable', message: `注入文件读取失败：${file}`, text: '', file, bytes: stat.size }
  }
  return { ok: true, code: 'ok', message: '', text: raw.trim(), file, bytes: stat.size }
}
