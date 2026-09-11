/**
 * Verification harness for dsh-chat-git's browser half.
 *
 * The client bundle cannot be run in a browser from here, but everything that
 * decides *what the shell does* can be checked in Node: the
 * `window.__ModuleLoader__` wrapper shape, the exported plugin surface, the
 * three slot registrations, the synchronous chain selector's cold/warm
 * behaviour, and the rendered output of both visible seats.
 *
 *   node test/client.mjs
 *
 * The renderer below is a deliberately small React stand-in — function
 * components are expanded recursively and `useState` persists across renders,
 * which is enough to observe the settings page go from "not probed yet" to a
 * detected version without a browser.
 */

let failures = 0
let checks = 0

/** Assert one condition and record the outcome. */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` -- ${detail}`}`)
  }
}

// ---------------------------------------------------------------------------
// A small React stand-in
// ---------------------------------------------------------------------------

/** Persisted hook state, keyed by the component function. */
const hookStore = new WeakMap()
let currentComponent = null
let hookCursor = 0

const ReactStub = {
  createElement(type, props, ...children) {
    return {
      element: true,
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }
  },
  useState(initial) {
    const store = hookStore.get(currentComponent) ?? []
    const index = hookCursor++
    if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial
    hookStore.set(currentComponent, store)
    const setter = (next) => {
      store[index] = typeof next === 'function' ? next(store[index]) : next
    }
    return [store[index], setter]
  },
  useEffect(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
}

/**
 * Expand a tree of elements into host elements, invoking function components
 * and giving each one a fresh hook cursor.
 */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node !== 'object' || node.element !== true) return node
  const { type, props } = node
  if (typeof type === 'function') {
    const outerComponent = currentComponent
    const outerCursor = hookCursor
    currentComponent = type
    hookCursor = 0
    let output
    try {
      output = type(props ?? {})
    } finally {
      currentComponent = outerComponent
      hookCursor = outerCursor
    }
    return render(output)
  }
  return { element: true, type, props: { ...props, children: render(props?.children) } }
}

/** Concatenate every string in a rendered tree. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && node.element === true) return textOf(node.props?.children)
  return ''
}

/** Every element of a given tag in a rendered tree. */
function findAll(node, tag, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, tag, found)
    return found
  }
  if (node.element === true) {
    if (node.type === tag) found.push(node)
    findAll(node.props?.children, tag, found)
  }
  return found
}

/** Let pending promise callbacks run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

// ---------------------------------------------------------------------------
// The host the client talks to
// ---------------------------------------------------------------------------

/** Requests the client made, for asserting the host contract it depends on. */
const requests = []

/** Host answers for the routes the client half needs. */
globalThis.fetch = async (url, init) => {
  const body = init === undefined ? {} : JSON.parse(init.body)
  requests.push({ url, body })
  let payload
  if (url === '/chat-git/state') {
    payload = {
      ok: true,
      value: {
        enabled: true,
        committed: true,
        stateFile: 'C:/tmp/chat-git.json',
        cwd: 'C:/ws',
        git: { available: true, version: 'git version 2.54.0.windows.1', error: '' },
        commits: [
          { sha: 'aaaa1111', short: 'aaaa111', subject: 'Ai-coding：实现登录接口', turn: 1, at: 2 },
          { sha: 'bbbb2222', short: 'bbbb222', subject: 'Ai-coding：把登录返回值改成 ok', turn: 2, at: 3 },
        ],
      },
    }
  } else if (url === '/chat-git/revert') {
    payload = { ok: true, value: { restored: body.sha, turn: 1, dropped: 1, removed: ['extra.txt'] } }
  } else if (url === '/chat-git/inherit') {
    payload = { ok: true, value: { inherited: 1 } }
  } else if (url === '/chat-git/detect') {
    payload = { ok: true, value: { available: true, version: 'git version 2.54.0.windows.1', error: '' } }
  } else {
    payload = { ok: false, error: { code: 'not-found', message: url } }
  }
  return { json: async () => payload }
}

// The bundle registers itself on load, exactly as client-modules expects the
// served file to; the record is captured here instead of being executed.
let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load(record) {
      registered = record
    },
  },
}

await import(new URL('../lib/client.js', import.meta.url).href)

console.log('\n== module wrapper ==')
check('the bundle registers with the module loader', registered !== null)
check('the module id is the package name', registered?.id === 'dsh-chat-git', String(registered?.id))
check('the wrapper exposes a factory', typeof registered?.factory === 'function')

const requireStub = (name) => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require: ${name}`)
}

