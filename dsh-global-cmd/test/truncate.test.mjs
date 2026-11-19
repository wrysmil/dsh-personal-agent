/**
 * 输出不再按 400KB 截断：验证大段输出能完整读回，并且 /exec/<id>/log 能导出完整日志文件。
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync as readText, rmSync } from 'node:fs'
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

function baseUrl(server) {
  const address = server.address()
  return `http://127.0.0.1:${address.port}/dsh-global-cmd/api`
}

async function json(url, init) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

async function pollUntilDone(url, id) {
  let cursor = 0
  let text = ''
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { body } = await json(`${url}/exec/${id}?after=${cursor}`)
    cursor = body.next
    text += body.chunks.map((chunk) => chunk.d).join('')
    if (body.done) return { text, result: body }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('命令在 16 秒内未结束')
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-global-cmd-truncate-'))
const dataFile = join(workDir, 'actions.json')
const isWindows = process.platform === 'win32'
const shellName = isWindows ? 'cmd' : 'sh'
// 20000 行 × 约 30 字节 ≈ 600KB，远超旧版的 400KB 上限
const bigCommand = `node -e "for(let i=0;i<20000;i++)console.log('row'+i+'-'+'x'.repeat(20))"`

after(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test('超过 400KB 的输出不会被截断', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const started = await json(`${url}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command: bigCommand, shell: shellName }),
  })
  assert.equal(started.status, 200)

  const { text, result } = await pollUntilDone(url, started.body.id)
  assert.ok(text.length > 400 * 1024, `实际输出只有 ${text.length} 字节`)
  assert.ok(!text.includes('已截断'), '不应该再出现截断提示')
  assert.match(text, /row0-/)
  assert.match(text, /row19999-/)
  assert.equal(result.exitCode, 0)

  const log = await fetch(`${url}/exec/${started.body.id}/log?stream=out`)
  assert.equal(log.status, 200)
  assert.match(log.headers.get('content-disposition') || '', /attachment/)
  const body = await log.text()
  assert.ok(body.length > 400 * 1024)
  assert.match(body, /row19999-/)
})

test('日志下载对不存在的任务返回 404', async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const missing = await json(`${url}/exec/not-a-job/log`)
  assert.equal(missing.status, 404)
})

test('客户端界面保留更多行，并能下载完整日志', () => {
  const client = readText(join(process.cwd(), 'client.js'), 'utf8')
  const cap = /const MAX_LINES = (\d+)/.exec(client)
  assert.ok(cap, '没找到 MAX_LINES')
  assert.ok(Number(cap[1]) >= 20000, `界面行数上限太小：${cap[1]}`)
  assert.match(client, /logUrl: \(id, stream\)/, '缺少日志下载地址')
  assert.match(client, /下载完整日志/, '缺少下载按钮')
  assert.match(client, /lastJob: jobId/, '任务结束后要记住 jobId 才能继续导出日志')
})
