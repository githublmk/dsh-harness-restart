/**
 * Resume policy: argument normalization, selection order, and the live
 * mid-turn snapshot.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { attachContinuationHint, collectCandidates, normalizeResumeMode, selectResumeEntries } from '../lib/policy.js'

const candidates = [
  { sessionId: 'session-old', lastEventTime: 100 },
  { sessionId: 'session-self', lastEventTime: 200 },
  { sessionId: 'session-new', lastEventTime: 300 },
]

test('normalizeResumeMode accepts the documented forms', () => {
  assert.equal(normalizeResumeMode(undefined), 'interrupted')
  assert.equal(normalizeResumeMode(null), 'interrupted')
  assert.equal(normalizeResumeMode(''), 'interrupted')
  assert.equal(normalizeResumeMode('SELF'), 'self')
  assert.equal(normalizeResumeMode('none'), 'none')
  assert.equal(normalizeResumeMode('everything'), null)
  assert.equal(normalizeResumeMode(42), null)
  assert.equal(normalizeResumeMode([]), 'none')
  assert.deepEqual(normalizeResumeMode(['session-a', 'session-a', ' session-b ']), ['session-a', 'session-b'])
})

test('interrupted puts the calling Session first and caps the rest', () => {
  const selected = selectResumeEntries({
    candidates,
    mode: 'interrupted',
    selfSessionId: 'session-self',
    cap: 2,
  })
  assert.deepEqual(selected.map((entry) => entry.sessionId), ['session-self', 'session-new'])
})

test('interrupted continues roots before the subagents running under them', () => {
  const selected = selectResumeEntries({
    candidates: [
      { sessionId: 'session-self', lastEventTime: 1 },
      { sessionId: 'session-root-b', lastEventTime: 4 },
      { sessionId: 'session-child-b', kind: 'subagent', parentSession: 'session-root-b', delegationDepth: 1, lastEventTime: 5 },
      { sessionId: 'session-child-a', kind: 'subagent', parentSession: 'session-self', delegationDepth: 1, lastEventTime: 3 },
      { sessionId: 'session-grandchild', kind: 'subagent', parentSession: 'session-child-b', delegationDepth: 2, lastEventTime: 6 },
    ],
    mode: 'interrupted',
    selfSessionId: 'session-self',
    cap: 8,
  })
  assert.deepEqual(selected.map((entry) => entry.sessionId), [
    'session-self', 'session-root-b', 'session-child-b', 'session-child-a', 'session-grandchild',
  ])
  /* The cap cuts the deepest children first, never the caller. */
  const capped = selectResumeEntries({
    candidates: [
      { sessionId: 'session-self', lastEventTime: 1 },
      { sessionId: 'session-child', kind: 'subagent', parentSession: 'session-self', delegationDepth: 1, lastEventTime: 2 },
    ],
    mode: 'interrupted',
    selfSessionId: 'session-self',
    cap: 1,
  })
  assert.deepEqual(capped.map((entry) => entry.sessionId), ['session-self'])
})

test('self only continues the calling Session', () => {
  assert.deepEqual(
    selectResumeEntries({ candidates, mode: 'self', selfSessionId: 'session-old' }).map((entry) => entry.sessionId),
    ['session-old'],
  )
  assert.deepEqual(selectResumeEntries({ candidates, mode: 'self' }), [])
})

test('none continues nothing', () => {
  assert.deepEqual(selectResumeEntries({ candidates, mode: 'none', selfSessionId: 'session-self' }), [])
  assert.deepEqual(selectResumeEntries({ candidates, mode: 'interrupted', cap: 0 }), [])
})

test('an explicit id list is honored even for a Session that is not mid-turn', () => {
  const selected = selectResumeEntries({
    candidates,
    mode: ['session-old', 'session-missing', 'session-old'],
  })
  assert.deepEqual(selected.map((entry) => entry.sessionId), ['session-old', 'session-missing'])
  assert.equal(selected[1].lastEventTime, undefined)
})

