import { matchTargetInText, matchAnchorInText } from '@assistant-ai/core'
import type { DocumentSnapshot } from './tipTapDocumentSnapshot'
import { plainTextIndexToTipTapPos } from './tipTapDocumentSnapshot'

/**
 * UI 位置计算（TipTap 壳）：文本匹配统一委托 core textMatcher 引擎（与 CLI 同一套语义：
 * L0 原文精确 → L1 行级容忍，唯一性内建，多匹配报错+candidates，无模糊层）；
 * 本模块只保留 plainText 偏移 → TipTap 文档位置的映射。
 */

export interface SnapshotPositionResultSuccess {
  success: true
  plainTextFrom: number
  plainTextTo: number
  from: number
  to: number
  matchedText: string
}

export interface CandidatePosition {
  index: number
  snippet: string
  suggested_context_before?: string
  suggested_context_after?: string
}

export interface SnapshotPositionResultFailure {
  success: false
  error: string
  candidates?: Array<CandidatePosition>
}

export type SnapshotPositionResult = SnapshotPositionResultSuccess | SnapshotPositionResultFailure

function mapMatchToTipTap(
  snapshot: DocumentSnapshot,
  plainTextFrom: number,
  plainTextTo: number
): SnapshotPositionResult {
  const tipTapFrom = plainTextIndexToTipTapPos(snapshot, plainTextFrom)
  const tipTapTo = plainTextIndexToTipTapPos(snapshot, plainTextTo)

  if (tipTapFrom === null || tipTapTo === null) {
    return {
      success: false,
      error: '无法映射到 TipTap 位置'
    }
  }

  return {
    success: true,
    plainTextFrom,
    plainTextTo,
    from: tipTapFrom,
    to: tipTapTo,
    matchedText: snapshot.plainText.slice(plainTextFrom, plainTextTo)
  }
}

export async function calculatePositionInSnapshotAsync(
  snapshot: DocumentSnapshot,
  targetText: string,
  contextBefore: string = '',
  contextAfter: string = ''
): Promise<SnapshotPositionResult> {
  return calculatePositionInSnapshot(snapshot, targetText, contextBefore, contextAfter)
}

export function calculatePositionInSnapshot(
  snapshot: DocumentSnapshot,
  targetText: string,
  contextBefore: string = '',
  contextAfter: string = ''
): SnapshotPositionResult {
  const result = matchTargetInText(snapshot.plainText, targetText, contextBefore, contextAfter)
  if (!result.success) return result
  return mapMatchToTipTap(snapshot, result.from, result.to)
}

export interface InsertPositionResultSuccess {
  success: true
  plainTextPos: number
  pos: number
  matchedText: string
}

export type InsertPositionResult = InsertPositionResultSuccess | SnapshotPositionResultFailure

export function calculateInsertPositionInSnapshot(
  snapshot: DocumentSnapshot,
  anchor: string,
  position: 'before' | 'after' = 'after'
): InsertPositionResult {
  const result = matchAnchorInText(snapshot.plainText, anchor, position)
  if (!result.success) return result

  const tipTapPos = plainTextIndexToTipTapPos(snapshot, result.pos)
  if (tipTapPos === null) {
    return {
      success: false,
      error: '无法映射到 TipTap 位置'
    }
  }

  return {
    success: true,
    plainTextPos: result.pos,
    pos: tipTapPos,
    matchedText: result.matchedText
  }
}
