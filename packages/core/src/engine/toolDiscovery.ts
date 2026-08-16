import type { ToolDefinition } from '../types/models'
import { CORE_TOOLS, MODE_TOOLS, DESKTOP_TOOLS } from '../services/builtInTools'

/**
 * 工具渐进发现层：纯函数、零外部依赖、无副作用，可独立单测。
 * 职责：按类别分组的纯名字索引构建（系统提示注入用）、BM25-lite 工具检索（search_tools 元工具用）、
 * 可见集计算与保序过滤（API 传参处裁剪用）、[activated] 名单行的生成与解析（history 扫描重建激活集用）。
 * 接线（当轮语料暂存、激活集生命周期、注入器）在 ChatEngine / ContextAssembler / builtInToolExecutor，本文件不做。
 */

/** 工具目录条目：检索与索引注入的最小信息单元 */
export interface ToolCatalogEntry {
  name: string
  description: string
  category: string
}

/** 检索命中：目录条目 + 完整工具定义（有定义时结果文本内联完整 schema） */
export interface ToolSearchHit {
  entry: ToolCatalogEntry
  definition?: ToolDefinition
}

/** 检索语料输入：完整 ToolDefinition 或预构建的目录条目 */
export type ToolCorpusInput = ToolDefinition | ToolCatalogEntry

/** 未归类工具的兜底类别名（TOOL_CATEGORY 未覆盖、MCP/agent 资源之外的输入落入） */
export const TOOL_CATEGORY_FALLBACK = '其他'

/** search_tools 结果文本末尾的机器可解析名单行前缀（history 扫描重建激活集的解析依据，改动须同步解析方） */
export const ACTIVATED_LINE_PREFIX = '[activated]'

/**
 * 渐进发现启用的绝对阈值（deferrable 工具定义序列化字符数）：低于该值时全量内联、不分层。
 * 换算来源：行业教训要求用绝对 token 数而非窗口百分比（Claude Code #39279——1M 窗口下 10% 百分比失效），
 * 阈值取 ~8K token；工具定义为中英混排 JSON，按 ~3 字符/token 粗算换算为 24000 字符，避免每轮跑 tokenizer。
 */
export const PROGRESSIVE_TOOLS_MIN_DEFERRABLE_CHARS = 24000

/** BM25-lite 参数（沿用经典取值） */
const BM25_K1 = 1.5
const BM25_B = 0.75

/**
 * 分词（BM25-lite 语料与 query 共用）：
 * 拉丁字母/数字小写单词（_ 等符号天然切分，工具名拆词由此覆盖）+ CJK 连续段的单字与二元组（近似中文匹配）。
 */
const tokenize = (text: string): string[] => {
  const tokens: string[] = []
  const latin = text.toLowerCase().match(/[a-z0-9]+/g)
  if (latin) tokens.push(...latin)
  const cjk = text.match(/[一-鿿]+/g) // 等价 [\u4e00-\u9fff]，CJK 统一表意文字基本区
  if (cjk) {
    for (const seg of cjk) {
      for (const ch of seg) tokens.push(ch)
      for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2))
    }
  }
  return tokens
}

/** 递归收集参数 schema 文本：参数名 + 参数描述（语料组成部分） */
const collectParamText = (schema: any, out: string[]): void => {
  if (!schema || typeof schema !== 'object') return
  if (typeof schema.description === 'string') out.push(schema.description)
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, val] of Object.entries(schema.properties)) {
      out.push(key)
      collectParamText(val, out)
    }
  }
  if (schema.items) collectParamText(schema.items, out)
}

const isToolDefinition = (input: ToolCorpusInput): input is ToolDefinition =>
  typeof (input as ToolDefinition).function === 'object' && (input as ToolDefinition).function !== null

/** 语料归一化：ToolDefinition → 带定义的命中；ToolCatalogEntry → 仅目录条目的命中 */
const toHit = (input: ToolCorpusInput, categories?: Record<string, string>): ToolSearchHit => {
  if (isToolDefinition(input)) {
    const name = input.function.name
    return {
      entry: { name, description: input.function.description, category: categories?.[name] ?? TOOL_CATEGORY_FALLBACK },
      definition: input,
    }
  }
  return { entry: input }
}

