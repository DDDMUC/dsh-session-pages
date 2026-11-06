// The window fold as a session projection.
//
// The runtime keeps one projection cell per session and drives it with every
// committed event, so a live window list costs nothing to read: no log decode, no
// re-fold. That is the difference between "every request re-reads 40 MB" and
// "the framework already knows".
//
// The rules are the same ones `buildPages` applies in logic.js:
//   - the session origin opens window 1;
//   - every compact-checkpoint opens the next window;
//   - counters accumulate per window.
//
// Only the SUMMARY (small, one object per window) lives here. Row details stay
// on-demand in /items, exactly the split the reference plugin uses.

const FIRST_PAGE = () => ({
  index: 1,
  createdAt: null,
  startSeq: 0,
  compactionId: null,
  summary: '',
  summaryChars: 0,
  replacedFrom: null,
  replacedTo: null,
  // frame: what every request in this window carries in front
  systemChars: 0,
  systemText: '',
  systemInherited: false,
  toolNames: null,
  // Visible dialogue rows (~user/assistant). Settings-only prefixes stay 0 and
  // are folded into the first checkpoint window by the reader.
  dialogue: 0,
  turnFrom: null,
  turnTo: null,
  steps: 0,
  messages: 0,
  toolCalls: 0,
  peakTokens: null,
  itemCount: 0,
})

/** The message object of an event, tolerating both the nested and flat shapes. */
function messageOf(event) {
  const data = event === null || event === undefined ? undefined : event.data
  if (data === null || data === undefined) return undefined
  if (data.message !== null && typeof data.message === 'object') return data.message
  if (data.role !== undefined || data.content !== undefined) return data
  return undefined
}

function textOfMessage(message) {
  if (message === null || message === undefined) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content) === false) return ''
  return message.content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function reasoningOf(message) {
  if (message === null || message === undefined || Array.isArray(message.content) === false) return ''
  return message.content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** Cut the checkpoint payload out of its preamble and wrapper tags. */
function summaryOf(text) {
  const open = text.indexOf('<compacted-summary>')
  const close = text.indexOf('</compacted-summary>')
  if (open >= 0 && close > open) return text.slice(open + '<compacted-summary>'.length, close).trim()
  return text.trim()
}

function addToPage(page, patch) {
  return { ...page, ...patch }
}

export const windowProjection = {
  key: 'sessionPages',
  stateVersion: 1,
  stateSchema: (z) => z.object({
    pages: z.array(z.any()),
  }),
  init: () => ({ pages: [FIRST_PAGE()], systemText: '', presetId: null }),
  apply: (state, event) => {
    const pages = state.pages.slice()
    const last = pages[pages.length - 1]
    // Window 1 is born with the session: the first event that carries a time
    // stamps it, because the session header is not part of this event stream.
    if (last.createdAt === null && Number.isFinite(event.time)) {
      pages[pages.length - 1] = { ...last, createdAt: event.time }
    }

    if (event.type === 'user/message') {
      const source = event.data === undefined ? undefined : event.data.source
      const kind = source === undefined ? undefined : source.kind
      if (kind === 'compact-checkpoint') {
        const text = textOfMessage(messageOf(event))
        const summary = summaryOf(text)
        const next = FIRST_PAGE()
        next.index = pages.length + 1
        next.startSeq = event.seq
        next.compactionId = typeof source.compactionId === 'string' ? source.compactionId : null
        next.summary = summary
        next.summaryChars = summary.length
        const op = event.surfaceOp
        next.createdAt = Number.isFinite(event.time) ? event.time : null
        next.replacedFrom = Number.isSafeInteger(op && op.startSeq) ? op.startSeq : null
        next.replacedTo = Number.isSafeInteger(op && op.endSeq) ? op.endSeq : null
        next.systemChars = last.systemChars
        next.systemText = last.systemText
        next.systemInherited = last.systemChars > 0
        pages.push(next)
        return { pages, systemText: state.systemText, presetId: state.presetId }
      }
      // A human turn opens a window's counting; injections and other user-role
      // rows are rows, not messages, except the checkpoint above.
      // The fold draws a row only when there is text to draw; a message that
      // carries nothing but an attachment still counts as a message, not a row.
      const text = textOfMessage(messageOf(event))
      const rendered = text.length > 0 ? 1 : 0
      const page = addToPage(last, {
        dialogue: last.dialogue + (rendered > 0 && (kind === 'user' || kind === undefined) ? 1 : 0),
        itemCount: last.itemCount + rendered,
        messages: last.messages + 1,
      })
      pages[pages.length - 1] = page
      return { pages, systemText: state.systemText, presetId: state.presetId }
    }

    if (event.type === 'assistant/message') {
      const message = messageOf(event)
      const turn = Number.isSafeInteger(event.data === undefined ? undefined : event.data.turn) ? event.data.turn : null
      const toolCalls = Array.isArray(message === undefined ? undefined : message.content)
        ? message.content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call').length
        : 0
      const usage = (event.data === undefined ? undefined : event.data.usage) || {}
      const total = Number.isFinite(usage.totalTokens) ? usage.totalTokens : null
      const reasoning = reasoningOf(message)
      const text = textOfMessage(message)
      const page = {
        ...last,
        dialogue: last.dialogue + 1,
        steps: last.steps + 1,
        messages: last.messages + 1,
        toolCalls: last.toolCalls + toolCalls,
        peakTokens: total === null ? last.peakTokens : (last.peakTokens === null ? total : Math.max(last.peakTokens, total)),
        itemCount: last.itemCount + 1 + (reasoning.length > 0 ? 1 : 0),
        turnFrom: turn === null ? last.turnFrom : (last.turnFrom === null ? turn : Math.min(last.turnFrom, turn)),
        turnTo: turn === null ? last.turnTo : (last.turnTo === null ? turn : Math.max(last.turnTo, turn)),
      }
      pages[pages.length - 1] = page
      return { pages, systemText: state.systemText, presetId: state.presetId }
    }

    if (event.type === 'system/message' || event.type === 'developer/message') {
      const text = textOfMessage(messageOf(event))
      if (text.length === 0) return state
      const base = state.systemText !== undefined && state.systemText.length > 0 ? state.systemText : text
      const page = last.systemChars > 0
        ? last
        : { ...last, systemChars: base.length, systemText: base }
      pages[pages.length - 1] = page
      return { pages, systemText: base, presetId: state.presetId }
    }

    if (event.type === 'request/header') {
      const tools = ((event.data || {}).header || {}).tools
      if (Array.isArray(tools) === false) return state
      const names = tools.map((tool) => (tool && typeof tool.name === 'string' ? tool.name : null)).filter((name) => name !== null)
      pages[pages.length - 1] = { ...last, toolNames: names }
      return { pages, systemText: state.systemText, presetId: state.presetId }
    }

    if (event.type === 'agent-preset/selected') {
      const preset = (event.data || {}).agentPreset
      return { pages, systemText: state.systemText, presetId: typeof preset === 'string' ? preset : state.presetId }
    }

    if (event.type === 'tool/result') {
      pages[pages.length - 1] = { ...last, messages: last.messages + 1, itemCount: last.itemCount + 1 }
      return { pages, systemText: state.systemText, presetId: state.presetId }
    }
    if (event.type === 'tool/call') {
      pages[pages.length - 1] = { ...last, itemCount: last.itemCount + 1 }
      return { pages, systemText: state.systemText, presetId: state.presetId }
    }
    return state
  },
}
