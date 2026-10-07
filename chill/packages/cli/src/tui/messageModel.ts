/**
 * TUI 消息模型（纯逻辑，不依赖 ink/react）
 *
 * 显示行 = 已提交不可变数组 + in-flight 原地增长（thinking/content 两个缓冲）。
 * 长行在模型层按终端宽度自换行为视觉行（CJK 宽字符与中文终端按 2 列渲染的
 * 歧义字符均计 2 列），窗口切片与渲染共用同一套视觉行，永不漂移。可见窗口 = rows-WINDOW_CHROME 行，slice 尾部；
 * auto-follow 默认钉底，上滚暂停跟随，回底恢复。
 */
import type { Message } from '@assistant-ai/core'
import { MessageRole, ToolCallStatus, type CompactionCheckpoint } from '@assistant-ai/core'
import { isFenceLine, isTableRowLine, isTableSeparatorLine, parseAlignment, stripAnsiText, styleInlineMarkdown } from './markdown.js'
import { highlightCode } from './syntaxHighlight.js'
import type { TodoLine } from './tuiState.js'

/** 窗口余量：输入行 1 + statusline 1 + 呼吸空行 1（TuiApp 的翻页步长同用）。
 *  实际 chrome 占 2 行，多预留的 1 行使消息区底部自然空出 1 行作间隔 */
export const WINDOW_CHROME = 3

/** East Asian Wide/Fullwidth 及 emoji 等占 2 列的码点区间（wcwidth 常用子集） */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/**
 * East Asian Ambiguous 中在中文终端实际按 2 列渲染的常见字符。
 * Ink 与我们按 1 列计，但终端按 2 列渲染会让行物理折行，
 * Ink 增量渲染按"1 输出行 = 1 终端行"记账，折行即整帧错位——必须按 2 列断行。
 * （宁可多算不可少算：多算只是提前折行，少算会溢出折行导致帧错位。
 *  盒线字符 0x2500-0x257f 不算——Windows Terminal 对其恒按 1 列，输入框边框为证。）
 */
function isAmbiguousWide(cp: number): boolean {
  return (
    cp === 0x00a1 || // ¡
    cp === 0x00a4 || // ¤
    (cp >= 0x00a7 && cp <= 0x00a9) || // §¨©
    (cp >= 0x00ae && cp <= 0x00b1) || // ®¯°±
    cp === 0x00b7 || // ·
    cp === 0x00d7 || // ×
    cp === 0x00f7 || // ÷
    (cp >= 0x0391 && cp <= 0x03c9) || // 希腊字母
    (cp >= 0x0400 && cp <= 0x04ff) || // 西里尔字母
    (cp >= 0x2010 && cp <= 0x2027) || // 各类破折号/引号/省略号/项目符号
    cp === 0x2030 || // ‰
    (cp >= 0x2032 && cp <= 0x2033) || // ′″
    cp === 0x203b || // ※
    cp === 0x20ac || // €
    cp === 0x2103 || // ℃
    cp === 0x2109 || // ℉
    cp === 0x2116 || // №
    (cp >= 0x2121 && cp <= 0x2122) || // ℡™
    cp === 0x213b || // ℻
    (cp >= 0x2150 && cp <= 0x215f) || // 分数
    (cp >= 0x2160 && cp <= 0x216b) || // 罗马数字
    (cp >= 0x2190 && cp <= 0x2199) || // 箭头
    cp === 0x2212 || cp === 0x2215 || cp === 0x221a || // −∕√
    cp === 0x221e || cp === 0x2223 || cp === 0x2225 || // ∞∣∥
    (cp >= 0x2236 && cp <= 0x2237) || // ∶∷
    cp === 0x2248 || // ≈
    (cp >= 0x2260 && cp <= 0x2261) || // ≠≡
    (cp >= 0x2264 && cp <= 0x2265) || // ≤≥
    cp === 0x22c5 || cp === 0x22ef || // ⋅⋯
    (cp >= 0x2460 && cp <= 0x24ff) || // ①②等圈码
    (cp >= 0x25a0 && cp <= 0x25ff) || // ■▲◆ 等几何图形(conhost CJK 按 2 列,string-width 按 1)
    (cp >= 0x2600 && cp <= 0x27bf) || // ⚠☐☑★ 等杂项符号/装饰符(同上)
    (cp >= 0x2b00 && cp <= 0x2bff) // ⭐➜ 等增补符号(同上,保守计 2)
  )
}

/** 歧义类(A 类)字符宽度:默认 2(保守;中文 conhost 行为),CPR 实测后可被本机值覆盖 */
let ambiguousClassWidth: 1 | 2 = 2
/** 码点级实测宽度覆盖(CPR 探测写入,优先级最高) */
const widthOverrides = new Map<number, number>()

/** 应用 CPR 实测宽度(widthProbe 在 TUI 启动时调用;类宽度 + 码点覆盖;
 *  每次调用整体替换上一轮测量,不累积过期覆盖) */
export function applyMeasuredWidths(ambiguousWidth: 1 | 2, overrides: Array<[number, number]>): void {
  ambiguousClassWidth = ambiguousWidth
  widthOverrides.clear()
  for (const [cp, w] of overrides) {
    if (w === 1 || w === 2) widthOverrides.set(cp, w)
  }
}

/** 单字符显示宽度：控制字符 0；实测覆盖优先；宽字符与歧义类按 2（或实测值）；其余 1 */
export function displayCharWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  const measured = widthOverrides.get(cp)
  if (measured !== undefined) return measured
  if (isWide(cp)) return 2
  if (isAmbiguousWide(cp)) return ambiguousClassWidth
  return 1
}

/** ANSI SGR 颜色序列（`\x1b[...m`）：零宽原子单元，折行时不计宽、不在其中间断行 */
const SGR_PATTERN = /^\x1b\[[0-9;]*m/
/** OSC 序列（`\x1b]...\x07` 或 `\x1b]...\x1b\\`，含 OSC 8 超链接）：零宽原子单元，同上 */
const OSC_PATTERN = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/
const SGR_RESET = '\x1b[0m'

/** 文本按显示宽度断行（ANSI SGR 与 OSC 感知：序列零宽且完整保留；续行行首重注当前激活色
 * （activeSgr 累积制：多属性样式续行不丢属性）；码点级遍历不在 surrogate pair 中间断开；空文本 → ['']） */
export function wrapTextToWidth(text: string, cols: number): string[] {
  const rows: string[] = []
  let cur = ''
  let w = 0
  let activeSgr = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\x1b') {
      // SGR:整体挂到当前行,不计宽度;activeSgr 累积(非 RESET 追加,RESET 清空)
      const sgr = SGR_PATTERN.exec(text.slice(i))
      if (sgr) {
        cur += sgr[0]
        activeSgr = sgr[0] === SGR_RESET ? '' : activeSgr + sgr[0]
        i += sgr[0].length
        continue
      }
      // OSC(如 OSC 8 超链接):整体挂到当前行,不计宽度,不参与 activeSgr
      const osc = OSC_PATTERN.exec(text.slice(i))
      if (osc) {
        cur += osc[0]
        i += osc[0].length
        continue
      }
    }
    const cp = text.codePointAt(i) ?? 0
    const ch = cp > 0xffff ? text.slice(i, i + 2) : text[i]
    i += ch.length
    const cw = displayCharWidth(ch)
    if (w + cw > cols) {
      rows.push(cur)
      cur = activeSgr + ch
      w = cw
    } else {
      cur += ch
      w += cw
    }
  }
  rows.push(cur)
  return rows
}

/** 工具参数摘要的优先键：命中即以其值作摘要（不带键名），顺序即优先级 */
const TOOL_SUMMARY_PRIORITY_KEYS = [
  'query', 'q', 'path', 'file_path', 'command', 'cmd',
  'url', 'task_id', 'pattern', 'keyword', 'prompt', 'description',
]
/** 摘要最大显示宽度（列） */
const TOOL_SUMMARY_MAX_WIDTH = 60

/** 空白净化：控制字符（含 \n \r \t）→ 空格，连续空白折叠，首尾 trim。
 *  工具行经 pushText 按 \n 拆行，值带换行（如 powershell 多行 command）会把一行炸成多行 */
