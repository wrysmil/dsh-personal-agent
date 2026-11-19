/**
 * 多行命令：cmd.exe 解析 `/c` 参数时遇到换行就截断，第二行往后会被静默丢掉。
 * 现在后端会把含换行的命令落成 <jobs>/<id>.cmd 再 `call` 它，这里守住这条路径。
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { body } = await json(`${url}/exec/${id}?after=${cursor}`)
    cursor = body.next
    text += body.chunks.map((chunk) => chunk.d).join('')
    if (body.done) return { text, result: body }
    if (!body.more) await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('命令在 9 秒内未结束')
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-global-cmd-multiline-'))
const dataFile = join(workDir, 'actions.json')
const isWindows = process.platform === 'win32'

after(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test('cmd 多行命令：换行后的内容不会被丢掉', { skip: !isWindows }, async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  // set 的值要能在后面的行里用上：证明是逐行执行，而不是被压成一行提前展开
  const command = ['set GCMD_A=42', 'echo first-line', 'echo second-line', 'echo A=%GCMD_A%'].join('\r\n')
  const started = await json(`${url}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command, shell: 'cmd' }),
  })
  assert.equal(started.status, 200)

  const { text, result } = await pollUntilDone(url, started.body.id)
  assert.match(text, /first-line/)
  assert.match(text, /second-line/)
  assert.match(text, /A=42/)
  assert.equal(result.exitCode, 0)

  // 脚本落在 jobs 目录里，任务还在时不删（删了正在跑的 cmd 会读不到）
  const jobs = readdirSync(join(workDir, 'jobs')).filter((name) => name.endsWith('.cmd'))
  assert.ok(jobs.length >= 1, '多行命令应该生成 .cmd 脚本')
})

test('单行命令不会多写一份脚本', { skip: !isWindows }, async (t) => {
  const { routes } = mount({ dataFile })
  const server = await startServer(routes)
  t.after(() => server.close())
  const url = baseUrl(server)

  const before = readdirSync(join(workDir, 'jobs')).filter((name) => name.endsWith('.cmd')).length
  const started = await json(`${url}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command: 'echo single-line', shell: 'cmd' }),
  })
  const { text } = await pollUntilDone(url, started.body.id)
  assert.match(text, /single-line/)
  const after = readdirSync(join(workDir, 'jobs')).filter((name) => name.endsWith('.cmd')).length
  assert.equal(after, before, '单行命令不该生成 .cmd 脚本')
})
