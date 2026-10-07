import * as fs from 'fs'
import {
  matchTargetInText,
  matchAnchorInText
} from '@assistant-ai/core'
import type {
  IPositionCalculator,
  IDocumentSnapshot,
  InsertPositionResult,
  PositionResult
} from '@assistant-ai/core'

/**
 * CLI 位置计算器：磁盘直读 + 统一文本匹配引擎（core textMatcher）。
 * 匹配语义与 UI 完全一致：L0 原文精确 → L1 行级容忍（CRLF/行尾空格/缩进起始免疫），
 * 多匹配报错+candidates（不再静默取第一），无模糊层。
 */
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
    const result = matchAnchorInText(snapshot.plainText, anchor, position)
    if (!result.success) return result
    return {
      success: true,
      plainTextPos: result.pos,
      pos: result.pos,
      matchedText: result.matchedText
    }
  }

  async calculatePosition(
    snapshot: IDocumentSnapshot,
    oldContent: string,
    contextBefore?: string,
    contextAfter?: string
  ): Promise<PositionResult> {
    const result = matchTargetInText(snapshot.plainText, oldContent, contextBefore, contextAfter)
    if (!result.success) return result
    return {
      success: true,
      plainTextFrom: result.from,
      plainTextTo: result.to,
      from: result.from,
      to: result.to,
      matchedText: result.matchedText
    }
  }
}
