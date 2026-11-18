# 实现细节与设计取舍

## 为什么它不需要会话

DSH 的会话级注入点（`conversation.composer.dock`、`conversation.input.right` 等）都挂在某条会话的渲染树上，
会话销毁就消失。本插件只用两个 **root 作用域** 的挂载点：

| 挂载点 | 作用域 | 放什么 |
| --- | --- | --- |
| `sidebar.footer.action` | root | 侧栏底部那个「❯_ 控制台」入口按钮，与「设置」并排 |
| `shell.overlay` | root | 控制台浮窗与命令库/表单浮层 |

`shell.overlay` 的定义是：

> Frame-wide floating layer, above every column and outside their scroll containers.

它由应用外壳持有，与会话生命周期解耦。但**悬浮层只放「打开时才出现的东西」**：关闭状态下这个条目直接返回
`null`，界面上什么都不留。入口按钮刻意放在侧栏底部而不是浮在右下角 —— 右下角正是编辑区/输入框的控制按钮所在地，
一个 `position: fixed` 的圆形启动器必然压在别人身上（第一版就是这么翻车的）。

入口那一格是「追加」而不是「替换」：`id` 用自己的 `dsh-global-cmd:launcher`（新 id 追加一格，复用别人的 id 才是替换），
`order: 10` 让它排在设置旁边的既有条目里；`shell.overlay` 侧用 `dsh-global-cmd:dock`、`order: 60`，
排在 better-sidebar(20) / mnemon(30) / cost-meter(50) 之后。

悬浮层本身是 click-through 的（`pointer-events: none`），所以根节点永远不吃事件：
打开时它只是给固定浮窗提供一个 `position: fixed; inset: 0` 的容器，**不画背景、不铺遮罩、不接管点击**；
浮窗自己 `pointer-events: auto`，落在它之外的点击照常交给下面的界面。

窗口形态是**可以拖动、位置固定的浮窗**（`min(880px, 94vw)` × `min(680px, 88vh)`，圆角 14px，投影），
而不是居中弹层：控制台是常驻工具，不该一次只干一件事 —— 一边看输出、一边点开别的面板才是常态，
遮罩会让「打开控制台」变成「进入控制台模式」。所以：

- 没有遮罩，点浮窗外面**不会**关掉它，也不再 `stopPropagation` 拦截整帧；
- 标签条左侧有拖动把手 `⠿`（标签条空白处也能拖），Pointer Events 拖动时实时改 `left/top`，
  并 `clamp` 在视口内；松手把坐标写进 `localStorage`（`dsh-global-cmd:console:v1` 的 `pos`）；
- 双击把手回到居中；窗口尺寸变化（`resize`）时重新夹紧，避免缩窗后浮窗跑到屏幕外；
- 开合状态也一起记住（`open`），刷新页面后仍是上次那个位置、上次那个开合状态。

窗口里只放两种东西：**终端**（标签条 + 输出区 + 内联提示符）和按需弹出的浮层（命令库 / 表单 / 设置）。
命令库曾经常驻在窗口上方，结果它抢走了终端一半的高度，用户拿红叉把它划掉了；
现在它改成 `Ctrl+K` 的浮层，主界面就是纯终端。提示符也不再单独占一行，
而是嵌在输出区最后一行 —— 这才像终端，也顺手解决了「历史输出只能看不能改」：
点任意一条历史命令行，命令会回填到提示符里，改完再回车。

### 观感对齐真实 cmd

第一版是「卡片套卡片」的网页风格：渐变、圆角、❯ 图标、灰色状态栏、一行说明文字。用户直接对比真实
Windows 命令提示符截图要求重做，于是把语义降到「终端该有的样子」：

- 纯黑底（`--dsw-alias-bg-base`）、`Cascadia Mono / Consolas` 等宽、14px、行高 1.42，输出区不再有卡片边框；
- 首屏横幅照 cmd 打开时那两行：`Microsoft Windows [Version …]` + `(c) Microsoft Corporation。保留所有权利。`
  —— 版本号来自 Host `/env` 的 `osVersion`（`os.release()`，如 `10.0.26200`），不在前端硬编码；
