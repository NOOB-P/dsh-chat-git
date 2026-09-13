/**
 * Local verification harness for dsh-chat-git's host half.
 *
 * Runs the real plugin against a fake Cordis context whose `subprocess` seam is
 * backed by genuine `git` child processes, in a throwaway workspace. This is
 * the only way to prove the checkpoint chain end to end without installing the
 * package into a profile and restarting the harness:
 *
 *   node test/harness.mjs
 *
 * Two deliberate constraints shape this file:
 *
 * - Child output is captured through **file descriptors on real files**, never
 *   `stdio: 'pipe'`. The DSH file sandbox denies the anonymous pipes that
 *   `child_process` opens for `'pipe'`, and every spawn fails with EPERM.
 * - The route handlers are driven over a real loopback HTTP server, so the
 *   loopback guard, the JSON envelope, and `req.socket.remoteAddress` are all
 *   exercised rather than mocked away.
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-chat-git-'))
const workspace = join(sandbox, 'workspace')
const home = join(sandbox, 'home')
const capture = join(sandbox, 'capture')
mkdirSync(workspace, { recursive: true })
mkdirSync(home, { recursive: true })
mkdirSync(capture, { recursive: true })

let captureSeq = 0

/**
 * Spawn one child with both output streams redirected to ordinary files.
 * @returns `{ done, read }` where `read()` returns the captured text.
 */
function spawnCaptured(command, args, cwd) {
  const id = captureSeq++
  const outPath = join(capture, `${id}.out`)
  const errPath = join(capture, `${id}.err`)
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let closed = false
  const release = () => {
    if (closed) return
    closed = true
    try { closeSync(outFd) } catch { /* already gone */ }
    try { closeSync(errFd) } catch { /* already gone */ }
  }
  const child = spawn(command, args, { cwd, stdio: ['ignore', outFd, errFd], windowsHide: true })
  const done = new Promise((resolve) => {
    child.on('error', (error) => {
      try { appendFileSync(errPath, String(error.message)) } catch { /* capture is best-effort */ }
      release()
      resolve({ exitCode: 127 })
    })
    child.on('close', (code) => {
      release()
      resolve({ exitCode: code })
    })
  })
  const read = () => {
    let out = ''
    let err = ''
    try { out = readFileSync(outPath, 'utf8') } catch { /* absent when the spawn never ran */ }
    try { err = readFileSync(errPath, 'utf8') } catch { /* absent when the spawn never ran */ }
    return { out, err }
  }
  return { done, read }
}

/** The synchronous variant used by the test's own assertions. */
function git(cwd, args) {
  const id = captureSeq++
  const outPath = join(capture, `${id}.out`)
  const errPath = join(capture, `${id}.err`)
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let status = null
  try {
    status = spawnSync('git', args, { cwd, stdio: ['ignore', outFd, errFd], windowsHide: true }).status
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  return { code: status, out: readFileSync(outPath, 'utf8').trim(), err: readFileSync(errPath, 'utf8').trim() }
}

/**
 * The `subprocess` service face the plugin consumes, backed by real children.
 * Mirrors the shape `dsh-subprocess` exposes: `done` plus bounded collectors.
 */
function createSubprocess() {
  return {
    spawn(spec) {
      const handle = spawnCaptured(spec.argv[0], spec.argv.slice(1), spec.cwd)
      return {
        done: handle.done,
        collected: {
          stdout: { readFrom: () => ({ text: handle.read().out }) },
          stderr: { readFrom: () => ({ text: handle.read().err }) },
        },
      }
    },
  }
}

/**
 * A minimal Cordis context: listener table, effect passthrough, route capture.
 * @param services - optional-service table behind `ctx.get`; an absent entry is
 * `undefined`, exactly as an unmounted service reads in the real host.
 */
function createContext(services = {}) {
  const listeners = new Map()
  const disposers = []
  const context = {
    subprocess: createSubprocess(),
    webServer: {
      register(entry) {
        context.route = entry
        return () => { context.route = null }
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    route: null,
    /** The optional-service lookup the plugin probes for `llm` and the model route. */
    get(name) {
      return services[name]
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    /** Deliver one event to every listener, awaiting each like the host loop. */
    async emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) await handler(payload)
    },
    dispose() {
      for (const disposer of disposers) disposer()
    },
  }
  return context
}

/** POST one JSON payload to the plugin's route over real HTTP. */
async function call(base, path, payload) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return response.json()
}

/** Serve one plugin context on an ephemeral loopback port. */
async function serve(context) {
  const server = createServer((req, res) => { void context.route.handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

/** One `agent/inbox/claimed` payload carrying a session identity and a prompt. */
function claim(sessionId, cwd, turn, text) {
  return {
    agent: { session: { header: { id: sessionId, cwd } } },
    message: { content: [{ type: 'text', text }] },
    turn,
  }
}

/** One `agent/session-start` payload: the conversation opening. */
function start(sessionId, cwd) {
  return { agent: { session: { header: { id: sessionId, cwd } } }, source: 'new' }
}

/** One `agent/turn-stopping` payload. */
function stop(sessionId, cwd, turn) {
  return { agent: { session: { header: { id: sessionId, cwd } } }, turn }
}

/** Calls the plugin made to the model, for asserting what the title prompt carried. */
const llmCalls = []

/** The fake model's behaviour; the tests swap this to exercise each failure path. */
let llmMode = 'title'
let llmTitle = '修复设置页开关无法启用'

const llmStub = {
  /** Two providers, the second of which never answers, so the deadline is real. */
  listProviders() {
    return [
      { id: 'fake-provider', name: 'Fake Provider' },
      { id: 'slow-provider', name: 'Slow Provider' },
    ]
  },
  async listModels(provider) {
    if (provider === 'slow-provider') return new Promise(() => {})
    return [
      { provider, id: 'fake-model', name: 'Fake Model' },
      { provider, id: 'tiny-model', name: 'Tiny Model' },
    ]
  },
  async *stream(options) {
    llmCalls.push(options)
    if (llmMode === 'throw') throw new Error('provider unreachable')
    if (llmMode === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'provider-error' } } }
      return
    }
    yield { type: 'text-delta', index: 0, text: llmTitle }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

/** Every selection the resend's model picker wrote, in order. */
const modelSelections = []

const modelRouteStub = {
  currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'low' }),
  saveSelection: async (selection) => { modelSelections.push(selection) },
}

/** Session logs the fake `sessions` service serves, keyed by session id. */
const sessionLogs = new Map()

/**
 * Live session headers, keyed by session id.
 *
 * Kept separate from {@link sessionLogs} because the two answer different
 * questions: a log is what the timeline folds into turns, while a header is what
 * the workspace pane needs to find a repository for a conversation this plugin
 * has never checkpointed. A session can legitimately have either one alone.
 */
const sessionHeaders = new Map()

const sessionsStub = {
  get(id) {
    const events = sessionLogs.get(id)
    const header = sessionHeaders.get(id)
    if (events === undefined && header === undefined) return undefined
    return {
      header,
      ...(events === undefined ? {} : { snapshotEvents: () => events }),
    }
  },
}

/** The store reads DSH_HOME at apply() time, so the real ~/.dsh is untouched. */
process.env.DSH_HOME = home

const SESSION = 'session-test-1'

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)
const { buildSummaryInput, cleanSummary } = await import(new URL('../lib/summarize.js', import.meta.url).href)
const { buildTimeline, turnPrompt } = await import(new URL('../lib/timeline.js', import.meta.url).href)

