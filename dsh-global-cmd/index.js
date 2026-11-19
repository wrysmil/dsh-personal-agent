/**
 * dsh-global-cmd —— Host 半侧
 *
 * 提供一组仅本机可用的 HTTP 路由，供 Web/Desktop 客户端（client.js）读取、
 * 保存自定义 Action（命令按钮），并执行本机 shell 命令。
 *
 * 路由前缀：/dsh-global-cmd/api
 *   GET    /state           读取 { settings, actions }
 *   PUT    /state           保存 { settings, actions }
 *   GET    /env             读取环境信息
 *   POST   /exec            启动一个命令，返回 { id }
 *   GET    /exec/<id>       读取命令输出（增量），?after=<chunk 序号>
 *   GET    /exec/<id>/log    下载完整日志（?stream=out|err），不受界面缓冲区限制
 *   POST   /exec/<id>/kill  终止命令
 *
 * 数据文件默认 <DSH_HOME>/global-cmd/actions.json（config.dataFile 可覆盖）。
 */
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname as osHostname, release as osRelease } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-global-cmd'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-global-cmd/api'
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** 输出不按字节数截断；这里只是内存里的行缓冲上限，而且只回收客户端已经读走的行。 */
const MAX_CHUNKS = 200000
/**
 * 一次轮询最多从日志文件里搬多少字节、最多回多少个 chunk。
 * 以前每轮都是 readFileSync 整个文件：命令狂刷日志时，光读文件就能把 Host 的
 * 事件循环占满，界面跟着一起卡。现在只读「上次之后新增的那一段」，
 * 一次搬不完就让客户端拿着 more 立刻再要一批，输出是渐进出现的，不会一顿一顿。
 */
const MAX_READ_BYTES = 1024 * 1024
const MAX_CHUNKS_PER_POLL = 4000
/** 一行超长（没有换行）输出时最多憋这么多字符，否则先当一整行吐出去，免得吃掉内存。 */
const MAX_PENDING_CHARS = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 0
const MAX_TIMEOUT_MS = 30 * 60 * 1000
/** 任务日志保留个数：每个任务把 stdout/stderr 直接写进文件，插件重载/Tab 刷新后还能接着读。 */
const JOBS_KEEP = 20
/** 数据文件版本；升到 2 时把旧默认的 120 秒超时重置为「不限制」。 */
const SETTINGS_VERSION = 2
const SHELLS = new Set(['auto', 'cmd', 'powershell', 'pwsh', 'bash', 'sh'])

function jsonBody(res, status, value) {
  const text = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 解析「DSH home」：优先 DSH_HOME；否则若家目录下有 .dsh 就用它；再退回家目录。
 * 打包后的 DSH 进程通常不注入 DSH_HOME，所以不能只靠环境变量。
 */
function resolveHome() {
  const fromEnv = (process.env.DSH_HOME || '').trim()
  if (fromEnv) return fromEnv
  const home = homedir()
  const candidate = join(home, '.dsh')
  try {
    if (existsSync(candidate)) return candidate
  } catch {
    /* 忽略 */
  }
  return home
}

function expandPath(input, home) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''
  let out = raw
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = join(home, out.slice(1).replace(/^[/\\]/, ''))
  }
  out = out.replace(/\$\{?DSH_HOME\}?/gi, process.env.DSH_HOME ?? home)
  out = out.replace(/%DSH_HOME%/gi, process.env.DSH_HOME ?? home)
  out = out.replace(/\$\{?USERPROFILE\}?/gi, process.env.USERPROFILE ?? home)
  out = out.replace(/\$\{?HOME\}?/gi, process.env.HOME ?? home)
  if (!isAbsolute(out)) out = resolve(home, out)
  return out
}

/**
 * 把一个「cd 目标」解析成绝对路径，并报告它存在与否。
 * 控制台里输入 `cd ..`、`cd ~`、`cd D:\foo` 都由它来落地。
 */
