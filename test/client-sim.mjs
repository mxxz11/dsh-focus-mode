/**
 * dsh-focus-mode — headless render + layout test for the browser half.
 *
 * Loads `client.js` the way the Web shell does (`window.__ModuleLoader__`), with
 * a tiny fake React and a fake `fetch`, then asserts:
 *
 *   - both slots are registered under the plugin's own ids;
 *   - the panel shows the status badge, the flat seven-tab row, the short brief
 *     line, both switches (lock + subsidiary confirm), the reset button and the
 *     interception counters;
 *   - a wide row shows every mode and no dropdown; a narrow row folds the tail
 *     into 「更多模式」 and never hides the selected mode;
 *   - clicking a tab posts the mode, clicking a switch posts the switch.
 *
 * Run: node test/client-sim.mjs
 */
import assert from 'node:assert/strict'

const MODES_FIXTURE = [
  { id: 'general', label: '通用默认模式', short: '通用', accent: '#888888', brief: '不限制任务域，按原生策略处理任何任务。', hint: '不限任务域', core: ['不限任务域'], subsidiary: [], primary: true },
  { id: 'image', label: '图片聚焦模式', short: '图片', accent: '#e0a458', brief: '主域：识图、修图、生图。', hint: '识图、修图、生图；附属「简短文字描述」仅在明确要求时执行。', core: ['识图', '修图', '生图'], subsidiary: ['简短文字描述'], primary: true },
  { id: 'ppt', label: 'PPT 聚焦模式', short: 'PPT', accent: '#e2725b', brief: '主域：大纲、页面文案、版式。', hint: '大纲、页面文案、版式；附属「页面备注」仅在明确要求时执行。', core: ['大纲', '页面文案', '版式'], subsidiary: ['页面备注'], primary: true },
  { id: 'video', label: '视频聚焦模式', short: '视频', accent: '#b06cf0', brief: '主域：脚本、分镜构思。', hint: '脚本、分镜构思；附属「配套台词」仅在明确要求时执行。', core: ['脚本', '分镜构思'], subsidiary: ['配套台词'], primary: true },
  { id: 'code', label: '代码聚焦模式', short: '代码', accent: '#4d6bfe', brief: '主域：编码、调试、排错、解读。', hint: '编码、调试、排错、解读；附属「绘制流程图」「生成文件」仅在明确要求时执行。', core: ['编码', '调试', '排错', '解读'], subsidiary: ['绘制流程图', '生成文件'], primary: true },
  { id: 'doc', label: '文档审阅聚焦模式', short: '文档', accent: '#3fa796', brief: '主域：精读、批注、摘要、对比。', hint: '精读、批注、摘要、对比；附属「整理提纲」仅在明确要求时执行。', core: ['精读', '批注', '摘要', '对比'], subsidiary: ['整理提纲'], primary: true },
  { id: 'data', label: '数据分析聚焦模式', short: '数据', accent: '#5b8def', brief: '主域：计算、校验、数据处理。', hint: '计算、校验、数据处理；附属「绘图」「导出/运行脚本」仅在明确要求时执行。', core: ['计算', '校验', '数据处理'], subsidiary: ['绘图', '导出/运行脚本'], primary: true },
]

const BASE_STATE = {
  ok: true,
  version: '2.0.0',
  sessionId: 'sess-ui',
  mode: 'code',
  modeLabel: '代码聚焦模式',
  modeShort: '代码',
  modeBrief: '主域：编码、调试、排错、解读。',
  active: true,
  locked: true,
  confirmSubsidiary: false,
  focusMode: false,
  showMarkers: true,
  rigor: 'balanced',
  rigors: [
    { id: 'fast', label: '快速核验', brief: '基础校验', detail: '只做基础校验', tooltip: '出结果快，基础严谨性高于普通对话' },
    { id: 'balanced', label: '严谨精简', brief: '默认', detail: '按体量自适应', tooltip: '平衡速度、篇幅与可信度（推荐）' },
    { id: 'strict', label: '极致严谨', brief: '全套复核', detail: '全套复核流程', tooltip: '全链路复核，高可信正式场景，开销更高' },
  ],
  notice: null,
  stats: { streak: 0, blocked: 2, passed: 1 },
  modes: MODES_FIXTURE,
  config: { offTopicRevertAfter: 3, idleRevertMinutes: 0, pollMs: 15000, defaultPanelOpen: true, confirmSubsidiary: false },
  hint: '任务域聚焦：把推理资源集中在当前主任务上。',
  diagnostics: { section: { registered: true } },
}

