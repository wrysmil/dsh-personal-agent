import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../index.js')

function mount(config) {
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      return fn()
    },
  }
  mod.apply(ctx, config)
  return routes
}

function startServer(routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
    const route = routes.find((item) =>
      item.kind === 'prefix' ? pathname.startsWith(item.path) : pathname === item.path,
    )
    if (!route) {
      res.writeHead(404).end('{}')
      return
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.writableEnded) res.writeHead(500).end('{}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** 每个用例一份独立的数据文件，避免互相清目录。 */
function prepare(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'gcmd-timeout-'))
  const dataFile = join(dir, 'actions.json')
  writeFileSync(dataFile, JSON.stringify(contents), 'utf8')
  return { dir, dataFile }
}

async function readState(t, seed) {
  const { dir, dataFile } = prepare(seed)
  const routes = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-global-cmd/api/state`)
  return response.json()
}

test('旧数据里的 120 秒默认超时会被迁移成「不限制」', async (t) => {
  // 模拟上一版写下的数据文件：version 1 + 默认 120 秒
  const body = await readState(t, { version: 1, settings: { timeoutMs: 120000 }, actions: [] })
  assert.equal(body.settings.timeoutMs, 0)
  assert.equal(body.version, 2)
})

test('用户自己设的超时值会被保留', async (t) => {
  const body = await readState(t, { version: 2, settings: { timeoutMs: 5000 }, actions: [] })
  assert.equal(body.settings.timeoutMs, 5000)
})

test('不设超时时任务不会被自动杀掉', async (t) => {
  const { dir, dataFile } = prepare({ version: 2, settings: { timeoutMs: 0 }, actions: [] })
  const routes = mount({ dataFile })
  const server = await startServer(routes)
  const base = `http://127.0.0.1:${server.address().port}/dsh-global-cmd/api`
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const isWindows = process.platform === 'win32'
  const command = isWindows ? 'ping -n 3 127.0.0.1 >nul & echo done' : 'sleep 2 && echo done'
  const started = await fetch(`${base}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, shell: 'auto', timeoutMs: 0 }),
  }).then((response) => response.json())

  let cursor = 0
  let text = ''
  let result
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const body = await fetch(`${base}/exec/${started.id}?after=${cursor}`).then((response) => response.json())
    cursor = body.next
    text += body.chunks.map((chunk) => chunk.d).join('')
    if (body.done) {
      result = body
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }

  assert.ok(result, '命令应在超时前正常结束')
  assert.equal(result.timedOut, false, '没有设置超时就不该被判定为超时')
  assert.match(text, /done/)
})
