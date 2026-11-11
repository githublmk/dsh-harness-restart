/**
 * Plan store: atomic writes, corruption tolerance, TTL, lock reclaim, receipts.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  acquireLock, appendReceipt, clearPlan, createPlan, isActive, isExpired, newPlanId, planPaths,
  readPlan, readReceipts, recentPlanSummary, requestIdFor, STATE, storeDirectory, summarizePlan, updatePlan,
  writePlan,
} from '../lib/plan.js'

let directory

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-restart-plan-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('createPlan fills the durable shape and keeps entries pending', () => {
  const plan = createPlan({
    origin: 'tool',
    reason: '  load new code  ',
    language: 'en',
    requestedBy: { sessionId: 'session-a', cwd: 'C:\\work', agentPreset: 'standard' },
    resume: [{ sessionId: 'session-a', cwd: 'C:\\work', openTurnStartSeq: 12, lastTurn: 3 }],
    tasks: [{ prompt: 'run the tests', title: 'tests', target: 'new' }],
    policy: { resume: 'interrupted', maxResumeSessions: 4, staggerMs: 0 },
    ttlMinutes: 30,
    now: 1000,
  })
  assert.equal(plan.version, 1)
  assert.equal(plan.state, STATE.armed)
  assert.equal(plan.reason, 'load new code')
  assert.equal(plan.language, 'en')
  assert.equal(plan.expiresAt, 1000 + 30 * 60_000)
  assert.deepEqual(plan.resume.map((entry) => [entry.sessionId, entry.state]), [['session-a', 'pending']])
  assert.deepEqual(plan.tasks.map((task) => [task.id, task.state, task.target]), [['task-1', 'pending', 'new']])
  assert.equal(plan.policy.resume, 'interrupted')
})

test('createPlan keeps a continuation hint and the subagent lineage on its own entry only', () => {
  const plan = createPlan({
    resume: [
      { sessionId: 'session-root', continuationHint: '  把重构收尾  ' },
      { sessionId: 'session-child', kind: 'subagent', parentSession: 'session-root', delegationDepth: 1 },
    ],
    now: 1000,
  })
  assert.equal(plan.resume[0].continuationHint, '把重构收尾')
  assert.equal('continuationHint' in plan.resume[1], false)
  assert.equal(plan.resume[1].kind, 'subagent')
  assert.equal(plan.resume[1].parentSession, 'session-root')
  assert.equal(plan.resume[1].delegationDepth, 1)
  assert.equal('kind' in plan.resume[0], false)
})

test('newPlanId sorts by request time and is unique enough', () => {
  const first = newPlanId(1762660872000)
  const second = newPlanId(1762660872000)
  assert.match(first, /^rst-\d{8}-\d{6}-[a-z0-9]{4}$/u)
  assert.equal(first.slice(0, 20), second.slice(0, 20))
})

test('writePlan then readPlan round-trips through the atomic path', async () => {
  const plan = createPlan({ reason: 'roundtrip', now: Date.now() })
  writePlan(directory, plan)
  const stored = readPlan(directory)
  assert.equal(stored.planId, plan.planId)
  assert.equal(stored.reason, 'roundtrip')
  assert.ok(stored.updatedAt >= plan.createdAt)
  assert.equal((await readdir(directory)).includes('plan.json'), true)
})

test('readPlan tolerates a corrupt file and keeps it for diagnosis', async () => {
  const file = planPaths(directory).plan
  await writeFile(file, '{ not json', 'utf8')
  assert.equal(readPlan(directory), null)
  const names = await readdir(directory)
  assert.equal(names.some((name) => name.startsWith('plan.json.corrupt-')), true)
  await rm(join(directory, names.find((name) => name.startsWith('plan.json.corrupt-'))))
})

test('updatePlan mutates the stored plan in one write', async () => {
  const plan = createPlan({ reason: 'update', now: Date.now() })
  writePlan(directory, plan)
  const next = updatePlan(directory, (current) => {
    current.state = STATE.done
  })
  assert.equal(next.state, STATE.done)
  assert.equal(readPlan(directory).state, STATE.done)
})

test('clearPlan removes the stored plan', () => {
  clearPlan(directory)
  assert.equal(readPlan(directory), null)
})

test('isActive and isExpired follow the TTL and the state machine', () => {
  const plan = createPlan({ ttlMinutes: 1, now: 5000 })
  assert.equal(isActive(plan), true)
  assert.equal(isExpired(plan, 5000 + 30_000), false)
  assert.equal(isExpired(plan, 5000 + 61_000), true)
  plan.state = STATE.done
  assert.equal(isActive(plan), false)
  plan.state = STATE.executing
  assert.equal(isActive(plan), true)
})

test('the restart lock is exclusive, releasable, and reclaims a dead owner', async () => {
  const first = acquireLock(directory, { pid: process.pid, now: Date.now(), staleMs: 60_000 })
  assert.notEqual(first, null)
  assert.equal(acquireLock(directory, { pid: process.pid, now: Date.now(), staleMs: 60_000 }), null)
  first.release()

  /* A host that died with the shell left its record behind. */
  await writeFile(planPaths(directory).lock, JSON.stringify({ pid: 999_999, at: Date.now() }), 'utf8')
  const reclaimed = acquireLock(directory, { pid: process.pid, now: Date.now(), staleMs: 60_000 })
  assert.notEqual(reclaimed, null)
  reclaimed.release()

  /* An owner that is alive and fresh keeps the lock. */
  const held = acquireLock(directory, { pid: process.pid, now: Date.now(), staleMs: 60_000 })
  assert.notEqual(held, null)
  assert.equal(acquireLock(directory, { pid: process.pid, now: Date.now(), staleMs: 60_000 }), null)
  held.release()
})

