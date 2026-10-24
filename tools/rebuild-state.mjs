// 从既有证据重建状态清单。
//
// 用途：应用记录丢失或写坏之后，把「宿主上确实躺着本方写入的内容」这件事重新记下来，
// 好让预检认得出、revert 还退得回去。没有这一步，一棵已应用的树两头堵死：apply 被
// 「整文件预哈希不符」整批阻断，revert 因为没有记录直接报未应用。
//
// 原文有两个来源，按顺序取：
//   1. 事务目录里的快照。它本来就是应用前的原文。
//   2. git HEAD。记录连同快照一起没了时，HEAD 仍是那份原文——但不能默认它就是，
//      更不能只凭「盘上内容与 HEAD 不一样」就断言差异是本方写的。
//
// 两个来源都要过同样三道判据，缺一不可：
//   - 声明的预哈希承认这份原文：hashText(原文) === hashes.json[patchId][path]；
//   - 盘上内容确实是本方写的：把它按全部档位的变体还原后逐字节等于原文；
//   - 盘上内容与原文不同：这份改动确实落过盘。
// 为了让数字好看而放宽任何一条，都会做出一个 revert 时兑现不了的承诺——记录里的
// before 就是回退时要写进宿主的字节，它必须真的是声明的那一版原文，不能是猜的。
//
// git 来源另加一条：哈希表记录的宿主 commit 必须等于当前 HEAD。哈希表采自另一棵树时，
// 逐文件哈希偶然相符也不能当证据。
//
// 只写 $DSH_HOME/breaklimit/ 下的内容：新建一个合并事务目录与一份新清单，覆盖清单前
// 先备份成 state.json.bak-<时间戳>，已有备份永不覆盖。一个文件都没采纳时拒绝写清单：
// 那等于把「没有任何补丁」记成事实，已应用的宿主补丁从此退不回去。
// 宿主源码一个字节都不改，旧事务目录一个都不删。
//
// 用法: node tools/rebuild-state.mjs <宿主根>

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { hashText, readTextOrNull, atomicWrite } from '../src/patch/fsx.js'
import { STATE_VERSION, resolveHome, statePath, transactionDir, transactionsDir, writeState } from '../src/patch/state.js'
import { revertSnippets } from '../src/patch/preflight.js'
import { DSH_TARGET, PATCHES, replaceVariantsByPath } from '../src/patch/index.js'
import { loadPatchHashes } from '../src/patch/hashes.js'
import { acquireFileLock, releaseFileLock } from '../src/patch/lock.js'

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HASHES_FILE = path.join(PACKAGE_ROOT, 'src', 'patch', 'hashes.json')

/** 哈希表清单（不只是 files 表）：git 来源要用它记录的 commit 做一致性判定。 */
function loadManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HASHES_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 单个目标的采纳判定。纯函数：不读盘、不写盘、不调 git。
 *
 * @param {object} input
 * @param {string | null} input.head - 宿主 HEAD 里的原文；HEAD 里没有这个文件时为 null。
 * @param {string | null} input.current - 宿主机上的当前内容。
 * @param {{ text: string, from: string } | null} input.snapshot - 事务目录里找到的快照及其目录名。
 * @param {string | undefined} input.declaredHash - 声明的前置哈希。
 * @param {string} input.headCommit - 宿主 HEAD 提交号。
 * @param {string | undefined} input.manifestCommit - 哈希表采集时的宿主提交号。
 * @param {Array<{ before?: string, after?: string }>} input.variants - 该路径下全部档位的 replace 变体。
 * @returns {{ accepted: true, source: 'snapshot' | 'head', before: string, after: string, snapshot: string }
 *   | { accepted: false, reason: string }}
 */
