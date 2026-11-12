/**
 * Headless smoke test for the harness-restart Client half.
 *
 * Runs the real client.js against a minimal React shim and a fake Host, in the
 * shape the plugin really runs in: `apply` once per app start, and the page
 * mounted and unmounted many times as the user switches panels. It proves the
 * client registers one sidebar panel row (behind the memory panel), the page
 * and the icon that go with it, and the frame-wide notice; that the row's label
 * follows the app language; that the page's version probe gates the action;
 * that the resume switch, the task box and the Host's task limit all reach the
 * POST; that a refused request leaves a usable page; that the stalled watchdog
 * releases the lock; that an outdated or unsupported Host never posts; that
 * Cancel returns to the Conversation; that a finished plan is reported and
 * then auto-hides; and that a page unmounted mid-POST can still restart after
 * it is mounted again.
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let definition
globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  setInterval() { return 0 },
  clearInterval() {},
  __ModuleLoader__: {
    load(def) { definition = def },
  },
}

/* --- fake timers: the watchdog and the notice auto-hide are the two paths
 * whose whole purpose is "do not get stuck", so they have to be runnable. */
let timerSeq = 0
const timers = new Map()
window.setTimeout = (callback) => {
  const id = ++timerSeq
  timers.set(id, callback)
  return id
}
window.clearTimeout = (id) => { timers.delete(id) }
/** Run every pending timer once, as if the whole delay had elapsed. */
function fireTimers() {
  const pending = [...timers.values()]
  timers.clear()
  for (const callback of pending) callback()
}

/* --- the hooks the page relies on, with React's real contracts: dependency
 * arrays, lazy state initializers, memoized callbacks, refs and cleanups. */