console.log('\n== folding a session log into a turn journal ==')
const folded = buildTimeline([
  { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 101, data: { content: [{ type: 'text', text: '实现登录接口' }] } },
  { type: 'assistant/message', seq: 3, time: 110, data: { turn: 1, step: 1, message: {} } },
  { type: 'turn/end', seq: 4, time: 120, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 5, time: 200, data: { turn: 2 } },
  { type: 'user/message', seq: 6, time: 201, data: { content: [{ type: 'text', text: '改成 ok' }] } },
  { type: 'turn/end', seq: 7, time: 210, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  // A turn that has started but never ended: no fork boundary exists for it.
  { type: 'turn/start', seq: 8, time: 300, data: { turn: 3 } },
])
check('one entry per turn', folded.length === 3, String(folded.length))
check('turns keep their order', folded.map((entry) => entry.turn).join(',') === '1,2,3',
  folded.map((entry) => entry.turn).join(','))
check('a closed turn carries its closing sequence',
  folded[0].seq === 4 && folded[1].seq === 7, JSON.stringify(folded.map((entry) => entry.seq)))
check('an open turn has no boundary', folded[2].seq === null, JSON.stringify(folded[2].seq))
check('the prompt is the first user message', folded[0].prompt === '实现登录接口',
  JSON.stringify(folded[0].prompt))
check('the end reason is kept', folded[1].endReason === 'aborted', JSON.stringify(folded[1].endReason))
check('assistant steps are counted', folded[0].steps === 1, String(folded[0].steps))
check('the turn time is its closing time', folded[0].at === 120, String(folded[0].at))

const steered = buildTimeline([
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '原始请求' }] } },
  { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '插话' }] } },
  { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
])
check('a steering message does not rewrite the prompt', steered[0].prompt === '原始请求',
  JSON.stringify(steered[0].prompt))

const beforeStart = buildTimeline([
  { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '先到的消息' }] } },
  { type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } },
  { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
])
check('a user message before turn/start still becomes the prompt',
  beforeStart[0].prompt === '先到的消息', JSON.stringify(beforeStart[0].prompt))

// Compaction replaces a span of the surface with a synthesized user message
// carrying the summary. That replacement is a `user/message` like any other, so
// without the source check the card for the *next* turn shows the checkpoint
// preamble instead of what the user actually asked — and 编辑并重新发送 then hands
// that preamble back to the model as if it were the request.
const CHECKPOINT_TEXT = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.'
const checkpointMessage = (seq, compactionId) => ({
  type: 'user/message',
  seq,
  time: seq,
  data: {
    content: [{ type: 'text', text: CHECKPOINT_TEXT }],
    source: { kind: 'plugin', plugin: 'compact', compactionId },
  },
})
const afterCompaction = buildTimeline([
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '第一轮的真实请求' }] } },
  { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'compaction/start', seq: 4, time: 4, data: { compactionId: 'c1' } },
  { type: 'compaction/summary', seq: 5, time: 5, data: { compactionId: 'c1', summary: [] } },
  checkpointMessage(6, 'c1'),
  { type: 'turn/start', seq: 7, time: 7, data: { turn: 2 } },
  { type: 'user/message', seq: 8, time: 8, data: { content: [{ type: 'text', text: '第二轮的请求' }] } },
  { type: 'turn/end', seq: 9, time: 9, data: { turn: 2, reason: { kind: 'completed' } } },
])
check('a compaction checkpoint is not mistaken for the next turn\'s prompt',
  afterCompaction[1].prompt === '第二轮的请求', JSON.stringify(afterCompaction[1].prompt))
check('the turn before a compaction keeps its own prompt',
  afterCompaction[0].prompt === '第一轮的真实请求', JSON.stringify(afterCompaction[0].prompt))
check('the whole-prompt read skips a compaction checkpoint too',
  turnPrompt(afterCompaction.length === 0 ? [] : [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    checkpointMessage(2, 'c2'),
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '真实请求' }] } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ], 1) === '真实请求',
  JSON.stringify(turnPrompt([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    checkpointMessage(2, 'c2'),
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '真实请求' }] } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ], 1)))
check('a turn that only ever saw a checkpoint has no prompt',
  buildTimeline([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    checkpointMessage(2, 'c3'),
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])[0].prompt === '',
  JSON.stringify(buildTimeline([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    checkpointMessage(2, 'c3'),
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])[0].prompt))
// A steering message the user typed after the checkpoint is still theirs: only
// the harness's own marker is skipped, never a real message that happens to
// follow one.
check('a real message after a checkpoint is still kept',
  buildTimeline([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    checkpointMessage(2, 'c4'),
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '接着改' }] } },
  ])[0].prompt === '接着改',
  JSON.stringify(buildTimeline([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    checkpointMessage(2, 'c4'),
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '接着改' }] } },
  ])[0].prompt))

const retried = buildTimeline([
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'error', error: {} } } },
  { type: 'turn/start', seq: 3, time: 3, data: { turn: 1 } },
  { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
])
check('a retried turn collapses to one entry', retried.length === 1, String(retried.length))
check('the retried entry keeps the newest boundary', retried[0].seq === 4, String(retried[0].seq))

check('junk events are ignored',
  buildTimeline([null, {}, { type: 'turn/start' }, 'x', { type: 'turn/end' }]).length === 0,
  JSON.stringify(buildTimeline([null, {}, { type: 'turn/start' }, 'x', { type: 'turn/end' }])))
check('a long prompt is clipped', buildTimeline([
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'x'.repeat(600) }] } },
])[0].prompt.length <= 300)

console.log('\n== the title cleaner ==')
check('strips a wrapping quote pair', cleanSummary('"修复登录接口"') === '修复登录接口',
  JSON.stringify(cleanSummary('"修复登录接口"')))
check('strips a label prefix', cleanSummary('标题：修复登录接口') === '修复登录接口',
  JSON.stringify(cleanSummary('标题：修复登录接口')))
check('strips an echoed marker', cleanSummary('Ai-coding：修复登录接口') === '修复登录接口',
  JSON.stringify(cleanSummary('Ai-coding：修复登录接口')))
check('drops a trailing full stop', cleanSummary('修复登录接口。') === '修复登录接口',
  JSON.stringify(cleanSummary('修复登录接口。')))
check('takes only the first non-empty line',
  cleanSummary('\n\n修复登录接口\n这里是解释文字') === '修复登录接口',
  JSON.stringify(cleanSummary('\n\n修复登录接口\n这里是解释文字')))
check('strips a bullet marker', cleanSummary('- 修复登录接口') === '修复登录接口',
  JSON.stringify(cleanSummary('- 修复登录接口')))
check('collapses inner whitespace', cleanSummary('修复   登录\n接口') === '修复 登录',
  JSON.stringify(cleanSummary('修复   登录\n接口')))
const longTitle = cleanSummary('这是一个被模型写得很长的标题'.repeat(4))
check('caps an over-long title', longTitle.length <= 40, `${longTitle.length}: ${longTitle}`)
check('caps it with an ellipsis', longTitle.endsWith('\u2026'), JSON.stringify(longTitle))
check('returns nothing for empty input', cleanSummary('') === '' && cleanSummary(null) === '')
check('returns nothing for whitespace only', cleanSummary('   \n  ') === '')

console.log('\n== the title prompt ==')
check('names the user request', buildSummaryInput('修复开关', '').includes('修复开关'),
  JSON.stringify(buildSummaryInput('修复开关', '')))
check('includes the changed files when present',
  buildSummaryInput('修复开关', 'M\tlib/index.js').includes('lib/index.js'))
check('omits the file section when there is none',
  !buildSummaryInput('修复开关', '').includes('本轮改动文件'))

console.log('\n== a 0.2 state file migrates to the three-way preference ==')
const { createStore } = await import(new URL('../lib/store.js', import.meta.url).href)
/** Write a legacy state file and read it back through the store. */
function migratedState(legacy) {
  const file = join(home, `legacy-${String(Object.keys(legacy).length)}-${String(legacy.summarize)}.json`)
  writeFileSync(file, JSON.stringify({ version: 1, enabled: true, sessions: {}, ...legacy }), 'utf8')
  return createStore(file).summary
}
check('a legacy summarize:false becomes the off mode',
  migratedState({ summarize: false }).mode === 'off', JSON.stringify(migratedState({ summarize: false })))
check('a legacy summarize:true becomes the current mode',
  migratedState({ summarize: true }).mode === 'current', JSON.stringify(migratedState({ summarize: true })))
check('a state file with no preference at all defaults to current',
  migratedState({}).mode === 'current', JSON.stringify(migratedState({})))
check('a corrupt preference degrades to the default',
  migratedState({ summary: { mode: 'nonsense' } }).mode === 'current',
  JSON.stringify(migratedState({ summary: { mode: 'nonsense' } })))

const ctx = createContext()
apply(ctx)

let server = null
let base = ''

