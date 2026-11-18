/**
 * dsh-global-cmd —— Client 半侧
 *
 * 一个与会话无关的全局控制台：挂在 shell.overlay（frame-wide 悬浮层）上，
 * 不随会话切换，也不占用任何一侧栏。
 *
 * 设计取向：控制台优先。
 *   - 主界面就是一个终端：提示符 + 命令输入 + 等宽输出
 *   - 支持多终端（标签页），每个终端有自己的 shell / 工作目录 / 历史 / 输出
 *   - 自定义命令收进「命令库」（⌘K），点击或回车即可执行，不占主界面
 *   - cd / cls / exit 在本地处理，像真终端一样工作
 *
 * 数据经 Host 路由 /dsh-global-cmd/api 持久化到 <DSH_HOME>/global-cmd/actions.json。
 */
window.__ModuleLoader__.load({
  id: 'dsh-global-cmd',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /* ------------------------------- 常量 ------------------------------- */

    const API = '/dsh-global-cmd/api'
    const STYLE_ID = 'dsh-global-cmd-style'
    const PREFS_KEY = 'dsh-global-cmd:console:v1'
    const POLL_MS = 80
    const FIRST_POLL_MS = 20
    const MAX_LINES = 3000
    const DEFAULT_HEIGHT = 420
    const MIN_HEIGHT = 220
    const MAX_HEIGHT = 900

    const SHELLS = [
      { value: 'auto', label: '自动' },
      { value: 'cmd', label: 'CMD' },
      { value: 'powershell', label: 'PowerShell 5' },
      { value: 'pwsh', label: 'PowerShell 7' },
      { value: 'bash', label: 'Bash' },
    ]
    const SHELL_LABEL = Object.fromEntries(SHELLS.map((s) => [s.value, s.label]))

    /** 标签页名字按终端类型取，像系统终端那样一眼能认出来（目录放在 title 里） */
    const TAB_NAME = {
      auto: '命令提示符',
      cmd: '命令提示符',
      powershell: 'Windows PowerShell',
      pwsh: 'PowerShell 7',
      bash: 'Bash',
    }
    const tabName = (tab) => TAB_NAME[tab.shell] || SHELL_LABEL[tab.shell] || '终端'

    const IS_MAC =
      typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')
    /** 快捷键提示用的修饰键名，避免在 Windows 上显示 ⌘ 让人误解 */
    const MOD = IS_MAC ? '⌘' : 'Ctrl'
    const COMBO = (key) => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`)

    /** 浮窗默认尺寸，必须和 CSS 里 `.gcmd-dock` 的 width / height 保持一致 */
    const dockBox = () => ({
      width: Math.min(880, Math.round(window.innerWidth * 0.94)),
      height: Math.min(680, Math.round(window.innerHeight * 0.88)),
    })

    /** 把浮窗左上角限制在视口内，允许贴边但不允许拖出屏幕 */
    function clampPos(pos) {
      const box = dockBox()
      const maxX = Math.max(0, window.innerWidth - box.width)
      const maxY = Math.max(0, window.innerHeight - box.height)
      const x = typeof pos?.x === 'number' ? pos.x : maxX / 2
      const y = typeof pos?.y === 'number' ? pos.y : maxY / 2
      return { x: Math.round(Math.min(maxX, Math.max(0, x))), y: Math.round(Math.min(maxY, Math.max(0, y))) }
    }

    /** 读回持久化的位置；脏数据一律当作「没存过」，交给 clampPos 居中 */
    function readPos(value) {
      if (!value || typeof value !== 'object') return null
      const x = Number(value.x)
      const y = Number(value.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return { x, y }
    }

    /* ------------------------------ 小工具 ------------------------------ */

    function uid() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    }

    /** 只保留路径尾部，避免长工作目录把提示符挤爆 */
    function shortPath(path, max = 46) {
      const text = String(path || '')
      if (text.length <= max) return text
      return '…' + text.slice(-(max - 1))
    }

    function promptMark(shell) {
      const kind = shell === 'auto' ? 'cmd' : shell
      if (kind === 'powershell' || kind === 'pwsh') return 'PS'
      if (kind === 'bash' || kind === 'sh') return '$'
      return '>'
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '0.0s'
      if (ms < 1000) return `${Math.round(ms)}ms`
      return `${(ms / 1000).toFixed(1)}s`
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /* ------------------------------ 存储 ------------------------------ */

    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writePrefs(patch) {
      try {
        const next = { ...readPrefs(), ...patch }
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        /* 忽略配额/隐私模式错误 */
      }
    }

    /* ------------------------------ HTTP ------------------------------ */

    async function request(path, init) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      }
      return payload
    }

    const api = {
      state: () => request('/state'),
      saveState: (payload) => request('/state', { method: 'PUT', body: JSON.stringify(payload) }),
      env: () => request('/env'),
      cwd: (path, base) => request(`/cwd?path=${encodeURIComponent(path || '')}&base=${encodeURIComponent(base || '')}`),
      exec: (payload) => request('/exec', { method: 'POST', body: JSON.stringify(payload) }),
      poll: (id, after) => request(`/exec/${id}?after=${after}`),
      kill: (id) => request(`/exec/${id}/kill`, { method: 'POST' }),
    }

    /* ------------------------------ 样式 ------------------------------ */

    const CSS = `
/* 悬浮层容器：自身不绘制、不拦截点击，窗口浮在它里面 */
.gcmd-root {
  position: fixed; inset: 0; z-index: 2147482500; pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary, #e9e9ec);
  /* 控制台自己的配色：比主题更冷、更暗，接近 HUD 而不是普通面板 */
  --gcmd-bg: #06090d;
  --gcmd-bg-2: #0a1017;
  --gcmd-bg-3: #0d141c;
  --gcmd-line: #17222d;
  --gcmd-line-2: #22303d;
  --gcmd-accent: #35e6c5;
  --gcmd-accent-2: #4d9bff;
  --gcmd-text: #dbe4ec;
  --gcmd-dim: #78889a;
}
@keyframes gcmd-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes gcmd-pop { from { opacity: 0; transform: scale(.99); } to { opacity: 1; transform: none; } }
.gcmd-root *, .gcmd-root *::before, .gcmd-root *::after { box-sizing: border-box; }
.gcmd-root button { font: inherit; color: inherit; cursor: pointer; }
.gcmd-root input, .gcmd-root textarea, .gcmd-root select { font: inherit; color: inherit; }
.gcmd-root ::selection { background: rgba(53, 230, 197, .26); color: #eafaf6; }

/* 侧栏底部入口（与设置并列，不悬浮在内容上） */
.gcmd-foot {
  box-sizing: border-box; pointer-events: auto;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 30px; min-width: 30px; padding: 0 8px;
  border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary, #a0a0a8);
  font-family: inherit; font-size: 12px; line-height: 1;
  transition: background .15s ease, color .15s ease;
}
.gcmd-foot:hover { background: var(--dsw-alias-bg-layer-2, #26262a); color: var(--dsw-alias-label-primary, #e9e9ec); }
.gcmd-foot[data-open="true"] { color: var(--dsw-alias-brand-primary, #4f8cff); }
.gcmd-foot-glyph { font-family: ui-monospace, Consolas, monospace; font-size: 13px; letter-spacing: -.04em; }
.gcmd-foot-label { white-space: nowrap; }

/* 控制台窗口：可以拖到任意位置并记住位置的固定浮窗 */
.gcmd-dock {
  position: fixed; pointer-events: auto;
  display: flex; flex-direction: column; overflow: hidden;
  width: min(880px, 94vw); height: min(680px, 88vh);
  background: linear-gradient(180deg, #0a1017 0%, #06090d 62%, #05080b 100%);
  border: 1px solid rgba(53, 230, 197, .22);
  border-radius: 8px;
  box-shadow:
    0 26px 70px rgba(0, 0, 0, .68),
    0 0 0 1px rgba(0, 0, 0, .5),
    0 0 46px rgba(53, 230, 197, .07);
  animation: gcmd-pop .12s ease-out;
}
/* 顶边一道发光细线，像设备通电后的状态灯 */
.gcmd-dock::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px;
  background: linear-gradient(90deg, rgba(53, 230, 197, 0), rgba(53, 230, 197, .75) 30%, rgba(77, 155, 255, .55) 70%, rgba(77, 155, 255, 0));
  pointer-events: none; z-index: 6;
}
.gcmd-dock[data-dragging="true"] { user-select: none; }
.gcmd-dock[data-dragging="true"] .gcmd-scroll { pointer-events: none; }

/* 拖动把手（标签栏最左侧，空着的标签栏空白处也可拖） */
.gcmd-drag {
  flex: none; display: grid; place-items: center;
  width: 18px; margin-right: 2px; padding: 0;
  border: 0; background: transparent; border-radius: 6px;
  color: var(--dsw-alias-label-secondary, #7d7d86);
  font-size: 12px; letter-spacing: -1.5px; line-height: 1;
  cursor: grab; user-select: none; touch-action: none;
}
.gcmd-drag:hover { color: var(--dsw-alias-label-primary, #e9e9ec); background: rgba(255, 255, 255, .06); }
.gcmd-drag:active { cursor: grabbing; }

/* 标题行 */
.gcmd-head {
  flex: none; display: flex; align-items: center; gap: 8px;
  height: 42px; padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #34343a);
  background: var(--dsw-alias-bg-layer-2, #26262a);
}
.gcmd-head-glyph { font-family: ui-monospace, Consolas, monospace; font-size: 13px; color: var(--dsw-alias-brand-primary, #4f8cff); }
.gcmd-head-title { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.gcmd-badge {
  font-size: 11px; padding: 1px 7px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #a0a0a8);
  background: var(--dsw-alias-bg-layer-1, #1d1d20);
  border: 1px solid var(--dsw-alias-border-l1, #34343a);
}
.gcmd-head-btn {
  height: 26px; padding: 0 10px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1, #34343a);
  background: transparent; color: var(--dsw-alias-label-secondary, #a0a0a8);
  font-size: 12px; white-space: nowrap;
  transition: background .12s ease, color .12s ease, border-color .12s ease;
}
.gcmd-head-btn:hover { background: var(--dsw-alias-bg-base, #16161a); color: var(--dsw-alias-label-primary, #e9e9ec); border-color: var(--dsw-alias-border-l2, #3a3a41); }
.gcmd-head-icon {
  width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 7px; background: transparent;
  color: var(--dsw-alias-label-secondary, #a0a0a8); font-size: 13px;
}
.gcmd-head-icon:hover { background: var(--dsw-alias-bg-base, #16161a); color: var(--dsw-alias-label-primary, #e9e9ec); }

/* 命令库区 */
.gcmd-lib {
  flex: 0 0 auto; display: flex; flex-direction: column;
  max-height: 38%; min-height: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #34343a);
}
.gcmd-lib-search {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 10px 14px 8px;
}
.gcmd-lib-search input {
  flex: 1; min-width: 0; height: 30px; padding: 0 10px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, #34343a);
  background: var(--dsw-alias-bg-base, #16161a);
  color: var(--dsw-alias-label-primary, #e9e9ec); font-size: 12.5px; outline: none;
}
.gcmd-lib-search input:focus { border-color: var(--dsw-alias-brand-primary, #4f8cff); }
.gcmd-lib-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 8px 8px; }
.gcmd-lib-group {
  padding: 8px 6px 4px; font-size: 11px; letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary, #8f8f97); text-transform: none;
}
.gcmd-lib-row {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 7px 8px; border: 0; border-radius: 8px; background: transparent;
  text-align: left; transition: background .1s ease;
}
.gcmd-lib-row:hover { background: var(--dsw-alias-bg-layer-2, #26262a); }
.gcmd-lib-row[data-active="true"] { background: var(--dsw-alias-bg-layer-2, #26262a); outline: 1px solid var(--dsw-alias-border-l2, #3a3a41); }
.gcmd-lib-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.gcmd-lib-name { font-size: 12.5px; color: var(--dsw-alias-label-primary, #e9e9ec); }
.gcmd-lib-cmd {
  font-family: ui-monospace, Consolas, monospace; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #8f8f97);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gcmd-lib-edit {
  flex: none; height: 22px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, #34343a); background: transparent;
  color: var(--dsw-alias-label-secondary, #a0a0a8); font-size: 11px;
  opacity: 0; transition: opacity .1s ease;
}
.gcmd-lib-row:hover .gcmd-lib-edit { opacity: 1; }
.gcmd-lib-edit:hover { color: var(--dsw-alias-label-primary, #e9e9ec); border-color: var(--dsw-alias-border-l2, #3a3a41); }
.gcmd-lib-empty { padding: 14px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8f8f97); }

/* 控制台窗口（旧 dock 样式，保留兼容） */
.gcmd-grip {
  height: 5px; flex: none; cursor: ns-resize;
  background: transparent; border-bottom: 1px solid transparent;
}
.gcmd-grip:hover { background: var(--dsw-alias-brand-primary, #4f8cff); opacity: .35; }

/* 标签栏：像一块被切出来的金属条，活动标签带发光下沿 */
.gcmd-tabs {
  position: relative; flex: none; display: flex; align-items: stretch; gap: 2px;
  height: 36px; padding: 0 8px;
  background: linear-gradient(180deg, #0c141c, #080d13);
  border-bottom: 1px solid var(--gcmd-line);
}
.gcmd-tab {
  position: relative; display: inline-flex; align-items: center; gap: 6px;
  max-width: 210px; padding: 0 9px; margin: 5px 0; border-radius: 5px;
  background: transparent; border: 1px solid transparent;
  color: var(--gcmd-dim); font-size: 12px; letter-spacing: .01em;
  transition: background .12s ease, color .12s ease, border-color .12s ease;
}
.gcmd-tab:hover { background: rgba(255, 255, 255, .04); color: var(--gcmd-text); }
.gcmd-tab[data-active="true"] {
  background: linear-gradient(180deg, rgba(53, 230, 197, .1), rgba(53, 230, 197, .03));
  border-color: rgba(53, 230, 197, .34);
  color: #eafaf6;
}
.gcmd-tab[data-active="true"]::after {
  content: ''; position: absolute; left: 6px; right: 6px; bottom: -5px; height: 1px;
  background: linear-gradient(90deg, rgba(53, 230, 197, 0), rgba(53, 230, 197, .9), rgba(53, 230, 197, 0));
}
.gcmd-tab-glyph { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--gcmd-accent); opacity: .75; }
.gcmd-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gcmd-tab-dot {
  width: 5px; height: 5px; border-radius: 50%; flex: none;
  background: var(--gcmd-amber, #ffb347);
  box-shadow: 0 0 8px rgba(255, 179, 71, .9);
  animation: gcmd-pulse 1.1s ease-in-out infinite;
}
.gcmd-tab-close {
  display: grid; place-items: center; width: 15px; height: 15px; padding: 0;
  border: none; border-radius: 3px; background: transparent;
  color: var(--gcmd-dim); font-size: 12px; opacity: 0;
  transition: opacity .12s ease, background .12s ease, color .12s ease;
}
.gcmd-tab:hover .gcmd-tab-close, .gcmd-tab[data-active="true"] .gcmd-tab-close { opacity: 1; }
.gcmd-tab-close:hover { background: rgba(255, 95, 109, .18); color: #ff5f6d; }
.gcmd-tabs-spacer { flex: 1; cursor: grab; }
.gcmd-tabs-spacer:active { cursor: grabbing; }

.gcmd-tool {
  display: inline-flex; align-items: center; gap: 5px; align-self: center;
  height: 26px; padding: 0 8px; margin-left: 4px;
  border-radius: 5px; border: 1px solid transparent; background: transparent;
  color: var(--gcmd-dim); font-size: 12px;
  transition: color .12s ease, background .12s ease, border-color .12s ease;
}
.gcmd-tool:hover {
  color: var(--gcmd-accent); background: rgba(53, 230, 197, .1);
  border-color: rgba(53, 230, 197, .26);
}
.gcmd-tool[data-active="true"] { color: var(--gcmd-accent); border-color: rgba(53, 230, 197, .34); }
.gcmd-tool-icon { font-size: 13px; line-height: 1; }
.gcmd-kbd {
  font-family: ui-monospace, Consolas, monospace; font-size: 10px; opacity: .55;
  padding: 1px 4px; border-radius: 3px; border: 1px solid var(--gcmd-line-2);
}

/* 输出区：纯黑底 + 极淡扫描线，等宽字体，像一块通电的终端屏 */
.gcmd-scroll {
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  padding: 12px 14px 8px;
  background-color: var(--gcmd-bg);
  background-image:
    radial-gradient(120% 70% at 50% 0%, rgba(53, 230, 197, .06), transparent 62%),
    repeating-linear-gradient(0deg, rgba(255, 255, 255, .014) 0 1px, transparent 1px 3px);
  color: var(--gcmd-text);
  font-family: "Cascadia Mono", Consolas, "Courier New", ui-monospace, monospace;
  font-size: 14px; line-height: 1.44;
  scrollbar-width: thin;
  box-shadow: inset 1px 0 0 rgba(53, 230, 197, .1), inset 0 1px 0 rgba(53, 230, 197, .05);
}
.gcmd-scroll::-webkit-scrollbar { width: 10px; }
.gcmd-scroll::-webkit-scrollbar-thumb { background: rgba(53, 230, 197, .18); border-radius: 6px; border: 3px solid transparent; background-clip: content-box; }
.gcmd-scroll::-webkit-scrollbar-thumb:hover { background: rgba(53, 230, 197, .32); background-clip: content-box; }
.gcmd-line { white-space: pre-wrap; word-break: break-word; padding: 0; }
.gcmd-line[data-kind="cmd"] { display: block; margin-top: 0; color: var(--gcmd-text); }
.gcmd-line[data-kind="out"] { color: var(--gcmd-text); }
.gcmd-line[data-kind="err"] { color: #ff6f7d; }
.gcmd-line[data-kind="info"] { color: var(--gcmd-dim); }
/* 回显行里那段「C:\path>」用冷色，命令本身保持正文色 */
.gcmd-echo-path { color: rgba(53, 230, 197, .72); }
/* cmd 里回显的那一行 = 「C:\path>命令」，整行可点，点回输入框改 */
.gcmd-line-reuse { cursor: pointer; border-radius: 3px; }
.gcmd-line-reuse:hover { background: rgba(53, 230, 197, .09); }
/* 首屏横幅：Microsoft Windows [Version …] + 版权行 */
.gcmd-banner { white-space: pre-wrap; padding: 0 0 12px; color: var(--gcmd-dim); }

/* 提示符：紧接在输出区最后一行，「路径>」之后直接打字 */
.gcmd-prompt {
  display: flex; align-items: baseline; gap: 0;
  margin-top: 0; padding: 2px 0 0;
  background: transparent;
  font-family: inherit; font-size: inherit; line-height: inherit;
}
.gcmd-path {
  flex: none; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--gcmd-accent); user-select: none;
  text-shadow: 0 0 14px rgba(53, 230, 197, .28);
}
.gcmd-prompt-mark {
  flex: none; color: var(--gcmd-accent); user-select: none;
  text-shadow: 0 0 14px rgba(53, 230, 197, .34);
}
.gcmd-input {
  flex: 1; min-width: 0; height: 1.44em; padding: 0; border: none; outline: none;
  background: transparent; color: #eef7fb;
  font-family: inherit; font-size: inherit; line-height: inherit;
  caret-color: var(--gcmd-accent);
}
.gcmd-input::placeholder { color: #4d5b69; }

/* 命令在跑的时候，只让窗口顶沿亮起一条流动光带：点它等于「停止」，不再放状态文字 */
.gcmd-progress {
  position: absolute; left: 0; right: 0; top: 0; height: 2px; z-index: 7;
  cursor: pointer;
  background-image: linear-gradient(90deg, rgba(53, 230, 197, 0), var(--gcmd-accent) 34%, var(--gcmd-accent-2) 66%, rgba(77, 155, 255, 0));
  background-size: 220% 100%;
  animation: gcmd-scan 1.5s linear infinite;
}
.gcmd-progress:hover { height: 3px; }
@keyframes gcmd-scan { from { background-position: 0% 0; } to { background-position: 220% 0; } }
@keyframes gcmd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
.gcmd-spacer { flex: 1; }

/* 命令库 / 弹层 */
.gcmd-overlay {
  position: absolute; inset: 0; display: flex; align-items: flex-start; justify-content: center;
  padding-top: 46px; background: rgba(0, 0, 0, .42); backdrop-filter: blur(1px);
  animation: gcmd-fade .12s ease-out;
}
@keyframes gcmd-fade { from { opacity: 0; } to { opacity: 1; } }
.gcmd-sheet {
  width: min(620px, calc(100% - 40px)); max-height: calc(100% - 84px);
  display: flex; flex-direction: column; overflow: hidden;
  background: linear-gradient(180deg, #0c131a, #070b10);
  border: 1px solid rgba(53, 230, 197, .2); border-radius: 8px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, .62), 0 0 40px rgba(53, 230, 197, .06);
}
.gcmd-sheet-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--gcmd-line);
  color: var(--gcmd-text); font-size: 12.5px; letter-spacing: .02em;
}
.gcmd-sheet-title { font-weight: 600; }
.gcmd-sheet-count { color: var(--gcmd-dim); font-size: 11.5px; }
.gcmd-sheet-close {
  margin-left: auto; display: grid; place-items: center; width: 22px; height: 22px;
  border: none; border-radius: 5px; background: transparent;
  color: var(--dsw-alias-label-secondary, #8b8b94);
}
.gcmd-sheet-close:hover { background: rgba(255, 255, 255, .1); color: var(--dsw-alias-label-primary, #fff); }
.gcmd-filter {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #34343a);
}
.gcmd-filter-input {
  flex: 1; height: 26px; padding: 0 8px; border-radius: 5px;
  border: 1px solid var(--gcmd-line-2);
  background: var(--gcmd-bg); outline: none;
  color: var(--gcmd-text); font-size: 12.5px;
}
.gcmd-filter-input:focus { border-color: rgba(53, 230, 197, .5); box-shadow: 0 0 0 1px rgba(53, 230, 197, .18); }
.gcmd-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
.gcmd-item {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 7px 9px; border: 1px solid transparent; border-radius: 7px;
  background: transparent; text-align: left;
}
.gcmd-item[data-active="true"] {
  background: linear-gradient(90deg, rgba(53, 230, 197, .13), rgba(53, 230, 197, .03));
  border-color: rgba(53, 230, 197, .38);
}
.gcmd-item-mark { flex: none; color: var(--gcmd-accent); font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.gcmd-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.gcmd-item-name { color: var(--dsw-alias-label-primary, #e9e9ec); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gcmd-item-cmd {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #8b8b94);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gcmd-item-tag {
  flex: none; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8b8b94);
  padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #34343a);
}
.gcmd-item-edit {
  flex: none; height: 22px; padding: 0 8px; border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1, #34343a); background: transparent;
  color: var(--dsw-alias-label-secondary, #8b8b94); font-size: 11.5px; opacity: 0;
}
.gcmd-item:hover .gcmd-item-edit, .gcmd-item[data-active="true"] .gcmd-item-edit { opacity: 1; }
.gcmd-item-edit:hover { color: var(--dsw-alias-label-primary, #fff); border-color: var(--dsw-alias-brand-primary, #4f8cff); }
.gcmd-empty-row { padding: 16px 12px; color: var(--dsw-alias-label-secondary, #8b8b94); font-size: 12px; }
.gcmd-sheet-foot {
  display: flex; align-items: center; gap: 10px; padding: 7px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, #34343a);
  color: var(--dsw-alias-label-secondary, #7f7f88); font-size: 11.5px;
}
.gcmd-sheet-foot .gcmd-spacer { flex: 1; }
.gcmd-foot-btn {
  height: 22px; padding: 0 9px; border-radius: 5px; font-size: 11.5px;
  border: 1px solid var(--dsw-alias-border-l1, #34343a); background: transparent;
  color: var(--dsw-alias-label-secondary, #9a9aa2);
}
.gcmd-foot-btn:hover { color: var(--dsw-alias-label-primary, #fff); border-color: var(--dsw-alias-brand-primary, #4f8cff); }

/* 表单 */
.gcmd-form { padding: 12px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.gcmd-field { display: flex; flex-direction: column; gap: 4px; }
.gcmd-field-label { color: var(--dsw-alias-label-secondary, #8f8f98); font-size: 11.5px; }
.gcmd-field input, .gcmd-field select, .gcmd-field textarea {
  width: 100%; padding: 6px 8px; border-radius: 5px;
  border: 1px solid var(--gcmd-line-2);
  background: var(--gcmd-bg); outline: none;
  color: var(--gcmd-text); font-size: 12.5px;
}
.gcmd-field input:focus, .gcmd-field select:focus, .gcmd-field textarea:focus {
  border-color: rgba(53, 230, 197, .5);
  box-shadow: 0 0 0 1px rgba(53, 230, 197, .18);
}
.gcmd-field textarea {
  min-height: 84px; resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.5;
}
.gcmd-field-row { display: flex; gap: 10px; }
.gcmd-field-row .gcmd-field { flex: 1; min-width: 0; }
.gcmd-check { display: flex; align-items: center; gap: 7px; color: var(--dsw-alias-label-secondary, #8f8f98); font-size: 12px; }
.gcmd-check input { width: 14px; height: 14px; }
.gcmd-form-error { color: var(--dsw-alias-state-error-primary, #ff6b6b); font-size: 12px; }
.gcmd-actions { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1, #34343a); }
.gcmd-actions .gcmd-spacer { flex: 1; }
.gcmd-btn {
  height: 28px; padding: 0 13px; border-radius: 6px; font-size: 12.5px;
  border: 1px solid var(--dsw-alias-border-l1, #34343a); background: transparent;
  color: var(--dsw-alias-label-primary, #e9e9ec);
}
.gcmd-btn:hover { border-color: var(--dsw-alias-border-l2, #55555e); }
.gcmd-btn[data-tone="primary"] {
  background: linear-gradient(180deg, #3d8bff, #1f63d0);
  border-color: #3d8bff; color: #fff;
  box-shadow: 0 4px 14px rgba(61, 139, 255, .28);
}
.gcmd-btn[data-tone="primary"]:hover { background: linear-gradient(180deg, #4d97ff, #276bd8); border-color: #4d97ff; }
.gcmd-btn[data-tone="danger"] { color: #ff6f7d; border-color: rgba(255, 111, 125, .42); }
.gcmd-btn:disabled { opacity: .5; cursor: default; }
.gcmd-modal {
  position: absolute; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(4, 7, 10, .62); border-radius: 8px; backdrop-filter: blur(2px);
}
.gcmd-modal-card {
  width: min(340px, 88%); padding: 16px 18px 14px; border-radius: 8px;
  background: linear-gradient(180deg, #0d141b, #080c11);
  border: 1px solid rgba(53, 230, 197, .26);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .6), 0 0 34px rgba(53, 230, 197, .06);
  animation: gcmd-pop .12s ease-out;
}
.gcmd-modal-title { font-size: 13px; font-weight: 600; color: var(--gcmd-text); }
.gcmd-modal-text { margin-top: 6px; font-size: 12px; line-height: 1.55; color: var(--gcmd-dim); }
.gcmd-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.gcmd-modal-btn {
  height: 26px; padding: 0 12px; border-radius: 6px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #34343a); background: transparent;
  color: var(--dsw-alias-label-primary, #e9e9ec);
}
.gcmd-modal-btn:hover { border-color: var(--dsw-alias-border-l2, #55555e); }
.gcmd-modal-btn[data-tone="danger"] { background: #c4453f; border-color: #c4453f; color: #fff; }
.gcmd-modal-btn[data-tone="danger"]:hover { background: #a83630; border-color: #a83630; }
.gcmd-notice {
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
  padding: 6px 14px; border-radius: 999px; font-size: 12px;
  background: rgba(10, 16, 22, .95);
  border: 1px solid rgba(53, 230, 197, .3);
  color: var(--gcmd-text);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .45), 0 0 22px rgba(53, 230, 197, .1);
  pointer-events: none;
}
`

    function ensureStyle() {
      // 模块热替换时 <style> 还在，但里面是旧 CSS（缺少新类名）→ 每次挂载都覆写一遍，
      // 否则新结构完全没有样式，会被当成流式元素挤成一坨。
      let style = document.getElementById(STYLE_ID)
      if (!style) {
        style = document.createElement('style')
        style.id = STYLE_ID
        document.head.appendChild(style)
      }
      if (style.textContent !== CSS) style.textContent = CSS
    }

    /* ------------------------------ 状态 ------------------------------ */

    function makeTab(seed) {
      return {
        id: uid(),
        shell: seed.shell || 'auto',
        cwd: seed.cwd || '',
        draft: '',
        history: [],
        histIndex: -1,
        lines: [],
        running: null,
        exit: null,
      }
    }

    function createStore() {
      const prefs = readPrefs()
      let state = {
        ready: false,
        error: '',
        env: null,
        actions: [],
        settings: { defaultShell: 'auto', defaultCwd: '', timeoutMs: 0 },
        tabs: [],
        activeId: '',
        dockOpen: prefs.open === true,
        dockPos: readPos(prefs.pos),
        dragging: false,
        dockHeight: Number.isFinite(prefs.height) ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, prefs.height)) : DEFAULT_HEIGHT,
        paletteOpen: false,
        editorOpen: false,
        settingsOpen: false,
        closing: null,
        notice: '',
      }
      const listeners = new Set()
      const subscribe = (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
      const getSnapshot = () => state
      const emit = () => {
        for (const fn of listeners) fn()
      }
      const set = (patch) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
        emit()
      }
      const patchTab = (id, patch) =>
        set((prev) => ({
          tabs: prev.tabs.map((tab) =>
            tab.id === id ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } : tab,
          ),
        }))
      const notify = (text) => {
        set({ notice: text })
        window.setTimeout(() => {
          if (getSnapshot().notice === text) set({ notice: '' })
        }, 1400)
      }
      return { subscribe, getSnapshot, set, get: () => state, patchTab, notify }
    }

    const store = createStore()

    const getTab = (id) => store.get().tabs.find((tab) => tab.id === id) || null
    const activeTab = () => getTab(store.get().activeId)

    /* --------------------------- 命令执行 --------------------------- */

    const timers = new Map()

    function pushLines(tabId, lines) {
      if (!lines.length) return
      store.patchTab(tabId, (tab) => ({ lines: [...tab.lines, ...lines].slice(-MAX_LINES) }))
    }

    function pushLine(tabId, kind, text, extra) {
      pushLines(tabId, [extra ? { kind, text, ...extra } : { kind, text }])
    }

    function chunksToLines(chunks) {
      const out = []
      for (const chunk of chunks) {
        const kind = chunk.s === 'err' ? 'err' : chunk.s === 'meta' ? 'info' : 'out'
        // Windows 的 \r\n 在 DOM 里会多出空行，统一成 \n 再拆行
        const parts = String(chunk.d ?? '').replace(/\r\n?/g, '\n').split('\n')
        for (const part of parts) {
          if (part !== '') out.push({ kind, text: part })
        }
      }
      return out
    }

    async function runExec(tabId, command, shell, cwd) {
      // 回显成 cmd 的样子：`C:\path>命令`
      pushLine(tabId, 'cmd', command, { cwd })
      store.patchTab(tabId, { running: { command, startedAt: Date.now() }, exit: null })
      let jobId
      try {
        const created = await api.exec({
          command,
          shell,
          cwd,
          timeoutMs: store.get().settings.timeoutMs,
        })
        jobId = created.id
      } catch (error) {
        pushLine(tabId, 'err', `无法执行：${errorText(error)}`)
        store.patchTab(tabId, { running: null })
        return
      }
      store.patchTab(tabId, (tab) => ({ running: { id: jobId, command, startedAt: tab.running?.startedAt ?? Date.now() } }))
      persistTabs()
      startPolling(tabId, jobId)
    }

    /** 轮询一个任务直到结束；页面刷新后也用它把还在跑的任务接回来 */
    function startPolling(tabId, jobId) {
      let after = 0
      let notACommand = false
      const tick = async () => {
        timers.delete(jobId)
        if (!getTab(tabId)) return
        let result
        try {
          result = await api.poll(jobId, after)
        } catch (error) {
          const message = errorText(error)
          pushLine(
            tabId,
            'info',
            message.includes('任务不存在')
              ? '[这条命令已经不在 Host 里了（插件重载过，或任务已被清理）]'
              : `读取输出失败：${message}`,
          )
          store.patchTab(tabId, { running: null })
          persistTabs()
          return
        }
        after = result.next
        const incoming = chunksToLines(result.chunks || [])
        for (const line of incoming) {
          if (line.kind === 'err' && /不是内部或外部命令|无法将.*项识别为|is not recognized as an internal/i.test(line.text)) {
            notACommand = true
          }
        }
        pushLines(tabId, incoming)
        if (!result.done) {
          timers.set(jobId, window.setTimeout(tick, POLL_MS))
          return
        }
        store.patchTab(tabId, {
          running: null,
          exit: {
            code: result.exitCode,
            ms: Math.max(1, result.endedAt - result.startedAt),
            timedOut: result.timedOut === true,
          },
        })
        persistTabs()
        // 失败/超时在输出里补一行淡提示（成功的命令像 cmd 一样什么都不多说）
        if (result.timedOut === true) {
          pushLine(tabId, 'info', `[已超时终止 · ${formatDuration(Math.max(1, result.endedAt - result.startedAt))}]`)
        } else if (result.exitCode === null) {
          pushLine(tabId, 'info', `[进程已结束（退出码未知）· ${formatDuration(Math.max(1, result.endedAt - result.startedAt))}]`)
        } else if (result.exitCode !== 0) {
          pushLine(tabId, 'info', `[退出码 ${result.exitCode} · ${formatDuration(Math.max(1, result.endedAt - result.startedAt))}]`)
        }
        // cmd 里没有的命令：给出「换 cmd 等价物 / 或切到 Git Bash」的提示
        if (notACommand) {
          pushLine(
            tabId,
            'info',
            '当前终端是 cmd：`ls`、`pwd`、`cat`、`ps` 这类是 Unix 命令，可以换成 `dir`、`cd`、`type`、`tasklist`，或者用内置命令 `shell bash` 切到 Git Bash。',
          )
        }
      }
      timers.set(jobId, window.setTimeout(tick, FIRST_POLL_MS))
    }

    function rememberCommand(tabId, command) {
      store.patchTab(tabId, (tab) => ({
        history: [...tab.history.filter((item) => item !== command), command].slice(-80),
        histIndex: -1,
      }))
    }

    /** 本地处理 cd / cls / exit，让控制台像真终端 */
    async function runCommand(tabId, rawCommand) {
      const tab = getTab(tabId)
      if (!tab) return
      const command = String(rawCommand ?? '').trim()
      if (!command) return
      if (tab.running) {
        store.notify('上一个命令还在运行')
        return
      }
      rememberCommand(tabId, command)
      store.patchTab(tabId, { draft: '' })

      const lower = command.toLowerCase()
      if (lower === 'cls' || lower === 'clear') {
        store.patchTab(tabId, { lines: [] })
        return
      }
      if (lower === 'exit') {
        // 和点 ✕ 一样，先确认再关，避免手快丢掉正在看的输出
        requestClose(tabId)
        return
      }

      const shellMatch = /^shell(?:\s+([\w.-]+))?$/i.exec(command)
      if (shellMatch) {
        const want = (shellMatch[1] || '').toLowerCase()
        if (!want) {
          pushLine(tabId, 'info', `当前终端：${tabName(tab)}（可用 shell ${SHELLS.map((item) => item.value).join(' / ')}）`)
          return
        }
        if (!SHELLS.some((item) => item.value === want)) {
          pushLine(tabId, 'err', `不支持的 shell：${want}，可选 ${SHELLS.map((item) => item.value).join(' / ')}`)
          return
        }
        store.patchTab(tabId, { shell: want })
        persistTabs()
        pushLine(tabId, 'info', `已切换到这个终端的 shell：${SHELL_LABEL[want] || want}`)
        return
      }

      const cdMatch = /^(?:cd|chdir|set-location|sl)(?:\s+([\s\S]*))?$/i.exec(command)
      if (cdMatch) {
        let rawTarget = (cdMatch[1] || '').trim()
        // cmd 的 /d 开关：「cd /d X」「cd /d"X"」都算
        if (/^\/d(?=\s|$)/i.test(rawTarget)) rawTarget = rawTarget.slice(2).trim()
        rawTarget = rawTarget.replace(/^(["'])([\s\S]*)\1$/, '$2').trim()
        // 只把「单纯换个目录」在本地处理；带 & | ; > < ^ 的整行是复合命令，原样交给 shell
        const plain = rawTarget === '' || !/[&|;<>^`]/.test(rawTarget)
        if (plain) {
          // 裸 cd 回家目录：交给 Host 用系统家目录解析，保持一致
          const target = rawTarget || '~'
          try {
            const resolved = await api.cwd(target, tab.cwd)
            if (!resolved.isDirectory) {
              pushLine(tabId, 'err', `不是有效的工作目录：${rawTarget || target}`)
              return
            }
            store.patchTab(tabId, { cwd: resolved.path })
            persistTabs()
          } catch (error) {
            pushLine(tabId, 'err', `切换目录失败：${errorText(error)}`)
          }
          return
        }
      }

      runExec(tabId, command, tab.shell, tab.cwd)
    }

    async function stopRun(tabId) {
      const tab = getTab(tabId)
      const jobId = tab?.running?.id
      if (!jobId) return
      try {
        await api.kill(jobId)
      } catch (error) {
        pushLine(tabId, 'err', `终止失败：${errorText(error)}`)
      }
    }

    /* --------------------------- 标签页 --------------------------- */

    function persistTabs() {
      const state = store.get()
      writePrefs({
        height: state.dockHeight,
        activeIndex: Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeId)),
        tabs: state.tabs.map((tab) => ({
          shell: tab.shell,
          cwd: tab.cwd,
          // 记下正在跑的任务 id：刷新页面后能把这条命令接回来，而不是当成没了
          running:
            tab.running && tab.running.id
              ? { id: tab.running.id, command: tab.running.command, startedAt: tab.running.startedAt }
              : null,
        })),
      })
    }

    function defaultCwdFor(settings, env) {
      return settings?.defaultCwd || env?.cwd || ''
    }

    function createTab(seed) {
      const state = store.get()
      const tab = makeTab({
        shell: seed?.shell || state.settings.defaultShell || 'auto',
        cwd: seed?.cwd || defaultCwdFor(state.settings, state.env),
      })
      focusPromptOnAppear = true
      store.set({ tabs: [...state.tabs, tab], activeId: tab.id })
      persistTabs()
      return tab
    }

    /** 关标签前先确认：标签上的 ✕ 与「关闭终端」快捷键都走这里，真的关掉才调 closeTab。 */
    function requestClose(tabId) {
      const state = store.get()
      if (!state.tabs.some((tab) => tab.id === tabId)) return
      store.set({ closing: tabId })
    }

    function confirmClose() {
      const state = store.get()
      const tabId = state.closing
      store.set({ closing: null })
      if (tabId) closeTab(tabId)
    }

    function cancelClose() {
      store.set({ closing: null })
    }

    function closeTab(tabId) {
      const state = store.get()
      const index = state.tabs.findIndex((tab) => tab.id === tabId)
      if (index < 0) return
      const running = state.tabs[index].running
      if (running?.id) {
        api.kill(running.id).catch(() => {})
        const timer = timers.get(running.id)
        if (timer) {
          window.clearTimeout(timer)
          timers.delete(running.id)
        }
      }
      const tabs = state.tabs.filter((tab) => tab.id !== tabId)
      if (tabs.length === 0) {
        const fresh = makeTab({ shell: state.settings.defaultShell, cwd: defaultCwdFor(state.settings, state.env) })
        store.set({ tabs: [fresh], activeId: fresh.id })
      } else {
        const activeId = state.activeId === tabId ? tabs[Math.min(index, tabs.length - 1)].id : state.activeId
        store.set({ tabs, activeId })
      }
      persistTabs()
    }

    function cycleTab(direction) {
      const state = store.get()
      if (state.tabs.length < 2) return
      const index = state.tabs.findIndex((tab) => tab.id === state.activeId)
      const next = (index + direction + state.tabs.length) % state.tabs.length
      focusPromptOnAppear = true
      store.set({ activeId: state.tabs[next].id })
      persistTabs()
    }

    function selectTab(index) {
      const tab = store.get().tabs[index]
      if (tab) {
        focusPromptOnAppear = true
        store.set({ activeId: tab.id })
        persistTabs()
      }
    }

    /* --------------------------- 命令库 --------------------------- */

    async function saveActions(actions, settings) {
      const state = store.get()
      const payload = {
        version: 1,
        actions,
        settings: settings ?? state.settings,
      }
      const saved = await api.saveState(payload)
      store.set({
        actions: saved.actions || [],
        settings: { ...state.settings, ...(saved.settings || {}) },
      })
      return saved
    }

    function blankDraft() {
      return { id: '', name: '', description: '', group: '', shell: 'auto', cwd: '', command: '', confirm: false }
    }

    function toDraft(action) {
      return {
        id: action.id,
        name: action.name || '',
        description: action.description || '',
        group: action.group || '',
        shell: action.shell || 'auto',
        cwd: action.cwd || '',
        command: action.command || '',
        confirm: action.confirm === true,
      }
    }

    async function submitDraft(draft) {
      const state = store.get()
      const command = String(draft.command || '').trim()
      if (!command) throw new Error('命令内容不能为空')
      const next = { ...draft, command, name: String(draft.name || '').trim() || command.split('\n')[0] }
      let actions
      if (next.id) {
        actions = state.actions.map((action) =>
          action.id === next.id ? { ...action, ...next, id: action.id } : action,
        )
      } else {
        actions = [...state.actions, { ...next, id: uid() }]
      }
      await saveActions(actions)
      return next
    }

    async function removeAction(id) {
      const state = store.get()
      await saveActions(state.actions.filter((action) => action.id !== id))
    }

    async function moveAction(id, direction) {
      const state = store.get()
      const index = state.actions.findIndex((action) => action.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= state.actions.length) return
      const actions = [...state.actions]
      const [item] = actions.splice(index, 1)
      actions.splice(target, 0, item)
      await saveActions(actions)
    }

    /* --------------------------- 引导 --------------------------- */

    let bootState = 'idle'

    async function bootstrap(force) {
      ensureStyle()
      if (!force && bootState !== 'idle') return
      bootState = 'loading'
      try {
        const [remote, env] = await Promise.all([api.state(), api.env()])
        const prefs = readPrefs()
        const seedTabs = Array.isArray(prefs.tabs) && prefs.tabs.length ? prefs.tabs : null
        const settings = { ...store.get().settings, ...(remote.settings || {}) }
        let tabs
        if (seedTabs) {
          tabs = seedTabs.map((seed) => {
            const tab = makeTab({
              shell: seed.shell || settings.defaultShell || 'auto',
              cwd: seed.cwd || defaultCwdFor(settings, env),
            })
            // 刷新前还有命令在跑：把任务 id 接回来，输出从 Host 重新拉一遍
            if (seed.running && typeof seed.running.id === 'string') {
              tab.running = {
                id: seed.running.id,
                command: typeof seed.running.command === 'string' ? seed.running.command : '',
                startedAt: Number(seed.running.startedAt) || Date.now(),
              }
            }
            return tab
          })
        } else {
          tabs = [makeTab({ shell: settings.defaultShell || 'auto', cwd: defaultCwdFor(settings, env) })]
        }
        const restored = Number.isInteger(prefs.activeIndex) ? tabs[prefs.activeIndex] : null
        store.set({
          ready: true,
          error: '',
          actions: remote.actions || [],
          settings,
          env,
          tabs,
          activeId: (restored || tabs[0]).id,
        })
        for (const tab of tabs) {
          if (!tab.running?.id) continue
          pushLine(tab.id, 'info', `[接上刷新前还在跑的命令：${tab.running.command || '（未知命令）'}]`)
          startPolling(tab.id, tab.running.id)
        }
        bootState = 'done'
      } catch (error) {
        bootState = 'idle'
        store.set({
          ready: true,
          error: `无法连接 dsh-global-cmd Host 服务：${errorText(error)}`,
        })
      }
    }

    /* --------------------------- 组件：输出 --------------------------- */

    const Line = React.memo(function Line({ line, onReuse }) {
      if (line.kind === 'cmd') {
        // 照 cmd 回显：`C:\path>命令`，整行可点（点回输入框继续改）
        return h(
          'div',
          {
            className: onReuse ? 'gcmd-line gcmd-line-reuse' : 'gcmd-line',
            'data-kind': 'cmd',
            title: onReuse ? '点一下把这条命令放回输入框再改' : undefined,
            onClick: onReuse,
          },
          h('span', { className: 'gcmd-echo-path' }, `${line.cwd || ''}>`),
          line.text,
        )
      }
      return h('div', { className: 'gcmd-line', 'data-kind': line.kind }, line.text)
    })

    /** 首屏横幅：模仿 Windows 命令提示符打开时那两行 */
    function bannerText(env) {
      if (!env) return ''
      if (env.platform !== 'win32') return `${env.platform} ${env.osVersion || ''}`.trim()
      const first = env.osVersion ? `Microsoft Windows [Version ${env.osVersion}]` : 'Microsoft Windows'
      return `${first}\n(c) Microsoft Corporation。保留所有权利。`
    }

    /** 提示符输入框的 DOM 句柄：点终端任意位置 / 点历史命令行时用来聚焦与回填 */
    const promptRef = { current: null }
    /** 提示符下一次出现时是否强制聚焦（打开控制台、切标签）；命令跑完后只在焦点还在控制台里时才抢回来 */
    let focusPromptOnAppear = true

    /** 输出区里由它们自己处理点击的元素，不抢焦点 */
    const FOCUS_GUARD = 'button, a, input, textarea, select, [contenteditable="true"]'

    function focusPrompt() {
      const node = promptRef.current
      if (node && typeof node.focus === 'function') node.focus()
    }

    function Output({ tab, env }) {
      const scroller = useRef(null)
      const pressed = useRef(null)
      const running = Boolean(tab && tab.running)
      const count = tab ? tab.lines.length : 0

      useEffect(() => {
        const node = scroller.current
        if (node) node.scrollTop = node.scrollHeight
      }, [count, tab ? tab.id : '', running])

      if (!tab) return null

      const reuse = (text) => {
        store.patchTab(tab.id, { draft: text })
        focusPrompt()
      }

      // 点终端任意位置都把焦点交回提示符（光标随时都在，不用专门去点提示符那一行）。
      // 拖选文本、双击选词时不抢，免得刚选中就被清掉。
      const startPress = (event) => {
        pressed.current = event.button === 0 ? { x: event.clientX, y: event.clientY } : null
      }
      const endPress = (event) => {
        const start = pressed.current
        pressed.current = null
        if (!start || event.button !== 0 || event.detail > 1) return
        if (Math.abs(event.clientX - start.x) > 3 || Math.abs(event.clientY - start.y) > 3) return
        const node = event.target
        if (node && typeof node.closest === 'function' && node.closest(FOCUS_GUARD)) return
        focusPrompt()
      }

      return h(
        'div',
        {
          className: 'gcmd-scroll',
          ref: scroller,
          onMouseDown: startPress,
          onMouseUp: endPress,
        },
        h('div', { className: 'gcmd-banner' }, bannerText(env)),
        tab.lines.map((line, index) =>
          h(Line, {
            key: index,
            line,
            onReuse: line.kind === 'cmd' ? () => reuse(line.text) : undefined,
          }),
        ),
        // 命令跑的时候不挂提示符：像真 cmd 一样，输出直接接在回显行后面，
        // 不会先冒出一行空提示符、等一会儿再补输出
        running ? null : h(PromptRow, { tab }),
      )
    }

    /* --------------------------- 组件：提示符 --------------------------- */

    function PromptRow({ tab }) {
      const inputRef = useRef(null)
      const [draft, setDraft] = useState(tab ? tab.draft : '')
      const [focused, setFocused] = useState(false)
      const tabId = tab ? tab.id : ''

      useEffect(() => {
        setDraft(tab ? tab.draft : '')
        const node = inputRef.current
        promptRef.current = node
        if (tab && node) {
          // 打开控制台 / 切标签时直接聚焦；命令跑完提示符重新出现时，只有焦点还在控制台里
          // （或压根不在任何地方）才抢回来，免得你正在别处输入时被它抢走
          const active = document.activeElement
          const dock = node.closest('.gcmd-dock')
          const inside = !active || active === document.body || (dock && dock.contains(active))
          if (focusPromptOnAppear || inside) node.focus()
          focusPromptOnAppear = false
        }
        return () => {
          if (promptRef.current === inputRef.current) promptRef.current = null
        }
      }, [tabId])

      // 外部（点历史命令行「放回输入框」）改了 tab.draft 时同步进来
      useEffect(() => {
        if (!tab) return
        if (tab.draft !== draft) setDraft(tab.draft)
      }, [tab ? tab.draft : ''])

      if (!tab) return null
      const running = Boolean(tab.running)
      // cmd 的提示符就是「路径>」，PowerShell 才是「PS 路径>」
      const isPowerShell = tab.shell === 'powershell' || tab.shell === 'pwsh'
      const promptText = `${isPowerShell ? 'PS ' : ''}${tab.cwd || '~'}`

      const commit = (value) => {
        setDraft(value)
        store.patchTab(tab.id, { draft: value })
      }

      const submit = () => {
        const value = draft
        if (!value.trim()) return
        setDraft('')
        runCommand(tab.id, value)
      }

      const onKeyDown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
          return
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          const history = tab.history
          if (!history.length) return
          let index = tab.histIndex
          index = event.key === 'ArrowUp' ? Math.min(history.length - 1, index + 1) : index - 1
          if (index < -1) index = -1
          store.patchTab(tab.id, { histIndex: index })
          const value = index >= 0 ? history[history.length - 1 - index] : ''
          setDraft(value)
          store.patchTab(tab.id, { draft: value })
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          store.set({ paletteOpen: true })
        }
      }

      return h(
        'div',
        { className: 'gcmd-prompt' },
        h('span', { className: 'gcmd-path', title: tab.cwd || '' }, promptText),
        h('span', { className: 'gcmd-prompt-mark' }, '>'),
        h('input', {
          ref: inputRef,
          className: 'gcmd-input',
          value: draft,
          spellCheck: false,
          autoComplete: 'off',
          // 真 cmd 里提示符后面是空的：只有没对焦时才提示一句
          placeholder: focused ? '' : '输入命令，回车执行',
          onChange: (event) => commit(event.target.value),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          onKeyDown,
        }),
      )
    }

    /* --------------------------- 拖动浮窗 --------------------------- */

    /**
     * 按住标签栏的把手（或标签栏空白处）拖动整个浮窗。
     * 位置实时写进 store，松手后持久化到 localStorage，刷新后回到原处。
     */
    function startDockDrag(event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      const dock = event.currentTarget.closest('.gcmd-dock')
      if (!dock) return
      const rect = dock.getBoundingClientRect()
      event.preventDefault()
      event.stopPropagation()
      const start = { pointerX: event.clientX, pointerY: event.clientY, x: rect.left, y: rect.top }
      let moved = false
      store.set({ dragging: true })
      const onMove = (moveEvent) => {
        moved = true
        store.set({
          dockPos: clampPos({
            x: start.x + moveEvent.clientX - start.pointerX,
            y: start.y + moveEvent.clientY - start.pointerY,
          }),
        })
      }
      const onEnd = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
        store.set({ dragging: false })
        if (moved) writePrefs({ pos: store.get().dockPos })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
    }

    /** 双击把手：回到居中位置 */
    function resetDockPos() {
      const pos = clampPos(null)
      store.set({ dockPos: pos })
      writePrefs({ pos })
    }

    /* --------------------------- 组件：标签栏 --------------------------- */

    function TabsBar({ tabs, activeId }) {
      return h(
        'div',
        { className: 'gcmd-tabs' },
        h(
          'button',
          {
            className: 'gcmd-drag',
            title: '拖动这里移动窗口（双击回到中间）',
            'aria-label': '拖动窗口',
            onPointerDown: startDockDrag,
            onDoubleClick: resetDockPos,
          },
          '⠿',
        ),
        tabs.map((tab) =>
          h(
            'button',
            {
              key: tab.id,
              className: 'gcmd-tab',
              'data-active': tab.id === activeId ? 'true' : 'false',
              title: `${tabName(tab)}\n${tab.cwd || ''}`.trim(),
              onClick: () => {
                focusPromptOnAppear = true
                store.set({ activeId: tab.id })
                persistTabs()
              },
            },
            h('span', { className: 'gcmd-tab-glyph' }, promptMark(tab.shell)),
            h('span', { className: 'gcmd-tab-name' }, tabName(tab)),
            tab.running ? h('span', { className: 'gcmd-tab-dot' }) : null,
            h(
              'span',
              {
                className: 'gcmd-tab-close',
                role: 'button',
                title: `关闭终端（${COMBO('W')}）`,
                onClick: (event) => {
                  event.stopPropagation()
                  requestClose(tab.id)
                },
              },
              '✕',
            ),
          ),
        ),
        h(
          'button',
          { className: 'gcmd-tool', title: `新建终端（${COMBO('T')}）`, onClick: () => createTab() },
          h('span', { className: 'gcmd-tool-icon' }, '＋'),
        ),
        h('span', { className: 'gcmd-tabs-spacer', onPointerDown: startDockDrag }),
        h(
          'button',
          {
            className: 'gcmd-tool',
            title: `清屏（${COMBO('L')}）`,
            onClick: () => {
              const active = tabs.find((item) => item.id === activeId) || tabs[0]
              if (active) store.patchTab(active.id, { lines: [], exit: null })
            },
          },
          h('span', { className: 'gcmd-tool-icon' }, '⌫'),
        ),
        h(
          'button',
          {
            className: 'gcmd-tool',
            title: '复制全部输出',
            onClick: async () => {
              const active = tabs.find((item) => item.id === activeId) || tabs[0]
              if (!active) return
              const text = active.lines
                .map((line) => (line.kind === 'cmd' ? `${line.cwd || ''}>${line.text}` : line.text))
                .join('\n')
              try {
                await navigator.clipboard.writeText(text)
                store.notify('输出已复制')
              } catch {
                store.notify('复制失败')
              }
            },
          },
          h('span', { className: 'gcmd-tool-icon' }, '⧉'),
        ),
        h(
          'button',
          {
            className: 'gcmd-tool',
            title: `命令库（${COMBO('K')}）`,
            onClick: () => store.set({ paletteOpen: true }),
          },
          h('span', { className: 'gcmd-tool-icon' }, MOD),
          '命令库',
          h('span', { className: 'gcmd-kbd' }, 'K'),
        ),
        h(
          'button',
          {
            className: 'gcmd-tool',
            title: '偏好设置',
            onClick: () => store.set({ settingsOpen: true }),
          },
          h('span', { className: 'gcmd-tool-icon' }, '⚙'),
        ),
        h(
          'button',
          {
            className: 'gcmd-tool',
            title: '收起控制台（Esc）',
            onClick: () => store.set({ dockOpen: false }),
          },
          h('span', { className: 'gcmd-tool-icon' }, '✕'),
        ),
      )
    }

    /* --------------------------- 执行一个命令库条目 --------------------------- */

    async function runConsoleAction(action, tabId) {
      const tab = tabId ? getTab(tabId) : activeTab()
      if (!tab || !action) return false
      if (tab.running) {
        store.notify('这个终端还有命令在跑')
        return false
      }
      if (action.confirm && !window.confirm(`执行「${action.name || action.command}」？`)) return false
      if (action.shell && action.shell !== 'auto') store.patchTab(tab.id, { shell: action.shell })
      if (action.cwd) {
        // 命令自带的目录也走一次解析，避免相对路径把 Host 的 cwd 校验打挂
        try {
          const resolved = await api.cwd(action.cwd, tab.cwd)
          if (!resolved.isDirectory) {
            pushLine(tab.id, 'err', `命令指定的工作目录无效：${resolved.path}`)
            return false
          }
          store.patchTab(tab.id, { cwd: resolved.path })
          persistTabs()
        } catch (error) {
          pushLine(tab.id, 'err', `解析工作目录失败：${errorText(error)}`)
          return false
        }
      }
      await runCommand(tab.id, action.command)
      return true
    }

    /* --------------------------- 组件：命令库 --------------------------- */

    function Palette({ state }) {
      const [query, setQuery] = useState('')
      const [index, setIndex] = useState(0)
      const listRef = useRef(null)

      const actions = state.actions
      const filtered = useMemo(() => {
        const text = query.trim().toLowerCase()
        if (!text) return actions
        return actions.filter((action) => {
          const hay = `${action.name || ''}\n${action.command || ''}\n${action.group || ''}\n${action.description || ''}`.toLowerCase()
          return hay.includes(text)
        })
      }, [actions, query])

      useEffect(() => {
        setIndex(0)
      }, [query])

      const active = filtered[Math.min(index, Math.max(0, filtered.length - 1))]

      const runAction = async (action) => {
        const tab = activeTab()
        if (!tab || !action) return
        store.set({ paletteOpen: false })
        if (tab.running) {
          store.notify('上一个命令还在运行')
          return
        }
        if (action.confirm && !window.confirm(`执行「${action.name || action.command}」？`)) return
        if (action.shell && action.shell !== 'auto') store.patchTab(tab.id, { shell: action.shell })
        if (action.cwd) {
          // 命令自带的目录也走一次解析，避免相对路径直接把 Host 的 cwd 校验打挂
          try {
            const resolved = await api.cwd(action.cwd, tab.cwd)
            if (resolved.isDirectory) {
              store.patchTab(tab.id, { cwd: resolved.path })
              persistTabs()
            } else {
              pushLine(tab.id, 'err', `命令指定的工作目录无效：${resolved.path}`)
              return
            }
          } catch (error) {
            pushLine(tab.id, 'err', `解析工作目录失败：${errorText(error)}`)
            return
          }
        }
        runCommand(tab.id, action.command)
      }

      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setIndex((value) => Math.min(filtered.length - 1, value + 1))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setIndex((value) => Math.max(0, value - 1))
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          runAction(active)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          store.set({ paletteOpen: false })
        }
      }

      return h(
        'div',
        { className: 'gcmd-overlay', onMouseDown: () => store.set({ paletteOpen: false }) },
        h(
          'div',
          { className: 'gcmd-sheet', onMouseDown: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'gcmd-sheet-head' },
            h('span', { className: 'gcmd-sheet-title' }, '命令库'),
            h('span', { className: 'gcmd-sheet-count' }, `${filtered.length} / ${actions.length}`),
            h(
              'button',
              { className: 'gcmd-sheet-close', title: '关闭（Esc）', onClick: () => store.set({ paletteOpen: false }) },
              '✕',
            ),
          ),
          h(
            'div',
            { className: 'gcmd-filter' },
            h('input', {
              className: 'gcmd-filter-input',
              autoFocus: true,
              placeholder: '搜索命令或说明…',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown,
            }),
          ),
          h(
            'div',
            { className: 'gcmd-list', ref: listRef },
            filtered.length === 0
              ? h('div', { className: 'gcmd-empty-row' }, actions.length === 0 ? '还没有自定义命令，新建一条吧。' : '没有匹配的命令。')
              : filtered.map((action, itemIndex) =>
                  h(
                    'div',
                    {
                      key: action.id,
                      className: 'gcmd-item',
                      'data-active': itemIndex === index ? 'true' : 'false',
                      onMouseEnter: () => setIndex(itemIndex),
                      onClick: () => runAction(action),
                    },
                    h('span', { className: 'gcmd-item-mark' }, '❯'),
                    h(
                      'div',
                      { className: 'gcmd-item-main' },
                      h('div', { className: 'gcmd-item-name' }, action.name || action.command),
                      h('div', { className: 'gcmd-item-cmd' }, (action.command || '').replace(/\s+/g, ' ')),
                    ),
                    action.group ? h('span', { className: 'gcmd-item-tag' }, action.group) : null,
                    h(
                      'button',
                      {
                        className: 'gcmd-item-edit',
                        title: '编辑这条命令',
                        onClick: (event) => {
                          event.stopPropagation()
                          store.set({ paletteOpen: false, editorOpen: true, editorDraft: toDraft(action) })
                        },
                      },
                      '编辑',
                    ),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'gcmd-sheet-foot' },
            h('span', null, '↑↓ 选择 · ↵ 执行 · Esc 关闭'),
            h('span', { className: 'gcmd-spacer' }),
            h(
              'button',
              {
                className: 'gcmd-foot-btn',
                onClick: () => store.set({ paletteOpen: false, editorOpen: true, editorDraft: blankDraft() }),
              },
              '＋ 新建命令',
            ),
            h(
              'button',
              { className: 'gcmd-foot-btn', onClick: () => store.set({ paletteOpen: false, settingsOpen: true }) },
              '⚙ 偏好',
            ),
          ),
        ),
      )
    }

    /* --------------------------- 组件：编辑器 --------------------------- */

    function Editor({ draft }) {
      const [form, setForm] = useState(draft)
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const isNew = !draft.id

      const update = (patch) => setForm((prev) => ({ ...prev, ...patch }))

      const save = async () => {
        if (!String(form.command || '').trim()) {
          setError('命令内容不能为空')
          return
        }
        setSaving(true)
        setError('')
        try {
          await submitDraft(form)
          store.set({ editorOpen: false, editorDraft: null })
          store.notify('已保存')
        } catch (err) {
          setError(errorText(err))
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { className: 'gcmd-overlay', onMouseDown: () => store.set({ editorOpen: false, editorDraft: null }) },
        h(
          'div',
          { className: 'gcmd-sheet', onMouseDown: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'gcmd-sheet-head' },
            h('span', { className: 'gcmd-sheet-title' }, isNew ? '新建命令' : '编辑命令'),
            h(
              'button',
              { className: 'gcmd-sheet-close', title: '关闭', onClick: () => store.set({ editorOpen: false, editorDraft: null }) },
              '✕',
            ),
          ),
          h(
            'div',
            { className: 'gcmd-form' },
            h(
              'div',
              { className: 'gcmd-field-row' },
              h(
                'div',
                { className: 'gcmd-field' },
                h('span', { className: 'gcmd-field-label' }, '名称'),
                h('input', {
                  value: form.name,
                  placeholder: '例如：启动开发服务器',
                  onChange: (event) => update({ name: event.target.value }),
                }),
              ),
              h(
                'div',
                { className: 'gcmd-field' },
                h('span', { className: 'gcmd-field-label' }, '分组'),
                h('input', {
                  value: form.group,
                  placeholder: '可选，例如：前端',
                  onChange: (event) => update({ group: event.target.value }),
                }),
              ),
            ),
            h(
              'div',
              { className: 'gcmd-field' },
              h('span', { className: 'gcmd-field-label' }, '命令'),
              h('textarea', {
                value: form.command,
                spellCheck: false,
                placeholder: '支持多行，例如：\ncd /d D:\\workspace\\project\nnpm run dev',
                onChange: (event) => update({ command: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'gcmd-field-row' },
              h(
                'div',
                { className: 'gcmd-field' },
                h('span', { className: 'gcmd-field-label' }, 'shell'),
                h(
                  'select',
                  { value: form.shell, onChange: (event) => update({ shell: event.target.value }) },
                  SHELLS.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
                ),
              ),
              h(
                'div',
                { className: 'gcmd-field' },
                h('span', { className: 'gcmd-field-label' }, '工作目录'),
                h('input', {
                  value: form.cwd,
                  placeholder: '留空则沿用当前终端目录',
                  onChange: (event) => update({ cwd: event.target.value }),
                }),
              ),
            ),
            h(
              'div',
              { className: 'gcmd-field' },
              h('span', { className: 'gcmd-field-label' }, '说明'),
              h('input', {
                value: form.description,
                placeholder: '可选，显示在命令库的副标题里',
                onChange: (event) => update({ description: event.target.value }),
              }),
            ),
            h(
              'label',
              { className: 'gcmd-check' },
              h('input', {
                type: 'checkbox',
                checked: form.confirm,
                onChange: (event) => update({ confirm: event.target.checked }),
              }),
              '执行前二次确认',
            ),
            error ? h('div', { className: 'gcmd-form-error' }, error) : null,
          ),
          h(
            'div',
            { className: 'gcmd-actions' },
            isNew
              ? null
              : h(
                  'button',
                  {
                    className: 'gcmd-btn',
                    'data-tone': 'danger',
                    onClick: async () => {
                      if (!window.confirm('删除这条命令？')) return
                      await removeAction(form.id)
                      store.set({ editorOpen: false, editorDraft: null })
                      store.notify('已删除')
                    },
                  },
                  '删除',
                ),
            isNew
              ? null
              : h(
                  'button',
                  { className: 'gcmd-btn', onClick: () => moveAction(form.id, -1), title: '上移' },
                  '↑',
                ),
            isNew
              ? null
              : h('button', { className: 'gcmd-btn', onClick: () => moveAction(form.id, 1), title: '下移' }, '↓'),
            h('span', { className: 'gcmd-spacer' }),
            h('button', { className: 'gcmd-btn', onClick: () => store.set({ editorOpen: false, editorDraft: null }) }, '取消'),
            h(
              'button',
              { className: 'gcmd-btn', 'data-tone': 'primary', disabled: saving, onClick: save },
              saving ? '保存中…' : '保存',
            ),
          ),
        ),
      )
    }

    /* --------------------------- 组件：设置 --------------------------- */

    function Settings({ state }) {
      const [form, setForm] = useState(state.settings)
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)

      const save = async () => {
        setSaving(true)
        setError('')
        try {
          await saveActions(state.actions, { ...state.settings, ...form })
          store.set({ settingsOpen: false })
          store.notify('设置已保存')
        } catch (err) {
          setError(errorText(err))
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { className: 'gcmd-overlay', onMouseDown: () => store.set({ settingsOpen: false }) },
        h(
          'div',
          { className: 'gcmd-sheet', onMouseDown: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'gcmd-sheet-head' },
            h('span', { className: 'gcmd-sheet-title' }, '偏好设置'),
            h('button', { className: 'gcmd-sheet-close', title: '关闭', onClick: () => store.set({ settingsOpen: false }) }, '✕'),
          ),
          h(
            'div',
            { className: 'gcmd-form' },
            h(
              'div',
              { className: 'gcmd-field-row' },
              h(
                'div',
                { className: 'gcmd-field' },
                h('span', { className: 'gcmd-field-label' }, '新终端默认 shell'),
                h(
                  'select',
                  {
                    value: form.defaultShell || 'auto',
                    onChange: (event) => setForm({ ...form, defaultShell: event.target.value }),
                  },
                  SHELLS.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
                ),
              ),
              h(
                'div',
                { className: 'gcmd-field' },
                h('span', { className: 'gcmd-field-label' }, '新终端默认目录'),
                h('input', {
                  value: form.defaultCwd || '',
                  placeholder: '留空则用 DSH 的工作目录',
                  onChange: (event) => setForm({ ...form, defaultCwd: event.target.value }),
                }),
              ),
            ),
            h(
              'div',
              { className: 'gcmd-field' },
              h('span', { className: 'gcmd-field-label' }, '单条命令超时（秒，0 = 一直运行）'),
              h('input', {
                type: 'number',
                min: 0,
                max: Math.round(((state.env && state.env.maxTimeoutMs) || 1800000) / 1000),
                value: Math.round((form.timeoutMs || 0) / 1000),
                onChange: (event) => {
                  const seconds = Number(event.target.value)
                  const max = Math.round(((state.env && state.env.maxTimeoutMs) || 1800000) / 1000)
                  setForm({
                    ...form,
                    timeoutMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, max) * 1000 : 0,
                  })
                },
              }),
            ),
            h(
              'div',
              { className: 'gcmd-field' },
              h('span', { className: 'gcmd-field-label' }, '数据文件'),
              h('input', { value: state.env ? state.env.dataFile : '加载中…', readOnly: true }),
            ),
            error ? h('div', { className: 'gcmd-form-error' }, error) : null,
          ),
          h(
            'div',
            { className: 'gcmd-actions' },
            h('span', { className: 'gcmd-spacer' }),
            h('button', { className: 'gcmd-btn', onClick: () => store.set({ settingsOpen: false }) }, '取消'),
            h(
              'button',
              { className: 'gcmd-btn', 'data-tone': 'primary', disabled: saving, onClick: save },
              saving ? '保存中…' : '保存',
            ),
          ),
        ),
      )
    }

    /* --------------------------- 组件：控制台 --------------------------- */

    function Dock({ state }) {
      const tab = state.tabs.find((item) => item.id === state.activeId) || state.tabs[0] || null
      const pos = clampPos(state.dockPos)

      return h(
        'div',
        {
          className: 'gcmd-dock',
          'data-dragging': state.dragging ? 'true' : 'false',
          'data-running': tab && tab.running ? 'true' : 'false',
          style: { left: `${pos.x}px`, top: `${pos.y}px` },
        },
        // 命令在跑：顶沿一条流动光带，点它就是停止（不再有「运行中」文字条）
        tab && tab.running
          ? h('div', {
              className: 'gcmd-progress',
              title: '停止这个命令（Esc）',
              onMouseDown: (event) => {
                event.stopPropagation()
                stopRun(tab.id)
              },
            })
          : null,
        h(TabsBar, { tabs: state.tabs, activeId: state.activeId }),
        h(Output, { tab, env: state.env }),
        state.paletteOpen ? h(Palette, { state }) : null,
        state.editorOpen && state.editorDraft ? h(Editor, { draft: state.editorDraft }) : null,
        state.settingsOpen ? h(Settings, { state }) : null,
        state.closing ? h(CloseConfirm, { state }) : null,
        state.notice ? h('div', { className: 'gcmd-notice' }, state.notice) : null,
      )
    }

    /* --------------------------- 组件：关闭确认 --------------------------- */

    function CloseConfirm({ state }) {
      const tab = state.tabs.find((item) => item.id === state.closing) || null
      const running = Boolean(tab && tab.running)
      return h(
        'div',
        { className: 'gcmd-modal', onMouseDown: (event) => event.stopPropagation() },
        h(
          'div',
          { className: 'gcmd-modal-card', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'gcmd-modal-title' }, '关闭这个终端？'),
          h(
            'div',
            { className: 'gcmd-modal-text' },
            running
              ? '这个终端里还有命令在运行，关闭会一并终止它，输出也会一起消失。'
              : '关闭后这个标签和它的输出都会消失，不会影响其他终端。',
          ),
          h(
            'div',
            { className: 'gcmd-modal-actions' },
            h('button', { className: 'gcmd-modal-btn', onClick: cancelClose }, '取消'),
            h(
              'button',
              { className: 'gcmd-modal-btn', 'data-tone': 'danger', onClick: confirmClose },
              running ? '终止并关闭' : '关闭',
            ),
          ),
        ),
      )
    }

    /* --------------------------- 组件：根 --------------------------- */

    function DockOverlay() {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)

      useEffect(() => {
        bootstrap()
      }, [])

      useEffect(() => {
        if (!state.ready) return undefined
        if (state.tabs.length === 0) {
          const tab = makeTab({
            shell: state.settings.defaultShell,
            cwd: state.settings.defaultCwd || (state.env && state.env.cwd) || '',
          })
          store.set({ tabs: [tab], activeId: tab.id })
        } else if (!state.tabs.some((tab) => tab.id === state.activeId)) {
          store.set({ activeId: state.tabs[0].id })
        }
        return undefined
      }, [state.ready, state.tabs.length])

      // 浮窗是「固定」的：开合状态与位置都记住，刷新页面后还回到原处
      useEffect(() => {
        writePrefs({ open: state.dockOpen })
      }, [state.dockOpen])

      useEffect(() => {
        if (!state.dockOpen) return undefined
        const onResize = () => store.set({ dockPos: clampPos(store.get().dockPos) })
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [state.dockOpen])

      useEffect(() => {
        const onKeyDown = (event) => {
          const modifier = event.ctrlKey || event.metaKey
          if (modifier && event.shiftKey && (event.key === 'k' || event.key === 'K')) {
            event.preventDefault()
            if (!store.get().dockOpen) focusPromptOnAppear = true
            store.set((prev) => ({ dockOpen: !prev.dockOpen }))
            return
          }
          const state = store.get()
          if (!state.dockOpen) return
          // 确认框开着时只认 Enter / Esc，别让别的快捷键抢走按键
          if (state.closing) {
            if (event.key === 'Enter') {
              event.preventDefault()
              confirmClose()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancelClose()
            }
            return
          }
          if (modifier && !event.shiftKey && (event.key === 'k' || event.key === 'K')) {
            event.preventDefault()
            store.set((prev) => ({ paletteOpen: !prev.paletteOpen, settingsOpen: false, editorOpen: false }))
            return
          }
          if (modifier && !event.shiftKey && (event.key === 'n' || event.key === 'N')) {
            event.preventDefault()
            store.set({ editorOpen: true, editorDraft: blankDraft() })
            return
          }
          if (modifier && (event.key === 't' || event.key === 'T')) {
            event.preventDefault()
            createTab()
            return
          }
          if (modifier && (event.key === 'w' || event.key === 'W')) {
            event.preventDefault()
            requestClose(state.activeId)
            return
          }
          if (modifier && (event.key === 'l' || event.key === 'L')) {
            event.preventDefault()
            store.patchTab(state.activeId, { lines: [], exit: null })
            return
          }
          if (modifier && (event.key === 'c' || event.key === 'C')) {
            const tab = state.tabs.find((item) => item.id === state.activeId)
            if (tab && tab.running) {
              event.preventDefault()
              stopRun(tab.id)
            }
            return
          }
          if (modifier && /^[1-9]$/.test(event.key)) {
            event.preventDefault()
            selectTab(Number(event.key) - 1)
            return
          }
          if (event.key === 'Escape') {
            if (state.paletteOpen || state.editorOpen || state.settingsOpen) {
              store.set({ paletteOpen: false, editorOpen: false, editorDraft: null, settingsOpen: false })
              return
            }
            const tab = state.tabs.find((item) => item.id === state.activeId)
            if (tab && tab.running) {
              event.preventDefault()
              stopRun(tab.id)
              return
            }
            store.set({ dockOpen: false })
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [])

      if (state.error) {
        if (!state.dockOpen) return null
        const pos = clampPos(state.dockPos)
        return h(
          'div',
          { className: 'gcmd-root' },
          h(
            'div',
            {
              className: 'gcmd-dock',
              style: { left: `${pos.x}px`, top: `${pos.y}px`, height: 'auto', padding: '16px' },
            },
            h('div', { className: 'gcmd-form-error' }, state.error),
            h(
              'div',
              { style: { marginTop: 10 } },
              h(
                'button',
                { className: 'gcmd-btn', onClick: () => bootstrap(true) },
                '重试',
              ),
            ),
          ),
        )
      }

      if (!state.dockOpen) return null

      return h('div', { className: 'gcmd-root' }, h(Dock, { state }))
    }

    /* 侧栏底部入口：与「设置」并排，属于界面镶边而不是悬浮控件 */
    function ConsoleAction({ wide }) {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)

      useEffect(() => {
        bootstrap()
      }, [])

      return h(
        'button',
        {
          className: 'gcmd-foot',
          'data-open': state.dockOpen ? 'true' : 'false',
          title: `全局控制台（${IS_MAC ? '⌘⇧K' : 'Ctrl+Shift+K'}）`,
          'aria-label': '全局控制台',
          onClick: () => {
            if (!store.get().dockOpen) focusPromptOnAppear = true
            store.set((prev) => ({ dockOpen: !prev.dockOpen }))
          },
        },
        h('span', { className: 'gcmd-foot-glyph' }, '❯_'),
        wide ? h('span', { className: 'gcmd-foot-label' }, '控制台') : null,
      )
    }

    /* --------------------------- 插件入口 --------------------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.footer.action', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.footer.action',
                  id: 'dsh-global-cmd:launcher',
                  order: 10,
                  registrant: 'dsh-global-cmd',
                  label: () => '控制台',
                },
                ConsoleAction,
              ),
            ),
          'global-cmd: sidebar action',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register(
                {
                  name: 'shell.overlay',
                  id: 'dsh-global-cmd:dock',
                  order: 60,
                  registrant: 'dsh-global-cmd',
                },
                DockOverlay,
              ),
            ),
          'global-cmd: dock overlay',
        )
      },
    }
  },
})
