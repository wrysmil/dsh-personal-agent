// 在 Node 里跑一遍 Client 半侧的「装载 → 注册槽位 → 渲染收藏按钮」，
// 用来兜住这类只在浏览器里才会炸的错误（比如 ctx 上少方法、组件 props 名字写错）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** 最小 React 替身：只需撑住 hook 调用与 createElement 的树结构 */
function fakeReact() {
  return {
    memo: (component) => component,
    forwardRef: (render) => render,
    Fragment: Symbol('Fragment'),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    useId: () => 'id',
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(),
    }),
  }
}

/** 收集树里的所有文字 */
function texts(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (Array.isArray(node)) node.forEach((child) => texts(child, out))
  else if (node.children) node.children.forEach((child) => texts(child, out))
  return out
}

/** 装一次 client.js：返回插件对象与它注册过的槽位 */
function boot() {
  let captured = null
  const window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
  const sandbox = {
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '', style: {}, classList: { add: () => {}, remove: () => {} } }),
      head: { appendChild: () => {} },
      body: { appendChild: () => {}, style: { setProperty: () => {} } },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
    navigator: { platform: 'Win32', userAgent: 'node' },
    fetch: async () => ({ ok: true, json: async () => ({ version: 1, actions: [], settings: {} }) }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  }
  sandbox.window = window
  const names = Object.keys(sandbox)
  // eslint-disable-next-line no-new-func
  new Function(...names, source)(...names.map((name) => sandbox[name]))

  assert.ok(captured, 'client.js 没有通过 __ModuleLoader__ 注册')
  assert.equal(captured.id, 'dsh-global-cmd')

  const plugin = captured.factory((specifier) => {
    if (specifier === 'react') return fakeReact()
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
  return { plugin, ctx, registrations }
}

test('Client 能装载，并注册控制台与代码块收藏的槽位', () => {
  const { plugin, ctx, registrations } = boot()
  assert.deepEqual(plugin.inject, ['slots'])
  assert.doesNotThrow(() => plugin.apply(ctx), 'apply 抛错了')

  const names = registrations.map((item) => item.spec.name)
  assert.ok(names.includes('sidebar.footer.action'), '缺少控制台入口')
  assert.ok(names.includes('shell.overlay'), '缺少控制台悬浮层')

  const fences = registrations.filter((item) => item.spec.name === 'conversation.chat.markdown.fence')
  assert.ok(fences.length >= 8, `代码块槽位注册太少：${fences.length}`)
  const keys = fences.map((item) => item.spec.key)
  assert.equal(new Set(keys).size, keys.length, '有重复的围栏语言')
  for (const lang of ['bash', 'cmd', 'powershell']) assert.ok(keys.includes(lang), `没挂 ${lang}`)

  const ids = registrations.map((item) => item.spec.id)
  assert.equal(new Set(ids).size, ids.length, '槽位 id 有重复')
})

test('收藏按钮只在代码落定后出现，并且不吞掉原代码块', () => {
  const { plugin, ctx, registrations } = boot()
  plugin.apply(ctx)
  const fence = registrations.find((item) => item.spec.key === 'bash')
  assert.ok(fence, '没找到 bash 的围栏层')

  const codeBlock = { type: 'pre', props: { className: 'code' }, children: ['ls -la'] }

  // 流式输出中：原样渲染 children，不出现按钮
  const streaming = fence.component({ lang: 'bash', code: 'ls -la', streaming: true, children: codeBlock })
  assert.equal(streaming, codeBlock, '流式时应该原样渲染代码块')

  // 落定后：代码块 + 收藏按钮
  const settled = fence.component({ lang: 'bash', code: 'ls -la', streaming: false, children: codeBlock })
  const all = texts(settled).join('|')
  assert.ok(all.includes('ls -la'), '代码块内容丢了')
  assert.ok(all.includes('收藏到 CMD'), '没出现收藏按钮')
})
