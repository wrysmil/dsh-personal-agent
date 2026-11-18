# dsh-global-cmd · 全局控制台

挂在 DeepSeek Harness 界面上的**常驻命令控制台**：与会话无关，切会话、开新会话、没开会话都一直在。
它是一个真的终端（提示符 + 命令 + 实时输出，可开多个），自定义命令收进「命令库」，点一下或按回车就执行。

---

## 它解决什么

DSH 里的 Echo/终端工具都是**跟着会话走**的：命令绑在某条会话的工具调用里，会话切走就看不到了，想跑一条 `git status`
还得让模型替你去调用。这个插件把「执行本机命令」变成界面上的常驻能力：

- **不依赖会话**：入口在 `sidebar.footer.action`（root 作用域），控制台主体在 `shell.overlay`（frame-wide 悬浮层），都属于整个应用框架，不是某条会话。
- **终端优先**：打开就是标签条 + 输出区 + 内联提示符，命令库收进 `Ctrl+K` 浮层，主界面不堆按钮、示例、说明文字。
- **多终端**：标签页并存，每个终端有自己的 shell、工作目录、命令历史、输出；点标签上的 ✕ 会先弹一个确认框，确认后才真的关。
- **自定义命令**：命令库里保存常用命令，点击即执行；支持分组、指定 shell、指定工作目录、二次确认。

---

## 安装

插件是一个本地 bundle 目录：`D:\workspace\dsh-plugins\dsh-global-cmd`。

```bash
# 在 DSH 里（Agent 侧）执行
plugin_manager action=install_bundle target=D:\workspace\dsh-plugins\dsh-global-cmd
```

安装成功后 Host 会用 `webServer` 注册 `/dsh-global-cmd/api/*`，Client 会在 `shell.overlay` 挂上控制台，
**不需要重启 DSH**。改代码后重新加载：`plugin_manager action=set_bundle target=dsh-global-cmd enabled=false`，
再 `enabled=true`（Host 半侧会重新加载；Client 半侧热替换）。

> 注意：它是 **bundle** 不是 plugin，所以用 `set_bundle`，不是 `set_plugin`。

---

## 打开与关闭

| 操作 | 说明 |
| --- | --- |
| 点侧栏底部 **❯_ 控制台** | 展开 / 收起控制台（入口与「设置」并排在侧栏底部） |
| `Ctrl+Shift+K` | 展开 / 收起控制台（Windows；macOS 为 `⌘⇧K`） |
| `Esc` | 逐层关闭：先关表单 / 设置，再收起控制台 |
| 标签条最右 **✕** | 收起控制台（**不会**因为点别处而收起） |
| 拖标签条左侧 **⠿** 把手（或标签条空白处） | 把窗口移到任意位置，松手后记住坐标 |
| 双击 **⠿** 把手 | 回到屏幕中央 |

入口是界面镶边里的一个普通按钮（和你熟悉的「设置」同一排），**不悬浮在内容上**，不会挡住编辑区或输入框；
侧栏收起成 56px 窄条时只显示图标，展开时带「控制台」文字。

打开后是一个**可以拖动、位置固定的浮窗**（`min(880px, 94vw)` × `min(680px, 88vh)`，圆角 14px、投影，没有遮罩、
不会拦截浮窗之外的点击）：可以一边用它、一边照常点开别的面板；位置和开合状态都会写进
`localStorage`，刷新页面后回到你上次放的地方（关掉就是关着，不会再自动弹）。

```
⠿ 命令提示符 ✕  Windows PowerShell ✕   ＋     ⌫  ⧉  ⌘K 命令库  ⚙  ✕
┌ 输出区（纯黑底 + 等宽字体，就是 cmd 的样子）────────────┐
│ Microsoft Windows [Version 10.0.26200]                  │
│ (c) Microsoft Corporation。保留所有权利。                 │
│                                                         │
│ C:\Users\me\proj>git status --short                     │
│ fatal: not a git repository (or any of the parent ...)   │
│ C:\Users\me\proj>▌                                      │
└─────────────────────────────────────────────────────────┘
```

窗口主体就是终端，观感照 Windows 命令提示符来：**深黑底 + 极淡扫描线、等宽字体、提示符是「路径 >」**
（路径与 `>` 用冷青色并带一点辉光），命令回显成 `C:\path>命令`（路径那段偏青、命令本身是正文色）。
没有气泡、没有说明文字、**没有「运行中」状态条**。标签栏右侧那排小按钮是
**⌫ 清屏 / ⧉ 复制全部输出 / ⌘K 命令库 / ⚙ 偏好 / ✕ 收起**；命令在跑的时候，
**窗口顶沿会亮起一条流动光带** —— 点它就是「停止」，标签上同时亮一个小橙点。命令库是 `Ctrl+K`
打开的浮层，不占主界面。

