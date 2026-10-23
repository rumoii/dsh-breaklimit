// 跨模块接口一致性检查。
//
// 这个工具的存在理由是一次真实的漏检：几个函数被删掉之后，调用方没有跟着清理，
// 而我用一条手敲的 Select-String 检查「零命中」——那个开关让 `|` 失去正则含义，
// 整串被当成一个字面量去匹配，于是检查假通过，三处调用点活到了验收。
//
// 结论不是「下次仔细点」，而是：人工检查接口一致性不可靠，把它变成机器能判的事。
//
// 检查两类，都是那次事故的真实形态：
//   1. `import { x } from './y.js'` 里的 x 不是 y 导出的名字。
//   2. `import * as ns from './y.js'` 之后访问了 ns.member，而 member 不是 y 导出的。
//
// 不检查「调用了未定义的标识符」这一类。试过：收集本文件定义与导入的名字，再扫
// 全部 `name(` 做差集，结果是 387 处误报——`if (`、`for (`、`catch (` 全被当成函数
// 调用。要做到准确就等于用正则重新实现一个 JS 解析器。一个会误报的检查比没有检查
// 更糟：它训练人忽略它的输出。这一类交给运行时，见 test/cli.test.js 的冒烟。
//
// 用法: node tools/lint-exports.mjs [根目录]

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git'])
const EXTENSIONS = ['.js', '.mjs']

export function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (!EXTENSIONS.includes(path.extname(entry.name))) continue
    out.push(path.join(dir, entry.name))
  }
  return out
}

/** 一个模块对外提供的名字。 */
export function collectExports(text) {
  const names = new Set()
  const patterns = [
    /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+class\s+([A-Za-z_$][\w$]*)/gm,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) names.add(match[1])
  }
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const piece of match[1].split(',')) {
      const parts = piece.trim().split(/\s+as\s+/)
      const name = (parts.length > 1 ? parts[1] : parts[0]).trim()
      if (name !== '') names.add(name)
    }
  }
  return names
}

export function collectImports(text) {
  const named = []
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = match[1]
      .split(',')
      .map(piece => piece.trim().split(/\s+as\s+/)[0].trim())
      .filter(name => name !== '')
    named.push({ specifier: match[2], names })
  }
  const namespaced = []
  for (const match of text.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g)) {
    namespaced.push({ alias: match[1], specifier: match[2] })
  }
  return { named, namespaced }
}

/** 去掉注释。import 的说明符本身是字符串，去掉就没法解析了，所以只去注释。 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** 去掉注释与全部字符串字面量，供符号扫描使用。 */
export function stripCommentsAndStrings(text) {
  return stripComments(text)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** 解析相对说明符到实际文件；解析不到返回 null（外部包不检查）。 */
export function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // 试下一个候选。
    }
  }
  return null
}

/**
 * 对一组源码做检查。
 * @param {Map<string, string>} sources - 绝对路径 → 内容。
 * @param {string} root - 用于生成相对路径的基准目录。
 * @returns {string[]} 问题描述；空数组表示通过。
 */
export function checkSources(sources, root) {
  const exportsByFile = new Map()
  for (const [file, text] of sources) exportsByFile.set(file, collectExports(text))

  const problems = []
  // 坏 import 检测：目标被删留下的相对说明符。不能复用 collectImports 的结果——
  // 它按模式收集，分不清真 import 和测试夹具字符串里的假 import；这里只认行首
  // （可缩进，不许跨行）的 import/export 语句。已知漏报面：动态 import('./x.js')、
  // 无空格写法 import{a}from'./x.js'；已知误报面：模板字符串里整行独占的假 import。
  const importStatementRe = /^[ \t]*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|^[ \t]*import\s+['"](\.[^'"]+)['"]/gm
  for (const [file, text] of sources) {
    for (const match of stripComments(text).matchAll(importStatementRe)) {
      const specifier = match[1] ?? match[2]
      if (resolveSpecifier(file, specifier) === null) {
        problems.push(`${path.relative(root, file)}: 无法解析的 import：${specifier}`)
      }
    }
  }
  for (const [file, text] of sources) {
    const relative = path.relative(root, file)
    // import 的说明符是字符串，必须在只去注释的文本上收集。
    const { named, namespaced } = collectImports(stripComments(text))
    // 成员扫描则要连字符串一起去掉，免得从文字里读出假符号。
    const clean = stripCommentsAndStrings(text)

    for (const { specifier, names } of named) {
      const target = resolveSpecifier(file, specifier)
      if (target === null) continue
      const available = exportsByFile.get(target)
      if (available === undefined) continue
      for (const name of names) {
        if (!available.has(name)) {
          problems.push(`${relative}: 从 ${specifier} 导入了不存在的导出 \`${name}\``)
        }
      }
    }

    for (const { alias, specifier } of namespaced) {
      const target = resolveSpecifier(file, specifier)
      if (target === null) continue
      const available = exportsByFile.get(target)
      if (available === undefined) continue
      const pattern = new RegExp(`(?:^|[^\\w.$])${alias}\\.([A-Za-z_$][\\w$]*)`, 'g')
      for (const match of clean.matchAll(pattern)) {
        if (!available.has(match[1])) {
          problems.push(`${relative}: 访问了 ${alias}.${match[1]}，但 ${specifier} 没有导出 \`${match[1]}\``)
        }
      }
    }
  }
  return problems
}

/** 扫描一个目录树并检查。 */
export function checkTree(root) {
  const files = walk(root)
  const sources = new Map()
  for (const file of files) sources.set(file, fs.readFileSync(file, 'utf8'))
  return { problems: checkSources(sources, root), fileCount: files.length }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const root = process.argv[2] ?? DEFAULT_ROOT
  const { problems, fileCount } = checkTree(root)
  if (problems.length > 0) {
    console.error(`接口一致性检查未通过，${String(problems.length)} 处问题：`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(`接口一致性检查通过（${String(fileCount)} 个文件）`)
}
