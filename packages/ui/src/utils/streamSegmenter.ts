/**
 * 流式 markdown 分段器（渲染架构 L4 核心）。
 *
 * 第一性原理：markdown 的块级结构天然行对齐——已闭合的行块（段落/列表项/标题）
 * 追加新行永不回改，只有"尾部未闭合块"可变。因此：
 * - 分段单位 = markdown 块（行对齐），而不是文本段/代码段（那样长段落仍是 O(L²)）；
 * - 冻结边界 = 空白行 + 前瞻一行非延续（CommonMark 中空行分隔的同类型列表项是
 *   单个宽松列表，朴素空白行切分会把 `- a\n\n- b` 渲染成两个列表——错误）；
 * - 每次 push 只处理新增后缀的完整行；闭合块一旦冻结，其内容永不重渲染；
 * - 尾部未带换行的半行暂存（partialLine），经 view() 虚拟并入开放块展示，
 *   换行确认后提交——保证流式中的当行文本实时可见。
 *
 * 代码 fence 是块类型之一：开放代码块内容按行累积（内部空行属代码，不构成冻结点），
 * 闭合时 trim（与旧管线 parseContentByTime 的产出对齐）。
 */

/** 列表标记识别结果 */
interface ListMarker {
  marker: string
  ordered: boolean
}

const matchListMarker = (line: string): ListMarker | null => {
  const m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)/)
  if (!m) return null
  return { marker: m[2], ordered: /\d/.test(m[2][0]) }
}

