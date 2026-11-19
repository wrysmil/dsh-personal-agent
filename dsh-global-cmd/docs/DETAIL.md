# 实现细节与设计取舍

## 为什么它不需要会话

DSH 的会话级注入点（`conversation.composer.dock`、`conversation.input.right` 等）都挂在某条会话的渲染树上，
会话销毁就消失。本插件的主界面只用两个 **root 作用域** 的挂载点：

| 挂载点 | 作用域 | 放什么 |
| --- | --- | --- |
| `sidebar.footer.action` | root | 侧栏底部那个「❯_ 控制台」入口按钮，与「设置」并排 |
| `shell.overlay` | root | 控制台浮窗与命令库/表单浮层 |

另有一个 session 作用域的挂载点，只用来在**聊天代码块右下角**补一个「收藏到 CMD」按钮：

| 挂载点 | 作用域 | 放什么 |
| --- | --- | --- |
| `conversation.chat.markdown.fence` | session | 代码块工具条（按语言注册 layer，`key` = 小写围栏语言） |

围栏层是 `hoc` 槽位：`entryKey` 就是围栏语言，层拿到 `{ lang, code, streaming, meta, children }`。
**渲染 `children` 才是「装饰」**（保留 Chat 原来的代码块，只额外加一条工具条）；不渲染 `children` 就成了「替换」。
所以这里只做装饰，另外顺手兜一层：万一 `children` 是空的，就自己用 `<pre><code>` 还原代码，绝不把代码弄丢。
流式输出阶段（`streaming`）代码还没写完，直接原样返回 `children`，等落定再出现按钮。

槽位没有通配符 key，只能按语言逐个注册（`bash`/`sh`/`shell`/…/`powershell`/`ps1`/`pwsh`/`cmd`/`bat`/`batch`），
每个语言的 `id` 都是 `dsh-global-cmd:fence/<lang>`，卸载时逐个 dispose。

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
- 空闲时**没有任何状态条**；命令在跑时窗口顶沿亮起一条流动光带（`.gcmd-progress`，2px 渐变 + `gcmd-scan`
  动画，hover 变 3px），**点它就是停止**，标签上同时亮一个橙色脉冲小点（`.gcmd-tab-dot`）。
  用户明确要求去掉「运行中 · 1.2s [停止]」那类文字条，所以运行状态只用光带表达；
  成功命令不打印退出码，只有失败（或你设了超时且真的超时）才补一行淡淡的 `[退出码 7 · 0.4s]`；
- 清屏 / 复制没有常驻状态栏可放了，于是收进标签栏右侧的小按钮（⌫ / ⧉）。
- 关终端要确认：✕、`Ctrl+W`、`exit` 都只调 `requestClose(tabId)`，由 `.gcmd-modal` 这个
  盖在浮窗上的小卡片问一次；确认框开着时键盘只认 `Enter`（确认）和 `Esc`（取消），
  别的快捷键不抢按键。终端里还有命令在跑时措辞变成「终止并关闭」，确认后才会真的 `kill`。

### 观感：从「朴素 cmd」到冷色 HUD

第三轮用户反馈「有些丑、简陋，要科技炫酷」，于是在「终端的语义」不变的前提下换了一层皮：

- 控制台自带一套局部配色变量（定义在 `.gcmd-root` 上，不跟主题走）：
  `--gcmd-accent: #35e6c5`（冷青）、`--gcmd-accent-2: #4d9bff`、`--gcmd-bg: #06090d`、`--gcmd-line: #17222d` 等；
  **不再拿主题 token 当填充色**（`--dsw-alias-brand-primary` 在浅色主题下会变成浅色，配白字直接看不见，踩过）；
- 窗口：深黑渐变 + 冷青 1px 边框 + 外层辉光，顶沿一道「通电」发光细线（`.gcmd-dock::before`），圆角收到 8px；
- 输出区：纯黑底之上叠极淡的横向扫描线 + 顶部一点冷青径向光晕（`repeating-linear-gradient` + `radial-gradient`），
  文字 `#dbe4ec`；回显行的 `C:\path>` 用半透明冷青（`.gcmd-echo-path`）与命令正文区分开；
- 提示符：路径与 `>` 用冷青并带 `text-shadow` 辉光，光标 `caret-color` 也是冷青；
- 标签栏：金属条观感，活动标签淡青色渐变 + 底部发光下沿；工具按钮 hover 变冷青；
- 弹层（命令库 / 编辑 / 偏好 / 关闭确认 / toast）：深色玻璃 + 冷青描边 + 柔和外阴影，主按钮仍是蓝色渐变（保证白字可读）。

