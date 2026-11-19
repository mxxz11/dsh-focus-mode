/**
 * dsh-focus-mode — 附属动作（subsidiary capability）taxonomy.
 *
 * Two independent guardrails live in this plugin:
 *
 *   1. **task-domain lock** — which *kinds of task* a session may do;
 *   2. **subsidiary-action control** — whether the model may reach for
 *      capabilities beyond plain text reasoning: sandbox execution, file IO,
 *      web access, downloads, clipboard, system info, batch subagents,
 *      recursive children, self-questioning, OCR, document parsing.
 *
 * This module owns (2): the mapping from wire tools to those capabilities, the
 * words that count as "the user explicitly asked for it", and the heuristic that
 * separates light manual computation from heavy computation.
 *
 * Pure text work, arithmetic the model can do by hand, formula derivation and
 * in-domain writing are **not** subsidiary actions and are never gated.
 */

/** The twelve subsidiary capabilities, in panel/report order. */
export const SUBSIDIARY_ACTIONS = [
  { id: 'sandbox', label: '沙箱代码执行', tool: 'shell' },
  { id: 'file', label: '本地文件读写', tool: 'file' },
  { id: 'web', label: '自动联网搜索', tool: 'web' },
  { id: 'download', label: '下载资源', tool: 'web' },
  { id: 'clipboard', label: '读取剪贴板', tool: 'none' },
  { id: 'sysinfo', label: '读取系统信息', tool: 'shell' },
  { id: 'subagentBatch', label: '批量子任务', tool: 'subagent' },
  { id: 'domainSwitch', label: '自动跨任务域切换', tool: 'none' },
  { id: 'subagentRecursive', label: '自动发起递归子任务', tool: 'subagent' },
  { id: 'selfQuestion', label: '自动多轮自助追问', tool: 'question' },
  { id: 'ocr', label: '图片 OCR', tool: 'image' },
  { id: 'docParse', label: '文档自动解析', tool: 'document' },
]

/** Tool name → subsidiary capability id. Unlisted tools are ordinary work. */
const TOOL_ACTIONS = {
  // sandbox code execution
  pwsh: 'sandbox',
  bash: 'sandbox',
  shell: 'sandbox',
  terminal_open: 'sandbox',
  terminal_read: 'sandbox',
  terminal_write: 'sandbox',
  terminal_signal: 'sandbox',
  terminal_list: 'sandbox',
  terminal_close: 'sandbox',
  job_list: 'sandbox',
  job_output: 'sandbox',
  job_kill: 'sandbox',
  // local file read/write
  read: 'file',
  write: 'file',
  edit: 'file',
  glob: 'file',
  grep: 'file',
  // network
  web_search: 'web',
  web_fetch: 'download',
  // batch / recursive subagents
  subagent: 'subagentBatch',
  subagent_fork: 'subagentBatch',
  workflow: 'subagentBatch',
  spawn_teammate: 'subagentBatch',
  send_message: 'subagentBatch',
  team_task_create: 'subagentBatch',
  team_task_update: 'subagentBatch',
  team_task_list: 'subagentBatch',
  team_task_get: 'subagentBatch',
  list_agents: 'subagentBatch',
  // self-questioning
  ask_user_question: 'selfQuestion',
  // vision / document capability
  read_image: 'ocr',
  present: 'docParse',
}

/** Words that mean the user asked for one capability in their own message. */
const ASK_KEYWORDS = {
  sandbox: ['跑', '执行', '运行', '脚本', '代码算', 'python', '命令', '沙箱', '终端', 'npm', 'node'],
  file: ['读文件', '写文件', '保存', '文件', '目录', '导出到', '读取', '打开', '修改文件'],
  web: ['搜索', '搜一下', '查一下', '联网', '网上', '检索', '搜索一下'],
  download: ['下载', '抓取', '爬取', '网页', '链接', 'fetch'],
  clipboard: ['剪贴板', '粘贴板'],
  sysinfo: ['系统信息', '环境变量', '进程', 'cpu', '内存占用', '磁盘'],
  subagentBatch: ['子任务', '子 agent', '并行', '批量处理', '分头', '多个 agent'],
  domainSwitch: ['切换模式', '换个模式'],
  subagentRecursive: ['递归', '继续拆解子任务'],
  selfQuestion: ['问我', '确认一下', '让我选'],
  ocr: ['识别图片', 'ocr', '读图', '图片内容', '看图'],
  docParse: ['解析文档', '解析这个 pdf', '读取文档', '文档内容', '打开这份文档'],
}

