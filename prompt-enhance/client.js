/**
 * prompt-enhance — Client half.
 *
 * Adds one button to the composer's right-hand control row. One click sends the
 * draft and the session id to the plugin's own Host route; the rewritten prompt
 * is placed back into the draft. No confirm step, no project rule files.
 */
window.__ModuleLoader__.load({
  id: '@local/prompt-enhance',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host route served by this bundle's Host half. */
    const ENDPOINT = '/prompt-enhance/enhance'
    /** Composer seat for compact controls before the submit action. */
    const SLOT = 'conversation.input.right'
    /** Order inside that row; stays left of the submit button. */
    const ORDER = 10

    const TEXTS = {
      zh: {
        button: '增强提示词（用草稿 + 最近两轮对话）',
        busy: '正在增强提示词…',
        failed: '增强失败',
        empty: '请先输入内容',
      },
      en: {
        button: 'Enhance prompt (draft + last two rounds)',
        busy: 'Enhancing prompt…',
        failed: 'Enhance failed',
        empty: 'Type something first',
      },
      ja: {
        button: 'プロンプトを強化（下書き + 直近 2 ターン）',
        busy: 'プロンプトを強化しています…',
        failed: '強化に失敗しました',
        empty: '先に入力してください',
      },
    }

    /**
     * Pick the copy for an active locale id, defaulting to English.
     * @param active - Locale id published by the locale service.
     * @returns The matching copy dictionary.
     */
    const pickTexts = (active) => {
      const id = typeof active === 'string' ? active.toLowerCase() : ''
      if (id.indexOf('zh') === 0) return TEXTS.zh
      if (id.indexOf('ja') === 0) return TEXTS.ja
      return TEXTS.en
    }

    const BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '24px',
      height: '24px',
      flex: '0 0 auto',
      padding: 0,
      border: 'none',
      borderRadius: '999px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #6b7280)',
      lineHeight: 0,
      transition: 'background-color 120ms ease, color 120ms ease, opacity 120ms ease',
    }

    /** Idempotent style element carrying the spinner keyframes. */
    const STYLE_ID = 'dsh-prompt-enhance-keyframes'
    const SPIN_CSS = '@keyframes dsh-prompt-enhance-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'
    const SPIN_ANIMATION = 'dsh-prompt-enhance-spin 700ms linear infinite'

    /** Install the keyframes once; inline styles cannot declare an animation. */
    const ensureKeyframes = () => {
      try {
        if (typeof document === 'undefined' || document.head === null) return
        if (document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = SPIN_CSS
        document.head.appendChild(style)
      } catch {
        // A missing document simply leaves the ring static.
      }
    }

    /**
     * Four-point sparkle, the same visual language as the reference control.
     * @param size - Rendered edge length in CSS pixels.
     * @returns The icon element.
     */
    const sparkle = (size) => h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', {
        d: 'M12 2.2c.28 0 .53.18.62.44l1.5 4.29a4.4 4.4 0 0 0 2.65 2.65l4.29 1.5a.65.65 0 0 1 0 1.24l-4.29 1.5a4.4 4.4 0 0 0-2.65 2.65l-1.5 4.29a.65.65 0 0 1-1.24 0l-1.5-4.29a4.4 4.4 0 0 0-2.65-2.65l-4.29-1.5a.65.65 0 0 1 0-1.24l4.29-1.5A4.4 4.4 0 0 0 9.88 6.93l1.5-4.29A.65.65 0 0 1 12 2.2Z',
        fill: 'currentColor',
      }),
      h('path', {
        d: 'M18.6 15.1c.16 0 .3.1.35.25l.6 1.7 1.7.6a.36.36 0 0 1 0 .7l-1.7.6-.6 1.7a.36.36 0 0 1-.7 0l-.6-1.7-1.7-.6a.36.36 0 0 1 0-.7l1.7-.6.6-1.7a.36.36 0 0 1 .35-.25Z',
        fill: 'currentColor',
        opacity: 0.72,
      }),
    )

    /**
     * Round ring that spins while a request is in flight.
     * @returns The indicator element.
     */
    const spinner = () => h(
      'svg',
      {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', animation: SPIN_ANIMATION },
      },
      h('circle', {
        cx: 12,
        cy: 12,
        r: 9,
        fill: 'none',
        stroke: 'currentColor',
        strokeOpacity: 0.2,
        strokeWidth: 2.6,
      }),
      h('circle', {
        cx: 12,
        cy: 12,
        r: 9,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.6,
        strokeLinecap: 'round',
        strokeDasharray: '16 41',
      }),
    )
    return {
      inject: ['slots', 'locale'],

      apply(ctx) {
        /**
         * Read the locale the UI is currently showing.
         * @returns The active locale id, when the locale service answers.
         */
        const readActive = () => {
          try {
            const snapshot = ctx.locale.getLocale()
            if (snapshot !== null && typeof snapshot === 'object') return snapshot.active
          } catch {
            // The locale service may not be ready during boot.
          }
          return undefined
        }

        /** Copy for the active locale, refreshed when the locale changes. */
        function useTexts() {
          const [active, setActive] = React.useState(readActive)
          React.useEffect(() => {
            let dispose
            try {
              dispose = ctx.locale.subscribe(() => setActive(readActive()))
            } catch {
              dispose = undefined
            }
            return typeof dispose === 'function' ? dispose : undefined
          }, [])
          return pickTexts(active)
        }

        /**
         * The composer button: one click, no questions asked.
         * The request never injects AGENTS.md / CLAUDE.md; the draft plus the
         * last two conversation rounds are enough.
         * @param props - Slot props: draft state, input actions, session id.
         * @returns The control element.
         */
        function EnhanceButton(props) {
          const inputActions = props === undefined ? undefined : props.inputActions
          const useInput = props === undefined ? undefined : props.useInput
          const sessionId = props === undefined ? undefined : props.sessionId

          const draft = typeof useInput === 'function'
            ? useInput((state) => (state !== null && typeof state === 'object' ? state.draft : ''))
            : ''

          const texts = useTexts()
          /** A request is in flight. */
          const [running, setRunning] = React.useState(false)
          /** Error reason, shown in the tooltip. */
          const [failure, setFailure] = React.useState('')
          const [hovered, setHovered] = React.useState(false)

          React.useEffect(() => {
            ensureKeyframes()
          }, [])

          const empty = typeof draft !== 'string' || draft.trim() === ''
          const disabled = running || empty

          React.useEffect(() => {
            setFailure('')
          }, [draft])

          /** Send the draft to the Host half and put the answer back. */
          const run = React.useCallback(() => {
            const text = typeof draft === 'string' ? draft : ''
            if (text.trim() === '' || running) return
            setRunning(true)
            setFailure('')
            const body = { draft: text }
            if (sessionId !== undefined && sessionId !== null) body.sessionId = String(sessionId)
            fetch(ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
              .then((response) => response.text().then((raw) => ({ response, raw })))
              .then((result) => {
                let payload
                try {
                  payload = JSON.parse(result.raw)
                } catch {
                  payload = undefined
                }
                if (!result.response.ok) {
                  const detail = payload !== undefined && payload !== null && typeof payload.error === 'string'
                    ? payload.error
                    : `HTTP ${result.response.status}`
                  throw new Error(detail)
                }
                const prompt = payload !== undefined && payload !== null && typeof payload.prompt === 'string'
                  ? payload.prompt
                  : ''
                if (prompt.trim() === '') throw new Error(texts.failed)
                if (inputActions === undefined || typeof inputActions.setDraft !== 'function') {
                  throw new Error(texts.failed)
                }
                inputActions.setDraft(prompt)
                setRunning(false)
              })
              .catch((error) => {
                setRunning(false)
                setFailure(error !== undefined && error !== null && error.message ? error.message : String(error))
              })
          }, [draft, sessionId, inputActions, running, texts])

          const title = failure !== ''
            ? `${texts.failed}：${failure}`
            : running
              ? texts.busy
              : empty
                ? texts.empty
                : texts.button

          return h(
            'button',
            {
              type: 'button',
              title,
              'aria-label': texts.button,
              'aria-busy': running ? 'true' : undefined,
              disabled,
              onClick: run,
              onMouseEnter: () => setHovered(true),
              onMouseLeave: () => setHovered(false),
              onFocus: () => setHovered(true),
              onBlur: () => setHovered(false),
              style: {
                ...BUTTON_STYLE,
                background: hovered && !disabled
                  ? 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.16))'
                  : 'transparent',
                color: failure !== ''
                  ? 'var(--dsw-alias-state-error-primary, #e5484d)'
                  : 'var(--dsw-alias-label-secondary, #6b7280)',
                opacity: disabled && !running ? 0.45 : 1,
                cursor: disabled ? 'default' : 'pointer',
              },
            },
            running ? spinner() : sparkle(15),
          )
        }

        ctx.slots.inject(SLOT, () => ctx.slots.register(
          { name: SLOT, id: 'prompt-enhance', order: ORDER },
          EnhanceButton,
        ))
      },
    }
  },
})
