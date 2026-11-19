/**
 * dsh-focus-mode — the mode catalog.
 *
 * Each mode carries three kinds of data:
 *
 *   1. **Directional guidance** (`guidance`) — the verbatim text injected into
 *      the session's system prompt. It exists to converge the model's reasoning
 *      budget and context attention onto the current main task, not merely to
 *      fence work off: 严谨、准确、深度 first, 自发拓展 out.
 *   2. **Panel data** (`label` / `short` / `brief` / `hint` / `core` /
 *      `subsidiary`) — what the tab row and the hover hints show.
 *   3. **Gate data** (`domains`, `subsidiary[].keywords` / `.domains`,
 *      `SIGNATURES`) — how the Host tells a main-domain call, a subsidiary
 *      action, and a fully cross-domain call apart.
 *
 * Every mode is resident in the tab row; the panel only folds tabs into
 * 「更多模式」 when the measured row width cannot hold them.
 *
 * `general` is unrestricted: it injects nothing and the gate never fires.
 */

/** Panel order — every mode is resident in the tab row. */
export const MODE_IDS = ['general', 'image', 'ppt', 'video', 'code', 'doc', 'data']

/** The tab row starts with the whole catalog; narrow windows fold the tail away. */
export const PRIMARY_MODE_IDS = ['general', 'image', 'ppt', 'video', 'code', 'doc', 'data']

/** Nothing is parked behind a dropdown by default. */
export const SECONDARY_MODE_IDS = []

/** The unattended default. */
export const DEFAULT_MODE_ID = 'general'

/** Human labels for the gated domains. */
export const DOMAIN_LABELS = {
  image: '图片',
  ppt: 'PPT',
  video: '视频',
  code: '代码',
  doc: '文档',
  data: '数据分析',
}

/** Words that make a message a continuation, never chitchat. */
const CONTINUATION_HINTS = [
  '继续', '接着', '好的', '好滴', '可以', '嗯', '行', '再来', '谢谢', '收到',
  '下一步', '没问题', '辛苦了', '不错', '在吗', '继续吧', '重试',
  'ok', 'okay', 'continue', 'go on', 'yes', 'next', 'thanks', 'retry',
]

// ---------------------------------------------------------------- signatures

/** Tools whose whole purpose is image generation. */
const IMAGE_TOOL = /(^|[^a-z])(image|img|picture|draw|paint)[_-]?(gen|generate|generation|create|edit)?([^a-z]|$)|generate[_-]?image|image[_-]?gen|dall|midjourney|stable[_-]?diffusion|文生图|画图|出图/i

/** Tools whose whole purpose is video generation. */
const VIDEO_TOOL = /generate[_-]?video|video[_-]?gen|text[_-]?to[_-]?video|sora|runway|kling|pika|文生视频|视频生成/i

