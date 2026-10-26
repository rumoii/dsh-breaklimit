import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { maskText, normalizeEntries } from '../src/host/masks.js'

const CLIENT = new URL('../src/client.js', import.meta.url)

// 最小宿主桩：把 client.js 按宿主的方式加载起来，取到导出的纯函数与组件。
// 组件是纯函数，直接调用再把函数子组件展开成普通节点树，就能断言真实渲染结果。
function loadClient(sandboxExtras = {}, reactExtras = {}) {
  let registration
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [initial, () => {}],
    useEffect() {},
    useCallback: fn => fn,
    useRef: current => ({ current }),
    ...reactExtras,
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document: { head: null, documentElement: { lang: 'en' }, getElementById() { return null } },
    navigator: { language: 'en' },
    ...sandboxExtras,
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)
  return { exported, registration }
}

function mount(node) {
  if (Array.isArray(node)) return node.flatMap(mount)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return mount(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(mount) }
}

function findAll(node, pred, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, pred, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const child of node.children) findAll(child, pred, out)
  return out
}

const textOf = (node) => {
  const parts = []
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (value !== null && typeof value === 'object') return value.children.forEach(walk)
    parts.push(String(value))
  }
  walk(node.children)
  return parts.join('')
}

test('设置页五页导航方向键同步移动键盘焦点', () => {
  let registration
  let component
  let dock
  let focused
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [initial, () => {}],
    useEffect() {},
    useCallback: fn => fn,
    useRef: current => ({ current }),
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document: {
      head: null,
      documentElement: { lang: 'en' },
      getElementById(id) { return { focus() { focused = id } } },
    },
    navigator: { language: 'en' },
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)
  exported.apply({
    effect(fn) { fn() },
    slots: {
      inject(_name, fn) { fn() },
      register(metadata, value) {
        // 一个 factory 现在会注册两个落点：设置分区与输入框下方的词表行。
        // 按 name 取，不靠注册顺序，否则后注册的那个会把前一个顶掉。
        if (metadata?.name === 'settings.section') component = value
        else if (metadata?.name === 'conversation.input.dock') dock = value
      },
    },
  })
  const tabs = []
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    if (node.props?.role === 'tab') tabs.push(node)
    visit(node.children)
  }
  visit(component())
  assert.equal(tabs.length, 5)
  assert.deepEqual(tabs.map(tab => tab.props.id), [
    'bkl-tab-overview', 'bkl-tab-patches', 'bkl-tab-prompt', 'bkl-tab-rules', 'bkl-tab-words',
  ])
  function key(index, value, expected) {
    let prevented = false
    tabs[index].props.onKeyDown({ key: value, preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(focused, `bkl-tab-${expected}`)
  }
  key(0, 'ArrowRight', 'patches')
  key(0, 'ArrowLeft', 'words')
  key(1, 'Home', 'overview')
  key(1, 'End', 'words')
  key(4, 'ArrowRight', 'overview')

  // 输入框下方的词表行必须真的注册出去，否则设置里看得到、对话里找不到入口。
  assert.equal(typeof dock, 'function')
})

test('草稿脏判定覆盖改动与未改动，beforeunload 守卫在无草稿时不拦截', () => {
  let registration
  let beforeunloadHandler = null
  const listeners = {}
  const react = {
    createElement: (type, props, ...children) => {
      if (typeof type === 'function') {
        return type({ ...(props ?? {}), children })
      }
      return { type, props: props ?? {}, children }
    },
    useState: initial => [initial, () => {}],
    useEffect(fn) { fn() },
    useCallback: fn => fn,
    useRef: current => ({ current }),
  }
  const sandbox = {
    setInterval: () => 123,
    clearInterval: () => {},
    setTimeout: () => 456,
    clearTimeout: () => {},
    window: {
      __ModuleLoader__: { load(value) { registration = value } },
      addEventListener(type, fn) { listeners[type] = fn; if (type === 'beforeunload') beforeunloadHandler = fn },
      removeEventListener(type) { delete listeners[type] },
    },
    document: {
      head: null,
      documentElement: { lang: 'zh' },
      getElementById() { return null },
    },
    navigator: { language: 'zh' },
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)
  let component
  exported.apply({
    effect(fn) { fn() },
    slots: {
      inject(_name, fn) { fn() },
      register(metadata, value) {
        if (metadata?.name === 'settings.section') component = value
      },
    },
  })

  // 渲染组件并确保 beforeunload 守卫已被注册
  component()
  assert.equal(typeof beforeunloadHandler, 'function')

  // 脏判定本身在这里直接测：桩里的 useState 恒返回初始值，ruleEdit 永远是 null，
  // 靠渲染逼不出脏草稿。判定是纯函数，测它比测 React 生命周期可靠。
  const isDirty = exported.isRuleEditDirty
  assert.equal(typeof isDirty, 'function')
  assert.equal(isDirty(null), false)

  const fresh = { isNew: true, id: "", name: "", target: "AGENTS.md", text: "" }
  assert.equal(isDirty({ ...fresh, baseline: fresh }), false)
  assert.equal(isDirty({ ...fresh, id: "abc", baseline: fresh }), true)
  assert.equal(isDirty({ ...fresh, name: "名字", baseline: fresh }), true)
  assert.equal(isDirty({ ...fresh, text: "正文", baseline: fresh }), true)

  const loaded = { isNew: false, id: "abc", name: "", target: "AGENTS.md", text: "body" }
  assert.equal(isDirty({ ...loaded, baseline: loaded }), false)
  assert.equal(isDirty({ ...loaded, text: "body2", baseline: loaded }), true)
  assert.equal(isDirty({ ...loaded, target: "CLAUDE.md", baseline: loaded }), true)
  assert.equal(isDirty({ ...loaded, name: "N", baseline: loaded }), true)

  // 验证 beforeunload 拦截逻辑
  let prevented = false
  const dummyEvent = {
    preventDefault() { prevented = true },
    returnValue: null,
  }
  beforeunloadHandler(dummyEvent)
  // 无草稿时默认不拦截
  assert.equal(prevented, false)
})

test('正文读取失败时不显示空正文或内置正文，也不许覆盖', () => {
  const { exported } = loadClient()
  let saved = 0
  let reset = 0
  const promptError = { tone: 'error', title: 'x', next: 'y' }
  const tree = mount(exported.PromptBlock({
    override: null,
    promptError,
    draft: null,
    setDraft() {},
    busy: false,
    onSave() { saved += 1 },
    onReset() { reset += 1 },
    onDiscard() {},
    onCopy() {},
    onRetry() {},
    noticeView: null,
  }))
  const textarea = findAll(tree, node => node.type === 'textarea')[0]
  assert.equal(textarea.props.value, '')
  assert.equal(textarea.props.readOnly, true)
  assert.equal(textarea.props['aria-invalid'], 'true')
  const buttons = findAll(tree, node => node.type === 'button')
  const save = buttons.find(button => textOf(button).includes('Save'))
  const resetButton = buttons.find(button => textOf(button).includes('Restore built-in'))
  assert.equal(save.props['aria-disabled'], 'true')
  assert.equal(resetButton.props['aria-disabled'], 'true')
  // 按钮即便被点到也不执行动作（Button 用 off 拦截）。
  save.props.onClick({ preventDefault() {} })
  resetButton.props.onClick({ preventDefault() {} })
  assert.equal(saved, 0)
  assert.equal(reset, 0)
  // 读取失败用 StateBlock(error) 承载，横幅带「重新读取」动作，而不是给一个空编辑器让人保存。
  const stateError = findAll(tree, n => n.props?.className && String(n.props.className).includes('bkl-state-error'))[0]
  assert.equal(Boolean(stateError), true, '读取失败应渲染 bkl-state-error 状态块')
  const retry = buttons.find(button => textOf(button).includes('Read the prompt again'))
  assert.equal(retry !== undefined, true)
})

test('HTTP 成功但 effective 读取失败时，正文仍未知且所有覆盖操作暂停', () => {
  const { exported } = loadClient()
  const tree = mount(exported.PromptBlock({
    override: { text: '', userFileExists: true, bytes: 900000, effective: { ok: false, code: 'inject_too_large' } },
    promptError: null, draft: 'new text', setDraft() {}, busy: false,
    onSave() { assert.fail('must not save') }, onReset() { assert.fail('must not reset') },
    onDiscard() {}, onCopy() { assert.fail('must not copy') }, onRetry() {}, noticeView: null,
  }))
  const textarea = findAll(tree, n => n.type === 'textarea')[0]
  assert.equal(textarea.props.readOnly, true)
  assert.equal(textarea.props['aria-invalid'], 'true')
  assert.match(textOf(tree), /current turn fails/u)
  assert.doesNotMatch(textOf(tree), /gets an empty body/u)
  for (const label of ['Save', 'Restore built-in', 'Copy all']) {
    const button = findAll(tree, n => n.type === 'button').find(n => textOf(n).includes(label))
    assert.equal(button.props['aria-disabled'], 'true')
    button.props.onClick({ preventDefault() {} })
  }
})

test('正文读取成功后才允许编辑与保存，草稿优先于已保存正文', () => {
  const { exported } = loadClient()
  let received = null
  let saved = 0
  const tree = mount(exported.PromptBlock({
    override: { text: 'builtin text', userFileExists: true, bytes: 12, effective: { ok: true } },
    promptError: null,
    draft: 'my draft',
    setDraft(value) { received = value },
    busy: false,
    onSave() { saved += 1 },
    onReset() {},
    onDiscard() {},
    onCopy() {},
    onRetry() {},
    noticeView: null,
  }))
  const textarea = findAll(tree, node => node.type === 'textarea')[0]
  assert.equal(textarea.props.value, 'my draft')
  assert.equal(textarea.props.readOnly, undefined)
  textarea.props.onChange({ target: { value: 'typed later' } })
  assert.equal(received, 'typed later')
  const save = findAll(tree, node => node.type === 'button').find(button => textOf(button).includes('Save'))
  assert.equal(save.props['aria-disabled'], undefined)
  save.props.onClick({ preventDefault() {} })
  assert.equal(saved, 1)
})

test('保存期间继续输入的新内容不被成功回调清除', () => {
  const { exported } = loadClient()
  assert.equal(exported.draftAfterSave('submitted', 'submitted'), null)
  assert.equal(exported.draftAfterSave('submitted plus more', 'submitted'), 'submitted plus more')
  assert.equal(exported.draftAfterSave(null, 'submitted'), null)
})

test('规则保存只邀请激活，绝不自动激活；外部修改时不邀请', () => {
  const { exported } = loadClient()
  const edit = { id: 'r1', name: 'n', target: 'AGENTS.md', text: 't' }
  const inactive = exported.ruleSaveNotice({}, null, edit)
  assert.equal(inactive.activateRule, 'r1')
  assert.equal(inactive.tone, 'ok')
  const active = exported.ruleSaveNotice({}, 'r1', edit)
  assert.equal(active.activateRule, null)
  const stale = exported.ruleSaveNotice({ landingStale: true, target: 'AGENTS.md' }, null, edit)
  assert.equal(stale.activateRule, null)
  assert.equal(stale.tone, 'warn')
  const moved = exported.ruleSaveNotice({ landingMoved: true, target: 'CLAUDE.md' }, null, edit)
  assert.equal(moved.activateRule, null)
})

test('词条校验：去空白后判空、同词、64/65 边界与 100 条上限', () => {
  const { exported } = loadClient()
  const errors = exported.wordEntryErrors
  assert.deepEqual(
    [errors('  a  ', '  b  ').from, errors('  a  ', '  b  ').to, errors('  a  ', '  b  ').limit],
    ['', '', ''],
  )
  assert.notEqual(errors('', 'b').from, '')
  assert.notEqual(errors('a', '').to, '')
  assert.notEqual(errors('same', ' same ').to, '')
  assert.equal(errors('x'.repeat(64), 'b').from, '')
  assert.notEqual(errors('x'.repeat(65), 'b').from, '')
  assert.equal(errors('a', 'y'.repeat(64)).to, '')
  assert.notEqual(errors('a', 'y'.repeat(65)).to, '')
  const full = Array.from({ length: 100 }, (_, index) => ({ from: `w${String(index)}`, to: `t${String(index)}` }))
  // 到达上限：新增被挡，但编辑或用相同原词覆盖仍然放行。
  assert.notEqual(errors('brand-new', 'b', { entries: full }).limit, '')
  assert.equal(errors('w5', 'b', { entries: full }).limit, '')
  assert.equal(errors('w5', 'b', { entries: full, originalFrom: 'w5' }).limit, '')
  assert.equal(errors('brand-new', 'b', { entries: full.slice(0, 99) }).limit, '')
})

test('词条整表计算：覆盖与合并的最终保留记录都可预测', () => {
  const { exported } = loadClient()
  const entries = [
    { from: 'old', to: 'new' },
    { from: 'dup', to: 'x' },
    { from: 'tail', to: 'z' },
  ]
  const save = (originalFrom, entry) => ({ type: 'save', originalFrom, entry })
  // 新增撞原词 → overwrite；目标那条换成新值，位置不变。
  assert.equal(exported.aliasChangeKind(entries, save(null, { from: 'dup', to: 'y' })), 'overwrite')
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported.aliasNextEntries(entries, save(null, { from: 'dup', to: 'y' })))),
    [{ from: 'old', to: 'new' }, { from: 'dup', to: 'y' }, { from: 'tail', to: 'z' }],
  )
  // 编辑改名撞原词 → merge；原记录消失，最终只留同名词条那条。
  assert.equal(exported.aliasChangeKind(entries, save('old', { from: 'dup', to: 'y' })), 'merge')
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported.aliasNextEntries(entries, save('old', { from: 'dup', to: 'y' })))),
    [{ from: 'dup', to: 'y' }, { from: 'tail', to: 'z' }],
  )
  // 改名到新原词 → 无冲突，原位替换。
  assert.equal(exported.aliasChangeKind(entries, save('old', { from: 'fresh', to: 'q' })), null)
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported.aliasNextEntries(entries, save('old', { from: 'fresh', to: 'q' })))),
    [{ from: 'fresh', to: 'q' }, { from: 'dup', to: 'x' }, { from: 'tail', to: 'z' }],
  )
  // 原词原地换替换词 → 无冲突。
  assert.equal(exported.aliasChangeKind(entries, save('dup', { from: 'dup', to: 'y' })), null)
  // 删除按原词整条移除。
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported.aliasNextEntries(entries, { type: 'delete', from: 'dup' }))),
    [{ from: 'old', to: 'new' }, { from: 'tail', to: 'z' }],
  )
})

test('本地预览与 host/masks.js 的 maskText 逐例一致', () => {
  const { exported } = loadClient()
  const cases = [
    ['百度贴吧和百度都行', [{ from: '百度', to: 'X' }, { from: '百度贴吧', to: 'Y' }]],
    ['Hello hello HELLO', [{ from: 'hello', to: 'hi' }]],
    // 后面的词条会继续匹配前面替换产生的文本。
    ['aaabbb', [{ from: 'a', to: 'aa' }, { from: 'aa', to: 'z' }]],
    ['', [{ from: 'a', to: 'b' }]],
    ['一段普通文本', [{ from: '', to: 'x' }, { from: 'same', to: 'same' }, { from: '普通', to: '一般' }]],
    ['dup dup dup', [{ from: 'dup', to: '1' }, { from: 'dup', to: '2' }]],
    ['long and short', [{ from: 'long and', to: 'L' }, { from: 'short', to: 'S' }, { from: 'and', to: 'A' }]],
  ]
  for (const [text, entries] of cases) {
    assert.equal(
      JSON.stringify(exported.maskPreview(text, entries)),
      JSON.stringify(maskText(text, entries)),
      `预览与 maskText 不一致：${JSON.stringify([text, entries])}`,
    )
  }
  // 超过 100 条同样按 host/masks.js 的口径截断。
  const many = Array.from({ length: 120 }, (_, index) => ({ from: `w${String(index)}`, to: `t${String(index)}` }))
  assert.equal(
    JSON.stringify(exported.maskPreview('w0 w119', many)),
    JSON.stringify(maskText('w0 w119', many)),
  )
  assert.equal(JSON.stringify(exported.normalizeAliasEntries(many)), JSON.stringify(normalizeEntries(many)))
})

test('词条编辑弹窗：覆盖与合并写明最终保留的记录，取消回到编辑保留输入', () => {
  const { exported } = loadClient()
  const entries = [{ from: 'old', to: 'new' }, { from: 'dup', to: 'x' }]
  let backed = 0
  let overwrote = 0
  const mergeEditor = {
    phase: 'merge', originalFrom: 'old', from: 'dup', to: 'y',
    baselineFrom: 'old', baselineTo: 'new', touched: true,
  }
  const mergeSpec = exported.WordEditor({
    editor: mergeEditor,
    entries,
    limits: { maxEntries: 100, maxTerm: 64 },
    saving: false,
    error: null,
    onField() {},
    onSave() {},
    onCancel() {},
    onBack() { backed += 1 },
    onConfirmOverwrite() { overwrote += 1 },
    onConfirmDiscard() {},
  })
  const merge = mount([mergeSpec.body, mergeSpec.foot])
  const mergePairs = findAll(merge, node => node.type === 'div' && node.props?.style?.gridTemplateColumns !== undefined)
    .map(pair => textOf(pair))
  // 三段：正在编辑的原记录、将被覆盖的记录、最终保留一条。
  assert.equal(mergePairs.some(text => text.includes('old') && text.includes('new')), true)
  assert.equal(mergePairs.some(text => text.includes('dup') && text.includes('x')), true)
  assert.equal(mergePairs.some(text => text.includes('dup') && text.includes('y')), true)
  const mergeButtons = findAll(merge, node => node.type === 'button')
  const back = mergeButtons.find(button => textOf(button).includes('Back to editing'))
  const yes = mergeButtons.find(button => textOf(button).includes('Merge and overwrite'))
  assert.equal(back !== undefined, true)
  assert.equal(yes !== undefined, true)
  back.props.onClick({ preventDefault() {} })
  yes.props.onClick({ preventDefault() {} })
  assert.equal(backed, 1)
  assert.equal(overwrote, 1)

  // 编辑态：输入值来自草稿，64 字符边界报在字段上，取消与保存按钮都接好线。
  let closed = 0
  let saved = 0
  const editSpec = exported.WordEditor({
    editor: {
      phase: 'edit', originalFrom: 'old', from: 'x'.repeat(65), to: 'y',
      baselineFrom: 'old', baselineTo: 'new', touched: true,
    },
    entries,
    limits: { maxEntries: 100, maxTerm: 64 },
    saving: false,
    error: null,
    onField() {},
    onSave() { saved += 1 },
    onCancel() { closed += 1 },
    onBack() {},
    onConfirmOverwrite() {},
    onConfirmDiscard() {},
  })
  const edit = mount([editSpec.body, editSpec.foot])
  const inputs = findAll(edit, node => node.type === 'input')
  assert.equal(inputs[0].props.value, 'x'.repeat(65))
  const fieldError = findAll(edit, node => node.type === 'span' && node.props?.id === 'bkl-word-from-error')[0]
  assert.notEqual(textOf(fieldError), '')
  const editButtons = findAll(edit, node => node.type === 'button')
  const saveButton = editButtons.find(button => textOf(button).includes('Save entry'))
  assert.equal(saveButton.props['aria-disabled'], 'true')
  const cancel = editButtons.find(button => textOf(button).includes('Cancel'))
  cancel.props.onClick({ preventDefault() {} })
  assert.equal(closed, 1)
})

test('词库共享 store：串行整表写入、过期响应作废、失败保留旧数据', async () => {
  const { exported } = loadClient()
  const calls = []
  let disk = [{ from: 'a', to: 'b' }]
  let failMode = null
  let pendingGet = null
  const requests = {
    get: async () => {
      calls.push(['get'])
      if (failMode === 'slow') {
        return new Promise((resolve) => { pendingGet = resolve })
      }
      if (failMode === 'get') {
        const error = new Error('offline')
        error.code = 'network'
        throw error
      }
      return { ok: true, code: 'ok', message: '', data: { entries: disk.map(entry => ({ ...entry })), limits: { maxEntries: 100, maxTerm: 64 }, lastHits: 1 } }
    },
    put: async (_path, body) => {
      calls.push(['put', JSON.parse(JSON.stringify(body))])
      if (failMode === 'timeout') {
        const error = new Error('slow')
        error.code = 'timeout'
        throw error
      }
      if (failMode === 'write') {
        const error = new Error('disk')
        error.code = 'write_failed'
        throw error
      }
      disk = body.entries.map(entry => ({ ...entry }))
      return { ok: true, code: 'saved', data: { entries: disk.map(entry => ({ ...entry })) } }
    },
  }
  const store = exported.createAliasStore(requests)
  await store.read()
  assert.equal(store.state.phase, 'ready')
  assert.equal(store.state.entries.length, 1)

  // 两个挂载点各自提交：写入串行，后一笔基于最新列表整表写，不丢前一笔。
  const first = store.commit({ type: 'save', originalFrom: null, entry: { from: 'c', to: 'd' } })
  const second = store.commit({ type: 'save', originalFrom: null, entry: { from: 'e', to: 'f' } })
  const [r1, r2] = await Promise.all([first, second])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  const puts = calls.filter(call => call[0] === 'put')
  assert.deepEqual(puts[0][1].entries.map(entry => entry.from), ['a', 'c'])
  assert.deepEqual(puts[1][1].entries.map(entry => entry.from), ['a', 'c', 'e'])
  assert.equal(store.state.entries.length, 3)

  // 过期读取响应不能覆盖写入后的新状态。
  failMode = 'slow'
  const slow = store.read()
  await store.commit({ type: 'delete', from: 'c' })
  pendingGet({ ok: true, code: 'ok', message: '', data: { entries: [{ from: 'stale', to: 'x' }] } })
  await slow
  assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['a', 'e'])
  failMode = null

  // 写失败：已保存列表不动，草稿逻辑在调用方；明确失败不是「结果未知」。
  failMode = 'write'
  const failed = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'g', to: 'h' } })
  assert.equal(failed.ok, false)
  assert.equal(failed.unknown, false)
  assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['a', 'e'])

  // 超时/断网是「结果未知」，不能宣称未生效。
  failMode = 'timeout'
  const unknown = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'g', to: 'h' } })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.unknown, true)

  // 读取失败：已有数据保留并标旧，写入被拒绝。
  failMode = 'get'
  await store.read()
  assert.equal(store.state.phase, 'failed')
  assert.equal(store.state.stale, true)
  assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['a', 'e'])
  const refused = await store.commit({ type: 'delete', from: 'a' })
  assert.equal(refused.ok, false)
  assert.equal(refused.refused, true)
  assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['a', 'e'])

  // 重新读取成功后恢复写入。
  failMode = null
  await store.read()
  assert.equal(store.state.phase, 'ready')
  assert.equal(store.state.stale, false)
  const recovered = await store.commit({ type: 'delete', from: 'a' })
  assert.equal(recovered.ok, true)
  assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['e'])
})

