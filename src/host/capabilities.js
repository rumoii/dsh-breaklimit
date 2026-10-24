import { writeTier } from '../context/tiers.js'
// 执行层预算：两档取值、运行时写入、以及实测读数。
//
// 写入走宿主 Loader 的公开 API——`loader.resolve(id).update({ config })`。当变更只
// 涉及 config 且 fiber 处于 ACTIVE 时，Loader 会在运行中的引用上原地提交 volatile
// 值、不重挂载，所以切模式立即生效。若条件不成立，它会重挂载该条目：对 subagent
// 来说就是打断正在跑的子代理，因此这里只提交 config、不碰其它字段。
//
// Loader 对 config 是整值替换（vendor/loader/src/config/entry.ts:125-131），缺失的键
// 回落到 schema 默认。所以提交前先读出条目现有的 config 再合并，只覆盖预算键；读不到
// （条目本来就没有 config）就按空对象合并照常提交——那时没有任何用户设过的键会被冲掉。
//
// 条目 id 带路径前缀。resolve 不到时按 `:id` 后缀收集全部候选：同后缀可能同时存在禁用
// 的诱饵条目与真实条目，而 update 对禁用条目只写 options 就返回（entry.ts:136-139），
// 冲掉的却是那份没人用的 options，于是记成 applied 而真实条目没动过。候选必须唯一且
// 启用才提交。
//
// 写入失败一律记进 skipped 并保留旧值：宁可没生效，也不能把宿主搞挂。提交成功后再用
// readRuntimeLimits 读回实际生效值：与目标不一致记进 mismatched；读回不可用（装载期
// volatile 还没就绪）记进 unverified，等状态接口稍后再核，不冒充不一致。
//
// src/bundle.yml 里的同名配置行是装载期基线（取推荐档的值），这样即便运行时写入
// 全部失败，装完之后也是推荐档，而不是宿主默认。

/** 两档的执行层预算。单位：毫秒、字节、层。 */
export const MODE_BUDGETS = Object.freeze({
  recommended: Object.freeze({
    timeoutMs: 1200000,
    maxTimeoutMs: 1200000,
    maxOutputBytes: 524288,
    maxDepth: 2,
  }),
  unrestricted: Object.freeze({
    timeoutMs: 9999000,
    maxTimeoutMs: 9999000,
    maxOutputBytes: 1048576,
    maxDepth: 5,
  }),
})

/** 兼容旧名：装载期基线就是推荐档。 */
export const RUNTIME_TARGET = MODE_BUDGETS.recommended

/**
 * 当前生效的两档预算。配置里的 `budgets` 由插件 Config 校验并补全为两档完整值；
 * 直接调用（测试、命令行）没有配置时用内置值。
 *
 * @param {object} [config] - 插件配置。
 * @returns {typeof MODE_BUDGETS} 两档完整预算。
 */
export function resolveBudgets(config) {
  const configured = config?.budgets
  return configured === undefined || configured === null ? MODE_BUDGETS : configured
}

