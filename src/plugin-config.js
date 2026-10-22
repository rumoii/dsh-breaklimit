// 插件配置：手写的 Standard Schema。
//
// 宿主在装载与热更新时调用 `Config['~standard'].validate`，校验不通过的整条插件行
// 不会启动（vendor/cordis 的 resolveConfig；见 DSH 的 docs/user/develop/basic/config）。
// 手写而不引 Schemastery：本插件从目录安装，没有 node_modules，多一个运行时依赖就多
// 一条解析路径。
//
// 未知键原样保留。`cordis.patch.yml` 里同一行可能带着别处写入的键，装载期拒绝会让宿主
// 起不来；已知键的类型写错则必须响亮失败。

import { MODE_BUDGETS } from './host/capabilities.js'

/** 缺省值。行的 config 为空或没写某个键时用它。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  injectFile: '',
  hostRoot: '',
  allowedHosts: Object.freeze([]),
  order: 8999,
  budgets: MODE_BUDGETS,
})

const BUDGET_TIERS = Object.freeze(['recommended', 'unrestricted'])
const BUDGET_KEYS = Object.freeze(['timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxDepth'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function typeIssue(path, expected, seen) {
  return { message: `应为${expected}，实际是 ${Array.isArray(seen) ? '数组' : typeof seen}`, path: [path] }
}

/** 两档预算的可变副本。默认值只读，装配结果必须能被单独改。 */
function cloneBudgets() {
  const copy = {}
  for (const tier of BUDGET_TIERS) copy[tier] = { ...MODE_BUDGETS[tier] }
  return copy
}

/**
 * 校验 `budgets` 覆盖并与默认值合并。
 *
 * 只接受两档、四个键；写错名字直接报错而不是静默忽略——拼错的预算键如果被丢掉，
 * 用户会以为改生效了。合并后再判 `maxTimeoutMs >= timeoutMs`，因为宿主执行时取两者
 * 的较小值，只抬 timeoutMs 不会有效果。
 *
 * @param {unknown} input - `budgets` 的值。
 * @param {object[]} issues - 收集问题。
 * @returns {object | undefined} 两档完整预算；有问题时 undefined。
 */
function validateBudgets(input, issues) {
  if (!isPlainObject(input)) {
    issues.push(typeIssue('budgets', '对象', input))
    return undefined
  }
  const merged = cloneBudgets()
  const before = issues.length
  for (const [tier, overrides] of Object.entries(input)) {
    if (!BUDGET_TIERS.includes(tier)) {
      issues.push({ message: `未知档位，只接受 ${BUDGET_TIERS.join(' / ')}`, path: ['budgets', tier] })
      continue
    }
    if (!isPlainObject(overrides)) {
      issues.push(typeIssue(`budgets.${tier}`, '对象', overrides))
      continue
    }
    for (const [key, raw] of Object.entries(overrides)) {
      if (!BUDGET_KEYS.includes(key)) {
        issues.push({ message: `未知预算键，只接受 ${BUDGET_KEYS.join(' / ')}`, path: ['budgets', tier, key] })
        continue
      }
      const min = key === 'maxDepth' ? 0 : 1
      if (!Number.isInteger(raw) || raw < min) {
        issues.push({ message: min === 0 ? '应为非负整数' : '应为正整数', path: ['budgets', tier, key] })
        continue
      }
      merged[tier][key] = raw
    }
    if (merged[tier].maxTimeoutMs < merged[tier].timeoutMs) {
      issues.push({
        message: 'maxTimeoutMs 不能小于 timeoutMs；宿主取较小值，只抬 timeoutMs 不会生效',
        path: ['budgets', tier],
      })
    }
  }
  return issues.length > before ? undefined : merged
}

/**
 * 校验并补默认值。同步返回，宿主不接受异步校验。
 *
 * @param {unknown} input - 行配置。没写 config 时宿主传 undefined。
 * @returns {{ value: object } | { issues: { message: string, path?: string[] }[] }}
 */
export function validateConfig(input) {
  if (input === undefined || input === null) input = {}
  if (!isPlainObject(input)) return { issues: [{ message: '插件配置必须是对象' }] }

  const value = { ...DEFAULTS, allowedHosts: [...DEFAULTS.allowedHosts], budgets: cloneBudgets() }
  const issues = []

  for (const [key, next] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      value[key] = next
      continue
    }
    if (key === 'budgets') {
      const merged = validateBudgets(next, issues)
      if (merged !== undefined) value.budgets = merged
      continue
    }
    if (key === 'enabled') {
      if (typeof next !== 'boolean') issues.push(typeIssue(key, '布尔值', next))
      else value.enabled = next
      continue
    }
    if (key === 'injectFile' || key === 'hostRoot') {
      if (typeof next !== 'string') issues.push(typeIssue(key, '字符串', next))
      else value[key] = next
      continue
    }
    if (key === 'order') {
      if (typeof next !== 'number' || !Number.isFinite(next)) issues.push(typeIssue(key, '有限数字', next))
      else value.order = next
      continue
    }
    // allowedHosts：主机名可带端口，空串没有意义。
    if (!Array.isArray(next)) {
      issues.push(typeIssue(key, '字符串数组', next))
      continue
    }
    const hosts = []
    for (const [index, host] of next.entries()) {
      if (typeof host !== 'string' || host.trim() === '') {
        issues.push({ message: '应为非空字符串', path: [key, String(index)] })
        continue
      }
      hosts.push(host)
    }
    value.allowedHosts = hosts
  }

  if (issues.length > 0) return { issues }
  return { value }
}

export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'rumo-dsh-breaklimit',
    validate: validateConfig,
  }),
})