- 提示符是 `C:\path>`（PowerShell 终端才是 `PS C:\path>`），输入框紧贴其后、没有边框没有背景，
  没聚焦时才显示一句极淡的占位提示；
- 命令回显也是 `C:\path>命令`（命令行 push 时把当时的 `cwd` 一并存进 line，否则 `cd` 之后老行会跟着变）；
- 空闲时**没有状态栏**（真 cmd 没有），只有命令在跑时才浮出一条 `● 运行中 · 1.2s [停止]`；
  成功命令不打印退出码，只有失败（或你设了超时且真的超时）才补一行淡淡的 `[退出码 7 · 0.4s]`；
- 清屏 / 复制没有常驻状态栏可放了，于是收进标签栏右侧的小按钮（⌫ / ⧉）。

关于「提示符行不要按钮」和 `cd` 复合命令的坑，见下面「cwd：不在 shell 里跑 `cd`」一节。

> 踩过的坑：`ensureStyle()` 早期只在 `<style id>` 不存在时才写 CSS。
> 模块被热替换而页面没刷新时，head 里留着的是**上一版** CSS，新 DOM 的新类名一条规则都没有，
> 整个窗口退化成无样式的流元素、挤在左上角一小条。现在每次挂载都比较并覆写 `style.textContent`。

## 两半结构

```
浏览器（Client）                                  Host 进程
┌───────────────────────────────┐   fetch    ┌──────────────────────────────┐
│ client.js                     │ ─────────▶ │ index.js                     │
│ 入口 → sidebar.footer.action   │            │ webServer prefix 路由         │
│ 浮窗 → shell.overlay          │ ◀───────── │ 命令执行（child_process）     │
│ 终端 / 标签 / 命令库 / 设置     │   轮询     │                              │
└───────────────────────────────┘            └──────────────────────────────┘
                                                      │
                                              <DSH_HOME>/global-cmd/actions.json
```

- **Host 半侧**只用一个服务：`webServer`（`inject = ['webServer']`）。所有路由通过
  `ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/dsh-global-cmd/api', handler}), label)` 注册，
  effect 的清理函数保证插件停用时路由一起撤掉。
- **Client 半侧**只 require `react`（浏览器模块表里的 React 18），不用任何 `@deepseek-ai/*` 客户端包，
  因此不怕 DSH 客户端 API 的版本漂移；UI 全部手写 `React.createElement` + 一段注入 `<style>` 的 CSS，
  配色只引用主题 token（`--dsw-alias-*`），深色/浅色主题都跟着走。

两边唯一的契约就是那几个 HTTP 路由 —— 换 Host 实现不影响 UI，反之亦然。

## 路由设计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 读命令库与全局设置；文件不存在时返回空命令库（不种任何示例） |
| PUT/POST | `/state` | `normalizeState` 归一化后原子写入（临时文件 + `renameSync`） |
| GET | `/env` | `platform`、`dataFile`、`home`、`cwd`、`shells`、`maxTimeoutMs`、`osVersion`、`hostname` |
| GET | `/cwd` | `resolveCwd(path, base, ~)` → `{path, exists, isDirectory}` |
| POST | `/exec` | 建任务，立刻返回 `{id}` |
| GET | `/exec/<id>` | 增量取输出，`?after=<已读 chunk 数>` |
| POST | `/exec/<id>/kill` | 终止进程树 |

**每个请求**先校验 `Host` 头（去端口后必须命中 `localhost` / `127.0.0.1` / 配置的 `trustedHosts`），
否则 `403 不被信任的 Host`。自定义路由不经过 `/api` 的浏览器信任栅栏，这一步必须自己做，否则本机任意网页
都能通过 DNS rebinding 打到这些能执行命令的接口。

