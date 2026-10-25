// 目标词表：请求交付给模型之前，把真实目标名换成占位名。
//
// 为什么需要它：模型对真实站点名有一层训练出来的拒答倾向，与提示词写得多硬无关。
// 换成占位名之后，那层倾向没有触发点，提示词里的规则才真正生效。
//
// 边界：
//   1. 只做精确字面替换，不做正则、不做模糊匹配。宁可漏替换，也不误伤正常的活。
//   2. 长词优先。词表里同时有「百度」和「百度贴吧」时，先替换长的那个。
//   3. 存储与索引分开是过度设计——词表很小，一个文件装得下。
import path from 'node:path'
import { breaklimitDir } from '../patch/state.js'
import { atomicWrite, decodeUtf8, readBytesStrict } from '../patch/fsx.js'

export const MASKS_FILE = 'masks.json'
export const MAX_MASKS = 100
export const MAX_MASK_TERM = 64

/** 词表文件路径。 */
export function masksPath(home) {
  return path.join(breaklimitDir(home), MASKS_FILE)
}

/** 一条映射是否可用。空白、超长、自映射都算不可用。 */
export function validEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false
  const { from, to } = entry
  if (typeof from !== 'string' || typeof to !== 'string') return false
  const source = from.trim()
  const target = to.trim()
  if (source === '' || target === '') return false
  if (source.length > MAX_MASK_TERM || target.length > MAX_MASK_TERM) return false
  if (source === target) return false
  return true
}

/** 规范化：去空白、丢无效项、按 from 去重（后者覆盖前者）。 */
export function normalizeEntries(entries) {
  const out = []
  const seen = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!validEntry(entry)) continue
    const item = { from: entry.from.trim(), to: entry.to.trim() }
    const at = seen.get(item.from)
    if (at === undefined) {
      seen.set(item.from, out.length)
      out.push(item)
    } else {
      out[at] = item
    }
  }
  return out.slice(0, MAX_MASKS)
}

/**
 * 读词表。
 *
 * @returns {{ entries: Array<{from: string, to: string}>, error: string | null }}
 *   文件不存在是正常状态，不是错误。
 */
export function readMasks(home, runtime) {
  const file = masksPath(home)
  const read = readBytesStrict(file)
  let result
  let trusted = false
  if (read.kind === 'missing') {
    result = { entries: [], error: null }
    trusted = true
  } else if (read.kind === 'unreadable') result = { entries: [], error: '词表文件读不到，未按空表处理。' }
  else {
    try {
      const parsed = JSON.parse(decodeUtf8(read.bytes))
      const raw = Array.isArray(parsed) ? parsed : parsed?.entries
      if (!Array.isArray(raw) || raw.length > MAX_MASKS) throw new Error('invalid entries')
      const entries = normalizeEntries(raw)
      const invalid = raw.some(entry => !validEntry(entry))
      if (raw.length > 0 && entries.length === 0) {
        result = { entries: [], error: '词表词条全部无效，未按空表处理。' }
      } else {
        result = invalid
          ? { entries, error: '部分词条无效，已忽略并继续使用合法词条。', unavailable: false }
          : { entries, error: null }
        trusted = true
      }
    } catch {
      result = { entries: [], error: '词表文件不是合法 JSON 或结构无效，未按空表处理。' }
    }
  }
  if (trusted) {
    if (runtime) runtime.maskSnapshot = { file, entries: result.entries }
    return result
  }
  const cached = runtime?.maskSnapshot
  return cached?.file === file
    ? { ...result, entries: cached.entries, source: 'cached', unavailable: false }
    : { ...result, source: 'unavailable', unavailable: true }
}

/** 写词表。返回结构化结果，不吞失败。 */
export function writeMasks(home, entries) {
  const list = normalizeEntries(entries)
  const body = JSON.stringify({ version: 1, entries: list }, null, 2) + '\n'
  try {
    atomicWrite(masksPath(home), body)
    return { ok: true, entries: list, error: null }
  } catch (error) {
    return { ok: false, entries: [], error: String(error?.message ?? error) }
  }
}

/**
 * 按词表替换一段文本。
 *
 * @returns {{ text: string, hits: number, matched: string[] }}
 *   matched 只回原词，不回替换结果——调用方需要知道「命中了哪几条」，
 *   不需要再拼一次。
 */
export function maskText(text, entries) {
  if (typeof text !== 'string' || text === '') return { text, hits: 0, matched: [] }
  const list = normalizeEntries(entries)
  if (list.length === 0) return { text, hits: 0, matched: [] }
  // 长词优先，否则「百度」会先把「百度贴吧」切碎。
  const ordered = [...list].sort((a, b) => b.from.length - a.from.length)
  let out = text
  let hits = 0
  const matched = []
  for (const entry of ordered) {
    if (!out.includes(entry.from)) continue
    const before = out
    out = out.split(entry.from).join(entry.to)
    if (out === before) continue
    hits += 1
    matched.push(entry.from)
  }
  return { text: out, hits, matched }
}