/** Words that forbid sandbox execution outright, whatever the task weight. */
const MANUAL_ONLY_HINTS = ['手工计算', '不要跑代码', '别跑代码', '手算', '心算', '不要用脚本', '手工列式', '不要执行代码']

/** Words that mark a heavy computation task. */
const HEAVY_HINTS = [
  '矩阵', '回归', '大数据', '批量', '循环', '迭代', '模拟', '蒙特卡洛', '聚类', '拟合',
  '十万', '百万', '千万', '上万', '数千行', '几十万',
  'pandas', 'numpy', 'dataframe', 'csv 文件', 'excel 文件', '数据集',
  '绘图', '画图', '可视化', '折线图', '柱状图', '散点图',
  '爬虫', '批量处理', '脚本处理',
]

/** Tools that execute in the sandbox (the capability 专注模式 disables). */
const SANDBOX_TOOLS = new Set([
  'pwsh', 'bash', 'shell',
  'terminal_open', 'terminal_read', 'terminal_write', 'terminal_signal', 'terminal_list', 'terminal_close',
])

/** Whether this wire tool is a subsidiary capability, and which one. */
export function subsidiaryOf (toolName) {
  const id = TOOL_ACTIONS[toolName]
  if (!id) return null
  return SUBSIDIARY_ACTIONS.find(action => action.id === id) || null
}

/** Whether this wire tool runs inside the sandbox. */
export function isSandboxTool (toolName) {
  return SANDBOX_TOOLS.has(toolName)
}

/** Whether the user's message explicitly asks for one capability. */
export function userAskedFor (text, actionId) {
  const normalized = typeof text === 'string' ? text.toLowerCase() : ''
  if (normalized === '' || !actionId) return false
  const keywords = ASK_KEYWORDS[actionId]
  if (!Array.isArray(keywords)) return false
  return keywords.some(keyword => normalized.includes(keyword.toLowerCase()))
}

/** Whether the user explicitly forbade running code. */
export function userForbadeSandbox (text) {
  const normalized = typeof text === 'string' ? text.toLowerCase() : ''
  if (normalized === '') return false
  return MANUAL_ONLY_HINTS.some(hint => normalized.includes(hint.toLowerCase()))
}

/**
 * Whether a task looks heavy — the trigger for the 专注模式 "continue manually?"
 * question. Deliberately conservative: only explicit complexity markers count,
 * plus a row-count above the configured limit.
 *
 * @param {string} text the user's message
 * @param {Record<string, number>} numbers the numeric literals found in the message
 * @param {number} limit the configured hand-computation limit
 * @returns {boolean} true when the task should be treated as heavy
 */
export function looksHeavy (text, numbers, limit) {
  const normalized = typeof text === 'string' ? text.toLowerCase() : ''
  if (HEAVY_HINTS.some(hint => normalized.includes(hint.toLowerCase()))) return true
  const threshold = Number.isFinite(limit) && limit > 0 ? limit : 200
  if (Array.isArray(numbers)) {
    for (const value of numbers) {
      if (Number.isFinite(value) && value >= threshold) return true
    }
  }
  return false
}

/** Numeric literals in a message, used only by {@link looksHeavy}. */
export function numbersIn (text) {
  const normalized = typeof text === 'string' ? text : ''
  const found = []
  for (const match of normalized.match(/\d[\d,_]*/g) || []) {
    const value = Number(match.replace(/[,_]/g, ''))
    if (Number.isFinite(value)) found.push(value)
  }
  return found
}

/** The footnote the model must append to a manually computed result. */
export const MANUAL_NOTE = '本结果为 LLM 分步验算，复杂计算存在出错概率，有条件建议使用沙箱脚本复核。'

/** The 专注模式 heavy-task prompt copy, verbatim. */
export const HEAVY_PROMPT = '当前专注模式，沙箱不可用。该任务复杂度高，手工验算出错概率高，是否继续使用手工列式尝试？'

/** The 锁定模式 refusal copy, verbatim. */
export const lockRefusal = (domainLabel) =>
  `当前处于锁定模式，仅支持【${domainLabel}】域任务，无法处理该类型请求。如需处理其他任务，请关闭锁定模式或者切换任务域。`

