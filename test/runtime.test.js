// 运行时行为的纯函数部分：模式映射与身份剥离。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { promptMode, readMode } from '../src/context/prompt.js'
import { describeSandboxPolicy, stripHostIdentity } from '../src/host/seams.js'
import { resolvePatches } from '../src/patch/patch-selection.js'
import { applyModeBudget } from '../src/host/capabilities.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-runtime-'))
}

test('模式收敛：合法值原样保留，旧档位名一律回到推荐', () => {
  assert.equal(promptMode('recommended'), 'recommended')
  assert.equal(promptMode('unrestricted'), 'unrestricted')
  assert.equal(promptMode('architect'), 'recommended')
  assert.equal(promptMode('autonomous'), 'unrestricted' === 'x' ? 'x' : 'recommended')
  assert.equal(promptMode('lean'), 'recommended')
  assert.equal(promptMode(undefined), 'recommended')
})

test('身份段被整段剔除，persona 前缀里的身份句被删掉', () => {
  const sections = [
    { name: 'harness:identity', text: 'harness identity' },
    { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the deepseek-flash model.' },
    { name: 'rules', text: 'workspace rules' },
  ]
  const out = stripHostIdentity(sections)
  assert.deepEqual(out.map(section => section.name), ['deployment:persona-prefix', 'rules'])
  assert.equal(out[0].text.includes('You are a coding agent'), false)
  assert.equal(out[1].text, 'workspace rules')
})

test('前置注入文本保留，只删身份那一句', () => {
  const sections = [{
    name: 'deployment:persona-prefix',
    text: 'MODE MAP\n\nYou are a coding agent powered by the deepseek-flash model.\n\ntail',
  }]
  const [out] = stripHostIdentity(sections)
  assert.match(out.text, /MODE MAP/u)
  assert.match(out.text, /tail/u)
  assert.equal(out.text.includes('You are a coding agent powered by'), false)
})

test('没有身份句的段原样返回同一个对象', () => {
  const sections = [{ name: 'rules', text: 'nothing to strip' }]
  const [out] = stripHostIdentity(sections)
  assert.equal(out, sections[0])
})

test('doctor 在服务缺席时报「宿主未提供」而不是不一致', async (t) => {
  const { doctorReport } = await import('../src/host/commands.js')
  // 本场景没有宿主与已存档位，不能读取调用者的本机配置。
  const previous = process.env.DSH_HOME
  const previousRoot = process.env.DSH_BREAKLIMIT_HOST_ROOT
  process.env.DSH_HOME = tempHome()
  delete process.env.DSH_BREAKLIMIT_HOST_ROOT
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (previousRoot === undefined) delete process.env.DSH_BREAKLIMIT_HOST_ROOT
    else process.env.DSH_BREAKLIMIT_HOST_ROOT = previousRoot
  })
  const report = doctorReport({ get: () => undefined }, { hostRoot: '' })
  assert.match(report.text, /提示词模式\s+recommended/u)
  assert.match(report.text, /宿主未提供/u)
  assert.match(report.text, /宿主根\s+未配置/u)
})

test('doctor 用配置里的预算判定，不拿内置值误报', async (t) => {
  const { doctorReport } = await import('../src/host/commands.js')
  const previous = process.env.DSH_HOME
  const previousRoot = process.env.DSH_BREAKLIMIT_HOST_ROOT
  process.env.DSH_HOME = tempHome()
  delete process.env.DSH_BREAKLIMIT_HOST_ROOT
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (previousRoot === undefined) delete process.env.DSH_BREAKLIMIT_HOST_ROOT
    else process.env.DSH_BREAKLIMIT_HOST_ROOT = previousRoot
  })
  const slot = value => ({ get: () => value })
  const ctx = {
    get(name) {
      if (name === 'shell') return { config: { timeoutMs: slot(7), maxTimeoutMs: slot(7), maxOutputBytes: slot(7) } }
      if (name === 'subagents') return { config: { maxDepth: slot(7) } }
      return undefined
    },
  }
  const config = {
    hostRoot: '',
    budgets: {
      recommended: { timeoutMs: 7, maxTimeoutMs: 7, maxOutputBytes: 7, maxDepth: 7 },
      unrestricted: { timeoutMs: 9, maxTimeoutMs: 9, maxOutputBytes: 9, maxDepth: 9 },
    },
  }
  const report = doctorReport(ctx, config)
  assert.doesNotMatch(report.text, /该模式应为/u)
  assert.match(report.text, /bash 超时\s+7/u)
})

