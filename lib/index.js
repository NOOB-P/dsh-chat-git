/**
 * dsh-chat-git — host half.
 *
 * Turns every conversation into a git checkpoint chain:
 *
 * - as a conversation **starts**, the session workspace is checked for a
 *   repository and `git init` runs when there is none;
 * - the moment a **turn ends** the workspace is staged and committed as
 *   `Ai-coding：<short description of the work>`;
 * - `POST /chat-git/revert` restores the worktree to a recorded checkpoint
 *   (`git checkout <sha> -- .`), which the browser half pairs with a session
 *   fork so the conversation rolls back with the code.
 *
 * The browser half (exports `./client`) is served by client-modules from this
 * package's `dsh.client` declaration; it reaches this half only through the
 * `/chat-git` routes, keyed by session id — the client never supplies a path,
 * so the routes cannot be pointed at an arbitrary directory.
 *
 * This module deliberately imports nothing outside `node:` builtins and its own
 * siblings. A profile install symlinks the package, and Node resolves bare
 * specifiers from the real project path, where a dependency tree would not
 * exist; staying dependency-free keeps the plugin loadable that way.
 * @module dsh-chat-git
 */

import { createGit } from './git.js'
import { createStore } from './store.js'
import { buildSummaryInput, SUMMARIZE_TIMEOUT_MS, summarizeTurn } from './summarize.js'

/** Cordis plugin name; matches the `cordis.patch.yml` row id. */
export const name = 'chat-git'

/**
 * Hard dependencies. `subprocess` runs every git verb and `webServer` carries
 * the browser half's calls; without either, the plugin has no working surface.
 */
export const inject = ['subprocess', 'webServer']

/** Longest commit subject kept, matching common git subject conventions. */
const SUBJECT_MAX = 72

/** Every checkpoint subject carries this marker before its description. */
const SUBJECT_PREFIX = 'Ai-coding：'

/** Wall-clock ceiling for one event-driven checkpoint, so a wedged git never pins a turn. */
const CHECKPOINT_TIMEOUT_MS = 30_000

/** Request body cap for the /chat-git routes. */
const BODY_MAX_BYTES = 64 * 1024

