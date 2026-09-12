/**
 * argv-based git plumbing for dsh-chat-git.
 *
 * Every verb runs through the harness `subprocess` service with an **argv
 * array**, never a shell string: no quoting rules to get wrong, no injection
 * surface in commit messages or paths, and the same managed-child lifetime,
 * output cap, and abort semantics a tool call receives.
 *
 * Nothing here imports a package outside `node:` builtins, so the plugin
 * loads correctly from a symlinked profile install where bare-specifier
 * resolution would otherwise walk up from the real project path.
 * @module dsh-chat-git/git
 */

import { resolve, sep } from 'node:path'

/** Collected-output cap for one git invocation (1 MiB, matching the sibling git plugins). */
const OUTPUT_CAP_BYTES = 1 << 20

/** Grace period between the kill request and the abandoned child. */
const GRACE_MS = 10_000

/** Commit identity used only when the repository has no user.email configured. */
const FALLBACK_IDENTITY = ['-c', 'user.name=DSH Chat Git', '-c', 'user.email=chat-git@localhost']

/** Field separator for the machine-readable log format (never appears in a subject line). */
const UNIT = '\u001f'

/** Human-readable message for an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Canonicalize a path for comparison: forward slashes, no trailing separator,
 * and lower-cased on Windows (where the filesystem is case-insensitive but
 * git may echo a differently-cased drive or directory).
 * @param value - path text from git or from a session header.
 * @returns the comparison key.
 */
