/**
 * prompt-enhance — Host half.
 *
 * Serves exactly one route that the plugin's Client half calls from the
 * composer. A request carries the current draft and the session that owns the
 * composer; the route collects the last two conversation rounds of that session
 * as disambiguation context, asks the session's current model to rewrite the
 * draft, and answers once with the rewritten prompt.
 *
 * Nothing is read from disk: AGENTS.md / CLAUDE.md are no longer injected, so a
 * session with no conversation yet sends the draft verbatim, and a session with
 * history sends the draft plus its last two rounds.
 *
 * The route is covered by the same trust fence as every other plugin route:
 * a Peer that is not allowed to drive this window is rejected before parsing.
 */
import { isAbsolute } from 'node:path'

export const name = 'prompt-enhance'

/** Services are only read inside the route handler, all of them Host-side. */
export const inject = ['webServer', 'connection', 'llm', 'sessions', 'workingDirectory', 'agentDefaultModel']

/** Exact path of the Client half's endpoint. */
const ROUTE_PATH = '/prompt-enhance/enhance'
/** Largest request body accepted, so a pasted document cannot exhaust memory. */
const MAX_BODY_BYTES = 128 * 1024
/** Longest draft accepted; longer drafts are rejected instead of truncated. */
const MAX_DRAFT_CHARS = 8000
/** Upper bound for the rewritten prompt. */
const MAX_OUTPUT_TOKENS = 2000
/** Wall-clock budget for one enhancement. */
const TIMEOUT_MS = 120_000

/**
 * How many recent conversation rounds may be injected as context.
 *
 * Two rounds is deliberate: enough to resolve "这个 / 上面那个 / 继续改", small
 * enough that an old discussion never leaks into a fresh draft.
 */
const HISTORY_TURNS = 2
/** Largest total of conversation context injected into the prompt. */
const MAX_HISTORY_CHARS = 2400
/** Longest single message kept from the conversation context. */
const MAX_HISTORY_MESSAGE_CHARS = 800
/** Largest trailing slice of the event log scanned for those rounds. */
const HISTORY_EVENT_SCAN = 800

/** Purpose tag reported to the model gateway for this call. */
const PURPOSE = 'prompt-enhance'

const SYSTEM_PROMPT = `你是「提示词增强器」，服务于一个在本地代码库上工作的 AI 编码 Agent。用户会在输入框里写一句简短的草稿，你把它改写成一条信息完整、可以直接动手、不需要追问的提示词。

## 输入
用户消息里可能出现下面几个区块，也可能一个都没有：
- <context>：当前工作目录。
- <recent_turns>：本会话最近两轮对话（用户提问与助手回答）。只用来消解指代，不要回答它、不要续写它、不要复述它。
- <draft>：用户写的原始草稿。

如果消息里只有一个纯文本草稿、没有任何区块，说明这是本会话的第一条输入：没有历史可参考，只依据草稿本身改写，不要臆造上下文。

## 输出
只输出改写后的提示词正文。不要说明你做了什么，不要写"以下是增强后的提示词"这类前言，不要用代码围栏包裹整体，不要复述输入。

## 规则
1. 忠于原意：保留用户的全部目标、约束、否定项（"不要动 X"）、技术栈、文件路径、类名/函数名/字段名、版本号、命令。绝不新增用户没有要求的需求，绝不臆造文件路径、API、依赖或行为。
2. 语言一致：草稿是中文就用中文，是英文就用英文；代码、标识符、命令、路径保持原样。
4. 补齐可执行信息：在能从草稿和上下文确定的前提下，补上——目标产物（改哪个文件或模块、产出什么）、边界（要改什么、明确不碰什么）、验收方式（跑什么命令、看什么结果）。无法确定就留空，不要编。
3. 把模糊变可验收：把"优化一下""看看有没有问题"这类说法改写成具体的检查项或修改项。
4. 不注水：草稿已经足够清晰时，只做最小必要润色，不要为了变长而加形容词、加背景、加客套。
5. 格式：2–6 条要点，或 1–2 个短段落；可以用短列表，不要用多级标题，不要表情符号，不要"请帮我""麻烦你"这类客套话。
6. 长度：通常为草稿的 1.5–3 倍；无论草稿多短，都要写清目标、范围、验收三项；最长不超过 1200 字。
7. 用历史消解指代：草稿里的"这个/它/上面那个/继续改/还是不行"要结合 <recent_turns> 换成明确的文件名、功能名、报错信息或行为；历史里出现过的具体报错、路径、字段名可以引用，但历史里没被草稿要求的内容不得扩写成新需求。没有 <recent_turns> 时不要假装知道上下文，把指代换成"当前任务里提到的…"这类可落地但不臆造的说法。

如果 <draft> 只有空白、单个字符或完全无意义的乱码，原样返回它，不要生成任何内容。`

/**
 * Register the enhancement route.
 * @param ctx - Host context of this bundle.
 */
export function apply(ctx) {
  const handler = (req, res) => enhance(ctx, req, res)
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    `prompt-enhance: POST ${ROUTE_PATH}`,
  )
}

