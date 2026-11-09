/**
 * Headless smoke test for the harness-restart Client half.
 *
 * Runs the real client.js against a minimal React shim and a fake caption-row
 * DOM: it proves the factory loads, the slot registration targets
 * `shell.overlay`, the control renders after the "更多" launcher, the version
 * probe gates the action, the confirm popover offers the resume switch and the
 * task box, confirming posts the accepted request exactly once, an uncheck
 * turns the resume policy off, the Host's task limit is honored, a refused
 * request leaves a usable control, an outdated or unsupported Host is refused,
 * and a finished plan shows the post-restart notice.
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let definition
globalThis.window = {
  innerWidth: 1440,
  addEventListener() {},
  removeEventListener() {},
  setInterval() { return 0 },
  clearInterval() {},
  __ModuleLoader__: {
    load(def) { definition = def },
  },
}

const hooks = (() => {
  const states = []
  let index = 0
  let effects = []
  return {
    begin() { index = 0; effects = [] },
    reset() { states.length = 0; index = 0; effects = [] },
    useState(initial) {
      const slot = index++
      if (!(slot in states)) states[slot] = initial
      return [states[slot], (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next }]
    },
    useEffect(fn) { index++; effects.push(fn) },
    useCallback(fn) { index++; return fn },
    settle() { for (const fn of effects.splice(0)) fn() },
  }
})()

const fakeReact = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState: hooks.useState,
  useEffect: hooks.useEffect,
  useCallback: hooks.useCallback,
}

/** The Client half's own handshake version, so the fake Host can never drift. */
const clientVersion = /const VERSION = '([^']+)'/u.exec(source)?.[1]
if (clientVersion === undefined) throw new Error('client.js does not declare VERSION')

/** What the fake Host reports; each scenario adjusts it. */
const host = {
  version: clientVersion,
  supported: true,
  resumeDefault: 'interrupted',
  maxTasks: 8,
  postStatus: 202,
  lastPlan: null,
}
const requests = []
globalThis.fetch = async (url, init) => {
  const method = init?.method ?? 'GET'
  requests.push({ url, method, headers: init?.headers ?? {}, body: init?.body })
  if (method === 'PUT') return { ok: true, status: 204, json: async () => ({ ok: true }) }
  if (method === 'GET') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        version: host.version,
        supported: host.supported,
        capabilities: ['restart', 'resume', 'tasks'],
        resumeDefault: host.resumeDefault,
        maxTasks: host.maxTasks,
        lastPlan: host.lastPlan,
      }),
    }
  }
  const accepted = host.postStatus >= 200 && host.postStatus < 300
  return {
    ok: accepted,
    status: host.postStatus,
    json: async () => (accepted ? { ok: true, status: 'restarting' } : { ok: false, error: 'failed' }),
  }
}

const launcher = {
  getBoundingClientRect: () => ({ left: 1100, right: 1130, top: 6, bottom: 34, width: 30, height: 28 }),
}
const nav = {
  getBoundingClientRect: () => ({ left: 120, right: 1130, top: 0, bottom: 40, width: 1010, height: 40 }),
  querySelector: (selector) => (selector === '[aria-haspopup]' ? launcher : null),
}
globalThis.document = {
  querySelector: (selector) => (selector.startsWith('nav') ? nav : null),
}

