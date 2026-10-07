import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DocumentSnapshot } from '../utils/tipTapDocumentSnapshot'

export interface PendingOperation {
  toolCallId: string
  toolName: string
  filePath: string
  resolvedPath: string
  operations: {
    type: 'insert' | 'delete' | 'replace' | 'create' | 'delete_file'
    from?: number
    to?: number
    plainTextFrom?: number
    plainTextTo?: number
    insertContent?: string
    deleteContent?: string
  }[]
  parameters: Record<string, any>
  timestamp: number
  snapshotPlainText?: string
  /** 标记该操作已预先执行，确认时跳过执行，拒绝时需回滚 */
  preApplied?: boolean
}

export const usePendingOperationsStore = defineStore('pendingOperations', () => {
  const operations = ref<PendingOperation[]>([])
  const documentSnapshots = ref<Map<string, DocumentSnapshot>>(new Map())

  const hasPendingOperations = computed(() => operations.value.length > 0)

  const pendingCount = computed(() => operations.value.length)

  const addOperation = (operation: PendingOperation) => {
    operations.value.push(operation)
  }

  const clearAll = () => {
    operations.value = []
    documentSnapshots.value.clear()
  }

  const getOperationsByFile = (filePath: string): PendingOperation[] => {
    return operations.value.filter(op => op.resolvedPath === filePath)
  }

  const setDocumentSnapshot = (filePath: string, snapshot: DocumentSnapshot) => {
    documentSnapshots.value.set(filePath, snapshot)
  }

  const getDocumentSnapshot = (filePath: string): DocumentSnapshot | undefined => {
    return documentSnapshots.value.get(filePath)
  }

  const clearDocumentSnapshot = (filePath: string) => {
    documentSnapshots.value.delete(filePath)
  }

  return {
    operations,
    documentSnapshots,
    hasPendingOperations,
    pendingCount,
    addOperation,
    clearAll,
    getOperationsByFile,
    setDocumentSnapshot,
    getDocumentSnapshot,
    clearDocumentSnapshot
  }
})