/** 读出宿主当前的执行层预算，供状态与诊断展示。取不到就是 null。 */
export function readRuntimeLimits(ctx) {
  const read = (slot) => (typeof slot?.get === 'function' ? slot.get() : null)
  const shell = ctx?.get?.('shell')
  const subagents = ctx?.get?.('subagents')
  return {
    shell: {
      timeoutMs: read(shell?.config?.timeoutMs),
      maxTimeoutMs: read(shell?.config?.maxTimeoutMs),
      maxOutputBytes: read(shell?.config?.maxOutputBytes),
    },
    subagents: { maxDepth: read(subagents?.config?.maxDepth) },
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 收集同名候选。resolve 命中就直接用它；解析不到再按 `:id` 后缀收集**全部**命中，
 * 不在第一个命中处停下。
 */
function findCandidates(loader, id) {
  try {
    const resolved = loader.resolve(id)
    if (resolved !== null && resolved !== undefined) return [resolved]
  } catch {
    // 原名解析不到，走后缀收集。
  }
  const candidates = []
  try {
    for (const candidate of loader.entries()) {
      const full = String(candidate?.id ?? '')
      if (full === id || full.endsWith(`:${id}`)) candidates.push(candidate)
    }
  } catch {
    // entries() 不可用时按条目不存在处理。
  }
  return candidates
}

/** 条目是否禁用。禁用与「读不出状态」分开：后者不能当成启用去提交。 */
function disabledState(entry) {
  try {
    if (entry?.disabled === true) return 'disabled'
    if (entry?.disabled === false) return 'enabled'
  } catch {
    return 'unknown'
  }
  const raw = entry?.options?.disabled
  if (raw === true) return 'disabled'
  if (raw === false || raw === undefined || raw === null) return 'enabled'
  // `!!js` 表达式等形态不在这里求值，交回调用方按未知处理。
  return 'unknown'
}

/**
 * 读出条目现有的 config，供合并提交。
 * `entry.options.config` 是 Loader 的唯一真源（entry.ts:52）。没有 config 是合法状态：
 * 这时条目本来就没有用户设过的键，按空对象合并即可，不必也不该跳过。
 */
function existingConfig(entry) {
  const config = entry?.options?.config
  return isPlainObject(config) ? config : {}
}

/**
 * 提交后读回服务侧实际生效值，与目标比对。
 *
 * 读回 null 记进 unverified 而不是 mismatched：装载期提交时 shell/subagents 的
 * volatile 值可能还没就绪，读不到不等于写失败。状态接口稍后读的是同一批值，
 * 那时还读不到才说明真没生效。
 */
function verifyApplied(ctx, id, service, expected, mismatched, unverified) {
  const limits = readRuntimeLimits(ctx)
  const actual = limits?.[service]
  for (const [key, want] of Object.entries(expected)) {
    const got = actual?.[key] ?? null
    if (got === null) {
      unverified.push(`${id}：${key} 目标 ${String(want)}，读回不可用`)
      continue
    }
    if (got !== want) mismatched.push(`${id}：${key} 目标 ${String(want)}，实际 ${String(got)}`)
  }
}

/**
 * 提交一个条目的预算键。
 *
 * @param {object} ctx - Cordis 上下文，需要它的 loader。
 * @param {string} id - 条目短名（`bash-sandbox` / `pwsh-sandbox` / `subagent`）。
 * @param {string} service - 读回实际值用的服务名（`shell` / `subagents`）。
 * @param {object} budgetKeys - 本次要覆盖的键。
 * @returns {Promise<{ applied: boolean, skipped: string | null, mismatched: string[], unverified: string[] }>}
 */
async function updateEntry(ctx, id, service, budgetKeys) {
  const skip = (reason) => ({ applied: false, skipped: `${id}：${reason}`, mismatched: [], unverified: [] })

  // 插件自己的 ctx.loader 指向它自己的子树，兄弟条目在那里解析不到；根 loader 才有整棵树。
  const loader = ctx?.root?.loader ?? ctx?.loader ?? ctx?.get?.('loader')
  if (loader === undefined || typeof loader.resolve !== 'function') return skip('宿主未暴露 loader')

  const candidates = findCandidates(loader, id)
  if (candidates.length === 0) return skip('条目不存在')
  if (candidates.length > 1) {
    const names = candidates.map((candidate) => String(candidate?.id)).join('、')
    return skip(`${String(candidates.length)} 个同后缀条目，无法确定目标（${names}）`)
  }

  const entry = candidates[0]
  if (entry === null || entry === undefined || typeof entry.update !== 'function') return skip('条目不可更新')

  const state = disabledState(entry)
  if (state === 'disabled') return skip('条目已禁用')
  if (state === 'unknown') return skip('无法确认条目是否禁用')

  try {
    await entry.update({ config: { ...existingConfig(entry), ...budgetKeys } })
  } catch (error) {
    return skip(`更新失败（${String(error?.message ?? error)}）`)
  }
  const mismatched = []
  const unverified = []
  verifyApplied(ctx, id, service, budgetKeys, mismatched, unverified)
  return { applied: true, skipped: null, mismatched, unverified }
}

/**
 * 把当前模式的执行层预算提交给宿主。
 *
 * 两个 shell 行都提交：bash-sandbox 在 win32 被禁用、pwsh-sandbox 只在 win32 挂载，
 * 只写一边总有一个平台拿不到。禁用的那一行按「条目已禁用」跳过，既不会生效，也不会
 * 被误记成已写入。
 *
 * @param {object} ctx - Cordis 上下文，需要它的 loader。
 * @param {string} mode - 补丁模式。
 * @returns {Promise<{ mode: string, applied: string[], skipped: string[], mismatched: string[], unverified: string[] }>}
 */
/**
 * 最近一次提交。结果与目标值放在同一个对象里，一次赋值——分两个变量写会在并发提交
 * 时错配，复核就会拿 A 的目标核 B 的结果。
 */
let lastSubmission = null

async function submitBudget(ctx, mode, budgets = MODE_BUDGETS) {
  const target = budgets[mode] ?? budgets.recommended
  const applied = []
  const skipped = []
  const mismatched = []
  const unverified = []
  const shellConfig = {
    timeoutMs: target.timeoutMs,
    maxTimeoutMs: target.maxTimeoutMs,
    maxOutputBytes: target.maxOutputBytes,
  }
  const plans = [
    ['bash-sandbox', 'shell', shellConfig],
    ['pwsh-sandbox', 'shell', shellConfig],
    ['subagent', 'subagents', { maxDepth: target.maxDepth }],
  ]
  for (const [id, service, budgetKeys] of plans) {
    const outcome = await updateEntry(ctx, id, service, budgetKeys)
    if (outcome.applied) applied.push(id)
    if (outcome.skipped !== null) skipped.push(outcome.skipped)
    mismatched.push(...outcome.mismatched)
    unverified.push(...outcome.unverified)
  }
  const budget = { mode, applied, skipped, mismatched, unverified }
  lastSubmission = { budget, targets: plans.map(([id, service, keys]) => [id, service, keys]) }
  return budget
}

/**
 * 用当前读数复核最近一次提交。
 *
 * `applyModeBudget` 在装载期跑，那时 volatile 值可能还没就绪，读回不可用的项会留在
 * `unverified` 里。状态读取时再核一遍：读得到的从 `unverified` 移除，读到但不相等的
 * 转进 `mismatched`，未提交的条目不核。目标值不进状态契约。
 *
 * @param {object} ctx - Cordis 上下文。
 * @returns {object|null} 复核后的结果；没提交过时 null。
 */
export function recheckBudget(ctx) {
  if (lastSubmission === null) return null
  const { budget, targets } = lastSubmission
  const mismatched = []
  const unverified = []
  for (const [id, service, expected] of targets) {
    if (!budget.applied.includes(id)) continue
    verifyApplied(ctx, id, service, expected, mismatched, unverified)
  }
  return { ...budget, mismatched, unverified }
}

/**
 * Loader 可见性的只读探针。诊断用：确认插件从哪个上下文拿到 loader、
 * 那个 loader 能看见哪些条目。挂到状态上，一次请求即可看清，不必再猜。
 */
export function describeLoader(ctx) {
  const out = { hasCtxLoader: false, hasRoot: false, hasRootLoader: false, entries: [], error: null }
  try {
    out.hasCtxLoader = typeof ctx?.loader?.resolve === 'function'
    out.hasRoot = ctx?.root !== undefined && ctx?.root !== null
    out.hasRootLoader = typeof ctx?.root?.loader?.resolve === 'function'
    const loader = ctx?.root?.loader ?? ctx?.loader
    if (typeof loader?.entries === 'function') {
      for (const entry of loader.entries()) {
        out.entries.push(String(entry?.id))
        if (out.entries.length >= 40) break
      }
    } else {
      out.error = 'loader.entries 不可用'
    }
  } catch (error) {
    out.error = String(error?.message ?? error)
  }
  return out
}


const tierSubmissions = new WeakMap()

function serializeBudget(ctx, run) {
  const owner = ctx.root ?? ctx
  const previous = tierSubmissions.get(owner) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(run)
  tierSubmissions.set(owner, pending)
  void pending.finally(() => { if (tierSubmissions.get(owner) === pending) tierSubmissions.delete(owner) }).catch(() => {})
  return pending
}

export function applyModeBudget(ctx, mode, budgets = MODE_BUDGETS) {
  return serializeBudget(ctx, () => submitBudget(ctx, mode, budgets))
}

/** 档位持久化与预算提交串行完成；结果不等同于预算已生效。 */
export function switchTier(ctx, home, tier, budgets = MODE_BUDGETS) {
  return serializeBudget(ctx, async () => {
    writeTier(home, tier)
    const budget = await submitBudget(ctx, tier, budgets)
    const failures = budget.skipped.filter(reason => !reason.endsWith('条目已禁用'))
    return { tier, budget, verified: failures.length === 0 && budget.mismatched.length === 0 && budget.unverified.length === 0 }
  })
}
