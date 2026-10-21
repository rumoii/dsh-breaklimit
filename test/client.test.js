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
// override=5、draft=16、ruleEdit=18；用 options.hooks 按下标覆盖。
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
    document: { head: null, documentElement: { lang: 'zh-CN' }, getElementById() { return null } },
    navigator: { language: 'zh-CN', clipboard: { writeText: writeTextImpl } },
    // load() 里的 fetch 永不落定，避免桩环境下产生无关的失败路径与计时器。
    fetch: () => new Promise(() => {}),
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

test('阶段三：flowSteps 4 阶段进度流纯函数建模', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const { flowSteps } = exported
  assert.equal(typeof flowSteps, 'function', 'flowSteps 必须被导出')

  // 场景 1: 未配置宿主目录
  const s1 = flowSteps({ hostRoot: null }, { rootMissing: true, enabledCount: 0, pendingFiles: 0, blocked: [] })
  assert.equal(s1.length, 4)
  assert.deepEqual(plain(s1[0]), ['配置宿主目录', 'current', '告诉插件源码在哪'])
  assert.equal(s1[1][1], 'todo')
  assert.equal(s1[2][1], 'todo')
  assert.equal(s1[3][1], 'todo')

  // 场景 2: 目录已就位，但尚未选择补丁
  const s2 = flowSteps({ hostRoot: '/dsh' }, { rootMissing: false, enabledCount: 0, pendingFiles: 0, blocked: [] })
  assert.deepEqual(plain(s2[0]), ['配置宿主目录', 'done', '已找到宿主源码'])
  assert.deepEqual(plain(s2[1]), ['选择补丁', 'current', '还没有选择'])
  assert.equal(s2[2][1], 'todo')
  assert.equal(s2[3][1], 'todo')

  // 场景 3: 已选 2 条补丁，待写入 3 个文件
  const s3 = flowSteps({ hostRoot: '/dsh' }, { rootMissing: false, enabledCount: 2, pendingFiles: 3, blocked: [] })
  assert.equal(s3[0][1], 'done')
  assert.deepEqual(plain(s3[1]), ['选择补丁', 'done', '已选 2 条'])
  assert.deepEqual(plain(s3[2]), ['检查并应用', 'current', '待写入 3 个文件'])
  assert.equal(s3[3][1], 'todo')

  // 场景 4: 预检阻断
  const s4 = flowSteps({ hostRoot: '/dsh' }, { rootMissing: false, enabledCount: 2, pendingFiles: 0, blocked: [{ patchId: 'p1' }] })
  assert.equal(s4[2][1], 'blocked')
  assert.deepEqual(plain(s4[2]), ['检查并应用', 'blocked', '预检未通过，未写入'])

  // 场景 5: 等待重启
  const s5 = flowSteps({ hostRoot: '/dsh', restart: 'apply' }, { rootMissing: false, restartPending: true, enabledCount: 2, pendingFiles: 0, blocked: [] })
  assert.equal(s5[2][1], 'done')
  assert.deepEqual(plain(s5[3]), ['重启宿主', 'current', '等你按原方式重启'])

  // 场景 6: 英文语言环境下输出纯英文字符串
  const { exported: exportedEn } = loadClient({ document: { documentElement: { lang: 'en' } } })
  const sEn = exportedEn.flowSteps({ hostRoot: '/dsh' }, { rootMissing: false, enabledCount: 1, pendingFiles: 1, blocked: [] })
  assert.deepEqual(plain(sEn[0]), ['Configure host directory', 'done', 'Host source found'])
  assert.deepEqual(plain(sEn[1]), ['Select patches', 'done', 'Selected 1 patch'])
  assert.deepEqual(plain(sEn[2]), ['Check and apply', 'current', '1 file pending'])
  assert.deepEqual(plain(sEn[3]), ['Restart host', 'todo', 'Pending patch application'])
})

