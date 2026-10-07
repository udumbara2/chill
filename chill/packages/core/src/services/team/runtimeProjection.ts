/**
 * 运行态统一投影(UI 三层显示统一 · 迭代 1 "运行"药丸)
 *
 * 定位:五壳共享的运行态视图模型——TeamRunState(团队)+ 进程任务列表(task 委派记录)
 *   → 团队区(成员行/看板计数/账本行)/独立任务区/折叠态计数/超预算标记。
 *   未来 WebUI/手机 UI 显示团队状态需要同一份投影,故归 core 而非 UI 私货。
 * 纪律:纯函数、零服务依赖;类型从 teamRuntimeTypes 导入,不新造;
 *   超预算判定只调 teamPolicy.isOverTokenBudget(判定 SSOT 同族),不新写比较逻辑;
 *   账本行复用 teamLedgerFormat.formatTokenSpend 三态(展示判定唯一格式化点)。
 */

import type { TaskToolOutput } from '../../orchestrator/types'
import { formatTokenSpend } from './teamLedgerFormat'
import { isOverTokenBudget } from './teamPolicy'
import { buildBoardProjection } from '../board/boardProjection'
import type { BoardItemStatus, TeamMemberStatus, TeamRunState } from './teamRuntimeTypes'

/** 进程任务条目(壳侧观测到的 task 委派记录;与 UI 原 subagentProcessInfos 条目同形。
 *  现状语义:运行中 output 为空,settle 后才回填输出与结果) */
export interface RuntimeProcessTask {
  taskId: string
  subagentType: string
  description: string
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  output: string
  result?: TaskToolOutput
}

/** 团队成员行(当前任务 = 按 roster.currentTaskId 精确匹配 processTasks;任务↔成员对账键) */
export interface RuntimeMemberRow {
  name: string
  status: TeamMemberStatus
  /** 成员当前/最近一次任务(有绑定且能在 processTasks 中找到时) */
  task?: RuntimeProcessTask
  /** 成员行认领信息(看板显示三段式;匹配 board 中 assignee===成员名 且 status==='in_progress' 的条目;
   *  lead 认领不计成员行;claimedAt 缺省(旧数据)= 不显示时长) */
  claim?: RuntimeMemberClaim
}

/** 成员行认领信息 */
export interface RuntimeMemberClaim {
  itemTitle: string
  claimedAt?: number
}

/** 看板条目投影(看板气泡唯一数据源——SSOT:UI 不直接读 teamState.board 组装) */
export interface RuntimeBoardItem {
  id: string
  title: string
  assignee?: string
  createdAt: number
  claimedAt?: number
  updatedAt: number
  result?: string
  releaseHistory?: { by: string; reason: string; suggestedTo?: string; at: number }[]
}

/** 看板分组(固定序:待认领/进行中/已完成/失败退回;空组不出现) */
export interface RuntimeBoardGroup {
  status: BoardItemStatus
  items: RuntimeBoardItem[]
}

/** 看板计数(待认领/进行中/完成/失败) */
export interface RuntimeBoardCounts {
  pending: number
  inProgress: number
  completed: number
  failed: number
}

/** 团队区投影 */
export interface RuntimeTeamSection {
  runId: string
  /** 固定团队名;ad-hoc 临时团队为 undefined */
  name?: string
  members: RuntimeMemberRow[]
  boardCounts: RuntimeBoardCounts
  /** 看板分组条目(气泡唯一数据源;固定序 待认领/进行中/已完成/失败退回,空组不出现) */
  boardGroups: RuntimeBoardGroup[]
  /** 待认领警示行数据源:最早一条待认领(最久滞留=最高信号)+ 待认领总条数;无待认领为 undefined */
  pendingWarning?: { title: string; createdAt: number; count: number }
  /** 账本行(formatTokenSpend 三态 + 上限;如 "~12,400(估值) / 10,000") */
  ledgerText: string
  overBudget: boolean
}

