/**
 * workPlanMirror.ts — 主会话任务清单镜像的纯逻辑（纯函数、Node-free、零 I/O）。
 *
 * 镜像容器为按事件 sessionId 分键的普通 Map（状态归调用方持有——wiring 层装配即常驻）；
 * 事件应用规则（迭代 0 钉死）：
 * - 来源过滤黑名单制：拒 'subagent'（ApprovalOrigin['source'] 全集中唯一 worker 类来源——
 *   其事件带宿主 sessionId，整表覆盖会污染主清单）；其余全收——undefined=旧发射方/缺归因、
 *   'main'=主会话、'mobile'=手机发起轮次的主引擎调用（buildCallOrigin），后三者都是主清单合法写入
 *   （与壳侧消费方过滤同规）；
 * - TASK_LIST_CREATED 整表替换（唯一建条目点）；STATUS_UPDATED 按 id 更新（未知 id 跳过）、
 *   DELETED 过滤、ADDED 追加——后三者对空镜像一律不建条目
 *   （中途启动边界：精确自愈条件=下一次 create_task_list，诚实空态绝不错误显示）。
 */
import type { TaskItem, TaskStatus } from '../../types/models'
import type { ApprovalOrigin } from '../approvals'

/** 会话分键清单镜像（键=事件 sessionId，值=该会话主清单的只读副本） */
export type WorkPlanMirror = Map<string, TaskItem[]>

/** 来源过滤统一规则（黑名单制，与壳侧 taskListStore/cli 消费方同规）：拒 'subagent'，其余（undefined/'main'/'mobile'）收 */
export function acceptTaskEventSource(source: ApprovalOrigin['source'] | undefined): boolean {
  return source !== 'subagent'
}

/** TASK_LIST_CREATED：整表替换（唯一建条目点；返回恒 true=镜像已变更） */
export function mirrorTaskListCreated(mirror: WorkPlanMirror, sessionId: string, tasks: TaskItem[]): boolean {
  mirror.set(sessionId, tasks.map((t) => ({ ...t })))
  return true
}

/** TASK_STATUS_UPDATED：按 id 更新（未知 id/空镜像跳过不建条目）；返回是否实际变更 */
export function mirrorTaskStatusUpdated(
  mirror: WorkPlanMirror,
  sessionId: string,
  taskId: string,
  status: TaskStatus,
  content?: string,
  result?: string,
): boolean {
  const list = mirror.get(sessionId)
  if (!list) return false
  const item = list.find((t) => t.id === taskId)
  if (!item) return false
  item.status = status
  item.updatedAt = new Date()
  if (content !== undefined) item.content = content
  if (result !== undefined) item.result = result
  return true
}

/** TASK_DELETED：按 id 过滤（空镜像/未知 id 跳过不建条目）；返回是否实际变更 */
export function mirrorTaskDeleted(mirror: WorkPlanMirror, sessionId: string, taskId: string): boolean {
  const list = mirror.get(sessionId)
  if (!list) return false
  const next = list.filter((t) => t.id !== taskId)
  if (next.length === list.length) return false
  mirror.set(sessionId, next)
  return true
}

/**
 * TASK_ADDED：追加（空镜像不建条目——精确自愈条件=下一次 create_task_list）；返回是否实际变更。
 * 批次清扫（横条批次化迭代）：镜像清单已 settled（非空且全部 completed——failed 不算，
 * 失败警示不被新批冲掉）时，本次 add 开新批次——旧批整表翻篇（替换为 [新任务]；
 * 不可删镜像键再走追加：会撞上方空镜像保护把新任务吞掉）。界限=确定事实
 * （settled 状态 + 结构性事件），非时间戳推断；create_task_list 整表替换天然新批不经此函数。
 */
export function mirrorTaskAdded(mirror: WorkPlanMirror, sessionId: string, task: TaskItem): boolean {
  const list = mirror.get(sessionId)
  if (!list) return false
  if (list.length > 0 && list.every((t) => t.status === 'completed')) {
    mirror.set(sessionId, [{ ...task }])
    return true
  }
  list.push({ ...task })
  return true
}

/**
 * workplan.sync 对账（照 board 先例）：手机 rev 一致 → 'ack' 纯确认（items 空）；
 * 落后/未知/缺省 → 'full' 全量树。core 重启 rev 归零 → 手机对账不上自动回全量，无脏态残留。
 */
export function decideWorkPlanSync(currentRev: number, knownRev: string | number | null | undefined): 'ack' | 'full' {
  if (knownRev === undefined || knownRev === null) return 'full'
  return String(knownRev) === String(currentRev) ? 'ack' : 'full'
}
