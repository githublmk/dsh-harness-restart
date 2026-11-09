/**
 * Relaunch assistant for the harness-restart bundle.
 *
 * It is started (detached, with no pipes) by the Host *before* the Electron
 * shell is stopped, because the Host itself shuts down as soon as its IPC
 * channel to the shell disconnects. This process waits until both the shell and
 * that Host are gone, then starts the application again with a clean
 * environment.
 *
 * A freshly started instance can still exit on its own while Chromium's
 * single-instance state of the process that was just killed settles; each
 * attempt therefore watches the process for a while, and a short attempt is
 * repeated instead of being trusted. Its stderr is kept next to the log, so a
 * silent exit can be explained.
 *
 * Arguments: `<shell pid> <host pid> <application exe> <log file> <ready marker>
 * [<plan dir> <plan id>]`. Empty plan arguments disable plan receipts. A pid
 * that is not a positive integer is treated as unknown: the wait is skipped and
 * the application is still launched.
 *
 * @module dsh-harness-restart/relaunch
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { countApplicationProcesses, launchDecision, parseAssistantArgs } from './lib/relaunch-core.js'

const { shell, host, appExe, logFile, marker, planDir, planId } = parseAssistantArgs(process.argv.slice(2))
/** Where the fallback launch logs go; the Host always supplies a log file. */
const logDir = logFile === '' ? tmpdir() : dirname(logFile)
/** Upper bound on waiting for the two processes to disappear. */
const EXIT_TIMEOUT_MS = 20000
/** Pause after both processes are gone, so ports and process state settle. */
const SETTLE_MS = 2500
/** How long one started application must stay alive to count as launched. */
const LAUNCH_PROBE_MS = 5000
/** Attempts to start the application, and the pause between them. */
const ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

/* The log directory may not exist yet on a fresh machine. */
try {
  if (logFile !== '') mkdirSync(dirname(logFile), { recursive: true })
} catch {
  /* a lost log is not a lost restart */
}

/** Append one line to the restart log; never touches stdio. */
function log(line) {
  if (logFile === '') return
  try {
    appendFileSync(logFile, `${new Date().toISOString()} relauncher: ${line}\n`, 'utf8')
  } catch {
    /* Diagnostics must never change the outcome. */
  }
}

/**
 * Record one relaunch milestone in the plan store, when this restart has one.
 * The Host that wrote the plan can never report a later failure itself.
 * @param {string} type - receipt type.
 * @param {object} [extra] - additional receipt fields.
 */
function receipt(type, extra = {}) {
  if (planDir === '' || planId === '') return
  try {
    mkdirSync(planDir, { recursive: true })
    appendFileSync(join(planDir, 'history.jsonl'), `${JSON.stringify({ at: Date.now(), type, planId, ...extra })}\n`, 'utf8')
  } catch {
    /* diagnostics must never change the outcome */
  }
}

/** Whether one process id is still in the process table. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

/** Wait between polls. */
function sleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

log(`started pid=${String(process.pid)} shell=${shell === null ? 'unknown' : String(shell)} host=${host === null ? 'unknown' : String(host)}`)
if (shell === null || host === null) {
  log('invalid pid arguments; the process wait is skipped')
}

/* Prove to the Host that this process is really running, so it only stops the
 * shell after a relaunch path exists. */
try {
  if (marker !== '') {
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, String(process.pid), 'utf8')
    log('ready marker written')
  }
} catch (error) {
  log(`ready marker failed: ${error?.code ?? error}`)
}

if (shell !== null && host !== null) {
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!alive(shell) && !alive(host)) break
    await sleep(100)
  }
}

if (shell !== null && alive(shell)) {
  log('shell is still running; not starting a second instance')
  receipt('relaunch-abandoned', { reason: 'shell-alive' })
  process.exit(0)
}

const hostAlive = host !== null && alive(host)
log(hostAlive ? 'shell is gone; the old host is still leaving' : 'shell and host are gone')
if (!hostAlive) receipt('shell-stopped')

await sleep(SETTLE_MS)

