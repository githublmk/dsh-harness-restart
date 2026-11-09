/**
 * Tool surface: definitions, the approval seam, the guard order, and the two
 * read-only tools against a real store directory.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { acquireLock, clearPlan, createPlan, readPlan, writePlan } from '../lib/plan.js'
import { approvalOutcome, createTools } from '../lib/tools.js'

let directory
const config = resolveConfig({})

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-restart-tools-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Build the three tools against a store and a Host context. */
function tools() {
  return createTools({ ctx: { get: () => undefined }, config, directory, log: () => {} })
}

/** A root Session execution identity. */
function rootExec() {
  return {
    agent: {
      id: 'session-a',
      session: { id: 'session-a', seq: 0, header: { cwd: 'C:\\work', agentPreset: 'standard' } },
    },
    callId: 'call-1',
  }
}

test('createTools exposes the three tools with a plain object output schema', () => {
  const created = tools()
  assert.deepEqual(created.map((tool) => tool.name), [
    'harness_restart', 'harness_restart_status', 'harness_restart_cancel',
  ])
  for (const tool of created) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  const restart = created[0]
  assert.deepEqual(restart.parameters.properties.resume.enum, ['interrupted', 'self', 'none'])
  assert.equal(restart.parameters.properties.sessions.items.type, 'string')
})

test('approvalOutcome honors the switch, the service, and every outcome', async () => {
  const agent = { id: 'session-a' }
  const calls = []
  const ctx = {
    get: (key) => (key === 'approval'
      ? {
        async request(request) {
          calls.push(request)
          return 'allowed-once'
        },
      }
      : undefined),
  }
  assert.equal(await approvalOutcome(ctx, { agent, callId: 'call-1' }, config, 'zh'), 'allowed-once')
  assert.equal(calls[0].toolName, 'harness_restart')
  assert.equal(calls[0].callId, 'call-1')
  assert.equal(typeof calls[0].reason, 'string')
  assert.equal(typeof calls[0].displayReason.zh, 'string')

  assert.equal(await approvalOutcome(ctx, { agent }, { ...config, requireApproval: false }, 'zh'), 'skipped')
  assert.equal(await approvalOutcome({ get: () => undefined }, { agent }, config, 'zh'), 'unavailable')
  assert.equal(await approvalOutcome(ctx, {}, config, 'zh'), 'unavailable')
  assert.equal(await approvalOutcome(
    { get: () => ({ request: async () => 'rejected' }) }, { agent }, config, 'zh',
  ), 'rejected')
  assert.equal(await approvalOutcome(
    { get: () => ({ request: async () => 'cancelled' }) }, { agent }, config, 'zh',
  ), 'cancelled')
  assert.equal(await approvalOutcome(
    { get: () => ({ request: async () => { throw new Error('answerer failed') } }) }, { agent }, config, 'zh',
  ), 'unavailable')
})

test('harness_restart refuses a subagent, then bad arguments, then a non-Desktop Host', async () => {
  const restart = tools()[0]
  const nested = await restart.execute({}, {
    agent: { session: { header: { parentSession: 'session-parent', cwd: 'C:\\work' } } },
  })
  assert.equal(nested.ok, false)
  assert.equal(nested.code, 'nested-agent')

  const badResume = await restart.execute({ resume: 'bogus' }, rootExec())
  assert.equal(badResume.ok, false)
  assert.equal(badResume.code, 'invalid-argument')

  const badTasks = await restart.execute({ tasks: [{ prompt: '   ' }] }, rootExec())
  assert.equal(badTasks.ok, false)
  assert.equal(badTasks.code, 'invalid-argument')

  /* The test runner is a plain Node process: no Electron, no shell. */
  const desktop = await restart.execute({}, rootExec())
  assert.equal(desktop.ok, false)
  assert.equal(desktop.code, 'desktop-only')
  assert.equal(typeof desktop.message, 'string')
})

test('harness_restart_status reads an empty store', async () => {
  const status = await tools()[1].execute({}, rootExec())
  assert.deepEqual(status, { ok: true, active: false, plan: '', last: '', unfinished: [] })
})

test('harness_restart_cancel drops an armed plan and reports an absent one', async () => {
  const created = tools()
  const absent = await created[2].execute({}, rootExec())
  assert.deepEqual(absent, { ok: true, cancelled: false, planId: '' })

  const plan = createPlan({ resume: [{ sessionId: 'session-a' }], now: Date.now() })
  writePlan(directory, plan)
  const cancelled = await created[2].execute({}, rootExec())
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.planId, plan.planId)
  assert.equal(readPlan(directory), null)

  /* An executing plan cannot be cancelled from a tool call. */
  const running = createPlan({ now: Date.now() })
  running.state = 'executing'
  writePlan(directory, running)
  const refused = await created[2].execute({}, rootExec())
  assert.equal(refused.cancelled, false)
  assert.equal(refused.planId, running.planId)
})

test('harness_restart_cancel refuses a plan whose restart request is in flight', async () => {
  const plan = createPlan({ now: Date.now() })
  writePlan(directory, plan)
  /* The in-flight request holds the restart lock. */
  const lock = acquireLock(directory, { pid: process.pid })
  assert.notEqual(lock, null)
  try {
    const refused = await tools()[2].execute({}, rootExec())
    assert.equal(refused.cancelled, false)
    assert.equal(refused.planId, plan.planId)
    assert.notEqual(readPlan(directory), null)
  } finally {
    lock.release()
    clearPlan(directory)
  }
})

test('harness_restart_cancel refuses a subagent caller', async () => {
  const plan = createPlan({ now: Date.now() })
  writePlan(directory, plan)
  const refused = await tools()[2].execute({}, {
    agent: { session: { header: { parentSession: 'session-parent' } } },
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'nested-agent')
  assert.notEqual(readPlan(directory), null)
  clearPlan(directory)
})

test('harness_restart_status reports a plan and its unfinished entries', async () => {
  const plan = createPlan({
    resume: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
    tasks: [{ prompt: 'x' }],
    now: Date.now(),
  })
  plan.resume[0].state = 'delivered'
  plan.resume[1].state = 'failed'
  plan.resume[1].error = 'gateway/internal'
  writePlan(directory, plan)
  const status = await tools()[1].execute({}, rootExec())
  assert.equal(status.ok, true)
  assert.equal(status.active, true)
  assert.match(status.plan, new RegExp(plan.planId, 'u'))
  assert.deepEqual(status.unfinished, ['resume:session-b:failed', 'task:task-1:pending'])
})