export function judgeAdoption({ head, current, snapshot, declaredHash, headCommit, manifestCommit, variants }) {
  if (head === null || head === undefined) return { accepted: false, reason: '宿主 HEAD 里没有这个文件' }
  if (current === null || current === undefined) return { accepted: false, reason: '宿主机上没有这个文件' }
  if (current === head) return { accepted: false, reason: '宿主内容与原始版本相同，这份改动不在' }

  if (snapshot !== null && snapshot !== undefined && snapshot.text !== head) {
    return { accepted: false, reason: `最新快照（${snapshot.from}）不是声明的原始版本` }
  }

  // 盘上内容必须是「原文只按本方声明换过那几段」。少一个字节没换、多一处别人的改动，
  // 还原结果都不会等于原文，这条自然就挡住了。
  if (revertSnippets(current, variants) !== head) {
    return { accepted: false, reason: '宿主内容不是「原文只按本方声明改过那几段」，还含有其他改动' }
  }

  if (declaredHash === undefined) return { accepted: false, reason: '该目标没有预哈希记录' }
  if (hashText(head) !== declaredHash) {
    return { accepted: false, reason: '声明的预哈希与 HEAD 内容不符，哈希表不是给这棵树采的' }
  }

  // 快照来源自带证明：它就是 HEAD 的那份原文。头部来源没有快照可对，只能拿 commit 兜底。
  const source = snapshot !== null && snapshot !== undefined && snapshot.text === head ? 'snapshot' : 'head'
  if (source === 'head' && manifestCommit !== headCommit) {
    return {
      accepted: false,
      reason: `哈希表记录的是 commit ${String(manifestCommit ?? '缺失')}，宿主 HEAD 是 ${headCommit}`,
    }
  }

  return { accepted: true, source, before: hashText(head), after: hashText(current), snapshot: head }
}

/**
 * 落盘与退出码判定。纯函数：不读盘、不写盘。
 *
 * 一个都没采纳时写清单，等于把「没有任何补丁」记成事实，所以拒绝写入、按失败退出（2）；
 * 有未采纳但至少采纳一个时照写清单，但退出码 1 提醒还有目标没进来；全部采纳才是
 * 干净的成功（0）。
 *
 * @param {number} acceptedCount 采纳的目标数。
 * @param {number} rejectedCount 未采纳的目标数。
 * @returns {{ write: boolean, exitCode: 0 | 1 | 2 }}
 */
export function adoptionOutcome(acceptedCount, rejectedCount) {
  if (acceptedCount === 0) return { write: false, exitCode: 2 }
  return { write: true, exitCode: rejectedCount > 0 ? 1 : 0 }
}

/**
 * 备份落点：文件名带时间戳，与已有文件冲突时取下一个名字。旧清单的备份是恢复凭证，
 * 已有的备份文件一个都不能覆盖。导出是为了让测试直接验证取名规则。
 *
 * @param {string} destination 清单路径。
 * @param {string} [stamp] 时间戳，默认取当前时刻。
 * @returns {string} 不会覆盖任何已有文件的备份路径。
 */
export function backupTarget(destination, stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)) {
  let candidate = `${destination}.bak-${stamp}`
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = `${destination}.bak-${stamp}-${n}`
  return candidate
}

/**
 * 逐个目标判定，并写出合并快照目录与新清单；一个都没采纳时什么都不写。
 *
 * @param {object} options
 * @param {string} options.hostRoot - 宿主根目录绝对路径。
 * @param {string} options.home - DSH_HOME 绝对路径。
 * @param {Array} [options.patches] - 补丁声明，默认全量（含只在某一档存在的补丁）。
 * @param {Record<string, Record<string, string>> | null} [options.hashes] - 预哈希表。
 * @param {object | null} [options.manifest] - 哈希表清单。
 * @param {(args: string[]) => string} [options.git] - git 读取实现，参数已含 -C 之前的调用形式。
 * @returns {{ destination: string, dir: string, accepted: Array, rejected: Array, snapshotCount: number, headCount: number,
 *   written: boolean, backup: string | null, exitCode: number }}
 *   一个都没采纳时 written 为 false、exitCode 为 2，清单不落盘。
 */
export function rebuildState(options) {
  const handle = acquireFileLock(options.home, `rebuild-${process.pid}-${Date.now()}`)
  if (handle.conflict !== undefined) {
    const error = new Error('另一个操作持有事务锁，状态重建已取消')
    error.code = 'locked'
    throw error
  }
  try {
    return rebuildStateLocked(options)
  } finally {
    releaseFileLock(handle)
  }
}

