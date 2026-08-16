import type { IConfirmationHandler, PendingOperation } from '@assistant-ai/core'

// 写边界模型后文件写不再暂存（圈内直通、圈外走 core 通用审批通道）；
// 本类仅保留 IConfirmationHandler 契约方法（快照缓存供编辑工具/autoApply 批次使用，
// pending 存储为接口契约保留——core 已不再产生文件写 pending op）。
export class CLIConfirmationHandler implements IConfirmationHandler {
  private pendingOps: Map<string, PendingOperation[]> = new Map()
  private snapshots: Map<string, any> = new Map()

  addPendingOperation(op: PendingOperation): void {
    const filePath = op.resolvedPath

    if (!this.pendingOps.has(filePath)) {
      this.pendingOps.set(filePath, [])
    }
    this.pendingOps.get(filePath)!.push(op)
  }

  getPendingOperations(filePath: string): PendingOperation[] {
    return this.pendingOps.get(filePath) || []
  }

  getDocumentSnapshot(filePath: string): any {
    return this.snapshots.get(filePath) || null
  }

  setDocumentSnapshot(filePath: string, snapshot: any): void {
    this.snapshots.set(filePath, snapshot)
  }

  clearAll(): void {
    this.pendingOps.clear()
    this.snapshots.clear()
  }
}
