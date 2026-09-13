/**
 * dsh-chat-git — browser half.
 *
 * Three seats, all fed by this package's host `/chat-git` routes:
 *
 * 1. `conversation.chat.assistant-actions` — the per-turn **回退** button. The
 *    shell renders this list as the `extraActions` slot of the turn's
 *    `MessageIconActions`, i.e. immediately after the copy button, so the
 *    control lands literally beside the icons it belongs with. The seat is a
 *    plain additive list: it competes with no other plugin for a cell, which is
 *    what removed the earlier need to outrank a sibling `turnTail` entry.
 * 2. `conversation.view` — the **历史** tab beside 对话 and 轨迹: every turn in
 *    order, each card offering 从这里 fork / 回退到这里 / 编辑并发送. Registered
 *    only while the preference says so, because a tab strip is projected from
 *    the slot itself and a component cannot withdraw its own tab.
 * 3. `settings.section` — the settings page: the checkpoint switch, the History
 *    tab switch, the summary-model tri-state, the `git --version` detection
 *    button, and the download jump to the official page.
 * 4. `conversation.input.dock` — a **headless** entry that carries out a
 *    request 编辑并发送 parked for a conversation whose composer was not on
 *    screen yet. It renders nothing; it exists so the draft is written by the
 *    composer's own session-scoped machinery rather than by reaching into
 *    another plugin's internals.
 *
 * Served by client-modules at `/plugins/dsh-chat-git/client.js`; this file is
 * authored directly in the `window.__ModuleLoader__` wrapper format the loader
 * expects, so the package needs no build step. `React.createElement` is used
 * throughout because nothing transpiles JSX here.
 * @module dsh-chat-git/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-chat-git',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // The shell's own primitives, used only to borrow the Tooltip that the
    // neighbouring icon buttons wear. A missing module or export must not take
    // this bundle down, so it degrades to a native `title` instead.
    let Tooltip = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives !== null && typeof primitives.Tooltip === 'function') Tooltip = primitives.Tooltip
    } catch {
      Tooltip = null
    }

    // ---------------------------------------------------------------------
    // Host transport
    // ---------------------------------------------------------------------

    /** Transport-level failure, shaped like the host's own error envelope. */
    const TRANSPORT = { code: 'transport', message: 'chat-git 路由不可用' }

    /**
     * POST one JSON payload to this package's host routes and unwrap the
     * `{ ok, value }` / `{ ok, error }` envelope. Never throws: an unreachable
     * route reads as an ordinary error result so the UI degrades to a message.
     */
    async function post(route, payload) {
      let response
      try {
        response = await fetch(route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch {
        return { ok: false, error: TRANSPORT }
      }
      try {
        const envelope = await response.json()
        if (envelope === null || typeof envelope !== 'object') return { ok: false, error: TRANSPORT }
        if (envelope.ok === true) return { ok: true, value: envelope.value }
        return { ok: false, error: errorOf(envelope.error) }
      } catch {
        return { ok: false, error: TRANSPORT }
      }
    }

    /**
     * Normalize whatever the host put in `error` into `{ code, message }`.
     *
     * The plugin's own envelopes carry an object, but the web server's own 404
     * answers `{ error: 'not found' }` with a bare string — and a route that is
     * not mounted is exactly what a host process running an older build looks
     * like. Reading `.message` off that string yielded `undefined`, so the pane
     * fell back to a generic "读取仓库失败" and hid the one fact that mattered:
     * the route itself was missing, not the repository.
     */
    function errorOf(error) {
      if (typeof error === 'string' && error !== '') return { code: 'host', message: error }
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error
      return TRANSPORT
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    /** Stylesheet id, so a second install (or a reload) never doubles it up. */
    const STYLE_ID = 'dsh-chat-git-style'

    /**
     * The plugin's own stylesheet. Only this plugin's namespaced classes are
     * styled — no product selector is touched — and every colour comes from the
     * shell's own alias tokens so the control follows whichever theme is live.
     *
     * Three rules matter for readability, because the same token means
     * different things in the two themes:
     *
     * - Text sitting on an accent fill uses `label-primary-foreground` (white
     *   on light's near-black brand, near-black on dark's near-white brand),
     *   never a literal `#fff`. `brand-primary` is `#0f1115` in light and
     *   `#f9fafb` in dark, so a hard-coded white foreground is white-on-white
     *   in dark mode — the exact failure this stylesheet avoids.
     * - Hover/selected washes use `interactive-bg-hover` (a 6-8% tint that
     *   reads on both a white and a near-black base) instead of `bg-layer-2`,
     *   which is opaque white in light mode and would erase the highlight.
     * - Raised surfaces use `bg-module-platform` (light grey on white, raised
     *   grey on dark) instead of `bg-layer-1`, which is white-on-white in light
     *   mode and leaves cards invisible.
     */
    const CSS = [
      '.dsh-chat-git-icon{display:inline-flex;align-items:center;justify-content:center;',
      'width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;',
      'transition:color .12s ease,background .12s ease}',
      '.dsh-chat-git-icon:hover{color:var(--dsw-alias-label-primary,#0f1115);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dsh-chat-git-icon:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0f1115);outline-offset:1px}',
      '.dsh-chat-git-icon[data-armed="true"]{color:var(--dsw-alias-state-error-primary,#d92c2c)}',
      '.dsh-chat-git-icon[data-active="true"]{color:var(--dsw-alias-brand-primary,#0f1115);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dsh-chat-git-icon[disabled]{opacity:.5;cursor:progress}',
      '.dsh-chat-git-note{font-size:11px;line-height:18px;margin-left:4px;',
      'color:var(--dsw-alias-state-error-primary,#d92c2c)}',
      // The conversation cards and the workspace commit rows are the same
      // surface in two columns, so they share one rule rather than drifting
      // apart in padding and fill.
      '.dsh-chat-git-card,.dsh-chat-git-commit{box-sizing:border-box;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));',
      'border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:7px;',
      'background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06))}',
      // The cards, the commit rows and the confirm dialog share one button
      // treatment, so a bare `<button>` never falls back to the browser's own
      // light-on-dark default in the middle of a themed panel.
      '.dsh-chat-git-card button,.dsh-chat-git-commit button,.dsh-chat-git-dialog button',
      '{padding:4px 10px;font:inherit;font-size:12px;',
      'border-radius:999px;cursor:pointer;background:transparent;',
      'color:var(--dsw-alias-label-primary,#0f1115);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45))}',
      '.dsh-chat-git-card button:hover:not([disabled]),',
      '.dsh-chat-git-commit button:hover:not([disabled]),',
      '.dsh-chat-git-dialog button:hover:not([disabled])',
      '{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dsh-chat-git-card button[disabled],.dsh-chat-git-commit button[disabled],',
      '.dsh-chat-git-dialog button[disabled]{opacity:.45;cursor:not-allowed}',
      // Arming a restore is a warning state, not a second primary action: the
      // row marks itself so the second click is visibly the confirming one.
      '.dsh-chat-git-commit button[data-armed="true"]',
      '{color:var(--dsw-alias-state-error-primary,#d92c2c);',
      'border-color:var(--dsw-alias-state-error-primary,#d92c2c)}',
      // A pane's own controls (the repository retry) sit outside any card, so
      // they need the same button treatment instead of the browser default.
      '.dsh-chat-git-pane button{padding:4px 10px;font:inherit;font-size:12px;border-radius:999px;',
      'cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45))}',
      '.dsh-chat-git-pane button:hover:not([disabled])',
      '{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dsh-chat-git-pane button[disabled]{opacity:.45;cursor:not-allowed}',
      // A commit row reads like one line of `git log --graph`: a graph gutter on
      // the left, then the id, the subject and the author. The gutter is drawn
      // with CSS only — a vertical rule plus a dot — because the pane lists a
      // linear history, and a real lane layout would imply branch structure the
      // data does not carry.
      '.dsh-chat-git-commit{flex-direction:row;align-items:stretch;gap:9px}',
      '.dsh-chat-git-commit-body{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0}',
      '.dsh-chat-git-graph{flex:0 0 auto;width:9px;position:relative;border-radius:6px;',
      'background:linear-gradient(var(--dsw-alias-border-l2,rgba(127,127,127,.5)),',
      'var(--dsw-alias-border-l2,rgba(127,127,127,.2))) no-repeat center/2px 100%}',
      '.dsh-chat-git-graph::before{content:"";position:absolute;left:50%;top:13px;width:7px;height:7px;',
      'margin-left:-3.5px;border-radius:50%;background:var(--dsw-alias-brand-primary,#0f1115)}',
      '.dsh-chat-git-commit-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px;',
      'font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
      // Settings controls carry their colours inline, so the hover wash has to
      // outrank an inline `background:transparent`; the primary variant is
      // declared last so it keeps its fill while hovered.
      '.dsh-chat-git-btn:hover:not([disabled]),.dsh-chat-git-choice:hover:not([disabled])',
      '{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))!important;',
      'border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.5))!important}',
      // The commit the worktree is standing on is tagged rather than merely
      // listed first: after a restore HEAD is no longer the answer to
      // "where am I", and the pane must say which commit's content is in place.
      // The conversation's newest turn wears the same tag for the same reason:
      // once the list is long, being the top row is not enough to answer it.
      '.dsh-chat-git-card[data-current="true"],.dsh-chat-git-commit[data-current="true"]',
      '{border-color:var(--dsw-alias-brand-primary,#0f1115)}',
      '.dsh-chat-git-here{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;',
      'color:var(--dsw-alias-label-primary-foreground,#fff);',
      'background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115))}',
      '.dsh-chat-git-primary,.dsh-chat-git-primary:hover:not([disabled])',
      '{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115))!important;',
      'border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115))!important;',
      'color:var(--dsw-alias-label-primary-foreground,#fff)!important}',
      '.dsh-chat-git-primary:hover:not([disabled])',
      '{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#0f1115))!important;',
      'border-color:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#0f1115))!important}',
      '.dsh-chat-git-choice[aria-checked="true"],.dsh-chat-git-choice[aria-checked="true"]:hover',
      '{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115))!important;',
      'border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115))!important;',
      'color:var(--dsw-alias-label-primary-foreground,#fff)!important}',
    ].join('')

    /** Install the stylesheet once; the disposer only removes our own element. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const head = document.head
      if (head === null || head === undefined) return () => {}
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      head.appendChild(element)
      return () => {
        if (element.parentNode !== null) element.parentNode.removeChild(element)
      }
    }

    // ---------------------------------------------------------------------
    // Checkpoints
    // ---------------------------------------------------------------------

    /**
     * Theme-aligned colors for the settings page and the inline notes.
     *
     * Every value is an alias token the shell redefines per theme, with a
     * light-theme fallback so a token that ever disappears still yields readable
     * text instead of the browser's unthemed default. Two pairings are chosen
     * deliberately rather than by habit:
     *
     * - `accent` is the *button primary fill*, and anything drawn on top of it
     *   uses `onAccent` (`label-primary-foreground`). `brand-primary` is
     *   near-black in the light theme and near-white in the dark one, so a
     *   literal white foreground on it is white-on-white in dark mode.
     * - `surface` is `bg-module-platform`, not `bg-layer-1`. The layer tokens
     *   are pure white in the light theme, which would make a card drawn on the
     *   page indistinguishable from the page itself.
     */
    const COLOR = {
      text: 'var(--dsw-alias-label-primary, #0f1115)',
      muted: 'var(--dsw-alias-label-secondary, #61666b)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.45))',
      surface: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.06))',
      accent: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #0f1115))',
      accentHover: 'var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #0f1115))',
      onAccent: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      danger: 'var(--dsw-alias-state-error-primary, #d92c2c)',
      success: 'var(--dsw-alias-state-success-primary, #22c55e)',
    }

    /** One in-flight or settled checkpoint read per session. */
    const checkpointCache = new Map()

    /**
     * Read the checkpoint list for one session, sharing one request between
     * every button that mounts for it.
     * @param sessionId - the conversation to read.
     * @returns a promise for that session's checkpoints.
     */
    function loadCheckpoints(sessionId) {
      const cached = checkpointCache.get(sessionId)
      if (cached !== undefined) return cached
      const pending = post('/chat-git/state', { sessionId }).then((result) => {
        if (!result.ok) throw new Error(result.error?.message ?? 'checkpoint read failed')
        return Array.isArray(result.value?.commits) ? result.value.commits : []
      })
      // A failed read is not cached, so a later mount retries.
      pending.catch(() => checkpointCache.delete(sessionId))
      checkpointCache.set(sessionId, pending)
      return pending
    }

    /** Drop one session's cached read so the next mount re-reads the host. */
    function invalidateCheckpoints(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') checkpointCache.clear()
      else checkpointCache.delete(sessionId)
    }

    // ---------------------------------------------------------------------
    // Assistant message → turn
    // ---------------------------------------------------------------------

    /**
     * Resolve the turn that produced one assistant message, together with the
     * sequence its turn closed on.
     *
     * The seat is dispatched with a `messageId` alone, but every checkpoint is
     * keyed by turn number and the revert needs a fork boundary. The owning turn
     * is read back off the Chat snapshot's `turn-tail` node, whose declared
     * payload carries the turn number, the closing sequence, and the final
     * assistant message id — the same three facts the turn's own renderer uses.
     *
     * The result is a `"turn:seq"` string rather than an object so the selector's
     * value stays stable by comparison and never churns renders.
     * @param snapshot - the Chat snapshot handed to the selector hook.
     * @param messageId - the message the seat was dispatched with.
     * @returns `"turn:seq"`, or an empty string when the turn is not resolvable.
     */
    function locateTurn(snapshot, messageId) {
      if (snapshot === null || typeof snapshot !== 'object') return ''
      const nodes = snapshot.nodes
      if (nodes === null || typeof nodes !== 'object' || typeof nodes.values !== 'function') return ''
      if (typeof messageId !== 'string' || messageId === '') return ''
      for (const node of nodes.values()) {
        if (node === null || typeof node !== 'object') continue
        if (node.kind !== 'turn-tail') continue
        const data = node.data
        if (data === null || typeof data !== 'object') continue
        const closing = data.closing
        if (closing === null || typeof closing !== 'object') continue
        const final = closing.finalNode
        if (final === null || typeof final !== 'object') continue
        if (final.messageId !== messageId) continue
        if (typeof data.turn !== 'number' || typeof final.seq !== 'number') continue
        return `${data.turn}:${final.seq}`
      }
      return ''
    }

    // ---------------------------------------------------------------------
    // The revert button (conversation.chat.assistant-actions)
    // ---------------------------------------------------------------------

    /** The 16px undo glyph, drawn inline so the control needs no icon package. */
    function UndoIcon() {
      return h('svg', {
        width: 15,
        height: 15,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: 'M6.4 3.6 3 7l3.4 3.4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3 7h6.3a3.6 3.6 0 0 1 0 7.2H7.4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * The rollback control for one turn, rendered beside the copy button.
     *
     * Renders nothing unless a checkpoint exists for the owning turn, so a
     * conversation that was never checkpointed keeps its action row untouched.
     * The first click arms the button and the second performs the rollback — a
     * native `confirm` is avoided because it blocks the shell's own event loop.
     */
    function RevertAction(props) {
      const sessionId = props.sessionId
      const messageId = props.messageId
      const useChat = props.useChat

      // `useChat` is guaranteed by this seat's contract, so the branch below is
      // stable across every render of every instance.
      const located = typeof useChat === 'function'
        ? useChat((snapshot) => locateTurn(snapshot, messageId))
        : ''
      const parts = typeof located === 'string' && located !== '' ? located.split(':') : []
      const turn = parts.length === 2 ? Number(parts[0]) : Number.NaN
      const seq = parts.length === 2 ? Number(parts[1]) : Number.NaN

      const [commit, setCommit] = React.useState(null)
      const [armed, setArmed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')

      React.useEffect(() => {
        let live = true
        setCommit(null)
        setArmed(false)
        setFailure('')
        if (typeof sessionId !== 'string' || sessionId === '' || !Number.isFinite(turn)) {
          return () => { live = false }
        }
        loadCheckpoints(sessionId).then((commits) => {
          if (live) setCommit(commits.find((entry) => entry.turn === turn) ?? null)
        }).catch(() => {
          if (live) setCommit(null)
        })
        return () => { live = false }
      }, [sessionId, turn])

      if (commit === null || !Number.isFinite(turn)) return null

      const revert = async () => {
        if (busy) return
        if (!armed) {
          setArmed(true)
          return
        }
        setBusy(true)
        setFailure('')
        const restored = await post('/chat-git/revert', { sessionId, sha: commit.sha })
        if (!restored.ok) {
          setBusy(false)
          setArmed(false)
          setFailure(restored.error?.message ?? '回退失败')
          return
        }
        // The conversation rollback reuses the shell's own fork primitive: a
        // session truncated at this turn's closing sequence becomes the live
        // timeline, which is how "下方的对话全部删除" is expressed without
        // destroying the log the user already has.
        let nextSessionId = null
        try {
          if (Number.isFinite(seq) && typeof props.forkAt === 'function') {
            nextSessionId = await props.forkAt(sessionId, seq)
          }
        } catch {
          nextSessionId = null
        }
        if (typeof nextSessionId === 'string' && nextSessionId !== '') {
          // A fork is a different session with no history of its own: hand it
          // the surviving checkpoints so earlier turns stay revertible there.
          await post('/chat-git/inherit', { from: sessionId, to: nextSessionId, turn })
          invalidateCheckpoints(nextSessionId)
        } else {
          invalidateCheckpoints(sessionId)
        }
        setBusy(false)
        setArmed(false)
      }

      const label = busy ? '回退中…' : armed ? '再点一次确认回退' : '回退仓库和对话'
      const button = h('button', {
        type: 'button',
        className: 'dsh-chat-git-icon',
        disabled: busy,
        title: label,
        'aria-label': label,
        ...(armed ? { 'data-armed': 'true' } : {}),
        onClick: revert,
      }, h(UndoIcon))

      const control = Tooltip === null
        ? button
        : h(Tooltip, { label, side: 'bottom' }, button)

      if (!armed && failure === '') return control
      return h('span', { style: { display: 'inline-flex', alignItems: 'center' } },
        control,
        armed ? h('span', { className: 'dsh-chat-git-note' }, `确认回退到「${commit.short}」?`) : null,
        failure !== '' ? h('span', { className: 'dsh-chat-git-note' }, failure) : null,
      )
    }

    // ---------------------------------------------------------------------
    // Settings page (settings.section)
    // ---------------------------------------------------------------------

    /** The official download page the detection failure points at. */
    const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads'

    const styles = {
      section: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0 24px', color: COLOR.text },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      lead: { margin: 0, fontSize: '13px', lineHeight: '20px', color: COLOR.muted },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '16px',
        border: `1px solid ${COLOR.border}`,
        borderRadius: '10px',
        background: COLOR.surface,
      },
      cardTitle: { margin: 0, fontSize: '13px', fontWeight: 600 },
      cardLead: { margin: 0, fontSize: '12px', lineHeight: '18px', color: COLOR.muted },
      field: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      fieldText: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
      fieldLabel: { fontSize: '13px', fontWeight: 500 },
      fieldHint: { fontSize: '12px', lineHeight: '17px', color: COLOR.muted },
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      switch: {
        position: 'relative',
        flex: '0 0 auto',
        width: '40px',
        height: '22px',
        borderRadius: '999px',
        border: `1px solid ${COLOR.borderStrong}`,
        background: 'transparent',
        cursor: 'pointer',
        transition: 'background 120ms ease',
      },
      switchOn: { background: COLOR.accent, borderColor: COLOR.accent },
      switchOff: { opacity: 0.5, cursor: 'not-allowed' },
      // The knob is a real colour, never a literal white: the "on" pill is
      // near-black in light mode and near-white in dark mode, so the knob has
      // to invert with it (`onAccent`), and the "off" knob uses the tertiary
      // label colour so it stays visible on the untinted track in both themes.
      knob: {
        position: 'absolute',
        top: '2px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-label-tertiary, #81858c)',
        transition: 'left 120ms ease,background 120ms ease',
      },
      knobOn: { background: COLOR.onAccent },
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 12px',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: 500,
        color: COLOR.text,
        background: 'transparent',
        border: `1px solid ${COLOR.borderStrong}`,
        borderRadius: '7px',
        cursor: 'pointer',
        textDecoration: 'none',
      },
      buttonPrimary: { color: COLOR.onAccent, background: COLOR.accent, borderColor: COLOR.accent },
      buttonBusy: { opacity: 0.6, cursor: 'progress' },
      choice: {
        padding: '5px 11px',
        font: 'inherit',
        fontSize: '12px',
        color: COLOR.text,
        background: 'transparent',
        border: `1px solid ${COLOR.borderStrong}`,
        borderRadius: '999px',
        cursor: 'pointer',
      },
      choiceActive: { color: COLOR.onAccent, background: COLOR.accent, borderColor: COLOR.accent },
      select: {
        font: 'inherit',
        fontSize: '12px',
        color: COLOR.text,
        background: COLOR.surface,
        border: `1px solid ${COLOR.borderStrong}`,
        borderRadius: '7px',
        padding: '5px 8px',
        maxWidth: '230px',
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11px',
        lineHeight: '16px',
        color: COLOR.muted,
        wordBreak: 'break-all',
      },
      note: (tone) => ({
        display: 'flex',
        alignItems: 'flex-start',
        gap: '6px',
        fontSize: '12px',
        lineHeight: '17px',
        color: tone === 'error' ? COLOR.danger : tone === 'ok' ? COLOR.success : COLOR.muted,
      }),
    }

    /** One option in the segmented summary-model choice. */
    function Choice(props) {
      const active = props.active === true
      return h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': active,
        disabled: props.disabled === true,
        className: 'dsh-chat-git-choice',
        style: { ...styles.choice, ...(active ? styles.choiceActive : {}) },
        onClick: () => { if (!active) props.onSelect() },
      }, props.label)
    }

    /** Render a `{ provider, model }` route, or say that none resolved. */
    function routeLabel(route) {
      if (route === null || route === undefined) return '（未解析到可用路由）'
      if (typeof route.provider !== 'string' || route.provider === '') return '（未解析到可用路由）'
      return `${route.provider} / ${String(route.model ?? '')}`
    }

    /**
     * Whether the shell is currently rendering its dark theme.
     *
     * The shell marks dark with `body[data-ds-dark-theme]` — the same attribute
     * its own token block keys off — so this is the theme source of truth, not
     * a guess from the user's OS. It exists for the one control CSS cannot
     * theme: a native `<select>` popup is drawn by the platform, so without an
     * explicit `color-scheme` the app can be dark while the popup comes back
     * white with the near-white label colour on it — the white-on-white case
     * this file is about. Guarded for non-browser and headless use.
     */
    function isDarkTheme() {
      if (typeof document === 'undefined') return false
      const body = document.body
      if (body === undefined || body === null || typeof body.hasAttribute !== 'function') return false
      return body.hasAttribute('data-ds-dark-theme') === true
    }

    /** Live `color-scheme` for native controls, re-read when the theme flips. */
    const colorSchemeStore = {
      subscribe(onChange) {
        if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return () => {}
        const body = document.body
        if (body === undefined || body === null) return () => {}
        const observer = new MutationObserver(onChange)
        observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => { observer.disconnect() }
      },
      getSnapshot() { return isDarkTheme() ? 'dark' : 'light' },
    }

    /** The `color-scheme` a native control should declare right now. */
    function useColorScheme() {
      return React.useSyncExternalStore(
        colorSchemeStore.subscribe,
        colorSchemeStore.getSnapshot,
        colorSchemeStore.getSnapshot,
      )
    }

    /** A native select, so the pickers behave and are reachable like any form control. */
    function Picker(props) {
      const colorScheme = useColorScheme()
      return h('select', {
        className: 'dsh-chat-git-select',
        style: { ...styles.select, colorScheme },
        value: props.value,
        disabled: props.disabled === true,
        'aria-label': props.label,
        onChange: (event) => props.onChange(event.target.value),
      }, (props.options ?? []).map((option) => h('option', {
        key: option.value,
        value: option.value,
      }, option.label)))
    }

    /** The switch component, shared by the settings rows. */
    function Toggle(props) {
      const on = props.on === true
      const disabled = props.disabled === true
      const style = { ...styles.switch }
      if (on) Object.assign(style, styles.switchOn)
      if (disabled) Object.assign(style, styles.switchOff)
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        'aria-label': props.label,
        disabled,
        style,
        onClick: () => { if (!disabled) props.onChange(!on) },
      }, h('span', { style: { ...styles.knob, ...(on ? styles.knobOn : {}), left: on ? '21px' : '3px' } }))
    }

    /**
     * The settings page: the master switch, the git detection probe, and the
     * download jump.
     *
     * Enabling is refused by the host while `git` is missing, so the switch
     * reflects a capability that actually exists rather than flipping to a
     * state the machine cannot honour.
     */
    function SettingsSection() {
      const [state, setState] = React.useState(null)
      const [probe, setProbe] = React.useState(null)
      const [probing, setProbing] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [catalogue, setCatalogue] = React.useState(null)
      const [loadingModels, setLoadingModels] = React.useState(false)

      const refresh = React.useCallback(async () => {
        // No session here: an empty id is the global read the host serves for
        // exactly this page (preference + git probe + state file, no commits).
        const result = await post('/chat-git/state', { sessionId: '' })
        if (result.ok) {
          setState(result.value)
          setProbe(result.value.git ?? null)
          // The tab strip is projected from the slot registry, so this switch
          // has to reach the registration rather than the component.
          publishHistory(result.value.history !== false)
        } else {
          setError(result.error?.message ?? 'host unavailable')
        }
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      const detect = async () => {
        setProbing(true)
        setError('')
        const result = await post('/chat-git/detect', { sessionId: '' })
        setProbing(false)
        if (result.ok) setProbe(result.value)
        else setError(result.error?.message ?? 'detection failed')
      }

      /**
       * Flip one host preference. Both switches share this: the host answers the
       * same `{ <field>: value }` shape, and a refusal (enabling without a
       * working git) is surfaced and the switch is re-read rather than assumed.
       */
      const setFlag = async (route, field, next) => {
        setBusy(true)
        setError('')
        const result = await post(route, { [field]: next })
        setBusy(false)
        if (!result.ok) {
          setError(result.error?.message ?? 'could not change the setting')
          await refresh()
          return
        }
        setState((current) => ({ ...(current ?? {}), [field]: result.value[field] }))
        if (field === 'history') publishHistory(result.value.history === true)
      }

      const enabled = state?.enabled === true
      const history = state?.history !== false
      const summary = state?.summary ?? null
      const summaryMode = summary?.mode ?? 'current'
      const interval = Number.isInteger(state?.interval) ? state.interval : 1

      /**
       * How many turns may pass between git checkpoints.
       *
       * The host validates the value, so a refusal re-reads instead of leaving
       * the control showing a number that was never stored.
       */
      const setIntervalTurns = async (turns) => {
        setBusy(true)
        setError('')
        const result = await post('/chat-git/set-interval', { interval: turns })
        setBusy(false)
        if (!result.ok) {
          setError(result.error?.message ?? 'could not change the setting')
          await refresh()
          return
        }
        setState((current) => ({ ...(current ?? {}), interval: result.value.interval }))
      }

      /**
       * Patch the summary preference and adopt the host's answer.
       *
       * The host replies with the whole stored object, so the UI never
       * reconstructs it from the patch it sent — and a refused patch (a custom
       * mode with no route) re-reads instead of leaving the controls lying.
       */
      const patchSummary = async (patch) => {
        setBusy(true)
        setError('')
        const result = await post('/chat-git/set-summary', patch)
        setBusy(false)
        if (!result.ok) {
          setError(result.error?.message ?? 'could not change the setting')
          await refresh()
          return false
        }
        setState((current) => ({ ...(current ?? {}), summary: result.value.summary }))
        return true
      }

      /** Read the live model catalogue the picker offers, and return it. */
      const loadCatalogue = React.useCallback(async () => {
        setLoadingModels(true)
        const result = await post('/chat-git/models', {})
        setLoadingModels(false)
        if (!result.ok) {
          setError(result.error?.message ?? 'could not read the model list')
          return null
        }
        setCatalogue(result.value)
        return result.value
      }, [])

      /**
       * Switch to `custom` with a usable route in the same patch.
       *
       * The host refuses a custom mode that has no route, so sending the mode
       * alone would answer a click with an error. An already stored route wins;
       * otherwise the first registered one is adopted.
       */
      const chooseCustomMode = async () => {
        const available = catalogue ?? await loadCatalogue()
        const provider = summary?.provider !== undefined && summary.provider !== ''
          ? summary.provider
          : (available?.providers?.[0]?.id ?? '')
        const entry = available?.providers?.find((candidate) => candidate.id === provider)
        const model = summary?.model !== undefined && summary.model !== ''
          ? summary.model
          : (entry?.models?.[0]?.id ?? '')
        await patchSummary({ mode: 'custom', provider, model })
      }

      // Read once on mount: it backs both the `current` route hint and the
      // pickers, and the host caches it, so opening the page stays cheap.
      React.useEffect(() => { void loadCatalogue() }, [loadCatalogue])

      const providers = catalogue?.providers ?? []
      const providerEntry = providers.find((entry) => entry.id === summary?.provider)
      // A provider with no registered model is not offered: picking it could only
      // produce a route the host refuses. A stored route the registry no longer
      // lists stays selectable instead, so opening this page can never silently
      // discard the user's configuration.
      const providerOptions = providers
        .filter((entry) => (entry.models?.length ?? 0) > 0 || entry.id === summary?.provider)
        .map((entry) => ({ value: entry.id, label: entry.name }))
      if (summary?.provider !== undefined && summary.provider !== ''
        && !providerOptions.some((option) => option.value === summary.provider)) {
        providerOptions.unshift({ value: summary.provider, label: summary.provider })
      }
      const modelOptions = (providerEntry?.models ?? []).map((model) => ({ value: model.id, label: model.name }))
      if (summary?.model !== undefined && summary.model !== ''
        && !modelOptions.some((option) => option.value === summary.model)) {
        modelOptions.unshift({ value: summary.model, label: summary.model })
      }

      const customPicker = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        loadingModels
          ? h('span', { style: styles.fieldHint }, '正在读取可用模型…')
          : h('div', { style: styles.row },
              h('span', { style: styles.fieldHint }, '服务商'),
              h(Picker, {
                label: '总结模型服务商',
                value: summary?.provider ?? '',
                disabled: busy || providerOptions.length === 0,
                options: providerOptions.length === 0
                  ? [{ value: '', label: '（没有可用服务商）' }]
                  : [{ value: '', label: '请选择' }, ...providerOptions],
                onChange: (provider) => {
                  // Pair the provider with its first model, so a half-set route is
                  // never sent: the host refuses that and nothing would change.
                  const entry = providers.find((candidate) => candidate.id === provider)
                  void patchSummary({ mode: 'custom', provider, model: entry?.models?.[0]?.id ?? '' })
                },              }),
            ),
        loadingModels
          ? null
          : h('div', { style: styles.row },
              h('span', { style: styles.fieldHint }, '模型'),
              h(Picker, {
                label: '总结模型',
                value: summary?.model ?? '',
                disabled: busy || modelOptions.length === 0,
                options: modelOptions.length === 0
                  ? [{ value: '', label: '（该服务商没有已注册模型）' }]
                  : [{ value: '', label: '请选择' }, ...modelOptions],
                onChange: (model) => { void patchSummary({ mode: 'custom', model }) },
              }),
            ),
        h('span', { style: styles.fieldHint },
          '列表来自当前已注册的模型路由，因此不会列出本部署无法调用的模型。'),
      )

      return h('div', { style: styles.section },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('h2', { style: styles.title }, '仓库增强'),
          h('p', { style: styles.lead },
            '把每个对话变成一条 git 检查点链：对话开始时自动 git init，每轮结束时以 Ai-coding：描述 的格式提交，随时可把代码和对话一起回退。'),
        ),

        h('div', { style: styles.card },
          h('div', { style: styles.field },
            h('div', { style: styles.fieldText },
              h('span', { style: styles.fieldLabel }, '自动检查点'),
              h('span', { style: styles.fieldHint },
                '开启后，对话开始时会检查工作区是否已有 git 仓库，没有则执行 git init；到保存点时执行 git add -A 与 git commit，提交信息为 Ai-coding：描述（保存点由下面的间隔决定）。'),
            ),
            h(Toggle, {
              on: enabled,
              disabled: busy || state === null,
              label: '自动检查点',
              onChange: (next) => { void setFlag('/chat-git/set-enabled', 'enabled', next) },
            }),
          ),
        ),

        h('div', { style: styles.card },
          h('div', { style: styles.field },
            h('div', { style: styles.fieldText },
              h('span', { style: styles.fieldLabel }, '自动保存间隔'),
              h('span', { style: styles.fieldHint },
                '每几轮保存一次 git 检查点。默认每轮都保存；选 2 或 3 轮时，中间的改动会累积到下一个保存点一起提交。对话本身每一轮都会被记录，不受这个设置影响。'),
            ),
          ),
          h('div', { style: styles.row, role: 'radiogroup', 'aria-label': '自动保存间隔' },
            ...[1, 2, 3].map((turns) => h(Choice, {
              key: `interval-${String(turns)}`,
              label: turns === 1 ? '每轮' : `每 ${String(turns)} 轮`,
              active: interval === turns,
              disabled: busy || state === null,
              onSelect: () => { void setIntervalTurns(turns) },
            })),
          ),
        ),

        h('div', { style: styles.card },
          h('div', { style: styles.field },
            h('div', { style: styles.fieldText },
              h('span', { style: styles.fieldLabel }, '历史标签页'),
              h('span', { style: styles.fieldHint },
                '在「对话 / 轨迹」旁显示「历史」标签页，按轮列出检查点，可从任意一轮 fork 或回退。关掉只是收起这个入口：每轮的撤回按钮与全部检查点照常可用。'),
            ),
            h(Toggle, {
              on: history,
              disabled: busy || state === null,
              label: '历史标签页',
              onChange: (next) => { void setFlag('/chat-git/set-history', 'history', next) },
            }),
          ),
        ),

        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, 'AI 总结提交信息'),
          h('p', { style: styles.cardLead },
            '每轮结束时会请模型读一遍该轮的提示词与改动文件，写出一句简短标题作为提交描述，取代冗长且被截断的原始提示词。模型不可用时自动回退为提示词本身，不会因此丢掉检查点。'),

          h('div', { style: styles.row, role: 'radiogroup', 'aria-label': '总结模型' },
            h(Choice, {
              label: '关闭',
              active: summaryMode === 'off',
              disabled: busy || state === null,
              onSelect: () => { void patchSummary({ mode: 'off' }) },
            }),
            h(Choice, {
              label: '使用当前模型',
              active: summaryMode === 'current',
              disabled: busy || state === null,
              onSelect: () => { void patchSummary({ mode: 'current' }) },
            }),
            h(Choice, {
              label: '指定模型',
              active: summaryMode === 'custom',
              disabled: busy || state === null,
              onSelect: () => { void chooseCustomMode() },
            }),
          ),

          summaryMode === 'current'
            ? h('span', { style: styles.fieldHint },
                `总结时使用该对话自身的模型，读不到时退回默认模型：${routeLabel(catalogue?.current)}`)
            : null,

          summaryMode === 'off'
            ? h('span', { style: styles.fieldHint }, '已关闭：提交描述直接取该轮的提示词，不产生任何模型调用。')
            : null,

          summaryMode === 'custom' ? customPicker : null,
        ),

        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, 'Git 环境'),
          h('p', { style: styles.cardLead },
            '检查点依赖本机的 git 命令行。检测会执行 git --version；未安装时无法开启自动检查点。'),

          h('div', { style: styles.row },
            h('button', {
              type: 'button',
              className: 'dsh-chat-git-btn',
              style: { ...styles.button, ...(probing ? styles.buttonBusy : {}) },
              disabled: probing,
              onClick: () => { void detect() },
            }, probing ? '检测中…' : '检测 Git'),
            h('a', {
              className: 'dsh-chat-git-btn dsh-chat-git-primary',
              style: { ...styles.button, ...styles.buttonPrimary },
              href: GIT_DOWNLOAD_URL,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, '下载 Git'),
          ),

          probe === null
            ? h('div', { style: styles.note('muted') }, '尚未检测。')
            : probe.available
              ? h('div', { style: styles.note('ok') }, `已检测到 ${probe.version}`)
              : h('div', { style: styles.note('error') },
                  `未检测到可用的 git：${probe.error || 'git --version 未返回版本信息'}。请先安装 Git 后再开启。`),
        ),

        error !== '' ? h('div', { style: styles.note('error') }, error) : null,

        state !== null
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('span', { style: styles.fieldHint },
                state.committed
                  ? '状态已写入磁盘，重启 harness 后仍然有效。'
                  : '状态文件当前不可写，设置只在本次进程内有效。'),
              h('span', { style: styles.mono }, state.stateFile ?? ''),
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // The conversation timeline panel
    // ---------------------------------------------------------------------

    /**
     * Whether the History view is offered, mirrored from the host.
     *
     * The tab strip is projected from the `conversation.view` slot itself, so a
     * component cannot hide its own tab — the only way to withdraw it is to not
     * be registered. This store is what lets the settings switch reach the
     * registration and take it back down.
     */
    let historyState = { enabled: true }
    const historyListeners = new Set()

    function publishHistory(enabled) {
      historyState = { enabled: enabled === true }
      for (const listener of historyListeners) listener()
    }

    function subscribeHistory(listener) {
      historyListeners.add(listener)
      return () => { historyListeners.delete(listener) }
    }

    /**
     * Requests 编辑并发送 has handed to a composer that is not on screen yet.
     *
     * The conversation is opened asynchronously and the composer that has to
     * receive the text belongs to another plugin, so there is no synchronous
     * hand-off to make: the request is parked under the target session id and
     * {@link ComposerSeeder} collects it the moment that session's composer
     * mounts. Keyed by session id rather than kept in one slot, because two
     * cards can legitimately be acted on one after another.
     */
    const pendingSeeds = new Map()

    /**
     * Park one request for a session's composer.
     * @param sessionId - the session whose composer should receive it.
     * @param seed - `{ text, imageIds }`; the ids are draft-local, already
     * registered with the conversation service.
     */
    function parkSeed(sessionId, seed) {
      pendingSeeds.set(sessionId, seed)
    }

    /**
     * Take the request parked for one session, if any.
     *
     * Taking is removing: a draft is written once, and a second composer mount
     * (the user navigating away and back) must not overwrite whatever they have
     * typed since.
     * @param sessionId - the session whose composer is mounting.
     * @returns the parked request, or null.
     */
    function takeSeed(sessionId) {
      const seed = pendingSeeds.get(sessionId)
      if (seed === undefined) return null
      pendingSeeds.delete(sessionId)
      return seed
    }

    /**
     * The headless composer seeder.
     *
     * 编辑并发送 moves the shell onto a conversation whose composer does not
     * exist yet, and that composer belongs to another plugin, so there is no
     * synchronous hand-off to make. This entry rides the composer's own session
     * scope instead: it renders nothing, and on mount it takes whatever request
     * was parked for *its* session and writes it through the actions the
     * composer itself publishes — never by reaching into another plugin's
     * internals.
     *
     * `inputActions` is absent while a session has no composer on screen (the
     * no-workspace hero), which is why the effect lists it as a dependency: the
     * seed is taken when the composer that can receive it exists, not merely
     * when the session does. Taking is destructive, so a later remount of the
     * same session cannot overwrite what the user has typed in the meantime.
     */
    function ComposerSeeder({ sessionId, inputActions }) {
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        if (inputActions === undefined || inputActions === null) return undefined
        const seed = takeSeed(sessionId)
        if (seed === null) return undefined
        if (seed.text !== '') inputActions.setDraft(seed.text)
        if (seed.imageIds.length > 0) inputActions.addImages(seed.imageIds)
        return undefined
      }, [sessionId, inputActions])
      return null
    }

    /**
     * `YYYY-MM-DD HH:MM:SS` for one timestamp, or an empty string when it is
     * unknown.
     *
     * The card is the only place a turn's own time is written down, and `14:05`
     * on its own cannot answer "was that today, yesterday, or last week" — which
     * is the first thing a history list is read for once a conversation spans
     * more than an afternoon. Seconds are kept because two turns of one
     * conversation routinely close inside the same minute, and a list that shows
     * them identically is unreadable in exactly the case it matters.
     */
    function stampOf(at) {
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return ''
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /**
     * The panel's own colors, resolved against the active theme.
     *
     * `background` is the layer the view body sits on and `surface` is the
     * raised card fill; both are tokens the shell redefines per theme, so the
     * same markup reads as light grey cards on white and raised grey cards on
     * near-black without a second stylesheet. The light fallbacks are light-theme
     * values on purpose: `#fff` text is only ever correct in dark mode, and a
     * token that resolves to nothing would then be unreadable in light mode.
     */
    const PANEL = {
      background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      surface: 'var(--dsw-alias-bg-module-platform, #f5f6f7)',
      text: 'var(--dsw-alias-label-primary, #0f1115)',
      muted: 'var(--dsw-alias-label-secondary, #61666b)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      accent: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #0f1115))',
      onAccent: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      danger: 'var(--dsw-alias-state-error-primary, #d92c2c)',
    }

    /**
     * One column of the split view.
     *
     * Each pane owns its own scroll box, so a long conversation and a long
     * commit list scroll independently: the two halves are read for different
     * reasons, and one shared scrollbar made the shorter list unreachable while
     * the longer one was being read.
     */
    const PANE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      flex: '1 1 0',
      minWidth: 0,
      minHeight: 0,
      boxSizing: 'border-box',
      border: `1px solid ${PANEL.border}`,
      borderRadius: '12px',
      padding: '12px 14px',
      overflowY: 'auto',
    }

    const panelStyles = {
      root: {
        display: 'flex',
        alignItems: 'stretch',
        gap: '12px',
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        padding: '16px 18px 28px',
        color: PANEL.text,
        background: PANEL.background,
      },
      pane: PANE,
      header: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
      },
      title: { margin: 0, fontSize: '13px', fontWeight: 600 },
      count: { fontSize: '11px', color: PANEL.muted },
      cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' },
      cardTurn: { fontSize: '12px', fontWeight: 600 },
      cardTime: { fontSize: '11px', color: PANEL.muted },
      prompt: { margin: 0, fontSize: '12px', lineHeight: '18px', color: PANEL.text, wordBreak: 'break-word' },
      commit: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11px',
        lineHeight: '16px',
        color: PANEL.muted,
        wordBreak: 'break-all',
      },
      muted: { fontSize: '11px', lineHeight: '16px', color: PANEL.muted },
      actions: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      backdrop: {
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))',
        pointerEvents: 'auto',
        zIndex: 60,
      },
      dialog: {
        width: '380px',
        maxWidth: '92vw',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '18px',
        borderRadius: '12px',
        background: PANEL.background,
        border: `1px solid ${PANEL.border}`,
        boxShadow: '0 0 32px rgba(0,0,0,0.4)',
      },
      dialogTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      dialogBody: { margin: 0, fontSize: '12px', lineHeight: '18px', color: PANEL.muted },
      dialogActions: { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end' },
    }



    /**
     * The History view: the conversation's turns, newest last, in the middle
     * content area beside 对话 and 轨迹.
     *
     * It is a `conversation.view` target, so the session id arrives as a
     * standard prop and the shell decides when it is on screen — the component
     * itself is the whole view body. Each card lists one turn and offers the two
     * branch actions; both open a dialog that chooses whether the repository is
     * restored along with the conversation, because that choice is not
     * recoverable from the label alone.
     */
    function HistoryView(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      /** Bumped after an action so the list re-reads the host's answer. */
      const [revision, setRevision] = React.useState(0)
      const [state, setState] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [pending, setPending] = React.useState(null)
      // The turn whose whole request is currently being read, or 0 for none.
      // Held as a turn number rather than a flag because the read is per card: a
      // flag would relabel every card's button while one of them loaded, and the
      // action is unusable until that read lands — a half-read request must
      // never be what gets handed to the new session's input box.
      const [loadingPrompt, setLoadingPrompt] = React.useState(0)
      // The turn whose 编辑并发送 dialog is open, or null. The dialog exists
      // because there are two honest destinations for the rebuilt line, and the
      // difference is not recoverable afterwards: 还原 replaces this
      // conversation (the original is archived), 新建对话 starts beside it.
      const [pendingEdit, setPendingEdit] = React.useState(null)
      // The failure of the last 编辑并发送 attempt, said inside that dialog. Both
      // the read and the move happen after a destination was picked, so their
      // errors belong where that choice was made.
      const [editError, setEditError] = React.useState('')
      // What the last successful 编辑并发送 did, said in the pane rather than in a
      // dialog: the action moves the whole shell onto a new conversation, so the
      // only place left to explain what happened is the view the user is looking
      // at while it happens.
      const [notice, setNotice] = React.useState('')
      // The right pane's own state. It is deliberately a second, independent
      // read: the workspace pane knows nothing about turns, and the
      // conversation pane never waits on a git command.
      const [repo, setRepo] = React.useState(null)
      const [repoError, setRepoError] = React.useState('')
      const [repoBusy, setRepoBusy] = React.useState(false)
      // The commit whose restore is being confirmed, or null. A dialog rather
      // than a second click on the row: the confirmation has to name what is
      // about to be overwritten, and a row has no room for that sentence.
      const [pendingRestore, setPendingRestore] = React.useState(null)

      React.useEffect(() => {
        let live = true
        if (sessionId === '') {
          setState(null)
          return () => { live = false }
        }
        setLoading(true)
        post('/chat-git/timeline', { sessionId }).then((result) => {
          if (!live) return
          setLoading(false)
          if (result.ok) {
            setState(result.value)
            setError('')
          } else {
            setError(result.error?.message ?? '读取历史失败')
          }
        })
        return () => { live = false }
      }, [revision, sessionId])

      React.useEffect(() => {
        let live = true
        if (sessionId === '') {
          setRepo(null)
          return () => { live = false }
        }
        setRepoBusy(true)
        post('/chat-git/repo', { sessionId }).then((result) => {
          if (!live) return
          setRepoBusy(false)
          if (result.ok) {
            setRepo(result.value)
            setRepoError('')
          } else {
            setRepo(null)
            setRepoError(result.error?.message ?? '读取仓库失败')
          }
        })
        return () => { live = false }
      }, [revision, sessionId])

      const turns = Array.isArray(state?.turns) ? state.turns : []
      // The conversation pane lists turns newest first, matching `git log` in
      // the pane beside it: the turn you are standing on is the one the actions
      // are most often aimed at, and reaching it should not mean scrolling past
      // the whole conversation. Each entry keeps its chronological index,
      // because the actions that need a boundary — 编辑并发送 above all —
      // address the turn *before* the one they were opened on.
      const orderedTurns = turns.map((entry, index) => ({ entry, index })).reverse()
      // Where the conversation stands: its newest turn, which is also the first
      // row of that list. The badge exists because the list is long — "which
      // turn am I on" stops being answerable from position alone once it
      // scrolls, exactly as it does in the workspace pane.
      const currentTurn = turns.length === 0 ? null : turns[turns.length - 1].turn
      const commits = Array.isArray(repo?.commits) ? repo.commits : []
      // Where the worktree stands. The host remembers it because a restore
      // deliberately leaves HEAD alone, and `positionKnown` keeps "the host told
      // us this is HEAD" apart from "the host has no record" — the pane words
      // those two differently rather than pretending to know which it is.
      const current = typeof repo?.position === 'string' ? repo.position : ''
      const currentKnown = repo?.positionKnown === true

      /** Fork or rewind the conversation. The repository is not touched here. */
      const run = async (entry, mode) => {
        if (busy) return
        setBusy(true)
        setError('')
        const outcome = await props.branch({
          sessionId,
          turn: entry.turn,
          seq: entry.seq,
          mode,
        })
        setBusy(false)
        setPending(null)
        if (!outcome.ok) {
          setError(outcome.error)
          return
        }
        // Re-read the host's answer: the fork moved the conversation, so the
        // list this view was showing no longer describes it.
        setRevision((current) => current + 1)
      }

      /**
       * Hand one turn's request to a rebuilt conversation's input box.
       *
       * The dialog over the card chose the destination, and the two differ in
       * exactly one thing — whether the conversation the user is standing in
       * survives:
       *
       * - `new` forks at the turn before the chosen one and leaves the original
       *   untouched, so two lines continue side by side.
       * - `current` performs the same rebuild but then archives the original, so
       *   the window the user is already in *becomes* the rebuilt line: this is
       *   "revert this conversation and ask that turn again".
       *
       * Neither one sends. The turn's whole request (its text and its images) is
       * handed to the composer and the action stops there, so the user keeps the
       * last word: they can rewrite it, drop an image, change the model, or
       * decide not to send at all.
       *
       * The whole request is read from the host only after a destination was
       * picked, because the card carries a display clip of the prompt rather
       * than the prompt; the read's failure is reported in the dialog it was
       * asked from.
       *
       * The first turn has no turn before it, and forking at nothing would keep
       * the whole conversation; a fresh session in the same workspace is the
       * honest expression of "nothing before this turn is kept".
       * @param entry - the turn whose request is being re-sent.
       * @param mode - `'current'` or `'new'`.
       */
      const runEditSend = async (entry, mode) => {
        if (busy || loadingPrompt !== 0) return
        setError('')
        setNotice('')
        setLoadingPrompt(entry.turn)
        const result = await post('/chat-git/turn-prompt', { sessionId, turn: entry.turn })
        setLoadingPrompt(0)
        if (!result.ok) {
          setEditError(result.error?.message ?? '读取该轮提示词失败')
          return
        }
        const index = turns.findIndex((candidate) => candidate.turn === entry.turn)
        const previous = index > 0 ? turns[index - 1] : null
        setBusy(true)
        const outcome = await props.editSend({
          sessionId,
          turn: entry.turn,
          previous,
          mode,
          text: typeof result.value?.text === 'string' ? result.value.text : '',
          images: Array.isArray(result.value?.images) ? result.value.images : [],
          cwd: typeof state?.cwd === 'string' ? state.cwd : '',
        })
        setBusy(false)
        if (!outcome.ok) {
          setEditError(outcome.error)
          return
        }
        setPendingEdit(null)
        setNotice(outcome.notice ?? '已开启新会话，提示词已放进输入区。')
        setRevision((current) => current + 1)
      }

      /** Restore the working tree to one commit. The conversation is not touched. */
      const restore = async (sha) => {
        if (repoBusy) return
        setRepoBusy(true)
        setRepoError('')
        const result = await post('/chat-git/restore', { sessionId, sha })
        setRepoBusy(false)
        setPendingRestore(null)
        if (!result.ok) {
          setRepoError(result.error?.message ?? '代码还原失败')
          return
        }
        setRevision((current) => current + 1)
      }

      /**
       * One conversation card. It offers conversation actions and nothing else.
       *
       * `here` marks the conversation's newest turn — the row the session
       * currently ends on — tagged the same way the workspace pane tags the
       * commit the worktree stands on.
       */
      const card = (entry, index, here) => {
        // A turn that never closed has no boundary to branch at; offering the
        // buttons anyway would produce a wrong or failed fork.
        const branchable = typeof entry.seq === 'number' && typeof sessionId === 'string' && sessionId !== ''
        // 编辑并发送 rebuilds the conversation *from* this turn, so the boundary
        // it needs belongs to the turn before it. The first turn needs none:
        // there is nothing to keep, so it starts a fresh session in the same
        // workspace instead.
        const previous = index > 0 ? turns[index - 1] : null
        const editable = branchable && (previous === null || typeof previous.seq === 'number')
        return h('div', {
          key: String(entry.turn),
          className: 'dsh-chat-git-card',
          ...(here ? { 'data-current': 'true' } : {}),
        },
          h('div', { style: panelStyles.cardHead },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              h('span', { style: panelStyles.cardTurn }, `第 ${String(entry.turn)} 轮`),
              here ? h('span', { className: 'dsh-chat-git-here' }, '当前位置') : null,
            ),
            h('span', { style: panelStyles.cardTime }, stampOf(entry.at)),
          ),
          h('p', { style: panelStyles.prompt }, entry.prompt !== '' ? entry.prompt : '（该轮没有记录到用户提示词）'),
          h('div', { style: panelStyles.actions },
            h('button', {
              type: 'button',
              disabled: busy || !branchable,
              onClick: () => setPending({ entry, mode: 'fork' }),
            }, '从这里打开新对话(fork)'),
            h('button', {
              type: 'button',
              disabled: busy || !branchable,
              onClick: () => setPending({ entry, mode: 'revert' }),
            }, '回退到这里(还原)'),
            h('button', {
              type: 'button',
              disabled: busy || loadingPrompt !== 0 || !editable,
              onClick: () => { setEditError(''); setPendingEdit({ entry }) },
            }, '编辑并发送'),
          ),
          // The card remembers the request, images included, but states only how
          // many there were: the handles themselves are re-read by the one
          // action that moves them, and a thumbnail grid would turn a history
          // list into a gallery.
          entry.imageCount > 0
            ? h('span', { style: panelStyles.muted }, `含 ${String(entry.imageCount)} 张图片`)
            : null,
          branchable
            ? null
            : h('span', { style: panelStyles.muted }, '该轮没有结束序列（仍在进行中），无法定位分叉点。'),
          branchable && !editable
            ? h('span', { style: panelStyles.muted }, '上一轮没有结束序列，无法从这里重新开始。')
            : null,
        )
      }

      /**
       * One commit row in the workspace pane.
       *
       * Restoring is confirmed in a dialog rather than by arming the button: the
       * confirmation has to say what is about to be overwritten, and a list row
       * has no room for that sentence. The row the worktree currently stands on
       * is tagged — after a restore HEAD no longer answers "where am I", because
       * restoring deliberately leaves HEAD where it was.
       */
      const commitRow = (commit) => {
        const when = stampOf(Date.parse(commit.date))
        const here = current !== '' && commit.sha === current
        return h('div', {
          key: commit.sha,
          className: 'dsh-chat-git-commit',
          ...(here ? { 'data-current': 'true' } : {}),
        },
          h('span', { className: 'dsh-chat-git-graph', 'aria-hidden': 'true' }),
          h('div', { className: 'dsh-chat-git-commit-body' },
            h('div', { style: panelStyles.cardHead },
              h('span', { style: panelStyles.commit }, commit.short),
              here ? h('span', { className: 'dsh-chat-git-here' }, '当前位置') : null,
            ),
            h('p', { style: panelStyles.prompt }, commit.subject),
            h('div', { className: 'dsh-chat-git-commit-meta' },
              h('span', null,
                [when, commit.author].filter((part) => typeof part === 'string' && part !== '').join(' · ')),
            ),
            h('div', { style: panelStyles.actions },
              h('button', {
                type: 'button',
                disabled: repoBusy || here,
                onClick: () => { setRepoError(''); setPendingRestore(commit) },
              }, here ? '已在此位置' : '还原到这里'),
            ),
          ),
        )
      }

      // The dialog is opened by one of the two branch buttons, so its wording
      // follows that choice: a fork dialog never says 回退, and a rewind dialog
      // never says fork. Spelling both into every button ("仅回退/fork 对话") made
      // the user re-read the card button they had just clicked to work out which
      // of the two they were actually in.
      //
      // There is no code scope to choose either: the repository has its own
      // pane, so a conversation fork/rewind never touches the working tree and
      // the dialog only confirms what the card button already said.
      const confirm = pending === null
        ? ''
        : pending.mode === 'fork' ? '确认打开新对话' : '确认回退对话'

      const dialog = pending === null ? null : h('div', { style: panelStyles.backdrop },
        h('div', { className: 'dsh-chat-git-dialog', style: panelStyles.dialog },
          h('h4', { style: panelStyles.dialogTitle },
            `${pending.mode === 'fork' ? '从这里打开新对话' : '回退到这里'}`
            + ` · 第 ${String(pending.entry.turn)} 轮`),
          pending.mode === 'fork'
            ? h('p', { style: panelStyles.dialogBody },
                '会新建一个只含到该轮的会话并切换过去；当前会话保持原样，两条线都能继续。')
            : h('p', { style: panelStyles.dialogBody },
                '会新建一个只含到该轮的会话并切换过去；当前会话随即归档（可从归档恢复），相当于往回走。'),
          h('p', { style: panelStyles.dialogBody }, '只作用于对话，工作区的代码不会被改动。'),
          error !== '' ? h('p', { style: { ...panelStyles.dialogBody, color: PANEL.danger } }, error) : null,
          h('div', { style: panelStyles.dialogActions },
            h('button', {
              type: 'button',
              className: 'dsh-chat-git-primary',
              disabled: busy,
              onClick: () => { void run(pending.entry, pending.mode) },
            }, confirm),
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => { setPending(null); setError('') },
            }, '取消'),
          ),
        ),
      )

      // 编辑并发送 has two destinations, and the difference only shows up after
      // the fact, so the choice is asked here rather than implied by the button.
      //
      // 当前对话 rebuilds *this* line: the same conversation is replaced by one
      // that ends at the previous turn, and the original is archived. 新建对话
      // rebuilds beside it and leaves the original alone. Both hand the turn's
      // whole request — text and images — to the new composer instead of
      // sending, so the user still owns the send.
      //
      // The read and the move both happen after a destination was picked, which
      // is why their failures are reported here, next to the choice that caused
      // them, rather than in the pane behind the dialog.
      const editDialog = pendingEdit === null ? null : h('div', { style: panelStyles.backdrop },
        h('div', { className: 'dsh-chat-git-dialog', style: panelStyles.dialog },
          h('h4', { style: panelStyles.dialogTitle },
            `编辑并发送 · 第 ${String(pendingEdit.entry.turn)} 轮`),
          h('p', { style: panelStyles.dialogBody },
            '把这一轮重新问一遍：提示词（连同图片）会放进输入区，不会自动发送，你可以改完再决定。'),
          h('p', { style: panelStyles.dialogBody },
            '当前对话：在本窗口里回退到上一轮，从这一轮重新开始；当前对话随即归档（可从归档恢复）。'),
          h('p', { style: panelStyles.dialogBody },
            '新建对话：另开一条只含到上一轮的会话并切换过去，当前对话保持原样，两条线都能继续。'),
          editError !== ''
            ? h('p', { style: { ...panelStyles.dialogBody, color: PANEL.danger } }, editError)
            : null,
          h('div', { style: panelStyles.dialogActions },
            h('button', {
              type: 'button',
              className: 'dsh-chat-git-primary',
              disabled: busy || loadingPrompt !== 0,
              onClick: () => { void runEditSend(pendingEdit.entry, 'current') },
            }, '当前对话'),
            h('button', {
              type: 'button',
              disabled: busy || loadingPrompt !== 0,
              onClick: () => { void runEditSend(pendingEdit.entry, 'new') },
            }, '新建对话'),
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => { setPendingEdit(null); setEditError('') },
            }, '取消'),
          ),
        ),
      )

      // Two independent columns: the conversation on the left, the workspace's
      // own repository on the right. Neither reads the other's data and neither
      // waits on the other's request, so a broken repository cannot take the
      // conversation list down with it (and the reverse).
      const conversationPane = h('div', { className: 'dsh-chat-git-pane', style: panelStyles.pane },
        h('div', { style: panelStyles.header },
          h('h3', { style: panelStyles.title }, '对话'),
          h('span', { style: panelStyles.count }, `${String(turns.length)} 轮`),
        ),
        h('span', { style: panelStyles.muted },
          '只作用于对话：从某一轮 fork 出新会话，或回退到该轮并归档当前会话。'),
        h('span', { style: panelStyles.muted }, '按时间倒序排列，最新一轮在最上面。'),
        currentTurn === null
          ? null
          : h('span', { style: panelStyles.muted }, `当前位置：第 ${String(currentTurn)} 轮。`),
        loading ? h('span', { style: panelStyles.muted }, '正在读取…') : null,
        error !== '' && pending === null
          ? h('span', { style: { ...panelStyles.muted, color: PANEL.danger } }, error)
          : null,
        // 编辑并发送 moves the shell onto another conversation, so this pane is
        // usually replaced a moment later. The notice is still worth stating:
        // whoever looks back at this line needs to know the request was not
        // thrown away, only handed to the new composer.
        notice !== '' ? h('span', { style: panelStyles.muted }, notice) : null,
        !loading && error === '' && turns.length === 0
          ? h('span', { style: panelStyles.muted }, '这个对话还没有任何记录。')
          : null,
        orderedTurns.map(({ entry, index }) => card(entry, index, entry.turn === currentTurn)),
      )

      const repoAvailable = repo !== null && repo.git?.available !== false
      const repoPane = h('div', { className: 'dsh-chat-git-pane', style: panelStyles.pane },
        h('div', { style: panelStyles.header },
          h('h3', { style: panelStyles.title }, '工作区 Git'),
          h('span', { style: panelStyles.count }, repoAvailable ? `${String(commits.length)} 个提交` : ''),
        ),
        // Only an *unexplained* empty pane says the repository is missing: when
        // there is an error it is the error that is shown, because blaming the
        // repository for a route that failed to answer is exactly the wrong
        // diagnosis to hand the user.
        repo === null && repoError === ''
          ? h('span', { style: panelStyles.muted }, repoBusy ? '正在读取…' : '没有可读取的仓库。')
          : null,
        repo !== null
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('span', { style: panelStyles.muted },
                `${repo.branch === '' ? '（游离 HEAD）' : repo.branch} · ${repo.dirty ? '有未提交改动' : '工作区干净'}`),
              h('span', { style: panelStyles.commit }, repo.root ?? ''),
            )
          : null,
        // The host's own words, paired with a retry. A route that was
        // momentarily unreachable — a host process still running the previous
        // build, a restarted server — used to leave the pane stuck on the
        // failure until some unrelated action happened to re-read it, and the
        // message named the repository when the route was what was missing.
        repoError !== ''
          ? h('div', { style: panelStyles.actions },
              h('span', { style: { ...panelStyles.muted, color: PANEL.danger } }, repoError),
              h('button', {
                type: 'button',
                disabled: repoBusy,
                onClick: () => { setRepoError(''); setRevision((current) => current + 1) },
              }, '重试'),
            )
          : null,
        repo !== null && repo.git?.available === false
          ? h('span', { style: panelStyles.muted }, '未检测到可用的 git，无法管理仓库。')
          : null,
        repoAvailable && commits.length === 0 && !repoBusy
          ? h('span', { style: panelStyles.muted }, '这个仓库还没有任何提交。')
          : null,
        repoAvailable
          ? h('span', { style: panelStyles.muted }, '还原只动工作区（git checkout + 清理新增路径），不改对话、不改 HEAD。')
          : null,
        repoAvailable
          ? h('span', { style: panelStyles.muted },
              currentKnown
                ? `当前位置：${current.slice(0, 7)}。`
                : '当前位置：HEAD（这个会话还没有还原过）。')
          : null,
        commits.map(commitRow),
      )

      // The restore confirmation. It repeats the commit's own subject instead of
      // only its id, because "还原到这里" is unambiguous only while the row is
      // still on screen — the dialog has to stand on its own.
      const restoreDialog = pendingRestore === null ? null : h('div', { style: panelStyles.backdrop },
        h('div', { className: 'dsh-chat-git-dialog', style: panelStyles.dialog },
          h('h4', { style: panelStyles.dialogTitle }, `还原到这里 · ${pendingRestore.short}`),
          h('p', { style: panelStyles.dialogBody }, pendingRestore.subject),
          h('p', { style: panelStyles.dialogBody },
            '会把这个提交的内容写回工作区，并清掉该提交中不存在的新增路径；HEAD 不动，提交历史和这个对话都不会改变。'),
          h('p', { style: panelStyles.dialogBody },
            '未跟踪的文件不属于任何检查点，删掉就找不回来，因此不会被清理。'),
          h('p', { style: panelStyles.dialogBody },
            currentKnown
              ? `当前位置：${current.slice(0, 7)}；还原后变成 ${pendingRestore.short}。`
              : `当前位置：HEAD；还原后变成 ${pendingRestore.short}。`),
          h('div', { style: panelStyles.dialogActions },
            h('button', {
              type: 'button',
              className: 'dsh-chat-git-primary',
              disabled: repoBusy,
              onClick: () => { void restore(pendingRestore.sha) },
            }, repoBusy ? '还原中…' : '确认还原'),
            h('button', {
              type: 'button',
              disabled: repoBusy,
              onClick: () => setPendingRestore(null),
            }, '取消'),
          ),
        ),
      )

      return h('div', { style: panelStyles.root },
        conversationPane,
        repoPane,
        dialog,
        editDialog,
        restoreDialog,
      )
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    /** The slot registry plus the session service whose fork/open drive the rollback. */
    const inject = ['slots', 'sessions']

    /**
     * Client plugin body: the per-turn revert button and the settings page.
     * @param ctx - the browser root context.
     */
    function apply(ctx) {
      const sessions = ctx.sessions

      /**
       * Fork the live conversation at one closing sequence and open the
       * truncated result — the shell's own rollback primitive.
       * @param sessionId - the conversation being rolled back.
       * @param seq - the closing sequence of the turn being kept.
       * @returns the new session id.
       */
      const forkAt = async (sessionId, seq) => {
        const nextSessionId = await sessions.fork({ sessionId, atSeq: seq })
        sessions.open(nextSessionId)
        return nextSessionId
      }

      ctx.effect(() => installStyles(), 'chat-git: styles')

      ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'chat-git-revert',
        order: 40,
        label: '回退仓库和对话',
      }, (props) => h(RevertAction, { ...props, forkAt }))), 'chat-git: revert button')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'chat-git',
        order: 140,
        label: '仓库增强',
      }, SettingsSection)), 'chat-git: settings page')

      // The seat that carries out a 编辑并发送. It is a list entry above the
      // composer card, like the todo and queue docks, because that is where the
      // composer's own session scope is already resolved: the entry receives
      // `sessionId` and `inputActions`, which is exactly the pair the hand-off
      // needs. It renders nothing, so the entry costs one inert node.
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'chat-git-seed',
        order: 30,
      }, ComposerSeeder)), 'chat-git: composer seeder')

      /**
       * Branch a conversation at one turn. It never touches the repository.
       *
       * Every path here is a fork: DSH has no "truncate session" API, so both
       * `fork` and `回退` produce a session that ends at the chosen turn. The
       * difference is what happens to the original — `fork` leaves it alone,
       * `回退` archives it so the list reflects the line you walked back onto.
       *
       * There is deliberately no code scope: the working tree is the workspace
       * pane's business, restored through its own route, so a conversation
       * action cannot leave the repository half-rewound.
       * @param request - the turn, its boundary, and the mode.
       * @returns `{ ok: true, nextSessionId }` or `{ ok: false, error }`.
       */
      const branch = async ({ sessionId, turn, seq, mode }) => {
        let nextSessionId
        try {
          nextSessionId = await sessions.fork({ sessionId, atSeq: seq })
        } catch (error) {
          return { ok: false, error: `分叉失败：${error instanceof Error ? error.message : String(error)}` }
        }

        // The fork is a new session with no history of its own: hand it the
        // surviving checkpoints so earlier turns stay revertible there too.
        await post('/chat-git/inherit', { from: sessionId, to: nextSessionId, turn })
        sessions.open(nextSessionId)

        if (mode === 'revert') await archive(sessionId)
        return { ok: true, nextSessionId }
      }

      /**
       * Read one durable image back into a browser file.
       * @returns the file, or null when the reference cannot be read.
       */
      const readImageFile = async (sessionId, attachmentId) => {
        const binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
        const session = binding?.session
        if (session === undefined || typeof session.readAttachment !== 'function') return null
        let result
        try {
          result = await session.readAttachment(attachmentId)
        } catch {
          return null
        }
        if (result === null || typeof result !== 'object' || result.ok !== true) return null
        const attachment = result.value?.attachment
        const data = result.value?.data
        if (data === undefined || data === null) return null
        const mediaType = typeof attachment?.mediaType === 'string' ? attachment.mediaType : 'image/png'
        const name = typeof attachment?.name === 'string' && attachment.name !== '' ? attachment.name : 'image'
        try {
          return new File([data], name, { type: mediaType })
        } catch {
          return null
        }
      }

      /**
       * Register the re-read images as draft images of the target session.
       *
       * `createDraftImages` is the only way to mint draft-local ids, because
       * `InputActions.addImages` speaks those ids and nothing else; it belongs
       * to the conversation service, which is also the object every shipped
       * composer goes through.
       * @returns the draft image ids to add, or an empty list.
       */
      const registerImages = async (sourceId, images) => {
        const conversation = ctx.get('conversation')
        if (conversation === undefined || typeof conversation.createDraftImages !== 'function') return []
        const files = []
        for (const image of images) {
          const id = typeof image?.attachmentId === 'string' ? image.attachmentId : ''
          if (id === '') continue
          const file = await readImageFile(sourceId, id)
          if (file !== null) files.push(file)
        }
        if (files.length === 0) return []
        try {
          return conversation.createDraftImages(files).map((attachment) => attachment.id)
        } catch {
          return []
        }
      }

      /**
       * The Workspace grouping a conversation belongs to, or ''.
       *
       * `sessions.create({ cwd })` only tells the host which directory to run
       * in: grouping is the Workspace service's own business, and a session
       * created from a bare directory is published as 未分组 even when that
       * directory *is* the Workspace's path. The rebuilt line has to land in
       * the group the conversation came from, so the group is resolved from the
       * source session id — and `{ cwd }` stays only as the fallback for a
       * deployment with no Workspace service.
       * @param sessionId - the conversation being rebuilt.
       * @returns the workspace id, or '' when it cannot be resolved.
       */
      const workspaceOf = (sessionId) => {
        const workspaces = ctx.get('workspaces')
        if (workspaces === undefined || typeof workspaces.list?.getSnapshot !== 'function') return ''
        const snapshot = workspaces.list.getSnapshot()
        const items = Array.isArray(snapshot?.items) ? snapshot.items : []
        for (const item of items) {
          if (item === null || typeof item !== 'object') continue
          if (!Array.isArray(item.sessionIds) || !item.sessionIds.includes(sessionId)) continue
          return typeof item.workspaceId === 'string' ? item.workspaceId : ''
        }
        return ''
      }

      /** Archive a conversation, treating a refusal as a tidiness failure only. */
      const archive = async (sessionId) => {
        const workspaces = ctx.get('workspaces')
        if (workspaces === undefined || typeof workspaces.archiveSession !== 'function') return
        try {
          await workspaces.archiveSession(sessionId)
        } catch {
          // The new branch already exists; a failed archive only costs tidiness,
          // so it must not be reported as a failed action.
        }
      }

      /**
       * Rebuild the conversation from one turn and put that turn's request in
       * the new composer, ready to be edited.
       *
       * Truncating is still a fork — DSH has no "truncate session" API — but the
       * boundary belongs to the turn *before* the chosen one, so the chosen turn
       * and everything after it disappear from the new line. The first turn has
       * no such boundary, and forking at nothing would keep the whole
       * conversation; a fresh session in the same workspace is the honest
       * expression of "nothing before this turn is kept".
       *
       * "Same workspace" is a grouping fact, not merely a directory: the new
       * session is created **inside the source conversation's Workspace** when
       * that group can be resolved, so it lands under the same sidebar heading
       * as the conversation it was rebuilt from. Passing only `cwd` publishes it
       * as 未分组 even when that directory is the Workspace's own path, because
       * only `{ workspaceId }` reaches the host's `attachSession`; `cwd` stays
       * as the fallback for a deployment with no Workspace service, and the two
       * are mutually exclusive on the wire.
       *
       * `mode` is the destination the dialog chose, and it decides one thing
       * only — whether the conversation the user is standing in survives:
       *
       * - `new` leaves the original alone, so two lines continue side by side.
       *   The fork gets `increaseTitle` (`… (1)`) because a fork the user cannot
       *   tell apart from its source is a fork they cannot navigate back to.
       * - `current` archives the original after switching, so this window becomes
       *   the rebuilt line: "revert this conversation and ask that turn again".
       *   Its title is inherited unchanged on purpose — it replaces its source
       *   rather than joining it.
       *
       * What this deliberately does *not* do is send. The old behaviour queued
       * the text immediately, which made the model answer before the user had
       * any chance to change their mind; now the request lands in the composer
       * and the composer's own send button is the confirmation.
       * @param request - the turn, the turn before it, the destination, the whole
       *   request, and cwd.
       * @returns `{ ok: true, nextSessionId, notice }` or `{ ok: false, error }`.
       */
      const editSend = async ({ sessionId, turn, previous, mode, text, images, cwd }) => {
        const hasPrevious = previous !== null && previous !== undefined && typeof previous.seq === 'number'
        // 当前对话 rebuilds the line the user is standing in; 新建对话 starts a
        // second one beside it. The only difference is what happens to the
        // original, which is also the whole difference between 回退 and fork.
        const inPlace = mode === 'current'
        let nextSessionId
        try {
          if (hasPrevious) {
            nextSessionId = await sessions.fork({
              sessionId,
              atSeq: previous.seq,
              // Only the side-by-side line needs a distinguishable title. The
              // in-place rebuild replaces its source, so the title it inherits
              // is the one this conversation already had — and `… (1)` there
              // would read as a second line that never existed.
              ...(inPlace ? {} : { increaseTitle: true }),
            })
          } else {
            const workspaceId = workspaceOf(sessionId)
            const placement = workspaceId !== ''
              ? { workspaceId }
              : typeof cwd === 'string' && cwd !== ''
                ? { cwd }
                : {}
            nextSessionId = await sessions.create(placement)
          }
        } catch (error) {
          return { ok: false, error: `重建对话失败：${error instanceof Error ? error.message : String(error)}` }
        }

        // The surviving checkpoints go to the new line so earlier turns stay
        // revertible there; with no earlier turn there is nothing to inherit.
        if (hasPrevious) {
          await post('/chat-git/inherit', { from: sessionId, to: nextSessionId, turn: previous.turn })
        }

        // The images are re-read before the switch, through the **source**
        // session's own authorization: the new line was cut at the turn before
        // the chosen one, so those durable references are not in its log and it
        // could not authorize their bytes itself.
        const imageIds = await registerImages(sessionId, Array.isArray(images) ? images : [])
        // Parked before the switch, so the seeder cannot miss a composer that
        // mounts on the very first render after `open`.
        parkSeed(nextSessionId, { text: typeof text === 'string' ? text : '', imageIds })
        sessions.open(nextSessionId)
        // 当前对话 means this window *becomes* the rebuilt line, so the original
        // is archived — the same move 回退 makes, reached from this action.
        // 新建对话 leaves it alone, which is the whole difference between them.
        if (inPlace) await archive(sessionId)

        const kept = hasPrevious ? previous.turn : 0
        const carried = imageIds.length > 0 ? `（含 ${String(imageIds.length)} 张图片）` : ''
        return {
          ok: true,
          nextSessionId,
          notice: inPlace
            ? `已在本窗口重建到第 ${String(kept)} 轮，第 ${String(turn)} 轮的提示词${carried}已放进输入区，确认后自行发送；原对话已归档。`
            : `已新建会话并保留到第 ${String(kept)} 轮，第 ${String(turn)} 轮的提示词${carried}已放进输入区，确认后自行发送；原对话保持原样。`,
        }
      }

      // The stored preference has to reach the registry before the settings page
      // is ever opened, or a withdrawn tab would reappear on every reload.
      void post('/chat-git/state', { sessionId: '' }).then((result) => {
        if (result.ok) publishHistory(result.value.history !== false)
      })

      /**
       * The History tab, registered only while it is switched on.
       *
       * The strip is projected from the slot itself, so a component cannot hide
       * its own tab — withdrawing one means leaving the registry. The store is
       * the bridge: the settings switch flips the host preference and mirrors it
       * here, and this effect adds or removes the registration to match, so the
       * tab and the switch can never disagree.
       */
      ctx.effect(() => ctx.slots.inject('conversation.view', () => {
        let dispose = null
        const sync = () => {
          if (historyState.enabled && dispose === null) {
            dispose = ctx.slots.register({
              name: 'conversation.view',
              id: 'chat-git-history',
              order: 20,
              label: '历史',
            }, (props) => h(HistoryView, { ...props, branch, editSend }))
          } else if (!historyState.enabled && dispose !== null) {
            dispose()
            dispose = null
          }
        }
        sync()
        const unsubscribe = subscribeHistory(sync)
        return () => {
          unsubscribe()
          if (dispose !== null) dispose()
          dispose = null
        }
      }), 'chat-git: history view')
    }

    exports.apply = apply
    exports.inject = inject
    exports.GIT_DOWNLOAD_URL = GIT_DOWNLOAD_URL
    return module.exports
  },
})
