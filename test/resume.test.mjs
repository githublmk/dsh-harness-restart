/**
 * Restore engine: delivery, idempotency, failure classification, deferred tasks.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { createPlan, readPlan, readReceipts, STATE, writePlan } from '../lib/plan.js'
import { deliveredCount, earliestPendingTaskAt, executePlan, scheduleBootRestore } from '../lib/resume.js'

let directory

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-restart-resume-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A Session controller stand-in that records every delivery. */
function fakeController(options = {}) {
  const failing = options.failing instanceof Set ? options.failing : new Set()
  const controller = {
    prompts: [],
    created: [],
    renamed: [],
    async prompt(request) {
      controller.prompts.push(request)
      if (failing.has(request.sessionId)) {
        const error = new Error('session not found')
        error.code = 'session/not-found'
        throw error
      }
      return { accepted: true }
    },
    async create(request) {
      controller.created.push(request)
      return { sessionId: `session-new-${controller.created.length}` }
    },
    async rename(request) {
      controller.renamed.push(request)
      return { title: request.title, seq: 1 }
    },
  }
  return controller
}

/** Build a plan with two continuations and two tasks (one per target). */
function makePlan(extra = {}) {
  return createPlan({
    origin: 'tool',
    reason: 'test restart',
    language: 'zh',
    requestedBy: { sessionId: 'session-a', cwd: 'C:\\work', agentPreset: 'standard' },
    resume: [{ sessionId: 'session-a', cwd: 'C:\\work' }, { sessionId: 'session-b' }],
    tasks: [
      { prompt: 'new-session task', title: 'Task one', target: 'new', cwd: 'C:\\work' },
      { prompt: 'existing session task', target: 'session', sessionId: 'session-target' },
    ],
    now: Date.now(),
    ...extra,
  })
}

test('executePlan delivers continuations and tasks, then finishes', async () => {
  const plan = makePlan()
  writePlan(directory, plan)
  const controller = fakeController()

  const finished = await executePlan({
    plan,
    directory,
    sessionController: controller,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
    log: () => {},
  })

  assert.equal(finished.state, STATE.done)
  assert.deepEqual(finished.resume.map((entry) => entry.state), ['delivered', 'delivered'])
  assert.deepEqual(finished.tasks.map((task) => task.state), ['delivered', 'delivered'])
  assert.equal(deliveredCount(finished.resume), 2)
  assert.equal(deliveredCount(finished.tasks), 2)

  assert.equal(controller.prompts.length, 4)
  const first = controller.prompts[0]
  assert.equal(first.sessionId, 'session-a')
  assert.equal(first.mode, 'queue')
  assert.equal(first.requestId, `restart-${plan.planId}-resume-session-a`)
  assert.match(first.content[0].text, /^\[harness-restart\]/u)

  assert.equal(controller.created.length, 1)
  assert.deepEqual(controller.created[0], { cwd: 'C:\\work' })
  assert.deepEqual(controller.renamed, [{ sessionId: 'session-new-1', title: 'Task one' }])
  const newSessionPrompt = controller.prompts.find((request) => request.sessionId === 'session-new-1')
  assert.equal(newSessionPrompt.requestId, `restart-${plan.planId}-task-task-1`)
  assert.equal(newSessionPrompt.content[0].text, 'new-session task')
  const existingTaskPrompt = controller.prompts.find((request) => request.requestId === `restart-${plan.planId}-task-task-2`)
  assert.equal(existingTaskPrompt.sessionId, 'session-target')

  const receipts = readReceipts(directory, 50)
  assert.equal(receipts.filter((receipt) => receipt.type === 'resume').length, 2)
  assert.equal(receipts.filter((receipt) => receipt.type === 'task').length, 2)
  assert.equal(readPlan(directory).state, STATE.done)
})