### 为什么用轮询而不是 SSE

`webServer.register` 给的是原生 `http.IncomingMessage / ServerResponse`，写 SSE 要自己维持长连接、心跳、
断线重连，还要处理 Electron 里 DevTools 复用连接的行为。而命令输出的量级（几十 KB、几百毫秒粒度）用
150ms 增量轮询完全够用，实现只需一个 `after` 游标：

1. `GET /exec/<id>?after=0` → `chunks` + `next`
2. 客户端 append，把游标记成 `next`
3. `done: true` 时停止轮询并显示退出码

代价是「最后一段输出可能晚 150ms 出现」，换来的是无状态、无连接泄漏、控制台收起/展开都不影响任务。

## 执行：Windows 上的三种 shell

进程一律用 `node:child_process.spawn`（不用 `ctx.subprocess`，避免插件依赖的运行环境差异）。

**cmd.exe**

```js
spawn(process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', '"chcp 65001>nul & ' + command + '"'],
      { windowsVerbatimArguments: true, windowsHide: true })
```

- `chcp 65001` 让中文输出走 UTF-8，否则 GBK 字节会变成乱码。
- **必须** `windowsVerbatimArguments: true`：否则 Node 会把内层引号转义成 `\"`，`/s /c "..."` 的引号语义被破坏。
- 实测通过：带空格路径、`A | B`、`&&`、`^^&`、中文、`exit 7` 的退出码。

**PowerShell 5 / pwsh 7**

```js
['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', base64(utf16le(script))]
```

`-EncodedCommand` 收到的永远是 base64 的 UTF-16LE，绕开命令行编码与引号的所有坑；脚本前缀补
`[Console]::OutputEncoding=[Text.Encoding]::UTF8;` 让输出是 UTF-8。
PowerShell 在非交互下把错误写进 stderr 时会带 `#< CLIXML` 序列化文本，Host 侧会解析 `<S S="Error">…</S>`
并把 `_x000D__x000A_` 之类的转义还原成人能读的换行。

**bash / sh**

`spawn('bash', ['-lc', command])`（WSL / Git Bash 环境可用）。

### 退出码与终止

- `error` 事件（可执行文件不存在，如 ENOENT，退出码会是 -4058）和 `close` 都可能触发，用 `settled` 标志防重复回调。
- 命令默认没有超时；只有请求里带了正数 `timeoutMs` 才装计时器。超时用 `setTimeout(...).unref()`，到点调 `killTree(pid)`：Windows 上 `spawn('taskkill', ['/pid', pid, '/t', '/f'])`，
  这样 `cmd → node → …` 整棵树都会死，不会留下孤儿进程。
- 任务表只保留最近 30 个，输出上限 400KB / 6000 chunks，超了写一条 `[输出已截断]` 的 meta 行。

## cwd：不在 shell 里跑 `cd`

真终端里 `cd` 是 shell 内建命令，起一个一次性进程再 `cd` 是没用的（进程退出，目录也不会留在父进程）。
所以控制台的 `cd` 由 Host 的 `GET /cwd` 解析，客户端把结果写进标签的 `cwd`，后续命令都以它为工作目录启动。

`resolveCwd` 的规则：

| 输入 | 结果 |
| --- | --- |
| 空、`.` | 保持 `base`（当前终端目录） |
| `~`、`~/x` | 系统用户目录（`os.homedir()`），不是 DSH_HOME |
| `D:` | `D:\` |
| 绝对路径 | 原样（存在性仍会检查） |
| 其它 | `path.resolve(base, raw)` |

只剥掉**成对包住整条路径**的引号，不会把路径里的单引号删掉。返回 `{path, exists, isDirectory}`，
客户端据此显示「不是有效的工作目录：…」而不是让进程启动失败。

客户端只在「**纯粹换目录**」时才走这条本地通道：`cd` / `chdir` / `set-location` / `sl` 后面跟着的
如果是一个不含 `&` `|` `;` `<` `>` `^` `` ` `` 的路径，才交给 `/cwd` 解析；一旦含这些字符，整行原样丢给
真正的 shell。这条规则来自一次真实翻车：用户输入

