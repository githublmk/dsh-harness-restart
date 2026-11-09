/**
 * Durable restart plan store.
 *
 * A plan is written before the Electronshell is stopped and read again by the
 * next Host process, so the store must survive an abrupt kill: writes go
 * through tmp+fsync+rename, reads tolerate a torn or corrupt file, and the one
 * in-flight restart is guarded by an exclusive lock file whose dead owner can
 * be reclaimed by the successor process.
 *
 * @module dsh-harness-restart/lib/plan
 */
import {
  appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

/** Stored plan format. A file with another version is treated as corrupt. */
export const PLAN_VERSION = 1

/** Plan lifecycle states. */
export const STATE = Object.freeze({
  /** Written, relaunch assistant not yet ready. */
  armed: 'armed',
  /** Relaunch assistant is ready; the shell is about to be stopped. */
  restarting: 'restarting',
  /** The next Host process is delivering entries. */
  executing: 'executing',
  /** Every entry reached a terminal state. */
  done: 'done',
  /** Delivery failed systemically; the plan did not finish. */
  failed: 'failed',
  /** Past its TTL; never executed. */
  expired: 'expired',
  /** The shell could not be stopped; the plan must not run later. */
  aborted: 'aborted',
})

const ACTIVE_STATES = new Set([STATE.armed, STATE.restarting, STATE.executing])

/** Entry states a plan may still deliver. */
export const ENTRY_PENDING = 'pending'

/** Entry states that need no further work. */
const ENTRY_TERMINAL = new Set(['delivered', 'skipped', 'failed'])

/**
 * Resolve the plan store directory.
 * @param {string|null|undefined} configured - explicit `storeDir`.
 * @returns {string} - absolute directory.
 */
export function storeDirectory(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'harness-restart')
}

/**
 * File names inside one store directory.
 * @param {string} directory - store directory.
 * @returns {{plan:string, history:string, lock:string}} - absolute paths.
 */
export function planPaths(directory) {
  return {
    plan: join(directory, 'plan.json'),
    history: join(directory, 'history.jsonl'),
    lock: join(directory, 'restart.lock'),
  }
}

/** Create the store directory when it does not exist. */
export function ensureStore(directory) {
  mkdirSync(directory, { recursive: true })
}

