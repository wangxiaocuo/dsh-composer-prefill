window.__ModuleLoader__.load({
  id: '@wangxiaocuo/dsh-composer-prefill',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'composerPrefill'
    /** Host slot: the full-width row directly above the composer card. */
    const SLOT = 'conversation.input.dock'
    /** Our own cell key; never reuse a shipped id. */
    const ENTRY_ID = 'composer-prefill'
    /** Position between the goal dock (10) and the queue dock (20). */
    const ORDER = 15
    /** Settings → General row that mirrors the master switch. */
    const SETTINGS_SLOT = 'settings.general.item'
    const SETTINGS_ID = 'composer-prefill'
    const SETTINGS_ORDER = 30
    /** Host endpoints owned by this plugin (see lib/http.js). */
    const PREDICT_PATH = '/composer-prefill/predict'
    const PREFS_PATH = '/composer-prefill/prefs'
    /** Same-origin scripted-call proof the Host requires on POST. */
    const CSRF_HEADER = 'x-dsh-composer-prefill'
    /** How long a "predictions are disabled" answer suppresses further calls. */
    const DISABLED_TTL_MS = 10 * 60 * 1000
    /** Request modes: `cached` replays only, `refresh` forces a reroll. */
    const MODE_CACHED = 'cached'
    const MODE_REFRESH = 'refresh'
    const MODE_GENERATE = 'generate'

    const DICTS = {
      en: {
        accept: 'Insert this suggestion',
        dismiss: 'Dismiss this suggestion',
        another: 'Another suggestion',
        thinking: 'Asking for another…',
        settingsTitle: 'Composer predictions',
        settingsDescription: 'Suggest the next message above the composer after a reply. Each suggestion costs one extra model call.',
        settingsUnavailable: 'Available once the Host plugin is running.',
      },
      zh: {
        accept: '填入这条建议',
        dismiss: '忽略这条建议',
        another: '换一条',
        thinking: '换一条中…',
        settingsTitle: '输入预测',
        settingsDescription: '助手回复后在输入框上方建议下一条消息。每条建议会多一次模型调用。',
        settingsUnavailable: '宿主插件运行后可用。',
      },
    }

    // Width/positioning copies the shipped dock rows (todo/goal/queue) so this
    // row lines up with the composer card instead of guessing an inset.
    // No author border: the card edge is the panel shadow's own 0.5px hairline
    // (`--dsw-elevation-stroke`), the way every other floated surface here draws
    // its boundary. A hand-written 1px border on top of it reads as a second
    // input box.
    const STYLE = {
      root: {
        boxSizing: 'border-box',
        flex: 'none',
        width:
          'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
        maxWidth:
          'calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
        margin: '0 auto',
        overflow: 'hidden',
        border: 0,
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-specific-menu)',
        boxShadow: 'var(--dsw-elevation-panel)',
      },
      body: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '6px 12px',
      },
      lead: {
        flex: 'none',
        display: 'grid',
        placeItems: 'center',
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      text: {
        flex: 'auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'left',
        padding: 0,
        border: 'none',
        background: 'none',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      keycap: {
        flex: 'none',
        padding: '0 5px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm, 4px)',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      iconButton: {
        flex: 'none',
        padding: '2px 4px',
        border: 'none',
        borderRadius: '4px',
        background: 'none',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      busyIconButton: {
        flex: 'none',
        padding: '2px 4px',
        border: 'none',
        borderRadius: '4px',
        background: 'none',
        cursor: 'default',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)',
        opacity: 0.4,
      },
      // Mirrors the shipped settings rows (border-bottom hairline, 14/22 title,
      // 12/18 description) and the shipped switch (20x10 track, 6px thumb).
      settingsRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '16px 0',
        borderBottom: '.5px solid var(--dsw-alias-border-l2)',
      },
      settingsText: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1',
        gap: '4px',
        minWidth: 0,
        paddingRight: '48px',
      },
      settingsTitle: {
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '14px',
        fontWeight: 400,
        lineHeight: '22px',
      },
      settingsDesc: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        fontWeight: 400,
        lineHeight: '18px',
      },
      switchTrack: {
        boxSizing: 'border-box',
        flex: 'none',
        position: 'relative',
        width: '20px',
        height: '10px',
        padding: 0,
        border: 0,
        borderRadius: '5px',
        cursor: 'pointer',
        transition: 'background-color .12s var(--ds-ease-in-out)',
      },
      switchThumb: {
        position: 'absolute',
        top: '2px',
        left: '2px',
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-bg-layer-1)',
        transition: 'transform .12s var(--ds-ease-in-out)',
      },
    }

    /**
     * Browser-side caller for the Host endpoints.
     *
     * @returns {{
     *   request: (sessionId: string, signal: AbortSignal, mode?: string) => Promise<string | null>,
     *   prefs: (signal: AbortSignal) => Promise<{ enabled: boolean, entryId: string | null } | null>,
     *   clearDisabled: () => void,
     * }} caller.
     */
    function createPredictionClient() {
      let disabledUntil = 0

      /**
       * @param {string} path endpoint.
       * @param {Record<string, unknown>} payload body.
       * @param {AbortSignal} signal cancellation.
       * @returns {Promise<any>} decoded result, or undefined on any failure.
       */
      async function post(path, payload, signal) {
        let response
        try {
          response = await fetch(new URL(path, window.location.origin), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
            body: JSON.stringify(payload),
            signal,
          })
        } catch {
          return undefined
        }
        if (signal.aborted) return undefined
        if (response.status === 403 || response.status === 405) return undefined
        try {
          return await response.json()
        } catch {
          return undefined
        }
      }

      return {
        clearDisabled() {
          disabledUntil = 0
        },
        async request(sessionId, signal, mode = MODE_GENERATE) {
          if (Date.now() < disabledUntil) return null
          const body = mode === MODE_GENERATE ? { sessionId } : { sessionId, mode }
          const result = await post(PREDICT_PATH, body, signal)
          if (result === null || typeof result !== 'object' || result.ok !== true) return null
          const value = result.value
          if (value === null || typeof value !== 'object') return null
          if (value.enabled === false) {
            disabledUntil = Date.now() + DISABLED_TTL_MS
            return null
          }
          const text = typeof value.text === 'string' ? value.text.trim() : ''
          return text === '' ? null : text
        },
        async prefs(signal) {
          const result = await post(PREFS_PATH, {}, signal)
          if (result === null || typeof result !== 'object' || result.ok !== true) return null
          const value = result.value
          if (value === null || typeof value !== 'object') return null
          return {
            enabled: value.enabled === true,
            entryId: typeof value.entryId === 'string' && value.entryId !== '' ? value.entryId : null,
          }
        },
      }
    }

    /**
     * One suggestion row above the composer.
     *
     * Standard props every session-scope slot entry receives: `sessionId`,
     * `inputActions`, `useInput`, `useSessionStatus` and (with `locale`) `t`.
     *
     * @param {object} props slot entry kit plus the plugin-owned `runtime`.
     * @returns {import('react').ReactElement | null} the row, or null while no
     * suggestion should be visible.
     */
    function PredictionRow({ sessionId, inputActions, useInput, useSessionStatus, runtime, t }) {
      const draft = useInput((state) => state?.draft ?? '')
      const attachmentCount = useInput((state) => state?.attachmentIds?.length ?? 0)
      const phase = useInput((state) => state?.phase ?? 'plain')
      const running = useSessionStatus((state) => state?.get(sessionId)?.running === true)
      const emptyDraft = draft === ''
      // `phase` guards the submit window: the draft empties before the turn
      // starts, and a stale suggestion must not flash back in that gap.
      const idleEmpty = !running && emptyDraft && attachmentCount === 0 && phase === 'plain'

      const [suggestion, setSuggestion] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [rerolling, setRerolling] = React.useState(false)
      const abortRef = React.useRef(null)
      const previousRunning = React.useRef(running)
      const previousIdleEmpty = React.useRef(false)
      const dismissedRef = React.useRef(false)
      /** Last text this session produced, so an emptied composer restores it free. */
      const lastSuggestionRef = React.useRef(null)

      const abort = React.useCallback(() => {
        if (abortRef.current !== null) {
          abortRef.current.abort()
          abortRef.current = null
        }
      }, [])

      // A suggestion belongs to one turn and one session: invalidate on either.
      React.useEffect(() => {
        setSuggestion(null)
        lastSuggestionRef.current = null
        dismissedRef.current = false
      }, [sessionId])

      React.useEffect(() => {
        if (!running) return
        setSuggestion(null)
        setRerolling(false)
        lastSuggestionRef.current = null
      }, [running])

      // Abort as soon as the suggestion is no longer wanted.
      React.useEffect(() => {
        if (idleEmpty) return
        abort()
        setSuggestion(null)
      }, [idleEmpty, abort])

      // Unmount cleanup.
      React.useEffect(() => () => abort(), [abort])

      const request = React.useCallback(
        (mode = MODE_GENERATE) => {
          abort()
          const controller = new AbortController()
          abortRef.current = controller
          setBusy(true)
          runtime
            .request(sessionId, controller.signal, mode)
            .then((text) => {
              if (abortRef.current !== controller) return
              abortRef.current = null
              setBusy(false)
              setRerolling(false)
              if (text !== null) {
                lastSuggestionRef.current = text
                setSuggestion(text)
              }
            })
            .catch(() => {
              if (abortRef.current === controller) {
                abortRef.current = null
                setBusy(false)
                setRerolling(false)
              }
            })
        },
        [abort, runtime, sessionId],
      )

      // One trigger for every moment a suggestion may show:
      //   - a turn just ended -> generate (a Host cache hit keeps it free)
      //   - the draft became empty again, or the row mounted on an idle session
      //     -> restore the text we already hold, else replay the Host cache only
      // An explicit Esc/✕ suppresses re-showing until the next turn starts.
      React.useEffect(() => {
        const wasRunning = previousRunning.current
        const wasIdleEmpty = previousIdleEmpty.current
        previousRunning.current = running
        previousIdleEmpty.current = idleEmpty
        if (running) {
          dismissedRef.current = false
          return
        }
        if (!idleEmpty || dismissedRef.current) return
        if (wasRunning) {
          request(MODE_GENERATE)
          return
        }
        if (!wasIdleEmpty) {
          if (lastSuggestionRef.current !== null) setSuggestion(lastSuggestionRef.current)
          else request(MODE_CACHED)
        }
      }, [running, idleEmpty, request])

      const visible = suggestion !== null && idleEmpty

      const accept = React.useCallback(() => {
        if (suggestion === null || rerolling) return
        const actions = inputActions ?? {}
        abort()
        if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
          const span = actions.captureInsertion()
          if (actions.insertText(suggestion, span) && typeof actions.persistDraft === 'function') actions.persistDraft()
        }
        setSuggestion(null)
      }, [abort, inputActions, rerolling, suggestion])

      const dismiss = React.useCallback(() => {
        dismissedRef.current = true
        abort()
        setSuggestion(null)
      }, [abort])

      const reroll = React.useCallback(() => {
        if (busy) return
        dismissedRef.current = false
        setRerolling(true)
        request(MODE_REFRESH)
      }, [busy, request])

      React.useEffect(() => {
        if (!visible) return undefined
        /** Bubble-phase guard: only claim Tab when this row actually accepts it. */
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return
          if (event.key === 'Escape') {
            event.preventDefault()
            dismiss()
            return
          }
          if (event.key !== 'Tab') return
          if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
          const path = typeof event.composedPath === 'function' ? event.composedPath() : []
          const insideComposer = path.some(
            (node) => node instanceof Element && typeof node.closest === 'function' && node.closest('[data-composer-card]') !== null,
          )
          if (!insideComposer) return
          event.preventDefault()
          accept()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [visible, accept, dismiss])

      if (!visible) return null

      const acceptLabel = typeof t === 'function' ? t('accept') : suggestion
      const dismissLabel = typeof t === 'function' ? t('dismiss') : 'dismiss'
      const anotherLabel = typeof t === 'function' ? t('another') : 'another'
      const thinkingLabel = typeof t === 'function' ? t('thinking') : '…'
      const displayText = rerolling ? thinkingLabel : suggestion
      const textStyle = rerolling ? { ...STYLE.text, color: 'var(--dsw-alias-label-tertiary)', cursor: 'default' } : STYLE.text

      return h(
        'div',
        { style: STYLE.root, 'data-composer-prefill': 'ready' },
        h(
          'div',
          { style: STYLE.body },
          h('span', { style: STYLE.lead, 'aria-hidden': true }, '↵'),
          h(
            'button',
            {
              type: 'button',
              title: displayText,
              'aria-label': acceptLabel,
              disabled: rerolling,
              style: textStyle,
              onMouseDown: (event) => event.preventDefault(),
              onClick: accept,
            },
            displayText,
          ),
          h('kbd', { style: STYLE.keycap, 'aria-hidden': true }, 'Tab'),
          h(
            'button',
            {
              type: 'button',
              title: anotherLabel,
              'aria-label': anotherLabel,
              'data-composer-prefill-reroll': busy ? 'busy' : 'idle',
              disabled: busy,
              style: busy ? STYLE.busyIconButton : STYLE.iconButton,
              onMouseDown: (event) => event.preventDefault(),
              onClick: reroll,
            },
            '↻',
          ),
          h(
            'button',
            {
              type: 'button',
              title: dismissLabel,
              'aria-label': dismissLabel,
              style: STYLE.iconButton,
              onMouseDown: (event) => event.preventDefault(),
              onClick: dismiss,
            },
            '✕',
          ),
        ),
      )
    }

    /**
     * Settings → General row mirroring `showPredictions`.
     *
     * Reads the effective value (and the Loader entry id) from the Host, then
     * writes through the shared configuration form so the change persists in
     * the profile the same way the Plugin Manager's own form does.
     *
     * @param {{ t: Function, runtime: object, configForms: object | undefined }} props row kit.
     * @returns {import('react').ReactElement} the row.
     */
    function GeneralRow({ t, runtime, configForms }) {
      const [status, setStatus] = React.useState('loading')
      const [enabled, setEnabled] = React.useState(false)
      const [entryId, setEntryId] = React.useState(null)
      const [pending, setPending] = React.useState(false)

      React.useEffect(() => {
        const controller = new AbortController()
        let cancelled = false
        runtime.prefs(controller.signal).then((value) => {
          if (cancelled) return
          if (value === null) {
            setStatus('unavailable')
            return
          }
          setEnabled(value.enabled)
          setEntryId(value.entryId)
          setStatus(value.entryId === null ? 'unavailable' : 'ready')
        })
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [runtime])

      React.useEffect(() => {
        if (status !== 'ready' || entryId === null || configForms === undefined) return undefined
        const form = configForms.get(entryId)
        const read = () => {
          const value = form.getSnapshot()?.value
          if (value === undefined) return
          setEnabled(value.showPredictions === true)
        }
        read()
        return form.subscribe(read)
      }, [status, entryId, configForms])

      const toggle = () => {
        if (pending) return
        if (status !== 'ready' || entryId === null || configForms === undefined) return
        const next = !enabled
        setEnabled(next)
        setPending(true)
        runtime.clearDisabled()
        Promise.resolve(configForms.get(entryId).set('showPredictions', next)).finally(() => setPending(false))
      }

      const usable = status === 'ready' && configForms !== undefined
      const description = usable ? t('settingsDescription') : t('settingsUnavailable')

      return h(
        'div',
        { style: STYLE.settingsRow },
        h(
          'div',
          { style: STYLE.settingsText },
          h('div', { style: STYLE.settingsTitle }, t('settingsTitle')),
          h('div', { style: STYLE.settingsDesc }, description),
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': t('settingsTitle'),
            disabled: !usable || pending,
            style: {
              ...STYLE.switchTrack,
              background: enabled ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)',
              opacity: usable ? 1 : 0.5,
            },
            onClick: toggle,
          },
          h('span', { style: { ...STYLE.switchThumb, transform: enabled ? 'translateX(10px)' : 'none' } }),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const runtime = createPredictionClient()
        const configForms = ctx.get('configForms')

        ctx.effect(() => ctx.locale.register(NS, DICTS), 'composer-prefill: dictionaries')

        /** Stable wrappers so the slots never remount on re-registration. */
        const Row = (props) => h(PredictionRow, { ...props, runtime })
        const SettingsRow = (props) => h(GeneralRow, { ...props, runtime, configForms })

        ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: ORDER, locale: NS }, Row))
        ctx.slots.inject(SETTINGS_SLOT, () =>
          ctx.slots.register({ name: SETTINGS_SLOT, id: SETTINGS_ID, order: SETTINGS_ORDER, locale: NS }, SettingsRow),
        )
      },
    }
  },
})