test('浮窗「管理词库」直达词库页，拿不到宿主能力时退回提示', () => {
  let registration
  const sent = []
  let navHandler = null
  const opened = []
  class CustomEventStub {
    constructor(type, init) {
      this.type = type
      this.detail = init?.detail
    }
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [initial, () => {}],
    useEffect() {},
    useCallback: fn => fn,
    useRef: current => ({ current }),
  }
  const sandbox = {
    CustomEvent: CustomEventStub,
    window: {
      __ModuleLoader__: { load(value) { registration = value } },
      dispatchEvent(event) {
        sent.push({ type: event.type, detail: event.detail })
        if (event.type === 'bkl:navigate' && navHandler !== null) navHandler(event.detail)
        return true
      },
      addEventListener() {},
      removeEventListener() {},
    },
    document: { head: null, documentElement: { lang: 'zh' }, getElementById() { return null } },
    navigator: { language: 'zh' },
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)

  // 没有宿主设置能力时：事件照发，返回 false 由浮窗给提示。
  exported.apply({ effect(fn) { fn() }, slots: { inject(_name, fn) { fn() }, register() {} } })
  assert.equal(exported.openWordsFromDock(), false)
  assert.equal(sent[0].type, 'bkl:navigate')
  assert.equal(sent[0].detail.tab, 'words')
  assert.equal(sent[0].detail.handled, false)

  // 宿主提供设置分区导航时：直达 breaklimit 分区（词库页由待落地页签接手）。
  exported.apply({
    effect(fn) { fn() },
    slots: {
      inject(_name, fn) { fn() },
      register() {},
      entries(key) {
        if (key !== 'sidebar.settings') return []
        return [{ store: { create: () => ({ actions: { openSection: (id) => opened.push(id) } }) } }]
      },
    },
  })
  assert.equal(exported.openWordsFromDock(), true)
  assert.deepEqual(opened, ['breaklimit'])

  // 设置分区已挂载（事件被认领）时：直接切页，不再去开设置面板。
  opened.length = 0
  navHandler = (detail) => { detail.handled = true }
  assert.equal(exported.openWordsFromDock(), true)
  assert.deepEqual(opened, [])
  assert.equal(sent.at(-1).detail.handled, true)

  // 词库写完后通知另一处挂载点重拉。
  exported.notifyStateChanged()
  assert.equal(sent.at(-1).type, 'bkl:state-changed')
})

test('词库读取告警随 200 返回时按读取失败处理，不当成空词库', async () => {
  const { exported } = loadClient()
  const store = exported.createAliasStore({
    get: async () => ({ ok: true, code: 'ok', message: '词表文件不是合法 JSON，已按空表处理。', data: { entries: [] } }),
    put: async () => ({ ok: true, code: 'saved', data: { entries: [] } }),
  })
  await store.read()
  assert.equal(store.state.phase, 'failed')
  assert.equal(store.state.stale, true)
  const refused = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'a', to: 'b' } })
  assert.equal(refused.refused, true)
})

// Dialog 的焦点往返：开口朝 DOM 节点存触发元素，关的时候还回去。
// 这条用例只证明组件逻辑；真实浏览器里 <dialog> 的焦点行为仍要另行验收。
function dialogHarness(activeElement) {
  let focused = null
  const dialogEl = {
    open: false,
    showModal() { this.open = true },
    close() { this.open = false },
    querySelector() { return null },
  }
  const effects = []
  const react = {
    createElement: (type, props, ...children) => {
      if (type === 'dialog' && props !== undefined && props.ref !== undefined) props.ref.current = dialogEl
      return { type, props: props ?? {}, children }
    },
    useState: initial => [initial, () => {}],
    // 真实 React 在挂载后跑 effect，这时 ref 已经赋值。桩里先收集，渲染后再跑。
    useEffect(fn) { effects.push(fn) },
    useCallback: fn => fn,
    useRef: current => ({ current }),
  }
  const { exported } = loadClient(
    { document: { head: null, documentElement: { lang: 'en' }, getElementById() { return null }, activeElement } },
    react,
  )
  const spec = { idBase: 'x', title: 't', tone: 'accent', body: null, foot: [], onClose() {} }
  const flush = () => { for (const fn of effects.splice(0)) fn() }
  const run = () => {
    exported.Dialog({ ...spec, open: true })
    flush()
    exported.Dialog({ ...spec, open: false })
    flush()
  }
  return { run, focused: () => focused, dialogEl }
}

test('Dialog 关闭时把焦点还给打开它的元素', () => {
  let focused = null
  const trigger = { tagName: 'BUTTON', isConnected: true, focus() { focused = trigger } }
  const harness = dialogHarness(trigger)
  harness.run()
  assert.equal(focused, trigger)
  assert.equal(harness.dialogEl.open, false)
})

test('Dialog 不把焦点还给 body，也不在无可还对象时乱调 focus', () => {
  let bodyFocused = false
  const body = { tagName: 'BODY', isConnected: true, focus() { bodyFocused = true } }
  const harness = dialogHarness(body)
  harness.run()
  assert.equal(bodyFocused, false)
})

// 沙箱里造出来的对象原型不同，deepStrictEqual 会因此失败；统一折成纯 JSON 再比。
const plain = value => JSON.parse(JSON.stringify(value))

test('浮窗布局：脏记录回落为空，半截字段不合并', () => {
  const { exported } = loadClient()
  assert.deepEqual(plain(exported.parseDockLayout(null)), { version: 1, rect: null })
  assert.deepEqual(plain(exported.parseDockLayout('nope')), { version: 1, rect: null })
  assert.deepEqual(plain(exported.parseDockLayout({ version: 2, rect: { x: 1, y: 1, width: 10, height: 10 } })), { version: 1, rect: null })
  assert.deepEqual(plain(exported.parseDockLayout({ version: 1, rect: { x: 'a', y: 1, width: 10, height: 10 } })), { version: 1, rect: null })
  assert.deepEqual(plain(exported.parseDockLayout({ version: 1, rect: { x: 1, y: 1, width: 0, height: 10 } })), { version: 1, rect: null })
  assert.deepEqual(
    plain(exported.parseDockLayout({ version: 1, rect: { x: 5, y: 6, width: 380, height: 460 } })),
    { version: 1, rect: { x: 5, y: 6, width: 380, height: 460 } },
  )
})

test('浮窗夹边：负坐标推回边距，越界拉回视口，过大缩小，过小撑到最小值', () => {
  const { exported } = loadClient()
  const viewport = { width: 1280, height: 800 }
  assert.deepEqual(
    plain(exported.clampDockRect({ x: -50, y: -20, width: 380, height: 460 }, viewport)),
    { x: 12, y: 12, width: 380, height: 460 },
  )
  assert.deepEqual(
    plain(exported.clampDockRect({ x: 5000, y: 5000, width: 380, height: 460 }, viewport)),
    { x: 1280 - 380 - 12, y: 800 - 460 - 12, width: 380, height: 460 },
  )
  const huge = plain(exported.clampDockRect({ x: 0, y: 0, width: 9999, height: 9999 }, viewport))
  assert.deepEqual(huge, { x: 12, y: 12, width: 1280 - 24, height: 800 - 24 })
  const tiny = plain(exported.clampDockRect({ x: 100, y: 100, width: 10, height: 10 }, viewport))
  assert.deepEqual(tiny, { x: 100, y: 100, width: 320, height: 280 })
  // 缺字段按默认宽度算，不产生 NaN 坐标。
  const empty = plain(exported.clampDockRect({}, viewport))
  assert.equal(Number.isFinite(empty.x) && Number.isFinite(empty.y), true)
  assert.equal(empty.width, 380)
})

test('浮窗默认位置完整落在视口内，小视口也不例外', () => {
  const { exported } = loadClient()
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 600 }, { width: 480, height: 420 }]) {
    const rect = plain(exported.defaultDockRect(viewport))
    assert.equal(rect.x >= 12, true, `x 越界：${JSON.stringify(rect)}`)
    assert.equal(rect.y >= 12, true, `y 越界：${JSON.stringify(rect)}`)
    assert.equal(rect.x + rect.width <= viewport.width - 12, true, `右边越界：${JSON.stringify(rect)}`)
    assert.equal(rect.y + rect.height <= viewport.height - 12, true, `底边越界：${JSON.stringify(rect)}`)
  }
})

test('浮窗组件渲染一次不抛错：触发按钮与展开后的标题栏、状态胶囊、内容区都在', () => {
  // 这条防的是「只有真正渲染才会暴露」的初始化顺序错误：常量在定义前被引用、
  // 组件里某段表达式依赖尚未赋值的变量。单测不渲染就永远看不到。
  let useStateCalls = 0
  const { exported } = loadClient({}, {
    // 第 6 个 useState 是 open；其余按初始值走，dockRect 的 initializer 要真的执行。
    useState: (initial) => {
      useStateCalls += 1
      if (useStateCalls === 6) return [true, () => {}]
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
  })
  const tree = exported.AliasRow({})
  const nodes = mount(tree)
  // 结构断言不碰文案：测试环境是英文界面，拿中文去比只会测到语言包。
  const triggers = findAll(nodes, node => node.type === 'button' && node.props && node.props['aria-haspopup'] === 'dialog')
  assert.equal(triggers.length, 1, '缺触发按钮')
  const dialogs = findAll(nodes, node => node.props && node.props.role === 'dialog')
  assert.equal(dialogs.length, 1, '应渲染一个对话框')
  assert.equal(dialogs[0].props.style.position, 'fixed', '浮窗必须脱离文档流，否则会被 composer 裁掉')
  assert.equal(typeof dialogs[0].props.style.left, 'string', '缺少视口横坐标')
  assert.equal(typeof dialogs[0].props.style.top, 'string', '缺少视口纵坐标')
  // 标题栏（可拖）、正文容器（可滚）、右下角把手：按样式找，不依赖子节点顺序。
  const kids = dialogs[0].children.filter(Boolean)
  const findByCursor = (value) => kids.find(kid => kid && kid.props && kid.props.style && kid.props.style.cursor === value)
  assert.equal(Boolean(findByCursor('move')), true, '缺可拖动的标题栏')
  assert.equal(Boolean(findByCursor('nwse-resize')), true, '缺右下角缩放把手')
  const scroller = kids.find(kid => kid && kid.props && kid.props.style && kid.props.style.overflowY === 'auto')
  assert.equal(Boolean(scroller), true, '缺可滚动的正文容器')
})

test('增强版 Dialog：ack 勾选联动确认按钮禁用与守卫提示', () => {
  // 1. 未勾选时：确认按钮应当被禁用（aria-disabled 为 true）
  const { exported: clientDefault } = loadClient()
  const treeDisabled = clientDefault.Dialog({
    open: true,
    title: '危险操作',
    ack: '我已了解此操作影响',
    yes: '确认执行',
  })
  const nodesDisabled = mount(treeDisabled)
  const checkboxes = findAll(nodesDisabled, n => n.type === 'input' && n.props?.type === 'checkbox')
  assert.equal(checkboxes.length, 1, '应渲染 ack 复选框')
  const buttons = findAll(nodesDisabled, n => n.type === 'button')
  const yesBtnDisabled = buttons.find(b => textOf(b).includes('确认执行'))
  assert.equal(Boolean(yesBtnDisabled), true, '应渲染确认按钮')
  assert.equal(yesBtnDisabled.props['aria-disabled'], 'true', '未勾选时确认按钮应处于禁用状态')

  // 2. 勾选后（模拟 useState 返回 ackChecked = true）：确认按钮解锁
  let callCount = 0
  const { exported: clientChecked } = loadClient({}, {
    useState: (initial) => {
      callCount += 1
      if (callCount === 1) return [true, () => {}] // ackChecked = true
      return [initial, () => {}]
    },
  })
  const treeEnabled = clientChecked.Dialog({
    open: true,
    title: '危险操作',
    ack: '我已了解此操作影响',
    yes: '确认执行',
  })
  const nodesEnabled = mount(treeEnabled)
  const buttonsEnabled = findAll(nodesEnabled, n => n.type === 'button')
  const yesBtnEnabled = buttonsEnabled.find(b => textOf(b).includes('确认执行'))
  assert.equal(yesBtnEnabled.props['aria-disabled'], undefined, '勾选后确认按钮应解除禁用')
})

test('增强版 Dialog：confirmWord 精准字词匹配与把手校验', () => {
  // 1. 输入未匹配时：确认按钮应被禁用
  let callCount = 0
  const { exported: clientMismatched } = loadClient({}, {
    useState: (initial) => {
      callCount += 1
      if (callCount === 2) return ['错词', () => {}] // confirmInput
      return [initial, () => {}]
    },
  })
  const treeMismatch = clientMismatched.Dialog({
    open: true,
    title: '重置规则清单',
    confirmWord: '重置',
    yes: '确认重置',
  })
  const nodesMismatch = mount(treeMismatch)
  const yesMismatch = findAll(nodesMismatch, n => n.type === 'button').find(b => textOf(b).includes('确认重置'))
  assert.equal(yesMismatch.props['aria-disabled'], 'true', '输入不符时确认按钮应处于禁用状态')

  // 2. 输入完全匹配时（含两端空白去除）：确认按钮解锁
  callCount = 0
  const { exported: clientMatched } = loadClient({}, {
    useState: (initial) => {
      callCount += 1
      if (callCount === 2) return ['  重置  ', () => {}] // confirmInput trimmed === '重置'
      return [initial, () => {}]
    },
  })
  const treeMatched = clientMatched.Dialog({
    open: true,
    title: '重置规则清单',
    confirmWord: '重置',
    yes: '确认重置',
  })
  const nodesMatched = mount(treeMatched)
  const yesMatched = findAll(nodesMatched, n => n.type === 'button').find(b => textOf(b).includes('确认重置'))
  assert.equal(yesMatched.props['aria-disabled'], undefined, '输入完全匹配时确认按钮应解除禁用')
})

test('增强版 Dialog：consequence 风险分级与后果提示行正确渲染', () => {
  const { exported } = loadClient()

  // 可逆操作 (ok: true)
  const treeOk = exported.Dialog({
    open: true,
    title: '切换模式',
    consequence: { ok: true, text: '可以随时切回' },
  })
  const nodesOk = mount(treeOk)
  const pOk = findAll(nodesOk, n => n.type === 'p' && typeof n.props?.className === 'string' && n.props.className.includes('bkl-consequence ok'))
  assert.equal(pOk.length, 1, '应渲染 ok 等级的 consequence 提示')
  assert.equal(textOf(pOk[0]).includes('可以随时切回'), true)

  // 不可逆操作 (ok: false)
  const treeDanger = exported.Dialog({
    open: true,
    title: '删除规则',
    consequence: { ok: false, text: '此操作无法撤销' },
  })
  const nodesDanger = mount(treeDanger)
  const pDanger = findAll(nodesDanger, n => n.type === 'p' && typeof n.props?.className === 'string' && n.props.className.includes('bkl-consequence danger'))
  assert.equal(pDanger.length, 1, '应渲染 danger 等级的 consequence 提示')
  assert.equal(textOf(pDanger[0]).includes('此操作无法撤销'), true)
})

test('P1 设计系统：Tag 色阶徽章前置圆点，无 tone 不带点', () => {
  const { exported } = loadClient()

  const plain = mount(exported.Tag({ tone: undefined, children: '普通' }))
  const plainSpans = findAll(plain, n => n.type === 'span' && n.props?.['aria-hidden'] === 'true')
  assert.equal(plainSpans.length, 0, '无 tone 的 Tag 不应渲染前置圆点')
  assert.equal(textOf(plain).includes('普通'), true, '无 tone 的 Tag 应渲染文案')

  const toned = mount(exported.Tag({ tone: 'ok', children: '已就位' }))
  assert.equal(textOf(toned).includes('已就位'), true, '带 tone 的 Tag 应渲染文案')
  const dots = findAll(toned, n => n.type === 'span' && n.props?.['aria-hidden'] === 'true')
  assert.equal(dots.length, 1, '带 tone 的 Tag 应渲染一个前置圆点')
  assert.equal(dots[0].props.style.background, 'currentColor', '圆点应取 currentColor')
})

test('P1 设计系统：Button link 与 icon 形态渲染与禁用拦截', () => {
  const { exported } = loadClient()

  const link = mount(exported.Button({ kind: 'link', onClick: () => {}, children: '调整' }))
  assert.equal(String(link.props.className).includes('bkl-btn-link'), true, 'link 形态应带 bkl-btn-link 类')
  assert.equal(textOf(link).includes('调整'), true, 'link 应渲染文案')
  assert.equal(typeof link.props.style.color, 'string', 'link 着色应为字符串')
  assert.equal(link.props.style.color.includes('var(--dsw-'), true, 'link 应取宿主令牌着色')

  const icon = mount(exported.Button({ kind: 'icon', label: '关闭', onClick: () => {}, children: '×' }))
  assert.equal(String(icon.props.className).includes('bkl-btn-icon'), true, 'icon 形态应带 bkl-btn-icon 类')
  assert.equal(icon.props['aria-label'], '关闭', 'icon 钮应携带 aria-label')
  assert.equal(textOf(icon).includes('×'), true, 'icon 钮应渲染内容')

  const iconSmall = mount(exported.Button({ kind: 'icon', size: 'small', label: '关闭', onClick: () => {}, children: '×' }))
  assert.equal(iconSmall.props.style.minHeight !== '26px', true, 'icon 形态不应套用 small 的 26px 最小高度')

  let clicked = 0
  const off = mount(exported.Button({ kind: 'link', off: true, onClick: () => { clicked += 1 }, children: '不可点' }))
  assert.equal(off.props['aria-disabled'], 'true', '禁用 link 应置 aria-disabled')
  off.props.onClick({ preventDefault() {} })
  assert.equal(clicked, 0, '禁用 link 的 onClick 不应触发')
})

test('P1 设计系统：Dialog 头部圆角图标块与 success 成功说明块', () => {
  const { exported } = loadClient()

  const dangerTree = exported.Dialog({ open: true, title: '删除规则', tone: 'danger', success: { title: '可以撤销', text: '之后可重新应用。' } })
  const dangerNodes = mount(dangerTree)
  const iconBlocks = findAll(dangerNodes, n => n.props?.style && n.props.style.background !== undefined && n.props['aria-hidden'] === 'true' && typeof n.props.style.width === 'string' && n.props.style.width === '32px')
  assert.equal(iconBlocks.length >= 1, true, '弹窗头部应渲染 32px 圆角图标块')

  // 图标映射：danger 用 alert + 错误底色，默认 tone 用 shield + 强调底色，两块必须可区分。
  const defaultTree = exported.Dialog({ open: true, title: '提示' })
  const defaultNodes = mount(defaultTree)
  const defaultIconBlocks = findAll(defaultNodes, n => n.props?.style && n.props.style.background !== undefined && n.props['aria-hidden'] === 'true' && typeof n.props.style.width === 'string' && n.props.style.width === '32px')
  assert.equal(defaultIconBlocks.length >= 1, true, '默认 tone 也应渲染 32px 图标块')
  assert.notEqual(iconBlocks[0].props.style.background, defaultIconBlocks[0].props.style.background, 'danger 与默认 tone 的图标块底色应不同')
  const dangerD = findAll(iconBlocks[0], n => n.type === 'path')[0]?.props?.d
  const defaultD = findAll(defaultIconBlocks[0], n => n.type === 'path')[0]?.props?.d
  assert.equal(typeof dangerD === 'string' && typeof defaultD === 'string', true, '两块图标都应带 svg path')
  assert.notEqual(dangerD, defaultD, 'danger 与默认 tone 的图标 path 应不同（alert vs shield）')

  const success = findAll(dangerNodes, n => typeof n.props?.className === 'string' && n.props.className.includes('bkl-success-sign'))
  assert.equal(success.length, 1, '应渲染 success 成功说明块')
  assert.equal(textOf(success[0]).includes('可以撤销'), true)
  assert.equal(textOf(success[0]).includes('之后可重新应用。'), true)

  const plainTree = exported.Dialog({ open: true, title: '提示' })
  const plainNodes = mount(plainTree)
  const plainSuccess = findAll(plainNodes, n => typeof n.props?.className === 'string' && n.props.className.includes('bkl-success-sign'))
  assert.equal(plainSuccess.length, 0, '未传 success 时不应渲染成功说明块')
})

test('P1 设计系统：Toast 视觉层不带 live region，Announcer 常驻播报独立承载', () => {
  const { exported } = loadClient()

  const toastTree = mount(exported.Toast({ text: '已复制到剪贴板' }))
  const toast = findAll(toastTree, n => n.props?.['data-bkl-toast'] === 'true')[0]
  assert.equal(Boolean(toast), true, '视觉 toast 应带 data-bkl-toast 标记')
  assert.equal(toast.props['aria-hidden'], 'true', '视觉 toast 应 aria-hidden')
  assert.equal(toast.props.role, undefined, '视觉 toast 不应带 role')
  assert.equal(toast.props['aria-live'], undefined, '视觉 toast 不应带 aria-live')
  assert.equal(textOf(toast).includes('已复制到剪贴板'), true, '视觉 toast 应渲染文案')

  const annTree = mount(exported.Announcer({ text: '已复制到剪贴板' }))
  const ann = findAll(annTree, n => n.props?.['data-bkl-toast-announcer'] === 'true')[0]
  assert.equal(Boolean(ann), true, 'Announcer 应带 data-bkl-toast-announcer 标记')
  assert.equal(ann.props.role, 'status', 'Announcer 应为 role=status')
  assert.equal(ann.props['aria-live'], 'polite')
  assert.equal(textOf(ann).includes('已复制到剪贴板'), true, 'Announcer 应渲染播报文案')
})

// Section 行为测试用的桩：可写 state、可捕获 cleanup、假计时器。
// hooks[1] 的注入依赖位置假设：status 必须是 Section 第 2 个 useState（0 基下标 1）。
// 注入 fakeStatus 后概览页才渲染 OverviewPage。其余常用槽位（useState 调用序）：
// override=5、draft=16、ruleEdit=17；用 options.hooks 按下标覆盖。
function loadSectionHarness(writeTextImpl, options = {}) {
  let registration
  const hooks = []
  const cleanups = []
  const timerLog = []
  const timers = new Map()
  let nextTimerId = 1
  let hookIndex = 0
  const fakeStatus = {
    hostRoot: '/test-host',
    target: { version: '0.9.0', commit: 'abc1234' },
    mode: 'danger-full-access',
    preflight: { ok: true, code: 'ok', blocked: [] },
    inject: { ok: true },
    ...options.status,
  }
  if (options.status?.preflight) fakeStatus.preflight = { ok: true, code: 'ok', blocked: [], ...options.status.preflight }
  hooks[1] = { value: fakeStatus }
  if (options.hooks) for (const [index, value] of Object.entries(options.hooks)) hooks[Number(index)] = { value }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const i = hookIndex++
      if (hooks[i] === undefined) hooks[i] = { value: initial }
      const slot = hooks[i]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    useCallback: (fn) => fn,
    useRef: (current) => {
      const i = hookIndex++
      if (hooks[i] === undefined) hooks[i] = { value: { current } }
      return hooks[i].value
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document: { head: null, documentElement: { lang: options.lang ?? 'zh-CN' }, getElementById() { return null } },
    navigator: { language: 'zh-CN', clipboard: { writeText: writeTextImpl } },
    // load() 里的 fetch 默认永不落定，避免桩环境下产生无关的失败路径与计时器；
    // 需要驱动真实 request() 信封校验的用例用 options.fetch 覆盖。
    fetch: options.fetch ?? (() => new Promise(() => {})),
    setTimeout: (fn, ms) => {
      const id = nextTimerId++
      timers.set(id, fn)
      timerLog.push({ kind: 'set', id, ms })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
      timerLog.push({ kind: 'clear', id })
    },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)
  let component
  exported.apply({
    effect(fn) { fn() },
    slots: {
      inject(_name, fn) { fn() },
      register(metadata, value) {
        if (metadata?.name === 'settings.section') component = value
      },
    },
  })
  return {
    exported,
    timerLog,
    cleanups,
    // hooks 槽原样露出：用例要断言的是状态本身（status 换没换、dialog 关没关、
    // 草稿丢没丢），只看渲染树证明不了这些。
    hooks,
    render: (props) => {
      hookIndex = 0
      return component(props)
    },
  }
}

const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve))