/** 统一视图模型(折叠态药丸与展开面板共用一份) */
export interface RuntimeProjection {
  /** 团队区;无活动团队为 null */
  team: RuntimeTeamSection | null
  /** 独立任务区:processTasks 中不匹配任何 roster.currentTaskId 的条目 */
  independentTasks: RuntimeProcessTask[]
  /** 进行中任务总数(成员任务 + 独立任务) */
  runningCount: number
  /** 全部落地:有任务且全部到终态(折叠态显示 "✓ 全部完成") */
  allDone: boolean
  /** 超预算标记(isOverTokenBudget 透传;折叠态药丸变红) */
  overBudget: boolean
  /** 药丸是否出现:没有运行中的东西(且无团队)不出现;有终态残留时出现以提供清空入口 */
  hasRuntime: boolean
}

export function buildRuntimeProjection(
  teamState: TeamRunState | null | undefined,
  processTasks: RuntimeProcessTask[],
): RuntimeProjection {
  const memberTaskIds = new Set(
    (teamState?.roster ?? []).map((e) => e.currentTaskId).filter((id): id is string => !!id),
  )
  const taskById = new Map(processTasks.map((t) => [t.taskId, t]))

  let team: RuntimeTeamSection | null = null
  if (teamState) {
    const boardCounts: RuntimeBoardCounts = { pending: 0, inProgress: 0, completed: 0, failed: 0 }
    for (const item of teamState.board) {
      if (item.status === 'pending') boardCounts.pending++
      else if (item.status === 'in_progress') boardCounts.inProgress++
      else if (item.status === 'completed') boardCounts.completed++
      else boardCounts.failed++
    }
    // 看板分组/警示行(收编 V4.2:改吃 boardProjection——分组归属与排序同源,不再各算一套;
    // 气泡形状字段照旧直给,UI 消费代码零改动)
    const boardProjection = buildBoardProjection(teamState.board, {
      pendingAskCount: 0,
      pendingApprovalCount: 0,
      now: Date.now(),
    })
    const boardGroups: RuntimeBoardGroup[] = (['pending', 'in_progress', 'completed', 'failed'] as const)
      .map((status) => ({
        status: status as BoardItemStatus,
        items: boardProjection.rows
          .filter((r) => r.status === status)
          .map((r) => ({
            id: r.itemId,
            title: r.title,
            assignee: r.assignee ?? undefined,
            createdAt: r.detail.createdAt,
            claimedAt: r.claimedAt,
            updatedAt: r.detail.updatedAt,
            result: r.detail.result,
            releaseHistory: r.detail.releaseHistory,
          })),
      }))
      .filter((g) => g.items.length > 0)
    // 待认领警示行:投影行序首条 pending(最久滞留=最高信号)+ 待认领总条数(计数语义不变)
    const pendingRows = boardProjection.rows.filter((r) => r.status === 'pending')
    const earliestPending = pendingRows[0]
    const pendingWarning = earliestPending
      ? { title: earliestPending.title, createdAt: earliestPending.detail.createdAt, count: pendingRows.length }
      : undefined

    const overBudget = isOverTokenBudget(teamState.snapshot, teamState.ledger)
    const maxTokens = teamState.snapshot?.budget?.maxTokens
    team = {
      runId: teamState.runId,
      name: teamState.name,
      members: teamState.roster.map((e) => {
        // 认领匹配:board 中 assignee===成员名 且进行中的第一条(lead 认领='lead' 永不匹配成员名)
        const claimed = teamState.board.find((i) => i.status === 'in_progress' && i.assignee === e.name)
        return {
          name: e.name,
          status: e.status,
          task: e.currentTaskId ? taskById.get(e.currentTaskId) : undefined,
          claim: claimed ? { itemTitle: claimed.title, claimedAt: claimed.claimedAt } : undefined,
        }
      }),
      boardCounts,
      boardGroups,
      pendingWarning,
      ledgerText: formatTokenSpend(teamState.ledger) + (maxTokens !== undefined ? ` / ${maxTokens}` : ''),
      overBudget,
    }
  }

  const active = processTasks.filter((t) => t.status !== 'idle')
  const independentTasks = active.filter((t) => !memberTaskIds.has(t.taskId))
  const runningCount = active.filter((t) => t.status === 'running').length
  const allDone = active.length > 0 && runningCount === 0

  return {
    team,
    independentTasks,
    runningCount,
    allDone,
    overBudget: team?.overBudget ?? false,
    hasRuntime: team !== null || active.length > 0,
  }
}
