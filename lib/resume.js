/**
 * Boot restore engine.
 *
 * The next Host process reads the plan a previous process wrote and turns it
 * into durable work: one continuation prompt per interrupted Session and one
 * prompt per queued task. Delivery is idempotent (a stable `requestId` per
 * entry, and a created Session is persisted before it is prompted), staggered,
 * and recorded entry by entry, so a Host that dies again in the middle resumes
 * the remaining entries instead of repeating the delivered ones.
 *
 * Only a plan that reached `restarting` (or `executing`, when an earlier start
 * was interrupted) is ever delivered: `armed` is the state written before the
 * relaunch assistant proved it is running, and a Host that died there must not
 * turn an ordinary later start into a surprise continuation.
 *
 * @module dsh-harness-restart/lib/resume
 */
import {
  acquireLock, appendReceipt, isExecutable, isExpired, readPlan, requestIdFor, STATE, writePlan,
} from './plan.js'
import { continuationText } from './text.js'

/** Default pause between two prompts. */
const DEFAULT_STAGGER_MS = 800
/** Attempts to find the services the restore needs before leaving the plan. */
const READY_ATTEMPTS = 20
/** Pause between those attempts, and between lock-conflict attempts. */
const RETRY_MS = 1000

/** Wait for one delay, or for the abort signal. */
function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (!(milliseconds > 0) || signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, milliseconds)
    timer.unref?.()
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** Stable code for a delivery failure. */
function failureCode(error) {
  if (error === null || typeof error !== 'object') return 'unknown'
  if (typeof error.code === 'string' && error.code !== '') return error.code
  if (typeof error.message === 'string' && error.message !== '') return error.message.slice(0, 160)
  return 'unknown'
}

/** Whether a failed prompt can never succeed on a retry. */
const PERMANENT_FAILURES = new Set([
  /* The Session does not exist, or a live agent already drives it. */
  'session/not-found',
  'session/agent-busy',
  /* A subagent can only be continued by its live direct parent: a child that
   * has no continuation state, no live parent, or whose parent did not come
   * back is not retryable. */
  'subagent/not-resumable',
  'subagent/unauthorized',
  'subagent/parent-unavailable',
  'subagent/not-found',
  'subagent/catalog-diagnostic',
  'subagents-unavailable',
])

/** Whether a failed delivery can never succeed on a retry. */
function permanentFailure(code) {
  return PERMANENT_FAILURES.has(code)
}

/** Delivery code for a subagent whose direct parent is not live. */
const PARENT_UNAVAILABLE = 'subagent/parent-unavailable'

/** A failed delivery with a stable code. */
function deliveryError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Deliver one continuation to an interrupted subagent.
 *
 * A child is never prompted directly: the Host continues it from its exact live
 * direct parent, which also cold-resumes a child that exists only in
 * persistence. Parents are delivered first (see {@link deliveryOrder}), so the
 * parent is normally live by the time its children are reached.
 * @param {object} input - `{ plan, entry, language, agents, subagents, signal }`.
 * @returns {Promise<void>} - resolves once the child's inbox accepted the message.
 */
