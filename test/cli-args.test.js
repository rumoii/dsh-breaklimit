// CLI 参数兜底与退出码契约。
//
// cli.test.js 验证「每个动作都能跑到返回」；这里验参数层的失败必须是显式失败：
// 此前拼错参数被静默忽略、最后打印帮助退出 0，与 --help 不可区分，脚本会当成
// 成功；`--status --apply` 被后写覆盖，实际只跑 apply。这些都必须以退出码 2
// 显式报错，而不是假装通过。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { run } from '../src/cli.js'
import { PATCHES } from '../src/patch/index.js'
import { writeDisabled } from '../src/patch/patch-selection.js'

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function envFor(home, extra = {}) {
  return { DSH_HOME: home, ...extra }
}

/** 跑一次 run，收走 stdout/stderr，返回退出码与两路输出。 */
function capture(argv, env) {
  const out = []
  const err = []
  const originalOut = process.stdout.write
  const originalErr = process.stderr.write
  process.stdout.write = (chunk) => {
    out.push(String(chunk))
    return true
  }
  process.stderr.write = (chunk) => {
    err.push(String(chunk))
    return true
  }
  try {
    const code = run(argv, env)
    return { code, stdout: out.join(''), stderr: err.join('') }
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }
}

test('拼错的参数报错退出 2，并指出是哪个参数', () => {
  const home = tempDir('bkl-args-')
  const result = capture(['--aply'], envFor(home, { DSH_BREAKLIMIT_HOST_ROOT: '' }))
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--aply/)
  // 不再与 --help 不可区分：失败时不把帮助当成功输出。
  assert.doesNotMatch(result.stdout, /--status/)
})

test('未知参数与动作同给时报错退出 2，动作不执行', () => {
  const home = tempDir('bkl-args-')
  const root = tempDir('bkl-args-host-')
  const result = capture(['--host-root', root, '--apply', '--aply'], envFor(home))
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--aply/)
  assert.deepEqual(fs.readdirSync(root), [], '参数错误时不得执行动作')
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'state.json')), false)
})

test('多动作组合被拒绝：--status --apply 退出 2，两个都不跑', () => {
  const home = tempDir('bkl-args-')
  const root = tempDir('bkl-args-host-')
  const result = capture(['--host-root', root, '--status', '--apply'], envFor(home))
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--status/)
  assert.match(result.stderr, /--apply/)
  assert.deepEqual(fs.readdirSync(root), [], '多动作被拒后不得有任何写入')
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'state.json')), false)
})

test('--host-root 的取值不算未知参数', () => {
  const home = tempDir('bkl-args-')
  const root = tempDir('bkl-args-host-')
  writeDisabled(home, PATCHES.map(patch => patch.id))
  const result = capture(['--host-root', root, '--status'], envFor(home))
  assert.equal(result.code, 0, '路径取值被消费掉，不得报未知参数，行为与改前一致')
  assert.equal(result.stderr, '')
})

test('宿主根未配置时 --status 跳过预检，退出 2 且明说跳过 ≠ 通过', () => {
  const home = tempDir('bkl-args-')
  const result = capture(['--status'], envFor(home, { DSH_BREAKLIMIT_HOST_ROOT: '' }))
  assert.equal(result.code, 2)
  assert.match(result.stdout, /跳过（宿主根未配置）/)
  assert.match(result.stdout, /预检被跳过 ≠ 通过/)
})

test('--help 不受参数兜底影响，仍退出 0', () => {
  const home = tempDir('bkl-args-')
  const result = capture(['--help'], envFor(home, { DSH_BREAKLIMIT_HOST_ROOT: '' }))
  assert.equal(result.code, 0)
  assert.match(result.stdout, /--status/)
})


test('--host-root 缺值不能吞掉动作，规则损坏不能报告空目录', () => {
  const home = tempDir('bkl-cli-bounded-')
  assert.equal(capture(['--host-root', '--status'], envFor(home)).code, 2)
  fs.mkdirSync(path.join(home, 'breaklimit'), { recursive: true })
  fs.writeFileSync(path.join(home, 'breaklimit', 'rules.json'), '{broken')
  assert.equal(capture(['--rules'], envFor(home)).code, 1)
})
