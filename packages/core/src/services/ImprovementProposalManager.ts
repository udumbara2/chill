/**
 * ImprovementProposalManager — 改进提案管理纯逻辑
 *
 * 职责：解析 proposals.md → 应用决策 → 格式化展示。
 * 纯字符串 in/out，不依赖任何平台 API（fs、路径等），由调用方负责文件 IO。
 */

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

  // 提取 HTML 注释头（## 之前的内容）
  const headerMatch = markdown.match(/^([\s\S]*?)(?=## 待确认)/)
  if (headerMatch) {
    result.header = headerMatch[1].trimEnd()
  }

  // 按 ## 标题分割各区
  const sections = markdown.split(/(?=## (?:待确认|已确认|已实现|已关闭))/)
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

// ==================== 展示 ====================

/**
 * 格式化条目列表为可读展示文本（五项固定格式）。
 * 用于 ask_user 展示给用户。
 */
export function formatEntries(entries: ProposalEntry[]): string {
  if (entries.length === 0) return '（暂无待确认条目）'

  return entries
    .map((e, i) => {
      const lines: string[] = [
        `${i + 1}. [${e.date}] **功能**：${e.title}`,
      ]
      if (e.reason) lines.push(`   理由：${e.reason}`)
      if (e.difficulty) lines.push(`   难度：${e.difficulty}`)
      if (e.benefit) lines.push(`   收益：${e.benefit}`)
      if (e.source) lines.push(`   来源：${e.source}`)
      return lines.join('\n')
    })
    .join('\n\n')
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

/**
 * 格式化条目列表为按组分组展示文本。
 * - 组顺序 = 文件内首次出现顺序；'未分组' 组排最后
 * - 每条保留原始编号（传入数组下标+1），分组只是视觉归类，不改编号——
 *   与决策解析 pending[n-1] 严格对应，保证用户决策零错位
 * - 组内条目完整展示全部字段（难度/收益/理由/来源），一次性全展示、不截断
 */
export function formatEntriesGrouped(entries: ProposalEntry[]): string {
  if (entries.length === 0) return '（暂无待确认条目）'

  // 组顺序 = 首次出现顺序；未分组最后
  const order: string[] = []
  const byGroup = new Map<string, Array<{ idx: number; e: ProposalEntry }>>()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const g = e.group && e.group !== '未分组' ? e.group : '未分组'
    if (!byGroup.has(g)) {
      byGroup.set(g, [])
      if (g !== '未分组') order.push(g)
    }
    byGroup.get(g)!.push({ idx: i, e })
  }
  if (byGroup.has('未分组')) order.push('未分组')

  const parts: string[] = []
  for (const g of order) {
    const items = byGroup.get(g)!
    parts.push(`【${g}】（${items.length} 条）`)
    for (const { idx, e } of items) {
      const lines: string[] = [`${idx + 1}. [${e.date}] ${e.title}`]
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

// ==================== 决策解析 ====================

/**
 * 决策解析结果：区分用户显式动作与未提及自动删除，供摘要回显。
 */
export interface DecisionParseResult {
  /** 用户原始输入（trim 后，供回显） */
  rawInput: string
  /** 快捷项类型（若有）：'all' | 's all' | 'del all' | null */
  shortcut: string | null
  /** 完整 decisions（含未提及自动 close）——与现行为一致 */
  decisions: Decision[]
  /** 实际生效的显式动作数（编号命中 pending 的 y/s；快捷项 = pending.length） */
  explicitCount: number
  /** 未提及自动 close 的条数（仅普通模式 >0；快捷项一律 0——快捷项全部是显式动作） */
  autoClosedCount: number
  /** 越界/无效编号（用户提及但不在 pending 范围，如 y 99） */
  invalidNums: number[]
}

/**
 * 解析用户决策输入为完整的决策结果（纯函数，无 IO）。
 *
 * 语义（语义反转）：用户只需输入「确认」（y）和「跳过」（s）的条目，
 * **未提及的条目自动 close（删除）**——待确认区不再无限堆积。
 *
 * 支持快捷项：
 * - `all`      → 全部 confirm
 * - `s all`    → 全部 skip（全部保留待确认，本次不处理）
 * - `del all`  → 全部 close（全部删除）
 *
 * 空输入保护：无任何有效决策（含快捷项）时返回 decisions 为空的 result，
 * 调用方不得写盘——防止误回车/无效输入触发"未提及自动删除"清空待确认区。
 *
 * @param input 用户原始回复文本
 * @param pending 待确认条目数组（编号 = 下标+1）
 */
export function parseDecisionInput(input: string, pending: ProposalEntry[]): DecisionParseResult {
  const text = (input || '').trim()
  const emptyResult = (): DecisionParseResult => ({ rawInput: text, shortcut: null, decisions: [], explicitCount: 0, autoClosedCount: 0, invalidNums: [] })
  if (!text || pending.length === 0) return emptyResult()

  // 快捷项检测（优先，`s all` 必须先于 `del all`/裸 `all`）——快捷项全部是显式动作
  if (/\bs\s*all\b/i.test(text)) {
    return { rawInput: text, shortcut: 's all', decisions: pending.map(e => ({ title: e.title, action: 'skip' as const })), explicitCount: pending.length, autoClosedCount: 0, invalidNums: [] }
  }
  if (/\bdel\s*all\b/i.test(text)) {
    return { rawInput: text, shortcut: 'del all', decisions: pending.map(e => ({ title: e.title, action: 'close' as const })), explicitCount: pending.length, autoClosedCount: 0, invalidNums: [] }
  }
  if (/\ball\b/i.test(text)) {
    return { rawInput: text, shortcut: 'all', decisions: pending.map(e => ({ title: e.title, action: 'confirm' as const })), explicitCount: pending.length, autoClosedCount: 0, invalidNums: [] }
  }

  // 普通解析：字符类用 [\d,，]+（不含 \s），杜绝 y 吞 s 编号
  const yPattern = /y\s+([\d,，]+)/i
  const sPattern = /s\s+([\d,，]+)/i
  const parseNums = (match: RegExpMatchArray | null): number[] => {
    if (!match) return []
    return match[1].split(/[,，]+/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
  }

  const confirmNums = new Set(parseNums(text.match(yPattern)))
  const skipNums = new Set(parseNums(text.match(sPattern)))

  // 无任何有效决策 → 空 result（空输入保护）
  if (confirmNums.size === 0 && skipNums.size === 0) return emptyResult()

  // 越界编号采集：合并双集合中不在 1..pending.length 的编号，去重升序
  const maxN = pending.length
  const invalidSet = new Set<number>()
  for (const n of [...confirmNums, ...skipNums]) {
    if (n < 1 || n > maxN) invalidSet.add(n)
  }
  const invalidNums = [...invalidSet].sort((a, b) => a - b)

  // 遍历 pending：被 y 提及 → confirm；被 s 提及 → skip；其余 → close
  const decisions: Decision[] = []
  let explicitCount = 0
  for (let i = 0; i < pending.length; i++) {
    const n = i + 1
    const title = pending[i].title
    if (confirmNums.has(n)) {
      decisions.push({ title, action: 'confirm' })
      explicitCount++
    } else if (skipNums.has(n)) {
      decisions.push({ title, action: 'skip' })
      explicitCount++
    } else {
      // 未提及 → 自动 close（删除）
      decisions.push({ title, action: 'close' })
    }
  }
  return {
    rawInput: text,
    shortcut: null,
    decisions,
    explicitCount,
    autoClosedCount: pending.length - explicitCount,
    invalidNums,
  }
}
