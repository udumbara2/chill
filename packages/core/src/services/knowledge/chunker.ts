import { DEFAULT_KNOWLEDGE_CONFIG, type ChunkRecord } from './types'

/**
 * 知识库切块模块（设计见 iDream/知识管理.md 第二节）：结构感知为主 + 递归字符兜底 + small-to-big。
 *
 * - Markdown：按标题层级切 section，超长节用递归字符切分兜底；每个 chunk 带 headingPath
 *   （如 "React > Hooks > useEffect"），子块 embedding 文本 = 标题路径前缀 + 正文（穷人版 Contextual Retrieval）
 * - 纯文本（PDF 抽取）：递归字符切分，无标题路径
 * - parent-child：子块 ~childChunkSize 做 embedding 与匹配，父块 ~parentChunkSize 不嵌向量，
 *   检索命中后返回父块喂模型；子块带 parentId
 *
 * 零依赖纯函数，三端同码（不 import 任何 Node/Electron API）。
 */

/** 递归切分的分隔符优先级：段落 → 换行 → 句号 → 分号，逐级降级，切口落在自然边界 */
const SEPARATORS = ['\n\n', '\n', '。', '；']

/** 相邻子块默认重叠字符数（缓解边界语义截断） */
const DEFAULT_OVERLAP = 50

/** 切块参数（尺寸缺省取全局配置默认值；docId 写入记录并作为 chunk id 前缀保证跨文档唯一） */
export interface ChunkOptions {
  childChunkSize?: number
  parentChunkSize?: number
  overlap?: number
  docId?: string
}

interface ResolvedChunkOptions {
  childChunkSize: number
  parentChunkSize: number
  overlap: number
  docId: string
}

function resolveOptions(options: ChunkOptions): ResolvedChunkOptions {
  const d = DEFAULT_KNOWLEDGE_CONFIG.retrieval
  const resolved: ResolvedChunkOptions = {
    childChunkSize: options.childChunkSize ?? d.childChunkSize,
    parentChunkSize: options.parentChunkSize ?? d.parentChunkSize,
    overlap: Math.max(0, options.overlap ?? DEFAULT_OVERLAP),
    docId: options.docId ?? 'doc',
  }
  if (resolved.childChunkSize <= 0) throw new Error('childChunkSize 必须为正数')
  if (resolved.parentChunkSize <= 0) throw new Error('parentChunkSize 必须为正数')
  return resolved
}

/** 带原文偏移的文本片段（start/end 为半开区间 [start, end)，相对于所在源文本） */
interface Piece {
  text: string
  start: number
  end: number
}

/** 去掉首尾空白并同步修正偏移；整片空白返回 null */
function trimPiece(piece: Piece): Piece | null {
  const text = piece.text.trim()
  if (!text) return null
  const lead = piece.text.length - piece.text.trimStart().length
  const start = piece.start + lead
  return { text, start, end: start + text.length }
}

/** 按分隔符切开，分隔符保留在前一段末尾（切口落在自然边界之后） */
function splitKeeping(piece: Piece, sep: string): Piece[] {
  const out: Piece[] = []
  let pos = 0
  while (pos < piece.text.length) {
    const idx = piece.text.indexOf(sep, pos)
    if (idx === -1) break
    const end = idx + sep.length
    out.push({ text: piece.text.slice(pos, end), start: piece.start + pos, end: piece.start + end })
    pos = end
  }
  if (pos < piece.text.length) {
    out.push({ text: piece.text.slice(pos), start: piece.start + pos, end: piece.end })
  }
  return out
}

/** 硬超限兜底：没有任何可用分隔符时按字符断（带重叠） */
function hardSplit(piece: Piece, maxSize: number, overlap: number): Piece[] {
  const out: Piece[] = []
  const step = Math.max(1, maxSize - overlap)
  for (let pos = 0; pos < piece.text.length; pos += step) {
    const end = Math.min(pos + maxSize, piece.text.length)
    out.push({ text: piece.text.slice(pos, end), start: piece.start + pos, end: piece.start + end })
    if (end >= piece.text.length) break
  }
  return out
}

