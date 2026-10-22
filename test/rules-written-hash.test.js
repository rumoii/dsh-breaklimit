// writtenHash 基线（#1）、孤儿快照保留（#2）、激活中改 target（#3）、提交冲突（#4）。
//
// 这批用例都从「一次失败之后磁盘上还剩什么、下一次操作还认不认得出」切入：
// 比对基线必须是我们写进落点的字节哈希（writtenHash），不是活正文；旧清单记录没有
// 该字段时行为退回旧基线。断言落在文件内容、清单字段与结构化返回值上。

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  INDEX_VERSION,
  activateRule,
  bodiesDir,
  deactivateRule,
  landingPath,
  readActive,
  readIndex,
  readRuleMeta,
  ruleTextPath,
  rulesIndexPath,
  saveRule,
  targetPath,
} from '../src/context/rules.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-written-hash-'))
}

function seedTarget(home, target, text) {
  fs.writeFileSync(targetPath(home, target), text, 'utf8')
}

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

function readIndexFile(home) {
  return JSON.parse(fs.readFileSync(rulesIndexPath(home), 'utf8'))
}

// 与 hashBytes 同口径：内容的完整 sha256 摘要。
const fullHash = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

/** 让下一次改名到 toPath 的写入失败，模拟落点同步写不进去。 */
function failRenameOnce(toPath) {
  const original = fs.renameSync
  let failed = false
  fs.renameSync = (from, to) => {
    if (!failed && to === toPath) {
      failed = true
      throw new Error('模拟改名失败')
    }
    return original(from, to)
  }
  return () => { fs.renameSync = original }
}

/** 让第 n 次改名到 toPath 的写入失败。saveRule 里第 1 次是规则清单、第 2 次是哈希记录。 */
function failNthRename(home, n) {
  const original = fs.renameSync
  const index = rulesIndexPath(home)
  let count = 0
  fs.renameSync = (from, to) => {
    if (to === index) {
      count += 1
      if (count === n) throw new Error('模拟清单改名失败')
    }
    return original(from, to)
  }
  return () => { fs.renameSync = original }
}

/**
 * 在第 n 次 rules.json 临时文件落盘时把清单换成外部版本，模拟不守锁的写者。
 * transforms：{ 第几次临时文件落盘: (当前清单) => 外部清单 }。
 */
function externalIndexWrites(home, transforms) {
  const originalWrite = fs.writeFileSync
  let count = 0
  fs.writeFileSync = (file, data, ...rest) => {
    const written = originalWrite(file, data, ...rest)
    if (String(file).includes('.rules.json.bkl-')) {
      count += 1
      const transform = transforms[count]
      if (transform !== undefined) {
        const current = JSON.parse(fs.readFileSync(rulesIndexPath(home), 'utf8'))
        originalWrite(rulesIndexPath(home), `${JSON.stringify(transform(current), null, 2)}\n`, 'utf8')
      }
    }
    return written
  }
  return () => { fs.writeFileSync = originalWrite }
}

/** 手工搭一份旧清单：landing 记录按传入内容原样落盘，用来测无 writtenHash 的回退。 */
function writeIndexFile(home, { rules, active, landing, pendingActivation = null, revision = 7 }) {
  fs.mkdirSync(path.dirname(rulesIndexPath(home)), { recursive: true })
  fs.mkdirSync(bodiesDir(home), { recursive: true })
  fs.writeFileSync(
    rulesIndexPath(home),
    `${JSON.stringify({ version: INDEX_VERSION, revision, rules, active, landing, pendingActivation }, null, 2)}\n`,
    'utf8',
  )
}

function legacyLandingRule(home, { targetText, bodyText, landing }) {
  fs.mkdirSync(bodiesDir(home), { recursive: true })
  fs.writeFileSync(ruleTextPath(home, 'legacy'), bodyText, 'utf8')
  seedTarget(home, 'AGENTS.md', targetText)
  writeIndexFile(home, {
    rules: [{ id: 'legacy', name: '旧', target: 'AGENTS.md', activatedAt: null }],
    active: 'legacy',
    landing,
  })
}

test('同步失败一次后：重新保存能恢复同步，不再永久 stale', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)

  // 本次保存的落点同步写失败：正文与清单已写新，落点还是旧的。
  const restore = failRenameOnce(targetPath(home, 'AGENTS.md'))
  let failed
  try {
    failed = saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' })
  } finally {
    restore()
  }
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'landing_write_failed')
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'A body')

  // 基线是 writtenHash（落点里实际是我们写的 A body），不是已经漂走的活正文：
  // 下一次保存还认得出，能接着同步。
  const saved = saveRule(home, 'alpha', 'A body v3', { target: 'AGENTS.md' })
  assert.equal(saved.ok, true)
  assert.equal(saved.landingSynced, true)
  assert.equal(saved.landingStale, false)
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'A body v3')

  // 持久化形状：landing 记录的 writtenHash = 写入落点的完整 sha256 摘要。
  const persisted = readIndexFile(home).landing
  assert.match(persisted.writtenHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(persisted.writtenHash, fullHash('A body v3'))
})

