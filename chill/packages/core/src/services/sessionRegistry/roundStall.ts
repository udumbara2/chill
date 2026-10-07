/**
 * roundStall.ts —— 轮次停滞判定（F-3，迭代 F：生产缺陷修复）。
 *
 * 纯函数（Node-free；照 wsKeepalive/idleEviction 先例：判定归 core、编排归壳）。
 * 输入 = 各引擎轮次活动快照（isRunning + lastActivityAt——任何带归因的进展事件刷新），
 * 输出 = 停滞会话 id 集。
 *
 * 选层论据（传输层超时兜不住的反证）：模型调用走全局 fetch（undici bodyTimeout 默认 300s），
 * 静默断流本应自灭；生产实测 25+ 分钟挂死 ⇒ 心跳滴漏型停滞（服务商持续发 SSE keepalive
 * 字节重置超时但零内容）——传输超时原理上抓不住，只有内容级进展观能。
 *
 * 判定刻意保守：只在 isRunning 且零任何进展超阈值时报；非流式长生成/异步任务轮询静默期
 * 可能误报——调用方只告警不自动杀（误伤代价 > 一次告警；中止权归操作者，F-2 保证可行使）。
 */

export interface RoundActivitySnapshot {
  sessionId: string
  isRunning: boolean
  /** 最近一次进展时刻（epoch ms）：TURN_STREAM_CHUNK / TOOL_CALL_STATUS_CHANGED / ASSISTANT_MESSAGE_CREATED / TURN_SETTLED / 引擎开启 */
  lastActivityAt: number
}

export interface RoundStallOptions {
  now: number
  /** 停滞阈值（ms；缺省 10min） */
  stallMs?: number
}

/** 缺省阈值：10 分钟零任何进展 */
export const ROUND_STALL_MS = 10 * 60 * 1000

/** 停滞集：isRunning ∧ now - lastActivityAt ≥ 阈值 */
export function pickStalledRounds(snapshots: RoundActivitySnapshot[], opts: RoundStallOptions): string[] {
  const stallMs = opts.stallMs ?? ROUND_STALL_MS
  return snapshots
    .filter((s) => s.isRunning && opts.now - s.lastActivityAt >= stallMs)
    .map((s) => s.sessionId)
}