/** Pad one number. */
function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/** Local wall-clock stamp used inside plan ids. */
function localStamp(milliseconds) {
  const date = new Date(milliseconds)
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Mint a plan id that sorts by request time and stays readable in logs.
 * @param {number} [now] - epoch milliseconds.
 * @returns {string} - for example `rst-20261109-142233-a1b2`.
 */
export function newPlanId(now = Date.now()) {
  return `rst-${localStamp(now)}-${Math.random().toString(36).slice(2, 6)}`
}

/** Localized time for receipts and model-facing text. */
export function formatTime(milliseconds, language = 'zh') {
  try {
    return new Date(milliseconds).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', { hour12: false })
  } catch {
    return new Date(milliseconds).toISOString()
  }
}

/**
 * Build one plan from an accepted restart request.
 * @param {object} input - request parts (see index.js / lib/tools.js).
 * @returns {object} - the plan, with every entry `pending`.
 */
export function createPlan(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const ttlMinutes = Number.isFinite(input.ttlMinutes) && input.ttlMinutes > 0 ? input.ttlMinutes : 60
  const requestedBy = input.requestedBy !== null && typeof input.requestedBy === 'object' ? input.requestedBy : {}
  const policy = input.policy !== null && typeof input.policy === 'object' ? input.policy : {}
  return {
    version: PLAN_VERSION,
    planId: typeof input.planId === 'string' && input.planId !== '' ? input.planId : newPlanId(now),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttlMinutes * 60_000,
    origin: input.origin === 'tool' ? 'tool' : 'button',
    reason: typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '',
    language: input.language === 'en' ? 'en' : 'zh',
    requestedBy: {
      ...(typeof requestedBy.sessionId === 'string' ? { sessionId: requestedBy.sessionId } : {}),
      ...(typeof requestedBy.cwd === 'string' ? { cwd: requestedBy.cwd } : {}),
      ...(typeof requestedBy.agentPreset === 'string' ? { agentPreset: requestedBy.agentPreset } : {}),
    },
    resume: (Array.isArray(input.resume) ? input.resume : []).map((entry) => ({
      sessionId: String(entry.sessionId),
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
      ...(typeof entry.agentPreset === 'string' ? { agentPreset: entry.agentPreset } : {}),
      ...(Number.isFinite(entry.openTurnStartSeq) ? { openTurnStartSeq: entry.openTurnStartSeq } : {}),
      ...(Number.isFinite(entry.lastTurn) ? { lastTurn: entry.lastTurn } : {}),
      ...(typeof entry.continuationHint === 'string' && entry.continuationHint.trim() !== ''
        ? { continuationHint: entry.continuationHint.trim().slice(0, 2000) }
        : {}),
      state: ENTRY_PENDING,
    })),
    tasks: (Array.isArray(input.tasks) ? input.tasks : []).map((task, index) => ({
      id: `task-${index + 1}`,
      prompt: String(task.prompt),
      ...(typeof task.title === 'string' && task.title.trim() !== '' ? { title: task.title.trim().slice(0, 120) } : {}),
      target: task.target === 'session' ? 'session' : 'new',
      ...(typeof task.sessionId === 'string' && task.sessionId !== '' ? { sessionId: task.sessionId } : {}),
      ...(typeof task.workspaceId === 'string' && task.workspaceId !== '' ? { workspaceId: task.workspaceId } : {}),
      ...(typeof task.cwd === 'string' ? { cwd: task.cwd } : {}),
      ...(typeof task.agentPreset === 'string' ? { agentPreset: task.agentPreset } : {}),
      ...(Number.isFinite(task.notBefore) ? { notBefore: task.notBefore } : {}),
      state: ENTRY_PENDING,
    })),
    policy: {
      resume: typeof policy.resume === 'string' ? policy.resume : 'interrupted',
      maxResumeSessions: Number.isFinite(policy.maxResumeSessions) ? policy.maxResumeSessions : 8,
      staggerMs: Number.isFinite(policy.staggerMs) ? policy.staggerMs : 800,
    },
    state: STATE.armed,
  }
}

/**
 * Read the stored plan.
 * @param {string} directory - store directory.
 * @returns {object|null} - the plan, or null when absent or unreadable.
 */
export function readPlan(directory) {
  const file = planPaths(directory).plan
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return null
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== PLAN_VERSION || typeof parsed.planId !== 'string') {
    /* Keep the unreadable file for diagnosis instead of silently overwriting it. */
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* a rename failure leaves the file in place; callers treat it as absent */
    }
    return null
  }
  return parsed
}

/**
 * Write the plan atomically.
 * @param {string} directory - store directory.
 * @param {object} plan - plan to persist.
 * @returns {object} - the same plan, with `updatedAt` refreshed.
 */
export function writePlan(directory, plan) {
  ensureStore(directory)
  plan.updatedAt = Date.now()
  const file = planPaths(directory).plan
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(temporary, 'w')
  try {
    writeSync(handle, JSON.stringify(plan, null, 2))
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, file)
  return plan
}

/**
 * Read-modify-write one stored plan.
 * @param {string} directory - store directory.
 * @param {(plan: object) => object|void} mutate - in-place change.
 * @returns {object|null} - the written plan, or null when none is stored.
 */
export function updatePlan(directory, mutate) {
  const plan = readPlan(directory)
  if (plan === null) return null
  const next = mutate(plan) ?? plan
  return writePlan(directory, next)
}

/** Remove the stored plan. */
export function clearPlan(directory) {
  try {
    rmSync(planPaths(directory).plan, { force: true })
  } catch {
    /* removing a missing plan is the normal case */
  }
}

