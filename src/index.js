// dsh-session-pages - host half.
//
// ONE route, loopback only, GET only:
//
//   GET /dsh-session-pages/state?sessionId=<id>[&clip=<chars>]
//
// It folds the session log into windows and hands the browser one JSON body.
// There is no write path here and no write verb: every non-GET method is 405
// before a body would be read.
//
// Events come from the official query service (ctx.get('sessionQuery')),
// with the live Session's snapshot as the fallback, so the shapes this plugin
// reasons about are the ones the runtime actually validated.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  windowProjection,
} from './projection.js'
import {
  PLUGIN_ID,
  VERSION,
  ROUTE_PREFIX,
  buildPages,
  clipText,
  isSessionId,
  messageOf,
  reasoningOf,
  resolveConfig,
  textOf,
} from './logic.js'

export const name = PLUGIN_ID
export const version = VERSION
// The projection registry drives one fold per live session; without this
// declaration cordis would hand the plugin an empty registry.
export const inject = ['sessionProjections']

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function idVariants(sessionId) {
  const out = new Set([sessionId])
  if (sessionId.startsWith('session-')) out.add(sessionId.slice('session-'.length))
  else out.add('session-' + sessionId)
  return [...out]
}

function findLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
  for (const variant of idVariants(sessionId)) {
    const found = sessions.get(variant)
    if (found) return found
  }
  return undefined
}

function eventsFromLive(session) {
  if (session === null || session === undefined || typeof session.snapshotEvents !== 'function') return undefined
  try {
    const events = session.snapshotEvents()
    if (Array.isArray(events)) return events
  } catch (error) {
    return undefined
  }
  return undefined
}


/**
 * Turn one projection state into the payload the view already understands.
 *
 * Only the per-window SUMMARY comes from the projection. `retainedTail` needs a
 * per-kind count over a seq range, which a fold cannot answer without the events,
 * so that one row is still derived from the log - and the log for a live session
 * is already in memory.
 */

/**
 * The optional `dsh-log-trim` ledger: how much log rewriting already happened to
 * this session. Read-only, best-effort, and never a dependency - a missing file
 * or broken JSON is simply "no record".
 */
const TRIM_LEDGER = path.join(os.homedir(), '.dsh', 'dsh-log-trim', 'ledger.json')

function readTrimLedger(sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(TRIM_LEDGER, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) return null
    const sessions = parsed.sessions
    if (sessions === null || typeof sessions !== 'object') return null
    const bare = sessionId.replace(/^session-/, '')
    const entry = sessions[sessionId] || sessions[bare] || sessions['session-' + bare]
    if (entry === undefined || entry === null || typeof entry !== 'object') return null
    const totals = entry.totals === null || entry.totals === undefined ? {} : entry.totals
    const trims = Array.isArray(entry.trims) ? entry.trims : []
    return {
      windowsRemoved: Number(totals.windowsRemoved) || 0,
      eventsRemoved: Number(totals.eventsRemoved) || 0,
      bytesSaved: Number(totals.bytesSaved) || 0,
      lastAt: typeof totals.lastAt === 'string' ? totals.lastAt : null,
      trims: trims.slice(-5),
    }
  } catch (error) {
    return null
  }
}

/** The timestamp of the event that opens this window. */
function timeAtStart(page, events) {
  if (Number.isFinite(page.createdAt) && page.index > 1) return page.createdAt
  if (Array.isArray(events) === false) return Number.isFinite(page.createdAt) ? page.createdAt : null
  if (page.index === 1) {
    for (const event of events) {
      if (Number.isFinite(event.time)) return event.time
    }
    return null
  }
  const opening = events.find((event) => Number(event.seq) === page.startSeq)
  if (opening !== undefined && Number.isFinite(opening.time)) return opening.time
  return Number.isFinite(page.createdAt) ? page.createdAt : null
}