let passed = 0
let failed = 0

function check (label, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + label)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + label)
    console.log('       ' + String((error && error.message) || error))
  }
}

async function checkAsync (label, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + label)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + label)
    console.log('       ' + String((error && error.message) || error))
  }
}

// ----------------------------------------------------------------- fake React

const effects = []
let hookCount = 0
const FakeReact = {
  createElement (type, props, ...children) {
    const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: { ...(props || {}), children: flat } }
  },
  useState (initial) {
    hookCount += 1
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect (fn) {
    hookCount += 1
    effects.push(fn)
    return undefined
  },
  useRef (initial) {
    hookCount += 1
    return { current: initial }
  },
}

/** Count how many hooks one render pass calls — React requires this to be stable. */
function countHooks (render) {
  hookCount = 0
  render()
  const count = hookCount
  hookCount = 0
  return count
}

function textOf (node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node && node.props) return textOf(node.props.children)
  return ''
}

function collect (node, predicate, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (node && node.props) {
    if (predicate(node)) out.push(node)
    collect(node.props.children, predicate, out)
  }
  return out
}

// ------------------------------------------------------------------ fake shell

let registered = []
let componentFactory = null

globalThis.window = {
  __ModuleLoader__: {
    load ({ id, factory }) {
      assert.equal(id, 'dsh-focus-mode')
      componentFactory = factory
    },
  },
  addEventListener () {},
  removeEventListener () {},
}

const posted = []
let served = { ...BASE_STATE }

globalThis.fetch = async (url, options) => {
  const method = (options && options.method) || 'GET'
  if (method !== 'POST') return { ok: true, status: 200, json: async () => served }
  const body = options && options.body ? JSON.parse(options.body) : {}
  posted.push({ url, body })
  if (url.endsWith('/mode')) {
    const mode = served.modes.find(item => item.id === body.mode)
    served = {
      ...served,
      mode: body.mode,
      modeLabel: mode ? mode.label : served.modeLabel,
      modeShort: mode ? mode.short : served.modeShort,
      modeBrief: mode ? mode.brief : served.modeBrief,
      active: body.mode !== 'general',
      notice: null,
    }
  } else if (url.endsWith('/lock')) {
    served = { ...served, locked: body.lock === true }
  } else if (url.endsWith('/confirm')) {
    served = { ...served, confirmSubsidiary: body.confirm === true }
  } else if (url.endsWith('/reset')) {
    served = { ...served, mode: 'general', modeShort: '通用', modeLabel: '通用默认模式', active: false }
  } else if (url.endsWith('/dismiss')) {
    served = { ...served, notice: null }
  }
  return { ok: true, status: 200, json: async () => served }
}

await import('../client.js')
assert.ok(typeof componentFactory === 'function', 'the module never called __ModuleLoader__.load')

const mod = componentFactory((name) => {
  assert.equal(name, 'react')
  return FakeReact
})

mod.apply({
  slots: {
    inject (key, callback) { callback(); return () => {} },
    register (meta, Component) {
      registered.push({ meta, Component })
      return () => {}
    },
  },
})

const chip = registered.find(item => item.meta.id === 'focus-mode-chip').Component
const panel = registered.find(item => item.meta.id === 'focus-mode-panel').Component
const { layoutTabs, chipWidth } = mod.__internals || {}

async function settle () {
  for (const fn of effects.splice(0)) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanup()
  }
  await new Promise(resolve => setTimeout(resolve, 40))
}

chip({ sessionId: 'sess-ui' })
panel({ sessionId: 'sess-ui' })
await settle()

console.log('\n[registration]')

check('both slots are registered under the plugin ids', () => {
  assert.equal(registered.length, 2)
  assert.deepEqual(registered.map(item => item.meta.name).sort(), ['conversation.input.dock', 'conversation.input.left'])
  assert.deepEqual(registered.map(item => item.meta.id).sort(), ['focus-mode-chip', 'focus-mode-panel'])
})

console.log('\n[render]')

check('the chip shows the current mode and the enforcement hint', () => {
  const tree = chip({ sessionId: 'sess-ui' })
  const text = textOf(tree)
  assert.ok(text.includes('代码'), 'chip label: ' + text)
  assert.ok(tree.props.title.includes('代码聚焦模式'))
  assert.ok(tree.props.title.includes('已锁定'), 'chip title should explain the lock state')
})

