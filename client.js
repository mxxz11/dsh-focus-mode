/**
 * dsh-focus-mode — browser half.
 *
 * - a compact chip in the composer tool row (`conversation.input.left`) that
 *   always shows the current mode — the resident status label;
 * - the panel above the composer (`conversation.input.dock`):
 *     · one flat tab row holding every mode (通用 / 图片 / PPT / 视频 / 代码 /
 *       文档 / 数据) — 平铺展示;
 *     · when the measured row width cannot hold them all, the tail folds into a
 *       「更多模式」 dropdown instead of overflowing or squeezing («窗口过窄自动收拢»);
 *     · the selected mode always stays visible;
 *     · a short brief line, the lock switch, the optional subsidiary-confirm
 *       switch, the reset button and the interception counters.
 *
 * Layout is driven by a measured row width (ResizeObserver), never by guessed
 * breakpoints.
 */
window.__ModuleLoader__.load({
  id: 'dsh-focus-mode',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    /** `h` for call sites that pass a keyed child array as one argument. */
    const hh = (type, props, children) => {
      if (Array.isArray(children)) return React.createElement(type, props, ...children)
      if (children === undefined || children === null) return React.createElement(type, props)
      return React.createElement(type, props, children)
    }

    const ROUTE = '/dsh-focus-mode'
    const DEFAULT_POLL_MS = 15000
    /** Panel-closed baseline poll; fast polling only runs while the panel is open. */
    const SLOW_POLL_MS = 60000
    const GAP = 6
    const MORE_WIDTH = 84

    const T = {
      fg: 'var(--dsw-alias-label-primary, #f2f3f5)',
      fgSoft: 'var(--dsw-alias-label-secondary, #a6a8b0)',
      border: 'var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(255,255,255,0.22))',
      layer1: 'var(--dsw-alias-bg-layer-1, rgba(30,31,36,0.94))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(44,46,53,0.9))',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      error: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      idle: 'var(--dsw-alias-state-idle-primary, #8b8d95)',
    }

    const ZERO_STATE = {
      ok: false,
      sessionId: null,
      mode: 'general',
      modeLabel: '通用默认模式',
      modeShort: '通用',
      modeBrief: '不限制任务域，按原生策略处理任何任务。',
      active: false,
      locked: true,
      confirmSubsidiary: false,
      notice: null,
      modes: [],
      stats: { streak: 0, blocked: 0, passed: 0 },
      config: { offTopicRevertAfter: 3, idleRevertMinutes: 0, pollMs: DEFAULT_POLL_MS },
    }

    const BLANK_ENTRY = {
      state: null,
      error: null,
      loading: true,
      open: false,
      userToggled: false,
    }

    /**
     * Local fallback for the rigor tiers. Rendering must never depend on the
     * Host payload: a stale/absent `rigors` array (or an unknown stored tier)
     * still yields a usable slider instead of a blank panel.
     */
    const FALLBACK_RIGORS = [
      { id: 'fast', label: '快速核验', tooltip: '出结果快，基础严谨性高于普通对话' },
      { id: 'balanced', label: '严谨精简', tooltip: '平衡速度、篇幅与可信度（推荐）' },
      { id: 'strict', label: '极致严谨', tooltip: '全链路复核，高可信正式场景，开销更高' },
    ]

    // ---------------------------------------------------------------- store

    function createStore () {
      const entries = new Map()
      const listeners = new Map()
      const retainers = new Map()
      const timers = new Map()
      const fastTimers = new Map()
      let pollMs = DEFAULT_POLL_MS
      let wired = false

      const ensure = (sessionId) => {
        let entry = entries.get(sessionId)
        if (!entry) {
          entry = { ...BLANK_ENTRY }
          entries.set(sessionId, entry)
        }
        return entry
      }

      const current = (sessionId) => (sessionId ? entries.get(sessionId) || BLANK_ENTRY : BLANK_ENTRY)

      const emit = (sessionId) => {
        const set = listeners.get(sessionId)
        if (!set) return
        for (const fn of [...set]) {
          try { fn() } catch (error) { /* one broken subscriber must not break the rest */ }
        }
      }

      const commit = (sessionId, next) => {
        if (!sessionId) return
        const entry = ensure(sessionId)
        entries.set(sessionId, { ...entry, ...next })
        syncFastTimer(sessionId)
        emit(sessionId)
      }

      const applyState = (sessionId, state) => {
        const entry = ensure(sessionId)
        const open = entry.userToggled
          ? entry.open
          : !!(state && state.config && state.config.defaultPanelOpen === true)
        commit(sessionId, { state, error: null, loading: false, open })
      }

      const load = async (sessionId) => {
        if (!sessionId) return
        const entry = ensure(sessionId)
        if (!entry.state) commit(sessionId, { loading: true })
        try {
          const response = await fetch(ROUTE + '/state?session=' + encodeURIComponent(sessionId), {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const state = await response.json()
          const nextPoll = state && state.config && typeof state.config.pollMs === 'number'
            ? state.config.pollMs
            : pollMs
          if (nextPoll !== pollMs) {
            pollMs = nextPoll
            restartTimers()
          }
          applyState(sessionId, state)
        } catch (error) {
          commit(sessionId, { error: String((error && error.message) || error), loading: false })
        }
      }

      const send = async (sessionId, action, payload) => {
        if (!sessionId) return
        try {
          const response = await fetch(ROUTE + '/' + action, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', 'x-dsh-focus': '1' },
            credentials: 'same-origin',
            body: JSON.stringify({ session: sessionId, ...payload }),
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data || data.ok !== true) {
            throw new Error((data && data.error) || ('HTTP ' + response.status))
          }
          applyState(sessionId, data)
        } catch (error) {
          commit(sessionId, { error: String((error && error.message) || error), loading: false })
          void load(sessionId)
        }
      }

      /** Slow baseline poll: cheap enough to keep the chip label fresh while closed. */
      const startTimer = (sessionId) => {
        if (timers.has(sessionId)) return
        timers.set(sessionId, setInterval(() => { void load(sessionId) }, Math.max(pollMs, SLOW_POLL_MS)))
      }

      /**
       * Fast poll only while the panel is actually open and the tab visible.
       * Closed panels fall back to the slow baseline, so a session with the panel
       * shut does not hold a 15s polling loop.
       */
      const syncFastTimer = (sessionId) => {
        const entry = entries.get(sessionId)
        const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
        const wantsFast = !!(entry && entry.open === true && visible)
        const existing = fastTimers.get(sessionId)
        if (wantsFast && existing === undefined) {
          fastTimers.set(sessionId, setInterval(() => { void load(sessionId) }, pollMs))
          void load(sessionId)
          return
        }
        if (!wantsFast && existing !== undefined) {
          clearInterval(existing)
          fastTimers.delete(sessionId)
        }
      }

      const stopTimer = (sessionId) => {
        const timer = timers.get(sessionId)
        if (timer !== undefined) {
          clearInterval(timer)
          timers.delete(sessionId)
        }
        const fast = fastTimers.get(sessionId)
        if (fast !== undefined) {
          clearInterval(fast)
          fastTimers.delete(sessionId)
        }
      }

      const restartTimers = () => {
        for (const sessionId of [...timers.keys()]) {
          stopTimer(sessionId)
          startTimer(sessionId)
        }
      }

      const retain = (sessionId) => {
        if (!sessionId) return () => {}
        const count = (retainers.get(sessionId) || 0) + 1
        retainers.set(sessionId, count)
        if (count === 1) {
          startTimer(sessionId)
          void load(sessionId)
        }
        let released = false
        return () => {
          if (released) return
          released = true
          const next = (retainers.get(sessionId) || 1) - 1
          if (next <= 0) {
            retainers.delete(sessionId)
            stopTimer(sessionId)
          } else {
            retainers.set(sessionId, next)
          }
        }
      }

      const subscribe = (sessionId, fn) => {
        if (!sessionId) return () => {}
        let set = listeners.get(sessionId)
        if (!set) {
          set = new Set()
          listeners.set(sessionId, set)
        }
        set.add(fn)
        let active = true
        return () => {
          if (!active) return
          active = false
          const live = listeners.get(sessionId)
          if (!live) return
          live.delete(fn)
          if (live.size === 0) listeners.delete(sessionId)
        }
      }

      if (!wired && typeof window !== 'undefined') {
        wired = true
        const refresh = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          for (const sessionId of retainers.keys()) void load(sessionId)
        }
        window.addEventListener('focus', refresh)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh)
      }

      const optimisticMode = (sessionId, modeId) => {
        const entry = ensure(sessionId)
        if (!entry.state) return
        const modes = Array.isArray(entry.state.modes) ? entry.state.modes : []
        const mode = modes.find(candidate => candidate.id === modeId)
        commit(sessionId, {
          state: {
            ...entry.state,
            mode: modeId,
            modeLabel: mode ? mode.label : entry.state.modeLabel,
            modeShort: mode ? mode.short : entry.state.modeShort,
            modeBrief: mode ? mode.brief : entry.state.modeBrief,
            active: modeId !== 'general',
            notice: null,
            stats: { ...(entry.state.stats || {}), streak: 0 },
          },
        })
      }

      return {
        current,
        subscribe,
        retain,
        togglePanel: (sessionId) => {
          const entry = ensure(sessionId)
          commit(sessionId, { open: !entry.open, userToggled: true })
        },
        closePanel: (sessionId) => commit(sessionId, { open: false, userToggled: true }),
        setMode: (sessionId, modeId) => {
          optimisticMode(sessionId, modeId)
          void send(sessionId, 'mode', { mode: modeId })
        },
        setLock: (sessionId, locked) => {
          const entry = ensure(sessionId)
          if (entry.state) commit(sessionId, { state: { ...entry.state, locked } })
          void send(sessionId, 'lock', { lock: locked })
        },
        setConfirmSubsidiary: (sessionId, confirm) => {
          const entry = ensure(sessionId)
          if (entry.state) commit(sessionId, { state: { ...entry.state, confirmSubsidiary: confirm } })
          void send(sessionId, 'confirm', { confirm })
        },
        setFocusMode: (sessionId, focus) => {
          const entry = ensure(sessionId)
          if (entry.state) commit(sessionId, { state: { ...entry.state, focusMode: focus, focusGuideSeen: false } })
          void send(sessionId, 'focus', { focus })
        },
        setRigor: (sessionId, level) => {
          const entry = ensure(sessionId)
          if (entry.state) commit(sessionId, { state: { ...entry.state, rigor: level } })
          void send(sessionId, 'rigor', { rigor: level })
        },
        setShowMarkers: (sessionId, markers) => {
          const entry = ensure(sessionId)
          if (entry.state) commit(sessionId, { state: { ...entry.state, showMarkers: markers } })
          void send(sessionId, 'markers', { markers })
        },
        dismissFocusGuide: (sessionId) => {
          const entry = ensure(sessionId)
          if (entry.state) commit(sessionId, { state: { ...entry.state, focusGuideSeen: true } })
          void send(sessionId, 'guide', {})
        },
        reset: (sessionId) => {
          optimisticMode(sessionId, 'general')
          void send(sessionId, 'reset', {})
        },
        dismissNotice: (sessionId) => {
          const entry = ensure(sessionId)
          if (entry.state) commit(sessionId, { state: { ...entry.state, notice: null } })
          void send(sessionId, 'dismiss', {})
        },
      }
    }

    const store = createStore()

    // -------------------------------------------------------------- helpers

    function stateOf (entry) {
      return entry && entry.state ? entry.state : ZERO_STATE
    }

    function reasonText (reason) {
      if (reason === 'off-topic') return '连续偏离当前模式'
      if (reason === 'idle') return '长时间空闲'
      return '自动回退'
    }

    /** Rough chip width in px: padding + dot + gap + label + border. */
    function chipWidth (mode) {
      const label = mode && typeof mode.short === 'string' ? mode.short : ''
      return 34 + label.length * 11
    }

    /**
     * Split the catalog into the visible tab row and the 「更多模式」 menu.
     *
     * Every mode is resident by default (平铺展示); only when the measured width
     * cannot hold them does the tail fold into the dropdown. The selected mode is
     * never hidden — if it would fall past the fold it takes the last visible seat.
     *
     * @param {Array<object>} modes the host catalog, in panel order
     * @param {string} currentId the selected mode
     * @param {number} width measured row width (0 before the first measure)
     * @returns {{row: Array<object>, more: Array<object>}} the layout
     */
    function layoutTabs (modes, currentId, width) {
      const all = Array.isArray(modes) ? modes : []
      if (all.length === 0) return { row: [], more: [] }
      const limit = width > 0 ? width : 760
      const budget = limit - MORE_WIDTH
      const row = []
      let used = 0
      for (const mode of all) {
        const widthOf = chipWidth(mode) + GAP
        if (used + widthOf <= budget || row.length === 0) {
          row.push(mode)
          used += widthOf
        } else {
          break
        }
      }
      const current = all.find(mode => mode.id === currentId) || null
      if (current && !row.some(mode => mode.id === current.id)) {
        if (row.length > 0) row[row.length - 1] = current
        else row.push(current)
      }
      const rowIds = new Set(row.map(mode => mode.id))
      const more = all.filter(mode => !rowIds.has(mode.id))
      return { row, more }
    }

    function useFocus (sessionId) {
      const [entry, setEntry] = useState(() => store.current(sessionId))
      useEffect(() => {
        setEntry(store.current(sessionId))
        const unsubscribe = store.subscribe(sessionId, () => setEntry(store.current(sessionId)))
        const release = store.retain(sessionId)
        return () => {
          unsubscribe()
          release()
        }
      }, [sessionId])
      return entry || BLANK_ENTRY
    }

    // ----------------------------------------------------------- components

    const chipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '24px',
      padding: '0 8px',
      borderRadius: '6px',
      border: '1px solid ' + T.border,
      background: 'transparent',
      color: T.fgSoft,
      font: 'inherit',
      fontSize: '11px',
      lineHeight: '16px',
      cursor: 'pointer',
      userSelect: 'none',
      whiteSpace: 'nowrap',
    }

    function FocusChip (props) {
      const sessionId = props && props.sessionId
      const entry = useFocus(sessionId)
      if (!sessionId) return null
      const state = stateOf(entry)
      const modes = Array.isArray(state.modes) ? state.modes : []
      const mode = modes.find(candidate => candidate.id === state.mode) || null
      const active = state.active === true
      const accent = mode && mode.accent ? mode.accent : T.idle
      const label = mode ? mode.short : '聚焦'
      const broken = typeof entry.error === 'string' && entry.error !== ''
      const title = broken
        ? '任务域聚焦状态读取失败：' + entry.error + '（点击打开面板重试）'
        : [
          '任务域聚焦 · 当前：' + (mode ? mode.label : '通用默认模式'),
          mode ? mode.hint : '点击选择图片 / PPT / 视频 / 代码 / 文档 / 数据',
          active ? (state.locked ? '已锁定：持续执行定向约束与跨域拦截' : '未锁定：仅提示，不做硬拦截') : '未开启任务域聚焦',
        ].join('\n')
      return hh('button', {
        type: 'button',
        onClick: () => store.togglePanel(sessionId),
        title,
        'aria-label': '任务域聚焦：' + (mode ? mode.label : '加载中'),
        'aria-expanded': entry.open === true,
        'data-focus-mode-mode': state.mode,
        style: {
          ...chipStyle,
          color: broken ? T.error : active ? T.fg : T.fgSoft,
          borderColor: active ? T.borderStrong : T.border,
          background: active ? T.layer2 : 'transparent',
        },
      }, [
        h('span', {
          key: 'dot',
          'aria-hidden': 'true',
          style: {
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            flex: '0 0 auto',
            background: broken ? T.error : accent,
            boxShadow: active && state.locked ? '0 0 0 3px rgba(77,107,254,0.18)' : 'none',
          },
        }),
        h('span', { key: 'label' }, label),
      ])
    }

    function switchStyle (on) {
      return {
        position: 'relative',
        width: '34px',
        height: '18px',
        flex: '0 0 auto',
        borderRadius: '9px',
        border: '1px solid ' + (on ? T.brand : T.border),
        background: on ? T.brand : 'transparent',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease',
      }
    }

    function knobStyle (on) {
      return {
        position: 'absolute',
        top: '2px',
        left: on ? '18px' : '2px',
        width: '12px',
        height: '12px',
        borderRadius: '50%',
        background: on ? '#fff' : T.fgSoft,
        transition: 'left 120ms ease',
      }
    }

    function tabStyle (selected, accent) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '26px',
        padding: '0 10px',
        borderRadius: '7px',
        font: 'inherit',
        fontSize: '11px',
        lineHeight: '16px',
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        color: selected ? '#fff' : T.fg,
        background: selected ? accent || T.brand : T.layer2,
        border: '1px solid ' + (selected ? 'transparent' : T.border),
        fontWeight: selected ? 600 : 400,
      }
    }

    /** One labelled switch row, used by both the lock and the subsidiary toggle. */
    function switchRow (key, title, description, checked, onToggle, toggleTitle, ariaLabel) {
      return hh('div', {
        key,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '6px 8px',
          borderRadius: '8px',
          background: T.layer2,
          border: '1px solid ' + T.border,
        },
      }, [
        hh('div', {
          key: 'copy',
          style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto' },
        }, [
          h('span', { key: 'a', style: { fontSize: '11px', fontWeight: 600, color: T.fg } }, title),
          h('span', { key: 'b', style: { fontSize: '11px', lineHeight: '15px', color: T.fgSoft } }, description),
        ]),
        h('button', {
          key: 'switch',
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': ariaLabel,
          title: toggleTitle,
          onClick: onToggle,
          style: switchStyle(checked),
        }, h('span', { key: 'knob', style: knobStyle(checked) })),
      ])
    }

    function FocusPanel (props) {
      const sessionId = props && props.sessionId
      const entry = useFocus(sessionId)
      const [menuOpen, setMenuOpen] = useState(false)
      const [width, setWidth] = useState(0)
      const rowRef = useRef(null)
      // All hooks must run unconditionally, above the `return null` below.
      const trackRef = useRef(null)
      const knobRef = useRef(null)
      const fillRef = useRef(null)
      const draggingRef = useRef(false)

      // Measure the tab row so chips fold into the dropdown instead of overflowing.
      useEffect(() => {
        const element = rowRef.current
        if (!element || entry.open !== true) return undefined
        const measure = () => {
          const next = element.getBoundingClientRect().width
          if (next > 0) setWidth(prev => (Math.abs(prev - next) > 1 ? next : prev))
        }
        measure()
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(measure)
          observer.observe(element)
          return () => observer.disconnect()
        }
        if (typeof window !== 'undefined') {
          window.addEventListener('resize', measure)
          return () => window.removeEventListener('resize', measure)
        }
        return undefined
      }, [entry.open, sessionId])

      // Close the dropdown on any outside click.
      useEffect(() => {
        if (!menuOpen || typeof document === 'undefined') return undefined
        const close = () => setMenuOpen(false)
        document.addEventListener('click', close)
        return () => document.removeEventListener('click', close)
      }, [menuOpen])

      if (!sessionId || entry.open !== true) return null

      const state = stateOf(entry)
      const modes = Array.isArray(state.modes) ? state.modes : []
      const current = modes.find(mode => mode.id === state.mode) || null
      const { row, more } = layoutTabs(modes, state.mode, width)
      const active = state.active === true
      const locked = state.locked === true
      const confirmSubsidiary = state.confirmSubsidiary === true
      const focusMode = state.focusMode === true
      const showMarkers = state.showMarkers === true
      const rigors = Array.isArray(state.rigors) && state.rigors.length > 0 ? state.rigors : FALLBACK_RIGORS
      const rigor = typeof state.rigor === 'string' ? state.rigor : 'balanced'
      const rigorLabel = (rigors.find(level => level.id === rigor) || {}).label || '严谨精简'
      const threshold = state.config && typeof state.config.offTopicRevertAfter === 'number'
        ? state.config.offTopicRevertAfter
        : 3
      const streak = state.stats && typeof state.stats.streak === 'number' ? state.stats.streak : 0
      const blocked = state.stats && typeof state.stats.blocked === 'number' ? state.stats.blocked : 0
      const passed = state.stats && typeof state.stats.passed === 'number' ? state.stats.passed : 0
      const accent = current && current.accent ? current.accent : T.idle
      const notice = state.notice && state.notice.kind === 'auto-revert' ? state.notice : null
      const undoMode = notice ? modes.find(mode => mode.id === notice.from) : null
      const pick = (modeId) => {
        setMenuOpen(false)
        store.setMode(sessionId, modeId)
      }

      const header = hh('div', {
        key: 'header',
        style: { display: 'flex', alignItems: 'center', gap: '8px' },
      }, [
        h('span', {
          key: 'title',
          style: { fontSize: '12px', fontWeight: 700, letterSpacing: '0.02em', color: T.fg },
        }, '任务域聚焦'),
        h('span', {
          key: 'badge',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: '18px',
            padding: '0 7px',
            borderRadius: '9px',
            fontSize: '11px',
            lineHeight: '16px',
            maxWidth: '260px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: active ? '#fff' : T.fgSoft,
            background: active ? accent : 'transparent',
            border: '1px solid ' + (active ? 'transparent' : T.border),
          },
        }, '当前：' + (current ? current.label : '通用默认模式')),
        h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h('button', {
          key: 'close',
          type: 'button',
          onClick: () => store.closePanel(sessionId),
          title: '收起面板',
          'aria-label': '收起任务域聚焦面板',
          style: {
            border: 'none',
            background: 'transparent',
            color: T.fgSoft,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '12px',
            lineHeight: '18px',
            padding: '2px 4px',
            borderRadius: '4px',
          },
        }, '✕'),
      ])

      const tabs = row.map((mode) => {
        const selected = state.mode === mode.id
        return hh('button', {
          key: mode.id,
          type: 'button',
          role: 'radio',
          'aria-checked': selected,
          title: mode.hint,
          onClick: () => store.setMode(sessionId, mode.id),
          style: tabStyle(selected, mode.accent),
        }, [
          h('span', {
            key: 'dot',
            'aria-hidden': 'true',
            style: {
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              flex: '0 0 auto',
              background: selected ? '#fff' : (mode.accent || T.idle),
            },
          }),
          h('span', { key: 'label' }, mode.short),
        ])
      })

      const moreButton = more.length > 0
        ? hh('button', {
          key: 'more',
          type: 'button',
          title: '更多模式：' + more.map(mode => mode.label).join('、'),
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          onClick: (event) => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            setMenuOpen(value => !value)
          },
          style: { ...tabStyle(false, T.idle), gap: '4px', color: menuOpen ? T.fg : T.fgSoft },
        }, [
          h('span', { key: 'label' }, '更多模式'),
          h('span', { key: 'caret', 'aria-hidden': 'true', style: { fontSize: '9px', lineHeight: '10px' } }, '▾'),
        ])
        : null

      const menu = menuOpen && more.length > 0
        ? hh('div', {
          key: 'menu',
          role: 'menu',
          onClick: (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation() },
          style: {
            position: 'absolute',
            top: '30px',
            left: 0,
            zIndex: 5,
            minWidth: '216px',
            maxHeight: '240px',
            overflowY: 'auto',
            padding: '4px',
            borderRadius: '8px',
            border: '1px solid ' + T.border,
            background: T.layer1,
            boxShadow: '0 10px 28px rgba(0,0,0,0.28)',
          },
        }, more.map((mode) => {
          const selected = state.mode === mode.id
          return hh('button', {
            key: mode.id,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected,
            title: mode.hint,
            onClick: () => pick(mode.id),
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '1px',
              width: '100%',
              padding: '5px 8px',
              borderRadius: '6px',
              border: 'none',
              background: selected ? T.layer2 : 'transparent',
              color: T.fg,
              font: 'inherit',
              fontSize: '11px',
              lineHeight: '15px',
              textAlign: 'left',
              cursor: 'pointer',
            },
          }, [
            hh('span', { key: 'label', style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: selected ? 600 : 400 } }, [
              h('span', {
                key: 'dot',
                'aria-hidden': 'true',
                style: { width: '6px', height: '6px', borderRadius: '50%', background: mode.accent || T.idle, flex: '0 0 auto' },
              }),
              h('span', { key: 'text' }, mode.label),
            ]),
            h('span', { key: 'brief', style: { color: T.fgSoft, paddingLeft: '12px' } }, mode.brief),
          ])
        }))
        : null

      const selector = h('div', {
        key: 'selector',
        ref: rowRef,
        role: 'radiogroup',
        'aria-label': '选择任务域模式',
        style: { position: 'relative', display: 'flex', flexWrap: 'nowrap', gap: GAP + 'px', minWidth: 0 },
      }, [...tabs, moreButton, menu])

      const brief = h('div', {
        key: 'brief',
        style: { fontSize: '11px', lineHeight: '16px', color: T.fgSoft, minHeight: '16px' },
      }, current && current.brief
        ? current.brief + (current.subsidiary && current.subsidiary.length > 0
          ? '｜附属：' + current.subsidiary.join('、') + '（仅在明确要求时执行）'
          : '')
        : '不限制任务域，按原生策略处理任何任务。')

      const lockRow = switchRow(
        'lock',
        '锁定模式（持续执行定向约束与跨域拦截）',
        locked
          ? '已开启：持续执行定向约束与跨域拦截，不自动切回通用'
          : (threshold > 0
            ? '已关闭：仅提示不硬拦截，连续' + threshold + '次偏离自动切回通用模式'
            : '已关闭：仅提示不硬拦截'),
        locked,
        () => store.setLock(sessionId, !locked),
        locked ? '点击关闭：只提示不拦截，并允许自动回退' : '点击开启：持续执行定向约束与跨域拦截',
        '锁定模式',
      )

      const confirmRow = switchRow(
        'confirm',
        '附属动作弹窗确认',
        confirmSubsidiary
          ? '已开启：明确提出附属动作时先弹确认框'
          : '已关闭：明确提出附属动作直接执行，未提出的动作拦截',
        confirmSubsidiary,
        () => store.setConfirmSubsidiary(sessionId, !confirmSubsidiary),
        confirmSubsidiary ? '点击关闭：明确要求后直接执行附属动作' : '点击开启：执行附属动作前先弹确认框',
        '附属动作弹窗确认',
      )

      const focusRow = switchRow(
        'focus',
        '专注模式（沙箱已禁用）',
        focusMode
          ? '已开启：沙箱不可用，仅支持手工列式；联网、文件读写、子任务等附属动作需你明确要求并经确认。'
          : '适合高可信度要求的单一任务；支持快速核验 / 严谨精简 / 极致严谨三档；轻量快速核对选快速核验，日常使用默认严谨精简，正式核验再开启极致严谨；混合需求不建议开启专注模式。',
        focusMode,
        () => store.setFocusMode(sessionId, !focusMode),
        focusMode ? '点击关闭：恢复沙箱与原有能力' : '点击开启：禁用沙箱，按档位控制复核深度',
        '专注模式',
      )

      // 严谨等级滑块：3 锚点吸附，可拖动或点击锚点跳档；专注模式关闭时整体置灰。
      // 未知/非法档位（旧缓存、Host 旧版）一律回落到默认档【严谨精简】，绝不抛错。
      const foundRigor = rigors.findIndex(level => level.id === rigor)
      const rigorIndex = foundRigor >= 0 ? foundRigor : Math.min(1, rigors.length - 1)
      const rigorCount = Math.max(2, rigors.length)
      const rigorPct = (rigorIndex / (rigorCount - 1)) * 100
      const indexAt = (clientX) => {
        const element = trackRef.current
        if (!element || rigors.length === 0) return 0
        const rect = element.getBoundingClientRect()
        if (!rect || rect.width <= 0) return 0
        const ratio = (clientX - rect.left) / rect.width
        return Math.max(0, Math.min(rigors.length - 1, Math.round(ratio * (rigors.length - 1))))
      }
      const applyIndex = (index) => {
        if (!focusMode) return
        const level = rigors[index]
        if (level && level.id !== rigor) store.setRigor(sessionId, level.id)
      }
      const onKnobDown = (event) => {
        if (!focusMode || draggingRef.current) return
        draggingRef.current = true
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        const knob = knobRef.current
        const fill = fillRef.current
        // While dragging, both tracks follow the pointer directly (no transition lag),
        // always written together so the dot and the fill can never drift apart.
        if (knob) {
          knob.style.transition = 'none'
          if (knob.classList) knob.classList.add('tf-dragging')
        }
        if (fill) fill.style.transition = 'none'
        const move = (moveEvent) => {
          const element = trackRef.current
          if (!element || !knob) return
          const rect = element.getBoundingClientRect()
          if (!rect || rect.width <= 0) return
          const ratio = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width))
          knob.style.left = (ratio * 100) + '%'
          if (fill) fill.style.width = (ratio * 100) + '%'
        }
        const up = (upEvent) => {
          draggingRef.current = false
          if (typeof window !== 'undefined') {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            window.removeEventListener('pointercancel', up)
          }
          if (knob) {
            knob.style.transition = 'left 180ms cubic-bezier(0.34, 1.32, 0.64, 1), transform 120ms ease-out'
            if (knob.classList) knob.classList.remove('tf-dragging')
            knob.style.left = rigorPct + '%'
          }
          if (fill) {
            fill.style.transition = 'width 180ms cubic-bezier(0.34, 1.32, 0.64, 1)'
            fill.style.width = rigorPct + '%'
          }
          applyIndex(indexAt(upEvent.clientX))
        }
        if (typeof window !== 'undefined') {
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
          window.addEventListener('pointercancel', up)
        }
      }

      const rigorRow = h('div', {
        key: 'rigor',
        'aria-label': '严谨等级',
        'data-rigor-row': focusMode ? 'on' : 'off',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '2px 2px 0 2px',
          opacity: focusMode ? 1 : 0.55,
          transition: 'opacity 160ms ease-out',
        },
      }, [
        h('span', { key: 'name', style: { fontSize: '11px', color: T.fgSoft, flex: '0 0 auto' } }, '严谨等级'),
        hh('div', {
          key: 'slider',
          className: 'tf-rigor' + (focusMode ? '' : ' is-off'),
          'aria-disabled': !focusMode,
          onClick: (event) => applyIndex(indexAt(event.clientX)),
          style: { position: 'relative', flex: '1 1 auto', height: '22px', minWidth: '120px', cursor: focusMode ? 'pointer' : 'default' },
        }, [
          h('div', {
            key: 'track',
            ref: trackRef,
            className: 'tf-rigor-track',
            style: {
              position: 'absolute',
              top: '10px',
              left: 0,
              right: 0,
              height: '3px',
              borderRadius: '2px',
              background: T.border,
              transition: 'background 180ms ease-out',
            },
          }),
          h('div', {
            key: 'fill',
            ref: fillRef,
            className: 'tf-rigor-fill',
            style: {
              position: 'absolute',
              top: '10px',
              left: 0,
              width: rigorPct + '%',
              height: '3px',
              borderRadius: '2px',
              background: focusMode ? T.brand : T.border,
              opacity: focusMode ? 0.85 : 0.5,
              transition: 'width 180ms cubic-bezier(0.34, 1.32, 0.64, 1), background 180ms ease-out',
            },
          }),
          ...rigors.map((level, index) => h('div', {
            key: 'tick-' + level.id,
            'data-tick': level.id,
            'aria-hidden': 'true',
            style: {
              position: 'absolute',
              top: '9px',
              left: ((index / (rigorCount - 1)) * 100) + '%',
              width: '5px',
              height: '5px',
              marginLeft: '-2.5px',
              borderRadius: '50%',
              background: T.fgSoft,
              opacity: 0.26,
              pointerEvents: 'none',
            },
          })),
          ...rigors.map((level, index) => h('button', {
            key: 'anchor-' + level.id,
            type: 'button',
            'data-rigor': level.id,
            'data-anchor-index': index,
            disabled: !focusMode,
            title: level.tooltip || level.detail,
            'aria-label': level.label,
            onClick: () => applyIndex(index),
            style: {
              position: 'absolute',
              top: '3px',
              left: ((index / (rigorCount - 1)) * 100) + '%',
              width: '12px',
              height: '12px',
              marginLeft: '-6px',
              borderRadius: '50%',
              border: 'none',
              padding: 0,
              background: 'transparent',
              cursor: focusMode ? 'pointer' : 'default',
            },
          })),
          h('div', {
            key: 'knob',
            ref: knobRef,
            className: 'tf-rigor-knob',
            role: 'slider',
            tabIndex: focusMode ? 0 : -1,
            'aria-valuemin': 0,
            'aria-valuemax': rigorCount - 1,
            'aria-valuenow': rigorIndex,
            'aria-valuetext': (rigors[rigorIndex] || {}).label || '严谨精简',
            'aria-disabled': !focusMode,
            title: (rigors[rigorIndex] || {}).tooltip || '',
            onPointerDown: onKnobDown,
            onKeyDown: (event) => {
              if (!focusMode) return
              if (event.key === 'ArrowLeft') applyIndex(Math.max(0, rigorIndex - 1))
              if (event.key === 'ArrowRight') applyIndex(Math.min(rigorCount - 1, rigorIndex + 1))
            },
            style: {
              position: 'absolute',
              top: '4px',
              left: rigorPct + '%',
              width: '14px',
              height: '14px',
              marginLeft: '-7px',
              borderRadius: '50%',
              background: focusMode ? T.brand : T.fgSoft,
              opacity: focusMode ? 1 : 0.55,
              cursor: focusMode ? 'grab' : 'default',
              touchAction: 'none',
              transition: 'left 180ms cubic-bezier(0.34, 1.32, 0.64, 1), transform 120ms ease-out, background 180ms ease-out',
            },
          }),
        ]),
        h('span', {
          key: 'value',
          style: {
            fontSize: '11px',
            lineHeight: '16px',
            color: focusMode ? T.fg : T.fgSoft,
            flex: '0 0 auto',
            minWidth: '56px',
            textAlign: 'right',
            transition: 'color 180ms ease-out',
          },
        }, h('span', { key: rigor, className: 'tf-fade' }, (rigors[rigorIndex] || {}).label || '严谨精简')),
      ])

      const markersRow = switchRow(
        'markers',
        '显示执行方式标记',
        showMarkers
          ? '已开启：结论前会标注【沙箱执行】或【手工列式验算】。'
          : '已关闭：不显示执行方式标记，正文更干净。',
        showMarkers,
        () => store.setShowMarkers(sessionId, !showMarkers),
        showMarkers ? '点击关闭：隐藏执行方式标记' : '点击开启：结论前标注执行方式',
        '是否显示执行方式标记',
      )

      const statusLines = []
      if (active && locked) statusLines.push('锁定模式｜当前域：' + (current ? current.label.replace('聚焦模式', '') : '通用') + '，禁止自动跨域')
      if (focusMode) statusLines.push('专注模式｜沙箱已禁用，仅支持手工列式计算｜档位：' + rigorLabel)
      if (confirmSubsidiary) statusLines.push('附属动作需要确认弹窗')
      const statusBar = statusLines.length > 0
        ? h('div', {
          key: 'status',
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            fontSize: '11px',
            lineHeight: '16px',
            color: T.fg,
            minWidth: 0,
            maxWidth: '100%',
          },
        }, statusLines.map((line, index) => h('span', {
          key: 'status-' + index,
          title: line,
          style: {
            padding: '1px 7px',
            borderRadius: '9px',
            border: '1px solid ' + T.border,
            background: T.layer2,
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: T.fg,
          },
        }, line)))
        : null

      const focusGuide = focusMode && state.focusGuideSeen !== true
        ? hh('div', {
          key: 'focus-guide',
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '6px 8px',
            borderRadius: '8px',
            border: '1px solid ' + T.brand,
            background: T.layer2,
            fontSize: '11px',
            lineHeight: '16px',
            color: T.fg,
          },
        }, [
          h('span', { key: 'text', style: { flex: '1 1 auto' } },
            '专注模式提示：适合只做单一类型任务时启用，会限制沙箱、外部附属能力；有混合需求、需要交替使用多种工具的场景，请不要开启专注模式。'),
          h('button', {
            key: 'ok',
            type: 'button',
            onClick: () => store.dismissFocusGuide(sessionId),
            title: '不再显示这条引导',
            style: {
              height: '20px',
              padding: '0 8px',
              borderRadius: '6px',
              border: 'none',
              background: T.brand,
              color: '#fff',
              font: 'inherit',
              fontSize: '11px',
              cursor: 'pointer',
              flex: '0 0 auto',
            },
          }, '知道了'),
        ])
        : null

      const footerItems = [
        h('button', {
          key: 'reset',
          type: 'button',
          disabled: !active,
          onClick: () => store.reset(sessionId),
          title: '一键切回通用默认模式',
          style: {
            height: '24px',
            padding: '0 10px',
            borderRadius: '6px',
            font: 'inherit',
            fontSize: '11px',
            cursor: active ? 'pointer' : 'default',
            color: active ? T.fg : T.fgSoft,
            background: 'transparent',
            border: '1px solid ' + T.border,
            opacity: active ? 1 : 0.55,
          },
        }, '重置为通用模式'),
      ]

      if (blocked > 0 || passed > 0) {
        footerItems.push(h('span', {
          key: 'counts',
          style: { fontSize: '11px', color: T.fgSoft },
        }, '已拦截 ' + blocked + ' 次' + (passed > 0 ? ' · 附属放行 ' + passed + ' 次' : '')))
      }
      if (active && !locked && threshold > 0) {
        footerItems.push(h('span', {
          key: 'streak',
          style: { fontSize: '11px', color: T.fgSoft },
        }, '偏离计数 ' + Math.min(streak, threshold) + '/' + threshold))
      }
      if (entry.error) {
        footerItems.push(h('span', {
          key: 'error',
          style: { fontSize: '11px', color: T.error },
        }, '同步失败：' + entry.error))
      } else if (entry.loading && !entry.state) {
        footerItems.push(h('span', {
          key: 'loading',
          style: { fontSize: '11px', color: T.fgSoft },
        }, '同步中…'))
      }

      const footer = hh('div', {
        key: 'footer',
        style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      }, footerItems)

      const banner = notice
        ? hh('div', {
          key: 'notice',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 8px',
            borderRadius: '8px',
            border: '1px solid ' + T.border,
            background: T.layer2,
            fontSize: '11px',
            lineHeight: '16px',
            color: T.fg,
          },
        }, [
          h('span', { key: 'text', style: { flex: '1 1 auto' } },
            '已自动切回通用模式（' + reasonText(notice.reason) + '），原模式：' + (notice.fromLabel || notice.from)),
          undoMode
            ? h('button', {
              key: 'undo',
              type: 'button',
              onClick: () => store.setMode(sessionId, undoMode.id),
              title: '恢复自动回退前的模式',
              style: {
                height: '22px',
                padding: '0 8px',
                borderRadius: '6px',
                border: '1px solid ' + T.border,
                background: 'transparent',
                color: T.fg,
                font: 'inherit',
                fontSize: '11px',
                cursor: 'pointer',
              },
            }, '恢复 ' + undoMode.short)
            : null,
          h('button', {
            key: 'dismiss',
            type: 'button',
            onClick: () => store.dismissNotice(sessionId),
            title: '不再显示这条提示',
            style: {
              height: '22px',
              padding: '0 8px',
              borderRadius: '6px',
              border: 'none',
              background: 'transparent',
              color: T.fgSoft,
              font: 'inherit',
              fontSize: '11px',
              cursor: 'pointer',
            },
          }, '知道了'),
        ])
        : null

      return h('div', {
        style: { display: 'flex', justifyContent: 'center', padding: '0 12px 8px 12px' },
      }, hh('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '7px',
          width: '100%',
          maxWidth: '760px',
          padding: '10px 12px',
          borderRadius: '12px',
          border: '1px solid ' + T.border,
          background: T.layer1,
          color: T.fg,
          font: 'inherit',
          fontSize: '11px',
          boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
        },
      }, [
        h('style', { key: 'tf-slider-style' },
          '.tf-fade{animation:tf-fade-in 120ms ease-out}' +
          '@keyframes tf-fade-in{from{opacity:0}to{opacity:1}}' +
          '.tf-rigor-knob:hover{transform:scale(1.05)}' +
          '.tf-rigor-knob:active{cursor:grabbing}' +
          '.tf-rigor-knob.tf-dragging{box-shadow:0 0 0 4px rgba(77,107,254,0.14)}' +
          '.tf-rigor-track{opacity:.85}' +
          '.tf-rigor-track:hover{opacity:1}' +
          '.tf-rigor.is-off .tf-rigor-track{opacity:.5}' +
          '.tf-rigor button:disabled{cursor:default}' +
          // 尊重系统的"减少动态效果"设置：只保留即时跳变，不做过渡
          '@media (prefers-reduced-motion: reduce){' +
          '.tf-fade{animation:none}' +
          '.tf-rigor-knob,.tf-rigor-fill,.tf-rigor-knob:hover{transition:none;transform:none}' +
          '}'),
        header,
        statusBar,
        focusGuide,
        selector,
        brief,
        // 层级顺序固定：专注模式开关 → 严谨等级滑块 → 其他设置项
        focusRow,
        rigorRow,
        lockRow,
        confirmRow,
        markersRow,
        footer,
        banner,
      ]))
    }

    return {
      inject: ['slots'],
      // Layout helpers exist only for the headless render test; they are not
      // part of the shipped production surface.
      ...(typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production'
        ? {}
        : { __internals: { layoutTabs, chipWidth } }),
      apply (ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'focus-mode-chip',
          order: 12,
          label: () => '任务域聚焦',
        }, FocusChip))

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'focus-mode-panel',
          order: 30,
          label: () => '任务域聚焦面板',
        }, FocusPanel))
      },
    }
  },
})
