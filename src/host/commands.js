// 宿主斜杠命令适配层，共用应用服务与状态查询。
import { resolveHome } from '../patch/state.js'
import { revertPatches } from '../patch/transaction.js'
import { applySelectedPatches } from '../patch/service.js'
import { resolveHostRoot } from './host-root.js'
import { buildStatus, formatStatusText } from './status.js'
import * as rules from '../context/rules.js'
import * as tiers from '../context/tiers.js'
import { promptMode, readMode, readModeExtension } from '../context/prompt.js'
import { applyModeBudget, readRuntimeLimits, resolveBudgets } from './capabilities.js'
import { inspectPatches } from '../patch/service.js'
import { resolvePatches } from '../patch/patch-selection.js'
import { diffPrompt, formatDiff, formatUpgrade, importRule, upgradeReport } from './inspect.js'
import { readInject } from '../context/inject-file.js'

export function registerCommands(ctx, config, runtime) {
  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'breaklimit',
      description: '查看 rumo-dsh-breaklimit 状态，或执行应用、回退与档位切换',
      input: { hint: 'status | doctor | upgrade | diff | import <路径> | apply | revert | tier [recommended|unrestricted] | on | off' },
      handler: (invocation) => {
        const rawInput = String(invocation?.rawInput ?? '').trim()
        const parts = rawInput.split(/\s+/)
        const action = (parts[0] || 'status').toLowerCase()
        if (action === 'on') {
          runtime.enabled = true
          return { kind: 'success', text: '接管已开启。' }
        }
        if (action === 'off') {
          runtime.enabled = false
          return { kind: 'success', text: '接管已关闭：全部接缝交还宿主。' }
        }
        if (action === 'tier') {
          const targetTier = (parts[1] ?? '').toLowerCase()
          const home = resolveHome()
          if (!targetTier) {
            const current = tiers.readTier(home)
            return { kind: 'success', text: `当前提示词档位：${current.tier}（可选：${tiers.TIERS.join(', ')}）` }
          }
          if (!tiers.isValidTier(targetTier)) {
            return { kind: 'error', text: `非法档位 "${targetTier}"。可用：${tiers.TIERS.join(', ')}。` }
          }
          tiers.writeTier(home, targetTier)
          void applyModeBudget(ctx, readMode(home), resolveBudgets(config))
          return { kind: 'success', text: `提示词模式已切换至 "${targetTier}"；可即时生效的上限已重设，源码补丁仍需回退并重新应用。` }
        }
        if (action === 'doctor') {
          return doctorReport(ctx, config)
        }
        if (action === 'upgrade') {
          const root = resolveHostRoot(config)
          if (root === null) {
            return { kind: 'error', text: '未配置宿主根，无法核对。设置 hostRoot 或 DSH_BREAKLIMIT_HOST_ROOT。' }
          }
          const home = resolveHome()
          const patches = resolvePatches(home, promptMode(tiers.readTier(home).tier))
          const report = upgradeReport(root, patches)
          return { kind: report.ok ? 'success' : 'error', text: formatUpgrade(report) }
        }
        if (action === 'diff') {
          const home = resolveHome()
          const loaded = readInject(config)
          const mode = promptMode(tiers.readTier(home).tier)
          const head = tiers.buildTierPrompt(mode, loaded.ok ? loaded.text : '', readModeExtension(mode))
          return { kind: 'success', text: formatDiff(diffPrompt(head)) }
        }
        if (action === 'import') {
          const home = resolveHome()
          const result = importRule(home, parts[1] ?? '')
          if (!result.ok) return { kind: 'error', text: result.reason }
          return {
            kind: 'success',
            text: `已导入为规则 ${result.id}（${String(result.bytes)} 字节），未激活。用 /breaklimit-rules activate ${result.id} 启用。`,
          }
        }
        if (action === 'apply' || action === 'revert') {
          const root = resolveHostRoot(config)
          if (root === null) {
            return { kind: 'error', text: '未配置宿主根，无法执行。设置 hostRoot 或 DSH_BREAKLIMIT_HOST_ROOT。' }
          }
          const home = resolveHome()
          const result = action === 'apply'
            ? applySelectedPatches({ root, home, mode: readMode(home) })
            : revertPatches({ root, home })
          return { kind: result.ok ? 'success' : 'error', text: result.message }
        }
        if (action !== 'status') {
          return { kind: 'error', text: `未知动作 "${action}"。可用：status、doctor、apply、revert、tier、on、off。` }
        }
        return { kind: 'success', text: formatStatusText(buildStatus(ctx, config, runtime)) }
      },
    })

    scope.commands.register({
      name: 'breaklimit-rules',
      description: '管理可切换的规则集：每套是一份指令正文与一个落点文件',
      input: { hint: 'list | read <id> | activate <id> | deactivate | delete <id> | reset' },
      handler: (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim()
        const [action = 'list', argument = ''] = raw.split(/\s+/)
        const home = resolveHome()

        if (action === 'list' || action === 'status') {
          const listed = rules.listRules(home)
          if (listed.length === 0) return { kind: 'success', text: '规则目录为空。可以在设置页新建一条。' }
          const lines = listed.map(rule =>
            `  ${rule.active ? '*' : ' '} ${rule.id}  → ${rule.target}  ${String(rule.bytes)} 字节  ${rule.name}`)
          return { kind: 'success', text: ['规则（* 为激活中）', ...lines].join('\n') }
        }

        if (action === 'read') {
          const loaded = rules.readRule(home, argument)
          if (!loaded.ok) return { kind: 'error', text: loaded.reason }
          const meta = rules.readRuleMeta(home, argument)
          return { kind: 'success', text: `${argument}（${meta.name} → ${meta.target}）\n\n${loaded.text}` }
        }

        if (action === 'activate') {
          const done = rules.activateRule(home, argument)
          if (!done.ok) return { kind: 'error', text: done.reason }
          const copied = typeof done.externalCopy === 'string'
            ? `落点上的外部改动已存副本 ${done.externalCopy}。`
            : ''
          const cleanup = done.cleanupPending ? '旧落点收尾尚未完成，状态记录与原文快照已保留。' : ''
          return {
            kind: 'success',
            text: `已激活「${done.name}」，正文写入 ${done.file}。${copied}${cleanup}宿主会在工作区指令里读到它，同时它也直接注入系统提示。`,
          }
        }

        if (action === 'deactivate') {
          const done = rules.deactivateRule(home)
          if (!done.ok) return { kind: 'error', text: done.reason }
          if (done.kept === true) {
            const files = done.skipped.map(item => item.path).join('、')
            return {
              kind: 'error',
              text: `落点被外部改过，激活记录与快照已保留，没有取消激活：${files}。先决定怎么处理那份文件，再重试。`,
            }
          }
          return { kind: 'success', text: '已取消激活。' }
        }

        if (action === 'delete') {
          const done = rules.deleteRule(home, argument)
          if (!done.ok) return { kind: 'error', text: done.reason }
          return { kind: 'success', text: `已删除规则 ${argument}。` }
        }

        if (action === 'reset') {
          const done = rules.resetRules(home)
          if (!done.ok) return { kind: 'error', text: done.reason }
          const kept = done.skipped.length > 0 ? `；${String(done.skipped.length)} 个落点文件被改过，已保留` : ''
          return { kind: 'success', text: `已清空规则，移除 ${String(done.removed)} 个文件${kept}。` }
        }

        return { kind: 'error', text: `未知动作 "${action}"。可用：list、read、activate、deactivate、delete、reset。` }
      },
    })
  })

}

