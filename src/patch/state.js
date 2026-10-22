// 状态清单与路径解析。
//
// 清单记在 $DSH_HOME/breaklimit/state.json，记录本次事务的备份目录、每个目标
// 文件的应用前后哈希，以及事务走到哪一步。
//
// 阶段字段是为崩溃恢复准备的：`pending` 表示快照已落盘、目标文件可能只写了一部分；
// `committed` 表示全部写完并复校验通过。进程在写入中途被杀时，磁盘上仍留有一份
// 能说明「快照在哪、目标本该是什么」的记录。
//
// 读取失败不再被压成一个空值。清单损坏与「从未应用过」是两件事：前者意味着恢复
// 信息可能已经不可信，必须让人看见；后者才是正常状态。
//
// 快照与清单分开存放：transactions/<id>/ 保存原文，state.json 只保存指针与哈希。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWrite, decodeUtf8, readBytesStrict } from './fsx.js'

export const STATE_VERSION = 1

/** DSH_HOME，解析规则与宿主自身一致。 */
export function resolveHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

export function breaklimitDir(home) {
  return path.join(home, 'breaklimit')
}

export function statePath(home) {
  return path.join(breaklimitDir(home), 'state.json')
}

export function transactionsDir(home) {
  return path.join(breaklimitDir(home), 'transactions')
}

export function transactionDir(home, id) {
  return path.join(transactionsDir(home), id)
}

/**
 * 读清单。
 *
 * @returns {{ kind: 'ok', state: object }
 *   | { kind: 'absent' }
 *   | { kind: 'corrupt', reason: string }
 *   | { kind: 'version_mismatch', found: unknown, expected: number }}
 *   corrupt 与 version_mismatch 都表示恢复信息不可信：调用方必须停下来报出来，
 *   而不是当成「没有应用记录」继续走。文件存在但读不到也归 corrupt：恢复信息
 *   读不出来与它坏了同样不可信，绝不能当成 absent。
 */
export function readState(home) {
  const raw = readBytesStrict(statePath(home))
  if (raw.kind === 'unreadable') {
    return { kind: 'corrupt', reason: `清单读不到：${String(raw.error?.message ?? raw.error)}` }
  }
  if (raw.kind === 'missing') return { kind: 'absent' }

  let parsed
  try {
    // 严格解码：非 UTF-8 的清单解码成替换字符后可能仍能解析，但那已经不是原数据了。
    const text = decodeUtf8(raw.bytes)
    if (text === null) throw new Error('不是合法 UTF-8')
    parsed = JSON.parse(text)
  } catch (error) {
    return { kind: 'corrupt', reason: `不是合法 JSON：${String(error?.message ?? error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: '顶层不是对象' }
  }
  if (parsed.version !== STATE_VERSION) {
    return { kind: 'version_mismatch', found: parsed.version, expected: STATE_VERSION }
  }
  if (parsed.files === null || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    return { kind: 'corrupt', reason: 'files 不是对象' }
  }
  return { kind: 'ok', state: parsed }
}

export function writeState(home, state) {
  atomicWrite(statePath(home), `${JSON.stringify(state, null, 2)}\n`)
}

/** 删除清单。只删清单，不动快照：回滚能力比目录整洁重要。 */
export function removeState(home) {
  try {
    fs.rmSync(statePath(home), { force: true })
  } catch {
    // 清单不存在即为目标状态。
  }
}
