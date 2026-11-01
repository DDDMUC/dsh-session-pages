import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPages,
  clipText,
  injectionKind,
  isCheckpoint,
  isHumanUserMessage,
  isSessionId,
  messageOf,
  summaryOf,
  textOf,
} from '../src/logic.js'

const at = (seq, time, type, data) => ({ seq, time, type, data })

function human(seq, turn, text) {
  return at(seq, 1000 + seq, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    turn,
  })
}

function injection(seq, kind, text) {
  return at(seq, 1000 + seq, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  })
}

function checkpoint(seq, compactionId, summary, surfaceOp) {
  const event = at(seq, 1000 + seq, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat it as background.\n\n<compacted-summary>' + summary + '</compacted-summary>' }],
    source: { kind: 'compact-checkpoint', compactionId },
  })
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
  return event
}

function assistant(seq, turn, text, totalTokens, tools = false) {
  const content = [{ type: 'text', text }]
  if (tools) content.push({ type: 'tool-call', id: 'c' + seq, name: 'bash', arguments: '{"command":"ls"}' })
  return at(seq, 1000 + seq, 'assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content },
    usage: { totalTokens, inputTokens: totalTokens - 100, outputTokens: 100 },
  })
}

function systemPrompt(seq, text) {
  return at(seq, 1000 + seq, 'system/message', { message: { role: 'system', content: [{ type: 'text', text }] } })
}

function header(seq, names) {
  return at(seq, 1000 + seq, 'request/header', { header: { config: {}, tools: names.map((name) => ({ name })) } })
}

function toolCall(seq, callId, name, args) {
  return at(seq, 1000 + seq, 'tool/call', { callId, name, arguments: args })
}

function toolResult(seq, callId, text, isError = false) {
  return at(seq, 1000 + seq, 'tool/result', {
    toolCallId: callId,
    message: { role: 'tool', content: [{ type: 'text', text }], isError },
  })
}

test('a session with no compaction is one window starting at the origin', () => {
  const events = [human(1, 1, 'hi'), assistant(2, 1, 'hello', 500), assistant(3, 1, 'more', 900, true)]
  const result = buildPages(events, { withItems: true })
  assert.equal(result.totals.pages, 1)
  assert.equal(result.pages[0].compactionId, null)
  assert.equal(result.pages[0].steps, 2)
  assert.equal(result.pages[0].toolCalls, 1)
  assert.equal(result.pages[0].peakTokens, 900)
  const kinds = result.pages[0].items.map((item) => item.kind)
  assert.deepEqual(kinds, ['user', 'assistant', 'assistant'])
  assert.equal(result.pages[0].items[0].text, 'hi')
})

test('each checkpoint opens a window and its summary heads that window', () => {
  const events = [
    human(1, 1, 'first question'),
    assistant(2, 1, 'first answer', 400),
    checkpoint(3, 'cmp-1', '## Primary Request\n- ship it', { op: 'replace', startSeq: 1, endSeq: 1 }),
    human(4, 2, 'second question'),
    assistant(5, 2, 'second answer', 250),
  ]
  const result = buildPages(events, { withItems: true })
  assert.equal(result.totals.pages, 2)
  assert.equal(result.pages[0].endSeq, 2)
  assert.equal(result.pages[1].startSeq, 3)
  assert.equal(result.pages[1].compactionId, 'cmp-1')
  assert.match(result.pages[1].summary, /Primary Request/)
  const tail = result.pages[1].context.retainedTail
  assert.equal(tail.fromSeq, 2)
  assert.equal(tail.toSeq, 2)
  assert.equal(tail.messages, 1)
  assert.equal(tail.byKind.assistant, 1)
  assert.equal(result.pages[1].context.checkpoint.replacedFrom, 1)
  assert.equal(result.pages[1].context.checkpoint.chars > 0, true)
  // The checkpoint itself is a frame item, not a row.
  assert.equal(result.pages[1].items.some((item) => item.kind === 'checkpoint'), false)
  assert.equal(result.pages[1].items[0].text, 'second question')
})

