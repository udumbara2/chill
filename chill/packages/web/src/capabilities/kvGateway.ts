/**
 * 能力网关：KeyValueStore（M1.5 四件套之一）
 *
 * core FileKeyValueStore 单实例（~/.chill/state.json，与 CLI/UI 共享同一文件）；
 * 客户端同步语义经「连接时快照推送 + 写穿广播」实现：
 * - kv:snapshot 事件（连接即推全量）——ws-host 本地缓存支撑渲染层同步 getItem；
 * - kv:changed 事件（任一端写入广播全连接）——多标签一致性。
 */
import { FileKeyValueStore } from '@assistant-ai/core'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export class KvGateway {
  private store: FileKeyValueStore
  private statePath: string
  private listeners = new Set<(n: string, d: unknown) => void>()

  constructor(userDataPath: string) {
    this.statePath = join(userDataPath, 'state.json')
    // 自愈：空文件/非法 JSON（崩溃残留的 0 字节写）时重置为空对象再构造
    // （core FileKeyValueStore 的 load 对空文件抛 SyntaxError——daemon 是宿主，承担修复职责）
    try {
      if (existsSync(this.statePath) && statSync(this.statePath).size === 0) {
        writeFileSync(this.statePath, '{}', 'utf-8')
      } else if (existsSync(this.statePath)) {
        JSON.parse(readFileSync(this.statePath, 'utf-8'))
      }
    } catch {
      try { writeFileSync(this.statePath, '{}', 'utf-8') } catch { /* 无盘可写时让构造器报真错 */ }
    }
    this.store = new FileKeyValueStore(this.statePath)
  }

  onEvent(cb: (n: string, d: unknown) => void): void {
    this.listeners.add(cb)
  }

  private emit(n: string, d: unknown): void {
    for (const cb of this.listeners) {
      try { cb(n, d) } catch { /* 监听器异常不影响主流程 */ }
    }
  }

  /** 连接建立时调用：推送全量快照（ws-host 以此支撑渲染层同步 getItem） */
  pushSnapshot(): void {
    this.emit('kv:snapshot', this.snapshot())
  }

  snapshot(): Record<string, string> {
    try {
      if (!existsSync(this.statePath)) return {}
      return JSON.parse(readFileSync(this.statePath, 'utf-8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  getItem(key: string): string | null {
    return this.store.getItem(key)
  }

  setItem(key: string, value: string): void {
    this.store.setItem(key, value)
    this.emit('kv:changed', { key, value })
  }

  removeItem(key: string): void {
    this.store.removeItem(key)
    this.emit('kv:changed', { key, value: null })
  }
}
