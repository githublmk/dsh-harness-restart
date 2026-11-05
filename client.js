/**
 * Client half of the harness-restart bundle.
 *
 * Renders one small control in the Desktop caption band, immediately after the
 * global panel nav's overflow ("更多") launcher, and asks the Host to restart
 * the application. Nothing is rendered in a plain browser page or when the
 * caption band is not there: restarting means stopping the process that serves
 * this page.
 *
 * The control asks the Host for its version before offering the action, so an
 * outdated Host half (one loaded before this file changed) is never used: that
 * combination would stop the shell without a working relaunch path.
 *
 * @module dsh-harness-restart
 */
window.__ModuleLoader__.load({
  id: 'dsh-harness-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Version the Host half must report before the action is offered. */
    const VERSION = '0.3.0'
    /** Same-origin route the Host half answers (forwarded by the Desktop shell). */
    const ROUTE = '/dsh-harness-restart/restart'
    /** Height of the control, matching one caption panel row. */
    const CONTROL_HEIGHT = 28
    /** Right-hand band reserved for the native window controls. */
    const WINDOW_CONTROLS_RESERVE = 168
    /** Locale namespace the strings are registered under. */
    const NS = 'harness-restart'

    /** Visible text, per app language; the Client locale service selects one. */
    const TEXT = {
      'zh-CN': {
        label: '重启',
        tooltip: '重启应用与 Host',
        title: '重启应用与 Host？',
        body: '正在进行的任务会被中断，界面会在几秒后自动恢复。',
        cancel: '取消',
        confirm: '重启',
        busy: '正在重启…',
        failed: '重启请求没有被接受，请稍后再试。',
        outdated: '当前 Host 还是旧版本，先重开一次应用再试。',
      },
      en: {
        label: 'Restart',
        tooltip: 'Restart the app and Host',
        title: 'Restart the app and Host?',
        body: 'Running tasks are interrupted; the window comes back in a few seconds.',
        cancel: 'Cancel',
        confirm: 'Restart',
        busy: 'Restarting…',
        failed: 'The restart request was not accepted. Try again.',
        outdated: 'The running Host is an older version. Restart the app once first.',
      },
    }

    /**
     * Every language hint this page exposes, most specific first: the Client
     * locale service, then markers the shell puts on the document, then the
     * browser's own language. The service is not assumed to answer.
     */
    function languageHints(ctx) {
      const hints = []
      try {
        const snapshot = ctx.locale?.getLocale?.() ?? ctx.locale?.getSnapshot?.()
        if (snapshot !== undefined && snapshot !== null) {
          for (const value of [snapshot.active, snapshot.id, snapshot.locale]) {
            if (typeof value === 'string' && value !== '') hints.push(value)
          }
        }
      } catch {
        /* the service is optional for this label */
      }
      try {
        const root = typeof document === 'undefined' ? undefined : document.documentElement
        for (const value of [
          root?.getAttribute?.('lang'),
          root?.getAttribute?.('data-locale'),
          root?.getAttribute?.('data-language'),
        ]) {
          if (typeof value === 'string' && value !== '') hints.push(value)
        }
      } catch {
        /* no document */
      }
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') hints.push(navigator.language)
      } catch {
        /* no navigator */
      }
      return hints.filter((value) => typeof value === 'string' && value !== '')
    }

    /**
     * Active app language. Any Chinese hint wins, because the interfaces this
     * control sits in are Chinese whenever the app is; otherwise an English
     * hint is used, and Chinese is the last resort.
     */
    function language(ctx) {
      const hints = languageHints(ctx).map((value) => value.toLowerCase())
      if (hints.some((value) => value.startsWith('zh'))) return 'zh-CN'
      if (hints.some((value) => value.startsWith('en'))) return 'en'
      return 'zh-CN'
    }

    /** Register the strings with the Client locale service; never fatal. */
    function registerStrings(ctx) {
      for (const id of Object.keys(TEXT)) {
        try {
          const dispose = ctx.locale?.register?.(NS, id, TEXT[id])
          if (typeof dispose === 'function') ctx.effect?.(() => dispose)
        } catch {
          /* A locale service that refuses this form falls back to the local table. */
        }
      }
    }

    /** Text for the current language, re-read whenever the locale changes. */
    function useText(ctx) {
      const [current, setCurrent] = useState(() => language(ctx))
      useEffect(() => {
        let dispose
        try {
          dispose = ctx.locale?.subscribe?.(() => setCurrent(language(ctx)))
        } catch {
          dispose = undefined
        }
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, [ctx])
      /* The table is keyed by the language this page resolved, so the label
       * cannot drift to the other language through a locale service that
       * answers with a different active id than the rest of the app uses. */
      const table = TEXT[current] ?? TEXT['zh-CN']
      return (key) => table[key] ?? key
    }

    /** The element whose right edge the control follows. */
    function captionAnchor() {
      const nav = document.querySelector('nav:has(> [class*="panelRow"])')
      if (nav !== null) {
        const band = nav.getBoundingClientRect()
        /* Only the Desktop caption band qualifies; the same nav sits vertically
         * in the sidebar of a plain Web page. */
        if (band.width > 0 && band.height > 0 && band.top < 60) {
          const launcher = nav.querySelector('[aria-haspopup]')
          const rect = launcher === null ? null : launcher.getBoundingClientRect()
          const reference = rect !== null && rect.width > 0 && rect.height > 0 ? rect : band
          return {
            left: Math.round(reference.right) + 8,
            top: Math.round(reference.top + (reference.height - CONTROL_HEIGHT) / 2),
          }
        }
      }
      const menubar = document.querySelector('[data-windows-menu]')
      const rect = menubar === null ? null : menubar.getBoundingClientRect()
      if (rect !== null && rect.width > 0 && rect.top < 60) {
        return {
          left: Math.round(rect.right) + 8,
          top: Math.round(rect.top + (rect.height - CONTROL_HEIGHT) / 2),
        }
      }
      return null
    }

    /**
     * Track the seat the control occupies, so it stays after the overflow
     * launcher while the sidebar collapses, the locale changes, or the window
     * resizes. Hidden when there is no room left of the window controls.
     */
    function useAnchor() {
      const [anchor, setAnchor] = useState(null)
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        let previous = ''
        const measure = () => {
          const next = captionAnchor()
          const room = next !== null && next.left + 104 <= window.innerWidth - WINDOW_CONTROLS_RESERVE
          const state = next === null || !room ? '' : `${next.left},${next.top}`
          if (state === previous) return
          previous = state
          setAnchor(state === '' ? null : next)
        }
        measure()
        const timer = window.setInterval(measure, 1000)
        window.addEventListener('resize', measure)
        return () => {
          window.clearInterval(timer)
          window.removeEventListener('resize', measure)
        }
      }, [])
      return anchor
    }

    /** Circular-arrow glyph matching the caption row's icon size. */
    function glyph() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, style: { flex: 'none' },
      },
      h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
      h('path', { d: 'M20 4v5h-5' }),
      )
    }

    /** One popover action button. */
    function actionButton(key, label, primary, onClick) {
      return h('button', {
        key,
        type: 'button',
        onClick,
        style: {
          padding: '5px 12px',
          borderRadius: 6,
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 13,
          ...(primary
            ? { border: 'none', background: 'var(--dsw-alias-state-error-primary)', color: '#fff' }
            : {
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
            }),
        },
      }, label)
    }

    /**
     * Build the control bound to this Client context.
     * @param ctx - the Client root context carrying the locale service.
     */
    function createControl(ctx) {
      return function RestartControl() {
        const text = useText(ctx)
        const anchor = useAnchor()
        const [open, setOpen] = useState(false)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        const [hover, setHover] = useState(false)

        useEffect(() => {
          if (!open) return undefined
          const onKey = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [open])

        /* One report per mount: which language sources the page really exposes.
         * The Host keeps it in a log line; it changes no state. */
        useEffect(() => {
          try {
            const payload = {
              resolved: language(ctx),
              hints: languageHints(ctx),
              hasLocaleService: Boolean(ctx.locale),
              active: (() => {
                try {
                  return ctx.locale?.getLocale?.()?.active ?? null
                } catch {
                  return 'threw'
                }
              })(),
              documentLang: (() => {
                try {
                  return document.documentElement?.getAttribute?.('lang') ?? null
                } catch {
                  return 'threw'
                }
              })(),
              navigatorLanguage: (() => {
                try {
                  return navigator.language
                } catch {
                  return 'threw'
                }
              })(),
            }
            fetch(ROUTE, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }).catch(() => {})
          } catch {
            /* diagnostics only */
          }
        }, [])

        /** Read the Host version before offering the action. */
        const probe = useCallback(async () => {
          try {
            const response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
            const info = await response.json()
            return response.ok && info?.version === VERSION
          } catch {
            return false
          }
        }, [])

        const confirm = useCallback(async () => {
          setOpen(false)
          setBusy(true)
          setError('')
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'x-dsh-restart-action': 'restart', 'content-type': 'application/json' },
              body: '{}',
            })
            if (!response.ok) throw new Error(String(response.status))
          } catch {
            setBusy(false)
            setError('failed')
            setOpen(true)
          }
        }, [])

        const toggle = useCallback(async () => {
          if (busy) return
          if (open) {
            setOpen(false)
            return
          }
          setError('')
          const current = await probe()
          if (!current) {
            setError('outdated')
            setOpen(true)
            return
          }
          setOpen(true)
        }, [busy, open, probe])

        if (anchor === null) return null

        const popoverWidth = 320
        const popoverLeft = Math.max(8, Math.min(anchor.left, window.innerWidth - popoverWidth - 12))
        const outdated = error === 'outdated'

        const backdrop = open
          ? h('div', {
            key: 'backdrop',
            onClick: () => setOpen(false),
            style: {
              position: 'fixed', inset: 0, zIndex: 1190,
              background: 'transparent', pointerEvents: 'auto',
            },
          })
          : null

        const control = h('button', {
          key: 'button',
          type: 'button',
          title: text('tooltip'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          disabled: busy,
          onClick: () => { toggle() },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            position: 'fixed',
            left: anchor.left,
            top: anchor.top,
            height: CONTROL_HEIGHT,
            boxSizing: 'border-box',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 10px',
            border: '1px solid transparent',
            borderRadius: 6,
            background: hover || open ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
            color: hover || open ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            font: 'inherit',
            fontSize: 14,
            lineHeight: `${CONTROL_HEIGHT}px`,
            whiteSpace: 'nowrap',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.7 : 1,
            zIndex: 1200,
            pointerEvents: 'auto',
            WebkitAppRegion: 'no-drag',
          },
        }, glyph(), h('span', { key: 'label' }, busy ? text('busy') : text('label')))

        const popover = open
          ? h('div', {
            key: 'popover',
            role: 'dialog',
            'aria-label': text('title'),
            style: {
              position: 'fixed',
              left: popoverLeft,
              top: anchor.top + CONTROL_HEIGHT + 6,
              width: popoverWidth,
              boxSizing: 'border-box',
              padding: 14,
              borderRadius: 10,
              background: 'var(--dsw-alias-bg-overlay)',
              border: '1px solid var(--dsw-alias-border-l1)',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 13,
              zIndex: 1400,
              pointerEvents: 'auto',
              WebkitAppRegion: 'no-drag',
            },
          },
          h('div', {
            key: 'title',
            style: { fontSize: 14, fontWeight: 600, marginBottom: 6 },
          }, text('title')),
          h('div', {
            key: 'body',
            style: {
              color: 'var(--dsw-alias-label-secondary)',
              lineHeight: 1.6,
              marginBottom: error === '' ? 12 : 8,
            },
          }, text('body')),
          error === ''
            ? null
            : h('div', {
              key: 'error',
              style: { color: 'var(--dsw-alias-state-error-primary)', marginBottom: 12 },
            }, text(outdated ? 'outdated' : 'failed')),
          h('div', {
            key: 'actions',
            style: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
          },
          outdated
            ? actionButton('close', text('cancel'), false, () => setOpen(false))
            : [
              actionButton('cancel', text('cancel'), false, () => setOpen(false)),
              actionButton('confirm', text('confirm'), true, () => { confirm() }),
            ],
          ),
          )
          : null

        return h(React.Fragment, null, backdrop, control, popover)
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        registerStrings(ctx)
        const Control = createControl(ctx)
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'harness-restart',
          order: 1000,
          label: 'Restart',
        }, Control))
      },
    }
  },
})