test('P1 Toast 行为：常驻播报、复制成功 4200ms 计时、替换与卸载清理', async () => {
  const harness = loadSectionHarness(async () => {})
  const { exported } = harness

  // 1. 初始渲染：announcer 常驻且唯一、文本为空；无视觉 toast
  const tree1 = harness.render()
  const anns1 = findAll(tree1, n => n.type === exported.Announcer)
  assert.equal(anns1.length, 1, 'announcer 应常驻且仅有 1 个')
  assert.equal(anns1[0].props.text, '', '初始播报文本应为空')
  assert.equal(findAll(tree1, n => n.type === exported.Toast).length, 0, '初始不应渲染视觉 toast')

  const onCopyNode = findAll(tree1, n => typeof n.type === 'function' && typeof n.props?.onCopy === 'function')[0]
  assert.equal(Boolean(onCopyNode), true, '应从 Section 树取到 OverviewPage 的 onCopy')

  // 2. 复制成功：announcer 与视觉 toast 同文，setTimeout 以 4200ms 注册一次
  onCopyNode.props.onCopy('诊断文本')
  await flushMicrotasks()

  const tree2 = harness.render()
  const ann2 = findAll(tree2, n => n.type === exported.Announcer)[0]
  const toasts2 = findAll(tree2, n => n.type === exported.Toast)
  assert.equal(toasts2.length, 1, '复制成功后应渲染视觉 toast')
  assert.equal(ann2.props.text.length > 0, true, '播报文本应变为非空')
  assert.equal(ann2.props.text, toasts2[0].props.text, '播报文本应与 toast 文本一致')
  const sets1 = harness.timerLog.filter(e => e.kind === 'set')
  assert.equal(sets1.length, 1, 'setTimeout 应注册一次')
  assert.equal(sets1[0].ms, 4200, 'setTimeout 应以 4200ms 注册')

  // 3. 再复制一次：先 clearTimeout 上一个 id，再注册新 id
  onCopyNode.props.onCopy('第二份诊断')
  await flushMicrotasks()
  const log = harness.timerLog.map(e => e.kind)
  assert.deepEqual(log, ['set', 'clear', 'set'], '再复制应先清旧计时器再注册新计时器')
  assert.equal(harness.timerLog[1].id, harness.timerLog[0].id, 'clear 的应是上一个计时器 id')
  assert.notEqual(harness.timerLog[2].id, harness.timerLog[0].id, '新计时器应是新的 id')
  assert.equal(harness.timerLog[2].ms, 4200, '新计时器仍应是 4200ms')

  // 4. 卸载清理：遍历调用所有 useEffect 桩捕获的 cleanup，最后一个 toast 计时器被清掉
  assert.equal(harness.cleanups.length > 0, true, 'useEffect 桩应捕获到 cleanup')
  for (const cleanup of harness.cleanups) cleanup()
  const lastSet = harness.timerLog.filter(e => e.kind === 'set').at(-1)
  assert.equal(
    harness.timerLog.some(e => e.kind === 'clear' && e.id === lastSet.id),
    true,
    '卸载 cleanup 应 clearTimeout 最后一个 toast 计时器',
  )
})

test('P1 Toast 行为：复制失败仍走 Notice，不产生 toast 与计时器', async () => {
  const harness = loadSectionHarness(async () => { throw new Error('clipboard denied') })
  const { exported } = harness

  const tree1 = harness.render()
  const onCopyNode = findAll(tree1, n => typeof n.type === 'function' && typeof n.props?.onCopy === 'function')[0]
  onCopyNode.props.onCopy('诊断文本')
  await flushMicrotasks()

  const tree2 = harness.render()
  assert.equal(findAll(tree2, n => n.type === exported.Toast).length, 0, '复制失败不应渲染 toast')
  assert.equal(findAll(tree2, n => n.type === exported.Announcer)[0].props.text, '', '复制失败播报应保持为空')

  const overviewNode = findAll(tree2, n => n.type === exported.OverviewPage)[0]
  assert.equal(Boolean(overviewNode?.props?.overviewNotice), true, '复制失败后 overviewNotice 应出现')
  const noticeTree = mount(exported.OverviewPage(overviewNode.props))
  const notices = findAll(noticeTree, n => String(n.props?.className ?? '').split(' ').includes('bkl-notice'))
  assert.equal(notices.length >= 1, true, '概览树里应出现 notice 节点')
  assert.equal(harness.timerLog.filter(e => e.kind === 'set' && e.ms === 4200).length, 0, '失败路径不应注册 4200ms 计时器')
})

test('StateBlock 状态块：统一承载 empty/error/loading/warn 四档布局与数据保护行', () => {
  const { exported } = loadClient()

  const tree = exported.StateBlock({
    tone: 'error',
    title: '规则清单损坏',
    body: '已暂停写入以保护原数据。',
    data: '正文文件仍在 bodies 目录下未被删除。',
    actions: [exported.Button({ label: '重置' }, '重置')],
  })
  const nodes = mount(tree)

  const root = findAll(nodes, n => n.props?.className && String(n.props.className).includes('bkl-state-error'))
  assert.equal(root.length, 1, '应渲染带有 bkl-state-error 类名的容器')
  assert.equal(root[0].props.role, 'alert', 'error 态角色应为 alert')

  const titleNode = findAll(nodes, n => n.type === 'h3')
  assert.equal(textOf(titleNode[0]), '规则清单损坏')

  const dataNode = findAll(nodes, n => n.props?.className && String(n.props.className).includes('bkl-notice-data'))
  assert.equal(dataNode.length, 1, '应渲染数据保护行')
  assert.equal(textOf(dataNode[0]).includes('正文文件仍在 bodies 目录下未被删除。'), true)

  const btnNode = findAll(nodes, n => n.type === 'button')
  assert.equal(btnNode.length, 1, '应渲染操作按钮')
})

test('Notice 通报条升级：支持 tone 状态色阶、数据保护声明与操作行', () => {
  const { exported } = loadClient()

  const tree = exported.Notice({
    tone: 'warn',
    title: '预检阻断通知',
    body: '检测到源码与补丁预期不一致。',
    data: '没有写入任何文件。',
  })
  const nodes = mount(tree)

  const root = findAll(nodes, n => n.props?.className && String(n.props.className).includes('bkl-notice-warn'))
  assert.equal(root.length, 1, '应渲染带有 bkl-notice-warn 类名的容器')

  const dataNode = findAll(nodes, n => n.props?.className && String(n.props.className).includes('bkl-notice-data'))
  assert.equal(dataNode.length, 1, '应渲染数据保护行')
  assert.equal(textOf(dataNode[0]).includes('没有写入任何文件。'), true)
})

test('Term 术语释义组件：支持 data-tip 悬浮属性与无障碍 note 角色', () => {
  const { exported } = loadClient()

  const tree = exported.Term({ termKey: 'host' })
  const nodes = mount(tree)

  assert.equal(nodes.type, 'span')
  assert.equal(nodes.props.className, 'bkl-term')
  assert.equal(nodes.props.tabIndex, 0, '需支持键盘 Tab 聚焦')
  assert.equal(nodes.props.role, 'note', '无障碍角色需为 note')
  assert.equal(typeof nodes.props['data-tip'], 'string', 'data-tip 应有释义内容')
  assert.equal(nodes.props['data-tip'].length > 0, true)
})

test('PageTip 引导卡片：渲染页面指引与误区警示，点击收起触发隐藏与外部回调', () => {
  const { exported } = loadClient()
  let dismissedTarget = null
  const tree = exported.PageTip({
    page: 'patches',
    onDismiss(target) { dismissedTarget = target },
  })
  const nodes = mount(tree)
  assert.equal(nodes.props.role, 'region', 'PageTip 容器应为 region 角色')
  assert.equal(typeof nodes.props['aria-label'], 'string', 'PageTip 需具备无障碍说明')
  assert.equal(nodes.props.className.includes('bkl-tip'), true)

  // 验证误区警示与主文案渲染
  const pitfallNode = findAll(nodes, n => n.props?.className === 'bkl-tip-pitfall')[0]
  assert.equal(Boolean(pitfallNode), true, '应渲染常见误区 span')
  assert.equal(textOf(pitfallNode).length > 0, true)

  // 验证收起按钮与点击通知
  const closeBtn = findAll(nodes, n => n.type === 'button' && n.props?.className === 'bkl-tip-close')[0]
  assert.equal(Boolean(closeBtn), true, '应渲染收起按钮')
  assert.equal(typeof closeBtn.props['aria-label'], 'string')
  closeBtn.props.onClick({ preventDefault() {} })
  assert.equal(dismissedTarget, 'patches', '点击收起应向外部回传 target')

  // 状态守卫：dismissed=true 或 tipOpen=false 或不存在的页面配置时返回 null
  assert.equal(exported.PageTip({ page: 'patches', dismissed: true }), null)
  assert.equal(exported.PageTip({ page: 'patches', tipOpen: false }), null)
  assert.equal(exported.PageTip({ page: 'non-existent-page' }), null)

  // 验证组件内部 hidden 状态响应：点击收起后下一次渲染返回 null
  let hiddenState = false
  const { exported: clientStateful } = loadClient({}, {
    useState: (initial) => [hiddenState, (next) => { hiddenState = typeof next === 'function' ? next(hiddenState) : next }],
  })
  const mountedInitial = mount(clientStateful.PageTip({ page: 'rules', onDismiss() {} }))
  assert.notEqual(mountedInitial, null)
  const btn = findAll(mountedInitial, n => n.type === 'button' && n.props?.className === 'bkl-tip-close')[0]
  btn.props.onClick({ preventDefault() {} })
  assert.equal(hiddenState, true)
  assert.equal(clientStateful.PageTip({ page: 'rules', onDismiss() {} }), null)
})

test('增强版 PageHead：生效时机图标化徽章渲染、自定义覆盖与 PageTip 集成', () => {
  const { exported } = loadClient()

  // 1. 预设生效时机徽章（以 patches 为例：refresh 图标与重启生效提示）
  let dismissed = null
  const treePatches = exported.PageHead({
    page: 'patches',
    title: '管理功能补丁',
    desc: '控制补丁启闭',
    titleId: 'patches-head-id',
    onDismissTip(p) { dismissed = p },
  })
  const nodesPatches = mount(treePatches)
  const h2 = findAll(nodesPatches, n => n.type === 'h2')[0]
  assert.equal(h2.props.id, 'patches-head-id')
  assert.equal(textOf(h2), '管理功能补丁')

  const badgePatches = findAll(nodesPatches, n => n.props?.className === 'bkl-badge-effect')[0]
  assert.equal(Boolean(badgePatches), true, '应渲染生效时机徽章')
  const svgPatches = findAll(badgePatches, n => n.type === 'svg')
  assert.equal(svgPatches.length, 1, '徽章内应渲染图标 SVG')
  assert.equal(svgPatches[0].props.width, 13)
  assert.equal(textOf(badgePatches).length > 0, true)

  // 验证 PageHead 默认集成了 PageTip 并在点击收起时连通 onDismissTip
  const tipNode = findAll(nodesPatches, n => n.props?.className && String(n.props.className).includes('bkl-tip'))[0]
  assert.equal(Boolean(tipNode), true, '默认应集成并展示 PageTip')
  const tipCloseBtn = findAll(tipNode, n => n.type === 'button' && n.props?.className === 'bkl-tip-close')[0]
  tipCloseBtn.props.onClick({ preventDefault() {} })
  assert.equal(dismissed, 'patches', '点击收起提示应透传至 onDismissTip 回调')

  // 2. 自定义覆盖 effectIcon 与 when
  const treeCustom = exported.PageHead({
    page: 'custom',
    title: '自定义页',
    effectIcon: 'terminal',
    when: '保存后即时生效',
    tipOpen: false,
  })
  const nodesCustom = mount(treeCustom)
  const badgeCustom = findAll(nodesCustom, n => n.props?.className === 'bkl-badge-effect')[0]
  assert.equal(Boolean(badgeCustom), true)
  assert.equal(textOf(badgeCustom).includes('保存后即时生效'), true)
  assert.equal(findAll(nodesCustom, n => n.props?.className && String(n.props.className).includes('bkl-tip')).length, 0, 'tipOpen=false 时不渲染 PageTip')

  // 3. overview 等无生效时机页面：不渲染徽章
  const treeOverview = exported.PageHead({
    page: 'overview',
    title: '概览',
    titleId: 'overview-id',
  })
  const nodesOverview = mount(treeOverview)
  assert.equal(findAll(nodesOverview, n => n.props?.className === 'bkl-badge-effect').length, 0, '无生效时机时不应渲染徽章')
})

test('Term 术语释义组件：在页面状态卡与标题中的实际挂载与完整无障碍属性', () => {
  let registration
  let component
  let stateIndex = 0
  const fakeStatus = {
    hostRoot: '/test-host',
    target: { version: '0.9.0', commit: 'abc1234' },
    mode: 'danger-full-access',
    preflight: { ok: true, code: 'ok', blocked: [] },
    inject: { ok: true },
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      stateIndex += 1
      if (stateIndex === 2) return [fakeStatus, () => {}] // 设置 status 使概览页完整展开
      return [initial, () => {}]
    },
    useEffect() {},
    useCallback: fn => fn,
    useRef: current => ({ current }),
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document: { head: null, documentElement: { lang: 'en' }, getElementById() { return null } },
    navigator: { language: 'en' },
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)
  exported.apply({
    effect(fn) { fn() },
    slots: {
      inject(_name, fn) { fn() },
      register(metadata, value) {
        if (metadata?.name === 'settings.section') component = value
      },
    },
  })

  // 1. 渲染实际设置分区页面（概览页挂载状态卡）
  const pageTree = mount(component())
  const pageTerms = findAll(pageTree, n => n.props?.className === 'bkl-term')
  assert.equal(pageTerms.length >= 4, true, '概览页状态卡应挂载至少 4 个 Term 术语实例')

  // 2. 在 PageHead 中挂载共用正文 Term
  const headTree = mount(exported.PageHead({
    page: 'prompt',
    title: '正文管理',
    desc: [exported.Term({ termKey: 'sharedPrompt' })],
  }))
  const headTerms = findAll(headTree, n => n.props?.className === 'bkl-term')
  assert.equal(headTerms.length, 1, 'PageHead 描述应成功挂载 sharedPrompt Term')

  // 3. 校验所有页面挂载的 Term 节点的无障碍契约
  const allTerms = [...pageTerms, ...headTerms]
  for (const term of allTerms) {
    assert.equal(term.type, 'span', 'Term 应为 inline span')
    assert.equal(term.props.role, 'note', '无障碍角色必须为 note')
    assert.equal(term.props.tabIndex, 0, 'tabIndex 必须为 0 以支持键盘访问')
    assert.equal(typeof term.props['data-tip'], 'string', 'data-tip 属性必须存在')
    assert.equal(term.props['data-tip'].length > 0, true, 'data-tip 释义内容不能为空')
    assert.equal(typeof term.props['aria-label'], 'string', 'aria-label 属性必须存在')
    assert.equal(term.props['aria-label'].includes(term.props['data-tip']), true, 'aria-label 必须包含释义说明')
  }
})

test('概览使用一套三阶段流程，不再叠加另一套引导', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const { flowSteps } = exported

  const missing = flowSteps({ hostRoot: null }, { rootMissing: true, enabledCount: 0, pendingFiles: 0, blocked: [] })
  assert.equal(missing.length, 3)
  assert.deepEqual(plain(missing[0]), ['选择方案', 'current', '先完成方案选择'])
  assert.equal(missing[1][1], 'todo')
  assert.equal(missing[2][1], 'todo')

  const none = flowSteps({ hostRoot: '/dsh' }, { rootMissing: false, enabledCount: 0, pendingFiles: 0, blocked: [] })
  assert.deepEqual(plain(none[0]), ['选择方案', 'current', '先完成方案选择'])

  const pending = flowSteps({ hostRoot: '/dsh' }, { rootMissing: false, enabledCount: 2, pendingFiles: 3, blocked: [] })
  assert.deepEqual(plain(pending[0]), ['选择方案', 'done', '已选 2 条'])
  assert.deepEqual(plain(pending[1]), ['检查并应用', 'current', '待写入 3 个文件'])
  assert.equal(pending[2][1], 'todo')

  const blocked = flowSteps({ hostRoot: '/dsh' }, { rootMissing: false, enabledCount: 2, pendingFiles: 0, blocked: [{ patchId: 'p1' }] })
  assert.deepEqual(plain(blocked[1]), ['检查并应用', 'blocked', '预检未通过，未写入'])

  const restart = flowSteps({ hostRoot: '/dsh', restart: 'apply' }, { rootMissing: false, restartPending: true, enabledCount: 2, pendingFiles: 0, blocked: [] })
  assert.equal(restart[1][1], 'done')
  assert.deepEqual(plain(restart[2]), ['重启宿主', 'current', '等你按原方式重启'])

  const { exported: exportedEn } = loadClient({ document: { documentElement: { lang: 'en' } } })
  const english = exportedEn.flowSteps({ hostRoot: '/dsh' }, { rootMissing: false, enabledCount: 1, pendingFiles: 1, blocked: [] })
  assert.deepEqual(plain(english[0]), ['Choose setup', 'done', '1 patch selected'])
  assert.deepEqual(plain(english[1]), ['Check and apply', 'current', '1 file pending'])
  assert.deepEqual(plain(english[2]), ['Restart host', 'todo', 'Apply first'])
})

test('deriveActionCard 保留异常优先级，待应用主按钮直接执行现有应用流程', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const { deriveActionCard } = exported

  const corrupt = deriveActionCard({}, { rulesIndex: 'corrupt', rootMissing: true, broken: true })
  assert.equal(corrupt.action, 'goRules')
  assert.equal(corrupt.tone, 'error')
  assert.equal(deriveActionCard({}, { broken: true, rootMissing: true }).action, 'refresh')
  assert.equal(deriveActionCard({}, { rootMissing: true, blocked: [] }).action, 'configureRoot')
  assert.equal(deriveActionCard({}, { rootMissing: false, blocked: [{ patchId: 'p' }] }).action, 'goPatches')
  assert.equal(deriveActionCard({ restart: 'apply' }, { restartPending: true, rootMissing: false, blocked: [] }).action, 'restartHelp')

  const pending = deriveActionCard({}, { pendingFiles: 2, enabledCount: 3, total: 3, rootMissing: false, blocked: [] })
  assert.equal(pending.action, 'apply')
  assert.equal(pending.icon, 'shield')
  assert.equal(pending.label, '推荐方案')

  const selection = {
    pendingFiles: 1,
    total: 2,
    rootMissing: false,
    blocked: [],
    mode: 'recommended',
    patches: [{ id: 'output.trim', enabled: true }, { id: 'read.limits', enabled: true }],
  }
  const recommended = deriveActionCard({}, { ...selection, enabledCount: 2 })
  assert.equal(recommended.title, '推荐破限方案')
  const custom = deriveActionCard({}, { ...selection, enabledCount: 1, patches: [{ id: 'output.trim', enabled: true }, { id: 'read.limits', enabled: false }] })
  assert.equal(custom.title, '自定义破限方案')
  assert.equal(custom.button, '检查并应用所选方案')

  assert.equal(deriveActionCard({}, { pendingFiles: 0, enabledCount: 0, total: 3, rootMissing: false, blocked: [] }).action, 'goPatches')
  const done = deriveActionCard({}, { pendingFiles: 0, enabledCount: 3, total: 3, rootMissing: false, blocked: [] })
  assert.equal(done.tone, 'ok')
  assert.equal(done.action, 'goPrompt')
})

test('阶段三：formatDiagnostics 严格脱敏与尾段收敛', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const { formatDiagnostics } = exported
  assert.equal(typeof formatDiagnostics, 'function', 'formatDiagnostics 必须被导出')

  const status = {
    target: { version: '0.2.1-rc.2', commit: '687f282e8625abcdef' },
    hostRoot: 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\deepseek-harness',
    http: { mounted: true },
    rulesIndex: 'ok',
    lock: { busy: false, operationId: 'secret-op-99', file: 'C:\\Users\\Administrator\\.dsh\\operation.lock' },
    applied: { files: 3, operationId: 'tx-1' },
    preflight: { code: 'ok' },
  }

  const text = formatDiagnostics(status, { rulesIndex: 'ok', applied: { files: 3 } })
  assert.equal(typeof text, 'string')

  // 1. 验证尾段路径收敛，绝对路径不得泄漏
  assert.equal(text.includes('Administrator'), false, '不得泄漏 Windows 用户名 Administrator')
  assert.equal(text.includes('AppData'), false, '不得泄漏中间目录 AppData')
  assert.equal(text.includes('…/deepseek-harness'), true, '路径必须收敛为尾段 …/deepseek-harness')

  // 2. 验证操作锁脱敏：不泄漏具体的 operationId
  assert.equal(text.includes('secret-op-99'), false, '不得泄漏操作锁的 operationId')

  // 3. 验证格式与关键字段存在
  assert.equal(text.includes('宿主提交: 687f282e8625'), true)
  assert.equal(text.includes('宿主根: …/deepseek-harness'), true)
  assert.equal(text.includes('插件 HTTP: 已挂载'), true)
  assert.equal(text.includes('规则清单: 可读'), true)
  assert.equal(text.includes('操作锁: 空闲'), true)
  assert.equal(text.includes('应用记录: 3 个文件'), true)
  assert.equal(text.includes('补丁预检: ok'), true)
  assert.equal(text.includes('运行行为: 未由此页面验证'), true)

  // 4. 英文环境下验证
  const { exported: exportedEn } = loadClient({ document: { documentElement: { lang: 'en' } } })
  const textEn = exportedEn.formatDiagnostics(status, { rulesIndex: 'ok', applied: { files: 3 } })
  assert.equal(textEn.includes('Host commit: 687f282e8625'), true)
  assert.equal(textEn.includes('Host root: …/deepseek-harness'), true)
  assert.equal(textEn.includes('Plugin HTTP: Mounted'), true)
  assert.equal(textEn.includes('Rules index: Readable'), true)
  assert.equal(textEn.includes('Operation lock: Idle'), true)
  assert.equal(textEn.includes('Applied records: 3 files'), true)
  assert.equal(textEn.includes('Patch preflight: ok'), true)
  assert.equal(textEn.includes('Runtime behavior: Not verified by this page'), true)
})

test('阻断与宿主目录说明弹窗：内容、文件清单与关闭文案', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })

  const blocked = exported.blockedHelpDialogSpec([
    { patchId: 'output.trim', path: 'packages/bundle/web-app/presets/cordis.patch.yml', reason: '已应用的是上一次声明的版本' },
    { patchId: 'read.limits', path: 'packages/fs/tool-fs/src/read.ts', reason: '内容不匹配' },
  ])
  assert.equal(blocked.tone, 'danger', '阻断说明用 error 图标')
  assert.equal(blocked.title.length > 0, true)
  const blockedText = textOf(mount(blocked.body))
  assert.equal(blockedText.includes('output.trim'), true, '应列出被阻断的补丁 id')
  assert.equal(blockedText.includes('cordis.patch.yml'), true, '应列出被阻断的文件')
  assert.equal(blockedText.includes('read.ts'), true, '应列出每一条')
  assert.equal(blockedText.includes('预检发现 2 处不一致'), true, '条数应来自传入的清单')
  assert.equal(blockedText.includes('不要直接覆盖或重新采集哈希'), true, '应带上警告')
  assert.equal(typeof blocked.cancelText, 'string', '只读弹窗用关闭文案，不传 yes')
  assert.equal(blocked.yes, undefined, '不应传 yes')

  const root = exported.configureRootDialogSpec()
  const rootText = textOf(mount(root.body))
  assert.equal(rootText.includes('DSH_BREAKLIMIT_HOST_ROOT'), true, '要给出真实的环境变量名')
  assert.equal(rootText.includes('deepseek-harness'), true, '示例里应带路径占位')
  assert.equal(typeof root.cancelText, 'string', '只读弹窗用关闭文案')
})

