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
    /** Host endpoint owned by this plugin (see index.js / lib/http.js). */
    const ROUTE_PATH = '/composer-prefill/predict'
    /** Same-origin scripted-call proof the Host requires on POST. */
    const CSRF_HEADER = 'x-dsh-composer-prefill'
    /** How long a "predictions are disabled" answer suppresses further calls. */
    const DISABLED_TTL_MS = 10 * 60 * 1000
    /** Request modes: `cached` only replays a Host cache hit, `generate` may call the model. */
    const MODE_CACHED = 'cached'
    const MODE_GENERATE = 'generate'

    const DICTS = {
      en: {
        accept: 'Insert this suggestion',
        dismiss: 'Dismiss this suggestion',
      },
      zh: {
        accept: '填入这条建议',
        dismiss: '忽略这条建议',
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
      close: {
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
    }

    /**
     * Browser-side caller for the Host prediction endpoint.
     *
     * @returns {{ request: (sessionId: string, signal: AbortSignal) => Promise<string | null> }} caller.
     */
    function createPredictionClient() {
      let disabledUntil = 0
      return {
        async request(sessionId, signal, mode = MODE_GENERATE) {
          if (Date.now() < disabledUntil) {
            return null
          }
          let response
          try {
            response = await fetch(new URL(ROUTE_PATH, window.location.origin), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
              body: JSON.stringify(mode === MODE_CACHED ? { sessionId, mode: MODE_CACHED } : { sessionId }),
              signal,
            })
          } catch (error) {
            return null
          }
          if (signal.aborted) return null
          if (response.status === 403 || response.status === 405) return null
          let result
          try {
            result = await response.json()
          } catch (error) {
            return null
          }
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
          runtime
            .request(sessionId, controller.signal, mode)
          .then((text) => {
              if (abortRef.current !== controller) return
              abortRef.current = null
              if (text !== null) {
                lastSuggestionRef.current = text
                setSuggestion(text)
              }
            })
            .catch(() => {
              if (abortRef.current === controller) abortRef.current = null
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
        if (suggestion === null) return
        const actions = inputActions ?? {}
        abort()
        if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
          const span = actions.captureInsertion()
          if (actions.insertText(suggestion, span) && typeof actions.persistDraft === 'function') actions.persistDraft()
        }
        setSuggestion(null)
      }, [abort, inputActions, suggestion])

      const dismiss = React.useCallback(() => {
        dismissedRef.current = true
        abort()
        setSuggestion(null)
      }, [abort])

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

      return h(
        'div',
        { style: STYLE.root, 'data-composer-prefill': 'm2' },
        h(
          'div',
          { style: STYLE.body },
          h('span', { style: STYLE.lead, 'aria-hidden': true }, '↵'),
          h(
            'button',
            {
              type: 'button',
              title: suggestion,
              'aria-label': acceptLabel,
              style: STYLE.text,
              onMouseDown: (event) => event.preventDefault(),
              onClick: accept,
            },
            suggestion,
          ),
          h('kbd', { style: STYLE.keycap, 'aria-hidden': true }, 'Tab'),
          h(
            'button',
            {
              type: 'button',
              title: dismissLabel,
              'aria-label': dismissLabel,
              style: STYLE.close,
              onMouseDown: (event) => event.preventDefault(),
              onClick: dismiss,
            },
            '✕',
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const runtime = createPredictionClient()

        /** Stable wrapper so the slot never remounts on re-registration. */
        const Row = (props) => h(PredictionRow, { ...props, runtime })

        ctx.effect(() => ctx.locale.register(NS, DICTS), 'composer-prefill: dictionaries')
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: ORDER, locale: NS }, Row),
        )
      },
    }
  },
})