test('the continuation hint belongs only to the Session that asked for the restart', () => {
  const entries = [{ sessionId: 'session-self' }, { sessionId: 'session-other' }]
  assert.equal(attachContinuationHint(entries, { continuation: '  先把重构收尾  ', selfSessionId: 'session-self' }), true)
  assert.equal(entries[0].continuationHint, '先把重构收尾')
  assert.equal('continuationHint' in entries[1], false)

  /* A hint never lands on a stranger: it is refused instead of dropped. */
  const others = [{ sessionId: 'session-other' }]
  assert.equal(attachContinuationHint(others, { continuation: 'x', selfSessionId: 'session-self' }), false)
  assert.equal('continuationHint' in others[0], false)
  assert.equal(attachContinuationHint(others, { continuation: 'x' }), false)

  /* No hint is not a refusal, and whitespace is no hint. */
  assert.equal(attachContinuationHint(others, { selfSessionId: 'session-self' }), true)
  assert.equal(attachContinuationHint([], { continuation: '   ', selfSessionId: 'session-self' }), true)
})

test('collectCandidates includes running subagents with their durable parent', () => {
  const rootSession = { header: { cwd: 'C:\\work' }, seq: 10, snapshotEvents: () => [] }
  const childSession = {
    header: { cwd: 'C:\\work', parentSession: 'session-root', delegationDepth: 1 },
    seq: 8,
    snapshotEvents: () => [],
  }
  const idleChildSession = { header: { parentSession: 'session-root', delegationDepth: 1 }, seq: 8, snapshotEvents: () => [] }
  const orphanSession = { header: {}, seq: 5, snapshotEvents: () => [] }
  const rootAgent = { id: 'session-root', session: rootSession }
  const agents = {
    roots: () => [rootAgent],
    list: () => [
      rootAgent,
      { id: 'session-child', session: childSession, status: 'running' },
      { id: 'session-idle-child', session: idleChildSession },
      { id: 'session-orphan', session: orphanSession, status: 'running' },
    ],
    turnBoundaryOf: (session) => (session === idleChildSession
      ? { openTurnStartSeq: null, lastTurn: 2 }
      : { openTurnStartSeq: 7, lastTurn: 3 }),
  }
  const logs = []
  const found = collectCandidates({ get: (key) => (key === 'agents' ? agents : undefined) }, {
    log: (line) => logs.push(line),
  })
  assert.deepEqual(found.map((entry) => [entry.sessionId, entry.kind, entry.parentSession, entry.delegationDepth]), [
    ['session-root', 'root', undefined, undefined],
    ['session-child', 'subagent', 'session-root', 1],
  ])
  /* A child with no durable parent cannot be routed, so it is left out loudly. */
  assert.equal(logs.some((line) => line.includes('session-orphan')), true)
})

test('collectCandidates keeps only live root Sessions inside a turn', () => {
  const openSession = {
    header: { cwd: 'C:\\work', agentPreset: 'standard' },
    seq: 40,
    snapshotEvents: () => [{ type: 'turn/start', time: 1234 }],
  }
  const idleSession = {
    header: { cwd: 'C:\\work' },
    seq: 12,
    snapshotEvents: () => [{ type: 'turn/end', time: 999 }],
  }
  const agents = {
    roots: () => [
      { id: 'session-open', session: openSession },
      { id: 'session-idle', session: idleSession },
    ],
    turnBoundaryOf: (session) => (session === openSession
      ? { openTurnStartSeq: 33, lastTurn: 7, lastStepBoundary: null }
      : { openTurnStartSeq: null, lastTurn: 2, lastStepBoundary: null }),
  }
  const ctx = { get: (key) => (key === 'agents' ? agents : undefined) }

  const found = collectCandidates(ctx)
  assert.equal(found.length, 1)
  assert.equal(found[0].sessionId, 'session-open')
  assert.equal(found[0].cwd, 'C:\\work')
  assert.equal(found[0].agentPreset, 'standard')
  assert.equal(found[0].openTurnStartSeq, 33)
  assert.equal(found[0].lastTurn, 7)
  assert.equal(found[0].lastEventTime, 1234)
})

test('collectCandidates degrades safely without the agents service', () => {
  assert.deepEqual(collectCandidates({}), [])
  assert.deepEqual(collectCandidates({ get: () => undefined }), [])
  const broken = {
    get: () => ({
      roots: () => {
        throw new Error('unavailable')
      },
      turnBoundaryOf: () => {
        throw new Error('unavailable')
      },
    }),
  }
  assert.deepEqual(collectCandidates(broken), [])
})