/** Collapse whitespace and clip to a maximum length. */
function clipSubject(text, max = SUBJECT_MAX) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}\u2026`
}

/**
 * Build the commit subject for one turn: the fixed {@link SUBJECT_PREFIX}
 * marker followed by a short description of the work.
 *
 * The description is the model's one-line summary of the turn when the `llm`
 * service can be reached, and the prompt that drove the turn otherwise. With
 * neither — nor a recorded prompt, as in a session resumed after a restart — it
 * falls back to the turn number. The whole line, marker included, stays within
 * {@link SUBJECT_MAX}.
 * @param turn - the turn number that just ended.
 * @param description - the summary, or the recorded user prompt for that turn.
 * @returns the commit subject.
 */
function subjectFor(turn, description) {
  const room = Math.max(1, SUBJECT_MAX - SUBJECT_PREFIX.length)
  const text = clipSubject(description, room) || clipSubject(`第 ${String(turn)} 轮对话`, room)
  return `${SUBJECT_PREFIX}${text}`
}

/**
 * Extract the plain text of a user message across the content shapes the
 * harness uses. Only the scalar text is read; the live message object is never
 * copied, stringified, or retained.
 * @param message - the `agent/inbox/claimed` message.
 * @returns the concatenated text blocks, or an empty string.
 */
function textOfMessage(message) {
  if (typeof message !== 'object' || message === null) return ''
  const direct = message.text
  if (typeof direct === 'string') return direct
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}

/**
 * Read the session identity and workspace root off an agent, reading only the
 * two scalar leaves this plugin needs from the live session object.
 * @param agent - the agent carried by the event payload.
 * @returns `{ id, cwd }`, or null when the agent exposes no usable identity.
 */
function sessionOf(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null) return null
  const id = header.id
  const cwd = header.cwd
  if (typeof id !== 'string' || id === '') return null
  if (typeof cwd !== 'string' || cwd === '') return null
  return { id, cwd }
}

/** Whether the request originates from this machine. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write one JSON response with the plugin's result envelope. */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** `{ ok: true, value }`. */
function ok(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/** `{ ok: false, error }`; carried at HTTP 200 so the client reads one shape. */
function fail(res, code, message) {
  writeJson(res, 200, { ok: false, error: { code, message } })
}

/**
 * Read and parse a bounded JSON request body.
 * @returns the parsed object, or undefined for an absent, oversized, or invalid body.
 */
function readJson(req) {
  return new Promise((resolvePromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        resolvePromise(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolvePromise({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolvePromise(typeof parsed === 'object' && parsed !== null ? parsed : undefined)
      } catch {
        resolvePromise(undefined)
      }
    })
    req.on('error', () => resolvePromise(undefined))
  })
}

/**
 * Mount the session checkpoint hooks and the browser-facing routes.
 * @param ctx - context carrying `subprocess` and `webServer`.
 */
export function apply(ctx) {
  const store = createStore()
  const git = createGit(ctx.subprocess)

  /** Sessions whose conversation start already triggered the repository bootstrap. */
  const bootstrapped = new Set()

  /** The prompt text that drove each `sessionId:turn`, the commit subject source. */
  const prompts = new Map()

  /** In-flight bootstrap promises, so a re-entrant claim never double-inits. */
  const bootstrapping = new Map()

  const log = (level, text) => {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](`chat-git: ${text}`)
  }

  /**
   * Resolve the provider/model route used for plugin-initiated calls.
   *
   * The plugin never hard-depends on the model layer, and the default selection
   * is the one route it can name without reading a session's frozen header.
   * @returns `{ provider, model }`, or null when no route is available.
   */
  function modelRoute() {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined || typeof service.currentSelection !== 'function') return null
    let selection
    try {
      selection = service.currentSelection()
    } catch {
      return null
    }
    const provider = selection?.provider
    const model = selection?.model
    if (typeof provider !== 'string' || provider === '') return null
    if (typeof model !== 'string' || model === '') return null
    return { provider, model }
  }

  /**
   * Ask the model for a one-line title for the turn that just finished.
   *
   * Deliberately total: every failure path — no `llm` service, no model route,
   * an unreachable provider, the timeout, an unusable answer — returns an empty
   * string, and the caller keeps its deterministic description. A checkpoint is
   * never lost because a summary could not be written.
   * @param session - `{ id, cwd }`.
   * @param prompt - the prompt that drove this turn.
   * @param parentSignal - the checkpoint's cancellation.
   * @returns the title, or an empty string.
   */
  async function describeWithAi(session, prompt, parentSignal) {
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return ''
    const selection = modelRoute()
    if (selection === null) return ''

    let files = ''
    try {
      files = await git.stagedSummary(session.cwd, parentSignal)
    } catch {
      files = ''
    }

    try {
      const result = await summarizeTurn(
        llm,
        selection,
        buildSummaryInput(prompt, files),
        AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS),
      )
      if (result.ok) return result.title
      log('warn', `commit title summarized from the prompt instead: ${result.error}`)
    } catch (error) {
      log('warn', `commit title summarization threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    return ''
  }

  /**
   * Ensure the session workspace is a repository. Serialized per session so the
   * first-prompt hook and a racing turn-end hook cannot both run `git init`.
   * @param session - `{ id, cwd }`.
   * @returns `{ ok, created, error }`.
   */
  function ensureRepo(session) {
    const running = bootstrapping.get(session.id)
    if (running !== undefined) return running
    const pending = (async () => {
      const signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS)
      const result = await git.ensureRepo(session.cwd, signal)
      if (result.ok) {
        store.rememberCwd(session.id, session.cwd)
        if (result.created) log('info', `initialized repository at ${session.cwd}`)
      } else {
        log('warn', `git init failed in ${session.cwd}: ${result.error}`)
      }
      return result
    })().finally(() => {
      bootstrapping.delete(session.id)
    })
    bootstrapping.set(session.id, pending)
    return pending
  }

  /**
   * Stage and commit the workspace for one finished turn.
   * @param session - `{ id, cwd }`.
   * @param turn - the turn number that just ended.
   */
  async function checkpoint(session, turn) {
    if (!store.enabled) return
    const signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS)

    const repo = await ensureRepo(session)
    if (!repo.ok) return
    if (!(await git.isDirty(session.cwd, signal))) return

    await git.addAll(session.cwd, signal)

    const prompt = prompts.get(`${session.id}:${String(turn)}`) ?? ''
    // Staging first is what lets the title call see the files this turn touched,
    // which is what makes it a summary of the work rather than of the request.
    const title = store.summarize ? await describeWithAi(session, prompt, signal) : ''
    const subject = subjectFor(turn, title !== '' ? title : prompt)
    if (title !== '') log('info', `turn ${String(turn)} titled: ${title}`)

    const committed = await git.commit(session.cwd, subject, signal)
    if (!committed.ok) {
      log('warn', `git commit failed for turn ${String(turn)}: ${committed.stderr.trim()}`)
      return
    }

    const sha = await git.head(session.cwd, signal)
    if (sha === null) return
    store.recordCommit(session.id, session.cwd, {
      sha,
      short: sha.slice(0, 7),
      subject,
      turn,
      at: Date.now(),
    })
    log('info', `committed turn ${String(turn)} as ${sha.slice(0, 7)}`)
  }

  // A conversation begins: check the workspace for a repository and create one
  // when there is none. The event is fire-and-forget, so the bootstrap is
  // kicked off and never awaited here; the turn-end checkpoint awaits the same
  // serialized promise, which is what keeps the ordering safe.
  ctx.on('agent/session-start', (payload) => {
    const session = sessionOf(payload?.agent)
    if (session === null) return
    if (!store.enabled) return
    if (bootstrapped.has(session.id)) return
    bootstrapped.add(session.id)
    void ensureRepo(session).catch(() => {})
  })

  // The prompt that drove each turn is the source of that turn's commit
  // subject, so it is recorded while the message is still in hand. Nothing is
  // bootstrapped here: the repository is settled at conversation start.
  ctx.on('agent/inbox/claimed', (payload) => {
    const session = sessionOf(payload?.agent)
    if (session === null) return
    const turn = payload?.turn
    if (typeof turn !== 'number') return
    prompts.set(`${session.id}:${String(turn)}`, textOfMessage(payload.message))
  })

  // The turn is about to close: the agent owes no response, so the workspace
  // state is final. This listener is awaited by the loop, which guarantees the
  // commit exists before the conversation renders the turn's revert button.
  ctx.on('agent/turn-stopping', async (payload) => {
    const session = sessionOf(payload?.agent)
    if (session === null) return
    const turn = payload?.turn
    try {
      await checkpoint(session, typeof turn === 'number' ? turn : 0)
    } catch (error) {
      log('warn', `checkpoint threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // A session leaving the registry must not leak its prompt cache.
  ctx.on('agent/disposed', (payload) => {
    const session = sessionOf(payload?.agent)
    if (session === null) return
    bootstrapped.delete(session.id)
    for (const key of prompts.keys()) {
      if (key.startsWith(`${session.id}:`)) prompts.delete(key)
    }
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/chat-git',
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      const route = new URL(req.url ?? '/', 'http://x').pathname
      const body = await readJson(req)
      if (body === undefined) {
        fail(res, 'bad-request', 'request body is not a JSON object')
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''

      switch (route) {
        case '/chat-git/detect': {
          const cwd = store.cwdOf(sessionId) || process.cwd()
          ok(res, await git.probe(cwd))
          return
        }

        case '/chat-git/state': {
          // An empty sessionId is the settings page's read: it has no session,
          // and only wants the preference, the git probe, and the state file.
          // A session read additionally carries that conversation's checkpoints.
          const cwd = sessionId === '' ? '' : store.cwdOf(sessionId)
          const probeCwd = cwd !== '' ? cwd : process.cwd()
          ok(res, {
            enabled: store.enabled,
            summarize: store.summarize,
            committed: store.persisted,
            stateFile: store.file,
            cwd,
            git: await git.probe(probeCwd),
            commits: sessionId === ''
              ? []
              : store.commitsOf(sessionId).map((entry) => ({
                sha: entry.sha,
                short: entry.short,
                subject: entry.subject,
                turn: entry.turn,
                at: entry.at,
              })),
          })
          return
        }

        case '/chat-git/set-summarize': {
          // Unlike enabling checkpointing, this needs no capability probe: the
          // switch only chooses whether a title is asked for, and an unreachable
          // model already degrades to the prompt.
          ok(res, { summarize: store.setSummarize(body.summarize === true) })
          return
        }

        case '/chat-git/set-enabled': {
          const wanted = body.enabled === true
          if (wanted) {
            // Enabling without a working git is refused rather than accepted
            // and silently inert: the switch must not claim a capability the
            // machine cannot deliver.
            const probe = await git.probe(process.cwd())
            if (!probe.available) {
              fail(res, 'git-missing', probe.error || 'git is not available on PATH')
              return
            }
          }
          ok(res, { enabled: store.setEnabled(wanted) })
          return
        }

        case '/chat-git/revert': {
          if (sessionId === '') {
            fail(res, 'bad-request', 'sessionId is required')
            return
          }
          const sha = typeof body.sha === 'string' ? body.sha : ''
          if (sha === '') {
            fail(res, 'bad-request', 'sha is required')
            return
          }
          const cwd = store.cwdOf(sessionId)
          if (cwd === '') {
            fail(res, 'session-unknown', 'no workspace is recorded for this conversation')
            return
          }
          const known = store.commitsOf(sessionId).some((entry) => entry.sha === sha)
          if (!known) {
            fail(res, 'unknown-checkpoint', 'that checkpoint does not belong to this conversation')
            return
          }
          const signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS)
          const restored = await git.restoreFrom(cwd, sha, signal)
          if (!restored.ok) {
            fail(res, 'checkout-failed', restored.error || 'git checkout failed')
            return
          }
          const turn = store.commitsOf(sessionId).find((entry) => entry.sha === sha)?.turn ?? -1
          const dropped = store.truncateAfter(sessionId, turn)
          log('info', `restored ${sha.slice(0, 7)} in ${cwd}; dropped ${String(dropped)} later checkpoint(s)`)
          ok(res, { restored: sha, turn, dropped, removed: restored.removed })
          return
        }

        case '/chat-git/inherit': {
          // A revert forks the conversation into a new session id; this hands
          // the fork the checkpoints that survived the rollback.
          const from = typeof body.from === 'string' ? body.from : ''
          const to = typeof body.to === 'string' ? body.to : ''
          if (from === '' || to === '') {
            fail(res, 'bad-request', 'from and to are required')
            return
          }
          const turn = typeof body.turn === 'number' ? body.turn : -1
          ok(res, { inherited: store.inherit(from, to, turn) })
          return
        }

        default:
          writeJson(res, 404, { error: 'not found' })
      }
    },
  }), 'chat-git: /chat-git routes')
}