test('开关与勾选框照宿主 ui-primitives 的尺寸和取色', () => {
  const { exported } = loadClient()
  const { Switch, S, SCOPED_CSS } = exported

  // 轨道 36×20、未选中用 border-l3、选中用品牌色——与宿主 Switch.module.css 一致。
  const offSwitch = Switch({ on: false, onToggle() {} })
  assert.equal(offSwitch.props.style.width, '36px', '轨道宽应为 36px')
  assert.equal(offSwitch.props.style.height, '20px', '轨道高应为 20px')
  assert.equal(offSwitch.props.style.background.includes('border-l3'), true, '未选中轨道应取 border-l3')
  const offKnob = findAll(offSwitch, n => n.props?.className === 'bkl-knob')[0]
  assert.equal(offKnob.props.style.width, '16px', '滑块应为 16px')
  assert.equal(offKnob.props.style.background.includes('switch-thumb'), true, '未选中滑块应取 switch-thumb 令牌')

  // 选中态：品牌色轨道，滑块右移 16px。
  const onSwitch = Switch({ on: true, onToggle() {} })
  assert.equal(onSwitch.props.style.background.includes('brand-primary'), true, '选中轨道应取品牌色')
  const onKnob = findAll(onSwitch, n => n.props?.className === 'bkl-knob')[0]
  assert.equal(onKnob.props.style.transform, 'translateX(16px)', '滑块右移距离应为 16px')

  // 轨道与滑块要退出宿主的全局超椭圆：不写这条会继承 superellipse(1.5)，比方圆，
  // 宿主的 Switch 显式写了 round（计算为 superellipse(1)）。
  assert.equal(SCOPED_CSS.includes('.bkl-root .bkl-switch, .bkl-root .bkl-knob { corner-shape: round; }'), true, '开关轨道与滑块应退出全局超椭圆')

  // 勾选框：16×16 且用品牌色强调，不用浏览器默认蓝。
  assert.equal(S.ackInput.width, '16px', '勾选框应为 16px')
  assert.equal(S.ackInput.height, '16px', '勾选框应为 16px')
  assert.equal(S.ackInput.accentColor.includes('brand-primary'), true, '勾选框选中色应取品牌色')
})

test('深色配色以 body 上的实际调色板属性为条件，跟随系统时也生效', () => {
  const { exported } = loadClient()
  const css = exported.SCOPED_CSS
  assert.equal(typeof css, 'string', 'SCOPED_CSS 应是拼好的样式字符串')
  assert.equal(css.includes('body[data-ds-dark-theme] .bkl-root'), true, '深色覆盖应挂在 body 的实际调色板属性上')
  assert.equal(css.includes('body[data-ds-dark-theme] .bkl-dock'), true, '浮窗同样覆盖')
  // 宿主的偏好来源属性取 light/dark/system，选「跟随系统」时是 system，按它判定永远取不到 dark。
  assert.equal(css.includes('data-ds-theme-source'), false, '不应再用偏好来源属性判定深色')
  assert.equal(css.includes('--dsw-alias-state-success-primary: #8dd9b2;'), true, '深色成功色应是原型暗色调色板的薄荷绿')
  assert.equal(css.includes('--bkl-toast-icon: #1f6e4c;'), true, '浮窗 toast 图标同样按原型取值')
})

test('OverviewPage：三阶段流程、主行动卡、双栏配置与默认收起的诊断', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const { OverviewPage } = exported
  assert.equal(typeof OverviewPage, 'function', 'OverviewPage 必须被导出')

  let actionRan = null
  let toggledEnabled = null
  let copiedText = null
  let helpOpened = 0

  const fakeStatus = {
    hostRoot: 'C:\\Users\\rumo\\dsh-host',
    target: { version: '0.9.0', commit: 'abc1234' },
    mode: 'danger-full-access',
    enabled: true,
    preflight: { ok: true, code: 'ok' },
    inject: { ok: true },
  }
  const fakeF = {
    rootMissing: false,
    broken: false,
    blocked: [],
    mode: 'recommended',
    rules: [{ id: 'r1', name: '日常规则', target: 'AGENTS.md' }],
    activeRule: 'r1',
    customPrompt: false,
    enabledCount: 2,
    pendingFiles: 1,
    total: 5,
    applied: null,
    preCode: 'ok',
    restartPending: false,
  }
  const fakeWords = {
    phase: 'ready',
    stale: false,
    entries: [{ from: '原词', to: '替换词' }],
  }

  const renderPage = (words = fakeWords, f = fakeF) => OverviewPage({
    f,
    status: fakeStatus,
    override: null,
    busy: false,
    enabledPending: false,
    restart: null,
    restartView: null,
    step: { tone: 'ok', title: '完成' },
    words,
    loadedAt: Date.now(),
    onRun(action) { actionRan = action },
    onGo() {},
    onToggleEnabled(next) { toggledEnabled = next },
    onCopy(text) { copiedText = text },
    onOpenHelp() { helpOpened += 1 },
    nextNotice: null,
    overviewNotice: null,
  })

  const tree = mount(renderPage())

  // 1. 验证三阶段进度条（ol.bkl-flow）
  const flowNode = findAll(tree, n => n.type === 'ol' && n.props?.className === 'bkl-flow')[0]
  assert.equal(Boolean(flowNode), true, '应渲染 ol.bkl-flow 进度流')
  const flowItems = findAll(flowNode, n => n.type === 'li')
  assert.equal(flowItems.length, 3, '进度流只保留选择、应用、重启三步')
  assert.equal(flowItems[0].props.className, 'done')
  assert.equal(flowItems[1].props.className, 'current')
  assert.equal(flowItems[2].props.className, 'todo')

  // 2. 验证主行动卡（section.bkl-action-card 纵向：eyebrow 图标圆 + h2 + 段落 + 按钮行）
  const actionCardNode = findAll(tree, n => n.type === 'section' && String(n.props?.className).includes('bkl-action-card'))[0]
  assert.equal(Boolean(actionCardNode), true, '应渲染主行动卡 bkl-action-card')
  const eyebrow = findAll(actionCardNode, n => n.props?.className === 'bkl-action-eyebrow')[0]
  assert.equal(Boolean(eyebrow), true, '行动卡应有 bkl-action-eyebrow')
  assert.equal(findAll(eyebrow, n => n.props?.className === 'bkl-icon-wrap').length, 1, 'eyebrow 内应有图标圆 bkl-icon-wrap')
  const actionTitle = findAll(actionCardNode, n => n.type === 'h2' && n.props?.id === 'bkl-action-title')[0]
  assert.equal(Boolean(actionTitle), true, '行动卡应有 h2#bkl-action-title')
  const actionActions = findAll(actionCardNode, n => n.props?.className === 'bkl-action-actions')[0]
  assert.equal(Boolean(actionActions), true, '行动卡应有按钮行 bkl-action-actions')
  const actionBtn = findAll(actionActions, n => n.type === 'button')[0]
  actionBtn.props.onClick({ preventDefault() {} })
  assert.equal(actionRan, 'apply', '待应用主按钮直接进入现有应用流程')

  // 3. 验证 bkl-columns 双栏
  const columnsNode = findAll(tree, n => n.props?.className === 'bkl-columns')[0]
  assert.equal(Boolean(columnsNode), true, '应渲染双栏网格 bkl-columns')
  assert.equal(findAll(tree, n => String(n.props?.className ?? '').includes('bkl-balanced-grid')).length, 0, '不应再有 bkl-balanced-grid')
  assert.equal(findAll(tree, n => String(n.props?.className ?? '').includes('bkl-hero-card')).length, 0, '不应再有 bkl-hero-card')
  assert.equal(findAll(tree, n => n.props?.className === 'bkl-guide').length, 0, '不再叠加另一套 Guide')
  assert.equal(findAll(tree, n => n.type === exported.PageTip).length, 0, '概览不再重复显示 PageTip')

  const doneTree = mount(renderPage(fakeWords, { ...fakeF, applied: { files: 3 }, pendingFiles: 0 }))
  assert.equal(textOf(doneTree).includes('当前破限配置'), true, '完成态停止显示首次配置引导')

  // 6. 验证核心配置清单（div.bkl-summary-list，尾钮 link + chevron，接管行 Switch）
  const summaryList = findAll(columnsNode, n => n.props?.className === 'bkl-summary-list')[0]
  assert.equal(Boolean(summaryList), true, '应渲染核心配置清单 bkl-summary-list')
  const summaryRows = findAll(summaryList, n => n.props?.className === 'bkl-summary-row')
  assert.equal(summaryRows.length, 4, '配置清单应包含 4 行')
  const summaryLinks = findAll(summaryList, n => n.type === 'button' && String(n.props?.className ?? '').includes('bkl-btn-link'))
  assert.equal(summaryLinks.length, 3, '前 3 行尾钮应为 bkl-btn-link')
  for (const link of summaryLinks) {
    assert.equal(findAll(link, n => n.type === 'path').length >= 1, true, 'link 尾钮应带 chevron 图标')
  }

  const takeoverSwitch = findAll(summaryList, n => n.type === 'button' && n.props?.role === 'switch')[0]
  assert.equal(Boolean(takeoverSwitch), true, '应渲染破限接管开关')
  takeoverSwitch.props.onClick({ preventDefault() {} })
  assert.equal(toggledEnabled, false, '点击开关应就地切换')

  // 7. 验证右栏环境与权限卡片（div.bkl-status-lines）与 status-footer 检查时间
  const statusLines = findAll(columnsNode, n => n.props?.className === 'bkl-status-lines')[0]
  assert.equal(Boolean(statusLines), true, '右栏应渲染环境权限行 bkl-status-lines')
  const envCard = findAll(columnsNode, n => n.type === 'section' && textOf(n).includes('环境与权限'))[0]
  assert.equal(Boolean(envCard), true, '应渲染环境与权限卡')
  assert.equal(textOf(envCard).includes('检查于'), true, '环境卡尾部应有检查时间 status-footer')

  // 8. 验证 help-box（生效时机四条 + 「查看使用说明」链接触发 onOpenHelp）
  const helpBox = findAll(columnsNode, n => n.props?.style && n.type === 'div' && textOf(n).includes('改动什么时候生效？'))[0]
  assert.equal(Boolean(helpBox), true, '应渲染 help-box（改动什么时候生效）')
  assert.equal(textOf(helpBox).includes('应用后重启宿主'), true, 'help-box 应含生效时机四条')
  const helpLink = findAll(helpBox, n => n.type === 'button' && textOf(n).includes('查看使用说明'))[0]
  assert.equal(Boolean(helpLink), true, 'help-box 应有「查看使用说明」链接')
  helpLink.props.onClick({ preventDefault() {} })
  assert.equal(helpOpened, 1, '点击帮助链接应触发 onOpenHelp')

  // 9. 验证技术诊断折叠块（details.bkl-disclosure、一键复制按钮与提示）
  const disclosure = findAll(columnsNode, n => n.type === 'details' && n.props?.className === 'bkl-disclosure')[0]
  assert.equal(Boolean(disclosure), true, '应渲染技术诊断折叠块')
  // 默认收起；仍须接管 onToggle，避免重渲染覆盖用户的展开选择。
  assert.equal(disclosure.props.open, false, '技术诊断应默认收起')
  assert.equal(typeof disclosure.props.onToggle, 'function', '应接管 onToggle 以保持受控')
  assert.equal(textOf(disclosure).includes('含本机路径，不含凭据'), true, '应展示不含凭据提示')
  const copyBtn = findAll(disclosure, n => n.type === 'button').find(b => textOf(b).includes('复制诊断信息'))
  assert.equal(Boolean(copyBtn), true, '应渲染复制诊断信息按钮')
  copyBtn.props.onClick({ preventDefault() {} })
  assert.equal(typeof copiedText === 'string' && copiedText.includes('宿主根: …/dsh-host'), true, '点击应触发一键复制脱敏文本')

  // 10. 词库 loading：配置卡显示「词表读取中…」，不误报「读取失败」
  const loadingTree = mount(renderPage({ phase: 'loading', entries: [], stale: false }))
  const loadingConfig = findAll(loadingTree, n => n.props?.className === 'bkl-summary-list')[0]
  assert.equal(Boolean(loadingConfig), true, 'loading 期配置卡应渲染')
  assert.equal(textOf(loadingConfig).includes('词表读取中…'), true, 'loading 期配置卡应显示「词表读取中…」')
  assert.equal(textOf(loadingConfig).includes('读取失败'), false, 'loading 期配置卡不得误报「读取失败」')
})

test('技术诊断文本追加五层状态、证据与累计范围，并保留双语', () => {
  const status = {
    diagnostics: {
      layers: [
        { id: 'disk', state: 'pass', scope: 'current_value', action: null, detail: null, evidence: { pendingFiles: 0 } },
        { id: 'request', state: 'unknown', scope: 'process_cumulative', action: 'run-session', detail: null, evidence: { preStep: 0 }, warnings: ['harden_misses_cumulative', 'mask_read_warning'] },
      ],
    },
  }
  const zh = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const zhText = zh.exported.formatDiagnostics(status, { rulesIndex: 'ok', applied: null })
  assert.match(zhText, /磁盘补丁: 通过/u)
  assert.match(zhText, /请求前处理观测: 不可判定/u)
  assert.match(zhText, /自插件本次装载以来累计/u)
  assert.match(zhText, /preStep=0/u)
  assert.match(zhText, /告警: 进程内曾有工作区声明措辞未识别；词表读取有降级告警/u)

  const en = loadClient()
  const enText = en.exported.formatDiagnostics(status, { rulesIndex: 'ok', applied: null })
  assert.match(enText, /Disk patches: Pass/u)
  assert.match(enText, /Pre-request processing: Unknown/u)
  assert.match(enText, /since this plugin loaded/u)
  assert.match(enText, /Open a session/u)
  assert.match(enText, /Warnings: Unrecognized workspace instruction wording was observed; Word list reading has a warning/u)
})

test('沙箱档位徽章随 modeSource 诚实化：default 显示未探测，session 与缺席按档位显示', () => {
  const renderPage = (lang) => {
    const { exported } = loadClient(lang === undefined ? {} : { document: { documentElement: { lang } } })
    return exported.OverviewPage
  }

  const fakeF = {
    rootMissing: false,
    broken: false,
    blocked: [],
    mode: 'recommended',
    rules: [{ id: 'r1', name: '日常规则', target: 'AGENTS.md' }],
    activeRule: 'r1',
    customPrompt: false,
    enabledCount: 1,
    pendingFiles: 1,
    total: 3,
    applied: null,
    preCode: 'ok',
    restartPending: false,
  }
  const baseStatus = {
    hostRoot: 'C:\\Users\\rumo\\dsh-host',
    target: { version: '0.9.0', commit: 'abc1234' },
    enabled: true,
    preflight: { ok: true, code: 'ok' },
    inject: { ok: true },
  }
  const render = (OverviewPage, status) => mount(OverviewPage({
    f: fakeF,
    status: { ...baseStatus, ...status },
    override: null,
    busy: false,
    enabledPending: false,
    restart: null,
    restartView: null,
    step: { tone: 'ok', title: '完成' },
    words: { phase: 'ready', stale: false, entries: [] },
    loadedAt: Date.now(),
    guideOpen: false,
    onToggleGuide() {},
    onRun() {},
    onGo() {},
    onToggleEnabled() {},
    onCopy() {},
    onOpenHelp() {},
    nextNotice: null,
    overviewNotice: null,
  }))

  // 沙箱档位行：行名是第一个 span，Tag 展开后的 span 是徽章。
  // 徽章文案只取字符串子节点并展平嵌套数组：Tag 的色点是元素子节点、
  // null 占位在 React 里不渲染（textOf 桩把它串成 'null' 会污染精确比对），
  // 组件子节点又会被 mount 包进一层嵌套数组。
  const labelOf = (node) => {
    const parts = []
    const walk = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item)
        return
      }
      if (value === null || value === undefined || typeof value === 'object') return
      parts.push(String(value))
    }
    walk(node.children)
    return parts.join('')
  }
  const sandboxBadge = (tree, rowLabel) => {
    const row = findAll(tree, n => n.type === 'div' && textOf(n).startsWith(rowLabel))[0]
    assert.equal(Boolean(row), true, '环境与权限卡应有沙箱档位行')
    return findAll(row, n => n.type === 'span' && textOf(n) !== rowLabel)[0]
  }

  // modeSource === 'default'：档位是部署默认档的解析结果，不是会话档位；
  // 即便 mode 是 danger-full-access，徽章也不得沿用档位文案。
  const zh = renderPage('zh-CN')
  const unprobed = sandboxBadge(render(zh, { mode: 'danger-full-access', modeSource: 'default' }), '沙箱档位')
  assert.equal(labelOf(unprobed), '档位未探测')
  assert.equal(findAll(unprobed, n => n.props?.['aria-hidden'] === 'true').length, 0, '未探测徽章应为中性样式（无色点）')

  // modeSource === 'session'：会话档位照常显示（完全权限带 warn 色点）。
  const sessionBadge = sandboxBadge(render(zh, { mode: 'danger-full-access', modeSource: 'session' }), '沙箱档位')
  assert.equal(labelOf(sessionBadge), '完全权限')
  assert.equal(findAll(sessionBadge, n => n.props?.['aria-hidden'] === 'true').length, 1, '完全权限徽章应带 warn 色点')

  // modeSource 缺席（旧后端）：按 session 处理，显示照旧跟着 mode 走。
  const legacyBadge = sandboxBadge(render(zh, { mode: 'read-only' }), '沙箱档位')
  assert.equal(labelOf(legacyBadge), '宿主受限')

  // 英文 i18n 同一场景有对应文案。
  const en = renderPage()
  const enBadge = sandboxBadge(render(en, { mode: 'danger-full-access', modeSource: 'default' }), 'Sandbox level')
  assert.equal(labelOf(enBadge), 'Level not probed')
})

test('重塑 PatchesPage：已选数量徽章、阻断/未配目录 Notice、分界标题、补丁列表高光/胶囊/模式门禁与悬浮底部栏', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const { PatchesPage } = exported
  assert.equal(typeof PatchesPage, 'function', 'PatchesPage 必须被导出')

  let toggledId = null
  let toggledNext = null
  let applied = false
  let reverted = false
  let runAction = null
  let navigatedTab = null
  let copiedText = null

  const fakePatches = [
    { id: 'output.trim', title: '保留输出', human: '减少遗漏', enabled: true, targets: [{ path: 'p1.ts' }] },
    { id: 'minimal.unfreeze', title: '精简解锁', human: '解除冻结', enabled: false, unrestricted: true, targets: [{ path: 'p2.ts' }] },
  ]
  const fakeF = {
    rootMissing: false,
    broken: false,
    mode: 'recommended', // 推荐模式下 minimal.unfreeze 应置灰门禁
    preKnown: true,
    total: 2,
    enabledCount: 1,
    pendingFiles: 1,
    findings: [{ patchId: 'output.trim', state: 'pending' }],
    blocked: [],
    patches: fakePatches,
    applied: { files: 1 },
  }

  const vdom = PatchesPage({
    f: fakeF,
    patchInfo: { files: 1 },
    patchError: null,
    busy: false,
    toggles: {},
    onToggle(id, next) { toggledId = id; toggledNext = next },
    onApply() { applied = true },
    onRevert() { reverted = true },
    onRun(action) { runAction = action },
    onCopy(text) { copiedText = text },
    onGo(tab) { navigatedTab = tab },
    noticeView: null,
    restartView: null,
  })

  const tree = mount(vdom)

  // 1. 验证顶部已选数量徽章
  const selectedBadge = findAll(tree, n => n.type === 'span' && textOf(n).includes('已选 1 条'))[0]
  assert.equal(Boolean(selectedBadge), true, 'PageHead 顶部应渲染已选数量徽章')

  // 2. 验证分界标题（.bkl-section-label）
  const sectionLabel = findAll(tree, n => n.props?.className === 'bkl-section-label')[0]
  assert.equal(Boolean(sectionLabel), true, '应渲染 .bkl-section-label 小标题')
  assert.equal(textOf(sectionLabel).includes('源码补丁'), true)
  assert.equal(textOf(sectionLabel).includes('当前提示词模式：推荐'), true)

  // 3. 验证补丁统一外壳（section.bkl-patch-list）
  const patchList = findAll(tree, n => n.type === 'section' && n.props?.className === 'bkl-patch-list')[0]
  assert.equal(Boolean(patchList), true, '应渲染 section.bkl-patch-list 容器')

  // 4. 验证补丁行项（article.bkl-patch-row）
  const rows = findAll(patchList, n => n.type === 'article' && String(n.props?.className).includes('bkl-patch-row'))
  assert.equal(rows.length, 2, '应渲染 2 行补丁')

  // 第一行：output.trim（开启 -> 带 .selected）
  const row1 = rows[0]
  assert.equal(row1.props.className.includes('selected'), true, '开启的补丁应带有 .selected 高光类名')
  const iconWrap1 = findAll(row1, n => n.props?.className === 'bkl-patch-icon')[0]
  assert.equal(Boolean(iconWrap1), true, '应渲染特征图标容器')
  const tagPending = findAll(row1, n => n.type === 'span' && textOf(n).includes('待写入'))[0]
  assert.equal(Boolean(tagPending), true, '应渲染待写入状态胶囊徽章')
  assert.equal(textOf(row1).includes('下次应用：包含'), true, '选择状态必须独立于磁盘状态')
  assert.equal(textOf(row1).includes('磁盘状态：待写入'), true, '磁盘状态必须明确标出')

  // 第二行：minimal.unfreeze（推荐模式门禁 -> 带 .inactive）
  const row2 = rows[1]
  assert.equal(row2.props.className.includes('inactive'), true, '推荐模式下的 minimal.unfreeze 应置灰带 .inactive')
  const unfreezeBadge = findAll(row2, n => n.type === 'span' && textOf(n).includes('仅完全解放'))[0]
  assert.equal(Boolean(unfreezeBadge), true, '应展示仅完全解放徽章')
  const modeLink = findAll(row2, n => n.type === 'button' && textOf(n).includes('切换模式后可选'))[0]
  assert.equal(Boolean(modeLink), true, '应展示模式跳转链接')
  modeLink.props.onClick({ preventDefault() {} })
  assert.equal(navigatedTab, 'prompt', '点击跳转链接应导向 prompt 页')

  // 折叠改动说明与涉及文件清单
  const rowDisclosure = findAll(row1, n => n.type === 'details' && n.props?.className === 'bkl-disclosure')[0]
  assert.equal(Boolean(rowDisclosure), true, '每行应具备 details.bkl-disclosure 改动说明折叠')
  const fileList = findAll(rowDisclosure, n => n.props?.className === 'bkl-file-list')[0]
  assert.equal(Boolean(fileList), true, '展开后应包含涉及文件清单 bkl-file-list')

  // 5. 验证悬浮固定底部操作栏（footer.bkl-sticky-footer）
  const footer = findAll(tree, n => n.type === 'footer' && n.props?.className === 'bkl-sticky-footer')[0]
  assert.equal(Boolean(footer), true, '应渲染悬浮固定底部操作栏 footer.bkl-sticky-footer')
  const footCopy = findAll(footer, n => n.props?.className && String(n.props.className).includes('bkl-foot-copy'))[0]
  assert.equal(textOf(footCopy).includes('预计写入 1 个文件'), true, '底部左侧应展示预计写入文件数')

  const buttons = findAll(footer, n => n.type === 'button')
  const applyBtn = buttons.find(b => textOf(b).includes('写入 1 个文件') || textOf(b).includes('检查并应用') || textOf(b).includes('应用'))
  assert.equal(buttons.some(b => textOf(b).includes('回退')), false, '主操作栏不再并排展示回退')
  assert.equal(Boolean(applyBtn), true, '应渲染应用按钮')
  applyBtn.props.onClick({ preventDefault() {} })
  assert.equal(applied, true, '点击应用应触发 onApply')

  const maintenance = findAll(tree, n => n.type === 'details' && n.props?.className === 'bkl-maintenance')[0]
  assert.equal(Boolean(maintenance), true, '回退应移入独立恢复与维护区域')
  const revertBtn = findAll(maintenance, n => n.type === 'button' && textOf(n).includes('回退'))[0]
  revertBtn.props.onClick({ preventDefault() {} })
  assert.equal(reverted, true, '恢复区的回退仍触发原 onRevert')
})