收起后界面完全恢复原样，不残留任何浮层。

---

## 控制台怎么用

- 在最后一行提示符后面直接敲命令回车 → 后台执行，输出**实时**追加到上方（stdout 正常色、stderr 红色、提示灰色）。
- 点上面任意一条历史命令行（`C:\path>命令`）→ 把那条命令**放回提示符**，改几个字再回车；点输出区空白也能把焦点交回提示符。
- `↑` / `↓` 翻历史命令。
- 命令跑起来后窗口顶沿出现一条流动光带，点它（或按 `Esc`）终止整棵进程树（Windows 用 `taskkill /t /f`）。
- 失败的命令会在输出里补一行淡淡的 `[退出码 7 · 0.4s]`；成功的命令像真 cmd 一样不啰嗦。命令**默认不限时**，一直跑到自己结束，或者你按「停止」/关掉这个标签。
- 提示符里显示的完整工作目录，`cd` 之后立刻跟着变。

### 内置的终端命令（本地处理，不起进程）

| 命令 | 行为 |
| --- | --- |
| `cd` / `cd ~` | 回家目录（系统用户目录） |
| `cd ..`、`cd sub\dir`、`cd D:\x`、`cd /d D:\x` | 解析并切换工作目录，失败会提示「不是有效的工作目录」 |
| `shell` / `shell bash` / `shell powershell` | 查看 / 切换**当前终端**的 shell（不再占用提示符行里的下拉框） |
| `cls` / `clear` | 清空当前终端输出 |
| `exit` | 关闭当前终端（同样会先弹确认框） |

只有「纯粹切换目录」的 `cd` 才在本地处理；**带 `&&`、`|`、`;`、`>` 的复合命令整行原样交给 shell**，
例如 `cd /d D:\workspace\project\aigc_platfrom_back && mvn -pl ruoyi-admin -am clean install -DskipTests -P local`
会整行在 cmd 里执行（不会再把后半截当成目录名报错）。其它命令一律交给真正的 shell 执行。

### 多终端

标签条上的 **＋** 新建（`Ctrl+T`），点标签切换（`Ctrl+1..9` 直达），标签上的 **✕** 或 `Ctrl+W` 关闭当前终端 —— 这三种方式都会先弹一个确认框（`Enter` 确认、`Esc` 取消）；终端里还有命令在跑时按钮会变成「终止并关闭」，提示会告诉你命令会被一起终止。
每个终端独立保存：shell、工作目录、历史、输出。关掉最后一个终端会自动补一个新的，不会关成空白。
终端结构（shell + 目录）与活动终端位置存在 `localStorage`，重开 DSH 能恢复。

---

## 命令库（自定义命令）

命令库是 `Ctrl+K` / `Tab` / 标签条右侧「命令库」按钮打开的**浮层**，主界面不被它占地方：

- 搜索框按名称 / 命令 / 分组 / 说明过滤；`↑↓` 选择，`Enter` 执行。
- 每行右侧 hover 出现「编辑」可改这条命令；浮层底部「＋ 新建命令」（`Ctrl+N`）。
- 点击条目 / 回车 = 在当前终端执行它的命令（若配了 shell / 工作目录会先应用），执行完浮层自动关闭。

命令库**初始是空的**，只放你自己加的命令（旧版本自动种下的三条示例即使还在数据文件里也会被自动丢掉）。

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| 名称 | 否 | 命令库里显示的标题；留空则取命令首行 |
| 分组 | 否 | 仅用于展示与搜索 |
| 命令 | **是** | 支持多行，例如 `cd /d D:\proj` 换行 `npm run dev` |
| shell | 否 | `自动` / `CMD` / `PowerShell 5` / `PowerShell 7` / `Bash` |
| 工作目录 | 否 | 相对路径按当前终端目录解析；留空沿用当前终端 |
| 说明 | 否 | 命令库里的一句话副标题 |
| 二次确认 | 否 | 执行前弹确认框（危险命令建议打开） |

---

