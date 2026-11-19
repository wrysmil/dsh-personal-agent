// 真的把控制台组件树渲染一遍（上一版 smoke 只建树、不执行组件函数）。
// 目的：提示符换成 textarea、输出区改成「只挂最后 N 行 + 显示更早」之后，
// 组件体里少写一个变量、hook 顺序错位这类错误，能在 Node 里就炸出来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** 够用的 React 替身：会真的调用函数组件，并按调用顺序分配 hook 槽位 */
function createReact() {
  const effects = []
  const frames = []
  let frame = null
  const nextSlot = () => {
    if (!frame) return {}
    const slot = frame.slots[frame.index] || (frame.slots[frame.index] = {})
    frame.index += 1
    return slot
  }
  return {
    memo: (component) => component,
    forwardRef: (render) => render,
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useRef: (initial) => {
      const slot = nextSlot()
      if (!('ref' in slot)) slot.ref = { current: initial }
      return slot.ref
    },
    useState: (initial) => {
      const slot = nextSlot()
      if (!('state' in slot)) slot.state = typeof initial === 'function' ? initial() : initial
      return [
        slot.state,
        (value) => {
          slot.state = typeof value === 'function' ? value(slot.state) : value
        },
      ]
    },
    useEffect: (fn) => {
      nextSlot()
      effects.push(fn)
    },
    useLayoutEffect: (fn) => {
      nextSlot()
      effects.push(fn)
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useId: () => 'id',
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    __enter() {
      frame = { index: 0, slots: [] }
      frames.push(frame)
    },
    __exit() {
      frames.pop()
      frame = frames[frames.length - 1] || null
    },
    __runEffects() {
      while (effects.length) {
        const fn = effects.shift()
        try {
          fn()
        } catch {
          // 清理函数在无 DOM 环境里可能挑剔，这里只关心渲染本身
        }
      }
    },
  }
}

function elementNode(type, props) {
  return {
    nodeType: 1,
    type,
    className: props.className || '',
    style: {},
    scrollTop: 0,
    scrollHeight: 320,
    clientHeight: 200,
    value: typeof props.value === 'string' ? props.value : '',
    props,
    textContent: '',
    focus() {},
    blur() {},
    closest: () => null,
    contains: () => false,
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 180, height: 20, top: 0, left: 0, right: 180, bottom: 20 }),
  }
}

/** 渲染成 { elements, texts }，同时把 props.ref.current 接上假节点 */
function renderTree(node, react, out = { elements: [], texts: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) renderTree(child, react, out)
    return out
  }
  const { type, props, children } = node
  if (typeof type === 'function') {
    react.__enter()
    let rendered
    try {
      rendered = type({ ...props, children })
    } finally {
      react.__exit()
    }
    renderTree(rendered, react, out)
    return out
  }
  const element = elementNode(type, props)
  if (props.ref && typeof props.ref === 'object') props.ref.current = element
  out.elements.push(element)
  renderTree(children, react, out)
  return out
}

function boot(prefs) {
  let captured = null
  const window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
  const created = []
  const sandbox = {
    document: {
      activeElement: null,
      getElementById: () => null,
      createElement: (tag) => {
        const node = elementNode(tag, {})
        created.push(node)
        return node
      },
      head: { appendChild: () => {} },
      body: { appendChild: () => {}, style: { setProperty: () => {} } },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
    },
    localStorage: {
      getItem: (key) => (key === 'dsh-global-cmd:console:v1' && prefs ? JSON.stringify(prefs) : null),
      setItem: () => {},
      removeItem: () => {},
    },
    location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
    navigator: { platform: 'Win32', userAgent: 'node' },
    fetch: async () => ({
      ok: true,
      json: async () => ({ version: 1, actions: [], settings: {}, platform: 'win32', cwd: 'C:\\work', home: 'C:\\Users\\me' }),
    }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  }
  // 浏览器里组件都是通过 window.* 拿这些的，别只塞进函数参数
  Object.assign(window, {
    document: sandbox.document,
    localStorage: sandbox.localStorage,
    fetch: sandbox.fetch,
    location: sandbox.location,
    navigator: sandbox.navigator,
    requestAnimationFrame: sandbox.requestAnimationFrame,
    cancelAnimationFrame: sandbox.cancelAnimationFrame,
    setTimeout: sandbox.setTimeout,
    clearTimeout: sandbox.clearTimeout,
  })
  sandbox.window = window
  const names = Object.keys(sandbox)
  // eslint-disable-next-line no-new-func
  new Function(...names, source)(...names.map((name) => sandbox[name]))

  assert.ok(captured, 'client.js 没有通过 __ModuleLoader__ 注册')
  const react = createReact()
  const plugin = captured.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`意外的 require：${specifier}`)
  })
  const registrations = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : undefined
    },
    slots: {
      inject(name, register) {
        const dispose = register()
        return () => dispose?.()
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }
  return { plugin, ctx, registrations, react, created }
}