/** 递归降级拆分：把超过 maxSize 的片段按分隔符优先级逐级拆到 maxSize 以内 */
function splitRecursive(piece: Piece, maxSize: number, overlap: number, sepIndex: number): Piece[] {
  if (piece.text.length <= maxSize) return [piece]
  let idx = -1
  for (let i = sepIndex; i < SEPARATORS.length; i++) {
    if (piece.text.includes(SEPARATORS[i])) { idx = i; break }
  }
  if (idx === -1) return hardSplit(piece, maxSize, overlap)
  const out: Piece[] = []
  for (const part of splitKeeping(piece, SEPARATORS[idx])) {
    out.push(...splitRecursive(part, maxSize, overlap, idx + 1))
  }
  return out
}

/** 贪心合并小片段到 maxSize 以内，相邻块之间保留 overlap 长度的尾部重叠 */
function mergePieces(pieces: Piece[], maxSize: number, overlap: number): Piece[] {
  const out: Piece[] = []
  let current: Piece[] = []
  let currentLen = 0
  let emittedCount = 0 // current 头部已产出过的片段数（重叠保留部分，避免重复成块）

  const emit = () => {
    if (current.length > emittedCount) {
      const piece = trimPiece({
        text: current.map(p => p.text).join(''),
        start: current[0].start,
        end: current[current.length - 1].end,
      })
      if (piece) out.push(piece)
    }
    // 重叠：从尾部保留总长度不超过 overlap 的片段，作为下一块的开头
    if (overlap > 0) {
      const kept: Piece[] = []
      let keptLen = 0
      for (let i = current.length - 1; i >= 0; i--) {
        const t = current[i].text.length
        if (keptLen + t > overlap) break
        kept.unshift(current[i])
        keptLen += t
      }
      current = kept
      currentLen = keptLen
    } else {
      current = []
      currentLen = 0
    }
    emittedCount = current.length
  }

  for (const p of pieces) {
    if (currentLen > 0 && currentLen + p.text.length > maxSize) emit()
    // 重叠保留片段加上新片段仍超限：丢弃重叠（p 本身保证 ≤ maxSize，单独成块）
    if (currentLen > 0 && currentLen + p.text.length > maxSize) {
      current = []
      currentLen = 0
      emittedCount = 0
    }
    current.push(p)
    currentLen += p.text.length
  }
  emit()
  return out
}

/** 递归切 + 合并：输出均不超过 maxSize（除非硬超限按字符断），偏移与输入 piece 同源 */
function splitToPieces(piece: Piece, maxSize: number, overlap: number): Piece[] {
  const trimmed = trimPiece(piece)
  if (!trimmed) return []
  return mergePieces(splitRecursive(trimmed, maxSize, overlap, 0), maxSize, overlap)
}

/**
 * 递归字符切分器：按 ['\n\n', '\n', '。', '；'] 优先级递归降级，切口落在自然边界；
 * 单段没有任何分隔符且硬超限时才按字符断。相邻块保留 overlap 长度重叠。
 */
export function recursiveSplit(text: string, maxSize: number, overlap = DEFAULT_OVERLAP): string[] {
  if (maxSize <= 0) throw new Error('maxSize 必须为正数')
  return splitToPieces({ text, start: 0, end: text.length }, maxSize, overlap).map(p => p.text)
}

/** Markdown 块：一个标题到下一个标题之间的 section，带标题路径与原文偏移 */
interface MarkdownBlock extends Piece {
  headingPath?: string
}

/** 判断块内是否有标题行以外的正文（只含标题的裸块会并入相邻块） */
function hasBody(block: MarkdownBlock): boolean {
  return block.text.split('\n').some(line => {
    const t = line.trim()
    return t.length > 0 && !t.startsWith('#')
  })
}

/** 按 Markdown 标题行切 section：块含标题行本身，headingPath 为当前标题栈（含本块标题） */
function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const stack: Array<{ level: number; title: string }> = []
  let blockStart = 0
  let blockPath: string | undefined
  let pos = 0
  for (const line of text.split('\n')) {
    const lineStart = pos
    pos += line.length + 1 // +1 是 '\n'；最后一行无换行多算 1 不影响（只用于后续行起点）
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (!m) continue
    const title = m[2].replace(/\s*#+\s*$/, '').trim() // 去掉行尾闭合的 ###
    if (lineStart > blockStart) {
      blocks.push({ text: text.slice(blockStart, lineStart), start: blockStart, end: lineStart, headingPath: blockPath })
    }
    while (stack.length && stack[stack.length - 1].level >= m[1].length) stack.pop()
    stack.push({ level: m[1].length, title })
    blockPath = stack.map(h => h.title).join(' > ')
    blockStart = lineStart
  }
  if (blockStart < text.length) {
    blocks.push({ text: text.slice(blockStart), start: blockStart, end: text.length, headingPath: blockPath })
  }
  return blocks
}