function stateFromProjection(projection, events, options) {
  // A trimmed log opens with a settings-only prefix; it is not a window. Same
  // rule as the fold: keep it only when it actually holds dialogue.
  const first = projection.pages.length > 1 ? projection.pages[0] : undefined
  const folded = first !== undefined && first.compactionId === null && (first.dialogue || 0) === 0
  const source = folded
    ? projection.pages.slice(1).map((page, index) => ({ ...page, index: index + 1 }))
    : projection.pages
  const pages = source.map((page, position) => {
    const context = {}
    if (page.systemChars > 0) {
      context.system = {
        present: true,
        // The window that now opens the list owns the frame, even though the
        // events carrying it sat in the dropped prefix.
        inherited: folded === true && position === 0 ? false : page.systemInherited === true,
        chars: page.systemChars,
        preview: clipText(page.systemText, options.clipChars).text,
        full: page.systemText,
      }
    }
    if (Array.isArray(page.toolNames)) {
      context.tools = {
        names: page.toolNames,
        count: page.toolNames.length,
        source: 'request-header',
        inherited: false,
      }
    }
    context.preset = { id: projection.presetId, switches: [] }
    if (page.index > 1) {
      context.checkpoint = {
        compactionId: page.compactionId,
        chars: page.summaryChars,
        preview: clipText(page.summary, options.clipChars).text,
        replacedFrom: page.replacedFrom,
        replacedTo: page.replacedTo,
      }
      if (page.replacedTo !== null && events !== null) {
        let events2 = 0
        const byKind = { user: 0, assistant: 0, toolResult: 0 }
        for (const event of events) {
          const seq = Number(event.seq)
          if (Number.isSafeInteger(seq) === false) continue
          if (seq <= page.replacedTo || seq >= page.startSeq) continue
          events2 += 1
          if (event.type === 'user/message') byKind.user += 1
          else if (event.type === 'assistant/message') byKind.assistant += 1
          else if (event.type === 'tool/result') byKind.toolResult += 1
        }
        context.retainedTail = {
          fromSeq: page.replacedTo + 1,
          toSeq: page.startSeq - 1,
          events: events2,
          messages: byKind.user + byKind.assistant + byKind.toolResult,
          byKind,
          replacedFrom: page.replacedFrom,
          replacedTo: page.replacedTo,
        }
      }
    }
    return {
      index: page.index,
      // A window is born with the event that opens it: window 1 with the log's
      // first event (which may be inherited history), later ones with their
      // checkpoint. Read it from the events when the projection cannot know.
      startTime: timeAtStart(page, events),
      startSeq: page.startSeq,
      compactionId: page.compactionId,
      summary: page.summary,
      summaryChars: page.summaryChars,
      turnFrom: page.turnFrom,
      turnTo: page.turnTo,
      steps: page.steps,
      messages: page.messages,
      toolCalls: page.toolCalls,
      peakTokens: page.peakTokens,
      itemCount: page.itemCount,
      context,
    }
  })
  const peak = pages.reduce((max, page) => (page.peakTokens === null ? max : Math.max(max, page.peakTokens)), 0)
  return {
    pages,
    totals: {
      pages: pages.length,
      turns: pages.reduce((max, page) => (page.turnTo === null ? max : Math.max(max, page.turnTo)), 0),
      steps: pages.reduce((sum, page) => sum + page.steps, 0),
      messages: pages.reduce((sum, page) => sum + page.messages, 0),
      peakTokens: peak === 0 ? null : peak,
      checkpointChars: pages.reduce((sum, page) => sum + page.summaryChars, 0),
      items: pages.reduce((sum, page) => sum + page.itemCount, 0),
      droppedItems: 0,
    },
  }
}

/** Live-preferred read through the public query service. */
// Decompressing a session log costs seconds on a multi-megabyte session, and the
// browser polls this route while the view is open. Two cheap layers fix that:
//
//   1. A LIVE session already holds its events in memory - read those first.
//   2. A historical read is cached by session id for a short window.
const EVENT_CACHE = new Map()
const HISTORICAL_TTL_MS = 30000
const EVENT_CACHE_LIMIT = 8

function cacheGet(sessionId) {
  const hit = EVENT_CACHE.get(sessionId)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > HISTORICAL_TTL_MS) {
    EVENT_CACHE.delete(sessionId)
    return undefined
  }
  // Refresh LRU position.
  EVENT_CACHE.delete(sessionId)
  EVENT_CACHE.set(sessionId, hit)
  return hit.events
}

