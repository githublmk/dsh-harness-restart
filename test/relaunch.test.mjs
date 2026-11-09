/**
 * Relaunch assistant helpers: argument parsing, the process-table count, and
 * the launch decision. The assistant itself cannot be unit tested (it spawns an
 * application), so its decisions are.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { countApplicationProcesses, launchDecision, parseAssistantArgs } from '../lib/relaunch-core.js'

test('parseAssistantArgs accepts a full invocation and treats bad pids as unknown', () => {
  const args = parseAssistantArgs(['1234', '5678', 'C:\\App\\App.exe', 'C:\\tmp\\restart.log', 'C:\\tmp\\ready', 'C:\\store', 'rst-1'])
  assert.equal(args.shell, 1234)
  assert.equal(args.host, 5678)
  assert.equal(args.appExe, 'C:\\App\\App.exe')
  assert.equal(args.logFile, 'C:\\tmp\\restart.log')
  assert.equal(args.marker, 'C:\\tmp\\ready')
  assert.equal(args.planDir, 'C:\\store')
  assert.equal(args.planId, 'rst-1')
})

test('parseAssistantArgs defaults absent optional arguments to empty strings', () => {
  const args = parseAssistantArgs(['1', '2', 'app.exe', 'log', 'ready'])
  assert.equal(args.planDir, '')
  assert.equal(args.planId, '')
  const malformed = parseAssistantArgs(['NaN', '-3', undefined])
  assert.equal(malformed.shell, null)
  assert.equal(malformed.host, null)
  assert.equal(malformed.appExe, '')
  assert.deepEqual(parseAssistantArgs(undefined), {
    shell: null, host: null, appExe: '', logFile: '', marker: '', planDir: '', planId: '',
  })
})

test('countApplicationProcesses matches the image column exactly', () => {
  const table = [
    '"App.exe","1111","Console","1","100,000 K"',
    '"App.exe","2222","Console","1","90,000 K"',
    '"OtherApp.exe","3333","Console","1","10 K"',
    '"notepad.exe","4444","Console","1","5 K"',
    '',
  ].join('\r\n')
  assert.equal(countApplicationProcesses(table, 'App.exe'), 2)
  assert.equal(countApplicationProcesses(table, 'app.exe'), 2)
  assert.equal(countApplicationProcesses('', 'App.exe'), 0)
  assert.equal(countApplicationProcesses(undefined, 'App.exe'), -1)
})

test('launchDecision distinguishes launched, not observed, and unknown', () => {
  assert.equal(launchDecision({ before: 0, after: 6 }), 'launched')
  assert.equal(launchDecision({ before: 4, after: 4 }), 'not-observed')
  assert.equal(launchDecision({ before: -1, after: 6 }), 'unknown')
  assert.equal(launchDecision({ before: 0, after: -1 }), 'unknown')
  assert.equal(launchDecision({ before: Number.NaN, after: 3 }), 'unknown')
})