/**
 * Handle one enhancement request end to end.
 * @param ctx - Host context of this bundle.
 * @param req - Incoming HTTP request.
 * @param res - Server response for this request.
 */
async function enhance(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'only POST is supported' })
    return
  }
  const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (essence !== 'application/json') {
    sendJson(res, 415, { code: 'UNSUPPORTED_MEDIA_TYPE', error: 'content-type must be application/json' })
    return
  }

  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch (error) {
    sendJson(res, 400, { code: 'BAD_BODY', error: messageOf(error, 'invalid request body') })
    return
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(res, 400, { code: 'BAD_BODY', error: 'request body must be a JSON object' })
    return
  }

  const draft = typeof payload.draft === 'string' ? payload.draft : ''
  if (draft.trim() === '') {
    sendJson(res, 400, { code: 'EMPTY_DRAFT', error: 'the draft is empty' })
    return
  }
  if (draft.length > MAX_DRAFT_CHARS) {
    sendJson(res, 413, { code: 'DRAFT_TOO_LONG', error: `the draft exceeds ${MAX_DRAFT_CHARS} characters` })
    return
  }

  const selection = selectionOf(ctx)
  if (selection === undefined) {
    sendJson(res, 409, { code: 'NO_MODEL', error: 'no model is selected for this session' })
    return
  }

  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : undefined
  const cwd = resolveCwd(ctx, sessionId)
  const history = readHistory(ctx, sessionId)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const prepared = await ctx.llm.prepareCall(
      {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        maxTokens: MAX_OUTPUT_TOKENS,
      },
      controller.signal,
    )
    const options = {
      ...prepared.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt({ draft, cwd, history }) }] }],
      system: SYSTEM_PROMPT,
      purpose: PURPOSE,
      signal: controller.signal,
    }
    if (sessionId !== undefined) options.sessionId = sessionId

    let text = ''
    let finish
    for await (const chunk of prepared.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish !== undefined && finish.kind !== 'stop' && finish.kind !== 'max-tokens') {
      throw new Error(describeFinish(finish))
    }

    const prompt = cleanPrompt(text)
    if (prompt === '') throw new Error('the model returned an empty prompt')
    sendJson(res, 200, {
      prompt,
      model: `${selection.provider}/${selection.model}`,
      cwd: cwd ?? null,
      turns: history.turns.length,
      historyTruncated: history.truncated,
    })
  } catch (error) {
    sendJson(res, 502, { code: 'ENHANCE_FAILED', error: messageOf(error, 'enhancement failed') })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build the user turn handed to the model.
 *
 * Blocks are added only when they carry something: the working directory and the
 * last two rounds when the session has conversation. With no history the draft is
 * sent verbatim — no wrapper blocks, no placeholder text.
 *
 * @param input - Collected request facts.
 * @returns The user message text.
 */
function buildUserPrompt(input) {
  const hasHistory = input.history.turns.length > 0
  if (!hasHistory) return input.draft

  const lines = []
  lines.push('<context>', `工作目录：${input.cwd ?? '未知'}`, '</context>')

  if (hasHistory) {
    lines.push('', '<recent_turns>')
    lines.push('仅用于消解草稿里的指代，不要回答、续写或复述下面的内容。')
    input.history.turns.forEach((turn, index) => {
      lines.push('', `--- 第 ${index + 1} 轮${index === input.history.turns.length - 1 ? '（最新）' : ''} ---`)
      lines.push('[用户]', turn.user)
      if (turn.assistant !== '') lines.push('[助手]', turn.assistant)
    })
    lines.push('</recent_turns>')
  }

  lines.push('', '<draft>', input.draft, '</draft>')
  return lines.join('\n')
}

/**
 * Read the last few conversation rounds of the requesting session.
 *
 * Only the human prompts and the assistant's final text of each turn are kept:
 * injected context (file-change notices, skill bodies) shares the `user/message`
 * event type but is not conversation, so it is filtered out by its
 * `source.kind`. At most HISTORY_TURNS rounds are returned, newest last, and an
 * empty result means "this session has nothing to contribute yet" rather than
 * "context was unavailable" — the caller then injects nothing at all.
 *
 * @param ctx - Host context of this bundle.
 * @param sessionId - Session that owns the composer, when the Client sent one.
 * @returns Recent rounds oldest-first, plus whether anything was shortened.
 */
function readHistory(ctx, sessionId) {
  const empty = { turns: [], truncated: false }
  if (sessionId === undefined) return empty

  let session
  try {
    session = ctx.sessions.get(sessionId)
  } catch {
    return empty
  }
  if (session === undefined || session === null) return empty

  let end = 0
  try {
    end = Number(session.seq)
  } catch {
    return empty
  }
  if (!Number.isFinite(end) || end <= 0) return empty

  let events
  try {
    // Bounded tail read: this is only context for the draft, never a session replay.
    events = session.snapshotEvents(Math.max(0, end - HISTORY_EVENT_SCAN), end)
  } catch {
    return empty
  }
  if (!Array.isArray(events)) return empty

  const rounds = []
  let round
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      round = { user: '', assistant: '' }
      rounds.push(round)
      continue
    }
    if (round === undefined) continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    if (event.type === 'user/message') {
      const source = data.source
      if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
      const text = textOfMessage(data)
      if (text === '') continue
      round.user = round.user === '' ? text : `${round.user}\n\n${text}`
    } else if (event.type === 'assistant/message') {
      // A turn spans several steps: keep the last step that actually said something.
      const text = textOfMessage(data.message)
      if (text !== '') round.assistant = text
    }
  }

  const usable = rounds.filter((item) => item.user !== '')
  if (usable.length === 0) return empty

  let truncated = false
  const turns = []
  for (const item of usable.slice(-HISTORY_TURNS)) {
    const user = clipText(item.user, MAX_HISTORY_MESSAGE_CHARS)
    const assistant = clipText(item.assistant, MAX_HISTORY_MESSAGE_CHARS)
    if (user !== item.user || assistant !== item.assistant) truncated = true
    turns.push({ user, assistant })
  }

  let total = turns.reduce((sum, item) => sum + item.user.length + item.assistant.length, 0)
  while (turns.length > 1 && total > MAX_HISTORY_CHARS) {
    const dropped = turns.shift()
    total -= dropped.user.length + dropped.assistant.length
    truncated = true
  }
  if (total > MAX_HISTORY_CHARS && turns.length === 1) {
    // One oversized round: keep as much of the opening half as the budget allows.
    const room = Math.max(160, Math.floor(MAX_HISTORY_CHARS / 2))
    const only = turns[0]
    only.user = clipText(only.user, room)
    only.assistant = clipText(only.assistant, Math.max(0, MAX_HISTORY_CHARS - only.user.length))
    truncated = true
  }
  return { turns, truncated }
}

