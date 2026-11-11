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

/** A plan whose child is listed before its parent on purpose. */
function makeSubagentPlan() {
  return createPlan({
    origin: 'tool',
    language: 'zh',
    requestedBy: { sessionId: 'session-root' },
    resume: [
      { sessionId: 'session-child', kind: 'subagent', parentSession: 'session-root', delegationDepth: 1 },
      { sessionId: 'session-root' },
    ],
    now: Date.now(),
  })
}

test('a running subagent is continued through its parent, after the parent', async () => {
  const plan = makeSubagentPlan()
  writePlan(directory, plan)
  const controller = fakeController()
  const promptRoot = controller.prompt.bind(controller)
  let rootLive = false
  controller.prompt = async (request, signal) => {
    const value = await promptRoot(request, signal)
    if (request.sessionId === 'session-root') rootLive = true
    return value
  }
  const agents = { get: (id) => (rootLive && id === 'session-root' ? { id: 'session-root' } : undefined) }
  const delivered = []
  const subagents = {
    async prompt(request) {
      delivered.push(request)
      return { messageId: 'message-1' }
    },
  }
  const finished = await executePlan({
    plan,
    directory,
    sessionController: controller,
    agents,
    subagents,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  /* The parent was revived first; only then was the child handed over. */
  assert.equal(controller.prompts.length, 1)
  assert.equal(controller.prompts[0].sessionId, 'session-root')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].parentSessionId, 'session-root')
  assert.equal(delivered[0].childSessionId, 'session-child')
  assert.equal(delivered[0].mode, 'continuable')
  assert.equal(delivered[0].delivery, 'queue')
  assert.equal(delivered[0].requestId, `restart-${plan.planId}-resume-session-child`)
  assert.match(delivered[0].content[0].text, /send_message/u)
  assert.deepEqual(finished.resume.map((entry) => entry.state), ['delivered', 'delivered'])
})

