// 插件装配入口。业务判定、宿主接缝和各入口适配分别由专属模块负责。
import { resolveHome } from './patch/state.js'
import { ensureInitialState } from './context/rules.js'
import { registerSeams } from './host/seams.js'
import { applyModeBudget, resolveBudgets } from './host/capabilities.js'
import { promptMode, readMode } from './context/prompt.js'
import { registerCommands } from './host/commands.js'
import { registerTools } from './host/tools.js'
import { createHandler, ROUTE_PREFIX } from './serve/http.js'

export { deriveHostRoot, resolveHostRootInfo } from './host/host-root.js'
export { hardenInstructionText } from './host/seams.js'
export { appliedSummary, describePermissionLayers, formatStatusText } from './host/status.js'
export const name = 'rumo-dsh-breaklimit'
export const inject = ['systemPrompt']
// 行配置的 Standard Schema。宿主据此校验并补默认值，校验失败整条插件行不启动。
export { Config } from './plugin-config.js'

export function apply(ctx, config = {}) {
  const runtime = {
    enabled: config.enabled !== false,
    holder: undefined,
    httpMounted: false,
    counters: {
      approval: 0,
      escalation: 0,
      escalationRejected: 0,
      toolGate: 0,
      editIntent: 0,
      assemble: 0,
      preStep: 0,
      hardenHits: 0,
      hardenMisses: 0,
      maskHits: 0,
    },
    // 最近一次命中词表的时间与次数，状态接口据此判断「这轮有没有在起作用」。
    maskLast: { hits: 0, at: 0 },
  }
  const order = Number.isFinite(config.order) ? config.order : 8999

  // 规则首轮收拢。落点文件里已有内容却还没有任何规则时，把它导入成 default 并激活，
  // 一份已经存在的 AGENTS.md 不该因为装了插件就失去作用。
  //
  // 只读落点、只写插件自己的规则目录；内容与落点字节一致时不重写，落点文件本身不动，
  // 非 UTF-8 的落点不收拢、原样保留。失败也不影响装载：收拢失败最坏是规则面板空着，
  // 而抛出去会让整个插件装载失败。
  try {
    runtime.ensure = ensureInitialState(resolveHome())
  } catch (error) {
    runtime.ensure = { error: String(error?.message ?? error) }
  }

  // 执行层预算随模式提交：走 Loader 的 volatile 提交，条件不成立时会退回静态基线。
  // 预算值来自配置里的 budgets，缺省用内置两档。
  try {
    void applyModeBudget(ctx, readMode(resolveHome(), runtime), resolveBudgets(config))
  } catch (error) {
    runtime.configError = error.code ?? 'tier_config_unavailable'
  }

  registerSeams(ctx, config, runtime, order)
  registerCommands(ctx, config, runtime)
  registerTools(ctx, config, runtime)
  ctx.inject(['webServer'], (scope) => {
    const handler = createHandler(ctx, config, runtime)
    runtime.httpMounted = true
    scope.effect(() => scope.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))
  })
}
