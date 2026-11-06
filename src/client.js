// dsh-session-pages - browser half.
//
// Registers ONE conversation view tab (id 'windows', order 30) beside the chat
// view (0) and the trajectory views (10, 20). It draws the session as windows:
// the session origin opens window 1, every compaction checkpoint opens the next
// one, and each window is headed by the summary that replaced the older range.
//
// A window is shown in two layers, because it IS two layers:
//   frame - what every request in this window carries in front: system prompt,
//           tool declarations, checkpoint, retained tail;
//   rows  - the window's own timeline, fetched per window on expand.
//
// The tab is read-only: it GETs this plugin's own routes, on a timer while the
// tab is open and never otherwise. Nothing here can write a session event.
window.__ModuleLoader__.load({
  id: 'dsh-session-pages',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    const NS = 'dsh-session-pages'
    const VERSION = '0.5.7'
    const ROUTE_PREFIX = '/dsh-session-pages'
    const VIEW_ID = 'windows'
    const VIEW_ORDER = 30
    const REFRESH_INTERVAL_MS = 10000

    const zh = {
      'view.windows': '窗口',
      'head.title': '{pages} 个窗口',
      'head.meta': '{turns} 轮 · {steps} 步 · {items} 条 · 峰值 {peak}',
      'head.trim': '累计裁掉 {windows} 窗 / {events} 条',
      'head.trimNone': '未裁剪',
      'head.loading': '正在读取会话…',
      'head.failed': '读取失败：{error}',
      'head.empty': '这个会话还没有任何事件。',
      'page.title': '第 {n} 窗',
      'page.origin': '会话开头',
      'page.born': '始于 {time}',
      'page.compacted': '压缩于第 {turn} 轮',
      'page.meta': '第 {from}–{to} 轮 · {steps} 次请求 · {messages} 条消息 · {tools} 次工具调用 · 峰值 {peak} token',
      'page.boundary': '本窗从这里开始 · 第 {from}–{to} 轮 · {steps} 次请求 · {messages} 条消息 · {tools} 次工具调用 · 峰值 {peak}',
      'frame.preset': '预设',
      'frame.system': '系统提示词',
      'frame.expand': '展开',
      'frame.collapse': '收起',
      'frame.loading': '读取中…',
      'frame.presetChanged': '（本窗内切换：{list}）',
      'frame.systemInherited': '沿用上一窗',
      'frame.systemAbsent': '无（预设未给提示词）',
      'frame.tools': '工具声明',
      'frame.toolsNone': '无工具',
      'frame.toolsInherited': '（沿用同一份请求头）',
      'frame.more': '等 {n} 个',
      'frame.checkpoint': '开窗摘要（{chars} 字符）',
      'frame.checkpointHint': '这一窗以 checkpoint 摘要开头，之前窗口的原文不再发送。',
      'frame.retained': '保留尾部',
      'frame.retainedRange': '替换 seq {from}–{to} · 尾部 {tail} 条对话消息（用户 {user} / 助手 {assistant} / 结果 {tool}）',
      'frame.retainedHint': '区间来自 checkpoint 的 surfaceOp 记录；实际发送集合未逐条记录，这里只报区间与条数。',
      'frame.noSummary': '这一窗从会话开头起算，没有前置摘要。',
      'rows.expand': '展开明细（{n} 块）',
      'rows.expandEmpty': '展开明细',
      'rows.collapse': '收起明细',
      'rows.loading': '正在读取明细…',
      'rows.failed': '明细读取失败：{error}',
      'rows.chunk': '第 {i} 块 · {n} 条',
      'rows.empty': '这一窗没有可列出的条目。',
      'row.injection': '注入',
      'row.reasoning': '思考',
      'row.user': '用户',
      'row.assistant': '助手',
      'row.toolCall': '工具',
      'row.toolResult': '结果',
      'turn.n': '第 {n} 轮',
      'turn.meta': '{steps} 次请求 · {messages} 条消息',
      'group.untagged': '未归入轮次',
      'turn.metaOnly': '{messages} 条',
      'footer.hint': '窗口按压缩分界切开；页首是这一窗每次请求都带在对话前面的东西。',
    }
    const en = {
      'view.windows': 'Windows',
      'head.title': '{pages} window(s)',
      'head.meta': '{turns} turns · {steps} steps · {items} items · peak {peak}',
      'head.trim': '{windows} windows / {events} events trimmed away',
      'head.trimNone': 'no trimming',
      'head.loading': 'Reading the session…',
      'head.failed': 'Read failed: {error}',
      'head.empty': 'This session has no events yet.',
      'page.title': 'Window {n}',
      'page.origin': 'session origin',
      'page.compacted': 'compacted at turn {turn}',
      'page.meta': 'turns {from}–{to} · {steps} requests · {messages} messages · {tools} tool calls · peak {peak} tokens',
      'page.boundary': 'window starts here · turns {from}–{to} · {steps} requests · {messages} messages · {tools} tool calls · peak {peak}',
      'frame.preset': 'Preset',
      'frame.system': 'System prompt',
      'frame.expand': 'Show',
      'frame.collapse': 'Hide',
      'frame.loading': 'Loading…',
      'frame.presetChanged': ' (switched in this window: {list})',
      'frame.systemInherited': 'inherited',
      'frame.systemAbsent': 'none (the preset gives no prompt)',
      'frame.tools': 'Tool declarations',
      'frame.toolsNone': 'no tools',
      'frame.toolsInherited': '(same request header)',
      'frame.more': 'and {n} more',
      'frame.checkpoint': 'Opening summary ({chars} chars)',
      'frame.checkpointHint': 'This window opens with a checkpoint; the earlier windows are no longer sent.',
      'frame.retained': 'Retained tail',
      'frame.retainedRange': 'replaced seq {from}–{to} · tail {tail} messages (user {user} / assistant {assistant} / result {tool})',
      'frame.retainedHint': 'The interval comes from the checkpoint\'s surfaceOp record; the exact set re-sent is not logged, so only the range and counts are reported.',
      'frame.noSummary': 'This window starts at the session origin; it has no preceding summary.',
      'rows.expand': 'Show rows ({n} blocks)',
      'rows.expandEmpty': 'Show rows',
      'rows.collapse': 'Hide rows',
      'rows.loading': 'Reading rows…',
      'rows.failed': 'Rows failed: {error}',
      'rows.chunk': 'block {i} · {n} items',
      'rows.empty': 'No rows in this window.',
      'row.injection': 'Injected',
      'row.reasoning': 'Thinking',
      'row.user': 'User',
      'row.assistant': 'Assistant',
      'row.toolCall': 'Tool',
      'row.toolResult': 'Result',
      'turn.n': 'Turn {n}',
      'turn.meta': '{steps} requests · {messages} messages',
      'group.untagged': 'Not in a turn',
      'turn.metaOnly': '{messages} items',
      'footer.hint': 'Windows are cut at compactions; each page head is what every request in that window carries in front of the dialogue.',
    }

    function formatText(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        values !== null && values !== undefined && Object.prototype.hasOwnProperty.call(values, key)
          ? String(values[key])
          : match,
      )
    }

    /** Local wall-clock stamp for a window's opening event. */
    function formatTime(ms) {
      if (typeof ms !== 'number' || Number.isFinite(ms) === false) return null
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return null
      const pad = (n) => String(n).padStart(2, '0')
      return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function formatCount(value) {
      if (value === null || value === undefined) return '—'
      if (value >= 10000) return (value / 10000).toFixed(1) + '万'
      return String(value)
    }

    // Colours come from the platform's own design tokens (--dsw-alias-*), never
    // from hard-coded hex: this view has to read on the light theme and the dark
    // one. Every token has a neutral fallback so a renamed token degrades to
    // legible rather than to invisible.
    const CSS = `/* dsh-session-pages - window view styles.
   The scale is the host's: 14/22 for a window title, 13/20 body, 12/18 meta,
   11/16 micro; spacing in 4/8/12/16; every colour a --dsw-alias-* token so the
   theme switch is free. */
.dspsp-root{padding:16px 20px 24px;display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}
.dspsp-root *{box-sizing:border-box}

/* ---- page head ---------------------------------------------------------- */
.dspsp-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dspsp-head-title{font-size:14px;line-height:22px;font-weight:600}
.dspsp-head-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}
.dspsp-head-trim{font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));color:var(--dsw-alias-label-secondary,inherit);cursor:help}

/* ---- one window --------------------------------------------------------- */
.dspsp-page{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);overflow:hidden}
.dspsp-page.is-current{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.4))}
.dspsp-page-head{display:flex;align-items:baseline;gap:8px;padding:10px 14px 8px;flex-wrap:wrap}
.dspsp-page-title{font-size:14px;line-height:22px;font-weight:600}
.dspsp-page-born{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));font-variant-numeric:tabular-nums}
.dspsp-tag{font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.14));color:var(--dsw-alias-state-warn-label,#8a5a00);border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.32))}
.dspsp-page-origin{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}
.dspsp-page-meta{padding:2px 14px 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}

/* ---- the frame: what every request carries in front --------------------- */
.dspsp-frame{margin:8px 14px 10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));display:flex;flex-direction:column;gap:6px}
.dspsp-frame-row{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:18px}
.dspsp-frame-row.is-clickable{cursor:pointer;border-radius:4px;padding:1px 4px;margin:-1px -4px}
.dspsp-frame-row.is-clickable:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dspsp-frame-key{flex:0 0 76px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}
.dspsp-frame-val{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary,inherit);word-break:break-word}
.dspsp-frame-val.is-absent{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8))}
.dspsp-frame-pre{margin:2px 0 6px 84px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:17px;max-height:320px;overflow:auto;font-family:var(--dsh-font-family-code-default,ui-monospace,Menlo,monospace);color:var(--dsw-alias-label-secondary,inherit)}
.dspsp-chip{display:inline-block;font-size:11px;line-height:16px;padding:0 5px;margin:0 4px 2px 0;border-radius:4px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,inherit);font-family:var(--dsh-font-family-code-default,ui-monospace,Menlo,monospace)}
.dspsp-fold-btn{flex:0 0 auto;min-width:38px;text-align:center;font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));color:var(--dsw-alias-label-secondary,inherit);background:transparent}
.dspsp-fold-btn.is-empty{border:0;padding:0;width:0;min-width:0;overflow:hidden}
.dspsp-fold-head{display:flex;gap:8px;align-items:baseline;cursor:pointer;padding:2px 4px;margin:0 -4px;border-radius:4px}
.dspsp-fold-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dspsp-fold-body{margin:2px 0 6px 20px;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,inherit);font-family:var(--dsh-font-family-code-default,ui-monospace,Menlo,monospace);max-height:280px;overflow:auto}
.dspsp-full{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:19px;color:var(--dsw-alias-label-primary,inherit)}

/* ---- tool declarations -------------------------------------------------- */
.dspsp-tools{margin:2px 0 4px 84px;display:flex;flex-direction:column;gap:8px;max-height:420px;overflow:auto}
.dspsp-tool{padding-left:8px;border-left:2px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.dspsp-tool-name{font-size:12px;line-height:18px;font-weight:600;font-family:var(--dsh-font-family-code-default,ui-monospace,Menlo,monospace)}
.dspsp-tool-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}
.dspsp-tool-params{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));font-family:var(--dsh-font-family-code-default,ui-monospace,Menlo,monospace)}

/* ---- checkpoint summary ------------------------------------------------- */
.dspsp-summary{margin:8px 14px 4px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05))}
.dspsp-summary>summary{padding:6px 10px;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-secondary,inherit);list-style:none}
.dspsp-summary>summary::-webkit-details-marker{display:none}
.dspsp-summary>summary::before{content:"▸ ";color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}
.dspsp-summary[open]>summary::before{content:"▾ "}
.dspsp-summary pre{margin:0;padding:0 10px 8px;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:19px;max-height:340px;overflow:auto;color:var(--dsw-alias-label-secondary,inherit)}

/* ---- the window-start boundary ------------------------------------------ */
.dspsp-boundary{display:flex;align-items:center;gap:8px;margin:12px 14px 8px}
.dspsp-boundary-line{flex:1 1 auto;height:1px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.28))}
.dspsp-boundary-text{flex:0 1 auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---- toggle ------------------------------------------------------------- */
.dspsp-toggle{margin:0 14px 12px;align-self:flex-start;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;line-height:18px;cursor:pointer}
.dspsp-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}

/* ---- one 100-row block -------------------------------------------------- */
.dspsp-chunk{margin:8px 14px 4px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:8px;padding:6px 8px 8px}
.dspsp-chunk-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}
.dspsp-rows{display:flex;flex-direction:column;gap:2px;padding-top:4px}

/* ---- one turn ----------------------------------------------------------- */
.dspsp-turn-block{margin:10px 0 0}
.dspsp-turn-block:first-child{margin-top:2px}
.dspsp-turn-head{display:flex;align-items:baseline;gap:8px;padding:0 4px 3px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));margin-bottom:4px}
.dspsp-turn-n{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.dspsp-turn-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}
.dspsp-turn-body{display:flex;flex-direction:column;gap:1px}

/* ---- one row ------------------------------------------------------------ */
.dspsp-item{display:flex;align-items:flex-start;gap:8px;padding:2px 4px;border-radius:4px}
.dspsp-item.is-fold{cursor:default}
.dspsp-item.is-fold:has(.dspsp-fold-btn:not(.is-empty)){cursor:pointer}
.dspsp-item.is-fold:has(.dspsp-fold-btn:not(.is-empty)):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}
.dspsp-item-kind{flex:0 0 48px;font-size:11px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dspsp-item-text{flex:1 1 auto;min-width:0;font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,inherit)}
.dspsp-item.is-error .dspsp-item-text{color:var(--dsw-alias-state-error-primary,#c0392b)}
.dspsp-item[data-kind="tool-call"],.dspsp-item[data-kind="tool-result"]{margin-left:56px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}
.dspsp-item[data-kind="tool-call"] .dspsp-item-text,.dspsp-item[data-kind="tool-result"] .dspsp-item-text{font-size:12px;line-height:19px;font-family:var(--dsh-font-family-code-default,ui-monospace,Menlo,monospace);color:var(--dsw-alias-label-secondary,inherit)}
.dspsp-item[data-kind="injection"],.dspsp-reasoning{font-size:12px}
.dspsp-injection-preview,.dspsp-reasoning-preview{flex:1 1 auto;min-width:0;font-style:italic;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dspsp-expand{flex:0 0 auto;align-self:flex-start;margin-left:8px;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-secondary,inherit);font-size:11px;line-height:16px;cursor:pointer}

/* ---- misc --------------------------------------------------------------- */
.dspsp-empty{padding:8px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}
.dspsp-foot{padding:4px 2px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8))}
`

    if (typeof document !== 'undefined' && document !== null) {
      // A hot reload re-runs this module: drop the previous sheet instead of
      // stacking a second copy of the same rules.
      const stale = document.querySelector('style[data-dsh-session-pages]')
      if (stale !== null && stale !== undefined) stale.remove()
      const tag = document.createElement('style')
      tag.setAttribute('data-dsh-session-pages', VERSION)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --- controller ------------------------------------------------------------

    class PagesController {
      constructor(sessionId) {
        this.sessionId = sessionId
        this.listeners = new Set()
        this.timer = null
        this.inFlight = false
        this.state = { summary: null, failure: null, loading: true, rows: new Map() }
      }

      getSnapshot() {
        return this.state
      }

      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }

      publish(patch) {
        this.state = { ...this.state, ...patch }
        for (const listener of this.listeners) listener()
      }

      rowsFor(pageIndex) {
        const entry = this.state.rows.get(pageIndex)
        return entry === undefined
          ? { status: 'idle', itemCount: null, chunkSize: 100, chunkCount: null, chunks: new Map(), error: null }
          : entry
      }

      async refresh() {
        if (this.inFlight === true) return
        this.inFlight = true
        try {
          const response = await fetch(
            ROUTE_PREFIX + '/state?sessionId=' + encodeURIComponent(this.sessionId),
            { headers: { accept: 'application/json' } },
          )
          const body = await response.json()
          if (response.ok === false || body.ok === false) {
            this.publish({ failure: String(body.error || response.status), loading: false })
            return
          }
          this.publish({ summary: body, failure: null, loading: false })
        } catch (error) {
          this.publish({ failure: String((error && error.message) || error), loading: false })
        } finally {
          this.inFlight = false
        }
      }

      async loadChunk(pageIndex, chunkIndex) {
        const entry = this.rowsFor(pageIndex)
        const existing = entry.chunks.get(chunkIndex)
        if (existing !== undefined && (existing.status === 'loading' || existing.status === 'ready')) return
        const pending = new Map(entry.chunks)
        pending.set(chunkIndex, { status: 'loading', items: [], error: null })
        this.state.rows.set(pageIndex, { ...entry, status: 'loading', chunks: pending })
        this.publish({ rows: this.state.rows })
        try {
          const url = ROUTE_PREFIX + '/items?sessionId=' + encodeURIComponent(this.sessionId)
            + '&page=' + String(pageIndex) + '&chunk=' + String(chunkIndex)
          const response = await fetch(url, { headers: { accept: 'application/json' } })
          const body = await response.json()
          const fresh = this.rowsFor(pageIndex)
          const next = new Map(fresh.chunks)
          if (response.ok === false || body.ok === false) {
            const message = String(body.error || response.status)
            next.set(chunkIndex, { status: 'error', items: [], error: message })
            this.state.rows.set(pageIndex, { ...fresh, status: 'error', error: message, chunks: next })
          } else {
            next.set(chunkIndex, { status: 'ready', items: Array.isArray(body.items) ? body.items : [], error: null })
            this.state.rows.set(pageIndex, {
              ...fresh,
              status: 'ready',
              error: null,
              itemCount: body.page === undefined ? fresh.itemCount : body.page.itemCount,
              chunkSize: body.chunk === undefined ? fresh.chunkSize : body.chunk.size,
              chunkCount: body.chunk === undefined ? fresh.chunkCount : body.chunk.chunks,
              chunks: next,
            })
          }
          this.publish({ rows: this.state.rows })
        } catch (error) {
          const fresh = this.rowsFor(pageIndex)
          const next = new Map(fresh.chunks)
          const message = String((error && error.message) || error)
          next.set(chunkIndex, { status: 'error', items: [], error: message })
          this.state.rows.set(pageIndex, { ...fresh, status: 'error', error: message, chunks: next })
          this.publish({ rows: this.state.rows })
        }
      }

      /**
       * Fetch only the block map for one window. Expanding the window must NOT
       * pull a block: the reader chooses which 100-item block to open.
       */
      async loadRows(pageIndex) {
        const entry = this.rowsFor(pageIndex)
        if (entry.chunkCount !== null) return
        this.state.rows.set(pageIndex, { ...entry, status: 'loading' })
        this.publish({ rows: this.state.rows })
        try {
          const url = ROUTE_PREFIX + '/items?sessionId=' + encodeURIComponent(this.sessionId)
            + '&page=' + String(pageIndex) + '&meta=1'
          const response = await fetch(url, { headers: { accept: 'application/json' } })
          const body = await response.json()
          const fresh = this.rowsFor(pageIndex)
          if (response.ok === false || body.ok === false) {
            const message = String(body.error || response.status)
            this.state.rows.set(pageIndex, { ...fresh, status: 'error', error: message })
          } else {
            this.state.rows.set(pageIndex, {
              ...fresh,
              status: 'ready',
              error: null,
              itemCount: body.page === undefined ? fresh.itemCount : body.page.itemCount,
              chunkSize: body.chunk === undefined ? fresh.chunkSize : body.chunk.size,
              chunkCount: body.chunk === undefined ? fresh.chunkCount : body.chunk.chunks,
            })
          }
          this.publish({ rows: this.state.rows })
        } catch (error) {
          const fresh = this.rowsFor(pageIndex)
          const message = String((error && error.message) || error)
          this.state.rows.set(pageIndex, { ...fresh, status: 'error', error: message })
          this.publish({ rows: this.state.rows })
        }
      }

      attach() {
        this.refresh()
        this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS)
        return () => {
          if (this.timer !== null) clearInterval(this.timer)
          this.timer = null
        }
      }

      detach() {
        if (this.timer !== null) clearInterval(this.timer)
        this.timer = null
      }
    }

    // --- view ------------------------------------------------------------------

    function PagesView(props) {
      const t = props.t
      const controller = props.controller
      const state = react.useSyncExternalStore(
        (listener) => controller.subscribe(listener),
        () => controller.getSnapshot(),
        () => controller.getSnapshot(),
      )
      react.useEffect(() => controller.attach(), [controller])

      const summary = state.summary
      // Optional: how much of this log dsh-log-trim already rewrote. Absent when
      // the package is not installed, the session has no record, or nothing was
      // removed - in every case the header simply does not mention it.
      const trim = summary === null || summary.trim === undefined ? null : summary.trim
      const trimNote = trim === null
        ? null
        : (trim.windowsRemoved > 0 || trim.eventsRemoved > 0)
            ? {
                text: formatText(t('head.trim'), {
                  windows: formatCount(trim.windowsRemoved),
                  events: formatCount(trim.eventsRemoved),
                }),
                title: trimTooltip(trim),
              }
            : null
      const head = react.createElement(
        'div',
        { className: 'dspsp-head' },
        react.createElement('span', { className: 'dspsp-head-title' },
          summary === null ? t('view.windows') : formatText(t('head.title'), { pages: summary.totals.pages })),
        summary === null
          ? null
          : react.createElement('span', { className: 'dspsp-head-meta' },
              formatText(t('head.meta'), {
                turns: summary.totals.turns,
                steps: summary.totals.steps,
                items: summary.totals.items,
                peak: formatCount(summary.totals.peakTokens),
              })),
        trimNote === null
          ? null
          : react.createElement('span', {
              className: 'dspsp-head-trim',
              title: trimNote.title,
            }, trimNote.text),
      )

      const children = [head]
      if (state.failure !== null) {
        children.push(react.createElement('div', { key: 'fail', className: 'dspsp-note' },
          formatText(t('head.failed'), { error: state.failure })))
      }
      if (summary === null) {
        if (state.failure === null) {
          children.push(react.createElement('div', { key: 'loading', className: 'dspsp-note' }, t('head.loading')))
        }
      } else if (summary.pages.length === 0) {
        children.push(react.createElement('div', { key: 'empty', className: 'dspsp-note' }, t('head.empty')))
      } else {
        summary.pages.forEach((page, index) => {
          children.push(react.createElement(PageCard, {
            key: 'p' + page.index,
            page,
            rows: controller.rowsFor(page.index),
            controller,
            onLoadRows: () => controller.loadRows(page.index),
            t,
            isLast: index === summary.pages.length - 1,
          }))
        })
        children.push(react.createElement('div', { key: 'foot', className: 'dspsp-foot' }, t('footer.hint') + ' · v' + VERSION))
      }

      return react.createElement('div', { className: 'dspsp-root', 'data-dspsp-view': VIEW_ID }, children)
    }

    function FrameBlock(props) {
      const page = props.page
      const controller = props.controller
      const t = props.t
      const context = page.context || {}
      const system = context.system || {}
      const tools = context.tools || {}
      const preset = context.preset || {}
      const [sysOpen, setSysOpen] = react.useState(false)
      const [toolOpen, setToolOpen] = react.useState(false)
      const [toolDetail, setToolDetail] = react.useState(null)
      const rows = []

      const loadTools = () => {
        if (toolDetail !== null || controller === undefined) return
        fetch(ROUTE_PREFIX + '/tools?sessionId=' + encodeURIComponent(controller.sessionId) + '&page=' + String(page.index), { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((body) => setToolDetail(Array.isArray(body.tools) ? body.tools : []))
          .catch(() => setToolDetail([]))
      }

      // Same fold affordance as the 注入 / 思考 rows: the control sits on the
      // LEFT and the whole line is the hit area.
      const foldRow = (key, label, value, open, toggle) =>
        react.createElement('div', {
          key,
          className: 'dspsp-frame-row is-clickable',
          onClick: toggle,
        }, [
          react.createElement('span', { key: 'b', className: 'dspsp-fold-btn' }, open === true ? t('frame.collapse') : t('frame.expand')),
          react.createElement('span', { key: 'k', className: 'dspsp-frame-key' }, label),
          react.createElement('span', { key: 'v', className: 'dspsp-frame-val' }, value),
        ])

      rows.push(react.createElement('div', { key: 'preset', className: 'dspsp-frame-row' }, [
        react.createElement('span', { key: 'k', className: 'dspsp-frame-key' }, t('frame.preset')),
        react.createElement('span', { key: 'v', className: 'dspsp-frame-val' },
          (preset.id || '—') + (Array.isArray(preset.switches) && preset.switches.length > 0
            ? formatText(t('frame.presetChanged'), { list: preset.switches.join(' → ') })
            : '')),
      ]))

      const sysValue = system.present === true
        ? formatCount(system.chars) + ' 字符' + (system.inherited === true ? ' · ' + t('frame.systemInherited') : '')
        : t('frame.systemAbsent')
      rows.push(foldRow('sys', t('frame.system'), sysValue, sysOpen, () => {
        if (system.present === true) setSysOpen(sysOpen === false)
      }))
      if (sysOpen === true && typeof system.full === 'string') {
        rows.push(react.createElement('pre', { key: 'sysfull', className: 'dspsp-frame-pre' }, system.full))
      }

      const names = Array.isArray(tools.names) ? tools.names : []
      const shown = names.slice(0, 14)
      const toolsValue = names.length === 0
        ? t('frame.toolsNone')
        : react.createElement('span', null, [
            shown.map((name) => react.createElement('span', { key: name, className: 'dspsp-chip' }, name)),
            names.length > shown.length
              ? react.createElement('span', { key: 'more', className: 'dspsp-page-origin' },
                  ' ' + formatText(t('frame.more'), { n: names.length - shown.length }))
              : null,
            tools.inherited === true
              ? react.createElement('span', { key: 'inh', className: 'dspsp-page-origin' }, ' ' + t('frame.toolsInherited'))
              : null,
          ])
      rows.push(foldRow('tools', t('frame.tools'), toolsValue, toolOpen, () => {
        const next = toolOpen === false
        setToolOpen(next)
        if (next === true) loadTools()
      }))
      if (toolOpen === true) {
        rows.push(react.createElement('div', { key: 'toolfull', className: 'dspsp-tools' },
          toolDetail === null
            ? [react.createElement('div', { key: 'l', className: 'dspsp-empty' }, t('frame.loading'))]
            : toolDetail.map((tool) => react.createElement('div', { key: tool.name, className: 'dspsp-tool' }, [
                react.createElement('div', { key: 'n', className: 'dspsp-tool-name' }, tool.name),
                react.createElement('div', { key: 'd', className: 'dspsp-tool-desc' }, tool.description),
                react.createElement('div', { key: 'p', className: 'dspsp-tool-params' },
                  tool.params.length === 0 ? '（无参数）' : tool.params.join(' · ')),
              ]))))
      }

      if (page.summaryChars > 0) {
        rows.push(react.createElement('details', { key: 'sum', className: 'dspsp-summary' },
          react.createElement('summary', null, formatText(t('frame.checkpoint'), { chars: page.summaryChars })),
          react.createElement('pre', null, page.summary)))
      }
      const tail = context.retainedTail
      if (tail !== null && tail !== undefined && tail !== false) {
        if (typeof tail === 'object') {
          rows.push(react.createElement('div', { key: 'ret', className: 'dspsp-frame-row' }, [
            react.createElement('span', { key: 'k', className: 'dspsp-frame-key' }, t('frame.retained')),
            react.createElement('span', { key: 'v', className: 'dspsp-frame-val' },
              formatText(t('frame.retainedRange'), {
                from: tail.replacedFrom,
                to: tail.replacedTo,
                tail: tail.messages,
                user: tail.byKind.user,
                assistant: tail.byKind.assistant,
                tool: tail.byKind.toolResult,
              })),
          ]))
          rows.push(react.createElement('div', { key: 'reth', className: 'dspsp-frame-row' }, [
            react.createElement('span', { key: 'k', className: 'dspsp-frame-key' }, ''),
            react.createElement('span', { key: 'v', className: 'dspsp-frame-val is-absent' }, t('frame.retainedHint')),
          ]))
        } else {
          rows.push(react.createElement('div', { key: 'ret', className: 'dspsp-frame-row' }, [
            react.createElement('span', { key: 'k', className: 'dspsp-frame-key' }, t('frame.retained')),
            react.createElement('span', { key: 'v', className: 'dspsp-frame-val' }, t('frame.retainedHint')),
          ]))
        }
      }
      return react.createElement('div', { className: 'dspsp-frame' }, rows)
    }

    function ItemRow(props) {
      const item = props.item
      const controller = props.controller
      const t = props.t
      const [full, setFull] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [open, setOpen] = react.useState(false)
      const expand = () => {
        if (busy === true || full !== null || controller === undefined) return
        setBusy(true)
        const url = ROUTE_PREFIX + '/item?sessionId=' + encodeURIComponent(controller.sessionId)
          + '&seq=' + String(item.seq)
        fetch(url, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((body) => { setFull(typeof body.text === 'string' ? body.text : '') })
          .catch(() => { setFull('') })
          .finally(() => { setBusy(false) })
      }
      const kindKey = {
        'injection': 'row.injection',
        'user': 'row.user',
        'assistant': 'row.assistant',
        'tool-call': 'row.toolCall',
        'tool-result': 'row.toolResult',
      }[item.kind] || 'row.assistant'
      const label = item.kind === 'tool-call'
        ? formatText('{k} · {name}', { k: t(kindKey), name: item.label })
        : t(kindKey)
      if (item.kind === 'reasoning') {
        const preview = String(item.text || '').replace(/\s+/g, ' ').slice(0, 60)
        const expandReasoning = () => {
          if (busy === true || full !== null || controller === undefined) return
          setBusy(true)
          const url = ROUTE_PREFIX + '/item?sessionId=' + encodeURIComponent(controller.sessionId)
            + '&seq=' + String(item.seq) + '&kind=reasoning'
          fetch(url, { headers: { accept: 'application/json' } })
            .then((response) => response.json())
            .then((body) => { setFull(typeof body.text === 'string' ? body.text : '') })
            .catch(() => { setFull('') })
            .finally(() => { setBusy(false) })
        }
        return react.createElement('div', { className: 'dspsp-reasoning', 'data-kind': 'reasoning' }, [
          react.createElement('div', {
            key: 'h',
            className: 'dspsp-fold-head',
            onClick: () => setOpen(open === false),
          }, [
            react.createElement('span', { key: 'a', className: 'dspsp-fold-btn' }, open === true ? '收起' : '展开'),
            react.createElement('span', { key: 'k', className: 'dspsp-item-kind' }, t('row.reasoning')),
            react.createElement('span', { key: 't', className: 'dspsp-reasoning-preview' },
              preview + (item.truncated === true ? '… （' + item.chars + ' 字符）' : '')),
          ]),
          open === true
            ? react.createElement('pre', { key: 'b', className: 'dspsp-fold-body', onClick: expandReasoning },
                full !== null ? full : String(item.text || ''))
            : null,
        ])
      }
      if (item.kind === 'injection') {
        const preview = String(item.text || '').replace(/\s+/g, ' ').slice(0, 60)
        return react.createElement('div', { className: 'dspsp-injection', 'data-kind': 'injection' }, [
          react.createElement('div', { key: 'h', className: 'dspsp-fold-head', onClick: () => setOpen(open === false) }, [
            react.createElement('span', { key: 'a', className: 'dspsp-fold-btn' }, open === true ? '收起' : '展开'),
            react.createElement('span', { key: 'k', className: 'dspsp-item-kind' }, label),
            react.createElement('span', { key: 't', className: 'dspsp-injection-preview' }, preview),
          ]),
          open === true
            ? react.createElement('pre', { key: 'b', className: 'dspsp-fold-body' }, item.text === '' || item.text === undefined ? '—' : item.text)
            : null,
        ])
      }
      const empty = item.text === '' || item.text === undefined
      const calls = Number.isFinite(item.toolCalls) ? item.toolCalls : 0
      const text = empty
        ? (item.kind === 'assistant' && calls > 0 ? '（工具调用 ×' + calls + '）' : '—')
        : item.text
      // Same fold pattern as the other rows: the control sits on the LEFT and
      // the whole line is the hit area. A right-hand button was pushed out of
      // view by long unbroken text.
      const canExpand = item.truncated === true
      const body = open === true && full !== null
        ? react.createElement('pre', { key: 'f', className: 'dspsp-fold-body' }, full)
        : react.createElement('span', { key: 't', className: 'dspsp-item-text' }, text)
      return react.createElement('div', {
        className: 'dspsp-item is-fold' + (item.isError === true ? ' is-error' : ''),
        'data-kind': item.kind,
        onClick: canExpand === true
          ? () => {
              const next = open === false
              setOpen(next)
              if (next === true && full === null) expand()
            }
          : undefined,
      }, [
        react.createElement('span', {
          key: 'x',
          className: 'dspsp-fold-btn' + (canExpand === true ? '' : ' is-empty'),
        }, canExpand === true ? (open === true ? t('frame.collapse') : t('frame.expand')) : ''),
        react.createElement('span', { key: 'k', className: 'dspsp-item-kind' }, label),
        body,
      ])
    }

    /** Group one chunk's items by turn and draw them. */
    function renderItems(items, controller, t) {
      const groups = []
      let current = null
      for (const item of items) {
        const key = item.turn === null || item.turn === undefined ? 'none' : 't' + item.turn
        if (current === null || current.key !== key) {
          current = { key, turn: item.turn, items: [] }
          groups.push(current)
        }
        current.items.push(item)
      }
      return groups.map((group) => {
        const steps = group.items.filter((item) => item.kind === 'assistant').length
        // A tool-call is a block inside the assistant message, not a message of
        // its own; the tool RESULT is. Counting both double-counted every call.
        const messages = group.items.filter((item) =>
          item.kind === 'user' || item.kind === 'assistant' || item.kind === 'tool-result').length
        const untagged = group.turn === null || group.turn === undefined
        return react.createElement('div', { key: 'g' + group.key, className: 'dspsp-turn-block' }, [
          react.createElement('div', { key: 'h', className: 'dspsp-turn-head' }, [
            react.createElement('span', { key: 'n', className: 'dspsp-turn-n' },
              untagged ? t('group.untagged') : formatText(t('turn.n'), { n: group.turn })),
            react.createElement('span', { key: 'm', className: 'dspsp-turn-meta' },
              untagged
                ? formatText(t('turn.metaOnly'), { messages })
                : formatText(t('turn.meta'), { steps, messages })),
          ]),
          react.createElement('div', { key: 'l', className: 'dspsp-turn-body' },
            group.items.map((item) => react.createElement(ItemRow, {
              key: 'i' + item.seq + '-' + item.kind, item, controller, t,
            }))),
        ])
      })
    }

    /** One 200-item block of a window: its own fold, its own fetch. */
    function ChunkBlock(props) {
      const rows = props.rows
      const index = props.index
      const t = props.t
      const chunk = rows.chunks.get(index)
      const size = rows.chunkSize || 100
      const total = rows.itemCount || 0
      const expected = Math.max(0, Math.min(size, total - (index - 1) * size))
      const [open, setOpen] = react.useState(false)
      const count = chunk !== undefined && chunk.status === 'ready' ? chunk.items.length : expected
      const head = react.createElement('div', {
        className: 'dspsp-fold-head',
        onClick: () => {
          const next = open === false
          setOpen(next)
          if (next === true && (chunk === undefined || chunk.status === 'idle' || chunk.status === 'error')) {
            props.controller.loadChunk(props.pageIndex, index)
          }
        },
      }, [
        react.createElement('span', { key: 'b', className: 'dspsp-fold-btn' },
          open === true ? t('rows.collapse') : t('rows.expand')),
        react.createElement('span', { key: 'l', className: 'dspsp-chunk-label' },
          formatText(t('rows.chunk'), { i: index, n: count })),
      ])
      const body = []
      if (open === true) {
        if (chunk === undefined || chunk.status === 'loading') {
          body.push(react.createElement('div', { key: 'l', className: 'dspsp-empty' }, t('rows.loading')))
        } else if (chunk.status === 'error') {
          body.push(react.createElement('div', { key: 'e', className: 'dspsp-empty' },
            formatText(t('rows.failed'), { error: chunk.error })))
        } else {
          body.push(react.createElement('div', { key: 'b', className: 'dspsp-rows' },
            renderItems(chunk.items, props.controller, t)))
        }
      }
      return react.createElement('div', { className: 'dspsp-chunk' }, [head].concat(body))
    }

    function RowsBlock(props) {
      const rows = props.rows
      const count = rows.chunkCount === null ? 1 : rows.chunkCount
      const out = []
      for (let i = 1; i <= count; i += 1) {
        out.push(react.createElement(ChunkBlock, {
          key: 'c' + i, pageIndex: props.page.index, index: i, rows, controller: props.controller, t: props.t,
        }))
      }
      return react.createElement('div', null, out)
    }

    function PageCard(props) {
      const page = props.page
      const rows = props.rows
      const t = props.t
      const meta = formatText(t('page.meta'), {
        from: page.turnFrom === null ? '—' : page.turnFrom,
        to: page.turnTo === null ? '—' : page.turnTo,
        steps: page.steps,
        messages: page.messages,
        tools: page.toolCalls,
        peak: formatCount(page.peakTokens),
      })
      const tag = page.compactionId === null
        ? react.createElement('span', { className: 'dspsp-page-origin' }, t('page.origin'))
        : react.createElement('span', { className: 'dspsp-tag' },
            formatText(t('page.compacted'), { turn: page.turnFrom === null ? '—' : page.turnFrom }))

      // Open/closed is local UI state; what was fetched lives in the controller,
      // so collapsing and re-opening never refetches.
      const [open, setOpen] = react.useState(false)
      const loaded = rows.chunkCount !== null
      const expanded = open === true && loaded === true
      // The window-level label counts BLOCKS: the item count lives on each block.
      const blockSize = rows.chunkSize || 100
      const blocks = page.itemCount === null || page.itemCount === undefined
        ? 0
        : Math.ceil(page.itemCount / blockSize)
      const toggle = react.createElement('button', {
        className: 'dspsp-toggle',
        onClick: () => {
          const next = expanded === false
          setOpen(next)
          if (next === true && loaded === false) props.onLoadRows()
        },
      }, expanded
        ? t('rows.collapse')
        : blocks === 0 ? t('rows.expandEmpty') : formatText(t('rows.expand'), { n: blocks }))

      const body = []
      if (expanded === false) {
        // collapsed: nothing else to draw
      } else if (rows.chunkCount === null) {
        body.push(react.createElement('div', { key: 'l', className: 'dspsp-empty' }, t('rows.loading')))
      } else {
        body.push(react.createElement(RowsBlock, { key: 'r', rows, page, controller: props.controller, t }))
      }

      return react.createElement('section', {
        className: 'dspsp-page' + (props.isLast ? ' is-current' : ''),
        'data-dspsp-page': page.index,
      }, [
        react.createElement('div', { key: 'h', className: 'dspsp-page-head' }, [
          react.createElement('span', { key: 't', className: 'dspsp-page-title' },
            formatText(t('page.title'), { n: page.index })),
          tag,
          typeof page.startTime === 'number'
            ? react.createElement('span', {
                key: 'b',
                className: 'dspsp-page-born',
                title: new Date(page.startTime).toLocaleString(),
              }, formatText(t('page.born'), { time: formatTime(page.startTime) }))
            : null,
        ]),
        react.createElement(FrameBlock, { key: 'f', page, controller: props.controller, t }),
        page.summaryChars > 0
          ? react.createElement('div', { key: 'hint', className: 'dspsp-page-meta' }, t('frame.checkpointHint'))
          : react.createElement('div', { key: 'hint', className: 'dspsp-page-meta' }, t('frame.noSummary')),
        react.createElement('div', { key: 'b', className: 'dspsp-boundary' }, [
          react.createElement('span', { key: 'l1', className: 'dspsp-boundary-line' }),
          react.createElement('span', { key: 't', className: 'dspsp-boundary-text' },
            formatText(t('page.boundary'), {
              from: page.turnFrom === null ? '—' : page.turnFrom,
              to: page.turnTo === null ? '—' : page.turnTo,
              steps: page.steps,
              messages: page.messages,
              tools: page.toolCalls,
              peak: formatCount(page.peakTokens),
            })),
          react.createElement('span', { key: 'l2', className: 'dspsp-boundary-line' }),
        ]),
        toggle,
      ].concat(body))
    }

    // --- plugin ----------------------------------------------------------------

    const TRIM_MODES = {
      window: '裁窗口',
      flatten: '折叠痕迹',
      stream: '清流式回放',
      lossless: '清理已遮蔽事件',
      rebuild: '按表面重建',
    }

    /** "最近一次 2026-11-04 12:57（裁窗口，3→2 窗）" */
    function trimTooltip(trim) {
      const last = Array.isArray(trim.trims) && trim.trims.length > 0 ? trim.trims[trim.trims.length - 1] : null
      const parts = []
      if (last !== null && typeof last.at === 'string') {
        const when = formatTime(Date.parse(last.at))
        if (when !== null) parts.push('最近一次 ' + when)
        const mode = TRIM_MODES[last.mode] || last.mode
        const span = last.windowsBefore !== undefined && last.windowsAfter !== undefined
          ? '，' + String(last.windowsBefore) + '→' + String(last.windowsAfter) + ' 窗'
          : ''
        if (typeof mode === 'string' && mode.length > 0) parts.push('（' + mode + span + '）')
      }
      if (Number.isFinite(trim.bytesSaved) && trim.bytesSaved > 0) {
        parts.push('已省 ' + formatCount(trim.bytesSaved) + ' 字节')
      }
      return parts.filter((part) => part.length > 0).join(' · ')
    }

    function registerView(slots, controllerFor, t) {
      slots.inject('conversation.view', () =>
        slots.register(
          {
            name: 'conversation.view',
            id: VIEW_ID,
            order: VIEW_ORDER,
            locale: NS,
            label: () => t('view.windows'),
            inject: (sessionId) => ({ controller: controllerFor(sessionId) }),
          },
          PagesView,
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ': dictionaries')
      const t = ctx.locale.bind(NS)

      const controllers = new Map()
      const controllerFor = (sessionId) => {
        let controller = controllers.get(sessionId)
        if (controller === undefined) {
          controller = new PagesController(sessionId)
          controllers.set(sessionId, controller)
        }
        return controller
      }
      ctx.effect(
        () => () => {
          for (const controller of controllers.values()) controller.detach()
          controllers.clear()
        },
        NS + ': per-session controllers',
      )

      if (ctx.slots !== undefined && ctx.slots !== null) registerView(ctx.slots, controllerFor, t)
      else if (typeof ctx.inject === 'function') ctx.inject(['slots'], (scope) => registerView(scope.slots, controllerFor, t))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.version = VERSION
    exports.__test = {
      NS, VERSION, ROUTE_PREFIX, VIEW_ID, VIEW_ORDER,
      formatText, formatCount, zh, en, PagesController, PagesView, PageCard, FrameBlock, ItemRow, RowsBlock, registerView,
    }
    return module.exports
  },
})