test('阶段四：两档模式权衡卡片（mode-grid）要点与预算渲染，切换时横向对比表（compare）结构与参数对比', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  assert.equal(typeof exported.ModeBlock, 'function', 'ModeBlock 必须被导出')

  // 1. 验证 ModeBlock 渲染两档模式卡片网格（.mode-grid）
  let pickedMode = null
  const tree = mount(exported.ModeBlock({
    mode: 'recommended',
    onPick(id) { pickedMode = id },
  }))

  const grid = findAll(tree, n => n.props?.className && String(n.props.className).includes('mode-grid'))[0]
  assert.equal(Boolean(grid), true, '应渲染 .mode-grid 模式卡片网格')

  const cards = findAll(grid, n => n.props?.className && String(n.props.className).includes('mode-card'))
  assert.equal(cards.length, 2, '应渲染两档模式卡片')

  // 推荐模式卡片：选中态、权衡要点与预算
  const recCard = cards.find(c => textOf(c).includes('推荐') || c.props?.['data-mode'] === 'recommended')
  assert.equal(Boolean(recCard), true, '应包含推荐模式卡片')
  assert.equal(String(recCard.props?.className).includes('selected') || recCard.props?.['aria-pressed'] === 'true' || recCard.props?.['aria-pressed'] === true, true, '推荐模式卡片应为选中态')
  const recBudget = findAll(recCard, n => n.props?.className && String(n.props.className).includes('mode-budget'))[0]
  assert.equal(Boolean(recBudget), true, '推荐卡片应包含预算信息 .mode-budget')
  assert.equal(textOf(recBudget).includes('20 分钟') || textOf(recBudget).includes('0.5 MB'), true, '推荐卡片预算应体现 20 分钟或 0.5 MB')

  // 完全解放卡片：未选中态、预算
  const unrCard = cards.find(c => textOf(c).includes('完全解放') || c.props?.['data-mode'] === 'unrestricted')
  assert.equal(Boolean(unrCard), true, '应包含完全解放模式卡片')
  const unrBudget = findAll(unrCard, n => n.props?.className && String(n.props.className).includes('mode-budget'))[0]
  assert.equal(Boolean(unrBudget), true, '完全解放卡片应包含预算信息 .mode-budget')
  assert.equal(textOf(unrBudget).includes('9,999') || textOf(unrBudget).includes('9999') || textOf(unrBudget).includes('1 MB'), true, '完全解放卡片预算应体现 9,999 秒或 1 MB')

  // 点击完全解放卡片触发 onPick
  unrCard.props.onClick?.({ preventDefault() {} })
  assert.equal(pickedMode, 'unrestricted', '点击卡片应触发 onPick')

  // 图标名：原始树上断言 props.name（mount 展开 Icon 后 name 就没了）。
  // 不得再出现 Icon name="zap"（会静默回落 info），非推荐卡应为 bolt。
  const rawTree = exported.ModeBlock({ mode: 'recommended', onPick() {} })
  assert.equal(findAll(rawTree, n => n.props?.name === 'zap').length, 0, '模式卡不得引用已移除的 zap 图标名')
  assert.equal(findAll(rawTree, n => n.props?.name === 'bolt').length > 0, true, '非推荐模式卡应使用 bolt 图标')

  // 2. 验证切换时的横向对比表（.compare）结构与参数对比
  assert.equal(typeof exported.ModeCompare, 'function', 'ModeCompare 必须被导出')
  const compareTree = mount(exported.ModeCompare({
    currentMode: 'recommended',
    targetMode: 'unrestricted',
  }))
  const compare = findAll(compareTree, n => n.props?.className && String(n.props.className).includes('compare'))[0]
  assert.equal(Boolean(compare), true, '应渲染 .compare 横向对比表容器')
  const compareText = textOf(compare)
  assert.equal(compareText.includes('项目'), true, '对比表应包含项目列标题')
  assert.equal(compareText.includes('现在') && compareText.includes('推荐'), true, '对比表应包含当前推荐模式列标题')
  assert.equal(compareText.includes('切换后') && compareText.includes('完全解放'), true, '对比表应包含切换后完全解放模式列标题')
  assert.equal(compareText.includes('命令超时') || compareText.includes('超时'), true, '对比表应包含超时对比项')
  assert.equal(compareText.includes('20 分钟') && (compareText.includes('9,999') || compareText.includes('9999')), true, '对比表应对比 20 分钟与 9999 秒')
  assert.equal(compareText.includes('输出') || compareText.includes('深度'), true, '对比表应包含工具输出与深度对比项')
  assert.equal(compareText.includes('约束'), true, '对比表应包含自我约束对比项')
  assert.equal(compareText.includes('保留') && compareText.includes('解除'), true, '对比表应对比保留与解除')
})

test('阶段四：Prompt 编辑器脏状态（dirty）高亮、字数/字节数精确计算与动态原因反馈', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  assert.equal(typeof exported.PromptBlock, 'function', 'PromptBlock 必须被导出')

  // 1. 未修改态（clean）
  const cleanTree = mount(exported.PromptBlock({
    override: { text: 'hello', userFileExists: true, bytes: 5, effective: { ok: true } },
    promptError: null,
    draft: null,
    setDraft() {},
    busy: false,
    onSave() {},
    onReset() {},
    onDiscard() {},
    onCopy() {},
    onRetry() {},
    noticeView: null,
  }))

  const cleanCard = findAll(cleanTree, n => n.props?.className && String(n.props.className).includes('editor-card'))[0] || cleanTree
  assert.equal(String(cleanCard.props?.className || '').includes('dirty'), false, '未修改时编辑器卡片不应有 .dirty 类名')
  const cleanSavedMark = findAll(cleanTree, n => n.props?.className === 'bkl-saved-mark')[0]
  assert.equal(Boolean(cleanSavedMark), true, '已加载且未修改时底部操作行应显示 saved-mark')
  assert.equal(textOf(cleanSavedMark).includes('已保存'), true, 'saved-mark 应含「已保存」')

  // 2. 脏状态（dirty）：卡片高亮、字数与 UTF-8 字节数精确计算、未保存徽章与动态原因反馈
  let discarded = false
  const dirtyTree = mount(exported.PromptBlock({
    override: { text: 'hello', userFileExists: true, bytes: 5, effective: { ok: true } },
    promptError: null,
    draft: '你好世界', // 4 字符，UTF-8 编码下每个汉字 3 字节，共 12 字节
    setDraft() {},
    busy: false,
    onSave() {},
    onReset() {},
    onDiscard() { discarded = true },
    onCopy() {},
    onRetry() {},
    noticeView: null,
  }))

  const dirtyCard = findAll(dirtyTree, n => n.props?.className && String(n.props.className).includes('dirty'))[0]
  assert.equal(Boolean(dirtyCard), true, '有修改时编辑器卡片应带有 .dirty 高光类名')
  assert.equal(findAll(dirtyTree, n => n.props?.className === 'bkl-saved-mark').length, 0, '脏状态不应显示 saved-mark')

  // 字数与字节数精确统计（字数 · 字节数）
  const countNode = findAll(dirtyTree, n => n.props?.id === 'prompt-count' || (n.props?.style && textOf(n).includes('字')))[0]
  assert.equal(Boolean(countNode), true, '应渲染统计节点')
  const countText = textOf(countNode)
  assert.equal(countText.includes('4 字') && countText.includes('12 字节'), true, '字数与 UTF-8 字节数应精确计算为 4 字 · 12 字节')

  // 脏状态徽章与原因反馈
  const dirtyBadge = findAll(dirtyTree, n => textOf(n).includes('未保存') || textOf(n).includes('改动'))[0]
  assert.equal(Boolean(dirtyBadge), true, '应展示未保存改动提示徽章')
  const reasonNode = findAll(dirtyTree, n => n.props?.id === 'prompt-reason' || n.props?.id === 'bkl-prompt-why')[0]
  assert.equal(Boolean(reasonNode), true, '应渲染原因反馈节点')
  assert.equal(textOf(reasonNode).includes('保存后') && textOf(reasonNode).includes('下一轮'), true, '动态原因反馈应说明保存后从下一轮对话生效')

  // 放弃修改按钮
  const discardBtn = findAll(dirtyTree, n => n.type === 'button' && textOf(n).includes('放弃'))[0]
  assert.equal(Boolean(discardBtn), true, '脏状态下应提供放弃修改按钮')
  discardBtn.props.onClick({ preventDefault() {} })
  assert.equal(discarded, true, '点击放弃修改应触发 onDiscard')
})

test('阶段四：规则页清单损坏（corrupt）与空态 StateBlock 居中渲染、文件路径透明度与数据安全声明', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  assert.equal(typeof exported.RulesBlock, 'function', 'RulesBlock 必须被导出')

  let recovered = false
  let newClicked = false

  // 1. 损坏态（corrupt）：使用 StateBlock(tone: 'error') 居中渲染、包含文件路径透明度 disclosure 与数据安全声明
  const corruptTree = mount(exported.RulesBlock({
    rules: [],
    activeRule: null,
    rulesIndex: 'corrupt',
    rulesIndexPath: 'breaklimit/rules.json',
    selectedId: null,
    body: { id: null, status: 'idle', text: '' },
    edit: null,
    busy: false,
    onNew() { newClicked = true },
    onOpen() {},
    onEdit() {},
    onEditChange() {},
    onSave() {},
    onCancelEdit() {},
    onActivate() {},
    onDeactivate() {},
    onDelete() {},
    onRecover() { recovered = true },
    onRetryBody() {},
    noticeView: null,
  }))

  const corruptState = findAll(corruptTree, n => n.props?.className && String(n.props.className).includes('bkl-state-error'))[0]
  assert.equal(Boolean(corruptState), true, '清单损坏时应使用 StateBlock(error) 居中承载')

  // 数据安全声明
  const dataProtect = findAll(corruptState, n => n.props?.className && String(n.props.className).includes('bkl-notice-data'))[0]
  assert.equal(Boolean(dataProtect), true, '应包含数据安全声明行')
  assert.equal(textOf(dataProtect).includes('bodies') && (textOf(dataProtect).includes('没有被删除') || textOf(dataProtect).includes('未被删除')), true, '数据安全行应声明 bodies 目录下的正文未被删除')

  // 文件路径透明度
  const pathDisclosure = findAll(corruptState, n => n.type === 'details' || (n.props?.className && String(n.props.className).includes('path')))[0]
  assert.equal(Boolean(pathDisclosure), true, '应包含涉及文件位置透明度折叠或路径展示')
  const corruptAllText = textOf(corruptState)
  assert.equal(corruptAllText.includes('rules.json') && corruptAllText.includes('bodies'), true, '应透明展示 rules.json 与 bodies/ 路径')

  // 重置操作按钮
  const recoverBtn = findAll(corruptState, n => n.type === 'button' && textOf(n).includes('备份并重置'))[0]
  assert.equal(Boolean(recoverBtn), true, '应提供备份并重置清单操作按钮')
  recoverBtn.props.onClick({ preventDefault() {} })
  assert.equal(recovered, true, '点击应触发 onRecover')

  // 2. 空态（empty）：无规则且清单正常时，使用 StateBlock 居中引导
  const emptyTree = mount(exported.RulesBlock({
    rules: [],
    activeRule: null,
    rulesIndex: 'ok',
    rulesIndexPath: 'breaklimit/rules.json',
    selectedId: null,
    body: { id: null, status: 'idle', text: '' },
    edit: null,
    busy: false,
    onNew() { newClicked = true },
    onOpen() {},
    onEdit() {},
    onEditChange() {},
    onSave() {},
    onCancelEdit() {},
    onActivate() {},
    onDeactivate() {},
    onDelete() {},
    onRecover() {},
    onRetryBody() {},
    noticeView: null,
  }))

  const emptyState = findAll(emptyTree, n => n.props?.className && String(n.props.className).includes('bkl-state-empty'))[0] ||
                     findAll(emptyTree, n => n.props?.className && String(n.props.className).includes('bkl-state'))[0]
  assert.equal(Boolean(emptyState), true, '无规则且清单正常时应渲染空态 StateBlock')
  const newFirstBtn = findAll(emptyState, n => n.type === 'button' && textOf(n).includes('新建'))[0]
  assert.equal(Boolean(newFirstBtn), true, '空态中应提供新建规则入口')
  newFirstBtn.props.onClick({ preventDefault() {} })
  assert.equal(newClicked, true, '点击新建按钮应触发 onNew')
})

test('P3：规则 ID 计数（ruleIdCount）随 edit.id 变化', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  assert.equal(typeof exported.RulesBlock, 'function', 'RulesBlock 必须被导出')
  const renderEdit = (id) => mount(exported.RulesBlock({
    rules: [],
    activeRule: null,
    rulesIndex: 'ok',
    rulesIndexPath: 'breaklimit/rules.json',
    selectedId: null,
    body: { id: null, status: 'idle', text: '' },
    edit: { isNew: true, id, name: '', target: 'AGENTS.md', text: '', baseline: null },
    busy: false,
    onNew() {},
    onOpen() {},
    onEdit() {},
    onEditChange() {},
    onSave() {},
    onCancelEdit() {},
    onActivate() {},
    onDeactivate() {},
    onDelete() {},
    onRecover() {},
    onRetryBody() {},
    noticeView: null,
  }))
  const tree3 = renderEdit('abc')
  const count3 = findAll(tree3, n => n.type === 'span' && textOf(n) === '3 / 64')[0]
  assert.equal(Boolean(count3), true, 'id 为 abc 时应显示计数 3 / 64')
  const tree7 = renderEdit('abcdefg')
  const count7 = findAll(tree7, n => n.type === 'span' && textOf(n) === '7 / 64')[0]
  assert.equal(Boolean(count7), true, 'id 变化时计数应跟着变成 7 / 64')
})

test('阶段四：规则删除安全把手（ack 勾选解锁）与损坏清单重置安全把手（confirmWord 精确输入解锁）', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  assert.equal(typeof exported.ruleDeleteDialogSpec, 'function', 'ruleDeleteDialogSpec 必须被导出')
  assert.equal(typeof exported.recoverRulesDialogSpec, 'function', 'recoverRulesDialogSpec 必须被导出')

  // 1. 规则删除安全把手（ack 勾选联动）
  const fakeRule = { id: 'test-rule', name: '测试规则', target: 'AGENTS.md' }
  const deleteSpec = exported.ruleDeleteDialogSpec(fakeRule, false)
  assert.equal(typeof deleteSpec?.ack === 'string' && deleteSpec.ack.length > 0, true, '删除规则弹窗必须包含 ack 确认把手文本')
  assert.equal(deleteSpec?.consequence?.ok, false, '删除规则后果必须为不可逆 (ok: false)')
  assert.equal(typeof deleteSpec?.consequence?.text === 'string' && deleteSpec.consequence.text.length > 0, true, '删除规则后果必须说明不可撤销后果')

  // 未勾选 ack 时：确认按钮禁用
  const treeDelDisabled = mount(exported.Dialog({
    open: true,
    title: deleteSpec.title,
    ack: deleteSpec.ack,
    consequence: deleteSpec.consequence,
    yes: deleteSpec.yes,
  }))
  const delYesDisabled = findAll(treeDelDisabled, n => n.type === 'button').find(b => textOf(b).includes(deleteSpec.yes))
  assert.equal(delYesDisabled.props['aria-disabled'], 'true', '未勾选 ack 时确认删除按钮应处于禁用状态')

  // 勾选 ack 后：确认按钮解锁
  let ackCount = 0
  const { exported: clientAckChecked } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } }, {
    useState: (initial) => {
      ackCount += 1
      if (ackCount === 1) return [true, () => {}] // ackChecked = true
      return [initial, () => {}]
    },
  })
  const treeDelEnabled = mount(clientAckChecked.Dialog({
    open: true,
    title: deleteSpec.title,
    ack: deleteSpec.ack,
    consequence: deleteSpec.consequence,
    yes: deleteSpec.yes,
  }))
  const delYesEnabled = findAll(treeDelEnabled, n => n.type === 'button').find(b => textOf(b).includes(deleteSpec.yes))
  assert.equal(delYesEnabled.props['aria-disabled'], undefined, '勾选 ack 后确认删除按钮应解除禁用')

  // 2. 损坏清单重置安全把手（confirmWord 精确输入联动）
  const recoverSpec = exported.recoverRulesDialogSpec()
  assert.equal(recoverSpec?.confirmWord, '重置', '损坏清单重置弹窗必须要求输入确认词「重置」')
  assert.equal(recoverSpec?.consequence?.ok, false, '重置清单后果必须为不可逆 (ok: false)')

  // 输入未匹配时：确认按钮禁用
  let wordCount = 0
  const { exported: clientWordMismatch } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } }, {
    useState: (initial) => {
      wordCount += 1
      if (wordCount === 2) return ['错误词', () => {}]
      return [initial, () => {}]
    },
  })
  const treeRecDisabled = mount(clientWordMismatch.Dialog({
    open: true,
    title: recoverSpec.title,
    confirmWord: recoverSpec.confirmWord,
    consequence: recoverSpec.consequence,
    yes: recoverSpec.yes,
  }))
  const recYesDisabled = findAll(treeRecDisabled, n => n.type === 'button').find(b => textOf(b).includes(recoverSpec.yes))
  assert.equal(recYesDisabled.props['aria-disabled'], 'true', '输入不符时确认重置按钮应处于禁用状态')

  // 输入完全匹配时（含空白去除）：确认按钮解锁
  wordCount = 0
  const { exported: clientWordMatched } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } }, {
    useState: (initial) => {
      wordCount += 1
      if (wordCount === 2) return ['  重置  ', () => {}]
      return [initial, () => {}]
    },
  })
  const treeRecEnabled = mount(clientWordMatched.Dialog({
    open: true,
    title: recoverSpec.title,
    confirmWord: recoverSpec.confirmWord,
    consequence: recoverSpec.consequence,
    yes: recoverSpec.yes,
  }))
  const recYesEnabled = findAll(treeRecEnabled, n => n.type === 'button').find(b => textOf(b).includes(recoverSpec.yes))
  assert.equal(recYesEnabled.props['aria-disabled'], undefined, '精准输入「重置」后确认重置按钮应解除禁用')
})

test('阶段五收官：词库页双栏响应式布局、长词优先本地替换与命中药丸（wordChips）渲染、搜索过滤与清除联动', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  assert.equal(typeof exported.WordsPage, 'function', 'WordsPage 必须被导出')

  // 1. 双栏响应式布局与长词优先本地替换
  const testEntries = [
    { from: 'AI', to: '人工智能' },
    { from: 'OpenAI', to: '开源人工' },
    { from: 'DeepSeek', to: '深度求索' },
  ]
  const dummyStore = {
    phase: 'ready',
    stale: false,
    entries: testEntries,
    limits: { maxEntries: 100, maxTerm: 64 },
    lastHits: 0,
    saving: false,
  }

  let cleared = false
  const tree = mount(exported.WordsPage({
    store: dummyStore,
    query: '',
    setQuery: (q) => { if (q === '') cleared = true },
    previewText: 'Hello OpenAI and DeepSeek!',
    setPreviewText: () => {},
    onAdd: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onRetryRead: () => {},
    onReturnChat: () => {},
    canReturn: true,
  }))

  // 双栏结构断言：主栏（列表）与侧栏（预览）
  const mainSection = findAll(tree, n => n.type === 'section' && n.props?.['aria-labelledby'] === 'bkl-words-list-title')[0]
  assert.equal(Boolean(mainSection), true, '主栏必须为带无障碍标题的词条列表区')
  const asideSection = findAll(tree, n => n.type === 'aside' && n.props?.['aria-labelledby'] === 'bkl-words-preview-title')[0]
  assert.equal(Boolean(asideSection), true, '侧栏必须为带无障碍标题的本地替换预览区')

  // 长词优先替换断言
  const previewBox = findAll(asideSection, n => n.type === 'pre')[0]
  assert.equal(Boolean(previewBox), true, '预览区必须包含输出代码块')
  const previewOut = textOf(previewBox)
  assert.equal(previewOut.includes('开源人工'), true, '长词 OpenAI 必须优先替换为 开源人工')
  assert.equal(previewOut.includes('深度求索'), true, '长词 DeepSeek 必须优先替换为 深度求索')
  assert.equal(previewOut.includes('Open人工智能'), false, '短词 AI 绝不可抢先替换破坏长词 OpenAI')

  // 命中药丸（wordChips）渲染断言
  const chipsWrap = findAll(asideSection, n => n.props?.style?.flexDirection === 'column')[0]
  assert.equal(Boolean(chipsWrap), true, '命中词条时必须渲染 wordChips 药丸容器')
  const chipsText = textOf(chipsWrap)
  assert.equal(chipsText.includes('OpenAI → 开源人工'), true, '命中药丸必须包含 OpenAI 映射')
  assert.equal(chipsText.includes('DeepSeek → 深度求索'), true, '命中药丸必须包含 DeepSeek 映射')
  assert.equal(chipsText.includes('AI → 人工智能'), false, '未命中的短词 AI 不得出现在命中药丸中')

  // 列表表头三条文案（原词 / 替换为 / 操作），列结构与行布局对齐
  const wordHead = findAll(tree, n => n.props?.className === 'bkl-word-head')[0]
  assert.equal(Boolean(wordHead), true, '列表 <ul> 前应渲染 bkl-word-head 表头')
  const headText = textOf(wordHead)
  assert.equal(headText.includes('原词'), true, '表头应含「原词」列')
  assert.equal(headText.includes('替换为'), true, '表头应含「替换为」列')
  assert.equal(headText.includes('操作'), true, '表头应含「操作」列')

  // 2. 搜索过滤与清除联动
  const searchTree = mount(exported.WordsPage({
    store: dummyStore,
    query: 'deep',
    setQuery: (q) => { if (q === '') cleared = true },
    previewText: '',
    setPreviewText: () => {},
    onAdd: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onRetryRead: () => {},
    onReturnChat: () => {},
    canReturn: false,
  }))

  const rows = findAll(searchTree, n => n.type === 'li' && textOf(n).includes('→'))
  assert.equal(rows.length, 1, '搜索 deep 时列表中应仅展示 1 项匹配项')
  assert.equal(textOf(rows[0]).includes('DeepSeek'), true, '展示项应为 DeepSeek')

  // 清除按钮联动
  const clearBtn = findAll(searchTree, n => n.type === 'button' && (textOf(n) === '×' || textOf(n).includes('清除')))[0]
  assert.equal(Boolean(clearBtn), true, '输入搜索词后工具栏必须出现清除按钮')
  clearBtn.props.onClick({ preventDefault() {} })
  assert.equal(cleared, true, '点击清除按钮应触发 setQuery("")')
})

