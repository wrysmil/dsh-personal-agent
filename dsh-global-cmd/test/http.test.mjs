/**
 * HTTP 错误语义回归测试。
 *
 * 背景：插件被 disable/enable 重载的那一瞬间，路由还没注册上，
 * DSH 会回一个「非 JSON 的 404 页面」。以前客户端只会甩一句
 * 「读取输出失败：HTTP 404」，用户完全不知道发生了什么；
 * 现在 request() 会给这种响应打上 pluginMissing 标记，
 * 轮询逻辑据此重试或者给出人话提示。
 *
 * client.js 是浏览器模块（依赖 React、DSH 运行时），没法直接 import，
 * 所以从源码里切出 HTTP 那一段，在 Node 里用假的 fetch 跑一遍。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8').replace(/\r\n/g, '\n')
const start = source.indexOf('async function request(path, init) {')
const end = source.indexOf('const api = {')
assert.ok(start >= 0 && end > start, 'client.js 里找不到 HTTP 段')

function makeRequest(fetchImpl) {
  return new Function(
    'fetch',
    `const API = 'http://dsh.local/dsh-global-cmd/api';
    ${source.slice(start, end)}
    return request;`,
  )(fetchImpl)
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function htmlResponse(status) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error('not json')
    },
  }
}

test('Host 返回 JSON 错误时，消息就是 Host 给的那句', async () => {
  const request = makeRequest(async () => jsonResponse(404, { error: '任务不存在或已过期' }))
  await assert.rejects(request('/exec/abc'), (error) => {
    assert.equal(error.message, '任务不存在或已过期')
    assert.equal(error.status, 404)
    assert.equal(error.pluginMissing, false, 'Host 明说任务没了，就不是插件没加载')
    return true
  })
})

test('路由没注册（非 JSON 的 404）要标成 pluginMissing', async () => {
  const request = makeRequest(async () => htmlResponse(404))
  await assert.rejects(request('/exec/abc'), (error) => {
    assert.equal(error.message, 'HTTP 404')
    assert.equal(error.status, 404)
    assert.equal(error.pluginMissing, true, '插件重载窗口里的 404 应该被识别出来')
    return true
  })
})

test('网络断了（fetch 直接抛）时错误照常冒泡', async () => {
  const request = makeRequest(async () => {
    throw new Error('Failed to fetch')
  })
  await assert.rejects(request('/exec/abc'), /Failed to fetch/)
})

test('正常响应原样返回', async () => {
  const request = makeRequest(async () => jsonResponse(200, { ok: true }))
  assert.deepEqual(await request('/state'), { ok: true })
})
