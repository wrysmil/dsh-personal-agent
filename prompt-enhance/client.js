/**
 * prompt-enhance — Client half.
 *
 * Adds one button to the composer's right-hand control row. One click sends the
 * draft, its inline @-references, its pending attachments and the session id to
 * the plugin's own Host route; the rewritten prompt is placed back into the
 * draft. No confirm step.
 *
 * The composer's input snapshot only exposes attachment *ids*: the objects live
 * in the conversation controller. The composer bar publishes a resolver to its
 * child slots and the controller carries the same method, so the button reads
 * names and sizes through whichever of the two is available and degrades to a
 * draft-only request when neither answers.
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
    /** Slightly longer than the Host's own 120 s budget, so its error wins. */
    const CLIENT_TIMEOUT_MS = 130_000

    /**
     * In-flight enhancement jobs, keyed by conversation.
     *
     * The button sits in a session-scoped slot, so switching conversations
     * unmounts it while its request is still running. Keeping the job here —
     * outside React — means the spinner comes back on remount, the answer is
     * written to the conversation that asked for it even when that conversation
     * is no longer visible, and a failure is still readable on return.
     */
    function createJobStore() {
      const jobs = new Map()
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        get(key) {
          return jobs.get(key)
        },
        isRunning(key) {
          const job = jobs.get(key)
          return job !== undefined && job.status === 'running'
        },
        begin(key) {
          jobs.set(key, { status: 'running', failure: '' })
          emit()
        },
        settle(key) {
          jobs.delete(key)
          emit()
        },
        fail(key, failure) {
          jobs.set(key, { status: 'failed', failure })
          emit()
        },
        /** Drop a stale error once the user edits that draft again. */
        clearFailure(key) {
          const job = jobs.get(key)
          if (job === undefined || job.status !== 'failed') return
          jobs.delete(key)
          emit()
        },
      }
    }

    const jobs = createJobStore()

    const TEXTS = {
      zh: {
        button: '增强提示词（草稿 + 附件/引用 + 最近两轮）',
        busy: '正在增强提示词…',
        failed: '增强失败',
        timeout: '超时未返回，请重试',
        empty: '请先输入内容',
      },
      en: {
        button: 'Enhance prompt (draft + attachments/refs + last two rounds)',
        busy: 'Enhancing prompt…',
        failed: 'Enhance failed',
        timeout: 'Timed out — try again',
        empty: 'Type something first',
      },
      ja: {
        button: 'プロンプトを強化（下書き + 添付/参照 + 直近 2 ターン）',
        busy: 'プロンプトを強化しています…',
        failed: '強化に失敗しました',
        timeout: 'タイムアウトしました。再試行してください',
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
      inject: ['slots', 'locale', 'conversation'],

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

        /** Longest label carried for one attachment or reference. */
        const MAX_LABEL_CHARS = 200
        /** Most attachments carried with one request. */
        const MAX_ATTACHMENTS = 20
        /** Most inline references carried with one request. */
        const MAX_REFERENCES = 20

        /**
         * Normalize one string for transport.
         * @param value - Candidate value.
         * @param max - Character budget.
         * @returns Trimmed text, clipped with an ellipsis when too long.
         */
        const textField = (value, max) => {
          if (typeof value !== 'string') return ''
          const trimmed = value.trim()
          if (trimmed.length <= max) return trimmed
          return `${trimmed.slice(0, max)}…`
        }

        /**
         * Resolve the composer attachments behind the draft's attachment ids.
         *
         * `attachmentIds` are browser-runtime ids; the attachment objects live in
         * the conversation controller. The composer bar hands its resolver to
         * every child slot, and the controller publishes the same method, so both
         * are tried. Both are optional APIs: a missing or throwing resolver
         * simply yields no list and the request carries no attachment block.
         *
         * @param props - Slot props, possibly carrying the bar's resolver.
         * @param state - Latest input snapshot.
         * @returns Resolved attachments in composer order.
         */
        const readAttachments = (props, state) => {
          const ids = state !== null && typeof state === 'object' && Array.isArray(state.attachmentIds)
            ? state.attachmentIds.filter((id) => typeof id === 'string' && id !== '')
            : []
          if (ids.length === 0) return []

          const resolvers = []
          if (props !== null && typeof props === 'object' && typeof props.resolveDraftAttachments === 'function') {
            resolvers.push((list) => props.resolveDraftAttachments(list))
          }
          try {
            const conversation = ctx.conversation
            if (
              conversation !== undefined
              && conversation !== null
              && typeof conversation.resolveDraftAttachments === 'function'
            ) {
              resolvers.push((list) => conversation.resolveDraftAttachments(list))
            }
          } catch {
            // The controller may not expose the method in this build.
          }
          for (const resolve of resolvers) {
            try {
              const list = resolve(ids)
              if (Array.isArray(list) && list.length > 0) return list
            } catch {
              // Try the next resolver.
            }
          }
          return []
        }

        /**
         * Reduce resolved attachments to the names the Host needs.
         * @param attachments - Resolved composer attachments.
         * @returns Plain descriptors, capped.
         */
        const describeAttachments = (attachments) => {
          const out = []
          for (const item of attachments) {
            if (item === null || typeof item !== 'object') continue
            const file = item.file !== null && typeof item.file === 'object' ? item.file : undefined
            const kind = item.kind === 'image' ? 'image' : 'file'
            const entry = { kind }
            const name = textField(file === undefined ? '' : file.name, MAX_LABEL_CHARS)
            if (name !== '') entry.name = name
            if (file !== undefined && typeof file.size === 'number' && Number.isFinite(file.size)) entry.size = file.size
            const mime = textField(file === undefined ? '' : file.type, MAX_LABEL_CHARS)
            if (mime !== '') entry.mime = mime
            if (kind === 'image') {
              if (typeof item.width === 'number' && Number.isFinite(item.width)) entry.width = item.width
              if (typeof item.height === 'number' && Number.isFinite(item.height)) entry.height = item.height
            }
            out.push(entry)
            if (out.length >= MAX_ATTACHMENTS) break
          }
          return out
        }

        /**
         * Reduce the draft's inline chips to their displayed labels.
         * @param occurrences - Occurrences from the input snapshot.
         * @returns Reference descriptors, capped.
         */
        const describeReferences = (occurrences) => {
          if (!Array.isArray(occurrences)) return []
          const out = []
          for (const item of occurrences) {
            if (item === null || typeof item !== 'object') continue
            const rawLabel = typeof item.label === 'string' && item.label !== '' ? item.label : item.clipboardText
            const label = textField(rawLabel, MAX_LABEL_CHARS)
            if (label === '') continue
            const entry = { label }
            const source = textField(item.source, MAX_LABEL_CHARS)
            if (source !== '') entry.source = source
            const ref = textField(
              typeof item.ref === 'string'
                ? item.ref
                : item.ref !== null && typeof item.ref === 'object'
                  ? JSON.stringify(item.ref)
                  : '',
              MAX_LABEL_CHARS,
            )
            if (ref !== '') entry.ref = ref
            if (item.invalid === true) entry.invalid = true
            out.push(entry)
            if (out.length >= MAX_REFERENCES) break
          }
          return out
        }

        /**
         * The composer button: one click, no questions asked.
         * The Client contributes what lives in the browser — the draft, its
         * @-references and its attachments; the Host half adds only the last two
         * conversation rounds, which the browser cannot read.
         * @param props - Slot props: draft state, input actions, session id.
         * @returns The control element.
         */
        function EnhanceButton(props) {
          const inputActions = props === undefined ? undefined : props.inputActions
          const useInput = props === undefined ? undefined : props.useInput
          const sessionId = props === undefined ? undefined : props.sessionId

          /**
           * Latest full input snapshot. The selector returns the draft string, so
           * the button only re-renders on typing; the snapshot itself is kept here
           * for the click handler, which needs the attachment ids and occurrences
           * that the returned string does not carry.
           */
          const latest = React.useRef(undefined)
          const draft = typeof useInput === 'function'
            ? useInput((state) => {
              if (state !== null && typeof state === 'object') latest.current = state
              return typeof state === 'object' && state !== null && typeof state.draft === 'string' ? state.draft : ''
            })
            : ''

          /**
           * One job per conversation: enhancing here must not block or leak
           * into an enhancement running in another conversation.
           */
          const jobKey = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
          const texts = useTexts()
          /** Re-render whenever any job changes state, whoever changed it. */
          const [, bumpTick] = React.useState(0)
          React.useEffect(() => jobs.subscribe(() => bumpTick((value) => value + 1)), [])

          const job = jobs.get(jobKey)
          /** A request for THIS conversation is in flight. */
          const running = job !== undefined && job.status === 'running'
          /** Error reason, shown in the tooltip. */
          const failure = job !== undefined && job.status === 'failed' ? job.failure : ''
          const [hovered, setHovered] = React.useState(false)

          React.useEffect(() => {
            ensureKeyframes()
          }, [])

          const empty = typeof draft !== 'string' || draft.trim() === ''
          const disabled = running || empty

          React.useEffect(() => {
            jobs.clearFailure(jobKey)
          }, [draft, jobKey])

          /** Send the draft to the Host half and put the answer back. */
          const run = React.useCallback(() => {
            const text = typeof draft === 'string' ? draft : ''
            if (text.trim() === '' || jobs.isRunning(jobKey)) return
            jobs.begin(jobKey)

            const body = { draft: text }
            if (sessionId !== undefined && sessionId !== null) body.sessionId = String(sessionId)

            // What only the browser knows: which files sit in the composer and
            // which @-references the draft already carries.
            const state = latest.current
            const attachments = describeAttachments(readAttachments(props, state))
            if (attachments.length > 0) body.attachments = attachments
            const references = describeReferences(
              state !== null && typeof state === 'object' ? state.occurrences : undefined,
            )
            if (references.length > 0) body.references = references

            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS)
            fetch(ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
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
                // This may run after a conversation switch unmounted the
                // button: the action still owns the draft of the conversation
                // that started the job, so the answer lands where it belongs.
                inputActions.setDraft(prompt)
                jobs.settle(jobKey)
              })
              .catch((error) => {
                const reason = error !== undefined && error !== null && error.message ? error.message : String(error)
                jobs.fail(jobKey, controller.signal.aborted ? texts.timeout : reason)
              })
              .finally(() => {
                clearTimeout(timer)
              })
          }, [draft, jobKey, sessionId, inputActions, texts, props])

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
