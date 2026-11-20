/**
 * dsh-focus-mode — Host half.
 *
 * One job: converge a session's reasoning budget and context attention onto the
 * task domain the user picked, and stop the two behaviors that waste it.
 *
 * 1. **Directional layer (primary)** — one system-prompt section carrying the
 *    deployment's verbatim guidance for the mode. It asks the model to spend its
 *    reasoning on rigor, accuracy and depth inside the domain, and to stop
 *    expanding scope, free-associating and gold-plating.
 * 2. **Gate layer (fallback)** — `tools/pre-execute` enforces exactly three
 *    action classes, matching the guidance:
 *      - **main domain** → allow, that is the work being optimized for;
 *      - **subsidiary action** → only when the user asked for it in their own
 *        words; a self-invented subsidiary action is denied with no dialog;
 *      - **fully cross-domain** → denied, with no pass option at all.
 *    Anything whose domain is not named by the call itself passes untouched:
 *    writing source files, reading, searching and running commands is how every
 *    domain works, and blocking it would fight the focus this plugin protects.
 *
 * Boundaries that matter for review:
 *   - no `approval/request` listener, no `tools/guard`, never a `{kind:'ask'}`
 *     decision: an approval answerer (AutoConsent, or the human) keeps full
 *     authority, and this gate can only ever narrow — a denied call never
 *     reaches the approval chain at all;
 *   - registered *after* prepared approvers (they prepend), so their verdict
 *     wins and this gate only ever sees calls they already allowed;
 *   - the optional subsidiary dialog uses the **question channel**, not the
 *     approval chain, and only when the user turned the switch on;
 *   - every failure path fails open (`next()`), so a bug here degrades to plain
 *     guidance instead of blocking work.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  DEFAULT_MODE_ID,
  DOMAIN_LABELS,
  MODES,
  MODE_IDS,
  askedSubsidiary,
  classifyIntent,
  classifyToolCall,
  isModeId,
  publicModes,
  renderGuidance,
  subsidiaryForDomain,
} from './modes.js'
import {
  BRIEF_LINE,
  DEFAULT_RIGOR,
  HEAVY_PROMPT,
  MANUAL_NOTE,
  RIGOR_LEVELS,
  detectSoftIntent,
  isRigorId,
  isSandboxTool,
  lockRefusal,
  looksHeavy,
  numbersIn,
  rigorGuidance,
  riskQuestion,
  subsidiaryOf,
  userAskedFor,
  userForbadeSandbox,
  wantsBrief,
} from './actions.js'

/** Must equal package.json `name` exactly, or install validation rejects the package. */
export const name = 'dsh-focus-mode'

/** The HTTP surface is the only hard dependency; everything else is optional. */
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-focus-mode'
const SECTION_NAME = 'focus-mode:policy'
const STORE_VERSION = 3
const MAX_SESSIONS = 300
const NOTICE_TTL_MS = 10 * 60 * 1000
const QUESTION_ID = 'focus-mode-subsidiary'
const SUBSIDIARY_RUN_LABEL = '执行'
const SUBSIDIARY_SKIP_LABEL = '跳过'