test('a second pass delivers nothing again', async () => {
  const plan = readPlan(directory)
  const controller = fakeController()
  const finished = await executePlan({
    plan,
    directory,
    sessionController: controller,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(controller.prompts.length, 0)
  assert.equal(controller.created.length, 0)
  assert.equal(finished.state, STATE.done)
})

test('a permanent Session failure is skipped, not retried, and does not block the rest', async () => {
  const plan = makePlan()
  const controller = fakeController({ failing: new Set(['session-b']) })
  const finished = await executePlan({
    plan,
    directory,
    sessionController: controller,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(finished.resume[0].state, 'delivered')
  assert.equal(finished.resume[1].state, 'skipped')
  assert.equal(finished.resume[1].error, 'session/not-found')
  assert.equal(finished.tasks[0].state, 'delivered')
  assert.equal(finished.state, STATE.done)
})

test('a future task stays pending and is reported for a later pass', async () => {
  const later = Date.now() + 5 * 60_000
  const plan = makePlan({ tasks: [{ prompt: 'later', notBefore: later }] })
  const controller = fakeController()
  const finished = await executePlan({
    plan,
    directory,
    sessionController: controller,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(finished.tasks[0].state, 'pending')
  assert.equal(controller.created.length, 0)
  /* A plan with pending work stays executable so the boot restore re-runs it. */
  assert.equal(finished.state, STATE.executing)
  assert.equal(earliestPendingTaskAt(finished), later)
})

test('a new task joins a resolved workspace instead of a bare cwd', async () => {
  const plan = makePlan({ tasks: [{ prompt: 'in workspace', workspaceId: 'ws-1', cwd: 'C:\\work' }] })
  const controller = fakeController()
  await executePlan({
    plan,
    directory,
    sessionController: controller,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.deepEqual(controller.created, [{ workspaceId: 'ws-1' }])
})

test('scheduleBootRestore restores a stored plan once and records the outcome', async () => {
  const bootDirectory = await mkdtemp(join(tmpdir(), 'harness-restart-boot-'))
  try {
    const plan = makePlan()
    plan.state = STATE.restarting
    writePlan(bootDirectory, plan)
    const controller = fakeController()
    const ctx = {
      get: (key) => (key === 'sessionController' ? controller : undefined),
      effect: (fn) => fn(),
    }
    scheduleBootRestore(ctx, { bootDelayMs: 0, staggerMs: 0, planTtlMinutes: 60 }, {
      directory: bootDirectory,
      log: () => {},
    })
    const deadline = Date.now() + 5000
    while (controller.prompts.length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(controller.prompts.length, 4)
    assert.equal(readPlan(bootDirectory).state, STATE.done)
    assert.equal(readReceipts(bootDirectory).some((receipt) => receipt.type === 'plan-done'), true)
  } finally {
    await rm(bootDirectory, { recursive: true, force: true })
  }
})

test('scheduleBootRestore never executes an expired plan', async () => {
  const bootDirectory = await mkdtemp(join(tmpdir(), 'harness-restart-expired-'))
  try {
    const plan = makePlan()
    plan.state = STATE.restarting
    plan.expiresAt = Date.now() - 1000
    writePlan(bootDirectory, plan)
    const controller = fakeController()
    const ctx = {
      get: (key) => (key === 'sessionController' ? controller : undefined),
      effect: (fn) => fn(),
    }
    scheduleBootRestore(ctx, { bootDelayMs: 0, staggerMs: 0, planTtlMinutes: 60 }, {
      directory: bootDirectory,
      log: () => {},
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(controller.prompts.length, 0)
    assert.equal(readPlan(bootDirectory).state, STATE.expired)
  } finally {
    await rm(bootDirectory, { recursive: true, force: true })
  }
})

test('scheduleBootRestore abandons an armed plan that never reached the shell stop', async () => {
  const bootDirectory = await mkdtemp(join(tmpdir(), 'harness-restart-armed-'))
  try {
    const plan = makePlan()
    writePlan(bootDirectory, plan)
    const controller = fakeController()
    const ctx = {
      get: (key) => (key === 'sessionController' ? controller : undefined),
      effect: (fn) => fn(),
    }
    scheduleBootRestore(ctx, { bootDelayMs: 0, staggerMs: 0, planTtlMinutes: 60 }, {
      directory: bootDirectory,
      log: () => {},
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(controller.prompts.length, 0)
    assert.equal(readPlan(bootDirectory).state, STATE.aborted)
    assert.equal(readReceipts(bootDirectory).some((receipt) => receipt.type === 'plan-abandoned'), true)
  } finally {
    await rm(bootDirectory, { recursive: true, force: true })
  }
})

test('an aborted pass keeps the plan executing and delivers nothing', async () => {
  const plan = makePlan()
  writePlan(directory, plan)
  const controller = fakeController()
  const finished = await executePlan({
    plan,
    directory,
    sessionController: controller,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
    signal: { aborted: true },
  })
  assert.equal(controller.prompts.length, 0)
  assert.equal(finished.state, STATE.executing)
})