check('the panel renders badge, seven flat tabs, brief, both switches and reset', () => {
  const tree = panel({ sessionId: 'sess-ui' })
  assert.ok(tree, 'panel should render while open')
  const text = textOf(tree)
  assert.ok(text.includes('任务域聚焦'), 'panel title')
  assert.ok(text.includes('当前：代码聚焦模式'), 'status badge: ' + text)
  assert.ok(text.includes('主域：编码、调试、排错、解读。'), 'brief line: ' + text)
  assert.ok(text.includes('附属：绘制流程图、生成文件'), 'brief should list the whitelist: ' + text)
  assert.ok(text.includes('锁定模式（持续执行定向约束与跨域拦截）'), 'lock row')
  assert.ok(text.includes('附属动作弹窗确认'), 'subsidiary switch row')
  assert.ok(text.includes('重置为通用模式'), 'reset button')
  assert.ok(text.includes('已拦截 2 次'), 'interception counter: ' + text)
  assert.ok(text.includes('附属放行 1 次'), 'subsidiary pass counter: ' + text)

  const allRadios = collect(tree, node => node.props && node.props.role === 'radio')
  const tabs = allRadios.filter(node => !node.props['data-rigor'])
  assert.equal(tabs.length, 7, 'all seven modes are resident')
  const anchors = collect(tree, node => node.props && node.props['data-rigor'])
  assert.equal(anchors.length, 3, 'three slider anchors')
  assert.deepEqual(anchors.map(node => node.props['aria-label']), ['快速核验', '严谨精简', '极致严谨'])
  assert.ok(text.includes('严谨等级'), 'slider row label')
  assert.ok(anchors[1].props.title.includes('平衡速度、篇幅与可信度'), 'anchor tooltip copy')
  const knob = collect(tree, node => node.props && node.props.role === 'slider')[0]
  assert.ok(knob, 'slider knob missing')
  assert.equal(knob.props['aria-valuetext'], '严谨精简', 'default tier on the knob')
  assert.equal(knob.props.title, '平衡速度、篇幅与可信度（推荐）', 'knob tooltip follows the tier')

  const ticks = collect(tree, node => node.props && node.props['data-tick'])
  assert.equal(ticks.length, 3, 'three faint ticks mark the anchors')
  assert.equal(ticks[0].props.style.opacity <= 0.3, true, 'ticks stay low-contrast')
  const statusSpan = collect(tree, node => node.props && node.props['data-focus-status'] !== undefined)[0]
  assert.ok(collect(tree, node => String(node.props.style && node.props.style.textOverflow) === 'ellipsis').length > 0, 'status text truncates instead of overflowing')

  // 层级顺序：专注模式开关 → 严谨等级滑块 → 其它设置项
  const flat = JSON.stringify(tree)
  const focusAt = flat.indexOf('专注模式（沙箱已禁用）')
  const sliderAt = flat.indexOf('严谨等级')
  const lockAt = flat.indexOf('锁定模式（持续执行定向约束与跨域拦截）')
  assert.ok(focusAt >= 0 && sliderAt > focusAt, '滑块必须紧贴专注模式开关之下')
  assert.ok(lockAt > sliderAt, '其它设置项必须排在滑块之后')
  assert.deepEqual(tabs.map(node => textOf(node).trim()), ['通用', '图片', 'PPT', '视频', '代码', '文档', '数据'])
  assert.ok(tabs.every(node => typeof node.props.title === 'string' && node.props.title.length > 4), 'every tab needs a hover hint')
  assert.equal(tabs.filter(node => node.props['aria-checked'] === true).length, 1)
  assert.equal(collect(tree, node => node.props && node.props.role === 'switch').length, 4, 'four independent switches')
  const labels = collect(tree, node => node.props && node.props.role === 'switch').map(node => node.props['aria-label'])
  assert.deepEqual(labels, ['专注模式', '锁定模式', '附属动作弹窗确认', '是否显示执行方式标记'], '专注模式开关排在其它设置之前')
})

check('the status bar mirrors the active guardrails', () => {
  const tree = panel({ sessionId: 'sess-ui' })
  const text = textOf(tree)
  assert.ok(text.includes('锁定模式｜当前域：代码，禁止自动跨域'), 'lock status: ' + text)
  assert.ok(!text.includes('专注模式｜沙箱已禁用'), 'focus status line only when focus is on')
})

check('a wide row shows every mode and needs no dropdown', () => {
  const wide = layoutTabs(MODES_FIXTURE, 'code', 760)
  assert.deepEqual(wide.row.map(mode => mode.id), MODES_FIXTURE.map(mode => mode.id))
  assert.deepEqual(wide.more, [])
  const roomier = layoutTabs(MODES_FIXTURE, 'data', 1400)
  assert.deepEqual(roomier.more, [])
})

