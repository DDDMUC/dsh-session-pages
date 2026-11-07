// dsh-session-pages - pure fold.
//
// One session log in, N windows out. A window (页) starts at a compaction
// checkpoint and ends right before the next one; the first window starts at the
// session origin.
//
// A window is described at TWO levels, and the view shows both:
//
//   context - what every request in this window carries in front of the
//             dialogue: the system prompt, the tool declarations, the
//             checkpoint, and (from window 2 on) the retained tail of the
//             previous window. These are not events of this window, they are
//             the frame it is assembled inside.
//   items   - the window's own timeline: injections, user messages, assistant
//             messages, tool calls and tool results, in seq order.
//
// Nothing here touches the network, the clock or the disk.
//
// What a window IS, from the platform's own compaction package:
//   * the checkpoint is a `user/message` whose `source.kind` is
//     'compact-checkpoint' and whose `source.compactionId` names the compaction;
//   * its text is the preamble followed by `<compacted-summary>…</compacted-summary>`;
//   * it replaces the older range and is FOLLOWED by the retained recent units.

export const PLUGIN_ID = 'dsh-session-pages'
export const VERSION = '0.5.7'
export const ROUTE_PREFIX = '/dsh-session-pages'
export const VIEW_ID = 'windows'
export const VIEW_ORDER = 30
export const CHECKPOINT_KIND = 'compact-checkpoint'
export const SUMMARY_OPEN = '<compacted-summary>'
export const SUMMARY_CLOSE = '</compacted-summary>'
export const SUMMARY_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation'

export const DEFAULTS = Object.freeze({
  // How much of one message the payload carries. The view clips again only for
  // layout, never to hide a value the host shipped.
  clipChars: 220,
  toolArgsChars: 140,
  toolResultChars: 260,
  // A guard, not a product decision: one window with thousands of items would
  // make a single HTTP response unusable.
  maxItemsPerPage: 20000,
  // The summary pass ships frames only; a page's rows come from the items pass,
  // one page at a time.
  withItems: false,
  onlyPage: null,
  withTools: false,
})

export function resolveConfig(config = {}) {
  const options = { ...DEFAULTS }
  const unknown = []
  for (const [key, value] of Object.entries(config === null || config === undefined ? {} : config)) {
    if (key in options) options[key] = value
    else unknown.push(key)
  }
  options.clipChars = clampInt(options.clipChars, 40, 4000)
  options.toolArgsChars = clampInt(options.toolArgsChars, 20, 2000)
  options.toolResultChars = clampInt(options.toolResultChars, 40, 4000)
  options.maxItemsPerPage = clampInt(options.maxItemsPerPage, 1, 5000)
  options.withItems = options.withItems === true
  options.onlyPage = Number.isSafeInteger(options.onlyPage) ? options.onlyPage : null
  options.withTools = options.withTools === true
  return { options, unknown }
}

