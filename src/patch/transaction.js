// 事务引擎：Apply 与 Revert 的唯一入口。
//
// Apply 的顺序不可交换：
//   全量预检 → 写快照 → 标记 pending → 原子替换并复校验 → 标记 committed
//
// 预检与写入分开的意义在于零写入：预检任一不通过，磁盘上不会多出一个字节。
// 快照先于写入，是为了写入中途失败时能退回原状。
//
// pending 标记先于第一次目标写入，是这一步的关键：从它落盘的那一刻起，
// 即使进程被杀，磁盘上也有一份能说明「快照在哪、目标本该是什么」的记录。
// 没有它，一次写入中途的崩溃会留下一个既没有清单、也没有原文件的宿主——
// 状态写不进去而文件已经改了，是这套流程里最危险的一种失败，所以 committed
// 写失败时选择把文件回滚回原文，让磁盘回到一致状态，而不是留下半个补丁。
//
// Revert 分两阶段。阶段一完全是读操作：校验全部快照存在且内容对得上记录里的
// before、全部目标仍等于本方写下的内容、非 committed 阶段尚未写入的文件按原文
// 放过。任一不符即整体拒绝，此时磁盘没有被碰过。阶段二先把当前内容备份到新事务
// 目录，再把 phase 写成 reverting 并把已写回的文件逐个记进去，然后逐文件写入；
// 中途失败就用那份备份把已经回退的文件恢复回起点。有了 reverting 这份记录，
// 进程在写入中途被杀之后，重试能按磁盘内容逐文件续做，而不是从头猜。
//
// 目标文件只做「整体成功」或「整体回到起点」两种结局；清单则按磁盘实况收敛：
// 只有全部目标都回到 before 才删除，否则留下 rollback-failed / reverting 供下次接着走。

import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, hashBytes, hashText, readBytesStrict, readTextOrNull } from './fsx.js'
import { acquireFileLock, createLock, releaseFileLock } from './lock.js'
import { declarationFingerprint, preflight } from './preflight.js'
import { PATCHES, DSH_TARGET, replaceVariantsByPath } from './index.js'
import { PATCH_HASHES } from './hashes.js'
import { STATE_VERSION, readState, removeState, statePath, transactionDir, transactionsDir, writeState } from './state.js'

/** 全进程共用一把锁：Apply、Revert、迁移、重启都在同一个临界区里。 */
const sharedLock = createLock()

/**
 * 跨进程锁被占用时的统一结果。
 *
 * 持有者必须报出来：只说"操作进行中"的话，使用者无从判断该等一会儿还是该去清锁，
 * 而这两条路的结果完全不同。锁文件路径一并给出，以便确认无操作在跑后手工清除。
 */
function busyResult(conflict, operationId) {
  const holder = conflict.holder
  const who = holder === null
    ? '持有者信息读不出，可能是上一次操作中途被杀'
    : `持有进程 ${String(holder.pid ?? '未知')}，开始于 ${String(holder.startedAt ?? '未知')}`
  return {
    ok: false,
    code: 'operation_in_progress',
    message: `另一个进程正在执行操作（${who}）。确认它已结束后，若锁文件仍在，可删除 ${conflict.path}。`,
    operationId,
    holder,
    lockPath: conflict.path,
  }
}

export function sharedOperationLock() {
  return sharedLock
}

