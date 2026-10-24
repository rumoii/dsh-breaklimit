// 所有入口共用的补丁查询与应用服务。回退继续由事务清单决定，与当前选择无关。
import { preflight } from './preflight.js'
import { readTextOrNull } from './fsx.js'
import { readState } from './state.js'
import { resolvePatches } from './patch-selection.js'
import { applyPatches } from './transaction.js'
import { PATCH_HASHES } from './hashes.js'
import { replaceVariantsByPath } from './index.js'

/**
 * 阻断文案：档位不符与内容冲突分开说。
 *
 * 两者都并进 blocked——写入阶段只认它——但一次切档会让每个已应用目标各出一条。
 * 混在一起数成「冲突」，人会以为宿主被外部改过，而实际只是需要先回退再应用。
 *
 * @param {number} modeMismatch - 应用的是上一次声明版本的目标数。
 * @param {number} conflicts - 其余阻断目标数。
 */
function blockedMessage(modeMismatch, conflicts) {
  const parts = []
  if (conflicts > 0) parts.push(`${String(conflicts)} 个目标与声明不符（冲突或缺失）`)
  if (modeMismatch > 0) {
    parts.push(`${String(modeMismatch)} 个目标应用的是上一次声明的版本（可能是另一档），需先回退再应用`)
  }
  return `预检阻断：${parts.join('；')}。`
}

// 判定用哪份清单由调用方决定：插件派发路径用随包的 PATCH_HASHES，拿合成宿主做判定的
// 工具与测试显式传入同一份合成清单——预哈希与实际文本必须互相印证，掺着用就是伪证据。
export function inspectPatches({ root, home, mode = 'recommended', hashes = PATCH_HASHES }) {
  const state = readState(home)
  if (!root) {
    return { state, preflight: {
      ok: false,
      code: 'host_root_unconfigured',
      message: '未配置宿主根，无法判定补丁状态。设 hostRoot、环境变量 DSH_BREAKLIMIT_HOST_ROOT，或从宿主源码树里启动宿主让它自己推导出来。',
    } }
  }
  if (state.kind === 'corrupt' || state.kind === 'version_mismatch') {
    return { state, preflight: {
      ok: false,
      code: state.kind === 'corrupt' ? 'state_corrupt' : 'state_version_mismatch',
      message: '应用记录不可读，补丁状态无法可靠判定。先处理 state.json 再继续。',
    } }
  }
  if (mode === null) return { state, preflight: { ok: false, code: 'tier_config_unavailable', message: '档位配置不可用，已暂停应用。' } }
  if (state.kind === 'ok' && state.state.phase !== 'committed') return { state, preflight: { ok: false, code: 'recovery_required', message: '存在未完成事务，请先回退，再重新应用。' } }
  // 整条记录交给预检，而不是只挑 each 的 after：指纹决定「已应用」与「上一次声明的
  // 版本」，少传它，档位切换就会被判回已应用。缺 declaration 的旧记录原样传下去，
  // 预检会按旧行为放过。
  const appliedRecords = {}
  if (state.kind === 'ok') {
    for (const [target, record] of Object.entries(state.state.files)) {
      appliedRecords[target] = { before: record.before, after: record.after, declaration: record.declaration, declarations: record.declarations }
    }
  }
  // 判用的补丁集与还原用的变体必须是同一份：变体取自默认声明时，调用方按档解析过的
  // 那份列表与它对不上，legacy 记录的还原会退化成空操作。
  const patches = resolvePatches(home, mode)
  const result = preflight({
    root,
    patches,
    readFile: readTextOrNull,
    hashes,
    appliedRecords,
    // 旧记录没有指纹时，预检要靠全档变体把磁盘内容还原成原文才能判断哪一档写的。
    variantsByPath: replaceVariantsByPath(patches),
  })
  // applied_other 并进 blocked，但单独计数：它要说明的是「先回退」，不是「宿主被改过」。
  const modeMismatchFiles = result.findings.filter(item => item.state === 'applied_other').length
  const blockedFiles = result.blocked.length
  return { state, preflight: {
    ok: result.ok,
    code: result.ok ? 'ok' : 'blocked',
    findings: result.findings,
    blocked: result.blocked,
    pendingFiles: result.changes.size,
    blockedFiles,
    conflictFiles: blockedFiles - modeMismatchFiles,
    modeMismatchFiles,
    ...(result.ok ? {} : { message: blockedMessage(modeMismatchFiles, blockedFiles - modeMismatchFiles) }),
  } }
}

export function applySelectedPatches({ root, home, mode = 'recommended' }) {
  return applyPatches({ root, home, patches: resolvePatches(home, mode) })
}