/** 裸标题块（无正文）并入下一块；下一块的 headingPath 已包含这些标题。末尾裸块并入上一块 */
function mergeBareHeadings(blocks: MarkdownBlock[]): MarkdownBlock[] {
  const out: MarkdownBlock[] = []
  let pending: MarkdownBlock | null = null
  for (const b of blocks) {
    if (pending) {
      b.text = pending.text + b.text
      b.start = pending.start
      pending = null
    }
    if (hasBody(b)) out.push(b)
    else pending = b
  }
  if (pending) {
    if (out.length) {
      const last = out[out.length - 1]
      last.text += pending.text
      last.end = pending.end
    } else {
      out.push(pending)
    }
  }
  return out
}

/**
 * small-to-big 组装：每个 section 先按 childChunkSize 递归拆成子块（超长节在此兜底），
 * 再把连续子块贪心分组为不超过 parentChunkSize 的父块。
 * 返回扁平记录数组：父块在前、其子块紧随其后；子块带 parentId，父块不嵌向量。
 */
function buildParentChild(blocks: MarkdownBlock[], source: string, opts: ResolvedChunkOptions): ChunkRecord[] {
  interface Child extends Piece { headingPath?: string }
  const children: Child[] = []
  for (const block of blocks) {
    for (const p of splitToPieces(block, opts.childChunkSize, opts.overlap)) {
      children.push({ ...p, headingPath: block.headingPath })
    }
  }

  const records: ChunkRecord[] = []
  let parentSeq = 0
  let childSeq = 0
  let group: Child[] = []

  const flush = () => {
    if (!group.length) return
    const current = group
    group = []
    // 父块文本 = 首末子块区间的原文切片（含块间空白），不嵌向量
    const parent = trimPiece({
      text: source.slice(current[0].start, current[current.length - 1].end),
      start: current[0].start,
      end: current[current.length - 1].end,
    })
    if (!parent) return
    const parentId = `${opts.docId}-p${parentSeq++}`
    records.push({
      id: parentId,
      docId: opts.docId,
      headingPath: current[0].headingPath, // 父块路径取首子块的标题路径（仅元数据）
      charStart: parent.start,
      charEnd: parent.end,
      text: parent.text,
    })
    for (const c of current) {
      records.push({
        id: `${opts.docId}-c${childSeq++}`,
        docId: opts.docId,
        parentId,
        headingPath: c.headingPath,
        charStart: c.start,
        charEnd: c.end,
        text: c.text,
      })
    }
  }

  for (const c of children) {
    // 父块文本是子块区间的原文切片，用区间长度判断超限（含块间空白）
    if (group.length > 0 && c.end - group[0].start > opts.parentChunkSize) flush()
    group.push(c)
  }
  flush()
  return records
}

/**
 * Markdown 标题切块：按 # 层级切 section，section 超 parentChunkSize 用递归字符切分兜底；
 * 每个 chunk 携带 headingPath（如 "React > Hooks > useEffect"）。
 */
export function chunkMarkdown(text: string, options: ChunkOptions = {}): ChunkRecord[] {
  const opts = resolveOptions(options)
  return buildParentChild(mergeBareHeadings(splitMarkdownBlocks(text)), text, opts)
}

/** 纯文本切块（PDF 抽取文本用）：递归字符切 + 父子块，无标题路径 */
export function chunkPlainText(text: string, options: ChunkOptions = {}): ChunkRecord[] {
  const opts = resolveOptions(options)
  return buildParentChild([{ text, start: 0, end: text.length }], text, opts)
}

/** 子块的 embedding 用文本：标题路径前缀 + 正文（如 "React > Hooks > useEffect\n正文..."） */
export function embeddingText(chunk: ChunkRecord): string {
  return chunk.headingPath ? `${chunk.headingPath}\n${chunk.text}` : chunk.text
}
