/**
 * ask ↔ 看板条目联动桥(V3.2;决策 6/3)
 *
 * 联动(全部事件驱动,零轮询):
 * - 挂起:ASK_REQUESTED(带归因 itemId)→ 该条目置 blocked(reason=question 摘要);
 * - 落定:ASK_SETTLED → unblock 回 in_progress(ask 回答/「跳过」同路,决策 7a');
 * - 认领人死亡:死亡回流清 ask 钉在 SessionBoardService.settleByTaskId 源头(AskChannel.invalidateByItems);
 * - 无归因 ask(submit_plan 等):无 itemId → 本桥无操作(纯请示不挂板)。
 * AskCard/ApprovalCard 线形零改动(taskId/itemId 只是内部归因,不外显)。
 */

import { eventBus, EVENTS } from '../../utils/eventBus'
import { getAskChannel, type AskRequestPayload } from '../askChannel'
import { getSessionBoardService } from './SessionBoardService'
import type { BoardCaller } from './boardTypes'

/** 系统联动的结构化身份(挂起/解除经事件桥发生,不是某工位自称;归属约束在 boardCore 仍复核) */
const BRIDGE_CALLER: BoardCaller = { role: 'lead' }

/** question 摘要(block 的受阻原因;首行截 80 字,与看板 title 摘要同则) */
function questionDigest(question: string): string {
  const firstLine = (question ?? '').split('\n')[0]!.trim()
  if (!firstLine) return '等待回答'
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

/**
 * 订阅 ask 生命周期 → 看板联动。返回退订函数。
 * 已挂起的带归因 ask 在接线时补记(重连/迟接线不丢联动)。
 */
export function wireBoardAskBridge(): () => void {
  const svc = () => getSessionBoardService()
  const itemByAsk = new Map<string, { sessionId: string; itemId: string }>()

  // 接线补记:已挂起 ask 的联动键(其 blocked 状态应已在板上;此处只补反查表)
  for (const p of getAskChannel().listPending()) {
    if (p.id && p.itemId && p.sessionId) itemByAsk.set(p.id, { sessionId: p.sessionId, itemId: p.itemId })
  }

  const onRequested = (payload: AskRequestPayload): void => {
    if (!payload?.id || !payload.itemId || !payload.sessionId) return // 无归因 ask 不挂板
    itemByAsk.set(payload.id, { sessionId: payload.sessionId, itemId: payload.itemId })
    void svc()
      ?.block(payload.sessionId, payload.itemId, { reason: questionDigest(payload.question) }, BRIDGE_CALLER)
      .catch((err) => console.warn('【看板】ask 挂起联动 blocked 失败:', err))
  }

  const onSettled = (e: { id: string; answer: string; by: string }): void => {
    const ref = itemByAsk.get(e.id)
    if (!ref) return
    itemByAsk.delete(e.id)
    // 落定/跳过同路解除(决策 7a');条目已被死亡回流/撤单时 unblock 报 INVALID_STATE——静默吞掉
    void svc()
      ?.unblock(ref.sessionId, ref.itemId, BRIDGE_CALLER)
      .catch(() => {})
  }

  eventBus.on(EVENTS.ASK_REQUESTED, onRequested)
  eventBus.on(EVENTS.ASK_SETTLED, onSettled)
  return () => {
    eventBus.off(EVENTS.ASK_REQUESTED, onRequested)
    eventBus.off(EVENTS.ASK_SETTLED, onSettled)
  }
}
