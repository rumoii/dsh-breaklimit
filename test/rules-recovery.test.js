// 规则存储的恢复与互斥（#4 激活意图、#5 外部改动保护、#6 规则操作锁 + 清单版本），
// 以及同落点换规则时首次接管原文的快照不被覆盖。
//
// 这些用例都只测一件事：失败之后磁盘上还剩什么。断言因此全部落在文件内容、清单字段
// 与返回的结构化错误上，不测内部写法。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import {
  activateRule,
  deactivateRule,
  ensureInitialState,
  landingPath,
  readActive,
  readIndex,
  ruleTextPath,
  rulesIndexPath,
  saveRule,
  targetPath,
} from '../src/context/rules.js'
import { acquireFileLock, lockFilePath, releaseFileLock } from '../src/patch/lock.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-rules-recovery-'))
}

function seedTarget(home, target, text) {
  fs.writeFileSync(targetPath(home, target), text, 'utf8')
}

function readIndexFile(home) {
  return JSON.parse(fs.readFileSync(rulesIndexPath(home), 'utf8'))
}

/** 让下一次针对 rules.json 的改名失败，模拟清单写不进去。 */
function failIndexRenameOnce(home) {
  const original = fs.renameSync
  const index = rulesIndexPath(home)
  fs.renameSync = (from, to) => {
    if (to === index) throw new Error('模拟清单改名失败')
    return original(from, to)
  }
  return () => { fs.renameSync = original }
}

test('清单写失败：激活报错、落点未被改写、快照被回收，不留下半个激活', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  const before = readIndexFile(home)

  const restore = failIndexRenameOnce(home)
  let result
  try {
    result = activateRule(home, 'alpha')
  } finally {
    restore()
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'index_write_failed')
  assert.equal(typeof result.reason, 'string')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'original text')
  assert.equal(readActive(home), null)
  assert.equal(fs.existsSync(landingPath(home, 'AGENTS.md')), false)
  const after = readIndexFile(home)
  assert.equal(after.active, null)
  assert.equal(after.revision, before.revision)
  assert.equal(fs.existsSync(lockFilePath(home)), false)
})

test('外部改动保护：保存跳过同步，取消激活保留记录与快照', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)

  seedTarget(home, 'AGENTS.md', 'USER_EXTERNAL')

  const saved = saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' })
  assert.equal(saved.ok, true)
  assert.equal(saved.landingStale, true)
  assert.equal(saved.landingSynced, false)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'USER_EXTERNAL')
  assert.equal(fs.readFileSync(ruleTextPath(home, 'alpha'), 'utf8'), 'A body v2')

  const off = deactivateRule(home)
  assert.equal(off.ok, true)
  assert.equal(off.skipped.length, 1)
  assert.equal(off.kept, true)
  assert.equal(readActive(home), 'alpha')
  assert.notEqual(readIndex(home).landing, null)
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'USER_EXTERNAL')
})

test('互斥：锁被占用时保存被拒绝，清单与正文都不动', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  const before = fs.readFileSync(rulesIndexPath(home), 'utf8')

  const holder = acquireFileLock(home, 'recovery-holder')
  assert.equal(holder.conflict, undefined)
  let result
  try {
    result = saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' })
  } finally {
    releaseFileLock(holder)
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'locked')
  assert.equal(fs.readFileSync(rulesIndexPath(home), 'utf8'), before)
  assert.equal(fs.readFileSync(ruleTextPath(home, 'alpha'), 'utf8'), 'A body')
})

test('版本冲突：清单在读写之间被外部改写则不覆盖', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  const before = readIndexFile(home)
  const external = {
    ...before,
    revision: 99,
    rules: [...before.rules, { id: 'external', name: '外部', target: 'AGENTS.md', activatedAt: null }],
  }

  // 清单临时文件落盘、还没改名的那一瞬间，外部把它换掉：CAS 必须看见这个改动。
  const originalWrite = fs.writeFileSync
  fs.writeFileSync = (file, data, ...rest) => {
    const written = originalWrite(file, data, ...rest)
    if (String(file).includes('.rules.json.bkl-')) {
      originalWrite(rulesIndexPath(home), `${JSON.stringify(external, null, 2)}\n`, 'utf8')
    }
    return written
  }
  let result
  try {
    result = saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' })
  } finally {
    fs.writeFileSync = originalWrite
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  const after = readIndexFile(home)
  assert.equal(after.revision, 99)
  assert.equal(after.rules.some(rule => rule.id === 'external'), true)
})

