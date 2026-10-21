// 升级重建的前置对账。
//
// 宿主升级后要同时对齐四处：DSH_TARGET 的版本与提交、package.json 的 engines.dsh、
// 补丁锚点与命中数、以及 src/patch/hashes.json 的目标集合。这四处任何一处没跟上，
// 预检都会失配，但失配的表现全都长得一样——「整文件预哈希不符」。
// 分不清是「宿主变了」还是「哈希表没跟上」，就得在几十条 finding 里逐条猜。
//
// 这个工具先回答一个问题：这份哈希表还是给这棵树采的吗？只读，不写任何文件。
//
// 用法: node tools/reconcile.mjs <宿主根>
// 退出码: 0 一致；1 发现不一致；2 参数或环境错误。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { DSH_TARGET, PATCHES } from '../src/patch/index.js'
import { loadPatchHashes } from '../src/patch/hashes.js'

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HASHES_FILE = path.join(PACKAGE_ROOT, 'src', 'patch', 'hashes.json')

const hostRoot = (process.argv[2] ?? process.env.DSH_BREAKLIMIT_HOST_ROOT ?? '').trim()
if (hostRoot === '') {
  console.error('用法: node tools/reconcile.mjs <宿主根>')
  console.error('      npm run reconcile -- <宿主根>   # npm 需要 -- 才会把参数交给脚本')
  console.error('或设置环境变量 DSH_BREAKLIMIT_HOST_ROOT。')
  process.exit(2)
}

const short = (value) => String(value ?? '').slice(0, 12)

function git(args) {
  return execFileSync('git', ['-C', hostRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

let head
try {
  head = git(['rev-parse', 'HEAD'])
} catch (error) {
  console.error(`无法读取 ${hostRoot} 的 HEAD：${String(error?.message ?? error)}`)
  process.exit(2)
}

const problems = []
const lines = []

lines.push(`宿主根       ${hostRoot}`)
lines.push(`宿主 HEAD    ${head}`)
lines.push(`DSH_TARGET   ${DSH_TARGET.version} @ ${short(DSH_TARGET.commit)}`)

// 1) 哈希表是不是给这棵树采的。这是升级后最常见的错位：版本号改了、哈希忘了重采，
//    于是每一条目标都报"预哈希不符"，看起来像宿主动过源码。
let manifest = null
try {
  manifest = JSON.parse(fs.readFileSync(HASHES_FILE, 'utf8'))
} catch {
  manifest = null
}
if (manifest === null) {
  problems.push('src/patch/hashes.json 读不出或格式不对，预检会退回弱判定。跑 tools/collect-hashes.mjs 重新生成。')
} else {
  const recorded = manifest.dsh ?? {}
  lines.push(`哈希表       ${String(recorded.version ?? '缺失')} @ ${short(recorded.commit)}（采集于 ${String(manifest.generatedAt ?? '未知')}）`)
  if (recorded.commit !== head) {
    problems.push(`哈希表不是给这棵树采的：记录 commit ${short(recorded.commit)}，宿主 HEAD ${short(head)}。先重采哈希，再用任何失配下结论。`)
  }
  if (recorded.version !== DSH_TARGET.version) {
    problems.push(`哈希表版本 ${String(recorded.version ?? '缺失')} 与 DSH_TARGET ${DSH_TARGET.version} 不一致。`)
  }
}

// 2) 锚点声明的提交与当前宿主是否同一份。
if (DSH_TARGET.commit !== head) {
  problems.push(`DSH_TARGET.commit ${short(DSH_TARGET.commit)} 与宿主 HEAD ${short(head)} 不一致；补丁锚点可能已漂移。`)
}

// 3) 包内版本声明与 DSH_TARGET 是否一致。两处各写一遍就必须互相校验。
let pkg = null
try {
  pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
} catch {
  pkg = null
}
if (pkg === null) {
  problems.push('package.json 读不出来，无法核对 engines.dsh。')
} else if (pkg.engines?.dsh !== DSH_TARGET.version) {
  problems.push(`package.json 的 engines.dsh（${String(pkg.engines?.dsh ?? '缺失')}）与 DSH_TARGET（${DSH_TARGET.version}）不一致。`)
}

// 4) 目标集合必须双向覆盖：声明里有而哈希表没有，预检会以"没有预哈希记录"阻断；
//    哈希表里有而声明没有，说明有人删了补丁却留着哈希，旧记录会误导下一次排查。
const declared = new Map(PATCHES.map((patch) => [patch.id, new Set(patch.targets.map((target) => target.path))]))
const hashed = loadPatchHashes()
if (hashed === null) {
  problems.push('哈希表加载失败，无法核对目标集合。')
} else {
  let targetCount = 0
  for (const [id, paths] of declared) {
    targetCount += paths.size
    const recorded = hashed[id]
    if (recorded === undefined) {
      problems.push(`补丁 ${id} 有声明但哈希表里没有任何记录。`)
      continue
    }
    const recordedPaths = new Set(Object.keys(recorded))
    for (const targetPath of paths) {
      if (!recordedPaths.has(targetPath)) problems.push(`补丁 ${id} 的目标 ${targetPath} 不在哈希表里。`)
    }
    for (const targetPath of recordedPaths) {
      if (!paths.has(targetPath)) problems.push(`哈希表里补丁 ${id} 多出目标 ${targetPath}，声明中已没有它。`)
    }
  }
  for (const id of Object.keys(hashed)) {
    if (!declared.has(id)) problems.push(`哈希表里有补丁 ${id}，声明中已不存在。`)
  }
  lines.push(`目标集合     ${String(declared.size)} 条补丁，${String(targetCount)} 个目标`)
}

for (const line of lines) console.log(line)
console.log('')

if (problems.length === 0) {
  console.log('对账通过：声明、哈希表与宿主是同一份版本。')
  process.exit(0)
}

console.log(`对账未通过，${String(problems.length)} 个问题：`)
for (const problem of problems) console.log(`  ${problem}`)
process.exit(1)