test('a subagent whose parent did not come back is skipped with a receipt', async () => {
  const plan = makeSubagentPlan()
  writePlan(directory, plan)
  const controller = fakeController()
  const subagents = {
    async prompt() {
      throw new Error('a child must not be prompted without a live parent')
    },
  }
  const finished = await executePlan({
    plan,
    directory,
    sessionController: controller,
    agents: { get: () => undefined },
    subagents,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(finished.resume[0].state, 'skipped')
  assert.equal(finished.resume[0].error, 'subagent/parent-unavailable')
  assert.equal(finished.resume[1].state, 'delivered')
  const receipt = readReceipts(directory, 50)
    .filter((entry) => entry.type === 'resume' && entry.planId === plan.planId
      && entry.sessionId === 'session-child')
    .at(-1)
  assert.equal(receipt.status, 'skipped')
  assert.equal(receipt.kind, 'subagent')
  assert.equal(receipt.parentSession, 'session-root')
})

test('a subagent is still continued when its idle parent is revived for it', async () => {
  const plan = makeSubagentPlan()
  writePlan(directory, plan)
  const revived = []
  let rootLive = false
  const agents = {
    get: (id) => (rootLive && id === 'session-root' ? { id: 'session-root' } : undefined),
    async resume(request) {
      revived.push(request)
      rootLive = true
      return { agent: { id: request.resumeSessionId } }
    },
  }
  const delivered = []
  const finished = await executePlan({
    plan,
    directory,
    sessionController: fakeController(),
    agents,
    subagents: { async prompt(request) { delivered.push(request); return { messageId: 'm-1' } } },
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.deepEqual(revived.map((request) => request.resumeSessionId), ['session-root'])
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].childSessionId, 'session-child')
  assert.deepEqual(finished.resume.map((entry) => entry.state), ['delivered', 'delivered'])
})

test('a subagent whose parent cannot be revived is skipped', async () => {
  const plan = makeSubagentPlan()
  writePlan(directory, plan)
  const finished = await executePlan({
    plan,
    directory,
    sessionController: fakeController(),
    agents: {
      get: () => undefined,
      async resume() {
        const error = new Error('session not found')
        error.code = 'session/not-found'
        throw error
      },
    },
    subagents: { async prompt() { throw new Error('the parent is missing') } },
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(finished.resume[0].state, 'skipped')
  assert.equal(finished.resume[0].error, 'subagent/parent-unavailable')
})

test('an uncontinuable subagent is skipped while a transient failure is retried', async () => {
  const failing = (code) => async () => {
    const error = new Error(code)
    error.code = code
    throw error
  }
  const first = makeSubagentPlan()
  writePlan(directory, first)
  const skipped = await executePlan({
    plan: first,
    directory,
    sessionController: fakeController(),
    agents: { get: () => ({ id: 'session-root' }) },
    subagents: { prompt: failing('subagent/not-resumable') },
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(skipped.resume[0].state, 'skipped')
  assert.equal(skipped.resume[0].error, 'subagent/not-resumable')

  const second = makeSubagentPlan()
  writePlan(directory, second)
  const retried = await executePlan({
    plan: second,
    directory,
    sessionController: fakeController(),
    agents: { get: () => ({ id: 'session-root' }) },
    subagents: { prompt: failing('subagent/delivery-unavailable') },
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(retried.resume[0].state, 'failed')
  assert.equal(retried.resume[0].error, 'subagent/delivery-unavailable')
  /* The plan stays executable so the next start tries the entry again. */
  assert.equal(retried.state, STATE.executing)

  const again = await executePlan({
    plan: second,
    directory,
    sessionController: fakeController(),
    agents: { get: () => ({ id: 'session-root' }) },
    subagents: { async prompt() { return { messageId: 'm-1' } } },
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(again.resume[0].state, 'delivered')
  assert.equal(again.resume[0].lastError, 'subagent/delivery-unavailable')
  assert.equal(again.state, STATE.done)
})

test('a subagent whose parent is archived is skipped without reviving it', async () => {
  const plan = makeSubagentPlan()
  writePlan(directory, plan)
  const revived = []
  const finished = await executePlan({
    plan,
    directory,
    sessionController: fakeController(),
    agents: {
      get: () => undefined,
      async resume(request) {
        revived.push(request)
        return { agent: { id: request.resumeSessionId } }
      },
    },
    subagents: { async prompt() { throw new Error('an archived parent must not authorize a child') } },
    archived: new Set(['session-root']),
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.deepEqual(revived, [])
  assert.equal(finished.resume[0].state, 'skipped')
  assert.equal(finished.resume[0].error, 'subagent/parent-unavailable')
})

test('a grandchild is delivered only after the child that has to revive it', async () => {
  const plan = createPlan({
    origin: 'tool',
    language: 'zh',
    requestedBy: { sessionId: 'session-root' },
    resume: [
      /* Listed first, and without delegationDepth, on purpose. */
      { sessionId: 'session-grandchild', kind: 'subagent', parentSession: 'session-child' },
      { sessionId: 'session-child', kind: 'subagent', parentSession: 'session-root' },
      { sessionId: 'session-root' },
    ],
    now: Date.now(),
  })
  writePlan(directory, plan)
  const live = new Set()
  const delivered = []
  const agents = {
    get: (id) => (live.has(id) ? { id } : undefined),
    async resume(request) {
      live.add(request.resumeSessionId)
      return { agent: { id: request.resumeSessionId } }
    },
  }
  const subagents = {
    async prompt(request) {
      delivered.push(request.childSessionId)
      live.add(request.childSessionId)
      return { messageId: 'm-1' }
    },
  }
  const finished = await executePlan({
    plan,
    directory,
    sessionController: fakeController(),
    agents,
    subagents,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.deepEqual(delivered, ['session-child', 'session-grandchild'])
  assert.equal(finished.state, STATE.done)
})

test('a Host without the subagent service skips the children and keeps the roots', async () => {
  const plan = makeSubagentPlan()
  writePlan(directory, plan)
  const controller = fakeController()
  const finished = await executePlan({
    plan,
    directory,
    sessionController: controller,
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(finished.resume[0].state, 'skipped')
  assert.equal(finished.resume[0].error, 'subagents-unavailable')
  assert.equal(finished.resume[1].state, 'delivered')
})

test('a subagent whose parent is an uncontinued subagent is skipped, not revived', async () => {
  const plan = createPlan({
    origin: 'tool',
    language: 'zh',
    resume: [
      { sessionId: 'session-child', kind: 'subagent', parentSession: 'session-root', delegationDepth: 1 },
      { sessionId: 'session-grandchild', kind: 'subagent', parentSession: 'session-child', delegationDepth: 2 },
    ],
    now: Date.now(),
  })
  writePlan(directory, plan)
  const revived = []
  const live = new Set()
  const finished = await executePlan({
    plan,
    directory,
    sessionController: fakeController(),
    agents: {
      get: (id) => (live.has(id) ? { id } : undefined),
      async resume(request) {
        revived.push(request.resumeSessionId)
        live.add(request.resumeSessionId)
        return { agent: { id: request.resumeSessionId } }
      },
    },
    subagents: {
      async prompt(request) {
        if (request.childSessionId === 'session-child') {
          const error = new Error('no continuation state')
          error.code = 'subagent/not-resumable'
          throw error
        }
        live.add(request.childSessionId)
        return { messageId: 'm-1' }
      },
    },
    config: { staggerMs: 0 },
    language: 'zh',
    sleep: async () => {},
  })
  assert.equal(finished.resume[0].state, 'skipped')
  assert.equal(finished.resume[1].state, 'skipped')
  assert.equal(finished.resume[1].error, 'subagent/parent-unavailable')
  /* Only the root may be revived; a subagent is never republished as one. */
  assert.deepEqual(revived, ['session-root'])
})

test('the boot restore waits for a late subagent service instead of skipping', async () => {
  const bootDirectory = await mkdtemp(join(tmpdir(), 'harness-restart-late-subagents-'))
  try {
    const plan = makeSubagentPlan()
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
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(controller.prompts.length, 0)
    assert.equal(readPlan(bootDirectory).state, STATE.restarting)
  } finally {
    await rm(bootDirectory, { recursive: true, force: true })
  }
})

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

  const receipts = readReceipts(directory, 50).filter((receipt) => receipt.planId === plan.planId)
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
