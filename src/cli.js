#!/usr/bin/env node
// breaklimit 命令行入口。
//
// 与插件内命令、HTTP 接口共用同一套引擎，不复制任何判定逻辑：命令行里
// 看到的预检结论与设置页看到的必须逐字相同，否则两处会各自演化出不同的
// "已生效"定义。
//
// 用法:
//   breaklimit --status           显示真实状态与预检结论
//   breaklimit --apply            预检通过后应用当前选择的补丁
//   breaklimit --revert           漂移检查通过后回退
//   breaklimit --edit             打开注入文件
//   breaklimit --rules            列出用户规则
//   breaklimit --help             显示本说明
//
// 宿主根来自 --host-root → DSH_BREAKLIMIT_HOST_ROOT → profile 的装配补丁 → 本包的
// src/bundle.yml。最后一级是必须的：插件自己的 config 就写在那个文件的 insert 行里，
// 文档让人只填一次，那命令行就得读到同一处。不推导：CLI 的进程入口是它自己，判不出
// 宿主源码树，而拿当前目录猜会让预检对着错误的树做判断，然后报一个看起来很像成功的结论。

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DSH_TARGET } from './patch/index.js'
import { inspectPatches, applySelectedPatches } from './patch/service.js'
import { readTextOrNull, sizeOf } from './patch/fsx.js'
import { resolveHome, transactionsDir } from './patch/state.js'
import { revertPatches } from './patch/transaction.js'
import * as rules from './context/rules.js'
import { TIERS, isValidTier, readTier, resolveTierInfo, writeTier } from './context/tiers.js'
import { promptMode, readMode, readModeExtension } from './context/prompt.js'

/** 本包根目录。CLI 的入口在 bin/ 下，向上一级即包根。 */
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const HELP = `breaklimit —— rumo-dsh-breaklimit 命令行

  --status              显示预检结论、应用记录、注入文件与规则
  --apply               预检通过后应用当前选择的补丁（不通过则零写入）
  --revert              回退到应用前状态（任一文件漂移则整体拒绝）
  --doctor              检查运行环境与依赖，输出就地诊断指引
  --tier [模式]         查看或切换提示词模式（recommended / unrestricted）
  --edit                用系统编辑器打开注入文件
  --rules               列出用户规则
  --host-root <路径>    指定宿主根，等价于 DSH_BREAKLIMIT_HOST_ROOT
  --help                显示本说明

一次只接受一个动作：--status --apply 这类组合被拒绝并以退出码 2 结束，
不按书写顺序取最后一个执行。未知参数同样报错退出（退出码 2）并指出参数
本身；--host-root、--tier 后面的取值不算未知参数。

退出码：
  0  动作成功，或 --status 预检通过
  1  执行失败或恢复信息不可读：预检阻断、漂移拒绝、非法档位、诊断有失败项、
     apply/revert 失败，以及「应用记录不可读」导致的预检跳过
  2  参数错误（未知参数、多个动作）或宿主根未配置（--status 因此跳过预检）
两种预检跳过都不以 0 退出：跳过 ≠ 通过，脚本只认 0。

环境：
  DSH_BREAKLIMIT_HOST_ROOT   宿主根的绝对路径
  DSH_HOME                   DSH 主目录，默认 ~/.dsh
`

/**
 * 解析参数。
 *
 * 兜底分支记录第一个无法识别的参数（含拼错的 --flag 与多余的位置参数）：此前
 * 它们被静默忽略，最后打印帮助、退出 0，与 --help 不可区分，脚本会当成成功。
 * 参数值不算未知参数：--host-root 无条件吞掉下一个参数、--tier 吞掉不以 - 开头
 * 的下一个参数，两者都在 index 递增后跳过，不再落回这个分支。
 *
 * actions 记录出现过的动作（去重保序）：此前 out.action 被后写的动作覆盖，
 * `--status --apply` 实际只跑 apply——可能是破坏性动作。多个动作的拒绝在 run 里
 * 做，退出策略属于调用方。
 */