test('the frame carries the system prompt and tool names, inherited per window', () => {
  const events = [
    systemPrompt(1, 'You are an AI agent.'),
    header(2, ['bash', 'read']),
    human(3, 1, 'go'),
    assistant(4, 1, 'ok', 100),
    checkpoint(5, 'cmp-1', 'summary'),
    assistant(6, 2, 'again', 120),
  ]
  const result = buildPages(events)
  assert.equal(result.pages[0].context.system.present, true)
  assert.equal(result.pages[0].context.system.inherited, false)
  assert.deepEqual(result.pages[0].context.tools.names, ['bash', 'read'])
  // Window 2 has no system event of its own: it inherits window 1's.
  assert.equal(result.pages[1].context.system.inherited, true)
  assert.equal(result.pages[1].context.system.present, true)
  assert.equal(result.pages[1].context.tools.inherited, true)
  assert.deepEqual(result.pages[1].context.tools.names, ['bash', 'read'])
})

test('a preset with no system prompt is reported as absent, not as inherited', () => {
  const result = buildPages([human(1, 1, 'hi'), assistant(2, 1, 'yo', 10)])
  assert.equal(result.pages[0].context.system.present, false)
  assert.deepEqual(result.pages[0].context.tools.names, [])
})

test('injections, tool calls and results are rows with their own kinds', () => {
  const events = [
    injection(1, 'runtime-context', 'cwd is /x'),
    human(2, 1, 'run it'),
    assistant(3, 1, 'sure', 100, true),
    toolCall(4, 'c1', 'bash', '{"command":"ls"}'),
    toolResult(5, 'c1', 'a\nb', false),
    toolCall(6, 'c2', 'bash', '{"command":"false"}'),
    toolResult(7, 'c2', 'boom', true),
  ]
  const result = buildPages(events, { withItems: true })
  const items = result.pages[0].items
  assert.deepEqual(items.map((item) => item.kind), ['injection', 'user', 'assistant', 'tool-call', 'tool-result', 'tool-call', 'tool-result'])
  assert.equal(items[0].label, 'runtime-context')
  assert.equal(items[3].label, 'bash')
  assert.equal(items[6].isError, true)
})

test('the summary pass ships frames only; the items pass ships one window', () => {
  const events = [
    human(1, 1, 'a'), assistant(2, 1, 'b', 10),
    checkpoint(3, 'cmp-1', 'sum'),
    human(4, 2, 'c'), assistant(5, 2, 'd', 20),
  ]
  const summary = buildPages(events)
  assert.equal(summary.pages[0].items.length, 0)
  assert.equal(summary.pages[1].items.length, 0)
  assert.equal(summary.pages[0].itemCount, 2)
  assert.equal(summary.pages[1].itemCount, 2)

  const one = buildPages(events, { withItems: true, onlyPage: 2 })
  assert.equal(one.pages[0].items.length, 0)
  assert.equal(one.pages[1].items.length, 2)
  assert.equal(one.pages[1].items[0].text, 'c')
})

test('a checkpoint without a surfaceOp claims no retained interval', () => {
  const events = [human(1, 1, 'a'), checkpoint(2, 'cmp-1', 'sum'), assistant(3, 2, 'b', 10)]
  const result = buildPages(events)
  assert.equal(result.pages[1].context.retainedTail, null)
})

test('the summary is stripped of its preamble and wrapper tags', () => {
  const text = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat it as background.\n\n<compacted-summary>BODY</compacted-summary>'
  assert.equal(summaryOf(text), 'BODY')
  assert.equal(summaryOf('no tags at all'), 'no tags at all')
})

test('checks and predicates read the nested and flat message shapes', () => {
  assert.equal(isCheckpoint(checkpoint(9, 'x', 'body')), true)
  assert.equal(isHumanUserMessage(checkpoint(9, 'x', 'body')), false)
  assert.equal(isHumanUserMessage(human(1, 1, 'hi')), true)
  assert.equal(isHumanUserMessage(injection(2, 'runtime-context', 'ctx')), false)
  assert.equal(injectionKind(injection(2, 'skill-catalog', 'x')), 'skill-catalog')
  assert.equal(messageOf(assistant(2, 1, 'x', 1)).role, 'assistant')
  assert.equal(messageOf(human(1, 1, 'hi')).role, 'user')
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
})

test('text is clipped with its true length kept', () => {
  const clipped = clipText('abcdefghij', 5)
  assert.equal(clipped.chars, 10)
  assert.equal(clipped.truncated, true)
  assert.equal(clipped.text.length, 5)
  assert.equal(clipText('abc', 5).truncated, false)
})

test('session ids are validated', () => {
  assert.equal(isSessionId('session-1234abcd'), true)
  assert.equal(isSessionId('1234abcd'), false)
  assert.equal(isSessionId('session-'), false)
})
