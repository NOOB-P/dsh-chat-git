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
import { buildTimeline, textOfMessage } from './timeline.js'

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

/** How long one provider's model discovery may take before it is abandoned. */
const CATALOGUE_PROVIDER_TIMEOUT_MS = 4_000

/** Commits the workspace pane lists; a longer history is reachable through git itself. */
const REPO_LOG_LIMIT = 100

/** The picker catalogue is reused this long, since discovery can reach a provider. */
const CATALOGUE_TTL_MS = 60_000

/**
 * Resolve `promise`, or reject once `ms` elapses.
 *
 * `llm.listModels` takes no signal, so a deadline is the only way to bound it;
 * the abandoned call is left to settle on its own, which is harmless because its
 * result is reported as an empty model list either way.
 */
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('model discovery timed out')) }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

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
 * Read one session's full turn journal out of its own log.
 *
 * Reading the log rather than tracking events means the answer is complete even
 * for turns that happened before this plugin loaded — a session resumed after a
 * harness restart included — and needs no persisted state of its own.
 * @param sessionId - the conversation to read.
 * @returns the journal, or null when the session is not live or unreadable.
 */
function timelineOf(sessions, sessionId) {
  if (sessions === undefined || typeof sessions.get !== 'function') return null
  let session
  try {
    session = sessions.get(sessionId)
  } catch {
    return null
  }
  if (session === undefined || session === null) return null
  if (typeof session.snapshotEvents !== 'function') return null
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return null
  }
  if (!Array.isArray(events)) return null
  return buildTimeline(events)
}

/**
 * Read the session identity, workspace root, and frozen model route off an
 * agent, reading only the scalar leaves this plugin needs from the live object.
 * @param agent - the agent carried by the event payload.
 * @returns `{ id, cwd, route }`, or null when the agent exposes no usable identity.
 */
