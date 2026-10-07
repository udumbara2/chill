/**
 * idleEviction.ts —— 多会话宿主的闲置回收判定（M2.1，多会话并行规划）。
 *
 * 纯函数（Node-free；照 wsKeepalive/nextLeaseRetryMs 先例：判定归 core、计时器编排归壳）。
 * 输入 = 各引擎空闲快照 + 任务清单归因，输出 = 可回收会话 id 集（LRU 序，最旧在前）。
 *
 * 回收条件三重守卫（缺一不可——回收绝不杀活任务/在途轮/活跃会话）：
 * 非活跃 × 无在途轮 × 无本句柄 running 任务 × idle 超阈值。
 * 引擎数超上限时，从"已闲置但未到阈值"的会话中按 LRU 补选直至回到上限（软帽）。
 */

export interface EngineIdleSnapshot {
  sessionId: string
  isActive: boolean
  /** 引擎在途轮（getSessionState().isRunning 现读） */
  isRunning: boolean
  /** 本引擎句柄（engineHandle 归因）的 running 后台任务数 */
  runningTaskCount: number
  /** 闲置基线：最近一轮落定时刻；无轮次史（从未发言）用 openedAt（epoch ms） */
  idleSince: number
}

export interface IdleEvictionOptions {
  now: number
  /** 闲置阈值（ms；缺省 30min） */
  idleMs?: number
  /** 引擎数软帽（缺省 8） */
  maxEngines?: number
}

/** 缺省阈值：30 分钟无轮次且无任务且非活跃 */
export const IDLE_EVICTION_IDLE_MS = 30 * 60 * 1000
/** 缺省引擎数软帽 */
export const IDLE_EVICTION_MAX_ENGINES = 8

/**
 * 可回收判定：
 * 1. 三重守卫全过且 idle 超阈值 → 候选（LRU 序）；
 * 2. 引擎总数超软帽 → 从"守卫全过的未到期闲置"里按 LRU 补选直至回到帽内（候选耗尽即止）。
 */
export function pickEvictableSessions(
  snapshots: EngineIdleSnapshot[],
  opts: IdleEvictionOptions,
): string[] {
  const idleMs = opts.idleMs ?? IDLE_EVICTION_IDLE_MS
  const maxEngines = opts.maxEngines ?? IDLE_EVICTION_MAX_ENGINES
  /** 守卫全过（可回收的必要条件） */
  const guarded = snapshots.filter((s) => !s.isActive && !s.isRunning && s.runningTaskCount === 0)
  const byLru = (a: EngineIdleSnapshot, b: EngineIdleSnapshot): number => a.idleSince - b.idleSince
  const expired = guarded.filter((s) => opts.now - s.idleSince >= idleMs).sort(byLru)
  const result = expired.map((s) => s.sessionId)
  if (snapshots.length <= maxEngines) return result
  // 软帽补选：未到期闲置按 LRU 递补（活跃/在途/有任务的永不入内）
  const over = snapshots.length - maxEngines
  if (result.length >= over) return result
  const unexpired = guarded
    .filter((s) => opts.now - s.idleSince < idleMs)
    .sort(byLru)
    .slice(0, over - result.length)
    .map((s) => s.sessionId)
  return [...result, ...unexpired]
}
