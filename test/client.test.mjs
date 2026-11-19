// 浏览器半边：右侧停靠栏的画布标签页、输入框插入、开新会话后把画布放到旁边。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function load() {
  let mod
  const listeners = []
  const effects = []
  // 极简 React：effect 立即执行，ref 指向一个假 iframe
  const React = {
    createElement: (type, props) => ({ type, props }),
    useRef: () => ({ current: { contentWindow: { posted: [], postMessage(m) { this.posted.push(m) } } } }),
    useEffect: (fn) => effects.push(fn()),
  }
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { mod = factory((name) => (name === 'react' ? React : null)) } },
  }
  const sandbox = {
    window,
    location: { origin: 'http://dsh.local' },
    addEventListener: (type, fn) => listeners.push(fn),
    removeEventListener: () => {},
    setTimeout: (fn) => fn(),
    Date,
  }
  vm.runInNewContext(SOURCE, sandbox)
  return { mod, listeners, effects }
}

function fakeCtx({ mounted = 's1', openThrows = 0 } = {}) {
  const calls = { registered: [], tabTypes: [], started: [], opened: [] }
  const slots = {
    inject: (name, fn) => fn(),
    register: (spec, Component) => calls.registered.push({ spec, Component }),
  }
  let throwsLeft = openThrows
  const sub = {
    slots,
    effect: (fn) => fn(),
    sidebarRight: {
      mounted: { getSnapshot: () => mounted },
      openTab: (kind, opts) => {
        if (throwsLeft-- > 0) throw new Error('store 未建好')
        calls.opened.push([kind, opts])
      },
    },
    sidebarRightTabs: { register: (def) => calls.tabTypes.push(def) },
  }
  const ctx = {
    slots,
    uiWorkspace: { startSession: (id, opts) => calls.started.push(opts) },
    inject: (names, fn) => (names.includes('theme') ? undefined : fn(sub)),
  }
  return { ctx, calls }
}

// vm 里造出的对象原型不同，比较前先转成普通 JSON
const plain = (value) => JSON.parse(JSON.stringify(value))
const component = (calls, name) => calls.registered.find((r) => r.spec.name === name).Component

function send(env, frameOwner, prompt) {
  const frame = frameOwner
  for (const fn of env.listeners) {
    fn({ source: frame.contentWindow, origin: 'http://dsh.local', data: { type: 'yingma-canvas:start', prompt } })
  }
}

test('侧栏图标跟 DSH 系统图标同规格：16 画布、1 线宽、字形不出 14', () => {
  assert.match(SOURCE, /viewBox: '0 0 16 16'/)
  assert.match(SOURCE, /strokeWidth: 1,/)
  const rects = [...SOURCE.matchAll(/h\('rect', \{ x: ([\d.]+), y: ([\d.]+), width: ([\d.]+), height: ([\d.]+)/g)]
  assert.equal(rects.length, 2)
  for (const [, x, y, w, h] of rects) {
    assert.ok(Number(x) >= 2 && Number(y) >= 2)
    assert.ok(Number(x) + Number(w) <= 14 && Number(y) + Number(h) <= 14)
  }
})

test('注册右侧停靠栏的画布标签页和输入框桥', () => {
  const env = load()
  const { ctx, calls } = fakeCtx()
  env.mod.apply(ctx)
  assert.deepEqual(plain(calls.tabTypes.map((d) => [d.id, d.kind, d.keepMounted])), [['dsh-yingma-canvas/canvas', 'yingma-canvas', true]])
  const names = calls.registered.map((r) => r.spec.name)
  assert.ok(names.includes('sidebar.right.pane.tab'))
  assert.ok(names.includes('conversation.input.left'))
  assert.ok(names.includes('main'))
  const tab = calls.registered.find((r) => r.spec.name === 'sidebar.right.pane.tab')
  assert.equal(tab.spec.key, 'dsh-yingma-canvas/canvas')
})

test('停靠在对话旁边：草稿插进当前会话的输入框，不另开会话', () => {
  const env = load()
  const { ctx, calls } = fakeCtx({ mounted: 's1' })
  env.mod.apply(ctx)
  const inserted = []
  component(calls, 'conversation.input.left')({
    sessionId: 's1',
    inputActions: { captureInsertion: () => ({ from: 0, draftRev: 1 }), insertText: (text) => inserted.push(text) },
  })
  const frame = component(calls, 'sidebar.right.pane.tab')()
  const ref = frame.props.ref
  assert.match(frame.props.src, /\?dock=1$/)
  send(env, ref.current, '看一下这些节点')
  assert.deepEqual(inserted, ['看一下这些节点'])
  assert.deepEqual(calls.started, [])
  assert.deepEqual(plain(ref.current.contentWindow.posted.at(-1)), { type: 'yingma-canvas:inserted' })
})

test('主面板里的画布：开新会话，再把画布放到它旁边（store 没好会重试）', () => {
  const env = load()
  const { ctx, calls } = fakeCtx({ mounted: 's2', openThrows: 2 })
  env.mod.apply(ctx)
  const frame = component(calls, 'main')()
  send(env, frame.props.ref.current, '用 yingma 工具看一下画布')
  assert.deepEqual(plain(calls.started), [{ prompt: '用 yingma 工具看一下画布', whenDraftExists: 'replace' }])
  assert.deepEqual(plain(calls.opened), [['yingma-canvas', { revealIfOpened: true }]])
})

test('停靠但这个会话没有输入框桥：退回开新会话', () => {
  const env = load()
  const { ctx, calls } = fakeCtx({ mounted: 's3' })
  env.mod.apply(ctx)
  const frame = component(calls, 'sidebar.right.pane.tab')()
  send(env, frame.props.ref.current, 'hi')
  assert.equal(calls.started.length, 1)
})