// ------------------------------------------------------------- rigor tiers

/**
 * 专注模式 has three rigor tiers. They change **depth and length only** — the
 * sandbox ban, subsidiary gating, execution markers and the error footnote are
 * identical in all three.
 */
export const RIGOR_LEVELS = [
  {
    id: 'fast',
    label: '快速核验',
    brief: '基础校验，token 开销最低',
    detail: '保留误差提示与执行标记，不做额外多轮复核；适合简单验算、快速核对。',
    tooltip: '出结果快，基础严谨性高于普通对话',
  },
  {
    id: 'balanced',
    label: '严谨精简',
    brief: '默认，按任务体量自适应',
    detail: '简单查询或要求简短时只给结论与必要算式；复杂测算自动启用完整复核流程。',
    tooltip: '平衡速度、篇幅与可信度（推荐）',
  },
  {
    id: 'strict',
    label: '极致严谨',
    brief: '全套复核，token 开销最高',
    detail: '强制多轮复核、累计值排除、污染回归对比、置信区间、Grubbs 临界值，完整推理链。',
    tooltip: '全链路复核，高可信正式场景，开销更高',
  },
]

/** The default tier. */
export const DEFAULT_RIGOR = 'balanced'

/** Whether `id` names a rigor tier. */
export function isRigorId (id) {
  return typeof id === 'string' && RIGOR_LEVELS.some(level => level.id === id)
}

/**
 * The tier-specific prompt fragment.
 * @param {string} id the rigor tier
 * @returns {string} the instruction block for this tier
 */
export function rigorGuidance (id) {
  if (id === 'fast') {
    return [
      '【档位：快速核验】只做基础合规底线校验：直接给结果与关键算式，不做多轮复核、不做多方法交叉验证、不展开推导过程；',
      '但必须保留执行标记与误差提示。目标是在可信的前提下用最低 token 开销快速给出结果。',
    ].join('\n')
  }
  if (id === 'strict') {
    return [
      '【档位：极致严谨】强制完整校验流程，全部执行且不可省略：',
      '数据初检与口径确认 → 多方法异常检验（IQR、MAD 稳健 Z、Grubbs 及临界值）→ 累计值/单位误填排除 → 含异常值与剔除异常值双口径对比 → 污染回归对比（斜率与 R² 变化）→ 置信区间 → 完整推理链与可逐步复核的计算过程。',
      '结论必须可追溯到具体算式；适合高风险、正式报告、对外交付场景。',
    ].join('\n')
  }
  return [
    '【档位：严谨精简】先判断任务体量再决定深度：',
    '简单查询、单步验算、或用户要求简短结论时——只给结论 + 必要算式 + 执行标记 + 误差提示，不展开冗余推导、不堆方法。',
    '复杂测算、统计分析、回归等任务——自动启用完整复核流程（数据初检、异常核验、双口径、可复核计算、必要时置信区间）。',
    '目标：日常场景兼顾可信、篇幅与成本。',
  ].join('\n')
}

/** Phrases that ask for a compressed answer. */
const BRIEF_INTENT = /一句话|简短|简洁|精简|简明|只要结论|只给结论|直接给结果|直接给结论|别废话|不用解释|简单说|概括一下|浓缩|短一点|简要/

/** Whether the user explicitly asked for a short answer. */
export function wantsBrief (text) {
  const normalized = typeof text === 'string' ? text : ''
  return BRIEF_INTENT.test(normalized)
}

/** The compression instruction appended when the user asked for brevity. */
export const BRIEF_LINE = '【简要输出要求】用户要求简短：只给结论 + 必要算式 + 执行标记 + 误差提示，不要展开推导、不要罗列方法、不要附带额外建议。'

// ------------------------------------------------------- intent-only risks

/**
 * 读取剪贴板 / 自动跨域切换 have **no native tool in DSH**, so this plugin cannot
 * force-block them. It can only recognise the intent and raise the advisory
 * dialog. The keyword tables below are deliberately huge: indirect, polite,
 * implicit, inverted, abbreviated and colloquial phrasings all count.
 */