function clampInt(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function isSessionId(value) {
  return typeof value === 'string' && /^session-[A-Za-z0-9-]{8,}$/.test(value)
}

/**
 * The message a user/tool event carries.
 *
 * assistant/message nests it under `data.message`; user/message and tool/result
 * put role/content/source at the top of `data`.
 */
export function messageOf(event) {
  const data = event === null || event === undefined ? {} : event.data || {}
  const nested = data.message
  return nested !== null && typeof nested === 'object' ? nested : data
}

/** Join every text block of a message into one string. */
export function textOf(message) {
  if (message === null || message === undefined) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** Every reasoning block of one message, in order. */
export function reasoningOf(message) {
  if (message === null || message === undefined || Array.isArray(message.content) === false) return ''
  return message.content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** The checkpoint's payload: the summary without its preamble and wrapper tags. */
export function summaryOf(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const open = text.indexOf(SUMMARY_OPEN)
  const close = text.indexOf(SUMMARY_CLOSE)
  if (open !== -1 && close > open) return text.slice(open + SUMMARY_OPEN.length, close).trim()
  const at = text.indexOf(SUMMARY_PREAMBLE)
  if (at !== -1) {
    const rest = text.slice(at + SUMMARY_PREAMBLE.length)
    const afterPeriod = rest.indexOf('.')
    return (afterPeriod === -1 ? rest : rest.slice(afterPeriod + 1)).trim()
  }
  return text.trim()
}

export function isCheckpoint(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'user/message') return false
  const source = event.data === null || event.data === undefined ? undefined : event.data.source
  return source !== null && source !== undefined && source.kind === CHECKPOINT_KIND
}


/**
 * Every seq the log has already dropped from the model's view.
 *
 * Trimming records what it shadowed on the compaction events: `shadowedSeqs` for
 * the individual rows and `shadowedRange` for the span a compaction replaced.
 * Regular events carry `surfaceOp: "append"` and say nothing about visibility.
 */
function shadowedSeqs(sorted) {
  const covered = new Set()
  for (const event of sorted) {
    // A checkpoint states its surface operation directly; compaction records it
    // under `data`.
    const op = event.surfaceOp
    if (op !== null && op !== undefined && typeof op === 'object'
      && Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq)) {
      for (let seq = op.startSeq; seq <= op.endSeq; seq += 1) covered.add(seq)
    }
    const data = event.data
    if (data === null || data === undefined) continue
    const list = data.shadowedSeqs
    if (Array.isArray(list)) {
      for (const seq of list) if (Number.isSafeInteger(seq)) covered.add(seq)
    }
    const range = data.shadowedRange
    if (range !== null && range !== undefined
      && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)) {
      for (let seq = range.start; seq <= range.end; seq += 1) covered.add(seq)
    }
  }
  return covered
}

/** True when [from, to] holds at least one dialogue row the model can still see. */
export function pageHasVisibleDialogue(sorted, from, to) {
  // A shadowed row is gone from the transcript even though it is still in the
  // log; counting it would keep a settings-only prefix as its own window.
  const covered = shadowedSeqs(sorted)
  for (const event of sorted) {
    const seq = Number(event.seq) || 0
    if (seq < from) continue
    if (seq > to) break
    if (covered.has(seq)) continue
    if (event.type === 'assistant/message') return true
    if (event.type === 'user/message' && isHumanUserMessage(event)) return true
  }
  return false
}

/** True when the window holds at least one visible dialogue message. */
function windowHasDialogue(sorted, page) {
  const to = page.endSeq === null ? Number.POSITIVE_INFINITY : page.endSeq
  return pageHasVisibleDialogue(sorted, page.startSeq, to)
}

/**
 * Drop a leading window that holds nothing but settings.
 *
 * A trimmed log starts with a prefix of system/settings events and no dialogue.
 * Splitting windows at checkpoints would count that prefix as "window 1", so
 * "2 windows kept" reads as 3. The rule:
 *
 *   - fewer than two windows          -> keep as is (a fresh session is 1 window);
 *   - first window has a checkpoint   -> it IS a conversation window, keep it;
 *   - prefix holds visible dialogue   -> the trim did not clear it, keep it;
 *   - otherwise                       -> drop it, renumber, and let the first
 *                                        checkpoint window carry the frame.
 */
export function collapseLeadingSettingsPrefix(sorted, pages) {
  if (pages.length < 2) return pages
  const first = pages[0]
  if (first.compactionId !== null) return pages
  if (windowHasDialogue(sorted, first) === true) return pages
  return pages.slice(1).map((page, index) => ({ ...page, index: index + 1 }))
}

export function isHumanUserMessage(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'user/message' || isCheckpoint(event)) return false
  const source = event.data === null || event.data === undefined ? undefined : event.data.source
  if (source === null || source === undefined) return true
  const kind = typeof source.kind === 'string' ? source.kind : ''
  return kind === 'user' || kind === ''
}

/** What kind of user message this is, when it is not the human speaking. */
export function injectionKind(event) {
  const source = event === null || event === undefined || event.data === undefined ? undefined : event.data.source
  if (source === null || source === undefined) return 'injected'
  return typeof source.kind === 'string' && source.kind.length > 0 ? source.kind : 'injected'
}

