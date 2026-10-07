export interface PendingOperation {
  toolCallId: string
  toolName: string
  filePath: string
  resolvedPath: string
  operations: Array<{
    type: string
    from?: number
    to?: number
    insertContent?: string
    [key: string]: any
  }>
  parameters: Record<string, any>
  timestamp: number
  snapshotPlainText?: string
  /** 标记该操作已预先执行（如 create_file 已先写入磁盘），确认时跳过执行，拒绝时需回滚 */
  preApplied?: boolean
}

export interface IConfirmationHandler {
  addPendingOperation(op: PendingOperation): void
  getPendingOperations(filePath: string): PendingOperation[]
  getDocumentSnapshot(filePath: string): any
  setDocumentSnapshot(filePath: string, snapshot: any): void
  clearAll(): void
}
