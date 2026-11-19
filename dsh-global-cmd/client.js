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
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /* ------------------------------- 常量 ------------------------------- */

    const API = '/dsh-global-cmd/api'
    const STYLE_ID = 'dsh-global-cmd-style'
    const PREFS_KEY = 'dsh-global-cmd:console:v1'
    const POLL_MS = 80
    const FIRST_POLL_MS = 20
    /** 界面里保留的输出行数上限：只影响屏幕上的回滚缓冲，完整日志用「下载日志」导出 */
    const MAX_LINES = 20000
    /**
     * 一次真正挂进 DOM 的行数。
     * 以前把两万行全塞进 DOM，每来一批输出（80ms）就整块重渲染，浏览器光排版就卡住了。
     * 现在只挂最后 TAIL_LINES 行，更早的用顶部按钮按 MORE_LINES 一批往上翻。
     */
    const TAIL_LINES = 600
    const MORE_LINES = 2000
    /** 提示符输入框跟着多行内容长高，最多长到这个高度（再高就框内滚动） */
    const MAX_PROMPT_HEIGHT = 168
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
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`)
        error.status = response.status
        // 插件被 disable/enable 重载的那一瞬间，路由还没注册上，
        // DSH 会回一个非 JSON 的 404 页面 —— 这不是「任务没了」，过几秒就好
        error.pluginMissing = !payload && response.status === 404
        throw error
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
      logUrl: (id, stream) => `${API}/exec/${id}/log?stream=${stream || 'out'}`,
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
.gcmd-line { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; padding: 0; }
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

/* 提示符：紧接在输出区最后一行，「路径>」之后直接打字。
   排版按真终端来：第一行从「路径>」后面开始，命令一折行，续行就回到左边距、吃满整行。
   以前是 flex 行，折出来的每一行都被挤在「路径>」右边那条窄缝里。 */
.gcmd-prompt {
  position: relative; display: block;
  margin-top: 0; padding: 2px 0 0;
  background: transparent;
  font-family: inherit; font-size: inherit; line-height: inherit;
}
/* 「路径>」只在第一行占位：绝对定位在左上角，输入框用 text-indent 让开它，
   于是折行后的第二行起自然回到 x=0（textarea 的 text-indent 只影响第一行） */
.gcmd-prompt-prefix {
  position: absolute; left: 0; top: 2px;
  display: flex; align-items: baseline; gap: 0;
  max-width: 70%; overflow: hidden; pointer-events: none;
}
.gcmd-path {
  /* 目录太长时靠收缩 + 省略号收尾，别把「>」顶出可视区 */
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--gcmd-accent); user-select: none;
  text-shadow: 0 0 14px rgba(53, 230, 197, .28);
}
.gcmd-prompt-mark {
  flex: none; color: var(--gcmd-accent); user-select: none;
  text-shadow: 0 0 14px rgba(53, 230, 197, .34);
}
.gcmd-input {
  width: 100%; height: 1.44em; padding: 0; border: none; outline: none;
  background: transparent; color: #eef7fb;
  font-family: inherit; font-size: inherit; line-height: inherit;
  caret-color: var(--gcmd-accent);
  /* 提示符是 textarea：单行时一行高，多行时由 JS 按内容撑高（上限 MAX_PROMPT_HEIGHT） */
  resize: none; overflow-y: auto; overflow-x: hidden;
  /* 长命令自动折行显示（pre-wrap 只影响显示，不会往命令里塞换行符）；
     anywhere 让一条超长的无空格路径/URL 也能断开，不至于被横向裁掉 */
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
  max-height: 168px; display: block;
}
.gcmd-input::-webkit-scrollbar { width: 8px; }
.gcmd-input::-webkit-scrollbar-thumb { background: rgba(53, 230, 197, .18); border-radius: 4px; }
.gcmd-input-hint {
  display: block; padding-top: 2px; text-align: right;
  font-size: 11px; line-height: 1.6; color: var(--gcmd-dim); opacity: .72; user-select: none;
}
/* 输出太长时只挂最后一段，上面用一个淡淡的按钮往回翻 */
.gcmd-more {
  display: block; width: 100%; margin: 0 0 8px; padding: 3px 6px;
  border: 1px dashed rgba(53, 230, 197, .26); border-radius: 4px;
  background: transparent; color: var(--gcmd-dim);
  font-family: inherit; font-size: 12px; line-height: 1.5; cursor: pointer;
}
.gcmd-more:hover { color: var(--gcmd-accent); border-color: rgba(53, 230, 197, .5); background: rgba(53, 230, 197, .06); }

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
.gcmd-chips {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  padding: 0 12px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, #34343a);
}
.gcmd-chips-label {
  color: var(--dsw-alias-label-tertiary, #6f6f78);
  font-size: 11px; letter-spacing: .4px;
}
.gcmd-chips-sep { width: 1px; height: 12px; margin: 0 2px; background: var(--gcmd-line-2); }
.gcmd-chip {
  height: 21px; padding: 0 9px; border-radius: 999px;
  border: 1px solid var(--gcmd-line-2); background: transparent;
  color: var(--dsw-alias-label-secondary, #9a9aa3);
  font-size: 11.5px; line-height: 1; white-space: nowrap;
}
.gcmd-chip:hover { color: var(--dsw-alias-label-primary, #fff); border-color: rgba(53, 230, 197, .45); }
.gcmd-chip[data-active="true"] {
  color: #0b1a17; border-color: transparent;
  background: linear-gradient(180deg, #46efd5, #2cc7ae);
}
.gcmd-chip-platform[data-active="true"] { background: linear-gradient(180deg, #9db7ff, #6f8cf0); color: #0a1020; }
.gcmd-static {
  height: 26px; display: flex; align-items: center;
  color: var(--dsw-alias-label-secondary, #8b8b94); font-size: 12px;
}
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
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 12px;
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
.gcmd-pager { display: flex; align-items: center; gap: 6px; }
.gcmd-pager-btn {
  height: 22px; padding: 0 8px; border-radius: 5px; font-size: 11.5px;
  border: 1px solid var(--dsw-alias-border-l1, #34343a); background: transparent;
  color: var(--dsw-alias-label-secondary, #9a9aa2);
}
.gcmd-pager-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #fff); border-color: var(--gcmd-line-2); }
.gcmd-pager-btn:disabled { opacity: .35; cursor: default; }
.gcmd-pager-label { color: var(--dsw-alias-label-secondary, #8b8b94); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.gcmd-item-run {
  flex: none; height: 22px; padding: 0 8px; border-radius: 5px;
  border: 1px solid rgba(53, 230, 197, .3); background: rgba(53, 230, 197, .08);
  color: #2fd3b5; font-size: 11.5px; opacity: 0;
}
.gcmd-item:hover .gcmd-item-run, .gcmd-item[data-active="true"] .gcmd-item-run { opacity: 1; }
.gcmd-item-run:hover { background: rgba(53, 230, 197, .2); border-color: rgba(53, 230, 197, .6); }

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

    /* 聊天代码块上的「收藏到 CMD」按钮：它挂在 Chat 的 fence 槽位里，
       不在 .gcmd-root 之内，所以这套样式单独注入、单独命名 */
    const FENCE_CSS = `
