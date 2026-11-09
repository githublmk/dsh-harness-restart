/**
 * Process-level guard for the relaunch assistant.
 *
 * A silent exit here is the worst possible failure: the shell is already
 * stopped, so nothing else can start the application. The script must therefore
 * stay alive across its wait loop — it did not, once, because an unref'd timer
 * emptied the event loop while both pids were still alive.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../relaunch.mjs', import.meta.url))

test('the relaunch assistant keeps running while it waits for the two pids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-restart-relaunch-'))
  const logFile = join(directory, 'restart.log')
  const marker = join(directory, 'ready.txt')
  const appExe = join(directory, 'not-an-application.exe')
  let child
  try {
    /* Both pids are alive, so the wait loop must sleep. With an unref'd timer
     * the script exits immediately and silently; with a real one it is still
     * running when the assertion below looks at it. */
    child = spawn(process.execPath, [
      script,
      String(process.pid),
      String(process.ppid),
      appExe,
      logFile,
      marker,
      '',
      '',
    ], { stdio: 'ignore', windowsHide: true })

    await new Promise((resolve) => setTimeout(resolve, 1200))

    assert.equal(child.exitCode, null, 'the assistant exited during its wait loop')
    const text = await readFile(logFile, 'utf8')
    assert.match(text, /started pid=/u, 'the assistant did not even start')
    assert.match(text, /ready marker written/u, 'the ready gate was not written')
    assert.doesNotMatch(text, /exited code=/u, 'the assistant reached its exit handler too early')
  } finally {
    child?.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(directory, { recursive: true, force: true })
  }
})