test('receipts survive a torn line and summarize the last finished plan', async () => {
  const planId = 'rst-20261109-140000-aaaa'
  appendReceipt(directory, { type: 'plan', planId, origin: 'tool', resume: 2, tasks: 1 })
  appendReceipt(directory, { type: 'resume', planId, sessionId: 'session-a', status: 'delivered' })
  appendReceipt(directory, { type: 'plan-done', planId, ok: true, resumed: 2, tasks: 1 })
  const history = planPaths(directory).history
  const text = await readFile(history, 'utf8')
  await writeFile(history, `${text}{ torn\n`, 'utf8')

  const receipts = readReceipts(directory, 10)
  assert.equal(receipts.length, 3)
  const summary = recentPlanSummary(directory, { now: Date.now(), withinMs: 60_000 })
  assert.equal(summary.planId, planId)
  assert.equal(summary.ok, true)
  assert.equal(summary.resumed, 2)
  assert.equal(summary.tasks, 1)
  assert.equal(recentPlanSummary(directory, { now: Date.now() + 120_000, withinMs: 60_000 }), null)
})

test('requestIdFor is stable and safe for a Session request id', () => {
  const first = requestIdFor('rst-1', 'resume-session a/b')
  assert.equal(first, requestIdFor('rst-1', 'resume-session a/b'))
  assert.match(first, /^restart-rst-1-resume-session-a-b$/u)
  assert.ok(first.length <= 120)
})

test('summarizePlan reports state and delivered counts', () => {
  const plan = createPlan({
    resume: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
    tasks: [{ prompt: 'x' }],
    now: Date.now(),
  })
  plan.resume[0].state = 'delivered'
  plan.state = STATE.executing
  const zh = summarizePlan(plan, 'zh')
  assert.match(zh, /状态 executing/u)
  assert.match(zh, /恢复 1\/2/u)
  assert.match(zh, /任务 0\/1/u)
  assert.match(summarizePlan(plan, 'en'), /1\/2 sessions/u)
})

test('storeDirectory prefers the profile override and falls back to DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:\\home\\dsh'
  try {
    assert.equal(storeDirectory(null), join('C:\\home\\dsh', 'harness-restart'))
    assert.equal(storeDirectory(' D:\\custom '), 'D:\\custom')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
