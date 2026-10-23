// 固定宿主的真实渲染器验收；可传入修改前源码副本比较普通正文的最终字节。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { registerSeams } from '../src/host/seams.js'
import { saveRule, activateRule } from '../src/context/rules.js'
import { writeTier } from '../src/context/tiers.js'
import { DSH_TARGET } from '../src/patch/index.js'

const [hostRoot, baseline] = process.argv.slice(2)
if (!hostRoot) throw new Error('用法：node tools/check-host-prompt.mjs <宿主根> [修改前源码副本]')
assert.equal(execFileSync('git', ['-C', hostRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), DSH_TARGET.commit)
const { renderPrompt } = await import(pathToFileURL(path.resolve(hostRoot, 'packages/core/system-prompt/lib/index.js')).href)
const oldRegister = baseline
  ? (await import(pathToFileURL(path.resolve(baseline, 'src/host/seams.js')).href)).registerSeams
  : null
const previousHome = process.env.DSH_HOME
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-host-prompt-'))
process.env.DSH_HOME = home
let compared = 0, literal = 0, baselineRejected = 0

async function assemble(register, persona) {
  const handlers = new Map(), registered = []
  const runtime = { enabled: true, counters: { assemble: 0 } }
  register({ on: (event, fn) => handlers.set(event, fn), systemPrompt: { section: value => registered.push(value) } }, {}, runtime, 10300)
  const sections = [
    { name: 'harness:identity', text: 'HOST IDENTITY' },
    ...(persona ? [{ name: 'deployment:persona-prefix', text: 'Persona {{model}}.' }] : []),
    { name: 'tools:core', text: 'TOOL GUIDANCE', interpolate: false },
    ...registered.map(section => ({ ...section, text: section.text() })),
  ]
  const assembly = { sections, contexts: [], tools: [], variables: { model: 'fixture-model', provider: 'fixture-provider' } }
  const out = await handlers.get('system-prompt/assemble')(assembly, {}, async () => assembly)
  const text = renderPrompt(out)
  handlers.get('session/event')({}, { type: 'system/message', data: { message: { content: [{ type: 'text', text }] } } })
  assert.equal(runtime.lastAssembly.injectionDropped, false)
  return { out, text }
}

try {
  for (const mode of ['recommended', 'unrestricted']) {
    writeTier(home, mode)
    for (const persona of [false, true]) {
      fs.writeFileSync(path.join(home, 'breaklimit-inject.md'), 'ORDINARY HEAD')
      saveRule(home, 'fixture', 'ORDINARY RULE', { target: 'AGENTS.md' })
      activateRule(home, 'fixture')
      const normal = await assemble(registerSeams, persona)
      const headAt = normal.text.indexOf('ORDINARY HEAD')
      const ruleAt = normal.text.indexOf('ORDINARY RULE')
      assert.ok(headAt >= 0 && ruleAt >= 0 && headAt < ruleAt, '头部或规则正文缺失、顺序不对')
      assert.ok(normal.text.includes('TOOL GUIDANCE'))
      if (persona) assert.ok(normal.text.includes('Persona fixture-model.'))
      if (oldRegister) {
        assert.equal(normal.text, (await assemble(oldRegister, persona)).text)
        compared += 1
      }
      for (const source of ['inject', 'rule']) {
        const payload = 'LITERAL {{cwd}} / {{model}} / {{ count }}\n```json\n{"x":"{{provider}}"}\n```'
        fs.writeFileSync(path.join(home, 'breaklimit-inject.md'), source === 'inject' ? payload : 'ORDINARY HEAD')
        saveRule(home, 'fixture', source === 'rule' ? payload : 'ORDINARY RULE')
        const rendered = await assemble(registerSeams, persona)
        assert.ok(rendered.text.includes(payload), `${mode}/${persona}/${source}: 字面正文必须完整保留`)
        assert.equal(rendered.out.sections.find(section => section.name === 'breaklimit:head').interpolate, false)
        literal += 1
        if (oldRegister) {
          await assert.rejects(() => assemble(oldRegister, persona), /prompt variable/)
          baselineRejected += 1
        }
      }
    }
  }
  console.log(JSON.stringify({ hostCommit: DSH_TARGET.commit, compared, literal, baselineRejected, home }, null, 2))
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
}