const OPEN_PREFS = {
  open: true,
  height: 420,
  activeIndex: 0,
  tabs: [{ shell: 'cmd', cwd: 'C:\\work', running: null }],
}

/**
 * 渲染整棵控制台：bootstrap 是异步的（先拉 /state 与 /env，之后才有标签页），
 * 所以跑一遍 effect、等一轮微任务，再渲染一次拿最终状态。
 */
async function renderConsole(prefs) {
  const { plugin, ctx, registrations, react } = boot(prefs)
  plugin.apply(ctx)

  const overlay = registrations.find((item) => item.spec.name === 'shell.overlay')
  assert.ok(overlay, '没注册 shell.overlay')

  // 第一遍渲染才会把 bootstrap 的 effect 排上队，跑完它再等一轮状态回来
  renderTree(overlay.component({}), react)
  react.__runEffects()
  await new Promise((resolve) => setImmediate(resolve))

  const out = renderTree(overlay.component({}), react)
  react.__runEffects()
  return { out, overlay, react }
}

test('打开控制台时组件树能渲染：提示符是 textarea，输出区挂了滚动容器', async () => {
  const { out } = await renderConsole(OPEN_PREFS)
  const scroller = out.elements.find((item) => item.className === 'gcmd-scroll')
  assert.ok(scroller, '没有渲染输出滚动容器')
  const prompt = out.elements.find((item) => item.className === 'gcmd-input')
  assert.ok(prompt, '没有渲染提示符输入框')
  assert.equal(prompt.type, 'textarea', '提示符应该是可换行的 textarea')
  assert.ok(out.texts.join('').includes('C:\\work'), '提示符没显示当前目录')
})

test('长命令在提示符里自动折行，而不是被横向裁掉', async () => {
  const long = `git commit -m "${'x'.repeat(200)}"`
  const { out, overlay, react } = await renderConsole(OPEN_PREFS)
  const prompt = out.elements.find((item) => item.className === 'gcmd-input')
  assert.equal(prompt.props.wrap, 'soft', 'textarea 必须是软换行，长命令才不会横着被切掉')

  prompt.props.onChange({ target: { value: long } })
  const next = renderTree(overlay.component({}), react)
  const after = next.elements.find((item) => item.className === 'gcmd-input')
  assert.equal(after.value, long, '折行只是显示效果，命令本身不能被改动')
  assert.ok(!after.value.includes('\n'), '自动折行不能往命令里插换行符')

  // 样式兜底：一条没有空格的长路径/URL 也要能断开
  const css = readFileSync(join(here, '..', 'client.js'), 'utf8')
  const block = css.slice(css.indexOf('.gcmd-input {'), css.indexOf('.gcmd-input::-webkit-scrollbar'))
  assert.match(block, /white-space:\s*pre-wrap/)
  assert.match(block, /overflow-wrap:\s*anywhere/)
})

test('长命令折行后，续行回到左边距（提示符只在第一行占位）', async () => {
  const { out } = await renderConsole(OPEN_PREFS)
  const promptRow = out.elements.find((item) => item.className === 'gcmd-prompt')
  assert.ok(promptRow, '没有渲染提示符行')
  const prefix = out.elements.find((item) => item.className === 'gcmd-prompt-prefix')
  assert.ok(prefix, '「路径>」应该单独包一层，才能绝对定位在第一行')
  assert.ok(out.texts.join('').includes('C:\\work>'), '提示符应该还是「路径>」')

  const css = readFileSync(join(here, '..', 'client.js'), 'utf8')
  // 「路径>」脱离文档流，输入框占满整行：第一行用 text-indent 让开它，
  // 折行出来的续行就从 x=0 开始（和真终端一样吃满整行）
  assert.match(css, /\.gcmd-prompt \{[^}]*display:\s*block/)
  assert.match(css, /\.gcmd-prompt-prefix \{[^}]*position:\s*absolute/)
  assert.match(css, /\.gcmd-input \{[^}]*width:\s*100%/)
  assert.ok(!/\.gcmd-prompt-multiline/.test(css), '折行不再靠 flex 顶对齐，这条规则应该删掉')
})


test('在提示符里敲多行：草稿原样保留，并撑出换行提示', async () => {
  const { out, overlay, react } = await renderConsole(OPEN_PREFS)
  const prompt = out.elements.find((item) => item.className === 'gcmd-input')
  assert.equal(prompt.type, 'textarea')

  // 模拟真的敲了两行（Enter 换行走的是浏览器的默认插入，这里直接给 value）
  prompt.props.onChange({ target: { value: 'echo a\necho b' } })

  const next = renderTree(overlay.component({}), react)
  react.__runEffects()

  const hint = next.elements.find((item) => item.className === 'gcmd-input-hint')
  assert.ok(hint, '多行命令时应该出现「Shift+Enter 换行」提示')
  const after = next.elements.find((item) => item.className === 'gcmd-input')
  assert.equal(after.value, 'echo a\necho b', '草稿应该原样回填到 textarea')
})