export function clipText(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return { text: value, chars: value.length, truncated: false }
  return { text: value.slice(0, Math.max(0, limit - 1)) + '…', chars: value.length, truncated: true }
}

function assistantMeta(event) {
  const data = event.data === null || event.data === undefined ? {} : event.data
  const message = data.message === null || data.message === undefined ? {} : data.message
  const usage = data.usage === null || data.usage === undefined ? {} : data.usage
  const content = Array.isArray(message.content) ? message.content : []
  return {
    turn: Number.isSafeInteger(data.turn) ? data.turn : null,
    text: textOf(message),
    reasoning: reasoningOf(message),
    totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : null,
    toolCalls: content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call'),
    isError: message.isError === true,
  }
}

function toolCallMeta(event) {
  const data = event.data === null || event.data === undefined ? {} : event.data
  let args = ''
  if (typeof data.arguments === 'string') args = data.arguments
  else if (data.arguments !== null && data.arguments !== undefined) args = JSON.stringify(data.arguments)
  return {
    callId: typeof data.callId === 'string' ? data.callId : null,
    name: typeof data.name === 'string' ? data.name : 'tool',
    args,
  }
}

function toolResultMeta(event) {
  const data = event.data === null || event.data === undefined ? {} : event.data
  const message = messageOf(event)
  return {
    callId: typeof data.toolCallId === 'string' ? data.toolCallId : typeof data.callId === 'string' ? data.callId : null,
    text: textOf(message),
    isError: message.isError === true,
  }
}

/**
 * What the checkpoint kept verbatim: every context-bearing event between the end
 * of the replaced range and the checkpoint itself.
 *
 * The interval is exact (surfaceOp). The set of messages actually re-sent is not
 * recorded per message - pruning and surface bookkeeping happen outside the log -
 * so this reports counts, never a claim about the live surface.
 */
function retainedTailOf(sorted, boundary, checkpointSeq) {
  if (boundary === undefined || boundary.replacedTo === null) return null
  const from = boundary.replacedTo + 1
  const to = checkpointSeq - 1
  let events = 0
  const byKind = { user: 0, assistant: 0, toolResult: 0 }
  for (const event of sorted) {
    const seq = Number(event.seq)
    if (Number.isSafeInteger(seq) === false || seq < from || seq > to) continue
    events += 1
    if (event.type === 'user/message') byKind.user += 1
    else if (event.type === 'assistant/message') byKind.assistant += 1
    else if (event.type === 'tool/result') byKind.toolResult += 1
  }
  return {
    fromSeq: from,
    toSeq: to,
    events,
    messages: byKind.user + byKind.assistant + byKind.toolResult,
    byKind,
    replacedFrom: boundary.replacedFrom,
    replacedTo: boundary.replacedTo,
  }
}

/** Tool names carried by one request/header event, if it has any. */
function toolsOfHeader(event) {
  const header = event === null || event === undefined || event.data === undefined ? undefined : event.data.header
  const tools = header === null || header === undefined ? undefined : header.tools
  if (Array.isArray(tools) === false) return null
  return tools
    .map((tool) => (tool !== null && typeof tool === 'object' && typeof tool.name === 'string' ? tool.name : null))
    .filter((name) => name !== null)
}

function emptyPage(index, fields) {
  return {
    index,
    compactionId: null,
    summary: '',
    summaryChars: 0,
    startSeq: 0,
    endSeq: null,
    startTime: null,
    endTime: null,
    steps: 0,
    messages: 0,
    toolCalls: 0,
    peakTokens: null,
    turnFrom: null,
    turnTo: null,
    // The frame every request in this window carries.
    context: {
      system: { present: false, inherited: true, chars: 0, preview: null },
      tools: { names: [], count: 0, source: 'none', inherited: true },
      checkpoint: null,
      retainedTail: false,
    },
    items: [],
    itemCount: 0,
    ...fields,
  }
}