/** Command-level evidence of chart rendering. */
const PLOT_HINT = /matplotlib|seaborn|plotly|pyecharts|pandas\.plot|\.plot\(|plt\.|echarts|chart\.js|ggplot|折线图|柱状图|饼图|散点图|热力图|直方图|可视化/i

const EXT = {
  ppt: /\.(pptx?|key|odp|potx?)$/i,
  doc: /\.(docx?|pdf|rtf|odt)$/i,
  data: /\.(xlsx?|csv|tsv|parquet|ods)$/i,
  video: /\.(mp4|mov|avi|mkv|webm)$/i,
  image: /\.(png|jpe?g|svg|webp|psd|tiff?)$/i,
}

/** Tools that write a file whose extension already names its domain. */
const ARTIFACT_TOOLS = new Set(['write', 'edit', 'present'])

/** Tools whose command text can betray a plotting detour. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell'])

const argumentText = (args) => {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return ''
  }
}

/**
 * Classify one tool call into a *gated* domain.
 *
 * Deliberately narrow: only calls whose product or purpose already names a
 * domain are classified. General purpose work (reading, searching, running a
 * script that builds a PPTX, writing source files) is never classified, because
 * that is how every domain gets its work done — blocking it would fight the very
 * focus this plugin is protecting.
 *
 * @param {string} toolName the wire tool name
 * @param {unknown} args the parsed arguments
 * @returns {{domain: string, evidence: string} | null} the domain, or null when unrestricted
 */
export function classifyToolCall (toolName, args) {
  const name = typeof toolName === 'string' ? toolName : ''
  if (!name) return null

  if (IMAGE_TOOL.test(name)) return { domain: 'image', evidence: '工具 ' + name }
  if (VIDEO_TOOL.test(name)) return { domain: 'video', evidence: '工具 ' + name }

  const text = argumentText(args)

  if (ARTIFACT_TOOLS.has(name)) {
    const paths = text.match(/"[^"]*?(\.[a-z0-9]{2,5})"/ig) || []
    for (const raw of paths) {
      const candidate = raw.replace(/"/g, '')
      for (const [domain, pattern] of Object.entries(EXT)) {
        if (pattern.test(candidate)) return { domain, evidence: '产物 ' + candidate }
      }
    }
  }

  if (SHELL_TOOLS.has(name) && PLOT_HINT.test(text)) {
    return { domain: 'data', evidence: '命令含绘图/分析特征' }
  }

  return null
}

// -------------------------------------------------------------------- modes

/** Appended to every focused mode: what the harness will actually enforce. */
const ACTION_RULES = [
  '',
  '动作判定（harness 会按此执行，请与之保持一致）：',
  '1. 主域任务：直接执行，优先投入推理深度，把严谨、准确、细节做扎实。',
  '2. 附属配套动作：只有当用户在原始提问里明确写出时才执行；你自己中途新增的附属动作一律不做，也不要主动提议。',
  '3. 完全跨领域任务：直接拒绝并回到主域，harness 会拦截该调用，且不提供放行选项。',
  '4. 安全与权限审批优先级最高：聚焦约束不替代、不绕过任何审批。',
]

const GENERAL = {
  id: 'general',
  label: '通用默认模式',
  short: '通用',
  accent: 'var(--dsw-alias-state-idle-primary, #8b8d95)',
  brief: '不限制任务域，按原生策略处理任何任务。',
  hint: '关闭任务域聚焦：不做定向约束，也不做跨域拦截。',
  core: ['不限任务域'],
  subsidiary: [],
  domains: { core: [], subsidiary: [] },
  guidance: '',
  keywords: [],
}

const IMAGE = {
  id: 'image',
  label: '图片聚焦模式',
  short: '图片',
  accent: '#e0a458',
  brief: '主域：识图、修图、生图。',
  hint: '聚焦画面要素、构图与风格；附属「简短文字描述」仅在用户明确要求时执行。',
  core: ['识图', '修图', '生图'],
  subsidiary: [{
    key: 'caption',
    label: '简短文字描述',
    keywords: ['文字描述', '文字说明', '说明文字', '描述一下', '写一段描述', 'caption'],
    domains: [],
  }],
  domains: { core: ['image'], subsidiary: [] },
  keywords: [
    '图', '画', '画面', '构图', '光影', '光线', '风格', '镜头', '景深', '焦段', '视角',
    '提示词', '绘图', '绘画', '绘制', '插画', '海报', '头像', '立绘', '背景', '配色', '渲染',
    '分辨率', '画幅', '比例', '参考图', '修图', '抠图', '出图', '原画', '写真', '壁纸',
    'image', 'picture', 'photo', 'poster', 'logo', 'art', 'render', 'midjourney', 'dall', 'prompt',
  ],
  guidance: [
    '【聚焦约束生效】当前为图片聚焦模式，请优先分配推理资源、上下文注意力到本领域任务。优先保证结果严谨、逻辑可靠、细节充分；禁止自发拓展、主动锦上添花、自行追加附属功能。附属配套能力（简短文字描述）仅在用户明确写出需求时执行，你不能主动提议、主动生成附属动作；完全跨领域的请求直接拦截拒绝。',
    '你的核心目标：精准理解图像需求、生成符合描述的图像prompt、图像内容解析。优先把控画面要素、构图、风格；不要主动写代码、做数据分析、写PPT；用户没有要求文字说明时，只专注图像相关工作。',
  ].join('\n'),
}

const PPT = {
  id: 'ppt',
  label: 'PPT 聚焦模式',
  short: 'PPT',
  accent: '#e2725b',
  brief: '主域：大纲、页面文案、版式。',
  hint: '聚焦大纲逻辑、层级与每页核心内容；附属「页面备注」仅在用户明确要求时执行。',
  core: ['大纲', '页面文案', '版式'],
  subsidiary: [{
    key: 'note',
    label: '页面备注',
    keywords: ['备注', '讲稿', '演讲词', '备注页', 'note'],
    domains: [],
  }],
  domains: { core: ['ppt'], subsidiary: [] },
  keywords: [
    'ppt', 'pptx', '幻灯片', '幻灯', '演示', '汇报', '宣讲', '大纲', '目录', '封面',
    '排版', '分页', '页面', '页数', '要点', '配图', '配色', '版式', '主题色', '母版',
    'slide', 'deck', 'keynote', 'presentation', 'layout',
  ],
  guidance: [
    '【聚焦约束生效】当前为PPT大纲聚焦模式，请优先分配推理资源、上下文注意力到本领域任务。优先保证结果严谨、逻辑可靠、细节充分；禁止自发拓展、主动锦上添花、自行追加附属功能。附属配套能力（页面备注）仅在用户明确写出需求时执行，你不能主动提议、主动生成附属动作；完全跨领域的请求直接拦截拒绝。',
    '你的核心目标：搭建逻辑通顺、层级清晰的汇报大纲，规划每页核心内容。优先保证结构合理、重点突出；不要主动写代码、画图、生成小说文案；用户没有要求备注时，只专注PPT框架搭建。',
  ].join('\n'),
}

const VIDEO = {
  id: 'video',
  label: '视频聚焦模式',
  short: '视频',
  accent: '#b06cf0',
  brief: '主域：脚本、分镜构思。',
  hint: '聚焦脚本、分镜与叙事节奏；附属「配套台词」仅在用户明确要求时执行。',
  core: ['脚本', '分镜构思'],
  subsidiary: [{
    key: 'line',
    label: '配套台词',
    keywords: ['台词', '对白', '配音词', '台词本', '旁白稿'],
    domains: [],
  }],
  domains: { core: ['video'], subsidiary: [] },
  keywords: [
    '视频', '分镜', '镜头', '运镜', '转场', '景别', '机位', '时长', '叙事', '短片',
    '片段', '配音', '字幕', '节奏', '脚本', '拍摄', '混剪', '特效',
    'video', 'storyboard', 'shot', 'scene', 'clip', 'reels', 'footage', 'cinematic',
  ],
  guidance: [
    '【聚焦约束生效】当前为视频脚本聚焦模式，请优先分配推理资源、上下文注意力到本领域任务。优先保证结果严谨、逻辑可靠、细节充分；禁止自发拓展、主动锦上添花、自行追加附属功能。附属配套能力（配套台词）仅在用户明确写出需求时执行，你不能主动提议、主动生成附属动作；完全跨领域的请求直接拦截拒绝。',
    '你的核心目标：撰写脚本、规划分镜、节奏设计。优先保证叙事流畅、镜头逻辑通顺；不要主动画图、写代码、做数据分析；用户没有要求台词时，只专注分镜与脚本框架。',
  ].join('\n'),
}

const CODE = {
  id: 'code',
  label: '代码聚焦模式',
  short: '代码',
  accent: '#4d6bfe',
  brief: '主域：编码、调试、排错、解读。',
  hint: '聚焦可运行代码与边界、异常、逻辑校验；附属「绘制流程图」「生成文件」仅在用户明确要求时执行。',
  core: ['编码', '调试', '排错', '解读'],
  subsidiary: [
    {
      key: 'flow',
      label: '绘制流程图',
      keywords: ['流程图', '架构图', '时序图', '示意图', '关系图', 'flowchart', 'diagram'],
      domains: ['image'],
    },
    {
      key: 'file',
      label: '生成文件',
      keywords: ['生成文件', '导出文件', '输出文件', '另存为'],
      domains: [],
    },
  ],
  domains: { core: [], subsidiary: ['image'] },
  keywords: [
    '代码', '函数', '类', '接口', '变量', '报错', '异常', '调试', '编译', '运行',
    '测试', '单测', '重构', '性能', '依赖', '仓库', '提交', '算法', '数据结构',
    '内存', '线程', '并发', '脚本', '程序', '源码', '部署', '架构',
    'bug', 'fix', 'refactor', 'test', 'build', 'compile', 'debug', 'api',
    'java', 'python', 'node', 'typescript', 'javascript', 'sql', 'c++', 'rust', 'golang',
  ],
  guidance: [
    '【聚焦约束生效】当前为代码聚焦模式，请优先分配推理资源、上下文注意力到本领域任务。优先保证结果严谨、逻辑可靠、细节充分；禁止自发拓展、主动锦上添花、自行追加附属功能。附属配套能力（绘制流程图、生成文件）仅在用户明确写出需求时执行，你不能主动提议、主动生成附属动作；完全跨领域的请求直接拦截拒绝。',
    '你的核心目标：写出规范、可运行、鲁棒性强的代码，优先处理边界条件、注释、异常处理、逻辑校验。不要主动生成效果图、文档封面、PPT等无关内容；没有用户明确要求时，只专注代码实现、逻辑解释、bug排查。',
  ].join('\n'),
}

const DOC = {
  id: 'doc',
  label: '文档审阅聚焦模式',
  short: '文档',
  accent: '#3fa796',
  brief: '主域：精读、批注、摘要、对比。',
  hint: '聚焦忠于原文的要点提炼与逻辑辨析；附属「整理提纲」仅在用户明确要求时执行。',
  core: ['精读', '批注', '摘要', '对比'],
  subsidiary: [{
    key: 'outline',
    label: '整理提纲',
    keywords: ['提纲', '大纲', 'outline', '结构梳理', '框架整理'],
    domains: [],
  }],
  domains: { core: ['doc'], subsidiary: [] },
  keywords: [
    '文档', '审阅', '批注', '校对', '摘要', '精读', '对比', '润色', '改写', '提纲',
    '章节', '段落', '措辞', '语病', '错别字', '格式', '参考文献', '报告', '论文',
    'readme', 'review', 'proofread', 'summary', 'abstract', 'document',
  ],
  guidance: [
    '【聚焦约束生效】当前为文档聚焦模式，请优先分配推理资源、上下文注意力到本领域任务。优先保证结果严谨、逻辑可靠、细节充分；禁止自发拓展、主动锦上添花、自行追加附属功能。附属配套能力（整理提纲）仅在用户明确写出需求时执行，你不能主动提议、主动生成附属动作；完全跨领域的请求直接拦截拒绝。',
    '你的核心目标：精读原文、提炼要点、梳理逻辑、辨析观点、归纳结论。优先保证忠于原文，不脑补额外信息；不要主动生成PPT配图、插画、脚本等无关内容；用户没有要求提纲时，只专注文本总结、批注、辨析。',
  ].join('\n'),
}

const DATA = {
  id: 'data',
  label: '数据分析聚焦模式',
  short: '数据',
  accent: '#5b8def',
  brief: '主域：计算、校验、数据处理。',
  hint: '聚焦计算逻辑、数据异常与结论可靠性；附属「绘图」「导出/运行脚本」仅在用户明确要求时执行。',
  core: ['计算', '校验', '数据处理'],
  subsidiary: [
    {
      key: 'chart',
      label: '绘图',
      keywords: ['绘图', '画图', '画个图', '画一张图', '画一下图', '做个图', '出个图', '作图', '图表', '可视化', '折线图', '柱状图', '散点图', 'plot', 'chart'],
      domains: ['data'],
    },
    {
      key: 'export',
      label: '导出/运行脚本',
      keywords: ['导出', 'excel', 'csv', '脚本', '运行脚本', '另存为'],
      domains: ['data'],
    },
  ],
  domains: { core: [], subsidiary: ['data'] },
  keywords: [
    '数据', '分析', '统计', '计算', '校验', '核对', '指标', '报表', '表格', 'excel',
    'csv', 'sql', '查询', '聚合', '平均', '中位数', '方差', '趋势', '同比', '环比',
    '转化率', '留存', '分布', '异常值', '可视化', '图表',
    'data', 'analysis', 'metric', 'dashboard', 'pivot',
  ],
  guidance: [
    '【聚焦约束生效】当前为数据分析聚焦模式，请优先分配推理资源、上下文注意力到本领域任务。优先保证结果严谨、逻辑可靠、细节充分；禁止自发拓展、主动锦上添花、自行追加附属功能。附属配套能力（绘图、导出/运行脚本）仅在用户明确写出需求时执行，你不能主动提议、主动生成附属动作；完全跨领域的请求直接拦截拒绝。',
    '你的核心目标：深度完成数据计算、校验、统计分析、误差核验、结果解读。优先检查计算逻辑、核验数据异常、给出可靠结论；不要主动美化图表、主动导出文件、主动画图。如果用户没有主动要求绘图、导出脚本，只专注做好分析与计算本身。',
  ].join('\n'),
}

/** The catalog, keyed by mode id. */
export const MODES = {
  general: GENERAL,
  image: IMAGE,
  ppt: PPT,
  video: VIDEO,
  code: CODE,
  doc: DOC,
  data: DATA,
}

/** Whether `id` names a real mode. */
export function isModeId (id) {
  return typeof id === 'string' && MODE_IDS.includes(id)
}

/**
 * The model-facing guidance for one mode, or `''` for `general`.
 *
 * The mode paragraph is verbatim deployment text; the appended action rules
 * spell out what the Host enforces, so the model is never surprised by a denied
 * call. Flat text: no `{{variable}}` groups (the prompt renderer treats those as
 * references and fails the whole assembly).
 *
 * @param {object} mode one entry of {@link MODES}
 * @returns {string} the section text, or `''` when the mode injects nothing
 */
export function renderGuidance (mode) {
  if (!mode || mode.id === DEFAULT_MODE_ID || !mode.guidance) return ''
  const lines = [mode.guidance, ...ACTION_RULES]
  if (mode.core.length > 0) lines.push('', `本模式主域：${mode.core.join('、')}。`)
  if (mode.subsidiary.length > 0) {
    lines.push(`附属白名单（次要辅助，不主动推荐、不主动生成）：${mode.subsidiary.map(item => item.label).join('、')}。`)
  }
  return lines.join('\n')
}

/**
 * The panel-facing catalog.
 * @returns {Array<object>} one entry per mode, in panel order
 */
export function publicModes () {
  return MODE_IDS.map((id) => {
    const mode = MODES[id]
    return {
      id: mode.id,
      label: mode.label,
      short: mode.short,
      accent: mode.accent,
      brief: mode.brief,
      hint: mode.hint,
      core: mode.core,
      subsidiary: mode.subsidiary.map(item => item.label),
      primary: PRIMARY_MODE_IDS.includes(id),
    }
  })
}

/**
 * Classify one user message against the active mode (only used by the
 * "auto return to general" behavior, which is off whenever the lock is on).
 *
 * @param {string} text the user-authored message text
 * @param {object} mode the mode the session is currently in
 * @returns {'focus'|'neutral'|'offtopic'} the verdict
 */
export function classifyIntent (text, mode) {
  const normalized = typeof text === 'string' ? text.toLowerCase().replace(/\s+/g, ' ').trim() : ''
  if (normalized === '') return 'neutral'
  if (normalized.length <= 8 && CONTINUATION_HINTS.some(hint => normalized.includes(hint))) return 'neutral'
  if (mode && mode.keywords.some(keyword => normalized.includes(keyword))) return 'focus'
  if (normalized.length < 8) return 'neutral'
  return 'offtopic'
}

/**
 * The subsidiary item the user explicitly asked for in this turn, if any.
 *
 * "Explicit" is decided from the user's own words: an agent may not conclude on
 * its own that a subsidiary action is wanted.
 *
 * @param {string} text the latest user-authored message text
 * @param {object} mode the mode the session is currently in
 * @returns {object | null} the matching subsidiary item
 */
export function askedSubsidiary (text, mode) {
  const normalized = typeof text === 'string' ? text.toLowerCase() : ''
  if (!mode || normalized === '') return null
  for (const item of mode.subsidiary) {
    if (!Array.isArray(item.keywords)) continue
    if (item.keywords.some(keyword => normalized.includes(keyword.toLowerCase()))) return item
  }
  return null
}

/**
 * The subsidiary item a gated signature belongs to, or null when the mode does
 * not treat that domain as a subsidiary capability.
 *
 * @param {object} mode the active mode
 * @param {string} domain the gated domain of the pending call
 * @returns {object | null} the subsidiary item that owns the domain
 */
export function subsidiaryForDomain (mode, domain) {
  if (!mode || !Array.isArray(mode.subsidiary)) return null
  for (const item of mode.subsidiary) {
    if (Array.isArray(item.domains) && item.domains.includes(domain)) return item
  }
  return null
}