/** Whether the plan may still be executed by a boot restore. */
export function isActive(plan) {
  return plan !== null && typeof plan === 'object' && ACTIVE_STATES.has(plan.state)
}

/**
 * Whether a boot restore may deliver this plan.
 *
 * `armed` is deliberately excluded: it is the state written before the relaunch
 * assistant proved it is running. A Host that died in that window leaves an
 * `armed` plan behind, and an ordinary later start must not execute it.
 */
export function isExecutable(plan) {
  return plan !== null && typeof plan === 'object'
    && (plan.state === STATE.restarting || plan.state === STATE.executing)
}

/** Whether the plan is past its TTL. */
export function isExpired(plan, now = Date.now()) {
  return plan === null || typeof plan !== 'object' || !Number.isFinite(plan.expiresAt) || now > plan.expiresAt
}

/** Count one plan's entries by state. */
export function entryCounts(plan) {
  const resume = Array.isArray(plan?.resume) ? plan.resume : []
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : []
  const count = (entries) => ({
    total: entries.length,
    pending: entries.filter((entry) => entry.state === ENTRY_PENDING).length,
    terminal: entries.filter((entry) => ENTRY_TERMINAL.has(entry.state)).length,
  })
  return { resume: count(resume), tasks: count(tasks) }
}

/** A stable dedupe identity for one entry of one plan. */
export function requestIdFor(planId, key) {
  return `restart-${planId}-${key}`.replace(/[^a-zA-Z0-9._:-]/gu, '-').slice(0, 120)
}

/** One-line plan summary for tools and receipts. */
export function summarizePlan(plan, language = 'zh') {
  if (plan === null || typeof plan !== 'object') return null
  const counts = entryCounts(plan)
  const created = formatTime(plan.createdAt, language)
  const detail = language === 'en'
    ? `${counts.resume.terminal}/${counts.resume.total} sessions, ${counts.tasks.terminal}/${counts.tasks.total} tasks`
    : `恢复 ${counts.resume.terminal}/${counts.resume.total}，任务 ${counts.tasks.terminal}/${counts.tasks.total}`
  return language === 'en'
    ? `${plan.planId} · ${plan.state} · ${detail} · created ${created}`
    : `${plan.planId} · 状态 ${plan.state} · ${detail} · 创建于 ${created}`
}

/** Whether one process id is still in the process table. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM'
  }
}

/** Whether a stored lock record may be reclaimed. */
function isReclaimable(record, now, staleMs) {
  if (record === null || typeof record !== 'object') return true
  if (!Number.isInteger(record.pid)) return true
  if (!Number.isFinite(record.at) || now - record.at > staleMs) return true
  return !alive(record.pid)
}

/**
 * Remove a lock record that was judged stale, without deleting a lock another
 * process replaced in the meantime.
 *
 * The record is moved aside first and its content compared with the judged
 * record; a mismatch means a racer replaced the lock, so it is moved back and
 * this attempt gives up.
 * @returns whether the stale record was removed.
 */
function discardStaleRecord(file, judged, pid, now) {
  const aside = `${file}.stale-${pid}-${now}`
  try {
    renameSync(file, aside)
  } catch {
    return false
  }
  let moved
  try {
    moved = JSON.parse(readFileSync(aside, 'utf8'))
  } catch {
    moved = null
  }
  if (moved === null || typeof moved !== 'object' || moved.pid !== judged.pid || moved.at !== judged.at) {
    try {
      renameSync(aside, file)
    } catch {
      /* another lock exists now; leaving the old record aside is harmless */
    }
    return false
  }
  try {
    rmSync(aside, { force: true })
  } catch {
    /* the file is already gone */
  }
  return true
}

/**
 * Claim the single in-flight restart lock.
 *
 * The successor Host reclaims the lock because the owning Host died with the
 * shell. A live owner keeps it, so a button click and a tool call cannot both
 * stop the shell. Reclaiming never deletes a lock it did not judge stale.
 * @param {string} directory - store directory.
 * @param {object} [options] - `pid`, `now`, `staleMs`.
 * @returns {{pid:number, release:() => void}|null} - the claim, or null.
 */