test('档位读不到与真的只读分开报告', () => {
  const absent = describeSandboxPolicy({ get: () => undefined })
  assert.equal(absent.available, false)
  assert.match(absent.error, /未提供/u)

  const broken = describeSandboxPolicy({ get: () => ({ resolve() { throw new Error('boom') } }) })
  assert.equal(broken.available, false)
  assert.match(broken.error, /boom/u)

  const empty = describeSandboxPolicy({ get: () => ({ resolve: () => ({}) }) })
  assert.equal(empty.available, false)

  const ok = describeSandboxPolicy({ get: () => ({ resolve: () => ({ mode: 'danger-full-access' }) }) })
  assert.deepEqual(ok, { available: true, mode: 'danger-full-access', error: null })
})

test('readMode 缺文件用默认，损坏且无可信快照时拒绝操作', () => {
  const home = tempHome()
  assert.equal(readMode(home), 'recommended', '无配置文件')
  const file = path.join(home, 'breaklimit', 'tier.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ broken', 'utf8')
  assert.throws(() => readMode(home), { code: 'tier_config_unavailable' })
  fs.writeFileSync(file, JSON.stringify({ tier: 'unrestricted' }), 'utf8')
  assert.equal(readMode(home), 'unrestricted')
})

test('模式贯通：同一 home 的 readMode 决定补丁集合与预算取值', async () => {
  const home = tempHome()
  const file = path.join(home, 'breaklimit', 'tier.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })

  fs.writeFileSync(file, JSON.stringify({ tier: 'recommended' }), 'utf8')
  const recommendedMode = readMode(home)
  const recommendedPatches = resolvePatches(home, recommendedMode)
  assert.equal(recommendedMode, 'recommended')
  assert.equal(recommendedPatches.some(patch => patch.id === 'minimal.unfreeze'), false)
  assert.equal(recommendedPatches.length, 4)

  fs.writeFileSync(file, JSON.stringify({ tier: 'unrestricted' }), 'utf8')
  const unrestrictedMode = readMode(home)
  const unrestrictedPatches = resolvePatches(home, unrestrictedMode)
  assert.equal(unrestrictedMode, 'unrestricted')
  assert.equal(unrestrictedPatches.some(patch => patch.id === 'minimal.unfreeze'), true)
  assert.equal(unrestrictedPatches.length, 5)

  const calls = []
  const ctx = { loader: { resolve: () => ({ async update() {} }), entries: () => [] } }
  const loaderCtx = {
    root: { loader: { resolve() { throw new Error('absent') }, entries: () => [{ id: 'host:bash-sandbox', async update(options) { calls.push(['bash', options.config]) } }, { id: 'host:pwsh-sandbox', async update(options) { calls.push(['pwsh', options.config]) } }, { id: 'host:subagent', async update(options) { calls.push(['subagent', options.config]) } }] } },
  }
  void ctx
  const result = await applyModeBudget(loaderCtx, unrestrictedMode)
  assert.equal(result.mode, 'unrestricted')
  const shell = calls.find(call => call[0] === 'pwsh')
  assert.equal(shell[1].timeoutMs, 9999000)
  assert.equal(shell[1].maxOutputBytes, 1048576)
  const sub = calls.find(call => call[0] === 'subagent')
  assert.equal(sub[1].maxDepth, 5)
})

test('源码守卫：不得把 home 路径交给 promptMode', () => {
  const root = path.join(import.meta.dirname, '..', 'src')
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.js')) continue
      const text = fs.readFileSync(full, 'utf8')
      if (/promptMode\s*\(\s*(home|resolveHome|home\(\))/.test(text)) offenders.push(full)
    }
  }
  walk(root)
  assert.deepEqual(offenders, [], '这些文件把 home 传给了 promptMode，应改用 readMode')
})
