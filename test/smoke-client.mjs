/**
 * Headless smoke test for the harness-restart Client half.
 *
 * Runs the real client.js against a minimal React shim and a fake caption-row
 * DOM: it proves the factory loads, the slot registration targets
 * `shell.overlay`, the control renders after the "更多" launcher, the version
 * probe gates the action, the confirm popover opens, and confirming posts the
 * accepted request. It also covers the outdated-Host path.
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

/** Set by each scenario: what the fake Host reports. */
let hostVersion = '0.3.0'
const requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {} })
  if ((init?.method ?? 'GET') === 'GET') {
    return { ok: true, status: 200, json: async () => ({ ok: true, version: hostVersion, supported: true }) }
  }
  return { ok: true, status: 202, json: async () => ({ ok: true, status: 'restarting' }) }
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

eval(source)
if (definition === undefined) throw new Error('module loader was not used')
if (definition.id !== 'dsh-harness-restart') throw new Error(`unexpected module id ${definition.id}`)

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
console.log('registration:', options.name, options.id, 'order', options.order)

render(component)
const tree = render(component)
if (tree === null) throw new Error('the control did not render after measuring the caption row')
const button = find(tree, (node) => node.type === 'button')
if (button === null) throw new Error('no button in the tree')
if (button.props.style.left !== 1138) throw new Error(`unexpected left ${button.props.style.left}`)
const label = textOf(button)
if (label !== '重启') throw new Error(`expected the Chinese label, saw ${JSON.stringify(label)}`)
console.log('button:', JSON.stringify(label), 'left', button.props.style.left, 'top', button.props.style.top)

// --- accepted Host: probe passes, confirm dialog appears
button.props.onClick()
await tick()
const opened = render(component)
const dialog = find(opened, (node) => node.props?.role === 'dialog')
if (dialog === null) throw new Error('the confirm popover did not open')
const popoverText = textOf(dialog)
if (!popoverText.includes('正在进行的任务会被中断')) {
  throw new Error(`unexpected popover copy ${JSON.stringify(popoverText)}`)
}
const probeRequest = requests.find((request) => request.method === 'GET')
if (probeRequest === undefined) throw new Error('no GET probe was sent')
console.log('probe:', probeRequest.method, probeRequest.url, '->', hostVersion)
console.log('popover:', JSON.stringify(popoverText))

const confirmButton = find(dialog, (node) => node.type === 'button' && textOf(node) === '重启')
if (confirmButton === null) throw new Error('no confirm button in the popover')
confirmButton.props.onClick()
await tick()
const post = requests.find((request) => request.method === 'POST')
if (post === undefined) throw new Error('no POST was sent')
if (post.url.toLowerCase() !== '/dsh-harness-restart/restart') throw new Error(`unexpected route ${post.url}`)
if (post.headers['x-dsh-restart-action'] !== 'restart') throw new Error('missing action header')
console.log('request:', post.method, post.url, JSON.stringify(post.headers))

// --- outdated Host: the action is refused with an explanation
const fresh = definition.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected module ${name}`)
})
registrations.length = 0
fresh.apply({
  slots: {
    inject: (owner, callback) => { callback() },
    register: (opts, comp) => { registrations.push({ options: opts, component: comp }); return opts },
  },
  locale,
  effect: (fn) => fn(),
})
const second = registrations[0].component
hostVersion = '0.2.0'
requests.length = 0
hooks.reset()
render(second)
const secondTree = render(second)
const secondButton = find(secondTree, (node) => node.type === 'button')
secondButton.props.onClick()
await tick()
const blocked = render(second)
const blockedDialog = find(blocked, (node) => node.props?.role === 'dialog')
if (blockedDialog === null) throw new Error('the outdated popover did not open')
const blockedText = textOf(blockedDialog)
if (!blockedText.includes('先重开一次应用')) {
  throw new Error(`unexpected outdated copy ${JSON.stringify(blockedText)}`)
}
const buttons = findAll(blockedDialog, (node) => node.type === 'button')
if (buttons.length !== 1) throw new Error(`expected one button in the outdated popover, got ${buttons.length}`)
if (requests.some((request) => request.method === 'POST')) throw new Error('an outdated Host must never be asked to restart')
console.log('outdated:', JSON.stringify(blockedText), '| buttons:', buttons.length)

console.log('SMOKE OK')
