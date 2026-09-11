/**
 * Verification harness for dsh-chat-git's browser half.
 *
 * The client bundle cannot be run in a browser from here, but everything that
 * decides *what the shell does* can be checked in Node: the
 * `window.__ModuleLoader__` wrapper shape, the exported plugin surface, the two
 * slot registrations, the restore-into-the-icon-row wiring, the message→turn
 * resolution, the revert flow, and the rendered output of both seats.
 *
 *   node test/client.mjs
 *
 * The renderer below is a deliberately small React stand-in — function
 * components are expanded recursively and `useState` persists across renders —
 * which is enough to drive the two-step confirm and observe the settings page
 * go from "not probed yet" to a detected version without a browser.
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

/** Shallow dependency comparison, as React performs it. */
function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (!Object.is(previous[index], next[index])) return false
  }
  return true
}

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
  /**
   * Deps-aware, because a stub that re-runs effects on every render would reset
   * the button's armed state on every render and make the two-step confirm
   * impossible to exercise — the very behaviour under test.
   */
  useEffect(fn, deps) {
    const store = hookStore.get(currentComponent) ?? []
    const index = hookCursor++
    const previous = store[index]
    if (previous !== undefined && sameDeps(previous, deps)) return undefined
    store[index] = deps === undefined ? [] : [...deps]
    hookStore.set(currentComponent, store)
    return fn()
  },
  /** Memoized by deps, so a stable callback does not re-trigger its effect. */
  useCallback(fn, deps) {
    const store = hookStore.get(currentComponent) ?? []
    const index = hookCursor++
    const previous = store[index]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn
    store[index] = { fn, deps }
    hookStore.set(currentComponent, store)
    return fn
  },
}

/** Expand a tree of elements into host elements, invoking function components. */
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
// A minimal DOM, so the plugin's own stylesheet can be observed
// ---------------------------------------------------------------------------

/** Elements appended to `document.head`. */
const styleElements = []

const headStub = {
  appendChild(element) {
    element.parentNode = {
      removeChild: () => {
        const at = styleElements.indexOf(element)
        if (at >= 0) styleElements.splice(at, 1)
      },
    }
    styleElements.push(element)
  },
}

globalThis.document = {
  head: headStub,
  getElementById: (id) => styleElements.find((element) => element.id === id) ?? null,
  createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null }),
}

// ---------------------------------------------------------------------------
// The host the client talks to
// ---------------------------------------------------------------------------

/** Requests the client made, for asserting the host contract it depends on. */
const requests = []

/**
 * The preference the fake host currently holds.
 *
 * Keeping it here is what makes partial patches faithful: the real host merges
 * a patch into the stored object, so a stub that rebuilt the preference from
 * the request body alone would reject patches the host accepts.
 */
let storedSummary = { mode: 'current', provider: '', model: '' }

