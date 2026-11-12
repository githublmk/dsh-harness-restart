/**
 * Client half of the harness-restart bundle.
 *
 * Contributes one global panel entry — a row in the sidebar's panel list,
 * seated right after the memory panel — plus the page that row opens. The page
 * carries the confirmation: what the restart interrupts, the resume switch, the
 * post-restart task box, and the action itself. Nothing is drawn over the rest
 * of the shell: the entry is a normal panel row, so it inherits the row's own
 * hover, tooltip, selected state and collapse behaviour instead of measuring
 * the caption band.
 *
 * The page asks the Host for its version before offering the action, so an
 * outdated Host half (one loaded before this file changed) is never used: that
 * combination would stop the shell without a working relaunch path. The same
 * probe reports the last finished restart, which the page lists and the
 * frame-wide notice repeats once the page is back.
 *
 * @module dsh-harness-restart
 */
window.__ModuleLoader__.load({
  id: 'dsh-harness-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Version the Host half must report before the action is offered. */
    const VERSION = '0.4.8'
    /** Same-origin route the Host half answers (forwarded by the Desktop shell). */
    const ROUTE = '/dsh-harness-restart/restart'
    /** Panel id shared by the sidebar entry and the page it opens. */
    const PANEL_ID = 'harness-restart'
    /**
     * Row position in the panel list. The memory panel claims 900, so 901 puts
     * the restart immediately after it and still before the overflow launcher.
     */
    const PANEL_ORDER = 901
    /** A finished plan older than this is history, not a notification. */
    const NOTICE_TTL_MS = 10 * 60 * 1000
    /** How long the post-restart notice stays on screen. */
    const NOTICE_HIDE_MS = 15000
    /** If the page is still alive this long after a request, the restart failed. */
    const RESTART_WATCHDOG_MS = 20000
    /** Upper bound on task lines accepted from the page. */
    const MAX_TASKS = 8
    /** Widest the page's centred column gets. */
    const PAGE_MAX_WIDTH = 720

    /** Visible text, per app language; the Client locale service selects one. */
    const TEXT = {
      'zh-CN': {
        label: '重启',
        heading: '重启应用与 Host',
        intro: '重启会结束应用与 Host 进程，然后自动拉起。正在进行的任务会被中断；重启完成后，被中断的会话可以自动继续。',
        body: '正在进行的任务会被中断；重启完成后，被中断的会话会自动继续。',
        bodyNoResume: '正在进行的任务会被中断；本次重启不会恢复被中断的会话。',
        resumeLabel: '重启后继续被中断的会话',
        tasksLabel: '重启后任务（可选，每行一条，最多 {max} 条）',
        tasksPlaceholder: '例如：跑一遍 npm test 并汇报失败摘要',
        cancel: '取消',
        confirm: '重启',
        retry: '重试',
        busy: '正在重启…',
        failed: '重启请求没有被接受，请稍后再试。',
        outdated: '当前 Host 还是旧版本，先重开一次应用再试。',
        unsupported: '当前环境不支持自动重启（仅桌面端）。',
        stalled: '重启没有在预期时间内发生，应用仍在运行；详情见 %TEMP%\\dsh-harness-restart\\restart.log。',
        conflict: '已有一次重启正在进行，稍等它完成（界面会在几秒内重启）。',
        notice: '重启完成：已恢复 {resumed} 个会话，启动 {tasks} 个任务',
        noticeFailed: '上次重启有未完成的条目（已恢复 {resumed} 个会话，启动 {tasks} 个任务）',
        lastOk: '上次重启已完成：已恢复 {resumed} 个会话，启动 {tasks} 个任务',
        lastFailed: '上次重启有未完成的条目：已恢复 {resumed} 个会话，启动 {tasks} 个任务',
      },
      en: {
        label: 'Restart',
        heading: 'Restart the app and Host',
        intro: 'A restart ends the app and Host processes and brings them back up. Running tasks are interrupted; interrupted Sessions can continue automatically afterwards.',
        body: 'Running tasks are interrupted; interrupted Sessions continue automatically after the restart.',
        bodyNoResume: 'Running tasks are interrupted; this restart will not resume interrupted Sessions.',
        resumeLabel: 'Continue interrupted Sessions after the restart',
        tasksLabel: 'Post-restart tasks (optional, one per line, at most {max})',
        tasksPlaceholder: 'For example: run npm test and report the failing summary',
        cancel: 'Cancel',
        confirm: 'Restart',
        retry: 'Retry',
        busy: 'Restarting…',
        failed: 'The restart request was not accepted. Try again.',
        outdated: 'The running Host is an older version. Restart the app once first.',
        unsupported: 'Automatic restart is available only in the Desktop app.',
        stalled: 'The restart did not happen in time and the app is still running; see %TEMP%\\dsh-harness-restart\\restart.log.',
        conflict: 'A restart is already in flight; wait for it to finish (the window comes back in a few seconds).',
        notice: 'Restart finished: {resumed} Session(s) resumed, {tasks} task(s) started',
        noticeFailed: 'The last restart left unfinished entries ({resumed} resumed, {tasks} task(s) started)',
        lastOk: 'Last restart finished: {resumed} Session(s) resumed, {tasks} task(s) started',
        lastFailed: 'The last restart left unfinished entries: {resumed} Session(s) resumed, {tasks} task(s) started',
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
     * Active app language, decided by the first hint that names one. The hints
     * are ordered most specific first, so an explicit locale-service answer wins
     * over the document marker and the browser's own language: an app switched
     * to English stays English on a Chinese-locale machine. Chinese is the last
     * resort, because the interfaces this page sits in are usually Chinese.
     */
    function language(ctx) {
      for (const hint of languageHints(ctx)) {
        const value = hint.toLowerCase()
        if (value.startsWith('zh')) return 'zh-CN'
        if (value.startsWith('en')) return 'en'
      }
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

    /** Circular-arrow glyph, drawn at the size the caller asks for. */
    function glyph(size) {
      const edge = typeof size === 'number' && size > 0 ? size : 16
      return h('svg', {
        viewBox: '0 0 24 24', width: edge, height: edge, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, style: { flex: 'none' },
      },
      h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
      h('path', { d: 'M20 4v5h-5' }),
      )
    }

    /**
     * The panel-list entry. The sidebar owns the button, the label and the
     * selected state around it; this only draws the glyph at the requested
     * edge, so the row looks exactly like the shipped ones.
     */
    function PanelIcon(props) {
      return glyph(props?.size)
    }

    /** One page action button. */
    function pageButton(key, label, primary, onClick, disabled) {
      return h('button', {
        key,
        type: 'button',
        disabled: disabled === true,
        onClick,
        style: {
          padding: '6px 14px',
          borderRadius: 6,
          cursor: disabled === true ? 'default' : 'pointer',
          font: 'inherit',
          fontSize: 13,
          lineHeight: '20px',
          opacity: disabled === true ? 0.55 : 1,
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

    /** Read the Host's handshake document: version, support, defaults, last plan. */
    async function probeHost() {
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
    }

    /**
     * The last finished plan as the page reports it, or null when there is
     * nothing recent enough to mention.
     * @param info - the Host's handshake document.
     */
    function recentPlan(info) {
      const last = info?.lastPlan
      if (last === null || typeof last !== 'object') return null
      if (typeof last.finishedAt !== 'number') return null
      if (Date.now() - last.finishedAt > NOTICE_TTL_MS) return null
      return {
        ok: last.ok !== false,
        resumed: Number.isFinite(last.resumed) ? last.resumed : 0,
        tasks: Number.isFinite(last.tasks) ? last.tasks : 0,
      }
    }

    /** Last-restart copy for one plan summary. */
    function describePlan(text, plan) {
      return formatTemplate(plan.ok ? text('lastOk') : text('lastFailed'), {
        resumed: plan.resumed,
        tasks: plan.tasks,
      })
    }

    /** Top inset for the page head, clearing the macOS window controls. */
    function pageTopInset() {
      try {
        if (document.documentElement?.getAttribute?.('data-platform') === 'darwin') {
          return 'calc(28px + var(--dsh-frame-top-clearance, 48px))'
        }
      } catch {
        /* no document: the browser default applies */
      }
      return '28px'
    }

    /**
     * Build the page bound to this Client context.
     * @param ctx - the Client root context carrying the locale and layout services.
     */
    function createPage(ctx) {
      return function RestartPage() {
        const text = useText(ctx)
        /* One submission at a time, even when two clicks land in one frame, and
         * per page instance: a panel switch unmounts the page while a POST may
         * still be in flight, and a lock kept in the module closure would leave
         * the next mount with a button that silently does nothing. */
        const submitting = useRef(false)
        /* The stalled watchdog of the current attempt. */
        const watchdog = useRef()
        /* Whether the profile's defaults were already adopted into the form. */
        const adopted = useRef(false)
        /* Whether the user edited the form, which freezes the adoption. */
        const touched = useRef(false)
        const heading = useRef(null)
        const [check, setCheck] = useState(null)
        const [resume, setResume] = useState(true)
        const [tasksText, setTasksText] = useState('')
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        const [lastPlan, setLastPlan] = useState(null)
        const [maxTasks, setMaxTasks] = useState(MAX_TASKS)

        useEffect(() => () => {
          cancelLater(watchdog.current)
          /* Unmounted with a POST in flight: release the lock, or the next mount
           * would start with `submitting` set and the button doing nothing. */
          submitting.current = false
        }, [])

        /* An entry page owns its heading: the panel is a navigation destination,
         * so the title takes focus when the page opens. */
        useEffect(() => {
          try {
            heading.current?.focus?.({ preventScroll: true })
          } catch {
            /* focus is a convenience */
          }
        }, [])

        /** Ask the Host again, and adopt the profile's defaults when it answers. */
        const refresh = useCallback(async () => {
          const result = await probeHost()
          setCheck(result)
          setError(result.error)
          if (result.error !== '') return
          const info = result.info ?? {}
          /* Adopted once: maxTasks only shapes the label and the truncation. */
          if (!adopted.current) {
            adopted.current = true
            if (Number.isInteger(info.maxTasks) && info.maxTasks > 0) setMaxTasks(info.maxTasks)
          }
          /* The profile's resume policy is the switch's initial state, and only
           * for a form the user has not touched yet: a Retry must not silently
           * revert a choice that would change what the POST sends. */
          if (!touched.current && typeof info.resumeDefault === 'string') {
            setResume(info.resumeDefault !== 'none')
          }
          setLastPlan(recentPlan(info))
        }, [])

        useEffect(() => {
          void refresh()
        }, [refresh])

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

        /** Leave the page and show the Conversation again. */
        const back = useCallback(() => {
          try {
            ctx.layout?.selectPanel?.(null)
          } catch {
            /* the layout service is already disposed */
          }
        }, [])

        const confirm = useCallback(async () => {
          if (submitting.current) return
          /* Never post against a Host whose handshake did not succeed: the
           * button is disabled until it does, but a disabled button must not be
           * the only guard (a scripted click, or a keyboard handler, can reach
           * this closure anyway). */
          if (check === null || check.error !== '') return
          submitting.current = true
          setBusy(true)
          setError('')
          cancelLater(watchdog.current)
          /* Armed before the request: a hung POST must not leave the page stuck
           * on "restarting" with no way back. */
          watchdog.current = later(() => {
            setBusy(false)
            setError('stalled')
            submitting.current = false
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
              cancelLater(watchdog.current)
              setBusy(false)
              setError(response.status === 409 ? 'conflict' : 'failed')
              submitting.current = false
            }
            /* On success the watchdog stays armed: if the app never restarts, it
             * clears the busy state instead of leaving a dead page behind. */
          } catch {
            cancelLater(watchdog.current)
            setBusy(false)
            setError('failed')
            submitting.current = false
          }
        }, [check, resume, tasksText, maxTasks])

        const blocked = check !== null && check.error !== ''
        const ready = check !== null && check.error === ''

        const card = [
          h('div', {
            key: 'body',
            style: { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7, marginBottom: 14 },
          }, text(resume ? 'body' : 'bodyNoResume')),
          h('label', {
            key: 'resume',
            style: {
              display: 'flex', alignItems: 'center', gap: 8,
              marginBottom: 16, cursor: busy ? 'default' : 'pointer',
              color: 'var(--dsw-alias-label-primary)', fontSize: 13,
            },
          },
          h('input', {
            type: 'checkbox',
            checked: resume,
            disabled: busy,
            onChange: () => {
              touched.current = true
              setResume(!resume)
            },
            style: { margin: 0 },
          }),
          h('span', { key: 'text' }, text('resumeLabel'))),
          h('label', {
            key: 'tasks',
            style: { display: 'block', marginBottom: 14 },
          },
          h('span', {
            key: 'label',
            style: {
              display: 'block',
              color: 'var(--dsw-alias-label-secondary)',
              marginBottom: 6,
              fontSize: 13,
            },
          }, formatTemplate(text('tasksLabel'), { max: maxTasks })),
          h('textarea', {
            value: tasksText,
            disabled: busy,
            onChange: (event) => {
              touched.current = true
              setTasksText(event?.target?.value ?? '')
            },
            placeholder: text('tasksPlaceholder'),
            rows: 3,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 13,
              lineHeight: 1.6,
            },
          })),
          error === ''
            ? null
            : h('div', {
              key: 'error',
              role: 'alert',
              style: { color: 'var(--dsw-alias-state-error-primary)', marginBottom: 12, fontSize: 13 },
            }, text(error)),
          h('div', {
            key: 'actions',
            style: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
          },
          pageButton('cancel', text('cancel'), false, back, busy),
          blocked
            ? pageButton('retry', text('retry'), false, () => { void refresh() }, busy)
            : pageButton('confirm', busy ? text('busy') : text('confirm'), true, () => { void confirm() }, busy || !ready),
          ),
        ]

        return h('div', {
          style: {
            /* The main panel is a flex column cell with min-height 0; take the
             * rest of it and scroll, instead of assuming a definite height. */
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            width: '100%',
            boxSizing: 'border-box',
            overflowY: 'auto',
            /* macOS draws the window buttons over the first row: keep the head
             * below them, as the shipped entry pages do. */
            padding: `${pageTopInset()} clamp(24px, 4vw, 48px) 48px`,
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        h('div', { style: { width: '100%', maxWidth: PAGE_MAX_WIDTH, margin: '0 auto' } },
        h('h1', {
          ref: heading,
          tabIndex: -1,
          style: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px', outline: 'none' },
        }, text('heading')),
        h('p', {
          style: {
            margin: '6px 0 0',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 13,
            lineHeight: '20px',
          },
        }, text('intro')),
        lastPlan === null
          ? null
          : h('p', {
            key: 'last',
            role: 'status',
            style: {
              margin: '10px 0 0',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 12,
              lineHeight: '18px',
            },
          }, describePlan(text, lastPlan)),
        h('div', {
          key: 'card',
          style: {
            marginTop: 20,
            padding: 16,
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            fontSize: 13,
          },
        }, card),
        ))
      }
    }

    /**
     * The frame-wide notice: a compact pill that reports a restart finished a
     * moment ago, then gets out of the way. It owns no button — the restart
     * itself lives in the panel page — so it hides once there is nothing to say.
     * @param ctx - the Client root context carrying the locale service.
     */
    function createNotice(ctx) {
      return function RestartNotice() {
        const text = useText(ctx)
        const [notice, setNotice] = useState(null)

        useEffect(() => {
          let mounted = true
          let timer
          ;(async () => {
            try {
              const response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
              const info = await response.json()
              if (!mounted) return
              const plan = recentPlan(info)
              if (plan === null) return
              setNotice(plan)
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

        if (notice === null) return null

        return h('div', {
          role: 'status',
          /* Purely informational, and it sits over the composer: it must never
           * swallow a click meant for the page underneath. It hides itself. */
          style: {
            position: 'fixed',
            left: '50%',
            bottom: 28,
            transform: 'translateX(-50%)',
            maxWidth: 'min(520px, calc(100vw - 32px))',
            padding: '8px 14px',
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-overlay)',
            border: '1px solid var(--dsw-alias-border-l1)',
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.16)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
            lineHeight: 1.5,
            zIndex: 1300,
            pointerEvents: 'none',
          },
        }, formatTemplate(notice.ok ? text('notice') : text('noticeFailed'), {
          resumed: notice.resumed,
          tasks: notice.tasks,
        }))
      }
    }

    return {
      /* `layout` is a hard dependency: the row's own click selects the panel,
       * and Cancel is the page's only way back to the Conversation. */
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        /* The page carries the action; the sidebar row is the entry that opens
         * it, seated where the user expects a global panel to be. */
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, createPage(ctx)))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => (TEXT[language(ctx)] ?? TEXT['zh-CN']).label,
        }, PanelIcon))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'harness-restart-notice',
          order: 1000,
        }, createNotice(ctx)))
      },
    }
  },
})