test('阶段五收官：词库容量守卫（100 条上限 Notice/禁用）与输入 64 字符边界校验', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const fullEntries = Array.from({ length: 100 }, (_, i) => ({
    from: `term${String(i).padStart(3, '0')}`,
    to: `target${String(i).padStart(3, '0')}`,
  }))
  const fullStore = {
    phase: 'ready',
    stale: false,
    entries: fullEntries,
    limits: { maxEntries: 100, maxTerm: 64 },
    lastHits: 0,
    saving: false,
  }

  const fullTree = mount(exported.WordsPage({
    store: fullStore,
    query: '',
    setQuery: () => {},
    previewText: '',
    setPreviewText: () => {},
    onAdd: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onRetryRead: () => {},
    onReturnChat: () => {},
    canReturn: false,
  }))

  // 1. 添加按钮在满额 100 条时处于禁用状态
  const addButtons = findAll(fullTree, n => n.type === 'button' && textOf(n).includes('添加词条'))
  assert.equal(addButtons.length > 0, true, '应存在添加词条按钮')
  const addBtn = addButtons[0]
  const isOff = addBtn.props?.off === true || addBtn.props?.['aria-disabled'] === 'true' || addBtn.props?.disabled === true
  assert.equal(isOff, true, '达到 100 条上限时添加词条按钮必须处于禁用状态')

  // 2. 满额 100 条时渲染容量守卫 Notice 通报条
  const notices = findAll(fullTree, n => n.props?.className && String(n.props.className).includes('bkl-notice'))
  const limitNotice = notices.find(n => textOf(n).includes('100 条上限') || textOf(n).includes('已达到 100 条上限'))
  assert.equal(Boolean(limitNotice), true, '达到 100 条上限时必须渲染容量守卫 Notice 通报条')
  assert.equal(textOf(limitNotice).includes('仍可编辑或删除已有词条'), true, '容量守卫 Notice 必须明确告知仍可编辑或删除已有词条')

  // 3. 已有词条的编辑与删除保持可用。图标钮无可见文本，
  //    按 props.label（编辑词条 … / 删除词条 …）在原始 Button 节点上查找；
  //    kind/off 是 Button 入参，mount 展开后就落到 className/aria-disabled 上了。
  const rawFull = exported.WordsPage({
    store: fullStore,
    query: '',
    setQuery: () => {},
    previewText: '',
    setPreviewText: () => {},
    onAdd: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onRetryRead: () => {},
    onReturnChat: () => {},
    canReturn: false,
  })
  const editButtons = findAll(rawFull, n => n.type === exported.Button && String(n.props?.label ?? '').includes('编辑词条'))
  const delButtons = findAll(rawFull, n => n.type === exported.Button && String(n.props?.label ?? '').includes('删除词条'))
  assert.equal(editButtons.length > 0, true, '已有词条必须渲染编辑按钮')
  assert.equal(delButtons.length > 0, true, '已有词条必须渲染删除按钮')
  assert.equal(editButtons[0].props?.off, undefined, '达到上限时不应禁用已有词条的编辑功能')
  assert.equal(delButtons[0].props?.off, undefined, '达到上限时不应禁用已有词条的删除功能')
  assert.equal(editButtons[0].props?.kind, 'icon', '行编辑按钮应为 icon 形态')
  assert.equal(delButtons[0].props?.kind, 'icon', '行删除按钮应为 icon 形态')
  assert.equal(textOf(editButtons[0]), '', '图标按钮应无可见文本（图标 aria-hidden）')
  assert.equal(textOf(delButtons[0]), '', '图标按钮应无可见文本（图标 aria-hidden）')

  // 4. 输入 64 字符边界与容量校验
  const term64A = 'A'.repeat(64)
  const term64B = 'B'.repeat(64)
  const validErrors = exported.wordEntryErrors(term64A, term64B, { entries: [], maxTerm: 64, maxEntries: 100 })
  assert.equal(validErrors.from, '', '64 字符原词应合法通过')
  assert.equal(validErrors.to, '', '64 字符替换词应合法通过')

  const term65A = 'A'.repeat(65)
  const overflowAErrors = exported.wordEntryErrors(term65A, term64B, { entries: [], maxTerm: 64, maxEntries: 100 })
  assert.equal(Boolean(overflowAErrors.from), true, '65 字符原词必须触发超限错误')

  const term65B = 'B'.repeat(65)
  const overflowBErrors = exported.wordEntryErrors(term64A, term65B, { entries: [], maxTerm: 64, maxEntries: 100 })
  assert.equal(Boolean(overflowBErrors.to), true, '65 字符替换词必须触发超限错误')

  // 5. 满 100 条时新增报错，编辑已有放行
  const newLimitErrors = exported.wordEntryErrors('newTerm', 'newTarget', {
    entries: fullEntries,
    maxEntries: 100,
    maxTerm: 64,
    originalFrom: null,
  })
  assert.equal(Boolean(newLimitErrors.limit), true, '满 100 条时新增词条必须触发 limit 上限错误')

  const editLimitErrors = exported.wordEntryErrors('term000', 'newTarget', {
    entries: fullEntries,
    maxEntries: 100,
    maxTerm: 64,
    originalFrom: 'term000',
  })
  assert.equal(editLimitErrors.limit, '', '满 100 条时编辑已有词条必须允许保存，不触发 limit 错误')
})

test('阶段五收官：会话浮窗微窗口（dockPanel）外观、标题栏模式微徽章、快速卡片切换、前 3 条微预览截断与底部直达导航', () => {
  let useStateCalls = 0
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } }, {
    useState: (initial) => {
      useStateCalls += 1
      if (useStateCalls === 6) return [true, () => {}] // open = true
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
  })

  // 构造 5 条词条以断言截断只展示前 3 条
  const fiveEntries = [
    { from: 'entry1', to: 'target1' },
    { from: 'entry2', to: 'target2' },
    { from: 'entry3', to: 'target3' },
    { from: 'entry4', to: 'target4' },
    { from: 'entry5', to: 'target5' },
  ]
  exported.aliasStore.state.entries = fiveEntries
  exported.aliasStore.state.phase = 'ready'

  // 原始树留一份：Icon 的 props.name 在 mount 展开后就没了，bolt 断言要在原始树上做。
  const rawTree = exported.AliasRow({})
  const tree = mount(rawTree)
  const dialogs = findAll(tree, n => n.props && n.props.role === 'dialog')
  assert.equal(dialogs.length, 1, '浮窗展开时必须渲染一个 role="dialog" 窗口')
  const panel = dialogs[0]

  // 1. 标题栏：包含标题、模式微徽章、关闭按钮
  const titlebar = findAll(panel, n => n.props?.style?.cursor === 'move')[0]
  assert.equal(Boolean(titlebar), true, '微窗口必须包含可拖拽标题栏')
  const titleText = textOf(titlebar)
  assert.equal(titleText.includes('破限快捷设置'), true, '标题栏必须包含破限快捷设置标题')
  assert.equal(titleText.includes('档位未知'), true, '尚未读取时必须显示档位未知')

  // 2. 快速卡片切换与说明
  const modeButtons = findAll(panel, n => n.type === 'button' && (textOf(n).includes('推荐') || textOf(n).includes('完全解放')))
  assert.equal(modeButtons.length >= 2, true, '微窗口内必须包含推荐模式与完全解放模式两档快速切换卡片')
  const panelAllText = textOf(panel)
  assert.equal(panelAllText.includes('切换前会确认影响，下一轮生效，不改变沙箱权限。'), true, '必须渲染 dockModeHint 模式影响说明')

  // 3. 前 3 条微预览截断与管理全部词条
  const listItems = findAll(panel, n => n.type === 'li' && textOf(n).includes('→'))
  assert.equal(listItems.length, 3, '5 条词条时微窗口词表应严格截断仅显示前 3 条')
  assert.equal(panelAllText.includes('entry1 → target1'), true, '前 3 条必须包含 entry1')
  assert.equal(panelAllText.includes('entry3 → target3'), true, '前 3 条必须包含 entry3')
  assert.equal(panelAllText.includes('entry4 → target4'), false, '超出 3 条的 entry4 绝不应在微窗口列表中渲染')
  assert.equal(panelAllText.includes('仅显示前 3 条，完整 5 条请前往词库管理。'), true, '多于 3 条时必须渲染 dockAliasLimitHint 截断提示')

  // 输入区域默认说明文案
  assert.equal(panelAllText.includes('原词与替换词各最多 64 字符。'), true, '单行输入区域下方必须包含 dockAliasInlineDefault 字符说明')

  // 管理全部词条入口
  const manageAllBtn = findAll(panel, n => n.type === 'button' && textOf(n).includes('管理全部词条'))[0]
  assert.equal(Boolean(manageAllBtn), true, '词表区域必须提供「管理全部词条」直达按钮')

  // 4. 底部直达导航与页脚提示
  assert.equal(panelAllText.includes('Esc 关闭 · 每次改动单独保存'), true, '页脚必须渲染 dockFooterHint 提示')
  const openSettingsBtn = findAll(panel, n => n.type === 'button' && textOf(n).includes('打开完整设置'))[0]
  assert.equal(Boolean(openSettingsBtn), true, '页脚必须提供「打开完整设置」直达按钮')

  // 5. P4 换皮结构：dock-section 分区、标题栏 bolt 图标、独立页脚与两列模式卡
  const sections = findAll(panel, n => n.props?.className === 'dock-section')
  assert.equal(sections.length, 2, '正文应拆成两个 dock-section 分区')
  const titlebarRaw = findAll(rawTree, n => n.props?.className === 'dock-titlebar')[0]
  assert.equal(Boolean(titlebarRaw), true, '标题栏应带 dock-titlebar 类名')
  assert.equal(findAll(titlebarRaw, n => n.props?.name === 'bolt').length > 0, true, '标题栏应含 Icon name="bolt"（mount 展开后 name 消失，必须在原始树断言）')
  const footer = findAll(panel, n => n.props?.className === 'dock-footer')[0]
  assert.equal(Boolean(footer), true, '页脚应为独立 dock-footer 分区')
  const footText = textOf(footer)
  assert.equal(footText.includes('Esc 关闭 · 每次改动单独保存'), true, '页脚应含 dockFooterHint')
  assert.equal(footText.includes('打开完整设置'), true, '页脚应含「打开完整设置」')
  const panelKids = panel.children.filter(Boolean)
  assert.equal(panelKids.some(kid => kid.props?.className === 'dock-footer'), true, '页脚必须是 panel 直接子项（移出滚动区）')
  const pressedButtons = findAll(panel, n => n.type === 'button' && n.props?.['aria-pressed'] !== undefined)
  assert.equal(pressedButtons.length, 2, '模式卡应仍是两个 aria-pressed 按钮')

  // 6. P3 复审收尾：浮窗 hover 作用域与紧凑卡差异说明
  assert.equal(panel.props.className, 'bkl-dock', '浮窗根节点应带 bkl-dock，hover 规则以它为作用域')
  assert.equal(findAll(panel, n => n.props?.className === 'dock-close').length, 1, '关闭钮应带 dock-close')
  assert.equal(findAll(panel, n => n.props?.className === 'dock-mode-card').length, 2, '两张模式卡应带 dock-mode-card')
  assert.equal(findAll(panel, n => n.props?.className === 'dock-alias-del').length, 3, '前 3 条词条应各带 dock-alias-del')
  assert.equal(panelAllText.includes('保留附加约束'), true, '推荐卡第二行应是差异说明而不是模式名')
  assert.equal(panelAllText.includes('完全解放 · 上限更高'), true, '完全解放卡第二行应说明上限更高')
})


test('P2 壳层：页签五图标、patches 计数角标、错误红徽章与脏点', () => {
  // 1. 五页签各带图标
  const base = loadSectionHarness(async () => {})
  const tree = base.render()
  const tabs = findAll(tree, n => n.props?.role === 'tab')
  assert.equal(tabs.length, 5, '应有 5 个页签')
  const expectedIcons = ['grid', 'patch', 'text', 'file', 'dictionary']
  tabs.forEach((tab, index) => {
    const icon = findAll(tab, n => n.type === base.exported.Icon)[0]
    assert.equal(Boolean(icon), true, `页签 ${String(index)} 应带图标`)
    assert.equal(icon.props.name, expectedIcons[index], `页签 ${String(index)} 图标名应为 ${expectedIcons[index]}`)
  })

  // 2. patches 计数角标：数字 + title；loading 期间 words 不报错（红徽章只看 failed/stale）
  const pending = loadSectionHarness(async () => {}, { status: { preflight: { pendingFiles: 3 } } })
  const pendingTree = pending.render()
  const pendingTabs = findAll(pendingTree, n => n.props?.role === 'tab')
  const patchesTab = pendingTabs.find(t => t.props.id === 'bkl-tab-patches')
  const countBadge = findAll(patchesTab, n => n.type === 'span' && n.props?.title === '3 个文件待写入')[0]
  assert.equal(Boolean(countBadge), true, 'patches 页签应有计数角标（title 为 tabPendingTitle）')
  assert.equal(textOf(countBadge), '3', '角标文本应为数字')
  const wordsTab = pendingTabs.find(t => t.props.id === 'bkl-tab-words')
  assert.equal(textOf(wordsTab).includes('有错误'), false, 'loading 期间 words 不应带错误 sr-only 文本')
  assert.equal(findAll(wordsTab, n => n.type === 'span' && n.props?.['aria-hidden'] === 'true' && textOf(n) === '!').length, 0, 'loading 期间 words 不应有红色 ! 徽章')

  // 3. 规则损坏红徽章
  const corrupt = loadSectionHarness(async () => {}, { status: { rulesIndex: 'corrupt' } })
  const corruptTabs = findAll(corrupt.render(), n => n.props?.role === 'tab')
  const rulesTab = corruptTabs.find(t => t.props.id === 'bkl-tab-rules')
  assert.equal(textOf(rulesTab).includes('有错误'), true, 'rules 损坏应带错误 sr-only 文本')
  assert.equal(findAll(rulesTab, n => n.type === 'span' && n.props?.['aria-hidden'] === 'true' && textOf(n) === '!').length, 1, 'rules 应有 aria-hidden 红色 ! 徽章')

  // 3b. 补丁阻断红徽章（预检 blocked）：计数角标与红徽章允许同时出现
  const blocked = loadSectionHarness(async () => {}, { status: { preflight: { ok: false, code: 'blocked', blocked: ['src/a.js'], pendingFiles: 2 } } })
  const blockedTabs = findAll(blocked.render(), n => n.props?.role === 'tab')
  const blockedPatchesTab = blockedTabs.find(t => t.props.id === 'bkl-tab-patches')
  assert.equal(textOf(blockedPatchesTab).includes('有错误'), true, 'patches 阻断应带错误 sr-only 文本')
  assert.equal(findAll(blockedPatchesTab, n => n.type === 'span' && n.props?.['aria-hidden'] === 'true' && textOf(n) === '!').length, 1, 'patches 阻断应有 aria-hidden 红色 ! 徽章')
  assert.equal(findAll(blockedPatchesTab, n => n.type === 'span' && n.props?.title === '2 个文件待写入').length, 1, '阻断时计数角标仍保留')

  // 3c. 提示词读取失败红徽章（promptError 槽位 = 6）
  const promptFail = loadSectionHarness(async () => {}, { hooks: { 6: { title: '正文读取失败', next: '重试' } } })
  const promptFailTabs = findAll(promptFail.render(), n => n.props?.role === 'tab')
  const promptTabFail = promptFailTabs.find(t => t.props.id === 'bkl-tab-prompt')
  assert.equal(textOf(promptTabFail).includes('有错误'), true, 'prompt 读取失败应带错误 sr-only 文本')
  assert.equal(findAll(promptTabFail, n => n.type === 'span' && n.props?.['aria-hidden'] === 'true' && textOf(n) === '!').length, 1, 'prompt 读取失败应有 aria-hidden 红色 ! 徽章')

  // 4. prompt / rules 脏点：注入 override+draft 与 ruleEdit
  const dirty = loadSectionHarness(async () => {}, {
    hooks: {
      5: { text: 'base text' },
      16: 'changed text',
      17: { id: 'r1', name: 'n', target: 'AGENTS.md', text: 'new', isNew: false, baseline: { id: 'r1', name: 'n', target: 'AGENTS.md', text: 'old' } },
    },
  })
  const dirtyTabs = findAll(dirty.render(), n => n.props?.role === 'tab')
  const promptTab = dirtyTabs.find(t => t.props.id === 'bkl-tab-prompt')
  assert.equal(textOf(promptTab).includes('有未保存的改动'), true, 'prompt 有草稿应带脏点 sr-only 文本')
  const dirtyRulesTab = dirtyTabs.find(t => t.props.id === 'bkl-tab-rules')
  assert.equal(textOf(dirtyRulesTab).includes('有未保存的改动'), true, 'rules 编辑中应带脏点 sr-only 文本')
  assert.equal(findAll(promptTab, n => n.type === 'span' && n.props?.['aria-hidden'] === 'true').length >= 1, true, '脏点装饰应 aria-hidden')
})

test('P2 壳层：顶栏品牌与版本徽章、帮助钮与可选关闭钮', () => {
  // 1. 无 props.close：不渲染关闭钮
  const noClose = loadSectionHarness(async () => {})
  const tree = noClose.render()
  assert.equal(findAll(tree, n => n.type === noClose.exported.Button && n.props?.label === '关闭设置，查看会话').length, 0, '宿主没给 close 就不渲染关闭钮')
  const helpBtn = findAll(tree, n => n.type === noClose.exported.Button && n.props?.label === '查看使用说明')[0]
  assert.equal(Boolean(helpBtn), true, '应渲染帮助图标钮（helpLabel）')
  assert.equal(helpBtn.props.kind, 'icon', '帮助钮应为 icon 形态')

  // 2. 版本徽章：无 tone 的 Tag，文本为 0.9.5
  const versionTag = findAll(tree, n => n.type === noClose.exported.Tag && textOf(n) === '0.9.5')[0]
  assert.equal(Boolean(versionTag), true, '顶栏应渲染版本徽章 0.9.5')
  assert.equal(versionTag.props?.tone, undefined, '版本徽章不应带 tone（不出圆点）')

  // 3. 传 close：渲染关闭钮且点击会调用
  const withClose = loadSectionHarness(async () => {})
  let closed = 0
  const tree2 = withClose.render({ close: () => { closed += 1 } })
  const closeBtn = findAll(tree2, n => n.type === withClose.exported.Button && n.props?.label === '关闭设置，查看会话')[0]
  assert.equal(Boolean(closeBtn), true, '传入 close 后应渲染关闭钮')
  closeBtn.props.onClick()
  assert.equal(closed, 1, '点击关闭钮应调用 closeSettings')
})

test('P2 壳层：有新版时顶栏给出可见文字，而不只是变色', () => {
  // updateInfo 是 Section 状态列表的最后一项（`bump` 之后，索引 26）。
  const harness = loadSectionHarness(async () => {}, {
    hooks: { 26: { hasUpdate: true, latestVersion: '0.9.9', autoCheckUpdates: true, checkedAt: 1 } },
  })
  const tree = harness.render()
  const hint = findAll(tree, n => n.type === 'span' && textOf(n) === '有新版本 0.9.9')[0]
  assert.equal(Boolean(hint), true, '有新版时应渲染可见文字，不能只靠变色或 title')

  const badge = findAll(tree, n => n.type === harness.exported.Tag && textOf(n) === '0.9.5')[0]
  assert.equal(badge.props?.tone, 'accent', '同时徽章仍是强调色')

  // 没有新版时不留空白占位。
  const plain = loadSectionHarness(async () => {})
  assert.equal(
    findAll(plain.render(), n => n.type === 'span' && textOf(n) === '有新版本 0.9.9').length,
    0,
    '无新版时不渲染这句文字',
  )
})

test('概览推荐主按钮从真实 Section 直接打开写入确认，不先跳转补丁页', () => {
  const harness = loadSectionHarness(async () => {}, {
    status: { preflight: { pendingFiles: 2 } },
    hooks: { 3: { patches: [{ id: 'output.trim', enabled: true }] } },
  })
  const { exported } = harness
  const page = findAll(harness.render(), n => n.type === exported.OverviewPage)[0]
  const tree = mount(page)
  const actionCard = findAll(tree, n => n.type === 'section' && String(n.props?.className).includes('bkl-action-card'))[0]
  const actionButton = findAll(actionCard, n => n.type === 'button')[0]
  actionButton.props.onClick({ preventDefault() {} })

  const next = harness.render()
  const dialog = findAll(next, n => n.type === exported.Dialog && n.props.open === true)[0]
  assert.equal(Boolean(dialog), true, '主按钮应打开现有写入确认 Dialog')
  assert.equal(dialog.props.title, '确认写入 2 个宿主源码文件？')
  const overviewTab = findAll(next, n => n.props?.role === 'tab' && n.props.id === 'bkl-tab-overview')[0]
  assert.equal(overviewTab.props['aria-selected'], 'true', '确认前仍停留在概览')
})

test('概览应用失败就地显示，切页保留同一结果，重试清除错误并显示成功', async () => {
  let applyCalls = 0
  let replyRetry
  const patches = { patches: [{ id: 'output.trim', enabled: true }] }
  const status = { hostRoot: '/test-host', preflight: { code: 'ok', pendingFiles: 1, blocked: [], findings: [{ patchId: 'output.trim', path: 'source.js', state: 'pending' }] } }
  const h = loadSectionHarness(async () => {}, {
    status, hooks: { 3: patches },
    fetch: async (url, init) => {
      if (url === '/breaklimit/apply') {
        applyCalls++
        if (applyCalls === 1) return { ok: false, status: 500, json: async () => ({ ok: false, code: 'write_failed' }) }
        return new Promise(resolve => { replyRetry = resolve })
      }
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, code: 'ok', data: {} }) }
      const data = url === '/breaklimit/status' ? status : url === '/breaklimit/patches' ? patches : {}
      return { ok: true, status: 200, json: async () => ({ ok: true, code: 'ok', data }) }
    },
  })
  const overview = () => findAll(h.render(), n => n.type === h.exported.OverviewPage)[0]
  const confirm = () => findAll(h.render(), n => n.type === h.exported.Dialog && n.props.open)[0].props.onAccept()
  overview().props.onRun('apply')
  confirm()
  await flushMicrotasks()
  const failed = mount(overview())
  assert.equal(textOf(failed).includes('write_failed'), true, '失败代码必须出现在概览实际渲染树中')
  assert.equal(findAll(failed, n => n.type === 'button' && textOf(n).includes('重新检查')).length > 0, true)
  const result = h.hooks[14].value.patches
  assert.equal(result.tone, 'error')
  assert.equal(h.timerLog.some(item => item.kind === 'set' && item.ms === 5000), false, '失败结果不能自动消失')

  overview().props.onGo('patches')
  const patchPage = findAll(h.render(), n => n.type === h.exported.PatchesPage)[0]
  assert.equal(textOf(mount(patchPage)).includes('write_failed'), true, '切页后继续展示同一结果')
  assert.equal(h.hooks[14].value.patches, result)
  findAll(h.render(), n => n.props?.id === 'bkl-tab-overview')[0].props.onClick()
  overview().props.onRun('apply')
  confirm()
  assert.equal(textOf(mount(overview())).includes('write_failed'), false, '重试开始即清除旧错误')
  replyRetry({ ok: true, status: 200, json: async () => ({ ok: true, code: 'applied', data: { written: ['source.js'] } }) })
  await flushMicrotasks()
  assert.equal(h.hooks[14].value.patches.tone, 'ok')
  assert.equal(textOf(mount(overview())).includes(h.hooks[14].value.patches.title), true)
  assert.equal(h.hooks[15].value.kind, 'apply', '实际写入后保留重启流程')
  assert.equal(applyCalls, 2)
})

test('概览应用零写入显示实际结果，不产生重启状态', async () => {
  const patches = { patches: [{ id: 'output.trim', enabled: true }] }
  const status = { hostRoot: '/test-host', preflight: { code: 'ok', blocked: [], pendingFiles: 1 } }
  const h = loadSectionHarness(async () => {}, {
    status, hooks: { 3: patches },
    fetch: async (url) => ({ ok: true, status: 200, json: async () => ({ ok: true, code: 'ok', data:
      url === '/breaklimit/apply' ? { written: [] } : url === '/breaklimit/status' ? status : url === '/breaklimit/patches' ? patches : {} }) }),
  })
  findAll(h.render(), n => n.type === h.exported.OverviewPage)[0].props.onRun('apply')
  findAll(h.render(), n => n.type === h.exported.Dialog && n.props.open)[0].props.onAccept()
  await flushMicrotasks()
  const page = findAll(h.render(), n => n.type === h.exported.OverviewPage)[0]
  assert.equal(h.hooks[14].value.patches.tone, 'info')
  assert.equal(textOf(mount(page)).includes(h.hooks[14].value.patches.title), true)
  assert.equal(h.hooks[15].value, null)
})

