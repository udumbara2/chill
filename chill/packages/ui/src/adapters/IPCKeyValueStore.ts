import type { IKeyValueStore } from '@assistant-ai/core'
import { getHostAPI } from '../host/hostApi'

export class IPCKeyValueStore implements IKeyValueStore {
  getItem(key: string): string | null {
    return getHostAPI().getKeyValue(key)
  }

  setItem(key: string, value: string): void {
    getHostAPI().setKeyValue(key, value)
  }

  removeItem(key: string): void {
    getHostAPI().removeKeyValue(key)
  }

  clear(): void {
    // clear 不需要实现，FileKeyValueStore 的 clear 不在 SelectedModelsService 中使用
  }
}