export function pathKey(value) {
  const normalized = resolve(String(value)).split(sep).join('/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Build the git surface over the subprocess seam.
 * @param subprocess - the harness subprocess service (`ctx.subprocess`).
 * @param options - behaviour knobs.
 * @param options.errorTag - log tag used when a spawn degrades.
 * @returns the git verbs; every verb resolves a result and never rejects.
 */
export function createGit(subprocess, options = {}) {
  /**
   * Run one git invocation. Spawn failures and mid-flight failures degrade to
   * an `exitCode: 127` result so a missing binary or an unusable workdir reads
   * as an ordinary failed command instead of rejecting into the agent loop.
   * @param argv - git arguments, without the leading `git`.
   * @param cwd - working directory (the session workspace root).
   * @param signal - caller cancellation.
   * @returns the outcome.
   */
  async function run(argv, cwd, signal) {
    let handle
    try {
      handle = subprocess.spawn({
        argv: ['git', ...argv],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_CAP_BYTES },
          stderr: { maxBytes: OUTPUT_CAP_BYTES },
        },
        graceMs: GRACE_MS,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      return { ok: false, exitCode: 127, stdout: '', stderr: `git: spawn failed: ${messageOf(error)}`, failedToStart: true }
    }
    try {
      const outcome = await handle.done
      const stdout = handle.collected?.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
      return { ok: outcome.exitCode === 0, exitCode: outcome.exitCode, stdout, stderr, failedToStart: false }
    } catch (error) {
      return { ok: false, exitCode: 127, stdout: '', stderr: `git: run failed: ${messageOf(error)}`, failedToStart: true }
    }
  }

  return {
    run,

    /**
     * `git --version`, the capability probe behind the settings detect button.
     * @param cwd - any usable directory.
     * @param signal - caller cancellation.
     * @returns `{ available, version }`; `version` is the raw first stdout line.
     */
    async probe(cwd, signal) {
      const result = await run(['--version'], cwd, signal)
      const version = result.stdout.trim().split('\n')[0] ?? ''
      return {
        available: result.ok && version.startsWith('git version'),
        version,
        error: result.ok ? '' : (result.stderr.trim() || `git exited with ${String(result.exitCode)}`),
      }
    },

    /**
     * Resolve the repository root that currently governs `cwd`.
     * @param cwd - the session workspace root.
     * @param signal - caller cancellation.
     * @returns the canonical root, or null when `cwd` is not inside any repository.
     */
    async toplevel(cwd, signal) {
      const result = await run(['rev-parse', '--show-toplevel'], cwd, signal)
      if (!result.ok) return null
      const root = result.stdout.trim()
      return root === '' ? null : root
    },

    /**
     * Ensure the session workspace root is its own repository.
     *
     * A repository whose root already **is** `cwd` is adopted as-is, so the
     * plugin never re-initializes a project the user already version-controls.
     * A `cwd` merely *inside* a parent repository gets its own nested `git init`
     * instead of borrowing the ancestor: committing into a repository the user
     * did not open this conversation against would stage unrelated work.
     * @param cwd - the session workspace root.
     * @param signal - caller cancellation.
     * @returns `{ ok, created, root, adopter }` where `adopter` names the pre-existing root.
     */
    async ensureRepo(cwd, signal) {
      const existing = await this.toplevel(cwd, signal)
      if (existing !== null && pathKey(existing) === pathKey(cwd)) {
        return { ok: true, created: false, root: cwd, adopter: existing, error: '' }
      }
      const init = await run(['init'], cwd, signal)
      if (!init.ok) {
        return { ok: false, created: false, root: null, adopter: existing, error: init.stderr.trim() || `git init exited with ${String(init.exitCode)}` }
      }
      return { ok: true, created: true, root: cwd, adopter: null, error: '' }
    },

    /**
     * Whether the index or worktree differs from HEAD.
     * @param cwd - repository root.
     * @param signal - caller cancellation.
     * @returns true when there is something to commit.
     */
    async isDirty(cwd, signal) {
      const result = await run(['status', '--porcelain'], cwd, signal)
      return result.ok && result.stdout.trim() !== ''
    },

    /**
     * Stage every change at and below the repository root.
     *
     * The explicit `-- .` pathspec is what scopes the add to the session
     * workspace: since Git 2.0 a bare `git add -A` stages the **entire working
     * tree** of the governing repository regardless of the working directory,
     * which would sweep in unrelated work if the workspace ever sat inside a
     * larger repository. With the workspace as its own repository root the two
     * forms are identical.
     */
    addAll(cwd, signal) {
      return run(['add', '-A', '--', '.'], cwd, signal)
    },

    /**
     * A compact digest of what is currently staged, for the title call.
     *
     * File names carry most of the signal, so they lead and are capped; the
     * one-line stat adds the magnitude. The result is plain text for the model,
     * never a live object, and an empty string when nothing can be read.
     * @param cwd - repository root.
     * @param signal - caller cancellation.
     * @param limit - most file entries kept before the counted remainder.
     * @returns the digest, newline-separated.
     */
    async stagedSummary(cwd, signal, limit = 15) {
      const names = await run(['diff', '--cached', '--name-status'], cwd, signal)
      if (!names.ok) return ''
      const rows = names.stdout.split('\n').map((row) => row.trim()).filter((row) => row !== '')
      const head = rows.slice(0, limit)
      const parts = [...head]
      if (rows.length > head.length) parts.push(`... and ${String(rows.length - head.length)} more`)
      const stat = await run(['diff', '--cached', '--shortstat'], cwd, signal)
      const magnitude = stat.ok ? stat.stdout.trim() : ''
      if (magnitude !== '') parts.push(magnitude)
      return parts.join('\n')
    },

    /**
     * Whether the repository carries a usable commit identity. A machine that
     * never ran `git config user.email` would otherwise fail every commit.
     */
    async hasIdentity(cwd, signal) {
      const result = await run(['config', 'user.email'], cwd, signal)
      return result.ok && result.stdout.trim() !== ''
    },

    /**
     * Commit the staged tree, supplying a fallback identity only when the
     * repository has none configured.
     * @param cwd - repository root.
     * @param subject - the commit subject line.
     * @param signal - caller cancellation.
     */
    async commit(cwd, subject, signal) {
      const identity = (await this.hasIdentity(cwd, signal)) ? [] : FALLBACK_IDENTITY
      return run([...identity, 'commit', '-m', subject], cwd, signal)
    },

    /**
     * The current HEAD object name.
     * @returns the full 40-character sha, or null when HEAD is unborn.
     */
    async head(cwd, signal) {
      const result = await run(['rev-parse', 'HEAD'], cwd, signal)
      const sha = result.stdout.trim()
      return result.ok && sha !== '' ? sha : null
    },

    /**
     * The branch HEAD is on, for the workspace pane's status line.
     * @param cwd - repository root.
     * @param signal - caller cancellation.
     * @returns the branch name, or an empty string on a detached HEAD or a failure.
     */
    async branch(cwd, signal) {
      const result = await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, signal)
      if (!result.ok) return ''
      const name = result.stdout.trim()
      return name === 'HEAD' ? '' : name
    },

    /**
     * Resolve a caller-supplied revision to the full commit id it names.
     *
     * The value is checked against the hex object-name shape **before** it
     * reaches argv, so a string that would read as a git option never becomes
     * one; `^{commit}` then pins the answer to a commit rather than letting a
     * tag or a tree through. This is what lets the workspace pane restore any
     * commit in the repository instead of only the ones this plugin recorded.
     * @param cwd - repository root.
     * @param revision - a short or full commit id from the browser half.
     * @param signal - caller cancellation.
     * @returns the full 40-character sha, or null when nothing resolves.
     */
    async resolveCommit(cwd, revision, signal) {
      if (typeof revision !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(revision)) return null
      const result = await run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], cwd, signal)
      const sha = result.stdout.trim()
      return result.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : null
    },

    /**
     * Read the most recent commits, newest first, in the shape `git log` shows
     * them: the id, the subject, the author, and the date.
     *
     * The author is carried because the workspace pane lists the repository's
     * real history rather than only this plugin's checkpoints, so a commit
     * written by the user (or by another tool) must be attributable too.
     * @param cwd - repository root.
     * @param limit - maximum rows.
     * @param signal - caller cancellation.
     * @returns `{ sha, short, subject, date, author }` rows; empty on any failure.
     */
    async log(cwd, limit, signal) {
      const format = ['%H', '%h', '%s', '%cI', '%an'].join(UNIT)
      const result = await run(['log', `-n${String(limit)}`, `--format=${format}`], cwd, signal)
      if (!result.ok) return []
      return result.stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [sha = '', short = '', subject = '', date = '', author = ''] = line.split(UNIT)
          return { sha, short, subject, date, author }
        })
    },

    /**
     * List the paths that entered the tree between `sha` and HEAD.
     *
     * `git checkout <sha> -- .` restores the *content* of every path it finds
     * in `sha`, but it never deletes a path that `sha` did not contain: files
     * created by later turns would survive a rollback and leave the workspace
     * visibly half-reverted. These are exactly the paths that must go.
     * @param cwd - repository root.
     * @param sha - the checkpoint being restored.
     * @param signal - caller cancellation.
     * @returns `{ ok, paths }`; NUL-delimited so a path may contain any character.
     */
    async addedSince(cwd, sha, signal) {
      const result = await run(['diff', '--name-only', '-z', '--diff-filter=A', sha, 'HEAD'], cwd, signal)
      if (!result.ok) return { ok: false, paths: [], error: result.stderr.trim() || `git diff exited with ${String(result.exitCode)}` }
      return { ok: true, paths: result.stdout.split('\u0000').filter((path) => path !== ''), error: '' }
    },

    /**
     * Remove paths from the index and the worktree.
     *
     * Only ever called on paths that exist in HEAD, so every removal stays
     * recoverable from the commit history.
     * @param cwd - repository root.
     * @param paths - repository-relative paths.
     * @param signal - caller cancellation.
     * @returns `{ ok, removed, error }`; `removed` lists what actually went.
     */
    async removePaths(cwd, paths, signal) {
      const removed = []
      // Chunked so a large turn cannot overflow the argv limit.
      for (let index = 0; index < paths.length; index += 64) {
        const chunk = paths.slice(index, index + 64)
        const result = await run(['rm', '-f', '-r', '--quiet', '--ignore-unmatch', '--', ...chunk], cwd, signal)
        if (!result.ok) {
          return { ok: false, removed, error: result.stderr.trim() || `git rm exited with ${String(result.exitCode)}` }
        }
        removed.push(...chunk)
      }
      return { ok: true, removed, error: '' }
    },

    /**
     * Roll the working tree back to a checkpoint (`git checkout <sha> -- .`),
     * then drop the paths that checkpoint never contained.
     *
     * HEAD is deliberately left where it is: the later commits stay in the
     * history, which keeps the turn → checkpoint mapping readable and makes
     * every pruned path recoverable. The restored tree therefore shows up as a
     * pending change against HEAD rather than as destroyed history.
     * @param cwd - repository root.
     * @param sha - the commit to restore from.
     * @param signal - caller cancellation.
     * @returns `{ ok, removed, error }`.
     */
    async restoreFrom(cwd, sha, signal) {
      const restored = await run(['checkout', sha, '--', '.'], cwd, signal)
      if (!restored.ok) {
        return { ok: false, removed: [], error: restored.stderr.trim() || `git checkout exited with ${String(restored.exitCode)}` }
      }
      const listed = await this.addedSince(cwd, sha, signal)
      if (!listed.ok) return { ok: true, removed: [], error: listed.error }
      if (listed.paths.length === 0) return { ok: true, removed: [], error: '' }
      const pruned = await this.removePaths(cwd, listed.paths, signal)
      return { ok: true, removed: pruned.removed, error: pruned.error }
    },
  }
}

export { UNIT as GIT_LOG_UNIT }