function parseArgs(argv, env) {
  const out = {
    action: null,
    actions: [],
    hostRoot: env.DSH_BREAKLIMIT_HOST_ROOT ?? null,
    tier: null,
    session: null,
    taskId: null,
    format: 'md',
    outFile: null,
    unknown: null,
  }
  const takeAction = (name) => {
    out.action = name
    if (!out.actions.includes(name)) out.actions.push(name)
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') takeAction('help')
    else if (arg === '--status') takeAction('status')
    else if (arg === '--apply') takeAction('apply')
    else if (arg === '--revert') takeAction('revert')
    else if (arg === '--doctor') takeAction('doctor')
    else if (arg === '--tier') {
      takeAction('tier')
      const next = argv[index + 1]
      if (next && !next.startsWith('-')) {
        index += 1
        out.tier = next
      }
    } else if (arg.startsWith('--tier=')) {
      takeAction('tier')
      out.tier = arg.slice('--tier='.length)
    } else if (arg === '--edit') takeAction('edit')
    else if (arg === '--rules') takeAction('rules')
    else if (arg === '--host-root') {
      index += 1
      out.hostRoot = argv[index] ?? null
    } else if (arg.startsWith('--host-root=')) {
      out.hostRoot = arg.slice('--host-root='.length)
    } else if (out.unknown === null) {
      out.unknown = arg
    }
  }
  return out
}

function injectPath(env) {
  return path.join(resolveHome(env), 'breaklimit-inject.md')
}

/**
 * 从一份装配补丁文本里取出本插件的 hostRoot。
 *
 * 只认自己那一段：先确认文本里出现了本包名，再用正则取 hostRoot。不做完整 YAML
 * 解析——失配时返回 null 让调用方按"没配"处理，而不是猜一个路径。空值同样返回
 * null：`hostRoot: ''` 就是没填。
 */
export function hostRootFromPatchText(text) {
  if (typeof text !== 'string' || !text.includes('rumo-dsh-breaklimit')) return null
  const matched = /^[ \t]*hostRoot:[ \t]*['"]?([^'"\r\n]+?)['"]?[ \t]*$/mu.exec(text)
  if (matched === null) return null
  const value = matched[1].trim()
  return value === '' ? null : value
}

/** 扫 profile 目录下的装配补丁。 */
function resolveHostRootFromProfile(home) {
  let names
  try {
    names = fs.readdirSync(path.join(home, 'profiles'))
  } catch {
    return null
  }
  for (const name of names) {
    let text
    try {
      text = fs.readFileSync(path.join(home, 'profiles', name, 'cordis.patch.yml'), 'utf8')
    } catch {
      continue
    }
    const found = hostRootFromPatchText(text)
    if (found !== null) return found
  }
  return null
}

/**
 * 读本包 `src/bundle.yml` 里的宿主根。
 *
 * 插件加载这个文件时，`insert` 行的 config 就是它的 config，所以填在这里插件一定
 * 读得到；命令行此前读不到，文档那句"插件与命令行都读得到"因此在 CLI 这一侧是假的。
 * 补上这一级之后那句话才成立。
 */
export function resolveHostRootFromPackage(packageRoot = PACKAGE_ROOT) {
  return hostRootFromPatchText(readTextOrNull(path.join(packageRoot, 'src', 'bundle.yml')))
}

/**
 * 按优先级解析宿主根，取不到返回 null。
 *
 * 解析只有这一份实现。此前 runStatus 与 requireHostRoot 各写了一套，于是刚补上的
 * "读本包装配补丁"那一级只进了其中一套，`--status` 照旧报未配置——文档与行为对不
 * 上的表象，根因是同一件事有两个说法。
 *
 * 不在这里退出：`--status` 必须在未配置时也能打印状态，退出策略属于调用方。
 */
function findHostRoot(hostRoot, env) {
  if (typeof hostRoot === 'string' && hostRoot.trim() !== '') return hostRoot.trim()
  const fromEnv = env.DSH_BREAKLIMIT_HOST_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const fromProfile = resolveHostRootFromProfile(resolveHome(env))
  if (fromProfile !== null) return fromProfile
  return resolveHostRootFromPackage()
}

function requireHostRoot(hostRoot, env) {
  const found = findHostRoot(hostRoot, env)
  if (found !== null) return found
  process.stderr.write(
    '未配置宿主根。用 --host-root <路径>、设置 DSH_BREAKLIMIT_HOST_ROOT，'
    + '或把它写进 profile 或本包的 src/bundle.yml（插件侧还会从宿主进程推导，命令行不推导）。\n',
  )
  process.exit(2)
}