/**
 * 一致性报告：当前模式、运行时上限是否符合该模式、以及源码补丁是否处于该模式应有的状态。
 *
 * 三类结论分开说，因为修复方式不同：上限可以直接重设，源码补丁必须回退后重新应用，
 * 而宿主根未配置时前两者都无从判定。
 */
export function doctorReport(ctx, config) {
  const home = resolveHome()
  const mode = readMode(home)
  // 诊断与实际提交读同一份预算；否则覆盖配置后 doctor 会拿内置值误报不一致。
  const expected = resolveBudgets(config)[mode]
  const now = readRuntimeLimits(ctx)
  const lines = [`提示词模式  ${mode}`]
  const problems = []

  const pairs = [
    ['bash 超时', now.shell.timeoutMs, expected.timeoutMs],
    ['bash 超时上限', now.shell.maxTimeoutMs, expected.maxTimeoutMs],
    ['bash 输出上限', now.shell.maxOutputBytes, expected.maxOutputBytes],
    ['子代理深度', now.subagents.maxDepth, expected.maxDepth],
  ]
  for (const [label, actual, want] of pairs) {
    if (actual === null) { lines.push(`  ${label}  宿主未提供`); continue }
    if (actual === want) { lines.push(`  ${label}  ${String(actual)}`); continue }
    lines.push(`  ${label}  ${String(actual)}，该模式应为 ${String(want)}`)
    problems.push('runtime')
  }

  const root = resolveHostRoot(config)
  if (root === null) {
    lines.push('宿主根    未配置，无法判定源码补丁状态')
    return { kind: problems.length > 0 ? 'error' : 'success', text: lines.join('\n') }
  }
  const { preflight } = inspectPatches({ root, home, mode })
  if (preflight.ok) {
    lines.push(`源码补丁  与 ${mode} 一致（待写入 ${String(preflight.pendingFiles)} 个文件）`)
  } else {
    lines.push(`源码补丁  与 ${mode} 不一致，${String(preflight.blocked.length)} 项阻断：`)
    for (const item of preflight.blocked.slice(0, 5)) lines.push(`  ${item.patchId}  ${item.path}  ${item.reason}`)
    problems.push('patches')
  }

  if (problems.includes('runtime')) {
    lines.push('修复：运行时上限可用 /breaklimit tier <模式> 重新写入，立即生效。')
  }
  if (problems.includes('patches')) {
    lines.push('修复：源码补丁需回退后按当前模式重新应用，并重启宿主。')
  }
  return { kind: problems.length === 0 ? 'success' : 'error', text: lines.join('\n') }
}
