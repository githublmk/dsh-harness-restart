/**
 * Host half of the harness-restart bundle.
 *
 * The Desktop application runs this Host as a child process of the Electron
 * shell, so the Host cannot call `app.relaunch()` and the packaged Application
 * menu has no restart item. This module therefore answers one authenticated
 * same-origin request from the Client half and restarts the application.
 *
 * The Host cannot relaunch after stopping the shell either: `dsh-desktop-host`
 * calls its own shutdown on `process.disconnect`, so the moment the shell dies
 * this process starts stopping. The restart is therefore carried out by
 * `relaunch.mjs`, a detached assistant started *before* the shell is stopped: it
 * waits until the shell and this Host are gone and then starts the application
 * with a clean environment.
 *
 * Every step is verified before the next one runs, so a failed restart leaves
 * the running application untouched instead of killing half of it: the shell is
 * only stopped after the assistant proved it is running, and a kill that does
 * not take effect is reported back to the page.
 *
 * @module dsh-harness-restart
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** Version the Client half requires before it offers the action. */
const VERSION = '0.3.0'
/** Same-origin route the Client half talks to; no other path is claimed. */
const ROUTE_PATH = '/dsh-harness-restart/restart'
/** Request header only this page's fetch sets; a cross-site form cannot send it. */
const ACTION_HEADER = 'x-dsh-restart-action'
/** Exact header value; absent or different is rejected before anything happens. */
const ACTION_VALUE = 'restart'
/** How long the assistant has to prove it is running before anything is stopped. */
const ASSISTANT_READY_TIMEOUT_MS = 4000
/** Upper bound on waiting for the stopped shell to leave the process table. */
const SHELL_EXIT_TIMEOUT_MS = 3000
/** Delay before this Host leaves when the shell's disconnect does not end it. */
const SELF_EXIT_DELAY_MS = 1500
/** Whether one restart request is already being carried out. */
let pending = false

/** Working directory for the assistant, its log, and its ready marker. */
const RUNTIME_DIR = join(tmpdir(), 'dsh-harness-restart')
/** Step log written by this half and by the assistant. */
const LOG_FILE = join(RUNTIME_DIR, 'restart.log')
/** File the assistant writes first; its absence means no relaunch path exists. */
const READY_MARKER = join(RUNTIME_DIR, 'relauncher-ready.txt')

/**
 * Detect the Desktop Host: the shell starts this process with the Electron
 * binary in Node mode, so it reports an Electron version and has the Electron
 * main process as its parent. A plain `dsh` process on Node fails both checks.
 */
function desktopHost() {
  return process.platform === 'win32'
    && typeof process.versions?.electron === 'string'
    && Number.isInteger(process.ppid)
    && process.ppid > 1
}

/** Append one line to the restart log. */
function log(line) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} host: ${line}\n`, 'utf8')
  } catch {
    /* Diagnostics must never change the outcome. */
  }
}

/** Wait between polls. */
function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/** Whether one process id is still in the process table. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

/** Path of the assistant script beside this module. */
function assistantPath() {
  return fileURLToPath(new URL('./relaunch.mjs', import.meta.url))
}

/**
 * Start the relaunch assistant once and wait until it proved it is running.
 * @param detached - whether to give the assistant its own process group.
 * @returns whether the assistant reported ready.
 */
async function launchAssistant(detached) {
  const shell = process.ppid
  let child
  try {
    child = spawn(process.execPath, [
      assistantPath(),
      String(shell),
      String(process.pid),
      process.execPath,
      LOG_FILE,
      READY_MARKER,
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
    return false
  }
  const deadline = Date.now() + ASSISTANT_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.pid === undefined) {
      log('assistant has no process id')
      return false
    }
    if (existsSync(READY_MARKER)) {
      log(`assistant ready pid=${String(child.pid)} detached=${String(detached)}`)
      return true
    }
    if (!alive(child.pid)) {
      log(`assistant exited before it was ready detached=${String(detached)}`)
      return false
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
  return false
}

/**
 * Start the relaunch assistant and wait until it proved it is running.
 *
 * A separate process group keeps it clear of the shell's own process group, and
 * a plain child is the fallback for the (rare) case where that form does not
 * start. The shell is only stopped when one of them reported ready.
 * @returns whether a relaunch path exists, so the shell may be stopped.
 */
async function startAssistant() {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true })
    rmSync(READY_MARKER, { force: true })
  } catch {
    /* A missing stale marker is the normal case. */
  }
  for (const detached of [true, false]) {
    if (await launchAssistant(detached)) return true
    try {
      rmSync(READY_MARKER, { force: true })
    } catch {
      /* nothing to clean */
    }
  }
  return false
}

/**
 * Stop the Electron shell and confirm it is gone.
 * @returns whether the shell was observed leaving the process table.
 */
async function stopShell() {
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
    /* This Host stops itself when the shell's IPC channel disconnects, so the
     * loop may never see the end of it; the assistant handles the rest. */
    if (!alive(shell)) {
      log('shell gone')
      return true
    }
    await sleep(60)
  }
  return !alive(shell)
}

/**
 * Restart the application: prepare the relaunch, then stop the shell.
 * @returns the outcome reported to the page.
 */
async function restart() {
  const prepared = await startAssistant()
  if (!prepared) return { ok: false, error: 'relaunch-unavailable' }
  const stopped = await stopShell()
  if (!stopped) return { ok: false, error: 'shell-alive' }
  /* The shell is gone: this Host is already shutting down through its own
   * disconnect handler. Keep a fallback for the case where it does not. */
  setTimeout(() => process.exit(0), SELF_EXIT_DELAY_MS)
  return { ok: true }
}

/**
 * Install the route that carries one restart request from the Client half.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const supported = desktopHost()

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

  const handler = async (req, res) => {
    /* The Client half reads this before offering the action: an outdated Host
     * (for example one loaded before this file changed) must not be used. */
    if (req.method === 'GET') {
      reply(res, 200, { ok: true, version: VERSION, supported, build: 'relaunch-assistant' })
      return
    }
    /* Diagnostic only: the Client half reports which language sources it sees,
     * so a wrong-label report can be answered with data instead of a guess. It
     * changes no state. */
    if (req.method === 'PUT') {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size <= 4096) chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          mkdirSync(RUNTIME_DIR, { recursive: true })
          appendFileSync(join(RUNTIME_DIR, 'client-probe.log'), `${new Date().toISOString()} ${Buffer.concat(chunks).toString('utf8')}\n`, 'utf8')
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
    if (pending) {
      reply(res, 202, { ok: true, status: 'restarting' })
      return
    }
    pending = true
    const outcome = await restart()
    pending = false
    if (outcome.ok) reply(res, 202, { ok: true, status: 'restarting' })
    else reply(res, 500, { ok: false, error: outcome.error })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler,
  }), 'harness-restart: route')
}

export const inject = ['webServer']
