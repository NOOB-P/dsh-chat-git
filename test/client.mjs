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
  /**
   * React 18's external-store hook. Subscribing is a no-op here because the
   * tests re-render by hand; the snapshot read is what matters.
   */
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
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

/** The checkpoint master switch, the History-tab preference, and the interval. */
let storedEnabled = true
let storedHistory = true
let storedInterval = 1

/** The timeline the fake host serves, including one turn that never closed. */
let timelineTurns = [
  {
    turn: 1,
    at: 0,
    prompt: '实现登录接口',
    seq: 10,
    steps: 2,
    endReason: 'completed',
    commit: { sha: 'aaaa1111', short: 'aaaa111', subject: 'Ai-coding：实现登录接口' },
  },
  {
    turn: 2,
    at: 0,
    prompt: '把登录返回值改成 ok',
    seq: 20,
    steps: 1,
    endReason: 'completed',
    commit: { sha: 'bbbb2222', short: 'bbbb222', subject: 'Ai-coding：把登录返回值改成 ok' },
  },
  // Still running: no closing sequence, so it has no fork boundary.
  { turn: 3, at: 0, prompt: '正在进行的一轮', seq: null, steps: 0, endReason: '', commit: null },
]

/**
 * The whole prompt behind each turn, as `/chat-git/turn-prompt` serves it.
 *
 * Deliberately different from the `prompt` on {@link timelineTurns}: that one is
 * the display clip, and a resend that quietly sent the clip instead of the whole
 * prompt is exactly the bug this separation makes observable.
 */
const wholePrompts = {
  1: '实现登录接口，并且把返回值统一改成 { ok: true } 的形式，另外记得补上失败分支的测试。',
  2: '把登录返回值改成 ok，并且为失败分支补一个单元测试。',
  3: '正在进行的一轮',
}

/** Prompts the fake conversation service was asked to send, in order. */
const sentPrompts = []

/** Sessions the fake workspace service archived. */
const archived = []

/**
 * Model routes the fake `/chat-git/set-model` route accepted, in order.
 *
 * Recorded rather than merely answered: the whole point of the picker is the
 * *order* — the selection has to be written before `sessions.create`/`fork`,
 * because both build their child from the default selection.
 */
const appliedModels = []

/**
 * How the fake `/chat-git/set-model` route refuses, when it should.
 *
 * Set to an error code to make the route refuse: a deployment whose model layer
 * rejects the write must leave the conversation exactly where it was.
 */
let modelSwitchRefused = ''

/**
 * Ordered log of the writes that decide which model the rebuilt line runs on.
 *
 * The order is the whole point: `sessions.create`/`fork` take their route from
 * the default selection, so a `/chat-git/set-model` that arrived *after* either
 * call would leave the new line on the old model while looking correct.
 */
const modelOrder = []

/**
 * The repository the fake host reports for the workspace pane.
 *
 * Deliberately its own data, not derived from `timelineTurns`: the two panes
 * read two routes, and a stub that fed the commit list from the turn list would
 * hide exactly the coupling this split removes.
 */
const repoCommits = [
  {
    sha: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
    short: 'aaaa111',
    subject: 'Ai-coding：实现登录接口',
    date: '2026-09-12T10:00:00+08:00',
    author: 'ClownLMe',
  },
  {
    sha: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
    short: 'bbbb222',
    subject: 'Ai-coding：把登录返回值改成 ok',
    date: '2026-09-12T10:30:00+08:00',
    author: 'ClownLMe',
  },
]

/** The workspace state the fake `/chat-git/repo` route answers with. */
let repoState = {
  cwd: 'C:/ws',
  root: 'C:/ws',
  git: { available: true, version: 'git version 2.54.0.windows.1', error: '' },
  branch: 'main',
  head: repoCommits[1].sha,
  // Where the *worktree* stands, which is a different question from HEAD once a
  // restore has happened: restoring leaves HEAD alone on purpose, so the host
  // remembers the position itself. The fixture starts already restored to the
  // first commit — the two differ on purpose, because a fixture where position
  // and HEAD agree could not tell the marker apart from a plain HEAD highlight.
  position: repoCommits[0].sha,
  positionKnown: true,
  dirty: false,
  commits: repoCommits,
}

/**
 * How the fake `/chat-git/repo` route fails, when it should.
 *
 * `repoFailure` is a **bare string**, mirroring the web server's own 404 body
 * (`{ error: 'not found' }`) — the shape that used to be read as
 * `error.message` and came back `undefined`, so the pane showed a generic
 * failure naming the repository when the route was what was missing.
 * `repoUnreachable` rejects the fetch instead, which is what a host process
 * that does not serve the route at all looks like from the browser.
 */
