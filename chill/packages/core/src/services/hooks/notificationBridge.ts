/**
 * eventBus → hooks 通知轨映射表（阶段 4）
 *
 * HookRunner 装配时（ChatEngine 构造）统一订阅本表：新增通知事件只改本表，无分散桥接代码。
 * 通知语义：并行 fire-and-forget、输出忽略（HookRunner 的 NOTIFY_EVENTS 轨道）。
 */

import { eventBus as globalEventBus, EVENTS } from '../../utils/eventBus'
import type { HookRunner } from './HookRunner'
import type { HookEvent } from './types'

interface BusLike {
  on(event: string, callback: (...args: any[]) => void): void
}

/** 一条映射：busEvent 触发 → 派发 hookEvent（matcher_value 固定子类型，matcher 与之精确相等） */
interface NotificationBridgeEntry {
  busEvent: string
  hookEvent: HookEvent
  matcherValue: string
  /** 'global' = 订阅全局 eventBus 单例（approvals.ts 的 APPROVAL_REQUESTED 只发在全局总线，与引擎实例 bus 无关） */
  bus?: 'global'
}

const NOTIFICATION_BRIDGE_MAP: readonly NotificationBridgeEntry[] = [
  // 审批请求 → Notification（桌面可接原生通知；goal 熔断请示的 Notification 由引擎直接派发，不经本表）
  { busEvent: EVENTS.APPROVAL_REQUESTED, hookEvent: 'Notification', matcherValue: 'approval', bus: 'global' },
  // goal 六事件 → GoalTransition（chill 特色事件）
  { busEvent: EVENTS.GOAL_STARTED, hookEvent: 'GoalTransition', matcherValue: 'started' },
  { busEvent: EVENTS.GOAL_ACHIEVED, hookEvent: 'GoalTransition', matcherValue: 'achieved' },
  { busEvent: EVENTS.GOAL_CLEARED, hookEvent: 'GoalTransition', matcherValue: 'cleared' },
  { busEvent: EVENTS.GOAL_PAUSED, hookEvent: 'GoalTransition', matcherValue: 'paused' },
  { busEvent: EVENTS.GOAL_RESUMED, hookEvent: 'GoalTransition', matcherValue: 'resumed' },
  { busEvent: EVENTS.GOAL_BUDGET_EXHAUSTED, hookEvent: 'GoalTransition', matcherValue: 'budget_exhausted' },
]

/** 已接线的 runner → 会话上下文闭包（幂等：同 runner 重复接线只更新闭包、不重复订阅——
 *  多引擎实例共享同一 runner 时，通知载荷的 sessionId/cwd 始终取自最新引擎） */
const attachedRunners = new WeakMap<HookRunner, { contextProvider: () => { sessionId: string; cwd: string } }>()

/**
 * 按映射表统一订阅 eventBus（引擎构造时调用）。
 * busEvent 载荷原样放入 stdin 的 payload 字段；会话上下文（sessionId/cwd）由闭包现读。
 */
export function attachHookNotificationBridge(
  runner: HookRunner,
  engineBus: BusLike,
  contextProvider: () => { sessionId: string; cwd: string }
): void {
  const existing = attachedRunners.get(runner)
  if (existing) {
    existing.contextProvider = contextProvider
    return
  }
  attachedRunners.set(runner, { contextProvider })
  const record = attachedRunners.get(runner)!
  for (const entry of NOTIFICATION_BRIDGE_MAP) {
    const bus: BusLike = entry.bus === 'global' ? globalEventBus : engineBus
    bus.on(entry.busEvent, (payload: unknown) => {
      const ctx = record.contextProvider()
      // fire-and-forget：通知轨输出忽略，故障静默（HookRunner 内部已 fail-open，此处双保险）
      void runner
        .dispatch(entry.hookEvent, {
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          matcherValue: entry.matcherValue,
          extra: { payload },
        })
        .catch(() => {})
    })
  }
}
