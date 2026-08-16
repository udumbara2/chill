import * as fs from 'fs'
import type {
  IPositionCalculator,
  IDocumentSnapshot,
  InsertPositionResult,
  PositionResult,
  CandidatePosition
} from '@assistant-ai/core'

export class LineBasedPositionCalculator implements IPositionCalculator {
  async getSnapshot(filePath: string): Promise<IDocumentSnapshot | null> {
    try {
      if (!fs.existsSync(filePath)) {
        return null
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      return { plainText: content }
    } catch {
      return null
    }
  }

  calculateInsertPosition(
    snapshot: IDocumentSnapshot,
    anchor: string,
    position: 'before' | 'after'
  ): InsertPositionResult {
    const text = snapshot.plainText

    // 收集所有匹配位置
    const matches: number[] = []
    let searchFrom = 0
    let idx = text.indexOf(anchor, searchFrom)
    while (idx !== -1) {
      matches.push(idx)
      searchFrom = idx + anchor.length
      idx = text.indexOf(anchor, searchFrom)
    }

    if (matches.length === 0) {
      return {
        success: false,
        error: `未找到锚点文本: "${anchor}"`,
        candidates: this.findCandidates(text, anchor)
      }
    }

    if (matches.length > 1) {
      return {
        success: false,
        error: `找到 ${matches.length} 个匹配位置，请补充更精确的上下文`,
        candidates: matches.slice(0, 5).map((index) => ({
          index,
          snippet: text.slice(Math.max(0, index - 20), Math.min(text.length, index + anchor.length + 20)),
          suggested_context_before: text.slice(Math.max(0, index - 30), index),
          suggested_context_after: text.slice(index + anchor.length, Math.min(text.length, index + anchor.length + 30))
        }))
      }
    }

    const index = matches[0]
    let pos: number

    if (position === 'after') {
      pos = index + anchor.length
      // 跳过锚点行末尾的换行符，使插入位置在下一行开头
      while (pos < text.length && (text[pos] === '\r' || text[pos] === '\n')) {
        pos++
      }
    } else {
      pos = index
      // 回退到锚点所在行的行首
      while (pos > 0 && text[pos - 1] !== '\n' && text[pos - 1] !== '\r') {
        pos--
      }
    }

    return {
      success: true,
      plainTextPos: pos,
      pos: pos,
      matchedText: anchor
    }
  }

  async calculatePosition(
    snapshot: IDocumentSnapshot,
    oldContent: string,
    contextBefore?: string,
    contextAfter?: string
  ): Promise<PositionResult> {
    const text = snapshot.plainText

    if (contextBefore && contextAfter) {
      const searchTarget = contextBefore + oldContent + contextAfter
      const index = text.indexOf(searchTarget)
      if (index !== -1) {
        const from = index + contextBefore.length
        const to = from + oldContent.length
        return {
          success: true,
          plainTextFrom: from,
          plainTextTo: to,
          from: from,
          to: to,
          matchedText: text.slice(from, to)
        }
      }
    }

    if (contextBefore) {
      const searchTarget = contextBefore + oldContent
      const index = text.indexOf(searchTarget)
      if (index !== -1) {
        const from = index + contextBefore.length
        const to = from + oldContent.length
        return {
          success: true,
          plainTextFrom: from,
          plainTextTo: to,
          from: from,
          to: to,
          matchedText: text.slice(from, to)
        }
      }
    }

    if (contextAfter) {
      const searchTarget = oldContent + contextAfter
      const index = text.indexOf(searchTarget)
      if (index !== -1) {
        const from = index
        const to = from + oldContent.length
        return {
          success: true,
          plainTextFrom: from,
          plainTextTo: to,
          from: from,
          to: to,
          matchedText: text.slice(from, to)
        }
      }
    }

    const index = text.indexOf(oldContent)
    if (index !== -1) {
      const to = index + oldContent.length
      return {
        success: true,
        plainTextFrom: index,
        plainTextTo: to,
        from: index,
        to: to,
        matchedText: oldContent
      }
    }

    return {
      success: false,
      error: `未找到文本: "${oldContent.slice(0, 50)}${oldContent.length > 50 ? '...' : ''}"`,
      candidates: this.findCandidates(text, oldContent)
    }
  }

  private findCandidates(text: string, target: string, maxResults: number = 5): CandidatePosition[] {
    const results: CandidatePosition[] = []

    let pos = 0
    while (pos < text.length && results.length < maxResults) {
      pos = text.indexOf(target[0], pos)
      if (pos === -1) break

      const snippetStart = Math.max(0, pos - 20)
      const snippetEnd = Math.min(text.length, pos + target.length + 20)
      const snippet = text.slice(snippetStart, snippetEnd)

      if (!results.some(r => r.index === pos)) {
        results.push({
          index: pos,
          snippet,
          suggested_context_before: text.slice(Math.max(0, pos - 20), pos),
          suggested_context_after: text.slice(pos, Math.min(text.length, pos + 20))
        })
      }

      pos++
    }

    return results
  }
}
