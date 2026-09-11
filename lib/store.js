/**
 * Durable state for dsh-chat-git: the on/off preference and the per-session
 * turn → commit mapping that the revert buttons resolve against.
 *
 * The mapping lives on disk rather than in memory so a harness restart (or a
 * profile reload) does not silently strip the revert affordance from
 * conversations whose commits still exist in the repository.
 *
 * Every filesystem touch degrades to an in-memory copy: a read-only or missing
 * DSH home must never take the host plugin down, it only costs persistence.
 * @module dsh-chat-git/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Newest commits kept per session; older checkpoints stop offering a revert target. */
export const MAX_COMMITS_PER_SESSION = 200

/** Sessions kept in the mapping file, oldest evicted first. */
export const MAX_SESSIONS = 100

/** The effective DSH home, matching the harness's own default. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** A fresh default state. Auto-checkpointing is opt-out, so the default is on. */
function emptyState() {
  return { version: 1, enabled: true, sessions: {} }
}

/**
 * Coerce whatever came off disk into the shape this plugin owns. A corrupt or
 * hand-edited file must degrade to defaults rather than throw on every event.
 * @param raw - parsed JSON, or undefined when the file is absent or unreadable.
 * @returns a usable state object.
 */
function normalize(raw) {
  const state = emptyState()
  if (typeof raw !== 'object' || raw === null) return state
  if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled
  const sessions = raw.sessions
  if (typeof sessions !== 'object' || sessions === null) return state
  for (const [sessionId, record] of Object.entries(sessions)) {
    if (typeof record !== 'object' || record === null) continue
    const commits = Array.isArray(record.commits)
      ? record.commits
        .filter((entry) => typeof entry === 'object' && entry !== null
          && typeof entry.sha === 'string' && entry.sha !== ''
          && typeof entry.turn === 'number')
        .map((entry) => ({
          sha: entry.sha,
          short: typeof entry.short === 'string' ? entry.short : entry.sha.slice(0, 7),
          subject: typeof entry.subject === 'string' ? entry.subject : '',
          turn: entry.turn,
          at: typeof entry.at === 'number' ? entry.at : 0,
        }))
        .slice(-MAX_COMMITS_PER_SESSION)
      : []
    state.sessions[sessionId] = {
      cwd: typeof record.cwd === 'string' ? record.cwd : '',
      commits,
    }
  }
  return state
}

/**
 * Open the state file and return the accessors the host plugin uses.
 * @param file - absolute path of the JSON state file.
 * @returns the store; `persisted` reports whether the last write reached disk.
 */
export function createStore(file = join(dshHome(), 'chat-git.json')) {
  let state = emptyState()
  let persisted = false

  try {
    state = normalize(JSON.parse(readFileSync(file, 'utf8')))
    persisted = true
  } catch {
    // Absent file (first run) or unreadable/corrupt content: defaults stand.
    persisted = false
  }

  /** Write the state atomically; a failure downgrades to memory-only. */
  function flush() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
      persisted = true
    } catch {
      persisted = false
    }
  }

  /** Evict the oldest sessions once the mapping outgrows its cap. */
  function prune() {
    const ids = Object.keys(state.sessions)
    if (ids.length <= MAX_SESSIONS) return
    const ordered = ids
      .map((id) => ({ id, at: Math.max(0, ...state.sessions[id].commits.map((entry) => entry.at)) }))
      .sort((a, b) => a.at - b.at)
    for (const entry of ordered.slice(0, ordered.length - MAX_SESSIONS)) delete state.sessions[entry.id]
  }

  /** Create the per-session record on first use. */
  function sessionOf(sessionId, cwd) {
    const existing = state.sessions[sessionId]
    if (existing !== undefined) {
      if (cwd !== undefined && cwd !== '') existing.cwd = cwd
      return existing
    }
    const created = { cwd: cwd ?? '', commits: [] }
    state.sessions[sessionId] = created
    return created
  }

  return {
    /** Where the state file lives (surfaced in the settings page). */
    file,
    /** Whether the most recent write reached disk. */
    get persisted() {
      return persisted
    },
    /** Whether automatic checkpointing is on. */
    get enabled() {
      return state.enabled
    },
    /** Flip the preference and persist it. */
    setEnabled(enabled) {
      state.enabled = enabled === true
      flush()
      return state.enabled
    },
    /** The recorded workspace root for one session, if any. */
    cwdOf(sessionId) {
      return state.sessions[sessionId]?.cwd ?? ''
    },
    /** Remember the workspace root for one session. */
    rememberCwd(sessionId, cwd) {
      if (sessionOf(sessionId, cwd).cwd !== cwd) flush()
    },
    /** The newest-first commit list recorded for one session. */
    commitsOf(sessionId) {
      const record = state.sessions[sessionId]
      if (record === undefined) return []
      return [...record.commits].reverse()
    },
    /**
     * Append one committed checkpoint. Re-committing the same turn replaces its
     * row so a turn that ends twice never renders two revert buttons.
     */
    recordCommit(sessionId, cwd, commit) {
      const record = sessionOf(sessionId, cwd)
      record.commits = record.commits.filter((entry) => entry.turn !== commit.turn)
      record.commits.push(commit)
      if (record.commits.length > MAX_COMMITS_PER_SESSION) {
        record.commits = record.commits.slice(-MAX_COMMITS_PER_SESSION)
      }
      prune()
      flush()
    },
    /** The checkpoint recorded for one turn, or null. */
    commitForTurn(sessionId, turn) {
      const record = state.sessions[sessionId]
      if (record === undefined) return null
      return record.commits.find((entry) => entry.turn === turn) ?? null
    },
    /**
     * Drop every checkpoint strictly after `turn`. Reverting a conversation
     * discards its later turns, so their git checkpoints must stop resolving.
     * @returns the number of discarded rows.
     */
    truncateAfter(sessionId, turn) {
      const record = state.sessions[sessionId]
      if (record === undefined) return 0
      const before = record.commits.length
      record.commits = record.commits.filter((entry) => entry.turn <= turn)
      const dropped = before - record.commits.length
      if (dropped > 0) flush()
      return dropped
    },
    /**
     * Copy one session's surviving checkpoints onto another. Reverting a
     * conversation forks it into a NEW session id, which would otherwise start
     * with no history and lose the ability to revert to earlier turns.
     * @returns the number of checkpoints carried over.
     */
    inherit(fromId, toId, turn) {
      const source = state.sessions[fromId]
      if (source === undefined) return 0
      const kept = source.commits.filter((entry) => entry.turn <= turn)
      state.sessions[toId] = { cwd: source.cwd, commits: kept }
      prune()
      flush()
      return kept.length
    },
  }
}