export const INTENT_ONLY_ACTIONS = {
  clipboard: {
    id: 'clipboard',
    label: '读取剪贴板',
    keywords: [
      '剪贴板', '剪切板', '粘贴板', '剪贴版', '剪切版', 'clipboard', 'paste buffer', 'system clipboard',
      'read clipboard', 'get-clipboard', 'get-clipboard', 'pbpaste', 'xclip', 'xsel', 'wl-paste',
      'ctrl+v', 'ctrl-v', 'cmd+v', 'cmd-v', 'ctrl+c', '复制粘贴', '粘贴过来', '复制过来',
      '我刚复制', '我复制的', '刚才复制的', '刚复制的', '我复制了', '已经复制好', '复制好了',
      '我拷贝的', '我刚拷贝', '拷过来的', '拷贝的内容', '我拷了', '我拷的', '我抄好了', '我刚抄',
      '我贴过来', '贴给你', '我粘过来', '我粘贴的', '我贴的', '贴一下我', '粘贴一下我',
      '从剪贴板', '剪贴板里', '板子里的内容', '剪贴板的内容', '剪贴板里那段', '复制在剪贴板',
      '已经放剪贴板', '我复制到输入框', '我复制在输入框', '我贴进对话框', '我粘贴到对话框',
      '粘到对话框', '粘贴到输入框', '贴到输入框', '你看剪贴板', '读一下剪贴板', '取一下剪贴板',
      '拿剪贴板', '读剪贴板', '取剪贴板', '内容我已经复制', '我复制好了', '我复制了一段',
      '刚才那段我复制', '我复制在', '复制在板', '板子里', '从板子里读', '粘贴过来的内容',
    ],
  },
  domainSwitch: {
    id: 'domainSwitch',
    label: '自动跨域切换',
    keywords: [
      '切换任务域', '切换模式', '换个模式', '换模式', '换一下模式', '模式换一下', '换任务域',
      '切任务域', '切域', '换域', '换领域', '切领域', '换个领域', '转到别的域', '转去别的域',
      '切到图片', '切到PPT', '切到ppt', '切到代码', '切到视频', '切到文档', '切到数据',
      '切换到', '切换至', '换到图片', '换到代码', '换到ppt', '换到文档', '换到数据', '换到视频',
      '切换到另一个', '换去', '转去', '转成图片模式', '转成代码模式',
      '切到图片模式', '切到PPT模式', '切到代码模式', '切到视频模式', '切到文档模式', '切到数据模式',
      '切到另一个', '换到另一个', '切过去', '换过去', '你切过去', '你先切', '你切一下', '你换一下',
      '你换一下吧', '切一下呗', '帮着切', '帮我切过去', '帮我切模式', '自己去切', '自己换一下模式',
      '帮我自动切换', '自动切到', '自动换到', '自动进入', '自动切模式', '直接进入PPT模式',
      '模式调成', '模式切成', '模式改成', '模式改成PPT', '改成PPT模式', '变成代码模式',
      '去做PPT', '你去做PPT', '顺手切换到', '你去切换', '模式你去换', 'PPT模式切一下',
      '代码模式切过去', 'switch mode', 'switch domain', 'change mode', 'auto-switch',
      'switch to image mode', 'switch to code mode', 'switch to ppt mode',
    ],
  },
}

/** Phrases that cancel a domain-switch intent ("不要切换模式"). */
const SWITCH_NEGATION = /(不要|别|不用|无需|不需要|禁止|不必)[^。；，,]{0,8}(切换|换|切到|切过去|换到)/

/** The advisory dialog copy, verbatim from the product spec. */
export const riskQuestion = (label) =>
  `【风险提示】框架限制，插件无法强制阻断该动作。\n动作类型：${label}\n是否允许执行？`

/**
 * Recognise the two intent-only risks in a user message.
 * @param {string} text the user-authored message
 * @returns {Array<{id: string, label: string, matched: string}>} recognised risks
 */
export function detectSoftIntent (text) {
  const normalized = typeof text === 'string' ? text.toLowerCase() : ''
  if (normalized === '') return []
  const hits = []
  for (const action of Object.values(INTENT_ONLY_ACTIONS)) {
    if (action.id === 'domainSwitch' && SWITCH_NEGATION.test(normalized)) continue
    const matched = action.keywords.find(keyword => normalized.includes(keyword.toLowerCase()))
    if (matched) hits.push({ id: action.id, label: action.label, matched })
  }
  return hits
}