test('同步失败一次后：取消激活按 writtenHash 判「未被改过」，插件创建的落点照常删', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  const restore = failRenameOnce(targetPath(home, 'AGENTS.md'))
  try {
    assert.equal(saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' }).code, 'landing_write_failed')
  } finally {
    restore()
  }

  // 正文已漂到 A body v2、落点还是 A body：活正文基线会永远判「内容已被改动」。
  const off = deactivateRule(home)
  assert.equal(off.ok, true)
  assert.deepEqual(off.skipped, [])
  assert.equal(off.removed, true)
  assert.equal(off.restored, false)
  assert.equal(fs.existsSync(targetPath(home, 'AGENTS.md')), false)
  assert.equal(readActive(home), null)
})

test('同步失败一次后：取消激活按 writtenHash 判「未被改过」，本来就有的落点写回原文', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  const restore = failRenameOnce(targetPath(home, 'AGENTS.md'))
  try {
    assert.equal(saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' }).code, 'landing_write_failed')
  } finally {
    restore()
  }

  const off = deactivateRule(home)
  assert.equal(off.ok, true)
  assert.deepEqual(off.skipped, [])
  assert.equal(off.restored, true)
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'original text')
})

test('哈希记录写不进去：落点退回同步前字节，基线不被污染，重试仍能同步', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)

  // 第 2 次改名到 rules.json 是 writtenHash 记录写入，让它失败一次。
  const restore = failNthRename(home, 2)
  let failed
  try {
    failed = saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' })
  } finally {
    restore()
  }
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'index_write_failed')
  assert.equal(failed.landingRestored, true)
  // 落点退回同步前的字节，writtenHash 与落点内容仍一致。
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'A body')
  assert.equal(readIndexFile(home).landing.writtenHash, fullHash('A body'))

  const saved = saveRule(home, 'alpha', 'A body v3', { target: 'AGENTS.md' })
  assert.equal(saved.landingSynced, true)
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'A body v3')
})

test('旧索引兼容：无 writtenHash 读出 null，比对退回活正文（一致则同步并升级记录）', () => {
  const home = tempHome()
  legacyLandingRule(home, {
    targetText: 'legacy body',
    bodyText: 'legacy body',
    landing: { target: 'AGENTS.md', created: false },
  })
  assert.deepEqual(readIndex(home).landing, { target: 'AGENTS.md', created: false, writtenHash: null })

  const saved = saveRule(home, 'legacy', 'legacy body v2', { target: 'AGENTS.md' })
  assert.equal(saved.ok, true)
  assert.equal(saved.landingSynced, true)
  assert.equal(saved.landingStale, false)
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'legacy body v2')
  // 同步成功后补写 writtenHash：旧记录就地升级，之后走新基线。
  assert.equal(readIndexFile(home).landing.writtenHash, fullHash('legacy body v2'))
})

test('旧索引兼容：无 writtenHash 且落点与正文不一致时，按旧行为判 stale / 判被改动', () => {
  const home = tempHome()
  legacyLandingRule(home, {
    targetText: 'user edited',
    bodyText: 'legacy body',
    landing: { target: 'AGENTS.md', created: false },
  })

  const saved = saveRule(home, 'legacy', 'legacy body v2', { target: 'AGENTS.md' })
  assert.equal(saved.ok, true)
  assert.equal(saved.landingSynced, false)
  assert.equal(saved.landingStale, true)
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'user edited')

  const off = deactivateRule(home)
  assert.equal(off.ok, true)
  assert.equal(off.kept, true)
  assert.equal(off.skipped.length, 1)
  assert.match(off.skipped[0].reason, /内容已被改动/u)
  assert.equal(readActive(home), 'legacy')
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'user edited')
})

test('landing 记录解析：未知字段丢弃，坏 writtenHash 按缺失回退', () => {
  const home = tempHome()
  legacyLandingRule(home, {
    targetText: 'user edited',
    bodyText: 'legacy body',
    landing: { target: 'AGENTS.md', created: false, writtenHash: 'not-a-digest', extra: 'x' },
  })
  assert.deepEqual(readIndex(home).landing, { target: 'AGENTS.md', created: false, writtenHash: null })
})

test('孤儿快照搬成保留副本，新快照照常写、不丢原文', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'first original')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  // 落点被手改后切到另一个落点：旧落点判 skipped，快照 landings/AGENTS.md 失去归属。
  seedTarget(home, 'AGENTS.md', 'user edit')
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'CLAUDE.md' }).ok, true)
  const switched = activateRule(home, 'beta')
  assert.equal(switched.ok, true)
  assert.equal(readText(landingPath(home, 'AGENTS.md')), 'first original')

  // 再激活回 AGENTS.md：孤儿快照先搬成保留副本，新快照照常记本次接管前的内容。
  assert.equal(saveRule(home, 'gamma', 'G body', { target: 'AGENTS.md' }).ok, true)
  const activated = activateRule(home, 'gamma')
  assert.equal(activated.ok, true)
  assert.equal(typeof activated.keptCopy, 'string')
  assert.match(path.basename(activated.keptCopy), /^AGENTS\.md\.kept-/)
  assert.equal(readText(activated.keptCopy), 'first original')
  assert.equal(readText(landingPath(home, 'AGENTS.md')), 'user edit')
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'G body')

  // 取消激活恢复的是本次快照；保留副本里的首次接管原文仍然在。
  const off = deactivateRule(home)
  assert.equal(off.restored, true)
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'user edit')
  assert.equal(readText(activated.keptCopy), 'first original')
})

