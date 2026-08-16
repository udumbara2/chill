import type { IKeyValueStore } from '@assistant-ai/core'

export class IPCKeyValueStore implements IKeyValueStore {
  getItem(key: string): string | null {
    return window.electronAPI.getKeyValue(key)
  }

  setItem(key: string, value: string): void {
    window.electronAPI.setKeyValue(key, value)
  }

  removeItem(key: string): void {
    window.electronAPI.removeKeyValue(key)
  }

  clear(): void {
    // clear 不需要实现，FileKeyValueStore 的 clear 不在 SelectedModelsService 中使用
  }
}