> 踩过的坑：`ensureStyle()` 早期只在 `<style id>` 不存在时才写 CSS。
> 模块被热替换而页面没刷新时，head 里留着的是**上一版** CSS，新 DOM 的新类名一条规则都没有，
> 整个窗口退化成无样式的流元素、挤在左上角一小条。现在每次挂载都比较并覆写 `style.textContent`。
>
> 另一个坑：CSS 模板字符串里不能出现反引号（注释里也不行），会让 `node --check` 报
> `SyntaxError: Unexpected identifier`。

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
- 输出**不按字节数截断**。内存里的 chunks 只是「界面还没读走的增量窗口」：`MAX_CHUNKS = 200000` 行，
  `trimChunks()` 只回收「`job.served` 已经读走」的前缀（`dropped` 同步累加，客户端的绝对游标因此不会错位）；
  没有客户端在读时一行都不丢。完整日志始终在磁盘上，`GET /exec/<id>/log?stream=out|err` 直接回原文件。
- 任务表只保留最近 20 个（`JOBS_KEEP`），但正在跑的任务不会被淘汰。

### 为什么输出不接管道，而是让子进程直接写文件

第一版是 `spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] })` + `stdout.on('data')`。看着正常，但
**插件每次更新（bundle 关→开）都会把旧模块连同它的管道一起扔掉**：JS 侧没人读管道了，子进程的下一次写
要么撞到已关闭的 fd、要么被 64KB 背压卡住 —— 表现就是「你正在跑的 `mvn install` 被更新弄死了」。

现在改成：

- 每个任务两个日志文件 `<id>.out.log` / `<id>.err.log`，**由 shell 自己重定向进去**：
  `cmd /d /s /c "( 你的命令 ) 1> "输出.log" 2> "错误.log""`（`windowsVerbatimArguments: true` 保住内层引号）。
  文件句柄从进程创建那一刻就归子进程所有，父进程连 `stdio` 都不用接（`stdio: 'ignore'`）；
- PowerShell / pwsh 也套一层 cmd 做重定向（`-EncodedCommand` 的 base64 里没有 cmd 元字符），
  脚本开头仍设 `[Console]::OutputEncoding = UTF8`，所以落到文件里的是 UTF-8；
  bash / sh 则在脚本里加 `{ … } 1> '…' 2> '…'`，Windows 路径转成 msys 认得的 `/c/...`；
- 任务清单落在 `jobs/registry.json`（含 pid、两个日志路径、起止时间、退出码），
  `apply()` 时 `recoverJobs()` 先把它读回来，`process.kill(pid, 0)` 判断还活着没有；
- 轮询时按字节偏移把新增的「完整行」读进 chunks（`drainJob`），只按 `\n` 切，绝不在多字节字符中间截断；
- registry 写入是「读旧文件 → 按 id 合并 → 写回」，旧模块先记下的退出码不会被新模块的 `null` 盖掉。

> **踩过的坑**：中间试过「父进程 `openSync(logfile)`，把 fd 传给 `spawn` 的 `stdio`，spawn 完立刻
> `closeSync` 自己那份」。这套写法在普通 Node 里常见，但在打包版 DSH 进程里实测**日志文件一直是 0 字节**，
> 命令照跑、退出码正确，就是抓不到任何输出。与其在句柄继承上继续赌，不如让 shell 自己开文件 —— 语义更直白，
> 也不依赖父进程的 fd 表。`GET /diag` 就是用来验这条链路的：它跑一条固定的
> `echo probe-stdout & echo probe-stderr 1>&2`，把 stdout/stderr 的实际内容回给你看。

代价（可接受）：如果命令恰好在重载窗口内结束，新模块拿不到 `close` 事件 → 退出码显示「未知」；
重载前设的超时计时器也随旧模块一起没了，重载后的任务不会再自动超时（可以手动停）。
另外命令被包进 `( )` 分组，所以命令里不能有未配对的括号。

任务日志保留最近 20 个，被淘汰的任务连同日志文件一起删掉。

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