.gcmd-fence { margin: 0; }
.gcmd-fence-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.gcmd-fence-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 10px; border-radius: 6px;
  border: 1px solid rgba(53, 230, 197, .34); background: rgba(53, 230, 197, .1);
  color: #2fd3b5; font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
}
.gcmd-fence-btn:hover { background: rgba(53, 230, 197, .2); border-color: rgba(53, 230, 197, .62); color: #7bf3dc; }
.gcmd-fence-btn:active { background: rgba(53, 230, 197, .3); }
.gcmd-fence-btn:disabled { opacity: .6; cursor: default; }
.gcmd-fence-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #8b8b94); }
`

    function ensureFenceStyle() {
      let style = document.getElementById(`${STYLE_ID}-fence`)
      if (!style) {
        style = document.createElement('style')
        style.id = `${STYLE_ID}-fence`
        document.head.appendChild(style)
      }
      if (style.textContent !== FENCE_CSS) style.textContent = FENCE_CSS
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
        lastJob: null,
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

    /* --------------------------- ANSI 着色 --------------------------- */

    // 命令输出是写进日志文件的（没有 TTY），颜色由 Host 侧的环境变量打开，
    // 所以这里得把 ESC[..m 还原成带颜色的 span：否则要么看到一串生硬的转义，要么整片黑白。
    const ANSI_BASE = ['#3b3b3b', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5']
    const ANSI_BRIGHT = ['#6e6e6e', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']
    const ANSI_CACHE = new Map()

    function ansi256Color(n) {
      if (!Number.isFinite(n) || n < 0) return null
      if (n < 8) return ANSI_BASE[n]
      if (n < 16) return ANSI_BRIGHT[n - 8]
      if (n < 232) {
        const steps = [0, 95, 135, 175, 215, 255]
        const index = n - 16
        return `rgb(${steps[Math.floor(index / 36)]},${steps[Math.floor(index / 6) % 6]},${steps[index % 6]})`
      }
      if (n < 256) {
        const level = 8 + (n - 232) * 10
        return `rgb(${level},${level},${level})`
      }
      return null
    }

    /** 把一组 SGR 参数叠加到当前样式上；0 会清空所有样式 */
    function applySgr(style, params) {
      let next = style ? { ...style } : {}
      for (let i = 0; i < params.length; i += 1) {
        const code = params[i]
        if (code === 0) {
          next = {}
        } else if (code === 1) {
          next.bold = true
        } else if (code === 2) {
          next.dim = true
        } else if (code === 3) {
          next.italic = true
        } else if (code === 4) {
          next.underline = true
        } else if (code === 7) {
          next.inverse = true
        } else if (code === 9) {
          next.strike = true
        } else if (code === 22) {
          delete next.bold
          delete next.dim
        } else if (code === 23) {
          delete next.italic
        } else if (code === 24) {
          delete next.underline
        } else if (code === 27) {
          delete next.inverse
        } else if (code === 29) {
          delete next.strike
        } else if (code >= 30 && code <= 37) {
          next.color = ANSI_BASE[code - 30]
        } else if (code === 39) {
          delete next.color
        } else if (code >= 40 && code <= 47) {
          next.background = ANSI_BASE[code - 40]
        } else if (code === 49) {
          delete next.background
        } else if (code >= 90 && code <= 97) {
          next.color = ANSI_BRIGHT[code - 90]
        } else if (code >= 100 && code <= 107) {
          next.background = ANSI_BRIGHT[code - 100]
        } else if (code === 38 || code === 48) {
          const key = code === 38 ? 'color' : 'background'
          if (params[i + 1] === 5) {
            next[key] = ansi256Color(params[i + 2]) || next[key]
            i += 2
          } else if (params[i + 1] === 2) {
            const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]]
            if ([r, g, b].every((value) => Number.isFinite(value))) next[key] = `rgb(${r},${g},${b})`
            i += 4
          } else {
            i += 1
          }
        }
      }
      return Object.keys(next).length ? next : null
    }

    /** 把一行文本切成 [{ text, style }]；没有转义序列时返回 null，调用方直接用纯文本 */
    function parseAnsi(text) {
      const segments = []
      let style = null
      let buffer = ''
      const flush = () => {
        if (buffer === '') return
        segments.push({ text: buffer, style })
        buffer = ''
      }
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        if (ch !== '\u001b') {
          buffer += ch
          continue
        }
        flush()
        const next = text[i + 1]
        if (next === '[') {
          let j = i + 2
          while (j < text.length && /[0-9;?]/.test(text[j])) j += 1
          if (text[j] === 'm') {
            const params = text.slice(i + 2, j).split(';').map((item) => (item === '' ? 0 : Number(item) || 0))
            style = applySgr(style, params)
          }
          // 光标移动、清屏等序列一律忽略
          i = j
          continue
        }
        if (next === ']') {
          let j = i + 2
          while (j < text.length && text[j] !== '\u0007' && !(text[j] === '\u001b' && text[j + 1] === '\\')) j += 1
          i = text[j] === '\u001b' ? j + 1 : j
          continue
        }
        i += 1
      }
      flush()
      return segments
    }

    function ansiSegments(text) {
      if (!text || !text.includes('\u001b')) return null
      if (!ANSI_CACHE.has(text)) {
        if (ANSI_CACHE.size > 4000) ANSI_CACHE.clear()
        ANSI_CACHE.set(text, parseAnsi(text))
      }
      return ANSI_CACHE.get(text)
    }

    /** 去掉转义序列：复制、导出、以及「不是内部或外部命令」这类匹配都要用干净文本 */
    function stripAnsi(text) {
      const segments = ansiSegments(text)
      return segments ? segments.map((segment) => segment.text).join('') : text
    }

    function ansiCss(style) {
      if (!style) return null
      const css = {}
      let color = style.color
      let background = style.background
      if (style.inverse) {
        const swap = color
        color = background || 'var(--gcmd-bg, #101014)'
        background = swap || 'var(--gcmd-text, #e9e9ec)'
      }
      if (color) css.color = color
      if (background) css.background = background
      if (style.bold) css.fontWeight = 700
      if (style.dim) css.opacity = 0.68
      if (style.italic) css.fontStyle = 'italic'
      const decoration = []
      if (style.underline) decoration.push('underline')
      if (style.strike) decoration.push('line-through')
      if (decoration.length) css.textDecoration = decoration.join(' ')
      return css
    }

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
        // Windows 的 \r\n 在 DOM 里会多出空行，统一成 \n 再拆行；
        // 单独的 \r（进度条回行首）留给下面按「覆盖」处理
        const parts = String(chunk.d ?? '').replace(/\r\n/g, '\n').split('\n')
        for (const part of parts) {
          if (part === '') continue
          // 进度条那种「回到行首覆盖」的写法，只保留最后一次刷新的内容
          const overwritten = part.includes('\r') ? part.split('\r').filter((item) => item !== '') : null
          const text = overwritten ? (overwritten[overwritten.length - 1] ?? '') : part
          if (text !== '') out.push({ kind, text })
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
        if (created.reused) pushLine(tabId, 'info', '[这条命令已经在跑了，接上它的输出]')
      } catch (error) {
        pushLine(
          tabId,
          'err',
          error && error.pluginMissing
            ? '无法执行：插件正在重载，等几秒再试一次'
            : `无法执行：${errorText(error)}`,
        )
        store.patchTab(tabId, { running: null })
        return
      }
      store.patchTab(tabId, (tab) => ({
        running: { id: jobId, command, startedAt: tab.running?.startedAt ?? Date.now() },
        lastJob: jobId,
      }))
      persistTabs()
      startPolling(tabId, jobId)
    }

    /** 轮询一个任务直到结束；页面刷新后也用它把还在跑的任务接回来 */
    function startPolling(tabId, jobId) {
      let after = 0
      let polls = 0
      let notACommand = false
      let retry = 0
      const tick = async () => {
        timers.delete(jobId)
        if (!getTab(tabId)) return
        let result
        try {
          result = await api.poll(jobId, after)
          retry = 0
        } catch (error) {
          const message = errorText(error)
          const missingPlugin = !!(error && error.pluginMissing)
          const gone = !missingPlugin && (message.includes('任务不存在') || (error && error.status === 404))
          if (gone) {
            // Host 明确说这个任务不在了（被清理 / 被挤出了登记表）
            pushLine(tabId, 'info', '[这条命令已经不在 Host 里了（插件重载过，或任务已被清理）]')
            store.patchTab(tabId, { running: null })
            persistTabs()
            return
          }
          if (retry < 6) {
            // 插件重载 / Host 重启的窗口里路由会短暂消失，先重试再放弃
            retry += 1
            pushLine(tabId, 'info', `[Host 暂时联系不上（插件可能正在重载），${retry}/6 次重试中…]`)
            timers.set(jobId, window.setTimeout(tick, 600 * retry))
            return
          }
          pushLine(
            tabId,
            'info',
            missingPlugin
              ? '[插件重载后没能接回这条命令，它可能已经被清理了]'
              : `读取输出失败：${message}`,
          )
          store.patchTab(tabId, { running: null })
          persistTabs()
          return
        }
        after = result.next
        const incoming = chunksToLines(result.chunks || [])
        for (const line of incoming) {
if (line.kind === 'err' && /不是内部或外部命令|无法将.*项识别为|is not recognized as an internal/i.test(stripAnsi(line.text))) {
            notACommand = true
          }
        }
        pushLines(tabId, incoming)
        polls += 1
        if (result.more) {
          // 后端还有一批没搬完的输出（一次最多回几千行）：别等 80ms，立刻接着要下一批
          timers.set(jobId, window.setTimeout(tick, 0))
          return
        }
        if (!result.done) {
          // 刚开始跑的命令前几轮问得勤一点：cmd 启动就要几十毫秒，
          // 这样 echo 这类秒回的命令不用干等满一个轮询周期
          timers.set(jobId, window.setTimeout(tick, polls < 3 ? 30 : POLL_MS))
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
    async function runCommand(tabId, rawCommand, shellOverride) {
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

      // cd / cls / exit / shell 这些本地拦截只对单行命令有意义：
      // 多行脚本里只要有一行以 cd 开头，整段就会被当成换目录而吞掉。
      if (!/[\r\n]/.test(command)) {
        const lower = command.toLowerCase()
        if (lower === 'cls' || lower === 'clear') {
          store.patchTab(tabId, { lines: [], exit: null })
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
      }

      runExec(tabId, command, shellOverride || tab.shell, tab.cwd)
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
      return {
        id: '',
        name: '',
        description: '',
        group: '',
        shell: 'auto',
        cwd: '',
        command: '',
        commandLinux: '',
        confirm: false,
      }
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
        commandLinux: action.commandLinux || '',
        confirm: action.confirm === true,
      }
    }

    async function submitDraft(draft) {
      const state = store.get()
      const command = String(draft.command || '').trim()
      const commandLinux = String(draft.commandLinux || '').trim()
      // 只填 Linux 版本也允许：切到 Linux 平台时它就是主命令
      if (!command && !commandLinux) throw new Error('命令内容不能为空')
      const next = {
        ...draft,
        command,
        commandLinux,
        name:
          String(draft.name || '').trim() || (command || commandLinux).split('\n')[0].trim() || '未命名命令',
      }
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

    /* --------------------------- 推荐命令：诊断 / 容器 / 部署 --------------------------- */

    // Windows 上默认 shell 是 cmd，所以 PowerShell 的条目都显式写 shell: 'powershell'，
    // 命令里不要出现 ${...}，避免被模板字符串当成插值。
    const PRESET_ACTIONS = [
      {
        name: 'CPU 占用 Top15',
        description: '按累计 CPU 时间排前 15 的进程',
        group: '诊断',
        shell: 'powershell',
        cwd: '',
        command: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, @{ n='CPU(s)'; e={ [math]::Round($_.CPU, 1) } }, @{ n='内存(MB)'; e={ [math]::Round($_.WS/1MB, 1) } } | Format-Table -AutoSize",
        confirm: false,
        commandLinux: 'ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 16',
      },
      {
        name: '内存占用 Top15',
        description: '按工作集排前 15 的进程',
        group: '诊断',
        shell: 'powershell',
        cwd: '',
        command: "Get-Process | Sort-Object WS -Descending | Select-Object -First 15 Name, Id, @{ n='内存(MB)'; e={ [math]::Round($_.WS/1MB, 1) } } | Format-Table -AutoSize",
        confirm: false,
        commandLinux: 'ps -eo pid,comm,%mem,rss --sort=-rss | head -n 16',
      },
      {
        name: '系统负载与内存',
        description: 'CPU 总占用、逻辑核数、内存总量与可用量',
        group: '诊断',
        shell: 'powershell',
        cwd: '',
        command: "Get-CimInstance Win32_Processor | Select-Object Name, LoadPercentage, NumberOfLogicalProcessors | Format-List; Get-CimInstance Win32_OperatingSystem | Select-Object @{ n='总内存(GB)'; e={ [math]::Round($_.TotalVisibleMemorySize/1MB, 2) } }, @{ n='可用内存(GB)'; e={ [math]::Round($_.FreePhysicalMemory/1MB, 2) } } | Format-List",
        confirm: false,
        commandLinux: 'uptime; echo; free -h; echo; nproc',
      },
      {
        name: '磁盘剩余空间',
        description: '各盘符已用 / 可用空间',
        group: '诊断',
        shell: 'powershell',
        cwd: '',
        command: "Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{ n='已用(GB)'; e={ [math]::Round($_.Used/1GB, 1) } }, @{ n='可用(GB)'; e={ [math]::Round($_.Free/1GB, 1) } } | Format-Table -AutoSize",
        confirm: false,
        commandLinux: 'df -h -x tmpfs -x devtmpfs',
      },
      {
        name: '端口监听一览',
        description: '所有 LISTENING 端口及其所属进程',
        group: '诊断',
        shell: 'powershell',
        cwd: '',
        command: "Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Select-Object LocalPort, OwningProcess, @{ n='进程'; e={ (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } } | Format-Table -AutoSize",
        confirm: false,
        commandLinux: 'ss -tlnp 2>/dev/null || netstat -tlnp',
      },
      {
        name: '查 8080 被谁占用',
        description: '改命令里的端口号即可查别的端口',
        group: '诊断',
        shell: 'powershell',
        cwd: '',
        command: "$p = (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if ($p) { Get-Process -Id $p | Select-Object Id, ProcessName, Path, StartTime | Format-List } else { '8080 没有程序在监听' }",
        confirm: false,
        commandLinux: 'ss -tlnp 2>/dev/null | grep \':8080 \' || lsof -nP -iTCP:8080 -sTCP:LISTEN',
      },
      {
        name: 'Java 进程一览',
        description: '含父进程与完整命令行，排查 mvn 孤儿进程用',
        group: '诊断',
        shell: 'powershell',
        cwd: '',
        command: "Get-CimInstance Win32_Process -Filter \"Name = 'java.exe'\" | Select-Object ProcessId, ParentProcessId, @{ n='命令行'; e={ $_.CommandLine } } | Format-List",
        confirm: false,
        commandLinux: 'ps -eo pid,ppid,etime,args | grep \'[j]ava\'',
      },
      {
        name: '结束占用 8080 的进程',
        description: '按端口找 PID 后 taskkill /T /F，会连子进程一起结束',
        group: '诊断',
        shell: 'cmd',
        cwd: '',
        command: 'for /f "tokens=5" %a in (\'netstat -ano ^| findstr :8080 ^| findstr LISTENING\') do taskkill /PID %a /T /F',
        confirm: true,
        commandLinux: 'pids=$(lsof -t -iTCP:8080 -sTCP:LISTEN 2>/dev/null); if [ -n "$pids" ]; then kill -9 $pids; else echo \'8080 没有程序在监听\'; fi',
      },
      {
        name: 'Docker 容器状态',
        description: '名称 / 镜像 / 状态 / 端口映射',
        group: '容器',
        shell: 'cmd',
        cwd: '',
        command: 'docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"',
        confirm: false,
        commandLinux: 'docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"',
      },
      {
        name: 'Docker 资源占用',
        description: '一次性快照，不会一直刷',
        group: '容器',
        shell: 'cmd',
        cwd: '',
        command: 'docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}"',
        confirm: false,
        commandLinux: 'docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}"',
      },
      {
        name: 'Docker 镜像列表',
        description: '仓库 / 标签 / 大小 / 构建时间',
        group: '容器',
        shell: 'cmd',
        cwd: '',
        command: 'docker images --format "table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}"',
        confirm: false,
        commandLinux: 'docker images --format "table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}"',
      },
      {
        name: 'Docker 空间占用明细',
        description: '镜像、容器、卷、构建缓存各占多少',
        group: '容器',
        shell: 'cmd',
        cwd: '',
        command: 'docker system df -v',
        confirm: false,
        commandLinux: 'docker system df -v',
      },
      {
        name: 'Docker 清理无用资源',
        description: '停止的容器 / 悬空镜像 / 无用网络，不动卷',
        group: '容器',
        shell: 'cmd',
        cwd: '',
        command: 'docker system prune -f',
        confirm: true,
        commandLinux: 'docker system prune -f',
      },
      {
        name: '容器日志（跟随）',
        description: '把「容器名」改成实际容器再执行',
        group: '容器',
        shell: 'cmd',
        cwd: '',
        command: 'docker logs -f --tail 200 容器名',
        confirm: false,
        commandLinux: 'docker logs -f --tail 200 容器名',
      },
      {
        name: 'Maven 打包（跳过测试）',
        description: '多线程构建，产物在 target 下',
        group: '部署',
        shell: 'cmd',
        cwd: '',
        command: 'mvn -T 1C clean package -DskipTests',
        confirm: false,
        commandLinux: 'mvn -T 1C clean package -DskipTests',
      },
      {
        name: 'Git 状态速览',
        description: '分支 / 增删行数 + 最近 5 条提交',
        group: '部署',
        shell: 'cmd',
        cwd: '',
        command: 'git status -sb && git log --oneline -5',
        confirm: false,
        commandLinux: 'git status -sb && git log --oneline -5',
      },
      {
        name: 'Git 同步远端',
        description: 'fetch 全部远端并清理已删除分支',
        group: '部署',
        shell: 'cmd',
        cwd: '',
        command: 'git fetch --all --prune && git status -sb',
        confirm: false,
        commandLinux: 'git fetch --all --prune && git status -sb',
      },
      {
        name: '网络连通性测试',
        description: '本机回环 4 个包，验证网络栈',
        group: '诊断',
        shell: 'cmd',
        cwd: '',
        command: 'ping -n 4 127.0.0.1',
        confirm: false,
        commandLinux: 'ping -c 4 127.0.0.1',
      },
      {
        name: '关键环境变量',
        description: 'JDK / Maven / Node / Python / Docker 相关变量',
        group: '诊断',
        shell: 'cmd',
        cwd: '',
        command: 'set | findstr /i "JAVA_HOME MAVEN_HOME NODE_HOME PYTHON DOCKER"',
        confirm: false,
        commandLinux: 'env | grep -E "JAVA_HOME|MAVEN_HOME|NODE_HOME|PYTHON|DOCKER"',
      },
      {
        name: '当前目录大文件 Top20',
        description: '递归找体积最大的 20 个文件',
        group: '诊断',
        shell: 'powershell',
        cwd: '',
        command: "Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 20 FullName, @{ n='MB'; e={ [math]::Round($_.Length/1MB, 1) } } | Format-Table -AutoSize",
        confirm: false,
        commandLinux: 'find . -type f -printf \'%s %p\\n\' 2>/dev/null | sort -nr | head -n 20',
      },
    ]

    const PLATFORMS = [
      { value: 'auto', label: '自动' },
      { value: 'windows', label: 'Windows' },
      { value: 'linux', label: 'Linux' },
    ]

    /** 当前生效的命令平台：设置里选了就跟设置，选「自动」时按 Host 报的平台走 */
    function commandPlatform(state) {
      const chosen = (state && state.settings && state.settings.commandPlatform) || 'auto'
      if (chosen === 'windows' || chosen === 'linux') return chosen
      return state && state.env && state.env.platform === 'linux' ? 'linux' : 'windows'
    }

    /** 一条命令在指定平台下真正要执行的内容（没写对应平台就退回另一个平台的版本） */
    function pickCommand(action, platform) {
      if (!action) return ''
      const win = String(action.command || '').trim()
      const linux = String(action.commandLinux || '').trim()
      return platform === 'linux' ? linux || win : win || linux
    }

    // 切到 Linux 平台时，Windows 专属的 shell 一律换成 bash —— 否则 cmd 命令在 Linux 上根本起不来
    const LINUX_SHELL_MAP = { powershell: 'bash', pwsh: 'bash', cmd: 'bash' }

    function pickShell(action, platform) {
      const shell = (action && action.shell) || 'auto'
      if (platform === 'linux' && LINUX_SHELL_MAP[shell]) return 'bash'
      return shell
    }

    /** 把条目换成「当前平台真正可执行」的版本，后面填输入框和执行都走它 */
    function effectiveAction(action, state) {
      const platform = commandPlatform(state)
      return { ...action, command: pickCommand(action, platform), shell: pickShell(action, platform) }
    }

    /** 只补库里没有的推荐命令（按名字判断），不覆盖你改过的同名条目 */
    async function importPresets() {
      const state = store.get()
      const known = new Map(state.actions.map((action) => [String(action.name || '').trim(), action]))
      const add = PRESET_ACTIONS.filter((preset) => !known.has(preset.name)).map((preset) => ({
        ...preset,
        id: uid(),
      }))
      // 早先导入过的推荐命令没有 Linux 版本，这里只补空缺，不覆盖用户改过的命令
      let patched = 0
      const merged = state.actions.map((action) => {
        const preset = PRESET_ACTIONS.find((item) => item.name === action.name)
        if (!preset || !preset.commandLinux) return action
        if (String(action.commandLinux || '').trim()) return action
        patched += 1
        return { ...action, commandLinux: preset.commandLinux }
      })
      if (add.length === 0 && patched === 0) {
        store.notify('推荐命令都已经在库里了')
        return 0
      }
      await saveActions([...merged, ...add])
      if (add.length === 0) store.notify(`已补上 ${patched} 条命令的 Linux 版本`)
      else store.notify(`已加入 ${add.length} 条推荐命令${patched ? `（另有 ${patched} 条补上 Linux 版本）` : ''}`)
      return add.length
    }

    /* --------------------------- 代码块 → 命令库 --------------------------- */

    const FENCE_SHELL = {
      powershell: 'powershell',
      ps1: 'powershell',
      pwsh: 'powershell',
      cmd: 'cmd',
      bat: 'cmd',
      batch: 'cmd',
    }

    function shellForFence(lang) {
      return FENCE_SHELL[String(lang || '').toLowerCase()] || 'auto'
    }

    // 这些语言的代码块本身就是 POSIX shell，收藏时同时记成 Linux 版本
    const POSIX_LANGS = ['bash', 'sh', 'shell', 'zsh', 'fish', 'console', 'shell-session', 'terminal']

    /** 把聊天里的代码块收进命令库；命令已在库里时不重复加，只提示已有的名字 */
    async function collectFenceCommand(code, lang) {
      const command = String(code || '').trim()
      if (!command) return '这段代码是空的'
      // 从 Host 取一次最新的库内容再合并：控制台可能还没打开过（store 里是空的），
      // 直接拿本地 actions 覆盖会把已有命令全冲掉
      const remote = await api.state()
      const actions = Array.isArray(remote.actions) ? remote.actions : store.get().actions
      const same = actions.find(
        (action) =>
          String(action.command || '').trim() === command ||
          String(action.commandLinux || '').trim() === command,
      )
      if (same) {
        store.set({ actions })
        return `已经在命令库里：${same.name}`
      }
      const firstLine = command.split('\n')[0].trim()
      const posix = POSIX_LANGS.includes(lang)
      const action = {
        id: uid(),
        name: firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine || '来自聊天的命令',
        description: `从聊天代码块收藏（${lang || 'shell'}）`,
        group: '收藏',
        shell: shellForFence(lang),
        cwd: '',
        command,
        // bash/sh 这类代码块顺手记成 Linux 版本，切到 Linux 平台时能直接用
        commandLinux: posix ? command : '',
        confirm: false,
      }
      const saved = await api.saveState({
        version: 1,
        actions: [...actions, action],
        settings: { ...store.get().settings, ...(remote.settings || {}) },
      })
      store.set({
        actions: saved && Array.isArray(saved.actions) ? saved.actions : [...actions, action],
        settings: { ...store.get().settings, ...((saved && saved.settings) || {}) },
      })
      return '已收藏 · 控制台里（Ctrl+Shift+K）就能看到'
    }

    /**
     * 命令库条目的两种用法：
     *  - 'insert'（默认）：只把命令填进提示符输入框，你自己确认或改完再回车，不直接跑
     *  - 'run'：立刻执行（条目上的「运行」按钮，或 Ctrl/⌘ + 回车）
     */
    async function applyAction(action, mode) {
      const tab = activeTab()
      if (!tab || !action) return false
      // 先换成当前平台可执行的那一版（Windows / Linux 各一份命令）
      const resolved = effectiveAction(action, store.get())
      if (!String(resolved.command || '').trim()) {
        store.notify('这条命令在当前平台没有版本，先去编辑器补一下')
        return false
      }
      store.set({ paletteOpen: false })
      if (mode === 'run') return runConsoleAction(resolved, tab.id)

      let cwd = tab.cwd
      if (resolved.cwd) {
        // 条目自带的目录也走一次解析，避免相对路径把 Host 的 cwd 校验打挂
        try {
          const resolvedCwd = await api.cwd(resolved.cwd, tab.cwd)
          if (resolvedCwd.isDirectory) cwd = resolvedCwd.path
          else store.notify(`条目目录无效，仍用当前目录：${resolvedCwd.path}`)
        } catch (error) {
          store.notify(`解析工作目录失败：${errorText(error)}`)
        }
      }
      const shell = resolved.shell && resolved.shell !== 'auto' ? resolved.shell : tab.shell
      store.patchTab(tab.id, { draft: resolved.command || '', cwd, shell })
      persistTabs()
      focusPromptOnAppear = true
      focusPrompt()
      return true
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
        const actions = Array.isArray(remote.actions) ? remote.actions : []
        store.set({
          ready: true,
          error: '',
          actions,
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
        // 第一次装上插件、库里空空如也时，先把常用运维命令铺进去，省得面对空列表
        if (actions.length === 0) void importPresets()
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
      return h('div', { className: 'gcmd-line', 'data-kind': line.kind }, renderAnsi(line.text))
    })

    /** 有颜色就按 span 输出，没有就整段文本（别为了兼容给每行都套一层） */
    function renderAnsi(text) {
      const segments = ansiSegments(text)
      if (!segments) return text
      return segments.map((segment, index) => {
        const css = ansiCss(segment.style)
        return css ? h('span', { key: index, style: css }, segment.text) : segment.text
      })
    }

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
      // 是否贴着底部：用户往上翻看历史时就不再把他拽回底部
      const stick = useRef(true)
      const metrics = useRef({ height: 0, top: 0 })
      const prepending = useRef(false)
      const [extra, setExtra] = useState(0)
      const running = Boolean(tab && tab.running)
      const count = tab ? tab.lines.length : 0
      const tabId = tab ? tab.id : ''

      // 切标签时回到「只看最新一屏」
      useEffect(() => {
        setExtra(0)
        stick.current = true
      }, [tabId])

      useEffect(() => {
        const node = scroller.current
        if (!node) return
        const height = node.scrollHeight
        const prev = metrics.current
        if (stick.current) {
          node.scrollTop = height
        } else if (prepending.current) {
          // 上面补进了更早的行：视口一起下移相同高度，正在看的那几行不会跳
          node.scrollTop = prev.top + Math.max(0, height - prev.height)
        }
        prepending.current = false
        metrics.current = { height, top: node.scrollTop }
      }, [count, extra, running, tabId])

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
      // 贴底就跟着新输出走；往上翻过就停在那儿，新增的输出不会把视线顶走
      const onScroll = () => {
        const node = scroller.current
        if (!node) return
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        metrics.current = { height: node.scrollHeight, top: node.scrollTop }
      }

      // 只挂最后一段行：几万行全塞进 DOM 时，每来一批输出浏览器都要重新排版，界面就卡住了
      const total = tab.lines.length
      const limit = TAIL_LINES + extra
      const start = Math.max(0, total - limit)
      const visible = start > 0 ? tab.lines.slice(start) : tab.lines

      const children = [h('div', { className: 'gcmd-banner', key: 'banner' }, bannerText(env))]
      if (start > 0) {
        children.push(
          h(
            'button',
            {
              key: 'more',
              type: 'button',
              className: 'gcmd-more',
              onClick: () => {
                prepending.current = true
                setExtra((value) => value + MORE_LINES)
              },
            },
            `↑ 显示更早的行（上面还有 ${start} 行）`,
          ),
        )
      }
      visible.forEach((line, index) =>
        children.push(
          h(Line, {
            key: start + index,
            line,
            onReuse: line.kind === 'cmd' ? () => reuse(line.text) : undefined,
          }),
        ),
      )
      // 命令跑的时候不挂提示符：像真 cmd 一样，输出直接接在回显行后面，
      // 不会先冒出一行空提示符、等一会儿再补输出
      children.push(running ? null : h(PromptRow, { tab, key: 'prompt' }))

      return h(
        'div',
        {
          className: 'gcmd-scroll',
          ref: scroller,
          onMouseDown: startPress,
          onMouseUp: endPress,
          onScroll,
        },
        children,
      )
    }

    /* --------------------------- 组件：提示符 --------------------------- */

    function PromptRow({ tab }) {
      const inputRef = useRef(null)
      const prefixRef = useRef(null)
      const [draft, setDraft] = useState(tab ? tab.draft : '')
      // 第一行要让开「路径>」的宽度；折行后的续行靠 text-indent 自动回到左边距
      const [indent, setIndent] = useState(0)
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

      // 输入框跟着内容长高：多行命令要能一眼看全，最多长到 MAX_PROMPT_HEIGHT 再框内滚动
      // （放 layout effect：画之前就把高度定好，不然长命令会先闪一帧单行）
      useLayoutEffect(() => {
        const node = inputRef.current
        if (!node || !node.style) return
        node.style.height = 'auto'
        const next = Math.min(MAX_PROMPT_HEIGHT, node.scrollHeight || 0)
        if (next > 0) node.style.height = `${next}px`
      }, [draft])

      // 量出「路径>」有多宽：输入框第一行缩进这么多，折行后的续行才会回到左边距。
      // 每次渲染都量一次（很便宜），字体加载完宽度变了也能跟上
      useLayoutEffect(() => {
        const node = prefixRef.current
        if (!node || typeof node.getBoundingClientRect !== 'function') return
        const width = Math.ceil(node.getBoundingClientRect().width || 0)
        if (width > 0) setIndent((prev) => (Math.abs(prev - width) > 1 ? width : prev))
      })

      if (!tab) return null
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
        const node = event.target
        const multiLine = draft.includes('\n')
        if (event.key === 'Enter') {
          // Shift+Enter / Alt+Enter 换行，Enter 直接执行：
          // 想写多行就按住 Shift 回车，和聊天框的习惯一致
          if (event.shiftKey || event.altKey) return
          event.preventDefault()
          submit()
          return
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          // 只有光标已经贴到首/尾时才翻历史，否则光标得能在多行命令里正常上下移动
          const atStart = node && node.selectionStart === 0 && node.selectionEnd === 0
          const atEnd = node && node.selectionStart === node.value.length && node.selectionEnd === node.value.length
          if (event.key === 'ArrowUp' ? !atStart : !atEnd) return
          if (multiLine) return
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
          return
        }
        if (event.key === 'Escape' && multiLine) {
          // 多行时 Esc 先把命令清掉，免得手滑把一长段脚本发出去（再按一次才关浮窗）
          event.stopPropagation()
          event.preventDefault()
          commit('')
        }
      }

      return h(
        'div',
        {
          // 「路径>」绝对定位在第一行，输入框自己决定高度
          className: 'gcmd-prompt',
        },
        h(
          'span',
          { className: 'gcmd-prompt-prefix', ref: prefixRef },
          h('span', { className: 'gcmd-path', title: tab.cwd || '' }, promptText),
          h('span', { className: 'gcmd-prompt-mark' }, '>'),
        ),
        h('textarea', {
          ref: inputRef,
          className: 'gcmd-input',
          // 单行时就是一行高；多行时靠下面的 effect 按内容撑开（最多撑到 MAX_PROMPT_HEIGHT）
          rows: 1,
          value: draft,
          spellCheck: false,
          autoComplete: 'off',
          // soft：长命令超过框宽就折行显示（命令本身仍是同一行，不会有换行符）
          wrap: 'soft',
          // 第一行让开「路径>」，续行自动回到 x=0 —— 真终端就是这么折的
          style: indent > 0 ? { textIndent: `${indent}px` } : null,
          // 真 cmd 的提示符后面什么都不写：不放 placeholder，空着就是一个等宽光标
          onChange: (event) => commit(event.target.value),
          onKeyDown,
        }),
        draft.includes('\n')
          ? h('span', { className: 'gcmd-input-hint', title: 'Enter 执行，Shift+Enter 换行' }, 'Shift+Enter 换行')
          : null,
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
              // 连输入框里还没执行的命令一起清掉：真 cmd 的 cls 也是把整个画面清空
              if (active) store.patchTab(active.id, { lines: [], exit: null, draft: '' })
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
                .map((line) => {
                  const clean = stripAnsi(line.text)
                  return line.kind === 'cmd' ? `${line.cwd || ''}>${clean}` : clean
                })
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
            title: '下载完整日志（.log 文件，不受界面缓冲限制）',
            onClick: () => {
              const active = tabs.find((item) => item.id === activeId) || tabs[0]
              const jobId = active?.running?.id || active?.lastJob
              if (!active || !jobId) {
                store.notify('还没有可以导出的输出')
                return
              }
              window.open(api.logUrl(jobId, 'out'), '_blank')
            },
          },
          h('span', { className: 'gcmd-tool-icon' }, '⤓'),
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

    async function runConsoleAction(rawAction, tabId) {
      const tab = tabId ? getTab(tabId) : activeTab()
      if (!tab || !rawAction) return false
      // 入口可能直接传库里的条目，这里再解析一次平台版本，保证执行的和界面上显示的一致
      const action = effectiveAction(rawAction, store.get())
      const command = String(action.command || '').trim()
      if (!command) {
        store.notify('这条命令在当前平台没有版本，先去编辑器补一下')
        return false
      }
      if (tab.running) {
        store.notify('这个终端还有命令在跑')
        return false
      }
      if (action.confirm && !window.confirm(`执行「${action.name || command}」？`)) return false
      // 条目可以自带 shell（PowerShell 条目、cmd 条目），但只在这一次执行里用，
      // 不改这个终端的 shell —— 否则跑过一条 PowerShell 命令后，后面的 cmd 命令全被带沟里。
      const runShell = action.shell && action.shell !== 'auto' ? action.shell : tab.shell
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
      await runCommand(tab.id, command, runShell)
      return true
    }

    /* --------------------------- 组件：命令库 --------------------------- */

    /** 命令库一页显示多少条（上下键跨页时自动翻页） */
    const PAGE_SIZE = 8

    function Palette({ state }) {
      const [query, setQuery] = useState('')
      const [index, setIndex] = useState(0)
      const [group, setGroup] = useState('all')
      const listRef = useRef(null)

      const platform = commandPlatform(state)
      const actions = state.actions

      // 分类标签直接从库里现有的分组生成，不写死
      const groups = useMemo(() => {
        const seen = []
        for (const action of actions) {
          const name = String(action.group || '').trim()
          if (name && !seen.includes(name)) seen.push(name)
        }
        return seen
      }, [actions])

      const filtered = useMemo(() => {
        const text = query.trim().toLowerCase()
        return actions.filter((action) => {
          if (group !== 'all' && String(action.group || '').trim() !== group) return false
          if (!text) return true
          const hay = `${action.name || ''}\n${pickCommand(action, platform)}\n${action.group || ''}\n${
            action.description || ''
          }`.toLowerCase()
          return hay.includes(text)
        })
      }, [actions, query, group, platform])

      useEffect(() => {
        setIndex(0)
      }, [query, group])

      /** 点平台标签就把选择存进偏好，下次打开还是这个平台 */
      const choosePlatform = async (value) => {
        try {
          await saveActions(store.get().actions, { ...store.get().settings, commandPlatform: value })
        } catch (err) {
          store.notify(`切换平台失败：${errorText(err)}`)
        }
      }

      const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
      const safeIndex = Math.min(index, Math.max(0, filtered.length - 1))
      // 页码由选中项算出来，不再单独存一份状态：上下键、翻页、搜索都不会互相打脸
      const page = Math.min(totalPages - 1, Math.floor(safeIndex / PAGE_SIZE))
      const pageItems = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
      const active = filtered[safeIndex]

      const goPage = (delta) => {
        const next = Math.max(0, Math.min(totalPages - 1, page + delta))
        setIndex(Math.max(0, Math.min(filtered.length - 1, next * PAGE_SIZE)))
      }

      // 选中项滚进可视区（键盘翻页时列表不会跑到视野外）
      useEffect(() => {
        const node = listRef.current
        const row = node && node.querySelector('.gcmd-item[data-active="true"]')
        if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
      }, [safeIndex, page])

      /** 回车 / 点击 = 填进输入框；Ctrl(⌘)+回车 或「运行」按钮 = 直接执行 */
      const use = (action, mode) => {
        applyAction(action, mode)
      }

      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setIndex((value) => Math.max(0, Math.min(filtered.length - 1, value + 1)))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setIndex((value) => Math.max(0, value - 1))
          return
        }
        if (event.key === 'PageDown') {
          event.preventDefault()
          goPage(1)
          return
        }
        if (event.key === 'PageUp') {
          event.preventDefault()
          goPage(-1)
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          if (!active) return
          use(active, event.ctrlKey || event.metaKey ? 'run' : 'insert')
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
            totalPages > 1
              ? h(
                  'span',
                  { className: 'gcmd-pager' },
                  h(
                    'button',
                    { className: 'gcmd-pager-btn', disabled: page === 0, onClick: () => goPage(-1) },
                    '‹',
                  ),
                  h('span', { className: 'gcmd-pager-label' }, `${page + 1} / ${totalPages}`),
                  h(
                    'button',
                    {
                      className: 'gcmd-pager-btn',
                      disabled: page >= totalPages - 1,
                      onClick: () => goPage(1),
                    },
                    '›',
                  ),
                )
              : null,
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
            { className: 'gcmd-chips' },
            h('span', { className: 'gcmd-chips-label' }, '分类'),
            h(
              'button',
              {
                className: 'gcmd-chip',
                'data-active': group === 'all' ? 'true' : 'false',
                onClick: () => setGroup('all'),
              },
              '全部',
            ),
            groups.map((name) =>
              h(
                'button',
                {
                  key: name,
                  className: 'gcmd-chip',
                  'data-active': group === name ? 'true' : 'false',
                  onClick: () => setGroup(group === name ? 'all' : name),
                },
                name,
              ),
            ),
            h('span', { className: 'gcmd-chips-sep' }),
            h('span', { className: 'gcmd-chips-label' }, '平台'),
            PLATFORMS.map((item) =>
              h(
                'button',
                {
                  key: item.value,
                  className: 'gcmd-chip gcmd-chip-platform',
                  title:
                    item.value === 'auto'
                      ? `跟随当前系统（现在是 ${platform === 'linux' ? 'Linux' : 'Windows'}）`
                      : `按 ${item.label} 的命令执行`,
                  'data-active':
                    ((state.settings && state.settings.commandPlatform) || 'auto') === item.value
                      ? 'true'
                      : 'false',
                  onClick: () => void choosePlatform(item.value),
                },
                item.label,
              ),
            ),
          ),
          h(
            'div',
            { className: 'gcmd-list', ref: listRef },
            filtered.length === 0
              ? h(
                  'div',
                  { className: 'gcmd-empty-row' },
                  actions.length === 0 ? '还没有命令，导入一批常用运维命令或自己新建一条吧。' : '没有匹配的命令。',
                )
              : pageItems.map((action, offset) => {
                  const itemIndex = page * PAGE_SIZE + offset
                  return h(
                    'div',
                    {
                      key: action.id,
                      className: 'gcmd-item',
                      'data-active': itemIndex === safeIndex ? 'true' : 'false',
                      onMouseEnter: () => setIndex(itemIndex),
                      onClick: () => use(action, 'insert'),
                    },
                    h('span', { className: 'gcmd-item-mark' }, '❯'),
                    h(
                      'div',
                      { className: 'gcmd-item-main' },
                      h('div', { className: 'gcmd-item-name' }, action.name || pickCommand(action, platform)),
                      h(
                        'div',
                        { className: 'gcmd-item-cmd' },
                        pickCommand(action, platform).replace(/\s+/g, ' '),
                      ),
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
                    h(
                      'button',
                      {
                        className: 'gcmd-item-run',
                        title: '直接执行（也可以 Ctrl/⌘ + 回车）',
                        onClick: (event) => {
                          event.stopPropagation()
                          use(action, 'run')
                        },
                      },
                      '▶ 运行',
                    ),
                  )
                }),
          ),
          h(
            'div',
            { className: 'gcmd-sheet-foot' },
            h('span', null, '↑↓ 选择 · ↵ 填入 · ⌃↵ 执行 · PgUp/PgDn 翻页'),
            h('span', { className: 'gcmd-spacer' }),
            h(
              'button',
              {
                className: 'gcmd-foot-btn',
                title: '补充 CPU / 内存 / 端口 / Docker / 部署 等常用运维命令',
                onClick: () => importPresets(),
              },
              '＋ 推荐命令',
            ),
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
        if (!String(form.command || '').trim() && !String(form.commandLinux || '').trim()) {
          setError('Windows 和 Linux 版本至少要填一个')
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
              h('span', { className: 'gcmd-field-label' }, '命令（Windows）'),
              h('textarea', {
                value: form.command,
                spellCheck: false,
                placeholder: '支持多行，例如：\ncd /d D:\\workspace\\project\nnpm run dev',
                onChange: (event) => update({ command: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'gcmd-field' },
              h('span', { className: 'gcmd-field-label' }, '命令（Linux，可不填）'),
              h('textarea', {
                value: form.commandLinux,
                spellCheck: false,
                placeholder: '服务器上跑的版本，例如：\ncd ~/app\n./run.sh',
                onChange: (event) => update({ commandLinux: event.target.value }),
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
              { className: 'gcmd-field-row' },
              h(
                'div',
                { className: 'gcmd-field' },
                h('span', { className: 'gcmd-field-label' }, '命令库平台'),
                h(
                  'select',
                  {
                    value: form.commandPlatform || 'auto',
                    onChange: (event) => setForm({ ...form, commandPlatform: event.target.value }),
                  },
                  PLATFORMS.map((item) =>
                    h('option', { key: item.value, value: item.value }, item.label),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'gcmd-field' },
                h('span', { className: 'gcmd-field-label' }, '当前系统'),
                h(
                  'div',
                  { className: 'gcmd-static' },
                  `${state.env && state.env.platform === 'linux' ? 'Linux' : 'Windows'} · ${
                    (state.env && state.env.osVersion) || '未知版本'
                  }`,
                ),
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
            // 输入框里的内容也一起清掉（只清输出的话，上一条没执行的命令还杵在那儿）
            store.patchTab(state.activeId, { lines: [], exit: null, draft: '' })
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

    /* --------------------------- 聊天代码块：收藏到 CMD --------------------------- */

    // 只给「命令类」语言挂收藏按钮：没标语言的围栏 entryKey 是空串，挂了太吵
    const FENCE_LANGS = [
      'bash',
      'sh',
      'shell',
      'zsh',
      'fish',
      'console',
      'shell-session',
      'terminal',
      'powershell',
      'ps1',
      'pwsh',
      'cmd',
      'bat',
      'batch',
    ]

    // Chat 的 fence 槽位把「带语言且有内容」的代码块交给 layer 渲染，
    // 我们渲染 children（原代码块）再补一条「收藏到 CMD」的工具条。
    function FenceCollect({ lang, code, streaming, children }) {
      const [hint, setHint] = useState('')
      const [busy, setBusy] = useState(false)

      // 流式输出时代码还没写完，先只渲染原代码块，落定后再出现按钮
      if (streaming || !String(code || '').trim()) return children || null

      const save = async () => {
        if (busy) return
        setBusy(true)
        try {
          setHint(await collectFenceCommand(code, lang))
        } catch (error) {
          setHint(`收藏失败：${errorText(error)}`)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'gcmd-fence' },
        // 正常情况下 Chat 把已经渲染好的代码块作为 children 传进来；
        // 万一没有（例如以后改了围栏层的渲染协议），自己兜一个，别把代码弄丢
        h('div', { className: 'gcmd-fence-code' }, children || h('pre', { className: 'gcmd-fence-raw' }, h('code', null, code))),
        h(
          'div',
          { className: 'gcmd-fence-bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'gcmd-fence-btn',
              disabled: busy,
              title: '把这段命令存进「命令库」（只保存，不执行）',
              onClick: save,
            },
            busy ? '收藏中…' : '＋ 收藏到 CMD',
          ),
          hint ? h('span', { className: 'gcmd-fence-hint' }, hint) : null,
        ),
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
        ctx.effect(() => {
          ensureFenceStyle()
          const disposers = FENCE_LANGS.map((lang) =>
            ctx.slots.inject('conversation.chat.markdown.fence', () =>
              ctx.slots.register(
                {
                  name: 'conversation.chat.markdown.fence',
                  id: `dsh-global-cmd:fence/${lang}`,
                  key: lang,
                  order: 20,
                  registrant: 'dsh-global-cmd',
                },
                FenceCollect,
              ),
            ),
          )
          return () => {
            for (const dispose of disposers) {
              try {
                dispose?.()
              } catch {
                /* 某个语言已经卸载过就算了 */
              }
            }
          }
        }, 'global-cmd: fence layers')
      },
    }
  },
})
