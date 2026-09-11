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

/** A minimal Cordis context: listener table, effect passthrough, route capture. */
function createContext() {
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

/** The store reads DSH_HOME at apply() time, so the real ~/.dsh is untouched. */
process.env.DSH_HOME = home

const SESSION = 'session-test-1'

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

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
  const noId = await call(base, '/chat-git/state', {})
  check('state without a sessionId is refused', noId.ok === false && noId.error.code === 'bad-request', JSON.stringify(noId))
  const missingSha = await call(base, '/chat-git/revert', { sessionId: SESSION })
  check('revert without a sha is refused', missingSha.ok === false && missingSha.error.code === 'bad-request', JSON.stringify(missingSha))

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
} finally {
  if (server !== null) await new Promise((resolve) => server.close(resolve))
  ctx.dispose()
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
