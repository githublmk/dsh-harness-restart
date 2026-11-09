/**
 * Host entry wiring: the route, the tools, and the boot restore are all mounted
 * by one `apply`, and the route answers its version handshake without a Desktop
 * shell.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { VERSION } from '../lib/config.js'
import { apply } from '../index.js'

let directory

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-restart-plugin-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** One recorded route with its handler. */
function mount() {
  const routes = []
  const tools = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register: (tool) => {
        tools.push(tool)
        return () => {}
      },
    },
  }
  apply(ctx, { storeDir: directory, bootDelayMs: 0 })
  return { routes, tools }
}

/** A response object that records what the handler wrote. */
function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body
    },
  }
}

test('apply mounts one exact route and the three tools', () => {
  const { routes, tools } = mount()
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/dsh-harness-restart/restart')
  assert.deepEqual(tools.map((tool) => tool.name), [
    'harness_restart', 'harness_restart_status', 'harness_restart_cancel',
  ])
})

test('GET answers the version handshake the Client half gates on', async () => {
  const { routes } = mount()
  const res = response()
  await routes[0].handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.version, VERSION)
  assert.deepEqual(body.capabilities, ['restart', 'resume', 'tasks'])
  assert.equal(body.resumeDefault, 'interrupted')
  assert.equal(body.maxTasks, 8)
  assert.equal(body.lastPlan, null)
  /* The test runner is a plain Node process, so the Client half must be told
   * that this Host has no restart path. */
  assert.equal(body.supported, false)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('both halves declare the same handshake version', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(
    source.includes(`const VERSION = '${VERSION}'`),
    `client.js must declare VERSION = '${VERSION}'`,
  )
})

test('the language diagnostic requires its own header', async () => {
  const { routes } = mount()
  const refused = response()
  await routes[0].handler({ method: 'PUT', headers: {}, on() {} }, refused)
  assert.equal(refused.status, 403)
})

test('POST without the action header is refused before anything else', async () => {
  const { routes } = mount()
  const res = response()
  await routes[0].handler({ method: 'POST', headers: {} }, res)
  assert.equal(res.status, 403)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'forbidden' })
})

test('POST on a Host without a Desktop shell reports desktop-only', async () => {
  const { routes } = mount()
  const res = response()
  await routes[0].handler({
    method: 'POST',
    headers: { 'x-dsh-restart-action': 'restart' },
    on() {},
  }, res)
  assert.equal(res.status, 409)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'desktop-only' })
})

test('an unsupported method is refused', async () => {
  const { routes } = mount()
  const res = response()
  await routes[0].handler({ method: 'DELETE', headers: {} }, res)
  assert.equal(res.status, 405)
})