/** 构建单条语料 tokens：名字 + 名字按 _ 拆词（tokenize 天然覆盖）+ 描述 + 参数名/参数描述 */
const corpusTokens = (hit: ToolSearchHit): string[] => {
  const fields = [hit.entry.name, hit.entry.name.replace(/_/g, ' '), hit.entry.description]
  if (hit.definition) {
    const paramText: string[] = []
    collectParamText(hit.definition.function.parameters, paramText)
    fields.push(...paramText)
  }
  const tokens = tokenize(fields.join(' '))
  tokens.push(hit.entry.name.toLowerCase()) // 完整名字作为整体 token，提高按名检索的区分度
  return tokens
}

/** BM25-lite 排序：零命中（全部 0 分）返回空数组，由调用方走降级 */
const bm25Search = (hits: ToolSearchHit[], query: string, limit: number): ToolSearchHit[] => {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0 || hits.length === 0) return []
  const docs = hits.map(hit => ({ hit, tokens: corpusTokens(hit) }))
  const avgdl = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = docs.length
  const scored = docs.map(d => {
    const tf = new Map<string, number>()
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const qt of queryTokens) {
      const f = tf.get(qt)
      if (!f) continue
      const n = df.get(qt) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * d.tokens.length / avgdl))
    }
    return { hit: d.hit, score }
  })
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.hit)
}

/** 由完整工具定义构建目录条目（categories 缺省或未覆盖时落「其他」兜底） */
export const buildCatalogEntries = (
  tools: ToolDefinition[],
  categories?: Record<string, string>,
): ToolCatalogEntry[] =>
  tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    category: categories?.[t.function.name] ?? TOOL_CATEGORY_FALLBACK,
  }))

/**
 * 按类别分组的纯名字索引文本（系统提示注入用）：类别保持首现顺序、类别内保持传入顺序，
 * 末尾一句指针引导用 search_tools；超预算时按工具数从多到少逐类聚合降级为「类别(+N)」，
 * 全部聚合仍超预算则返回全聚合形态（已是最紧凑）。
 */
export const buildCatalogIndex = (entries: ToolCatalogEntry[], budgetChars: number): string => {
  const groups: Array<{ category: string; names: string[] }> = []
  for (const e of entries) {
    const g = groups.find(g => g.category === e.category)
    if (g) g.names.push(e.name)
    else groups.push({ category: e.category, names: [e.name] })
  }
  const pointer = '需要某个类别下的能力、或找不到合适工具时，必须先调用 search_tools 检索激活（已知名字可用 select:<工具名> 直取），再判断是否有该能力。'
  const render = (collapsed: Set<string>): string => {
    const lines = groups.map(g =>
      collapsed.has(g.category) ? `- ${g.category}(+${g.names.length})` : `- ${g.category}: ${g.names.join(', ')}`
    )
    return ['【工具目录索引】（全部可用工具按类别分组，仅列名字）', ...lines, '', pointer].join('\n')
  }
  const collapsed = new Set<string>()
  let text = render(collapsed)
  if (text.length <= budgetChars) return text
  for (const g of [...groups].sort((a, b) => b.names.length - a.names.length)) {
    collapsed.add(g.category)
    text = render(collapsed)
    if (text.length <= budgetChars) return text
  }
  return text
}

export interface SearchToolCorpusOptions {
  query: string
  limit?: number
  category?: string
  /** 工具名 → 类别映射（ToolDefinition 输入时取类别用；缺省落「其他」） */
  categories?: Record<string, string>
}

/**
 * BM25-lite 工具检索：
 * - `select:<工具名>` 直取：绕过检索按确切名字返回，找不到返回空数组；
 * - category 直取：query 为空 + 传 category 时返回该类全部工具（不受 limit 截断）；query 非空时在类别内检索；
 * - exact-name 命中（query 恰为某工具名）强制置顶，且不受 top-N 截断（行业教训 Codex #21503）；
 * - 零命中返回空数组，由调用方走降级文本（buildSearchResultText 处理）。
 */
export const searchToolCorpus = (
  tools: ToolCorpusInput[],
  options: SearchToolCorpusOptions,
): ToolSearchHit[] => {
  const limit = options.limit ?? 8
  const hits = tools.map(t => toHit(t, options.categories))
  const query = (options.query ?? '').trim()

  if (query.toLowerCase().startsWith('select:')) {
    const target = query.slice('select:'.length).trim()
    const hit = hits.find(h => h.entry.name === target)
    return hit ? [hit] : []
  }

  if (options.category) {
    const inCategory = hits.filter(h => h.entry.category === options.category)
    if (!query) return inCategory
    const exact = inCategory.find(h => h.entry.name === query)
    const ranked = bm25Search(exact ? inCategory.filter(h => h !== exact) : inCategory, query, limit)
    return exact ? [exact, ...ranked] : ranked
  }

  const exact = hits.find(h => h.entry.name === query)
  const ranked = bm25Search(exact ? hits.filter(h => h !== exact) : hits, query, limit)
  return exact ? [exact, ...ranked] : ranked
}