check('a narrow row folds the tail into the dropdown without hiding the selection', () => {
  const narrow = layoutTabs(MODES_FIXTURE, 'data', 320)
  assert.ok(narrow.row.length < 7, 'narrow widths must fold: ' + narrow.row.map(mode => mode.id).join(','))
  assert.ok(narrow.row.some(mode => mode.id === 'data'), 'the selected mode stays visible')
  assert.ok(narrow.more.length > 0, 'the dropdown receives the rest')
  const union = new Set([...narrow.row, ...narrow.more].map(mode => mode.id))
  assert.equal(union.size, MODES_FIXTURE.length, 'every mode stays reachable')

  const tiny = layoutTabs(MODES_FIXTURE, 'image', 150)
  assert.equal(tiny.row.length, 1)
  assert.equal(tiny.row[0].id, 'image')
})

check('chipWidth grows with the label', () => {
  assert.ok(chipWidth({ short: 'PPT' }) > chipWidth({ short: '代码' }))
})

check('the panel calls the same number of hooks open and closed (no hook-order crash)', () => {
  // Regression guard: calling useRef/useState AFTER the early `return null`
  // makes React throw "Rendered more hooks than during the previous render",
  // which kills the whole panel subtree.
  const closed = countHooks(() => panel({ sessionId: 'sess-never-loaded' }))
  const open = countHooks(() => panel({ sessionId: 'sess-ui' }))
  assert.ok(closed > 0, 'the closed render should still run its hooks')
  assert.equal(closed, open, 'hook count must not depend on the open state')
  assert.equal(
    countHooks(() => chip({ sessionId: 'sess-never-loaded' })),
    countHooks(() => chip({ sessionId: 'sess-ui' })),
    'chip hook count must be stable too',
  )
})

await checkAsync('a stale or unknown rigor value cannot break the panel', async () => {
  served = { ...BASE_STATE, sessionId: 'sess-bad', focusMode: true, rigor: 'nonsense-tier', rigors: null }
  chip({ sessionId: 'sess-bad' })
  panel({ sessionId: 'sess-bad' })
  await settle()
  const tree = panel({ sessionId: 'sess-bad' })
  assert.ok(tree, 'the panel must still render with a bad stored tier')
  const knob = collect(tree, node => node.props && node.props.role === 'slider')[0]
  assert.ok(knob, 'the slider must still render from the local fallback catalog')
  assert.equal(knob.props['aria-valuetext'], '严谨精简', 'unknown tier falls back to the default seat')
  served = { ...BASE_STATE }
})

