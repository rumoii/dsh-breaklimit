// 插件配置：手写的 Standard Schema。
//
// 宿主在装载与热更新时调用 `Config['~standard'].validate`，校验不通过的整条插件行
// 不会启动（vendor/cordis 的 resolveConfig；见 DSH 的 docs/user/develop/basic/config）。
// 手写而不引 Schemastery：本插件从目录安装，没有 node_modules，多一个运行时依赖就多
// 一条解析路径。
//
// 未知键原样保留。`cordis.patch.yml` 里同一行可能带着别处写入的键，装载期拒绝会让宿主
// 起不来；已知键的类型写错则必须响亮失败。

/** 缺省值。行的 config 为空或没写某个键时用它。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  injectFile: '',
  hostRoot: '',
  allowedHosts: Object.freeze([]),
  order: 8999,
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function typeIssue(path, expected, seen) {
  return { message: `应为${expected}，实际是 ${Array.isArray(seen) ? '数组' : typeof seen}`, path: [path] }
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

  const value = { ...DEFAULTS, allowedHosts: [...DEFAULTS.allowedHosts] }
  const issues = []

  for (const [key, next] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      value[key] = next
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
