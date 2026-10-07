import type { DocumentSnapshot } from './tipTapDocumentSnapshot'
import type { usePendingOperationsStore } from '../stores/pendingOperationsStore'

export function safeGenerateSnapshot(
  filePath: string,
  getSnapshot: () => DocumentSnapshot | null,
  pendingStore: ReturnType<typeof usePendingOperationsStore>
): DocumentSnapshot | null {
  const cachedSnapshot = pendingStore.getDocumentSnapshot(filePath)
  if (cachedSnapshot) {
    return cachedSnapshot
  }

  const snapshot = getSnapshot()
  if (!snapshot) {
    return null
  }

  pendingStore.setDocumentSnapshot(filePath, snapshot)
  return snapshot
}
