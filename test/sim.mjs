/**
 * dsh-focus-mode v3 — Host simulation test.
 *
 * Covers both guardrails and their priority order
 * (专注模式 > 附属动作确认 > 锁定模式 > 通用默认), plus result classification.
 *
 * Run: node test/sim.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import apply from '../lib/index.js'
import { MODES, MODE_IDS, PRIMARY_MODE_IDS, renderGuidance } from '../lib/modes.js'
import {
  HEAVY_PROMPT,
  MANUAL_NOTE,
  detectSoftIntent,
  isSandboxTool,
  lockRefusal,
  looksHeavy,
  numbersIn,
  subsidiaryOf,
  userAskedFor,
  userForbadeSandbox,
} from '../lib/actions.js'

let ok = 0
let bad = 0
const check = async (label, fn) => {
  try {
    await fn()
    ok += 1
    console.log('  ok   ' + label)
  } catch (error) {
    bad += 1
    console.log('  FAIL ' + label)
    console.log('       ' + String((error && error.message) || error))
  }
}

function makeContext () {
  const listeners = new Map()
  const routes = []
  const sections = []
  const services = {}
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    get (name) { return services[name] },
    on (event, fn) {
      const list = listeners.get(event) || []
      list.push({ fn })
      listeners.set(event, list)
      return () => {}
    },
    effect (fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    systemPrompt: { section (definition) { sections.push(definition); return () => {} }, getSectionOrder () { return 500 } },
    webServer: { register (route) { routes.push(route); return () => {} } },
  }
  const fire = (event, ...args) => { for (const entry of listeners.get(event) || []) entry.fn(...args) }
  return { ctx, routes, sections, listeners, services, fire }
}

async function callRoute (routes, url, method = 'GET', body = null) {
  const route = routes.find(item => url.startsWith(item.path))
  const payload = body === null ? '' : Buffer.from(JSON.stringify(body), 'utf8')
  const req = Readable.from(payload.length === 0 ? [] : [payload])
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json' }
  const chunks = []
  let finish = () => {}
  const done = new Promise(resolve => { finish = resolve })
  const res = { statusCode: 0, setHeader () {}, end (chunk) { if (chunk) chunks.push(Buffer.from(chunk)); finish() } }
  await route.handler(req, res)
  await done
  const text = Buffer.concat(chunks).toString('utf8')
  return { status: res.statusCode, json: text ? JSON.parse(text) : null }
}

const agentOf = id => ({ id, session: { id, header: { cwd: os.tmpdir() } } })
const tmpRoot = path.join(os.tmpdir(), 'tf-v3-' + Date.now())
const storageFile = path.join(tmpRoot, 'state.json')

// ------------------------------------------------------------------- catalog

console.log('\n[catalog]')

await check('seven modes, all resident, general injects nothing', async () => {
  assert.deepEqual([...MODE_IDS], ['general', 'image', 'ppt', 'video', 'code', 'doc', 'data'])
  assert.deepEqual([...PRIMARY_MODE_IDS], [...MODE_IDS])
  assert.equal(renderGuidance(MODES.general), '')
  for (const id of ['data', 'code', 'doc', 'ppt', 'image', 'video']) {
    const text = renderGuidance(MODES[id])
    assert.ok(text.includes('【聚焦约束生效】'), id)
    assert.ok(text.includes('禁止自发拓展'), id)
    assert.ok(!text.includes('{{'), id)
  }
})

await check('the twelve subsidiary capabilities map from wire tools', async () => {
  assert.equal(subsidiaryOf('pwsh').id, 'sandbox')
  assert.equal(subsidiaryOf('bash').id, 'sandbox')
  assert.equal(subsidiaryOf('write').id, 'file')
  assert.equal(subsidiaryOf('web_search').id, 'web')
  assert.equal(subsidiaryOf('web_fetch').id, 'download')
  assert.equal(subsidiaryOf('subagent').id, 'subagentBatch')
  assert.equal(subsidiaryOf('ask_user_question').id, 'selfQuestion')
  assert.equal(subsidiaryOf('read_image').id, 'ocr')
  assert.equal(subsidiaryOf('present').id, 'docParse')
  assert.equal(subsidiaryOf('todo_write'), null)
  assert.equal(isSandboxTool('pwsh'), true)
  assert.equal(isSandboxTool('read'), false)
})

await check('explicit ask / forbid / heavy detection read the user words', async () => {
  assert.equal(userAskedFor('帮我跑一下这段 python', 'sandbox'), true)
  assert.equal(userAskedFor('帮我看看这个月的数据', 'sandbox'), false)
  assert.equal(userAskedFor('搜索一下最新价格', 'web'), true)
  assert.equal(userForbadeSandbox('请手工计算，不要跑代码'), true)
  assert.equal(userForbadeSandbox('帮我算一下'), false)
  assert.equal(looksHeavy('做个矩阵回归分析', [], 200), true)
  assert.equal(looksHeavy('把这三个数加起来', numbersIn('把这三个数加起来'), 200), false)
  assert.equal(looksHeavy('1200 行数据统计', numbersIn('1200 行数据统计'), 200), true)
  assert.ok(MANUAL_NOTE.includes('LLM 分步验算'))
  assert.ok(HEAVY_PROMPT.includes('沙箱不可用'))
  assert.ok(lockRefusal('数据分析').startsWith('当前处于锁定模式，仅支持【数据分析】域任务'))
})

// --------------------------------------------------------------------- wiring

console.log('\n[wiring]')

const main = makeContext()
const api = apply(main.ctx, { storageFile, lockByDefault: true, sweepSeconds: 30 })
let nextAnswer = null
let askCalls = []
main.services.userQuestions = {
  async ask (request) {
    askCalls.push(request)
    if (nextAnswer instanceof Error) throw nextAnswer
    return nextAnswer
  },
}
main.services.agents = { get: id => agentOf(id) }

const gate = async (sessionId, toolName, args) => {
  const list = main.listeners.get('tools/pre-execute') || []
  let nextCalls = 0
  const decision = await list[0].fn({
    name: toolName,
    arguments: args,
    agent: agentOf(sessionId),
    signal: new AbortController().signal,
  }, async () => { nextCalls += 1; return { kind: 'allow' } })
  return { decision, nextCalls }
}
const sayTo = (sessionId, text) => main.fire('session/event', { id: sessionId }, {
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const renderFor = id => main.sections[0].text({ agent: agentOf(id), scope: agentOf(id) })

await check('the prompt section is registered once', async () => {
  assert.equal(main.sections.length, 1)
  assert.equal(main.sections[0].name, 'focus-mode:policy')
})

await check('focus mode appends sandbox guidance to the prompt', async () => {
  api.setMode('p1', 'data')
  api.setFocusMode('p1', true)
  const text = renderFor('p1')
  assert.ok(text.includes('专注模式已开启'))
  assert.ok(text.includes(MANUAL_NOTE))
  assert.ok(text.includes('沙箱代码执行被禁用'))
})

// ------------------------------------------------------------------ tier 1

console.log('\n[专注模式]')

await check('sandbox calls are refused with manual-computation guidance', async () => {
  api.setMode('f1', 'data')
  api.setFocusMode('f1', true)
  sayTo('f1', '帮我算一下这几个数的平均值')
  const { decision, nextCalls } = await gate('f1', 'pwsh', { command: 'python calc.py' })
  assert.equal(decision.kind, 'deny')
  assert.equal(nextCalls, 0)
  assert.match(decision.reason, /沙箱已禁用/)
  assert.match(decision.reason, /手工列式/)
  assert.equal(decision.info.code, 'TASK_FOCUS_SANDBOX_DISABLED')
})

await check('an explicit "no code" request skips the heavy dialog', async () => {
  sayTo('f1', '请手工计算，不要跑代码')
  askCalls = []
  const { decision } = await gate('f1', 'pwsh', { command: 'python heavy.py' })
  assert.equal(askCalls.length, 0)
  assert.match(decision.reason, /用户已明确要求手工计算/)
})

await check('a heavy task asks the confirmation question and honours the answer', async () => {
  sayTo('f1', '跑个矩阵回归分析')
  askCalls = []
  nextAnswer = { answers: [{ id: 'focus-mode-heavy', selected: ['继续手工列式'] }] }
  const keep = await gate('f1', 'pwsh', { command: 'python regression.py' })
  assert.equal(askCalls.length, 1)
  assert.equal(askCalls[0].questions[0].question, HEAVY_PROMPT)
  assert.match(keep.decision.reason, /用户已确认继续手工列式/)
  nextAnswer = { answers: [{ id: 'focus-mode-heavy', selected: ['终止任务'] }] }
  const stop = await gate('f1', 'pwsh', { command: 'python regression.py' })
  assert.match(stop.decision.reason, /用户选择终止/)
})

await check('other capabilities under focus mode go through the dialog', async () => {
  sayTo('f1', '搜索一下最新的行业数据')
  askCalls = []
  nextAnswer = { answers: [{ id: 'focus-mode-subsidiary', selected: ['本次临时放行'] }] }
  const { decision } = await gate('f1', 'web_search', { query: 'x' })
  assert.equal(askCalls.length, 1)
  assert.deepEqual(askCalls[0].questions[0].options.map(o => o.label), ['本次临时放行', '拒绝'])
  assert.equal(decision.kind, 'allow')
})

await check('focus off restores the sandbox', async () => {
  api.setFocusMode('f1', false)
  const { decision } = await gate('f1', 'pwsh', { command: 'python calc.py' })
  assert.notEqual(decision.info && decision.info.code, 'TASK_FOCUS_SANDBOX_DISABLED')
})

// ------------------------------------------------------------------ tier 2

console.log('\n[附属动作管控]')

await check('a self-invented capability is blocked with no dialog', async () => {
  api.setMode('a1', 'code')
  api.setLock('a1', true)
  api.setConfirmSubsidiary('a1', true)
  sayTo('a1', '帮我改一下这个函数')
  askCalls = []
  const { decision } = await gate('a1', 'web_search', { query: 'x' })
  assert.equal(askCalls.length, 0)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /自动联网搜索/)
  assert.match(decision.reason, /不要用话术诱导用户手动执行/)
})

await check('a requested capability asks, and the pass is one-shot', async () => {
  sayTo('a1', '搜索一下这个报错')
  askCalls = []
  nextAnswer = { answers: [{ id: 'focus-mode-subsidiary', selected: ['本次临时放行'] }] }
  const first = await gate('a1', 'web_search', { query: 'x' })
  assert.equal(askCalls.length, 1)
  assert.equal(first.decision.kind, 'allow')
  askCalls = []
  await gate('a1', 'web_search', { query: 'y' })
  assert.equal(askCalls.length, 1, 'the pass is one-shot')
})

await check('declining the dialog blocks the capability', async () => {
  nextAnswer = { answers: [{ id: 'focus-mode-subsidiary', selected: ['拒绝'] }] }
  const { decision } = await gate('a1', 'web_search', { query: 'z' })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /用户提出了该动作，但未获授权执行/)
})

await check('with the confirm switch off, a requested capability runs directly', async () => {
  api.setConfirmSubsidiary('a1', false)
  sayTo('a1', '搜索一下文档')
  askCalls = []
  const { decision } = await gate('a1', 'web_search', { query: 'docs' })
  assert.equal(askCalls.length, 0)
  assert.equal(decision.kind, 'allow')
})

await check('file IO is a subsidiary action too — gated while locked', async () => {
  api.setConfirmSubsidiary('a1', false)
  sayTo('a1', '帮我看看这个函数')
  const blocked = await gate('a1', 'read', { file_path: 'src/app.ts' })
  assert.equal(blocked.decision.kind, 'deny', 'an unrequested file read must be gated')
  assert.match(blocked.decision.reason, /本地文件读写/)

  sayTo('a1', '读一下 src/app.ts 这个文件')
  api.setConfirmSubsidiary('a1', true)
  askCalls = []
  nextAnswer = { answers: [{ id: 'focus-mode-subsidiary', selected: ['本次临时放行'] }] }
  const allowed = await gate('a1', 'read', { file_path: 'src/app.ts' })
  assert.equal(askCalls.length, 1, 'file IO must ask when the confirm switch is on')
  assert.equal(allowed.decision.kind, 'allow')

  nextAnswer = { answers: [{ id: 'focus-mode-subsidiary', selected: ['拒绝'] }] }
  const denied = await gate('a1', 'write', { file_path: 'src/app.ts', content: 'x' })
  assert.equal(denied.decision.kind, 'deny')
})

// ------------------------------------------------------------------ tier 3

console.log('\n[锁定模式]')

await check('a cross-domain call is refused with the verbatim lock copy', async () => {
  const { decision } = await gate('a1', 'write', { file_path: 'deck.pptx' })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /^当前处于锁定模式，仅支持【代码】域任务，无法处理该类型请求。/)
  assert.match(decision.reason, /请关闭锁定模式或者切换任务域/)
})

await check('unlocked sessions fall back to the universal default', async () => {
  api.setLock('a1', false)
  api.setConfirmSubsidiary('a1', false)
  const { decision } = await gate('a1', 'write', { file_path: 'deck.pptx' })
  assert.equal(decision.kind, 'allow')
  const web = await gate('a1', 'web_search', { query: 'x' })
  assert.equal(web.decision.kind, 'allow')
})

// ------------------------------------------------- result classification

console.log('\n[报错分类]')

await check('sandbox failures become a system message and stop retries', async () => {
  api.setMode('r1', 'code')
  api.setLock('r1', true)
  const list = main.listeners.get('tools/post-execute') || []
  const decision = await list[0].fn(
    { name: 'pwsh', arguments: { command: 'dir' }, agent: agentOf('r1'), signal: new AbortController().signal },
    { isError: true, error: { message: 'SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\x)' }, content: [] },
    async () => ({ kind: 'accept' }),
  )
  assert.match(decision.content[0].text, /系统异常/)
  assert.equal(api.snapshot('r1').sandboxFailedAt > 0, true)
  const retry = await gate('r1', 'pwsh', { command: 'dir' })
  assert.equal(retry.decision.kind, 'deny')
  assert.match(retry.decision.reason, /不再重试/)
})

await check('script errors are labelled as code errors', async () => {
  const list = main.listeners.get('tools/post-execute') || []
  const decision = await list[0].fn(
    { name: 'pwsh', arguments: { command: 'python x.py' }, agent: agentOf('r1'), signal: new AbortController().signal },
    { isError: true, error: { message: 'Traceback (most recent call last): SyntaxError' }, content: [] },
    async () => ({ kind: 'accept' }),
  )
  assert.match(decision.content[0].text, /代码报错/)
})

// ------------------------------------------------- intent-only risks

console.log('\n[意图识别：剪贴板 / 跨域切换]')

await check('the keyword tables catch direct, indirect and colloquial phrasings', async () => {
  const clipboardPhrases = [
    '剪贴板里的内容你看一下',
    '我刚复制的那段提示词粘给你',
    '刚才复制的帮我格式化一下',
    '内容我已经复制好了，你读一下',
    'ctrl+v 给你了',
    '我拷了一份贴在对话框里',
    '从板子里读一下',
    'pbpaste 拿一下',
  ]
  for (const phrase of clipboardPhrases) {
    assert.ok(detectSoftIntent(phrase).some(hit => hit.id === 'clipboard'), 'clipboard: ' + phrase)
  }
  const switchPhrases = [
    '帮我切换到图片模式',
    '你切过去做 PPT',
    '换个模式，去做数据分析',
    '模式切到代码',
    '你自动切到文档模式吧',
    '切到另一个域',
    'switch mode to image',
  ]
  for (const phrase of switchPhrases) {
    assert.ok(detectSoftIntent(phrase).some(hit => hit.id === 'domainSwitch'), 'switch: ' + phrase)
  }
  assert.deepEqual(detectSoftIntent('不要切换模式，就留在这里'), [], 'negated switch intent is ignored')
  assert.deepEqual(detectSoftIntent('把这三个数加起来'), [])
})

await check('the advisory dialog uses the verbatim risk copy and records the refusal', async () => {
  api.setMode('s2', 'code')
  api.setLock('s2', true)
  askCalls = []
  nextAnswer = { answers: [{ id: 'focus-mode-risk-clipboard', selected: ['拒绝'] }] }
  sayTo('s2', '剪贴板里那段代码你读一下')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(askCalls.length, 1, 'the advisory dialog must appear on intent')
  const question = askCalls[0].questions[0]
  assert.equal(question.question, '【风险提示】框架限制，插件无法强制阻断该动作。\n动作类型：读取剪贴板\n是否允许执行？')
  assert.deepEqual(question.options.map(option => option.label), ['本次临时放行', '拒绝'])
  const guidance = renderFor('s2')
  assert.ok(guidance.includes('用户刚拒绝了以下动作'), 'the refusal must reach the prompt')
  assert.ok(guidance.includes('读取剪贴板'))
})

// --------------------------------------------- 计数重置 / 开关叠加 / 重置按钮

console.log('\n[计数重置 / 开关叠加 / 重置按钮]')

await check('the drift counter resets on domain switch, focus toggle and lock toggle', async () => {
  api.setMode('c1', 'code')
  api.setLock('c1', false)
  for (const text of ['今天天气不错，讲个笑话吧', '再聊聊历史上的今天吧']) sayTo('c1', text)
  assert.ok(api.snapshot('c1').stats.streak > 0, 'the counter should accumulate while unlocked')
  api.setLock('c1', true)
  assert.equal(api.snapshot('c1').stats.streak, 0, 'lock toggle resets the counter')

  api.setLock('c1', false)
  sayTo('c1', '再聊聊历史上的今天')
  api.setFocusMode('c1', true)
  assert.equal(api.snapshot('c1').stats.streak, 0, 'focus toggle resets the counter')

  api.setFocusMode('c1', false)
  sayTo('c1', '顺便再聊聊别的')
  api.setMode('c1', 'data')
  assert.equal(api.snapshot('c1').stats.streak, 0, 'domain switch resets the counter')
})

await check('lock on + focus on: the sandbox ban from 专注模式 wins', async () => {
  api.setMode('x1', 'data')
  api.setLock('x1', true)
  api.setFocusMode('x1', true)
  sayTo('x1', '帮我核对一下这几个数')
  const sandbox = await gate('x1', 'pwsh', { command: 'python x.py' })
  assert.equal(sandbox.decision.info.code, 'TASK_FOCUS_SANDBOX_DISABLED', '专注 wins over 锁定 for the sandbox')
  assert.match(sandbox.decision.reason, /沙箱已禁用/)
})

await check('lock off + focus on: 专注模式 still applies', async () => {
  api.setMode('x2', 'data')
  api.setLock('x2', false)
  api.setFocusMode('x2', true)
  sayTo('x2', '帮我核对一下这几个数')
  const sandbox = await gate('x2', 'pwsh', { command: 'python y.py' })
  assert.equal(sandbox.decision.kind, 'deny', '专注模式不依赖锁定开关')
  assert.equal(sandbox.decision.info.code, 'TASK_FOCUS_SANDBOX_DISABLED')
})

await check('lock on + focus off: 锁定域文案优先于附属弹窗', async () => {
  api.setMode('x3', 'code')
  api.setLock('x3', true)
  api.setFocusMode('x3', false)
  api.setConfirmSubsidiary('x3', true)
  sayTo('x3', '搜索一下这个报错')
  const cross = await gate('x3', 'write', { file_path: 'deck.pptx' })
  assert.equal(cross.decision.kind, 'deny')
  assert.match(cross.decision.reason, /^当前处于锁定模式，仅支持【代码】域任务/, '锁定 > 附属：跨域优先报锁定文案')
  askCalls = []
  const capable = await gate('x3', 'web_search', { query: 'x' })
  assert.equal(askCalls.length, 1, '同域内的附属动作仍然走确认弹窗')
  assert.ok(['allow', 'deny'].includes(capable.decision.kind))
})

await check('重置为通用模式 only exits the domain lock', async () => {
  api.setMode('r2', 'video')
  api.setLock('r2', true)
  api.setConfirmSubsidiary('r2', true)
  api.setFocusMode('r2', true)
  api.setRigor('r2', 'strict')
  const before = api.snapshot('r2')
  api.resetMode('r2')
  const after = api.snapshot('r2')
  assert.equal(after.mode, 'general', 'mode falls back to general')
  assert.equal(after.stats.streak, 0, 'counter cleared')
  assert.equal(after.locked, before.locked, 'lock switch untouched')
  assert.equal(after.confirmSubsidiary, before.confirmSubsidiary, 'confirm switch untouched')
  assert.equal(after.focusMode, before.focusMode, 'focus switch untouched')
  assert.equal(after.rigor, before.rigor, 'rigor tier untouched')
})

// --------------------------------------------------------- rigor tiers

console.log('\n[严谨档位]')

await check('the default tier is 严谨精简 and all three tiers are exposed', async () => {
  api.setMode('q1', 'data')
  api.setFocusMode('q1', true)
  const state = api.snapshot('q1')
  assert.equal(state.rigor, 'balanced')
  assert.deepEqual(state.rigors.map(level => level.label), ['快速核验', '严谨精简', '极致严谨'])
})

await check('each tier injects its own depth instruction', async () => {
  sayTo('q1', '帮我算一下 12 个月的平均值')
  api.setRigor('q1', 'fast')
  const fast = renderFor('q1')
  assert.ok(fast.includes('【档位：快速核验】'))
  assert.ok(fast.includes('不做多轮复核'))
  assert.ok(!fast.includes('Grubbs'), 'fast must not demand the full suite')
  assert.ok(fast.includes('执行标记'), 'markers survive every tier')

  api.setRigor('q1', 'balanced')
  const balanced = renderFor('q1')
  assert.ok(balanced.includes('【档位：严谨精简】'))
  assert.ok(balanced.includes('先判断任务体量'))
  assert.ok(!balanced.includes('Grubbs'))

  api.setRigor('q1', 'strict')
  const strict = renderFor('q1')
  assert.ok(strict.includes('【档位：极致严谨】'))
  assert.ok(strict.includes('Grubbs'))
  assert.ok(strict.includes('置信区间'))
  assert.ok(strict.includes('累计值/单位误填排除'))
})

await check('a brevity request adds the compression instruction, otherwise it is absent', async () => {
  api.setRigor('q1', 'balanced')
  sayTo('q1', '直接给我这个数据的结论，一句话就行')
  assert.ok(renderFor('q1').includes('【简要输出要求】'))
  sayTo('q1', '帮我做完整的统计分析')
  assert.ok(!renderFor('q1').includes('【简要输出要求】'))
  assert.ok(renderFor('q1').includes('【档位：严谨精简】'))
})

await check('light and heavy tasks get different budgets in the prompt', async () => {
  sayTo('q1', '把这三个数加一下')
  assert.ok(renderFor('q1').includes('轻量计算'))
  sayTo('q1', '跑个矩阵回归分析')
  assert.ok(renderFor('q1').includes('重型计算'))
})

await check('switching tiers never weakens the safety constraints', async () => {
  sayTo('q1', '帮我核对下这几个数')
  for (const level of ['fast', 'balanced', 'strict']) {
    api.setRigor('q1', level)
    assert.equal(api.snapshot('q1').focusMode, true)
    const sandbox = await gate('q1', 'pwsh', { command: 'python x.py' })
    assert.equal(sandbox.decision.kind, 'deny', level + ' must still ban the sandbox')
    assert.equal(sandbox.decision.info.code, 'TASK_FOCUS_SANDBOX_DISABLED')
    const text = renderFor('q1')
    assert.ok(text.includes('沙箱代码执行被禁用'), level + ' keeps the ban notice')
    assert.ok(text.includes('本结果为 LLM 分步验算'), level + ' keeps the error footnote')
  }
})

await check('the rigor tier round-trips through HTTP and storage', async () => {
  const response = await callRoute(main.routes, '/dsh-focus-mode/rigor', 'POST', { session: 'q2', rigor: 'strict' })
  assert.equal(response.json.rigor, 'strict')
  const bad = await callRoute(main.routes, '/dsh-focus-mode/rigor', 'POST', { session: 'q2', rigor: 'nope' })
  assert.equal(bad.status, 400)
  await api.flush()
  const saved = JSON.parse(await fs.readFile(storageFile, 'utf8'))
  assert.equal(saved.sessions.find(entry => entry.id === 'q2').rigor, 'strict')
})

// --------------------------------------------------------------------- http

console.log('\n[http]')

await check('every switch round-trips and persists', async () => {
  const base = { session: 'h1' }
  const focus = await callRoute(main.routes, '/dsh-focus-mode/focus', 'POST', { ...base, focus: true })
  assert.equal(focus.json.focusMode, true)
  const markers = await callRoute(main.routes, '/dsh-focus-mode/markers', 'POST', { ...base, markers: false })
  assert.equal(markers.json.showMarkers, false)
  const confirm = await callRoute(main.routes, '/dsh-focus-mode/confirm', 'POST', { ...base, confirm: true })
  assert.equal(confirm.json.confirmSubsidiary, true)
  const lock = await callRoute(main.routes, '/dsh-focus-mode/lock', 'POST', { ...base, lock: true })
  assert.equal(lock.json.locked, true)
  const mode = await callRoute(main.routes, '/dsh-focus-mode/mode', 'POST', { ...base, mode: 'data' })
  assert.equal(mode.json.mode, 'data')
  const guide = await callRoute(main.routes, '/dsh-focus-mode/guide', 'POST', base)
  assert.equal(guide.json.focusGuideSeen, true)
  await api.flush()
  const saved = JSON.parse(await fs.readFile(storageFile, 'utf8'))
  const stored = saved.sessions.find(entry => entry.id === 'h1')
  assert.equal(stored.focusMode, true)
  assert.equal(stored.showMarkers, false)
  assert.equal(stored.confirmSubsidiary, true)
  assert.equal(stored.lock, true)
  assert.equal(stored.mode, 'data')
  assert.equal(stored.focusGuideSeen, true)

  const second = makeContext()
  const api2 = apply(second.ctx, { storageFile })
  const started = Date.now()
  while (!api2.sessions.has('h1') && Date.now() - started < 1500) await new Promise(r => setTimeout(r, 20))
  const restored = api2.snapshot('h1')
  assert.equal(restored.focusMode, true)
  assert.equal(restored.showMarkers, false)
  assert.equal(restored.confirmSubsidiary, true)
  assert.equal(restored.mode, 'data')
})

await check('the focus guide is shown once', async () => {
  api.setFocusMode('g1', true)
  assert.equal(api.snapshot('g1').focusGuideSeen, false)
  api.seenFocusGuide('g1')
  assert.equal(api.snapshot('g1').focusGuideSeen, true)
})

await check('the approval chain is never touched', async () => {
  assert.equal(main.listeners.has('approval/request'), false)
  assert.equal(main.listeners.has('tools/guard'), false)
  assert.ok(main.listeners.has('tools/pre-execute'))
  assert.ok(main.listeners.has('tools/post-execute'))
})

await api.flush()
await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})

console.log('\n' + (bad === 0 ? 'PASS' : 'FAIL') + ' — ' + ok + ' passed, ' + bad + ' failed\n')
if (bad > 0) process.exitCode = 1