test('两页应用共用门槛，直接调用概览处理函数也不能绕过', () => {
  const cases = [
    { name: '操作中', hooks: { 9: true } },
    { name: '开关保存中', hooks: { 10: { 'output.trim': false } } },
    { name: '目录缺失', status: { hostRoot: null } },
    { name: '状态损坏', status: { stateProblem: { code: 'bad' } } },
    { name: '锁占用', status: { lock: { busy: true } } },
    { name: '预检阻断', status: { preflight: { pendingFiles: 1, code: 'blocked', blocked: [{}] } } },
    { name: '没有选中', hooks: { 3: { patches: [{ id: 'output.trim', enabled: false }] } } },
    { name: '清单未就绪', hooks: { 3: null } },
    { name: '清单读取失败', hooks: { 4: { title: '读取失败' } } },
    { name: '预检未知', status: { preflight: { pendingFiles: 1, code: 'failed' } } },
    { name: '状态读取失败', hooks: { 2: { title: '状态读取失败' } } },
    { name: '没有待写入', status: { preflight: { pendingFiles: 0 } } },
  ]
  for (const item of cases) {
    const calls = []
    const h = loadSectionHarness(async () => {}, {
      status: { preflight: { pendingFiles: 1 }, ...item.status },
      hooks: { 3: { patches: [{ id: 'output.trim', enabled: true }] }, ...item.hooks },
      fetch: (url, init) => { if (init?.method === 'POST') calls.push(url); return new Promise(() => {}) },
    })
    const page = findAll(h.render(), n => n.type === h.exported.OverviewPage)[0]
    const action = h.exported.deriveActionCard(page.props.status, page.props.f).action
    if (action === 'apply') {
      const card = findAll(mount(page), n => n.type === 'section' && String(n.props?.className).includes('bkl-action-card'))[0]
      assert.equal(findAll(card, n => n.type === 'button')[0].props['aria-disabled'], 'true', item.name)
    }
    page.props.onRun('apply')
    assert.equal(findAll(h.render(), n => n.type === h.exported.Dialog && n.props.open).length, 0, item.name)
    page.props.onGo('patches')
    const patches = findAll(h.render(), n => n.type === h.exported.PatchesPage)[0]
    const footer = findAll(mount(patches), n => n.type === 'footer')[0]
    const button = findAll(footer, n => n.type === 'button')[0]
    assert.equal(button.props['aria-disabled'], 'true', item.name)
    button.props.onClick({ preventDefault() {} })
    assert.deepEqual(calls, [], item.name)
  }
})

test('概览应用确认取消或关闭时不发起写入', () => {
  const calls = []
  const h = loadSectionHarness(async () => {}, {
    status: { preflight: { pendingFiles: 1 } }, hooks: { 3: { patches: [{ id: 'output.trim', enabled: true }] } },
    fetch: (url, init) => { if (init?.method === 'POST') calls.push(url); return new Promise(() => {}) },
  })
  const page = findAll(h.render(), n => n.type === h.exported.OverviewPage)[0]
  page.props.onRun('apply')
  findAll(h.render(), n => n.type === h.exported.Dialog && n.props.open)[0].props.onClose()
  assert.equal(findAll(h.render(), n => n.type === h.exported.Dialog && n.props.open).length, 0)
  assert.deepEqual(calls, [])
})

test('推荐与自定义方案的概览页头均按磁盘事实描述，不误报推荐配置完成', () => {
  for (const lang of ['zh-CN', 'en']) {
    for (const custom of [false, true]) {
      for (const pendingFiles of [0, 1]) {
        const h = loadSectionHarness(async () => {}, { lang,
          status: { applied: { files: 1 }, preflight: { pendingFiles } },
          hooks: { 3: { patches: [{ id: 'output.trim', enabled: true }, { id: 'read.limits', enabled: !custom }] } },
        })
        const page = findAll(h.render(), n => n.type === h.exported.OverviewPage)[0]
        const head = findAll(mount(page), n => n.props?.className === 'bkl-page-head-wrap')[0]
        const text = textOf(head)
        assert.equal(/推荐路径已经选好|推荐配置已就位|recommended (?:path|setup) is ready|recommended setup is in place/i.test(text), false, `${lang}/${custom}/${pendingFiles}`)
        if (pendingFiles === 0) assert.match(text, lang === 'en' ? /disk/i : /磁盘/)
        if (pendingFiles > 0 && custom) assert.match(textOf(mount(page)), lang === 'en' ? /custom jailbreak setup/i : /自定义破限方案/)
      }
    }
  }
})

test('P2 壳层：帮助 Dialog 标题与三步骤文案来自 TEXT', () => {
  const harness = loadSectionHarness(async () => {})
  const { exported } = harness
  const tree1 = harness.render()
  const helpBtn = findAll(tree1, n => n.type === exported.Button && n.props?.label === '查看使用说明')[0]
  helpBtn.props.onClick()

  const tree2 = harness.render()
  const dialogNode = findAll(tree2, n => n.type === exported.Dialog && n.props?.open === true)[0]
  assert.equal(Boolean(dialogNode), true, '点击帮助钮应打开 Dialog')
  assert.equal(dialogNode.props.title, '从配置到生效', '弹窗标题应为 helpTitle')
  assert.equal(dialogNode.props.tone, 'accent', '帮助弹窗应为 accent tone')
  assert.equal(dialogNode.props.yes, undefined, '帮助弹窗不传 yes（只有取消）')
  assert.equal(dialogNode.props.cancelText, '关闭', '帮助弹窗底部按钮应为「关闭」而非「取消」')
  const bodyText = textOf({ children: [dialogNode.props.body] })
  for (const copy of ['选择提示词模式', '选择需要的补丁', '应用，并重启宿主', '先沿用推荐模式，之后也能随时切换。', '看清用途再打开开关；开关只记下选择，不改源码。', '应用前会列出要改的文件，写入后按原方式重启。']) {
    assert.equal(bodyText.includes(copy), true, `弹窗正文应含「${copy}」`)
  }
  assert.equal(bodyText.includes('源码补丁重启宿主后加载'), true, '弹窗应含生效时机一句')
})

test('Dialog：cancelText 真的渲染成底部按钮文案', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  // 不用「关闭」测：弹窗头部本身有一个「关闭」图标钮，同名会撞。
  const tree = mount(exported.Dialog({ open: true, title: 'x', cancelText: '继续' }))
  const dialogEl = findAll(tree, n => n.type === 'dialog')[0]
  assert.equal(Boolean(dialogEl), true, '应渲染 dialog 元素')
  const inner = dialogEl.children[0]
  const foot = inner.children[inner.children.length - 1]
  const footButtons = findAll(foot, n => n.type === 'button' && textOf(n) === '继续')
  assert.equal(footButtons.length, 1, '底部应有且仅有一个文本为「继续」的按钮（cancelText 必须渲染出来）')
})

test('aliasReadError：loading 不算错误，failed 与 stale 才算', () => {
  const { exported } = loadClient()
  assert.equal(typeof exported.aliasReadError, 'function', 'aliasReadError 必须被导出')
  assert.equal(exported.aliasReadError({ phase: 'loading' }), false, 'loading 是正常过程，不报错')
  assert.equal(exported.aliasReadError({ phase: 'failed' }), true, '读取失败应报错')
  assert.equal(exported.aliasReadError({ phase: 'ready', stale: true }), true, '数据过期应报错')
  assert.equal(exported.aliasReadError({ phase: 'ready', stale: false }), false, '就绪且新鲜不报错')
})

test('P2 壳层：PLUGIN_VERSION 与 package.json version 同步', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const source = fs.readFileSync(CLIENT, 'utf8')
  const match = /const PLUGIN_VERSION = "([^"]*)"/.exec(source)
  assert.equal(Boolean(match), true, 'client.js 应含 const PLUGIN_VERSION = "..." 常量（改名或挪走都会失配）')
  assert.equal(match[1], pkg.version, `PLUGIN_VERSION（${match[1]}）应等于 package.json version（${pkg.version}）`)
})

// ---- A4/A5：词库写入守卫与请求信封校验 -------------------------------------
//
// A5 的坏响应桩。真实 Response 里 HTML 与空体都让 json() 抛错，被 request() 的
// .catch(() => null) 吃成 null；缺 ok 的 JSON 则是 json() 正常解析出残缺信封。
const goodAliasEnvelope = (entries) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    code: 'ok',
    message: '',
    data: { entries: entries.map(entry => ({ ...entry })), limits: { maxEntries: 100, maxTerm: 64 }, lastHits: 0 },
  }),
})
const badAliasResponses = [
  ['200 HTML', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html is not json') } })],
  ['204 空体', () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError('empty body') } })],
  ['缺 ok 的 JSON', () => ({ ok: true, status: 200, json: async () => ({ code: 'ok', message: '', data: { entries: [] } }) })],
]

test('A4 词库 store：首次读取落定前（loading）commit 拒绝写入，绝不发 PUT 整表覆盖', async () => {
  const { exported } = loadClient()
  const calls = []
  let pendingGet = null
  const requests = {
    get: () => {
      calls.push(['get'])
      return new Promise((resolve) => { pendingGet = resolve })
    },
    put: async (_path, body) => {
      calls.push(['put', JSON.parse(JSON.stringify(body))])
      return { ok: true, code: 'saved', data: { entries: body.entries } }
    },
  }
  const store = exported.createAliasStore(requests)
  const reading = store.read()

  // GET /alias 还没回来（phase=loading）：按空表算整表再 PUT 会把真实词库全删，必须拒绝。
  const refused = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'a', to: 'b' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.unknown, false)
  assert.equal(refused.refused, true, 'loading 态的拒绝形状与 failed/stale 一致')
  assert.equal(calls.filter(call => call[0] === 'put').length, 0, 'loading 态不许发出 PUT /alias')
  assert.equal(store.state.phase, 'loading')
  assert.deepEqual(Array.from(store.state.entries, entry => entry.from), [], '拒绝写入不动 entries')

  // 读取落定后照常可写：只堵 loading 窗口，ready 的写入语义不变。
  pendingGet({ ok: true, code: 'ok', message: '', data: { entries: [{ from: 'x', to: 'y' }], limits: { maxEntries: 100, maxTerm: 64 } } })
  await reading
  assert.equal(store.state.phase, 'ready')
  const saved = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'a', to: 'b' } })
  assert.equal(saved.ok, true)
  assert.equal(calls.filter(call => call[0] === 'put').length, 1, 'ready 后 commit 照常发 PUT')
  assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['x', 'a'])
})

test('A5 信封校验：200 HTML、空体、缺 ok 的 JSON 都走失败路径，词库不被清空、不假成功', async () => {
  for (const [label, makeBad] of badAliasResponses) {
    // 读取侧：先用合法信封读出真实词库，再让 GET 回坏响应。
    let mode = 'good'
    const reader = loadClient({
      fetch: async () => (mode === 'good' ? goodAliasEnvelope([{ from: 'a', to: 'b' }]) : makeBad()),
    })
    const store = reader.exported.aliasStore
    await store.read()
    assert.equal(store.state.phase, 'ready', `${label}：合法信封应读取成功`)
    assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['a'], `${label}：合法信封应读到词库`)

    mode = 'bad'
    await store.read()
    assert.equal(store.state.phase, 'failed', `${label}：坏响应不许假成功（phase 不能落 ready）`)
    assert.equal(store.state.stale, true, `${label}：旧词库应保留并标旧`)
    assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['a'], `${label}：坏响应不许把词库清成空表`)

    // 写入侧：GET 正常、PUT 回坏响应，commit 必须报失败且不动列表。
    let putMode = 'good'
    const writer = loadClient({
      fetch: async (_url, init) => (init?.method === 'PUT' && putMode === 'bad' ? makeBad() : goodAliasEnvelope([{ from: 'a', to: 'b' }])),
    })
    const store2 = writer.exported.aliasStore
    await store2.read()
    assert.equal(store2.state.phase, 'ready', `${label}：写入侧前置读取成功`)
    putMode = 'bad'
    const failed = await store2.commit({ type: 'delete', from: 'a' })
    assert.equal(failed.ok, false, `${label}：PUT 坏响应不许假成功`)
    assert.equal(failed.unknown, false, `${label}：坏响应是明确失败，不是结果未知`)
    assert.deepEqual(Array.from(store2.state.entries, entry => entry.from), ['a'], `${label}：写失败不动列表`)
  }
})

test('A5 合法信封路径零变化：正常 GET/PUT 照常读写词库', async () => {
  let disk = [{ from: 'a', to: 'b' }]
  const { exported } = loadClient({
    fetch: async (_url, init) => {
      if (init?.method === 'PUT') disk = JSON.parse(init.body).entries
      return goodAliasEnvelope(disk)
    },
  })
  const store = exported.aliasStore
  await store.read()
  assert.equal(store.state.phase, 'ready')
  assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['a'])
  const saved = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'c', to: 'd' } })
  assert.equal(saved.ok, true, '合法信封的 PUT 应保存成功')
  assert.deepEqual(disk.map(entry => entry.from), ['a', 'c'], 'PUT 整表按 commit 计算结果发出')
  assert.deepEqual(Array.from(store.state.entries, entry => entry.from), ['a', 'c'])
})

test('A5 explain：bad_response 有独立标题与下一步（中英两套），错误信封仍按后端 code 翻译', async () => {
  // hooks[1] 注入 null：status 停在空，概览体直接渲染 explain 的结果（Notice.notice）。
  const html = loadSectionHarness(async () => {}, {
    hooks: { 1: null },
    fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html is not json') } }),
  })
  html.render()
  await flushMicrotasks()
  const notice = findAll(html.render(), n => n.type === html.exported.Notice && n.props?.notice?.code === 'bad_response')[0]
  assert.equal(Boolean(notice), true, '坏响应应走 explain 的 bad_response 分支')
  assert.equal(notice.props.notice.tone, 'error')
  assert.equal(notice.props.notice.title, '后端回的不是插件响应', '标题应为 errBadResponse（中文键存在且被用上）')
  assert.equal(
    notice.props.notice.next,
    '宿主可能没挂载插件接口。确认插件已装进当前 profile 并重启过宿主，再点「重新检查」。',
    '下一步应为 errBadResponseNext（中文键存在且被用上）',
  )

  // 英文键同样存在：换 lang 后标题与下一步取英文份。
  const english = loadSectionHarness(async () => {}, {
    lang: 'en',
    hooks: { 1: null },
    fetch: async () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError('empty body') } }),
  })
  english.render()
  await flushMicrotasks()
  const enNotice = findAll(english.render(), n => n.type === english.exported.Notice && n.props?.notice?.code === 'bad_response')[0]
  assert.equal(Boolean(enNotice), true, '空体坏响应同样走 bad_response 分支')
  assert.equal(enNotice.props.notice.title, 'The backend reply is not a plugin response', '英文标题应为 errBadResponse（en 键存在且被用上）')
  assert.equal(
    enNotice.props.notice.next,
    'The host may not expose the plugin routes. Make sure the plugin is installed in the current profile and the host was restarted, then press Check again.',
    '英文下一步应为 errBadResponseNext（en 键存在且被用上）',
  )

  // 错误信封（ok:false + code）仍按后端 code 翻译，收紧校验不误伤既有错误语义。
  const writeFailed = loadSectionHarness(async () => {}, {
    hooks: { 1: null },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ ok: false, code: 'write_failed', message: '', data: null }) }),
  })
  writeFailed.render()
  await flushMicrotasks()
  const notice2 = findAll(writeFailed.render(), n => n.type === writeFailed.exported.Notice && n.props?.notice?.code === 'write_failed')[0]
  assert.equal(Boolean(notice2), true, '错误信封的 code 应原样透出到 explain')
  assert.equal(notice2.props.notice.title, '写不进磁盘', 'write_failed 仍翻成 errWrite 文案')

  const snapshot = loadSectionHarness(async () => {}, {
    hooks: { 1: null },
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, code: 'snapshot_corrupt', message: '', data: { drifted: [
      { path: 'a.txt', kind: 'snapshot', reason: '快照缺失，无法恢复' },
      { path: 'b.txt', kind: 'target', reason: '内容既非应用后版本也非应用前版本' },
    ] } }) }),
  })
  snapshot.render()
  await flushMicrotasks()
  const snapshotNotice = findAll(snapshot.render(), n => n.type === snapshot.exported.Notice && n.props?.notice?.code === 'snapshot_corrupt')[0]
  assert.equal(Boolean(snapshotNotice), true, '快照损坏必须有独立反馈，不能落入未知错误')
  assert.equal(snapshotNotice.props.notice.title, '恢复快照缺失、不可读或已损坏')
  assert.match(snapshotNotice.props.notice.next, /rebuild-state\.mjs/u)
  assert.deepEqual(snapshotNotice.props.notice.items, [
    '快照故障 · a.txt · 快照缺失，无法恢复',
    '目标漂移 · b.txt · 内容既非应用后版本也非应用前版本',
  ])

  const englishSnapshot = loadSectionHarness(async () => {}, {
    lang: 'en', hooks: { 1: null },
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, code: 'snapshot_corrupt', message: '', data: { drifted: [{ path: 'a.txt', kind: 'snapshot', reason: 'snapshot missing' }] } }) }),
  })
  englishSnapshot.render()
  await flushMicrotasks()
  const englishNotice = findAll(englishSnapshot.render(), n => n.type === englishSnapshot.exported.Notice && n.props?.notice?.code === 'snapshot_corrupt')[0]
  assert.deepEqual(englishNotice.props.notice.items, ['Snapshot fault · a.txt · snapshot missing'])
})

// ---- B8 前端缺陷回归 -------------------------------------------------------
//
// 每条用例断言的都是「修好后才成立」的事实：过期响应不覆盖新数据、结果未知不误报
// 失败、删除按条目身份锚定、上限以 limits 为准、草稿不丢、读回即夹边、迟到 render
// 不重开弹窗、自动检查失败如实显示。

// request() 的信封契约桩：resolve 给类 Response 对象，json() 给信封。
const makeResponse = (data, message = '') => ({ ok: true, status: 200, json: async () => ({ ok: true, code: 'ok', message, data }) })

// 永不落定的 fetch，逐笔记录，由用例决定何时 resolve 哪一笔：能精确制造
// 「先发后到」与「请求在途中用户已关掉弹窗」两类时序。
function deferredFetch() {
  const log = []
  const fetch = (url, init) => new Promise((resolve) => { log.push({ url: String(url), init, resolve }) })
  return { log, fetch }
}

test('B8 load() 请求序号：先发后到的旧响应不覆盖新数据', async () => {
  const { log, fetch } = deferredFetch()
  const harness = loadSectionHarness(async () => {}, { fetch })
  harness.render() // load #1：四路请求在途
  harness.render() // load #2
  const statusOf = (version, pendingFiles) => ({
    hostRoot: '/test-host',
    target: { version, commit: 'abc1234' },
    mode: 'danger-full-access',
    preflight: { ok: true, code: 'ok', blocked: [], pendingFiles },
    inject: { ok: true },
    rules: [],
    activeRule: null,
  })
  const respondLoad = (n, { version, pendingFiles, tier }) => {
    const pick = (suffix) => log.filter((call) => call.url.endsWith(suffix))[n]
    pick('/status').resolve(makeResponse(statusOf(version, pendingFiles)))
    pick('/patches').resolve(makeResponse({ patches: [] }))
    pick('/override').resolve(makeResponse({ text: 'body', userFileExists: false }))
    pick('/tier').resolve(makeResponse({ tier }))
  }
  assert.equal(log.filter((call) => call.url.endsWith('/status')).length, 2, '两次 load 应各发一次 GET /status')
  // 后发的 load #2 先落定
  respondLoad(1, { version: 'NEW-1', pendingFiles: 3, tier: 'unrestricted' })
  await flushMicrotasks()
  assert.equal(harness.hooks[1].value.target.version, 'NEW-1')
  // 先发的 load #1 迟到落定：必须整体作废
  respondLoad(0, { version: 'OLD-1', pendingFiles: 7, tier: 'recommended' })
  await flushMicrotasks()
  assert.equal(harness.hooks[1].value.target.version, 'NEW-1', '旧响应覆盖了新状态')
  assert.equal(harness.hooks[7].value.tier, 'unrestricted', '旧响应覆盖了新档位')
  const tree = harness.render()
  assert.equal(findAll(tree, (n) => n.type === 'span' && n.props?.title === '3 个文件待写入').length, 1, '渲染应反映新响应')
  assert.equal(findAll(tree, (n) => n.type === 'span' && n.props?.title === '7 个文件待写入').length, 0, '不许渲染旧响应的数据')
})

// 浮窗（AliasRow）行为测试的桩：useState/useRef 按调用序落槽（open 是第 6 个
// useState），fetch 按路由作答并逐笔记录。effect 不自动跑：挂载副作用会污染
// fetch 日志，日志里只留用例自己点出来的请求。
function loadDockHarness(options = {}) {
  let registration
  const slots = []
  const fetchLog = []
  const dispatched = []
  const effects = [], listeners = new Map()
  let hookIndex = 0
  let aliasEntries = options.aliasEntries ?? []
  let tierValue = options.tier ?? 'recommended'
  let tierReadFails = false
  let postTier = () => Promise.resolve(makeResponse({ tier: 'unrestricted' }))
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const i = hookIndex++
      if (slots[i] === undefined) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect(fn) { if (options.effects) effects.push(fn) },
    useCallback: (fn) => fn,
    useRef: (current) => {
      const i = hookIndex++
      if (slots[i] === undefined) slots[i] = { value: { current } }
      return slots[i].value
    },
  }
  const sandbox = {
    CustomEvent: class CustomEventStub { constructor(type) { this.type = type } },
    window: {
      __ModuleLoader__: { load(value) { registration = value } },
      innerWidth: options.viewport?.width ?? 1024,
      innerHeight: options.viewport?.height ?? 768,
      dispatchEvent(event) { dispatched.push(event?.type ?? ''); return true },
      addEventListener(type, handler) { listeners.set(type, handler) },
      removeEventListener() {},
    },
    document: { addEventListener() {}, removeEventListener() {}, head: null, documentElement: { lang: 'zh-CN' }, getElementById() { return null } },
    navigator: { language: 'zh-CN' },
    localStorage: options.localStorage ?? { getItem() { return null }, setItem() {} },
    fetch: (url, init) => {
      const path = String(url)
      const method = init?.method ?? 'GET'
      fetchLog.push({ method, path, body: init?.body ?? null })
      if (method === 'POST' && path === '/breaklimit/tier') return postTier(init)
      if (method === 'PUT' && path === '/breaklimit/alias') {
        const next = JSON.parse(init.body).entries
        aliasEntries = next
        return Promise.resolve(makeResponse({ entries: next.map((entry) => ({ ...entry })) }))
      }
      if (path === '/breaklimit/alias') {
        return Promise.resolve(makeResponse({ entries: aliasEntries.map((entry) => ({ ...entry })), limits: { maxEntries: 100, maxTerm: 64 }, lastHits: 0 }))
      }
      if (path === '/breaklimit/tier') {
        return tierReadFails
          ? Promise.reject(Object.assign(new Error('offline'), { name: 'TypeError' }))
          : Promise.resolve(makeResponse({ tier: tierValue }))
      }
      return new Promise(() => {})
    },
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)
  if (options.hooks) for (const [index, value] of Object.entries(options.hooks)) slots[Number(index)] = { value }
  return {
    exported,
    fetchLog,
    dispatched,
    effects,
    listeners,
    setAlias: (entries) => { aliasEntries = entries },
    setTier: (value) => { tierValue = value },
    setTierReadFails: (value) => { tierReadFails = value },
    setPostTier: (handler) => { postTier = handler },
    render: () => {
      hookIndex = 0
      return exported.AliasRow({})
    },
  }
}