export function buildPages(events, options = {}) {
  const settings = { ...DEFAULTS, ...options }
  const list = Array.isArray(events) ? events.filter((event) => event !== null && typeof event === 'object') : []
  const sorted = [...list].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))

  // 1. Boundaries: every checkpoint opens a window.
  const boundaries = []
  for (const event of sorted) {
    if (isCheckpoint(event) === false) continue
    const source = event.data.source || {}
    boundaries.push({
      seq: Number(event.seq) || 0,
      time: Number(event.time) || null,
      compactionId: typeof source.compactionId === 'string' ? source.compactionId : null,
      summary: summaryOf(textOf(messageOf(event))),
      // The checkpoint carries the range it replaced on the EVENT (not in data):
      // { op: 'replace', startSeq, endSeq }. The retained tail is what follows it.
      replacedFrom: Number.isSafeInteger(event.surfaceOp && event.surfaceOp.startSeq) ? event.surfaceOp.startSeq : null,
      replacedTo: Number.isSafeInteger(event.surfaceOp && event.surfaceOp.endSeq) ? event.surfaceOp.endSeq : null,
    })
  }

  const pages = []
  pages.push(emptyPage(1, {
    startSeq: sorted.length > 0 ? Number(sorted[0].seq) || 0 : 0,
    endSeq: boundaries.length > 0 ? boundaries[0].seq - 1 : null,
    startTime: sorted.length > 0 ? Number(sorted[0].time) || null : null,
  }))
  boundaries.forEach((boundary, index) => {
    pages.push(emptyPage(index + 2, {
      compactionId: boundary.compactionId,
      summary: boundary.summary,
      summaryChars: boundary.summary.length,
      startSeq: boundary.seq,
      endSeq: index + 1 < boundaries.length ? boundaries[index + 1].seq - 1 : null,
      startTime: boundary.time,
    }))
  })

  // user/message and the platform injections carry no `turn` field. The turn a
  // message belongs to is the next assistant turn at or after it, so resolve it
  // with one backwards pass instead of inventing an order.
  const upcomingTurn = new Map()
  let nextTurn = null
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const event = sorted[i]
    const data = event.data === null || event.data === undefined ? {} : event.data
    if (event.type === 'assistant/message' && Number.isSafeInteger(data.turn)) nextTurn = data.turn
    upcomingTurn.set(Number(event.seq) || 0, nextTurn)
  }

  const pageForSeq = (seq) => {
    let found = pages[0]
    for (const page of pages) {
      if (seq >= page.startSeq) found = page
      else break
    }
    return found
  }

  // 2. The frame: system prompt and tool declarations, resolved per window.
  const headers = sorted.filter((event) => event.type === 'request/header')
  const presetEvents = sorted
    .filter((event) => event.type === 'agent-preset/selected' && typeof (event.data || {}).agentPreset === 'string')
    .map((event) => ({ seq: Number(event.seq) || 0, preset: event.data.agentPreset }))
  const headerPreset = sorted.find((event) => event.type === 'session')
  const basePreset = headerPreset !== undefined && typeof headerPreset.agentPreset === 'string' ? headerPreset.agentPreset : null
  // The base prompt is the FIRST non-empty system/developer message: later ones
  // are additive developer updates, not a replacement of the frame.
  const systems = sorted
    .filter((event) => event.type === 'system/message' || event.type === 'developer/message')
    .filter((event) => textOf(messageOf(event)).length > 0)
  const baseSystem = systems.length > 0 ? systems[0] : undefined
  for (const page of pages) {
    const systemInPage = systems.find((event) => pageForSeq(Number(event.seq) || 0) === page)
    const systemEvent = systemInPage !== undefined ? systemInPage : baseSystem
    if (systemEvent !== undefined) {
      const text = textOf(messageOf(systemEvent))
      page.context.system = {
        present: text.length > 0,
        inherited: systemInPage === undefined,
        chars: text.length,
        preview: clipText(text, settings.clipChars).text,
        full: text,
      }
    }
    // The query service may hand back the log WITHOUT the session header, so the
    // base preset falls back to the earliest switch the session recorded.
    const activePreset = presetEvents.filter((entry) => entry.seq <= page.startSeq).pop()
    // The first selection inside the window ESTABLISHES its preset; only later
    // ones are switches. Listing the baseline as a switch read as
    // "standard → cordis → standard" for what was really "start standard,
    // switched cordis, switched back".
    const inWindow = presetEvents.filter((entry) => pageForSeq(entry.seq) === page)
    const baselineSeq = activePreset !== undefined
      ? activePreset.seq
      : inWindow.length > 0 ? inWindow[0].seq : -1
    const switches = inWindow.filter((entry) => entry.seq > baselineSeq).map((entry) => entry.preset)
    page.context.preset = {
      id: activePreset !== undefined
        ? activePreset.preset
        : presetEvents.length > 0 ? presetEvents[0].preset : basePreset,
      switches,
    }
    const headerInPage = headers.find((event) => pageForSeq(Number(event.seq) || 0) === page)
    const lastHeaderBefore = headers.filter((event) => (Number(event.seq) || 0) <= page.startSeq).pop()
    const activeHeader = headerInPage !== undefined ? headerInPage : lastHeaderBefore
    const names = toolsOfHeader(activeHeader)
    if (names !== null) {
      page.context.tools = {
        names,
        count: names.length,
        source: 'request-header',
        inherited: headerInPage === undefined,
      }
      if (settings.withTools === true && activeHeader !== undefined) {
        const raw = (activeHeader.data && activeHeader.data.header && activeHeader.data.header.tools) || []
        page.context.tools.detail = raw.map((tool) => ({
          name: typeof tool.name === 'string' ? tool.name : '?',
          description: typeof tool.description === 'string' ? tool.description : '',
          params: Object.keys((tool.parameters && tool.parameters.properties) || {}),
          required: Array.isArray(tool.parameters && tool.parameters.required) ? tool.parameters.required : [],
        }))
      }
    }
    if (page.index > 1) {
      const boundary = boundaries[page.index - 2]
      page.context.checkpoint = {
        compactionId: page.compactionId,
        chars: page.summaryChars,
        preview: clipText(page.summary, settings.clipChars).text,
        replacedFrom: boundary === undefined ? null : boundary.replacedFrom,
        replacedTo: boundary === undefined ? null : boundary.replacedTo,
      }
      page.context.retainedTail = retainedTailOf(sorted, boundary, page.startSeq)
    }
  }

  // 2b. A settings-only prefix is not a window of its own.
  const withoutPrefix = collapseLeadingSettingsPrefix(sorted, pages)
  let floorSeq = 0
  if (withoutPrefix !== pages) {
    pages.length = 0
    for (const page of withoutPrefix) pages.push(page)
    // The prefix's system prompt and tool roster now belong to this window, so
    // it no longer inherits them from a window that is not shown.
    if (pages[0].context.system !== null && pages[0].context.system.present === true) {
      pages[0].context.system.inherited = false
    }
    if (pages[0].context.tools !== null && pages[0].context.tools.count > 0) {
      pages[0].context.tools.inherited = false
    }
    floorSeq = pages[0].startSeq
  }

  // 3. The window's own timeline.
  let dropped = 0
  for (const event of sorted) {
    const seq = Number(event.seq) || 0
    // Events before the first shown window belong to the dropped prefix.
    if (seq < floorSeq) continue
    const page = pageForSeq(seq)
    const time = Number(event.time)
    if (Number.isFinite(time)) {
      if (page.startTime === null) page.startTime = time
      page.endTime = time
    }
    const push = (item) => {
      page.itemCount += 1
      if (settings.withItems === false) return
      if (settings.onlyPage !== null && settings.onlyPage !== page.index) return
      if (page.items.length < settings.maxItemsPerPage) page.items.push(item)
      else dropped += 1
    }

    if (event.type === 'assistant/message') {
      const meta = assistantMeta(event)
      page.steps += 1
      page.toolCalls += meta.toolCalls.length
      if (meta.totalTokens !== null && (page.peakTokens === null || meta.totalTokens > page.peakTokens)) {
        page.peakTokens = meta.totalTokens
      }
      if (meta.turn !== null) {
        if (page.turnFrom === null || meta.turn < page.turnFrom) page.turnFrom = meta.turn
        if (page.turnTo === null || meta.turn > page.turnTo) page.turnTo = meta.turn
      }
      page.messages += 1
      // The chain of thought is part of what this window sent back, so it gets
      // its own row - collapsed in the view, never counted as a message.
      if (meta.reasoning.length > 0) {
        push({
          kind: 'reasoning',
          seq,
          turn: meta.turn,
          ...clipText(meta.reasoning, settings.clipChars),
        })
      }
      // An assistant message that only carries tool calls is still a message -
      // and still a request. Dropping it here made a turn with two tool
      // round-trips report "1 request".
      push({
        kind: 'assistant',
        seq,
        turn: meta.turn,
        step: Number.isSafeInteger(event.data.step) ? event.data.step : null,
        toolCalls: meta.toolCalls.length,
        ...clipText(meta.text, settings.clipChars),
        isError: meta.isError,
      })
      continue
    }
    if (event.type === 'tool/call') {
      const meta = toolCallMeta(event)
      push({
        kind: 'tool-call',
        seq,
        turn: Number.isSafeInteger(event.data.turn) ? event.data.turn : null,
        step: Number.isSafeInteger(event.data.step) ? event.data.step : null,
        label: meta.name,
        callId: meta.callId,
        ...clipText(meta.args, settings.toolArgsChars),
      })
      continue
    }
    if (event.type === 'tool/result') {
      page.messages += 1
      const meta = toolResultMeta(event)
      push({
        kind: 'tool-result',
        seq,
        turn: Number.isSafeInteger(event.data.turn) ? event.data.turn : null,
        step: Number.isSafeInteger(event.data.step) ? event.data.step : null,
        label: 'result',
        callId: meta.callId,
        ...clipText(meta.text, settings.toolResultChars),
        isError: meta.isError,
      })
      continue
    }
    if (isCheckpoint(event)) {
      continue // the checkpoint is a frame item, not a timeline row
    }
    if (event.type === 'user/message') {
      const text = textOf(messageOf(event))
      const turn = Number.isSafeInteger(event.data.turn) ? event.data.turn : (upcomingTurn.get(seq) ?? null)
      page.messages += 1
      if (isHumanUserMessage(event)) {
        if (text.length === 0) continue
        push({ kind: 'user', seq, turn, label: 'user', ...clipText(text, settings.clipChars) })
      } else {
        push({
          kind: 'injection',
          seq,
          turn,
          label: injectionKind(event),
          ...clipText(text, settings.clipChars),
        })
      }
    }
  }

  // 4. Trim and order.
  for (const page of pages) {
    page.items.sort((a, b) => a.seq - b.seq)
    if (page.endTime === null) page.endTime = page.startTime
  }

  const steps = pages.reduce((sum, page) => sum + page.steps, 0)
  const peaks = pages.map((page) => page.peakTokens).filter((value) => value !== null)
  const turns = new Set()
  for (const page of pages) {
    if (page.turnFrom !== null) {
      for (let t = page.turnFrom; t <= page.turnTo; t += 1) turns.add(t)
    }
  }
  return {
    totals: {
      pages: pages.length,
      turns: turns.size,
      steps,
      messages: pages.reduce((sum, page) => sum + page.messages, 0),
      peakTokens: peaks.length === 0 ? null : Math.max(...peaks),
      checkpointChars: pages.reduce((sum, page) => sum + page.summaryChars, 0),
      items: pages.reduce((sum, page) => sum + page.itemCount, 0),
      droppedItems: dropped,
    },
    pages,
  }
}
