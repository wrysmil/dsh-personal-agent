import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'

const require = createRequire('D:/workspace/project/aigc_platfrom_back/package.json')
const { chromium } = require('playwright-core')

const URL = 'http://127.0.0.1:63250'
const SHOTS = 'D:/workspace/dsh-plugins/dsh-global-cmd/.tmp-shots'
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Users/Huangqh/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe',
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', (msg) => {
  const text = msg.text()
  if (/error|Error/.test(text)) console.log('[page]', text.slice(0, 300))
})
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(6000)
await page.screenshot({ path: `${SHOTS}/01-app.png` })

const entry = page.locator('.gcmd-foot')
console.log('entry count', await entry.count())
if (await entry.count()) {
  await entry.first().click()
  await page.waitForTimeout(700)
}
await page.screenshot({ path: `${SHOTS}/02-open.png` })

const prompt = page.locator('.gcmd-input')
console.log('prompt count', await prompt.count())

// 1) 先点输出区里的历史行（或横幅）以外的地方：直接点 banner 文字
if (await page.locator('.gcmd-banner').count()) {
  await page.mouse.click(700, 300)
  await page.waitForTimeout(150)
  console.log('after click blank -> active:', await page.evaluate(() => {
    const el = document.activeElement
    return el ? `${el.tagName}.${el.className}` : 'null'
  }))
  await page.screenshot({ path: `${SHOTS}/03-click-blank.png` })
}

// 2) 输入一条命令，抓输出出现前后的两帧
await prompt.first().click()
await page.keyboard.type('dir /b')
const t0 = Date.now()
await page.keyboard.press('Enter')
await page.waitForTimeout(60)
await page.screenshot({ path: `${SHOTS}/04-t60ms.png` })
await page.waitForTimeout(160)
await page.screenshot({ path: `${SHOTS}/05-t220ms.png` })
await page.waitForTimeout(400)
await page.screenshot({ path: `${SHOTS}/06-t620ms.png` })
console.log('elapsed for shots', Date.now() - t0)

await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/07-done.png` })

// 3) 命令结束后：点第一行输出文字，看看焦点是否回到提示符、光标是否出现
const line = page.locator('.gcmd-line[data-kind="out"]').first()
if (await line.count()) {
  const box = await line.boundingBox()
  if (box) {
    await page.mouse.click(box.x + 12, box.y + box.height / 2)
    await page.waitForTimeout(150)
    console.log('after click output line -> active:', await page.evaluate(() => {
      const el = document.activeElement
      return el ? `${el.tagName}.${el.className}` : 'null'
    }))
    await page.screenshot({ path: `${SHOTS}/08-click-output.png` })
  }
}

// 4) 拖动选中文本时不应抢焦点
const outLine = page.locator('.gcmd-line[data-kind="out"]').first()
if (await outLine.count()) {
  const box = await outLine.boundingBox()
  if (box) {
    await page.mouse.move(box.x + 4, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    console.log('after drag select -> selection:', await page.evaluate(() => String(window.getSelection())))
    await page.screenshot({ path: `${SHOTS}/09-drag.png` })
  }
}

await browser.close()
console.log('done')
