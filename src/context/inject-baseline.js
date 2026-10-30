// 自定义正文的基线记录。
//
// 保存自定义正文时，把「当时内置正文的指纹」一并记下来。之后插件升级换了内置正文，
// 用户那份仍是旧的：装配照旧用用户的（用户写的东西归用户），但状态与提示词页要把
// 这件事说出来。只告警，不自动迁移——合并等于替用户改写他写下的字。
//
// 记录与正文分开存：正文是用户内容，基线是插件元数据，读写寿命与备份策略都不同。
// 文件放在 $DSH_HOME/breaklimit/inject-baseline.json。
//
// 缺记录不等于陈旧。0.9.5 之前保存的正文没有基线，判不了新旧，一律报 unknown，
// 不猜。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { breaklimitDir } from '../patch/state.js'
import { atomicWrite, decodeUtf8, hashBytes, readBytesStrict } from '../patch/fsx.js'
import { PACKAGE_INJECT_PATH } from './inject-file.js'

const PACKAGE_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')

export const BASELINE_FILE = 'inject-baseline.json'
const BASELINE_VERSION = 1

export function baselinePath(home) {
  return path.join(breaklimitDir(home), BASELINE_FILE)
}

/** 插件版本；读不到给 null，不阻断任何判定。 */
function packageVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * 当前内置正文的指纹。
 *
 * 读不到时返回 null：没有指纹就判不出新旧，调用方必须报 unknown 而不是 stale。
 * @returns {{ hash: string, bytes: number, plugin: string|null } | null}
 */
export function builtinFingerprint(readFile = fs.readFileSync) {
  let bytes
  try {
    bytes = readFile(PACKAGE_INJECT_PATH)
  } catch {
    return null
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
  return { hash: hashBytes(buffer), bytes: buffer.length, plugin: packageVersion() }
}

/**
 * 读基线记录。损坏与缺失分开报：前者说明记录被动过，后者只是老版本保存的正文。
 * @returns {{ kind: 'ok', saved: { hash: string, bytes: number, plugin: string|null, savedAt: string|null } }
 *   | { kind: 'absent' } | { kind: 'corrupt', reason: string }}
 */
export function readBaseline(home) {
  const read = readBytesStrict(baselinePath(home))
  if (read.kind === 'missing') return { kind: 'absent' }
  if (read.kind === 'unreadable') return { kind: 'corrupt', reason: '基线记录读不到' }
  const text = decodeUtf8(read.bytes)
  if (text === null) return { kind: 'corrupt', reason: '基线记录不是合法 UTF-8' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'corrupt', reason: '基线记录不是合法 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: '基线记录顶层不是对象' }
  }
  if (parsed.version !== BASELINE_VERSION) {
    return { kind: 'corrupt', reason: `基线记录版本是 ${String(parsed.version)}，期望 ${String(BASELINE_VERSION)}` }
  }
  const builtin = parsed.builtin
  if (builtin === null || typeof builtin !== 'object' || Array.isArray(builtin)
    || typeof builtin.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(builtin.hash)
    || !Number.isInteger(builtin.bytes) || builtin.bytes < 0) {
    return { kind: 'corrupt', reason: '基线记录的 builtin 字段无效' }
  }
  return {
    kind: 'ok',
    saved: {
      hash: builtin.hash,
      bytes: builtin.bytes,
      plugin: typeof builtin.plugin === 'string' ? builtin.plugin : null,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    },
  }
}

/**
 * 写基线记录。调用方在正文写成功之后调用；失败向上抛，由调用方决定怎么报。
 * @param {string} home - $DSH_HOME。
 * @param {{ hash: string, bytes: number, plugin: string|null }} builtin - `builtinFingerprint()` 的结果。
 */
export function writeBaseline(home, builtin) {
  const payload = {
    version: BASELINE_VERSION,
    builtin: { hash: builtin.hash, bytes: builtin.bytes, plugin: builtin.plugin ?? null },
    savedAt: new Date().toISOString(),
  }
  atomicWrite(baselinePath(home), `${JSON.stringify(payload, null, 2)}\n`)
}

/** 删除基线记录。没有记录也算成功；删除失败不抛——正文已回到内置，陈旧判定用不上它。 */
export function removeBaseline(home) {
  try {
    fs.rmSync(baselinePath(home), { force: true })
  } catch {
    // 删不掉时留下的记录只在用户再次保存正文时被覆盖，不影响装配路径。
  }
}

/**
 * 判定自定义正文相对当前内置正文的新旧。
 *
 * @param {string} home - $DSH_HOME。
 * @param {{ active: boolean }} options - `active` 表示用户文件确实在替换内置正文
 *   （存在且非空）；不在替换时没有陈旧可言。
 * @returns {{ state: 'absent'|'current'|'stale'|'unknown', reason: string|null,
 *   saved: object|null, builtin: { bytes: number, plugin: string|null }|null }}
 */
export function baselineState(home, options = {}) {
  const builtin = builtinFingerprint()
  const builtinView = builtin === null ? null : { bytes: builtin.bytes, plugin: builtin.plugin }
  if (options.active !== true) {
    return { state: 'absent', reason: null, saved: null, builtin: builtinView }
  }
  const read = readBaseline(home)
  if (read.kind === 'absent') {
    return { state: 'unknown', reason: 'no_baseline', saved: null, builtin: builtinView }
  }
  if (read.kind === 'corrupt') {
    return { state: 'unknown', reason: read.reason, saved: null, builtin: builtinView }
  }
  if (builtin === null) {
    return { state: 'unknown', reason: 'builtin_unreadable', saved: read.saved, builtin: null }
  }
  return {
    state: read.saved.hash === builtin.hash ? 'current' : 'stale',
    reason: null,
    saved: read.saved,
    builtin: builtinView,
  }
}
