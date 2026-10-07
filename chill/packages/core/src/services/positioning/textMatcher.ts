/**
 * 统一文本匹配引擎（replace_content / insert_content / delete_content 共用）。
 *
 * 设计原则：
 * - 磁盘当前内容是唯一真相源——本引擎只对调用方传入的文本负责，不持有任何缓存。
 * - 两层匹配：L0 原文精确（indexOf 全位置 + context 过滤 + 唯一性）；
 *   L1 行级容忍（按 \r\n|\r|\n 拆行、逐行去行尾空白后整行等值，免疫 CRLF/行尾空格/
 *   缩进行起始——行内比较不存在跨边界空白折叠的不对称问题）。
 * - 唯一性内建：多处匹配一律失败并给出 candidates（按物理位置去重），调用方不得静默取第一。
 * - 无模糊匹配层：匹配不上就明确报错并引导 read_file（生产日志证据：旧模糊路径产出全是误报）。
 *
 * 纯函数、Node-free，渲染进程可安全引用。
 */

export interface TextMatchCandidate {
  index: number
  snippet: string
  suggested_context_before?: string
  suggested_context_after?: string
}

export interface TextMatchSuccess {
  success: true
  /** 原文偏移起点 */
  from: number
  /** 原文偏移终点（不含） */
  to: number
  matchedText: string
}

export interface TextMatchFailure {
  success: false
  error: string
  candidates?: TextMatchCandidate[]
}

export type TextMatchResult = TextMatchSuccess | TextMatchFailure

export interface AnchorMatchSuccess {
  success: true
  /** 原文偏移插入点（after=锚点下一行行首；before=锚点所在行行首） */
  pos: number
  matchedText: string
}

export type AnchorMatchResult = AnchorMatchSuccess | TextMatchFailure

const READ_FILE_HINT = '文本可能已被修改，建议先 read_file 查看最新内容'
const MAX_CANDIDATES = 5

function preview(s: string, max: number = 50): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

interface LineInfo {
  /** 行首在原文中的偏移 */
  start: number
  /** 行内容（不含行终止符，保留行尾空白与缩进） */
  raw: string
  /** 去行尾空格/制表符后的内容（比较用） */
  trimmed: string
}

/** 按 \r\n|\r|\n 拆行，保留原文偏移；行尾空白仅 trimEnd（缩进保留） */
function splitLines(text: string): LineInfo[] {
  const lines: LineInfo[] = []
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\r' || ch === '\n') {
      const raw = text.slice(start, i)
      lines.push({ start, raw, trimmed: raw.replace(/[ \t]+$/, '') })
      if (ch === '\r' && text[i + 1] === '\n') i++
      i++
      start = i
    } else {
      i++
    }
  }
  if (start < text.length) {
    const raw = text.slice(start)
    lines.push({ start, raw, trimmed: raw.replace(/[ \t]+$/, '') })
  }
  return lines
}

/** target 拆行并去掉首尾的空行（容忍模型复制时多带的首尾换行） */
function targetLinesOf(target: string): string[] {
  const lines = splitLines(target).map((l) => l.trimmed)
  let s = 0
  let e = lines.length
  while (s < e && lines[s] === '') s++
  while (e > s && lines[e - 1] === '') e--
  return lines.slice(s, e)
}

function contextOk(
  fileText: string,
  from: number,
  to: number,
  contextBefore?: string,
  contextAfter?: string
): boolean {
  if (contextBefore && fileText.slice(Math.max(0, from - contextBefore.length), from) !== contextBefore) return false
  if (contextAfter && fileText.slice(to, to + contextAfter.length) !== contextAfter) return false
  return true
}

/** L0 原文精确：indexOf 全位置 + context 过滤 */
function collectExactMatches(
  fileText: string,
  target: string,
  contextBefore?: string,
  contextAfter?: string
): Array<{ from: number; to: number }> {
  const matches: Array<{ from: number; to: number }> = []
  let i = fileText.indexOf(target)
  while (i !== -1) {
    const to = i + target.length
    if (contextOk(fileText, i, to, contextBefore, contextAfter)) matches.push({ from: i, to })
    i = fileText.indexOf(target, i + target.length)
  }
  return matches
}