```
cd /d D:\workspace\project\aigc_platfrom_back && mvn -pl ruoyi-admin -am clean install -DskipTests -P local
```

早期版本用 `/^(?:cd|chdir|set-location|sl)(?:\s+(.*))?$/` 抓整行，把 `D:\… && mvn …` 整串当成路径去解析，
于是「不是有效的工作目录：D:\… && mvn …」刷了三遍，命令根本没跑。现在 `cd` 的 `/d` 开关（`cd /d X`、
`cd /d"X"`）在本地剥掉，复合命令则完整进 shell —— cmd 自己会把 `/d` 处理好。

### 提示符行不放按钮

提示符行里只有「目录 + 提示符 + 输入框」：回车就执行，停止是运行中才出现的状态栏按钮（或 `Esc`），
shell 用 `shell bash` / `shell powershell` 这类内置命令切换。早期把 shell 下拉框和「运行」按钮塞在输入框右边，
两个控件叠在输出文字上、还抢走输入框宽度（用户画红框点名要去掉），于是整体收进状态栏与内置命令。

## 数据归一化

`normalizeState` 把不可信输入（手改的 JSON、旧版本数据）洗干净：

- 没有 `command` 的条目直接丢弃；`command` 截断到 8000 字符；`name/group/description/cwd` 限长。
- 非法 `shell` → `auto`；非法 `timeoutMs` → 120s，且不超过 `maxTimeoutMs`（默认 30min）。
- 命令库永远是**用户自己的**：不种任何示例。旧版本自动写入的三条示例（查看当前目录 / Git 状态 / Node 版本，
  分组「示例」）由 `isLegacySeed` 在归一化时静默丢掉 —— 只认「名称 + 命令 + 分组」三者都还对得上的，
  用户改过的条目不会被误删。
- 写入前 `mkdirSync(dirname)`，写临时文件再 `renameSync`，避免半截文件。

## 客户端渲染要点

- 状态是一个极小的 external store（`subscribe / getSnapshot / set`）配 `useSyncExternalStore`，
  不引入任何状态库。
- 输出区只渲染 `{kind, text}` 行的数组，`MAX_LINES = 3000` 时从头部裁剪；每行 `white-space: pre-wrap`，
  自动滚到底部。提示符作为最后一行也在这个滚动容器里，所以输出变长时它会自然往下推。
- 历史命令行可点（`.gcmd-line-reuse`）：点击只做 `patchTab({draft})` + 聚焦输入框，不重跑命令；
  提示符的本地 `draft` 由 `tab.draft` 的变化同步回来。
- 供应链条很小：`localStorage` 存布局，`fetch` 说话，CSS 一次性注入 `<style id="dsh-global-cmd-style">`
  （每次挂载都比较并覆写，避免热替换后沿用旧 CSS）。
- `\r\n` 在拆行前统一成 `\n`，否则 Windows 输出会在每行之间多出空行。
- 快捷键提示按平台生成（Windows 显示 `Ctrl+K`，macOS 显示 `⌘K`）。
- 主色 token 只用来当**文字色/边框色**，不当填充底色：`--dsw-alias-brand-primary` 在某些主题下解析为浅色，
  拿它铺底色再配白字会变成「白底白字」（保存按钮踩过一次），所以主按钮用固定的 `#3b6ef0` + 白字。

## 扩展点

- 想加「命令模板变量」（如 `${cwd}`）→ 在 Host 的 `startJob` 里做替换，客户端不用动。
- 想换持久化方式（SQLite、云端同步）→ 只改 `readState / writeState`。
- 想加「定时执行 / 保存输出到文件」→ 复用 `jobs` 表，加一个 `GET /exec/<id>/download` 路由即可。
