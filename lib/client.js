/**
 * dsh-chat-git — browser half.
 *
 * Two seats, both fed by this package's host `/chat-git` routes:
 *
 * 1. `conversation.chat.assistant-actions` — the per-turn **回退** button. The
 *    shell renders this list as the `extraActions` slot of the turn's
 *    `MessageIconActions`, i.e. immediately after the copy button, so the
 *    control lands literally beside the icons it belongs with. The seat is a
 *    plain additive list: it competes with no other plugin for a cell, which is
 *    what removed the earlier need to outrank a sibling `turnTail` entry.
 * 2. `settings.section` — the settings page: the on/off switch, the `git
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
        return { ok: false, error: envelope.error ?? TRANSPORT }
      } catch {
        return { ok: false, error: TRANSPORT }
      }
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    /** Stylesheet id, so a second install (or a reload) never doubles it up. */
    const STYLE_ID = 'dsh-chat-git-style'

    /**
     * The plugin's own stylesheet. Only this plugin's namespaced classes are
     * styled — no product selector is touched — and theme tokens are used with
     * fallbacks so the control matches whichever theme is active.
     */
    const CSS = [
      '.dsh-chat-git-icon{display:inline-flex;align-items:center;justify-content:center;',
      'width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,#9a9a9a);cursor:pointer;',
      'transition:color .12s ease,background .12s ease}',
      '.dsh-chat-git-icon:hover{color:var(--dsw-alias-label-primary,#f3f3f3);',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18))}',
      '.dsh-chat-git-icon:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#7c91ff);outline-offset:1px}',
      '.dsh-chat-git-icon[data-armed="true"]{color:var(--dsw-alias-state-error-primary,#ff6b6b)}',
      '.dsh-chat-git-icon[disabled]{opacity:.5;cursor:progress}',
      '.dsh-chat-git-note{font-size:11px;line-height:18px;margin-left:4px;',
      'color:var(--dsw-alias-state-error-primary,#ff6b6b)}',
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

    /** Theme-aligned colors for the settings page and the inline notes. */
    const COLOR = {
      text: 'var(--dsw-alias-label-primary, #f3f3f3)',
      muted: 'var(--dsw-alias-label-secondary, #9a9a9a)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.45))',
      surface: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
      accent: 'var(--dsw-alias-brand-primary, #7c91ff)',
      danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      success: 'var(--dsw-alias-state-success-primary, #4ade80)',
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
      choiceActive: { color: '#fff', background: COLOR.accent, borderColor: COLOR.accent },
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

    /** A native select, so the pickers behave and are reachable like any form control. */
    function Picker(props) {
      return h('select', {
        style: styles.select,
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
      }, h('span', { style: { ...styles.knob, left: on ? '21px' : '3px' } }))
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
      }

      const enabled = state?.enabled === true
      const summary = state?.summary ?? null
      const summaryMode = summary?.mode ?? 'current'

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
          h('h2', { style: styles.title }, '对话 Git'),
          h('p', { style: styles.lead },
            '把每个对话变成一条 git 检查点链：对话开始时自动 git init，每轮结束时以 Ai-coding：描述 的格式提交，随时可把代码和对话一起回退。'),
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
              onChange: (next) => { void setFlag('/chat-git/set-enabled', 'enabled', next) },
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
        label: '对话 Git',
      }, SettingsSection)), 'chat-git: settings page')
    }

    exports.apply = apply
    exports.inject = inject
    exports.GIT_DOWNLOAD_URL = GIT_DOWNLOAD_URL
    return module.exports
  },
})