## 快捷键一览

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Shift+K` | 展开 / 收起控制台 |
| `Ctrl+K` | 打开 / 关闭命令库浮层 |
| `Ctrl+N` | 新建命令 |
| `Ctrl+T` | 新建终端 |
| `Ctrl+W` | 关闭当前终端 |
| `Ctrl+L` | 清屏 |
| `Ctrl+C` | 停止当前运行 |
| `Ctrl+1..9` | 切到第 N 个终端 |
| `↑` / `↓` | 历史命令（命令库内为选择） |
| `Tab` | 打开命令库（提示符处） |
| `Esc` | 逐层关闭：先关浮层 → 再停运行中的命令 → 最后收起控制台 |

（macOS 上把 `Ctrl` 换成 `⌘`，界面提示会自动跟随平台。）

---

## 数据与持久化

| 内容 | 位置 |
| --- | --- |
| 命令库 + 全局设置 | `<DSH_HOME>/global-cmd/actions.json`（本机为 `C:\Users\Huangqh\.dsh\global-cmd\actions.json`） |
| 任务登记表 + 每个任务的输出日志 | `<DSH_HOME>/global-cmd/jobs/`（`registry.json` + `<任务 id>.out.log` / `.err.log`） |
| 终端布局（标签、高度、活动标签、正在跑的任务） | 浏览器 `localStorage`，键 `dsh-global-cmd:console:v1` |
| 屏幕上保留的输出行 | 最近 3000 行；磁盘日志按任务保留最近 20 个 |

写入是原子的（临时文件 + rename）。想重置命令库，删掉 `actions.json` 后重新加载插件即可。

### 更新插件、刷新页面时命令不会中断

命令的 stdout/stderr **由 shell 自己重定向进日志文件**（`cmd /c "( 命令 ) 1> 输出.log 2> 错误.log"`，
不是接在本插件进程的管道上），任务清单也落在 `jobs/registry.json` 里，所以：

- 插件升级 / 关→开重载（`set_bundle`）时，正在跑的 `mvn install`、`npm run dev` 继续跑，
  新模块加载时会把它们接回来，输出接着读；
- 浏览器刷新（`Ctrl+R`）时，标签栏会重新接上那条命令，并把之前的输出重新拉一遍；
- 唯一会被丢的是「退出码」和「超时计时器」：如果命令是在插件重载**期间**结束的，退出码显示为未知
  （`[进程已结束（退出码未知）]`）；重载前设的超时也只在旧模块里生效。

> 代价：为了把输出交给子进程自己写文件，命令会被包进 cmd 的分组里执行
> （`cmd /d /s /c "( 你的命令 ) 1> 输出.log 2> 错误.log"`）。所以命令里**不要出现未配对的括号**，
> 其余 `&&`、`|`、`>`、引号都正常。

也可在插件 `cordis.patch.yml` 的 `config` 里覆盖：`dataFile`（换数据文件）、`trustedHosts`（额外信任的 Host 名）、
`maxTimeoutMs`（单条命令超时上限；命令本身默认不限时）。

---

## HTTP 接口（本机专用）

前缀 `/dsh-global-cmd/api`，全部只允许可信 Host（`localhost` / `127.0.0.1`，其余 403）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state` | 读 `{settings, actions}` |
| PUT | `/state` | 归一化后保存 |
| GET | `/env` | 平台、系统版本、主机名、数据文件、家目录、默认 cwd、可用 shell、超时上限 |
| GET | `/cwd?path=&base=` | 解析 `cd` 目标，返回 `{path, exists, isDirectory}` |
| POST | `/exec` | 启动命令 `{command, shell, cwd, timeoutMs}` → `{id}` |
| GET | `/exec/<id>?after=N` | 增量读取输出（poll），`done` 时带退出码 |
| POST | `/exec/<id>/kill` | 终止进程树 |
| GET | `/diag` | 自检：用同一套 spawn + 重定向跑一条固定命令，回显 stdout/stderr 是否落进日志文件 |

---

## 安全

- 路由只绑定 `127.0.0.1`，并且**每个请求都校验 Host 头**，挡掉 DNS rebinding。
- 命令以启动 DSH 的那个用户身份在本机执行 —— 不要在插件的命令库里放敏感凭据。
- 单条命令**默认不限时**：只有你在偏好里设了秒数才会按时终止（上限 30min，填 0 就是不限制）；输出超 400KB 自动截断并提示。
- 插件不引入任何第三方依赖（Host 用 `node:child_process` / `node:fs`，Client 只用 React）。

---

## 卸载

```bash
plugin_manager action=set_bundle target=dsh-global-cmd enabled=false   # 先停用
plugin_manager action=remove_bundle target=dsh-global-cmd              # 再移除
```

命令库数据不会被删除，需要的话手动删 `<DSH_HOME>/global-cmd/actions.json`。

---

## 文件

```
dsh-global-cmd/
├── index.js            Host 半侧：路由 + 命令执行 + 持久化
├── client.js           Client 半侧：控制台 UI（React，无构建）
├── cordis.patch.yml    bundle 插入声明与默认 config
├── locale/{zh,en}.json 插件名与描述
├── icon.svg            插件图标
├── docs/DETAIL.md      实现细节与设计取舍
├── test/smoke.test.mjs Host 侧冒烟测试（node --test test/）
└── README.md
```