function formatFindings(findings) {
  const labels = {
    applied: '已应用',
    pending: '待应用',
    conflict: '冲突',
    missing: '缺失',
    satisfied: '已满足',
    unsatisfied: '未满足',
  }
  return findings.map((item) => {
    const label = labels[item.state] ?? item.state
    return `  ${item.patchId}  ${label}  ${String(item.hits)}/${String(item.expected)}  ${item.path}`
  })
}

function report(result) {
  process.stdout.write(`${result.message}\n`)
  if (Array.isArray(result.written) && result.written.length > 0) {
    process.stdout.write(`写入：\n${result.written.map(item => `  ${item}\n`).join('')}`)
  }
  if (Array.isArray(result.restored) && result.restored.length > 0) {
    process.stdout.write(`回退：\n${result.restored.map(item => `  ${item}\n`).join('')}`)
  }
  if (Array.isArray(result.drifted) && result.drifted.length > 0) {
    process.stdout.write(`漂移：\n${result.drifted.map(item => `  ${item.path}  ${item.reason}\n`).join('')}`)
  }
  if (Array.isArray(result.blocked) && result.blocked.length > 0) {
    process.stdout.write(`阻断：\n${result.blocked.map(item => `  ${item.patchId}  ${item.path}  ${item.reason}\n`).join('')}`)
  }
}

function runStatus(options, env) {
  const home = resolveHome(env)
  const file = injectPath(env)
  const hostRoot = findHostRoot(options.hostRoot, env)
  const { state: loaded, preflight: result } = inspectPatches({ root: hostRoot, home, mode: readMode(home) })

  process.stdout.write(`rumo-dsh-breaklimit\n`)
  process.stdout.write(`  目标宿主    ${DSH_TARGET.version} @ ${DSH_TARGET.commit.slice(0, 12)}\n`)
  process.stdout.write(`  DSH_HOME    ${home}\n`)
  process.stdout.write(`  宿主根      ${hostRoot === null || hostRoot === undefined || String(hostRoot).trim() === '' ? '未配置（补丁状态无法判定）' : String(hostRoot)}\n`)
  process.stdout.write(`  注入文件    ${file}（${String(sizeOf(file))} 字节，用户文件${sizeOf(file) > 0 ? '存在' : '不存在，回退包内默认'}）\n`)

  const defaultInject = readTextOrNull(path.join(PACKAGE_ROOT, 'src', 'context', 'inject.md')) ?? ''
  const userText = readTextOrNull(file)
  const baseText = userText !== null && userText.trim() !== '' ? userText : defaultInject
  // 头部正文 = 共用正文 + 该档附加段。漏掉附加段，这里的字节数会比状态页与 POST /tier
  // 少一整段，同一状态两个数。
  const tierInfo = resolveTierInfo(home, baseText, readModeExtension(readMode(home)))
  process.stdout.write(`  提示词档位  ${tierInfo.tier}（可选：${tierInfo.available.join('/')}，${String(tierInfo.bytes)} 字节）\n`)
  if (tierInfo.kind === 'corrupt') {
    process.stdout.write(`  档位问题    tier_config_corrupt：tier.json 读不出或内容非法，当前按缺省档 ${tierInfo.tier} 生效\n`)
  }

  if (loaded.kind === 'ok') {
    process.stdout.write(`  应用记录    ${loaded.state.operationId}（${String(Object.keys(loaded.state.files).length)} 个文件，阶段 ${loaded.state.phase ?? 'committed'}）\n`)
  } else if (loaded.kind === 'absent') {
    process.stdout.write('  应用记录    无\n')
  } else {
    process.stdout.write(`  应用记录    ${loaded.kind}：恢复信息不可信，先处理 state.json\n`)
  }

  // 事务目录会随每次 apply/revert 增长（每个目录带着全部目标的原文快照）。
  // 报出来让增长看得见：数量卡在保留上限说明清理在跑，一路涨说明没跑。
  const txnRoot = transactionsDir(home)
  let txnCount = 0
  try {
    txnCount = fs.readdirSync(txnRoot)
      .filter((name) => fs.statSync(path.join(txnRoot, name)).isDirectory())
      .length
  } catch {
    // 还没有任何事务，计数就是 0。
  }
  process.stdout.write(`  事务目录    ${String(txnCount)} 个\n`)

  const active = rules.readActive(home)
  const listed = rules.listRules(home)
  process.stdout.write(`  激活规则    ${active ?? '无'}\n`)
  process.stdout.write(`  用户规则    ${String(listed.length)} 份\n`)
  for (const rule of listed) {
    process.stdout.write(`    ${rule.active ? '*' : ' '} ${rule.id} → ${rule.target}  ${String(rule.bytes)} 字节  ${rule.name}\n`)
  }

  if (hostRoot === null || hostRoot === undefined || String(hostRoot).trim() === '') {
    // 跳过不是通过。这里曾经 return 0，脚本于是把「没做预检」读成「预检通过」。
    // 口径与下面「应用记录不可读」的跳过对齐：跳过一律非 0，宿主根未配置是
    // 参数/配置类问题，用 2。
    process.stdout.write('  补丁预检    跳过（宿主根未配置）：预检被跳过 ≠ 通过，不得据此判为通过\n')
    return 2
  }
  if (loaded.kind === 'corrupt' || loaded.kind === 'version_mismatch') {
    process.stdout.write('  补丁预检    跳过（应用记录不可读）\n')
    return 1
  }

  process.stdout.write(`  补丁预检    ${result.ok ? '通过' : '阻断'}，待写入 ${String(result.pendingFiles)} 个文件\n`)
  process.stdout.write(`${formatFindings(result.findings).join('\n')}\n`)
  for (const item of result.blocked) {
    process.stdout.write(`    阻断 ${item.patchId}  ${item.path}  ${item.reason}\n`)
  }
  return result.ok ? 0 : 1
}

