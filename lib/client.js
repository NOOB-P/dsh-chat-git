/**
 * dsh-chat-git — browser half.
 *
 * Three seats, all fed by this package's host `/chat-git` routes:
 *
 * 1. `conversation.chat.turnTail` — the per-conversation **撤回** button. The
 *    chain has no default entry, and the tail renders as a sibling *before* the
 *    standard turn action row, so claiming a turn adds a control without
 *    replacing anything the shell or other plugins put there. Its selector is
 *    synchronous and receives turn-scoped props only, so it decides from a
 *    warmed index and declines every turn it has no checkpoint for.
 * 2. `conversation.chat.assistant-actions` — an invisible tracker that keeps
 *    that index warm. This seat is a plain additive list, so it costs no
 *    contention and renders no pixels.
 * 3. `settings.section` — the settings page: the on/off switch, the `git
 *    --version` detection button, and the download jump to the official page.
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

    // ---------------------------------------------------------------------
    // Host transport
    // ---------------------------------------------------------------------

    /** Transport-level failure, shaped like the host's own error envelope. */
    const TRANSPORT = { code: 'transport', message: 'chat-git routes are unavailable' }

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
        return { ok: false, error: envelope.error ?? TRANSPORT }
      } catch {
        return { ok: false, error: TRANSPORT }
      }
    }

    // ---------------------------------------------------------------------
    // Theme-aligned inline styles
    // ---------------------------------------------------------------------

    /** Fallbacks keep the plugin legible on a shell that lacks a token. */
    const COLOR = {
      text: 'var(--dsw-alias-label-primary, #f3f3f3)',
      muted: 'var(--dsw-alias-label-secondary, #9a9a9a)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.45))',
      surface: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
      accent: 'var(--dsw-alias-brand-primary, #7c91ff)',
      danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      success: 'var(--dsw-alias-state-success-primary, #4ade80)',
      warn: 'var(--dsw-alias-state-warn-primary, #fbbf24)',
    }

    const styles = {
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      // The tail seat is a low-key inline affordance inside the turn's tail row.
      turnButton: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '2px 8px',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        color: COLOR.muted,
        background: 'transparent',
        border: `1px solid ${COLOR.border}`,
        borderRadius: '999px',
        cursor: 'pointer',
      },
      turnButtonArmed: {
        color: COLOR.danger,
        borderColor: COLOR.danger,
      },
      turnButtonBusy: { opacity: 0.6, cursor: 'progress' },
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
      knob: {
        position: 'absolute',
        top: '2px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 120ms ease',
      },
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
      buttonPrimary: { color: '#fff', background: COLOR.accent, borderColor: COLOR.accent },
      buttonBusy: { opacity: 0.6, cursor: 'progress' },
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

    // ---------------------------------------------------------------------
    // Per-conversation revert button (conversation.chat.turnTail)
    // ---------------------------------------------------------------------

    /**
     * Chain priority. `dsh-better-sidebar` claims the same chain at -1 and its
     * selector declines any turn that produced no files, so this entry only has
     * to be tried earlier to own the turns that carry a checkpoint; it still
     * declines every other turn, leaving that plugin's row untouched.
     */
    const TURN_TAIL_PRIORITY = -5

    /** Registration id of this plugin's own turnTail entry. */
    const TURN_TAIL_ID = 'chat-git-revert'

    /** Registration id of the invisible per-session tracker seat. */
    const TRACKER_ID = 'chat-git-session-tracker'

    /**
     * The session whose turn tails are currently rendering.
     *
     * The chain selector is synchronous and receives turn-scoped props only —
     * never a session id — so the active session is captured by the tracker
     * seat and read back here. A stale value can only cause a *decline*, which
     * is the safe direction: every sibling entry keeps the turn it would have
     * had before this plugin was installed.
     */
    let activeSessionId = ''

    /**
     * Synchronous `sessionId -> { loaded, byTurn, commits }` index.
     *
     * The selector must decide without awaiting anything, so the host's answer
     * is folded into this map and consulted directly. `loaded` is what
     * distinguishes "this turn has no checkpoint" from "not asked yet".
     */
    const checkpointIndex = new Map()

    /** In-flight warm-ups, so concurrent renders share one request. */
    const warming = new Map()

    /**
     * Refresh the checkpoint index for one session.
     * @param sessionId - the session to read; the empty string is a no-op.
     * @returns a promise for the refreshed entry, or null for an empty id.
     */
    function warm(sessionId) {
      const key = sessionId ?? ''
      if (key === '') return null
      const running = warming.get(key)
      if (running !== undefined) return running
      const settled = post('/chat-git/state', { sessionId: key })
        .then((result) => {
          const entry = { loaded: true, enabled: false, commits: [], byTurn: new Map() }
          if (result.ok) {
            entry.enabled = result.value?.enabled === true
            entry.commits = Array.isArray(result.value?.commits) ? result.value.commits : []
            for (const commit of entry.commits) entry.byTurn.set(commit.turn, commit)
          }
          checkpointIndex.set(key, entry)
          return entry
        })
        .catch(() => null)
        .then((value) => {
          warming.delete(key)
          return value
        })
      warming.set(key, settled)
      return settled
    }

    /** Forget one session's index so the next evaluation re-reads the host. */
    function invalidate(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') checkpointIndex.clear()
      else checkpointIndex.delete(sessionId)
    }

    /**
     * Invisible seat that keeps the synchronous index warm.
     *
     * Registered on the additive `conversation.chat.assistant-actions` list, so
     * it never competes for a shared cell: it renders nothing at all and exists
     * only to learn the active session id and fold that session's checkpoints
     * into {@link checkpointIndex}, which the chain selector then reads.
     */
    function SessionTracker(props) {
      const sessionId = props.sessionId
      // Recorded during render, so the next chain evaluation in this session
      // already sees the right key.
      if (typeof sessionId === 'string' && sessionId !== '') activeSessionId = sessionId
      React.useEffect(() => {
        if (typeof sessionId === 'string' && sessionId !== '') void warm(sessionId)
      }, [sessionId])
      return null
    }

    /**
     * The revert control for one completed turn.
     *
     * Renders nothing unless a checkpoint exists for this exact turn, so a
     * conversation that was never checkpointed looks untouched. The first click
     * arms the button and the second performs the rollback; a native `confirm`
     * is avoided because it blocks the shell's own event loop.
     */
    function RevertAction(props) {
      const sessionId = props.sessionId
      // The selector only ever claims a turn it already holds a checkpoint for,
      // so the commit arrives as part of the matched value and this render path
      // awaits nothing.
      const turn = props.matched?.turn
      const seq = props.matched?.seq
      const commit = props.matched?.commit ?? null

      const [armed, setArmed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')

      // Disarm whenever the seat loses its identity (session switch, re-render
      // onto another turn) so a stale armed state can never fire elsewhere.
      React.useEffect(() => { setArmed(false); setFailure('') }, [sessionId, turn])

      if (commit === null || typeof turn !== 'number') return null

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
          setFailure(restored.error?.message ?? 'revert failed')
          return
        }
        // The conversation rollback reuses the shell's own fork primitive: a
        // session truncated at this turn's closing sequence becomes the live
        // timeline, which is how "后面的对话全部删除" is expressed without
        // destroying the log the user already has.
        let nextSessionId = null
        try {
          if (typeof seq === 'number' && typeof props.forkAt === 'function') {
            nextSessionId = await props.forkAt(sessionId, seq)
          }
        } catch {
          nextSessionId = null
        }
        if (typeof nextSessionId === 'string' && nextSessionId !== '') {
          // A fork is a different session with no history of its own: hand it
          // the surviving checkpoints so earlier turns stay revertible there.
          await post('/chat-git/inherit', { from: sessionId, to: nextSessionId, turn })
          invalidate(nextSessionId)
          await warm(nextSessionId)
        } else {
          invalidate(sessionId)
          await warm(sessionId)
        }
        setBusy(false)
        setArmed(false)
      }

      const style = { ...styles.turnButton }
      if (armed) Object.assign(style, styles.turnButtonArmed)
      if (busy) Object.assign(style, styles.turnButtonBusy)

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
        h('button', {
          type: 'button',
          style,
          disabled: busy,
          title: `撤回到此轮：git checkout ${commit.short} -- .（${commit.subject}）`,
          onClick: revert,
          'aria-label': armed ? '确认撤回到此轮' : '撤回到此轮',
        }, busy ? '撤回中…' : armed ? '确认撤回?' : '撤回'),
        failure !== '' ? h('span', { style: styles.note('error') }, failure) : null,
      )
    }

    // ---------------------------------------------------------------------
    // Settings page (settings.section)
    // ---------------------------------------------------------------------

    /** The official download page the detection failure points at. */
    const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads'

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
      }, h('span', {
        style: { ...styles.knob, left: on ? '21px' : '3px' },
      }))
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

      const refresh = React.useCallback(async () => {
        const result = await post('/chat-git/state', { sessionId: '' })
        if (result.ok) {
          setState(result.value)
          setProbe(result.value.git ?? null)
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

      const toggle = async (next) => {
        setBusy(true)
        setError('')
        const result = await post('/chat-git/set-enabled', { enabled: next })
        setBusy(false)
        if (!result.ok) {
          // The host refuses to enable without a working git; surface why and
          // leave the switch where it was.
          setError(result.error?.message ?? 'could not change the setting')
          await refresh()
          return
        }
        setState((current) => ({ ...(current ?? {}), enabled: result.value.enabled }))
      }

      const enabled = state?.enabled === true
      const available = probe?.available === true

      return h('div', { style: styles.section },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('h2', { style: styles.title }, '对话 Git'),
          h('p', { style: styles.lead },
            '把每个对话变成一条 git 检查点链：对话开始时自动 git init，每轮结束时以 Ai-coding：描述 的格式提交，随时可把代码和对话一起撤回。'),
        ),

        h('div', { style: styles.card },
          h('div', { style: styles.field },
            h('div', { style: styles.fieldText },
              h('span', { style: styles.fieldLabel }, '自动检查点'),
              h('span', { style: styles.fieldHint },
                '开启后，对话开始时会检查工作区是否已有 git 仓库，没有则执行 git init；每轮结束时执行 git add -A 与 git commit，提交信息为 Ai-coding：描述。'),
            ),
            h(Toggle, {
              on: enabled,
              disabled: busy || state === null,
              label: '自动检查点',
              onChange: (next) => { void toggle(next) },
            }),
          ),
        ),

        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, 'Git 环境'),
          h('p', { style: styles.cardLead },
            '检查点依赖本机的 git 命令行。检测会执行 git --version；未安装时无法开启自动检查点。'),

          h('div', { style: styles.row },
            h('button', {
              type: 'button',
              style: { ...styles.button, ...(probing ? styles.buttonBusy : {}) },
              disabled: probing,
              onClick: () => { void detect() },
            }, probing ? '检测中…' : '检测 Git'),
            h('a', {
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
    // Plugin
    // ---------------------------------------------------------------------

    /** The slot registry plus the session service whose fork/open drive the rollback. */
    const inject = ['slots', 'sessions']

    /**
     * Client plugin body: the per-turn revert seat and the settings page.
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

      ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: TURN_TAIL_ID,
        priority: TURN_TAIL_PRIORITY,
        // Pure routing, and the only decision this plugin makes about a shared
        // cell: claim the turn when the warmed index already holds a checkpoint
        // for it. A cold index or an unrelated session declines, which hands
        // the turn straight back to the sibling entry untouched.
        select: (owner) => {
          const turn = owner?.turn?.turn
          if (typeof turn !== 'number') return null
          const entry = checkpointIndex.get(activeSessionId)
          if (entry === undefined || entry.loaded !== true) return null
          const commit = entry.byTurn.get(turn)
          if (commit === undefined) return null
          return { turn, seq: owner?.seq, commit }
        },
      }, (props) => h(RevertAction, { ...props, forkAt }))), 'chat-git: revert button')

      // The tracker rides an additive list, so it competes with nothing and
      // shows nothing; it only warms the index the selector above reads.
      ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: TRACKER_ID,
        order: 100,
      }, SessionTracker)), 'chat-git: session tracker')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'chat-git',
        order: 140,
        label: '对话 Git',
      }, SettingsSection)), 'chat-git: settings page')
    }

    exports.apply = apply
    exports.inject = inject
    exports.GIT_DOWNLOAD_URL = GIT_DOWNLOAD_URL
    return module.exports
  },
})