function cacheSet(sessionId, events) {
  EVENT_CACHE.set(sessionId, { at: Date.now(), events })
  while (EVENT_CACHE.size > EVENT_CACHE_LIMIT) {
    const oldest = EVENT_CACHE.keys().next()
    if (oldest.done === true) break
    EVENT_CACHE.delete(oldest.value)
  }
}

async function readEvents(ctx, sessionId) {
  // 1. Live session: the snapshot is already in memory, no decode involved.
  const live = eventsFromLive(findLiveSession(ctx, sessionId))
  if (live !== undefined) return live

  // 2. Historical: reuse a recent decode.
  const cached = cacheGet(sessionId)
  if (cached !== undefined) return cached

  const query = ctx.get('sessionQuery')
  if (query !== undefined && query !== null && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      if (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.events)) {
        cacheSet(sessionId, snapshot.events)
        return snapshot.events
      }
    } catch (error) {
      return null
    }
  }
  return null
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.split(':')[0].toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function guard(req, res) {
  if (isLoopbackAddress(req.socket && req.socket.remoteAddress) === false) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (isLocalHostHeader(host) === false) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch (error) {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' })
      return false
    }
  }
  return true
}

function queryOf(url) {
  try {
    return new URL(url, 'http://localhost').searchParams
  } catch (error) {
    return new URLSearchParams('')
  }
}