test('同落点换规则：落点被手改过时不覆盖首次接管时的快照', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)

  // 用户手改落点：此时快照是 alpha 激活前的原文，落点是用户内容。
  seedTarget(home, 'AGENTS.md', 'USER_EXTERNAL')

  const switched = activateRule(home, 'beta')
  assert.equal(switched.ok, true)
  assert.equal(switched.snapshotKept, true)
  assert.equal(switched.previousLanding.skipped.length, 1)
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original text')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'B body')
  assert.equal(readActive(home), 'beta')
})

test('同落点手改后取消激活：落点保持手改内容，快照仍在', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  seedTarget(home, 'AGENTS.md', 'USER_EXTERNAL')

  const off = deactivateRule(home)
  assert.equal(off.ok, true)
  assert.equal(off.skipped.length, 1)
  assert.equal(off.restored, false)
  assert.equal(off.kept, true)
  assert.equal(readActive(home), 'alpha')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'USER_EXTERNAL')
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original text')
})

test('正常同落点切换沿用首次快照，不恢复旧落点', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)
  const first = activateRule(home, 'alpha')
  assert.equal(first.ok, true)
  assert.equal(first.snapshotKept, false)

  const switched = activateRule(home, 'beta')
  assert.equal(switched.ok, true)
  assert.equal(switched.snapshotKept, true)
  assert.equal(switched.previousLanding.restored, false)
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original text')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'B body')

  const off = deactivateRule(home)
  assert.equal(off.restored, true)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'original text')
  assert.equal(fs.existsSync(landingPath(home, 'AGENTS.md')), false)
})

test('首轮导入：原文留在 bodies/default.md，切换规则只可能丢干净快照', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'existing instructions')
  const imported = ensureInitialState(home)
  assert.equal(imported.imported, 'default')
  assert.equal(fs.readFileSync(ruleTextPath(home, 'default'), 'utf8'), 'existing instructions')

  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)
  seedTarget(home, 'AGENTS.md', 'USER_EXTERNAL')
  const switched = activateRule(home, 'beta')
  assert.equal(switched.ok, true)
  assert.equal(switched.snapshotKept, true)
  assert.equal(fs.readFileSync(ruleTextPath(home, 'default'), 'utf8'), 'existing instructions')
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'existing instructions')
})


test('切到不可读的新落点失败时，旧激活、落点和原文快照完全不动', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'ORIGINAL')
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  saveRule(home, 'beta', 'B body', { target: 'CLAUDE.md' })
  activateRule(home, 'alpha')
  fs.mkdirSync(targetPath(home, 'CLAUDE.md'))
  const before = fs.readFileSync(rulesIndexPath(home))
  assert.equal(activateRule(home, 'beta').code, 'landing_unreadable')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'A body')
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'ORIGINAL')
  assert.deepEqual(fs.readFileSync(rulesIndexPath(home)), before)
  assert.equal(saveRule(home, 'alpha', 'A revised').landingSynced, true)
})

test('同落点换规则提交失败，旧字节和首次快照不被先行处置', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'ORIGINAL')
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' })
  activateRule(home, 'alpha')
  const original = fs.renameSync
  let writes = 0
  fs.renameSync = (from, to) => {
    if (to === rulesIndexPath(home) && ++writes === 2) throw new Error('commit failed')
    return original(from, to)
  }
  let result
  try { result = activateRule(home, 'beta') } finally { fs.renameSync = original }
  assert.equal(result.ok, false)
  assert.equal(readActive(home), 'alpha')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'A body')
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'ORIGINAL')
})