try {
  console.log('\n== route registration ==')
  check('a /chat-git route is registered', ctx.route !== null)
  check('the route is a prefix route', ctx.route?.kind === 'prefix', String(ctx.route?.kind))
  check('the route path is /chat-git', ctx.route?.path === '/chat-git', String(ctx.route?.path))
  ;({ server, base } = await serve(ctx))

  console.log('\n== the conversation start initializes the repository ==')
  check('no repository exists before the conversation starts', git(workspace, ['rev-parse', '--is-inside-work-tree']).code !== 0)
  await ctx.emit('agent/session-start', start(SESSION, workspace))
  // The bootstrap is fire-and-forget; the turn-end hook awaits the same
  // serialized promise, so a short settle is all that is needed here.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const inside = git(workspace, ['rev-parse', '--is-inside-work-tree'])
  check('git init created a repository at the workspace root', inside.out === 'true', inside.err || JSON.stringify(inside))

  console.log('\n== a finished turn is committed ==')
  writeFileSync(join(workspace, 'login.js'), 'export const login = () => true\n', 'utf8')
  // The prompt is recorded by the inbox claim, which is a separate concern from
  // the bootstrap: every turn fires it, including the first.
  await ctx.emit('agent/inbox/claimed', claim(SESSION, workspace, 1, '实现登录接口'))
  await ctx.emit('agent/turn-stopping', stop(SESSION, workspace, 1))
  const log1 = git(workspace, ['log', '--format=%s'])
  check('turn 1 produced a commit', log1.code === 0 && log1.out !== '', log1.err)
  check('the subject is the Ai-coding marker plus the prompt',
    log1.out === 'Ai-coding：实现登录接口', JSON.stringify(log1.out))

  console.log('\n== the next turn commits again ==')
  writeFileSync(join(workspace, 'login.js'), 'export const login = () => "ok"\n', 'utf8')
  writeFileSync(join(workspace, 'extra.txt'), 'added in turn 2\n', 'utf8')
  await ctx.emit('agent/inbox/claimed', claim(SESSION, workspace, 2, '把登录返回值改成 ok'))
  await ctx.emit('agent/turn-stopping', stop(SESSION, workspace, 2))
  const log2 = git(workspace, ['log', '--format=%s'])
  check('turn 2 produced a second commit', log2.out.split('\n').length === 2, JSON.stringify(log2.out))
  check('newest commit is listed first',
    log2.out.startsWith('Ai-coding：把登录返回值改成 ok'), JSON.stringify(log2.out))

  console.log('\n== an idle turn commits nothing ==')
  const beforeIdle = git(workspace, ['rev-list', '--count', 'HEAD']).out
  await ctx.emit('agent/turn-stopping', stop(SESSION, workspace, 3))
  check('a clean workspace adds no commit', git(workspace, ['rev-list', '--count', 'HEAD']).out === beforeIdle,
    `${beforeIdle} -> ${git(workspace, ['rev-list', '--count', 'HEAD']).out}`)
  const stateAfterIdle = (await call(base, '/chat-git/state', { sessionId: SESSION })).value
  check('the idle turn records no checkpoint', !stateAfterIdle.commits.some((entry) => entry.turn === 3),
    JSON.stringify(stateAfterIdle.commits.map((entry) => entry.turn)))

  console.log('\n== /chat-git/state ==')
  const state = (await call(base, '/chat-git/state', { sessionId: SESSION })).value
  check('state reports the workspace root', state.cwd === workspace, state.cwd)
  check('state reports two checkpoints', state.commits.length === 2, String(state.commits.length))
  check('state reports auto-checkpointing on by default', state.enabled === true)
  check('state reports git as available', state.git.available === true, JSON.stringify(state.git))
  check('state exposes the state file path', state.stateFile === join(home, 'chat-git.json'), state.stateFile)
  check('state persisted to disk', state.committed === true)

  console.log('\n== /chat-git/detect ==')
  const probe = (await call(base, '/chat-git/detect', {})).value
  check('detect finds git', probe.available === true, JSON.stringify(probe))
  check('detect reports a version string', /^git version /.test(probe.version), probe.version)

  console.log('\n== /chat-git/revert rolls the worktree back ==')
  const turn1 = state.commits.find((entry) => entry.turn === 1)
  // An untracked file belongs to no checkpoint; the rollback must leave it be
  // rather than silently destroying work the user never committed.
  writeFileSync(join(workspace, 'untracked-after.txt'), 'belongs to no checkpoint\n', 'utf8')
  const reverted = await call(base, '/chat-git/revert', { sessionId: SESSION, sha: turn1.sha })
  check('revert succeeds', reverted.ok === true, JSON.stringify(reverted))
  check('revert reports the restored turn', reverted.value?.turn === 1, JSON.stringify(reverted.value))
  check('revert reports the pruned path', (reverted.value?.removed ?? []).includes('extra.txt'),
    JSON.stringify(reverted.value?.removed))
  check('login.js is back to the turn-1 content',
    readFileSync(join(workspace, 'login.js'), 'utf8').replace(/\r\n/g, '\n') === 'export const login = () => true\n',
    JSON.stringify(readFileSync(join(workspace, 'login.js'), 'utf8')))
  check('extra.txt, added after the checkpoint, is gone',
    git(workspace, ['ls-files', 'extra.txt']).out === '', JSON.stringify(git(workspace, ['ls-files', 'extra.txt']).out))
  check('the untracked file is deliberately left alone',
    git(workspace, ['status', '--porcelain']).out.includes('untracked-after.txt'),
    git(workspace, ['status', '--porcelain']).out)
  check('HEAD is untouched, so later commits stay readable', git(workspace, ['rev-list', '--count', 'HEAD']).out === '2',
    git(workspace, ['rev-list', '--count', 'HEAD']).out)

  console.log('\n== revert guards ==')
  const unknown = await call(base, '/chat-git/revert', { sessionId: SESSION, sha: 'deadbeef' })
  check('an unknown sha is refused', unknown.ok === false && unknown.error.code === 'unknown-checkpoint', JSON.stringify(unknown))
  const noSession = await call(base, '/chat-git/revert', { sessionId: 'nope', sha: turn1.sha })
  check('an unknown session is refused', noSession.ok === false && noSession.error.code === 'session-unknown', JSON.stringify(noSession))
  const missingSha = await call(base, '/chat-git/revert', { sessionId: SESSION })
  check('revert without a sha is refused', missingSha.ok === false && missingSha.error.code === 'bad-request', JSON.stringify(missingSha))

  // Regression guard for the settings page: it has no session and reads the
  // host with an empty id. Refusing that shape left the switch permanently
  // disabled with a "sessionId is required" error, so this call must stay valid.
  console.log('\n== the settings page reads the host without a session ==')
  const settingsState = await call(base, '/chat-git/state', { sessionId: '' })
  check('an empty sessionId is a valid global read', settingsState.ok === true, JSON.stringify(settingsState))
  check('the global read reports the preference', settingsState.value?.enabled === true,
    JSON.stringify(settingsState.value?.enabled))
  check('the global read reports the state file path',
    settingsState.value?.stateFile === join(home, 'chat-git.json'), String(settingsState.value?.stateFile))
  check('the global read probes git', settingsState.value?.git?.available === true,
    JSON.stringify(settingsState.value?.git))
  check('the global read carries no checkpoints',
    Array.isArray(settingsState.value?.commits) && settingsState.value.commits.length === 0,
    JSON.stringify(settingsState.value?.commits))
  check('the global read carries no workspace root', settingsState.value?.cwd === '',
    JSON.stringify(settingsState.value?.cwd))
  check('the global read reports the History-tab preference',
    settingsState.value?.history === true, JSON.stringify(settingsState.value?.history))
  const settingsNoBody = await call(base, '/chat-git/state', {})
  check('an omitted sessionId behaves like an empty one', settingsNoBody.ok === true, JSON.stringify(settingsNoBody))

  console.log('\n== /chat-git/inherit carries checkpoints to a fork ==')
  const inherited = await call(base, '/chat-git/inherit', { from: SESSION, to: 'session-fork-1', turn: 1 })
  check('inherit reports the carried count', inherited.value?.inherited === 1, JSON.stringify(inherited))
  const forkState = (await call(base, '/chat-git/state', { sessionId: 'session-fork-1' })).value
  check('the fork sees the surviving checkpoint', forkState.commits.length === 1, String(forkState.commits.length))
  check('the fork knows the workspace root', forkState.cwd === workspace, forkState.cwd)

  console.log('\n== the switch disables checkpointing ==')
  const off = await call(base, '/chat-git/set-enabled', { enabled: false })
  check('disabling succeeds', off.ok === true && off.value.enabled === false, JSON.stringify(off))
  writeFileSync(join(workspace, 'while-off.txt'), 'no commit expected\n', 'utf8')
  await ctx.emit('agent/turn-stopping', stop(SESSION, workspace, 9))
  check('a disabled plugin commits nothing', !git(workspace, ['log', '--format=%s']).out.includes('while-off')
    && git(workspace, ['status', '--porcelain']).out.includes('while-off.txt'),
    git(workspace, ['status', '--porcelain']).out)
  const on = await call(base, '/chat-git/set-enabled', { enabled: true })
  check('re-enabling succeeds while git exists', on.ok === true && on.value.enabled === true, JSON.stringify(on))

  console.log('\n== the History tab can be withdrawn and restored ==')
  // Presentation only: no git probe guards this, so it must work even on a
  // machine with no git and must never disturb the checkpoint preference.
  const tabOff = await call(base, '/chat-git/set-history', { history: false })
  check('withdrawing the tab succeeds', tabOff.ok === true && tabOff.value.history === false,
    JSON.stringify(tabOff))
  const tabOffState = (await call(base, '/chat-git/state', { sessionId: '' })).value
  check('the settings page reads the withdrawn preference', tabOffState.history === false,
    JSON.stringify(tabOffState.history))
  check('withdrawing the tab leaves checkpointing on', tabOffState.enabled === true,
    JSON.stringify(tabOffState.enabled))
  // The field name is the whole point: a route that read `enabled` instead
  // answered ok and coerced every `{ history: true }` to false, leaving the tab
  // withdrawn forever with no way back.
  const tabOn = await call(base, '/chat-git/set-history', { history: true })
  check('restoring the tab succeeds', tabOn.ok === true && tabOn.value.history === true,
    JSON.stringify(tabOn))
  const tabMissing = await call(base, '/chat-git/set-history', {})
  check('a request with no history field turns the tab off rather than erroring',
    tabMissing.ok === true && tabMissing.value.history === false, JSON.stringify(tabMissing))
  await call(base, '/chat-git/set-history', { history: true })

  console.log('\n== the automatic save interval ==')
  // The interval throttles the git side only. The conversation keeps being
  // recorded every turn by the harness's own session log, so this setting can
  // never make the conversation history sparser — it trades checkpoint
  // granularity for fewer commits, and the changes wait in the worktree.
  const intervalDefault = (await call(base, '/chat-git/state', { sessionId: '' })).value
  check('the interval defaults to every turn', intervalDefault.interval === 1,
    JSON.stringify(intervalDefault.interval))
  // 0 would mean "never commit" while the switch still reads as on, so it is
  // refused rather than stored.
  const badZero = await call(base, '/chat-git/set-interval', { interval: 0 })
  check('an interval of 0 is refused', badZero.ok === false && badZero.error.code === 'bad-preference',
    JSON.stringify(badZero))
  const badHigh = await call(base, '/chat-git/set-interval', { interval: 11 })
  check('an interval above the cap is refused',
    badHigh.ok === false && badHigh.error.code === 'bad-preference', JSON.stringify(badHigh))
  const badType = await call(base, '/chat-git/set-interval', { interval: '2' })
  check('a non-integer interval is refused',
    badType.ok === false && badType.error.code === 'bad-preference', JSON.stringify(badType))
  check('a refused interval leaves the stored preference untouched',
    (await call(base, '/chat-git/state', { sessionId: '' })).value.interval === 1)
  const everyThree = await call(base, '/chat-git/set-interval', { interval: 3 })
  check('an interval of three is accepted', everyThree.ok === true && everyThree.value.interval === 3,
    JSON.stringify(everyThree))

  const intervalWs = join(sandbox, 'interval')
  mkdirSync(intervalWs, { recursive: true })
  await ctx.emit('agent/session-start', start('session-interval', intervalWs))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  /** Commit count, where an unborn HEAD reads as zero rather than as an error. */
  const commitsIn = (cwd) => git(cwd, ['rev-list', '--count', 'HEAD']).out || '0'

  writeFileSync(join(intervalWs, 'one.txt'), 'one\n', 'utf8')
  await ctx.emit('agent/inbox/claimed', claim('session-interval', intervalWs, 1, '第一轮'))
  await ctx.emit('agent/turn-stopping', stop('session-interval', intervalWs, 1))
  check('a turn before the interval is not committed', commitsIn(intervalWs) === '0', commitsIn(intervalWs))
  check('the uncommitted change waits in the worktree',
    git(intervalWs, ['status', '--porcelain']).out.includes('one.txt'),
    git(intervalWs, ['status', '--porcelain']).out)

  writeFileSync(join(intervalWs, 'two.txt'), 'two\n', 'utf8')
  await ctx.emit('agent/inbox/claimed', claim('session-interval', intervalWs, 2, '第二轮'))
  await ctx.emit('agent/turn-stopping', stop('session-interval', intervalWs, 2))
  check('the second turn is still not committed', commitsIn(intervalWs) === '0', commitsIn(intervalWs))

  writeFileSync(join(intervalWs, 'three.txt'), 'three\n', 'utf8')
  await ctx.emit('agent/inbox/claimed', claim('session-interval', intervalWs, 3, '第三轮'))
  await ctx.emit('agent/turn-stopping', stop('session-interval', intervalWs, 3))
  check('the eligible turn commits', commitsIn(intervalWs) === '1', commitsIn(intervalWs))
  // The whole point of accumulating: everything written across the interval
  // lands in the one commit, not just the last turn's file.
  const intervalShow = git(intervalWs, ['show', '--name-only', '--format=%s', 'HEAD']).out
  check('the commit carries every file written since the last checkpoint',
    intervalShow.includes('one.txt') && intervalShow.includes('two.txt') && intervalShow.includes('three.txt'),
    JSON.stringify(intervalShow))
  check('the commit is titled for the turn that produced it',
    intervalShow.startsWith('Ai-coding：第三轮'), JSON.stringify(intervalShow))
  check('the worktree is clean once the interval commits',
    git(intervalWs, ['status', '--porcelain']).out === '', git(intervalWs, ['status', '--porcelain']).out)

  const backToOne = await call(base, '/chat-git/set-interval', { interval: 1 })
  check('the interval can be returned to every turn',
    backToOne.ok === true && backToOne.value.interval === 1, JSON.stringify(backToOne))

  console.log('\n== the preference survives a reload ==')
  const reloaded = createContext()
  apply(reloaded)
  const second = await serve(reloaded)
  const reloadState = (await call(second.base, '/chat-git/state', { sessionId: SESSION })).value
  // The earlier revert dropped turn 2's checkpoint, so exactly the turn-1 row
  // must come back off disk — proving the truncation was persisted, not just
  // applied in memory.
  check('the surviving checkpoint list came back off disk', reloadState.commits.length === 1,
    JSON.stringify(reloadState.commits.map((entry) => entry.turn)))
  check('the surviving checkpoint is turn 1', reloadState.commits[0]?.turn === 1,
    JSON.stringify(reloadState.commits[0]?.turn))
  check('the workspace root survived the reload', reloadState.cwd === workspace, reloadState.cwd)
  check('the enabled preference survived the reload', reloadState.enabled === true)
  reloaded.dispose()
  await new Promise((resolve) => second.server.close(resolve))

  console.log('\n== an adopted existing repository is not re-initialized ==')
  const adopted = join(sandbox, 'adopted')
  mkdirSync(adopted, { recursive: true })
  git(adopted, ['init'])
  const headBefore = git(adopted, ['symbolic-ref', 'HEAD']).out
  await ctx.emit('agent/session-start', start('session-adopted', adopted))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  check('the existing repository is reused', git(adopted, ['rev-parse', '--is-inside-work-tree']).out === 'true')
  check('the existing HEAD is untouched', git(adopted, ['symbolic-ref', 'HEAD']).out === headBefore,
    `${headBefore} -> ${git(adopted, ['symbolic-ref', 'HEAD']).out}`)

  console.log('\n== the conversation start is idempotent ==')
  const adoptedLog = git(adopted, ['log', '--oneline']).out
  await ctx.emit('agent/session-start', start('session-adopted', adopted))
  await ctx.emit('agent/session-start', start('session-adopted-2', adopted))
  await new Promise((resolve) => setTimeout(resolve, 800))
  check('repeated starts leave the repository alone', git(adopted, ['log', '--oneline']).out === adoptedLog
    && git(adopted, ['status', '--porcelain']).out === '',
    git(adopted, ['status', '--porcelain']).out)

  console.log('\n== the subject contract ==')
  const longPrompt = '把整个登录流程重构成基于令牌的鉴权机制，补上刷新令牌与失效回退，为每个分支补齐单元测试和集成测试，并且同步更新接口文档与部署说明'
  const narrow = join(sandbox, 'narrow')
  mkdirSync(narrow, { recursive: true })
  await ctx.emit('agent/session-start', start('session-narrow', narrow))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  writeFileSync(join(narrow, 'a.txt'), 'one\n', 'utf8')
  await ctx.emit('agent/inbox/claimed', claim('session-narrow', narrow, 1, longPrompt))
  await ctx.emit('agent/turn-stopping', stop('session-narrow', narrow, 1))
  const clipped = git(narrow, ['log', '-1', '--format=%s']).out
  check('a long prompt is clipped to one subject line', clipped.length <= 72, `${clipped.length}: ${clipped}`)
  check('the clipped subject keeps the marker', clipped.startsWith('Ai-coding：'), JSON.stringify(clipped))
  check('the clipped subject is marked as truncated', clipped.endsWith('\u2026'), JSON.stringify(clipped))

  // A turn whose prompt was never recorded (a resumed session, or a turn with
  // no user message) must still produce a well-formed subject.
  writeFileSync(join(narrow, 'b.txt'), 'two\n', 'utf8')
  await ctx.emit('agent/turn-stopping', stop('session-narrow', narrow, 2))
  const fallback = git(narrow, ['log', '-1', '--format=%s']).out
  check('a turn with no recorded prompt still carries the marker',
    fallback.startsWith('Ai-coding：'), JSON.stringify(fallback))
  check('the fallback names the turn', fallback.includes('2'), JSON.stringify(fallback))

  console.log('\n== add is scoped to the workspace subtree ==')
  // The workspace sits inside a repository that is NOT its root: the plugin must
  // create its own nested repository rather than committing into the ancestor.
  const outer = join(sandbox, 'outer')
  const inner = join(outer, 'inner')
  mkdirSync(inner, { recursive: true })
  git(outer, ['init'])
  writeFileSync(join(outer, 'outside.txt'), 'belongs to the ancestor\n', 'utf8')
  await ctx.emit('agent/session-start', start('session-inner', inner))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  writeFileSync(join(inner, 'inside.txt'), 'belongs to the workspace\n', 'utf8')
  await ctx.emit('agent/turn-stopping', stop('session-inner', inner, 1))
  check('the workspace gets its own repository', git(inner, ['rev-parse', '--is-inside-work-tree']).out === 'true')
  check('the nested repository root is the workspace', git(inner, ['rev-parse', '--show-toplevel']).out !== ''
    && git(inner, ['rev-parse', '--show-toplevel']).out.replace(/\\/g, '/').toLowerCase().endsWith('/inner'),
    git(inner, ['rev-parse', '--show-toplevel']).out)
  check('the ancestor repository is left completely untouched',
    git(outer, ['status', '--porcelain']).out.includes('outside.txt')
    && !git(outer, ['status', '--porcelain']).out.includes('inside.txt'),
    git(outer, ['status', '--porcelain']).out)
  check('the workspace commit stayed inside the workspace',
    git(inner, ['log', '-1', '--format=%s']).out.startsWith('Ai-coding：'),
    git(inner, ['log', '-1', '--format=%s']).out)

  // -------------------------------------------------------------------------
  // AI commit titles. These run against their own context so the deterministic
  // fallback exercised above stays covered by the same assertions it had.
  // -------------------------------------------------------------------------
  console.log('\n== a model title becomes the commit subject ==')
  const aiCtx = createContext({ llm: llmStub, agentDefaultModel: modelRouteStub, sessions: sessionsStub })
  apply(aiCtx)
  const aiServer = await serve(aiCtx)
  const ai = join(sandbox, 'ai')
  mkdirSync(ai, { recursive: true })
  await aiCtx.emit('agent/session-start', start('session-ai', ai))
  await new Promise((resolve) => setTimeout(resolve, 1200))

  writeFileSync(join(ai, 'widget.js'), 'export const widget = 1\n', 'utf8')
  await aiCtx.emit('agent/inbox/claimed', claim('session-ai', ai, 1, '把设置页的开关修好，并且补一个回归测试'))
  await aiCtx.emit('agent/turn-stopping', stop('session-ai', ai, 1))
  const aiSubject = git(ai, ['log', '-1', '--format=%s']).out
  check('the subject is the model title behind the marker',
    aiSubject === 'Ai-coding：修复设置页开关无法启用', JSON.stringify(aiSubject))

  const firstCall = llmCalls[0]
  check('the model was asked on the configured route',
    firstCall?.provider === 'fake-provider' && firstCall?.model === 'fake-model',
    JSON.stringify({ provider: firstCall?.provider, model: firstCall?.model }))
  check('the title prompt carried the user request',
    String(firstCall?.messages?.[0]?.content?.[0]?.text ?? '').includes('把设置页的开关修好'),
    JSON.stringify(firstCall?.messages?.[0]?.content?.[0]?.text))
  check('the title prompt carried the files this turn changed',
    String(firstCall?.messages?.[0]?.content?.[0]?.text ?? '').includes('widget.js'),
    JSON.stringify(firstCall?.messages?.[0]?.content?.[0]?.text))
  check('the title prompt attributes the message to this plugin',
    firstCall?.messages?.[0]?.source?.plugin === 'chat-git',
    JSON.stringify(firstCall?.messages?.[0]?.source))
  check('the title call is deterministic', firstCall?.temperature === 0, String(firstCall?.temperature))
  check('the title call is output-capped', typeof firstCall?.maxTokens === 'number' && firstCall.maxTokens <= 128,
    String(firstCall?.maxTokens))

  console.log('\n== an unusable model answer falls back to the prompt ==')
  llmMode = 'error'
  writeFileSync(join(ai, 'second.js'), 'export const second = 2\n', 'utf8')
  await aiCtx.emit('agent/inbox/claimed', claim('session-ai', ai, 2, '给第二个组件加上导出'))
  await aiCtx.emit('agent/turn-stopping', stop('session-ai', ai, 2))
  check('a failed stream still produces the prompt-based subject',
    git(ai, ['log', '-1', '--format=%s']).out === 'Ai-coding：给第二个组件加上导出',
    git(ai, ['log', '-1', '--format=%s']).out)

  llmMode = 'throw'
  writeFileSync(join(ai, 'third.js'), 'export const third = 3\n', 'utf8')
  await aiCtx.emit('agent/inbox/claimed', claim('session-ai', ai, 3, '补齐第三个导出'))
  await aiCtx.emit('agent/turn-stopping', stop('session-ai', ai, 3))
  check('a throwing provider still produces the prompt-based subject',
    git(ai, ['log', '-1', '--format=%s']).out === 'Ai-coding：补齐第三个导出',
    git(ai, ['log', '-1', '--format=%s']).out)

  llmMode = 'title'
  llmTitle = '这是一段又长又啰嗦的模型输出'.repeat(4)
  writeFileSync(join(ai, 'fourth.js'), 'export const fourth = 4\n', 'utf8')
  await aiCtx.emit('agent/inbox/claimed', claim('session-ai', ai, 4, '第四个导出'))
  await aiCtx.emit('agent/turn-stopping', stop('session-ai', ai, 4))
  const cappedSubject = git(ai, ['log', '-1', '--format=%s']).out
  check('an over-long model answer is capped into the subject', cappedSubject.length <= 72,
    `${cappedSubject.length}: ${cappedSubject}`)
  check('the capped subject keeps the marker', cappedSubject.startsWith('Ai-coding：'), JSON.stringify(cappedSubject))
  llmTitle = '修复设置页开关无法启用'

  console.log('\n== the summary preference: off ==')
  const offSummary = await call(aiServer.base, '/chat-git/set-summary', { mode: 'off' })
  check('the preference can be turned off',
    offSummary.ok === true && offSummary.value.summary.mode === 'off', JSON.stringify(offSummary))
  const callsBefore = llmCalls.length
  writeFileSync(join(ai, 'fifth.js'), 'export const fifth = 5\n', 'utf8')
  await aiCtx.emit('agent/inbox/claimed', claim('session-ai', ai, 5, '第五个导出'))
  await aiCtx.emit('agent/turn-stopping', stop('session-ai', ai, 5))
  check('no model call is made while the preference is off',
    llmCalls.length === callsBefore, `${String(llmCalls.length - callsBefore)} extra call(s)`)
  check('the subject comes straight from the prompt',
    git(ai, ['log', '-1', '--format=%s']).out === 'Ai-coding：第五个导出',
    git(ai, ['log', '-1', '--format=%s']).out)

  console.log('\n== the summary preference: a configured route ==')
  const custom = await call(aiServer.base, '/chat-git/set-summary',
    { mode: 'custom', provider: 'other-provider', model: 'tiny-model' })
  check('a custom route is accepted',
    custom.ok === true && custom.value.summary.mode === 'custom', JSON.stringify(custom))
  writeFileSync(join(ai, 'sixth.js'), 'export const sixth = 6\n', 'utf8')
  await aiCtx.emit('agent/inbox/claimed', claim('session-ai', ai, 6, '第六个导出'))
  await aiCtx.emit('agent/turn-stopping', stop('session-ai', ai, 6))
  const customCall = llmCalls.at(-1)
  check('the model was asked on the configured route',
    customCall?.provider === 'other-provider' && customCall?.model === 'tiny-model',
    JSON.stringify({ provider: customCall?.provider, model: customCall?.model }))

  console.log('\n== the summary preference: the conversation route ==')
  const backToCurrent = await call(aiServer.base, '/chat-git/set-summary', { mode: 'current' })
  check('the current mode is accepted',
    backToCurrent.ok === true && backToCurrent.value.summary.mode === 'current', JSON.stringify(backToCurrent))
  // The agent's own frozen route must win over the default selection: "current"
  // means the model this conversation is actually talking to.
  const routeAgent = {
    session: { header: { id: 'session-route', cwd: ai } },
    options: { provider: 'session-provider', model: 'session-model' },
  }
  writeFileSync(join(ai, 'seventh.js'), 'export const seventh = 7\n', 'utf8')
  await aiCtx.emit('agent/inbox/claimed', {
    agent: routeAgent,
    message: { content: [{ type: 'text', text: '走会话自身的路由' }] },
    turn: 1,
  })
  await aiCtx.emit('agent/turn-stopping', { agent: routeAgent, turn: 1 })
  const routeCall = llmCalls.at(-1)
  check('the conversation route is preferred over the default',
    routeCall?.provider === 'session-provider' && routeCall?.model === 'session-model',
    JSON.stringify({ provider: routeCall?.provider, model: routeCall?.model }))
  check('the conversation-mode subject still carries the marker',
    git(ai, ['log', '-1', '--format=%s']).out === 'Ai-coding：修复设置页开关无法启用',
    git(ai, ['log', '-1', '--format=%s']).out)

  console.log('\n== an unusable summary preference is refused ==')
  const incomplete = await call(aiServer.base, '/chat-git/set-summary',
    { mode: 'custom', provider: 'other-provider', model: '' })
  check('custom with an empty model is refused',
    incomplete.ok === false && incomplete.error.code === 'bad-preference', JSON.stringify(incomplete))
  // A patch that names only the mode keeps whatever route is already stored, so
  // the refusal case is an explicitly emptied route, not an omitted one.
  const noRoute = await call(aiServer.base, '/chat-git/set-summary',
    { mode: 'custom', provider: '', model: '' })
  check('custom with an emptied route is refused',
    noRoute.ok === false && noRoute.error.code === 'bad-preference', JSON.stringify(noRoute))
  const badMode = await call(aiServer.base, '/chat-git/set-summary', { mode: 'whenever' })
  check('an unknown mode is refused',
    badMode.ok === false && badMode.error.code === 'bad-preference', JSON.stringify(badMode))
  const keptMode = (await call(aiServer.base, '/chat-git/state', { sessionId: '' })).value?.summary
  check('a refused patch leaves the stored preference untouched',
    keptMode?.mode === 'current', JSON.stringify(keptMode))

  console.log('\n== the model catalogue behind the picker ==')
  // This call also proves the per-provider deadline: the stub's second provider
  // never settles, so the answer can only arrive if the bound is enforced.
  const startedCatalogue = Date.now()
  const models = (await call(aiServer.base, '/chat-git/models', {})).value
  const catalogueMs = Date.now() - startedCatalogue
  check('the catalogue lists every registered provider',
    Array.isArray(models?.providers) && models.providers.length === 2,
    JSON.stringify(models?.providers?.map((entry) => entry.id)))
  check('a provider that answers lists its models',
    models.providers.find((entry) => entry.id === 'fake-provider')?.models.length === 2,
    JSON.stringify(models.providers.find((entry) => entry.id === 'fake-provider')?.models))
  check('a provider that never answers degrades to an empty model list',
    models.providers.find((entry) => entry.id === 'slow-provider')?.models.length === 0,
    JSON.stringify(models.providers.find((entry) => entry.id === 'slow-provider')?.models))
  check('the stalled provider does not hold up the answer',
    catalogueMs < 8000, `${String(catalogueMs)}ms`)
  check('the catalogue reports the route current would use',
    models?.current?.provider === 'fake-provider', JSON.stringify(models?.current))
  check('the catalogue reports the stored preference',
    models?.configured?.mode === 'current', JSON.stringify(models?.configured))
  const cachedCatalogue = Date.now()
  await call(aiServer.base, '/chat-git/models', {})
  check('the catalogue is cached rather than re-probed each time',
    Date.now() - cachedCatalogue < 1000, `${String(Date.now() - cachedCatalogue)}ms`)

  console.log('\n== a resend can pick the model it runs on ==')
  // `session.create` and `session.fork` build their child from the default
  // selection, so writing that selection *before* either call is what makes the
  // new line run the chosen model. Validating against the live catalogue is the
  // other half: a route this deployment cannot serve would otherwise fail much
  // later, with the conversation already moved.
  modelSelections.length = 0
  const pickedModel = await call(aiServer.base, '/chat-git/set-model',
    { provider: 'fake-provider', model: 'tiny-model' })
  check('a registered route is accepted',
    pickedModel.ok === true && pickedModel.value.model === 'tiny-model', JSON.stringify(pickedModel))
  check('the choice is written as the default selection',
    modelSelections.length === 1 && modelSelections[0].provider === 'fake-provider'
    && modelSelections[0].model === 'tiny-model',
    JSON.stringify(modelSelections))
  const noModel = await call(aiServer.base, '/chat-git/set-model', { provider: 'fake-provider' })
  check('a switch without a model is refused',
    noModel.ok === false && noModel.error.code === 'bad-request', JSON.stringify(noModel))
  const noProvider = await call(aiServer.base, '/chat-git/set-model', { provider: '', model: 'tiny-model' })
  check('a switch without a provider is refused',
    noProvider.ok === false && noProvider.error.code === 'bad-request', JSON.stringify(noProvider))
  const unregistered = await call(aiServer.base, '/chat-git/set-model',
    { provider: 'fake-provider', model: 'not-a-model' })
  check('a model this deployment does not register is refused',
    unregistered.ok === false && unregistered.error.code === 'unknown-model', JSON.stringify(unregistered))
  const unknownProvider = await call(aiServer.base, '/chat-git/set-model',
    { provider: 'no-such-provider', model: 'fake-model' })
  check('a provider this deployment does not register is refused',
    unknownProvider.ok === false && unknownProvider.error.code === 'unknown-model',
    JSON.stringify(unknownProvider))
  check('a refused switch writes nothing',
    modelSelections.length === 1, JSON.stringify(modelSelections))

  console.log('\n== the timeline route ==')
  // A fresh session so the commit join is deterministic: turn 1 will have a
  // checkpoint, turn 2 will not.
  const timelineWorkspace = join(sandbox, 'timeline')
  mkdirSync(timelineWorkspace, { recursive: true })
  await aiCtx.emit('agent/session-start', start('session-timeline', timelineWorkspace))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  writeFileSync(join(timelineWorkspace, 'first.js'), 'export const first = 1\n', 'utf8')
  await aiCtx.emit('agent/inbox/claimed', claim('session-timeline', timelineWorkspace, 1, '第一轮的请求'))
  await aiCtx.emit('agent/turn-stopping', stop('session-timeline', timelineWorkspace, 1))
  sessionLogs.set('session-timeline', [
    { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 101, data: { content: [{ type: 'text', text: '第一轮的请求' }] } },
    { type: 'assistant/message', seq: 3, time: 110, data: { turn: 1, step: 1, message: {} } },
    { type: 'turn/end', seq: 4, time: 120, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 5, time: 200, data: { turn: 2 } },
    { type: 'user/message', seq: 6, time: 201, data: { content: [{ type: 'text', text: '第二轮的请求' }] } },
    { type: 'turn/end', seq: 7, time: 210, data: { turn: 2, reason: { kind: 'completed' } } },
  ])

  const timeline = (await call(aiServer.base, '/chat-git/timeline', { sessionId: 'session-timeline' })).value
  check('the route returns every turn in order',
    timeline?.turns?.map((entry) => entry.turn).join(',') === '1,2',
    JSON.stringify(timeline?.turns?.map((entry) => entry.turn)))
  check('each turn carries its fork boundary',
    timeline.turns[0].seq === 4 && timeline.turns[1].seq === 7,
    JSON.stringify(timeline.turns.map((entry) => entry.seq)))
  check('each turn carries its prompt',
    timeline.turns[0].prompt === '第一轮的请求', JSON.stringify(timeline.turns[0].prompt))
  check('the checkpoint is joined onto its turn',
    typeof timeline.turns[0].commit?.sha === 'string' && timeline.turns[0].commit.sha !== '',
    JSON.stringify(timeline.turns[0].commit))
  check('the joined subject keeps the marker',
    String(timeline.turns[0].commit?.subject).startsWith('Ai-coding：'),
    String(timeline.turns[0].commit?.subject))
  check('a turn with no checkpoint reports null', timeline.turns[1].commit === null,
    JSON.stringify(timeline.turns[1].commit))
  check('the route reports the workspace root', timeline.cwd === timelineWorkspace, String(timeline.cwd))
  const unloaded = await call(aiServer.base, '/chat-git/timeline', { sessionId: 'session-not-loaded' })
  check('a conversation that is not loaded is reported, not guessed',
    unloaded.ok === false && unloaded.error.code === 'session-unavailable', JSON.stringify(unloaded))
  const noTimelineId = await call(aiServer.base, '/chat-git/timeline', {})
  check('the timeline needs a sessionId',
    noTimelineId.ok === false && noTimelineId.error.code === 'bad-request', JSON.stringify(noTimelineId))

  console.log('\n== the turn-prompt route keeps the whole prompt ==')
  // The panel renders a clipped card, but 编辑并重新发送 hands this text back to
  // the model: resending a clip would quietly ask for something the user never
  // wrote. A 600-character prompt is what makes the distinction observable —
  // the timeline answer clips it, and this route must not.
  const longTurnPrompt = `开头${'x'.repeat(600)}结尾`
  sessionLogs.set('session-long', [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: longTurnPrompt }] } },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const fullPrompt = (await call(aiServer.base, '/chat-git/turn-prompt',
    { sessionId: 'session-long', turn: 1 })).value
  check('the route returns the whole prompt', fullPrompt?.prompt === longTurnPrompt,
    JSON.stringify(String(fullPrompt?.prompt).length))
  check('the returned prompt is longer than the display clip',
    String(fullPrompt?.prompt).length > 300, String(String(fullPrompt?.prompt).length))
  check('the route echoes the turn it answered for', fullPrompt?.turn === 1, JSON.stringify(fullPrompt?.turn))
  const clippedPrompt = (await call(aiServer.base, '/chat-git/timeline',
    { sessionId: 'session-long' })).value.turns[0].prompt
  check('the timeline answer stays clipped for display',
    clippedPrompt.length <= 300 && clippedPrompt !== longTurnPrompt, String(clippedPrompt.length))

  const noPromptTurn = await call(aiServer.base, '/chat-git/turn-prompt',
    { sessionId: 'session-long', turn: 99 })
  check('a turn the conversation never had is refused',
    noPromptTurn.ok === false && noPromptTurn.error.code === 'turn-unknown', JSON.stringify(noPromptTurn))
  const badTurn = await call(aiServer.base, '/chat-git/turn-prompt', { sessionId: 'session-long' })
  check('the route needs a whole turn number',
    badTurn.ok === false && badTurn.error.code === 'bad-request', JSON.stringify(badTurn))
  const noPromptSession = await call(aiServer.base, '/chat-git/turn-prompt', { sessionId: '', turn: 1 })
  check('the route needs a sessionId',
    noPromptSession.ok === false && noPromptSession.error.code === 'bad-request', JSON.stringify(noPromptSession))
  const unloadedPrompt = await call(aiServer.base, '/chat-git/turn-prompt',
    { sessionId: 'session-not-loaded', turn: 1 })
  check('a conversation that is not loaded is reported here too',
    unloadedPrompt.ok === false && unloadedPrompt.error.code === 'session-unavailable',
    JSON.stringify(unloadedPrompt))

  console.log('\n== turnPrompt reads one turn out of a log ==')
  check('the whole prompt is returned unclipped',
    turnPrompt(sessionLogs.get('session-long'), 1) === longTurnPrompt,
    String(String(turnPrompt(sessionLogs.get('session-long'), 1)).length))
  check('an unknown turn answers null', turnPrompt(sessionLogs.get('session-long'), 7) === null,
    JSON.stringify(turnPrompt(sessionLogs.get('session-long'), 7)))
  check('a log that is not an array answers null', turnPrompt(undefined, 1) === null,
    JSON.stringify(turnPrompt(undefined, 1)))
  check('the first user message stays the prompt, not the steering one',
    turnPrompt([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '原始请求' }] } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '插话' }] } },
    ], 1) === '原始请求',
    JSON.stringify(turnPrompt([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '原始请求' }] } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '插话' }] } },
    ], 1)))

  console.log('\n== the workspace pane reads the repository on its own route ==')
  // The whole point of the split: this answer never mentions a turn, and the
  // timeline answer above never mentions a repository. Reading git directly is
  // what lets the pane show commits this plugin did not create.
  const repoRead = (await call(aiServer.base, '/chat-git/repo', { sessionId: 'session-timeline' })).value
  // git echoes the root with forward slashes even on Windows, so the comparison
  // normalizes both sides rather than assuming the separator `join` produced.
  const samePath = (left, right) => String(left).replace(/\\/g, '/').toLowerCase()
    === String(right).replace(/\\/g, '/').toLowerCase()
  check('the repo route reports the repository root', samePath(repoRead?.root, timelineWorkspace),
    String(repoRead?.root))
  check('the repo route names the current branch', repoRead?.branch !== '', JSON.stringify(repoRead?.branch))
  check('the repo route reports a clean worktree', repoRead?.dirty === false, JSON.stringify(repoRead?.dirty))
  check('the repo route reports HEAD', typeof repoRead?.head === 'string' && repoRead.head.length === 40,
    JSON.stringify(repoRead?.head))
  // Where the *worktree* stands, which is not the same question as HEAD once a
  // restore has happened: restoring leaves HEAD alone on purpose, so the pane's
  // 当前位置 marker has to come from the store rather than from git.
  check('a checkpointed conversation stands where its newest commit is',
    repoRead?.position === repoRead?.head, JSON.stringify(repoRead?.position))
  // Known, not guessed: committing the worktree is itself what puts the position
  // there, so the store has a real answer even before any restore happens.
  check('a recorded position is reported as known rather than as HEAD',
    repoRead?.positionKnown === true, JSON.stringify(repoRead?.positionKnown))
  check('the repo route lists the history', repoRead?.commits?.length === 1,
    JSON.stringify(repoRead?.commits?.length))
  // Author included: the pane shows the repository's real history, so a commit
  // this plugin did not write still has to be attributable.
  check('a commit row carries every field the pane renders',
    typeof repoRead?.commits?.[0]?.sha === 'string' && typeof repoRead?.commits?.[0]?.short === 'string'
    && typeof repoRead?.commits?.[0]?.subject === 'string' && typeof repoRead?.commits?.[0]?.date === 'string'
    && typeof repoRead?.commits?.[0]?.author === 'string' && repoRead.commits[0].author !== '',
    JSON.stringify(repoRead?.commits?.[0]))
  check('the short id is an abbreviation of the full one',
    repoRead.commits[0].sha.startsWith(repoRead.commits[0].short),
    JSON.stringify({ sha: repoRead.commits[0].sha, short: repoRead.commits[0].short }))
  check('the date is an ISO timestamp the client can parse',
    !Number.isNaN(Date.parse(repoRead.commits[0].date)), JSON.stringify(repoRead.commits[0].date))
  const noRepoId = await call(aiServer.base, '/chat-git/repo', {})
  check('the repo route needs a sessionId',
    noRepoId.ok === false && noRepoId.error.code === 'bad-request', JSON.stringify(noRepoId))
  const unknownRepo = await call(aiServer.base, '/chat-git/repo', { sessionId: 'session-never-opened' })
  check('the repo route refuses a session with no recorded workspace',
    unknownRepo.ok === false && unknownRepo.error.code === 'session-unknown', JSON.stringify(unknownRepo))

  // The exact failure the pane used to show: a conversation that was already
  // open when this plugin loaded has no `cwd` in the store, so the store alone
  // answered "no workspace is recorded" for a repository sitting right there.
  // The live session header is authoritative, and the route must consult it.
  const headerWorkspace = join(sandbox, 'header-only')
  mkdirSync(headerWorkspace, { recursive: true })
  git(headerWorkspace, ['init'])
  sessionHeaders.set('session-header-only', { id: 'session-header-only', cwd: headerWorkspace })
  const headerRead = await call(aiServer.base, '/chat-git/repo', { sessionId: 'session-header-only' })
  check('a session the store never checkpointed still resolves its workspace from its live header',
    headerRead.ok === true, JSON.stringify(headerRead))
  check('the resolved root is that header cwd',
    samePath(headerRead.value?.root, headerWorkspace), String(headerRead.value?.root))
  // The one case where nothing is known: the store has never seen this session,
  // so it has no position to report. The route resolves it to HEAD and says so,
  // which is what keeps the pane from presenting a guess as a record.
  check('a session the store never recorded reports no known position',
    headerRead.value?.positionKnown === false && headerRead.value?.position === headerRead.value?.head,
    JSON.stringify({ position: headerRead.value?.position, known: headerRead.value?.positionKnown }))
  // Remembering it is what makes the follow-up reads cheap and consistent.
  const headerState = (await call(aiServer.base, '/chat-git/state', { sessionId: 'session-header-only' })).value
  check('the header-resolved workspace is remembered for the next read',
    samePath(headerState?.cwd, headerWorkspace), String(headerState?.cwd))
  // A cwd still never comes from the request: the same call naming a headerless
  // session is refused, which is what keeps the route off arbitrary directories.
  const noHeader = await call(aiServer.base, '/chat-git/repo', { sessionId: 'session-no-header' })
  check('a session with neither a record nor a header is still refused',
    noHeader.ok === false && noHeader.error.code === 'session-unknown', JSON.stringify(noHeader))

  console.log('\n== the workspace restore moves code and nothing else ==')
  writeFileSync(join(timelineWorkspace, 'second.js'), 'export const second = 2\n', 'utf8')
  await aiCtx.emit('agent/turn-stopping', stop('session-timeline', timelineWorkspace, 2))
  const twoCommits = (await call(aiServer.base, '/chat-git/repo', { sessionId: 'session-timeline' })).value
  check('the second turn produced a second commit', twoCommits?.commits?.length === 2,
    JSON.stringify(twoCommits?.commits?.length))
  const firstSha = twoCommits.commits[1].sha
  const checkpointsBefore = (await call(aiServer.base,
    '/chat-git/state', { sessionId: 'session-timeline' })).value.commits.length
  const restoredWorkspace = await call(aiServer.base,
    '/chat-git/restore', { sessionId: 'session-timeline', sha: firstSha })
  check('a workspace restore succeeds', restoredWorkspace.ok === true, JSON.stringify(restoredWorkspace))
  check('it prunes the path that checkpoint never contained',
    (restoredWorkspace.value?.removed ?? []).includes('second.js'),
    JSON.stringify(restoredWorkspace.value?.removed))
  check('the pruned file is gone from the worktree',
    git(timelineWorkspace, ['ls-files', 'second.js']).out === '',
    JSON.stringify(git(timelineWorkspace, ['ls-files', 'second.js']).out))
  check('HEAD is left where it was',
    git(timelineWorkspace, ['rev-list', '--count', 'HEAD']).out === '2',
    git(timelineWorkspace, ['rev-list', '--count', 'HEAD']).out)
  // The worktree now holds the first commit's content while HEAD still points at
  // the second, so nothing in git can answer "where am I" any more. The store is
  // the only record, and the pane's marker reads it back from here.
  const positioned = (await call(aiServer.base, '/chat-git/repo', { sessionId: 'session-timeline' })).value
  check('the restore is remembered as the worktree position',
    positioned?.position === firstSha, JSON.stringify(positioned?.position))
  check('and is now reported as a known position rather than as HEAD',
    positioned?.positionKnown === true, JSON.stringify(positioned?.positionKnown))
  check('the remembered position is not HEAD, which the restore left alone',
    positioned?.position !== positioned?.head,
    JSON.stringify({ position: positioned?.position, head: positioned?.head }))
  // The decoupling, asserted directly: `/chat-git/revert` drops the later
  // checkpoints, and this route deliberately must not, because the conversation
  // is not being rewound.
  const checkpointsAfter = (await call(aiServer.base,
    '/chat-git/state', { sessionId: 'session-timeline' })).value.commits.length
  check('restoring code leaves the conversation checkpoints intact',
    checkpointsAfter === checkpointsBefore, `${String(checkpointsBefore)} -> ${String(checkpointsAfter)}`)
  // Resolution happens before argv, so a revision that would read as a git
  // option can never become one.
  const revision = await call(aiServer.base,
    '/chat-git/restore', { sessionId: 'session-timeline', sha: 'HEAD~1' })
  check('a revision that is not an object name is refused',
    revision.ok === false && revision.error.code === 'unknown-commit', JSON.stringify(revision))
  const injected = await call(aiServer.base,
    '/chat-git/restore', { sessionId: 'session-timeline', sha: '--upload-pack=touch pwned' })
  check('a sha that looks like an option is refused',
    injected.ok === false && injected.error.code === 'unknown-commit', JSON.stringify(injected))
  const unknownCommit = await call(aiServer.base,
    '/chat-git/restore', { sessionId: 'session-timeline', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
  check('a commit that is not in this repository is refused',
    unknownCommit.ok === false && unknownCommit.error.code === 'unknown-commit', JSON.stringify(unknownCommit))
  const noRestoreSha = await call(aiServer.base, '/chat-git/restore', { sessionId: 'session-timeline' })
  check('a restore without a sha is refused',
    noRestoreSha.ok === false && noRestoreSha.error.code === 'unknown-commit', JSON.stringify(noRestoreSha))
  const noRestoreSession = await call(aiServer.base, '/chat-git/restore', { sha: firstSha })
  check('a restore without a session is refused',
    noRestoreSession.ok === false && noRestoreSession.error.code === 'bad-request',
    JSON.stringify(noRestoreSession))

  console.log('\n== an absent model layer never costs a checkpoint ==')
  // No `llm` and no model route: the whole AI path must be skipped, not fatal.
  const bare = createContext()
  apply(bare)
  const bareServer = await serve(bare)
  // A distinct path and distinct content: reusing a file an earlier turn already
  // committed would leave the tree clean and silently skip the checkpoint.
  writeFileSync(join(ai, 'eighth.js'), 'export const eighth = 8\n', 'utf8')
  await bare.emit('agent/inbox/claimed', claim('session-bare', ai, 1, '没有模型服务时仍然要提交'))
  await bare.emit('agent/turn-stopping', stop('session-bare', ai, 1))
  check('the checkpoint is written without any llm service',
    git(ai, ['log', '-1', '--format=%s']).out === 'Ai-coding：没有模型服务时仍然要提交',
    git(ai, ['log', '-1', '--format=%s']).out)
  bare.dispose()
  await new Promise((resolve) => bareServer.server.close(resolve))
  aiCtx.dispose()
  await new Promise((resolve) => aiServer.server.close(resolve))
} finally {
  if (server !== null) await new Promise((resolve) => server.close(resolve))
  ctx.dispose()
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
