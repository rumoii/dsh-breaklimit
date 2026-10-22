// 激活覆盖外部改动前留副本（P1-2 回归）。
//
// 激活的语义就是把新正文写进落点，所以「外部改动不覆盖」在这里守的是「不丢」：
// 被覆盖的字节不属于任何插件副本时先存副本再覆盖，路径从 externalCopy 报出。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  activateRule,
  landingPath,
  saveRule,
  targetPath,
} from '../src/context/rules.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-copy-'))
}

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

test('有首接快照的落点被外部改过、再激活另一条：外部改动存副本，快照不动', () => {
  const home = tempHome()
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), 'USER ORIGINAL', 'utf8')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), 'USER EXTERNAL EDIT', 'utf8')
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)

  const activated = activateRule(home, 'beta')
  assert.equal(activated.ok, true)
  assert.equal(typeof activated.externalCopy, 'string')
  assert.equal(readText(activated.externalCopy), 'USER EXTERNAL EDIT')
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'B body')
  // 副本不抢快照入口：首次接管时的原文快照原封不动。
  assert.equal(readText(landingPath(home, 'AGENTS.md')), 'USER ORIGINAL')
})

test('插件自建的落点被手改、再激活另一条：手改内容进快照，不丢字节', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), 'USER EXTERNAL EDIT', 'utf8')
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)

  const activated = activateRule(home, 'beta')
  assert.equal(activated.ok, true)
  // 没有首接快照时，本次快照存的就是现有字节——手改内容已有去处，无需另存副本。
  assert.equal(activated.externalCopy, null)
  assert.equal(readText(landingPath(home, 'AGENTS.md')), 'USER EXTERNAL EDIT')
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'B body')
})

test('正常切换（落点还是我们写的内容）不留副本', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)

  const activated = activateRule(home, 'beta')
  assert.equal(activated.ok, true)
  assert.equal(activated.externalCopy, null)
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'B body')
})

test('新接管用户已有文件：内容由快照保存，不另留副本', () => {
  const home = tempHome()
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), 'USER ORIGINAL', 'utf8')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)

  const activated = activateRule(home, 'alpha')
  assert.equal(activated.ok, true)
  assert.equal(activated.externalCopy, null)
  // 原文进快照，撤销时可恢复——这就是「已有副本」。
  assert.equal(readText(landingPath(home, 'AGENTS.md')), 'USER ORIGINAL')
})

test('对已激活规则再 activate 且落点被改过：同样留副本并覆盖', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  fs.writeFileSync(targetPath(home, 'AGENTS.md'), 'USER EXTERNAL EDIT', 'utf8')

  const again = activateRule(home, 'alpha')
  assert.equal(again.ok, true)
  assert.equal(typeof again.externalCopy, 'string')
  assert.equal(readText(again.externalCopy), 'USER EXTERNAL EDIT')
  assert.equal(readText(targetPath(home, 'AGENTS.md')), 'A body')
})

test('插件自己写的旧正文不算外部改动：切走再切回不留副本', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'beta').ok, true)
  // 落点当前是 B body；alpha 的正文仍完整存在于 bodies/，切回不算外部改动。
  const back = activateRule(home, 'alpha')
  assert.equal(back.ok, true)
  assert.equal(back.externalCopy, null)
})