const hooks = (() => {
  const states = []
  const refs = []
  const previousDeps = []
  const callbacks = []
  let cleanups = []
  let index = 0
  let effects = []
  return {
    begin() { index = 0; effects = [] },
    reset() {
      /* A reset stands for a fresh mount: run the previous mount's cleanups so
       * a scenario that forgets `unmount()` cannot leak effects or timers into
       * the next one. */
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      states.length = 0
      refs.length = 0
      previousDeps.length = 0
      callbacks.length = 0
      cleanups = []
      index = 0
      effects = []
      timers.clear()
    },
    useState(initial) {
      const slot = index++
      /* A function initializer is lazy, like React's. */
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
      return [states[slot], (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next }]
    },
    useRef(initial) {
      const slot = index++
      if (!(slot in refs)) refs[slot] = { current: initial }
      return refs[slot]
    },
    useEffect(fn, deps) {
      const slot = index++
      if (deps === undefined) {
        effects.push(fn)
        return
      }
      const previous = previousDeps[slot]
      const same = Array.isArray(previous) && previous.length === deps.length
        && deps.every((value, position) => Object.is(value, previous[position]))
      if (same) return
      previousDeps[slot] = deps
      effects.push(fn)
    },
    /* Same contract: the identity is stable until a dependency changes, so a
     * stale closure cannot post an outdated resume policy. */
    useCallback(fn, deps) {
      const slot = index++
      const previous = callbacks[slot]
      if (Array.isArray(deps) && previous !== undefined
        && previous.deps.length === deps.length
        && deps.every((value, position) => Object.is(value, previous.deps[position]))) {
        return previous.fn
      }
      callbacks[slot] = { deps: Array.isArray(deps) ? deps : [], fn }
      return fn
    },
    settle() {
      for (const fn of effects.splice(0)) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
    },
    /** React's unmount: run every effect cleanup this mount registered. */
    unmount() {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    },
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
  useRef: hooks.useRef,
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
  /** Hold the next POST open, so a scenario can unmount mid-request. */
  postGate: null,
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
  if (host.postGate !== null) {
    const gate = host.postGate
    host.postGate = null
    await gate.reached
  }
  const accepted = host.postStatus >= 200 && host.postStatus < 300
  return {
    ok: accepted,
    status: host.postStatus,
    json: async () => (accepted ? { ok: true, status: 'restarting' } : { ok: false, error: 'failed' }),
  }
}

globalThis.document = {
  documentElement: { getAttribute: () => 'zh-CN' },
  querySelector: () => null,
}

const registrations = []
/** Selected panel id recorded by the fake layout service. */
const selected = []
const localeState = { active: 'zh-CN' }
const locale = {
  getLocale: () => ({ active: localeState.active, locales: [], revision: 1 }),
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

function render(component, props = {}) {
  hooks.begin()
  const tree = component(props)
  hooks.settle()
  return tree
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

/** One Client half, applied exactly once — the production shape. */
let plugin
function applyOnce() {
  if (plugin !== undefined) return plugin
  const api = definition.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected module ${name}`)
  })
  api.apply({
    slots: {
      inject: (owner, callback) => {
        if (!['main', 'sidebar.panellist', 'shell.overlay'].includes(owner)) {
          throw new Error(`unexpected owner slot ${owner}`)
        }
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return { options, component }
      },
    },
    locale,
    layout: { selectPanel: (id) => { selected.push(id) } },
    effect: (fn) => fn(),
  })
  if (registrations.length !== 3) throw new Error(`expected three registrations, got ${registrations.length}`)
  const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  const page = registrations.find((entry) => entry.options.name === 'main')
  const notice = registrations.find((entry) => entry.options.name === 'shell.overlay')
  if (panel === undefined || page === undefined || notice === undefined) {
    throw new Error(`unexpected registrations ${JSON.stringify(registrations.map((entry) => entry.options))}`)
  }
  if (page.options.key !== 'harness-restart') {
    throw new Error(`unexpected main key ${JSON.stringify(page.options.key)}`)
  }
  if (panel.options.id !== 'harness-restart') {
    throw new Error(`unexpected panel id ${JSON.stringify(panel.options.id)}`)
  }
  /* Behind the memory panel (900) and ahead of the overflow launcher. */
  if (!(panel.options.order > 900)) {
    throw new Error(`the restart row must follow the memory panel, got order ${panel.options.order}`)
  }
  plugin = { page: page.component, icon: panel.component, notice: notice.component, panel }
  return plugin
}

/**
 * Mount the page fresh and let its probe settle.
 * @param options.probe - when false, keep the page in its pre-probe state.
 */
async function mountPage(options = {}) {
  applyOnce()
  hooks.reset()
  selected.length = 0
  const page = plugin.page
  render(page)
  if (options.probe === false) return page
  await tick()
  return page
}

/** Re-render the mounted page and read its tree. */
function pageTree(page) {
  return render(page)
}

/** Click the page action whose exact label is given. */
function click(tree, label) {
  const button = findAll(tree, (node) => node.type === 'button' && textOf(node) === label).at(-1)
  if (button === undefined) throw new Error(`no "${label}" button in the page`)
  button.props.onClick()
}

const posts = () => requests.filter((request) => request.method === 'POST')

eval(source)
if (definition === undefined) throw new Error('module loader was not used')
if (definition.id !== 'dsh-harness-restart') throw new Error(`unexpected module id ${definition.id}`)

// --- the panel row, its icon, and the page copy
{
  const page = await mountPage()
  if (plugin.panel.options.label() !== '重启') {
    throw new Error(`unexpected row label ${JSON.stringify(plugin.panel.options.label())}`)
  }
  const svg = plugin.icon({ size: 18, active: false })
  if (svg.type !== 'svg' || svg.props.width !== 18 || svg.props.height !== 18) {
    throw new Error(`the sidebar icon ignored the requested edge: ${JSON.stringify(svg.props)}`)
  }
  const tree = pageTree(page)
  const heading = textOf(tree)
  for (const expected of [
    '重启应用与 Host',
    '正在进行的任务会被中断',
    '重启后继续被中断的会话',
    '重启后任务（可选，每行一条，最多 8 条）',
  ]) {
    if (!heading.includes(expected)) throw new Error(`unexpected page copy ${JSON.stringify(heading)}`)
  }
  /* The heading is the page's h1 and is a focus target (this harness does not
   * attach refs, so the focus effect itself is not observable here). */
  const h1 = find(tree, (node) => node.type === 'h1')
  if (h1 === null || h1.props.tabIndex !== -1 || h1.props.ref === undefined) {
    throw new Error('the page head is not a focusable h1')
  }
  const checkbox = find(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')
  if (checkbox === null || checkbox.props.checked !== true) {
    throw new Error('the resume switch did not start checked')
  }
  /* The task box is programmatically labelled: its own <label> wraps it. */
  const taskLabel = find(tree, (node) => node.type === 'label' && find(node, (child) => child.type === 'textarea') !== null)
  if (taskLabel === null) throw new Error('the task box is not wrapped in a label')
  const probe = requests.find((request) => request.method === 'GET')
  if (probe === undefined) throw new Error('no GET probe was sent')
  if (requests.find((request) => request.method === 'PUT') === undefined) {
    throw new Error('the language diagnostic was not reported')
  }
  console.log('probe:', probe.method, probe.url, '->', host.version)
  console.log('page:', JSON.stringify(heading))
}

// --- before the probe answers, the action is inert
{
  requests.length = 0
  const page = await mountPage({ probe: false })
  const tree = pageTree(page)
  const confirmButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '重启').at(-1)
  if (confirmButton === undefined) throw new Error('no restart button while probing')
  if (confirmButton.props.disabled !== true) throw new Error('the restart button was enabled before the Host answered')
  /* Even a direct invocation (a keypress, a stale handler) must not post. */
  confirmButton.props.onClick()
  await tick()
  if (posts().length !== 0) throw new Error('the page posted before the Host handshake completed')
  console.log('pre-probe: action inert')
}

// --- confirming posts the accepted request exactly once
{
  requests.length = 0
  const page = await mountPage()
  const tree = pageTree(page)
  click(tree, '重启')
  click(tree, '重启')
  await tick()
  const sent = posts()
  if (sent.length !== 1) throw new Error(`expected one POST, saw ${sent.length}`)
  const posted = JSON.parse(sent[0].body)
  if (posted.resume !== 'interrupted') throw new Error(`unexpected resume policy ${JSON.stringify(posted.resume)}`)
  if (!Array.isArray(posted.tasks) || posted.tasks.length !== 0) throw new Error(`unexpected tasks ${JSON.stringify(posted.tasks)}`)
  if (posted.language !== 'zh-CN') throw new Error(`unexpected language ${JSON.stringify(posted.language)}`)
  const busy = pageTree(page)
  if (!textOf(busy).includes('正在重启…')) throw new Error('the page did not report the restart in flight')
  console.log('request:', sent[0].method, sent[0].url, JSON.stringify(posted))
}

// --- the stalled watchdog releases the lock instead of leaving a dead page
{
  requests.length = 0
  const page = await mountPage()
  click(pageTree(page), '重启')
  await tick()
  if (posts().length !== 1) throw new Error('the accepted request never posted')
  /* The app never restarts: the watchdog must clear the busy state. */
  fireTimers()
  const after = pageTree(page)
  if (!textOf(after).includes('没有在预期时间内发生')) {
    throw new Error(`unexpected stalled copy ${JSON.stringify(textOf(after))}`)
  }
  const again = findAll(after, (node) => node.type === 'button' && textOf(node) === '重启').at(-1)
  if (again === undefined || again.props.disabled === true) {
    throw new Error('the stalled watchdog left the page without a usable restart button')
  }
  again.props.onClick()
  await tick()
  if (posts().length !== 2) throw new Error('the watchdog did not release the submission lock')
  console.log('watchdog: stalled reported, lock released')
}

// --- a page unmounted mid-POST can restart again after it comes back
{
  requests.length = 0
  const page = await mountPage()
  let release
  host.postGate = { reached: new Promise((resolve) => { release = resolve }) }
  click(pageTree(page), '重启')
  await tick()
  if (posts().length !== 1) throw new Error('the gated POST never started')
  /* The user switches to another panel while the restart is in flight. */
  hooks.unmount()
  release()
  await tick()
  await mountPage()
  const tree = pageTree(page)
  const button = findAll(tree, (node) => node.type === 'button' && textOf(node) === '重启').at(-1)
  if (button === undefined) throw new Error('no restart button after remounting the page')
  if (button.props.disabled === true) throw new Error('the remounted page left the restart button disabled')
  button.props.onClick()
  await tick()
  if (posts().length !== 2) throw new Error('a page remounted after an interrupted restart could not restart again')
  console.log('remount: restart still possible after an unmount mid-POST')
}

// --- the resume switch off: policy none and the matching copy
{
  requests.length = 0
  const page = await mountPage()
  const tree = pageTree(page)
  const checkbox = find(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')
  checkbox.props.onChange()
  const updated = pageTree(page)
  if (!textOf(updated).includes('本次重启不会恢复被中断的会话')) {
    throw new Error(`unexpected unchecked copy ${JSON.stringify(textOf(updated))}`)
  }
  click(updated, '重启')
  await tick()
  const posted = JSON.parse(posts()[0].body)
  if (posted.resume !== 'none') throw new Error(`unexpected unchecked policy ${JSON.stringify(posted.resume)}`)
  console.log('unchecked request:', JSON.stringify(posted))
}

// --- the Host limits the task list, and the label states the limit
{
  requests.length = 0
  host.maxTasks = 2
  const page = await mountPage()
  const tree = pageTree(page)
  if (!textOf(tree).includes('最多 2 条')) throw new Error(`the task label did not state the Host limit: ${JSON.stringify(textOf(tree))}`)
  const textarea = find(tree, (node) => node.type === 'textarea')
  if (textarea === null) throw new Error('no task box in the page')
  textarea.props.onChange({ target: { value: 'one\ntwo\nthree\n' } })
  click(pageTree(page), '重启')
  await tick()
  const posted = JSON.parse(posts()[0].body)
  if (posted.tasks.length !== 2) throw new Error(`expected the Host limit to apply, saw ${JSON.stringify(posted.tasks)}`)
  console.log('limited tasks:', JSON.stringify(posted.tasks))
  host.maxTasks = 8
}

// --- a refused request leaves a usable page
{
  requests.length = 0
  host.postStatus = 500
  const page = await mountPage()
  click(pageTree(page), '重启')
  await tick()
  const after = pageTree(page)
  if (!textOf(after).includes('没有被接受')) throw new Error(`unexpected failure copy ${JSON.stringify(textOf(after))}`)
  const retryable = findAll(after, (node) => node.type === 'button' && textOf(node) === '重启')
  if (retryable.length !== 1) throw new Error('the page did not return to a usable restart button')
  if (retryable[0].props.disabled === true) throw new Error('the restart button stayed disabled after a refused request')
  console.log('refused:', JSON.stringify(textOf(after)))
  host.postStatus = 202
}

// --- a conflict says so, and keeps the action
{
  requests.length = 0
  host.postStatus = 409
  const page = await mountPage()
  click(pageTree(page), '重启')
  await tick()
  const after = pageTree(page)
  if (!textOf(after).includes('已有一次重启正在进行')) throw new Error(`unexpected conflict copy ${JSON.stringify(textOf(after))}`)
  console.log('conflict:', JSON.stringify(textOf(after)))
  host.postStatus = 202
}

// --- outdated Host: no restart, a retry, and a retry keeps the user's edit
{
  host.version = '0.4.5'
  requests.length = 0
  const page = await mountPage()
  const tree = pageTree(page)
  if (!textOf(tree).includes('先重开一次应用')) throw new Error(`unexpected outdated copy ${JSON.stringify(textOf(tree))}`)
  if (findAll(tree, (node) => node.type === 'button' && textOf(node) === '重启').length !== 0) {
    throw new Error('an outdated Host still offered the restart action')
  }
  if (findAll(tree, (node) => node.type === 'button' && textOf(node) === '重试').length !== 1) {
    throw new Error('an outdated Host did not offer a retry')
  }
  /* The blocked page still shows the form: a choice made there must survive
   * the retry, because Retry is not a form reset. */
  find(tree, (node) => node.type === 'input' && node.props.type === 'checkbox').props.onChange()
  host.version = clientVersion
  click(pageTree(page), '重试')
  await tick()
  const recovered = pageTree(page)
  if (!textOf(recovered).includes('本次重启不会恢复被中断的会话')) {
    throw new Error(`the retry reverted the user's resume choice: ${JSON.stringify(textOf(recovered))}`)
  }
  click(recovered, '重启')
  await tick()
  const posted = JSON.parse(posts()[0].body)
  if (posted.resume !== 'none') throw new Error(`the retry changed what the POST sends: ${JSON.stringify(posted)}`)
  console.log('retry: recovered after the version fix, keeping the choice ->', JSON.stringify(posted))
}

// --- unsupported Host: no restart button, no POST
{
  host.supported = false
  requests.length = 0
  const page = await mountPage()
  const tree = pageTree(page)
  if (!textOf(tree).includes('不支持自动重启')) throw new Error(`unexpected unsupported copy ${JSON.stringify(textOf(tree))}`)
  if (findAll(tree, (node) => node.type === 'button' && textOf(node) === '重启').length !== 0) {
    throw new Error('an unsupported Host still offered the restart action')
  }
  if (posts().length !== 0) throw new Error('an unsupported Host must never be asked to restart')
  console.log('unsupported:', JSON.stringify(textOf(tree)))
  host.supported = true
}

// --- the profile's resume policy preselects the switch
{
  host.resumeDefault = 'none'
  const page = await mountPage()
  const tree = pageTree(page)
  if (!textOf(tree).includes('本次重启不会恢复被中断的会话')) {
    throw new Error(`the profile policy did not preselect the switch: ${JSON.stringify(textOf(tree))}`)
  }
  console.log('profile default:', JSON.stringify(textOf(tree)))
  host.resumeDefault = 'interrupted'
}

// --- Cancel returns to the Conversation
{
  const page = await mountPage()
  click(pageTree(page), '取消')
  if (selected.length !== 1 || selected[0] !== null) {
    throw new Error(`the panel was not released on Cancel: ${JSON.stringify(selected)}`)
  }
  console.log('cancel: selected', JSON.stringify(selected))
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
  const page = await mountPage()
  const status = find(pageTree(page), (node) => node.props?.role === 'status')
  if (status === null) throw new Error('the page did not report the last restart')
  const statusText = textOf(status)
  if (!statusText.includes('已恢复 2 个会话') || !statusText.includes('启动 1 个任务')) {
    throw new Error(`unexpected page summary ${JSON.stringify(statusText)}`)
  }
  console.log('page summary:', JSON.stringify(statusText))
}

// --- the frame-wide notice reports the same plan, then hides itself
{
  const page = await mountPage()
  hooks.unmount()
  hooks.reset()
  render(plugin.notice)
  await tick()
  const pill = find(render(plugin.notice), (node) => node.props?.role === 'status')
  if (pill === null) throw new Error('the post-restart notice did not render')
  const pillText = textOf(pill)
  if (!pillText.includes('已恢复 2 个会话') || !pillText.includes('启动 1 个任务')) {
    throw new Error(`unexpected notice copy ${JSON.stringify(pillText)}`)
  }
  /* It must not sit over the composer as a click target, and it must go away. */
  if (pill.props.style.pointerEvents !== 'none') throw new Error('the notice swallows pointer events')
  if (pill.props.onClick !== undefined) throw new Error('the notice is an unlabelled interactive element')
  fireTimers()
  if (find(render(plugin.notice), (node) => node.props?.role === 'status') !== null) {
    throw new Error('the notice did not hide itself after its time on screen')
  }
  console.log('notice:', JSON.stringify(pillText), '(auto-hides)')
  host.lastPlan = null
}

{
  hooks.reset()
  render(plugin.notice)
  await tick()
  if (find(render(plugin.notice), (node) => node.props?.role === 'status') !== null) {
    throw new Error('the notice rendered without a recent plan')
  }
  console.log('notice: hidden without a plan')
}

// --- the row label and the page copy follow the app language, and the locale
//     service outranks the browser's own language
{
  localeState.active = 'en'
  globalThis.document = { documentElement: { getAttribute: () => 'en' }, querySelector: () => null }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true })
  const page = await mountPage()
  if (plugin.panel.options.label() !== 'Restart') throw new Error(`unexpected English row label ${JSON.stringify(plugin.panel.options.label())}`)
  const tree = pageTree(page)
  for (const expected of ['Restart the app and Host', 'Cancel', 'Continue interrupted Sessions after the restart']) {
    if (!textOf(tree).includes(expected)) throw new Error(`unexpected English copy ${JSON.stringify(textOf(tree))}`)
  }
  console.log('english:', JSON.stringify(plugin.panel.options.label()))
}

{
  /* An app switched to English on a Chinese-locale machine stays English. */
  localeState.active = 'en'
  globalThis.document = { documentElement: { getAttribute: () => 'en' }, querySelector: () => null }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
  applyOnce()
  if (plugin.panel.options.label() !== 'Restart') {
    throw new Error(`the browser language overrode the app locale: ${JSON.stringify(plugin.panel.options.label())}`)
  }
  console.log('locale precedence: app locale wins over navigator.language')
  localeState.active = 'zh-CN'
  globalThis.document = { documentElement: { getAttribute: () => 'zh-CN' }, querySelector: () => null }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
}

console.log('SMOKE OK')