test('跨落点在提交后中断，启动可按 cleanup 意图续做旧落点收尾', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'ORIGINAL')
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  saveRule(home, 'beta', 'B body', { target: 'CLAUDE.md' })
  activateRule(home, 'alpha')
  const moduleUrl = new URL('../src/context/rules.js', import.meta.url).href
  const code = `import fs from 'node:fs';import {activateRule,rulesIndexPath} from ${JSON.stringify(moduleUrl)};
    const home=process.argv[1];const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{const r=rename(from,to);if(to===rulesIndexPath(home)&&JSON.parse(fs.readFileSync(to,'utf8')).pendingActivation?.phase==='cleanup')process.exit(23);return r};
    activateRule(home,'beta');`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, home], { encoding: 'utf8' })
  assert.equal(child.status, 23, child.stderr)
  assert.equal(readActive(home), 'beta')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'A body')
  // 子进程模拟在已提交点退出；释放它留下的锁，避免依赖陈旧锁宽限期。
  releaseFileLock({ path: lockFilePath(home), operationId: JSON.parse(fs.readFileSync(lockFilePath(home), 'utf8')).operationId })
  const recovered = ensureInitialState(home)
  assert.equal(recovered.active, 'beta')
  assert.equal(readIndex(home).pendingActivation, null)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'ORIGINAL')
  assert.equal(fs.readFileSync(targetPath(home, 'CLAUDE.md'), 'utf8'), 'B body')
})


test('旧落点 I/O 故障保留 cleanup，新激活有效；故障解除后写入口先续做', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'ORIGINAL')
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  saveRule(home, 'beta', 'B body', { target: 'CLAUDE.md' })
  activateRule(home, 'alpha')
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === targetPath(home, 'AGENTS.md')) throw new Error('old target busy')
    return rename(from, to)
  }
  try {
    const result = activateRule(home, 'beta')
    assert.equal(result.ok, true)
    assert.equal(result.cleanupPending, true)
    assert.equal(readActive(home), 'beta')
    assert.equal(readIndex(home).pendingActivation.phase, 'cleanup')
    assert.equal(deactivateRule(home).code, 'conflict')
    assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'ORIGINAL')
  } finally { fs.renameSync = rename }
  assert.equal(saveRule(home, 'beta', 'B revised').landingSynced, true)
  assert.equal(readIndex(home).pendingActivation, null)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'ORIGINAL')
})

test('旧落点已恢复但清理意图提交失败，重试识别原文而非外部漂移', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'ORIGINAL')
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  saveRule(home, 'beta', 'B body', { target: 'CLAUDE.md' })
  activateRule(home, 'alpha')
  const rename = fs.renameSync
  let indexWrites = 0
  fs.renameSync = (from, to) => {
    if (to === rulesIndexPath(home) && ++indexWrites === 3) throw new Error('cleanup commit failed')
    return rename(from, to)
  }
  let result
  try { result = activateRule(home, 'beta') } finally { fs.renameSync = rename }
  assert.equal(result.cleanupPending, true)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'ORIGINAL')
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'ORIGINAL')
  assert.equal(ensureInitialState(home).active, 'beta')
  assert.equal(readIndex(home).pendingActivation, null)
  assert.equal(fs.existsSync(landingPath(home, 'AGENTS.md')), false)
})

test('收尾记录与清单不一致：写入口挡下并指路，取消激活可清掉卡死的记录', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'ORIGINAL')
  saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' })
  saveRule(home, 'beta', 'B body', { target: 'CLAUDE.md' })
  activateRule(home, 'alpha')
  const moduleUrl = new URL('../src/context/rules.js', import.meta.url).href
  const code = `import fs from 'node:fs';import {activateRule,rulesIndexPath} from ${JSON.stringify(moduleUrl)};
    const home=process.argv[1];const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{const r=rename(from,to);if(to===rulesIndexPath(home)&&JSON.parse(fs.readFileSync(to,'utf8')).pendingActivation?.phase==='cleanup')process.exit(23);return r};
    activateRule(home,'beta');`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, home], { encoding: 'utf8' })
  assert.equal(child.status, 23, child.stderr)
  releaseFileLock({ path: lockFilePath(home), operationId: JSON.parse(fs.readFileSync(lockFilePath(home), 'utf8')).operationId })
  // 模拟不守锁的写者把清单改到与收尾记录不一致：previous 没了，续做无从下手。
  const indexPath = rulesIndexPath(home)
  const index = readIndexFile(home)
  assert.equal(index.pendingActivation.phase, 'cleanup')
  index.pendingActivation.previous = null
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8')

  // 写入口挡下，但报错如实指向「记录与清单不一致」，不冒充读写故障。
  const blocked = saveRule(home, 'beta', 'X')
  assert.equal(blocked.code, 'conflict')
  assert.match(String(blocked.reason), /不一致/)

  // 停止类操作放行：取消激活按自身逻辑清掉这份无法自动续做的记录。
  const cleared = deactivateRule(home)
  assert.equal(cleared.ok, true)
  assert.equal(readIndex(home).pendingActivation, null)
})
