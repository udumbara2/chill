import type { IConfirmationHandler, PendingOperation } from '@assistant-ai/core'
import { usePendingOperationsStore } from '../stores/pendingOperationsStore'

export class PiniaConfirmationHandler implements IConfirmationHandler {
  addPendingOperation(op: PendingOperation): void {
    const store = usePendingOperationsStore()
    store.addOperation(op as any)
  }

  getPendingOperations(filePath: string): PendingOperation[] {
    const store = usePendingOperationsStore()
    return store.getOperationsByFile(filePath) as PendingOperation[]
  }

  getDocumentSnapshot(filePath: string): any {
    const store = usePendingOperationsStore()
    return store.getDocumentSnapshot(filePath)
  }

  setDocumentSnapshot(filePath: string, snapshot: any): void {
    const store = usePendingOperationsStore()
    store.setDocumentSnapshot(filePath, snapshot)
  }

  clearAll(): void {
    const store = usePendingOperationsStore()
    store.clearAll()
  }
}
