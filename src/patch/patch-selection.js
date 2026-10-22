// 补丁的选择状态：哪些补丁参与预检与应用。
//
// 配置存在 $DSH_HOME/breaklimit/patches.json，记的是「禁用集」而不是「启用集」——
// 这样将来新增的补丁默认就是启用的，不必回头改配置。
//
// 容错口径与 readTier 一致：配置缺失、损坏、字段类型不对一律退回「全部启用」，
// 绝不因为一个坏配置文件就把所有补丁关掉。

import path from 'node:path'
import process from 'node:process'

import { PATCHES, normalizePatchMode, patchesForMode, resolvedAfter } from './index.js'
import { atomicWrite, readTextOrNull } from './fsx.js'
import { acquireFileLock, releaseFileLock } from './lock.js'
import { breaklimitDir } from './state.js'

/**
 * 选择配置的格式版本。
 *
 * 与 state.json 的策略有意不同：state.json 存的是崩溃恢复信息，版本不符意味着
 * 恢复信息不可信，必须让调用方停下来报错；这里存的是偏好，版本不符只退回默认
 * 并让人看见，不该因此让插件不可用。
 */
export const SELECTION_VERSION = 1

/** 声明里存在的全部补丁 id。 */
export function knownPatchIds() {
  return PATCHES.map(patch => patch.id)
}

/** 选择配置的文件路径。 */
export function selectionPath(home) {
  return path.join(breaklimitDir(home), 'patches.json')
}

/**
 * 读取禁用集。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @returns {{ kind: 'ok' | 'default' | 'corrupt', disabled: string[] }}
 */
export function readDisabled(home) {
  const raw = readTextOrNull(selectionPath(home))
  if (raw === null) return { kind: 'default', disabled: [] }

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'corrupt', disabled: [] }
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.disabled)) {
    return { kind: 'corrupt', disabled: [] }
  }
  // 版本判定排在这里，而不是最前面：字段缺失要视为当前版本——加这个字段之前
  // 写出的文件就是同一格式，先比版本会把它们全部判成不匹配。
  if (parsed.version !== undefined && parsed.version !== SELECTION_VERSION) {
    return { kind: 'version_mismatch', disabled: [] }
  }

  // 未知 id 直接丢掉：它可能来自旧版本或被手工改过，留着只会让过滤变成猜测。
  const known = new Set(knownPatchIds())
  const disabled = [...new Set(parsed.disabled.filter(id => typeof id === 'string' && known.has(id)))].sort()
  return { kind: 'ok', disabled }
}

/**
 * 写入禁用集，只保留已知 id。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {string[]} ids - 期望禁用的补丁 id。
 * @returns {{ disabled: string[] }}
 */
export function writeDisabled(home, ids) {
  const known = new Set(knownPatchIds())
  const filtered = Array.isArray(ids) ? ids : []
  const disabled = [...new Set(filtered.filter(id => typeof id === 'string' && known.has(id)))].sort()
  const payload = { version: SELECTION_VERSION, disabled, updatedAt: new Date().toISOString() }
  atomicWrite(selectionPath(home), `${JSON.stringify(payload, null, 2)}\n`)
  return { disabled }
}

/**
 * 按配置过滤补丁，顺序与声明一致。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @returns {ReadonlyArray<object>}
 */
export function resolvePatches(home, mode = 'recommended') {
  const active = normalizePatchMode(mode)
  const { disabled } = readDisabled(home)
  const skip = new Set(disabled)
  return patchesForMode(active)
    .filter(patch => !skip.has(patch.id))
    .map(patch => ({
      ...patch,
      targets: patch.targets.map(target => ({ ...target, after: resolvedAfter(target, active) })),
    }))
}

/**
 * 切换一条补丁的启用状态。
 *
 * 读-改-写在跨进程锁内完成：多个进程共享同一 $DSH_HOME 时不会互相覆盖禁用集。
 * 锁被占用时抛 code 为 'locked' 的错误，不动文件。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {string} id - 补丁 id，必须是声明里存在的。
 * @param {boolean} enabled - 目标状态。
 * @returns {{ disabled: string[] }} 切换后的完整禁用集。
 */
export function setPatchEnabled(home, id, enabled) {
  if (!knownPatchIds().includes(id)) {
    throw new Error(`Unknown patch id: \`${String(id)}\``)
  }
  return withSelectionLock(home, () => {
    const { disabled } = readDisabled(home)
    const next = new Set(disabled)
    if (enabled) next.delete(id)
    else next.add(id)
    return writeDisabled(home, [...next])
  })
}

// 写入锁的事务 id 计数：同一进程里多个入口各自拿各自的 id。
let lockSequence = 0

/** 锁被占用时的结构化失败。本域的失败通道就是抛错，code 供调用方分支。 */
function lockBusyError(conflict) {
  const holder = conflict?.holder ?? null
  const who = holder === null
    ? '另一个操作'
    : `另一个操作（${String(holder.operationId ?? '未知事务')}，pid ${String(holder.pid ?? '未知')}）`
  const error = new Error(`补丁选择正在被${who}占用，本次写入已取消`)
  error.code = 'locked'
  error.lockPath = conflict?.path
  return error
}

/**
 * 在跨进程锁内跑一段同步的「读-改-写」临界区。
 *
 * 锁文件与补丁事务、规则写入共用 `$DSH_HOME/breaklimit/operation.lock`：改的都是
 * 同一个 DSH_HOME，互相排斥本来就是对的。锁被占用时立即抛 code 为 'locked' 的
 * 错误，不排队。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {() => object} run - 同步临界区。
 */
function withSelectionLock(home, run) {
  lockSequence += 1
  const operationId = `selection-toggle-${process.pid.toString(36)}-${String(lockSequence)}`
  // acquireFileLock 抛出时没有本次建出的东西可清（lock.js 自己收干净）；
  // run 抛出时 finally 保证释放。
  const handle = acquireFileLock(home, operationId)
  if (handle.conflict !== undefined) throw lockBusyError(handle.conflict)
  try {
    return run()
  } finally {
    releaseFileLock(handle)
  }
}