async function deliverSubagent(input) {
  const { plan, entry, language, agents, subagents, signal } = input
  const parentSessionId = typeof entry.parentSession === 'string' ? entry.parentSession : ''
  if (parentSessionId === '') {
    throw deliveryError(PARENT_UNAVAILABLE, 'the interrupted subagent has no durable direct parent')
  }
  if (subagents === undefined || typeof subagents.prompt !== 'function') {
    throw deliveryError('subagents-unavailable', 'this Host cannot continue subagents')
  }
  let parent = typeof agents?.get === 'function' ? agents.get(parentSessionId) : undefined
  if (parent === undefined && typeof agents?.resume === 'function') {
    /* The parent had no open turn (typically a lead that stopped its turn while
     * a teammate ran), so it is not in the plan and nothing revived it. The
     * Host only continues a child through its live direct parent — and the
     * child can only send its result back to a live parent — so the parent is
     * revived bare here and stays idle until that result wakes it. */
    try {
      await agents.resume({ resumeSessionId: parentSessionId, ...(signal === undefined ? {} : { signal }) })
    } catch (error) {
      throw deliveryError(
        PARENT_UNAVAILABLE,
        `the direct parent ${parentSessionId} could not be revived (${failureCode(error)})`,
      )
    }
    parent = typeof agents.get === 'function' ? agents.get(parentSessionId) : undefined
  }
  if (parent === undefined) {
    throw deliveryError(PARENT_UNAVAILABLE, `the direct parent ${parentSessionId} was not revived`)
  }
  await subagents.prompt({
    requestId: requestIdFor(plan.planId, `resume-${entry.sessionId}`),
    parentSessionId,
    childSessionId: entry.sessionId,
    mode: 'continuable',
    delivery: 'queue',
    content: [{ type: 'text', text: continuationText({ plan, entry, language }) }],
  }, signal)
}

/** Parents before children, shallow children before grandchildren. */
function deliveryOrder(entries) {
  const depth = (entry) => (Number.isFinite(entry.delegationDepth) ? entry.delegationDepth : 0)
  return [...entries].sort((left, right) => {
    const leftChild = left.kind === 'subagent' ? 1 : 0
    const rightChild = right.kind === 'subagent' ? 1 : 0
    if (leftChild !== rightChild) return leftChild - rightChild
    return depth(left) - depth(right)
  })
}

/** Every entry of one plan, continuations first. */
function entriesOf(plan) {
  return [
    ...(Array.isArray(plan?.resume) ? plan.resume : []),
    ...(Array.isArray(plan?.tasks) ? plan.tasks : []),
  ]
}

/** Count entries that were handed to a Session. */
export function deliveredCount(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry.state === 'delivered').length
}

/** The earliest pending `notBefore` among tasks, or null. */
export function earliestPendingTaskAt(plan) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : []
  let earliest = null
  for (const task of tasks) {
    if (task.state !== 'pending' || !Number.isFinite(task.notBefore)) continue
    if (earliest === null || task.notBefore < earliest) earliest = task.notBefore
  }
  return earliest
}

/**
 * Deliver one plan.
 *
 * Every entry is written back before the next one starts, so a second Host
 * death leaves an accurate record. A prompt that fails permanently marks the
 * entry `skipped`; any other failure marks it `failed`; both stay recorded and
 * never block the remaining entries. An abort leaves the current entry pending,
 * so it is retried by the next start rather than recorded as a failure.
 * @param {object} input - `{ plan, directory, sessionController, agents, subagents, config, language, sleep, signal, log }`.
 * @returns {Promise<object>} - the plan, with its final state.
 */
