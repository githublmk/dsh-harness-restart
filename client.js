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
 * combination would stop the shell without a working relaunch path. The same
 * probe reports the last finished restart, which the control shows once the
 * page is back.
 *
 * @module dsh-harness-restart
 */
window.__ModuleLoader__.load({
  id: 'dsh-harness-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React
    /**
     * Menu row widget of the platform primitives. Every bundle resolves the
     * same frozen platform table, so the sidebar's own menu uses it; a carrier
     * without it falls back to a plain button row.
     */
    let MenuItemButton
    try {
      ;({ MenuItemButton } = require('@deepseek-ai/dsh-client-ui-primitives'))
    } catch {
      MenuItemButton = undefined
    }

    /** Version the Host half must report before the action is offered. */
    const VERSION = '0.4.6'
    /** Same-origin route the Host half answers (forwarded by the Desktop shell). */
    const ROUTE = '/dsh-harness-restart/restart'
    /** Height of the control, matching one caption panel row. */
    const CONTROL_HEIGHT = 28
    /** A caption band is a short strip; anything taller is a layout column. */
    const CAPTION_MAX_HEIGHT = 96
    /** Below this width only the Web (phone) layout exists, and it has no band. */
    const CAPTION_MIN_VIEWPORT = 520
    /** Widest the confirmation popover gets before it must fit the viewport. */
    const MAX_POPOVER_WIDTH = 360
    /** Right-hand band reserved for the native window controls. */
    const WINDOW_CONTROLS_RESERVE = 168
    /** Locale namespace the strings are registered under. */
    const NS = 'harness-restart'
    /** A finished plan older than this is history, not a notification. */
    const NOTICE_TTL_MS = 10 * 60 * 1000
    /** How long the post-restart notice stays on screen. */
    const NOTICE_HIDE_MS = 15000
    /** If the page is still alive this long after a request, the restart failed. */
    const RESTART_WATCHDOG_MS = 20000
    /** Upper bound on task lines accepted from the popover. */
    const MAX_TASKS = 8

    /** Visible text, per app language; the Client locale service selects one. */
    const TEXT = {
      'zh-CN': {
        label: '重启',
        menuLabel: '重启应用与 Host',
        tooltip: '重启应用与 Host（重启后可继续被中断的会话）',
        title: '重启应用与 Host？',
        body: '正在进行的任务会被中断；重启完成后，被中断的会话会自动继续。',
        bodyNoResume: '正在进行的任务会被中断；本次重启不会恢复被中断的会话。',
        resumeLabel: '重启后继续被中断的会话',
        tasksLabel: '重启后任务（可选，每行一条）',
        tasksPlaceholder: '例如：跑一遍 npm test 并汇报失败摘要',
        cancel: '取消',
        confirm: '重启',
        busy: '正在重启…',
        failed: '重启请求没有被接受，请稍后再试。',
        outdated: '当前 Host 还是旧版本，先重开一次应用再试。',
        unsupported: '当前环境不支持自动重启（仅桌面端）。',
        stalled: '重启没有在预期时间内发生，应用仍在运行；详情见 %TEMP%\\dsh-harness-restart\\restart.log。',
        conflict: '已有一次重启正在进行，稍等它完成（界面会在几秒内重启）。',
        notice: '重启完成：已恢复 {resumed} 个会话，启动 {tasks} 个任务',
        noticeFailed: '上次重启有未完成的条目（已恢复 {resumed} 个会话，启动 {tasks} 个任务）',
      },
      en: {
        label: 'Restart',
        menuLabel: 'Restart app and Host',
        tooltip: 'Restart the app and Host (interrupted Sessions continue afterwards)',
        title: 'Restart the app and Host?',
        body: 'Running tasks are interrupted; interrupted Sessions continue automatically after the restart.',
        bodyNoResume: 'Running tasks are interrupted; this restart will not resume interrupted Sessions.',
        resumeLabel: 'Continue interrupted Sessions after the restart',
        tasksLabel: 'Post-restart tasks (optional, one per line)',
        tasksPlaceholder: 'For example: run npm test and report the failing summary',
        cancel: 'Cancel',
        confirm: 'Restart',
        busy: 'Restarting…',
        failed: 'The restart request was not accepted. Try again.',
        outdated: 'The running Host is an older version. Restart the app once first.',
        unsupported: 'Automatic restart is available only in the Desktop app.',
        stalled: 'The restart did not happen in time and the app is still running; see %TEMP%\\dsh-harness-restart\\restart.log.',
        conflict: 'A restart is already in flight; wait for it to finish (the window comes back in a few seconds).',
        notice: 'Restart finished: {resumed} Session(s) resumed, {tasks} task(s) started',
        noticeFailed: 'The last restart left unfinished entries ({resumed} resumed, {tasks} task(s) started)',
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

    /** Fill `{name}` placeholders in one localized template. */
    function formatTemplate(template, values) {
      return String(template).replace(/\{(\w+)\}/gu, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      ))
    }

    /**
     * Schedule work through the page's timer, when it has one. The headless
     * smoke harness has no `window.setTimeout`, and no timer is better than a
     * Node timer that would keep that process alive.
     */
    function later(callback, milliseconds) {
      if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        return window.setTimeout(callback, milliseconds)
      }
      return undefined
    }

    /** Cancel a timer created by {@link later}. */
    function cancelLater(handle) {
      if (handle === undefined) return
      if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
        window.clearTimeout(handle)
      }
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

    /**
     * Whether one rectangle is the Desktop caption strip rather than a layout
     * column. A plain Web page renders the same nav vertically down the left
     * edge, and on a phone that column starts at the top of the viewport with
     * the conversation scrolling beside it, so position alone would seat the
     * fixed control in the middle of the chat. A caption band is short, wide
     * and fully on screen.
     * @param band - bounds of the candidate element.
     * @returns true only for a caption-like strip.
     */
    function isCaptionBand(band) {
      return band.width > 0 && band.height > 0
        && band.height <= CAPTION_MAX_HEIGHT
        && band.width >= band.height * 2
        && band.top < 60
        && band.right > 0
    }

    /**
     * The caption-band element whose right edge the control follows, or null
     * when this layout has no caption band (a phone or a plain Web page keeps
     * the same nav as a vertical sidebar column).
     * @returns the band's bounds, or null.
     */
    function captionBand() {
      if (window.innerWidth < CAPTION_MIN_VIEWPORT) return null
      /* 0.2.2 wraps every caption entry in a `panelEntry` block, so the shipped
       * row is no longer a direct child of the nav; the nav's own `panelList`
       * class is the stable shape, and the old one stays for a 0.2.1 build. */
      const nav = document.querySelector('nav[class*="panelList"], nav:has(> [class*="panelRow"])')
      if (nav !== null) {
        const band = nav.getBoundingClientRect()
        if (isCaptionBand(band)) {
          const launcher = nav.querySelector('[aria-haspopup]')
          const rect = launcher === null ? null : launcher.getBoundingClientRect()
          return rect !== null && rect.width > 0 && rect.height > 0 ? rect : band
        }
      }
      const menubar = document.querySelector('[data-windows-menu]')
      if (menubar !== null) {
        const rect = menubar.getBoundingClientRect()
        if (isCaptionBand(rect)) return rect
      }
      return null
    }

    /** The seat the fixed control takes when a caption band exists. */
    function captionAnchor() {
      const reference = captionBand()
      if (reference === null) return null
      return {
        left: Math.round(reference.right) + 8,
        top: Math.round(reference.top + (reference.height - CONTROL_HEIGHT) / 2),
      }
    }

    /** Whether this layout already carries the caption-band control. */
    function hasCaptionBand() {
      return captionBand() !== null
    }

    /** Center seat for a confirmation opened from the More menu. */
    function centerSeat() {
      const width = Math.min(MAX_POPOVER_WIDTH, window.innerWidth - 24)
      return {
        left: Math.max(8, Math.round((window.innerWidth - width) / 2)),
        top: Math.min(200, Math.max(72, Math.round(window.innerHeight * 0.15))),
      }
    }

    /**
     * Overlay controls listening for a More-menu request. The overlay owns the
     * confirmation dialog, so the menu row only asks it to open.
     */
    const openRequests = new Set()

    /** Ask the mounted control to open its confirmation. */
    function requestOpenFromMenu() {
      for (const listener of openRequests) listener()
    }

    /**
     * One row of the panel list's More menu.
     * @param icon - leading glyph.
     * @param label - row text.
     * @param onSelect - activation handler.
     * @param separatorBefore - whether the owner's own rows precede this one.
     */
    function menuRow(icon, label, onSelect, separatorBefore) {
      if (MenuItemButton !== undefined) {
        return h(MenuItemButton, { icon, separatorBefore, onSelect }, label)
      }
      return h('button', {
        type: 'button',
        role: 'menuitem',
        onClick: onSelect,
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '8px 10px', border: 'none', background: 'transparent',
          color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14,
          textAlign: 'left', cursor: 'pointer',
          ...(separatorBefore ? { borderTop: '1px solid var(--dsw-alias-border-l1)' } : {}),
        },
      }, icon, h('span', null, label))
    }

    /**
     * Build the More-menu row. Layouts without a caption band have no other
     * seat, and the row opens the same confirmation the caption control does.
     * @param ctx - the Client root context carrying the locale service.
     */
    function createMenuEntry(ctx) {
      return function RestartMenuEntry(props) {
        const { entries = [], onDismiss } = props ?? {}
        /* The Desktop caption band already carries the control. */
        if (hasCaptionBand()) return null
        const table = TEXT[language(ctx)] ?? TEXT['zh-CN']
        return menuRow(glyph(), table.menuLabel, () => {
          if (typeof onDismiss === 'function') onDismiss()
          requestOpenFromMenu()
        }, entries.length > 0)
      }
    }

    /**
     * Track the seat the control occupies, so it stays after the overflow
     * launcher while the sidebar collapses, the locale changes, or the window
     * resizes. Hidden when there is no room left of the window controls.
     */
    function useAnchor(open) {
      const [anchor, setAnchor] = useState(null)
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        let previous = ''
        const measure = () => {
          const next = captionAnchor()
          const room = next !== null && next.left + 104 <= window.innerWidth - WINDOW_CONTROLS_RESERVE
          const seat = next === null || !room ? '' : `${next.left},${next.top}`
          if (seat === previous) return
          /* Keep the control where it is while its popover is open: losing the
           * seat for one remeasure must not unmount the dialog under the user. */
          if (seat === '' && open) return
          previous = seat
          setAnchor(seat === '' ? null : next)
        }
        measure()
        const timer = window.setInterval(measure, 1000)
        window.addEventListener('resize', measure)
        return () => {
          window.clearInterval(timer)
          window.removeEventListener('resize', measure)
        }
      }, [open])
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
      /** One submission at a time, even when two clicks land in one frame. */
      let submitting = false
      /** The stalled watchdog of the current attempt. */
      let watchdog

      return function RestartControl() {
        const text = useText(ctx)
        const [open, setOpen] = useState(false)
        const anchor = useAnchor(open)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        const [hover, setHover] = useState(false)
        const [resume, setResume] = useState(true)
        const [tasksText, setTasksText] = useState('')
        const [notice, setNotice] = useState(null)
        const [maxTasks, setMaxTasks] = useState(MAX_TASKS)
        /** Seat of a dialog opened from the More menu: no caption band to hang it from. */
        const [menuSeat, setMenuSeat] = useState(null)
        /** A More-menu request waiting for the probe; the effect below owns it. */
        const [menuRequested, setMenuRequested] = useState(false)

        useEffect(() => () => {
          cancelLater(watchdog)
        }, [])

        useEffect(() => {
          if (!open) return undefined
          const onKey = (event) => {
            if (event.key === 'Escape') {
              setOpen(false)
              setMenuSeat(null)
            }
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
              headers: { 'content-type': 'application/json', 'x-dsh-restart-probe': '1' },
              body: JSON.stringify(payload),
            }).catch(() => {})
          } catch {
            /* diagnostics only */
          }
        }, [])

        /* The page is freshly loaded after a restart: if the Host finished a
         * plan a moment ago, say what it did. */
        useEffect(() => {
          let mounted = true
          let timer
          ;(async () => {
            try {
              const response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
              const info = await response.json()
              if (!mounted) return
              const last = info?.lastPlan
              if (last === null || typeof last !== 'object' || typeof last.finishedAt !== 'number') return
              if (Date.now() - last.finishedAt > NOTICE_TTL_MS) return
              setNotice({
                ok: last.ok !== false,
                resumed: Number.isFinite(last.resumed) ? last.resumed : 0,
                tasks: Number.isFinite(last.tasks) ? last.tasks : 0,
              })
              timer = later(() => {
                if (mounted) setNotice(null)
              }, NOTICE_HIDE_MS)
            } catch {
              /* the notice is optional */
            }
          })()
          return () => {
            mounted = false
            cancelLater(timer)
          }
        }, [])

        /** Probe the Host: version, support, and the button's own defaults. */
        const probe = useCallback(async () => {
          try {
            const response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
            if (!response.ok) return { error: 'failed' }
            const info = await response.json()
            if (info?.supported === false) return { error: 'unsupported' }
            if (info?.version !== VERSION) return { error: 'outdated' }
            return { error: '', info }
          } catch {
            return { error: 'failed' }
          }
        }, [])

        const confirm = useCallback(async () => {
          if (submitting) return
          submitting = true
          setOpen(false)
          setBusy(true)
          setError('')
          setNotice(null)
          cancelLater(watchdog)
          /* Armed before the request: a hung POST must not leave the control
           * busy forever with no popover and no way to retry. */
          watchdog = later(() => {
            setBusy(false)
            setError('stalled')
            setOpen(true)
            submitting = false
          }, RESTART_WATCHDOG_MS)
          const tasks = tasksText
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line !== '')
            .slice(0, maxTasks)
            .map((prompt) => ({ prompt }))
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'x-dsh-restart-action': 'restart', 'content-type': 'application/json' },
              body: JSON.stringify({ resume: resume ? 'interrupted' : 'none', tasks, language: language(ctx) }),
            })
            if (!response.ok) {
              cancelLater(watchdog)
              setBusy(false)
              setError(response.status === 409 ? 'conflict' : 'failed')
              setOpen(true)
              submitting = false
            }
            /* On success the watchdog stays armed: if the app never restarts, it
             * clears the busy state instead of leaving a dead control behind. */
          } catch {
            cancelLater(watchdog)
            setBusy(false)
            setError('failed')
            setOpen(true)
            submitting = false
          }
        }, [resume, tasksText, maxTasks])

        const toggle = useCallback(async () => {
          if (busy) return
          if (open) {
            setOpen(false)
            return
          }
          setError('')
          const result = await probe()
          if (result.error !== '') {
            setError(result.error)
            setOpen(true)
            return
          }
          const info = result.info ?? {}
          /* The profile's resume policy is the button's initial state. */
          if (typeof info.resumeDefault === 'string') setResume(info.resumeDefault !== 'none')
          if (Number.isInteger(info.maxTasks) && info.maxTasks > 0) setMaxTasks(info.maxTasks)
          setOpen(true)
        }, [busy, open, probe])

        /* The More menu has no caption control to press: its row asks this
         * component to open the same confirmation in the middle of the view. */
        useEffect(() => {
          const listener = () => {
            setMenuSeat(centerSeat())
            setMenuRequested(true)
          }
          openRequests.add(listener)
          return () => {
            openRequests.delete(listener)
          }
        }, [])

        useEffect(() => {
          if (!menuRequested) return
          setMenuRequested(false)
          void toggle()
        }, [menuRequested])

        const seat = anchor ?? menuSeat
        if (seat === null) return null

        const popoverWidth = Math.min(MAX_POPOVER_WIDTH, window.innerWidth - 24)
        const popoverLeft = Math.max(8, Math.min(seat.left, window.innerWidth - popoverWidth - 12))
        const blocked = error === 'outdated' || error === 'unsupported'
        /** Dismiss the dialog and forget a More-menu seat so it cannot linger. */
        const closeDialog = () => {
          setOpen(false)
          setMenuSeat(null)
        }

        const backdrop = open
          ? h('div', {
            key: 'backdrop',
            onClick: () => closeDialog(),
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
            left: seat.left,
            top: seat.top,
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
              top: seat.top + CONTROL_HEIGHT + 6,
              width: popoverWidth,
              maxHeight: Math.max(200, window.innerHeight - seat.top - CONTROL_HEIGHT - 24),
              overflowY: 'auto',
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
              marginBottom: 10,
            },
          }, text(resume ? 'body' : 'bodyNoResume')),
          h('label', {
            key: 'resume',
            style: {
              display: 'flex', alignItems: 'center', gap: 8,
              marginBottom: 10, cursor: 'pointer',
              color: 'var(--dsw-alias-label-primary)',
            },
          },
          h('input', {
            type: 'checkbox',
            checked: resume,
            onChange: () => setResume(!resume),
            style: { margin: 0 },
          }),
          h('span', { key: 'text' }, text('resumeLabel'))),
          h('div', {
            key: 'tasks',
            style: { marginBottom: error === '' ? 12 : 8 },
          },
          h('div', {
            key: 'label',
            style: { color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 },
          }, text('tasksLabel')),
          h('textarea', {
            value: tasksText,
            onChange: (event) => setTasksText(event?.target?.value ?? ''),
            placeholder: text('tasksPlaceholder'),
            rows: 2,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 13,
            },
          })),
          error === ''
            ? null
            : h('div', {
              key: 'error',
              style: { color: 'var(--dsw-alias-state-error-primary)', marginBottom: 12 },
            }, text(error)),
          h('div', {
            key: 'actions',
            style: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
          },
          blocked
            ? actionButton('close', text('cancel'), false, () => closeDialog())
            : [
              actionButton('cancel', text('cancel'), false, () => closeDialog()),
              actionButton('confirm', text('confirm'), true, () => { confirm() }),
            ],
          ),
          )
          : null

        const noticeNode = notice === null
          ? null
          : h('div', {
            key: 'notice',
            role: 'status',
            onClick: () => setNotice(null),
            style: {
              position: 'fixed',
              left: seat.left,
              top: seat.top + CONTROL_HEIGHT + 6,
              maxWidth: 380,
              padding: '4px 10px',
              borderRadius: 6,
              background: 'var(--dsw-alias-bg-overlay)',
              border: '1px solid var(--dsw-alias-border-l1)',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 12,
              lineHeight: 1.5,
              zIndex: 1300,
              pointerEvents: 'auto',
              cursor: 'pointer',
              WebkitAppRegion: 'no-drag',
            },
          }, formatTemplate(notice.ok ? text('notice') : text('noticeFailed'), {
            resumed: notice.resumed,
            tasks: notice.tasks,
          }))

        return h(React.Fragment, null, backdrop, anchor === null ? null : control, popover, noticeNode)
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
        /* The sidebar shows its "More" menu while this list has rows; on a
         * Web layout the row is the only way to reach the restart. */
        ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({
          name: 'sidebar.panellist.actions',
          id: 'harness-restart',
          order: 1000,
          label: 'Restart',
        }, createMenuEntry(ctx)))
      },
    }
  },
})