await checkAsync('the slider motion contract holds (180ms ease-out, 1.05 hover, 120ms text fade)', async () => {
  served = { ...BASE_STATE, sessionId: 'sess-motion', focusMode: true }
  chip({ sessionId: 'sess-motion' })
  panel({ sessionId: 'sess-motion' })
  await settle()
  const tree = panel({ sessionId: 'sess-motion' })
  const knob = collect(tree, node => node.props && node.props.role === 'slider')[0]
  const fill = collect(tree, node => node.props && node.props.className === 'tf-rigor-fill')[0]
  const track = collect(tree, node => node.props && node.props.className === 'tf-rigor-track')[0]
  assert.ok(knob && fill && track, 'knob / fill / track must all exist')

  // 1. 吸附缓动：180ms，ease-out 收尾带一点点回弹
  assert.match(knob.props.style.transition, /left 180ms cubic-bezier\(0\.34, 1\.32, 0\.64, 1\)/)
  assert.match(fill.props.style.transition, /width 180ms cubic-bezier\(0\.34, 1\.32, 0\.64, 1\)/)
  assert.ok(
    knob.props.style.transition.split('cubic-bezier')[0].includes('left 180ms') &&
    fill.props.style.transition.split('cubic-bezier')[0].includes('width 180ms'),
    'dot and fill settle with the same curve and duration',
  )

  // 2. 点线同步：两者宽度/位置都来自同一个百分比
  assert.equal(knob.props.style.left, fill.props.style.width, 'dot and fill must share one percentage')

  // 3. 配色：激活态圆点与进度段同主色，轨道浅灰底
  assert.match(String(knob.props.style.background), /--dsw-alias-brand-primary/)
  assert.match(String(fill.props.style.background), /--dsw-alias-brand-primary/)
  assert.match(String(track.props.style.background), /--dsw-alias-border-l1/)

  // 4. 样式表里的柔和特效与"禁止花哨"约束
  const css = collect(tree, node => node.type === 'style').map(node => textOf(node)).join('')
  assert.match(css, /\.tf-rigor-knob:hover\{transform:scale\(1\.05\)\}/, 'hover scale 1.05')
  assert.match(css, /tf-fade-in 120ms/, 'text fade 120ms')
  assert.match(css, /\.tf-rigor-track:hover\{opacity:1\}/, 'track brightens on hover')
  assert.match(css, /prefers-reduced-motion/, 'respects reduced motion')
  assert.ok(!/gradient|glow|blur\(|animation:.*(pulse|blink|bounce|shake)/.test(css), 'no glow / gradient / pulse / bounce')
  served = { ...BASE_STATE }
})

await checkAsync('the disabled state is grey with no highlight', async () => {
  served = { ...BASE_STATE, sessionId: 'sess-off', focusMode: false }
  chip({ sessionId: 'sess-off' })
  panel({ sessionId: 'sess-off' })
  await settle()
  const tree = panel({ sessionId: 'sess-off' })
  const knob = collect(tree, node => node.props && node.props.role === 'slider')[0]
  const fill = collect(tree, node => node.props && node.props.className === 'tf-rigor-fill')[0]
  assert.equal(knob.props['aria-disabled'], true)
  assert.match(String(knob.props.style.background), /label-secondary/, 'knob grey, not brand')
  assert.ok(!String(fill.props.style.background).includes('brand-primary'), 'no brand fill while disabled')
  served = { ...BASE_STATE }
})

console.log('\n[actions]')

await checkAsync('clicking a tab posts the mode to the Host', async () => {
  const before = posted.length
  const tabs = collect(panel({ sessionId: 'sess-ui' }), node => node.props && node.props.role === 'radio')
  const target = tabs.find(node => textOf(node).trim() === '视频')
  assert.ok(target, 'no video tab found')
  target.props.onClick()
  await settle()
  const sent = posted.slice(before).find(entry => entry.url.endsWith('/mode'))
  assert.ok(sent, 'no mode request sent')
  assert.equal(sent.body.session, 'sess-ui')
  assert.equal(sent.body.mode, 'video')
})

await checkAsync('the lock switch posts the flipped value', async () => {
  const before = posted.length
  const switches = collect(panel({ sessionId: 'sess-ui' }), node => node.props && node.props.role === 'switch')
  const lockSwitch = switches.find(node => node.props['aria-label'] === '锁定模式')
  assert.ok(lockSwitch, 'lock switch missing')
  lockSwitch.props.onClick()
  await settle()
  const sent = posted.slice(before).find(entry => entry.url.endsWith('/lock'))
  assert.ok(sent, 'no lock request sent')
  assert.equal(typeof sent.body.lock, 'boolean')
})

await checkAsync('the subsidiary switch posts to /confirm', async () => {
  const before = posted.length
  const switches = collect(panel({ sessionId: 'sess-ui' }), node => node.props && node.props.role === 'switch')
  const confirmSwitch = switches.find(node => node.props['aria-label'] === '附属动作弹窗确认')
  assert.ok(confirmSwitch, 'subsidiary switch missing')
  assert.equal(confirmSwitch.props['aria-checked'], false, 'default is off')
  confirmSwitch.props.onClick()
  await settle()
  const sent = posted.slice(before).find(entry => entry.url.endsWith('/confirm'))
  assert.ok(sent, 'no confirm request sent')
  assert.equal(sent.body.confirm, true)
})

await checkAsync('an auto-revert notice renders with its undo action', async () => {
  served = {
    ...BASE_STATE,
    sessionId: 'sess-notice',
    mode: 'general',
    modeLabel: '通用默认模式',
    modeShort: '通用',
    active: false,
    notice: { kind: 'auto-revert', at: Date.now(), from: 'doc', fromLabel: '文档审阅聚焦模式', to: 'general', reason: 'off-topic' },
  }
  chip({ sessionId: 'sess-notice' })
  panel({ sessionId: 'sess-notice' })
  await settle()
  const text = textOf(panel({ sessionId: 'sess-notice' }))
  assert.ok(text.includes('已自动切回通用模式'), 'notice text: ' + text)
  assert.ok(text.includes('恢复 文档'), 'undo action missing')
})

console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ' — ' + passed + ' passed, ' + failed + ' failed\n')
process.exit(failed === 0 ? 0 : 1)