test('B8 浮窗切档：超时/断网按结果未知处理并读回核对，明确失败才说没切', async () => {
  const harness = loadDockHarness({ hooks: { 5: true } })
  const { exported } = harness
  exported.aliasStore.state.phase = 'ready'
  const panel = (tree) => textOf(findAll(tree, (n) => n.props?.role === 'dialog')[0])
  const cards = (tree) => findAll(tree, (n) => n.type === 'button' && n.props?.className === 'dock-mode-card')
  const confirm = (tree) => findAll(tree, (n) => n.type === 'button' && n.props?.['aria-label'] === '切换')[0]

  // 场景一：POST 超时但实际已写入 —— 结果未知 + 读回核对，不许误报失败。
  let tree = harness.render()
  cards(tree)[1].props.onClick() // 选中「完全解放」
  tree = harness.render()
  harness.setTier('unrestricted') // 后端实际已切
  harness.setPostTier(() => Promise.reject(Object.assign(new Error('slow'), { name: 'AbortError' })))
  confirm(tree).props.onClick()
  await flushMicrotasks()
  tree = harness.render()
  assert.equal(panel(tree).includes('已重新读取核对，显示的即当前实际档位'), true, '超时应显示结果未知并说明已核对')
  assert.equal(panel(tree).includes('切换失败，当前仍是原来那档'), false, '超时不能误报切换失败')
  assert.equal(cards(tree)[1].props['aria-pressed'], 'true', '档位应跟随读回结果')
  assert.equal(cards(tree)[0].props['aria-pressed'], 'false')
  assert.equal(harness.fetchLog.filter((call) => call.method === 'GET' && call.path === '/breaklimit/tier').length, 1, '超时后必须重新读取核对')
  assert.equal(harness.dispatched.filter((type) => type === 'bkl:state-changed').length, 1, '结果未知但核对成功后要广播状态变更，设置区才不陈旧')

  // 场景二：明确失败（如预检阻断）—— 才说没切，且不属于结果未知。
  harness.setPostTier(() => Promise.resolve({ ok: false, status: 409, json: async () => ({ ok: false, code: 'preflight_blocked', message: '', data: null }) }))
  cards(tree)[0].props.onClick() // 切回「推荐」
  tree = harness.render()
  confirm(tree).props.onClick()
  await flushMicrotasks()
  tree = harness.render()
  assert.equal(panel(tree).includes('切换失败，当前仍是原来那档'), true, '明确失败要说没切')
  assert.equal(panel(tree).includes('没有收到切换回执'), false, '明确失败不是结果未知')
  assert.equal(cards(tree)[1].props['aria-pressed'], 'true', '明确失败档位不变')
  assert.equal(harness.dispatched.filter((type) => type === 'bkl:state-changed').length, 1, '明确失败不广播（档位没变），计数应停在场景一')

  // 场景三：超时且读回也失败 —— 只说没核对上，不许声称显示的就是实际档位。
  harness.setTierReadFails(true)
  harness.setPostTier(() => Promise.reject(Object.assign(new Error('slow'), { name: 'AbortError' })))
  cards(tree)[0].props.onClick()
  tree = harness.render()
  confirm(tree).props.onClick()
  await flushMicrotasks()
  tree = harness.render()
  assert.equal(panel(tree).includes('当前档位没能核对上'), true, '读回失败只说没核对上')
  assert.equal(panel(tree).includes('切换失败，当前仍是原来那档'), false)
  assert.equal(panel(tree).includes('显示的即当前实际档位'), false, '没核对上不许声称显示的是实际档位')
  assert.equal(harness.dispatched.filter((type) => type === 'bkl:state-changed').length, 2, '读回失败同样是结果未知，也要广播')
})

test('B8 浮窗删除确认按条目身份锚定：确认期间列表变化不误删', async () => {
  const harness = loadDockHarness({ hooks: { 5: true } })
  const { exported } = harness
  const a = { from: 'aaa', to: 'x1' }
  const b = { from: 'bbb', to: 'x2' }
  const c = { from: 'ccc', to: 'x3' }
  exported.aliasStore.state.phase = 'ready'
  exported.aliasStore.state.entries = [a, b, c]
  const delButtons = (tree) => findAll(tree, (n) => n.type === 'button' && n.props?.className === 'dock-alias-del')

  let tree = harness.render()
  assert.equal(delButtons(tree).length, 3)
  delButtons(tree)[1].props.onClick() // 给 bbb 挂确认态
  // 确认期间列表变了（aaa 被别处删掉）：bbb 从下标 1 挪到 0。
  exported.aliasStore.state.entries = [b, c]
  tree = harness.render()
  const armed = delButtons(tree).filter((n) => n.props?.title !== undefined)
  assert.equal(armed.length, 1, '只应有一个确认态按钮')
  assert.equal(String(armed[0].props.title).includes('bbb'), true, '确认态必须挂在 bbb 行')
  assert.equal(String(armed[0].props.title).includes('ccc'), false, '确认态不许漂到 ccc 行')
  armed[0].props.onClick() // 确认删除
  await flushMicrotasks()
  const puts = harness.fetchLog.filter((call) => call.method === 'PUT')
  assert.equal(puts.length, 1)
  assert.deepEqual(JSON.parse(puts[0].body).entries.map((entry) => entry.from), ['ccc'], '删掉的应是 bbb，ccc 不许陪葬')
})

test('B8 归一化上限以下 limits 为准：后端调高上限后第 101 条起不被删掉', async () => {
  const { exported } = loadClient()
  const many = Array.from({ length: 120 }, (_, i) => ({ from: `f${i}`, to: `t${i}` }))
  // limits 缺席才回落模块常量（100 条 / 64 字符）
  assert.equal(exported.normalizeAliasEntries(many).length, 100)
  assert.equal(exported.normalizeAliasEntries([{ from: 'x'.repeat(65), to: 'y' }]).length, 0)
  // limits 为准
  assert.equal(exported.normalizeAliasEntries(many, { maxEntries: 150, maxTerm: 64 }).length, 120, '120 条按 limits 全保留')
  assert.equal(exported.normalizeAliasEntries([{ from: 'x'.repeat(80), to: 'y' }], { maxEntries: 150, maxTerm: 80 }).length, 1, '80 字符词条在 maxTerm=80 时合法')
  // 读取与提交两个挂载点共用这一口径
  let disk = many
  const store = exported.createAliasStore({
    get: async () => ({ ok: true, code: 'ok', message: '', data: { entries: disk, limits: { maxEntries: 150, maxTerm: 80 }, lastHits: 0 } }),
    put: async (_path, body) => { disk = body.entries; return { ok: true, code: 'saved', data: { entries: disk } } },
  })
  await store.read()
  assert.equal(store.state.entries.length, 120, '读取归一化不许按 100 条常量截断')
  const saved = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'new', to: 'one' } })
  assert.equal(saved.ok, true)
  assert.equal(store.state.entries.length, 121, '提交回来的整表同样不被常量截断')
  // 预览与归一化同一口径：80 字符词条在 maxTerm=80 时参与替换
  const long = 'x'.repeat(80)
  assert.equal(exported.maskPreview(long, [{ from: long, to: 'Y' }], { maxEntries: 150, maxTerm: 80 }).text, 'Y')
  assert.equal(exported.maskPreview(long, [{ from: long, to: 'Y' }]).text, long, 'limits 缺席仍按 64 字符常量丢弃')
})

test('B8 点列表切换规则过草稿守卫：不丢草稿、不误拉正文，确认后才切', async () => {
  const { log, fetch } = deferredFetch()
  const harness = loadSectionHarness(async () => {}, {
    fetch,
    status: {
      rules: [
        { id: 'r1', name: 'Rule One', target: 'AGENTS.md', bytes: 10 },
        { id: 'r2', name: 'Rule Two', target: 'CLAUDE.md', bytes: 20 },
      ],
      activeRule: 'r1',
    },
    hooks: {
      0: 'rules',
      // ruleBody 已就位（id 与选中项一致）：规则正文按需加载的 effect 不会再拉。
      // 这也是「正在看 r1 且手上有脏草稿」的真实状态；顺带避开桩内 effect 在
      // render 中途执行时踩到后置 const 的 TDZ（真 React 在 render 后才跑 effect）。
      19: { id: 'r1', status: 'ok', text: 'body' },
      17: { id: 'r1', name: '', target: 'AGENTS.md', text: 'new draft', isNew: false, baseline: { id: 'r1', name: '', target: 'AGENTS.md', text: 'old body' } },
    },
  })
  const { exported } = harness
  const reads = () => log.filter((call) => call.url.includes('/rules/read'))
  const tree = harness.render()
  const rulesNode = findAll(tree, (n) => n.type === exported.RulesBlock)[0]
  const ruleList = rulesNode.type({ ...rulesNode.props, children: rulesNode.children })
  const ruleButtons = findAll(ruleList, (n) => n.type === 'button' && String(n.props?.['aria-label'] ?? '').startsWith('查看规则'))
  assert.equal(ruleButtons.length, 2)
  ruleButtons[1].props.onClick() // 点 Rule Two——手上有脏草稿
  assert.deepEqual(reads(), [], '守卫拦下后不许拉 r2 正文')
  assert.equal(harness.hooks[17].value.text, 'new draft', '草稿不许被清掉')
  assert.notEqual(harness.hooks[18].value, 'r2', '选中项不许偷偷切换')
  const tree2 = harness.render()
  const dialogNode = findAll(tree2, (n) => n.type === exported.Dialog && n.props?.open === true)[0]
  assert.equal(Boolean(dialogNode), true, '应弹出放弃草稿确认')
  assert.equal(dialogNode.props.title, '当前有未保存的规则草稿')
  dialogNode.props.onAccept() // 确认放弃才真正切
  await flushMicrotasks()
  assert.equal(harness.hooks[12].value, null, '确认后弹窗关闭')
  assert.equal(harness.hooks[17].value, null, '确认后才清草稿')
  assert.equal(harness.hooks[18].value, 'r2', '确认后才切到 r2')
  assert.deepEqual(reads().map((call) => call.url), ['/breaklimit/rules/read?id=r2'], '确认后才拉一次 r2 正文')
})

test('B8 浮窗读回存档即夹边：小视口下不会整体落在视口外', () => {
  const stored = JSON.stringify({ version: 1, rect: { x: 5000, y: 5000, width: 380, height: 460 } })
  const harness = loadDockHarness({
    hooks: { 5: true },
    viewport: { width: 800, height: 600 },
    localStorage: { getItem: () => stored, setItem() {} },
  })
  const tree = harness.render()
  const dialog = findAll(tree, (n) => n.props?.role === 'dialog')[0]
  const rect = {
    left: Number.parseFloat(dialog.props.style.left),
    top: Number.parseFloat(dialog.props.style.top),
    width: Number.parseFloat(dialog.props.style.width),
    height: Number.parseFloat(dialog.props.style.height),
  }
  assert.equal(rect.left >= 0 && rect.left + rect.width <= 800, true, `浮窗横坐标越界：${dialog.props.style.left}`)
  assert.equal(rect.top >= 0 && rect.top + rect.height <= 600, true, `浮窗纵坐标越界：${dialog.props.style.top}`)
})

test('B8 更新弹窗被迟到 render 重开：用户关掉后不再弹开', async () => {
  const { log, fetch } = deferredFetch()
  const harness = loadSectionHarness(async () => {}, {
    fetch,
    hooks: { 26: { hasUpdate: false, newer: false, autoCheckUpdates: true, checkedAt: 1 } },
  })
  const { exported } = harness
  const openDialogs = (tree) => findAll(tree, (n) => n.type === exported.Dialog && n.props?.open === true)
  const bodyText = (dialogNode) => textOf({ children: [dialogNode.props.body] })

  let tree = harness.render()
  findAll(tree, (n) => n.type === 'button' && n.props?.className === 'bkl-version')[0].props.onClick()
  tree = harness.render()
  assert.equal(openDialogs(tree).length, 1, '点版本徽章应打开更新弹窗')
  // 点「检查更新」：请求在途
  const checkButton = findAll({ children: [openDialogs(tree)[0].props.body] }, (n) => n.type === exported.Button && textOf(n) === '检查更新')[0]
  checkButton.props.onClick()
  tree = harness.render()
  assert.equal(bodyText(openDialogs(tree)[0]).includes('正在检查'), true)
  // 请求在途中用户关掉弹窗
  findAll(tree, (n) => n.type === exported.Dialog && n.props?.idBase === 'bkl-dialog')[0].props.onClose()
  tree = harness.render()
  assert.equal(openDialogs(tree).length, 0, '关掉后不该有打开的弹窗')
  // 迟到的检查结果落定：不许把弹窗重新打开
  log.filter((call) => call.url.endsWith('/update/check'))[0].resolve(makeResponse({ hasUpdate: false, newer: false, checkedAt: 2, autoCheckUpdates: true }))
  await flushMicrotasks()
  tree = harness.render()
  assert.equal(openDialogs(tree).length, 0, '迟到的 render 不许重开弹窗')
  assert.equal(harness.hooks[12].value, null, '弹窗状态必须保持关闭')
})

test('B8 自动检查失败显示失败态，不显示『已是最新版本』', () => {
  const openUpdateBody = (harness) => {
    const tree = harness.render()
    findAll(tree, (n) => n.type === 'button' && n.props?.className === 'bkl-version')[0].props.onClick()
    const node = findAll(harness.render(), (n) => n.type === harness.exported.Dialog && n.props?.open === true)[0]
    return {
      text: textOf({ children: [node.props.body] }),
      notices: findAll({ children: [node.props.body] }, (n) => n.type === harness.exported.Notice),
    }
  }
  const view = (extra) => ({ hasUpdate: false, newer: false, autoCheckUpdates: true, checkedAt: 1700000000000, ...extra })
  // 自动检查失败（连不上 GitHub）：如实报失败，不再说「已是最新版本」。
  const failed = openUpdateBody(loadSectionHarness(async () => {}, { hooks: { 26: view({ lastError: 'update_unreachable' }) } }))
  assert.equal(failed.notices.some((n) => n.props?.title === '连不上 GitHub'), true, '应显示失败态')
  assert.equal(failed.text.includes('已是最新版本'), false, '失败时不许说已是最新版本')
  // locked 与 update_invalid 各有其文案。
  const locked = openUpdateBody(loadSectionHarness(async () => {}, { hooks: { 26: view({ lastError: 'locked' }) } }))
  assert.equal(locked.notices.some((n) => n.props?.title === '更新状态被其它进程占用'), true)
  const invalid = openUpdateBody(loadSectionHarness(async () => {}, { hooks: { 26: view({ lastError: 'update_invalid' }) } }))
  assert.equal(invalid.notices.some((n) => n.props?.title === '检查结果无法解析'), true)
  // 对照：没有失败结论时仍是「已是最新版本」，断言本身有判别力。
  const ok = openUpdateBody(loadSectionHarness(async () => {}, { hooks: { 26: view({}) } }))
  assert.equal(ok.text.includes('已是最新版本'), true)
  assert.equal(ok.notices.length, 0)
})


test('词库未知写入后核对期间及排队操作拒写，旧读取不能解除保护', async () => {
  const { exported } = loadClient()
  let disk = [{ from: 'existing', to: 'E' }], fail = true
  const reads = []
  const store = exported.createAliasStore({
    get: () => new Promise(resolve => reads.push(resolve)),
    put: async (_p, body) => {
      disk = body.entries
      if (fail) throw Object.assign(new Error('reply lost'), { code: 'network' })
      return { data: { entries: disk } }
    },
  })
  const initial = store.read(); reads.shift()({ data: { entries: disk } }); await initial
  const staleRead = store.read()
  const a = store.commit({ type: 'save', entry: { from: 'A', to: 'a' } })
  const queued = store.commit({ type: 'save', entry: { from: 'queued', to: 'q' } })
  assert.equal((await a).unknown, true)
  assert.equal((await queued).refused, true)
  assert.equal(store.state.stale, true)
  reads.shift()({ data: { entries: [{ from: 'existing', to: 'E' }] } }); await staleRead
  assert.equal(store.state.stale, true)
  const checking = store.read()
  assert.equal((await store.commit({ type: 'save', entry: { from: 'B', to: 'b' } })).refused, true)
  reads.shift()({ data: { entries: disk } }); await checking
  fail = false
  assert.equal((await store.commit({ type: 'save', entry: { from: 'B', to: 'b' } })).ok, true)
  assert.deepEqual(Array.from(disk, e => e.from), ['existing', 'A', 'B'])
})

test('规则保存只清理已提交版本，保存期间的新修改与其他编辑器保持原样', async () => {
  for (const change of [null, { text: 'new draft' }, { name: 'new name' }, { target: 'CLAUDE.md' }, { id: 'other', text: 'other draft' }]) {
    let reply
    const rule = { id: 'r', name: 'r', target: 'AGENTS.md' }
    const edit = { isNew: false, ...rule, text: 'submitted', baseline: { ...rule, text: 'before' } }
    const h = loadSectionHarness(async () => {}, {
      hooks: { 0: 'rules', 17: edit, 19: { id: 'r', status: 'ok', text: 'before' } },
      status: { rules: [rule], activeRule: null },
      fetch: (_url, init) => init?.method === 'POST' ? new Promise(resolve => { reply = resolve }) : new Promise(() => {}),
    })
    let block = findAll(h.render(), n => n.type === h.exported.RulesBlock)[0]
    block.props.onSave(); await flushMicrotasks()
    if (change) {
      block = findAll(h.render(), n => n.type === h.exported.RulesBlock)[0]
      block.props.onEditChange({ ...block.props.edit, ...change })
    }
    reply({ ok: true, status: 200, json: async () => ({ ok: true, code: 'saved', data: rule }) })
    await flushMicrotasks()
    const remaining = h.hooks[17].value
    if (change === null) assert.equal(remaining, null)
    else {
      for (const [key, value] of Object.entries(change)) assert.equal(remaining?.[key], value)
      if (!change.id) assert.equal(remaining.baseline.text, 'submitted')
    }
  }
})

test('取消激活被保留时明确显示仍生效，中英文都不能显示取消成功', async () => {
  for (const lang of ['zh-CN', 'en']) {
    const rule = { id: 'r', name: 'r', target: 'AGENTS.md' }
    const h = loadSectionHarness(async () => {}, { lang, hooks: { 0: 'rules', 19: { id: 'r', status: 'ok', text: 'body' } },
      status: { rules: [rule], activeRule: 'r' },
      fetch: (_url, init) => init?.method === 'POST'
        ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, code: 'deactivate_kept', data: { kept: true, active: true, skipped: [{ path: 'AGENTS.md' }] } }) })
        : new Promise(() => {}),
    })
    findAll(h.render(), n => n.type === h.exported.RulesBlock)[0].props.onDeactivate(rule)
    void h.hooks[12].value.run(); await flushMicrotasks()
    const notice = h.hooks[14].value.rules
    assert.equal(notice.tone, 'warn')
    assert.match(notice.title, lang === 'en' ? /still active/i : /仍在生效/)
  }
})

test('保存在途时编辑器换成同 id 的另一次读取，迟到响应不把旧内容当新草稿留下', async () => {
  let replySave
  let replyRead
  const rule = { id: 'r', name: 'r', target: 'AGENTS.md' }
  const edit = {
    isNew: true, id: 'r', name: 'r', target: 'AGENTS.md', text: 'submitted', token: 99,
    baseline: { isNew: true, id: 'r', name: 'r', target: 'AGENTS.md', text: 'submitted' },
  }
  const h = loadSectionHarness(async () => {}, {
    hooks: { 0: 'rules', 17: edit, 19: { id: 'r', status: 'ok', text: 'submitted' } },
    status: { rules: [], activeRule: null },
    fetch: (_url, init) => init?.method === 'POST'
      ? new Promise(resolve => { replySave = resolve })
      : new Promise(resolve => { replyRead = resolve }),
  })
  let block = findAll(h.render(), n => n.type === h.exported.RulesBlock)[0]
  block.props.onSave(); await flushMicrotasks()
  // 保存在途：点「打开已有规则」把编辑器换成同 id 的另一次读取（草稿是干净的，不弹确认）。
  block = findAll(h.render(), n => n.type === h.exported.RulesBlock)[0]
  block.props.onEdit('r'); await flushMicrotasks()
  replyRead({ ok: true, status: 200, json: async () => ({ ok: true, code: 'ok', data: { name: '', target: 'AGENTS.md', text: 'refetched' } }) })
  await flushMicrotasks()
  assert.equal(h.hooks[17].value.text, 'refetched')
  replySave({ ok: true, status: 200, json: async () => ({ ok: true, code: 'saved', data: rule }) })
  await flushMicrotasks()
  const after = h.hooks[17].value
  assert.equal(after.text, 'refetched', '迟到响应不许把保存前的内容换回来')
  assert.equal(after.baseline.text, 'refetched', 'baseline 不许标成刚提交的版本')
  const notice = h.hooks[14].value.rules
  assert.equal(notice.tone, 'warn')
  assert.match(notice.title, /未受影响/)
  assert.match(notice.next, /没有被改动/)
})


test('关闭的 dialog 对宿主焦点环隐藏且不可交互', () => {
  const { exported } = loadClient()
  const tree = mount(exported.Dialog({ open: false, title: 'Closed', body: null, onClose() {} }))
  const dialog = findAll(tree, n => n.type === 'dialog')[0]
  assert.equal(dialog.props.hidden, true)
  assert.equal(dialog.props.inert, '')
})


test('浮窗 Esc 只处理自身焦点，宿主其他弹层的 Esc 保持可用', async () => {
  const harness = loadDockHarness({ effects: true, hooks: { 5: true } })
  const tree = harness.render(), inside = {}, outside = {}
  const panel = findAll(tree, node => node.props?.role === 'dialog')[0]
  panel.props.ref.current = { contains: target => target === inside }
  tree.props.ref.current = { contains: () => false }
  for (const effect of harness.effects.splice(0)) effect()
  const keydown = harness.listeners.get('keydown')
  let stopped = 0
  const event = target => ({ key: 'Escape', target, stopPropagation() { stopped++ }, preventDefault() {} })
  keydown(event(outside))
  assert.equal(stopped, 0)
  assert.equal(findAll(harness.render(), node => node.props?.role === 'dialog').length, 1)
  keydown(event(inside))
  assert.equal(stopped, 1)
  assert.equal(findAll(harness.render(), node => node.props?.role === 'dialog').length, 0)
  await flushMicrotasks()
})


test('浮窗提交前词表状态变旧时明确未写入，保留草稿并重新读取', async () => {
  const harness = loadDockHarness({ hooks: { 5: true, 7: 'SOURCE', 8: 'TARGET' } })
  harness.exported.aliasStore.state.phase = 'ready'
  const tree = harness.render()
  const add = findAll(tree, node => node.type === 'button' && textOf(node) === '添加')[0]
  assert.ok(add)
  harness.exported.aliasStore.state.stale = true
  add.props.onClick()
  await flushMicrotasks()
  assert.equal(harness.fetchLog.filter(call => call.method === 'PUT').length, 0)
  assert.equal(harness.fetchLog.filter(call => call.path === '/breaklimit/alias').length, 1)
  const after = harness.render()
  assert.match(textOf(after), /本次未写入/)
  const inputs = findAll(after, node => node.type === 'input')
  assert.ok(inputs.some(node => node.props.value === 'SOURCE'))
})