test('激活中改 target：写旧落点，meta.target 报实际落点，landingMoved 为 true', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)

  const saved = saveRule(home, 'alpha', 'A body v2', { target: 'CLAUDE.md' })
  assert.equal(saved.ok, true)
  assert.equal(saved.landingSynced, true)
  assert.equal(saved.landingMoved, true)
  // meta.target 报实际写入的落点，不是请求里的新 target。
  assert.equal(saved.meta.target, 'AGENTS.md')
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'A body v2')
  assert.equal(fs.existsSync(targetPath(home, 'CLAUDE.md')), false)

  // 清单里规则的 target 照请求记；落点归属与 writtenHash 都留在实际生效的落点上。
  assert.equal(readRuleMeta(home, 'alpha').target, 'CLAUDE.md')
  const index = readIndex(home)
  assert.equal(index.landing.target, 'AGENTS.md')
  assert.equal(index.landing.writtenHash, fullHash('A body v2'))

  // 同落点保存：请求与实际一致，landingMoved 为 false。
  const same = saveRule(home, 'alpha', 'A body v3', { target: 'AGENTS.md' })
  assert.equal(same.landingMoved, false)
  assert.equal(same.meta.target, 'AGENTS.md')
})

const externalRule = { id: 'external', name: '外部', target: 'AGENTS.md', activatedAt: null }

test('提交激活冲突：清单可回滚时撤销本次意图，状态复原', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)

  // 提交那一次写清单时外部换掉它：带走了别的改动，但 pendingActivation 还是本次意图。
  const restore = externalIndexWrites(home, {
    2: current => ({ ...current, revision: 99, rules: [...current.rules, externalRule] }),
  })
  let result
  try {
    result = activateRule(home, 'alpha')
  } finally {
    restore()
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  assert.equal(result.landingRestored, true)
  assert.equal(result.rolledBack, true)
  assert.equal(result.activeNow, null)

  // 状态复原：落点是接管前的字节、没有激活、意图已撤销；外部写者的改动不被覆盖。
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'original text')
  assert.equal(readActive(home), null)
  const index = readIndex(home)
  assert.equal(index.pendingActivation, null)
  assert.equal(index.landing, null)
  assert.equal(index.rules.some(rule => rule.id === 'external'), true)
})

test('提交激活冲突：意图已被外部改动时不回滚，失败结果带真实状态', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)

  // 外部写者换掉了清单，pendingActivation 不再是本次意图（已被清掉，active 是别人的）。
  const restore = externalIndexWrites(home, {
    2: current => ({
      ...current,
      revision: 99,
      active: 'external-rule',
      pendingActivation: null,
      rules: [...current.rules, { ...externalRule, id: 'external-rule', name: '外部规则' }],
    }),
  })
  let result
  try {
    result = activateRule(home, 'alpha')
  } finally {
    restore()
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  assert.equal(result.rolledBack, false)
  assert.equal(result.landingRestored, true)
  // 真实状态：当前激活是外部写者写的那条，落点已还原。
  assert.equal(result.activeNow, 'external-rule')
  assert.match(result.reason, /当前激活/u)
  assert.match(result.reason, /落点已还原/u)
  assert.equal(readActive(home), 'external-rule')
  assert.equal(readIndex(home).pendingActivation, null)
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'original text')
})

test('提交激活冲突：回滚也冲突时如实报失败，带真实状态', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)

  // 提交时外部换掉清单（意图还是本次的）；回滚那一次写清单时外部又换了一次。
  const restore = externalIndexWrites(home, {
    2: current => ({
      ...current,
      revision: 99,
      active: 'external-rule',
      rules: [...current.rules, { ...externalRule, id: 'external-rule', name: '外部规则' }],
    }),
    3: current => ({ ...current, revision: 100 }),
  })
  let result
  try {
    result = activateRule(home, 'alpha')
  } finally {
    restore()
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  assert.equal(result.rolledBack, false)
  assert.equal(result.landingRestored, true)
  assert.equal(result.activeNow, 'external-rule')
  assert.match(result.reason, /回滚失败/u)
  assert.match(result.reason, /落点已还原/u)
  // 回滚没成功，盘上的事实原样可见：意图还挂着，等待恢复入口处理。
  assert.equal(readIndex(home).pendingActivation?.id, 'alpha')
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'original text')
})
