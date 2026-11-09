/**
 * Host half of the harness-restart bundle.
 *
 * The Desktop application runs this Host as a child process of the Electron
 * shell, so the Host cannot call `app.relaunch()` and the packaged Application
 * menu has no restart item. This module therefore:
 *
 * 1. answers one authenticated same-origin request from the Client half and
 *    restarts the application (v0.3.0 path, still the only one that works in a
 *    packaged build);
 * 2. registers the `harness_restart*` tools, so an Agent can request the same
 *    restart and describe what should happen afterwards;
 * 3. runs the boot restore: the plan a previous process wrote is turned into
 *    continuation prompts for the Sessions it interrupted and into the tasks it
 *    queued.
 *
 * The shell is only stopped after `relaunch.mjs` proved it is running, and
 * always after the plan and the tool result reached disk; a failed stop aborts
 * the plan so the next normal start cannot surprise anyone.
 *
 * @module dsh-harness-restart
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  ACTION_HEADER, ACTION_VALUE, PROBE_HEADER, PROBE_VALUE, ROUTE_PATH, VERSION, resolveConfig,
} from './lib/config.js'
import { recentPlanSummary, storeDirectory } from './lib/plan.js'
import { normalizeResumeMode } from './lib/policy.js'
import { scheduleBootRestore } from './lib/resume.js'
import { createLogger, desktopHost, normalizeTasks, requestRestart, runtimePaths } from './lib/restart.js'
import { createTools } from './lib/tools.js'

export const name = 'harness-restart'
export const inject = ['webServer', 'tools']

/**
 * Mount the route, the tools, and the boot restore.
 * @param ctx - Host cordis context.
 * @param config - `{ resume?, requireApproval?, maxResumeSessions?, staggerMs?,
 *   restartDelayMs?, planTtlMinutes?, continuationLanguage?, flushTimeoutMs?,
 *   bootDelayMs?, maxTasks?, storeDir? }`.
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  const directory = storeDirectory(settings.storeDir)
  const paths = runtimePaths()
  const log = createLogger(paths.logFile)
  const supported = desktopHost()

  /** One restart implementation for the page and the tools. */
  const restart = (input) => requestRestart(ctx, { config: settings, directory, log, ...input })

  const reply = (res, status, payload) => {
    const body = JSON.stringify(payload)
    try {
      if (typeof res.writeHead !== 'function' || typeof res.end !== 'function') return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      /* The window that asked may already be gone with the shell. */
    }
  }

  /** Read a bounded JSON request body. */
  const readBody = (req, limit) => new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })

  const handler = async (req, res) => {
    /* The Client half reads this before offering the action: an outdated Host
     * (for example one loaded before this file changed) must not be used. The
     * same document also feeds the post-restart notice. */
    if (req.method === 'GET') {
      let lastPlan = null
      try {
        lastPlan = recentPlanSummary(directory)
      } catch {
        lastPlan = null
      }
      reply(res, 200, {
        ok: true,
        version: VERSION,
        supported,
        capabilities: ['restart', 'resume', 'tasks'],
        /* What the button should preselect, and how many task lines it may send. */
        resumeDefault: settings.resume,
        maxTasks: settings.maxTasks,
        lastPlan,
      })
      return
    }
    /* Diagnostic only: the Client half reports which language sources it sees,
     * so a wrong-label report can be answered with data instead of a guess. It
     * changes no state, and it is header-gated like the restart itself. */
    if (req.method === 'PUT') {
      if (req.headers[PROBE_HEADER] !== PROBE_VALUE) {
        reply(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size <= 4096) chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          mkdirSync(dirname(paths.probeLog), { recursive: true })
          appendFileSync(paths.probeLog, `${new Date().toISOString()} ${Buffer.concat(chunks).toString('utf8')}\n`, 'utf8')
        } catch {
          /* diagnostics only */
        }
        reply(res, 204, {})
      })
      return
    }
    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (req.headers[ACTION_HEADER] !== ACTION_VALUE) {
      reply(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (!supported) {
      reply(res, 409, { ok: false, error: 'desktop-only' })
      return
    }
    const body = await readBody(req, 64 * 1024)
    if (body === null) {
      reply(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    const mode = normalizeResumeMode(body.resume === undefined || body.resume === null ? settings.resume : body.resume)
    if (mode === null) {
      reply(res, 400, { ok: false, error: 'invalid-argument' })
      return
    }
    const tasks = normalizeTasks(body.tasks, settings.maxTasks)
    if (tasks.ok !== true) {
      reply(res, 400, { ok: false, error: tasks.code })
      return
    }
    const forced = settings.continuationLanguage
    const language = forced === 'zh' || forced === 'en'
      ? forced
      : (typeof body.language === 'string' && body.language.toLowerCase().startsWith('en') ? 'en' : 'zh')
    let outcome
    try {
      outcome = await restart({
        origin: 'button',
        mode,
        tasks: tasks.tasks,
        reason: typeof body.reason === 'string' ? body.reason : '',
        language,
      })
    } catch (error) {
      log(`button restart threw: ${String(error?.message ?? error)}`)
      reply(res, 500, { ok: false, error: 'internal' })
      return
    }
    if (outcome.ok === true) {
      reply(res, 202, { ok: true, status: 'restarting', planId: outcome.plan.planId })
      return
    }
    const status = outcome.code === 'desktop-only' || outcome.code === 'plan-busy' ? 409 : 500
    reply(res, status, { ok: false, error: outcome.code })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler,
  }), 'harness-restart: route')

  ctx.effect(() => {
    /* A rejected tool definition must not take the restart route down with it:
     * the button stays useful even when an Agent tool cannot be registered. */
    const disposers = []
    try {
      for (const tool of createTools({ ctx, config: settings, directory, log })) {
        disposers.push(ctx.tools.register(tool))
      }
    } catch (error) {
      log(`tool registration failed: ${String(error?.message ?? error)}`)
      /* Do not leave a partial tool set behind. */
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* the registry already dropped it */
        }
      }
      disposers.length = 0
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'harness-restart: tools')

  try {
    scheduleBootRestore(ctx, settings, { directory, log })
  } catch (error) {
    log(`boot restore could not be armed: ${String(error?.message ?? error)}`)
  }
}
