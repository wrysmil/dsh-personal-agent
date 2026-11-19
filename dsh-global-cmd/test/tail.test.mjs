/**
 * 收尾时不能丢掉「最后一行没有换行」的输出：
 * 命令结束得比客户端第一次轮询还快时，那段输出会永远留在日志文件里没人看。
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../index.js')

function mount(config) {
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      return fn()
    },
  }
  mod.apply(ctx, config)
  return { routes }
}

function startServer(routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
    const route = routes.find((item) =>
      item.kind === 'prefix' ? pathname.startsWith(item.path) : pathname === item.path,
    )
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'no route' }))
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const baseUrl = (server) => `http://127.0.0.1:${server.address().port}/dsh-global-cmd/api`

async function json(url, init) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-global-cmd-tail-'))
const dataFile = join(workDir, 'actions.json')
const isWindows = process.platform === 'win32'

after(() => {
  // Windows 上后台 shell（PowerShell 启动本身就要一两秒）可能还攥着日志句柄，
  // 直接 rmSync 会 EBUSY；给几次重试，别让清理失败盖掉真正的测试结果
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(workDir, { recursive: true, force: true })
      return
    } catch {
      const until = Date.now() + 100
      while (Date.now() < until) {
        /* 忙等一小会儿再试 */
      }
    }
  }
})

/** 轮询到命令结束（PowerShell 冷启动在并发测试里可能超过 1.5 秒） */
async function waitDone(url, id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = (await json(`${url}/exec/${id}?after=0`)).body
    if (last?.done) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return last
}

test('命令秒退时，输出也不会丢在日志文件里', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const started = await json(`${url}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command: 'echo tail-line', shell: isWindows ? 'cmd' : 'sh' }),
  })
  assert.equal(started.status, 200)

  // 故意等命令彻底结束再读：这时一次性把所有输出拿回来
  const body = await waitDone(url, started.body.id)
  assert.equal(body.done, true)
  const text = body.chunks.map((chunk) => chunk.d).join('')
  assert.match(text, /tail-line/, '命令结束后一次性读取也必须拿到输出')
})

test('PowerShell 里跑 cmd 语法时给出「换 shell」的提示', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const cmdSyntax = 'set "AIGC_DOMAIN=1.2.3.4" && cd /d . && echo hi'
  const started = await json(`${url}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command: cmdSyntax, shell: isWindows ? 'powershell' : 'pwsh' }),
  })
  assert.equal(started.status, 200)

  await new Promise((resolve) => setTimeout(resolve, 1500))
  const body = await waitDone(url, started.body.id)
  const text = body.chunks.map((chunk) => chunk.d).join('')
  if (isWindows) {
    assert.equal(body.exitCode, 1, 'PowerShell 5 解析 && 应该失败')
    assert.match(text, /cmd 语法/, '应该提示这是 cmd 语法')
  }
})