/**
 * search_tools 结果文本：命中时给人类可读说明 + 命中工具完整 schema 文本，
 * 末尾附机器可解析行 `[activated] name1, name2`（history 扫描重建激活集的依据）；
 * 零命中/降级时返回按类别名单 + 用法提示（引导换词重试 / select: 直取 / category 直取）。
 */
export const buildSearchResultText = (
  hits: ToolSearchHit[],
  allEntries: ToolCatalogEntry[],
): string => {
  if (hits.length === 0) {
    return [
      '未检索到匹配工具。请更换关键词重试（用任务意图词，中英文均可，如"记忆"、"截图"、"模型"）；已知确切名字用 select:<工具名> 直取；或传 category 参数按类别直取。',
      '',
      buildCatalogIndex(allEntries, Number.MAX_SAFE_INTEGER),
    ].join('\n')
  }
  const parts: string[] = [`检索命中 ${hits.length} 个工具，已激活，下一轮起可直接调用：`, '']
  for (const hit of hits) {
    parts.push(`## ${hit.entry.name}（${hit.entry.category}）`)
    parts.push(hit.definition ? JSON.stringify(hit.definition, null, 2) : hit.entry.description)
    parts.push('')
  }
  parts.push(`${ACTIVATED_LINE_PREFIX} ${hits.map(h => h.entry.name).join(', ')}`)
  return parts.join('\n')
}

const ACTIVATED_LINE_RE = new RegExp(`^${ACTIVATED_LINE_PREFIX.replace(/[[\]]/g, '\\$&')}\\s*(.+)$`, 'gm')

/** 从 search_tools 结果文本解析 [activated] 名单行（多行取并集、保序去重；供 history 扫描重建激活集） */
export const parseActivatedNames = (toolResultText: string): string[] => {
  const names: string[] = []
  for (const match of toolResultText.matchAll(ACTIVATED_LINE_RE)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim()
      if (name && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/** 可见集 = 常驻核心集 ∪ 模式条件集（MODE_TOOLS[mode]）∪ 桌面工具集（开关开时）∪ 已激活集 */
export const computeVisibleNames = (options: {
  mode?: string
  activated?: Iterable<string>
  /** 桌面能力开关（desktop_control_enabled）：开时 DESKTOP_TOOLS 直接可见——
      常设声明 NOTICE 说"你拥有三个桌面工具"，可见集必须兑现，否则模型只能瞎调 */
  desktopEnabled?: boolean
}): Set<string> => {
  const visible = new Set<string>(CORE_TOOLS)
  for (const name of MODE_TOOLS[options.mode ?? ''] ?? []) visible.add(name)
  if (options.desktopEnabled) for (const name of DESKTOP_TOOLS) visible.add(name)
  if (options.activated) for (const name of options.activated) visible.add(name)
  return visible
}

/**
 * 可见性过滤（只发生在 API 传参处，绝不裁 toolset 本体）：
 * 非 activated 的可见工具保持 allTools 原顺序（保 prompt 缓存前缀），activated 工具按原相对顺序追加在末尾；
 * 结果永不为空——空则抛带明显标记的 Error（防 detectAndProcessMCPTools 对空数组灌回全量 MCP 工具）。
 */
export const filterVisibleTools = (
  allTools: ToolDefinition[],
  visibleNames: Set<string>,
  activatedNames?: Set<string>,
): ToolDefinition[] => {
  const isActivated = (name: string): boolean => activatedNames?.has(name) ?? false
  const head = allTools.filter(t => visibleNames.has(t.function.name) && !isActivated(t.function.name))
  const tail = allTools.filter(t => visibleNames.has(t.function.name) && isActivated(t.function.name))
  const result = [...head, ...tail]
  if (result.length === 0) {
    throw new Error('[toolDiscovery] filterVisibleTools 结果为空：可见集与全量工具无交集（违反"过滤结果永不为空"不变量）')
  }
  return result
}

/** 是否启用渐进发现：deferrable 工具定义总量（序列化字符数）超过绝对阈值才分层，否则全量内联 */
export const shouldEnableProgressiveTools = (deferrableChars: number): boolean =>
  deferrableChars > PROGRESSIVE_TOOLS_MIN_DEFERRABLE_CHARS