/**
 * 探测外部命令，返回去掉首尾空白的输出，取不到返回 null。
 *
 * 单拎出来是为了让 `--doctor` 的测试不依赖 runner 上恰好装了什么：pnpm 在 GitHub
 * Actions 的 runner 上不存在，命令一走真实 PATH，那条「全部 PASS」的用例就必红。
 * 测试传一个桩进去，本机与 CI 的结论才一致。
 *
 * Windows 上 pnpm 是 `.cmd` 脚本，`execFileSync` 直接跑不了，要过一层 `cmd.exe`。
 * 这个平台差异留在默认实现里，调用方只关心「命令能不能跑、输出了什么」。
 *
 * @param {Record<string, string | undefined>} childEnv - 子进程环境变量。
 * @returns {(bin: string, args: string[]) => string | null}
 */
function makeProbe(childEnv) {
  return (bin, args) => {
    const viaShell = process.platform === 'win32' && bin === 'pnpm'
    const file = viaShell ? 'cmd.exe' : bin
    const argv = viaShell ? ['/d', '/s', '/c', `${bin} ${args.join(' ')}`] : args
    try {
      const text = execFileSync(file, argv, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env: childEnv,
      }).trim()
      return text === '' ? null : text
    } catch {
      return null
    }
  }
}

/**
 * 环境诊断。
 *
 * @param {object} options - 命令行参数。
 * @param {Record<string, string | undefined>} env - 环境变量。
 * @param {{ probe?: (bin: string, args: string[]) => string | null }} [deps] - 注入点，仅测试使用。
 * @returns {number} 全部通过为 0，有失败项为 1。
 */
