/**
 * boundedLineReader —— 以行语义消费外部文件的唯一安全形态。
 *
 * 背景（2026-10-04 serve 宿主无声死亡根治）：node:readline 的 kLine_buffer 无上限，
 * 文件中出现一行超过 V8 字符串上限（2^29-24 ≈ 536M 字符）时，_normalWrite 在
 * 'data' 事件上下文里直接抛 RangeError: Invalid string length——事件处理器内的
 * 异常无法被任何调用方捕获，整个进程当场死亡（生产实测 serve 崩溃，本地以
 * 640MB 单行文件复现出逐字节一致的栈）。2026-09-15 埋的 stdin-watch-debug 盯错
 * 了流（真凶是文件流不是 stdin），零命中，已随之退役。
 *
 * 职责：固定容量滚动缓冲逐行产出（内存 O(maxLineChars)，与文件总大小无关），
 * 超长行截断并如实标注 originalLength / truncated——任何病态文件形状最多损失
 * 该行尾部内容，永远不可能杀死宿主进程。行终结语义与 readline 的
 * crlfDelay:Infinity 对齐（\n / \r\n / 孤立 \r 均计一个终结符）。
 *
 * 约定：凡是"用行语义读取外部文件"，一律走这里；严禁再 readline.createInterface
 * 裸读文件流（AGENTS.md《文件行读取约定》）。
 */

/** 单行字符上限：合法单行的宽裕天花板（minified 产物级），超出按病态行截断 */
export const MAX_LINE_CHARS = 8 * 1024 * 1024

export interface BoundedLine {
  /** 行内容；truncated=true 时为前 maxLineChars 字符 */
  text: string
  /** 该行真实字符数（截断前口径） */
  originalLength: number
  truncated: boolean
}

/** 接受字符串块（流侧已按 encoding 解码）或字节块（本读取器负责跨块多字节安全解码） */
export type LineChunk = string | Uint8Array

export async function* readLinesBounded(
  chunks: AsyncIterable<LineChunk>,
  maxLineChars: number = MAX_LINE_CHARS,
): AsyncGenerator<BoundedLine> {
  const decoder = new TextDecoder('utf-8')
  let line = '' // 当前未完结行（长度恒 ≤ maxLineChars）
  let runLength = 0 // 当前行已累计字符数（截断前口径）

  const appendSegment = (seg: string): void => {
    runLength += seg.length
    if (line.length >= maxLineChars) return // 已到顶：只计数不累积（内存恒定的关键）
    const room = maxLineChars - line.length
    line += seg.length > room ? seg.slice(0, room) : seg
  }

  const emit = (): BoundedLine => {
    // truncated 按"已见字符数 > 保留字符数"自洽推导——不依赖累积路径的标志位，任何路径不漏置
    const out: BoundedLine = { text: line, originalLength: runLength, truncated: line.length < runLength }
    line = ''
    runLength = 0
    return out
  }

  for await (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let segStart = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code === 10 /* \n */ || code === 13 /* \r */) {
        appendSegment(text.slice(segStart, i))
        yield emit()
        // \r\n 计一个终结符：\r 后紧跟的 \n 跳过
        if (code === 13 && text.charCodeAt(i + 1) === 10) i++
        segStart = i + 1
      }
    }
    if (segStart < text.length) appendSegment(text.slice(segStart))
  }
  // 冲刷多字节解码残余（字节块路径）+ 末行（文件不以换行结尾时）
  const tail = decoder.decode()
  if (tail) appendSegment(tail)
  if (line.length > 0 || runLength > 0) yield emit()
}
