// 模式与附加段、尾巴的读取。
//
// 模式本身由 tiers 决定；这里只负责把该模式的附加文件与两档共用的尾巴读出来。
// 读不到就返回空串：附加段缺失不该让装配失败，最坏是少一段话。
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readTextOrNull } from '../patch/fsx.js'
import { DEFAULT_TIER, TIERS, readTier, tierConfigPath } from './tiers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const EXTENSIONS = Object.freeze({
  recommended: 'recommended.md',
  unrestricted: 'unrestricted.md',
})

/** 把已读出的值收敛成合法模式。只用于手上有值的情况。 */
export function promptMode(mode) {
  return TIERS.includes(mode) ? mode : DEFAULT_TIER
}

/**
 * 从磁盘读出当前模式。所有"当前用的是哪一档"的调用点都应该用它，
 * 而不是把 home 路径交给 promptMode——那会恒回落默认档。
 */
export function readMode(home, runtime) {
  const result = readTier(home, runtime)
  if (result.source === 'unavailable') {
    const file = tierConfigPath(home)
    const error = new Error(`档位配置不可用，已暂停操作；请修复 ${file}，或运行 breaklimit --tier recommended 后重试。`)
    error.code = 'tier_config_unavailable'
    throw error
  }
  return promptMode(result.tier)
}

/** 读该模式的附加段。 */
export function readModeExtension(mode) {
  const file = EXTENSIONS[promptMode(mode)]
  return readTextOrNull(path.join(HERE, file)) ?? ''
}

/** 读两档共用的尾巴。 */
export function readTail() {
  return readTextOrNull(path.join(HERE, 'tail.md')) ?? ''
}
