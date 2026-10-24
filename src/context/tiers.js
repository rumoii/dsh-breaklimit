// 提示词模式。
//
// 只有两档：recommended（推荐）与 unrestricted（完全解放）。正文由三部分拼成：
//   inject.md          两档共用的正文（用户可覆盖）
//   recommended.md / unrestricted.md  各自的附加段
//   tail.md            两档共用的尾部（序号由 config.order 决定，默认 8999）
//
// 档位配置保存在 $DSH_HOME/breaklimit/tier.json；旧值 lean / architect / autonomous
// 判为非法；无可信快照时暂停受影响操作，不迁移、不猜测。

import path from 'node:path'
import { breaklimitDir } from '../patch/state.js'
import { atomicWrite, decodeUtf8, readBytesStrict } from '../patch/fsx.js'

export const TIERS = Object.freeze(['recommended', 'unrestricted'])
export const DEFAULT_TIER = 'recommended'

export function tierConfigPath(home) {
  return path.join(breaklimitDir(home), 'tier.json')
}

export function isValidTier(tier) {
  return typeof tier === 'string' && TIERS.includes(tier)
}

/**
 * 读取当前模式。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @returns {{ kind: 'ok' | 'default' | 'corrupt' | 'unreadable', tier: string, raw?: string }}
 */
export function readTier(home, runtime) {
  const file = tierConfigPath(home)
  const read = readBytesStrict(file)
  let result
  if (read.kind === 'missing') result = { kind: 'default', tier: DEFAULT_TIER }
  else if (read.kind === 'unreadable') result = { kind: 'unreadable', tier: DEFAULT_TIER }
  else {
    const raw = decodeUtf8(read.bytes)
    try {
      const parsed = JSON.parse(raw)
      result = isValidTier(parsed?.tier)
        ? { kind: 'ok', tier: parsed.tier }
        : { kind: 'corrupt', tier: DEFAULT_TIER, raw }
    } catch {
      result = { kind: 'corrupt', tier: DEFAULT_TIER, raw }
    }
  }
  if (result.kind === 'ok' || result.kind === 'default') {
    if (runtime) runtime.tierSnapshot = { file, tier: result.tier }
    return result
  }
  const cached = runtime?.tierSnapshot
  return { ...result, tier: cached?.file === file ? cached.tier : DEFAULT_TIER,
    source: cached?.file === file ? 'cached' : 'unavailable',
    error: 'tier_config_unavailable' }
}

/**
 * 设置并持久化当前模式。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {string} tier - 目标模式。
 * @returns {{ ok: boolean, tier: string }}
 */
export function writeTier(home, tier) {
  if (!isValidTier(tier)) {
    throw new Error(`Invalid tier: \`${String(tier)}\`. Allowed: ${TIERS.join(', ')}`)
  }
  const filePath = tierConfigPath(home)
  const payload = {
    tier,
    updatedAt: new Date().toISOString(),
  }
  atomicWrite(filePath, `${JSON.stringify(payload, null, 2)}\n`)
  return { ok: true, tier }
}

/**
 * 拼装某一档的头部正文：共用正文 + 该档附加段。
 *
 * @param {string} tier - 选定模式。
 * @param {string} baseText - inject.md 的正文。
 * @param {string} extensionText - recommended.md 或 unrestricted.md 的正文。
 * @returns {string} 实际生效的头部文本。
 */
export function buildTierPrompt(tier, baseText = '', extensionText = '') {
  const base = typeof baseText === 'string' ? baseText : ''
  const extension = typeof extensionText === 'string' ? extensionText : ''
  if (base === '') return extension
  if (extension === '') return base
  return `${base}\n\n${extension}`
}

/**
 * 解析并生成当前模式的完整信息。
 *
 * kind 与 source 一并带出；source=unavailable 时候选文本不代表已生效，
 * 运行路径必须通过 readMode 的可信配置判定。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {string} baseText - 共用正文。
 * @param {string} extensionText - 该档附加段。
 * @returns {{ kind: 'ok' | 'default' | 'corrupt' | 'unreadable', tier: string, text: string, bytes: number, available: readonly string[] }}
 */
export function resolveTierInfo(home, baseText = '', extensionText = '', runtime) {
  const { kind, tier, source, error } = readTier(home, runtime)
  const text = buildTierPrompt(tier, baseText, extensionText)
  const bytes = Buffer.byteLength(text, 'utf8')
  return {
    kind,
    source,
    error,
    tier,
    text,
    bytes,
    available: TIERS,
  }
}