export async function executePlan(input) {
  const {
    plan, directory, sessionController, agents, subagents, config, language = 'zh',
    sleep = delay, signal, log = () => {},
  } = input
  const staggerMs = Number.isFinite(config?.staggerMs) ? config.staggerMs : DEFAULT_STAGGER_MS

  plan.state = STATE.executing
  writePlan(directory, plan)

  for (const entry of deliveryOrder(Array.isArray(plan.resume) ? plan.resume : [])) {
    if (signal?.aborted === true) {
      writePlan(directory, plan)
      return plan
    }
    if (entry.state !== 'pending') continue
    try {
      if (entry.kind === 'subagent') {
        await deliverSubagent({ plan, entry, language, agents, subagents, signal })
      } else {
        await sessionController.prompt({
          sessionId: entry.sessionId,
          requestId: requestIdFor(plan.planId, `resume-${entry.sessionId}`),
          mode: 'queue',
          content: [{ type: 'text', text: continuationText({ plan, entry, language }) }],
        }, signal)
      }
      entry.state = 'delivered'
      /* A retried entry keeps no stale failure from an earlier start. */
      delete entry.error
    } catch (error) {
      if (signal?.aborted === true) {
        writePlan(directory, plan)
        return plan
      }
      const code = failureCode(error)
      entry.state = permanentFailure(code) ? 'skipped' : 'failed'
      entry.error = code
    }
    writePlan(directory, plan)
    appendReceipt(directory, {
      type: 'resume',
      planId: plan.planId,
      sessionId: entry.sessionId,
      ...(entry.kind === 'subagent' ? { kind: 'subagent', parentSession: entry.parentSession } : {}),
      status: entry.state,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    })
    log(`restore: resume ${entry.sessionId}${entry.kind === 'subagent' ? ' (subagent)' : ''} -> ${entry.state}`)
    if (entry.state === 'delivered') await sleep(staggerMs, signal)
  }

  for (const task of Array.isArray(plan.tasks) ? plan.tasks : []) {
    if (signal?.aborted === true) {
      writePlan(directory, plan)
      return plan
    }
    if (task.state !== 'pending') continue
    /* A task with a future `at` stays pending; the caller schedules another pass. */
    if (Number.isFinite(task.notBefore) && task.notBefore > Date.now() + 1000) continue
    let sessionId = typeof task.sessionId === 'string' && task.sessionId !== '' ? task.sessionId : null
    try {
      if (task.target === 'new' && sessionId === null) {
        const created = await sessionController.create({
          ...(typeof task.workspaceId === 'string'
            ? { workspaceId: task.workspaceId }
            : (typeof task.cwd === 'string' ? { cwd: task.cwd } : {})),
          ...(typeof task.agentPreset === 'string' ? { agentPreset: task.agentPreset } : {}),
        })
        sessionId = created.sessionId
        task.sessionId = sessionId
        if (typeof task.title === 'string' && task.title !== '') {
          try {
            await sessionController.rename({ sessionId, title: task.title })
          } catch {
            /* the title is cosmetic; the task still runs */
          }
        }
        /* Persist the created Session before prompting: a Host that dies before
         * the prompt must reuse this Session, not create a second one. */
        writePlan(directory, plan)
      }
      if (sessionId === null) throw new Error('task has no target Session')
      await sessionController.prompt({
        sessionId,
        requestId: requestIdFor(plan.planId, `task-${task.id}`),
        mode: 'queue',
        content: [{ type: 'text', text: task.prompt }],
      }, signal)
      task.state = 'delivered'
      delete task.error
    } catch (error) {
      if (signal?.aborted === true) {
        writePlan(directory, plan)
        return plan
      }
      const code = failureCode(error)
      task.state = permanentFailure(code) ? 'skipped' : 'failed'
      task.error = code
    }
    writePlan(directory, plan)
    appendReceipt(directory, {
      type: 'task',
      planId: plan.planId,
      taskId: task.id,
      sessionId: typeof task.sessionId === 'string' ? task.sessionId : null,
      status: task.state,
      ...(task.error === undefined ? {} : { error: task.error }),
    })
    log(`restore: task ${task.id} -> ${task.state}`)
  }

  const pending = entriesOf(plan).some((entry) => entry.state === 'pending')
  plan.state = signal?.aborted === true || pending ? STATE.executing : STATE.done
  writePlan(directory, plan)
  return plan
}

/**
 * Arm the boot restore.
 *
 * Runs once per Host start, shortly after mount so the Session controller and
 * the model route exist. A plan that is expired, or one another Host already
 * finished, is left alone; an `executing` plan is resumed because its stable
 * request ids make a repeat delivery harmless.
 * @param {object} ctx - Host context.
 * @param {object} config - effective configuration.
 * @param {{directory:string, log:Function}} runtime - store directory and logger.
 * @returns {() => void} - disposer.
 */
