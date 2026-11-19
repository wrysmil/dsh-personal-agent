// PowerShell 在重定向时会把 stderr 序列化成 CLIXML：真正的报错在 <S S="Error"> 里，
// 而进度条（Write-Progress / 模块首次加载）是 <Obj S="progress"> 记录。
// 后者不是错误，必须丢掉，否则整段 XML 会被当成报错糊在输出后面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n')

function slice(start, end) {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `找不到片段起点：${start}`)
  const to = source.indexOf(end, from)
  assert.ok(to > from, `找不到片段终点：${end}`)
  return source.slice(from, to)
}

const cleanPowerShellError = new Function(
  `${slice('/** PowerShell 的 stderr 会被 CLIXML 序列化', 'function isAlivePid')}\nreturn cleanPowerShellError`,
)()

const PROGRESS =
  '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>'

test('普通文本（没有 CLIXML）原样返回', () => {
  assert.equal(cleanPowerShellError('mvn: 命令未找到'), 'mvn: 命令未找到')
  assert.equal(cleanPowerShellError(''), '')
})

test('CLIXML 里的报错会被还原成纯文本', () => {
  const text = `#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">cmd : 找不到路径_x000D__x000A_</S></Objs>`
  const cleaned = cleanPowerShellError(text)
  assert.match(cleaned, /找不到路径/)
  assert.ok(!cleaned.includes('CLIXML'), '不该留下 CLIXML 标记')
  assert.ok(!cleaned.includes('<S S='), '不该留下 XML 标签')
})

test('只有进度记录时什么都不输出（这正是之前的噪音来源）', () => {
  assert.equal(cleanPowerShellError(`#< CLIXML\n${PROGRESS}`), '')
  assert.equal(cleanPowerShellError(PROGRESS), '')
})

test('进度记录和报错混在一起时只留报错', () => {
  const text = `${PROGRESS}\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Get-Process : 拒绝访问</S></Objs>`
  const cleaned = cleanPowerShellError(text)
  assert.match(cleaned, /拒绝访问/)
  assert.ok(!cleaned.includes('progress'), '进度记录应该被丢掉')
  assert.ok(!cleaned.includes('Preparing modules'), '进度文案不应该漏出来')
})