/** fence 行识别（开/闭同式，与旧管线 /^```(\w+)?$/ 语义一致） */
const matchFence = (line: string): { language: string | null } | null => {
  const m = line.match(/^```(\w+)?\s*$/)
  return m ? { language: m[1] ?? null } : null
}

/** 内部分段结构（closed 后 content 不可变） */
export interface Segment {
  id: string
  type: 'text' | 'code'
  content: string
  language?: string
  closed: boolean
}

/** 展示用分段（开放块含 partialLine 虚拟并入；开放代码块不 trim） */
export interface DisplaySegment {
  id: string
  type: 'text' | 'code'
  content: string
  language?: string
  open: boolean
}

export class StreamSegmenter {
  private segments: Segment[] = []
  private segCounter = 0
  private partialLine = ''
  private open: Segment | null = null
  /** 冻结待定中的空行数（空白行到达后等下一非空行做延续判定） */
  private pendingBlanks = 0
  /** 开放文本块的列表上下文（延续判定：同类列表项/缩进延续） */
  private listCtx: ListMarker | null = null

  /** 喂入新增文本（任意切分；内部按完整行消费，尾部半行暂存） */
  push(text: string): void {
    if (!text) return
    const combined = this.partialLine + text
    const lines = combined.split('\n')
    this.partialLine = lines.pop() ?? ''
    for (const line of lines) {
      this.consumeLine(line)
    }
  }

  /** 流结束（或静态全文）：提交半行、判定挂起空行、冻结全部开放块 */
  finalize(): void {
    if (this.partialLine) {
      this.consumeLine(this.partialLine)
      this.partialLine = ''
    }
    // 结尾空行对渲染无意义，直接丢弃（与旧管线 trim 语义一致）
    this.pendingBlanks = 0
    this.closeOpen()
  }

  /** 展示快照：闭合块原样；开放块虚拟并入半行 */
  view(): DisplaySegment[] {
    const out: DisplaySegment[] = this.segments.map((s) => ({
      id: s.id,
      type: s.type,
      content: s.content,
      language: s.language,
      open: !s.closed,
    }))
    if (this.partialLine) {
      const last = out[out.length - 1]
      if (last && last.open) {
        last.content = last.content + this.partialLine
      } else {
        // 半行无法归属已闭合块：临时开放块展示（换行确认后转正）
        const id = `s${this.segCounter}` // 与下一正式块同 id（consumeLine 将立刻创建它）
        out.push({ id, type: 'text', content: this.partialLine, open: true })
      }
    }
    return out
  }

  // ==================== 内部：行消费状态机 ====================

  private consumeLine(line: string): void {
    // 开放代码块：内部空行属代码内容；fence 行闭合
    if (this.open && this.open.type === 'code') {
      if (matchFence(line)) {
        this.open.content = this.open.content.replace(/\n+$/, '')
        this.open.closed = true
        this.open = null
      } else {
        this.commitBlanks()
        this.open.content += line + '\n'
      }
      return
    }

    // 文本区：空行 → 冻结待定（等下一非空行判定延续）
    if (line.trim() === '') {
      if (this.open) this.pendingBlanks++
      return
    }

    // fence 行（无论空行与否）终结当前文本块并开启代码块（与旧管线逐行独立判定一致）
    if (matchFence(line)) {
      this.closeOpen()
      this.openBlock(line)
      return
    }

    if (this.open && this.pendingBlanks > 0) {
      if (this.isContinuation(line)) {
        // 宽松列表延续：空行并入开放块（CommonMark 单列表语义）
        this.commitBlanks()
        this.open.content += line + '\n'
        this.updateListCtx(line)
      } else {
        this.closeOpen()
        this.openBlock(line)
      }
      return
    }

    if (this.open) {
      // 连续行（无空行）：同一块（段落 lazy continuation / 列表项内容）
      this.open.content += line + '\n'
      this.updateListCtx(line)
      return
    }

    this.openBlock(line)
  }

  private openBlock(line: string): void {
    const fence = matchFence(line)
    const seg: Segment = {
      id: `s${this.segCounter++}`,
      type: fence ? 'code' : 'text',
      content: fence ? '' : line + '\n',
      closed: false,
    }
    if (fence) seg.language = fence.language ?? 'text'
    this.segments.push(seg)
    this.open = seg
    this.listCtx = fence ? null : this.updateListCtx(line)
  }

  private closeOpen(): void {
    if (!this.open) return
    this.open.content = this.open.content.replace(/\n+$/, '')
    this.open.closed = true
    this.open = null
    this.listCtx = null
    this.pendingBlanks = 0
  }

  private commitBlanks(): void {
    if (this.open && this.pendingBlanks > 0) {
      this.open.content += '\n'.repeat(this.pendingBlanks)
    }
    this.pendingBlanks = 0
  }

  private updateListCtx(line: string): ListMarker | null {
    const m = matchListMarker(line)
    if (m) this.listCtx = m
    return this.listCtx
  }

  /** 延续判定（冻结边界前瞻）：同类列表项 / 有序同类 / 列表项缩进延续 */
  private isContinuation(line: string): boolean {
    if (!this.listCtx) return false
    const m = matchListMarker(line)
    if (m) {
      if (m.marker === this.listCtx.marker) return true
      if (m.ordered && this.listCtx.ordered) return true
      return false
    }
    // 缩进行：开放块处于列表上下文时视为列表项内容延续
    if (/^\s/.test(line)) return true
    return false
  }
}

/**
 * 单趟模式（静态全文，供 DocumentLightView / ResultPanel / 压缩摘要共用）。
 * 与流式路径同一状态机，产出全闭合分段。
 */
export function segmentStatic(text: string): DisplaySegment[] {
  const seg = new StreamSegmenter()
  seg.push(text)
  seg.finalize()
  return seg.view()
}

/**
 * `<link>` 标签过滤（安全项：html:true 下模型输出里的杂散 link 标签会触发网络请求）。
 * 作用于全部内容（不随 reasoning 规范化收窄）；在块冻结时与开放块展示时各执行一次。
 */
export function filterLinkTags(text: string): string {
  return text.replace(/<link[^>]*>/gi, '')
}

/**
 * reasoning 内容的增量转义还原（仅思考内容——其原始用途；正文与代码原文直通）。
 * 部分模型在思考输出中发出字面转义序列（"\n" 两字符），此处还原为真实字符。
 * 增量实现：只规范化"安全前缀"，尾部可能构成转义序列开头的反斜杠串回持待下一拍，
 * 保证每拍代价 O(新增)（整文重规范化是 O(L²)）。
 */
export class IncrementalReasoningNormalizer {
  private normalized = ''
  private carry = ''

  /** 喂入新增 chunk；返回本拍新规范化出的后缀（可能为空） */
  push(chunk: string): string {
    if (!chunk) return ''
    const s = this.carry + chunk
    // 尾部反斜杠串可能是不完整转义序列的开头：整串回持
    const trailing = s.match(/\\+$/)
    const hold = trailing ? trailing[0].length : 0
    const safe = hold ? s.slice(0, -hold) : s
    this.carry = hold ? s.slice(-hold) : ''
    if (!safe) return ''
    const before = this.normalized.length
    this.normalized += applyEscapeRestoration(safe)
    return this.normalized.slice(before)
  }

  /** 结束冲刷（回持尾巴无后续，按原文并入） */
  flushTail(): string {
    if (!this.carry) return ''
    const tail = this.carry
    this.carry = ''
    const before = this.normalized.length
    this.normalized += applyEscapeRestoration(tail)
    return this.normalized.slice(before)
  }

  reset(): void {
    this.normalized = ''
    this.carry = ''
  }
}

/** 转义还原链（与旧管线 processThinkingContent 第 2 步语义一致；不含空行删除/trimEnd——那两类是渲染缺陷，已按规划移除） */
function applyEscapeRestoration(text: string): string {
  return text
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\r/g, '\r')
    .replace(/\\\\t/g, '\t')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\\\\\\\/g, '\\\\')
    .replace(/\\\\"/g, '"')
    .replace(/\\\\'/g, "'")
}

/**
 * reasoning 的 JSON 解包（整段缓冲判定）：{ 开头且完整解析成功的思考内容，
 * 提取 thinking/reasoning/thought/analysis 字段或合并全部字符串字段。
 * 返回 null 表示尚不能判定（继续缓冲）。
 */
export function tryUnwrapReasoningJson(text: string): { text: string } | null {
  const t = text.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  try {
    const data = JSON.parse(t)
    if (!data || typeof data !== 'object') return null
    const thinkingFields = ['thinking', 'reasoning', 'thought', 'analysis']
    for (const field of thinkingFields) {
      if (typeof data[field] === 'string' && data[field]) {
        return { text: data[field] }
      }
    }
    const textFields = Object.values(data).filter((v) => typeof v === 'string').join('\n')
    if (textFields) return { text: textFields }
    return null
  } catch {
    return null
  }
}
