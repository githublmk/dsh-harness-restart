/**
 * Restart request surface that does not need a running Desktop shell:
 * task normalization and the environment guards.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { desktopHost, normalizeTasks, requestRestart } from '../lib/restart.js'

test('normalizeTasks accepts a complete task and drops unknown fields', () => {
  const result = normalizeTasks([
    {
      prompt: '  run the tests  ',
      title: ' tests ',
      newSession: true,
      cwd: ' C:\\work ',
      agentPreset: ' standard ',
      at: '2030-01-01T00:00:00Z',
      ignored: 'x',
    },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.tasks.length, 1)
  const task = result.tasks[0]
  assert.equal(task.prompt, 'run the tests')
  assert.equal(task.title, 'tests')
  assert.equal(task.target, 'new')
  assert.equal(task.cwd, 'C:\\work')
  assert.equal(task.agentPreset, 'standard')
  assert.equal(task.notBefore, Date.parse('2030-01-01T00:00:00Z'))
  assert.equal('ignored' in task, false)
})

test('normalizeTasks targets an existing Session when asked for one', () => {
  const result = normalizeTasks([{ prompt: 'continue here', newSession: false, sessionId: ' session-x ' }])
  assert.equal(result.ok, true)
  assert.equal(result.tasks[0].target, 'session')
  assert.equal(result.tasks[0].sessionId, 'session-x')
})

test('normalizeTasks rejects what cannot be executed', () => {
  assert.deepEqual(normalizeTasks(undefined), { ok: true, tasks: [] })
  assert.equal(normalizeTasks('not-a-list').ok, false)
  assert.equal(normalizeTasks([{ prompt: '   ' }]).ok, false)
  assert.equal(normalizeTasks([{ prompt: 'x' }], 0).ok, false)
  assert.equal(normalizeTasks([{ prompt: 'x' }, { prompt: 'y' }], 1).ok, false)
  assert.equal(normalizeTasks([{ prompt: 'x', newSession: false }]).ok, false)
  assert.equal(normalizeTasks([{ prompt: 'x', at: 'not a date' }]).ok, false)
  assert.equal(normalizeTasks([null]).ok, false)
})

test('normalizeTasks clips an over-long prompt instead of rejecting it', () => {
  const prompt = 'x'.repeat(9000)
  const result = normalizeTasks([{ prompt }])
  assert.equal(result.ok, true)
  assert.equal(result.tasks[0].prompt.length, 8000)
})

test('requestRestart refuses outside the Desktop Host before touching the store', async () => {
  /* The test runner is a plain Node process: no Electron version, no shell. */
  assert.equal(desktopHost(), false)
  const outcome = await requestRestart({}, { config: {}, directory: 'C:\\never-used' })
  assert.deepEqual(outcome, { ok: false, code: 'desktop-only' })
})
