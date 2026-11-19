// 命令库浮层 / 编辑器 / 偏好面板的渲染冒烟：这三块最近改得最多（分页、分类标签、
// 平台切换、Linux 命令输入框），用最小的 React 替身渲染一遍，能兜住「函数里引用了
// 不存在的变量」这类只在点开面板时才会炸的错误。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8').replace(/\r\n/g, '\n')

function slice(start, end) {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `找不到片段起点：${start}`)
  const to = source.indexOf(end, from)
  assert.ok(to > from, `找不到片段终点：${end}`)
  return source.slice(from, to)
}

const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(2) })

function texts(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (Array.isArray(node)) node.forEach((child) => texts(child, out))
  else if (node.children) node.children.forEach((child) => texts(child, out))
  return out
}

function countByClass(node, className, hits = []) {
  if (node == null || typeof node !== 'object') return hits
  if (Array.isArray(node)) {
    node.forEach((child) => countByClass(child, className, hits))
    return hits
  }
  if (node.props && String(node.props.className || '').split(/\s+/).includes(className)) hits.push(node)
  if (node.children) node.children.forEach((child) => countByClass(child, className, hits))
  return hits
}

/** 渲染一个组件：hooks 用「读初值即可」的替身，setter 只记录调用 */
function render(componentName, endMarker, props, deps) {
  const src = slice(`function ${componentName}(`, endMarker)
  const names = Object.keys(deps)
  const factory = new Function(...names, `${src}\nreturn ${componentName}`)
  return factory(...names.map((name) => deps[name]))(props)
}

const PRESET_SOURCE = slice('const PRESET_ACTIONS = [', '\n    ]\n') + '\n    ]\n'
const presets = new Function(`${PRESET_SOURCE}\nreturn PRESET_ACTIONS`)()

const PLATFORMS = [
  { value: 'auto', label: '自动' },
  { value: 'windows', label: 'Windows' },
  { value: 'linux', label: 'Linux' },
]

function platformOf(state) {
  const chosen = (state.settings && state.settings.commandPlatform) || 'auto'
  if (chosen === 'windows' || chosen === 'linux') return chosen
  return state.env && state.env.platform === 'linux' ? 'linux' : 'windows'
}

function pickCommand(action, platform) {
  const win = String(action.command || '').trim()
  const linux = String(action.commandLinux || '').trim()
  return platform === 'linux' ? linux || win : win || linux
}

function actions(count) {
  return Array.from({ length: count }, (item, index) => {
    const preset = presets[index % presets.length]
    return { ...preset, id: `id-${index}`, order: index }
  })
}

function paletteDeps(state, calls = []) {
  const store = {
    set: (patch) => calls.push({ kind: 'set', patch }),
    notify: (text) => calls.push({ kind: 'notify', text }),
    get: () => state,
  }
  return {
    calls,
    h,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, (next) => calls.push({ kind: 'state', next })],
    useRef: (initial) => ({ current: initial }),
    useMemo: (fn) => fn(),
    useEffect: () => {},
    store,
    PAGE_SIZE: 8,
    PLATFORMS,
    commandPlatform: platformOf,
    pickCommand,
    applyAction: async () => true,
    toDraft: (action) => action,
    saveActions: async () => calls.push({ kind: 'save' }),
    errorText: (error) => String(error && error.message),
  }
}

function paletteTree(settings, env, total = 3) {
  const state = {
    actions: actions(total),
    settings,
    env: { platform: 'win32', ...env },
    tabs: [{ id: 'tab-1', cwd: 'D:\\', shell: 'cmd', running: false }],
    activeTabId: 'tab-1',
  }
  const deps = paletteDeps(state)
  const tree = render('Palette', 'function Editor(', { state }, deps)
  return { tree, state, deps }
}