/** L1 行级容忍：target 行序列在文件行序列中的唯一连续匹配（逐行 trimEnd 后等值） */
function collectLineMatches(
  fileText: string,
  fileLines: LineInfo[],
  targetLines: string[],
  contextBefore?: string,
  contextAfter?: string
): Array<{ from: number; to: number }> {
  const matches: Array<{ from: number; to: number }> = []
  const n = targetLines.length
  for (let s = 0; s + n <= fileLines.length; s++) {
    let ok = true
    for (let j = 0; j < n; j++) {
      if (fileLines[s + j].trimmed !== targetLines[j]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const from = fileLines[s].start
    const last = fileLines[s + n - 1]
    const to = last.start + last.raw.length
    if (contextOk(fileText, from, to, contextBefore, contextAfter)) matches.push({ from, to })
  }
  return matches
}

function makeCandidate(fileText: string, index: number, targetLen: number): TextMatchCandidate {
  return {
    index,
    snippet: fileText.slice(Math.max(0, index - 20), Math.min(fileText.length, index + targetLen + 20)),
    suggested_context_before: fileText.slice(Math.max(0, index - 30), index),
    suggested_context_after: fileText.slice(index, Math.min(fileText.length, index + 30))
  }
}

/** 按物理位置去重：间距小于 targetLen 的候选视为同一位置的重复（防滑窗自碰撞式误报） */
function dedupeCandidates(candidates: TextMatchCandidate[], targetLen: number): TextMatchCandidate[] {
  const minGap = Math.max(1, targetLen)
  const kept: TextMatchCandidate[] = []
  for (const c of candidates) {
    if (kept.every((k) => Math.abs(k.index - c.index) >= minGap)) kept.push(c)
    if (kept.length >= MAX_CANDIDATES) break
  }
  return kept
}

function multipleFailure(fileText: string, positions: Array<{ from: number }>, targetLen: number): TextMatchFailure {
  const candidates = dedupeCandidates(
    positions.map((p) => makeCandidate(fileText, p.from, targetLen)),
    targetLen
  )
  return {
    success: false,
    error: `找到 ${positions.length} 个匹配位置，请补充更精确的上下文（可用 context_before/context_after）`,
    candidates
  }
}

/** 未找到时的候选：包含 target 首个非空行（trim 后）的行位置 */
function notFoundFailure(fileText: string, fileLines: LineInfo[], targetLines: string[], target: string): TextMatchFailure {
  const firstLine = (targetLines[0] ?? '').trim()
  const raw: TextMatchCandidate[] = []
  if (firstLine) {
    for (const l of fileLines) {
      if (l.trimmed.includes(firstLine)) raw.push(makeCandidate(fileText, l.start, target.length))
      if (raw.length >= MAX_CANDIDATES * 2) break
    }
  }
  return {
    success: false,
    error: `未找到匹配的文本：${preview(target)}。${READ_FILE_HINT}`,
    candidates: dedupeCandidates(raw, target.length)
  }
}

function matchTargetCore(
  fileText: string,
  target: string,
  contextBefore?: string,
  contextAfter?: string
): TextMatchResult {
  if (!target || !target.trim()) {
    return { success: false, error: 'old_content/anchor 不能为空或全为空白' }
  }

  // L0 原文精确
  const exact = collectExactMatches(fileText, target, contextBefore, contextAfter)
  if (exact.length === 1) {
    const m = exact[0]
    return { success: true, from: m.from, to: m.to, matchedText: fileText.slice(m.from, m.to) }
  }
  if (exact.length > 1) return multipleFailure(fileText, exact, target.length)

  // L1 行级容忍
  const fileLines = splitLines(fileText)
  const targetLines = targetLinesOf(target)
  if (targetLines.length === 0) {
    return { success: false, error: 'old_content/anchor 不能为空或全为空白' }
  }
  const lineMatches = collectLineMatches(fileText, fileLines, targetLines, contextBefore, contextAfter)
  if (lineMatches.length === 1) {
    const m = lineMatches[0]
    return { success: true, from: m.from, to: m.to, matchedText: fileText.slice(m.from, m.to) }
  }
  if (lineMatches.length > 1) return multipleFailure(fileText, lineMatches, target.length)

  return notFoundFailure(fileText, fileLines, targetLines, target)
}

/**
 * 定位 target 在 fileText 中的唯一位置（replace_content/delete_content 的匹配语义）。
 * contextBefore/contextAfter 为可选的相邻原文约束（精确等值）。
 */
export function matchTargetInText(
  fileText: string,
  target: string,
  contextBefore?: string,
  contextAfter?: string
): TextMatchResult {
  return matchTargetCore(fileText, target, contextBefore, contextAfter)
}

/**
 * 定位 insert_content 锚点并给出插入点。
 * after=锚点匹配区末之后、跳过行终止符到下一行行首；before=回退到锚点所在行行首。
 */
export function matchAnchorInText(
  fileText: string,
  anchor: string,
  position: 'before' | 'after'
): AnchorMatchResult {
  const result = matchTargetCore(fileText, anchor)
  if (!result.success) {
    if (result.error.startsWith('未找到匹配的文本')) {
      return { ...result, error: `未找到锚点文本：${preview(anchor)}。${READ_FILE_HINT}` }
    }
    return result
  }

  let pos: number
  if (position === 'after') {
    pos = result.to
    while (pos < fileText.length && (fileText[pos] === '\r' || fileText[pos] === '\n')) pos++
  } else {
    pos = result.from
    while (pos > 0 && fileText[pos - 1] !== '\n') pos--
  }
  return { success: true, pos, matchedText: result.matchedText }
}