export function scheduleBootRestore(ctx, config, runtime) {
  const { directory, log = () => {} } = runtime
  let timer
  let cancelled = false
  const controller = new AbortController()

  const schedule = (milliseconds, work) => {
    timer = setTimeout(work, milliseconds)
    timer.unref?.()
  }

  const run = async (attempt, expectedPlanId) => {
    if (cancelled) return
    let plan
    try {
      plan = readPlan(directory)
    } catch {
      plan = null
    }
    if (plan === null) return
    if (expectedPlanId !== undefined && plan.planId !== expectedPlanId) return
    if (isExpired(plan)) {
      plan.state = STATE.expired
      try {
        writePlan(directory, plan)
      } catch {
        /* the next start sees the same expired plan */
      }
      appendReceipt(directory, { type: 'plan-expired', planId: plan.planId })
      log('restore: plan expired; not executed')
      return
    }
    if (plan.state === STATE.armed) {
      plan.state = STATE.aborted
      try {
        writePlan(directory, plan)
      } catch {
        /* the previous state still blocks a boot execution */
      }
      appendReceipt(directory, { type: 'plan-abandoned', planId: plan.planId, reason: 'armed-without-restart' })
      log('restore: abandoned an armed plan that never reached the shell stop')
      return
    }
    if (!isExecutable(plan)) return
    const sessionController = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    if (sessionController === undefined) {
      if (attempt < READY_ATTEMPTS && !cancelled) {
        schedule(RETRY_MS, () => {
          void run(attempt + 1, expectedPlanId)
        })
        return
      }
      log('restore: sessionController unavailable; plan kept for the next start')
      return
    }
    let lock = null
    try {
      lock = acquireLock(directory, { pid: process.pid, staleMs: 60_000 })
    } catch {
      lock = null
    }
    if (lock === null) {
      if (attempt < READY_ATTEMPTS && !cancelled) {
        schedule(RETRY_MS, () => {
          void run(attempt + 1, expectedPlanId)
        })
        return
      }
      log('restore: restart lock still held; plan kept for the next start')
      return
    }
    try {
      /* Re-read under the lock: a cancel or a newer request may have replaced it. */
      const current = readPlan(directory)
      if (current === null || current.planId !== plan.planId || !isExecutable(current)) {
        log('restore: the plan changed before delivery; leaving it alone')
        return
      }
      const finished = await executePlan({
        plan: current,
        directory,
        sessionController,
        agents: typeof ctx.get === 'function' ? ctx.get('agents') : undefined,
        subagents: typeof ctx.get === 'function' ? ctx.get('subagents') : undefined,
        config,
        language: current.language === 'en' ? 'en' : 'zh',
        signal: controller.signal,
        log,
      })
      const entries = entriesOf(finished)
      const failed = entries.some((entry) => entry.state === 'failed')
      appendReceipt(directory, {
        type: 'plan-done',
        planId: finished.planId,
        ok: finished.state === STATE.done && !failed,
        resumed: deliveredCount(finished.resume),
        tasks: deliveredCount(finished.tasks),
      })
      log(`restore: plan ${finished.planId} -> ${finished.state}`)
      const next = earliestPendingTaskAt(finished)
      if (next !== null && !cancelled) {
        const wait = Math.min(Math.max(next - Date.now() + 250, 1000), 30 * 60_000)
        schedule(wait, () => {
          void run(attempt + 1, finished.planId)
        })
      }
    } catch (error) {
      plan.state = STATE.failed
      try {
        writePlan(directory, plan)
      } catch {
        /* keep the previous state when the store is unwritable */
      }
      appendReceipt(directory, { type: 'plan-failed', planId: plan.planId, error: failureCode(error) })
      log(`restore: failed (${failureCode(error)})`)
    } finally {
      lock.release()
    }
  }

  schedule(Number.isFinite(config?.bootDelayMs) ? config.bootDelayMs : 1500, () => {
    void run(0)
  })

  const dispose = () => {
    cancelled = true
    controller.abort()
    if (timer !== undefined) clearTimeout(timer)
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'harness-restart: restore')
  return dispose
}
