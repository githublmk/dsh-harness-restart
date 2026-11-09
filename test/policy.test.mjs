/**
 * Resume policy: argument normalization, selection order, and the live
 * mid-turn snapshot.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectCandidates, normalizeResumeMode, selectResumeEntries } from '../lib/policy.js'

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
