/**
 * workPlanTree.ts — 工作计划树投影 SSOT（纯函数、Node-free、零 I/O；照 buildRuntimeProjection 先例）。
 *
 * v4（长条落定常驻迭代，2026-10-06 规划三审全 PASS）：规则⑦从"批结清时间窗退场"重构为"保留界 1"——
 * 手机端 settled 6s 自动收摊已删（配套的定格窗口失去存在理由），已结清批不再因时间流逝退场：
 * ①-⑥ 保持 v2 语义不变（有链嵌套/无链根层/断链孤儿提升/父项自动结项派生/行序稳定/needsYou 窄判定）；
 * ⑦ 保留界 1（替代 v3 批结清定格退场；与 PROTOCOL-FROZEN.md 树合并规则⑥同一条规则）：
 *   a. 无链（含断链提升③）看板根行按 batchId 分组；无 batchId 行自成单行批（key=行 id——单独派活
 *      一单一批的自然退化，零特例分支）；
 *   b. 未结清批（任一行非终态）全部投影（终态行=批内进度展示；失败回流行拖住整批，与清单侧
 *      "failed 不算 settled"对齐——整轮完成才让位）；
 *   c. 已结清批（全部 completed/cancelled）的保留条件：**无活跃批时保留最近一代**（settledAt=批内最晚
 *      updatedAt 最大者；平局按组键字典序取首——纯结构判定不依赖输入行序，跨推送稳定）；
 *      **存在任一未结清批（新任务发起）时已结清批全部立即让位**（顶掉即刻发生，不等新批结清——
 *      长条焦点无歧义地切到新任务，旧完成态不残留）；
 *   d. 让位触发=结构事件（新批出现或新代结清，与清单侧"结构事件翻篇"语义对称统一）；
 *      树规模恒有界（每会话 ≤1 已结清代 + 活跃批 + 清单项）。
 *      有链行与清单镜像侧零改动（全态投影 / settled 翻篇照旧）。
 * 零时间注入：无 now/grace 参数，同输入恒同树（测试无需 mock 时钟）；旧 v3 的时间窗机制
 * （WORK_PLAN_SETTLE_GRACE_MS/settleDismissalAt/BuildWorkPlanTreeOpts）已全部退役。
 */
import type { TaskItem } from '../../types/models'
import type { BoardItem, BoardItemStatus } from '../board/boardTypes'
import { boardRowNeedsUserDecision } from '../board/boardProjection'
import type { WorkPlanItemWire } from '../relay/envelope'

export interface BuildWorkPlanTreeInput {
  /** wiring 层主会话清单镜像（迭代 0 数据源） */
  mirrorTasks: TaskItem[]
  /** 看板行（会话轻量板 ∪ 归属该会话的活动团队板；缺省=无看板，退化为迭代 0 平铺） */
  boardItems?: BoardItem[]
}

/** 看板行六态 → 树项五态（blocked/failed 同映 failed，相位差异由行级 needsYou 区分） */
const BOARD_STATUS_TO_WIRE: Record<BoardItemStatus, WorkPlanItemWire['status']> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled',
  blocked: 'failed',
  failed: 'failed',
}

/** 批终态集合（封闭枚举；与 v2 行级终态同集——cancelled 留痕不冒充完成，但计入批结清） */
const BATCH_TERMINAL: ReadonlySet<BoardItemStatus> = new Set(['completed', 'cancelled'])

/** 看板行 → 树项（actor=认领成员名，未认领='待认领'；行级 needsYou=窄判定 boardRowNeedsUserDecision——
 *  只 blocked 档亮琥珀；待认领（灰调等待）/失败（红字警示）自成一相，不占中断位） */
function boardItemToWire(item: BoardItem): WorkPlanItemWire {
  return {
    id: item.id,
    content: item.title,
    status: BOARD_STATUS_TO_WIRE[item.status],
    actor: item.assignee ?? '待认领',
    ...(boardRowNeedsUserDecision(item.status) ? { needsYou: true } : {}),
    ...(item.result !== undefined ? { result: item.result } : {}),
    ...(item.note !== undefined ? { note: item.note } : {}),
  }
}

/** 批分组键：batchId 缺省自成单行批（key=行 id——单独派活一单一批的自然退化，⑦a） */
const batchKeyOf = (item: BoardItem): string => item.batchId ?? `__solo__:${item.id}`

/** 批结清判定：全部行终态=结清；settledAt=批内最晚 updatedAt（⑦b：起点恒≥真实末次终态时刻） */
interface BatchSettle {
  settled: boolean
  settledAt: number
}

