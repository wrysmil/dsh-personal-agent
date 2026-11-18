/**
 * 「插件重载不会杀掉正在跑的命令」回归测试。
 *
 * 做法：同一份数据目录挂载两次插件（第二次 = bundle 关→开后的新模块实例），
 * 第一次启动一条要跑几秒的命令，然后立刻用第二次挂载的新路由去轮询同一个任务：
 *  - 命令必须还活着（不是被旧模块回收管道弄死的）
 *  - 输出能接着读到，并且最终能拿到 done + 完整输出
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function call(server, path, init) {
  const { port } = server.address()
  const response = await fetch(`http://127.0.0.1:${port}/dsh-global-cmd/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  })
  return { status: response.status, body: await response.json() }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('插件重载后正在跑的命令还能继续，并读到完整输出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcmd-survive-'))
  const config = { dataFile: join(dir, 'actions.json'), trustedHosts: [], maxTimeoutMs: 1800000 }
  const servers = []
  try {
    const serverA = await startServer(mount(config).routes)
    servers.push(serverA)

    const created = await call(serverA, '/exec', {
      method: 'POST',
      body: JSON.stringify({
        command: 'ping -n 6 127.0.0.1 >nul & echo survive-ok',
        shell: 'cmd',
        timeoutMs: 0,
      }),
    })
    assert.equal(created.status, 200)
    const { id } = created.body
    assert.ok(id, '拿到任务 id')

    const first = await call(serverA, `/exec/${id}?after=0`)
    assert.equal(first.status, 200, '旧实例能轮询')

    // ===== 模拟 bundle 关→开：旧实例留着，直接挂一个新的模块实例 =====
    const serverB = await startServer(mount(config).routes)
    servers.push(serverB)

    let after = first.body.next
    let done = false
    let text = ''
    let sawRunning = false
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const poll = await call(serverB, `/exec/${id}?after=${after}`)
      assert.equal(poll.status, 200, '新实例必须还能认出这个任务')
      after = poll.body.next
      if (!poll.body.done) sawRunning = true
      text += (poll.body.chunks || []).map((chunk) => chunk.d).join('')
      if (poll.body.done) {
        done = true
        assert.ok(
          poll.body.exitCode === null || poll.body.exitCode === 0,
          `命令没有被重载弄死，退出码：${poll.body.exitCode}`,
        )
        break
      }
      await sleep(200)
    }

    assert.ok(sawRunning, '重载后命令还在跑（不是被立刻杀掉）')
    assert.ok(done, '最终能读到 done')
    assert.match(text, /survive-ok/, '重载后仍然拿到了完整输出')
    assert.doesNotMatch(text, /这个命令已经结束/, '命令不是被重载弄死的')
  } finally {
    for (const server of servers) {
      server.closeAllConnections?.()
      server.close()
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
