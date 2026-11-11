/**
 * Restart execution for the harness-restart bundle.
 *
 * The Desktop Host is a child of the Electron shell and stops itself on
 * `process.disconnect`, so the Host cannot stop the shell and then start the
 * app: `relaunch.mjs` is started **before** the shell is stopped (detached, no
 * pipes), waits for both processes to disappear, and starts the application the
 * way a double click does. Nothing stops the shell unless that assistant is
 * still alive right before the kill.
 *
 * On top of the v0.3.0 path this module:
 * - writes a durable plan first, so the next Host knows what to continue;
 * - flushes live Sessions before the kill and reports an unconfirmed barrier;
 * - stops the shell on a short timer, so the tool result reaches the Session
 *   log before the process dies;
 * - re-reads the plan and re-checks the assistant immediately before the kill,
 *   and aborts (recording it) when either is gone, so a failed restart never
 *   turns into a surprise on the next normal start.
 *
 * @module dsh-harness-restart/lib/restart
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acquireLock, appendReceipt, clearPlan, createPlan, ensureStore, isExpired, readPlan, STATE, writePlan,
} from './plan.js'
import { attachContinuationHint, collectCandidates, selectResumeEntries } from './policy.js'

/** How long the assistant has to prove it is running before anything is stopped. */
const ASSISTANT_READY_TIMEOUT_MS = 4000
/** Upper bound on waiting for the stopped shell to leave the process table. */
const SHELL_EXIT_TIMEOUT_MS = 3000

/**
 * Detect the Desktop Host: the shell starts this process with the Electron
 * binary in Node mode, so it reports an Electron version and has the Electron
 * main process as its parent. A plain `dsh` process on Node fails both checks.
 */
export function desktopHost() {
  return process.platform === 'win32'
    && typeof process.versions?.electron === 'string'
    && Number.isInteger(process.ppid)
    && process.ppid > 1
}

/**
 * Paths this bundle writes for diagnostics and for the ready gate.
 * @returns {{runtimeDir:string, logFile:string, readyMarker:string, probeLog:string}} - absolute paths.
 */
export function runtimePaths() {
  const runtimeDir = join(tmpdir(), 'dsh-harness-restart')
  return {
    runtimeDir,
    logFile: join(runtimeDir, 'restart.log'),
    readyMarker: join(runtimeDir, 'relauncher-ready.txt'),
    probeLog: join(runtimeDir, 'client-probe.log'),
  }
}

/**
 * Build the restart-step logger.
 * @param {string} logFile - absolute log path.
 * @returns {(line:string) => void} - logger that never throws.
 */
