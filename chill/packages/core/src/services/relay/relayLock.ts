/**
 * relayLock.ts — `~/.chill/relay.lock` 租约仲裁（M2，纯状态机）。
 *
 * 语义：先抢得者跑 relay 传输 + 心跳续约 + 过期接管——CLI/桌面谁先在线谁跑
 * （CLI-only 用户也能用手机功能，chill 架构铁律）。
 * 文件 I/O 全部依赖注入（RelayLockStore）；原子性由实现方保证
 * （壳侧可用 proper-lockfile 或 O_EXCL 语义实现；本层只做判定）。
 *
 * 接管三层判定（自愈收敛，与壳侧重试回路配合）：
 * - 心跳过期 → 接管（无需任何探活）；
 * - 心跳鲜活但持有方进程确定死亡（宿主注入 isOwnerAlive）→ 立即接管，不等租约过期；
 *   未注入/解析不明一律视为存活（宁等勿抢——抢错锁两端互踢的代价远大于多等一个租约）；
 * - 写后回读确认：跨进程"读-改-写"不互斥，两个等待者可能同时判定可接管，
 *   写后立即读回，owner≠己 = 竞态落败，按 held-by-other 处理（续约期 owner 易主检测兜底收敛）。
 */

export interface RelayLockState {
  /** 持有者标识（如 'cli:<pid>' / 'electron:<pid>'） */
  owner: string
  heartbeatAt: number
}

export interface RelayLockStore {
  read(): Promise<RelayLockState | null>
  write(state: RelayLockState): Promise<void>
  remove(): Promise<void>
}

/** 租约时长：心跳间隔建议 ≤ LEASE/3（壳侧定时器实现） */
export const RELAY_LOCK_LEASE_MS = 15_000
export const RELAY_LOCK_HEARTBEAT_MS = 5_000

/** 租约等待重试（10s → 30s 封顶，抖动 ±20%；纯函数，壳侧等待态重试循环用，仿 nextBackoffMs 先例） */
export function nextLeaseRetryMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 10_000 * 2 ** Math.max(0, attempt))
  const jitter = 0.8 + random() * 0.4
  return Math.round(base * jitter)
}

/** 宿主探活：ownerId → 持有方进程是否存活（壳侧注入，如解析 pid + process.kill(pid, 0)） */
export type IsOwnerAlive = (ownerId: string) => boolean

export type AcquireResult = 'acquired' | 'held-by-other'

export class RelayLockArbiter {
  private store: RelayLockStore
  private ownerId: string
  private now: () => number
  private isOwnerAlive: IsOwnerAlive | null

  constructor(store: RelayLockStore, ownerId: string, now: () => number = Date.now, isOwnerAlive?: IsOwnerAlive) {
    this.store = store
    this.ownerId = ownerId
    this.now = now
    this.isOwnerAlive = isOwnerAlive ?? null
  }

  /** 抢锁：无锁或锁已过期（心跳停 LEASE 以上）或锁主进程确定死亡 → 接管；他端持有且心跳鲜活 → held-by-other */
  async tryAcquire(): Promise<AcquireResult> {
    const cur = await this.store.read()
    if (cur && cur.owner !== this.ownerId && this.now() - cur.heartbeatAt < RELAY_LOCK_LEASE_MS) {
      // 心跳鲜活：仅当宿主探活确定锁主已死才立即接管；未注入探活一律视为存活
      const alive = this.isOwnerAlive ? this.isOwnerAlive(cur.owner) : true
      if (alive) return 'held-by-other'
    }
    await this.store.write({ owner: this.ownerId, heartbeatAt: this.now() })
    // 回读确认：竞态落败（他端在本端读判后也完成了写入）则按未获得处理
    const confirm = await this.store.read()
    if (!confirm || confirm.owner !== this.ownerId) return 'held-by-other'
    return 'acquired'
  }

  /** 续约：只能续自己的约；返回 false = 已被他端接管/锁丢失（调用方应停传输并退租） */
  async renew(): Promise<boolean> {
    const cur = await this.store.read()
    if (!cur || cur.owner !== this.ownerId) return false
    await this.store.write({ owner: this.ownerId, heartbeatAt: this.now() })
    return true
  }

  /** 退租：只删自己的锁（他端已接管时不误删） */
  async release(): Promise<void> {
    const cur = await this.store.read()
    if (cur && cur.owner === this.ownerId) await this.store.remove()
  }

  /** 当前持有者（提示文案用："配对确认将出现在当前在线的 chill 端"）；无锁/过期为 null */
  async currentHolder(): Promise<string | null> {
    const cur = await this.store.read()
    if (!cur) return null
    if (this.now() - cur.heartbeatAt >= RELAY_LOCK_LEASE_MS) return null
    return cur.owner
  }
}
