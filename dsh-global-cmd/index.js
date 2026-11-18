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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname as osHostname, release as osRelease } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-global-cmd'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-global-cmd/api'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_CHUNKS = 20000
const MAX_STREAM_CHARS = 400 * 1024
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

/** 把 Windows 路径改写成 msys/git-bash 认得的 /c/... 形式 */
function toPosixPath(target) {
  const normalized = String(target).replace(/\\/g, '/')
  const match = /^([A-Za-z]):(.*)$/.exec(normalized)
  return match ? '/' + match[1].toLowerCase() + match[2] : normalized
}

/** 把用户命令包装成各 shell 可直接执行的 spawn 参数（capture 时由 shell 自己重定向输出） */
function buildSpawnSpec(shellInput, command, cwd, redirect) {
  const platform = process.platform
  const isWindows = platform === 'win32'
  const outPath = redirect && typeof redirect.outPath === 'string' ? redirect.outPath : ''
  const errPath = redirect && typeof redirect.errPath === 'string' ? redirect.errPath : ''
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
      const inner = capture
        ? `chcp 65001>nul & ( ${command} ) 1> "${outPath}" 2> "${errPath}"`
        : `chcp 65001>nul & ${command}`
      return {
        file: comspec,
        args: ['/d', '/s', '/c', `"${inner}"`],
        options: { windowsVerbatimArguments: true },
        label: 'cmd',
      }
    }
    if (shell === 'powershell' || shell === 'pwsh') {
      const file = shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe'
      const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;\n${command}`
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

  function isAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // Windows 上无权限访问时抛 EPERM，说明进程还在
      return Boolean(error) && error.code === 'EPERM'
    }
  }

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
    const keep = [...byId.values()]
      .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0))
      .slice(-JOBS_KEEP)
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
      offsets: { out: 0, err: 0 },
      chars: { out: 0, err: 0 },
      truncated: { out: false, err: false },
      chunks: [],
      dropped: 0,
    }
  }

  function appendChunk(job, stream, text) {
    if (text === '') return
    // 'meta' 是插件自己插的提示行，不占 400KB 的输出预算
    if (stream !== 'meta') {
      if (job.chars[stream] >= MAX_STREAM_CHARS) {
        if (!job.truncated[stream]) {
          job.truncated[stream] = true
          job.chunks.push({ s: 'meta', d: '[输出超过 ' + Math.round(MAX_STREAM_CHARS / 1024) + 'KB，已截断]\n' })
        }
        return
      }
      job.chars[stream] += text.length
    }
    job.chunks.push({ s: stream, d: text })
    if (job.chunks.length > MAX_CHUNKS) {
      job.chunks.shift()
      job.dropped += 1
    }
  }

  /** 把日志文件里新增的完整行搬进 chunks（按 \n 切，绝不在多字节字符中间截断） */
  function drainJob(job, flush) {
    for (const stream of ['out', 'err']) {
      const file = stream === 'out' ? job.outPath : job.errPath
      if (!file) continue
      let buffer
      try {
        buffer = readFileSync(file)
      } catch {
        continue
      }
      const from = job.offsets[stream]
      if (buffer.length <= from) continue
      let end = buffer.lastIndexOf(10)
      if (end < from) {
        if (!flush) continue
        end = buffer.length - 1
      }
      const text = buffer.subarray(from, end + 1).toString('utf8')
      job.offsets[stream] = end + 1
      const clean = stream === 'err' && (job.shell === 'powershell' || job.shell === 'pwsh')
        ? cleanPowerShellError(text)
        : text
      for (const line of clean.split('\n')) {
        if (line === '') continue
        appendChunk(job, stream, line + '\n')
      }
    }
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

    const id = randomUUID()
    mkdirSync(jobsDir, { recursive: true })
    const outPath = join(jobsDir, id + '.out.log')
    const errPath = join(jobsDir, id + '.err.log')
    writeFileSync(outPath, '', 'utf8')
    writeFileSync(errPath, '', 'utf8')

    // 输出由 shell 自己重定向进上面两个文件（见 buildSpawnSpec）。
    // 不用父进程 fd 继承：父进程的句柄在插件重载时会被回收，
    // 而这种写法里文件句柄从一开始就归子进程所有。
    const spec = buildSpawnSpec(shell, command, cwd, { outPath, errPath })
    let child
    try {
      child = spawn(spec.file, spec.args, {
        cwd,
        env: process.env,
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
    })
    jobs.set(job.id, job)

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
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      job.exitCode = typeof code === 'number' ? code : null
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
      for (const file of [job.outPath, job.errPath]) {
        if (!file) continue
        try {
          unlinkSync(file)
        } catch {}
      }
    }
    if (removed > 0) persistRegistry()
  }

  /** 插件（重新）加载时把上次留下的任务接回来，包括还在跑的那些 */
  function recoverJobs() {
    const entries = readRegistry()
    let restored = 0
    for (const entry of entries.slice(-JOBS_KEEP)) {
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
    } else if (!job.done) {
      drainJob(job, false)
    }
    const start = Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0
    const dropped = job.dropped || 0
    const from = Math.max(0, start - dropped)
    const slice = job.chunks.slice(from)
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
      next: dropped + from + slice.length,
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
              env: process.env,
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

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }),
    'global-cmd: http routes',
  )

  ctx.logger?.info?.(
    `dsh-global-cmd 已就绪，数据文件：${dataFile}${restored > 0 ? `；已接上 ${restored} 个任务` : ''}`,
  )
}