export function acquireLock(directory, options = {}) {
  ensureStore(directory)
  const file = planPaths(directory).lock
  const pid = Number.isInteger(options.pid) ? options.pid : process.pid
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 5 * 60_000
  const record = JSON.stringify({ pid, at: now, host: hostname() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(file, 'wx')
      try {
        writeSync(handle, record)
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      return {
        pid,
        release: () => {
          try {
            rmSync(file, { force: true })
          } catch {
            /* already gone */
          }
        },
      }
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'EEXIST') return null
      if (attempt !== 0) return null
      let judged
      try {
        judged = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        judged = null
      }
      if (!isReclaimable(judged, now, staleMs)) return null
      if (!discardStaleRecord(file, judged, pid, now)) return null
    }
  }
  return null
}

/** Receipt history is trimmed once it grows past this size. */
const HISTORY_LIMIT_BYTES = 512 * 1024
/** Receipts kept by one trim. */
const HISTORY_KEEP_LINES = 400

/** Rewrite the receipt history with its newest lines only. */
function trimHistory(file) {
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '')
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(temporary, `${lines.slice(-HISTORY_KEEP_LINES).join('\n')}\n`, 'utf8')
    renameSync(temporary, file)
  } catch {
    /* trimming is best effort; the next append still works */
  }
}

/**
 * Append one diagnostic receipt. Receipts must never change an outcome.
 * @param {string} directory - store directory.
 * @param {object} receipt - JSON object; `at` is filled in.
 */
export function appendReceipt(directory, receipt) {
  try {
    ensureStore(directory)
    const file = planPaths(directory).history
    try {
      if (statSync(file).size > HISTORY_LIMIT_BYTES) trimHistory(file)
    } catch {
      /* the history does not exist yet */
    }
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...receipt })}\n`, 'utf8')
  } catch {
    /* receipts are diagnostics */
  }
}

/**
 * Read recent receipts, oldest first.
 * @param {string} directory - store directory.
 * @param {number} [limit] - maximum number of trailing receipts.
 * @returns {object[]} - parsed receipts; unreadable lines are skipped.
 */
export function readReceipts(directory, limit = 200) {
  let text
  try {
    text = readFileSync(planPaths(directory).history, 'utf8')
  } catch {
    return []
  }
  const parsed = []
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    try {
      const receipt = JSON.parse(line)
      if (receipt !== null && typeof receipt === 'object') parsed.push(receipt)
    } catch {
      /* a torn line from a killed process is expected */
    }
  }
  return parsed.slice(-Math.max(1, limit))
}

/**
 * Summarize the most recent finished restart for the page notice.
 * @param {string} directory - store directory.
 * @param {object} [options] - `now`, `withinMs`.
 * @returns {{planId:string, at:number, finishedAt:number, ok:boolean, resumed:number, tasks:number}|null} - summary.
 */
export function recentPlanSummary(directory, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const withinMs = Number.isFinite(options.withinMs) ? options.withinMs : 24 * 60 * 60_000
  const receipts = readReceipts(directory, 400)
  const finished = new Map()
  for (const receipt of receipts) {
    if (receipt.type === 'plan-done' || receipt.type === 'plan-failed') finished.set(receipt.planId, receipt)
  }
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const start = receipts[index]
    if (start.type !== 'plan' || typeof start.planId !== 'string') continue
    const end = finished.get(start.planId)
    if (end === undefined || now - end.at > withinMs) return null
    return {
      planId: start.planId,
      at: start.at,
      finishedAt: end.at,
      ok: end.type === 'plan-done',
      resumed: Number.isFinite(end.resumed) ? end.resumed : 0,
      tasks: Number.isFinite(end.tasks) ? end.tasks : 0,
    }
  }
  return null
}