function sessionOf(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null) return null
  const id = header.id
  const cwd = header.cwd
  if (typeof id !== 'string' || id === '') return null
  if (typeof cwd !== 'string' || cwd === '') return null
  // The conversation's own route, when the agent exposes both halves. This is
  // what `current` means: the model the user is actually talking to.
  const options = agent.options
  const provider = options?.provider
  const model = options?.model
  const route = typeof provider === 'string' && provider !== ''
    && typeof model === 'string' && model !== ''
    ? { provider, model }
    : null
  return { id, cwd, route }
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

  /** Cached model catalogue for the settings picker, and when it was read. */
  let catalogue = null
  let catalogueAt = 0

  const log = (level, text) => {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](`chat-git: ${text}`)
  }

  /**
   * The route the conversation itself is using, from the default selection.
   *
   * The plugin never hard-depends on the model layer, so this is the fallback
   * when the agent does not expose its own frozen route.
   * @returns `{ provider, model }`, or null when no route is available.
   */
  function defaultRoute() {
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
   * Resolve the route a commit title should be asked of, honouring the saved
   * preference: `off` means no call, `custom` means the configured route, and
   * `current` means the conversation's own route (falling back to the default).
   * @param session - `{ id, cwd, route }`.
   * @returns `{ provider, model }`, or null when no call should be made.
   */
  function summaryRoute(session) {
    const summary = store.summary
    if (summary.mode === 'off') return null
    if (summary.mode === 'custom') {
      if (summary.provider === '' || summary.model === '') return null
      return { provider: summary.provider, model: summary.model }
    }
    return session.route ?? defaultRoute()
  }

  /**
   * Describe the model routes the deployment actually serves, for the settings
   * picker.
   *
   * Read from the live registry rather than a hard-coded list, so a route that
   * is not mounted can never be offered. Each provider is probed independently
   * under its own deadline, so one slow or failing provider degrades to its id
   * alone instead of holding up the whole answer.
   * @returns `{ providers, current }`, cached briefly.
   */
  async function describeModelCatalogue() {
    const now = Date.now()
    if (catalogue !== null && now - catalogueAt < CATALOGUE_TTL_MS) return catalogue

    const llm = ctx.get('llm')
    let providers = []
    if (llm !== undefined && typeof llm.listProviders === 'function') {
      let listed = []
      try {
        listed = llm.listProviders() ?? []
      } catch {
        listed = []
      }
      const probed = await Promise.all(listed.map(async (provider) => {
        const id = typeof provider?.id === 'string' ? provider.id : ''
        if (id === '') return null
        const entry = { id, name: typeof provider.name === 'string' ? provider.name : id, models: [] }
        if (typeof llm.listModels !== 'function') return entry
        try {
          const models = await withDeadline(llm.listModels(id), CATALOGUE_PROVIDER_TIMEOUT_MS)
          entry.models = (models ?? [])
            .filter((model) => typeof model?.id === 'string' && model.id !== '')
            .map((model) => ({ id: model.id, name: typeof model.name === 'string' ? model.name : model.id }))
        } catch {
          entry.models = []
        }
        return entry
      }))
      providers = probed.filter((entry) => entry !== null)
    }

    catalogue = { providers, current: defaultRoute() }
    catalogueAt = now
    return catalogue
  }

  /**
   * Ask the model for a one-line title for the turn that just finished.
   *
   * Deliberately total: every failure path — `off`, no `llm` service, no usable
   * route, an unreachable provider, the timeout, an unusable answer — returns an
   * empty string, and the caller keeps its deterministic description. A
   * checkpoint is never lost because a summary could not be written.
   * @param session - `{ id, cwd, route }`.
   * @param prompt - the prompt that drove this turn.
   * @param parentSignal - the checkpoint's cancellation.
   * @returns the title, or an empty string.
   */
  async function describeWithAi(session, prompt, parentSignal) {
    const selection = summaryRoute(session)
    if (selection === null) return ''
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return ''

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
   * Resolve the workspace root for one conversation.
   *
   * The store is the fast path, but it is **not** the only source, and treating
   * it as one was a real bug: a conversation that was already open when this
   * plugin loaded — or one restored from disk after a harness restart — has no
   * recorded `cwd` until one of its turns ends, so the workspace pane answered
   * "no workspace is recorded for this conversation" for a repository that was
   * sitting right there. The live session header is authoritative, so it is
   * consulted second and the answer is remembered for next time.
   *
   * `cwd` still never comes from the request: it is either what this plugin
   * recorded or what the harness itself put in the session header, so the
   * routes remain impossible to point at an arbitrary directory.
   * @param sessionId - the conversation to resolve.
   * @returns the workspace root, or an empty string when nothing knows it.
   */
  function cwdFor(sessionId) {
    if (sessionId === '') return ''
    const remembered = store.cwdOf(sessionId)
    if (remembered !== '') return remembered
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return ''
    let session
    try {
      session = sessions.get(sessionId)
    } catch {
      return ''
    }
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return ''
    store.rememberCwd(sessionId, cwd)
    return cwd
  }

  /**
   * Stage and commit the workspace for one finished turn.
   *
   * The **interval** throttles this git checkpoint only. The conversation itself
   * is recorded per turn by the harness's own session log, so a larger interval
   * never makes the conversation history sparser — it lets the worktree
   * accumulate changes and commits them together on the next eligible turn.
   * Nothing is lost in between: uncommitted work simply stays in the worktree,
   * where the workspace pane shows it as an uncommitted change.
   * @param session - `{ id, cwd }`.
   * @param turn - the turn number that just ended.
   */
  async function checkpoint(session, turn) {
    if (!store.enabled) return
    const interval = store.interval
    if (interval > 1 && turn % interval !== 0) {
      log('info', `turn ${String(turn)} left uncommitted: the interval is every ${String(interval)} turns`)
      return
    }
    const signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS)

    const repo = await ensureRepo(session)
    if (!repo.ok) return
    if (!(await git.isDirty(session.cwd, signal))) return

    await git.addAll(session.cwd, signal)

    const prompt = prompts.get(`${session.id}:${String(turn)}`) ?? ''
    // Staging first is what lets the title call see the files this turn touched,
    // which is what makes it a summary of the work rather than of the request.
    // `describeWithAi` owns the whole decision, including the `off` mode.
    const title = await describeWithAi(session, prompt, signal)
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
          const cwd = cwdFor(sessionId) || process.cwd()
          ok(res, await git.probe(cwd))
          return
        }

        case '/chat-git/state': {
          // An empty sessionId is the settings page's read: it has no session,
          // and only wants the preference, the git probe, and the state file.
          // A session read additionally carries that conversation's checkpoints.
          const cwd = sessionId === '' ? '' : cwdFor(sessionId)
          const probeCwd = cwd !== '' ? cwd : process.cwd()
          ok(res, {
            enabled: store.enabled,
            history: store.history,
            interval: store.interval,
            summary: store.summary,
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

        case '/chat-git/set-summary': {
          // Unlike enabling checkpointing this needs no capability probe: the
          // preference only chooses which route is asked, and `off` is a valid
          // choice even on a machine with no model at all.
          const applied = store.setSummary({
            ...(body.mode === undefined ? {} : { mode: body.mode }),
            ...(body.provider === undefined ? {} : { provider: body.provider }),
            ...(body.model === undefined ? {} : { model: body.model }),
          })
          if (!applied.ok) {
            fail(res, 'bad-preference', applied.error)
            return
          }
          ok(res, { summary: applied.summary })
          return
        }

        case '/chat-git/timeline': {
          // The panel's data: every turn of the conversation in order, each one
          // joined with the checkpoint it produced when it produced one.
          // `seq` is the turn's fork boundary, read from the session log.
          if (sessionId === '') {
            fail(res, 'bad-request', 'sessionId is required')
            return
          }
          const journal = timelineOf(ctx.get('sessions'), sessionId)
          if (journal === null) {
            fail(res, 'session-unavailable', 'that conversation is not loaded in this process')
            return
          }
          const commits = store.commitsOf(sessionId)
          ok(res, {
            cwd: cwdFor(sessionId),
            turns: journal.map((entry) => {
              const commit = commits.find((candidate) => candidate.turn === entry.turn)
              return {
                turn: entry.turn,
                at: entry.at,
                prompt: entry.prompt,
                seq: entry.seq,
                steps: entry.steps,
                endReason: entry.endReason,
                commit: commit === undefined
                  ? null
                  : { sha: commit.sha, short: commit.short, subject: commit.subject },
              }
            }),
          })
          return
        }

        case '/chat-git/repo': {
          // The workspace pane's own read: the repository exactly as git sees
          // it, with no reference to this conversation's checkpoints. It is a
          // separate route precisely so the two panes stay independent — the
          // conversation pane never needs a commit, and this one never needs a
          // turn. `cwd` is resolved from the store, never from the request, so
          // the route cannot be pointed at an arbitrary directory.
          if (sessionId === '') {
            fail(res, 'bad-request', 'sessionId is required')
            return
          }
          const cwd = cwdFor(sessionId)
          if (cwd === '') {
            fail(res, 'session-unknown', 'no workspace is recorded for this conversation')
            return
          }
          const probe = await git.probe(cwd)
          if (!probe.available) {
            // No git is a readable state, not an error: the pane says so and
            // offers nothing, and the conversation pane keeps working.
            ok(res, { cwd, root: '', git: probe, branch: '', head: null, dirty: false, commits: [] })
            return
          }
          const signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS)
          const root = (await git.toplevel(cwd)) ?? cwd
          ok(res, {
            cwd,
            root,
            git: probe,
            branch: await git.branch(root, signal),
            head: await git.head(root, signal),
            dirty: await git.isDirty(root, signal),
            commits: await git.log(root, REPO_LOG_LIMIT, signal),
          })
          return
        }

        case '/chat-git/restore': {
          // Git-only rollback for the workspace pane.
          //
          // It deliberately does NOT go through `/chat-git/revert`: that route
          // also truncates this conversation's checkpoint list, which is
          // exactly the coupling the two-pane split removes. Here nothing but
          // the working tree moves — no conversation is forked, no turn is
          // forgotten, and the checkpoint list the icon buttons resolve against
          // is left intact.
          if (sessionId === '') {
            fail(res, 'bad-request', 'sessionId is required')
            return
          }
          const cwd = cwdFor(sessionId)
          if (cwd === '') {
            fail(res, 'session-unknown', 'no workspace is recorded for this conversation')
            return
          }
          const signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS)
          const sha = await git.resolveCommit(cwd, typeof body.sha === 'string' ? body.sha : '', signal)
          if (sha === null) {
            // Resolution is what makes any commit in the repository restorable
            // while still refusing a revision that is not an object name: the
            // sha never reaches argv unchecked.
            fail(res, 'unknown-commit', 'that commit is not in this repository')
            return
          }
          const restored = await git.restoreFrom(cwd, sha, signal)
          if (!restored.ok) {
            fail(res, 'checkout-failed', restored.error || 'git checkout failed')
            return
          }
          log('info', `workspace restored to ${sha.slice(0, 7)} in ${cwd}; removed ${String(restored.removed.length)} path(s)`)
          ok(res, { restored: sha, removed: restored.removed })
          return
        }

        case '/chat-git/models': {
          ok(res, { ...(await describeModelCatalogue()), configured: store.summary })
          return
        }

        case '/chat-git/set-history': {
          // Presentation only: no probe, no capability check. Withdrawing the
          // tab cannot break checkpointing, so there is nothing to refuse.
          // The field is `history`, matching the switch's own name: reading
          // `enabled` here left the tab permanently off, because the client's
          // `{ history: true }` then coerced to false on every request.
          ok(res, { history: store.setHistory(body.history === true) })
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

        case '/chat-git/set-interval': {
          // How many turns may pass between git checkpoints. This cannot make
          // the conversation sparser — the harness records every turn in its own
          // session log regardless — it only lets the worktree accumulate
          // changes and commits them together on the next eligible turn, so
          // choosing 2 or 3 trades checkpoint granularity for fewer commits.
          const applied = store.setInterval(body.interval)
          if (!applied.ok) {
            fail(res, 'bad-preference', applied.error)
            return
          }
          ok(res, { interval: applied.interval })
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
          const cwd = cwdFor(sessionId)
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