test('命令库浮层能渲染：分类标签、平台标签、分页器都在', () => {
  const { tree } = paletteTree({ commandPlatform: 'auto' }, {}, 3)
  const all = texts(tree).join('|')
  assert.ok(all.includes('命令库'), '没渲染标题')
  assert.ok(all.includes('分类') && all.includes('平台'), '缺少标签行')
  assert.ok(all.includes('全部'), '缺少「全部」分类标签')
  assert.ok(all.includes('自动') && all.includes('Windows') && all.includes('Linux'), '缺少平台标签')
  // 推荐命令里的分组应该变成分类标签
  assert.ok(all.includes('诊断'), '分类标签里没有「诊断」')
})

test('每页只渲染 PAGE_SIZE 条，超过一页才出现翻页器', () => {
  const one = paletteTree({}, {}, 3)
  assert.equal(countByClass(one.tree, 'gcmd-item').length, 3, '条目数不对')
  assert.equal(countByClass(one.tree, 'gcmd-pager').length, 0, '只有一页不该出现翻页器')

  const many = paletteTree({}, {}, 20)
  assert.equal(countByClass(many.tree, 'gcmd-item').length, 8, '第一页应该只渲染 8 条')
  assert.equal(countByClass(many.tree, 'gcmd-pager').length, 1, '超过一页应该有翻页器')
  assert.match(texts(many.tree).join('|'), /1 \/ 3/, '页码标签不对')
})

test('条目上显示的是当前平台的命令', () => {
  const target = presets.find((preset) => preset.name === '内存占用 Top15')
  const only = { actions: [{ ...target, id: 'x', order: 0 }], tabs: [], activeTabId: null }

  const win = render(
    'Palette',
    'function Editor(',
    { state: { ...only, settings: { commandPlatform: 'windows' }, env: { platform: 'win32' } } },
    paletteDeps({ ...only, settings: {}, env: { platform: 'win32' } }),
  )
  assert.match(texts(win).join('|'), /Get-Process/, 'Windows 平台应显示 PowerShell 版本')

  const linux = render(
    'Palette',
    'function Editor(',
    { state: { ...only, settings: { commandPlatform: 'linux' }, env: { platform: 'win32' } } },
    paletteDeps({ ...only, settings: { commandPlatform: 'linux' }, env: { platform: 'win32' } }),
  )
  const linuxText = texts(linux).join('|')
  assert.match(linuxText, /ps -eo pid/, 'Linux 平台应显示 Linux 版本')
  assert.ok(!linuxText.includes('Get-Process'), 'Linux 平台不该混进 PowerShell 命令')
})

test('编辑器有 Windows / Linux 两个命令框', () => {
  const tree = render('Editor', 'function Settings(', { draft: { id: '', name: '', command: '', commandLinux: '' } }, {
    h,
    useState: (initial) => [initial, () => {}],
    store: { set: () => {}, notify: () => {} },
    submitDraft: async () => ({}),
    errorText: (error) => String(error),
    SHELLS: [{ value: 'auto', label: '自动' }, { value: 'cmd', label: 'CMD' }],
  })
  const labels = texts(tree).join('|')
  assert.ok(labels.includes('命令（Windows）'), '缺少 Windows 命令框')
  assert.ok(labels.includes('命令（Linux，可不填）'), '缺少 Linux 命令框')
})

test('偏好面板有命令库平台选择', () => {
  const tree = render('Settings', 'function Dock(', { state: { settings: {}, actions: [], env: { platform: 'win32' } } }, {
    h,
    useState: (initial) => [initial, () => {}],
    store: { set: () => {}, notify: () => {} },
    saveActions: async () => {},
    errorText: (error) => String(error),
    SHELLS: [{ value: 'auto', label: '自动' }, { value: 'cmd', label: 'CMD' }],
    PLATFORMS,
  })
  const labels = texts(tree).join('|')
  assert.ok(labels.includes('命令库平台'), '缺少平台选择')
  assert.ok(labels.includes('当前系统'), '缺少当前系统展示')
})
