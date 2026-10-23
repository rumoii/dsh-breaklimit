// 文档数字守卫的新增守卫：声明层数字。
//
// verify.md 的「5 条补丁、10 个声明目标（推荐模式启用 4 条）」此前无守卫会静默漂。
// 新守卫的判据从 src/patch/index.js 推导；这里验两件事：判据不是第二份硬编码，
// 以及数字漂了会被抓。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkText, declarationCounts, declarationRules, docNumberRules } from '../tools/check-doc-numbers.mjs'
import { PATCHES, patchesForMode, targetPaths } from '../src/patch/index.js'

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERIFY_TEXT = fs.readFileSync(path.join(PACKAGE_ROOT, 'docs', 'verify.md'), 'utf8')

test('新守卫的判据来自补丁声明，不是第二份硬编码', () => {
  assert.deepEqual(declarationCounts(), {
    patches: PATCHES.length,
    targets: targetPaths().length,
    recommendedPatches: patchesForMode('recommended').length,
  })
})

test('当前 verify.md 的声明层数字与代码一致', () => {
  assert.deepEqual(checkText(VERIFY_TEXT, declarationRules(), 'docs/verify.md'), [])
})

test('补丁条数漂移被抓', () => {
  const drifted = VERIFY_TEXT.replace('5 条补丁', '6 条补丁')
  assert.notEqual(drifted, VERIFY_TEXT, '用例前提：原数在文档里')
  const problems = checkText(drifted, declarationRules(), 'docs/verify.md')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /补丁条数 6，实际是 5/)
})

test('声明目标数漂移被抓', () => {
  const drifted = VERIFY_TEXT.replace('10 个声明目标', '9 个声明目标')
  assert.notEqual(drifted, VERIFY_TEXT, '用例前提：原数在文档里')
  const problems = checkText(drifted, declarationRules(), 'docs/verify.md')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /声明目标数 9，实际是 10/)
})

test('推荐档启用数漂移被抓', () => {
  const drifted = VERIFY_TEXT.replace('推荐模式启用 4 条', '推荐模式启用 5 条')
  assert.notEqual(drifted, VERIFY_TEXT, '用例前提：原数在文档里')
  const problems = checkText(drifted, declarationRules(), 'docs/verify.md')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /推荐档启用数 5，实际是 4/)
})

test('整套规则下新守卫同样抓漂移，且规则不空转', () => {
  // 既有 4 类的计数取自实跑门禁；这里从当前文档取值，让用例只盯新守卫，
  // 不随既有守卫的数字变化而红。
  const counts = {
    tests: Number(/tests (\d+) \/ pass/.exec(VERIFY_TEXT)[1]),
    passes: Number(/pass (\d+) \/ fail/.exec(VERIFY_TEXT)[1]),
    scannedFiles: Number(/接口一致性检查通过（(\d+) 个文件）/.exec(VERIFY_TEXT)[1]),
    clientKeys: Number(/语言检查验证 (\d+) 个语言键/.exec(VERIFY_TEXT)[1]),
    clientRefs: Number(/及 (\d+) 处引用/.exec(VERIFY_TEXT)[1]),
  }
  const rules = docNumberRules(counts)
  assert.equal(rules.length, 8, '既有 4 类（语言键数/引用数同一条规则）共 5 条，加声明层 3 条')
  assert.deepEqual(checkText(VERIFY_TEXT, rules, 'docs/verify.md'), [])
  const drifted = VERIFY_TEXT.replace('5 条补丁', '7 条补丁')
  const problems = checkText(drifted, rules, 'docs/verify.md')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /补丁条数 7，实际是 5/)
})
