/**
 * ANSI 着色回归测试。
 *
 * client.js 是浏览器模块（依赖 React、DSH 的 bundle 运行时），没法直接 import，
 * 所以从源码里切出「ANSI 着色」那一段，在 Node 里跑一遍：
 * 颜色有没有解析出来、顺序有没有叠对、光标控制序列有没有被丢掉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
const start = source.indexOf('/* --------------------------- ANSI 着色')
const end = source.indexOf('/* --------------------------- 命令执行')
assert.ok(start >= 0 && end > start, 'client.js 里找不到 ANSI 着色段')

const ansi = new Function(
  `${source.slice(start, end)}
  return { parseAnsi, stripAnsi, ansiSegments, ansiCss }`,
)()

const ESC = '\u001b'

test('没有转义序列时返回 null，调用方走纯文本', () => {
  assert.equal(ansi.ansiSegments('2026-11-18 INFO started'), null)
})

test('16 色、加粗、亮色都能解析出来', () => {
  const segments = ansi.parseAnsi(`${ESC}[32mgreen${ESC}[0m plain ${ESC}[1;91mbright red${ESC}[0m`)
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ['green', ' plain ', 'bright red'],
  )
  assert.deepEqual(segments[0].style, { color: '#0dbc79' })
  assert.equal(segments[1].style, null)
  assert.deepEqual(segments[2].style, { bold: true, color: '#f14c4c' })
})

test('样式会叠加，22 只关掉粗细不影响颜色', () => {
  const segments = ansi.parseAnsi(`${ESC}[1m${ESC}[31mbold red${ESC}[22m still red`)
  assert.deepEqual(segments[0].style, { bold: true, color: '#cd3131' })
  assert.deepEqual(segments[1].style, { color: '#cd3131' })
})

test('256 色与 24 位真彩色', () => {
  const segments = ansi.parseAnsi(`${ESC}[38;5;196mred${ESC}[0m ${ESC}[38;2;255;0;128mhit${ESC}[0m`)
  assert.deepEqual(segments[0].style, { color: 'rgb(255,0,0)' })
  assert.equal(segments[1].text, ' ')
  assert.deepEqual(segments[2].style, { color: 'rgb(255,0,128)' })
})

test('光标移动、清屏、OSC 标题都被丢掉，不留垃圾字符', () => {
  const text = `${ESC}[2K${ESC}[1Gdownloading 12%${ESC}]0;title${ESC}\\ done`
  assert.equal(ansi.stripAnsi(text), 'downloading 12% done')
})

test('反显会交换前景背景', () => {
  const css = ansi.ansiCss({ inverse: true, color: '#111111', background: '#eeeeee' })
  assert.equal(css.color, '#eeeeee')
  assert.equal(css.background, '#111111')
})

test('下划线+删除线合并成一个 text-decoration', () => {
  const css = ansi.ansiCss({ underline: true, strike: true })
  assert.equal(css.textDecoration, 'underline line-through')
})