function runDoctor(options, env, deps = {}) {
  const lines = ['breaklimit 环境诊断 (--doctor)\n']
  let failCount = 0
  const childEnv = { ...process.env, ...env }
  const probe = deps.probe ?? makeProbe(childEnv)

  // 1. Node.js 版本
  const nodeVer = process.versions.node
  const [major, minor] = nodeVer.split('.').map(Number)
  const nodeOk = (major === 22 && minor >= 19) || major >= 24
  if (nodeOk) {
    lines.push(`  [PASS] Node.js 运行时：v${nodeVer}（满足 >=22.19.0 || >=24.0.0）`)
  } else {
    failCount += 1
    lines.push(`  [FAIL] Node.js 运行时：v${nodeVer}（要求 >=22.19.0 || >=24.0.0）`)
    lines.push('         修复指引：请升级 Node.js 至 22.19.0+ 或 24.0.0+（官方下载：https://nodejs.org）')
  }

  // 2. pnpm 可用性
  const pnpmVer = probe('pnpm', ['--version'])
  if (pnpmVer) {
    lines.push(`  [PASS] pnpm 包管理器：v${pnpmVer}`)
  } else {
    failCount += 1
    lines.push('  [FAIL] pnpm 包管理器：未找到 pnpm 命令')
    lines.push('         修复指引：请运行 npm i -g pnpm 或 corepack enable 安装 pnpm')
  }

  // 3. git 可用性
  const gitVer = probe('git', ['--version'])
  if (gitVer) {
    lines.push(`  [PASS] git 版本控制：${gitVer}`)
  } else {
    failCount += 1
    lines.push('  [FAIL] git 版本控制：未找到 git 命令')
    lines.push('         修复指引：请安装 Git 并将其加入系统 PATH 环境变量')
  }


  // 4. 宿主源码根
  const hostRoot = findHostRoot(options.hostRoot, env)
  if (!hostRoot || !fs.existsSync(hostRoot)) {
    failCount += 1
    lines.push(`  [FAIL] 宿主源码根：${hostRoot ? `目录不存在 (${hostRoot})` : '未配置'}`)
    lines.push('         修复指引：请设置环境变量 $env:DSH_BREAKLIMIT_HOST_ROOT="D:\\你的目录\\deepseek-harness" 或使用 --host-root')
  } else {
    const hasMarker = fs.existsSync(path.join(hostRoot, 'package.json')) || fs.existsSync(path.join(hostRoot, 'apps', 'cli', 'src'))
    if (!hasMarker) {
      failCount += 1
      lines.push(`  [FAIL] 宿主源码根：目录缺少宿主结构 (${hostRoot})`)
      lines.push('         修复指引：请确认该路径是 deepseek-harness 源码仓库目录')
    } else {
      // HEAD 读不到只影响展示，不算失败项：目录结构对了就说明路径选对了。
      const headShort = probe('git', ['-C', hostRoot, 'rev-parse', '--short', 'HEAD'])
      lines.push(`  [PASS] 宿主源码根：${hostRoot}${headShort ? ` (HEAD: ${headShort})` : ''}`)
    }
  }

  // 5. 宿主依赖。源码版要能跑起来，`node_modules` 必须在；缺了它后面每一步都会
  // 报「找不到 tsx」，那是 FAQ 里最常见的一条，放在最前面比让人自己找强。
  if (hostRoot && fs.existsSync(hostRoot)) {
    const depsInstalled = fs.existsSync(path.join(hostRoot, 'node_modules'))
    if (depsInstalled) {
      lines.push('  [PASS] 宿主依赖：已安装 node_modules')
    } else {
      failCount += 1
      lines.push(`  [FAIL] 宿主依赖：${hostRoot} 下没有 node_modules`)
      lines.push('         修复指引：在宿主根执行 pnpm install，装完再回来重跑 --doctor')
    }
  }

  // 6. DSH 数据目录与 profile
  const home = resolveHome(env)
  const profileDir = path.join(home, 'profiles', 'web-breaklimit')
  const profilePkg = path.join(profileDir, 'package.json')
  let manifest = null
  if (fs.existsSync(profilePkg)) {
    try {
      manifest = JSON.parse(fs.readFileSync(profilePkg, 'utf8'))
    } catch {
      manifest = null
    }
  }
  if (!fs.existsSync(profileDir)) {
    failCount += 1
    lines.push(`  [FAIL] DSH 数据目录：未找到 web-breaklimit 配置目录 (${profileDir})`)
    lines.push('         修复指引：请确认宿主已完成初始化，或先运行一次：./dsh.ps1 --profile web-breaklimit')
  } else {
    lines.push(`  [PASS] DSH 数据目录：${home} (已发现 web-breaklimit profile)`)
  }

  // 7. Web 组合。profile 里少了 web-app，宿主起得来但设置页没有入口，光看日志
  // 看不出是少了 bundle。
  if (fs.existsSync(profileDir)) {
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    if (bundles.includes('@deepseek-ai/dsh-web-app')) {
      lines.push('  [PASS] Web 组合：profile 的 bundles 含 @deepseek-ai/dsh-web-app')
    } else {
      failCount += 1
      lines.push('  [FAIL] Web 组合：profiles/web-breaklimit 的 dsh.profile.bundles 缺少 @deepseek-ai/dsh-web-app')
      lines.push('         修复指引：按安装说明补齐 Web bundle，或对该 profile 重跑一次 --from-default-profile web')
    }
  }

  // 8. 插件依赖注入状态
  const depOk = Boolean(manifest?.dependencies?.['rumo-dsh-breaklimit'])
  if (depOk) {
    lines.push('  [PASS] 插件注册状态：profiles/web-breaklimit 已声明依赖 rumo-dsh-breaklimit')
  } else if (fs.existsSync(profileDir)) {
    failCount += 1
    lines.push('  [FAIL] 插件注册状态：profiles/web-breaklimit/package.json 尚未声明 rumo-dsh-breaklimit 依赖')
    lines.push('         修复指引：请在 profiles/web-breaklimit/package.json 的 dependencies 中添加 "rumo-dsh-breaklimit"')
  }

  lines.push('')
  if (failCount === 0) {
    lines.push('诊断完成：全部检查项通过。\n')
  } else {
    lines.push(`诊断完成：发现 ${String(failCount)} 处环境问题，请根据上述修复指引处理。\n`)
  }
  process.stdout.write(lines.join('\n'))
  return failCount === 0 ? 0 : 1
}