const plugin = registered.factory(requireStub)

console.log('\n== plugin surface ==')
check('apply is exported', typeof plugin.apply === 'function')
check('inject is an array', Array.isArray(plugin.inject), JSON.stringify(plugin.inject))
check('inject declares slots', plugin.inject?.includes('slots') === true)
check('inject declares sessions', plugin.inject?.includes('sessions') === true)
check('the download target is the official git page',
  plugin.GIT_DOWNLOAD_URL === 'https://git-scm.com/downloads', String(plugin.GIT_DOWNLOAD_URL))

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** One captured `slots.register` call, tagged with the slot it went into. */
const registrations = []

const ctx = {
  sessions: { fork: async () => 'session-fork-9', open: () => {} },
  slots: {
    inject(name, callback) {
      registrations.push({ injectName: name, pending: true })
      try {
        callback()
      } catch (error) {
        registrations.at(-1).error = String(error)
      }
      return () => {}
    },
    register(options, component) {
      const entry = registrations.at(-1)
      entry.options = options
      entry.component = component
      entry.pending = false
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}

plugin.apply(ctx)

console.log('\n== slot registration ==')
check('every inject callback completed', registrations.every((entry) => entry.pending === false),
  JSON.stringify(registrations.filter((entry) => entry.pending).map((entry) => entry.injectName)))
check('three seats are registered', registrations.length === 3,
  JSON.stringify(registrations.map((entry) => entry.injectName)))

const turnTail = registrations.find((entry) => entry.injectName === 'conversation.chat.turnTail')
const tracker = registrations.find((entry) => entry.injectName === 'conversation.chat.assistant-actions')
const settings = registrations.find((entry) => entry.injectName === 'settings.section')

check('the revert button claims the turn tail chain', turnTail !== undefined)
check('the turn tail entry carries its own id', turnTail?.options?.id === 'chat-git-revert', String(turnTail?.options?.id))
check('the turn tail entry outranks the sibling entry at -1',
  typeof turnTail?.options?.priority === 'number' && turnTail.options.priority < -1,
  String(turnTail?.options?.priority))
check('the turn tail entry declares a selector', typeof turnTail?.options?.select === 'function')
check('the tracker rides the additive assistant-actions list', tracker !== undefined)
check('the tracker declares its own id', tracker?.options?.id === 'chat-git-session-tracker',
  String(tracker?.options?.id))
check('the tracker declares no selector, so it competes with nothing',
  tracker?.options?.select === undefined)
check('the settings page registers a section', settings !== undefined)
check('the settings section id is chat-git', settings?.options?.id === 'chat-git', String(settings?.options?.id))
check('the settings section carries a nav label', settings?.options?.label === '对话 Git',
  String(settings?.options?.label))

// ---------------------------------------------------------------------------
// The synchronous chain selector
// ---------------------------------------------------------------------------

const select = turnTail.options.select

console.log('\n== chain selector: cold index ==')
check('a cold index declines, leaving the sibling entry in place',
  select({ turn: { turn: 1 }, seq: 10 }) === null, JSON.stringify(select({ turn: { turn: 1 }, seq: 10 })))
check('a malformed owner declines', select({}) === null)
check('a non-numeric turn declines', select({ turn: { turn: 'one' }, seq: 1 }) === null)

console.log('\n== chain selector: warm index ==')
// Rendering the tracker is what teaches the plugin which session is live and
// warms the index; this is the real cooperation between the two seats.
render(ReactStub.createElement(tracker.component, { sessionId: 'session-live-1' }))
await tick()

check('the tracker renders nothing at all',
  render(ReactStub.createElement(tracker.component, { sessionId: 'session-live-1' })) === null)
check('the tracker asked the host for this session',
  requests.some((entry) => entry.url === '/chat-git/state' && entry.body.sessionId === 'session-live-1'),
  JSON.stringify(requests))

const claimed = select({ turn: { turn: 1 }, seq: 10 })
check('a checkpointed turn is claimed', claimed !== null, JSON.stringify(claimed))
check('the claimed turn number is passed through', claimed?.turn === 1, JSON.stringify(claimed?.turn))
check('the claimed sequence is passed through', claimed?.seq === 10, JSON.stringify(claimed?.seq))
check('the checkpoint rides along, so the button needs no fetch',
  claimed?.commit?.sha === 'aaaa1111', JSON.stringify(claimed?.commit))
check('a turn with no checkpoint still declines',
  select({ turn: { turn: 7 }, seq: 70 }) === null, JSON.stringify(select({ turn: { turn: 7 }, seq: 70 })))

// ---------------------------------------------------------------------------
// Rendered output
// ---------------------------------------------------------------------------

console.log('\n== the revert button renders ==')
check('nothing renders without a matched checkpoint',
  render(ReactStub.createElement(turnTail.component, { sessionId: 'session-live-1', matched: null })) === null)

const armed = render(ReactStub.createElement(turnTail.component, {
  sessionId: 'session-live-1',
  matched: { turn: 2, seq: 20, commit: { sha: 'bbbb2222', short: 'bbbb222', subject: 'Ai-coding：把登录返回值改成 ok' } },
}))
const buttons = findAll(armed, 'button')
check('one button renders for a checkpointed turn', buttons.length === 1, String(buttons.length))
check('the button is labelled 撤回', textOf(buttons[0]) === '撤回', JSON.stringify(textOf(buttons[0])))
check('the button is an explicit button element', buttons[0]?.props?.type === 'button')
check('the tooltip names the checkpoint commit',
  String(buttons[0]?.props?.title ?? '').includes('bbbb222'), String(buttons[0]?.props?.title))
check('the tooltip names the rollback command',
  String(buttons[0]?.props?.title ?? '').includes('git checkout'), String(buttons[0]?.props?.title))

console.log('\n== the settings page renders ==')
const sectionNode = ReactStub.createElement(settings.component, { close: () => {} })
let section = render(sectionNode)
const coldText = textOf(section)
check('the section names the feature', coldText.includes('对话 Git'), JSON.stringify(coldText))
check('the section offers a detection control', coldText.includes('检测 Git'), JSON.stringify(coldText))
check('the section offers the download jump', coldText.includes('下载 Git'), JSON.stringify(coldText))
check('the section reports the checkpoint behaviour', coldText.includes('git init'), JSON.stringify(coldText))
check('the section says the check happens at conversation start',
  coldText.includes('对话开始时'), JSON.stringify(coldText))
check('the section states the commit subject format',
  coldText.includes('Ai-coding：'), JSON.stringify(coldText))
check('the section mentions the detection command', coldText.includes('git --version'), JSON.stringify(coldText))
check('before probing, the section says so', coldText.includes('尚未检测'), JSON.stringify(coldText))

const links = findAll(section, 'a')
check('the download control links to the official page',
  links.some((link) => link.props?.href === 'https://git-scm.com/downloads'),
  JSON.stringify(links.map((link) => link.props?.href)))
check('the download link opens in a new tab',
  links.every((link) => link.props?.target === '_blank' && String(link.props?.rel ?? '').includes('noreferrer')),
  JSON.stringify(links.map((link) => ({ target: link.props?.target, rel: link.props?.rel }))))
check('the switch is rendered as a switch role',
  findAll(section, 'button').some((button) => button.props?.role === 'switch'),
  JSON.stringify(findAll(section, 'button').map((button) => button.props?.role)))
check('the switch starts disabled until the host has been read',
  findAll(section, 'button').find((button) => button.props?.role === 'switch')?.props?.disabled === true)

// The probe result arrives asynchronously; re-rendering with the same element
// reads the state the promise already wrote.
await tick()
section = render(sectionNode)
const warmText = textOf(section)
check('the section reported the host read at mount',
  requests.some((entry) => entry.url === '/chat-git/state'), JSON.stringify(requests.map((entry) => entry.url)))
check('the detected git version is shown', warmText.includes('已检测到 git version'),
  JSON.stringify(warmText))
check('the state file path is surfaced', warmText.includes('chat-git.json'), JSON.stringify(warmText))
check('the persistence note is shown', warmText.includes('磁盘'), JSON.stringify(warmText))
const warmSwitch = findAll(section, 'button').find((button) => button.props?.role === 'switch')
check('the switch renders as on once the host reported the preference on',
  warmSwitch?.props?.['aria-checked'] === true, JSON.stringify(warmSwitch?.props?.['aria-checked']))
check('the switch is enabled once the host has been read', warmSwitch?.props?.disabled === false,
  String(warmSwitch?.props?.disabled))

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
