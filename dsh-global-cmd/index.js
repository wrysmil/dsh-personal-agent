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
 *   POST   /exec/<id>/kill  终止命令
 *
 * 数据文件默认 <DSH_HOME>/global-cmd/actions.json（config.dataFile 可覆盖）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname as osHostname, release as osRelease } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-global-cmd'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-global-cmd/api'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_CHUNKS = 6000
const MAX_STREAM_CHARS = 400 * 1024
const DEFAULT_TIMEOUT_MS = 0
const MAX_TIMEOUT_MS = 30 * 60 * 1000
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
  if (!command.trim()) return null
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
    },
    actions,
  }
}

/** 把用户命令包装成各 shell 可直接执行的 spawn 参数 */
function buildSpawnSpec(shellInput, command, cwd) {
  const platform = process.platform
  const isWindows = platform === 'win32'
  let shell = shellInput
  if (shell === 'auto' || !shell) {
    shell = isWindows ? (process.env.ComSpec?.toLowerCase().includes('powershell') ? 'powershell' : 'cmd') : 'sh'
  }
  if (isWindows) {
    if (shell === 'cmd') {
      const comspec = process.env.ComSpec || 'cmd.exe'
      // windowsVerbatimArguments 保留内层引号；chcp 65001 让中文输出走 UTF-8
      return {
        file: comspec,
        args: ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`],
        options: { windowsVerbatimArguments: true },
        label: 'cmd',
      }
    }
    if (shell === 'powershell' || shell === 'pwsh') {
      const file = shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe'
      const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;\n${command}`
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      return {
        file,
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        options: {},
        label: shell,
      }
    }
    if (shell === 'bash' || shell === 'sh') {
      const file = shell === 'bash' ? 'bash.exe' : 'sh.exe'
      return { file, args: ['-lc', command], options: {}, label: shell }
    }
  }
  const file = shell === 'bash' ? 'bash' : '/bin/sh'
  const args = shell === 'bash' ? ['-lc', command] : ['-c', command]
  return { file, args, options: {}, label: shell }
}

/** PowerShell 的 stderr 会被 CLIXML 序列化，这里还原成纯文本 */
function cleanPowerShellError(text) {
  if (!text.includes('#< CLIXML')) return text
  const out = []
  const re = /<S S="Error">([\s\S]*?)<\/S>/g
  let match
  while ((match = re.exec(text)) !== null) {
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
  return cleaned || text
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    // 进程可能已退出
  }
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

  function pushChunk(job, stream, text) {
    if (!text) return
    const clean = stream === 'err' ? text : text
    if (job.chars[stream] >= MAX_STREAM_CHARS) {
      if (!job.truncated[stream]) {
        job.truncated[stream] = true
        job.chunks.push({ s: 'meta', d: `\n[输出超过 ${Math.round(MAX_STREAM_CHARS / 1024)}KB，已截断]\n` })
      }
      return
    }
    job.chars[stream] += clean.length
    if (job.chunks.length > MAX_CHUNKS) job.chunks.shift()
    job.chunks.push({ s: stream, d: clean })
  }

  function startJob(input) {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) throw new Error('命令不能为空')
    const shell = SHELLS.has(input.shell) ? input.shell : 'auto'
    const cwdInput = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : ''
    const cwd = cwdInput ? expandPath(cwdInput, home) : process.cwd()
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`工作目录不存在：${cwd}`)
    }
    const timeoutRaw = Number(input.timeoutMs)
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(timeoutRaw, maxTimeoutMs)
      : DEFAULT_TIMEOUT_MS

    const spec = buildSpawnSpec(shell, command, cwd)
    const child = spawn(spec.file, spec.args, {
      cwd,
      env: process.env,
      windowsHide: true,
      ...spec.options,
    })

    const job = {
      id: randomUUID(),
      command,
      shell: spec.label,
      cwd,
      startedAt: Date.now(),
      endedAt: 0,
      exitCode: null,
      done: false,
      timedOut: false,
      killed: false,
      chunks: [],
      chars: { out: 0, err: 0 },
      truncated: { out: false, err: false },
      pid: child.pid,
    }
    jobs.set(job.id, job)

    // timeoutMs === 0 表示不限制：命令一直跑到自己结束，或者用户按「停止」/关标签。
    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (job.done) return
        job.timedOut = true
        pushChunk(job, 'meta', `\n[超时 ${Math.round(timeoutMs / 1000)}s，已终止]\n`)
        killTree(child.pid)
      }, timeoutMs)
      timer.unref?.()
    }

    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      job.done = true
      job.endedAt = Date.now()
      job.exitCode = typeof code === 'number' ? code : null
      child.removeAllListeners('close')
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text) => pushChunk(job, 'out', text))
    child.stderr?.on('data', (text) => pushChunk(job, 'err', spec.label === 'powershell' || spec.label === 'pwsh' ? cleanPowerShellError(text) : text))
    child.on('error', (error) => {
      pushChunk(job, 'meta', `\n[启动失败] ${error.message}\n`)
      finish(-1)
    })
    child.on('close', (code) => finish(code))

    // 只保留最近 30 个任务，避免内存无限增长
    if (jobs.size > 30) {
      for (const [id, item] of jobs) {
        if (item.done) jobs.delete(id)
        if (jobs.size <= 30) break
      }
    }
    return job
  }

  function readJobChunks(job, after) {
    const start = Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0
    const slice = job.chunks.slice(start)
    return {
      id: job.id,
      done: job.done,
      exitCode: job.exitCode,
      timedOut: job.timedOut,
      command: job.command,
      shell: job.shell,
      cwd: job.cwd,
      pid: job.pid,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      next: start + slice.length,
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
      if (path === '/exec' && method === 'POST') {
        const body = await readBody(req)
        const job = startJob(body)
        jsonBody(res, 200, { id: job.id })
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
            pushChunk(job, 'meta', '\n[已手动终止]\n')
            killTree(job.pid)
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

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }),
    'global-cmd: http routes',
  )

  ctx.logger?.info?.(`dsh-global-cmd 已就绪，数据文件：${dataFile}`)
}