提示符行里只有「目录 + 提示符 + 输入框」：回车就执行，停止是**顶沿那条流动光带**（点它，或按 `Esc`），
shell 用 `shell bash` / `shell powershell` 这类内置命令切换。早期把 shell 下拉框和「运行」按钮塞在输入框右边，
两个控件叠在输出文字上、还抢走输入框宽度（用户画红框点名要去掉），于是整体收进内置命令与顶沿光带。

### 多行命令为什么要落成 .cmd 文件

`cmd.exe` 解析 `/c` 参数时**遇到换行就截断**，后面的行被静默丢掉：

```
cmd /d /s /c "echo a<CRLF>echo b"   →   只打印 a
```

所以「命令支持换行」只改前端输入框是不够的 —— 真发下去也跑不出来。现在的做法是：

- 前端提示符是 `<textarea rows=1>`，`Enter` 执行、`Shift+Enter`（或 `Alt+Enter`）换行，
  内容含换行时右侧显示 `Shift+Enter 换行` 提示，输入框跟着内容长高（上限 168px，再高就在框内滚）。
  多行时 `↑` / `↓` 先当光标移动，只有光标贴在首/尾才翻历史。
- 后端 `buildSpawnSpec` 发现命令里有换行，就把命令（`CRLF` 归一成 `\n`，前置 `@echo off`）写成
  `<jobs>/<id>.cmd`，再用 `chcp 65001>nul & ( call "<脚本>" ) 1> out 2> err` 执行。
  `call` 而不是直接跑脚本：块里直接起 `.cmd` 会把控制权交出去，`call` 才能把退出码带回来。
  单行命令仍走原来的 `( 命令 )` 包装，没有多一次文件 IO。
- 本地拦截（`cls` / `exit` / `shell X` / `cd X`）只对**单行**命令生效。多行脚本里只要有一行以 `cd`
  开头，整段就会被当成换目录而吞掉，所以含换行时一律直接交给 shell。

### 大输出为什么不卡了

日志是 shell 自己重定向进文件的（句柄归子进程，插件重载不打断命令），代价是读它得精打细算：

- 旧版 `drainJob` 每轮 `readFileSync` **整个日志**。8MB 的输出在命令跑着的十几秒里，
  每 80ms 就被完整读一遍并分配一次，Host 的事件循环全耗在这上面。现在按 `job.offsets` 只读
  新增的那一段（单轮上限 1MB），半行留在 `job.pending`，多字节字符由 `StringDecoder` 续上，
  不会在汉字中间切出乱码；日志被截断（`size < offset`）时游标自动归零。
- 一次最多回 `MAX_CHUNKS_PER_POLL = 4000` 个 chunk，没送完时返回 `more: true`，客户端拿到就
  立刻要下一批（`setTimeout(tick, 0)`），输出是渐进刷出来的，不会等满一个轮询周期。
  还有没送完的批次时 `done` 保持 `false`，否则客户端一看到 `done` 就停轮询、剩下的输出没人要。
- 界面只把最后 `TAIL_LINES = 600` 行挂进 DOM，更早的用一个虚线按钮按 `MORE_LINES = 2000` 往上翻
  （翻的时候按 `scrollHeight` 差值把视口一起下移，正在看的那几行不会跳）。以前两万行全在 DOM 里，
  每来一批输出都要重新排版。
- 滚动条不再无条件贴底：只有本来就在底部（距底 < 24px）时才跟随新输出，往上翻看历史时视线不会被顶走。

### 清屏连输入框一起清

`cls` / `clear`、工具栏 `⌫`、`Ctrl+L` 都走同一个语义：`patchTab({ lines: [], exit: null, draft: '' })`。
早期只清 `lines`，输入框里没执行的那半截命令还杵在那儿，看着像没清干净。

### 长命令自动折行

提示符是 `<textarea>`，`wrap="soft"` + `white-space: pre-wrap` + `overflow-wrap: anywhere`：

- 命令超过框宽就折到下一行，不再横向裁掉半截 —— 一条几百字符的 `git commit -m "..."` 也能整段看全。
- `soft` 只是**显示**折行，`value` 里不会多出换行符，执行时仍是同一条命令；`overflow-wrap: anywhere`
  让没有空格的长路径/URL 也能断开。
- 折行后的续行要回到**左边距**、吃满整行，和真终端一样 —— 早先提示符是 flex 行（`路径> | 输入框`），
  折出来的每一行都被挤在「路径>」右边那条窄缝里。现在「路径>」绝对定位在第一行（`.gcmd-prompt-prefix`），
  输入框 `width: 100%`，用 `text-indent`（= 量出来的前缀宽度）把**第一行**让开：
  textarea 的 `text-indent` 只作用于第一行，续行自然从 x=0 开始。