function failure(res, error) {
  const status = error instanceof HttpError ? error.status : 500
  const code = error instanceof HttpError ? error.code : 'internal'
  sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
}

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  // Declared in `inject`, so the registry is present before the first step.
  const projections = ctx.sessionProjections
  ctx.effect(
    () => projections.register(windowProjection),
    PLUGIN_ID + ': window projection',
  )

  const registerRoutes = (webServer, fiber) => {
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/state',
        handler: async (req, res) => {
          if (guard(req, res) === false) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const params = queryOf(req.url)
            const sessionId = (params.get('sessionId') || '').trim()
            if (sessionId === '') throw new HttpError(400, 'invalid', 'sessionId required')
            if (isSessionId(sessionId) === false) throw new HttpError(400, 'invalid', 'invalid session id')
            const clip = Number((params.get('clip') || '').trim())
            const options = Number.isSafeInteger(clip) && clip > 0
              ? { ...resolved.options, clipChars: Math.min(clip, 4000) }
              : resolved.options
            const events = await readEvents(ctx, sessionId)
            if (events === null) throw new HttpError(404, 'session-not-found', 'no session log for this id')
            // A live session already carries a driven projection: read it instead
            // of folding the log again. Closed sessions have no cell, so they keep
            // the fold (the decode is cached).
            const forceFold = (params.get('fold') || '') === '1'
            const liveSession = forceFold ? undefined : findLiveSession(ctx, sessionId)
            const projected = liveSession === undefined ? undefined : projections.stateOf(liveSession, windowProjection.key)
            const folded = projected === undefined
              ? buildPages(events, options)
              : stateFromProjection(projected, events, options)
            sendJson(res, 200, {
              ok: true,
              sessionId,
              version: VERSION,
              viewId: 'windows',
              unknownConfig: resolved.unknown,
              trim: readTrimLedger(sessionId),
              ...folded,
            })
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )

    // One window's tool declarations, fetched only when its frame is expanded.
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/tools',
        handler: async (req, res) => {
          if (guard(req, res) === false) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const params = queryOf(req.url)
            const sessionId = (params.get('sessionId') || '').trim()
            if (sessionId === '') throw new HttpError(400, 'invalid', 'sessionId required')
            if (isSessionId(sessionId) === false) throw new HttpError(400, 'invalid', 'invalid session id')
            const page = Number((params.get('page') || '').trim())
            if (Number.isSafeInteger(page) === false || page < 1) throw new HttpError(400, 'invalid', 'page must be a positive integer')
            const events = await readEvents(ctx, sessionId)
            if (events === null) throw new HttpError(404, 'session-not-found', 'no session log for this id')
            const folded = buildPages(events, { ...resolved.options, withTools: true, onlyPage: page })
            const found = folded.pages.find((entry) => entry.index === page)
            if (found === undefined) throw new HttpError(404, 'page-not-found', 'no such window')
            sendJson(res, 200, { ok: true, sessionId, page: page, tools: found.context.tools.detail || [] })
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )

    // One message's untruncated text, fetched only when a row is expanded. The
    // summary pass clips every row; this is how the reader gets the rest back
    // without paying for every long message in the page payload.
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/item',
        handler: async (req, res) => {
          if (guard(req, res) === false) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const params = queryOf(req.url)
            const sessionId = (params.get('sessionId') || '').trim()
            if (sessionId === '') throw new HttpError(400, 'invalid', 'sessionId required')
            if (isSessionId(sessionId) === false) throw new HttpError(400, 'invalid', 'invalid session id')
            const seq = Number((params.get('seq') || '').trim())
            if (Number.isSafeInteger(seq) === false || seq < 0) throw new HttpError(400, 'invalid', 'seq must be a non-negative integer')
            const events = await readEvents(ctx, sessionId)
            if (events === null) throw new HttpError(404, 'session-not-found', 'no session log for this id')
            const event = events.find((entry) => Number(entry && entry.seq) === seq)
            if (event === undefined) throw new HttpError(404, 'event-not-found', 'no event with that seq')
            const kind = (params.get('kind') || 'text').trim()
            const text = kind === 'reasoning' ? reasoningOf(messageOf(event)) : textOf(messageOf(event))
            sendJson(res, 200, { ok: true, sessionId, seq, type: event.type, kind, text, chars: text.length })
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )

    // One page's timeline, fetched only when the reader expands it. The summary
    // pass deliberately ships no rows: a long session would otherwise pay for
    // every window's detail on every poll.
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/items',
        handler: async (req, res) => {
          if (guard(req, res) === false) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const params = queryOf(req.url)
            const sessionId = (params.get('sessionId') || '').trim()
            if (sessionId === '') throw new HttpError(400, 'invalid', 'sessionId required')
            if (isSessionId(sessionId) === false) throw new HttpError(400, 'invalid', 'invalid session id')
            const page = Number((params.get('page') || '').trim())
            if (Number.isSafeInteger(page) === false || page < 1) throw new HttpError(400, 'invalid', 'page must be a positive integer')
            const chunkParam = Number((params.get('chunk') || '1').trim())
            const sizeParam = Number((params.get('chunkSize') || '').trim())
            const chunkSize = Number.isSafeInteger(sizeParam) && sizeParam >= 20 && sizeParam <= 1000 ? sizeParam : 100
            const metaOnly = (params.get('meta') || '') === '1'
            const events = await readEvents(ctx, sessionId)
            if (events === null) throw new HttpError(404, 'session-not-found', 'no session log for this id')
            const folded = buildPages(events, { ...resolved.options, withItems: true, onlyPage: page })
            const found = folded.pages.find((entry) => entry.index === page)
            if (found === undefined) throw new HttpError(404, 'page-not-found', 'no such window')
            const all = Array.isArray(found.items) ? found.items : []
            const chunks = Math.max(1, Math.ceil(all.length / chunkSize))
            const chunk = Math.min(Math.max(1, Number.isSafeInteger(chunkParam) ? chunkParam : 1), chunks)
            const from = (chunk - 1) * chunkSize
            sendJson(res, 200, {
              ok: true,
              sessionId,
              version: VERSION,
              page: {
                index: found.index,
                itemCount: found.itemCount,
                turnFrom: found.turnFrom,
                turnTo: found.turnTo,
                steps: found.steps,
                messages: found.messages,
                toolCalls: found.toolCalls,
              },
              chunk: { index: chunk, size: chunkSize, chunks, count: metaOnly ? 0 : Math.max(0, Math.min(chunkSize, all.length - from)), total: all.length },
              items: metaOnly ? [] : all.slice(from, from + chunkSize),
            })
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer) registerRoutes(webServer, ctx)
  else ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
}
