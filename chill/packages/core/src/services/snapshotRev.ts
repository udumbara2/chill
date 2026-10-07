/**
 * snapshotRev.ts — 快照同步通道 rev 纪元安全 SSOT（纯函数、Node-free）。
 *
 * 背景（2026-10-07 事故根治）：board rev 曾为小计数器、仅存于可损坏/可丢失的板文件——
 * 文件损坏时 ensureBoard 静默重开新板 revision:0，手机端 LWW（incoming < known 即丢弃）
 * 从此永久拒收该会话全部看板推送（无自愈、无日志）。workplan 于 2026-10-04 已改时间基
 * 根治同款病（relayEngineWiring bump 注释），本模块把同一纪律收敛为单一事实点。
 *
 * 纪律（AGENTS.md「快照同步 rev 纪律」）：
 * - 快照通道 rev 一律时间基：**纪元边界**（新建/加载）经 migrateSnapshotRev 落地；
 *   纪元内 +1 即可（不查钟——纪元中段墙钟回拨对 +1 无影响，同毫秒多变更仍严格递增）；
 * - **对账采纳**：应答 sync 时手机上报 knownRev 高于本端（跨纪元/跨进程丢更新）→
 *   本端抬到 adoptSnapshotRev(knownRev) 再答——只会抬不会降，内容仍为本端真相。
 */

/** 毫秒纪元下限：低于它=旧小计数纪元（任何真实 Date.now() 恒大于此值，判据跨版本稳定） */
export const MS_EPOCH_FLOOR = 1e11

/** 纪元内/采纳时的下一跳：max(当前时刻, prev+1)——时间基起步 + 严格递增双保险 */
export function nextSnapshotRev(prev: number): number {
  return Math.max(Date.now(), prev + 1)
}

/** 纪元迁移：旧小计数 → 当前时刻；已是时间基原样保留（幂等，二次调用零变化） */
export function migrateSnapshotRev(loaded: number): number {
  return loaded >= MS_EPOCH_FLOOR ? loaded : Date.now()
}

/** 对账采纳目标值：至少高于手机上报值一线（max(now, known+1)） */
export function adoptSnapshotRev(knownRev: number): number {
  return nextSnapshotRev(knownRev)
}