function runEdit(env) {
  const file = injectPath(env)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '', 'utf8')
    process.stdout.write(`已创建空注入文件：${file}\n`)
  }
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? (process.platform === 'win32' ? 'notepad' : 'vi')
  const child = spawn(editor, [file], { stdio: 'inherit', detached: false })
  child.on('error', (error) => {
    process.stderr.write(`无法启动编辑器 ${editor}：${String(error.message)}\n文件位于：${file}\n`)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 0
  })
  return null
}

/**
 * 命令行主流程。
 *
 * 导出成函数是为了让测试能直接调用它——CLI 曾经完全没有测试，于是一个被删除的
 * 函数在这里留了调用点，`--apply` 一跑就抛 ReferenceError，直到验收才发现。
 * 环境变量作为参数传入而不是直接读 process.env，测试才能指向临时 DSH_HOME。
 *
 * @param {string[]} argv - 不含 node 与脚本名的参数。
 * @param {Record<string, string | undefined>} env - 环境变量。
 * @param {{ probe?: (bin: string, args: string[]) => string | null }} [deps] - 外部命令探测的注入点，测试用。
 * @returns {number | null} 退出码；null 表示不需要设置（例如 --edit 交给子进程）。
 */
export function run(argv, env = process.env, deps = {}) {
  const options = parseArgs(argv, env)
  const home = resolveHome(env)

  // 参数错误先于一切动作：报错并以 2 结束，任何动作都不执行。
  if (options.unknown !== null) {
    process.stderr.write(`未知参数 ${options.unknown}：不执行任何动作。可用参数见 --help。\n`)
    return 2
  }
  if (options.actions.length > 1) {
    const given = options.actions.map(name => `--${name}`).join('、')
    process.stderr.write(`一次只接受一个动作：${given} 同时给出，不执行任何动作。可用参数见 --help。\n`)
    return 2
  }

  if (options.action === null || options.action === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  if (options.action === 'doctor') return runDoctor(options, env, deps)
  if (options.action === 'status') return runStatus(options, env)
  if (options.action === 'tier') {
    const targetTier = options.tier
    if (!targetTier) {
      const current = readTier(home)
      process.stdout.write(`当前提示词档位：${current.tier}（可选：${TIERS.join(', ')}）\n`)
      return 0
    }
    if (!isValidTier(targetTier)) {
      process.stderr.write(`非法档位 "${targetTier}"。可选：${TIERS.join(', ')}\n`)
      return 1
    }
    writeTier(home, targetTier)
    process.stdout.write(`提示词档位已切换至 "${targetTier}"。\n`)
    return 0
  }
  if (options.action === 'rules') {
    const listed = rules.listRules(home)
    if (listed.length === 0) {
      process.stdout.write('规则目录为空。\n')
      return 0
    }
    for (const rule of listed) {
      process.stdout.write(`${rule.active ? '*' : ' '} ${rule.id} → ${rule.target}  ${String(rule.bytes)} 字节  ${rule.name}\n`)
    }
    return 0
  }
  if (options.action === 'edit') return runEdit(env)

  const root = requireHostRoot(options.hostRoot, env)
  if (options.action === 'apply') {
    const result = applySelectedPatches({ root, home, mode: readMode(home) })
    report(result)
    return result.ok ? 0 : 1
  }
  if (options.action === 'revert') {
    const result = revertPatches({ root, home })
    report(result)
    return result.ok ? 0 : 1
  }
  process.stdout.write(HELP)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const code = run(process.argv.slice(2))
  if (typeof code === 'number') process.exitCode = code
}