- 前缀宽度每次渲染都用 `getBoundingClientRect()` 量（很便宜），字体加载完或换目录后能跟上；
  目录过长时按 `max-width: 70%` + 省略号收尾，「>」不会被顶出可视区。

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
- 输出区只渲染 `{kind, text}` 行的数组，`MAX_LINES = 20000` 时从头部裁剪（只影响屏幕回滚，完整日志走 ⤓ 下载）；
  其中真正挂进 DOM 的只是最后 `TAIL_LINES` 行，更早的点按钮往回翻（见「大输出为什么不卡了」）。
  每行 `white-space: pre-wrap`，贴底时自动跟随，往上翻过就停住。提示符作为最后一行也在这个滚动容器里，
  所以输出变长时它会自然往下推。
- 历史命令行可点（`.gcmd-line-reuse`）：点击只做 `patchTab({draft})` + 聚焦输入框，不重跑命令；
  提示符的本地 `draft` 由 `tab.draft` 的变化同步回来。
- 供应链条很小：`localStorage` 存布局，`fetch` 说话，CSS 一次性注入 `<style id="dsh-global-cmd-style">`
  （每次挂载都比较并覆写，避免热替换后沿用旧 CSS）。
- `\r\n` 在拆行前统一成 `\n`，否则 Windows 输出会在每行之间多出空行。
- 快捷键提示按平台生成（Windows 显示 `Ctrl+K`，macOS 显示 `⌘K`）。
- 主色 token 只用来当**文字色/边框色**，不当填充底色：`--dsw-alias-brand-primary` 在某些主题下解析为浅色，
  拿它铺底色再配白字会变成「白底白字」（保存按钮踩过一次），所以主按钮用固定的 `#3b6ef0` + 白字。

### 同一份命令的两个平台版本

一条 action 有两个命令字段：`command`（Windows）和 `commandLinux`（Linux），两份都为空才算非法条目。
客户端用一个很薄的解析层决定「实际执行什么」：

- `commandPlatform(state)`：`settings.commandPlatform` 是 `windows` / `linux` 就用它，是 `auto`（或缺省）
  时看 `/env` 返回的 `platform`。
- `pickCommand(action, platform)`：优先取对应平台的字段，缺了退回另一个平台的版本 —— 只填一份也能用。
- `pickShell(action, platform)`：切到 Linux 时把 `powershell` / `pwsh` / `cmd` 统一换成 `bash`
  （`LINUX_SHELL_MAP`），否则 `cmd /c` 在 Linux 上根本起不来。
- `effectiveAction(action, state)` 把上面三件事合起来，填输入框、直接执行、条目预览都走它，
  避免「列表里显示 Linux 命令、执行却是 Windows 命令」这种不一致。

平台偏好存在 `settings.commandPlatform`（`auto` / `windows` / `linux`），命令库顶部的平台标签直接读它。
分类筛选不存状态：分组标签从库里现有的 `group` 去重生成，选中项只影响 `filtered`，页码仍由选中项推导。

### PowerShell 的 CLIXML 噪音

PowerShell 在 stdout/stderr 被重定向（不是 TTY）时会开启 `#< CLIXML` 序列化，进度流也一起被写成
`<Obj S="progress">` 记录。修法有两层：

1. 源头：`buildSpawnSpec` 给 PowerShell 脚本加 `$ProgressPreference='SilentlyContinue';`，不再产生进度记录。
2. 兜底：`cleanPowerShellError(text)` 先剥掉 progress 记录与空 `<Objs>`，只把 `<S S="Error">` 还原成文本；
   剥完什么都不剩就返回空串（调用方按行拆分时自动跳过），绝不把整段 XML 原样吐给用户。
   这条路径按 chunk 处理，所以正则必须容忍不完整的块——现在最坏情况是漏掉一段噪音，不会再整段糊出来。

## 扩展点

- 想加「命令模板变量」（如 `${cwd}`）→ 在 Host 的 `startJob` 里做替换，客户端不用动。
- 想换持久化方式（SQLite、云端同步）→ 只改 `readState / writeState`。
- 想加「定时执行 / 保存输出到文件」→ 复用 `jobs` 表，加一个 `GET /exec/<id>/download` 路由即可。
