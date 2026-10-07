/**
 * relayNodeStores.ts — CLI 侧 relay 持久化适配：
 * - FileRelayLockStore：~/.chill/relay.lock（JSON 单行；单用户场景的原子性够用——
 *   写走 tmp+rename，读失败视为无锁；竞态窗口由租约心跳语义兜底，最坏=两端都跑，消息幂等去重）
 * - NodeDeviceStore：~/.chill/relay/devices.json（配对记录）
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { RelayLockStore, RelayLockState, DeviceStore, PairedDevice } from '@assistant-ai/core'

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value), 'utf8')
  renameSync(tmp, filePath)
}

export class FileRelayLockStore implements RelayLockStore {
  constructor(private filePath: string) {}

  async read(): Promise<RelayLockState | null> {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as RelayLockState
      if (typeof raw.owner !== 'string' || typeof raw.heartbeatAt !== 'number') return null
      return raw
    } catch {
      return null
    }
  }

  async write(state: RelayLockState): Promise<void> {
    atomicWriteJson(this.filePath, state)
  }

  async remove(): Promise<void> {
    try {
      unlinkSync(this.filePath)
    } catch {
      /* 不存在即目标态 */
    }
  }
}

export class NodeDeviceStore implements DeviceStore {
  constructor(private filePath: string) {}

  async read(): Promise<PairedDevice[]> {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  async write(devices: PairedDevice[]): Promise<void> {
    atomicWriteJson(this.filePath, devices)
  }
}

export function defaultRelayLockPath(userDataPath: string): string {
  return join(userDataPath, 'relay.lock')
}

export function defaultDevicesPath(userDataPath: string): string {
  return join(userDataPath, 'relay', 'devices.json')
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

export function relayStateExists(userDataPath: string): boolean {
  return existsSync(defaultDevicesPath(userDataPath))
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