const registrations = []
const locale = {
  getLocale: () => ({ active: 'zh-CN', locales: [], revision: 1 }),
  subscribe: () => () => {},
  register: () => () => {},
  bind: () => (key) => key,
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

function find(node, test) {
  if (node === null || typeof node !== 'object') return null
  if (test(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, test)
    if (hit !== null) return hit
  }
  return null
}

function findAll(node, test, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (test(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, test, found)
  return found
}

function render(component) {
  hooks.begin()
  const tree = component({})
  hooks.settle()
  return tree
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

/** Mount one fresh Client half; returns its component and the second render. */
function mount() {
  registrations.length = 0
  hooks.reset()
  const api = definition.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected module ${name}`)
  })
  api.apply({
    slots: {
      inject: (owner, callback) => {
        if (owner !== 'shell.overlay') throw new Error(`unexpected owner slot ${owner}`)
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return { options, component }
      },
    },
    locale,
    effect: (fn) => fn(),
  })
  if (registrations.length !== 1) throw new Error(`expected one registration, got ${registrations.length}`)
  const { options, component } = registrations[0]
  if (options.name !== 'shell.overlay' || options.id !== 'harness-restart') {
    throw new Error(`unexpected registration ${JSON.stringify(options)}`)
  }
  render(component)
  return { component, tree: render(component) }
}

/** Click the control, wait for the probe, and return the open dialog. */
async function open(component, tree) {
  const control = find(tree, (node) => node.type === 'button')
  if (control === null) throw new Error('no control button in the tree')
  control.props.onClick()
  await tick()
  const dialog = find(render(component), (node) => node.props?.role === 'dialog')
  if (dialog === null) throw new Error('the confirm popover did not open')
  return dialog
}

/** Click the confirm button inside one dialog. */
function confirm(dialog) {
  const button = findAll(dialog, (node) => node.type === 'button' && textOf(node) === '重启').at(-1)
  if (button === undefined) throw new Error('no confirm button in the popover')
  button.props.onClick()
}

const posts = () => requests.filter((request) => request.method === 'POST')

eval(source)
if (definition === undefined) throw new Error('module loader was not used')
if (definition.id !== 'dsh-harness-restart') throw new Error(`unexpected module id ${definition.id}`)

// --- accepted Host: the default request, posted exactly once
{
  const { component, tree } = mount()
  const control = find(tree, (node) => node.type === 'button')
  if (control.props.style.left !== 1138) throw new Error(`unexpected left ${control.props.style.left}`)
  if (textOf(control) !== '重启') throw new Error(`expected the Chinese label, saw ${JSON.stringify(textOf(control))}`)
  const dialog = await open(component, tree)
  const popoverText = textOf(dialog)
  for (const expected of ['正在进行的任务会被中断', '重启后继续被中断的会话', '重启后任务（可选，每行一条）']) {
    if (!popoverText.includes(expected)) throw new Error(`unexpected popover copy ${JSON.stringify(popoverText)}`)
  }
  const probe = requests.find((request) => request.method === 'GET')
  if (probe === undefined) throw new Error('no GET probe was sent')
  console.log('probe:', probe.method, probe.url, '->', host.version)
  console.log('popover:', JSON.stringify(popoverText))

  /* Two clicks in the same frame must still produce one request. */
  confirm(dialog)
  confirm(dialog)
  await tick()
  const sent = posts()
  if (sent.length !== 1) throw new Error(`expected one POST, saw ${sent.length}`)
  const posted = JSON.parse(sent[0].body)
  if (posted.resume !== 'interrupted') throw new Error(`unexpected resume policy ${JSON.stringify(posted.resume)}`)
  if (!Array.isArray(posted.tasks) || posted.tasks.length !== 0) throw new Error(`unexpected tasks ${JSON.stringify(posted.tasks)}`)
  if (posted.language !== 'zh-CN') throw new Error(`unexpected language ${JSON.stringify(posted.language)}`)
  console.log('request:', sent[0].method, sent[0].url, JSON.stringify(posted))
}

// --- the resume switch off: policy none and the matching copy
{
  requests.length = 0
  const { component, tree } = mount()
  const dialog = await open(component, tree)
  const checkbox = find(dialog, (node) => node.type === 'input' && node.props.type === 'checkbox')
  if (checkbox === null) throw new Error('no resume switch in the popover')
  checkbox.props.onChange()
  const updated = find(render(component), (node) => node.props?.role === 'dialog')
  if (!textOf(updated).includes('本次重启不会恢复被中断的会话')) {
    throw new Error(`unexpected unchecked copy ${JSON.stringify(textOf(updated))}`)
  }
  confirm(updated)
  await tick()
  const posted = JSON.parse(posts()[0].body)
  if (posted.resume !== 'none') throw new Error(`unexpected unchecked policy ${JSON.stringify(posted.resume)}`)
  console.log('unchecked request:', JSON.stringify(posted))
}

// --- the Host limits the task list
{
  requests.length = 0
  host.maxTasks = 2
  const { component, tree } = mount()
  const dialog = await open(component, tree)
  const textarea = find(dialog, (node) => node.type === 'textarea')
  if (textarea === null) throw new Error('no task box in the popover')
  textarea.props.onChange({ target: { value: 'one\ntwo\nthree\n' } })
  const updated = find(render(component), (node) => node.props?.role === 'dialog')
  confirm(updated)
  await tick()
  const posted = JSON.parse(posts()[0].body)
  if (posted.tasks.length !== 2) throw new Error(`expected the Host limit to apply, saw ${JSON.stringify(posted.tasks)}`)
  console.log('limited tasks:', JSON.stringify(posted.tasks))
  host.maxTasks = 8
}

// --- a refused request leaves a usable control
{
  requests.length = 0
  host.postStatus = 500
  const { component, tree } = mount()
  confirm(await open(component, tree))
  await tick()
  const after = render(component)
  const control = find(after, (node) => node.type === 'button')
  if (!textOf(control).includes('重启')) throw new Error('the control stayed busy after a refused request')
  const dialog = find(after, (node) => node.props?.role === 'dialog')
  if (dialog === null) throw new Error('the failure popover did not reopen')
  if (!textOf(dialog).includes('没有被接受')) throw new Error(`unexpected failure copy ${JSON.stringify(textOf(dialog))}`)
  console.log('refused:', JSON.stringify(textOf(dialog)))
  host.postStatus = 202
}

// --- outdated Host
{
  host.version = '0.2.0'
  requests.length = 0
  const { component, tree } = mount()
  const dialog = await open(component, tree)
  if (!textOf(dialog).includes('先重开一次应用')) throw new Error(`unexpected outdated copy ${JSON.stringify(textOf(dialog))}`)
  const buttons = findAll(dialog, (node) => node.type === 'button')
  if (buttons.length !== 1) throw new Error(`expected one button in the outdated popover, got ${buttons.length}`)
  if (posts().length !== 0) throw new Error('an outdated Host must never be asked to restart')
  console.log('outdated:', JSON.stringify(textOf(dialog)))
  host.version = clientVersion
}

// --- unsupported Host
{
  host.supported = false
  requests.length = 0
  const { component, tree } = mount()
  const dialog = await open(component, tree)
  if (!textOf(dialog).includes('不支持自动重启')) throw new Error(`unexpected unsupported copy ${JSON.stringify(textOf(dialog))}`)
  if (posts().length !== 0) throw new Error('an unsupported Host must never be asked to restart')
  console.log('unsupported:', JSON.stringify(textOf(dialog)))
  host.supported = true
}

// --- the profile's resume policy preselects the switch
{
  host.resumeDefault = 'none'
  const { component, tree } = mount()
  const dialog = await open(component, tree)
  if (!textOf(dialog).includes('本次重启不会恢复被中断的会话')) {
    throw new Error(`the profile policy did not preselect the switch: ${JSON.stringify(textOf(dialog))}`)
  }
  console.log('profile default:', JSON.stringify(textOf(dialog)))
  host.resumeDefault = 'interrupted'
}

// --- finished plan: the page says what the restart did
{
  host.lastPlan = {
    planId: 'rst-notice',
    at: Date.now() - 2000,
    finishedAt: Date.now() - 2000,
    ok: true,
    resumed: 2,
    tasks: 1,
  }
  const { component } = mount()
  await tick()
  const notice = find(render(component), (node) => node.props?.role === 'status')
  if (notice === null) throw new Error('the post-restart notice did not render')
  const noticeText = textOf(notice)
  if (!noticeText.includes('已恢复 2 个会话') || !noticeText.includes('启动 1 个任务')) {
    throw new Error(`unexpected notice copy ${JSON.stringify(noticeText)}`)
  }
  console.log('notice:', JSON.stringify(noticeText))
}

console.log('SMOKE OK')