function num (value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function int (value, fallback, min, max) {
  return Math.round(clamp(num(value, fallback), min, max))
}

function text (value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function dshHome () {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(os.homedir(), '.dsh')
}

/** The single directory this plugin is allowed to write to. */
const STORAGE_DIR = 'dsh-focus-mode'

function storageBaseDir () {
  return path.join(dshHome(), 'storages', STORAGE_DIR)
}

function defaultStorageFile () {
  return path.join(storageBaseDir(), 'state.json')
}

/**
 * Confine the store to <dshHome>/storages/dsh-focus-mode/.
 * A configured path outside that directory is refused and replaced by the
 * default state.json, so the plugin can never be pointed at an arbitrary file.
 * @param configured - the raw config value.
 * @returns the storage file path that is guaranteed to be inside the plugin dir.
 */
function resolveStorageFile (configured) {
  const fallback = defaultStorageFile()
  if (typeof configured !== 'string' || !configured.trim()) return fallback
  const base = storageBaseDir()
  const resolved = path.resolve(configured.trim())
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : fallback
}

function normalizeConfig (raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: cfg.enabled !== false,
    enforce: cfg.enforce !== false,
    confirmSubsidiary: cfg.confirmSubsidiary === true,
    focusModeByDefault: cfg.focusModeByDefault === true,
    showMarkersByDefault: cfg.showMarkersByDefault !== false,
    rigorByDefault: isRigorId(cfg.rigorByDefault) ? cfg.rigorByDefault : DEFAULT_RIGOR,
    handLimit: int(cfg.handLimit, 200, 1, 1000000),
    defaultMode: isModeId(cfg.defaultMode) ? cfg.defaultMode : DEFAULT_MODE_ID,
    lockByDefault: cfg.lockByDefault !== false,
    offTopicRevertAfter: int(cfg.offTopicRevertAfter, 3, 0, 50),
    idleRevertMinutes: int(cfg.idleRevertMinutes, 0, 0, 1440),
    persist: cfg.persist !== false,
    storageFile: resolveStorageFile(cfg.storageFile),
    retentionDays: int(cfg.retentionDays, 30, 1, 3650),
    sectionOrder: num(cfg.sectionOrder, 520),
    pollMs: int(cfg.pollMs, 15000, 2000, 120000),
    sweepSeconds: int(cfg.sweepSeconds, 30, 5, 600),
    defaultPanelOpen: cfg.defaultPanelOpen === true,
  }
}

function sessionIdOf (agent) {
  if (!agent || typeof agent !== 'object') return undefined
  const candidates = [
    agent.session && agent.session.id,
    agent.session && agent.session.header && agent.session.header.id,
    agent.sessionId,
    agent.id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return undefined
}

/** Whether a logged `user/message` came from the human (not from a plugin notice). */
function isUserAuthored (data) {
  if (!data || typeof data !== 'object') return false
  const source = data.source
  if (!source || typeof source !== 'object') return true
  return source.kind === undefined || source.kind === 'user'
}

/** Flatten the text blocks of one logged message. */
function textOfMessage (data) {
  const message = data && typeof data === 'object' ? data : {}
  const blocks = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.message && message.message.content)
      ? message.message.content
      : []
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string' && (block.type === 'text' || block.type === undefined)) {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

function readBody (req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Custom header every mutating request must carry. */
const MUTATION_HEADER = 'x-dsh-focus'

/**
 * Same-origin + custom-header guard for every mutating route.
 * A browser cannot attach a custom header cross-origin without a CORS preflight,
 * and the app never answers one, so this blocks cross-session tampering from a
 * foreign page while staying invisible to the first-party panel.
 * @param req - the incoming request.
 * @returns true when allowed, otherwise the rejection reason.
 */
function guardMutation (req) {
  const headers = (req && req.headers) || {}
  if (headers[MUTATION_HEADER] !== '1') return 'missing ' + MUTATION_HEADER + ' header'
  const host = headers.host || ''
  const sameOrigin = (value) => {
    if (!value) return true
    try {
      return new URL(value).host === host
    } catch {
      return false
    }
  }
  if (!sameOrigin(headers.origin)) return 'cross-origin Origin rejected'
  if (!sameOrigin(headers.referer)) return 'cross-origin Referer rejected'
  return true
}

function sendJson (res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * The plugin body. Intentionally NOT exported as `apply`: keeping the module
 * namespace free of an `apply` property guarantees the default export below is
 * the only plugin entry, so no lifecycle (effects, listeners, timers) registers
 * twice.
 */
function applyPlugin (ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (...args) => {
    try { ctx.logger?.info?.('[focus-mode]', ...args) } catch {}
  }
  const warn = (...args) => {
    try { ctx.logger?.warn?.('[focus-mode]', ...args) } catch {}
  }

  /** Session id → mode state. Entries exist only after a user acts on a session. */
  const sessions = new Map()

  let persistTimer = null
  /** Assigned inside the lifecycle effect so the debounce timer is effect-owned. */
  let armPersistTimer = () => {}
  let persistInFlight = null
  let dirty = false
  let restored = false
  const hits = { total: 0, lastAt: null, lastError: null }
  /** Last assembly-time decision, surfaced by `GET /dsh-focus-mode/state`. */
  let lastRender = null
  /** Last gate decision, surfaced by the same endpoint. */
  let lastGate = null
  let sectionRegistered = false

  // ---- state -----------------------------------------------------------

  const emptyEntry = (sessionId) => ({
    id: sessionId,
    mode: config.defaultMode,
    lock: config.lockByDefault,
    confirmSubsidiary: config.confirmSubsidiary,
    focusMode: config.focusModeByDefault,
    showMarkers: config.showMarkersByDefault,
    rigor: config.rigorByDefault,
    focusGuideSeen: false,
    sandboxFailedAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUserAt: 0,
    lastUserText: '',
    streak: 0,
    running: false,
    pendingRevert: null,
    notice: null,
    stats: { blocked: 0, passed: 0 },
  })

  const entryFor = (sessionId) => {
    let entry = sessions.get(sessionId)
    if (!entry) {
      entry = emptyEntry(sessionId)
      sessions.set(sessionId, entry)
      markDirty()
    }
    return entry
  }

  const markDirty = () => {
    dirty = true
    schedulePersist()
  }

  /** Return the session to the general mode because the user drifted away. */
  const applyRevert = (entry, reason) => {
    const from = entry.mode
    entry.pendingRevert = null
    entry.streak = 0
    if (from === DEFAULT_MODE_ID) return
    entry.mode = DEFAULT_MODE_ID
    entry.updatedAt = Date.now()
    entry.notice = {
      kind: 'auto-revert',
      at: entry.updatedAt,
      from,
      fromLabel: MODES[from] ? MODES[from].label : from,
      to: DEFAULT_MODE_ID,
      reason,
    }
    markDirty()
    log('auto-revert', entry.id, from, '->general (' + reason + ')')
  }

  const setMode = (sessionId, modeId) => {
    if (!isModeId(modeId)) throw new Error('未知的模式 id: ' + String(modeId))
    const entry = entryFor(sessionId)
    entry.mode = modeId
    entry.streak = 0
    entry.pendingRevert = null
    entry.notice = null
    entry.updatedAt = Date.now()
    markDirty()
    return entry
  }

  const setLock = (sessionId, lock) => {
    const entry = entryFor(sessionId)
    entry.lock = lock === true
    if (entry.lock) entry.pendingRevert = null
    // 切换开关就是换了一种约束状态，旧的偏离计数不再适用。
    entry.streak = 0
    entry.updatedAt = Date.now()
    markDirty()
    return entry
  }

  const setConfirmSubsidiary = (sessionId, confirm) => {
    const entry = entryFor(sessionId)
    entry.confirmSubsidiary = confirm === true
    entry.updatedAt = Date.now()
    markDirty()
    return entry
  }

  const setFocusMode = (sessionId, on) => {
    const entry = entryFor(sessionId)
    entry.focusMode = on === true
    entry.sandboxFailedAt = 0
    // 开关专注模式后，偏离计数从 0/3 重新开始。
    entry.streak = 0
    entry.pendingRevert = null
    entry.updatedAt = Date.now()
    markDirty()
    return entry
  }

  const setShowMarkers = (sessionId, on) => {
    const entry = entryFor(sessionId)
    entry.showMarkers = on === true
    entry.updatedAt = Date.now()
    markDirty()
    return entry
  }

  const setRigor = (sessionId, level) => {
    if (!isRigorId(level)) throw new Error('未知的严谨档位: ' + String(level))
    const entry = entryFor(sessionId)
    entry.rigor = level
    entry.updatedAt = Date.now()
    markDirty()
    return entry
  }

  const seenFocusGuide = (sessionId) => {
    const entry = entryFor(sessionId)
    if (entry.focusGuideSeen) return entry
    entry.focusGuideSeen = true
    entry.updatedAt = Date.now()
    markDirty()
    return entry
  }

  const markSandboxFailure = (sessionId) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    entry.sandboxFailedAt = Date.now()
    markDirty()
  }

  const resetMode = (sessionId) => {
    const entry = entryFor(sessionId)
    entry.mode = DEFAULT_MODE_ID
    entry.streak = 0
    entry.pendingRevert = null
    entry.notice = null
    entry.updatedAt = Date.now()
    markDirty()
    return entry
  }

  const dismissNotice = (sessionId) => {
    const entry = sessions.get(sessionId)
    if (!entry || !entry.notice) return entry || null
    entry.notice = null
    entry.updatedAt = Date.now()
    markDirty()
    return entry
  }

  const bump = (entry, key) => {
    if (!entry.stats || typeof entry.stats[key] !== 'number') entry.stats = { blocked: 0, passed: 0 }
    entry.stats[key] += 1
    entry.updatedAt = Date.now()
  }

  /**
   * Score one user message against the session's mode and remember the drift
   * streak (only used when the lock is off — the lock is what keeps the mode).
   */
  const noteUserMessage = (sessionId, messageText) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    entry.lastUserAt = Date.now()
    entry.lastUserText = messageText.slice(0, 2000)
    if (!config.enabled || entry.mode === DEFAULT_MODE_ID || entry.lock) {
      entry.streak = 0
      return
    }
    if (config.offTopicRevertAfter <= 0) return
    const verdict = classifyIntent(messageText, MODES[entry.mode])
    if (verdict === 'focus') entry.streak = 0
    if (verdict === 'offtopic') entry.streak += 1
    if (entry.streak >= config.offTopicRevertAfter) {
      if (entry.running) entry.pendingRevert = 'off-topic'
      else applyRevert(entry, 'off-topic')
    }
  }

  // ---- persistence -----------------------------------------------------

  const serialize = () => ({
    version: STORE_VERSION,
    savedAt: Date.now(),
    sessions: [...sessions.values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_SESSIONS)
      .map(entry => ({
        id: entry.id,
        mode: entry.mode,
        lock: entry.lock,
        confirmSubsidiary: entry.confirmSubsidiary,
        focusMode: entry.focusMode,
        showMarkers: entry.showMarkers,
        rigor: entry.rigor,
        focusGuideSeen: entry.focusGuideSeen,
        sandboxFailedAt: entry.sandboxFailedAt,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastUserAt: entry.lastUserAt,
        stats: entry.stats,
        notice: entry.notice,
      })),
  })

  const persistNow = async () => {
    if (!config.persist) {
      dirty = false
      return
    }
    if (persistInFlight) {
      await persistInFlight.catch(() => {})
      if (!dirty) return
    }
    dirty = false
    persistInFlight = (async () => {
      try {
        await fs.mkdir(path.dirname(config.storageFile), { recursive: true })
        await fs.writeFile(config.storageFile, JSON.stringify(serialize(), null, 2), 'utf8')
      } catch (error) {
        warn('persist failed:', error && error.message)
      } finally {
        persistInFlight = null
      }
    })()
    await persistInFlight
  }

  const schedulePersist = () => {
    if (!config.persist || persistTimer) return
    armPersistTimer()
  }

  const restore = async () => {
    if (!config.persist) {
      restored = true
      return
    }
    try {
      const raw = await fs.readFile(config.storageFile, 'utf8')
      const saved = JSON.parse(raw)
      const list = saved && Array.isArray(saved.sessions) ? saved.sessions : []
      for (const item of list) {
        if (!item || typeof item.id !== 'string' || !item.id) continue
        if (sessions.has(item.id)) continue
        const stats = item.stats && typeof item.stats === 'object'
          ? { blocked: num(item.stats.blocked, 0), passed: num(item.stats.passed, 0) }
          : { blocked: 0, passed: 0 }
        sessions.set(item.id, {
          ...emptyEntry(item.id),
          mode: isModeId(item.mode) ? item.mode : DEFAULT_MODE_ID,
          lock: item.lock === true,
          confirmSubsidiary: typeof item.confirmSubsidiary === 'boolean' ? item.confirmSubsidiary : config.confirmSubsidiary,
          focusMode: typeof item.focusMode === 'boolean' ? item.focusMode : config.focusModeByDefault,
          showMarkers: typeof item.showMarkers === 'boolean' ? item.showMarkers : config.showMarkersByDefault,
          rigor: isRigorId(item.rigor) ? item.rigor : config.rigorByDefault,
          focusGuideSeen: item.focusGuideSeen === true,
          sandboxFailedAt: num(item.sandboxFailedAt, 0),
          createdAt: num(item.createdAt, Date.now()),
          updatedAt: num(item.updatedAt, Date.now()),
          lastUserAt: num(item.lastUserAt, 0),
          stats,
          notice: item.notice && typeof item.notice === 'object' ? item.notice : null,
        })
      }
      log('restored', sessions.size, 'session(s) from', config.storageFile)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') warn('restore failed:', error && error.message)
    } finally {
      restored = true
    }
  }

  const prune = (now) => {
    const cutoff = now - config.retentionDays * 24 * 60 * 60 * 1000
    for (const [id, entry] of sessions) {
      if ((entry.updatedAt || 0) < cutoff) {
        sessions.delete(id)
        dirty = true
      }
    }
    if (sessions.size > MAX_SESSIONS) {
      const ordered = [...sessions.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      const excess = sessions.size - MAX_SESSIONS
      for (let i = 0; i < excess; i += 1) {
        sessions.delete(ordered[i].id)
        dirty = true
      }
    }
  }

  const expireNotices = (now) => {
    for (const entry of sessions.values()) {
      if (entry.notice && now - num(entry.notice.at, now) > NOTICE_TTL_MS) {
        entry.notice = null
        dirty = true
      }
    }
  }

  const sweep = () => {
    try {
      if (!restored) return
      const now = Date.now()
      for (const entry of sessions.values()) {
        if (entry.pendingRevert && !entry.running) {
          applyRevert(entry, entry.pendingRevert)
          continue
        }
        if (config.idleRevertMinutes <= 0) continue
        if (entry.lock || entry.mode === DEFAULT_MODE_ID || entry.running) continue
        if (!entry.lastUserAt) continue
        if (now - entry.lastUserAt >= config.idleRevertMinutes * 60 * 1000) applyRevert(entry, 'idle')
      }
      expireNotices(now)
      prune(now)
      if (dirty) void persistNow()
    } catch (error) {
      warn('sweep failed:', error && error.message)
    }
  }

  // ---- prompt guidance -------------------------------------------------

  const guidanceFor = (context) => {
    try {
      if (!config.enabled) {
        lastRender = { at: Date.now(), result: 'disabled' }
        return ''
      }
      const sessionId = sessionIdOf(context && context.agent)
      if (!sessionId) {
        lastRender = { at: Date.now(), result: 'no-agent-in-context' }
        return ''
      }
      const entry = sessions.get(sessionId)
      const modeId = entry ? entry.mode : config.defaultMode
      const base = modeId === DEFAULT_MODE_ID ? '' : renderGuidance(MODES[modeId])
      const extras = []
      if (entry && entry.focusMode) {
        extras.push('', '[专注模式已开启] 沙箱代码执行被禁用（不会再重试）；联网、文件读写、剪贴板、系统信息、子任务、OCR、文档解析等附属动作都受管控。')
        extras.push(rigorGuidance(entry.rigor || config.rigorByDefault))
        const budget = looksHeavy(entry.lastUserText || '', numbersIn(entry.lastUserText || ''), config.handLimit) ? '重型' : '轻量'
        extras.push(budget === '重型'
          ? '本次任务判定为重型计算：先提示「' + HEAVY_PROMPT + '」，用户确认后才继续手工列式；用户拒绝就终止该任务。手工结果末尾追加：' + MANUAL_NOTE
          : '本次任务判定为轻量计算：不走沙箱，直接手工列式/直接作答正常输出；若涉及数值推导，结果末尾追加：' + MANUAL_NOTE)
        if (wantsBrief(entry.lastUserText || '')) extras.push(BRIEF_LINE)
      }
      if (entry && Array.isArray(entry.softDenied) && entry.softDenied.length > 0) {
        extras.push('用户刚拒绝了以下动作，本次不要执行、也不要换个说法绕道：' + entry.softDenied.join('、') + '。')
      }
      if (entry && entry.showMarkers && (base !== '' || entry.focusMode)) {
        extras.push('执行方式标记：必须在回复正文最开头单独一行放置【沙箱执行】或【手工列式验算】，绝对不要写进代码块、行内代码或文件内容里，避免破坏代码格式。')
      }
      const rendered = [base, ...extras].filter(part => typeof part === 'string' && part !== '').join('\n')
      if (!rendered) {
        lastRender = { at: Date.now(), result: 'general', sessionId, mode: modeId }
        return ''
      }
      lastRender = { at: Date.now(), result: 'injected', sessionId, mode: modeId, chars: rendered.length }
      return rendered.includes('{{') ? rendered.split('{{').join('{ {') : rendered
    } catch (error) {
      lastRender = { at: Date.now(), result: 'error', error: String((error && error.message) || error) }
      warn('guidance failed, contributing no section:', error && error.message)
      return ''
    }
  }

  /**
   * Register the section on the live `systemPrompt` service.
   *
   * `ctx.get()` reads a service without an inject requirement, which is the path
   * that actually works here: a nested `ctx.inject([...], callback)` fiber does
   * not start for this bundle (verified against the running Host).
   */
  const registerSection = (owner) => {
    try {
      if (sectionRegistered) return
      const prompt = (owner && typeof owner.get === 'function' ? owner.get('systemPrompt') : undefined) ||
        (owner && owner.systemPrompt)
      if (!prompt || typeof prompt.section !== 'function') {
        warn('systemPrompt service is unavailable; task focus will not reach the model')
        return
      }
      const effect = owner && typeof owner.effect === 'function' ? owner.effect.bind(owner) : (fn) => fn()
      effect(() => prompt.section({
        name: SECTION_NAME,
        order: config.sectionOrder,
        text: (context) => guidanceFor(context),
      }))
      sectionRegistered = true
      log('prompt section registered:', SECTION_NAME, 'order', config.sectionOrder)
    } catch (error) {
      warn('section registration failed:', error && error.message)
    }
  }

  registerSection(ctx)
  if (!sectionRegistered && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['systemPrompt'], (owner) => { registerSection(owner) })
    } catch (error) {
      warn('inject(systemPrompt) failed:', error && error.message)
    }
  }

  // ---- capability tier (专注模式 + 附属动作) ----------------------------

  /** Capabilities gated whenever 锁定模式 / 附属确认 is on. */
  const GATED_IN_LOCK = new Set([
    'sandbox', 'file', 'web', 'download', 'clipboard', 'sysinfo',
    'subagentBatch', 'subagentRecursive', 'selfQuestion', 'ocr', 'docParse',
  ])

  /** 专注模式 gates everything. */
  const GATED_IN_FOCUS = new Set([...GATED_IN_LOCK, 'domainSwitch'])

  const CAPABILITY_PASS_LABEL = '本次临时放行'
  const CAPABILITY_DENY_LABEL = '拒绝'

  const focusSandboxText = (entry, why) => [
    '⛔ [专注模式] 沙箱已禁用，本次调用未执行。',
    why,
    `下一步：不要改用别的工具绕过。请直接用 LLM 手工列式验算完成任务，并在结果末尾追加一句：${MANUAL_NOTE}`,
    '专注模式只限制沙箱与外部附属能力，不降低主任务的算力与质量要求。',
  ].join('\n')

  const focusHeavyContinueText = () => [
    '⛔ [专注模式] 沙箱已禁用；用户已确认继续手工列式尝试。',
    `下一步：按手工列式推进，逐步列出算式与中间结果，末尾追加：${MANUAL_NOTE}`,
  ].join('\n')

  const focusHeavyStopText = () => [
    '⛔ [专注模式] 沙箱已禁用，且用户选择终止该高复杂度任务。',
    '下一步：停止计算，用一句话说明已按用户选择终止，并给出降低复杂度的建议（例如缩小数据量或关闭专注模式）。',
  ].join('\n')

  const denyCapabilityText = (entry, action, toolName, asked) => [
    `⛔ [${entry.focusMode ? '专注模式' : '附属动作管控'}] 已拦截附属动作「${action.label}」。`,
    `本次调用：${toolName}。${asked ? '用户提出了该动作，但未获授权执行。' : '用户这条提问里没有明确要求该附属动作。'}`,
    '下一步：不要执行、不要补做、不要用话术诱导用户手动执行，也不要主动输出代码、文件路径或下载链接，除非用户明确索要；清空本次附属调用意图，继续完成主域任务。',
  ].join('\n')

  const denySandboxBrokenText = (toolName) => [
    '⛔ [沙箱不可用] 本会话的沙箱启动已失败，不再重试。',
    `本次调用：${toolName} 已拦截，不会再次尝试。`,
    '下一步：改用不依赖沙箱的方式继续（手工列式或直接文本处理），不要重复提交同类命令。',
  ].join('\n')

  const askCapability = async (exec, entry, action) => {
    const questions = ctx.get('userQuestions')
    if (!questions || typeof questions.ask !== 'function') {
      warn('no userQuestions channel; denying the subsidiary action')
      return false
    }
    try {
      const answer = await questions.ask({
        questions: [{
          id: QUESTION_ID,
          header: entry.focusMode ? '专注模式' : '附属动作确认',
          question: `本次要执行附属动作「${action.label}」（工具 ${exec.name}），是否允许？`,
          detail: [
            entry.focusMode ? '当前处于专注模式：沙箱已禁用，其余附属动作需你确认。' : '当前开启了附属动作弹窗确认。',
            '选择【本次临时放行】只对这一次生效，不修改任何全局设置。',
          ].join('\n'),
          options: [
            { label: CAPABILITY_PASS_LABEL, description: '仅本次放行，不修改全局配置' },
            { label: CAPABILITY_DENY_LABEL, description: '拦截本次附属动作' },
          ],
          multiSelect: false,
        }],
        agent: exec.agent,
        signal: exec.signal,
      })
      const answers = answer && Array.isArray(answer.answers) ? answer.answers : []
      const chosen = answers.find(candidate => candidate && candidate.id === QUESTION_ID)
      if (!chosen) return false
      return Array.isArray(chosen.selected) && chosen.selected.includes(CAPABILITY_PASS_LABEL)
    } catch (error) {
      warn('capability dialog failed:', error && error.message)
      return false
    }
  }

  const askHeavyContinue = async (exec, entry) => {
    const questions = ctx.get('userQuestions')
    if (!questions || typeof questions.ask !== 'function') return false
    try {
      const answer = await questions.ask({
        questions: [{
          id: 'focus-mode-heavy',
          header: '专注模式',
          question: HEAVY_PROMPT,
          detail: '选择继续则由 LLM 手工列式推进，结果会附带误差提示；选择终止则结束该任务。',
          options: [
            { label: '继续手工列式', description: '接受手工验算的出错风险' },
            { label: '终止任务', description: '不再执行该计算' },
          ],
          multiSelect: false,
        }],
        agent: exec.agent,
        signal: exec.signal,
      })
      const answers = answer && Array.isArray(answer.answers) ? answer.answers : []
      const chosen = answers.find(candidate => candidate && candidate.id === 'focus-mode-heavy')
      return !!(chosen && Array.isArray(chosen.selected) && chosen.selected.includes('继续手工列式'))
    } catch (error) {
      warn('heavy-task dialog failed:', error && error.message)
      return false
    }
  }

  /**
   * Decide tiers 1–2. Returns a decision, or `undefined` to let the task-domain
   * lock look at the call.
   */
  const preDecide = async (exec, entry, next) => {
    const active = entry.focusMode === true || entry.confirmSubsidiary === true || entry.lock === true
    if (!active) return undefined

    // 专注模式: the sandbox is disabled outright — one attempt, no retries.
    if (entry.focusMode === true && isSandboxTool(exec.name)) {
      lastGate = { at: Date.now(), sessionId: entry.id, verdict: 'focus-sandbox', tool: exec.name }
      bump(entry, 'blocked')
      if (userForbadeSandbox(entry.lastUserText)) return { kind: 'deny', reason: focusSandboxText(entry, '用户已明确要求手工计算。'), info: { name: 'dsh-focus-mode', code: 'TASK_FOCUS_MANUAL_ONLY' } }
      if (looksHeavy(entry.lastUserText, numbersIn(entry.lastUserText), config.handLimit)) {
        const keepGoing = await askHeavyContinue(exec, entry)
        return {
          kind: 'deny',
          reason: keepGoing ? focusHeavyContinueText() : focusHeavyStopText(),
          info: { name: 'dsh-focus-mode', code: keepGoing ? 'TASK_FOCUS_HEAVY_MANUAL' : 'TASK_FOCUS_HEAVY_STOP' },
        }
      }
      return { kind: 'deny', reason: focusSandboxText(entry, '沙箱执行属于被禁用的能力。'), info: { name: 'dsh-focus-mode', code: 'TASK_FOCUS_SANDBOX_DISABLED' } }
    }

    // One sandbox attempt per session: a failed start must not be retried.
    if (!entry.focusMode && isSandboxTool(exec.name) && entry.sandboxFailedAt) {
      lastGate = { at: Date.now(), sessionId: entry.id, verdict: 'sandbox-broken', tool: exec.name }
      bump(entry, 'blocked')
      return { kind: 'deny', reason: denySandboxBrokenText(exec.name), info: { name: 'dsh-focus-mode', code: 'TASK_FOCUS_SANDBOX_FAILED' } }
    }

    const action = subsidiaryOf(exec.name)
    if (!action) return undefined

    // A cross-domain *task* outranks the capability message: let the domain-lock
    // tier answer with its own refusal copy.
    if (entry.lock && entry.mode !== DEFAULT_MODE_ID) {
      const signature = classifyToolCall(exec.name, exec.arguments)
      if (signature) {
        const mode = MODES[entry.mode]
        const allowedDomain = (mode.domains.core || []).includes(signature.domain) ||
          subsidiaryForDomain(mode, signature.domain) !== null
        if (!allowedDomain) return undefined
      }
    }
    const gated = entry.focusMode === true ? GATED_IN_FOCUS : GATED_IN_LOCK
    if (!gated.has(action.id)) return undefined

    const asked = userAskedFor(entry.lastUserText, action.id) ||
      !!(askedSubsidiary(entry.lastUserText, MODES[entry.mode]))
    if (!asked) {
      lastGate = { at: Date.now(), sessionId: entry.id, verdict: 'capability-self', tool: exec.name, action: action.id }
      bump(entry, 'blocked')
      return {
        kind: 'deny',
        reason: denyCapabilityText(entry, action, exec.name, false),
        info: { name: 'dsh-focus-mode', code: 'TASK_FOCUS_CAPABILITY_SELF', reason: `未获用户要求，拒绝「${action.label}」` },
      }
    }
    // Under 专注模式 every subsidiary action still needs the dialog.
    if (entry.confirmSubsidiary === true || entry.focusMode === true) {
      const granted = await askCapability(exec, entry, action)
      lastGate = { at: Date.now(), sessionId: entry.id, verdict: granted ? 'capability-passed' : 'capability-denied', tool: exec.name, action: action.id }
      if (granted) {
        bump(entry, 'passed')
        return next()
      }
      bump(entry, 'blocked')
      return {
        kind: 'deny',
        reason: denyCapabilityText(entry, action, exec.name, true),
        info: { name: 'dsh-focus-mode', code: 'TASK_FOCUS_CAPABILITY_DENIED' },
      }
    }
    lastGate = { at: Date.now(), sessionId: entry.id, verdict: 'capability-allowed', tool: exec.name, action: action.id }
    bump(entry, 'passed')
    return next()
  }

  // ---- intent-only risks (读取剪贴板 / 自动跨域切换) ----------------------

  /**
   * These two have no wire tool, so they cannot be force-blocked. Recognise the
   * intent in the user's message and raise the advisory dialog instead.
   */
  const askRisk = async (sessionId, entry, action) => {
    const questions = ctx.get('userQuestions')
    const agents = ctx.get('agents')
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (!questions || typeof questions.ask !== 'function' || !agent) {
      warn('no question channel/agent for the advisory dialog; recording a refusal')
      return false
    }
    try {
      const answer = await questions.ask({
        questions: [{
          id: 'focus-mode-risk-' + action.id,
          header: '附属动作确认',
          question: riskQuestion(action.label),
          detail: '该项在框架层没有可拦截的工具调用，插件只能按意图提醒；拒绝后模型会被要求不要执行该动作。',
          options: [
            { label: '本次临时放行', description: '仅本次放行，不修改全局配置' },
            { label: '拒绝', description: '记录拒绝，并要求模型不要执行' },
          ],
          multiSelect: false,
        }],
        agent,
      })
      const answers = answer && Array.isArray(answer.answers) ? answer.answers : []
      const chosen = answers.find(item => item && item.id === 'focus-mode-risk-' + action.id)
      return !!(chosen && Array.isArray(chosen.selected) && chosen.selected.includes('本次临时放行'))
    } catch (error) {
      warn('advisory dialog failed:', error && error.message)
      return false
    }
  }

  const handleSoftIntent = async (sessionId, entry, messageText) => {
    try {
      const hits = detectSoftIntent(messageText)
      if (hits.length === 0) return
      const denied = []
      for (const hit of hits) {
        lastGate = { at: Date.now(), sessionId, verdict: 'intent-risk', action: hit.id, matched: hit.matched }
        const allowed = await askRisk(sessionId, entry, hit)
        if (!allowed) denied.push(hit.label)
      }
      entry.softDenied = denied
      markDirty()
    } catch (error) {
      warn('soft intent handling failed:', error && error.message)
    }
  }

  // ---- the gate --------------------------------------------------------

  const brandOf = (mode) => `当前模式：${mode.label}｜主域：${mode.core.join('、')}` +
    (mode.subsidiary.length > 0 ? `｜附属：${mode.subsidiary.map(item => item.label).join('、')}` : '')

  /** Task-domain lock refusal — the verbatim copy from the product spec. */
  const denyCrossText = (mode, signature, toolName) => {
    const domainLabel = DOMAIN_LABELS[mode.id] || mode.label
    return [
      lockRefusal(domainLabel),
      '',
      `（拦截明细：${toolName} → ${signature.evidence}；当前锁定域：${mode.label}；主域：${mode.core.join('、')}）`,
      '聚焦约束不替代、不绕过任何权限与安全审批。',
    ].join('\n')
  }

  /** Subsidiary action the model invented on its own: refused, no dialog. */
  const denySubsidiaryText = (mode, item, signature, toolName) => {
    const domainLabel = DOMAIN_LABELS[signature.domain] || signature.domain
    return [
      '⛔ [任务域聚焦] 已拦截一次你自己新增的附属动作（不弹窗、不放行）。',
      brandOf(mode),
      `本次调用：${toolName}（${signature.evidence}）命中附属能力「${item.label}」（${domainLabel}领域），但用户这条提问里没有明确提出它。`,
      '下一步：不要执行、不要补做、也不要在回复里主动提议这个附属动作；把注意力收回到主域任务上继续做深。',
    ].join('\n')
  }

  /** Subsidiary action the user asked for, but declined in the confirm dialog. */
  const denySubsidiarySkippedText = (mode, item, toolName) => [
    '⛔ [任务域聚焦] 用户选择跳过这次的附属动作。',
    brandOf(mode),
    `本次调用：${toolName}，命中附属能力「${item.label}」。`,
    '下一步：不要换个方式绕道实现，直接回到主域任务继续。',
  ].join('\n')

  /** Ask the human whether to run a subsidiary action the user did ask for. */
  const askSubsidiary = async (exec, entry, signature, item) => {
    const questions = ctx.get('userQuestions')
    if (!questions || typeof questions.ask !== 'function') {
      warn('no userQuestions channel; running the requested subsidiary action')
      return true
    }
    const mode = MODES[entry.mode]
    try {
      const answer = await questions.ask({
        questions: [{
          id: QUESTION_ID,
          header: '聚焦模式',
          question: `当前处于【${mode.label}】，检测到你在提问中要求的附属配套动作（${item.label}），是否执行本次附属动作？`,
          detail: [
            `工具：${signature.tool}`,
            `命中依据：${signature.evidence}`,
            `主域：${mode.core.join('、')}`,
            '附属动作只是次要辅助，不影响聚焦模式本身。',
          ].join('\n'),
          options: [
            { label: SUBSIDIARY_RUN_LABEL, description: `执行本次${item.label}` },
            { label: SUBSIDIARY_SKIP_LABEL, description: '跳过，只保留主域任务' },
          ],
          multiSelect: false,
        }],
        agent: exec.agent,
        signal: exec.signal,
      })
      const answers = answer && Array.isArray(answer.answers) ? answer.answers : []
      const chosen = answers.find(candidate => candidate && candidate.id === QUESTION_ID)
      if (!chosen) return false
      return Array.isArray(chosen.selected) && chosen.selected.includes(SUBSIDIARY_RUN_LABEL)
    } catch (error) {
      warn('subsidiary dialog failed:', error && error.message)
      return false
    }
  }

  ctx.effect(() => {
    const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (!config.enabled || !config.enforce) return next()
        if (!exec || typeof exec.name !== 'string') return next()
        const sessionId = sessionIdOf(exec.agent)
        if (!sessionId) return next()
        const entry = sessions.get(sessionId)
        if (!entry) return next()
        // Tiers 1–2 (专注模式 / 附属动作) are independent of the task-domain mode.
        const early = await preDecide(exec, entry, next)
        if (early !== undefined) return early
        // Tier 3: task-domain lock.
        if (!entry.lock) return next()
        if (entry.mode === DEFAULT_MODE_ID) return next()

        const signature = classifyToolCall(exec.name, exec.arguments)
        if (!signature) return next()

        const mode = MODES[entry.mode]
        const call = { tool: exec.name, domain: signature.domain, evidence: signature.evidence }

        // 1) Main domain: this is the work the session exists for.
        if (Array.isArray(mode.domains.core) && mode.domains.core.includes(signature.domain)) return next()

        // 2) Subsidiary capability: only on the user's own explicit words.
        const item = subsidiaryForDomain(mode, signature.domain)
        if (item) {
          const asked = askedSubsidiary(entry.lastUserText, mode)
          const explicit = !!(asked && asked.key === item.key)
          if (!explicit) {
            lastGate = { at: Date.now(), sessionId, mode: entry.mode, verdict: 'subsidiary-self', ...call }
            bump(entry, 'blocked')
            log('blocked self-invented subsidiary:', sessionId, call.tool, item.key)
            return {
              kind: 'deny',
              reason: denySubsidiaryText(mode, item, { ...signature, tool: exec.name }, exec.name),
              info: { name: 'dsh-focus-mode', code: 'TASK_FOCUS_SUBSIDIARY_SELF', reason: `${mode.label} 未获用户要求，拒绝附属动作「${item.label}」` },
            }
          }
          if (entry.confirmSubsidiary) {
            const granted = await askSubsidiary(exec, entry, { ...signature, tool: exec.name }, item)
            lastGate = { at: Date.now(), sessionId, mode: entry.mode, verdict: granted ? 'subsidiary-confirmed' : 'subsidiary-skipped', ...call }
            if (granted) {
              bump(entry, 'passed')
              return next()
            }
            bump(entry, 'blocked')
            return {
              kind: 'deny',
              reason: denySubsidiarySkippedText(mode, item, exec.name),
              info: { name: 'dsh-focus-mode', code: 'TASK_FOCUS_SUBSIDIARY_SKIPPED', reason: '用户跳过本次附属动作' },
            }
          }
          lastGate = { at: Date.now(), sessionId, mode: entry.mode, verdict: 'subsidiary-allowed', ...call }
          bump(entry, 'passed')
          return next()
        }

        // 3) Fully cross-domain: refused, no pass option.
        lastGate = { at: Date.now(), sessionId, mode: entry.mode, verdict: 'cross-domain', ...call }
        bump(entry, 'blocked')
        log('blocked cross-domain call:', sessionId, call.tool, '->', call.domain)
        return {
          kind: 'deny',
          reason: denyCrossText(mode, { ...signature, tool: exec.name }, exec.name),
          info: { name: 'dsh-focus-mode', code: 'TASK_FOCUS_DOMAIN_BLOCKED', reason: `${mode.label} 不允许 ${call.domain} 领域的调用` },
        }
      } catch (error) {
        warn('gate failed, failing open:', error && error.message)
        return next()
      }
    })
    return dispose
  })

  // ---- result classification (报错分类 + 沙箱只试一次) -------------------

  const classifyFailure = (message) => {
    const text = typeof message === 'string' ? message : ''
    if (/SetNamedSecurityInfoW|grantWrite|sandbox|沙箱|access is denied|拒绝访问/i.test(text)) return 'system'
    if (/SyntaxError|Traceback|NameError|TypeError|ReferenceError|exit code|command not found|不是内部或外部命令/i.test(text)) return 'script'
    return ''
  }

  ctx.effect(() => {
    const dispose = ctx.on('tools/post-execute', (exec, result, next) => {
      try {
        if (!config.enabled || !exec || typeof exec.name !== 'string') return next()
        if (!result || result.isError !== true) return next()
        const sessionId = sessionIdOf(exec.agent)
        if (!sessionId) return next()
        const message = (result.error && result.error.message) || ''
        const kind = classifyFailure(message)
        if (isSandboxTool(exec.name)) markSandboxFailure(sessionId)
        if (!kind) return next()
        const friendly = kind === 'system'
          ? '⚠️ 系统异常：这次执行环境没有就绪（沙箱/权限准备失败），这不是你的脚本写错了。本次会话不会再重试该能力，请改用不依赖它的方式继续完成任务。'
          : kind === 'script'
            ? '⚠️ 代码报错：脚本本身执行失败（语法或运行期错误）。请根据上面的报错定位并修复，而不是重复原样重试。'
            : ''
        return { kind: 'accept', content: [{ type: 'text', text: friendly }] }
      } catch (error) {
        warn('post-execute classification failed:', error && error.message)
        return next()
      }
    })
    return dispose
  })

  // ---- session tracking ------------------------------------------------

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        if (!session || !event) return
        const sessionId = typeof session.id === 'string' ? session.id : ''
        if (!sessionId) return
        if (!sessions.has(sessionId) && config.defaultMode === DEFAULT_MODE_ID) return
        const entry = entryFor(sessionId)
        if (event.type === 'turn/start') {
          entry.running = true
          entry.updatedAt = Date.now()
          return
        }
        if (event.type === 'turn/end') {
          entry.running = false
          if (entry.pendingRevert) applyRevert(entry, entry.pendingRevert)
          return
        }
        if (event.type === 'user/message') {
          if (!isUserAuthored(event.data)) return
          const messageText = textOfMessage(event.data)
          noteUserMessage(sessionId, messageText)
          void handleSoftIntent(sessionId, entry, messageText)
        }
      } catch (error) {
        warn('session/event handling failed:', error && error.message)
      }
    })
    return dispose
  })

  ctx.effect(() => {
    const dispose = ctx.on('agent/status', (payload) => {
      try {
        const sessionId = sessionIdOf(payload && payload.agent)
        if (!sessionId || !sessions.has(sessionId)) return
        const entry = sessions.get(sessionId)
        const running = payload.status === 'running'
        entry.running = running
        if (!running && entry.pendingRevert) applyRevert(entry, entry.pendingRevert)
      } catch (error) {
        warn('agent/status handling failed:', error && error.message)
      }
    })
    return dispose
  })

  // ---- HTTP surface ----------------------------------------------------

  const snapshot = (sessionId) => {
    const entry = typeof sessionId === 'string' && sessionId ? sessions.get(sessionId) : undefined
    const modeId = entry ? entry.mode : config.defaultMode
    const mode = MODES[modeId] || MODES[DEFAULT_MODE_ID]
    return {
      ok: true,
      version: '2.0.0',
      now: Date.now(),
      enabled: config.enabled,
      enforce: config.enforce,
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      mode: mode.id,
      modeLabel: mode.label,
      modeShort: mode.short,
      modeBrief: mode.brief,
      active: mode.id !== DEFAULT_MODE_ID,
      locked: entry ? entry.lock : config.lockByDefault,
      confirmSubsidiary: entry ? entry.confirmSubsidiary === true : config.confirmSubsidiary,
      focusMode: entry ? entry.focusMode === true : config.focusModeByDefault,
      showMarkers: entry ? entry.showMarkers === true : config.showMarkersByDefault,
      rigor: entry ? entry.rigor || config.rigorByDefault : config.rigorByDefault,
      rigors: RIGOR_LEVELS,
      focusGuideSeen: entry ? entry.focusGuideSeen === true : false,
      sandboxFailedAt: entry ? entry.sandboxFailedAt || 0 : 0,
      notice: entry && entry.notice ? entry.notice : null,
      stats: {
        streak: entry ? entry.streak : 0,
        running: entry ? entry.running === true : false,
        blocked: entry && entry.stats ? entry.stats.blocked : 0,
        passed: entry && entry.stats ? entry.stats.passed : 0,
        since: entry ? entry.createdAt : null,
        updatedAt: entry ? entry.updatedAt : null,
        lastUserAt: entry && entry.lastUserAt ? entry.lastUserAt : null,
      },
      modes: publicModes(),
      config: {
        defaultMode: config.defaultMode,
        lockByDefault: config.lockByDefault,
        confirmSubsidiary: config.confirmSubsidiary,
        offTopicRevertAfter: config.offTopicRevertAfter,
        idleRevertMinutes: config.idleRevertMinutes,
        pollMs: config.pollMs,
        defaultPanelOpen: config.defaultPanelOpen,
        sectionOrder: config.sectionOrder,
      },
      hint: '任务域聚焦：把推理资源与上下文注意力集中在当前主任务上；跨域拦截、附属动作需你明确提出。不改变权限与安全审批。',
      diagnostics: {
        section: { name: SECTION_NAME, order: config.sectionOrder, registered: sectionRegistered },
        lastRender,
        lastGate,
        stateEntries: sessions.size,
      },
    }
  }

  const requireSession = (body) => {
    const sessionId = body && typeof body.session === 'string' ? body.session.trim() : ''
    if (!sessionId) throw Object.assign(new Error('缺少 session 参数'), { status: 400 })
    return sessionId
  }

  const handler = (req, res) => {
    const run = async () => {
      const url = new URL(req.url || '/', 'http://localhost')
      const pathname = url.pathname.replace(/\/+$/, '') || ROUTE_PREFIX
      const method = (req.method || 'GET').toUpperCase()
      hits.total += 1
      hits.lastAt = Date.now()

      if (method === 'GET' || method === 'HEAD') {
        if (pathname !== ROUTE_PREFIX + '/state' && pathname !== ROUTE_PREFIX) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }
        const sessionId = url.searchParams.get('session') || ''
        if (method === 'HEAD') {
          res.statusCode = 200
          res.end()
          return
        }
        sendJson(res, 200, snapshot(sessionId))
        return
      }

      if (method !== 'POST') {
        res.setHeader('allow', 'GET, HEAD, POST')
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }

      const guard = guardMutation(req)
      if (guard !== true) {
        hits.lastError = 'rejected: ' + guard
        sendJson(res, 403, { ok: false, error: guard })
        return
      }

      const body = await readBody(req)
      const sessionId = requireSession(body)

      if (pathname === ROUTE_PREFIX + '/mode') {
        setMode(sessionId, body.mode)
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      if (pathname === ROUTE_PREFIX + '/lock') {
        setLock(sessionId, body.lock === true)
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      if (pathname === ROUTE_PREFIX + '/confirm') {
        setConfirmSubsidiary(sessionId, body.confirm === true)
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      if (pathname === ROUTE_PREFIX + '/focus') {
        setFocusMode(sessionId, body.focus === true)
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      if (pathname === ROUTE_PREFIX + '/markers') {
        setShowMarkers(sessionId, body.markers === true)
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      if (pathname === ROUTE_PREFIX + '/rigor') {
        setRigor(sessionId, body.rigor)
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      if (pathname === ROUTE_PREFIX + '/guide') {
        seenFocusGuide(sessionId)
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      if (pathname === ROUTE_PREFIX + '/reset') {
        resetMode(sessionId)
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      if (pathname === ROUTE_PREFIX + '/dismiss') {
        dismissNotice(sessionId)
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    }

    void run().catch((error) => {
      const status = typeof error?.status === 'number' ? error.status : 400
      hits.lastError = String((error && error.message) || error)
      try {
        sendJson(res, status, { ok: false, error: hits.lastError })
      } catch {
        try { res.statusCode = 500; res.end('error') } catch {}
      }
    })
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler,
    })
    return dispose
  })

  // ---- lifecycle -------------------------------------------------------

  ctx.effect(() => {
    // Every timer this plugin owns is created and disposed inside this effect.
    armPersistTimer = () => {
      persistTimer = setTimeout(() => {
        persistTimer = null
        void persistNow()
      }, 1200)
      persistTimer.unref?.()
    }
    void restore()
    const timer = setInterval(sweep, config.sweepSeconds * 1000)
    timer.unref?.()
    return async () => {
      clearInterval(timer)
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      // Await the final flush so unload never leaves a write in flight.
      await persistNow()
    }
  })

  log('serving', ROUTE_PREFIX, '| store', config.storageFile, '| modes', MODE_IDS.join(','), '| enforce', config.enforce)

  return {
    config,
    snapshot,
    sessions,
    setMode,
    setLock,
    setConfirmSubsidiary,
    setFocusMode,
    setShowMarkers,
    setRigor,
    seenFocusGuide,
    resetMode,
    dismissNotice,
    sweep,
    flush: () => persistNow(),
  }
}

/**
 * Cordis plugin entry — the ONLY plugin entry this module exposes.
 *
 * `export const name` above equals package.json `name` exactly, `applyPlugin` is
 * not exported (so the namespace cannot look like a second plugin object), and
 * every `ctx.effect(...)` / `ctx.on(...)` lives inside that one body. The Loader
 * therefore creates exactly one fiber and no lifecycle registers twice.
 *
 * @param ctx the plugin context supplied by the Loader.
 * @param rawConfig the row config from cordis.patch.yml.
 * @returns the plugin handle used by the headless test suite.
 */
export default function dshFocusMode (ctx, rawConfig) {
  return applyPlugin(ctx, rawConfig)
}