const environment = { ...process.env }
for (const name of ['ELECTRON_RUN_AS_NODE', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) delete environment[name]

/** Last few stderr lines of one attempt, for the log. */
function stderrTail(path) {
  try {
    const text = readFileSync(path, 'utf8').trim()
    if (text === '') return '(empty)'
    const lines = text.split(/\r?\n/u)
    return lines.slice(-3).join(' | ')
  } catch {
    return '(no stderr)'
  }
}

/**
 * How many processes of the application exist right now.
 *
 * The process table is the only signal a shell launch gives us: `explorer.exe`
 * hands the request to the desktop shell and returns immediately, so there is
 * no child handle to watch.
 * @returns the process count, or -1 when it cannot be read.
 */
function applicationProcesses() {
  /* The image name comes from the executable that is running this bundle, so a
   * moved or renamed installation keeps working. */
  const image = basename(appExe)
  try {
    const text = execFileSync('tasklist.exe', [
      '/FI', `IMAGENAME eq ${image}`,
      '/FO', 'CSV',
      '/NH',
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    return countApplicationProcesses(text, image)
  } catch (error) {
    /* tasklist can exit non-zero while still printing the table. */
    if (typeof error?.stdout === 'string') return countApplicationProcesses(error.stdout, image)
    return -1
  }
}

/**
 * Start the application the way a double click does: through the desktop shell.
 *
 * This gives it explorer's environment and parentage instead of this process's,
 * which is the one difference between a launch that works and one that exits.
 * @returns whether an application process was observed and stayed alive.
 */
async function launchThroughShell() {
  const before = applicationProcesses()
  log(`shell launch: application processes before=${String(before)}`)
  try {
    const child = spawn('explorer.exe', [appExe], { stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => log(`explorer spawn error: ${error?.code ?? error}`))
    child.unref()
  } catch (error) {
    log(`shell launch threw: ${error?.code ?? error}`)
    return false
  }
  for (let waited = 0; waited < 24000; waited += 1500) {
    await sleep(1500)
    const after = applicationProcesses()
    const decision = launchDecision({ before, after })
    if (decision === 'unknown') {
      /* Reading the table failed (an antivirus, a locked-down shell). Starting
       * another instance would be worse than trusting the launch. */
      log('shell launch: the process table is unreadable; assuming the application started')
      return true
    }
    if (decision === 'launched') {
      /* One sighting is not enough: an instance that quits right away also
       * shows up for a moment. */
      await sleep(4000)
      const again = applicationProcesses()
      if (again < 0) {
        log(`launched through shell (the process table became unreadable); waited ${String(waited + 5500)}ms`)
        return true
      }
      if (again >= after) {
        log(`launched through shell; application processes=${String(again)} after ${String(waited + 5500)}ms`)
        return true
      }
      log(`shell launch exited again; processes=${String(again)}`)
      return false
    }
  }
  log('shell launch produced no application process')
  return false
}

let launched = await launchThroughShell()

for (let attempt = 1; attempt <= ATTEMPTS && !launched; attempt += 1) {
  /* A plain child first: DETACHED_PROCESS makes some executables exit at once,
   * so a separate process group is only the last resort. */
  const detached = attempt === ATTEMPTS
  const outPath = join(logDir, `launch-${String(attempt)}.out.log`)
  const errPath = join(logDir, `launch-${String(attempt)}.err.log`)
  let out = -1
  let err = -1
  let child
  try {
    out = openSync(outPath, 'w')
    err = openSync(errPath, 'w')
    child = spawn(appExe, [], {
      detached,
      stdio: ['ignore', out, err],
      windowsHide: true,
      cwd: dirname(appExe),
      env: environment,
    })
    child.on('error', (error) => log(`launch error attempt=${String(attempt)}: ${error?.code ?? error}`))
    child.unref()
  } catch (error) {
    log(`launch threw attempt=${String(attempt)}: ${error?.code ?? error}`)
    continue
  } finally {
    if (out >= 0) closeSync(out)
    if (err >= 0) closeSync(err)
  }
  const until = Date.now() + LAUNCH_PROBE_MS
  while (Date.now() < until) {
    if (child.exitCode !== null) break
    await sleep(150)
  }
  if (child.exitCode === null) {
    log(`launched pid=${String(child.pid)} attempt=${String(attempt)} detached=${String(detached)}`)
    launched = true
    break
  }
  log(`attempt ${String(attempt)} exited pid=${String(child.pid)} code=${String(child.exitCode)} detached=${String(detached)} stderr: ${stderrTail(errPath)}`)
  if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS)
}

log(launched ? 'done' : 'gave up')
receipt(launched ? 'relaunch-ok' : 'relaunch-failed', launched ? {} : { reason: 'launch-failed' })
process.exit(launched ? 0 : 1)
