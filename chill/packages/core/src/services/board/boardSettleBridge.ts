/**
 * settle 桥(V1.5→V3):任务 settle → 会话看板(boardCore.onTaskSettle)的单点挂接。
 *
 * 纪律:只转调 SessionBoardService.settleByTaskId(claimedByTaskId 数据匹配,零启发式);
 *   team 半边(roster)不在此处——delegation 的 settle 咽喉先后调 syncTeamRosterOnSettle/直调
 *   syncOnTaskSettle(取消路径)与本桥,team 运行时语义一字不动(V4 才收编)。
 * 死亡回流的 ask 清尾钉在 SessionBoardService.settleByTaskId 源头(任何调用路径都生效)。
 */

import { getSessionBoardService } from './SessionBoardService'
import type { BoardSettleOutcome } from './boardTypes'

export interface SettleBridgeResult {
  settledIds: string[]
  reflowedIds: string[]
  frozenIds: string[]
}

/**
 * 任务 settle 的看板半边:completed=自动结项(result 标注自动结项)、failed|cancelled=死亡回流。
 * 未装配服务/未登记任务=无操作(不隐式建板)。返回影响面供拉活识别;Promise 供咽喉 await。
 */
export function boardSettleBridge(
  taskId: string,
  outcome: BoardSettleOutcome,
  opts?: { result?: string },
): Promise<SettleBridgeResult> {
  const svc = getSessionBoardService()
  if (!svc) return Promise.resolve({ settledIds: [], reflowedIds: [], frozenIds: [] })
  return svc.settleByTaskId(taskId, outcome, opts).catch((err) => {
    console.warn(`【看板】settle 桥回写失败(taskId=${taskId}):`, err)
    return { settledIds: [], reflowedIds: [], frozenIds: [] }
  })
}