function rebuildStateLocked({
  hostRoot,
  home,
  patches = PATCHES,
  hashes = loadPatchHashes(),
  manifest = loadManifest(),
  git = args => execFileSync('git', ['-C', hostRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
}) {
  const headCommit = git(['rev-parse', 'HEAD']).trim()
  const manifestCommit = manifest !== null && manifest !== undefined && manifest.dsh !== undefined
    ? manifest.dsh.commit
    : undefined

  const declaredByPath = new Map()
  for (const patch of patches) {
    const table = hashes === null || hashes === undefined ? undefined : hashes[patch.id]
    if (table === undefined) continue
    for (const target of patch.targets) {
      if (declaredByPath.has(target.path)) continue
      declaredByPath.set(target.path, table[target.path])
    }
  }
  const variants = replaceVariantsByPath(patches)

  const txnRoot = transactionsDir(home)
  const dirs = fs.existsSync(txnRoot)
    ? fs.readdirSync(txnRoot)
      .filter((name) => fs.statSync(path.join(txnRoot, name)).isDirectory())
      .sort()
      .reverse()
    : []

  const findSnapshot = (relative) => {
    for (const name of dirs) {
      const text = readTextOrNull(path.join(txnRoot, name, 'files', relative))
      if (text !== null && hashText(text) === declaredByPath.get(relative)) return { text, from: name }
    }
    return null
  }

  const headText = (relative) => {
    try {
      return git(['show', `HEAD:${relative}`])
    } catch {
      return null
    }
  }

  const targets = [...new Set(patches.flatMap((patch) => patch.targets.map((target) => target.path)))].sort()

  const accepted = {}
  const rejected = []
  for (const relative of targets) {
    const verdict = judgeAdoption({
      head: headText(relative),
      current: readTextOrNull(path.join(hostRoot, relative)),
      snapshot: findSnapshot(relative),
      declaredHash: declaredByPath.get(relative),
      headCommit,
      manifestCommit,
      variants: variants.get(relative) ?? [],
    })
    if (verdict.accepted) accepted[relative] = verdict
    else rejected.push([relative, verdict.reason])
  }

  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const operationId = `rebuilt-${stamp}`
  const dir = transactionDir(home, operationId)

  const files = {}
  for (const [relative, record] of Object.entries(accepted)) {
    atomicWrite(path.join(dir, 'files', relative), record.snapshot)
    files[relative] = { before: record.before, after: record.after }
  }

  const destination = statePath(home)
  const outcome = adoptionOutcome(Object.keys(accepted).length, rejected.length)

  let backup = null
  if (outcome.write) {
    if (fs.existsSync(destination)) {
      backup = backupTarget(destination)
      fs.copyFileSync(destination, backup)
    }

    writeState(home, {
      version: STATE_VERSION,
      operationId,
      phase: 'committed',
      updatedAt: new Date().toISOString(),
      dsh: DSH_TARGET,
      transaction: dir,
      files,
    })
  }

  const snapshotCount = Object.values(accepted).filter(record => record.source === 'snapshot').length
  return {
    destination,
    dir,
    accepted,
    rejected,
    snapshotCount,
    headCount: Object.keys(accepted).length - snapshotCount,
    written: outcome.write,
    backup,
    exitCode: outcome.exitCode,
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const hostRoot = process.argv[2]
  if (hostRoot === undefined || hostRoot === '') {
    console.error('用法: node tools/rebuild-state.mjs <宿主根>')
    process.exit(2)
  }

  let result
  try {
    result = rebuildState({ hostRoot, home: resolveHome() })
  } catch (error) {
    console.error(`重建失败：${String(error?.message ?? error)}`)
    process.exit(2)
  }

  const total = Object.keys(result.accepted).length
  if (result.written) {
    const backupNote = result.backup !== null ? `（旧清单备份为 ${path.basename(result.backup)}）` : ''
    console.log(`已写 ${result.destination}${backupNote}`)
    console.log(`合并快照目录 ${result.dir}`)
  } else {
    console.log(`未写 ${result.destination}：一个文件都没有采纳，写入只会把「没有任何补丁」记成事实`)
  }
  console.log(`采纳 ${String(total)} 个文件（快照 ${String(result.snapshotCount)} 个，git HEAD ${String(result.headCount)} 个），未采纳 ${String(result.rejected.length)} 个`)
  for (const [relative, reason] of result.rejected) console.log(`  未采纳 ${relative}：${reason}`)
  if (result.exitCode !== 0) process.exit(result.exitCode)
}