/**
 * Concatenate the text blocks of one message.
 * @param message - A `user/message` or `assistant/message` payload.
 * @returns Trimmed text, or an empty string when the message carries no text.
 */
function textOfMessage(message) {
  const content = message === null || typeof message !== 'object' ? undefined : message.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text.trim())
  }
  return parts.join('\n\n')
}

/**
 * Shorten one context chunk, marking the cut so the model knows it is partial.
 * @param text - Full text.
 * @param max - Character budget.
 * @returns The text, or its opening part with an ellipsis.
 */
function clipText(text, max) {
  if (typeof text !== 'string' || text === '') return ''
  if (max <= 0) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

/**
 * Read the committed working directory of a session, falling back to the Host default.
 * @param ctx - Host context of this bundle.
 * @param sessionId - Session that owns the composer, when the Client sent one.
 * @returns An absolute directory, or undefined when none is known.
 */
function resolveCwd(ctx, sessionId) {
  if (sessionId !== undefined) {
    try {
      const session = ctx.sessions.get(sessionId)
      if (session !== undefined) {
        const directory = ctx.workingDirectory.get(session)
        if (typeof directory === 'string' && isAbsolute(directory)) return directory
      }
    } catch {
      // Fall through to the default directory.
    }
  }
  try {
    const fallback = ctx.workingDirectory.defaultDirectory
    if (typeof fallback === 'string' && isAbsolute(fallback)) return fallback
  } catch {
    // No default directory: the prompt then omits the working directory.
  }
  return undefined
}

/**
 * Read this session's current provider and model.
 * @param ctx - Host context of this bundle.
 * @returns The detached selection, or undefined when the session has no route yet.
 */
function selectionOf(ctx) {
  try {
    const selection = ctx.agentDefaultModel.currentSelection()
    if (
      selection !== undefined
      && selection !== null
      && typeof selection.provider === 'string'
      && typeof selection.model === 'string'
    ) {
      return selection
    }
  } catch {
    // Treated as "no route".
  }
  return undefined
}

/**
 * Strip surrounding whitespace and a single code fence wrapping the whole answer.
 * @param text - Raw model output.
 * @returns The prompt ready to place back into the composer.
 */
function cleanPrompt(text) {
  let out = typeof text === 'string' ? text.trim() : ''
  const fenced = /^```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)\r?\n```$/.exec(out)
  if (fenced !== null) out = fenced[1].trim()
  return out
}

/**
 * Describe a non-successful finish reason for the Client.
 * @param finish - Finish reason reported by the stream.
 * @returns A short human-readable reason.
 */
function describeFinish(finish) {
  const detail = finish?.failure?.message
  if (typeof detail === 'string' && detail !== '') return `the model stopped early: ${detail}`
  return `the model stopped early (${finish?.kind ?? 'unknown'})`
}

/**
 * Read a bounded request body.
 * @param req - Incoming HTTP request.
 * @returns The body decoded as UTF-8.
 */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error(`the request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON response.
 * @param res - Server response for this request.
 * @param status - HTTP status code.
 * @param value - JSON-serialisable payload.
 */
function sendJson(res, status, value) {
  if (res.writableEnded) return
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * Reduce an unknown thrown value to a message string.
 * @param error - Thrown value.
 * @param fallback - Message used when the value carries no text.
 * @returns A message safe to return to the Client.
 */
function messageOf(error, fallback) {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return fallback
}