/** 事务 id：时间戳加随机后缀，既按时间排序又可读。 */
export function newTransactionId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const salt = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${salt}`
}

/** 快照里保存单个目标文件原文的相对路径。 */
function snapshotPath(dir, target) {
  return path.join(dir, 'files', target)
}

/**
 * 写状态清单。phase 记录事务走到哪一步，供崩溃后的恢复判断。
 * @param {string} home - DSH_HOME。
 * @param {object} entry - operationId、目录、文件哈希表与阶段。
 */
function commitState(home, entry) {
  writeState(home, {
    version: STATE_VERSION,
    operationId: entry.operationId,
    phase: entry.phase,
    updatedAt: new Date().toISOString(),
    dsh: DSH_TARGET,
    transaction: entry.dir,
    files: entry.files,
  })
}

/** 目标源码必须能无损往返 UTF-8；快照和恢复不经过解码。 */
function readPatchText(file) {
  const read = readBytesStrict(file)
  if (read.kind === 'missing') return null
  if (read.kind === 'unreadable') throw read.error
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes) }
  catch { const error = new Error(`目标不是合法 UTF-8，拒绝写入：${file}`); error.code = 'invalid_encoding'; throw error }
}

function readRequiredBytes(file) {
  const read = readBytesStrict(file)
  if (read.kind !== 'ok') throw read.error ?? new Error(`文件不存在：${file}`)
  return read.bytes
}

/**
 * 用快照把一组目标文件恢复到原文。
 * @returns {string[]} 回滚过程中的错误描述，空数组表示全部成功。
 */
function restoreFromSnapshot(root, dir, targets, writeFile, expected = new Map()) {
  const errors = []
  for (const target of targets) {
    try {
      const original = readRequiredBytes(snapshotPath(dir, target))
      const current = readRequiredBytes(path.join(root, target))
      if (expected.has(target) && hashBytes(current) !== expected.get(target)) {
        errors.push(`${target}: 当前内容已变化，拒绝补偿覆盖`)
        continue
      }
      writeFile(path.join(root, target), original)
      if (!readRequiredBytes(path.join(root, target)).equals(original)) {
        errors.push(`${target}: 恢复后内容复校验失败`)
      }
    } catch (error) {
      errors.push(`${target}: ${String(error?.message ?? error)}`)
    }
  }
  return errors
}

/**
 * 清单里的每个目标是否都回到了记录中的应用前内容。
 *
 * 这是能不能删清单的唯一依据。判定只看磁盘实况，不看「本次回滚写了几个文件」：
 * 增量场景下先前的 after 内容仍在宿主上，那批文件根本没进本次回滚的 written，
 * 按 written 判空就会把整份记录连同它们的 before 一起删掉，于是下一次 Revert
 * 只会说「没有应用记录」，把已经应用过的那批永久留在宿主上。
 *
 * @returns {boolean} 全部等于 before 时为 true；任一文件缺失或内容不符为 false。
 */
function allTargetsAtBefore(root, files) {
  for (const [target, record] of Object.entries(files)) {
    const currentRead = readBytesStrict(path.join(root, target))
    const current = currentRead.kind === 'ok' ? currentRead.bytes : null
    if (current === null) return false
    if (hashText(current) !== record.before) return false
  }
  return true
}

/**
 * 回滚之后的收尾。
 *
 * 回滚成功且清单里每个文件都回到起点时删掉清单：留着它会让下一次 Revert 去回退
 * 一次从未真正发生的应用。
 *
 * 其余情况**必须留下清单**。文件停在混合状态，而那份清单是自动恢复的唯一线索
 * ——把它删掉，等于在故障现场擦掉自己的记录。这里只改写 phase，快照与目标哈希
 * 都还在目录里，Revert 的两阶段预检能据此逐文件判断该恢复什么。
 *
 * @returns {{ statePreserved: boolean, phase: string }} 让调用方能把结局报出去。
 */
function settleAfterRollback(home, root, { operationId, dir, files, rollbackErrors }) {
  if (rollbackErrors.length === 0 && allTargetsAtBefore(root, files)) {
    // 回滚成功的目录不再承担恢复职责（每个目标都回到了 before），把 manifest 落成
    // rolled-back——它是 prune 认得出「可收走」的唯一凭据。先落 phase 再删清单：
    // 两步之间崩溃时 state 仍指着这个目录，prune 的指针守卫会保住它。
    markManifestPhase(dir, 'rolled-back')
    removeState(home)
    // 顺手收走先前失败留下的 rolled-back 目录；本次这个用 protect 豁免，作为刚发生
    // 的失败现场留一次，下一次成功收尾或显式 prune 再清。清理尽力而为：失败不致命，
    // prune 返回的清单只含真正删掉的目录，删不掉的留在原地，不谎报。
    try {
      pruneTransactions(home, 10, dir)
    } catch {
      // 清理失败不改变「已回滚」这个结果。
    }
    return { statePreserved: false, phase: 'rolled-back' }
  }
  try {
    commitState(home, { operationId, dir, files, phase: 'rollback-failed' })
    return { statePreserved: true, phase: 'rollback-failed' }
  } catch {
    // 连记录都写不下去，只能如实说清单没保住。
    return { statePreserved: false, phase: 'unknown' }
  }
}

/**
 * 回滚没让磁盘整体回到应用前时，一句话说清停在哪种情况。
 *
 * 两种情形必须分开报：有文件回滚失败；或者本批文件都回滚了、但清单里早先应用的
 * 文件仍在宿主上（增量场景）。笼统写「已回滚」，使用者会以为宿主已经干净。
 */
function rollbackNotSettled(rollbackErrors) {
  return rollbackErrors.length > 0
    ? `写入失败，${String(rollbackErrors.length)} 个文件回滚失败，磁盘未整体回到应用前；`
    : '写入失败，本批写入的文件已回滚，但清单里早先应用的文件仍在宿主上；'
}

/**
 * 应用补丁。
 *
 * @param {object} options
 * @param {string} options.root - 宿主根目录绝对路径。
 * @param {string} options.home - DSH_HOME 绝对路径。
 * @param {Array} [options.patches] - 补丁声明，默认全量。
 * @param {object} [options.lock] - 单飞锁，默认全进程共享的那一把。
 * @param {(file: string, content: string) => void} [options.writeFile] - 写入实现。
 * @returns {object} 统一结果：{ ok, code, message, operationId, findings, blocked, written }
 */
export function applyPatches({
  root,
  home,
  patches = PATCHES,
  lock = sharedLock,
  writeFile = atomicWrite,
  hashes = PATCH_HASHES,
}) {
  const operationId = newTransactionId()
  if (lock.acquire(operationId) === null) {
    return {
      ok: false,
      code: 'operation_in_progress',
      message: '另一个应用或回退操作正在执行。',
      operationId: lock.operationId,
    }
  }

  // 跨进程那一层。宿主在跑、用户在终端里再跑一次 CLI 是完全正常的用法，
  // 两边的进程内锁互不可见，只有文件锁能拦住这种并发。
  // 获取失败（例如 home 父级是文件）时必须先释放进程内锁再抛，否则这把锁会一直
  // 停在 busy，之后所有入口都返回 operation_in_progress，只能重启宿主。
  let fileGuard
  try {
    fileGuard = acquireFileLock(home, operationId)
  } catch (error) {
    lock.release(operationId)
    throw error
  }
  if (fileGuard.conflict !== undefined) {
    lock.release(operationId)
    return busyResult(fileGuard.conflict, operationId)
  }

  try {
    const readFile = readPatchText

    // 记录不可读时停手。一份损坏的清单会让「已应用」判定建立在错误前提上，
    // 而那是整批补丁里唯一能防止重复写入的依据。
    const loaded = readState(home)
    if (loaded.kind === 'corrupt' || loaded.kind === 'version_mismatch') {
      return {
        ok: false,
        code: loaded.kind === 'corrupt' ? 'state_corrupt' : 'state_version_mismatch',
        message: `应用记录不可读，拒绝继续。先处理 ${statePath(home)}，或确认无需恢复后删除它。`,
        operationId,
      }
    }
    if (loaded.kind === 'ok' && loaded.state.phase !== 'committed') {
      return { ok: false, code: 'recovery_required', message: '存在未完成事务，请先回退，再重新应用。', operationId, written: [] }
    }
    // 应用记录整条交给预检：只传 after 哈希的话，判不出「这条记录是上一档写的」。
    const appliedRecords = {}
    if (loaded.kind === 'ok') {
      for (const [target, record] of Object.entries(loaded.state.files)) {
        appliedRecords[target] = { before: record.before, after: record.after, declaration: record.declaration, declarations: record.declarations }
      }
    }

    const result = preflight({
      root,
      patches,
      readFile,
      hashes,
      appliedRecords,
      // 旧记录没有指纹时，预检要靠全档变体把磁盘内容还原成原文才能判断哪一档写的。
      // 变体必须与本批声明同源：拿默认补丁集算，调用方自带声明时这条路径就没有变体，
      // 还原退化成空操作，另一档写下的内容会被判成「已应用」。
      variantsByPath: replaceVariantsByPath(patches),
    })
    // 目标路径 → 本批在这个路径上用到的**全部**声明指纹。同一文件可能被两条 replace
    // 目标命中（读取上限与单行长度就落在同一个文件里），只记最后一条会让另一个目标
    // 下次预检永远对不上，整批被判 applied_other。
    const declarationsByTarget = new Map()
    for (const patch of patches) {
      for (const declaredTarget of patch.targets) {
        // 同一文件可能同时被 replace 与 verify 覆盖；记录只由写正文的那条产生，
        // 让 verify 覆盖同一 key 会让指纹永远对不上。
        if (declaredTarget.after === undefined) continue
        const list = declarationsByTarget.get(declaredTarget.path) ?? []
        list.push(declarationFingerprint(patch.id, declaredTarget))
        declarationsByTarget.set(declaredTarget.path, list)
      }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: 'preflight_blocked',
        message: `预检未通过，未写入任何文件：${String(result.blocked.length)} 个目标被阻断。`,
        operationId,
        findings: result.findings,
        blocked: result.blocked,
        written: [],
      }
    }

    if (result.changes.size === 0) {
      return {
        ok: true,
        code: 'already_applied',
        message: '全部补丁均已是目标状态。',
        operationId,
        findings: result.findings,
        blocked: [],
        written: [],
      }
    }

    const dir = transactionDir(home, operationId)
    const files = {}

    // 记录说的是「当前仍归插件管的全部文件」，不是「最近一次写了什么」。增量应用
    // （先应用一批、之后又加一条再应用）若不继承，先前那批就失去「已应用」的证据，
    // 预检会把它们判成宿主偏离声明版本，整批阻断。
    // 继承要拿得出证据：旧记录的 after 必须等于该文件此刻的内容。
    const inherited = []
    const inheritedNow = new Set()
    const released = []
    if (loaded.kind === 'ok') {
      for (const [target, record] of Object.entries(loaded.state.files)) {
        // 这里不再守「files 里已有就跳过」：收集发生在记账之前，files 必然还是空的，
        // 那样的守卫是死代码。与本批撞车的目标（旧记录判 needs_reapply 的那批）在
        // 下面的继承循环里处理，覆盖是有意的，升级发生在提交成功之后。
        const current = readFile(path.join(root, target))
        if (current === null || hashText(current) !== record.after) {
          // 文件已被外部改动，不再归我们管——不把别人的改动记成自己的。
          released.push(target)
          continue
        }
        // 记录里没有备份目录指针，就没有快照可搬，继承不了。
        if (typeof loaded.state.transaction !== 'string') {
          released.push(target)
          continue
        }
        inherited.push({ target, record, fromDir: loaded.state.transaction })
      }
    }

    // 快照、manifest 与 pending 标记都属于「目标文件还没被碰过」的阶段：
    // 三者任一失败都直接停下，不需要回滚任何目标文件，但必须返回结构化结果，
    // 不能把异常抛给调用方——调用方拿不到结果就无从判断磁盘到底动没动。
    try {
      for (const [target, change] of result.changes) {
        writeFile(snapshotPath(dir, target), Buffer.from(change.before, 'utf8'))
        const declared = declarationsByTarget.get(target)
        files[target] = {
          before: hashText(change.before),
          after: hashText(change.after),
          // 指纹必须用本批真正应用的那份声明算：解锁档的 after 由 resolvePatches
          // 按当前模式替换过，拿原始 PATCHES 算出来的指纹下次切档永远对不上。
          ...(declared === undefined ? {} : { declarations: declared }),
        }
      }
      // 记录与快照同进同退：只继承记录会让 revert 去找不存在的快照，静默漏掉文件，
      // 比不继承更坏。快照搬不过来就拒绝继续，保留旧账本，不丢弃恢复职责。
      for (const { target, record, fromDir } of inherited) {
        const snapshot = readRequiredBytes(snapshotPath(fromDir, target))
        if (record.before !== undefined && hashBytes(snapshot) !== record.before) throw new Error(`继承快照与记录不符：${target}`)
        writeFile(snapshotPath(dir, target), snapshot)
        // 继承原始快照与旧档哈希；本批的新哈希在 pendingAfter 中先于目标写入持久化。
        // 中断后回退接受三种已知内容，提交成功再将 after 升级为本批结果。
        // before 缺失的旧记录按快照补上：回退恢复的就是快照字节，账本必须兑现它。
        files[target] = record.before === undefined ? { ...record, before: hashText(snapshot) } : record
        inheritedNow.add(target)
      }
      for (const [target, change] of result.changes) files[target] = { ...files[target], pendingAfter: hashText(change.after) }
      atomicWrite(path.join(dir, 'manifest.json'), `${JSON.stringify({
        operationId,
        // 先记 pending：同一份 phase 也进清理判据，失败现场因此不会被当成垃圾。
        // 成功提交后再由 markManifestPhase 改成 committed。
        phase: 'pending',
        startedAt: new Date().toISOString(),
        dsh: DSH_TARGET,
        files,
      }, null, 2)}\n`)
      // pending 从这一刻起生效：即使接下来崩溃，磁盘上也有记录说明快照在哪。
      commitState(home, { operationId, dir, files, phase: 'pending' })
    } catch (error) {
      return {
        ok: false,
        code: 'apply_failed',
        message: `事务准备失败，未修改任何目标文件：${String(error?.message ?? error)}`,
        operationId,
        error: String(error?.message ?? error),
        findings: result.findings,
        blocked: [],
        written: [],
      }
    }

    const written = []
    const expectedWrites = new Map([...result.changes].map(([target, change]) => [target, hashText(change.after)]))
    try {
      for (const [target, change] of result.changes) {
        if (readPatchText(path.join(root, target)) !== change.before) throw new Error(`写入前目标已变化：${target}`)
        writeFile(path.join(root, target), change.after)
        written.push(target)
        // 复校验：写完立刻读回，确认磁盘上的内容确实是我们要写的那一份。比对对象是
        // 这一批写下的哈希，不是 files[target].after——被继承的旧记录要到提交时刻才
        // 升级，拿旧档哈希比对会让复校验必然失败，一次升级连吃几轮「失败+回滚」。
        const back = readTextOrNull(path.join(root, target))
        if (back === null || hashText(back) !== hashText(change.after)) {
          throw new Error(`写入后复校验失败：${target}`)
        }
      }
    } catch (error) {
      const rollbackErrors = restoreFromSnapshot(root, dir, written, writeFile, expectedWrites)
      const settlement = settleAfterRollback(home, root, { operationId, dir, files, rollbackErrors })
      return {
        ok: false,
        code: 'apply_failed',
        message: settlement.statePreserved
          ? `${rollbackNotSettled(rollbackErrors)}应用记录已保留（phase=${settlement.phase}），可用 revert 继续恢复。原始错误：${String(error?.message ?? error)}`
          : `写入失败，已回滚：${String(error?.message ?? error)}`,
        operationId,
        error: String(error?.message ?? error),
        rollbackErrors,
        ...settlement,
        findings: result.findings,
        blocked: [],
        written: [],
      }
    }

    // 提交成功才升级被继承的旧记录：after 换成这一批真正写下的哈希、补上本批声明
    // 指纹。before 与快照沿旧记录的原文不动——回退要回到的是原文，不是旧档中间态。
    const committedFiles = Object.fromEntries(Object.entries(files).map(([target, record]) => {
      const { pendingAfter: _pendingAfter, ...committed } = record
      return [target, committed]
    }))
    for (const target of inheritedNow) {
      const change = result.changes.get(target)
      if (change === undefined) continue
      const declared = declarationsByTarget.get(target)
      committedFiles[target] = {
        before: files[target].before,
        after: hashText(change.after),
        ...(declared === undefined ? {} : { declarations: declared }),
      }
    }

    try {
      commitState(home, { operationId, dir, files: committedFiles, phase: 'committed' })
    } catch (error) {
      // 目标文件已经改了，却写不下状态记录——下一次 Revert 会说「没有记录」。
      // 这时唯一能保持磁盘一致的做法是把文件也退回去，并如实报告。
      const rollbackErrors = restoreFromSnapshot(root, dir, written, writeFile, expectedWrites)
      const settlement = settleAfterRollback(home, root, { operationId, dir, files, rollbackErrors })
      return {
        ok: false,
        code: 'apply_failed',
        message: `状态清单写入失败。${settlement.statePreserved
          ? `${rollbackNotSettled(rollbackErrors)}清单同样没能保住（phase=${settlement.phase}），快照在 ${dir}，可手工恢复。`
          : '已回滚全部目标文件。'}原始错误：${String(error?.message ?? error)}`,
        operationId,
        error: String(error?.message ?? error),
        rollbackErrors,
        ...settlement,
        findings: result.findings,
        blocked: [],
        written: [],
      }
    }

    // 记录已 committed，历史快照不再承担恢复职责，此时才清理。`dir` 额外豁免：
    // 它就是刚才那份快照的来源，即便 keep 很小也不该被自己的清理扫掉。
    // 先把 manifest 的 phase 落成 committed，否则按保守清理规则它永远删不掉。
    markManifestPhase(dir, 'committed', committedFiles)
    pruneTransactions(home, 10, dir)

    return {
      ok: true,
      code: 'applied',
      message: `已应用补丁，写入 ${String(written.length)} 个文件，记录中共 ${String(Object.keys(committedFiles).length)} 个。`
        + (released.length > 0
          ? ` ${String(released.length)} 个文件已被外部改动，不再计入记录。`
          : ''),
      operationId,
      findings: result.findings,
      blocked: [],
      written,
    }
  } catch (error) {
    return { ok: false, code: error?.code === 'invalid_encoding' ? 'invalid_encoding' : 'io_failed', message: `文件操作失败，未清除已有恢复记录：${String(error?.message ?? error)}`, operationId }
  } finally {
    releaseFileLock(fileGuard)
    lock.release(operationId)
  }
}

/**
 * 回退到应用前的状态。
 *
 * 阶段一全部是读操作，任一不符即整体拒绝，此时磁盘没有被碰过。快照必须与记录里的
 * before 逐一对上：快照是恢复的唯一依据，它坏了就没有「回到哪一版」这回事。
 * 阶段二先备份当前内容，再把 phase 写成 reverting 并逐个登记已写回的文件，然后
 * 逐文件写入；中途失败则把已回退的文件恢复到回退前，清单留着供下一次重试。
 */
export function revertPatches({ root, home, lock = sharedLock, writeFile = atomicWrite }) {
  const operationId = newTransactionId()
  if (lock.acquire(operationId) === null) {
    return {
      ok: false,
      code: 'operation_in_progress',
      message: '另一个应用或回退操作正在执行。',
      operationId: lock.operationId,
    }
  }

  // 获取失败（例如 home 父级是文件）时必须先释放进程内锁再抛，否则这把锁会一直
  // 停在 busy，之后所有入口都返回 operation_in_progress，只能重启宿主。
  let fileGuard
  try {
    fileGuard = acquireFileLock(home, operationId)
  } catch (error) {
    lock.release(operationId)
    throw error
  }
  if (fileGuard.conflict !== undefined) {
    lock.release(operationId)
    return busyResult(fileGuard.conflict, operationId)
  }

  try {
    const loaded = readState(home)
    if (loaded.kind === 'absent') {
      return { ok: false, code: 'not_applied', message: '没有应用记录，无可回退。', operationId }
    }
    if (loaded.kind === 'corrupt') {
      return {
        ok: false,
        code: 'state_corrupt',
        message: `应用记录已损坏，拒绝回退以免覆盖现场：${loaded.reason}`,
        operationId,
        reason: loaded.reason,
      }
    }
    if (loaded.kind === 'version_mismatch') {
      return {
        ok: false,
        code: 'state_version_mismatch',
        message: `应用记录版本为 ${String(loaded.found)}，本版本读的是 ${String(loaded.expected)}，拒绝回退。`,
        operationId,
      }
    }

    const state = loaded.state
    const dir = state.transaction
    // 非 committed 阶段（pending、rollback-failed、reverting）的文件可能停在应用前
    // 或应用后任一侧：写入可能只做了一半，回滚也可能只做了一半。那是正确的中间态，
    // 不是漂移，逐文件判定即可。
    const partial = state.phase !== 'committed'

    // 阶段一：零动作预检。
    const plan = []
    const alreadyReverted = []
    const drifted = []
    // 快照与记录不符时单独记一个标记：它和「目标文件漂移」是两种不同的事故，
    // 返回码必须分开，否则使用者会去查宿主文件，而真正坏掉的是备份。
    let snapshotCorrupt = false
    for (const [target, record] of Object.entries(state.files)) {
      const snapshotRead = readBytesStrict(snapshotPath(dir, target))
      const snapshot = snapshotRead.kind === 'ok' ? snapshotRead.bytes : null
      if (snapshot === null) {
        drifted.push({ path: target, reason: '快照缺失，无法恢复' })
        continue
      }
      // 恢复的唯一依据就是这份快照，它自己也得对得上记录里的 before。只判断存在，
      // 等于把「恢复到哪一版」交给一份可能被改坏、也可能根本不是本轮写入的文件；
      // 一旦写回去，宿主上就多了一份没人声明过的内容。
      if (hashText(snapshot) !== record.before) {
        snapshotCorrupt = true
        drifted.push({ path: target, reason: '快照内容与记录不符，拒绝恢复' })
        continue
      }
      const currentRead = readBytesStrict(path.join(root, target))
      const current = currentRead.kind === 'ok' ? currentRead.bytes : null
      if (current === null) {
        drifted.push({ path: target, reason: '文件已不存在' })
        continue
      }
      const now = hashText(current)
      if (now === record.after || (partial && now === record.pendingAfter)) {
        plan.push({ target, before: snapshot, expected: now })
        continue
      }
      // 中断后重试：这个文件在之前的尝试里已经写回原文。判定用磁盘内容，不用
      // state.revert.restored 那份清单——补偿成功过的文件内容会退回 after，
      // 照清单跳过就会把它当成「已完成」，永远不再回退。
      if (partial && now === record.before) {
        alreadyReverted.push(target)
        continue
      }
      drifted.push({ path: target, reason: '内容既非应用后版本也非应用前版本' })
    }

    if (drifted.length > 0) {
      return {
        ok: false,
        code: snapshotCorrupt ? 'snapshot_corrupt' : 'drift_detected',
        message: snapshotCorrupt
          ? `检测到 ${String(drifted.length)} 个目标无法安全恢复（快照缺失或与记录不符），已整体拒绝回退，磁盘未被改动。`
          : `检测到 ${String(drifted.length)} 个文件漂移，已整体拒绝回退，磁盘未被改动。`,
        operationId,
        drifted,
      }
    }

    if (plan.length === 0) {
      removeState(home)
      return {
        ok: true,
        code: 'reverted',
        message: alreadyReverted.length > 0
          ? `没有待回退的文件：${String(alreadyReverted.length)} 个文件在之前的尝试里已写回原文，清单已清除。`
          : '没有需要回退的文件，清单已清除。',
        operationId,
        restored: alreadyReverted,
      }
    }

    // 阶段二准备：把当前内容备份到新事务目录，供失败时反向恢复。
    //
    // 与 Apply 的快照阶段同义：此刻目标文件一个都还没被碰过。所以写盘失败不能把
    // 异常抛给调用方——调用方拿不到结果就无从判断磁盘到底动没动。如实返回
    // revert_failed，state.json 原样保留（phase 仍是阶段一读到的那个值，通常是
    // committed），下一次 Revert 面对的是同一份记录，可以原样重来。
    const backupDir = transactionDir(home, operationId)
    const backupFiles = {}
    try {
      for (const item of plan) {
        const content = readRequiredBytes(path.join(root, item.target))
        if (hashBytes(content) !== item.expected) throw new Error(`备份前目标已变化：${item.target}`)
        writeFile(snapshotPath(backupDir, item.target), content)
        backupFiles[item.target] = { before: hashText(content), after: hashText(item.before) }
      }
      atomicWrite(path.join(backupDir, 'manifest.json'), `${JSON.stringify({
        operationId,
        kind: 'revert-backup',
        phase: 'reverting',
        startedAt: new Date().toISOString(),
        files: backupFiles,
      }, null, 2)}\n`)
    } catch (error) {
      return {
        ok: false,
        code: 'revert_failed',
        message: `回退备份写入失败，未修改任何目标文件，应用记录保持原样（phase=${String(state.phase)}）：${String(error?.message ?? error)}`,
        operationId,
        phase: state.phase,
        restored: [],
        failures: [],
        recoveryErrors: [],
        error: String(error?.message ?? error),
      }
    }

    // 进入写入之前先把阶段落盘：从这一刻起，即使进程被杀，磁盘上也有一份记录
    // 说明回退进行到哪一步、哪些文件已经写回。写不下就不动手——没有这份记录的
    // 写入，崩溃之后留下的是一份无主的混合状态，下一次运行只能靠猜。
    let progress = {
      ...state,
      updatedAt: new Date().toISOString(),
      phase: 'reverting',
      revert: { operationId, backupDir, restored: [...alreadyReverted] },
    }
    try {
      writeState(home, progress)
    } catch (error) {
      return {
        ok: false,
        code: 'revert_failed',
        message: `回退阶段记录写入失败，未修改任何目标文件：${String(error?.message ?? error)}`,
        operationId,
        phase: state.phase,
        restored: [],
        failures: [],
        recoveryErrors: [],
        error: String(error?.message ?? error),
      }
    }

    // 阶段二执行。每写回一个文件就再落一次盘：进度记录落后于磁盘只会让重试多做
    // 一次相同的写入，而记录超前于磁盘会让重试跳过没做完的事。所以先写文件，
    // 再把路径记进去。
    const restoredThisRun = []
    const failures = []
    const progressErrors = []
    for (const item of plan) {
      try {
        if (hashBytes(readRequiredBytes(path.join(root, item.target))) !== item.expected) throw new Error(`回退前目标已变化：${item.target}`)
        writeFile(path.join(root, item.target), item.before)
        restoredThisRun.push(item.target)
        if (!readRequiredBytes(path.join(root, item.target)).equals(item.before)) {
          throw new Error(`回退后内容复校验失败：${item.target}`)
        }
        progress = {
          ...progress,
          updatedAt: new Date().toISOString(),
          revert: { ...progress.revert, restored: [...alreadyReverted, ...restoredThisRun] },
        }
        try {
          writeState(home, progress)
        } catch (error) {
          // 进度写不进去不改变「这个文件已经写回」这个事实，重试时按内容判定
          // 仍然能跳过它。但必须报出来，否则这份记录的可信度会被高估。
          progressErrors.push(`${item.target}: ${String(error?.message ?? error)}`)
        }
      } catch (error) {
        failures.push({ path: item.target, reason: String(error?.message ?? error) })
      }
    }

    if (failures.length === 0 && !allTargetsAtBefore(root, state.files)) {
      failures.push({ path: '', reason: '回退结束时仍有文件与原文不符，保留恢复记录' })
    }
    if (failures.length > 0) {
      // 补偿用本次的备份把已写回的文件恢复到回退前。补偿本身可能失败，所以
      // 「哪些文件真的回到原文」不能从尝试次数推断，只能逐个读回来判定。
      const recoveryErrors = restoreFromSnapshot(root, backupDir, restoredThisRun, writeFile, new Map(plan.map(item => [item.target, hashBytes(item.before)])))
      // 与成功分支同一个含义：磁盘上已经等于 record.before 的那些文件。遍历清单
      // 而不是遍历本次写过谁——先前尝试里已回退的文件也算数，补偿删掉的文件不算。
      const stillReverted = []
      for (const [target, record] of Object.entries(state.files)) {
        const currentRead = readBytesStrict(path.join(root, target))
        const current = currentRead.kind === 'ok' ? currentRead.bytes : null
        if (current !== null && hashText(current) === record.before) stillReverted.push(target)
      }
      // 清单里的 restored 必须和磁盘对得上：它是下一次重试的起点，写错就会跳过
      // 一个其实没回退的文件。补偿成功的那部分会从这份清单里退出去。
      try {
        writeState(home, {
          ...state,
          updatedAt: new Date().toISOString(),
          phase: 'reverting',
          revert: { operationId, backupDir, restored: stillReverted },
        })
      } catch (error) {
        progressErrors.push(`state.json: ${String(error?.message ?? error)}`)
      }
      return {
        ok: false,
        code: 'revert_failed',
        message: `回退未完成，${String(failures.length)} 个文件写入失败；${String(recoveryErrors.length)} 个文件未能恢复到回退前，${String(stillReverted.length)} 个文件已回到原文。应用记录已保留（phase=reverting），再次回退会按磁盘现状续做。`,
        operationId,
        phase: 'reverting',
        restored: stillReverted,
        failures,
        recoveryErrors,
        ...(progressErrors.length > 0 ? { progressErrors } : {}),
      }
    }

    // 之前尝试里已经写回的文件同样是本次回退的成果，一并报出去。
    const restored = [...alreadyReverted, ...restoredThisRun]
    removeState(home)
    // 回退已完成、清单已清，备份目录退回历史证据的身份，按上限收拢。
    // 同样先把 phase 落成 committed，让它可以进入清理范围。
    markManifestPhase(backupDir, 'committed')
    pruneTransactions(home, 10, backupDir)
    return {
      ok: true,
      code: 'reverted',
      message: `已回退 ${String(restored.length)} 个文件。`,
      operationId,
      restored,
      ...(progressErrors.length > 0 ? { progressErrors } : {}),
    }
  } catch (error) {
    return { ok: false, code: error?.code === 'invalid_encoding' ? 'invalid_encoding' : 'io_failed', message: `文件操作失败，未清除已有恢复记录：${String(error?.message ?? error)}`, operationId }
  } finally {
    releaseFileLock(fileGuard)
    lock.release(operationId)
  }
}

/**
 * 读事务目录 manifest.json 里的 phase，读不出时返回 null。
 *
 * @param {string} dir - 事务目录绝对路径。
 * @returns {string | null} phase；manifest 缺失、坏 JSON、无 phase 字段均为 null。
 */
function manifestPhase(dir) {
  const raw = readTextOrNull(path.join(dir, 'manifest.json'))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return typeof parsed.phase === 'string' ? parsed.phase : null
  } catch {
    return null
  }
}

/**
 * 收尾后改写事务 manifest：换 phase，需要时同步 files。
 *
 * 事务目录里的 manifest 起手写的是 pending / reverting，那是「随时可能中断」时的标记。
 * 清理按 phase 认「可收走」：成功收尾落成 committed，回滚成功落成 rolled-back；不落，
 * 真实目录永远不会被收拢，备份会无限增长。files 同步只在成功收尾时做：提交时刻升级过
 * 的旧记录必须与 state.json 一致，manifest 停在 pending 时刻的形状就是一份假记录。
 * 这一步失败只影响该目录能否被清理，不能让已经成功的事务报错，所以吞掉异常——
 * 目录留着，多占一点磁盘而已。
 *
 * @param {string} dir - 事务目录绝对路径。
 * @param {string} phase - 落盘的 phase。
 * @param {object} [files] - 同步进 manifest 的文件记录；缺省不动原有内容。
 */
function markManifestPhase(dir, phase, files) {
  const file = path.join(dir, 'manifest.json')
  try {
    const raw = readTextOrNull(file)
    if (raw === null) return
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    parsed.phase = phase
    if (files !== undefined) parsed.files = files
    atomicWrite(file, `${JSON.stringify(parsed, null, 2)}\n`)
  } catch {
    // 清理豁免：不影响主流程，也不谎报成功。
  }
}

/**
 * 清理历史事务目录，避免备份无限增长。
 *
 * 成功路径与回滚成功的收尾都调用它。失败现场留下的 pending / rollback-failed /
 * reverting 目录可能正是 `--revert` 与 `tools/rebuild-state.mjs` 的依据，当垃圾扫掉
 * 就等于毁掉恢复凭证，所以清理不按目录名一刀切：先读目录里 manifest.json 的 phase，
 * 只删 committed 与 rolled-back 两类。
 *
 * rolled-back 是已了结的失败现场：回滚把每个目标都送回了 before，目录里没有任何
 * 恢复职责，见到就清、不占保留名额——否则每次「写入失败→回滚成功」都留一个永不
 * 收走的快照目录。committed 仍按 `keep` 收拢：它们可能是 tools/rebuild-state.mjs
 * 的原文来源。
 *
 * 读不到 manifest 就不删：文件缺失、不是合法 JSON、顶层不是对象、没有 phase 字段，
 * 一律按「证据不足」跳过。这些目录最可能就是失败现场，留着只多占一点磁盘，删错
 * 了就没有下一次恢复可言。state.json 指着的目录无论 phase 是什么都不删：它是当前
 * 恢复的唯一依据。
 *
 * `keep` 是 committed 的保留名额；`protect` 指定的目录额外豁免，因为它可能正是
 * state.json 指向的那一份快照来源。合起来保证「清理之后仍能回退」。
 *
 * @param {string} home - DSH_HOME。
 * @param {number} [keep] - 期望保留的最新事务目录数量。
 * @param {string | null} [protect] - 无论新旧都要保留的目录绝对路径。
 * @returns {string[]} 被真正删除的目录名；删除失败的不在其中，留在原地不谎报。
 */
export function pruneTransactions(home, keep = 10, protect = null) {
  const dir = transactionsDir(home)
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const protectedName = typeof protect === 'string' ? path.basename(protect) : null
  // 指针守卫：被 state.json 引用的目录是当前恢复的依据，删了就没有下一次恢复可言。
  // 清单损坏时拿不到指针，只能按「没有引用」处理——那种状态本就让 apply/revert 全部
  // 停手，不会走到依赖这层守卫的清理。
  const loaded = readState(home)
  const referencedName = loaded.kind === 'ok' && typeof loaded.state.transaction === 'string'
    ? path.basename(loaded.state.transaction)
    : null
  const sorted = entries
    .filter((name) => {
      try {
        return fs.statSync(transactionDir(home, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
  // 事务 id 以时间戳开头，字典序即时间序。keep 窗口只算 committed：rolled-back
  // 见到就清、不占名额，否则失败目录会把重建证据（committed）挤出窗口。
  const phases = new Map(sorted.map(name => [name, manifestPhase(transactionDir(home, name))]))
  const committedNames = sorted.filter(name => phases.get(name) === 'committed')
  const survivors = new Set(committedNames.slice(-Math.max(1, keep)))
  if (protectedName !== null) survivors.add(protectedName)
  const droppable = sorted.filter((name) => {
    if (name === protectedName || name === referencedName) return false
    const phase = phases.get(name)
    if (phase === 'rolled-back') return true
    // 上限只对 committed 生效。读不出 phase 的一律留在原地：失败凭证比目录整洁重要。
    return phase === 'committed' && !survivors.has(name)
  })
  // 返回的清单只含真正删掉的目录：删除失败的不报成已清理。
  const dropped = []
  for (const name of droppable) {
    try {
      fs.rmSync(transactionDir(home, name), { recursive: true, force: true })
      dropped.push(name)
    } catch {
      // 清理是尽力而为的维护动作，失败不该影响主流程。
    }
  }
  return dropped
}
