import type { IDocumentSnapshot } from '../types/document'

/**
 * 位置计算成功结果：纯文本坐标（plainText*）与编辑器坐标（from/to）成对返回。
 * 编辑器坐标由宿主的位置计算器按自身文档模型解释（UI 的 TipTap、CLI 的行基模型、
 * electron 主进程 noop），core 不绑定具体编辑器实现（T7 字段泛化为编辑器无关命名）。
 */
export interface PositionResultSuccess {
  success: true
  plainTextFrom: number
  plainTextTo: number
  /** 编辑器坐标起点（宿主编器文档模型解释） */
  from: number
  /** 编辑器坐标终点 */
  to: number
  matchedText: string
}

export interface InsertPositionResultSuccess {
  success: true
  plainTextPos: number
  /** 编辑器坐标插入点（宿主编器文档模型解释） */
  pos: number
  matchedText: string
}

export interface CandidatePosition {
  index: number
  snippet: string
  suggested_context_before?: string
  suggested_context_after?: string
}

export interface PositionResultFailure {
  success: false
  error: string
  candidates?: CandidatePosition[]
}

export type PositionResult = PositionResultSuccess | PositionResultFailure

export type InsertPositionResult = InsertPositionResultSuccess | PositionResultFailure

export interface IPositionCalculator {
  getSnapshot(filePath: string): Promise<IDocumentSnapshot | null>

  calculateInsertPosition(
    snapshot: IDocumentSnapshot,
    anchor: string,
    position: 'before' | 'after'
  ): InsertPositionResult

  calculatePosition(
    snapshot: IDocumentSnapshot,
    oldContent: string,
    contextBefore?: string,
    contextAfter?: string
  ): Promise<PositionResult>
}
