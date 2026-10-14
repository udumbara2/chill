/**
 * relayNodeStores.ts — CLI 侧 relay 持久化适配：
 * - FileRelayLockStore / NodeDeviceStore / defaultDevicesPath：自 core 单源再导出
 *   （账本单源化 2026-10-12——NodeDeviceStore 下沉 core implementations/relayNodeRuntime.ts，
 *   daemon/electron main 经 RPC 薄适配复用同一实现；CLI 侧 import 零改动）
 * - makeSeenIdsStore / makePendingRoundsStore：CLI 本地文件适配（暂无第二消费者）
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export { FileRelayLockStore, NodeDeviceStore, defaultDevicesPath } from '@assistant-ai/core'

export function defaultRelayLockPath(userDataPath: string): string {
  return join(userDataPath, 'relay.lock')
}

export function defaultSeenIdsPath(userDataPath: string): string {
  return join(userDataPath, 'relay', 'seen-ids.json')
}

/** 已见信封 id 的文件持久化（桥去重的重启兜底） */
export function makeSeenIdsStore(userDataPath: string): {
  load: () => Promise<string[]>
  save: (ids: string[]) => Promise<void>
} {
  const p = defaultSeenIdsPath(userDataPath)
  return {
    load: async () => {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8'))
        return Array.isArray(raw) ? raw : []
      } catch {
        return []
      }
    },
    save: async (ids) => {
      mkdirSync(dirname(p), { recursive: true })
      const { tmp, final } = { tmp: p + '.tmp', final: p }
      writeFileSync(tmp, JSON.stringify(ids))
      renameSync(tmp, final)
    },
  }
}

export function defaultPendingRoundsPath(userDataPath: string): string {
  return join(userDataPath, 'relay', 'pending-rounds.json')
}

/**
 * 投递台账文件持久化（M7增量3·决策30/31，崩溃恢复唯一事实源）：
 * load 失败按空账处理；save 失败上抛（桥据此不 ACK——安全不对称）。
 */
export function makePendingRoundsStore(userDataPath: string): {
  load: () => Promise<unknown[]>
  save: (entries: unknown[]) => Promise<void>
} {
  const p = defaultPendingRoundsPath(userDataPath)
  return {
    load: async () => {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8'))
        return Array.isArray(raw) ? raw : []
      } catch {
        return []
      }
    },
    save: async (entries) => {
      mkdirSync(dirname(p), { recursive: true })
      const tmp = p + '.tmp'
      writeFileSync(tmp, JSON.stringify(entries))
      renameSync(tmp, p)
    },
  }
}