function sanitizeSummary(text: string): string {
  return text.replace(/[\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 按显示宽度截断：整串放得下原样返回；放不下时按 maxWidth-省略号宽 取前缀再补 …
 * （保证结果宽度 ≤ maxWidth——老实现可能因补 … 超出 1~2 列，在边界行引发折行爬行） */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  let total = 0
  for (const ch of text) {
    total += displayCharWidth(ch)
    if (total > maxWidth) break
  }
  if (total <= maxWidth) return text
  const budget = Math.max(0, maxWidth - displayCharWidth('…'))
  let out = ''
  let used = 0
  for (const ch of text) {
    const cw = displayCharWidth(ch)
    if (used + cw > budget) return `${out}…`
    out += ch
    used += cw
  }
  return out
}

// ==================== 思考折叠 ====================

/** 流式思考区视觉行预算（内容行，不含头行）：思考区管理的资源是屏幕视觉行，
 *  封顶单位必须与资源同单位——按逻辑行封顶会隔着"折行"这层内容/宽度相关映射，
 *  高度必然忽高忽低。视觉行封顶后：高度 = min(实际, 1+N)，与内容长度、换行形态、
 *  终端宽度全部解耦，稳态恒定（与任务清单活动区同美学：内容滚动、区域不动） */
export const MAX_THINKING_STREAM_ROWS = 6
/** 思考尾部字符窗：簿记只需够铺满视觉行预算（300 列 ASCII 的极端也就 6×300=1800），
 *  超窗切片保尾并补 … 前缀标记截断；append 为 O(1) 追加 + 偶发切片，零逐行簿记 */
const THINKING_STREAM_TAIL_CHARS = 2000

/** 思考时长格式化：<60s → `Ns`；<1h → `XmYs`；≥1h → `XhYmZs`
 * （秒向下取整，与流式头行 `[思考中] Ns` 的计时口径一致） */
export function formatThinkingDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m${s % 60}s`
}

/** 思考摘要行（flush 提交与 rebuild 重建共用，保证原位替换逐字一致）：
 *  纯时长形态 `[思考] Ns`——时长来自消息 thinkingDurationMs 字段（core 流式打点实测，
 *  随消息入史，rebuild 从字段还原，天然确定）；无字段（旧会话/非流式）→ `[思考]` */
export function thinkingSummaryLine(durationMs?: number): string {
  return durationMs === undefined ? '[思考]' : `[思考] ${formatThinkingDuration(durationMs)}`
}

/**
 * 工具调用参数 → 单行摘要（行业形态：同名调用凭关键参数可区分）。
 * 解析成功：优先键命中取其值（裸值）；否则首标量 `键: 值`、数组 `键: N 项`。
 * 解析失败（流式不完整 JSON、provider 快照块盲拼接的非法 JSON）：正则回退——
 * 同样先按优先键匹配（输出形态与解析档一致），再退第一组完整 "键": "值"；全程不抛异常。
 */
export function summarizeToolArgs(argsJson: string): string {
  if (!argsJson) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    parsed = undefined
  }
  let summary = ''
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    for (const key of TOOL_SUMMARY_PRIORITY_KEYS) {
      const v = obj[key]
      if ((typeof v === 'string' && v) || typeof v === 'number') {
        summary = String(v)
        break
      }
    }
    if (!summary) {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          summary = `${k}: ${String(v)}`
          break
        }
        if (Array.isArray(v)) {
          summary = `${k}: ${v.length} 项`
          break
        }
      }
    }
  } else {
    for (const key of TOOL_SUMMARY_PRIORITY_KEYS) {
      // 值允许未闭合（流式中途 `{"query": "量子` 也能取出部分值）
      const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)`).exec(argsJson)
      if (m && m[1]) {
        summary = m[1]
        break
      }
    }
    if (!summary) {
      // 通用回退要求完整键值对（防把半截内容安到错误的键上）
      const m = /"([^"]+)"\s*:\s*"([^"]*)"/.exec(argsJson)
      if (m) summary = `${m[1]}: ${m[2]}`
    }
  }
  return truncateToWidth(sanitizeSummary(summary), TOOL_SUMMARY_MAX_WIDTH)
}

/** 工具调用标记行（流式 addToolCall 与历史 toDisplayLines 共用同一格式，保证原位替换逐字一致） */
function toolCallLine(name: string, argsJson: string): string {
  const summary = summarizeToolArgs(argsJson)
  return `[工具] ${name}${summary ? `(${summary})` : ''}`
}

/** 用户消息显示文本：'>' 提示符前缀（轮次锚点，Claude Code 同款语言），多行续行悬挂缩进 2 列聚合成块 */
export function userDisplayText(text: string): string {
  return `> ${text.replace(/\n/g, '\n  ')}`
}

/** JSON 美化（查看器参数块用）：parse 成功 pretty-print 2 空格（单行 JSON 的转义 \n 还原为真实换行），失败原样 */
function prettyJsonIfPossible(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * 工具结果 → 可读文本（回显与查看器结果块共用前置）。
 * TOOL content 的真实形态：task 工具是单行 JSON 信封 `{"content": "…"}`；
 * MCP 是标准信封 `{content:[{type:'text',text}]}` 或 pretty JSON 字符串；
 * 内置工具多为可读中文字符串；其余对象结果是被 JSON.stringify 的单行 blob。
 * 三分支覆盖：信封解包 / 其他对象美化 / 原样；全程不抛异常。
 */
export function normalizeToolResult(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      // task 工具信封：{ content: string }
      if (typeof obj.content === 'string') return obj.content
      // 标准 MCP 信封：{ content: [{ type: 'text', text: string }, ...] }
      if (Array.isArray(obj.content)) {
        const texts = obj.content
          .filter(
            (p): p is { type: string; text: string } =>
              !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string'
          )
          .map((p) => p.text)
        if (texts.length > 0) return texts.join('\n')
      }
      return JSON.stringify(parsed, null, 2)
    }
    if (Array.isArray(parsed)) return JSON.stringify(parsed, null, 2)
    return content
  } catch {
    return content
  }
}

/** 回显最大显示宽度（列） */
const TOOL_ECHO_MAX_WIDTH = 80

/** 主流程结果回显行：规范化后取第一个有意义的行（跳过空行与纯括号/标点的零信息行——
 *  JSON 类结果的 { } [ 等行），空白净化并按 80 列截断；全文无有意义行 → (无文本输出) */
function toolResultEcho(content: string): string {
  const normalized = normalizeToolResult(content)
  for (const raw of normalized.split('\n')) {
    const line = sanitizeSummary(raw)
    if (!line) continue
    // 零信息行：不含任何字母/数字（含汉字，\p{L} 覆盖）
    if (!/[\p{L}\p{N}]/u.test(line)) continue
    return `└ ${truncateToWidth(line, TOOL_ECHO_MAX_WIDTH)}`
  }
  return '└ (无文本输出)'
}

// ==================== GFM 表格渲染 ====================

/** 表格列宽下限（水位分配下界：防病态窄列）与宽度阈值下限（防病态窄窗） */
const TABLE_COL_MIN = 8
const TABLE_MAX_WIDTH_FLOOR = 40
const SGR_BOLD = '\x1b[1m'
const SGR_DIM = '\x1b[2m'

/** 字符串显示宽度（逐码点求和，宽字符按 2） */
export function displayWidthOf(text: string): number {
  let w = 0
  for (const ch of text) w += displayCharWidth(ch)
  return w
}

/** 表格行 → 单元格数组（去首尾 |,朴素切分——转义 \| 罕见不支持） */
function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
}

/** 按对齐方式补齐单元格（宽度按剥离 ANSI 后文本算，SGR 零宽不影响对齐） */
function padCell(styled: string, width: number, align: 'left' | 'center' | 'right'): string {
  const pad = Math.max(0, width - displayWidthOf(stripAnsiText(styled)))
  if (align === 'right') return ' '.repeat(pad) + styled
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + styled + ' '.repeat(pad - left)
  }
  return styled + ' '.repeat(pad)
}

/** GFM 表格 → 对齐列文本行（表头整行粗 + dim ─ 分隔 + 数据行）;
 *  显示层的职责是完整呈现信息：宽度不够向纵向要空间，不吃内容——截断路径不存在。
 *  列宽水位分配：从自然宽出发，总宽超预算时反复削减当前最宽列（宽列让位、窄列不受罪），
 *  下限 TABLE_COL_MIN；超长单元格内换行（行高 = 该行各单元格最大折行数，列对齐保持）。
 *  到下限仍超预算才返回 null 走 key/value 退化（形态降级，信息仍完整） */
function renderTable(headerLine: string, sepLine: string, rowLines: string[], maxTableWidth: number): string[] | null {
  const headers = splitTableRow(headerLine)
  const colCount = headers.length
  if (colCount === 0) return null
  const alignsRaw = parseAlignment(sepLine)
  const aligns = Array.from({ length: colCount }, (_, c) => alignsRaw[c] ?? 'left')
  const rows = rowLines.map((l) => {
    const cells = splitTableRow(l)
    return Array.from({ length: colCount }, (_, c) => cells[c] ?? '')
  })
  // 各列最终渲染文本（剥离 ANSI）的自然显示宽
  const natural = headers.map((h, c) => {
    let w = displayWidthOf(stripAnsiText(styleInlineMarkdown(h, true)))
    for (const r of rows) w = Math.max(w, displayWidthOf(stripAnsiText(styleInlineMarkdown(r[c], true))))
    return w
  })
  const total = (ws: number[]): number => ws.reduce((a, b) => a + b, 0) + 2 * (colCount - 1)
  // 水位分配：每轮削减当前最宽列一格，直至总宽入预算；全列到下限仍排不下 → 退化
  const widths = [...natural]
  while (total(widths) > maxTableWidth) {
    let widest = 0
    for (let c = 1; c < colCount; c++) if (widths[c] > widths[widest]) widest = c
    if (widths[widest] <= TABLE_COL_MIN) return null
    widths[widest]--
  }
  // 单元格按列宽折行（wrapTextToWidth：ANSI 零宽原子、续行重注激活样式、实测宽度表精确断行）；
  // 行高 = 该行各单元格最大折行数，空段以 '' 补齐——任何单元格内容全文可见
  const renderRow = (cells: string[]): string[] => {
    const wrapped = cells.map((cell, c) => wrapTextToWidth(styleInlineMarkdown(cell, true), widths[c]))
    const height = Math.max(...wrapped.map((w) => w.length))
    const out: string[] = []
    for (let v = 0; v < height; v++) {
      out.push(wrapped.map((w, c) => padCell(w[v] ?? '', widths[c], aligns[c])).join('  '))
    }
    return out
  }
  // 表头可多行：逐物理行加粗（SGR 配平在行内闭合，不跨行泄漏）
  const header = renderRow(headers).map((l) => `${SGR_BOLD}${l}${SGR_RESET}`)
  const sep = `${SGR_DIM}${widths.map((w) => '─'.repeat(w)).join('  ')}${SGR_RESET}`
  return [...header, sep, ...rows.flatMap((r) => renderRow(r))]
}

/** 超宽表格退化:key/value 逐行（列名加粗;记录之间空行分隔,普通折行,不标 noWrap） */
function degradeTable(headerLine: string, rowLines: string[]): string[] {
  const headers = splitTableRow(headerLine)
  const out: string[] = []
  rowLines.forEach((l, rowIdx) => {
    if (rowIdx > 0) out.push('')
    const cells = splitTableRow(l)
    headers.forEach((h, c) => {
      out.push(styleInlineMarkdown(`**${h}**: ${cells[c] ?? ''}`))
    })
  })
  return out
}

/** 围栏行 → 语言标记（``` 或 ~~~ 后随语言名；光秃围栏捕获到空串，归一为 undefined） */
function fenceLang(line: string): string | undefined {
  const lang = /^\s*(?:```|~~~)\s*([\w#+.-]*)/.exec(line)?.[1]
  return lang ? lang : undefined
}

/** assistant 文本 → 格式化行（提交与流式共用,保证两路径逐字一致）:
 *  围栏状态机打标（围栏内字面、标记行不带边框）;围栏外识别 GFM 表格块 → 对齐列渲染
 *  （宽度阈值 maxTableWidth 自适应终端,超宽退化 key/value）;
 *  已闭合且标注语言的围栏块 → 语法高亮（完成态呈现：未闭合/无语言/失败均字面，零开销） */
export function formatAssistantLines(text: string, maxTableWidth: number): Array<{ text: string; inCodeBlock: boolean; noWrap?: boolean }> {
  const out: Array<{ text: string; inCodeBlock: boolean; noWrap?: boolean }> = []
  const raws = text.split('\n')
  let inFence = false
  let i = 0
  while (i < raws.length) {
    const raw = raws[i]
    const fence = isFenceLine(raw)
    // 围栏外表格块:表头行 + 分隔行起,连续 | 行止
    if (!inFence && !fence && isTableRowLine(raw) && i + 1 < raws.length && isTableSeparatorLine(raws[i + 1])) {
      let end = i + 2
      while (end < raws.length && isTableRowLine(raws[end])) end++
      const rendered = renderTable(raw, raws[i + 1], raws.slice(i + 2, end), maxTableWidth)
      if (rendered) {
        for (const t of rendered) out.push({ text: t, inCodeBlock: false, noWrap: true })
      } else {
        for (const t of degradeTable(raw, raws.slice(i + 2, end))) out.push({ text: t, inCodeBlock: false })
      }
      i = end
      continue
    }
    // 已闭合且标注语言的围栏块 → 整块语法高亮；行数不变（原位替换），任何失败回退字面
    if (fence && !inFence) {
      const lang = fenceLang(raw)
      let end = i + 1
      while (end < raws.length && !isFenceLine(raws[end])) end++
      if (lang && end < raws.length) {
        const rows = highlightCode(raws.slice(i + 1, end).join('\n'), lang)
        if (rows) {
          out.push({ text: styleInlineMarkdown(raw), inCodeBlock: false }) // 开启标记行（与现状一致走行内样式）
          for (const r of rows) out.push({ text: r, inCodeBlock: true })
          out.push({ text: raws[end], inCodeBlock: false }) // 闭合标记行（与现状一致原文）
          i = end + 1
          continue
        }
      }
    }
    out.push({
      text: inFence ? raw : styleInlineMarkdown(raw),
      // 围栏标记行本身不带边框(开合一致),内容行才带
      inCodeBlock: fence ? false : inFence,
    })
    if (fence) inFence = !inFence
    i++
  }
  return out
}

/** task 系工具（子代理交付全文）：其结果属人读的交付文本，查看器按 markdown 渲染；
 *  其余工具结果（命令输出/JSON/日志/文件内容）保持纯文本保真 */
const TASK_LIKE_TOOLS = new Set(['task', 'batch_task', 'resume_task'])

export function isTaskLikeTool(name?: string): boolean {
  return !!name && TASK_LIKE_TOOLS.has(name)
}

/** 长文本按行做 markdown 行内渲染（标题/粗/斜/删除线/行内代码/链接/列表/任务列表/引用）。
 *  围栏代码块内的行原样保真（代码不做 markdown 处理）。
 *  供查看器复用：思考全文 / 压缩摘要 / 子代理交付全文。
 *  渲染产物含 ANSI，wrapTextToWidth 的 ANSI 感知折行保证显示行账本不受影响 */
export function renderInlineMarkdownLines(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const logical of text.split('\n')) {
    const fence = isFenceLine(logical)
    if (inFence || fence) out.push(logical)
    else out.push(styleInlineMarkdown(logical))
    if (fence) inFence = !inFence
  }
  return out
}

/** 显示行类别（着色依据；diff 行自带 ANSI 颜色，按默认色渲染） */
export type DisplayKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'toolResult' | 'notice' | 'error' | 'diff' | 'raw'

export interface DisplayLine {
  key: string
  kind: DisplayKind
  text: string
  /** 是否在围栏代码块内（渲染边框用；折行传播） */
  inCodeBlock?: boolean
  /** 不折行（表格行：折行会毁对齐，溢出交给渲染层 truncate 截右缘） */
  noWrap?: boolean
}

/** 消息正文提取（string | ContentPart[] → 纯文本） */
export function messageContentToText(content: Message['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('')
}

export class MessageModel {
  /** 已提交显示行（不可变，只追加或由 rebuildCommitted 整体重建） */
  private committed: DisplayLine[] = []
  /** 事件行（任务事件/命令输出/提问等引擎历史之外的提示行）：锚定插入时的历史行数，
   *  rebuildCommitted 重建时按锚点插回——不再被历史重建抹掉 */
  private eventLines: Array<{ line: DisplayLine; anchor: number }> = []
  /** 当前 committed 中引擎历史衍生的逻辑行数（事件行锚点基准） */
  private historyLineCount = 0
  /** 是否处于生成轮中（tuiShell 的 runTurn 维护） */
  inTurn = false
  /** 执行中调用数（assistant 已发起、TOOL 未入史）与待确认调用数（TOOL PENDING）：
   *  轮中事件锚点补偿——每个这类调用的结果/回显行随后会落地，事件须锚在它们全部之后 */
  private executingCount = 0
  private pendingCount = 0
  /** 工具详情 sidecar：工具标记逻辑行 key → 完整参数/结果/状态（查看器展开用；
   *  toDisplayLines 每次重建全清重填，与历史一致） */
  private toolDetails = new Map<string, { args: string; result?: string; status: string; toolName?: string }>()
  /** 思考全文 sidecar：思考摘要行 key → 思考全文（查看器展开用；与 toolDetails 同生命周期：
   *  toDisplayLines 每次重建全清重填，flush 路径登记） */
  private thinkingDetails = new Map<string, string>()
  /** 压缩 checkpoint 数据源（tuiShell 从引擎 getSessionState().compactions 注入；
   *  标记条与查看器总结均由此派生渲染，本模型不含压缩业务逻辑） */
  private compactions: CompactionCheckpoint[] = []
  /** 压缩标记行 key → checkpoint（查看器展开总结全文用；toDisplayLines 每次重建全清重填） */
  private compactionDetails = new Map<string, CompactionCheckpoint>()
  /** 压缩标记行（toDisplayLines 重建时重填）：不进 historyLines，作为带锚点元素与事件行
   *  共用一套"纯消息行坐标"——纯消息历史只增不改（append-only），锚点永不漂移，
   *  事件行与标记行都不需要任何坐标换算（坐标系混淆曾是排版错乱的根因） */
  private compactionMarks: Array<{ line: DisplayLine; freeIdx: number }> = []
  /** in-flight 缓冲：流式到达的思考与正文，轮次结束由 commitInflight 提交 */
  private inflightThinking = ''
  private inflightContent = ''
  /** in-flight 思考的增量簿记：尾部字符窗 + 计时打点。窗口封顶 THINKING_STREAM_TAIL_CHARS
   *  （够铺满视觉行预算即可）——严禁对整个 inflightThinking 缓冲取尾/全量 split（几千行
   *  思考每 chunk 一次全量扫描，总成本 O(n²)）；一律在 appendThinking 以 O(1) 追加维护 */
  private thinkingTailText = ''
  /** 首个 thinking chunk 打点（chunk 驱动重渲染自然走秒，无需定时器）；flush 时冻结 */
  private thinkingStartedAt: number | null = null
  private thinkingFrozenAt: number | null = null
  /** 任务清单活动区行（独立状态，不进 committed/inflight 行模型，规避帧数学约束；
   *  null = 无活跃清单/已撤除） */
  private todoLines: TodoLine[] | null = null
  /** 暂停跟随时冻结的 in-flight 快照：已流出部分可回看，流式增长不打扰视口 */
  private frozenInflight: DisplayLine[] | null = null
  private seq = 0
  private revision = 0
  /** 向上滚动的视觉行数（0 = 钉底）；follow 为 true 时恒为 0 */
  private scrollOffset = 0
  /** auto-follow：新输出自动滚底；上滚暂停，回底恢复 */
  follow = true
  private listeners = new Set<() => void>()
  /** 渲染静音：静音期 emit 只累 revision 不触发 listener（捕获命令输出时防回流循环） */
  private muted = false
  /** 最近一次窗口计算的列宽与窗口行数（scrollUp/Down 计算视觉行总数与封顶用） */
  private lastCols = 80
  private lastWindowSize = 20
  /** committed 视觉行缓存：committed 只追加（重建时变短），据此增量换行 */
  private cachedCols = 0
  private cachedCommittedRows: DisplayLine[] = []
  private cachedCommittedCount = 0

  // ==================== 订阅（React 侧据此重渲染） ====================

  /** 订阅变化，返回退订函数 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** 每次变更自增，供渲染层做浅比较 */
  getRevision(): number {
    return this.revision
  }

  private emit(): void {
    this.revision++
    if (this.muted) return
    for (const fn of this.listeners) fn()
  }

  /** 轻量重绘触发：不产生任何行，仅通知订阅者（后台任务秒表等模型外状态驱动状态栏刷新用；沿用 muted 语义） */
  poke(): void {
    this.emit()
  }

  /** 开始静音（emit 不再触发 listener，revision 照常累加） */
  mute(): void {
    this.muted = true
  }

  /** 结束静音并补发一次变更（静音期积累的变更一帧渲染） */
  unmute(): void {
    this.muted = false
    this.emit()
  }

  // ==================== 历史装载 ====================

  /** 注入压缩 checkpoint（紧随其后的 loadHistory/rebuildCommitted 重建时派生标记条；只存数据，不触发渲染）。
   *  会话进行中新增 checkpoint（/compact、对端 watch 采纳）时登记待揭示标记——下次打开查看器
   *  自动定位到最新标记条；初始装载（committed 为空）不登记，避免翻看旧会话被强拉位置 */
  setCompactions(compactions: CompactionCheckpoint[]): void {
    if (this.committed.length > 0 && compactions.length > this.compactions.length) {
      const latest = compactions[compactions.length - 1]
      if (latest) this.revealCompactionKey = `compact-${latest.id}`
    }
    this.compactions = compactions
  }

  /** 引擎历史 → 显示行（清空 inflight，钉底；重置视觉行缓存） */
  loadHistory(messages: Message[]): void {
    const historyLines = this.toDisplayLines(messages)
    this.historyLineCount = historyLines.length
    this.committed = this.mergeEventLines(historyLines)
    this.resetThinkingState()
    this.inflightContent = ''
    this.frozenInflight = null
    this.resetWrapCache()
    this.toBottom()
  }

  /** onMessagesChanged 时重建已提交部分并清空 inflight（引擎历史为权威来源，inflight 已成为过期数据；
   *  事件行按锚点插回，不随重建丢失） */
  rebuildCommitted(messages: Message[]): void {
    const historyLines = this.toDisplayLines(messages)
    this.historyLineCount = historyLines.length
    this.committed = this.mergeEventLines(historyLines)
    this.resetThinkingState()
    this.inflightContent = ''
    this.frozenInflight = null
    this.resetWrapCache()
    this.emit()
  }

  /** 历史行 + 带锚点元素（事件行 + 压缩标记行）按纯消息行坐标合并：按锚点分组（同锚点
   *  标记先于事件——标记是"过去发生"的），高锚点组先插（低位先插会把高位锚点顶错位置）。
   *  纯消息历史 append-only → 两类锚点都永不漂移，无需任何坐标换算 */
  private mergeEventLines(historyLines: DisplayLine[]): DisplayLine[] {
    if (this.eventLines.length === 0 && this.compactionMarks.length === 0) return historyLines
    const merged = [...historyLines]
    const groups = new Map<number, DisplayLine[]>()
    for (const m of this.compactionMarks) {
      const g = groups.get(m.freeIdx) ?? []
      g.push(m.line)
      groups.set(m.freeIdx, g)
    }
    for (const e of this.eventLines) {
      const g = groups.get(e.anchor) ?? []
      g.push(e.line)
      groups.set(e.anchor, g)
    }
    const anchors = [...groups.keys()].sort((a, b) => b - a)
    for (const anchor of anchors) {
      merged.splice(Math.min(anchor, merged.length), 0, ...groups.get(anchor)!)
    }
    return merged
  }

  /** 视觉行缓存失效：committed 被整体替换（loadHistory/rebuildCommitted）时必须调用，
   *  否则增量缓存按"只追加"假设保留过期行（且只清计数会拼接污染，须一并清空数组） */
  private resetWrapCache(): void {
    this.cachedCommittedRows = []
    this.cachedCommittedCount = 0
    this.cachedViewerRows = []
    this.cachedViewerRev = -1
  }

  /**
   * 历史 → 显示行：user→'> ' 提示符（userDisplayText）；assistant→思考（一律折叠为一行
   *  摘要 [思考] Ns + 查看器详情挂全文）+正文；
   * 带 toolCallStatus 的 TOOL 消息→'[工具] name(参数摘要)' 标记行 + 结果回显行
   * （SUCCESS/REJECTED→dim、FAILED→error；PENDING/RUNNING 不附回显）；
   * assistant 已发起、TOOL 结果尚未入史的调用（执行中窗口）同样补标记行——
   * 否则工具执行期间 onMessagesChanged 重建会把流式提交的标记行抹掉，执行完再出现（闪烁）；
   * 顺带统计 executingCount/pendingCount（事件锚点补偿用）、登记 toolDetails（查看器展开用）；
   * 压缩 checkpoint 派生「📦 上下文已压缩」标记行——不进返回的历史行，收集为带锚点元素
   * （compactionMarks，锚点 = 纯消息行坐标）与事件行一起在 mergeEventLines 合入；SYSTEM 跳过。
   */
  private toDisplayLines(messages: Message[]): DisplayLine[] {
    const lines: DisplayLine[] = []
    const toolNameById = new Map<string, string>()
    const toolArgsById = new Map<string, string>()
    this.toolDetails.clear()
    this.thinkingDetails.clear()
    this.compactionDetails.clear()
    this.executingCount = 0
    this.pendingCount = 0
    // 预扫：已有 TOOL 消息（含 pending 等待确认）的调用 id——这些由 TOOL 分支出行，不重复补
    const answeredToolCallIds = new Set<string>()
    for (const msg of messages) {
      if (msg.role === MessageRole.TOOL && msg.toolCallId) answeredToolCallIds.add(msg.toolCallId)
    }
    // 压缩标记条：不进 historyLines，收集为带锚点元素（freeIdx = 其前方纯消息行数），
    // 与事件行一起在 mergeEventLines 按纯消息行坐标合入；key 用 checkpoint.id，跨重建稳定
    const pendingMarks = this.compactions
      .map((cp) => ({ cp, upTo: new Date(cp.upToTimestamp).getTime() }))
      .filter((m) => !Number.isNaN(m.upTo))
      .sort((a, b) => a.upTo - b.upTo)
    let markIdx = 0
    this.compactionMarks = []
    const pushDueMarks = (msgTs: number): void => {
      while (markIdx < pendingMarks.length && msgTs > pendingMarks[markIdx].upTo) {
        const cp = pendingMarks[markIdx++].cp
        const line: DisplayLine = { key: `compact-${cp.id}`, kind: 'notice', text: '📦 上下文已压缩 · Ctrl+O 查看总结' }
        this.compactionMarks.push({ line, freeIdx: lines.length })
        this.compactionDetails.set(line.key, cp)
      }
    }
    for (const msg of messages) {
      const ts = msg.timestamp instanceof Date ? msg.timestamp.getTime() : new Date(msg.timestamp).getTime()
      pushDueMarks(Number.isNaN(ts) ? 0 : ts)
      if (msg.role === MessageRole.ASSISTANT && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.id) {
            toolNameById.set(tc.id, tc.function.name)
            toolArgsById.set(tc.id, tc.function.arguments ?? '')
          }
        }
      }
      if (msg.role === MessageRole.SYSTEM) continue
      if (msg.role === MessageRole.USER) {
        if (msg.synthetic === 'todoLanding' || msg.synthetic === 'frontSwitch' || msg.synthetic === 'desktopToggle' || msg.synthetic === 'fileReceipt') {
          // todoLanding：任务清单落地留痕（全量原文可回溯）；frontSwitch：前台人格边界标记（单行）；
          // desktopToggle：桌面能力开关切换通知（单行）；fileReceipt：d→m 文件发送的手机回执（单行）
          // ——均按提示行样式渲染原文（AGENTS.md「合成消息标记」）
          this.pushText(lines, 'notice', messageContentToText(msg.content))
        } else if (msg.synthetic === 'goalTick') {
          // 目标模式推进消息：折叠为一条摘要行；全文（评估理由/预算/清单）仍在会话历史供模型整合
          const firstLine = messageContentToText(msg.content).split('\n')[0] ?? ''
          this.pushText(lines, 'notice', `【目标推进】${firstLine.replace(/^【[^】]*】/, '').trim() || '目标未达成，自动续跑'}`)
        } else if (msg.synthetic) {
          // 合成编排消息（回流轮通知）：对用户冗余（完成事实已由委派 notice 呈现），
          // 折叠为一条摘要行；全文仍在会话历史供模型整合（AGENTS.md「合成消息标记」）
          const n = (messageContentToText(msg.content).match(/^- \[/gm) || []).length
          this.pushText(lines, 'notice', `【后台任务完成通知】${n} 项任务已落地，结果已写回工具消息`)
        } else {
          this.pushText(lines, 'user', userDisplayText(messageContentToText(msg.content)))
        }
      } else if (msg.role === MessageRole.ASSISTANT) {
        if (msg.reasoningContent) this.commitThinking(lines, msg.reasoningContent, msg.thinkingDurationMs)
        const text = messageContentToText(msg.content)
        if (text.trim()) this.pushAssistantText(lines, text)
        // 执行中窗口：该消息发起的调用尚无 TOOL 结果入史 → 就地补标记行（文本与 TOOL
        // 分支一致，结果落地后原位替换，无视觉跳动）
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            if (tc.id && !answeredToolCallIds.has(tc.id)) {
              this.executingCount++
              const args = tc.function.arguments ?? ''
              this.pushText(lines, 'tool', toolCallLine(tc.function.name, args))
              this.toolDetails.set(lines[lines.length - 1].key, { args, status: 'running', toolName: tc.function.name })
            }
          }
        }
      } else if (msg.role === MessageRole.TOOL && msg.toolCallStatus) {
        const name = toolNameById.get(msg.toolCallId ?? '') ?? 'unknown'
        const args = toolArgsById.get(msg.toolCallId ?? '') ?? ''
        this.pushText(lines, 'tool', toolCallLine(name, args))
        const status = String(msg.toolCallStatus)
        // 结果回显：PENDING（确认占位）与 RUNNING（瞬态）不附
        if (status === ToolCallStatus.PENDING || status === ToolCallStatus.RUNNING) {
          if (status === ToolCallStatus.PENDING) this.pendingCount++
        } else {
          const echo = toolResultEcho(messageContentToText(msg.content))
          this.pushText(lines, status === ToolCallStatus.FAILED ? 'error' : 'toolResult', echo)
        }
        // 详情登记在该工具的最后一行（有回显即回显行）→ 查看器详情块插在回显之后
        this.toolDetails.set(lines[lines.length - 1].key, {
          args,
          result: messageContentToText(msg.content),
          status,
          toolName: name,
        })
      }
    }
    // 兜底：切点晚于全部消息（正常不会发生，切点必在最近 2 轮之前）的标记补在末尾
    pushDueMarks(Number.POSITIVE_INFINITY)
    return lines
  }

  /** 文本按 \n 拆为多行（空行保留），追加到目标数组 */
  private pushText(target: DisplayLine[], kind: DisplayKind, text: string): void {
    for (const textLine of text.split('\n')) {
      target.push({ key: `${kind}-${this.seq++}`, kind, text: textLine })
    }
  }

  /** 表格宽度阈值：跟随终端实际可用宽（lastCols 由渲染路径持续刷新），下限 40 防病态窄窗;
   *  排版发生在内容生成时,终端事后改宽不重排（与行业行为一致） */
  private tableMaxWidth(): number {
    return Math.max(TABLE_MAX_WIDTH_FLOOR, this.lastCols)
  }

  /** assistant 正文 → 显示行（提交路径）：与流式共用 formatAssistantLines，仅键方案不同 */
  private pushAssistantText(target: DisplayLine[], text: string): void {
    for (const line of formatAssistantLines(text, this.tableMaxWidth())) {
      target.push({
        key: `assistant-${this.seq++}`,
        kind: 'assistant',
        text: line.text,
        inCodeBlock: line.inCodeBlock,
        noWrap: line.noWrap,
      })
    }
  }

  // ==================== 流式增长与提交 ====================

  /** 用户发送一条消息（提交为用户行） */
  addUserMessage(text: string): void {
    this.pushText(this.committed, 'user', userDisplayText(text))
    this.emit()
  }

  appendThinking(text: string): void {
    if (!text) return
    if (!this.inflightThinking) {
      // 首个 thinking chunk 打点（计时起点；chunk 驱动重渲染自然走秒，无需定时器）
      this.thinkingStartedAt = Date.now()
      this.thinkingFrozenAt = null
      this.thinkingTailText = ''
    }
    this.inflightThinking += text
    // 尾部字符窗：O(1) 追加，超窗切片保尾并补 … 前缀标记截断
    // （簿记量只需够铺满视觉行预算；显示层在折行出口按视觉行截断，见 capThinkingStreamRows）
    this.thinkingTailText += text
    if (this.thinkingTailText.length > THINKING_STREAM_TAIL_CHARS) {
      this.thinkingTailText = `…${this.thinkingTailText.slice(-(THINKING_STREAM_TAIL_CHARS - 1))}`
    }
    this.emit()
  }

  appendContent(text: string): void {
    // 首个 content chunk 到达即提前折叠思考（部分 flush）：正文开始流式时思考已落地为
    // 摘要行，正文在下方接续——消除「正文在流、头行仍写思考中」的陈旧滞留
    if (this.inflightThinking) this.flushThinking()
    this.inflightContent += text
    this.emit()
  }

  /** 工具调用标记（流中出现即提交一行；先冲刷 in-flight，保持与引擎历史一致的
   *  顺序——committed 渲染在 in-flight 之上，不冲刷会让标记显示在先流出的文字上方，
   *  待权威历史重建时又"跳"回文字下方。行格式与 toDisplayLines 的 toolCallLine 逐字一致，
   *  保证重建时原位替换无跳动） */
  addToolCall(name: string, argsSummary: string): void {
    this.flushInflight()
    this.pushText(this.committed, 'tool', `[工具] ${name}${argsSummary ? `(${argsSummary})` : ''}`)
    this.emit()
  }

  /** 思考落地（flush 提交与 toDisplayLines 历史重建共用同一套折叠逻辑，保证原位替换
   *  逐字一致）：≤8 逻辑行且 ≤640 字符原样落地（所见即所得）；超限折叠为一行摘要并登记
   *  查看器详情（主屏折叠、查看器全量）。durationMs = 思考时长（历史路径取消息
   *  thinkingDurationMs 字段，flush 路径取本地计时），缺省则摘要行不带时长。
   *  一律折叠（行业形态：DeepSeek 官方/ChatGPT/Claude 对思考全部默认折叠，
   *  无「短思考不折」先例——思考是过程而非产物，原文再短也是 transcript 噪音） */
  private commitThinking(target: DisplayLine[], thinking: string, durationMs?: number): void {
    const line: DisplayLine = { key: `thinking-${this.seq++}`, kind: 'thinking', text: thinkingSummaryLine(durationMs) }
    target.push(line)
    this.thinkingDetails.set(line.key, thinking)
  }

  /** 思考流式状态整体复位（flush 提交与历史重建后） */
  private resetThinkingState(): void {
    this.inflightThinking = ''
    this.thinkingTailText = ''
    this.thinkingStartedAt = null
    this.thinkingFrozenAt = null
  }

  /** 思考计时（秒）：flush 冻结后读冻结值，流式期间读实时（chunk 驱动重渲染自然走秒） */
  private thinkingElapsedSeconds(): number {
    if (this.thinkingStartedAt === null) return 0
    return Math.max(0, Math.floor(((this.thinkingFrozenAt ?? Date.now()) - this.thinkingStartedAt) / 1000))
  }

  /** 仅冲刷 in-flight 思考（首个 content chunk 到达时的提前折叠，与 addToolCall 冲刷同机制，
   *  事件锚点语义不变；折叠逻辑与历史路径同源，rebuild 重建原位替换无跳动） */
  private flushThinking(): void {
    if (!this.inflightThinking) return
    this.thinkingFrozenAt = Date.now() // 计时冻结（随 resetThinkingState 一并复位，簿记完整性）
    // 本地实测时长（首个 chunk→冻结）作为摘要行时长；随后权威历史 rebuild 以消息
    // thinkingDurationMs 字段原位替换（同一段思考的同一口径计时，秒级显示一致）
    const durationMs =
      this.thinkingStartedAt !== null ? this.thinkingFrozenAt - this.thinkingStartedAt : undefined
    this.commitThinking(this.committed, this.inflightThinking, durationMs)
    this.resetThinkingState()
    // 一并清冻结快照：内容已入 committed，暂停跟随时保留快照会重复显示同一段文字
    this.frozenInflight = null
  }

  /** in-flight → committed（一并清冻结快照：内容已入 committed，
   *  暂停跟随时若保留快照会重复显示同一段文字） */
  private flushInflight(): void {
    this.flushThinking()
    if (this.inflightContent) this.pushAssistantText(this.committed, this.inflightContent)
    this.inflightContent = ''
    this.frozenInflight = null
  }

  /** 轮次结束：in-flight 提交为不可变行（同时清冻结快照，内容已入 committed，避免重复） */
  commitInflight(): void {
    this.flushInflight()
    this.emit()
  }

  /** in-flight 渲染行（每次渲染现算，键固定不随内容变化；content 含样式注入与围栏打标）。
   *  思考区恒定有界：头行（[思考中] Ns 纯计时，与落地行 [思考] Ns 对称）+ 尾部字符窗
   *  按 \n 现切（窗口封顶 2000 字符，split 成本 µs 级，与全量缓冲 split 的 O(n²) 禁令不冲突）；
   *  视觉行封顶在 visibleRows 折行出口统一执行（capThinkingStreamRows），此处不做行数限制 */
  getInflightLines(): DisplayLine[] {
    const lines: DisplayLine[] = []
    if (this.inflightThinking) {
      lines.push({
        key: 'inflight-t-head',
        kind: 'thinking',
        text: `[思考中] ${this.thinkingElapsedSeconds()}s`,
      })
      this.thinkingTailText.split('\n').forEach((text, i) => {
        lines.push({ key: `inflight-t-${i}`, kind: 'thinking', text })
      })
    }
    if (this.inflightContent) {
      formatAssistantLines(this.inflightContent, this.tableMaxWidth()).forEach((line, i) => {
        lines.push({
          key: `inflight-c-${i}`,
          kind: 'assistant',
          text: line.text,
          inCodeBlock: line.inCodeBlock,
          noWrap: line.noWrap,
        })
      })
    }
    return lines
  }

  // ==================== 提示行 ====================

  /** 任务清单活动区：设置快照行（emit 触发渲染，TuiApp 原位刷新）；
   *  落地/删空/会话切换时传 null 撤除。独立状态，不占消息区窗口行 */
  setTodoLines(lines: TodoLine[] | null): void {
    this.todoLines = lines
    this.emit()
  }

  /** 任务清单活动区行（null = 不渲染清单块） */
  getTodoLines(): TodoLine[] | null {
    return this.todoLines
  }

  /** 事件行：进 eventLines（锚定当前历史行数）并追加显示——重建不丢；
   *  每次调用去首尾空行（通知文本常带 \n 包裹，空行会造成事件块内大段空白） */
  private pushEventLines(kind: DisplayKind, text: string): void {
    const parts = text.split('\n')
    while (parts.length > 0 && parts[0] === '') parts.shift()
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    for (const textLine of parts) {
      const line: DisplayLine = { key: `${kind}-${this.seq++}`, kind, text: textLine }
      // 轮中补偿:每个执行中/待确认调用的结果与回显行随后必落地——锚在它们全部之后,
      // 保证"先工具标记与回显、后事件"(单工具=+1,与旧规则一致;多工具/多文件确认不再错位)。
      // 锚点即纯消息行坐标：historyLines 不含压缩标记行（标记作为带锚点元素在 merge 时合入），
      // 纯消息历史 append-only，锚点永不漂移
      const anchor = this.historyLineCount + (this.inTurn ? this.executingCount + this.pendingCount : 0)
      this.eventLines.push({ line, anchor })
      this.committed.push(line)
    }
  }

  /** 确认提示、命令提示等系统提示（黄色） */
  addNotice(text: string): void {
    this.pushEventLines('notice', text)
    this.emit()
  }

  /** Markdown 渲染的提示行（提问/计划等富文本：复用 assistant 渲染管线——行内样式/代码块/表格）。
   *  与 addNotice 的区别：addNotice 逐行原文；本方法先经 formatAssistantLines 渲染再逐行加入 */
  addMarkdownNotice(text: string): void {
    this.pushRenderedLines('notice', text)
    this.emit()
  }

  /** 事件行（Markdown 渲染版）：文本经 assistant 渲染管线 → 逐行加入。
   *  锚定逻辑与 pushEventLines 一致（重建不丢、轮中补偿） */
  private pushRenderedLines(kind: DisplayKind, text: string): void {
    const rendered = formatAssistantLines(text, this.tableMaxWidth())
    // 去首尾空行（与 pushEventLines 同口径）
    let start = 0
    let end = rendered.length
    while (start < end && rendered[start].text.trim() === '') start++
    while (end > start && rendered[end - 1].text.trim() === '') end--
    for (let i = start; i < end; i++) {
      const r = rendered[i]
      const line: DisplayLine = {
        key: `${kind}-${this.seq++}`,
        kind,
        text: r.text,
        inCodeBlock: r.inCodeBlock,
        noWrap: r.noWrap,
      }
      const anchor = this.historyLineCount + (this.inTurn ? this.executingCount + this.pendingCount : 0)
      this.eventLines.push({ line, anchor })
      this.committed.push(line)
    }
  }

  addError(text: string): void {
    this.pushEventLines('error', text)
    this.emit()
  }

  /** 确认用的 diff 文本（自带 ANSI 颜色；kind='diff' 按默认色渲染，不被外层风格盖色） */
  addDiff(text: string): void {
    this.pushEventLines('diff', text)
    this.emit()
  }

  /** 启动欢迎内容等原生 ANSI 行（banner/入口提示/约束通知；kind='raw' 不被外层盖色，
   *  noWrap 保像素字形——窄窗截右缘比折行毁字形可读；锚点 0：重建不丢、置顶） */
  addRawLines(text: string): void {
    const parts = text.split('\n')
    while (parts.length > 0 && parts[0] === '') parts.shift()
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    for (const textLine of parts) {
      const line: DisplayLine = { key: `raw-${this.seq++}`, kind: 'raw', text: textLine, noWrap: true }
      // 与 pushEventLines 同锚定规则（启动行在 model 创建后即注册，historyLineCount=0 → 置顶）
      const anchor = this.historyLineCount + (this.inTurn ? this.executingCount + this.pendingCount : 0)
      this.eventLines.push({ line, anchor })
      this.committed.push(line)
    }
    this.emit()
  }

  // ==================== 可见窗口与滚动 ====================

  /** 逻辑行 → 视觉行（key 加 `:行内序号` 后缀；传播 inCodeBlock，围栏内行按 cols-2 折行给边框让位；
   *  noWrap 行不折行——表格行折行会毁对齐，溢出交给渲染层 truncate 截右缘） */
  private wrapLines(lines: DisplayLine[], cols: number): DisplayLine[] {
    const rows: DisplayLine[] = []
    for (const line of lines) {
      if (line.noWrap) {
        rows.push({ key: `${line.key}:0`, kind: line.kind, text: line.text, inCodeBlock: line.inCodeBlock, noWrap: true })
        continue
      }
      const effCols = line.inCodeBlock ? Math.max(1, cols - 2) : cols
      wrapTextToWidth(line.text, effCols).forEach((text, i) => {
        rows.push({ key: `${line.key}:${i}`, kind: line.kind, text, inCodeBlock: line.inCodeBlock })
      })
    }
    return rows
  }

  /** 思考区视觉行封顶（折行出口单点，follow 与冻结快照两路径同此一处）：头行恒保留，
   *  内容只留末尾 MAX_THINKING_STREAM_ROWS 个视觉行——高度与内容长度/换行形态/终端宽度
   *  解耦，稳态恒定。committed 中的 [思考] 摘要行是历史，不经此裁剪（只作用于 inflight） */
  private capThinkingStreamRows(wrappedInflight: DisplayLine[]): DisplayLine[] {
    let blockEnd = 0
    while (blockEnd < wrappedInflight.length && wrappedInflight[blockEnd].kind === 'thinking') blockEnd++
    if (blockEnd <= 1 + MAX_THINKING_STREAM_ROWS) return wrappedInflight
    return [
      wrappedInflight[0],
      ...wrappedInflight.slice(blockEnd - MAX_THINKING_STREAM_ROWS, blockEnd),
      ...wrappedInflight.slice(blockEnd),
    ]
  }

  /** committed 视觉行（增量缓存：只追加新行；宽度变化或重建后全量重排） */
  private ensureCommittedRows(cols: number): DisplayLine[] {
    if (cols !== this.cachedCols || this.committed.length < this.cachedCommittedCount) {
      this.cachedCommittedRows = this.wrapLines(this.committed, cols)
    } else if (this.committed.length > this.cachedCommittedCount) {
      this.cachedCommittedRows.push(...this.wrapLines(this.committed.slice(this.cachedCommittedCount), cols))
    }
    this.cachedCols = cols
    this.cachedCommittedCount = this.committed.length
    return this.cachedCommittedRows
  }

  /**
   * 可见窗口：rows-WINDOW_CHROME 个视觉行。
   * follow：committed + in-flight 合并为统一视觉行流，切尾部（钉底）；
   * 暂停跟随：committed + 冻结的 in-flight 快照（已流出部分可回看，视口不受流式增长打扰）。
   */
  visibleRows(rows: number, cols: number): DisplayLine[] {
    const safeCols = Math.max(1, cols)
    this.lastCols = safeCols
    const windowSize = Math.max(1, rows - WINDOW_CHROME)
    this.lastWindowSize = windowSize
    const committedRows = this.ensureCommittedRows(safeCols)
    if (!this.follow) {
      const base = this.frozenInflight
        ? committedRows.concat(this.capThinkingStreamRows(this.wrapLines(this.frozenInflight, safeCols)))
        : committedRows
      const end = Math.max(0, base.length - this.scrollOffset)
      return base.slice(Math.max(0, end - windowSize), end)
    }
    const all = committedRows.concat(this.capThinkingStreamRows(this.wrapLines(this.getInflightLines(), safeCols)))
    return all.slice(Math.max(0, all.length - windowSize))
  }

  /** 上滚 n 个视觉行并暂停跟随；首次暂停时冻结 in-flight 快照；
   *  封顶在最老内容恰好铺满窗口（再滚不会出现空白屏） */
  scrollUp(n: number): void {
    if (this.follow) this.frozenInflight = this.getInflightLines()
    this.follow = false
    let total = this.ensureCommittedRows(this.lastCols).length
    if (this.frozenInflight) total += this.wrapLines(this.frozenInflight, this.lastCols).length
    const maxOffset = Math.max(0, total - this.lastWindowSize)
    this.scrollOffset = Math.min(maxOffset, this.scrollOffset + Math.max(1, n))
    this.emit()
  }

  /** 下滚 n 个视觉行；回到底部自动恢复跟随并清冻结快照 */
  scrollDown(n: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, n))
    if (this.scrollOffset === 0) {
      this.follow = true
      this.frozenInflight = null
    }
    this.emit()
  }

  /** 回底并恢复跟随 */
  toBottom(): void {
    this.scrollOffset = 0
    this.follow = true
    this.frozenInflight = null
    this.emit()
  }

  /** 已提交行总数（测试与调试） */
  get size(): number {
    return this.committed.length
  }

  // ==================== transcript 查看器 ====================

  /** 查看器展开行缓存（键 = revision + cols） */
  private cachedViewerRows: DisplayLine[] = []
  private cachedViewerRev = -1
  private cachedViewerCols = 0

  /**
   * 查看器展开数组：committed 视觉行 + 工具详情块（参数/结果）插在对应工具标记逻辑行之后，
   * 压缩总结全文插在对应压缩标记行之后。
   * 查看器全部消费方（viewerRows/clampViewerTop/viewerSearch）统一读此——搜索匹配索引、
   * 滚动钳制、高亮行号同源，插入详情行后不错位。
   */
  private ensureViewerRows(cols: number): DisplayLine[] {
    const safeCols = Math.max(1, cols)
    if (this.cachedViewerRev === this.revision && this.cachedViewerCols === safeCols) {
      return this.cachedViewerRows
    }
    const committedRows = this.ensureCommittedRows(safeCols)
    if (this.toolDetails.size === 0 && this.compactionDetails.size === 0 && this.thinkingDetails.size === 0) {
      this.cachedViewerRows = committedRows
    } else {
      const expanded: DisplayLine[] = []
      let i = 0
      while (i < committedRows.length) {
        // 同一逻辑行的全部视觉行（key:0, key:1…）先通过，再按 baseKey 查详情
        const baseKey = committedRows[i].key.replace(/:\d+$/, '')
        expanded.push(committedRows[i])
        i++
        while (i < committedRows.length && committedRows[i].key.replace(/:\d+$/, '') === baseKey) {
          expanded.push(committedRows[i])
          i++
        }
        const detail = this.toolDetails.get(baseKey)
        if (detail) expanded.push(...this.buildToolDetailRows(baseKey, detail, safeCols))
        const checkpoint = this.compactionDetails.get(baseKey)
        if (checkpoint) expanded.push(...this.buildCompactionRows(baseKey, checkpoint, safeCols))
        const thinking = this.thinkingDetails.get(baseKey)
        if (thinking !== undefined) expanded.push(...this.buildThinkingRows(baseKey, thinking, safeCols))
      }
      this.cachedViewerRows = expanded
    }
    this.cachedViewerRev = this.revision
    this.cachedViewerCols = safeCols
    return this.cachedViewerRows
  }

  /** 工具详情 → 查看器视觉行：参数块（JSON 美化后拆行折行，封顶 20）+
   *  结果块（规范化后拆行折行，封顶 50；执行中注记）。超长注出口：会话记录文件 */
  private buildToolDetailRows(
    baseKey: string,
    detail: { args: string; result?: string; status: string; toolName?: string },
    cols: number
  ): DisplayLine[] {
    const rows: DisplayLine[] = []
    let n = 0
    const push = (text: string): void => {
      rows.push({ key: `${baseKey}:d${n++}`, kind: 'toolResult', text })
    }
    /** render=true 时逐行 markdown 行内渲染（子代理交付全文等人读文本）；
     *  其余（命令输出/JSON/日志/文件内容）保持原文保真 */
    const pushBlock = (label: string, body: string, cap: number, render = false): void => {
      if (!body.trim()) {
        push(`  ${label} (空)`)
        return
      }
      const visual: string[] = []
      for (const logical of render ? renderInlineMarkdownLines(body) : body.split('\n')) {
        visual.push(...wrapTextToWidth(logical, cols))
      }
      visual.slice(0, cap).forEach((v, i) => push(i === 0 ? `  ${label} ${v}` : `    ${v}`))
      if (visual.length > cap) push(`    … 共 ${visual.length} 行，完整内容在会话记录文件中`)
    }
    pushBlock('参数:', detail.args ? prettyJsonIfPossible(detail.args) : '', 20)
    if (detail.result !== undefined) {
      pushBlock('结果:', normalizeToolResult(detail.result), 50, isTaskLikeTool(detail.toolName))
    } else push('  结果: (执行中，结果未落地)')
    return rows
  }

  /** 思考全文 → 查看器视觉行（kind 'thinking' 继承 dim+italic 观感；不截断——
   *  主屏折叠、查看器全量是 transcript「全量视图」的本意，与工具详情的超长截断语义不同） */
  private buildThinkingRows(baseKey: string, thinking: string, cols: number): DisplayLine[] {
    const rows: DisplayLine[] = []
    let n = 0
    for (const logical of renderInlineMarkdownLines(thinking)) {
      for (const v of wrapTextToWidth(logical, cols)) {
        rows.push({ key: `${baseKey}:t${n++}`, kind: 'thinking', text: v })
      }
    }
    return rows
  }

  /** 压缩 checkpoint → 查看器视觉行：引导语（若有）+ 总结全文（dim 弱化，对齐工具详情观感；
   *  总结即用户要看的内容，不截断——与工具详情的超长截断语义不同） */
  private buildCompactionRows(baseKey: string, checkpoint: CompactionCheckpoint, cols: number): DisplayLine[] {
    const rows: DisplayLine[] = []
    let n = 0
    const push = (text: string): void => {
      rows.push({ key: `${baseKey}:c${n++}`, kind: 'toolResult', text })
    }
    const pushBlock = (label: string, body: string): void => {
      for (const logical of renderInlineMarkdownLines(body)) {
        const visual = wrapTextToWidth(logical, cols)
        visual.forEach((v, i) => push(i === 0 ? `  ${label} ${v}` : `    ${v}`))
      }
    }
    if (checkpoint.guidance) pushBlock('引导语:', checkpoint.guidance)
    pushBlock('总结:', checkpoint.summary)
    return rows
  }

  /** transcript 查看器开关（滚轮处理器与 TuiApp 键路由均读此） */
  viewerOpen = false
  /** 视口顶行的绝对视觉行号（单一簿记：新内容追加不漂移，读取钳制不越界） */
  private viewerTop = 0
  /** 最近一次查看器窗口行数（滚动封顶用） */
  private viewerWindowSize = 20

  /** 开合查看器；打开时定位到最新（底部）。经 emit 驱动重渲染。
   *  例外：刚发生过新压缩（setCompactions 观察到 checkpoint 增多）时，首次打开定位到
   *  最新标记条——切点距底部可能隔着很长的 tail 轮次（长回复动辄数十行），
   *  钉底打开会让用户看不到总结（用户报告过的真实困惑） */
  toggleViewer(): void {
    this.viewerOpen = !this.viewerOpen
    if (this.viewerOpen) {
      if (this.revealCompactionKey !== null) {
        const key = this.revealCompactionKey
        this.revealCompactionKey = null
        const rows = this.ensureViewerRows(this.lastCols)
        const idx = rows.findIndex((r) => r.key.replace(/:\d+$/, '') === key)
        if (idx >= 0) {
          this.viewerTop = Math.max(0, idx - 1)
          this.emit()
          return
        }
      }
      this.viewerToBottom()
    } else this.emit()
  }

  /** 待揭示的压缩标记行 key（compact-<id>）：setCompactions 发现新增 checkpoint 时登记，
   *  下次打开查看器定位到该标记后清除（一次性） */
  private revealCompactionKey: string | null = null

  /** 查看器窗口：rows 行（TuiApp 以 rows-2 调用）；只含 committed（已提交档案，不含 in-flight）
   *  + 工具详情展开块 */
  viewerRows(rows: number, cols: number): DisplayLine[] {
    const safeCols = Math.max(1, cols)
    this.lastCols = safeCols
    this.viewerWindowSize = Math.max(1, rows)
    const all = this.ensureViewerRows(safeCols)
    const maxTop = Math.max(0, all.length - this.viewerWindowSize)
    this.viewerTop = Math.max(0, Math.min(this.viewerTop, maxTop))
    return all.slice(this.viewerTop, this.viewerTop + this.viewerWindowSize)
  }

  /** viewerTop 钳制：历史变短（/session load 重建）不越界、不空白 */
  private clampViewerTop(): void {
    const total = this.ensureViewerRows(this.lastCols).length
    const maxTop = Math.max(0, total - this.viewerWindowSize)
    this.viewerTop = Math.max(0, Math.min(this.viewerTop, maxTop))
  }

  /** 逐行滚动（n<0 上滚，n>0 下滚） */
  viewerScroll(n: number): void {
    this.viewerTop += n
    this.clampViewerTop()
    this.emit()
  }

  /** 整屏翻页：步长 = windowSize - 1（留 1 行重叠衔接，less 手感） */
  viewerPage(dir: 1 | -1): void {
    this.viewerScroll(dir * Math.max(1, this.viewerWindowSize - 1))
  }

  viewerToTop(): void {
    this.viewerTop = 0
    this.emit()
  }

  viewerToBottom(): void {
    // 置哨兵而非直接钳制：真实窗口行数要等 viewerRows 调用才知道，
    // 立即钳制会用陈旧尺寸把"底部"错钳到别处
    this.viewerTop = Number.MAX_SAFE_INTEGER
    this.emit()
  }

  // ==================== 查看器搜索 ====================

  /** 匹配的视觉行号数组（ensureCommittedRows 顺序）与当前命中下标 */
  private viewerMatches: number[] = []
  private viewerMatchIdx = -1
  /** 最近一次搜索词（匹配高亮用，空串表示未搜索） */
  viewerQuery = ''

  /** 视觉行大小写不敏感包含搜索（跨折行断开的词查不到，与 less 一致）；
   *  命中后定位视口到首个匹配，返回匹配总数 */
  viewerSearch(query: string): number {
    const q = query.trim()
    this.viewerQuery = q
    this.viewerMatches = []
    this.viewerMatchIdx = -1
    if (q) {
      const lower = q.toLowerCase()
      const all = this.ensureViewerRows(this.lastCols)
      for (let i = 0; i < all.length; i++) {
        // 含 Markdown 样式 ANSI 的行按纯文本匹配,行号不变
        if (stripAnsiText(all[i].text).toLowerCase().includes(lower)) this.viewerMatches.push(i)
      }
    }
    if (this.viewerMatches.length > 0) this.viewerJumpToMatch(1)
    else this.emit()
    return this.viewerMatches.length
  }

  /** 当前命中行号（无命中为 -1；高亮区分当前与其他匹配用） */
  get viewerCurrentRow(): number {
    return this.viewerMatchIdx >= 0 ? this.viewerMatches[this.viewerMatchIdx] : -1
  }

  /** 当前视口顶行号（渲染层计算行内命中位置用；viewerRows 调用后为钳制后值） */
  get viewerTopIndex(): number {
    return this.viewerTop
  }

  /** 在匹配间循环定位（1 下一个，-1 上一个）；返回当前是第几个（1 起），无匹配返回 0 */
  viewerJumpToMatch(dir: 1 | -1): number {
    const n = this.viewerMatches.length
    if (n === 0) return 0
    this.viewerMatchIdx = (((this.viewerMatchIdx + dir) % n) + n) % n
    const row = this.viewerMatches[this.viewerMatchIdx]
    // 匹配行尽量居于视口中部
    this.viewerTop = row - Math.floor(this.viewerWindowSize / 2)
    this.clampViewerTop()
    this.emit()
    return this.viewerMatchIdx + 1
  }

  /** 当前匹配状态（提示行显示用）：[第几个（1 起，0 表示无命中），匹配总数] */
  get viewerMatchState(): [number, number] {
    return [this.viewerMatchIdx + 1, this.viewerMatches.length]
  }

  // ==================== 查看器轮次跳转 ====================

  /** kind==='user' 的视觉行号（轮次锚点） */
  private userRowIndices(cols: number): number[] {
    const all = this.ensureCommittedRows(cols)
    const idx: number[] = []
    for (let i = 0; i < all.length; i++) {
      if (all[i].kind === 'user') idx.push(i)
    }
    return idx
  }

  /** 在用户消息（轮次）间跳转：-1 上一条、1 下一条；视口顶定位到该轮 */
  viewerJumpUser(dir: 1 | -1): void {
    const users = this.userRowIndices(this.lastCols)
    if (users.length === 0) return
    // 当前视口顶所在的轮次：最后一条不晚于 viewerTop 的用户行
    let pos = -1
    for (let i = 0; i < users.length; i++) {
      if (users[i] <= this.viewerTop) pos = i
      else break
    }
    let next: number
    if (pos === -1) next = 0 // 位于首条用户消息之前，任一键都去第一条
    else if (users[pos] === this.viewerTop) next = pos + dir
    else next = dir === -1 ? pos : pos + 1
    next = Math.max(0, Math.min(users.length - 1, next))
    this.viewerTop = users[next]
    this.clampViewerTop()
    this.emit()
  }
}