function resolveCwd(input, base, userHome) {
  const home = userHome || homedir()
  const cleaned = typeof input === 'string' ? input.trim() : ''
  // 只剥掉「成对包住整条路径」的引号，不能把路径里的单引号也删掉
  const raw = cleaned.replace(/^(['"])([\s\S]*)\1$/, '$2')
  let target
  if (!raw || raw === '.') {
    target = base
  } else if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    target = join(home, raw.slice(1).replace(/^[/\\]/, ''))
  } else if (/^[a-zA-Z]:$/.test(raw)) {
    target = raw + '\\'
  } else if (isAbsolute(raw)) {
    target = raw
  } else {
    target = resolve(base, raw)
  }
  let exists = false
  let isDirectory = false
  try {
    const stat = statSync(target)
    exists = true
    isDirectory = stat.isDirectory()
  } catch {
    /* 不存在就是不存在，交给调用方报错 */
  }
  return { path: target, exists, isDirectory }
}

/**
 * 早期版本会自动种三条示例命令（查看当前目录 / Git 状态 / Node 版本）。
 * 用户明确表示不要这些「案例」：只要还保持原样（名称、命令、分组都没改过），读取时直接丢掉。
 */
const LEGACY_SEEDS = [
  { name: '查看当前目录', command: 'cd', group: '示例' },
  { name: 'Git 状态', command: 'git status --short', group: '示例' },
  { name: 'Node 版本', command: 'node --version', group: '示例' },
]

function isLegacySeed(raw) {
  if (!raw || typeof raw !== 'object') return false
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  const group = typeof raw.group === 'string' ? raw.group.trim() : ''
  return LEGACY_SEEDS.some((seed) => seed.name === name && seed.command === command && (group === seed.group || group === ''))
}

function normalizeAction(raw, index, home) {
  if (!raw || typeof raw !== 'object') return null
  const command = typeof raw.command === 'string' ? raw.command : ''
  // Linux 版本可以单独存在：只写了 Linux 命令的条目也是合法条目
  const commandLinux = typeof raw.commandLinux === 'string' ? raw.commandLinux : ''
  if (!command.trim() && !commandLinux.trim()) return null
  const shell = SHELLS.has(raw.shell) ? raw.shell : 'auto'
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : `命令 ${index + 1}`
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID(),
    name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : '',
    group: typeof raw.group === 'string' && raw.group.trim() ? raw.group.trim().slice(0, 40) : '自定义',
    shell,
    cwd: typeof raw.cwd === 'string' ? raw.cwd.trim().slice(0, 400) : '',
    command: command.slice(0, 8000),
    commandLinux: commandLinux.slice(0, 8000),
    order: Number.isFinite(raw.order) ? Number(raw.order) : index,
    confirm: raw.confirm === true,
  }
}

function normalizeState(raw) {
  const home = resolveHome()
  const src = raw && typeof raw === 'object' ? raw : {}
  const settingsSrc = src.settings && typeof src.settings === 'object' ? src.settings : {}
  const actionsSrc = Array.isArray(src.actions) ? src.actions.filter((item) => !isLegacySeed(item)) : []
  const actions = actionsSrc
    .map((item, index) => normalizeAction(item, index, home))
    .filter(Boolean)
  const timeout = Number(settingsSrc.timeoutMs)
  // 旧版本的默认超时是 120 秒，会把长构建、常驻服务当成卡死；升级到 v2 时把它当成「没设置过」。
  const legacyDefault = Number(src.version) !== SETTINGS_VERSION && timeout === 120000
  return {
    version: SETTINGS_VERSION,
    settings: {
      defaultShell: SHELLS.has(settingsSrc.defaultShell) ? settingsSrc.defaultShell : 'auto',
      defaultCwd: typeof settingsSrc.defaultCwd === 'string' ? settingsSrc.defaultCwd.trim().slice(0, 400) : '',
      timeoutMs: legacyDefault
        ? DEFAULT_TIMEOUT_MS
        : Number.isFinite(timeout) && timeout > 0
          ? Math.min(timeout, MAX_TIMEOUT_MS)
          : DEFAULT_TIMEOUT_MS,
      closeAfterRun: settingsSrc.closeAfterRun === true,
      // 命令库按哪个平台取命令：auto 跟随运行 DSH 的系统
      commandPlatform: ['auto', 'windows', 'linux'].includes(settingsSrc.commandPlatform)
        ? settingsSrc.commandPlatform
        : 'auto',
    },
    actions,
  }
}

/** 把 Windows 路径改写成 msys/git-bash 认得的 /c/... 形式 */
function toPosixPath(target) {
  const normalized = String(target).replace(/\\/g, '/')
  const match = /^([A-Za-z]):(.*)$/.exec(normalized)
  return match ? '/' + match[1].toLowerCase() + match[2] : normalized
}

/**
 * 子进程环境：把颜色打开。
 * 输出是重定向进日志文件的（没有 TTY），各种工具默认会判定「不是终端」而关掉颜色，
 * 于是控制台里就只剩下一片黑白的 INFO/WARN。这里显式要求它们照样上色。
 */
function commandEnv() {
  const env = {
    ...process.env,
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: process.env.FORCE_COLOR || '1',
    CLICOLOR_FORCE: '1',
    // Spring Boot 的 spring.output.ansi.enabled 默认是 detect：重定向时检测不到控制台，日志就没颜色了
    SPRING_OUTPUT_ANSI_ENABLED: 'always',
  }
  if (!env.MAVEN_OPTS || !env.MAVEN_OPTS.includes('style.color')) {
    env.MAVEN_OPTS = `${env.MAVEN_OPTS ? env.MAVEN_OPTS + ' ' : ''}-Dstyle.color=always`
  }
  return env
}

/**
 * 多行 cmd 命令落成一个批处理脚本。
 * 为什么不在 /c 后面直接塞带换行的命令：cmd.exe 解析 /c 参数时遇到换行就截断，
 * 第二行往后会被静默丢掉（实测 `cmd /c "echo a\r\necho b"` 只打印 a）。
 * 落成 .cmd 之后，每一行都由 cmd 按脚本自己解析，%VAR% 展开、set、if 这些都正常。
 */
function buildBatchScript(command) {
  const body = String(command).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // @echo off：脚本自己的命令行不要混进输出里，控制台只该看到命令真正打印的内容
  return '@echo off\r\n' + body + '\r\n'
}

/** 把用户命令包装成各 shell 可直接执行的 spawn 参数（capture 时由 shell 自己重定向输出） */
function buildSpawnSpec(shellInput, command, cwd, redirect) {
  const platform = process.platform
  const isWindows = platform === 'win32'
  const outPath = redirect && typeof redirect.outPath === 'string' ? redirect.outPath : ''
  const errPath = redirect && typeof redirect.errPath === 'string' ? redirect.errPath : ''
  const scriptPath = redirect && typeof redirect.scriptPath === 'string' ? redirect.scriptPath : ''
  const capture = outPath !== '' && errPath !== ''
  let shell = shellInput
  if (shell === 'auto' || !shell) {
    shell = isWindows ? (process.env.ComSpec?.toLowerCase().includes('powershell') ? 'powershell' : 'cmd') : 'sh'
  }
  if (isWindows) {
    if (shell === 'cmd') {
      const comspec = process.env.ComSpec || 'cmd.exe'
      // windowsVerbatimArguments 保留内层引号；chcp 65001 让中文输出走 UTF-8。
      // 1> / 2> 交给 cmd 自己打开文件：句柄归子进程所有，插件被回收也不影响它继续写。
      let body = command
      if (/[\r\n]/.test(command)) {
        if (!scriptPath) throw new Error('多行命令需要脚本路径')
        writeFileSync(scriptPath, buildBatchScript(command), 'utf8')
        // call：块里直接跑 .cmd 会夺走父上下文，call 才能把控制权还回来，退出码也照传
        body = `call "${scriptPath}"`
      }
      const inner = capture
        ? `chcp 65001>nul & ( ${body} ) 1> "${outPath}" 2> "${errPath}"`
        : `chcp 65001>nul & ${body}`
      return {
        file: comspec,
        args: ['/d', '/s', '/c', `"${inner}"`],
        options: { windowsVerbatimArguments: true },
        label: 'cmd',
      }
    }
    if (shell === 'powershell' || shell === 'pwsh') {
      const file = shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe'
      // 顺手关掉进度条：重定向时 PowerShell 会把 progress 流序列化成 CLIXML 糊进 stderr
      const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;\n$ProgressPreference='SilentlyContinue';\n${command}`
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
      if (!capture) {
        return { file, args: psArgs, options: {}, label: shell }
      }
      // 借 cmd 的重定向把 PS 的输出落到文件；-EncodedCommand 的 base64 里没有 cmd 元字符
      const comspec = process.env.ComSpec || 'cmd.exe'
      const inner = `chcp 65001>nul & ( ${file} ${psArgs.join(' ')} ) 1> "${outPath}" 2> "${errPath}"`
      return {
        file: comspec,
        args: ['/d', '/s', '/c', `"${inner}"`],
        options: { windowsVerbatimArguments: true },
        label: shell,
      }
    }
    if (shell === 'bash' || shell === 'sh') {
      const file = shell === 'bash' ? 'bash.exe' : 'sh.exe'
      const script = capture
        ? `{ ${command}\n} 1> '${toPosixPath(outPath)}' 2> '${toPosixPath(errPath)}'`
        : command
      return { file, args: ['-lc', script], options: {}, label: shell }
    }
  }
  const file = shell === 'bash' ? 'bash' : '/bin/sh'
  const script = capture ? `{ ${command}\n} 1> '${outPath}' 2> '${errPath}'` : command
  const args = shell === 'bash' ? ['-lc', script] : ['-c', script]
  return { file, args, options: {}, label: shell }
}

/** PowerShell 的 stderr 会被 CLIXML 序列化，这里还原成纯文本 */
function cleanPowerShellError(text) {
  if (!text.includes('#< CLIXML') && !text.includes('<Objs ')) return text
  // 进度条（Write-Progress / 模块首次加载）在重定向时会变成 CLIXML 的 progress 记录，
  // 不是错误，直接丢掉；之前没处理，整段 XML 就被当成报错糊在输出后面
  const withoutProgress = text
    .replace(/<Obj S="progress"[\s\S]*?<\/Obj>/g, '')
    .replace(/<Objs [^>]*>\s*<\/Objs>/g, '')
  const out = []
  const re = /<S S="Error">([\s\S]*?)<\/S>/g
  let match
  while ((match = re.exec(withoutProgress)) !== null) {
    out.push(
      match[1]
        .replace(/_x000D__x000A_/g, '\n')
        .replace(/_x000D_/g, '\r')
        .replace(/_x000A_/g, '\n')
        .replace(/_x0009_/g, '\t')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim(),
    )
  }
  const cleaned = out.filter(Boolean).join('\n').trim()
  if (cleaned) return cleaned
  // 只剩壳层标记（`#< CLIXML` 之类）或整段都是进度记录时，还原不出任何真实报错
  const leftover = withoutProgress.replace(/#< CLIXML/g, '').trim()
  return leftover.includes('<Objs') ? '' : leftover
}

function isAlivePid(pid) {
  const value = Number(pid)
  if (!Number.isFinite(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    // Windows 上无权限访问时抛 EPERM，说明进程还在
    return Boolean(error) && error.code === 'EPERM'
  }
}

/**
 * 杀掉整棵进程树，并等 pid 真的消失（最多 ~3s）再返回。
 * 之前是「发完 taskkill 就不管了」，Windows 上偶发「壳层先死、孙进程活下来」，
 * 生成再也认不回来的孤儿进程（典型症状：下次启动 mvn / spring-boot 撞端口）。
 */
function killTree(pid) {
  const root = Number(pid)
  if (!Number.isFinite(root) || root <= 0) return Promise.resolve(false)
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(root), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-root, 'SIGKILL')
    }
  } catch {
    // 进程可能已退出
  }
  return new Promise((resolve) => {
    const deadline = Date.now() + 3000
    const tick = () => {
      if (!isAlivePid(root)) {
        resolve(true)
        return
      }
      if (Date.now() > deadline) {
        resolve(false)
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/** 跑一条系统命令、收回 stdout；超时或起不来都当成失败，绝不抛错。 */
function runCapture(file, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (error) {
      resolve({ ok: false, stdout: '', error })
      return
    }
    let stdout = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
      finish({ ok: false, stdout, timedOut: true })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', (error) => finish({ ok: false, stdout, error }))
    child.on('close', (code) => finish({ ok: code === 0, stdout }))
  })
}

/**
 * 列出本机所有进程：[{ pid, ppid, name, createdAt }]。
 * Windows 走 PowerShell 的 Win32_Process（wmic 在新系统上已被移除）；
 * 其它平台走 ps -o etimes，用「已运行秒数」倒推创建时间。
 */
async function readProcessTable() {
  const isWindows = process.platform === 'win32'
  if (isWindows) {
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { $c = ''; if ($_.CreationDate) { $c = $_.CreationDate.ToString('o') }; " +
      "$_.ProcessId.ToString() + '|' + $_.ParentProcessId.ToString() + '|' + $_.Name + '|' + $c }"
    const attempts = [
      ['powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]],
      ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', script]],
    ]
    for (const [file, args] of attempts) {
      const { ok, stdout } = await runCapture(file, args, 8000)
      if (!ok || !stdout) continue
      const list = []
      for (const line of stdout.split(/\r?\n/)) {
        const [pid, ppid, name, created] = line.trim().split('|')
        if (!pid || !ppid) continue
        const pidNum = Number(pid)
        const ppidNum = Number(ppid)
        if (!Number.isFinite(pidNum) || pidNum <= 0) continue
        list.push({
          pid: pidNum,
          ppid: Number.isFinite(ppidNum) ? ppidNum : 0,
          name: (name || '').trim(),
          // .ToString('o') 是 100ns 精度，JS 只认到毫秒
          createdAt: created ? Date.parse(created.replace(/(\.\d{3})\d+/, '$1')) : 0,
        })
      }
      if (list.length) return list
    }
    return []
  }
  const { ok, stdout } = await runCapture('ps', ['-A', '-o', 'pid=,ppid=,comm=,etimes='], 6000)
  if (!ok || !stdout) return []
  const now = Date.now()
  const list = []
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    const pid = Number(cols[0])
    const ppid = Number(cols[1])
    const elapsed = Number(cols[3])
    if (!Number.isFinite(pid) || pid <= 0) continue
    list.push({
      pid,
      ppid: Number.isFinite(ppid) ? ppid : 0,
      name: cols[2] || '',
      createdAt: Number.isFinite(elapsed) ? now - elapsed * 1000 : 0,
    })
  }
  return list
}

/** 进程表缓存：一次清理会连续用到它，别为每个任务都起一次 PowerShell。 */
let processTableCache = { at: 0, list: [] }
async function listProcesses(maxAgeMs = 4000) {
  if (Date.now() - processTableCache.at < maxAgeMs) return processTableCache.list
  let list = []
  try {
    list = await readProcessTable()
  } catch {
    list = []
  }
  processTableCache = { at: Date.now(), list }
  return list
}

/**
 * 清掉「任务的 shell 壳层已经死了、但它的子进程还在跑」的残渣。
 *
 * 为什么需要：Windows 没有进程组隔离，插件只能看见自己 spawn 出来的那一层
 * （cmd.exe）。壳层一旦被单独杀掉（DSH 退出、taskkill 竞态、手动结束窗口），
 * mvn / spring-boot / vite 这些真正的服务进程就会活下来继续占端口，
 * 而 ParentProcessId 还指着已经消失的壳 —— 只能靠它把整棵后代找回来。
 *
 * 安全约束：
 *  - 只处理「记录在案的任务 + 它的壳已死」的后代，不碰无关进程；
 *  - 比任务本身还早启动的进程不可能是它的子进程（PID 复用保护）；
 *  - 永远不杀自己（以及自己的父进程）。
 */
async function reapOrphanTrees(roots) {
  const dead = roots.filter((root) => root && Number(root.pid) > 0 && !isAlivePid(Number(root.pid)))
  if (!dead.length) return []
  const procs = await listProcesses()
  if (!procs.length) return []
  const children = new Map()
  for (const proc of procs) {
    const list = children.get(proc.ppid)
    if (list) list.push(proc)
    else children.set(proc.ppid, [proc])
  }
  const targets = new Map()
  for (const root of dead) {
    const startedAt = Number(root.startedAt) || 0
    const stack = [...(children.get(Number(root.pid)) || [])]
    const seen = new Set()
    while (stack.length) {
      const proc = stack.pop()
      if (!proc || seen.has(proc.pid)) continue
      seen.add(proc.pid)
      if (proc.pid === process.pid || proc.pid === process.ppid) continue
      if (startedAt && proc.createdAt && proc.createdAt < startedAt - 2000) continue
      targets.set(proc.pid, proc)
      for (const child of children.get(proc.pid) || []) stack.push(child)
    }
  }
  await Promise.all([...targets.keys()].map((pid) => killTree(pid)))
  return [...targets.values()]
}

/** 问系统：端口被谁监听着（只用于把失败原因说清楚）。 */
async function portOwner(port) {
  const { ok, stdout } = await runCapture('netstat', ['-ano', '-p', 'tcp'], 3000)
  if (!ok || !stdout) return null
  const suffix = `:${port}`
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    if (!(cols[1] || '').endsWith(suffix)) continue
    const pid = Number(cols[cols.length - 1])
    if (!Number.isFinite(pid) || pid <= 0) continue
    let name = ''
    try {
      const listed = await runCapture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 2500)
      name = (listed.stdout.split(',')[0] || '').replace(/"/g, '').trim()
    } catch {
      /* 名字拿不到不影响结论 */
    }
    return { pid, name }
  }
  return null
}

export function apply(ctx, config = {}) {
  const home = resolveHome()
  const dataFile = expandPath(config.dataFile, home) || join(home, 'global-cmd', 'actions.json')
  const extraHosts = Array.isArray(config.trustedHosts) ? config.trustedHosts.filter(Boolean) : []
  const trustedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', ...extraHosts])
  const maxTimeoutMs = Number.isFinite(config.maxTimeoutMs) && config.maxTimeoutMs > 0
    ? Math.min(config.maxTimeoutMs, MAX_TIMEOUT_MS)
    : MAX_TIMEOUT_MS

  /** @type {Map<string, any>} */
  const jobs = new Map()
  // 任务日志放在数据文件旁边，插件重载后靠它接上还在跑的命令
  const jobsDir = join(dirname(dataFile), 'jobs')
  const registryFile = join(jobsDir, 'registry.json')

  function readState() {
    let stored
    try {
      stored = JSON.parse(readFileSync(dataFile, 'utf8'))
    } catch {
      return normalizeState({})
    }
    const state = normalizeState(stored)
    // 版本号落后就顺手落盘一次，让「120 秒默认超时」这类旧值只迁移一次。
    if (stored !== null && typeof stored === 'object' && Number(stored.version) !== SETTINGS_VERSION) {
      try {
        writeState(state)
      } catch {
        // 只读目录里迁移失败也无所谓：内存中的语义已经是新的。
      }
    }
    return state
  }

  function writeState(state) {
    const next = normalizeState(state)
    mkdirSync(dirname(dataFile), { recursive: true })
    const tmp = `${dataFile}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, dataFile)
    return next
  }

  /* -------------------- 任务：子进程直接写日志文件 -------------------- */
  // 关键点：stdout/stderr 不接管道，而是把文件句柄交给子进程自己写。
  // 这样插件被重载（bundle 关→开）时，旧模块里没有任何管道需要 GC，
  // 子进程照旧往文件里写，新模块重新读文件就能接上 —— 命令不会被「更新」杀掉。

  const isAlive = isAlivePid

  function readRegistry() {
    try {
      const raw = JSON.parse(readFileSync(registryFile, 'utf8'))
      if (!raw || !Array.isArray(raw.jobs)) return []
      return raw.jobs.filter((item) => item && typeof item.id === 'string')
    } catch {
      return []
    }
  }

  function persistRegistry() {
    const byId = new Map()
    for (const entry of readRegistry()) byId.set(entry.id, entry)
    for (const job of jobs.values()) {
      const record = {
        id: job.id,
        command: job.command,
        shell: job.shell,
        cwd: job.cwd,
        pid: job.pid,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        exitCode: job.exitCode,
        timedOut: job.timedOut,
        killed: job.killed,
        outPath: job.outPath,
        errPath: job.errPath,
      }
      const prev = byId.get(record.id)
      // 旧实例（重载前那个模块）可能已经记下真实退出码，别用 null 盖掉它
      if (record.exitCode === null && prev && prev.exitCode !== null && prev.exitCode !== undefined) {
        record.exitCode = prev.exitCode
        record.endedAt = record.endedAt || prev.endedAt || 0
      }
      byId.set(record.id, record)
    }
    // 还在跑的任务永远不参与淘汰：它是唯一能停掉那个进程的线索，
    // 一旦被挤出登记表，进程就成了谁也认不回来的孤儿（典型后果：端口一直被占）。
    const all = [...byId.values()].sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0))
    const running = all.filter((record) => record.exitCode === null || record.exitCode === undefined)
    const finished = all.filter((record) => !(record.exitCode === null || record.exitCode === undefined))
    const keep = [...running, ...finished.slice(-Math.max(0, JOBS_KEEP - running.length))].sort(
      (a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0),
    )
    try {
      mkdirSync(jobsDir, { recursive: true })
      const tmp = registryFile + '.tmp-' + process.pid
      writeFileSync(tmp, JSON.stringify({ version: 1, jobs: keep }, null, 2) + '\n', 'utf8')
      renameSync(tmp, registryFile)
    } catch {
      // 数据目录不可写就算了：只影响「重载后能不能接上」
    }
  }

  function makeJob(seed) {
    return {
      id: seed.id,
      command: seed.command,
      shell: seed.shell,
      cwd: seed.cwd,
      pid: seed.pid,
      startedAt: seed.startedAt,
      endedAt: seed.endedAt || 0,
      exitCode: seed.exitCode === undefined ? null : seed.exitCode,
      timedOut: seed.timedOut === true,
      killed: seed.killed === true,
      done: seed.done === true,
      recovered: seed.recovered === true,
      outPath: seed.outPath || '',
      errPath: seed.errPath || '',
      scriptPath: seed.scriptPath || '',
      offsets: { out: 0, err: 0 },
      // 半行缓冲 + 各自的 UTF-8 解码器：一次只读新追加的字节，可能正好切在多字节字符中间
      pending: { out: '', err: '' },
      decoders: { out: null, err: null },
      chunks: [],
      dropped: 0,
      served: 0,
    }
  }

  function appendChunk(job, stream, text) {
    if (text === '') return
    job.chunks.push({ s: stream, d: text })
    trimChunks(job)
  }

  /**
   * 只回收「客户端已经读走」的旧行：不按字节数截断输出，也不会丢掉还没送到界面的内容。
   * job.served 是已发给客户端的绝对游标（dropped + chunks.length 的历史最大值）。
   */
  function trimChunks(job) {
    const overflow = job.chunks.length - MAX_CHUNKS
    if (overflow <= 0) return
    const consumed = Math.max(0, (job.served || 0) - (job.dropped || 0))
    const drop = Math.min(overflow, consumed)
    if (drop <= 0) return
    job.chunks.splice(0, drop)
    job.dropped = (job.dropped || 0) + drop
  }

  /** 从 from 起读一段字节（最多 max 个），用于增量搬运日志 */
  function readRange(file, from, max) {
    const fd = openSync(file, 'r')
    try {
      const size = statSync(file).size
      if (size <= from) return Buffer.alloc(0)
      const take = Math.max(1, Math.min(size - from, max))
      const buffer = Buffer.allocUnsafe(take)
      let read = 0
      while (read < take) {
        const got = readSync(fd, buffer, read, take - read, from + read)
        if (got <= 0) break
        read += got
      }
      return read === take ? buffer : buffer.subarray(0, read)
    } finally {
      try {
        closeSync(fd)
      } catch {
        // 关不掉就算了，下一轮还会重新打开
      }
    }
  }

  /** 还没搬进内存的日志字节数：搬运分片进行，靠它判断「真的读完了」 */
  function remainingBytes(job) {
    let total = 0
    for (const stream of ['out', 'err']) {
      const file = stream === 'out' ? job.outPath : job.errPath
      if (!file) continue
      try {
        total += Math.max(0, statSync(file).size - (job.offsets[stream] || 0))
      } catch {
        // 文件还没建出来 / 被删了，当作没有新增
      }
    }
    return total
  }

  /**
   * 把日志文件里新增的完整行搬进 chunks。
   *
   * 只读「上次 offset 之后新增的那一段」，而不是每轮 readFileSync 整个文件：
   * 一条狂刷日志的命令（几 MB 起步）以前每 80ms 就被整个读一遍，Host 的事件循环
   * 全耗在这上面，界面跟着卡。现在一轮最多搬 MAX_READ_BYTES，
   * 半行留在 pending 里等下一轮，多字节字符交给 StringDecoder 拼，不会切出乱码。
   */
  function drainJob(job, flush) {
    if (!job.offsets) job.offsets = { out: 0, err: 0 }
    if (!job.pending) job.pending = { out: '', err: '' }
    if (!job.decoders) job.decoders = { out: null, err: null }
    for (const stream of ['out', 'err']) {
      const file = stream === 'out' ? job.outPath : job.errPath
      if (!file) continue
      let size
      try {
        size = statSync(file).size
      } catch {
        continue
      }
      let from = job.offsets[stream] || 0
      if (size < from) {
        // 文件被截断/重建（例如同名任务被清理后重建）：游标作废，从头再读
        from = 0
        job.offsets[stream] = 0
        job.pending[stream] = ''
        job.decoders[stream] = null
      }
      const available = size - from
      if (available <= 0) continue
      let bytes
      try {
        bytes = readRange(file, from, Math.min(available, MAX_READ_BYTES))
      } catch {
        continue
      }
      if (!bytes.length) continue
      job.offsets[stream] = from + bytes.length
      const decoder = job.decoders[stream] || (job.decoders[stream] = new StringDecoder('utf8'))
      const finished = from + bytes.length >= size
      let text = (job.pending[stream] || '') + decoder.write(bytes)
      if (flush && finished) text += decoder.end()
      // 只吐出完整的行；最后那半行留在 pending 里，收尾时（flush）才当作一整行
      let cut = text.lastIndexOf('\n') + 1
      if (flush && finished) cut = text.length
      const ready = cut > 0 ? text.slice(0, cut) : ''
      job.pending[stream] = text.slice(cut)
      if (ready !== '') {
        const clean = stream === 'err' && (job.shell === 'powershell' || job.shell === 'pwsh')
          ? cleanPowerShellError(ready)
          : ready
        for (const line of clean.split('\n')) {
          if (line === '') continue
          appendChunk(job, stream, line + '\n')
        }
      }
      // 单行输出超过上限（比如把整个文件写进一行）：先当成一整行吐出去，别一直憋着吃内存
      const waiting = job.pending[stream] || ''
      if (waiting.length > MAX_PENDING_CHARS) {
        job.pending[stream] = ''
        const cutLine = waiting.replace(/\s+$/, '')
        if (cutLine !== '') appendChunk(job, stream, cutLine + '\n')
      }
    }
  }

  /**
   * 命令因为端口被占而失败时，顺手把「谁占着」写进输出。
   * 只读日志 + 一次 netstat，绝不自动去杀别人的进程（那可能是用户正开着的另一个服务）。
   */
  async function announcePortConflict(job) {
    let text = ''
    try {
      const out = readFileSync(job.outPath)
      text = out.subarray(Math.max(0, out.length - 64 * 1024)).toString('utf8')
      const err = readFileSync(job.errPath)
      text += err.subarray(Math.max(0, err.length - 16 * 1024)).toString('utf8')
    } catch {
      return
    }
    const match = /(?:Port\s+(\d{2,5})\s+(?:is\s+)?already\s+in\s+use|EADDRINUSE[^\d]{0,40}(\d{2,5})|端口\s*(\d{2,5})\s*(?:已|被))/i.exec(text)
    if (!match) return
    const port = Number(match[1] || match[2] || match[3])
    if (!port) return
    const owner = await portOwner(port)
    if (owner) {
      appendChunk(
        job,
        'meta',
        `[端口 ${port} 正被 PID ${owner.pid}${owner.name ? '（' + owner.name + '）' : ''} 占用 · 先 taskkill /PID ${owner.pid} /T /F，或换个端口再启动]\n`,
      )
    } else {
      appendChunk(job, 'meta', `[端口 ${port} 已被占用 · 先结束占用它的进程，或换个端口再启动]\n`)
    }
  }

  /**
   * 命令在 PowerShell 里被 cmd 语法噎住时给一句人话提示。
   * 典型场景：终端切到了 PowerShell，结果执行了 `set "A=B" && cd /d ... && mvn ...`。
   * PowerShell 5.1 不支持 &&、不支持 set "A=B"，所以整行直接解析失败。
   */
  async function announceShellHint(job) {
    let text = ''
    try {
      const err = readFileSync(job.errPath)
      text = err.subarray(Math.max(0, err.length - 16 * 1024)).toString('utf8')
    } catch {
      return
    }
    // stderr 被 PowerShell 序列化成了 CLIXML，里面的 && 写作 &amp;&amp;，先解码再匹配
    const decoded = cleanPowerShellError(text)
    const cmdSyntax =
      /is not a valid statement separator/i.test(decoded) ||
      /不是有效语句分隔符|不是有效的语句分隔符/i.test(decoded) ||
      /The token '&{0,4}?&{0,4}&{0,4}' is not valid/i.test(text)
    if (!cmdSyntax) return
    appendChunk(
      job,
      'meta',
      '[这条命令是 cmd 语法（set "X=Y" && cd /d ...），当前终端用的 PowerShell 不支持 && 。' +
        '把终端切回 cmd 再执行，或把命令改成 PowerShell 写法（$env:X="Y"; cd ...; ...）]\n',
    )
  }

  function startJob(input) {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) throw new Error('命令不能为空')
    const shell = SHELLS.has(input.shell) ? input.shell : 'auto'
    const cwdInput = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : ''
    const cwd = cwdInput ? expandPath(cwdInput, home) : process.cwd()
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error('工作目录不存在：' + cwd)
    }
    const timeoutRaw = Number(input.timeoutMs)
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(timeoutRaw, maxTimeoutMs)
      : DEFAULT_TIMEOUT_MS

    // 同一条命令（同目录）已经在跑：接上它，而不是再 spawn 一份。
    // 连点两下「启动项目」= 第二个 mvn 去抢同一个端口，用户只会看到一条莫名其妙的 BUILD FAILURE。
    const same = [...jobs.values()].find((job) => !job.done && job.command === command && job.cwd === cwd)
    if (same) {
      same.reused = true
      return same
    }

    const id = randomUUID()
    mkdirSync(jobsDir, { recursive: true })
    const outPath = join(jobsDir, id + '.out.log')
    const errPath = join(jobsDir, id + '.err.log')
    // 多行 cmd 命令会写到这个脚本里再 call 它（见 buildSpawnSpec）；单行命令不会生成这个文件
    const scriptPath = join(jobsDir, id + '.cmd')
    writeFileSync(outPath, '', 'utf8')
    writeFileSync(errPath, '', 'utf8')

    // 输出由 shell 自己重定向进上面两个文件（见 buildSpawnSpec）。
    // 不用父进程 fd 继承：父进程的句柄在插件重载时会被回收，
    // 而这种写法里文件句柄从一开始就归子进程所有。
    const spec = buildSpawnSpec(shell, command, cwd, { outPath, errPath, scriptPath })
    let child
    try {
      child = spawn(spec.file, spec.args, {
        cwd,
        env: commandEnv(),
        windowsHide: true,
        stdio: 'ignore',
        ...spec.options,
      })
    } catch (error) {
      try {
        appendFileSync(errPath, '[启动失败] ' + (error instanceof Error ? error.message : String(error)) + '\n', 'utf8')
      } catch {}
      throw error
    }

    const job = makeJob({
      id,
      command,
      shell: spec.label,
      cwd,
      pid: child.pid || 0,
      startedAt: Date.now(),
      outPath,
      errPath,
      scriptPath,
    })
    jobs.set(job.id, job)
    // 只有多行命令才会生成脚本文件；记下来，任务被淘汰时一起删掉
    if (existsSync(scriptPath)) job.scriptPath = scriptPath

    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (job.done) return
        job.timedOut = true
        appendChunk(job, 'meta', '[超时 ' + Math.round(timeoutMs / 1000) + 's，已终止]\n')
        killTree(job.pid)
      }, timeoutMs)
      timer.unref?.()
    }

    let settled = false
    const finish = async (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const exitCode = typeof code === 'number' ? code : null
      // 先补「端口被谁占着」「是不是 shell 用错了」再宣布结束：客户端一看到 done 就停止轮询，晚了这句提示就没人看得到。
      if (exitCode !== 0) {
        await announcePortConflict(job)
        await announceShellHint(job)
      }
      job.exitCode = exitCode
      job.endedAt = Date.now()
      job.done = true
      drainJob(job, true)
      persistRegistry()
    }

    child.on('error', (error) => {
      try {
        appendFileSync(errPath, '[启动失败] ' + error.message + '\n', 'utf8')
      } catch {}
      finish(-1)
    })
    child.on('close', (code) => finish(code))

    persistRegistry()
    pruneJobs()
    return job
  }

  /** 只留最近 JOBS_KEEP 个任务，顺手删掉被淘汰任务的日志文件 */
  function pruneJobs() {
    if (jobs.size <= JOBS_KEEP) return
    const extra = jobs.size - JOBS_KEEP
    let removed = 0
    for (const [id, job] of jobs) {
      if (removed >= extra) break
      if (!job.done) continue
      jobs.delete(id)
      removed += 1
      for (const file of [job.outPath, job.errPath, job.scriptPath]) {
        if (!file) continue
        try {
          unlinkSync(file)
        } catch {}
      }
    }
    if (removed > 0) persistRegistry()
  }

  /**
   * 清理「壳层已死、子孙还活着」的残渣。
   * 插件重载/重启后原来的 cmd.exe 壳没了，但 mvn → java 还挂在端口上，
   * 下次启动就会撞端口。加载时无条件扫一次，运行期最多 30s 一次（列表进程不便宜）。
   */
  let sweepInFlight = null
  let lastSweepAt = 0
  function sweepOrphanJobs(force = false) {
    if (sweepInFlight) return sweepInFlight
    const now = Date.now()
    if (!force && now - lastSweepAt < 30000) return Promise.resolve([])
    lastSweepAt = now
    const dead = readRegistry().filter((entry) => Number(entry.pid) > 0 && !isAlive(Number(entry.pid)))
    if (!dead.length) return Promise.resolve([])
    sweepInFlight = reapOrphanTrees(
      dead.map((entry) => ({ pid: Number(entry.pid) || 0, startedAt: Number(entry.startedAt) || 0 })),
    )
      .then((killed) => {
        if (!killed.length) return killed
        const pids = killed.map((item) => (item.name ? `${item.pid}(${item.name})` : String(item.pid))).join('、')
        for (const entry of dead) {
          const job = jobs.get(entry.id)
          if (job) appendChunk(job, 'meta', `[清理了上次留下的子进程：${pids}]\n`)
        }
        ctx.logger?.warn?.(`dsh-global-cmd 清理了 ${killed.length} 个残留子进程：${pids}`)
        persistRegistry()
        return killed
      })
      .catch(() => [])
      .finally(() => {
        sweepInFlight = null
      })
    return sweepInFlight
  }

  /** 插件（重新）加载时把上次留下的任务接回来，包括还在跑的那些 */
  function recoverJobs() {
    const entries = readRegistry()
    let restored = 0
    for (const entry of entries) {
      const job = makeJob({
        id: entry.id,
        command: typeof entry.command === 'string' ? entry.command : '',
        shell: typeof entry.shell === 'string' ? entry.shell : 'auto',
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        pid: Number(entry.pid) || 0,
        startedAt: Number(entry.startedAt) || Date.now(),
        endedAt: Number(entry.endedAt) || 0,
        exitCode: entry.exitCode === undefined ? null : entry.exitCode,
        timedOut: entry.timedOut === true,
        killed: entry.killed === true,
        done: entry.exitCode !== null && entry.exitCode !== undefined,
        recovered: true,
        outPath: typeof entry.outPath === 'string' ? entry.outPath : '',
        errPath: typeof entry.errPath === 'string' ? entry.errPath : '',
      })
      jobs.set(job.id, job)
      drainJob(job, job.done)
      if (!job.done && !isAlive(job.pid)) {
        const known = readRegistry().find((item) => item.id === job.id)
        if (known && known.exitCode !== null && known.exitCode !== undefined) {
          job.exitCode = known.exitCode
          job.endedAt = Number(known.endedAt) || Date.now()
        } else {
          job.endedAt = Date.now()
        }
        job.done = true
        appendChunk(
          job,
          'meta',
          job.exitCode === null ? '[插件重载期间这个命令已经结束，退出码未知]\n' : '[插件重载期间这个命令已经结束 · 退出码 ' + job.exitCode + ']\n',
        )
      }
      restored += 1
    }
    if (restored > 0) persistRegistry()
    return restored
  }

  function readJobChunks(job, after) {
    if (job.recovered && !job.done) {
      drainJob(job, false)
      if (!isAlive(job.pid)) {
        const known = readRegistry().find((item) => item.id === job.id)
        if (known && known.exitCode !== null && known.exitCode !== undefined) {
          job.exitCode = known.exitCode
          job.endedAt = job.endedAt || Number(known.endedAt) || Date.now()
        } else {
          job.endedAt = job.endedAt || Date.now()
        }
        job.done = true
        drainJob(job, true)
        appendChunk(job, 'meta', job.exitCode === null ? '[进程已结束，退出码未知]\n' : '[进程已结束 · 退出码 ' + job.exitCode + ']\n')
        persistRegistry()
      }
    } else if (job.done) {
      // 命令已经结束，但日志可能还分片没搬完（一次最多搬 MAX_READ_BYTES），继续搬
      drainJob(job, true)
    } else {
      drainJob(job, false)
    }
    const start = Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0
    const dropped = job.dropped || 0
    const from = Math.max(0, start - dropped)
    // 一次别回太多：界面按批渐进显示，不会因为一条命令刷了几十万行而整块卡住
    const end = Math.min(job.chunks.length, from + MAX_CHUNKS_PER_POLL)
    const slice = job.chunks.slice(from, end)
    const next = dropped + end
    if (next > (job.served || 0)) job.served = next
    // 日志还没搬完时先别提 done：客户端看到 done 就停止轮询，剩下的输出就没人要了
    const drained = remainingBytes(job) === 0 && !(job.pending && (job.pending.out || job.pending.err))
    const more = end < job.chunks.length
    trimChunks(job)
    return {
      id: job.id,
      // 还有没送完的批次时先别说 done：客户端看到 done 就停止轮询，剩下的输出就没人要了
      done: job.done && drained && !more,
      draining: job.done && !drained,
      more,
      exitCode: job.exitCode,
      timedOut: job.timedOut,
      command: job.command,
      shell: job.shell,
      cwd: job.cwd,
      pid: job.pid,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      next,
      reset: start < dropped,
      chunks: slice,
    }
  }

  async function handle(req, res) {
    const hostname = (typeof req.headers.host === 'string' ? req.headers.host : '').replace(/:\d+$/, '').toLowerCase()
    if (!trustedHosts.has(hostname)) {
      jsonBody(res, 403, { error: '不被信任的 Host' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) || '/' : url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (path === '/state' && method === 'GET') {
        jsonBody(res, 200, readState())
        return
      }
      if (path === '/state' && (method === 'PUT' || method === 'POST')) {
        const body = await readBody(req)
        jsonBody(res, 200, writeState(body))
        return
      }
      if (path === '/env' && method === 'GET') {
        jsonBody(res, 200, {
          platform: process.platform,
          dataFile,
          home,
          cwd: process.cwd(),
          shells: [...SHELLS],
          maxTimeoutMs,
          // 控制台首屏照 cmd 的样子打「Microsoft Windows [Version …]」，这里给出真实版本号
          osVersion: osRelease(),
          hostname: osHostname(),
        })
        return
      }
      if (path === '/cwd' && method === 'GET') {
        const raw = url.searchParams.get('path') ?? ''
        const baseParam = url.searchParams.get('base') ?? ''
        const userHome = homedir()
        const base = baseParam ? expandPath(baseParam, userHome) : process.cwd()
        jsonBody(res, 200, resolveCwd(raw, base, userHome))
        return
      }
      if (path === '/diag' && method === 'GET') {
        // 自检：用同一套 spawn + 重定向跑一条固定命令，看看 stdout/stderr 是否真的落进日志文件
        const probeId = randomUUID()
        mkdirSync(jobsDir, { recursive: true })
        const probeOut = join(jobsDir, probeId + '.diag.out.log')
        const probeErr = join(jobsDir, probeId + '.diag.err.log')
        writeFileSync(probeOut, '', 'utf8')
        writeFileSync(probeErr, '', 'utf8')
        const probeCommand = 'echo probe-stdout & echo probe-stderr 1>&2'
        const probeSpec = buildSpawnSpec('cmd', probeCommand, process.cwd(), { outPath: probeOut, errPath: probeErr })
        const probe = await new Promise((resolve) => {
          let child
          try {
            child = spawn(probeSpec.file, probeSpec.args, {
              cwd: process.cwd(),
              env: commandEnv(),
              windowsHide: true,
              stdio: 'ignore',
              ...probeSpec.options,
            })
          } catch (error) {
            resolve({ spawnError: error instanceof Error ? error.message : String(error), exitCode: null })
            return
          }
          const guard = setTimeout(() => {
            try {
              killTree(child.pid)
            } catch {}
          }, 8000)
          guard.unref?.()
          child.on('error', (error) => {
            clearTimeout(guard)
            resolve({ spawnError: error.message, exitCode: null })
          })
          child.on('close', (code) => {
            clearTimeout(guard)
            resolve({ exitCode: code })
          })
        })
        const probeRead = (file) => {
          try {
            return readFileSync(file, 'utf8')
          } catch {
            return ''
          }
        }
        jsonBody(res, 200, {
          command: probeCommand,
          spec: { file: probeSpec.file, args: probeSpec.args, label: probeSpec.label },
          ...probe,
          stdout: probeRead(probeOut),
          stderr: probeRead(probeErr),
        })
        return
      }
      if (path === '/exec' && method === 'POST') {
        const body = await readBody(req)
        await sweepOrphanJobs()
        const job = startJob(body)
        const reused = job.reused === true
        job.reused = false
        jsonBody(res, 200, { id: job.id, reused })
        return
      }
      const logMatch = /^\/exec\/([0-9a-zA-Z-]+)\/log$/.exec(path)
      if (logMatch) {
        const job = jobs.get(logMatch[1])
        if (!job) {
          jsonBody(res, 404, { error: '任务不存在或已过期' })
          return
        }
        const stream = url.searchParams.get('stream') === 'err' ? 'err' : 'out'
        const file = stream === 'err' ? job.errPath : job.outPath
        let text = ''
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          text = ''
        }
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="' + job.id + '.' + stream + '.log"',
          'cache-control': 'no-store',
        })
        res.end(text)
        return
      }
      const execMatch = /^\/exec\/([0-9a-zA-Z-]+)(\/kill)?$/.exec(path)
      if (execMatch) {
        const id = execMatch[1]
        const job = jobs.get(id)
        if (!job) {
          jsonBody(res, 404, { error: '任务不存在或已过期' })
          return
        }
        if (execMatch[2]) {
          if (method !== 'POST') {
            jsonBody(res, 405, { error: '只支持 POST' })
            return
          }
          if (!job.done) {
            job.killed = true
            appendChunk(job, 'meta', '[已手动终止]\n')
            killTree(job.pid)
            persistRegistry()
          }
          jsonBody(res, 200, { id, killed: true })
          return
        }
        const after = Number(url.searchParams.get('after') ?? '0')
        jsonBody(res, 200, readJobChunks(job, after))
        return
      }
      jsonBody(res, 404, { error: `未知路由：${path}` })
    } catch (error) {
      jsonBody(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // 先把上次留下的任务接回来，再暴露路由：避免新实例刚起来时客户端轮询撞上 404
  const restored = recoverJobs()
  // 上次重载/崩溃留下的孤儿（壳死了、mvn/java 还在跑）先清掉，否则一启动就撞端口
  void sweepOrphanJobs(true)

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }),
    'global-cmd: http routes',
  )

  ctx.logger?.info?.(
    `dsh-global-cmd 已就绪，数据文件：${dataFile}${restored > 0 ? `；已接上 ${restored} 个任务` : ''}`,
  )
}