let repoFailure = ''
let repoUnreachable = false

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
        enabled: storedEnabled,
        // Mirrors the host: the settings page's global read also carries the
        // History-tab preference, which is what the tab's registration follows.
        history: storedHistory,
        interval: storedInterval,
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
  } else if (url === '/chat-git/timeline') {
    payload = { ok: true, value: { cwd: 'C:/ws', turns: timelineTurns } }
  } else if (url === '/chat-git/turn-prompt') {
    // The whole prompt, unclipped — deliberately longer than the card's clip so
    // a resend that used the displayed prompt instead would be visible.
    payload = { ok: true, value: { turn: body.turn, prompt: wholePrompts[body.turn] ?? '' } }
  } else if (url === '/chat-git/repo') {
    if (repoUnreachable) throw new Error('route not mounted')
    // Mirrors the host: an empty sessionId is refused, because the workspace
    // pane always knows which conversation it is looking at.
    payload = repoFailure !== ''
      ? { ok: false, error: repoFailure }
      : body.sessionId === ''
        ? { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } }
        : { ok: true, value: { ...repoState } }
  } else if (url === '/chat-git/restore') {
    // Mirrors the host: the worktree moves while HEAD stays, so the position the
    // pane marks is the restored commit and it is now a *known* position.
    repoState = { ...repoState, position: body.sha, positionKnown: true }
    payload = { ok: true, value: { restored: body.sha, removed: ['extra.txt'] } }
  } else if (url === '/chat-git/set-model') {
    // Mirrors the host: the route validates against the live registry before it
    // writes anything, so an unregistered route is refused rather than stored.
    if (modelSwitchRefused !== '') {
      payload = { ok: false, error: { code: modelSwitchRefused, message: modelSwitchRefused } }
    } else if (body.provider === 'no-such-provider' || body.model === 'no-such-model') {
      payload = {
        ok: false,
        error: { code: 'unknown-model', message: 'that model is not registered in this deployment' },
      }
    } else {
      appliedModels.push({ provider: body.provider, model: body.model })
      modelOrder.push('set-model')
      payload = { ok: true, value: { provider: body.provider, model: body.model } }
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
  } else if (url === '/chat-git/set-enabled') {
    storedEnabled = body.enabled === true
    payload = { ok: true, value: { enabled: storedEnabled } }
  } else if (url === '/chat-git/set-history') {
    storedHistory = body.history === true
    payload = { ok: true, value: { history: storedHistory } }
  } else if (url === '/chat-git/set-interval') {
    // Mirrors the host's own validation: anything outside 1..10 is refused
    // rather than stored, because 0 would silently stop committing.
    if (Number.isInteger(body.interval) && body.interval >= 1 && body.interval <= 10) {
      storedInterval = body.interval
      payload = { ok: true, value: { interval: storedInterval } }
    } else {
      payload = {
        ok: false,
        error: { code: 'bad-preference', message: 'interval must be an integer between 1 and 10' },
      }
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

/** Sessions the plugin asked the host to create outright (a first-turn resend). */
const createdSessions = []

/**
 * Whether the fake deployment mounts the conversation controller.
 *
 * The resend prefers `ctx.conversation.send` and falls back to the session
 * face's own `prompt`; flipping this is what exercises the second path, so the
 * fallback is covered rather than merely written.
 */
let conversationAvailable = true

/** The injection whose callback is currently running, if any. */
let activeInjection = null

const ctx = {
  sessions: {
    fork: async ({ sessionId, atSeq }) => {
      forkedSessions.push({ sessionId, atSeq })
      modelOrder.push('fork')
      return 'session-fork-9'
    },
    create: async (opts = {}) => {
      createdSessions.push(opts)
      modelOrder.push('create')
      return 'session-new-7'
    },
    open: () => {},
    /** The scope-addressed hop the resend takes to reach `conversation`. */
    scope: () => (conversationAvailable
      ? {
        get: (name) => (name === 'conversation'
          ? { send: async (text) => { sentPrompts.push(text) } }
          : undefined),
      }
      : undefined),
    binding: () => ({
      session: {
        prompt: async (content) => {
          sentPrompts.push(content[0].text)
          return { ok: true, value: { accepted: true } }
        },
      },
    }),
  },
  /** Optional services the plugin probes rather than injecting. */
  get(name) {
    if (name === 'workspaces') {
      return {
        archiveSession: async (sessionId) => { archived.push(sessionId) },
      }
    }
    return undefined
  },
  slots: {
    inject(name, callback) {
      const entry = { injectName: name, pending: true }
      registrations.push(entry)
      activeInjection = entry
      try {
        callback()
      } catch (error) {
        entry.error = String(error)
      } finally {
        activeInjection = null
      }
      return () => {}
    },
    register(options, component) {
      // Resolve the seat this call belongs to, in the order the real registry
      // would: the injection that is running right now, else the injection that
      // owns this slot name. The second case is not a convenience — the History
      // tab re-registers itself from a store subscription, long after every
      // `inject` callback has returned, and a stub that resolved with
      // `registrations.at(-1)` filed that restore under the settings section,
      // making the tab look permanently withdrawn.
      const entry = activeInjection
        ?? registrations.find((candidate) => candidate.injectName === options.name)
        ?? registrations.at(-1)
      entry.options = options
      entry.component = component
      entry.pending = false
      entry.disposed = false
      // A real registry drops the seat when the disposer runs; recording it
      // here is what lets the tests observe a withdrawn tab.
      return () => { entry.disposed = true }
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
check('three seats are registered, the History tab among them', registrations.length === 3,
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
check('the settings section carries a nav label', settings?.options?.label === '仓库增强',
  String(settings?.options?.label))

console.log('\n== the plugin stylesheet ==')
check('one stylesheet is installed', styleElements.length === 1, String(styleElements.length))
check('the stylesheet is namespaced to this plugin', styleElements[0]?.id === 'dsh-chat-git-style',
  String(styleElements[0]?.id))
// The rule this guards is "no product selector is styled", so it looks for a
// bare `body` **selector** rather than the substring: a namespaced class like
// `.dsh-chat-git-commit-body` legitimately contains the word.
check('the stylesheet styles only this plugin classes',
  String(styleElements[0]?.textContent).includes('.dsh-chat-git-icon')
  && !/(^|[},])\s*(body|html|\*)\s*[{,]/.test(String(styleElements[0]?.textContent)),
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
check('the section names the feature', coldText.includes('仓库增强'), JSON.stringify(coldText))
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
check('both preferences render a switch', coldSwitches.length === 2, String(coldSwitches.length))
check('the two switches are the checkpoint and the History tab',
  coldSwitches.map((btn) => btn.props?.['aria-label']).join('|') === '自动检查点|历史标签页',
  coldSwitches.map((btn) => btn.props?.['aria-label']).join('|'))
check('the summary card is titled', coldText.includes('AI 总结提交信息'), JSON.stringify(coldText))
check('the summary card promises the fallback',
  coldText.includes('回退为提示词'), JSON.stringify(coldText))

// The page now carries two radiogroups (the checkpoint interval and the summary
// mode), so a group is read out of its own node rather than by collecting every
// radio on the page — the earlier page-wide collection silently re-labelled the
// interval buttons as summary modes.
const radioGroupOf = (tree, label) => findAll(tree, 'div')
  .find((node) => node.props?.role === 'radiogroup' && node.props?.['aria-label'] === label)
const radiosIn = (tree, label) => findAll(radioGroupOf(tree, label), 'button')
  .filter((btn) => btn.props?.role === 'radio')

const coldModes = radiosIn(section, '总结模型')
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

console.log('\n== the automatic save interval ==')
const coldInterval = radiosIn(section, '自动保存间隔')
check('the interval offers the three choices', coldInterval.length === 3, String(coldInterval.length))
check('the choices are every turn, every 2, every 3',
  coldInterval.map((btn) => textOf(btn)).join('|') === '每轮|每 2 轮|每 3 轮',
  coldInterval.map((btn) => textOf(btn)).join('|'))
check('the default is every turn before the host is read',
  JSON.stringify(coldInterval.map((btn) => btn.props?.['aria-checked'])) === '[true,false,false]',
  JSON.stringify(coldInterval.map((btn) => btn.props?.['aria-checked'])))
check('the interval cannot be changed before the host has been read',
  coldInterval.every((btn) => btn.props?.disabled === true),
  JSON.stringify(coldInterval.map((btn) => btn.props?.disabled)))
check('the interval hint says the conversation is unaffected',
  coldText.includes('对话本身每一轮都会被记录'), JSON.stringify(coldText))
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

const warmModes = radiosIn(section, '总结模型')
check('the stored mode is the selected one', warmModes[1]?.props?.['aria-checked'] === true,
  JSON.stringify(warmModes.map((btn) => btn.props?.['aria-checked'])))
check('the modes are enabled once the host has been read',
  warmModes.every((btn) => btn.props?.disabled === false),
  JSON.stringify(warmModes.map((btn) => btn.props?.disabled)))

const warmInterval = radiosIn(section, '自动保存间隔')
check('the interval is enabled once the host has been read',
  warmInterval.every((btn) => btn.props?.disabled === false),
  JSON.stringify(warmInterval.map((btn) => btn.props?.disabled)))
check('the interval reflects the stored preference',
  JSON.stringify(warmInterval.map((btn) => btn.props?.['aria-checked'])) === '[true,false,false]',
  JSON.stringify(warmInterval.map((btn) => btn.props?.['aria-checked'])))
// Choosing an interval is its own route: it must not be mistaken for the
// checkpoint switch, which would silently disable checkpointing instead.
warmInterval[2].props.onClick()
await tick()
const intervalCall = requests.find((entry) => entry.url === '/chat-git/set-interval')
check('choosing 3 turns sends the interval on its own route',
  intervalCall?.body?.interval === 3, JSON.stringify(intervalCall?.body))
check('choosing an interval never touches the checkpoint switch',
  !requests.some((entry) => entry.url === '/chat-git/set-enabled'),
  JSON.stringify(requests.filter((entry) => entry.url.startsWith('/chat-git/set')).map((entry) => entry.url)))
section = render(sectionNode)
const afterInterval = radiosIn(section, '自动保存间隔')
check('the interval control adopts the host answer',
  JSON.stringify(afterInterval.map((btn) => btn.props?.['aria-checked'])) === '[false,false,true]',
  JSON.stringify(afterInterval.map((btn) => btn.props?.['aria-checked'])))
// Back to every turn, so the later checks read the default state.
radiosIn(section, '自动保存间隔')[0].props.onClick()
await tick()
section = render(sectionNode)
check('the interval can be returned to every turn',
  intervalCall !== undefined
  && radiosIn(section, '自动保存间隔')[0]?.props?.['aria-checked'] === true,
  JSON.stringify(radiosIn(section, '自动保存间隔').map((btn) => btn.props?.['aria-checked'])))
check('the current mode names the concrete route',
  warmText.includes('deepseek-official / deepseek-v4-flash'), JSON.stringify(warmText))
check('the model catalogue was read from the host',
  requests.some((entry) => entry.url === '/chat-git/models'),
  JSON.stringify(requests.map((entry) => entry.url)))

console.log('\n== choosing a summary model ==')
// Selecting the custom mode must carry a usable route in the same patch: the
// host refuses a custom mode with no route, so sending the mode alone would
// answer the click with an error.
radiosIn(section, '总结模型')[2].props.onClick()
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

// ---------------------------------------------------------------------------
// The History view, in the tab strip beside 对话 and 轨迹
// ---------------------------------------------------------------------------

const conversationTab = registrations.find((entry) => entry.injectName === 'conversation.view')

console.log('\n== the History tab ==')
check('the History view rides the conversation tab strip', conversationTab !== undefined)
check('the tab declares its own id', conversationTab?.options?.id === 'chat-git-history',
  String(conversationTab?.options?.id))
check('the tab is labelled 历史', conversationTab?.options?.label === '历史',
  String(conversationTab?.options?.label))
check('the tab has an ordering', typeof conversationTab?.options?.order === 'number',
  String(conversationTab?.options?.order))
check('the tab entry is purely additive',
  conversationTab?.options?.select === undefined && conversationTab?.options?.key === undefined,
  JSON.stringify(conversationTab?.options))

const panelNode = ReactStub.createElement(conversationTab.component, { sessionId: 'session-live-1' })

console.log('\n== the view lists the conversation in order ==')
render(panelNode)
await tick()
let panel = render(panelNode)
const cardsOf = (tree) => findAll(tree, 'div')
  .filter((node) => String(node.props?.className ?? '').includes('dsh-chat-git-card'))
/**
 * The confirm dialog, read out of its own node.
 *
 * The dialog is a child of the panel, so collecting every button in the panel
 * would also pick up the card buttons, whose wording ("从这里 fork" /
 * "回退到这里") legitimately names the same verbs and would drown out the
 * assertion about what the dialog itself offers.
 */
const dialogOf = (tree) => findAll(tree, 'div')
  .find((node) => String(node.props?.className ?? '').includes('dsh-chat-git-dialog'))
check('the panel read the conversation timeline',
  requests.some((entry) => entry.url === '/chat-git/timeline' && entry.body.sessionId === 'session-live-1'),
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/timeline').map((entry) => entry.body)))
const cards = cardsOf(panel)
/**
 * The card for one chronological turn.
 *
 * The pane lists newest first, so the rendered order is the reverse of
 * `timelineTurns`. Addressing a card by its chronological index keeps every
 * block below from having to know that.
 */
const cardAt = (chrono) => cardsOf(panel)[timelineTurns.length - 1 - chrono]
check('one card per turn', cards.length === 3, String(cards.length))
const panelText = textOf(panel)
check('a card names its turn', panelText.includes('第 1 轮'), JSON.stringify(panelText.slice(0, 160)))
// Newest first: the turn the conversation is standing on is the one the actions
// are usually aimed at, so reaching it must not mean scrolling the whole log.
check('the cards list the newest turn first',
  panelText.indexOf('正在进行的一轮') < panelText.indexOf('把登录返回值改成 ok')
  && panelText.indexOf('把登录返回值改成 ok') < panelText.indexOf('实现登录接口'),
  JSON.stringify(panelText.slice(0, 300)))
check('the pane says which way the list runs',
  panelText.includes('按时间倒序排列，最新一轮在最上面。'), JSON.stringify(panelText.slice(0, 200)))
check('the panel counts the turns', panelText.includes('3 轮'), JSON.stringify(panelText.slice(0, 120)))
check('the pane names the current turn in words',
  panelText.includes('当前位置：第 3 轮'), JSON.stringify(panelText.slice(0, 200)))
// The newest turn is tagged rather than merely listed first: once the list
// scrolls, being the top row stops answering "which turn am I on".
const currentCard = cards.find((card) => card.props?.['data-current'] === 'true')
check('the newest turn is tagged as the current position',
  currentCard !== undefined && textOf(currentCard).includes('正在进行的一轮'),
  JSON.stringify(cards.map((card) => card.props?.['data-current'])))
check('the current turn carries a 当前位置 label',
  findAll(currentCard ?? null, 'span')
    .some((span) => String(span.props?.className ?? '').includes('dsh-chat-git-here')
      && textOf(span) === '当前位置'),
  JSON.stringify(findAll(currentCard ?? null, 'span').map((span) => [span.props?.className, textOf(span)])))
check('only one turn is marked as the current position',
  cards.filter((card) => card.props?.['data-current'] === 'true').length === 1,
  JSON.stringify(cards.map((card) => card.props?.['data-current'])))
// The turn list must no longer echo the checkpoint: showing the same commit in
// both columns was what made the two halves read as one coupled thing.
check('a conversation card carries no commit line',
  !textOf(cardAt(1)).includes('bbbb222'), JSON.stringify(textOf(cardAt(1))))

console.log('\n== the workspace pane reads git on its own ==')
// The two panes are independent reads: the left one never asks for a commit and
// the right one never asks for a turn, which is what lets either half fail on
// its own without taking the other down.
// Matched as an exact class token, not a substring: a commit row also carries
// `dsh-chat-git-commit-body` and `dsh-chat-git-commit-meta`, so a substring test
// counted three nodes per commit and made row indices meaningless.
const commitsOf = (tree) => findAll(tree, 'div')
  .filter((node) => String(node.props?.className ?? '').split(/\s+/).includes('dsh-chat-git-commit'))
check('the workspace pane read the repository on its own route',
  requests.some((entry) => entry.url === '/chat-git/repo' && entry.body.sessionId === 'session-live-1'),
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/repo').map((entry) => entry.body)))
const repoRows = commitsOf(panel)
check('the workspace pane lists the repository commits', repoRows.length === 2, String(repoRows.length))
check('a commit row names its sha and its subject',
  textOf(repoRows[1]).includes('bbbb222') && textOf(repoRows[1]).includes('把登录返回值改成 ok'),
  JSON.stringify(textOf(repoRows[1])))
// The pane lists the repository's real history, not only this plugin's
// checkpoints, so a commit has to say who wrote it and when.
check('a commit row carries the author and the time',
  textOf(repoRows[1]).includes('ClownLMe') && textOf(repoRows[1]).includes('10:30'),
  JSON.stringify(textOf(repoRows[1])))
// The gutter is what makes the list read like `git log --graph`; it is drawn by
// CSS, so the only thing the markup owes the stylesheet is the hook element.
check('every commit row carries the graph gutter',
  repoRows.every((row) => findAll(row, 'span')
    .some((span) => String(span.props?.className ?? '').split(/\s+/).includes('dsh-chat-git-graph'))),
  JSON.stringify(repoRows.map((row) => findAll(row, 'span').map((span) => span.props?.className))))
check('the gutter is hidden from assistive tech',
  findAll(repoRows[0], 'span')
    .filter((span) => String(span.props?.className ?? '').includes('dsh-chat-git-graph'))
    .every((span) => span.props?.['aria-hidden'] === 'true'),
  JSON.stringify(findAll(repoRows[0], 'span').map((span) => span.props?.['aria-hidden'])))
check('the workspace pane reports the branch and the repository root',
  panelText.includes('main') && panelText.includes('C:/ws'), JSON.stringify(panelText.slice(-320)))
check('the workspace pane reports a clean worktree', panelText.includes('工作区干净'),
  JSON.stringify(panelText.slice(-320)))

console.log('\n== each card offers all three conversation actions ==')
check('every card carries exactly the three buttons',
  cards.every((card) => findAll(card, 'button').length === 3),
  JSON.stringify(cards.map((card) => findAll(card, 'button').length)))
check('the buttons are labelled as asked',
  findAll(cardAt(0), 'button').map((btn) => textOf(btn)).join('|')
    === '从这里 fork|回退到这里|编辑并重新发送',
  findAll(cardAt(0), 'button').map((btn) => textOf(btn)).join('|'))
check('a turn with no closing sequence cannot branch',
  findAll(cardAt(2), 'button').every((btn) => btn.props?.disabled === true),
  JSON.stringify(findAll(cardAt(2), 'button').map((btn) => btn.props?.disabled)))
check('the panel explains why that turn cannot branch',
  panelText.includes('没有结束序列'), JSON.stringify(panelText.slice(-200)))

console.log('\n== the resend editor is seeded from the whole prompt ==')
// The card shows a *clip* of the prompt — `/chat-git/timeline` truncates it for
// display. Resending that clip would quietly ask the model for something the
// user never wrote, so the editor has to be seeded from the separate whole-prompt
// read, and the fake host gives the two deliberately different text.
findAll(cardAt(0), 'button')[2].props.onClick()
await tick()
panel = render(panelNode)
const editorOf = (tree) => findAll(tree, 'textarea')[0]
const editor = editorOf(panel)
check('clicking the third action opens an editor',
  editor !== undefined, JSON.stringify(findAll(panel, 'textarea').length))
check('the whole prompt is read from the host, not the card',
  requests.some((entry) => entry.url === '/chat-git/turn-prompt'
    && entry.body.sessionId === 'session-live-1' && entry.body.turn === 1),
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/turn-prompt').map((entry) => entry.body)))
check('the editor is seeded with the whole prompt',
  editor?.props?.value === wholePrompts[1], JSON.stringify(editor?.props?.value))
check('the seeded text is longer than the card\'s clip',
  String(editor?.props?.value ?? '').length > String(cardAt(0) && textOf(cardAt(0))).length
  && editor?.props?.value !== timelineTurns[0].prompt,
  JSON.stringify({ seeded: editor?.props?.value, card: timelineTurns[0].prompt }))
check('the editor is labelled for assistive tech', editor?.props?.['aria-label'] === '编辑提示词',
  String(editor?.props?.['aria-label']))
const resendDialogText = textOf(dialogOf(panel))
check('the resend dialog names the turn', resendDialogText.includes('第 1 轮'),
  JSON.stringify(resendDialogText.slice(-320)))
check('the resend dialog says the later turns go away',
  resendDialogText.includes('删掉这一轮及其之后'), JSON.stringify(resendDialogText.slice(-320)))
check('the resend dialog says the original is archived',
  resendDialogText.includes('归档'), JSON.stringify(resendDialogText.slice(-320)))
check('the resend dialog confirms with its own wording',
  findAll(dialogOf(panel), 'button').map((btn) => textOf(btn)).join('|') === '删除并重新发送|取消',
  findAll(dialogOf(panel), 'button').map((btn) => textOf(btn)).join('|'))
check('the resend dialog never offers fork or rewind',
  !findAll(dialogOf(panel), 'button').some((btn) => /fork|回退/.test(textOf(btn))),
  JSON.stringify(findAll(dialogOf(panel), 'button').map((btn) => textOf(btn))))

console.log('\n== the resend dialog lets the model be re-picked ==')
// Choosing a model is part of this dialog rather than a separate step: the
// rebuilt line runs on the deployment's default selection, so the choice has to
// be written before the session is created or forked — a picker shown after the
// fact would be describing a decision that was already made.
const picker = findAll(dialogOf(panel), 'select')[0]
check('the dialog offers a model picker', picker !== undefined,
  JSON.stringify(findAll(dialogOf(panel), 'select').length))
check('the picker is labelled for assistive tech',
  picker?.props?.['aria-label'] === '重新发送使用的模型', String(picker?.props?.['aria-label']))
check('the picker lists one option per registered model',
  (picker?.props?.children ?? []).length === 2,
  JSON.stringify((picker?.props?.children ?? []).map((option) => option?.props?.value)))
check('an option names both the provider and the model',
  textOf((picker?.props?.children ?? [])[0]) === 'DeepSeek / V4 Flash',
  JSON.stringify(textOf((picker?.props?.children ?? [])[0])))
// Seeded with the route the deployment would use anyway, so the control reads as
// "change this if you want" rather than as a question that must be answered.
check('the picker is seeded with the current route', picker?.props?.value === '0',
  String(picker?.props?.value))
check('a provider with no models contributes no option',
  !(picker?.props?.children ?? []).some((option) => textOf(option).includes('Bare')),
  JSON.stringify((picker?.props?.children ?? []).map((option) => textOf(option))))
// The catalogue read happens while the dialog opens, alongside the whole-prompt
// read: a picker that populated itself a moment later would look like a failure.
check('the model list is read before the dialog is usable',
  requests.some((entry) => entry.url === '/chat-git/models'),
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/models').length))
picker?.props?.onChange({ target: { value: '1' } })
panel = render(panelNode)
check('choosing another model updates the picker',
  findAll(dialogOf(panel), 'select')[0]?.props?.value === '1',
  String(findAll(dialogOf(panel), 'select')[0]?.props?.value))
check('choosing a model sends nothing on its own',
  appliedModels.length === 0, JSON.stringify(appliedModels))

console.log('\n== an emptied prompt cannot be resent ==')
// An empty box is the one way this dialog can be refused, and it must be
// refused *before* the conversation moves: sending nothing after truncating
// would destroy turns for no reason.
const beforeEmptyFork = forkedSessions.length
const beforeEmptyCreate = createdSessions.length
editorOf(panel).props.onChange({ target: { value: '   ' } })
panel = render(panelNode)
const emptiedConfirm = findAll(dialogOf(panel), 'button')[0]
check('an emptied editor disables the confirm', emptiedConfirm?.props?.disabled === true,
  String(emptiedConfirm?.props?.disabled))
check('the dialog says why it is refused', textOf(dialogOf(panel)).includes('提示词不能为空'),
  JSON.stringify(textOf(dialogOf(panel)).slice(-200)))
emptiedConfirm.props.onClick()
await tick()
check('a refused resend moves no conversation',
  forkedSessions.length === beforeEmptyFork && createdSessions.length === beforeEmptyCreate,
  JSON.stringify({ forks: forkedSessions.length, created: createdSessions.length }))

console.log('\n== resending the first turn starts a fresh session ==')
// Turn 1 has no turn before it, so there is no boundary to fork at: forking at
// nothing would keep the whole conversation. A new session in the same
// workspace is the honest expression of "nothing before this turn is kept".
archived.length = 0
sentPrompts.length = 0
const editedFirst = '实现登录接口，返回值统一改成 ok，并补上失败分支的测试。'
editorOf(panel).props.onChange({ target: { value: editedFirst } })
panel = render(panelNode)
findAll(dialogOf(panel), 'button')[0].props.onClick()
await tick()
await tick()
await tick()
check('the first turn resends into a newly created session',
  createdSessions.length === 1 && forkedSessions.length === beforeEmptyFork,
  JSON.stringify({ created: createdSessions, forks: forkedSessions.slice(beforeEmptyFork) }))
check('the new session keeps the conversation workspace',
  createdSessions[0]?.cwd === 'C:/ws', JSON.stringify(createdSessions[0]))
// The model has to be written *before* the session is built: `sessions.create`
// and `sessions.fork` both take their route from the default selection, so a
// switch that arrived afterwards would leave the new line on the old model.
check('the chosen model is written before the conversation moves',
  appliedModels.length === 1 && appliedModels[0].provider === 'deepseek-official'
  && appliedModels[0].model === 'deepseek-v4-pro',
  JSON.stringify(appliedModels))
check('the model switch happens before the session is built',
  modelOrder.indexOf('set-model') >= 0
  && modelOrder.indexOf('set-model') < modelOrder.indexOf('create'),
  JSON.stringify(modelOrder))
check('the edited prompt is what gets sent', sentPrompts.at(-1) === editedFirst,
  JSON.stringify(sentPrompts))
check('the edited text is trimmed before it is sent',
  sentPrompts.at(-1) === editedFirst.trim(), JSON.stringify(sentPrompts.at(-1)))
check('the original conversation is archived',
  archived.length === 1 && archived[0] === 'session-live-1', JSON.stringify(archived))
check('a first-turn resend inherits nothing, because nothing survives',
  !requests.some((entry) => entry.url === '/chat-git/inherit'
    && entry.body.to === 'session-new-7'),
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/inherit').map((entry) => entry.body)))

console.log('\n== resending a later turn forks at the turn before it ==')
// The boundary belongs to the turn *before* the edited one — the edited turn and
// everything after it are what disappear.
panel = render(panelNode)
await tick()
panel = render(panelNode)
const beforeLaterFork = forkedSessions.length
const beforeLaterCreate = createdSessions.length
const beforeLaterArchived = archived.length
sentPrompts.length = 0
findAll(cardsOf(panel)[1], 'button')[2].props.onClick()
await tick()
panel = render(panelNode)
const laterEditor = findAll(panel, 'textarea')[0]
check('the editor is seeded from that turn\'s own prompt',
  laterEditor?.props?.value === wholePrompts[2], JSON.stringify(laterEditor?.props?.value))
findAll(dialogOf(panel), 'button')[0].props.onClick()
await tick()
await tick()
await tick()
check('the later turn forks instead of creating',
  forkedSessions.length === beforeLaterFork + 1 && createdSessions.length === beforeLaterCreate,
  JSON.stringify({ forks: forkedSessions.slice(beforeLaterFork), created: createdSessions.slice(beforeLaterCreate) }))
check('the fork boundary is the turn before the edited one',
  forkedSessions.at(-1)?.atSeq === 10, JSON.stringify(forkedSessions.at(-1)))
check('the surviving checkpoints go to the new line',
  requests.some((entry) => entry.url === '/chat-git/inherit' && entry.body.turn === 1),
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/inherit').map((entry) => entry.body)))
check('the unedited prompt is resent as it stands', sentPrompts.at(-1) === wholePrompts[2],
  JSON.stringify(sentPrompts))
check('the second resend archives its original too',
  archived.length === beforeLaterArchived + 1, JSON.stringify(archived))

console.log('\n== a deployment without the conversation service still resends ==')
// `ctx.conversation` and this plugin are separate packages, so the resend keeps
// a real second path rather than assuming the controller is mounted.
conversationAvailable = false
panel = render(panelNode)
await tick()
panel = render(panelNode)
sentPrompts.length = 0
findAll(cardAt(0), 'button')[2].props.onClick()
await tick()
panel = render(panelNode)
findAll(dialogOf(panel), 'button')[0].props.onClick()
await tick()
await tick()
await tick()
check('the session face carries the prompt when the controller is absent',
  sentPrompts.at(-1) === wholePrompts[1], JSON.stringify(sentPrompts))
conversationAvailable = true
panel = render(panelNode)
await tick()
panel = render(panelNode)

console.log('\n== the dialog asks only about the conversation ==')
findAll(cards[1], 'button')[0].props.onClick()
panel = render(panelNode)
const dialogLabels = findAll(dialogOf(panel), 'button').map((btn) => textOf(btn))
check('the fork dialog confirms the fork and nothing else',
  dialogLabels.join('|') === '确认 fork 对话|取消', JSON.stringify(dialogLabels))
// A fork dialog that also says 回退 makes the user re-read the card button they
// just pressed to work out which of the two they are in.
check('a fork dialog never says 回退',
  !dialogLabels.some((label) => label.includes('回退')), JSON.stringify(dialogLabels))
// The code scope is gone: there is no longer a choice to make here, because the
// repository belongs to the other pane.
check('the dialog no longer offers a code scope',
  !dialogLabels.some((label) => label.includes('代码')), JSON.stringify(dialogLabels))
const dialogText = textOf(dialogOf(panel))
check('the dialog names the turn', dialogText.includes('第 2 轮'), JSON.stringify(dialogText.slice(-320)))
check('a fork promises the original survives',
  dialogText.includes('当前会话保持原样'), JSON.stringify(dialogText.slice(-320)))
check('the dialog states that the code is not touched',
  dialogText.includes('工作区的代码不会被改动'), JSON.stringify(dialogText.slice(-320)))
check('the dialog no longer names a checkpoint',
  !dialogText.includes('bbbb222'), JSON.stringify(dialogText.slice(-320)))

console.log('\n== a conversation fork never touches the repository ==')
forkedSessions.length = 0
archived.length = 0
const beforeFork = requests.filter((entry) => entry.url === '/chat-git/revert').length
const beforeRestores = requests.filter((entry) => entry.url === '/chat-git/restore').length
const beforeTimelineReads = requests.filter((entry) => entry.url === '/chat-git/timeline').length
findAll(panel, 'button').find((btn) => textOf(btn) === '确认 fork 对话').props.onClick()
await tick()
await tick()
await tick()
// Both write routes are checked, not just the old one: the point of the split is
// that a conversation action has no git side effect at all.
check('no repository write was requested',
  requests.filter((entry) => entry.url === '/chat-git/revert').length === beforeFork
  && requests.filter((entry) => entry.url === '/chat-git/restore').length === beforeRestores,
  JSON.stringify(requests.filter((entry) => entry.url.startsWith('/chat-git/')).map((entry) => entry.url)))
check('the fork happens at that turn closing sequence',
  forkedSessions.length === 1 && forkedSessions[0].atSeq === 20, JSON.stringify(forkedSessions))
check('the fork inherits the surviving checkpoints',
  requests.some((entry) => entry.url === '/chat-git/inherit' && entry.body.turn === 2),
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/inherit').map((entry) => entry.body)))
check('a fork leaves the original conversation alone', archived.length === 0, JSON.stringify(archived))
// A tab has nothing to close: acting on a turn moves the conversation, so the
// view bumps its revision and re-reads the timeline instead of dismissing
// itself. The bump is state, so a re-render is what makes the effect run.
panel = render(panelNode)
await tick()
check('the view re-reads the timeline after acting',
  requests.filter((entry) => entry.url === '/chat-git/timeline').length > beforeTimelineReads,
  String(requests.filter((entry) => entry.url === '/chat-git/timeline').length))

console.log('\n== rewinding archives the conversation it came from ==')
panel = render(panelNode)
const rewindCard = cardAt(0)
findAll(rewindCard, 'button')[1].props.onClick()
panel = render(panelNode)
const rewindDialogText = textOf(dialogOf(panel))
check('the rewind dialog says the original will be archived',
  rewindDialogText.includes('归档'), JSON.stringify(rewindDialogText.slice(-320)))
const rewindLabels = findAll(dialogOf(panel), 'button').map((btn) => textOf(btn))
check('a rewind dialog names only 回退, never fork',
  rewindLabels.join('|') === '确认回退对话|取消', JSON.stringify(rewindLabels))

forkedSessions.length = 0
archived.length = 0
const beforeRewind = requests.filter((entry) => entry.url === '/chat-git/revert').length
const beforeRewindRestores = requests.filter((entry) => entry.url === '/chat-git/restore').length
findAll(panel, 'button').find((btn) => textOf(btn) === '确认回退对话').props.onClick()
await tick()
await tick()
await tick()
check('the rewind never writes to the repository',
  requests.filter((entry) => entry.url === '/chat-git/revert').length === beforeRewind
  && requests.filter((entry) => entry.url === '/chat-git/restore').length === beforeRewindRestores,
  JSON.stringify(requests.filter((entry) => entry.url.startsWith('/chat-git/')).map((entry) => entry.url)))
check('the fork still happens at that turn', forkedSessions[0]?.atSeq === 10, JSON.stringify(forkedSessions))
check('rewinding archives the original conversation',
  archived.length === 1 && archived[0] === 'session-live-1', JSON.stringify(archived))

// ---------------------------------------------------------------------------
// The workspace pane restores code on its own
// ---------------------------------------------------------------------------

console.log('\n== the workspace pane restores code without the conversation ==')
panel = render(panelNode)
// The rewind above bumped the revision, which re-runs the repository read. Until
// that settles the pane is genuinely busy, so the reads are awaited before the
// rows are captured — otherwise the clicks below land on a disabled row's
// closure and silently do nothing.
await tick()
await tick()
panel = render(panelNode)
const beforeRestoreForks = forkedSessions.length
const beforeRestoreArchived = archived.length
const restoreRows = commitsOf(panel)
check('every commit row offers exactly one action',
  restoreRows.every((row) => findAll(row, 'button').length === 1),
  JSON.stringify(restoreRows.map((row) => findAll(row, 'button').length)))
check('the restore button is labelled as such',
  textOf(findAll(restoreRows[1], 'button')[0]) === '还原到这里',
  JSON.stringify(textOf(findAll(restoreRows[1], 'button')[0])))
// Confirmation is a dialog, not a second click on the same button: the sentence
// that has to be read before overwriting a worktree ("this is what you lose")
// does not fit in a list row, and an armed button leaves it unsaid.
const beforeDialogRestore = requests.filter((entry) => entry.url === '/chat-git/restore').length
findAll(restoreRows[1], 'button')[0].props.onClick()
panel = render(panelNode)
const restoreDialogNode = dialogOf(panel)
check('clicking 还原 opens a confirmation dialog',
  restoreDialogNode !== undefined, JSON.stringify(findAll(panel, 'div').length))
check('opening the dialog restores nothing yet',
  requests.filter((entry) => entry.url === '/chat-git/restore').length === beforeDialogRestore,
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/restore').map((entry) => entry.body)))
const restoreDialogText = textOf(restoreDialogNode)
// The dialog names the commit itself: "还原到这里" is only unambiguous while the
// row is still on screen, so the confirmation has to stand on its own.
check('the dialog names the commit being restored',
  restoreDialogText.includes(repoCommits[1].short) && restoreDialogText.includes('把登录返回值改成 ok'),
  JSON.stringify(restoreDialogText.slice(-320)))
check('the dialog says HEAD is not moved',
  restoreDialogText.includes('HEAD 不动'), JSON.stringify(restoreDialogText.slice(-320)))
check('the dialog warns that untracked files are left alone',
  restoreDialogText.includes('未跟踪'), JSON.stringify(restoreDialogText.slice(-320)))
check('the dialog says where the worktree stands now and where it will be',
  restoreDialogText.includes('当前位置') && restoreDialogText.includes('还原后变成'),
  JSON.stringify(restoreDialogText.slice(-320)))
const restoreLabels = findAll(restoreDialogNode, 'button').map((btn) => textOf(btn))
check('the restore dialog confirms with its own wording',
  restoreLabels.join('|') === '确认还原|取消', JSON.stringify(restoreLabels))
// Cancelling must be a real way out, not just a label: the dialog closes and no
// request is issued.
findAll(restoreDialogNode, 'button')[1].props.onClick()
panel = render(panelNode)
check('cancelling closes the dialog without restoring',
  dialogOf(panel) === undefined
  && requests.filter((entry) => entry.url === '/chat-git/restore').length === beforeDialogRestore,
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/restore').map((entry) => entry.body)))

findAll(commitsOf(panel)[1], 'button')[0].props.onClick()
panel = render(panelNode)
findAll(dialogOf(panel), 'button')[0].props.onClick()
await tick()
await tick()
await tick()
const restoreCalls = requests.filter((entry) => entry.url === '/chat-git/restore')
check('confirming in the dialog restores that commit',
  restoreCalls.length === 1 && restoreCalls[0].body.sha === repoCommits[1].sha,
  JSON.stringify(restoreCalls.map((entry) => entry.body)))
check('restoring code forks no conversation', forkedSessions.length === beforeRestoreForks,
  JSON.stringify(forkedSessions))
check('restoring code archives no conversation', archived.length === beforeRestoreArchived,
  JSON.stringify(archived))

console.log('\n== the pane marks where the worktree stands ==')
// A restore deliberately leaves HEAD alone, so after one git alone can no longer
// answer "where am I": the host remembers the position, and the pane has to show
// it as a label rather than leaving the user to compare shas by eye.
panel = render(panelNode)
await tick()
panel = render(panelNode)
const markedRows = commitsOf(panel)
const restoredRow = markedRows.find((row) => row.props?.['data-current'] === 'true')
check('the row the worktree stands on is tagged',
  restoredRow !== undefined && textOf(restoredRow).includes(repoCommits[1].short),
  JSON.stringify(markedRows.map((row) => row.props?.['data-current'])))
check('that row carries a 当前位置 label',
  findAll(restoredRow ?? null, 'span')
    .some((span) => String(span.props?.className ?? '').includes('dsh-chat-git-here')
      && textOf(span) === '当前位置'),
  JSON.stringify(findAll(restoredRow ?? null, 'span').map((span) => [span.props?.className, textOf(span)])))
check('only one row is marked as the current position',
  markedRows.filter((row) => row.props?.['data-current'] === 'true').length === 1,
  JSON.stringify(markedRows.map((row) => row.props?.['data-current'])))
// Restoring onto the position the worktree already holds would be a no-op that
// still reports success, so that row's button is refused rather than offered.
check('the current row refuses a no-op restore',
  textOf(findAll(restoredRow ?? null, 'button')[0]) === '已在此位置'
  && findAll(restoredRow ?? null, 'button')[0].props?.disabled === true,
  JSON.stringify(textOf(findAll(restoredRow ?? null, 'button')[0])))
check('a row that is not the current position still offers 还原到这里',
  textOf(findAll(markedRows[0], 'button')[0]) === '还原到这里'
  && findAll(markedRows[0], 'button')[0].props?.disabled === false,
  JSON.stringify(textOf(findAll(markedRows[0], 'button')[0])))
check('the pane states the position in words as well',
  textOf(panel).includes('当前位置：bbbb222'), JSON.stringify(textOf(panel).slice(-320)))

// ---------------------------------------------------------------------------
// A failed workspace read
// ---------------------------------------------------------------------------

console.log('\n== a failed workspace read is named and recoverable ==')
// The bare-string body is the web server's own 404 shape (`{ error: 'not found' }`),
// which is exactly what a host process still running the previous build answers
// for a route it does not serve. Reading `.message` off that string yielded
// `undefined`, so the pane fell back to a generic failure that named the
// repository when the route was what was missing — and it stayed stuck until
// some unrelated action happened to re-read it.
repoFailure = 'not found'
/**
 * Drive one effect-backed re-read to completion.
 *
 * The order matters, and getting it wrong is what made an earlier version of
 * this block pass for the wrong reason: the read lives in an effect, and an
 * effect only runs on a render. So the render that mounts the effect has to
 * come *after* the action that bumped the revision, and the ticks that settle
 * the request have to come between that render and the one that asserts.
 */
const settleRead = async () => {
  await tick()
  panel = render(panelNode)
  await tick()
  panel = render(panelNode)
}
/**
 * Restore one row through the dialog, which is what bumps the revision.
 *
 * The re-read this block needs lives in an effect keyed on the revision, and a
 * successful restore is what advances it — so the block has to go through the
 * real two-step confirmation rather than poking at state directly.
 */
const restoreRow = async (index) => {
  findAll(commitsOf(panel)[index], 'button')[0].props.onClick()
  panel = render(panelNode)
  findAll(dialogOf(panel), 'button')[0].props.onClick()
  await settleRead()
}
await restoreRow(0)
const failedText = textOf(panel)
check('the host\'s own words are surfaced instead of a generic failure',
  failedText.includes('not found'), JSON.stringify(failedText.slice(-300)))
check('the pane no longer blames the repository for a missing route',
  !failedText.includes('没有可读取的仓库'), JSON.stringify(failedText.slice(-300)))
check('the pane offers a retry', findAll(panel, 'button').some((btn) => textOf(btn) === '重试'),
  JSON.stringify(findAll(panel, 'button').map((btn) => textOf(btn))))
// Retrying is the whole point of showing the control: the read must actually
// run again, and a route that is back must repopulate the list.
repoFailure = ''
findAll(panel, 'button').find((btn) => textOf(btn) === '重试').props.onClick()
await settleRead()
check('retrying re-reads the repository', commitsOf(panel).length === 2,
  JSON.stringify(commitsOf(panel).length))
check('the error is cleared once the read succeeds', !textOf(panel).includes('not found'),
  JSON.stringify(textOf(panel).slice(-200)))

// A host that serves no such route at all looks like a rejected fetch, and the
// transport message is the honest thing to show for it.
repoUnreachable = true
// Row 1 rather than row 0: the restore above moved the position, so row 0 is now
// the current one and its button is refused. Restoring a row that is genuinely
// offered is what bumps the revision this read hangs off.
await restoreRow(1)
check('an unreachable route reports the transport, not the repository',
  textOf(panel).includes('路由不可用'), JSON.stringify(textOf(panel).slice(-300)))
repoUnreachable = false
findAll(panel, 'button').find((btn) => textOf(btn) === '重试').props.onClick()
await settleRead()
check('the pane recovers once the route answers again', commitsOf(panel).length === 2,
  JSON.stringify(commitsOf(panel).length))

// ---------------------------------------------------------------------------
// Withdrawing the History tab
// ---------------------------------------------------------------------------

console.log('\n== the settings switch withdraws and restores the tab ==')
// The strip is projected from the registry, so a hidden tab means the seat is
// gone: clicking the switch must dispose the registration, and clicking it back
// must put a live seat back. A one-way trip would lose the tab for the rest of
// the session with no way to recover it.
section = render(sectionNode)
const historyToggle = findAll(section, 'button').filter((btn) => btn.props?.role === 'switch')[1]
check('the History switch is the second preference', historyToggle?.props?.['aria-label'] === '历史标签页',
  String(historyToggle?.props?.['aria-label']))
const enabledCallsBefore = requests.filter((entry) => entry.url === '/chat-git/set-enabled').length
historyToggle.props.onClick()
await tick()
const historyCalls = requests.filter((entry) => entry.url === '/chat-git/set-history')
check('turning the tab off tells the host the field the route reads',
  historyCalls.at(-1)?.body?.history === false, JSON.stringify(historyCalls.at(-1)?.body))
check('turning the tab off withdraws the seat', conversationTab?.disposed === true,
  String(conversationTab?.disposed))
check('withdrawing the tab never touches the checkpoint preference',
  requests.filter((entry) => entry.url === '/chat-git/set-enabled').length === enabledCallsBefore,
  JSON.stringify(requests.filter((entry) => entry.url === '/chat-git/set-enabled').map((entry) => entry.body)))

section = render(sectionNode)
const restoreToggle = findAll(section, 'button').filter((btn) => btn.props?.role === 'switch')[1]
check('the switch reads as off once the host confirmed', restoreToggle?.props?.['aria-checked'] === false,
  JSON.stringify(restoreToggle?.props?.['aria-checked']))
restoreToggle.props.onClick()
await tick()
check('turning the tab back on restores the seat', conversationTab?.disposed === false,
  String(conversationTab?.disposed))
check('the restored seat keeps its id and label',
  conversationTab?.options?.id === 'chat-git-history' && conversationTab?.options?.label === '历史',
  JSON.stringify(conversationTab?.options))

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
