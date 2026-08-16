import type {
  IPositionCalculator,
  IDocumentSnapshot,
  InsertPositionResult,
  PositionResult
} from '@assistant-ai/core'
import { eventBus, EVENTS } from '@assistant-ai/core'
import {
  calculateInsertPositionInSnapshot,
  calculatePositionInSnapshotAsync
} from '../utils/snapshotPositionCalculator'
import { createVirtualSnapshot } from '../utils/tipTapDocumentSnapshot'

export class TipTapPositionCalculator implements IPositionCalculator {
  async getSnapshot(filePath: string): Promise<IDocumentSnapshot | null> {
    return new Promise((resolve) => {
      let settled = false
      const done = (snapshot: IDocumentSnapshot | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(snapshot)
      }
      // 磁盘回退：真相源即文件本身。编辑器（WritingView）按需挂载，未挂载时无人应答
      // REQUEST_SNAPSHOT——不能让快照请求无限挂起（会造成工具调用卡死）
      const diskFallback = async () => {
        try {
          const resp = await window.electronAPI?.fileRead?.(filePath)
          if (resp?.success && typeof resp.content === 'string') {
            // 虚拟快照（plainText + 合成 mapping）：位置计算与 TipTap 映射均可工作；
            // 编辑器在挂载时走上面的快速通道（真实编辑器快照）
            done(createVirtualSnapshot(resp.content) as IDocumentSnapshot)
          } else {
            done(null)
          }
        } catch {
          done(null)
        }
      }
      const timer = setTimeout(() => void diskFallback(), 800)
      eventBus.emit(EVENTS.REQUEST_SNAPSHOT, {
        filePath,
        callback: (snapshot: any | null) => {
          if (!snapshot) {
            // 编辑器在挂载但给不出快照：同样回退磁盘，而不是直接判失败
            void diskFallback()
            return
          }
          // 【修复】保留完整的 snapshot（包含 mapping 字段），
          // 不能只提取 plainText，否则后续 calculatePosition 中
          // plainTextIndexToTipTapPos 访问 snapshot.mapping.find() 会报错
          done(snapshot as IDocumentSnapshot)
        }
      })
    })
  }

  calculateInsertPosition(
    snapshot: IDocumentSnapshot,
    anchor: string,
    position: 'before' | 'after'
  ): InsertPositionResult {
    const result = calculateInsertPositionInSnapshot(
      snapshot as any,
      anchor,
      position
    )
    return result as InsertPositionResult
  }

  async calculatePosition(
    snapshot: IDocumentSnapshot,
    oldContent: string,
    contextBefore?: string,
    contextAfter?: string
  ): Promise<PositionResult> {
    const result = await calculatePositionInSnapshotAsync(
      snapshot as any,
      oldContent,
      contextBefore,
      contextAfter
    )
    return result as PositionResult
  }
}
