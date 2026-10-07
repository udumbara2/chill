/**
 * ImprovementProposalManager — 改进提案管理纯逻辑
 *
 * 职责：解析 proposals.md → 应用决策 → 格式化展示。
 * 纯字符串 in/out，不依赖任何平台 API（fs、路径等），由调用方负责文件 IO。
 */

import { PLAINTEXT_BUDGET_BYTES, type AskTriageCard } from './relay/envelope'

// ==================== 反省提取标准 ====================

/**
 * 机器反省的提取标准 —— 单一定义处。
 *
 * 供两条反省路径共用：自动攒料（improvementProposer.buildProposePrompt）
 * 与手动反省（skills/builtin/self-improve/SKILL.md）。
 *
 * 只收录「从用户使用角度看的、能靠改 chill 自身实现的、需要改变的功能」（改进/添加/删除 三类）；
 * 不收录「让模型换个说法」类规训条目。
 */
export const IMPROVEMENT_EXTRACTION_STANDARD = `【提取标准】
1. 视角 —— 只从用户使用角度出发：描述用户遇到的不便与期望，不写代码落点、不写实现方式。
2. 杠杆 —— 只收「改 chill 自身能实现」的：代码 / 架构 / 设计 / 机制 / 提示词（含技能文档与指令文案）。
3. 边界 —— 不收「让模型换个说法」类：措辞、语气、格式、风格、回复精简度、结论先后一律不算；不要用提示词去约束模型的表达自由。
   注意区分：修补提示词的功能缺陷（指令遗漏、自相矛盾、工具描述不准导致模型用错或做不到）算改进；要求模型改变表达方式不算。
4. 判据 —— 问一句「这条是让 chill 这个产品更好用，还是只是让模型更合我意？」后者不收。

【三类改变】
- 改进：现有功能有缺陷或不顺手，应当改好
- 添加：用户需要一个现在没有的能力，应当补上
- 删除：有功能多余 / 误导 / 添乱，应当去掉`

// ==================== 类型 ====================

export interface ProposalEntry {
  /** 日期标签（如 "2026-07-25"） */
  date: string
  /** 功能标题 */
  title: string
  /** 分组/标签（模型生成，≤6 字；待确认区缺失回退 '未分组'） */
  group?: string
  /** 理由（仅待确认区有） */
  reason?: string
  /** 难度（仅待确认区有） */
  difficulty?: string
  /** 收益（仅待确认区有） */
  benefit?: string
  /** 来源（仅待确认区有） */
  source?: string
}

export interface ParsedProposals {
  /** HTML 注释头 */
  header: string
  pending: ProposalEntry[]
  confirmed: ProposalEntry[]
  closed: ProposalEntry[]
  /** 已关闭区（删除归档，可恢复；不能用 closed——已被「已实现」占用） */
  discarded: ProposalEntry[]
}

export interface Decision {
  /** 条目标题（精确匹配） */
  title: string
  action: 'confirm' | 'close' | 'skip'
}

// ==================== 解析 ====================

const SECTION_HEADER = /^## (待确认|已确认|已实现|已关闭)/

/**
 * 解析 proposals.md 文本，返回结构化数据。
 * 容错：多行理由、字段缺失、空白行异常均不崩溃。
 */