test('阶段三：deriveActionCard 主行动卡片优先级判定与数据结构', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const { deriveActionCard } = exported
  assert.equal(typeof deriveActionCard, 'function', 'deriveActionCard 必须被导出')

  // 1. 规则清单损坏优先级最高
  const aCorrupt = deriveActionCard({}, { rulesIndex: 'corrupt', rootMissing: true, broken: true })
  assert.equal(aCorrupt.tone, 'error')
  assert.equal(aCorrupt.action, 'goRules')
  assert.equal(aCorrupt.icon, 'alert')
  assert.equal(aCorrupt.label, '需要先处理')
  assert.equal(aCorrupt.title, '规则清单读不出来')

  // 2. 状态记录损坏
  const aBroken = deriveActionCard({}, { broken: true, rootMissing: true })
  assert.equal(aBroken.tone, 'error')
  assert.equal(aBroken.action, 'refresh')
  assert.equal(aBroken.icon, 'alert')

  // 3. 宿主目录未配置
  const aRoot = deriveActionCard({}, { rootMissing: true, blocked: [] })
  assert.equal(aRoot.tone, 'warn')
  assert.equal(aRoot.action, 'configureRoot')
  assert.equal(aRoot.icon, 'folder')
  assert.equal(aRoot.label, '下一步 · 配置环境')

  // 4. 预检阻断
  const aBlocked = deriveActionCard({}, { rootMissing: false, blocked: [{ patchId: 'p' }] })
  assert.equal(aBlocked.tone, 'error')
  assert.equal(aBlocked.action, 'goPatches')
  assert.equal(aBlocked.icon, 'alert')

  // 5. 等待重启
  const aRestart = deriveActionCard({ restart: 'apply' }, { restartPending: true, rootMissing: false, blocked: [] })
  assert.equal(aRestart.tone, 'warn')
  assert.equal(aRestart.action, 'restartHelp')
  assert.equal(aRestart.icon, 'refresh')

  // 6. 有待写入文件
  const aPending = deriveActionCard({}, { pendingFiles: 2, enabledCount: 3, total: 3, rootMissing: false, blocked: [] })
  assert.equal(aPending.action, 'goPatches')
  assert.equal(aPending.icon, 'arrow')
  assert.equal(aPending.label, '下一步 · 应用补丁')

  // 7. 未选择补丁
  const aNone = deriveActionCard({}, { pendingFiles: 0, enabledCount: 0, total: 3, rootMissing: false, blocked: [] })
  assert.equal(aNone.action, 'goPatches')
  assert.equal(aNone.icon, 'patch')
  assert.equal(aNone.label, '按需选择')

  // 8. 检查通过全部就位
  const aDone = deriveActionCard({}, { pendingFiles: 0, enabledCount: 3, total: 3, rootMissing: false, blocked: [] })
  assert.equal(aDone.tone, 'ok')
  assert.equal(aDone.action, 'goPrompt')
  assert.equal(aDone.icon, 'check')
  assert.equal(aDone.label, '磁盘检查通过')
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

test('重塑 OverviewPage：4阶段进度流、action-card 与 Guide 三步、columns 双栏配置清单与技术诊断脱敏折叠', () => {
  const { exported } = loadClient({ document: { documentElement: { lang: 'zh-CN' } } })
  const { OverviewPage } = exported
  assert.equal(typeof OverviewPage, 'function', 'OverviewPage 必须被导出')

  let actionRan = null
  let toggledEnabled = null
  let navigatedTab = null
  let copiedText = null
  let guideToggled = false
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
    // applied 为 null：Guide step3 未完成（当前步落第 3 步），flow 第 3 阶段仍是 current。
    applied: null,
    preCode: 'ok',
    restartPending: false,
  }
  const fakeWords = {
    phase: 'ready',
    stale: false,
    entries: [{ from: '原词', to: '替换词' }],
  }

  const renderPage = (guideOpen, words = fakeWords) => OverviewPage({
    f: fakeF,
    status: fakeStatus,
    override: null,
    busy: false,
    enabledPending: false,
    restart: null,
    restartView: null,
    step: { tone: 'ok', title: '完成' },
    words,
    loadedAt: Date.now(),
    guideOpen,
    onToggleGuide() { guideToggled = true },
    onRun(action) { actionRan = action },
    onGo(tab) { navigatedTab = tab },
    onToggleEnabled(next) { toggledEnabled = next },
    onCopy(text) { copiedText = text },
    onOpenHelp() { helpOpened += 1 },
    nextNotice: null,
    overviewNotice: null,
  })

  const tree = mount(renderPage(true))

  // 1. 验证 4 阶段进度条（ol.bkl-flow）
  const flowNode = findAll(tree, n => n.type === 'ol' && n.props?.className === 'bkl-flow')[0]
  assert.equal(Boolean(flowNode), true, '应渲染 ol.bkl-flow 进度流')
  const flowItems = findAll(flowNode, n => n.type === 'li')
  assert.equal(flowItems.length, 4, '进度流应包含 4 个步骤')
  assert.equal(flowItems[0].props.className, 'done')
  assert.equal(flowItems[1].props.className, 'done')
  assert.equal(flowItems[2].props.className, 'current')
  assert.equal(flowItems[3].props.className, 'todo')

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
  assert.equal(actionRan, 'goPatches', '点击主行动卡片按钮应触发 action')

  // 3. 验证 bkl-columns 双栏
  const columnsNode = findAll(tree, n => n.props?.className === 'bkl-columns')[0]
  assert.equal(Boolean(columnsNode), true, '应渲染双栏网格 bkl-columns')
  assert.equal(findAll(tree, n => String(n.props?.className ?? '').includes('bkl-balanced-grid')).length, 0, '不应再有 bkl-balanced-grid')
  assert.equal(findAll(tree, n => String(n.props?.className ?? '').includes('bkl-hero-card')).length, 0, '不应再有 bkl-hero-card')

  // 4. 验证 Guide 三步引导（展开态）：进度、三步、当前步、收起链接
  const guideNode = findAll(tree, n => n.props?.className === 'bkl-guide')[0]
  assert.equal(Boolean(guideNode), true, '展开态应渲染 bkl-guide')
  const guideItems = findAll(guideNode, n => String(n.props?.className ?? '').includes('bkl-guide-item'))
  assert.equal(guideItems.length, 3, 'Guide 应有 3 个步骤行')
  assert.equal(textOf(guideNode).includes('已完成 2 / 3'), true, '进度文本应显示已完成 n / 3')
  const currentItems = findAll(guideNode, n => n.props?.className === 'bkl-guide-item is-current')
  assert.equal(currentItems.length, 1, '应有且仅有一个当前步 is-current')
  assert.equal(textOf(currentItems[0]).includes('应用，并重启宿主'), true, '当前步应是第一个未完成项（第 3 步）')
  assert.equal(textOf(guideItems[0]).includes('已有默认值'), true, 'step1 标题应带默认值后缀')
  const doneNums = findAll(guideNode, n => n.props?.className === 'bkl-step-num done')
  assert.equal(doneNums.length, 2, '已完成的两步序号块应为 done')
  const guideButtons = findAll(guideNode, n => n.type === 'button')
  const collapseLink = guideButtons.find(b => textOf(b).includes('收起步骤'))
  assert.equal(Boolean(collapseLink), true, '应有收起链接（guideHide）')
  const goLink = guideButtons.find(b => textOf(b).includes('去完成'))
  assert.equal(Boolean(goLink), true, '当前步链接文案应为「去完成」')
  goLink.props.onClick({ preventDefault() {} })
  assert.equal(navigatedTab, 'patches', '第 3 步链接应跳转 patches')
  const step1Link = findAll(guideItems[0], n => n.type === 'button')[0]
  step1Link.props.onClick({ preventDefault() {} })
  assert.equal(navigatedTab, 'prompt', 'step1 链接应跳转 prompt')
  // 步骤链接的可访问名称带上步骤标题，读屏列表里可区分
  const stepLinkLabels = guideItems.map(item => String(findAll(item, n => n.type === 'button')[0]?.props?.['aria-label'] ?? ''))
  const stepTitles = ['选择提示词模式', '选择需要的补丁', '应用，并重启宿主']
  stepLinkLabels.forEach((label, stepIndex) => {
    assert.equal(label.includes(stepTitles[stepIndex]), true, `步骤 ${String(stepIndex + 1)} 链接的可访问名称应含步骤标题（实际：${label}）`)
    assert.equal(label.includes('查看') || label.includes('去完成'), true, `步骤 ${String(stepIndex + 1)} 链接的可访问名称应含动作词`)
  })
  collapseLink.props.onClick({ preventDefault() {} })
  assert.equal(guideToggled, true, '收起链接应触发 onToggleGuide')

  // 5. 关闭态：只留 guideShow link
  const closedTree = mount(renderPage(false))
  assert.equal(findAll(closedTree, n => n.props?.className === 'bkl-guide').length, 0, '关闭态不应渲染 bkl-guide')
  const showLink = findAll(closedTree, n => n.type === 'button' && textOf(n).includes('展开步骤'))[0]
  assert.equal(Boolean(showLink), true, '关闭态应显示 guideShow link')
  showLink.props.onClick({ preventDefault() {} })
  assert.equal(guideToggled, true, '展开链接应触发 onToggleGuide')

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
  assert.equal(textOf(disclosure).includes('含本机路径，不含凭据'), true, '应展示不含凭据提示')
  const copyBtn = findAll(disclosure, n => n.type === 'button').find(b => textOf(b).includes('复制诊断信息'))
  assert.equal(Boolean(copyBtn), true, '应渲染复制诊断信息按钮')
  copyBtn.props.onClick({ preventDefault() {} })
  assert.equal(typeof copiedText === 'string' && copiedText.includes('宿主根: …/dsh-host'), true, '点击应触发一键复制脱敏文本')

  // 10. 词库 loading：配置卡显示「词表读取中…」，不误报「读取失败」
  const loadingTree = mount(renderPage(true, { phase: 'loading', entries: [], stale: false }))
  const loadingConfig = findAll(loadingTree, n => n.props?.className === 'bkl-summary-list')[0]
  assert.equal(Boolean(loadingConfig), true, 'loading 期配置卡应渲染')
  assert.equal(textOf(loadingConfig).includes('词表读取中…'), true, 'loading 期配置卡应显示「词表读取中…」')
  assert.equal(textOf(loadingConfig).includes('读取失败'), false, 'loading 期配置卡不得误报「读取失败」')
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
  const revertBtn = buttons.find(b => textOf(b).includes('回退'))
  const applyBtn = buttons.find(b => textOf(b).includes('写入 1 个文件') || textOf(b).includes('检查并应用') || textOf(b).includes('应用'))
  assert.equal(Boolean(revertBtn), true, '应渲染回退按钮')
  assert.equal(Boolean(applyBtn), true, '应渲染应用按钮')
  revertBtn.props.onClick({ preventDefault() {} })
  applyBtn.props.onClick({ preventDefault() {} })
  assert.equal(reverted, true, '点击回退应触发 onRevert')
  assert.equal(applied, true, '点击应用应触发 onApply')
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
  assert.equal(titleText.includes('推荐模式') || titleText.includes('完全解放模式'), true, '标题栏必须包含当前模式微徽章')

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
      18: { id: 'r1', name: 'n', target: 'AGENTS.md', text: 'new', isNew: false, baseline: { id: 'r1', name: 'n', target: 'AGENTS.md', text: 'old' } },
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

  // 2. 版本徽章：无 tone 的 Tag，文本为 0.9.3
  const versionTag = findAll(tree, n => n.type === noClose.exported.Tag && textOf(n) === '0.9.3')[0]
  assert.equal(Boolean(versionTag), true, '顶栏应渲染版本徽章 0.9.3')
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
