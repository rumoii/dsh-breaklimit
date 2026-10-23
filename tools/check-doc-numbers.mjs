// 文档数字守卫。
//
// verify.md 里写死了测试数、pass 数、扫描文件数和语言检查计数。这类数字每次增补
// 代码都会变，靠人盯着必然漂移——实际上它已经漂过好几轮（140/163/166/170、
// 28/32/33），而验收文档里的数字是判据：写错的判据会把正常状态读成异常。
//
// 这个工具实际跑一遍门禁，拿真实计数去比对文档，对不上就失败。它自己跑，
// 不依赖上游脚本传参——npm 脚本之间传不了值，重跑一遍是最诚实的做法。
//
// 一条规则在当前文档上一处也匹配不到，同样算失败：空转的规则永远不可能报错，
// 等于这条检查不存在。加规则时先确认它在今天的文档上真的命中。
//
// 声明层数字守卫：verify.md 还写了「5 条补丁、10 个声明目标（推荐模式启用 4 条）」，
// 此前无守卫会静默漂。这三处能从 src/patch/index.js 静态推导，判据直接取
// PATCHES / targetPaths() / patchesForMode('recommended')，不把数字抄成第二份
// 事实来源。
//
// 同一段里没守的数字与原因：
//   「12 条结果 / 11 条结果、待写入 10 个文件 / 9 个文件」是 tools/selfcheck.mjs 对
//   从宿主 HEAD 导出的干净夹具实跑预检的输出（findings 与 changes 计数），值叠着
//   「目标存在于宿主 HEAD、版本干净」这些前提；按声明层推导值来守，等于把夹具实跑
//   行为钉成第二份事实来源，宿主或自检口径一变就假报。
//   「8 项能力断言」的清单在 tools/selfcheck.mjs 的 capabilities 里，属于宿主能力
//   域、随宿主演化，不是补丁声明的数字。这几处漂了由实跑 npm run check:host 核对。
//
// 退出码: 0 一致；1 不一致、规则空转、或读不到真实计数/文档。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PATCHES, patchesForMode, targetPaths } from '../src/patch/index.js'

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(args) {
  try {
    return execFileSync(process.execPath, args, {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    // 门禁失败时 stdout 里仍有计数行，返回它，让这里的报错指向文档而不是测试本身。
    return String(error?.stdout ?? '')
  }
}

/**
 * 声明层数字的判据，直接从补丁声明推导，不抄文档里的数字。
 *
 * @returns {{patches: number, targets: number, recommendedPatches: number}}
 */
export function declarationCounts() {
  return {
    patches: PATCHES.length,
    targets: targetPaths().length,
    recommendedPatches: patchesForMode('recommended').length,
  }
}

/** docs/verify.md 声明层数字的规则（补丁条数、声明目标数、推荐档启用数）。 */
export function declarationRules(declaration = declarationCounts()) {
  return [
    { pattern: /当前声明为 (\d+) 条补丁/g, expected: declaration.patches, label: '补丁条数' },
    { pattern: /(\d+) 个声明目标/g, expected: declaration.targets, label: '声明目标数' },
    { pattern: /推荐模式启用 (\d+) 条/g, expected: declaration.recommendedPatches, label: '推荐档启用数' },
  ]
}

/**
 * docs/verify.md 的完整规则集：既有 4 类（测试数/pass/扫描文件/语言键引用）
 * 加声明层数字。既有 4 类的模式与判定保持原样。
 */
export function docNumberRules(counts) {
  return [
    { pattern: /^(\d+) 项，覆盖/gm, expected: counts.tests, label: '测试数' },
    { pattern: /tests (\d+) \/ pass/g, expected: counts.tests, label: 'tests 计数' },
    { pattern: /pass (\d+) \/ fail/g, expected: counts.passes, label: 'pass 计数' },
    { pattern: /接口一致性检查通过（(\d+) 个文件）/g, expected: counts.scannedFiles, label: '扫描文件数' },
    {
      pattern: /语言检查验证 (\d+) 个语言键及 (\d+) 处引用/g,
      expected: [counts.clientKeys, counts.clientRefs],
      label: ['语言键数', '语言引用数'],
    },
    ...declarationRules(),
  ]
}

/**
 * 一条规则可以带多个捕获组：expected 与 label 写成数组，按顺序对应第 1、2…组。
 * 单个捕获组直接用标量。匹配 0 次不是通过，是规则空转，记一条问题。
 *
 * @param {string} text - 文档全文。
 * @param {Array<{pattern: RegExp, expected: number | number[], label: string | string[]}>} rules
 * @param {string} [relative] - 报错里用的文件名。
 * @returns {string[]} 问题列表，空数组表示一致。
 */
export function checkText(text, rules, relative = '文档') {
  const problems = []
  for (const { pattern, expected, label } of rules) {
    const expectedList = Array.isArray(expected) ? expected : [expected]
    const labels = Array.isArray(label) ? label : [label]
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    let matches = 0
    for (const match of text.matchAll(global)) {
      matches += 1
      const line = text.slice(0, match.index).split('\n').length
      expectedList.forEach((want, index) => {
        const actual = Number(match[index + 1])
        if (actual !== want) {
          problems.push(`${relative}:${String(line)} 写着 ${labels[index]} ${String(actual)}，实际是 ${String(want)}。`)
        }
      })
    }
    if (matches === 0) {
      problems.push(`${relative} 里「${labels.join(' / ')}」的规则一处也没匹配到（模式 ${pattern.source}）——空转的规则永远报不了错，先修正模式或删掉它。`)
    }
  }
  return problems
}

function main() {
  const testOutput = run(['--test', '--test-reporter=spec'])
  const testMatch = testOutput.match(/\nℹ tests (\d+)/)
  const passMatch = testOutput.match(/\nℹ pass (\d+)/)
  if (testMatch === null || passMatch === null) {
    console.error('读不到测试计数：`node --test` 的输出里没有 `ℹ tests N` / `ℹ pass N`。')
    process.exit(2)
  }
  const tests = Number(testMatch[1])
  const passes = Number(passMatch[1])

  const lintOutput = run(['tools/lint-exports.mjs'])
  const lintMatch = lintOutput.match(/接口一致性检查通过（(\d+) 个文件）/)
  if (lintMatch === null) {
    console.error('读不到接口一致性文件数：`tools/lint-exports.mjs` 的输出不符合预期。')
    process.exit(2)
  }
  const scannedFiles = Number(lintMatch[1])

  const clientOutput = run(['tools/check-client.mjs'])
  const clientMatch = clientOutput.match(/界面文案检查通过（(\d+) 个语言键，(\d+) 处引用）/)
  if (clientMatch === null) {
    console.error('读不到界面文案计数：`tools/check-client.mjs` 的输出不符合预期。')
    process.exit(2)
  }
  const clientKeys = Number(clientMatch[1])
  const clientRefs = Number(clientMatch[2])

  const relative = 'docs/verify.md'
  const file = path.join(PACKAGE_ROOT, relative)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    console.error(`${relative} 读不出来。`)
    process.exit(1)
  }

  // README 已经不写测试数了（原来的「N 项测试」一句不在文档里），那条规则在当前
  // README 上一处也匹配不到，属于空转，已删除。要在这里重新挂规则，先确认它能命中。
  const problems = checkText(text, docNumberRules({ tests, passes, scannedFiles, clientKeys, clientRefs }), relative)

  if (problems.length === 0) {
    const declaration = declarationCounts()
    console.log(`文档数字一致：测试 ${String(tests)}，通过 ${String(passes)}，扫描文件 ${String(scannedFiles)}，语言键 ${String(clientKeys)}，引用 ${String(clientRefs)}，补丁 ${String(declaration.patches)} 条 / 目标 ${String(declaration.targets)} 个 / 推荐档 ${String(declaration.recommendedPatches)} 条。`)
    process.exit(0)
  }

  console.error('文档数字与实测不符：')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) main()
