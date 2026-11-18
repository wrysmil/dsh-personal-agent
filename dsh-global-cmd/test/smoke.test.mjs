/**
 * dsh-global-cmd Host 服务的冒烟测试：
 * 用一个假的 ctx（webServer/logger/effect）挂载插件，再起一个真实 http 服务转发请求，
 * 验证 state 读写、命令执行、输出增量读取、终止与 Host 头校验。
 *
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
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
  return { routes, ctx }
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

function baseUrl(server) {
  const address = server.address()
  return `http://127.0.0.1:${address.port}/dsh-global-cmd/api`
}

async function json(url, init) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

async function pollUntilDone(url, id) {
  let cursor = 0
  let text = ''
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { body } = await json(`${url}/exec/${id}?after=${cursor}`)
    cursor = body.next
    text += body.chunks.map((chunk) => chunk.d).join('')
    if (body.done) return { text, result: body }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error('命令在 7 秒内未结束')
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-global-cmd-'))
const dataFile = join(workDir, 'actions.json')
const isWindows = process.platform === 'win32'
const shellName = isWindows ? 'cmd' : 'sh'

after(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test('state 初始为空 + 读写持久化', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const initial = await json(`${url}/state`)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.actions.length, 0, '不再内置示例命令')
  assert.equal(initial.body.settings.timeoutMs, 120000)

  const saved = await json(`${url}/state`, {
    method: 'PUT',
    body: JSON.stringify({
      actions: [
        { name: 'Echo Hi', command: 'echo hi', shell: 'auto', group: '测试' },
        { name: '', command: '   ' },
      ],
      settings: { defaultShell: 'cmd', timeoutMs: 5000 },
    }),
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.actions.length, 1, '空命令应被丢弃')
  assert.equal(saved.body.actions[0].name, 'Echo Hi')
  assert.equal(saved.body.settings.timeoutMs, 5000)

  const reread = await json(`${url}/state`)
  assert.equal(reread.body.actions.length, 1)
  assert.equal(reread.body.actions[0].group, '测试')
})

test('旧版本自动种下的示例命令会被清理掉', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const saved = await json(`${url}/state`, {
    method: 'PUT',
    body: JSON.stringify({
      actions: [
        { name: '查看当前目录', command: 'cd', group: '示例' },
        { name: 'Node 版本', command: 'node --version', group: '示例' },
        { name: '我的命令', command: 'echo mine', group: '自定义' },
      ],
    }),
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.actions.length, 1)
  assert.equal(saved.body.actions[0].name, '我的命令')
})

test('执行命令并增量读取输出', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const started = await json(`${url}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command: 'echo global-cmd-ok', shell: shellName }),
  })
  assert.equal(started.status, 200)
  assert.ok(started.body.id)

  const { text, result } = await pollUntilDone(url, started.body.id)
  assert.match(text, /global-cmd-ok/)
  assert.equal(result.exitCode, 0)
  assert.equal(result.done, true)
})

test('非零退出码会被记录下来', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const started = await json(`${url}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command: 'exit 7', shell: shellName }),
  })
  const { result } = await pollUntilDone(url, started.body.id)
  assert.equal(result.exitCode, 7)
})

test('终止运行中的命令', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const longCommand = isWindows ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 30'
  const started = await json(`${url}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command: longCommand, shell: shellName }),
  })
  assert.ok(started.body.id)

  const killed = await json(`${url}/exec/${started.body.id}/kill`, { method: 'POST', body: '{}' })
  assert.equal(killed.status, 200)
  assert.equal(killed.body.killed, true)

  const { result } = await pollUntilDone(url, started.body.id)
  assert.equal(result.done, true)
})

test('未信任 Host 头被拒绝', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const address = server.address()

  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/dsh-global-cmd/api/state',
        headers: { host: 'evil.example.com' },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode)
      },
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 403)
})

test('工作目录不存在时给出明确错误', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const result = await json(`${url}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command: 'echo x', cwd: join(workDir, 'nope-not-here') }),
  })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /工作目录不存在/)
})