/** Host answers for the routes the client half needs. */
globalThis.fetch = async (url, init) => {
  const body = init === undefined ? {} : JSON.parse(init.body)
  requests.push({ url, body })
  let payload
  if (url === '/chat-git/state') {
    // The host serves a session read and the settings page's global read
    // through the same route. Mirroring that split here is what keeps this
    // stub honest: an empty sessionId carries no checkpoints and no workspace
    // root, and a stub that returned both anyway once hid a settings bug.
    const scoped = typeof body.sessionId === 'string' && body.sessionId !== ''
    payload = {
      ok: true,
      value: {
        enabled: true,
        summary: { ...storedSummary },
        committed: true,
        stateFile: 'C:/tmp/chat-git.json',
        cwd: scoped ? 'C:/ws' : '',
        git: { available: true, version: 'git version 2.54.0.windows.1', error: '' },
        commits: scoped
          ? [
            { sha: 'aaaa1111', short: 'aaaa111', subject: 'Ai-coding：实现登录接口', turn: 1, at: 2 },
            { sha: 'bbbb2222', short: 'bbbb222', subject: 'Ai-coding：把登录返回值改成 ok', turn: 2, at: 3 },
          ]
          : [],
      },
    }
  } else if (url === '/chat-git/models') {
    payload = {
      ok: true,
      value: {
        providers: [
          {
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [
              { id: 'deepseek-v4-flash', name: 'V4 Flash' },
              { id: 'deepseek-v4-pro', name: 'V4 Pro' },
            ],
          },
          { id: 'bare-provider', name: 'Bare', models: [] },
        ],
        current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        configured: { ...storedSummary },
      },
    }
  } else if (url === '/chat-git/set-summary') {
    // Mirrors the host: the patch merges into the stored preference, the reply
    // is the whole object, and a custom mode with no route is refused.
    const next = { ...storedSummary }
    if (typeof body.mode === 'string') next.mode = body.mode
    if (typeof body.provider === 'string') next.provider = body.provider
    if (typeof body.model === 'string') next.model = body.model
    if (next.mode === 'custom' && (next.provider === '' || next.model === '')) {
      payload = {
        ok: false,
        error: { code: 'bad-preference', message: 'a custom summary model needs both a provider and a model' },
      }
    } else {
      storedSummary = next
      payload = { ok: true, value: { summary: { ...next } } }
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
  // The shell primitives are absent in this environment; the bundle must cope.
  if (name === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('not installed')
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

/** Disposers the plugin registered through `ctx.effect`. */
const effects = []

const forkedSessions = []

const ctx = {
  sessions: {
    fork: async ({ sessionId, atSeq }) => {
      forkedSessions.push({ sessionId, atSeq })
      return 'session-fork-9'
    },
    open: () => {},
  },
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
    const disposer = fn()
    if (typeof disposer === 'function') effects.push(disposer)
    return disposer
  },
}

plugin.apply(ctx)

console.log('\n== slot registration ==')
check('every inject callback completed', registrations.every((entry) => entry.pending === false),
  JSON.stringify(registrations.filter((entry) => entry.pending).map((entry) => entry.injectName)))
check('two seats are registered', registrations.length === 2,
  JSON.stringify(registrations.map((entry) => entry.injectName)))

const actions = registrations.find((entry) => entry.injectName === 'conversation.chat.assistant-actions')
const settings = registrations.find((entry) => entry.injectName === 'settings.section')

check('the revert button claims the additive assistant action list', actions !== undefined)
check('the action list is additive, never a chain',
  actions?.options?.select === undefined && actions?.options?.priority === undefined,
  JSON.stringify(actions?.options))
check('the revert button declares its own id', actions?.options?.id === 'chat-git-revert',
  String(actions?.options?.id))
check('the revert button carries a label', actions?.options?.label === '回退仓库和对话',
  String(actions?.options?.label))
check('the revert button has an ordering', typeof actions?.options?.order === 'number',
  String(actions?.options?.order))
check('the settings page registers a section', settings !== undefined)
check('the settings section id is chat-git', settings?.options?.id === 'chat-git', String(settings?.options?.id))
check('the settings section carries a nav label', settings?.options?.label === '对话 Git',
  String(settings?.options?.label))

console.log('\n== the plugin stylesheet ==')
check('one stylesheet is installed', styleElements.length === 1, String(styleElements.length))
check('the stylesheet is namespaced to this plugin', styleElements[0]?.id === 'dsh-chat-git-style',
  String(styleElements[0]?.id))
check('the stylesheet styles only this plugin classes',
  String(styleElements[0]?.textContent).includes('.dsh-chat-git-icon')
  && !String(styleElements[0]?.textContent).includes('body'),
  String(styleElements[0]?.textContent).slice(0, 60))
check('a second apply does not double the stylesheet', (() => {
  const before = styleElements.length
  plugin.apply(ctx)
  return styleElements.length === before
})(), String(styleElements.length))

// ---------------------------------------------------------------------------
// Message → turn resolution
// ---------------------------------------------------------------------------

/** The snapshot the fake `useChat` selector is handed; swapped per scenario. */
let chatSnapshot = null

const useChatStub = (selector) => selector(chatSnapshot)

/** Build a snapshot whose turn-tail nodes carry the ids the seat is keyed by. */
function snapshotWith(entries) {
  return {
    nodes: {
      values: () => entries.map((entry) => ({
        kind: 'turn-tail',
        data: {
          turn: entry.turn,
          closing: entry.closing === undefined
            ? { finalNode: { seq: entry.seq, messageId: entry.messageId } }
            : entry.closing,
        },
      })),
    },
  }
}

chatSnapshot = snapshotWith([
  { turn: 1, seq: 10, messageId: 'msg-1' },
  { turn: 2, seq: 20, messageId: 'msg-2' },
])

const RevertSeat = actions.component

/** Render the seat for one message id and settle its checkpoint read. */
async function seatFor(messageId, sessionId = 'session-live-1') {
  render(ReactStub.createElement(RevertSeat, { sessionId, messageId, useChat: useChatStub }))
  await tick()
  return render(ReactStub.createElement(RevertSeat, { sessionId, messageId, useChat: useChatStub }))
}

console.log('\n== message -> turn resolution ==')
const unmatched = await seatFor('msg-does-not-exist')
check('a message that no turn owns renders nothing', unmatched === null, JSON.stringify(unmatched))

const matched = await seatFor('msg-2')
check('the turn owning the message is claimed', matched !== null)
check('the seat read this session\'s checkpoints',
  requests.some((entry) => entry.url === '/chat-git/state' && entry.body.sessionId === 'session-live-1'))

const stateReads = requests.filter((entry) => entry.url === '/chat-git/state'
  && entry.body.sessionId === 'session-live-1').length
await seatFor('msg-2')
check('checkpoint reads are shared per session rather than repeated per button',
  requests.filter((entry) => entry.url === '/chat-git/state'
    && entry.body.sessionId === 'session-live-1').length === stateReads,
  String(requests.filter((entry) => entry.url === '/chat-git/state').length))

chatSnapshot = snapshotWith([{ turn: 5, seq: 50, messageId: 'msg-5', closing: null }])
const noClosing = await seatFor('msg-5')
check('a turn tail with no closing assistant message renders nothing', noClosing === null)

chatSnapshot = { nodes: { values: () => [null, { kind: 'assistant-step' }, { kind: 'turn-tail', data: null }] } }
const junkSnapshot = await seatFor('msg-2')
check('an unexpected snapshot shape renders nothing instead of throwing', junkSnapshot === null)

chatSnapshot = {}
check('a snapshot without a node store renders nothing', (await seatFor('msg-2')) === null)

chatSnapshot = snapshotWith([{ turn: 2, seq: 20, messageId: 'msg-2' }])

// ---------------------------------------------------------------------------
// Rendered output
// ---------------------------------------------------------------------------

console.log('\n== the revert button renders beside copy ==')
const button = await seatFor('msg-2')
const buttons = findAll(button, 'button')
check('exactly one icon button renders for a checkpointed turn', buttons.length === 1, String(buttons.length))
check('the button matches the shell icon-button size class',
  String(buttons[0]?.props?.className).includes('dsh-chat-git-icon'), String(buttons[0]?.props?.className))
check('the button is an explicit button element', buttons[0]?.props?.type === 'button')
check('the button is icon-only, drawn as an inline svg',
  findAll(button, 'svg').length === 1 && textOf(button).trim() === '', JSON.stringify(textOf(button)))
check('the tooltip names both the repository and the conversation',
  buttons[0]?.props?.['aria-label'] === '回退仓库和对话', String(buttons[0]?.props?.['aria-label']))
check('the native title mirrors the tooltip',
  buttons[0]?.props?.title === '回退仓库和对话', String(buttons[0]?.props?.title))
check('the button starts unarmed', buttons[0]?.props?.['data-armed'] === undefined)

console.log('\n== the two-step confirm ==')
buttons[0].props.onClick()
const armed = await seatFor('msg-2')
const armedButton = findAll(armed, 'button')[0]
check('the first click arms instead of acting', armedButton?.props?.['data-armed'] === 'true',
  String(armedButton?.props?.['data-armed']))
check('the armed tooltip asks for confirmation', armedButton?.props?.['aria-label'] === '再点一次确认回退',
  String(armedButton?.props?.['aria-label']))
check('the armed state names the checkpoint being restored',
  textOf(armed).includes('bbbb222'), JSON.stringify(textOf(armed)))
check('arming alone performs no request',
  !requests.some((entry) => entry.url === '/chat-git/revert'))

console.log('\n== the revert flow ==')
armedButton.props.onClick()
await tick()
await tick()
const revertCall = requests.find((entry) => entry.url === '/chat-git/revert')
check('a confirmed click reverts on the host', revertCall !== undefined, JSON.stringify(requests.map((r) => r.url)))
check('the revert names the turn\'s checkpoint', revertCall?.body?.sha === 'bbbb2222', JSON.stringify(revertCall?.body))
check('the revert names the conversation', revertCall?.body?.sessionId === 'session-live-1',
  JSON.stringify(revertCall?.body))
check('the conversation is forked at the turn\'s closing sequence',
  forkedSessions.length === 1 && forkedSessions[0].atSeq === 20, JSON.stringify(forkedSessions))
check('the fork is told which conversation it came from',
  forkedSessions[0]?.sessionId === 'session-live-1', JSON.stringify(forkedSessions))
const inheritCall = requests.find((entry) => entry.url === '/chat-git/inherit')
check('the surviving checkpoints are handed to the fork', inheritCall !== undefined,
  JSON.stringify(requests.map((r) => r.url)))
check('inherit names both sessions and the kept turn',
  inheritCall?.body?.from === 'session-live-1' && inheritCall?.body?.to === 'session-fork-9'
  && inheritCall?.body?.turn === 2, JSON.stringify(inheritCall?.body))

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

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
  findAll(section, 'button').some((btn) => btn.props?.role === 'switch'),
  JSON.stringify(findAll(section, 'button').map((btn) => btn.props?.role)))
check('the switch starts disabled until the host has been read',
  findAll(section, 'button').find((btn) => btn.props?.role === 'switch')?.props?.disabled === true)

const coldSwitches = findAll(section, 'button').filter((btn) => btn.props?.role === 'switch')
check('the checkpoint preference renders a switch', coldSwitches.length === 1, String(coldSwitches.length))
check('the summary card is titled', coldText.includes('AI 总结提交信息'), JSON.stringify(coldText))
check('the summary card promises the fallback',
  coldText.includes('回退为提示词'), JSON.stringify(coldText))

const coldModes = findAll(section, 'button').filter((btn) => btn.props?.role === 'radio')
check('the summary model offers three modes', coldModes.length === 3, String(coldModes.length))
check('the three modes are the expected ones',
  coldModes.map((btn) => textOf(btn)).join('|') === '关闭|使用当前模型|指定模型',
  coldModes.map((btn) => textOf(btn)).join('|'))
check('the default mode shows as selected before the host is read',
  JSON.stringify(coldModes.map((btn) => btn.props?.['aria-checked'])) === '[false,true,false]',
  JSON.stringify(coldModes.map((btn) => btn.props?.['aria-checked'])))
check('the modes cannot be clicked before the host has been read',
  coldModes.every((btn) => btn.props?.disabled === true),
  JSON.stringify(coldModes.map((btn) => btn.props?.disabled)))
check('the pickers are hidden while the mode is not custom',
  findAll(section, 'select').length === 0, String(findAll(section, 'select').length))

// The probe result arrives asynchronously; re-rendering with the same element
// reads the state the promise already wrote.
await tick()
section = render(sectionNode)
const warmText = textOf(section)
check('the section read the host without a session',
  requests.some((entry) => entry.url === '/chat-git/state' && entry.body.sessionId === ''),
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/state').map((entry) => entry.body)))
check('the detected git version is shown', warmText.includes('已检测到 git version'), JSON.stringify(warmText))
check('the state file path is surfaced', warmText.includes('chat-git.json'), JSON.stringify(warmText))
check('the persistence note is shown', warmText.includes('磁盘'), JSON.stringify(warmText))
const warmSwitch = findAll(section, 'button').find((btn) => btn.props?.role === 'switch')
check('the switch renders as on once the host reported the preference on',
  warmSwitch?.props?.['aria-checked'] === true, JSON.stringify(warmSwitch?.props?.['aria-checked']))
check('the switch is enabled once the host has been read', warmSwitch?.props?.disabled === false,
  String(warmSwitch?.props?.disabled))

const warmModes = findAll(section, 'button').filter((btn) => btn.props?.role === 'radio')
check('the stored mode is the selected one', warmModes[1]?.props?.['aria-checked'] === true,
  JSON.stringify(warmModes.map((btn) => btn.props?.['aria-checked'])))
check('the modes are enabled once the host has been read',
  warmModes.every((btn) => btn.props?.disabled === false),
  JSON.stringify(warmModes.map((btn) => btn.props?.disabled)))
check('the current mode names the concrete route',
  warmText.includes('deepseek-official / deepseek-v4-flash'), JSON.stringify(warmText))
check('the model catalogue was read from the host',
  requests.some((entry) => entry.url === '/chat-git/models'),
  JSON.stringify(requests.map((entry) => entry.url)))

console.log('\n== choosing a summary model ==')
// Selecting the custom mode must carry a usable route in the same patch: the
// host refuses a custom mode with no route, so sending the mode alone would
// answer the click with an error.
warmModes[2].props.onClick()
await tick()
const customCall = requests.find((entry) => entry.url === '/chat-git/set-summary')
check('choosing the custom mode sends a complete route',
  customCall?.body?.mode === 'custom'
  && customCall?.body?.provider === 'deepseek-official'
  && customCall?.body?.model === 'deepseek-v4-flash',
  JSON.stringify(customCall?.body))
check('choosing a mode never touches the checkpoint preference',
  !requests.some((entry) => entry.url === '/chat-git/set-enabled'),
  JSON.stringify(requests.filter((entry) => entry.url.startsWith('/chat-git/set')).map((entry) => entry.url)))

section = render(sectionNode)
const customText = textOf(section)
const pickers = findAll(section, 'select')
check('the custom mode reveals both pickers', pickers.length === 2, String(pickers.length))
check('the provider picker lists the registered providers',
  pickers[0]?.props?.children?.length === 2, String(pickers[0]?.props?.children?.length))
check('a provider with no registered model is not offered',
  !(pickers[0]?.props?.children ?? []).some((option) => option?.props?.value === 'bare-provider'),
  JSON.stringify((pickers[0]?.props?.children ?? []).map((option) => option?.props?.value)))
check('the model picker lists that provider models',
  pickers[1]?.props?.children?.length === 3, String(pickers[1]?.props?.children?.length))
check('the picker reflects the stored route',
  pickers[0]?.props?.value === 'deepseek-official' && pickers[1]?.props?.value === 'deepseek-v4-flash',
  JSON.stringify({ provider: pickers[0]?.props?.value, model: pickers[1]?.props?.value }))
check('the custom pickers explain where the list comes from',
  customText.includes('已注册的模型路由'), JSON.stringify(customText))

// Changing the model alone must keep the already chosen provider.
findAll(section, 'select')[1].props.onChange({ target: { value: 'deepseek-v4-pro' } })
await tick()
const modelCall = requests.filter((entry) => entry.url === '/chat-git/set-summary').at(-1)
check('choosing a model sends that model on the custom mode',
  modelCall?.body?.mode === 'custom' && modelCall?.body?.model === 'deepseek-v4-pro',
  JSON.stringify(modelCall?.body))
check('choosing a model does not restate the provider',
  modelCall?.body?.provider === undefined, JSON.stringify(modelCall?.body))

// A route the registry no longer lists must stay selectable, or simply opening
// this page would quietly make the user's configuration unreachable.
findAll(section, 'select')[1].props.onChange({ target: { value: 'retired-model' } })
await tick()
section = render(sectionNode)
const retiredPicker = findAll(section, 'select')[1]
check('a stored model the registry no longer lists stays selectable',
  (retiredPicker?.props?.children ?? []).some((option) => option?.props?.value === 'retired-model'),
  JSON.stringify((retiredPicker?.props?.children ?? []).map((option) => option?.props?.value)))
check('the stored model is the selected one', retiredPicker?.props?.value === 'retired-model',
  String(retiredPicker?.props?.value))

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