export function createLogger(logFile) {
  return (line) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${new Date().toISOString()} host: ${line}\n`, 'utf8')
    } catch {
      /* diagnostics must never change the outcome */
    }
  }
}

/** Wait between polls. */
function sleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

/** Whether one process id is still in the process table. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM'
  }
}

/** Path of the relaunch assistant beside this module's package root. */
function assistantPath() {
  return fileURLToPath(new URL('../relaunch.mjs', import.meta.url))
}

/**
 * Start the relaunch assistant once and wait until it proved it is running.
 * @param {object} input - `{ detached, log, paths, planDir, planId }`.
 * @returns {Promise<number|null>} - the assistant pid, or null when it never
 *   reported ready.
 */
async function launchAssistant(input) {
  const { detached, log, paths, planDir, planId } = input
  const shell = process.ppid
  let child
  try {
    child = spawn(process.execPath, [
      assistantPath(),
      String(shell),
      String(process.pid),
      process.execPath,
      paths.logFile,
      paths.readyMarker,
      typeof planDir === 'string' ? planDir : '',
      typeof planId === 'string' ? planId : '',
    ], {
      detached,
      stdio: 'ignore',
      windowsHide: true,
      cwd: dirname(process.execPath),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.on('error', (error) => log(`assistant spawn error detached=${String(detached)}: ${error?.code ?? error}`))
    child.unref()
  } catch (error) {
    log(`assistant spawn threw detached=${String(detached)}: ${error?.code ?? error}`)
    return null
  }
  const deadline = Date.now() + ASSISTANT_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.pid === undefined) {
      log('assistant has no process id')
      return null
    }
    if (existsSync(paths.readyMarker)) {
      log(`assistant ready pid=${String(child.pid)} detached=${String(detached)}`)
      return child.pid
    }
    if (!alive(child.pid)) {
      log(`assistant exited before it was ready detached=${String(detached)}`)
      return null
    }
    await sleep(80)
  }
  log(`assistant did not report ready detached=${String(detached)}`)
  /* Leave no half-started assistant behind before the next attempt. */
  try {
    process.kill(child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
  return null
}

/**
 * Start the assistant with a separate process group, then without one.
 * @param {object} input - `{ log, paths, planDir, planId }`.
 * @returns {Promise<number|null>} - the ready assistant pid, or null.
 */
async function startAssistant(input) {
  const { log, paths } = input
  try {
    mkdirSync(paths.runtimeDir, { recursive: true })
    rmSync(paths.readyMarker, { force: true })
  } catch {
    /* a missing stale marker is the normal case */
  }
  for (const detached of [true, false]) {
    const pid = await launchAssistant({ ...input, detached })
    if (pid !== null) return pid
    try {
      rmSync(paths.readyMarker, { force: true })
    } catch {
      /* nothing to clean */
    }
  }
  return null
}

/**
 * Stop the Electron shell and confirm it is gone.
 *
 * This Host stops itself when the shell's IPC channel disconnects, so the loop
 * may never see the end of it; the assistant handles the rest.
 * @param {Function} log - logger.
 * @returns {Promise<boolean>} - whether the shell left the process table.
 */
async function stopShell(log) {
  const shell = process.ppid
  try {
    process.kill(shell, 'SIGKILL')
    log(`shell ${String(shell)} signalled`)
  } catch (error) {
    log(`kill failed: ${error?.code ?? error}`)
    return false
  }
  const deadline = Date.now() + SHELL_EXIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!alive(shell)) {
      log('shell gone')
      return true
    }
    await sleep(60)
  }
  return !alive(shell)
}

/**
 * Flush every live Session, bounded by a budget.
 *
 * A restart is allowed to interrupt a turn, but it must not also discard the
 * events that turn already produced. Only a flush that settled counts; a timed
 * out barrier is logged, because it is the one guarantee this step provides.
 * @param {object} ctx - Host context.
 * @param {number} timeoutMs - overall budget.
 * @param {Function} log - logger.
 * @returns {Promise<number>} - how many Sessions settled their flush.
 */
export async function flushSessions(ctx, timeoutMs, log) {
  const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined
  if (sessions === undefined || typeof sessions.list !== 'function' || typeof sessions.flush !== 'function') {
    log('flush: sessions service unavailable; the restart continues without a durability barrier')
    return 0
  }
  const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 3000)
  let flushed = 0
  let live = []
  try {
    live = sessions.list()
  } catch {
    return 0
  }
  for (const session of live) {
    if (Date.now() >= deadline) break
    const budget = Math.max(200, deadline - Date.now())
    const flush = Promise.resolve(sessions.flush(session))
    /* A losing flush must not surface as an unhandled rejection after the race. */
    flush.catch(() => {})
    const outcome = await Promise.race([
      flush.then(() => 'settled', () => 'failed'),
      sleep(budget).then(() => 'timeout'),
    ])
    if (outcome === 'settled') {
      flushed += 1
    } else if (outcome === 'failed') {
      log(`flush ${String(session?.id ?? '?')} failed`)
    } else {
      log(`flush ${String(session?.id ?? '?')} timed out after ${String(budget)}ms`)
    }
  }
  return flushed
}

/**
 * Normalize the model-facing `tasks` argument.
 * @param {unknown} value - raw argument.
 * @param {number} maxTasks - upper bound.
 * @returns {{ok:true, tasks:object[]}|{ok:false, code:string}} - normalized tasks.
 */
export function normalizeTasks(value, maxTasks = 8) {
  if (value === undefined || value === null) return { ok: true, tasks: [] }
  if (!Array.isArray(value)) return { ok: false, code: 'invalid-argument' }
  if (value.length > maxTasks) return { ok: false, code: 'invalid-argument' }
  const tasks = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') return { ok: false, code: 'invalid-argument' }
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (prompt === '') return { ok: false, code: 'invalid-argument' }
    const target = item.newSession === false ? 'session' : 'new'
    const sessionId = typeof item.sessionId === 'string' && item.sessionId.trim() !== '' ? item.sessionId.trim() : undefined
    if (target === 'session' && sessionId === undefined) return { ok: false, code: 'invalid-argument' }
    let notBefore
    if (typeof item.at === 'string' && item.at.trim() !== '') {
      const parsed = Date.parse(item.at)
      if (!Number.isFinite(parsed)) return { ok: false, code: 'invalid-argument' }
      notBefore = parsed
    }
    tasks.push({
      prompt: prompt.slice(0, 8000),
      ...(typeof item.title === 'string' && item.title.trim() !== '' ? { title: item.title.trim() } : {}),
      target,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(typeof item.cwd === 'string' && item.cwd.trim() !== '' ? { cwd: item.cwd.trim() } : {}),
      ...(typeof item.agentPreset === 'string' && item.agentPreset.trim() !== '' ? { agentPreset: item.agentPreset.trim() } : {}),
      ...(notBefore === undefined ? {} : { notBefore }),
    })
  }
  return { ok: true, tasks }
}

/**
 * Stop the shell after a short delay: verify the plan is still current, verify
 * the assistant is still alive, flush, then kill.
 * @param {object} input - `{ ctx, config, plan, directory, lock, log, assistantPid }`.
 * @returns {ReturnType<typeof setTimeout>} - the timer.
 */
function scheduleShellStop(input) {
  const { ctx, config, plan, directory, lock, log, assistantPid } = input
  let finished = false

  /** Re-read the stored plan and report whether it is still this request. */
  const stillCurrent = () => {
    let current = null
    try {
      current = readPlan(directory)
    } catch {
      current = null
    }
    return current !== null && current.planId === plan.planId && current.state === STATE.restarting
  }

  /** Abandon this restart without touching the shell. */
  const abort = (reason) => {
    if (finished) return
    finished = true
    if (stillCurrent() || reason === 'host-exited') {
      plan.state = STATE.aborted
      try {
        writePlan(directory, plan)
      } catch {
        /* the previous state still blocks a boot execution */
      }
    }
    appendReceipt(directory, { type: 'plan-aborted', planId: plan.planId, reason })
    lock.release()
    log(`restart aborted: ${reason}`)
  }

  const timer = setTimeout(() => {
    void (async () => {
      /* A canceled, replaced, or already-aborted plan must not kill the shell. */
      if (!stillCurrent()) {
        finished = true
        lock.release()
        log('restart aborted: the plan is no longer current')
        return
      }
      if (!alive(Number(assistantPid))) {
        abort('relaunch-assistant-gone')
        return
      }
      try {
        const flushed = await flushSessions(ctx, config.flushTimeoutMs, log)
        log(`flushed ${String(flushed)} session(s)`)
        const shellStopped = await stopShell(log)
        if (!shellStopped) {
          abort('shell-alive')
          return
        }
        finished = true
        appendReceipt(directory, { type: 'shell-stopped', planId: plan.planId })
        log('shell stopped; the relaunch assistant takes over')
        /* The lock stays: this process dies with the shell, and the successor
         * reclaims it because its owner is gone. */
      } catch (error) {
        abort('kill-failed')
        log(`restart failed: ${String(error?.message ?? error)}`)
      }
    })()
  }, Number.isFinite(config.restartDelayMs) ? config.restartDelayMs : 1500)
  timer.unref?.()

  /* If the Host lives past this timer (plugin unload, disposal before the kill),
   * the plan must not execute on a later ordinary start. */
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => {
        if (finished) return
        try {
          clearTimeout(timer)
        } catch {
          /* already fired */
        }
        abort('host-exited')
      }, 'harness-restart: stop')
    } catch {
      /* an effect cannot be registered in this composition */
    }
  }
  return timer
}

/**
 * Accept one restart request: write the plan, prove a relaunch path, then stop
 * the shell a moment later.
 * @param {object} ctx - Host context.
 * @param {object} input - `{ config, directory, log, origin, reason, mode, continuation, tasks, requestedBy, language, dryRun }`.
 *   `continuation` is the requesting Session's own post-restart instruction; it
 *   is refused with `continuation-without-self` when that Session is not resumed.
 * @returns {Promise<{ok:true, plan:object, dryRun:boolean}|{ok:false, code:string}>} - outcome.
 */
export async function requestRestart(ctx, input) {
  const { config, directory, log = () => {} } = input
  if (!desktopHost()) return { ok: false, code: 'desktop-only' }

  let lock
  try {
    ensureStore(directory)
    lock = acquireLock(directory, { pid: process.pid })
  } catch {
    return { ok: false, code: 'store-failed' }
  }
  if (lock === null) return { ok: false, code: 'plan-busy' }

  let plan
  try {
    const existing = readPlan(directory)
    /* `armed` from another process is an orphan (its owner died before the
     * assistant was ready); a live request holds this lock, so it cannot be
     * racing us here. Only a restart that actually reached the shell stop
     * blocks a new request. */
    if (existing !== null && !isExpired(existing)
      && (existing.state === STATE.restarting || existing.state === STATE.executing)) {
      lock.release()
      return { ok: false, code: 'plan-busy' }
    }
    const requestedBy = input.requestedBy !== null && typeof input.requestedBy === 'object' ? input.requestedBy : {}
    const selfSessionId = typeof requestedBy.sessionId === 'string' ? requestedBy.sessionId : undefined
    let resumeEntries
    if (Array.isArray(input.resumeEntries)) {
      resumeEntries = input.resumeEntries
    } else {
      const candidates = collectCandidates(ctx, { log })
      resumeEntries = selectResumeEntries({
        candidates,
        mode: input.mode,
        selfSessionId,
        cap: config.maxResumeSessions,
      })
    }
    /* An archived Session would refuse the continuation later; do not promise it. */
    const workspace = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    const archived = Array.isArray(workspace?.archivedSessionIds) ? new Set(workspace.archivedSessionIds) : null
    if (archived !== null) resumeEntries = resumeEntries.filter((entry) => !archived.has(entry.sessionId))
    /* The caller's own instruction for its next turn: attached to that
     * Session's entry and to nothing else, because every other resumed Session
     * must keep the standard instruction rather than be told to do this
     * Session's work. A hint whose Session is not resumed cannot be delivered,
     * and refusing it here is the only moment the caller can still react. */
    if (!attachContinuationHint(resumeEntries, {
      continuation: input.continuation,
      selfSessionId,
    })) {
      log(`continuation refused: the requesting Session ${String(selfSessionId ?? '(unknown)')} is not resumed`)
      lock.release()
      return { ok: false, code: 'continuation-without-self' }
    }
    plan = createPlan({
      planId: input.planId,
      origin: input.origin,
      reason: input.reason,
      language: input.language,
      requestedBy,
      resume: resumeEntries,
      tasks: Array.isArray(input.tasks) ? input.tasks : [],
      policy: {
        resume: typeof input.mode === 'string' ? input.mode : 'explicit',
        maxResumeSessions: config.maxResumeSessions,
        staggerMs: config.staggerMs,
      },
      ttlMinutes: config.planTtlMinutes,
    })
    /* A task that does not name a location runs where the requesting Session
     * runs, not in the Host's default directory. */
    if (requestedBy.cwd !== undefined || requestedBy.agentPreset !== undefined) {
      for (const task of plan.tasks) {
        if (task.target !== 'new') continue
        if (task.cwd === undefined && requestedBy.cwd !== undefined) task.cwd = requestedBy.cwd
        if (task.agentPreset === undefined && requestedBy.agentPreset !== undefined) {
          task.agentPreset = requestedBy.agentPreset
        }
      }
    }
    /* Join the project the directory belongs to, so the new Session appears in
     * the workspace the user already has, not in an unfiled list. */
    const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (registry !== undefined && typeof registry.resolveByPath === 'function') {
      for (const task of plan.tasks) {
        if (task.target !== 'new' || task.workspaceId !== undefined || typeof task.cwd !== 'string') continue
        try {
          const workspace = await registry.resolveByPath(task.cwd)
          if (workspace !== undefined && typeof workspace.id === 'string') task.workspaceId = workspace.id
        } catch {
          /* grouping is best effort; the task still runs */
        }
      }
    }
  } catch {
    lock.release()
    return { ok: false, code: 'store-failed' }
  }

  if (input.dryRun === true) {
    lock.release()
    return { ok: true, plan, dryRun: true }
  }

  try {
    writePlan(directory, plan)
  } catch {
    lock.release()
    return { ok: false, code: 'store-failed' }
  }

  const paths = runtimePaths()
  const assistantPid = await startAssistant({
    log,
    paths,
    planDir: directory,
    planId: plan.planId,
  })
  if (assistantPid === null) {
    clearPlan(directory)
    appendReceipt(directory, { type: 'plan-failed', planId: plan.planId, error: 'relaunch-unavailable' })
    lock.release()
    return { ok: false, code: 'relaunch-unavailable' }
  }

  plan.state = STATE.restarting
  try {
    writePlan(directory, plan)
  } catch {
    /* Without a `restarting` plan the successor would refuse to continue the
     * Sessions this kill interrupts, so the restart is abandoned instead. */
    clearPlan(directory)
    appendReceipt(directory, { type: 'plan-failed', planId: plan.planId, error: 'store-failed' })
    lock.release()
    return { ok: false, code: 'store-failed' }
  }
  appendReceipt(directory, {
    type: 'plan',
    planId: plan.planId,
    origin: plan.origin,
    resume: plan.resume.length,
    subagents: plan.resume.filter((entry) => entry.kind === 'subagent').length,
    tasks: plan.tasks.length,
    reason: plan.reason,
  })
  scheduleShellStop({ ctx, config, plan, directory, lock, log, assistantPid })
  return { ok: true, plan, dryRun: false }
}
