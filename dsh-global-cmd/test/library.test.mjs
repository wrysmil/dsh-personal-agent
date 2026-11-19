// 命令库相关的静态检查：推荐命令与「代码块 → 收藏」用的语言映射
// client.js 是浏览器端单文件插件（没有导出），这里直接切出需要的片段求值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// 仓库里是 CRLF，切片用的标记按 \n 写，先统一掉
const source = readFileSync(join(here, '..', 'client.js'), 'utf8').replace(/\r\n/g, '\n')

/** 取 `start` 到 `end` 之间的源码；keepEnd 为真时把结尾标记也带上（数组闭合括号要靠它） */
function slice(start, end, keepEnd = false) {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `找不到片段起点：${start}`)
  const to = source.indexOf(end, from)
  assert.ok(to > from, `找不到片段终点：${end}`)
  return keepEnd ? source.slice(from, to) + end : source.slice(from, to)
}

const presetSource = slice('const PRESET_ACTIONS = [', '\n    ]\n', true)
const presets = new Function(`${presetSource}\nreturn PRESET_ACTIONS`)()

const shellSource = slice('const FENCE_SHELL = {', '/** 把聊天里的代码块收进命令库')
const fenceLangsSource = slice('const FENCE_LANGS = [', '\n    ]\n', true)

test('推荐命令有一批，而且名字不重复', () => {
  assert.ok(presets.length >= 15, `推荐命令太少：${presets.length}`)
  const names = presets.map((item) => item.name)
  assert.equal(new Set(names).size, names.length, '推荐命令里出现了重名')
})

test('每条推荐命令都有名字、分组和非空命令', () => {
  for (const preset of presets) {
    assert.ok(preset.name && preset.name.trim(), '缺名字')
    assert.ok(preset.group && preset.group.trim(), `${preset.name} 缺分组`)
    assert.ok(typeof preset.command === 'string' && preset.command.trim(), `${preset.name} 命令是空的`)
    assert.equal(typeof preset.confirm, 'boolean', `${preset.name} 的 confirm 应该是布尔`)
  }
})

test('推荐命令覆盖诊断 / 容器 / 部署三类', () => {
  const groups = new Set(presets.map((item) => item.group))
  for (const group of ['诊断', '容器', '部署']) assert.ok(groups.has(group), `缺少 ${group} 分组`)
})

test('PowerShell 命令不会被当成模板插值', () => {
  for (const preset of presets) {
    assert.ok(!preset.command.includes('${'), `${preset.name} 里出现了模板插值`)
    if (preset.shell === 'powershell') {
      assert.ok(!preset.command.includes('\\n'), `${preset.name} 应该是单行命令`)
    }
  }
})

test('危险操作（结束进程 / 清理 docker）都要求确认', () => {
  const danger = presets.filter((item) => /taskkill|system prune/.test(item.command))
  assert.ok(danger.length >= 2, '没找到危险命令')
  for (const preset of danger) assert.equal(preset.confirm, true, `${preset.name} 应该要求确认`)
})

test('代码块语言映射到正确的 shell', () => {
  const shellForFence = new Function(`${shellSource}\nreturn shellForFence`)()
  assert.equal(shellForFence('powershell'), 'powershell')
  assert.equal(shellForFence('ps1'), 'powershell')
  assert.equal(shellForFence('pwsh'), 'powershell')
  assert.equal(shellForFence('cmd'), 'cmd')
  assert.equal(shellForFence('bat'), 'cmd')
  assert.equal(shellForFence('bash'), 'auto')
  assert.equal(shellForFence(''), 'auto')
})

test('收藏按钮挂在这些语言上，且没有重复', () => {
  const langs = new Function(`${fenceLangsSource}\nreturn FENCE_LANGS`)()
  assert.ok(langs.length >= 8, `语言太少：${langs.length}`)
  assert.equal(new Set(langs).size, langs.length, '语言列表里有重复')
  for (const lang of ['bash', 'cmd', 'powershell', 'sh']) assert.ok(langs.includes(lang), `缺少 ${lang}`)
  // 没标语言的围栏 entryKey 是空串，注册空 key 没有意义
  assert.ok(!langs.includes(''), '不应该注册空语言')
})

const platformSource = slice('const PLATFORMS = [', '/** 只补库里没有的推荐命令')
const helpers = new Function(
  `${platformSource}\nreturn { PLATFORMS, commandPlatform, pickCommand, pickShell, effectiveAction }`,
)()

test('每条推荐命令都带 Linux 版本，且不是 Windows 写法', () => {
  for (const preset of presets) {
    const linux = String(preset.commandLinux || '').trim()
    assert.ok(linux, `${preset.name} 缺 Linux 版本`)
    assert.ok(!/\$\{/.test(linux), `${preset.name} 的 Linux 版本里出现了模板插值`)
    for (const bad of ['cd /d', 'Get-', 'taskkill', '.exe', '\\\\']) {
      assert.ok(!linux.includes(bad), `${preset.name} 的 Linux 版本里还有 Windows 写法：${bad}`)
    }
  }
})

test('危险操作的 Linux 版本同样要求确认', () => {
  const danger = presets.filter((item) => /kill -9|system prune/.test(String(item.commandLinux || '')))
  assert.ok(danger.length >= 2, '没找到 Linux 危险命令')
  for (const preset of danger) assert.equal(preset.confirm, true, `${preset.name} 应该要求确认`)
})

test('平台切换会挑对命令和 shell', () => {
  const { pickCommand, pickShell } = helpers
  const both = { command: 'win-cmd', commandLinux: 'linux-cmd' }
  assert.equal(pickCommand(both, 'windows'), 'win-cmd')
  assert.equal(pickCommand(both, 'linux'), 'linux-cmd')
  // 缺一个平台时退回另一个平台，别让条目变成空命令
  assert.equal(pickCommand({ command: 'only-win' }, 'linux'), 'only-win')
  assert.equal(pickCommand({ commandLinux: 'only-linux' }, 'windows'), 'only-linux')
  assert.equal(pickCommand({}, 'linux'), '')

  assert.equal(pickShell({ shell: 'powershell' }, 'linux'), 'bash')
  assert.equal(pickShell({ shell: 'pwsh' }, 'linux'), 'bash')
  assert.equal(pickShell({ shell: 'cmd' }, 'linux'), 'bash')
  assert.equal(pickShell({ shell: 'bash' }, 'linux'), 'bash')
  assert.equal(pickShell({ shell: 'powershell' }, 'windows'), 'powershell')
  assert.equal(pickShell({}, 'windows'), 'auto')
})

test('平台上按偏好走，没选就跟随系统', () => {
  const { commandPlatform, effectiveAction, PLATFORMS } = helpers
  assert.equal(commandPlatform({ settings: {}, env: { platform: 'linux' } }), 'linux')
  assert.equal(commandPlatform({ settings: {}, env: { platform: 'win32' } }), 'windows')
  assert.equal(commandPlatform(null), 'windows')
  assert.equal(
    commandPlatform({ settings: { commandPlatform: 'linux' }, env: { platform: 'win32' } }),
    'linux',
  )
  assert.deepEqual(
    PLATFORMS.map((item) => item.value),
    ['auto', 'windows', 'linux'],
  )
  const resolved = effectiveAction(
    { command: 'win-cmd', commandLinux: 'linux-cmd', shell: 'cmd', name: 'x' },
    { settings: {}, env: { platform: 'linux' } },
  )
  assert.equal(resolved.command, 'linux-cmd')
  assert.equal(resolved.shell, 'bash')
  assert.equal(resolved.name, 'x', '其他字段要原样带着')
})