function batchSettleOf(items: BoardItem[]): BatchSettle {
  let settledAt = 0
  for (const i of items) {
    settledAt = Math.max(settledAt, i.updatedAt)
    if (!BATCH_TERMINAL.has(i.status)) return { settled: false, settledAt }
  }
  return { settled: true, settledAt }
}

/** opts 解析统一口已退役（v4 零时间注入） */

/**
 * 让位批分组键集合（v4.1：供 buildWorkPlanTree 投影与 wiring 层物理清扫共用同一口径）：
 * 存在未结清批 → 全部已结清批��位；无未结清批 → 仅保留 settledAt 最大代（平局组键字典序取首），其余让位。
 * 与 buildWorkPlanTree 的输出严格一致（同一分组/判定代码路径）。
 */
export function retiredBatchGroupKeys(input: BuildWorkPlanTreeInput): Set<string> {
  const groups = groupRootBatches(input.mirrorTasks, input.boardItems ?? [])
  let hasActive = false
  for (const items of groups.values()) {
    if (!batchSettleOf(items).settled) {
      hasActive = true
      break
    }
  }
  let keepKey: string | undefined
  if (!hasActive) {
    let keepAt = -1
    for (const [key, items] of groups) {
      const { settled, settledAt } = batchSettleOf(items)
      if (!settled) continue
      if (settledAt > keepAt || (settledAt === keepAt && (keepKey === undefined || key < keepKey))) {
        keepAt = settledAt
        keepKey = key
      }
    }
  }
  const retired = new Set<string>()
  for (const [key, items] of groups) {
    if (batchSettleOf(items).settled && (hasActive || key !== keepKey)) retired.add(key)
  }
  return retired
}

/** 无链根行分组（buildWorkPlanTree 与 retiredBatchGroupKeys 共用同一分组口径） */
function groupRootBatches(mirrorTasks: TaskItem[], boardItems: BoardItem[]): Map<string, BoardItem[]> {
  const taskIds = new Set(mirrorTasks.map((t) => t.id))
  const groups = new Map<string, BoardItem[]>()
  for (const item of boardItems) {
    const pid = item.parentTaskId
    if (pid !== undefined && taskIds.has(pid)) continue // 有链行不参与⑦（全态投影，不删）
    const key = batchKeyOf(item)
    const arr = groups.get(key)
    if (arr) arr.push(item)
    else groups.set(key, [item])
  }
  return groups
}
/** 清单镜像 + 看板行 → 工作计划树（规则①-⑥见 v2 头注释；⑦保留界 1见文件头） */
export function buildWorkPlanTree(input: BuildWorkPlanTreeInput): WorkPlanItemWire[] {
  const { mirrorTasks, boardItems = [] } = input
  const taskIds = new Set(mirrorTasks.map((t) => t.id))
  const linked = new Map<string, BoardItem[]>()
  const rootRows: BoardItem[] = []
  for (const item of boardItems) {
    const pid = item.parentTaskId
    if (pid !== undefined && taskIds.has(pid)) {
      const arr = linked.get(pid)
      if (arr) arr.push(item)
      else linked.set(pid, [item])
    } else {
      // ②无链 ③断链孤儿：同规则提升根层（不丢行不猜新父）
      rootRows.push(item)
    }
  }
  const tree: WorkPlanItemWire[] = mirrorTasks.map((t) => {
    const children = (linked.get(t.id) ?? []).map(boardItemToWire)
    let status: WorkPlanItemWire['status'] = t.status
    let note: string | undefined
    if (children.length > 0) {
      if (children.every((c) => c.status === 'completed')) {
        // ④父项自动结项（纯投影派生，不 mutate 镜像真相）
        status = 'completed'
        note = '自动结项'
      } else if (children.some((c) => c.status === 'in_progress')) {
        status = 'in_progress'
      }
    }
    return {
      id: t.id,
      content: t.content,
      status,
      ...(t.result !== undefined ? { result: t.result } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(children.length > 0 ? { children } : {}),
    }
  })
  // 规则⑦（v4.1 顶掉即刻化）：让位判定唯一事实点=retiredBatchGroupKeys（与 wiring 物理清扫共用同一口径）；
  // 行序稳定（⑤）：按 rootRows 原序输出，让位组整批跳过（同组同命，输出序不变）
  const retiredKeys = retiredBatchGroupKeys({ mirrorTasks, boardItems })
  for (const item of rootRows) {
    if (retiredKeys.has(batchKeyOf(item))) continue
    tree.push(boardItemToWire(item))
  }
  return tree
}
