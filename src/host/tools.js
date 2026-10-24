// 模型工具适配层。与斜杠命令共用同一套应用服务与状态字段。
import { resolveHome } from '../patch/state.js'
import { revertPatches } from '../patch/transaction.js'
import { applySelectedPatches } from '../patch/service.js'
import { resolveHostRoot } from './host-root.js'
import { promptMode, readMode } from '../context/prompt.js'
import { buildStatus, formatOperationText, formatStatusText } from './status.js'
import { formatGuard, inspectTarget } from './guard.js'

export function registerTools(ctx, config, runtime) {
  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'breaklimit_status',
      description: '查看 rumo-dsh-breaklimit 的真实状态：宿主根、补丁预检结论、接缝去向、注入文件与规则。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      execute(_args, exec) {
        runtime.holder = exec
        return formatStatusText(buildStatus(ctx, config, runtime))
      },
    })

    scope.tools.register({
      name: 'breaklimit_apply',
      description: '对宿主执行补丁预检并应用。预检不通过时不写入任何文件。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      execute(_args, exec) {
        runtime.holder = exec
        const root = resolveHostRoot(config)
        if (root === null) return '未配置宿主根，无法执行。设置 hostRoot 或 DSH_BREAKLIMIT_HOST_ROOT。'
        const home = resolveHome()
        const result = applySelectedPatches({ root, home, mode: readMode(resolveHome(), runtime) })
        return formatOperationText(result)
      },
    })

    scope.tools.register({
      name: 'breaklimit_revert',
      description: '把宿主恢复到应用前的状态。任一目标文件偏离应用后哈希时整体拒绝。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      execute(_args, exec) {
        runtime.holder = exec
        const root = resolveHostRoot(config)
        if (root === null) return '未配置宿主根，无法执行。设置 hostRoot 或 DSH_BREAKLIMIT_HOST_ROOT。'
        return formatOperationText(revertPatches({ root, home: resolveHome() }))
      },
    })


    // 危险操作预检：读路径规模、是否在 git 仓库、有无未提交改动。只读，不改任何文件。
    scope.tools.register({
      name: 'breaklimit_guard',
      description: '删除、覆盖或推送前先看影响面：目标路径的文件数、总字节、是否在工作区内、是否 git 仓库、有多少未提交改动。只读。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '要预检的文件或目录路径' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      execute(args, exec) {
        runtime.holder = exec
        try {
          return formatGuard(inspectTarget({ target: args?.target }))
        } catch (error) {
          return `预检失败：${String(error?.message ?? error)}`
        }
      },
    })
  })

}