export function parseProposals(markdown: string): ParsedProposals {
  const result: ParsedProposals = { header: '', pending: [], confirmed: [], closed: [], discarded: [] }

  // 提取 HTML 注释头（首个行首「## 待确认」之前的内容）
  // 行锚定（^ + m）：标题文本中段出现 "## 已确认" 字样不得切开文件（R5 结构注入防线的解析器侧兜底——
  // 实测教训：无锚定的 split 会被单行标题里的区名伪装击穿四区边界）
  const headerMatch = markdown.match(/^([\s\S]*?)(?=^## 待确认)/m)
  if (headerMatch) {
    result.header = headerMatch[1].trimEnd()
  }

  // 按行首 ## 标题分割各区（同款行锚定）
  const sections = markdown.split(/(?=^## (?:待确认|已确认|已实现|已关闭))/m)
  for (const section of sections) {
    const headerMatch = section.match(SECTION_HEADER)
    if (!headerMatch) continue

    const sectionName = headerMatch[1]
    const entries = parseSection(section, sectionName)

    switch (sectionName) {
      case '待确认':
        result.pending = entries
        break
      case '已确认':
        result.confirmed = entries
        break
      case '已实现':
        result.closed = entries
        break
      case '已关闭':
        result.discarded = entries
        break
    }
  }

  return result
}

/**
 * 解析单个区段内的条目列表。
 * 待确认区提取五项字段；已确认/已实现区只提取日期和标题。
 */
function parseSection(section: string, sectionName: string): ProposalEntry[] {
  const entries: ProposalEntry[] = []
  // 按 "- [日期] **功能**：" 分割条目
  const entryPattern = /- \[(\d{4}-\d{2}-\d{2})\]\s+\*\*功能\*\*[：:]\s*(.+?)(?=\n- \[|\n## |$)/gs
  let match

  while ((match = entryPattern.exec(section)) !== null) {
    const date = match[1]
    const body = match[2]
    const title = extractLine(body, '功能') || body.split('\n')[0].trim()

    // 所有区都提取组字段；已确认/已实现区若带 "——已关闭（日期）" 等标注则去掉
    const cleanTitle = title.replace(/——.*$/, '').trim()
    const group = extractField(body, '组')

    if (sectionName === '待确认') {
      entries.push({
        date,
        title: cleanTitle,
        group: group || '未分组',
        reason: extractField(body, '理由'),
        difficulty: extractField(body, '难度'),
        benefit: extractField(body, '收益'),
        source: extractField(body, '来源'),
      })
    } else {
      // 已确认/已实现：存量无组字段，缺失留 undefined（不强行标注）
      entries.push({ date, title: cleanTitle, group })
    }
  }

  return entries
}

/** 从条目正文中提取指定字段的值 */
function extractField(body: string, field: string): string | undefined {
  const pattern = new RegExp(`\\*\\*${field}\\*\\*[：:]\\s*(.+?)(?=\\n\\s*\\*\\*|$)`, 's')
  const m = body.match(pattern)
  return m ? m[1].trim() : undefined
}

/** 提取条目第一行（功能标题） */
function extractLine(body: string, _field: string): string {
  const firstLine = body.split('\n')[0]
  return firstLine.replace(/^\*\*功能\*\*[：:]\s*/, '').trim()
}

// ==================== 决策应用 ====================

/**
 * 根据决策列表修改 proposals.md，返回新的完整文本。
 * 决策按 title 精确匹配。
 */
export function applyDecisions(markdown: string, decisions: Decision[]): string {
  const parsed = parseProposals(markdown)

  const confirmTitles = new Set<string>()
  const closeTitles = new Set<string>()

  for (const d of decisions) {
    switch (d.action) {
      case 'confirm':
        confirmTitles.add(d.title)
        break
      case 'close':
        closeTitles.add(d.title)
        break
    }
  }

  // 从待确认区移除被决策的条目
  const remaining: ProposalEntry[] = []
  for (const entry of parsed.pending) {
    if (confirmTitles.has(entry.title)) {
      parsed.confirmed.push(entry)
    } else if (closeTitles.has(entry.title)) {
      // 删除：移入「已关闭」归档区（可恢复），而非彻底丢弃
      parsed.discarded.push(entry)
    } else {
      remaining.push(entry)
    }
  }
  parsed.pending = remaining

  return generateMarkdown(parsed)
}

// ==================== 已确认/已关闭区流转（C+D 手机端命令面迭代） ====================

/** 流转动作（源区→目标区）：close 已确认→已关闭归档；implement 已确认→已实现（手工结账）；requeue 已确认→待确认（重审）；reopen 已关闭→已确认（误关恢复） */
export type ConfirmedTransitionAction = 'close' | 'implement' | 'requeue' | 'reopen'

export interface ConfirmedTransition {
  /** 条目标题（精确匹配源区，与 Decision 同寻址语义） */
  title: string
  action: ConfirmedTransitionAction
}

/**
 * 四向流转（手机端 improve.confirmed.decide 的纯逻辑层）：按 title 匹配源区迁移条目，
 * 未命中幂等无操作（对齐 applyDecisions 语义）；返回新全文与实际迁移数。
 */
export function applyConfirmedTransitions(
  markdown: string,
  transitions: ConfirmedTransition[],
): { markdown: string; applied: number } {
  const parsed = parseProposals(markdown)
  const titlesOf = (action: ConfirmedTransitionAction): Set<string> =>
    new Set(transitions.filter((t) => t.action === action).map((t) => t.title))
  let applied = 0
  /** 从 src 区摘除命中条目压入 dest（返回保留清单） */
  const move = (src: ProposalEntry[], titles: Set<string>, dest: ProposalEntry[]): ProposalEntry[] => {
    const keep: ProposalEntry[] = []
    for (const e of src) {
      if (titles.has(e.title)) {
        dest.push(e)
        applied++
      } else keep.push(e)
    }
    return keep
  }
  const closes = titlesOf('close')
  if (closes.size) parsed.confirmed = move(parsed.confirmed, closes, parsed.discarded)
  const impls = titlesOf('implement')
  if (impls.size) parsed.confirmed = move(parsed.confirmed, impls, parsed.closed)
  const requeues = titlesOf('requeue')
  if (requeues.size) parsed.confirmed = move(parsed.confirmed, requeues, parsed.pending)
  const reopens = titlesOf('reopen')
  if (reopens.size) parsed.discarded = move(parsed.discarded, reopens, parsed.confirmed)
  return { markdown: generateMarkdown(parsed), applied }
}

// ==================== 生成 ====================

/** 根据结构化数据生成完整的 proposals.md 文本 */
function generateMarkdown(parsed: ParsedProposals): string {
  const parts: string[] = []

  if (parsed.header) {
    parts.push(parsed.header.trimEnd())
  }

  parts.push('')
  parts.push('## 待确认')
  if (parsed.pending.length === 0) {
    parts.push('（暂无）')
  } else {
    for (const e of parsed.pending) {
      parts.push(formatPendingEntry(e))
    }
  }

  parts.push('')
  parts.push('## 已确认')
  if (parsed.confirmed.length === 0) {
    parts.push('（暂无）')
  } else {
    for (const e of parsed.confirmed) {
      parts.push(formatSimpleEntry(e))
    }
  }

  parts.push('')
  parts.push('## 已实现')
  if (parsed.closed.length === 0) {
    parts.push('（暂无）')
  } else {
    for (const e of parsed.closed) {
      parts.push(formatSimpleEntry(e))
    }
  }

  parts.push('')
  parts.push('## 已关闭')
  if (parsed.discarded.length === 0) {
    parts.push('（暂无）')
  } else {
    for (const e of parsed.discarded) {
      parts.push(formatSimpleEntry(e))
    }
  }

  return parts.join('\n') + '\n'
}

/** 格式化待确认条目（六字段完整） */
function formatPendingEntry(e: ProposalEntry): string {
  const lines: string[] = [
    `- [${e.date}] **功能**：${e.title}`,
  ]
  if (e.group) lines.push(`  **组**：${e.group}`)
  if (e.reason) lines.push(`  **理由**：${e.reason}`)
  if (e.difficulty) lines.push(`  **难度**：${e.difficulty}`)
  if (e.benefit) lines.push(`  **收益**：${e.benefit}`)
  if (e.source) lines.push(`  **来源**：${e.source}`)
  return lines.join('\n')
}

/** 格式化已确认/已实现条目（标题行 + 组字段，标签全生命周期保留） */
function formatSimpleEntry(e: ProposalEntry): string {
  const lines: string[] = [`- [${e.date}] **功能**：${e.title}`]
  if (e.group) lines.push(`  **组**：${e.group}`)
  return lines.join('\n')
}

// ==================== 分组 ====================

/**
 * 从解析结果中提取全部已有组名（待确认+已确认区合并去重）。
 * 供 improvementProposer 生成新建议时注入 prompt（模型优先复用，避免同义变体）。
 */
export function extractGroupNames(parsed: ParsedProposals): string[] {
  const names = new Set<string>()
  for (const e of [...parsed.pending, ...parsed.confirmed]) {
    if (e.group && e.group !== '未分组') names.add(e.group)
  }
  return [...names]
}

// ==================== 决策视图（簇聚合 · 唯一投影层） ====================

/** 簇聚合的可选参数 */
export interface DecisionViewOptions {
  now?: Date
  /** "近期新增"统计窗口天数（默认 7） */
  recentDays?: number
  /** 只保留前 N 个簇（按活跃度排序后截取；缺省=全部） */
  topN?: number
}

/** 一个问题簇（同组条目的聚合视图）——裁决单位 */
export interface ClusterSummary {
  /** 簇标识：组名以 C 编号开头时为该编号（如 'C26'），否则为组名全称（决策语法的寻址键） */
  id: string
  /** 组名全称 */
  name: string
  entries: ProposalEntry[]
  count: number
  /** 近窗口内新增条数（按 date 字段推导） */
  recent: number
  /** 难度分布 */
  difficulty: { low: number; mid: number; high: number }
  /** 主难度（占比最高者；无难度字段时 undefined） */
  dominantDifficulty: '低' | '中' | '高' | undefined
  /** 簇内最新条目日期（yyyy-MM-dd；无日期字段时空串） */
  latest: string
}

/** 待确认区的决策视图（TopN 已应用） */
export interface DecisionView {
  clusters: ClusterSummary[]
  pendingCount: number
}

/** 账本摘要（状态块/药丸的一行数据源） */
export interface DecisionDigest {
  pending: number
  clusters: number
  confirmed: number
  implemented: number
  /** 近窗口新增条数 */
  recent: number
}

/** 组名 → 簇标识：'C22 健壮性与异常处理' → 'C22'；无编号组名原样返回 */
function clusterIdOf(group: string): string {
  const m = group.match(/^(C\d+)\b/i)
  if (m) return m[1].toUpperCase()
  return group
}

function daysBetween(dateStr: string, now: Date): number {
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return Infinity
  const t = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(t)) return Infinity
  return (now.getTime() - t) / 86_400_000
}

/**
 * 簇聚合唯一事实点（buildDecisionView 与 formatEntriesGrouped 的共同底座）。
 * 排序：近窗口新增 ↓ → 条数 ↓ → 名称 ↑；'未分组' 恒排最后。
 */
export function buildClusterSummaries(entries: ProposalEntry[], opts: DecisionViewOptions = {}): ClusterSummary[] {
  const now = opts.now ?? new Date()
  const recentDays = opts.recentDays ?? 7
  const byGroup = new Map<string, ProposalEntry[]>()
  for (const e of entries) {
    const g = e.group && e.group !== '未分组' ? e.group : '未分组'
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g)!.push(e)
  }
  const clusters: ClusterSummary[] = []
  for (const [name, list] of byGroup) {
    const difficulty = { low: 0, mid: 0, high: 0 }
    let latest = ''
    let recent = 0
    for (const e of list) {
      if (e.difficulty === '低') difficulty.low++
      else if (e.difficulty === '中') difficulty.mid++
      else if (e.difficulty === '高') difficulty.high++
      if (e.date && e.date > latest) latest = e.date
      if (daysBetween(e.date, now) <= recentDays) recent++
    }
    const total = difficulty.low + difficulty.mid + difficulty.high
    const dominantDifficulty =
      total === 0 ? undefined : difficulty.low >= difficulty.mid && difficulty.low >= difficulty.high ? '低' : difficulty.mid >= difficulty.high ? '中' : '高'
    clusters.push({ id: clusterIdOf(name), name, entries: list, count: list.length, recent, difficulty, dominantDifficulty, latest })
  }
  clusters.sort((a, b) => {
    if (a.id === '未分组' && b.id !== '未分组') return 1
    if (b.id === '未分组' && a.id !== '未分组') return -1
    if (b.recent !== a.recent) return b.recent - a.recent
    if (b.count !== a.count) return b.count - a.count
    return a.id.localeCompare(b.id)
  })
  return clusters
}

/** 待确认区决策视图（簇聚合 + 可选 TopN） */
export function buildDecisionView(parsed: ParsedProposals, opts: DecisionViewOptions = {}): DecisionView {
  const clusters = buildClusterSummaries(parsed.pending, opts)
  return { clusters: opts.topN !== undefined ? clusters.slice(0, opts.topN) : clusters, pendingCount: parsed.pending.length }
}

/** 账本摘要：四区计数 + 近窗口新增 */
export function summarizeDigest(parsed: ParsedProposals, opts: DecisionViewOptions = {}): DecisionDigest {
  const now = opts.now ?? new Date()
  const recentDays = opts.recentDays ?? 7
  let recent = 0
  for (const e of parsed.pending) {
    if (daysBetween(e.date, now) <= recentDays) recent++
  }
  const clusters = new Set(parsed.pending.map(e => (e.group && e.group !== '未分组' ? e.group : '未分组')))
  return {
    pending: parsed.pending.length,
    clusters: clusters.size,
    confirmed: parsed.confirmed.length,
    implemented: parsed.closed.length,
    recent,
  }
}

/** 账本摘要的一行文案（core 单一格式化点，CLI 状态块/TUI statusline/GUI 药丸共享） */
export function formatDigestLine(d: DecisionDigest): string {
  const parts: string[] = []
  if (d.recent > 0) parts.push(`近7天新增 ${d.recent}`)
  parts.push(`待确认 ${d.pending} 条 / ${d.clusters} 簇`)
  parts.push(`已确认 ${d.confirmed} 待实施`)
  return parts.join(' · ')
}

/**
 * 条目文本清洗（R5 结构注入防线）：账本是 markdown 人机共写文件，四区边界靠 `## 标题` 行解析、
 * 条目锚定单行格式——外部输入（听写/粘贴/模型输出）的换行与控制字符会伪造区界或字段行。
 * 单行化：控制字符（含 \n）→ 空格 → 连续空白折叠 → 剥行首伪装标记（## / - [日期]）。
 * ledger.capture 与 improvementProposer.appendProposals 共用（后者属同款既有隐患修复）。
 */
export function sanitizeEntryText(raw: string): string {
  let t = (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  t = t.replace(/^(?:#{1,6}\s+)+/, '')
  t = t.replace(/^(?:-\s*\[\d{4}-\d{2}-\d{2}\]\s*)+/, '')
  return t.trim()
}

/** 老化决策：近 windowDays 未被决策的待确认条目 → close（移入已关闭区，可恢复） */
export interface AgingResult {
  decisions: Decision[]
  closed: number
  /** 摘要行（无老化时 null） */
  summary: string | null
}

export function buildAgingDecisions(parsed: ParsedProposals, opts: { days?: number; now?: Date } = {}): AgingResult {
  const now = opts.now ?? new Date()
  const days = opts.days ?? 30
  const decisions: Decision[] = []
  for (const e of parsed.pending) {
    if (daysBetween(e.date, now) > days) decisions.push({ title: e.title, action: 'close' })
  }
  if (decisions.length === 0) return { decisions, closed: 0, summary: null }
  return {
    decisions,
    closed: decisions.length,
    summary: `已自动归档 ${decisions.length} 条超过 ${days} 天未决策的提案（移入「已关闭」区，可恢复）`,
  }
}

/**
 * 格式化条目列表为按组分组展示文本（消费 buildClusterSummaries——分组唯一事实点的展示层）。
 * - 组顺序 = 活跃度（近期新增 ↓ → 条数 ↓）；'未分组' 组排最后
 * - 每条保留原始编号（传入数组下标+1），分组只是视觉归类，不改编号——
 *   与决策解析 pending[n-1] 严格对应，保证用户决策零错位
 * - 组内条目完整展示全部字段（难度/收益/理由/来源），一次性全展示、不截断
 */
export function formatEntriesGrouped(entries: ProposalEntry[], opts: DecisionViewOptions = {}): string {
  if (entries.length === 0) return '（暂无待确认条目）'
  const index = new Map<ProposalEntry, number>()
  for (let i = 0; i < entries.length; i++) index.set(entries[i], i + 1)

  const parts: string[] = []
  for (const c of buildClusterSummaries(entries, opts)) {
    parts.push(`【${c.name}】（${c.count} 条${c.recent > 0 ? ` · 近期+${c.recent}` : ''}）`)
    for (const e of c.entries) {
      const n = index.get(e)!
      const lines: string[] = [`${n}. [${e.date}] ${e.title}`]
      const meta: string[] = []
      if (e.difficulty) meta.push(`【难度】${e.difficulty}`)
      if (e.benefit) meta.push(`【收益】${e.benefit}`)
      if (meta.length > 0) lines.push(`   ${meta.join(' | ')}`)
      if (e.reason) lines.push(`   理由：${e.reason}`)
      if (e.source) lines.push(`   来源：${e.source}`)
      parts.push(lines.join('\n'))
    }
    parts.push('')
  }
  return parts.join('\n').trimEnd()
}

/**
 * 簇级紧凑概览（ask 提问卡视图）：digest 行 + 每簇一行摘要（名称含簇编号=决策寻址键）。
 * manage_improvements 无决策分支的提问正文——三端（TUI 菜单/GUI 弹窗/手机提问卡）共一份
 * payload，全量逐条清单会击穿手机 64KB 线上预算且卡片不可读；逐条阅读的正位是
 * /improve TUI 面板与 GUI 改进面板（直接读账本，不经 ask）。封顶 maxClusters 簇，其余折叠。
 */
export function formatClusterOverview(
  parsed: ParsedProposals,
  opts: DecisionViewOptions & { maxClusters?: number } = {},
): string {
  const digest = formatDigestLine(summarizeDigest(parsed, opts))
  const clusters = buildClusterSummaries(parsed.pending, opts)
  if (clusters.length === 0) return `待确认改进提案（${digest}）：\n（暂无待确认条目）`
  const cap = opts.maxClusters ?? 30
  const shown = clusters.slice(0, cap)
  const lines: string[] = [`待确认改进提案（${digest}），按活跃度排序的问题簇：`]
  for (const c of shown) {
    const bits = [`${c.count} 条`]
    if (c.recent > 0) bits.push(`近7天+${c.recent}`)
    if (c.dominantDifficulty) bits.push(`${c.dominantDifficulty}难度为主`)
    if (c.latest) bits.push(`最新 ${c.latest}`)
    lines.push(`- ${c.name}（${bits.join(' · ')}）`)
  }
  if (clusters.length > shown.length) {
    lines.push(`- …其余 ${clusters.length - shown.length} 簇略（逐条阅读请用桌面 /improve 面板或改进面板）`)
  }
  return lines.join('\n')
}

// ==================== 点选裁决卡（手机端 ask 卡载荷 · 构造唯一事实点） ====================

/** 「未分组」簇的卡片哨兵 id（组名无 C 编号可寻址；卡载荷/桌面快照展开/文本回退三处口径一致） */
export const UNGROUPED_CLUSTER_ID = '__ungrouped__'

/** 每页簇数上限（分页帽；页内仍受预算约束可继续收缩。收尾页豁免：剩余整页装得下就全装——
 *  与懒算时代产出的页界口径一致，布局前置不改分页观感） */
export const TRIAGE_BATCH_MAX_CLUSTERS = 20

/** 理由字段截断长度（预算降级第一档） */
export const TRIAGE_REASON_MAX_CHARS = 120

/** 字符串 UTF-8 字节数（TextEncoder 三端可用；本文件保持 Node-free） */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

type TriageEntryWire = NonNullable<NonNullable<AskTriageCard['clusters']>[number]['entries']>[number]

/** buildTriageCard / planTriageLayout / buildTriagePageCard 的可选构造参数 */
export interface TriageCardOptions {
  /** 开庭 pending 快照（entries 编号 n=快照下标+1 的事实源，与 parseDecisionInput 编号语义同源；
   *  缺省=不带 entries，维持纯簇摘要卡形态） */
  pending?: ProposalEntry[]
  /** 页起始簇下标（须为 planTriageLayout 产出的页界；缺省 0=首页） */
  batchOffset?: number
  /** 本庭已落账标注（原地翻页回翻已决页的只读渲染数据源；title 命中即在 entry 上带 decided） */
  decidedByTitle?: ReadonlyMap<string, 'confirm' | 'close' | 'skip'>
}

/** 页卡详情档位（降级链三档：理由全文 → 理由截 120 → 每簇首条详情其余仅标题） */
export type TriageDetailMode = 'full' | 'trim120' | 'firstOnly'

/** 一页的簇切片（offset=起始簇下标，clusterCount=本页簇数） */
export interface TriagePageSpec {
  offset: number
  clusterCount: number
}

/** 分页布局（开庭会话事实：pages 即"第 x/y 批"全程恒定的分母来源） */
export interface TriageLayout {
  mode: TriageDetailMode
  pages: TriagePageSpec[]
}

/** 投影上下文（digest 一次算好；pendingIndex 为编号映射；reserveDecided=按 decided 最坏余量计费） */
interface TriageProjection {
  digest: string
  pendingIndex: Map<ProposalEntry, number> | null
  decidedByTitle?: ReadonlyMap<string, 'confirm' | 'close' | 'skip'>
  reserveDecided: boolean
}

function makeTriageProjection(view: DecisionView, opts: TriageCardOptions, reserveDecided: boolean): TriageProjection {
  const recent = view.clusters.reduce((sum, c) => sum + c.recent, 0)
  const digestParts: string[] = []
  if (recent > 0) digestParts.push(`近7天新增 ${recent}`)
  digestParts.push(`待确认 ${view.pendingCount} 条 / ${view.clusters.length} 簇`)
  // entries 编号映射：同一批 ProposalEntry 对象引用（buildClusterSummaries 不拷贝）→ 快照下标+1
  const pendingIndex = opts.pending ? new Map<ProposalEntry, number>() : null
  if (opts.pending) {
    for (let i = 0; i < opts.pending.length; i++) pendingIndex!.set(opts.pending[i], i + 1)
  }
  return { digest: digestParts.join(' · '), pendingIndex, decidedByTitle: opts.decidedByTitle, reserveDecided }
}

/**
 * 簇切片 → 线形投影（含簇 id 唯一性闸：同 id 第 N 次出现确定性加 #N 后缀——实测 bug 根治，
 * 组名不同但 C 编号相同的簇会产出重复 id，手机 validateTriageCard 整卡拒绝；按切片内顺序，
 * 分页布局下同一簇只在一页出现，页间无相互影响。
 * 注意：# 后缀 id 文本语法不可寻址（parseDecisionInput 无此表层），仅结构化 decisions 可达）
 */
function projectTriageClusters(pj: TriageProjection, clusters: ClusterSummary[], mode: TriageDetailMode): AskTriageCard['clusters'] {
  const seenIds = new Map<string, number>()
  const uniqueId = (id: string): string => {
    const n = (seenIds.get(id) ?? 0) + 1
    seenIds.set(id, n)
    return n === 1 ? id : `${id}#${n}`
  }
  const entryWire = (e: ProposalEntry, detailed: boolean): TriageEntryWire => {
    const n = pj.pendingIndex?.get(e) ?? 0
    // reserveDecided=布局预算计费的最坏情形（"decided":"confirm" 为三个动作词最长者）；serve 按实际标注
    const decided = pj.reserveDecided ? ('confirm' as const) : pj.decidedByTitle?.get(e.title)
    if (!detailed) return { n, title: e.title, ...(decided ? { decided } : {}) }
    const reason =
      e.reason !== undefined && mode !== 'full' && e.reason.length > TRIAGE_REASON_MAX_CHARS
        ? `${e.reason.slice(0, TRIAGE_REASON_MAX_CHARS)}…`
        : e.reason
    return {
      n,
      title: e.title,
      ...(reason !== undefined ? { reason } : {}),
      ...(e.difficulty !== undefined ? { difficulty: e.difficulty } : {}),
      ...(e.benefit !== undefined ? { benefit: e.benefit } : {}),
      ...(e.source !== undefined ? { source: e.source } : {}),
      ...(decided ? { decided } : {}),
    }
  }
  return clusters.map((c) => ({
    id: uniqueId(c.id === '未分组' ? UNGROUPED_CLUSTER_ID : c.id),
    name: c.name,
    count: c.count,
    recent: c.recent,
    ...(c.dominantDifficulty ? { difficulty: c.dominantDifficulty } : {}),
    latest: c.latest,
    ...(pj.pendingIndex
      ? { entries: c.entries.map((e, i) => entryWire(e, mode !== 'firstOnly' || i === 0)) }
      : {}),
  }))
}

/** 预算判定：card 序列化字节 + question 实际字节合计 ≤ PLAINTEXT_BUDGET_BYTES（合计口径防叠加顶爆） */
function triageCardFits(pj: TriageProjection, clusters: ClusterSummary[], mode: TriageDetailMode, questionBytes: number): boolean {
  const card: AskTriageCard = { digest: pj.digest, clusters: projectTriageClusters(pj, clusters, mode) }
  return utf8Bytes(JSON.stringify(card)) + questionBytes <= PLAINTEXT_BUDGET_BYTES
}

/**
 * 裁决卡分页布局（开庭时一次性计算的会话事实——"第 x/y 批"的 y 跳变 bug 根治：
 * 页大小曾是预算动态收缩且逐页懒算[首页帽 20、次页整剩 27]，手机端 y=ceil(total/当前页簇数)
 * 随页跳变；布局前置后 pageCount 全程恒定）。纯函数、确定性：同一 view 快照 + 同一预算口径
 * 逐页切片，输入同则布局逐字同。
 *
 * 预算口径：card 序列化字节 + question 实际字节合计 ≤ PLAINTEXT_BUDGET_BYTES，且**按 decided
 * 标注的最坏情形计费**（每条目预留 "decided":"confirm" 载荷——翻页下发带标注时绝不爆预算）。
 * 降级链与懒算时代一致：理由截断 120 字 → 首条详情 → 分页（firstOnly 逐页贪心：收尾页豁免
 * 20 帽[剩余整页装得下就全装]，否则帽 20 再按预算收缩）→ 整体不带卡（返回 null）。
 */
export function planTriageLayout(view: DecisionView, questionBytes: number, opts: TriageCardOptions = {}): TriageLayout | null {
  const pj = makeTriageProjection(view, opts, true)
  const total = view.clusters.length
  if (total === 0) return null

  // 降级链前两档：整案单页能装（最坏余量计）→ 单页布局
  for (const mode of ['full', 'trim120', 'firstOnly'] as const) {
    if (triageCardFits(pj, view.clusters, mode, questionBytes)) {
      return { mode, pages: [{ offset: 0, clusterCount: total }] }
    }
  }

  // 分页档：firstOnly 逐页贪心
  const pages: TriagePageSpec[] = []
  let offset = 0
  while (offset < total) {
    const remaining = total - offset
    // 收尾页豁免帽：剩余整页装得下就全装（与懒算产出的页界口径一致——实测 47 簇=20+27 两页）
    if (triageCardFits(pj, view.clusters.slice(offset), 'firstOnly', questionBytes)) {
      pages.push({ offset, clusterCount: remaining })
      break
    }
    let size = Math.min(TRIAGE_BATCH_MAX_CLUSTERS, remaining)
    while (size > 1 && !triageCardFits(pj, view.clusters.slice(offset, offset + size), 'firstOnly', questionBytes)) size--
    if (!triageCardFits(pj, view.clusters.slice(offset, offset + size), 'firstOnly', questionBytes)) return null
    pages.push({ offset, clusterCount: size })
    offset += size
  }
  return { mode: 'firstOnly', pages }
}

/**
 * 页卡构造（布局的消费点）：按布局第 pageIndex 页投影 + decidedByTitle 标注。
 * 预算由布局的最坏余量保证（serve 不重算）——布局存在即页卡合法。
 */
export function buildTriagePageCard(
  view: DecisionView,
  layout: TriageLayout,
  pageIndex: number,
  opts: TriageCardOptions = {},
): AskTriageCard | null {
  const page = layout.pages[pageIndex]
  if (!page) return null
  const pj = makeTriageProjection(view, opts, false)
  const clusters = view.clusters.slice(page.offset, page.offset + page.clusterCount)
  return {
    digest: pj.digest,
    clusters: projectTriageClusters(pj, clusters, layout.mode),
    ...(layout.pages.length > 1
      ? { batch: { offset: page.offset, total: view.clusters.length, pageIndex, pageCount: layout.pages.length } }
      : {}),
  }
}

/**
 * 裁决卡构造（兼容包装 = planTriageLayout + 按 batchOffset 找页投影）：
 * DecisionView → 协议线形 AskTriageCard（digest 自含，手机不解析 question 文本）。
 * batchOffset 须为布局页界（court 全程供给页界 offset）；非页界返回 null。
 */
export function buildTriageCard(view: DecisionView, questionBytes: number, opts: TriageCardOptions = {}): AskTriageCard | null {
  const layout = planTriageLayout(view, questionBytes, opts)
  if (!layout) return null
  const offset = opts.batchOffset ?? 0
  const pageIndex = layout.pages.findIndex((p) => p.offset === offset)
  if (pageIndex < 0) return null
  return buildTriagePageCard(view, layout, pageIndex, opts)
}

// ==================== 决策解析 ====================

/**
 * 决策解析结果：区分用户显式动作与未提及处置，供摘要回显。
 */
export interface DecisionParseResult {
  /** 用户原始输入（trim 后，供回显） */
  rawInput: string
  /** 快捷项类型（若有）：'all' | 's all' | 'del all' | null */
  shortcut: string | null
  /** 完整 decisions（未提及条目按 opts.onUnmitted 处置；显式动作按 title 键控去重） */
  decisions: Decision[]
  /** 实际生效的显式动作数（命中 pending 的 y/s/del；快捷项 = pending.length） */
  explicitCount: number
  /** 未提及自动 close 的条数（onUnmentioned='close' 时 = pending-explicitCount；'keep' 时恒 0） */
  autoClosedCount: number
  /** 越界/无效编号（用户提及但不在 pending 范围，如 y 99） */
  invalidNums: number[]
  /** 无法解析的非编号目标（簇标识不存在或前缀歧义），供回显引导 */
  invalidTargets: string[]
}

export interface ParseDecisionOptions {
  /**
   * 未提及条目的处置：
   * - 'keep'（默认）= 保留待确认——防"确认 1 条静默归档其余全部"的丢失面
   * - 'close' = 自动移入已关闭区（旧语义；膨胀靠 buildAgingDecisions 有界化）
   */
  onUnmentioned?: 'keep' | 'close'
}

type ActionKind = Decision['action']
const DECISION_VERBS: Record<string, ActionKind> = {
  y: 'confirm', 确认: 'confirm',
  s: 'skip', 跳过: 'skip',
  del: 'close', 删除: 'close',
}

interface DecisionSegment {
  action: ActionKind
  targets: string[]
}

/** 动词段扫描：把输入切成「动作 → 目标列表」序列（中文动词与"簇"后缀先行分词） */
function scanDecisionSegments(text: string): DecisionSegment[] {
  const normalized = text.replace(/(确认|跳过|删除|簇)/g, ' $1 ')
  const segments: DecisionSegment[] = []
  let current: DecisionSegment | null = null
  for (const raw of normalized.split(/[\s,，、]+/)) {
    const token = raw.trim()
    if (!token) continue
    const verb = DECISION_VERBS[token.toLowerCase()]
    if (verb) {
      current = { action: verb, targets: [] }
      segments.push(current)
      continue
    }
    if (token === '簇' || token === '整簇') continue
    if (current) current.targets.push(token)
  }
  return segments
}

/** 非编号目标（簇标识）解析：精确 → 唯一前缀 → 组名全称；歧义/未命中返回 null */
function resolveClusterTarget(token: string, clusters: ClusterSummary[]): string[] | null {
  const lower = token.toLowerCase()
  const exact = clusters.filter(c => c.id.toLowerCase() === lower)
  if (exact.length === 1) return exact[0].entries.map(e => e.title)
  const byName = clusters.filter(c => c.name.toLowerCase() === lower)
  if (byName.length === 1) return byName[0].entries.map(e => e.title)
  const prefix = clusters.filter(c => c.id.toLowerCase().startsWith(lower))
  if (prefix.length === 1) return prefix[0].entries.map(e => e.title)
  return null
}

/**
 * 解析用户决策输入为完整的决策结果（纯函数，无 IO）。
 *
 * 目标寻址（每段动作后可跟多个目标，逗号/空格分隔）：
 * - 编号：`y 1,3`（pending 下标+1，与分组展示的原始序号严格对应）
 * - 簇标识：`y C26`（C 编号精确或唯一前缀）、`y 检索噪声过滤`（组名全称，仅适用于无空格组名）
 * - 友好短语：`确认 C26 簇` / `跳过 C26` / `删除 C26`（与各壳选项按钮的 label 对齐）
 *
 * 快捷项：`all` 全确认 / `s all` 全跳过 / `del all` 全删除。
 *
 * 未提及语义见 ParseDecisionOptions.onUnmentioned（默认 keep）。
 * 空输入保护：无任何有效显式动作时返回 decisions 为空的 result，调用方不得写盘。
 */
export function parseDecisionInput(input: string, pending: ProposalEntry[], opts: ParseDecisionOptions = {}): DecisionParseResult {
  const onUnmentioned = opts.onUnmentioned ?? 'keep'
  const text = (input || '').trim()
  const emptyResult = (): DecisionParseResult => ({ rawInput: text, shortcut: null, decisions: [], explicitCount: 0, autoClosedCount: 0, invalidNums: [], invalidTargets: [] })
  if (!text || pending.length === 0) return emptyResult()

  // 快捷项检测（优先，`s all` 必须先于 `del all`/裸 `all`）——快捷项全部是显式动作
  if (/\bs\s*all\b/i.test(text)) {
    return { rawInput: text, shortcut: 's all', decisions: pending.map(e => ({ title: e.title, action: 'skip' as const })), explicitCount: pending.length, autoClosedCount: 0, invalidNums: [], invalidTargets: [] }
  }
  if (/\bdel\s*all\b/i.test(text)) {
    return { rawInput: text, shortcut: 'del all', decisions: pending.map(e => ({ title: e.title, action: 'close' as const })), explicitCount: pending.length, autoClosedCount: 0, invalidNums: [], invalidTargets: [] }
  }
  if (/\ball\b/i.test(text)) {
    return { rawInput: text, shortcut: 'all', decisions: pending.map(e => ({ title: e.title, action: 'confirm' as const })), explicitCount: pending.length, autoClosedCount: 0, invalidNums: [], invalidTargets: [] }
  }

  const segments = scanDecisionSegments(text)
  const clusters = buildClusterSummaries(pending)
  const actionByTitle = new Map<string, ActionKind>()
  const invalidNums = new Set<number>()
  const invalidTargets = new Set<string>()
  let explicitCount = 0

  for (const seg of segments) {
    if (seg.targets.length === 0) continue
    for (const target of seg.targets) {
      if (/^\d+$/.test(target)) {
        const n = parseInt(target, 10)
        if (n >= 1 && n <= pending.length) {
          const title = pending[n - 1].title
          if (!actionByTitle.has(title)) explicitCount++
          actionByTitle.set(title, seg.action)
        } else {
          invalidNums.add(n)
        }
        continue
      }
      const titles = resolveClusterTarget(target, clusters)
      if (titles) {
        for (const title of titles) {
          if (!actionByTitle.has(title)) explicitCount++
          actionByTitle.set(title, seg.action)
        }
      } else {
        invalidTargets.add(target)
      }
    }
  }

  // 空输入保护：无任何有效显式动作 → decisions 为空（调用方不得写盘）；
  // 但越界编号/无效目标仍随结果带回（供交互面回显引导，不让"y 99"静默无反馈）
  if (explicitCount === 0) {
    return {
      ...emptyResult(),
      invalidNums: [...invalidNums].sort((a, b) => a - b),
      invalidTargets: [...invalidTargets],
    }
  }

  const decisions: Decision[] = []
  for (let i = 0; i < pending.length; i++) {
    const title = pending[i].title
    const explicit = actionByTitle.get(title)
    if (explicit) {
      decisions.push({ title, action: explicit })
    } else if (onUnmentioned === 'close') {
      // 未提及 → 自动 close（旧语义，需显式传入）
      decisions.push({ title, action: 'close' })
    }
    // onUnmentioned='keep'（默认）→ 未提及不产生决策，保留待确认
  }

  return {
    rawInput: text,
    shortcut: null,
    decisions,
    explicitCount,
    autoClosedCount: onUnmentioned === 'close' ? pending.length - explicitCount : 0,
    invalidNums: [...invalidNums].sort((a, b) => a - b),
    invalidTargets: [...invalidTargets],
  }
}
