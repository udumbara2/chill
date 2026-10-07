/**
 * 共享看板 · 显示判定唯一事实点(纯函数、Node-free)
 *
 * 壳侧(UI/TUI/WebUI/手机)只消费投影,不得自行组装行序/徽章/进展行/限窗判定。
 * 纪律:零服务依赖;4KB result 截断标注与 core 习惯同源(capBoardText);
 *   进展行三来源用词区分:note(进展/受阻原因)、releaseHistory(失败记录/退回记录)、发帖说明(发帖提议)。
 */

import {
  boardBindingCandidate,
  capBoardText,
  type BoardItem,
  type BoardItemStatus,
  type BoardReleaseEntry,
} from './boardTypes'

/** 行态徽章文案(词表与 boardTypes 状态注释一致) */
export const BOARD_STATUS_LABEL: Record<BoardItemStatus, string> = {
  pending: '待认领',
  in_progress: '进行中',
  blocked: '需拍板',
  completed: '已交付',
  cancelled: '已取消',
  failed: '待裁决',
}

/**
 * 回流态行徽章（M7 增量 2）：与「待认领」分开——「待认领」= 从没人做过的活（动作是"派人"），
 * 「待重派」= 上一轮执行失败/中断后回池的活（动作是"重派原主或换人接手，也可撤单"）。
 * 协议零新增：label 本就是自由文本字段，手机侧信号态直接渲染协议 label。
 */
export const BOARD_REFLOW_LABEL = '待重派'

/** 第三层分态明细数据(随行下发,壳展开即得,无需二次读板) */
export interface BoardRowDetail {
  description?: string
  /** 最新进展(blocked 时兼作受阻原因) */
  note?: string
  /** 受阻原因(blocked 时 = note,分态显式下发) */
  blockedReason?: string
  /** result 全文(超 4KB 截断并明示;truncated=截断标记) */
  result?: string
  resultTruncated?: boolean
  releaseHistory?: BoardReleaseEntry[]
  failCount?: number
  /** 认领任务绑定键(= feed.subagent.taskId,行↔feed 归属键;只增透传,零判定) */
  claimedByTaskId?: string
  batchId?: string
  createdBy: string
  createdAt: number
  updatedAt: number
  stagnationAfter?: number
}

/** 看板行(三段式显示:归属徽章/行态徽章/进展行 + 第层明细) */
export interface BoardRow {
  itemId: string
  title: string
  /** 工位徽章文本(team=成员名|'lead',轻量板=subagentType·短序号);无主为 null */
  assignee: string | null
  status: BoardItemStatus
  /** 行态徽章文案:待认领/需拍板/待裁决/进行中/已交付/已取消 */
  label: string
  /** 进展行(来源规则见 buildBoardProgressText;事实兜底由壳用 feed 拼装) */
  progressText: string | null
  /** 计时基线("认领 N 分钟";缺省=旧数据不显示时长) */
  claimedAt?: number
  /** 限窗标记(true=终态行超出窗口;要你行与进行中行永不置真) */
  clipped?: boolean
  detail: BoardRowDetail
}

/** 要你信号(全板:待认领∪需拍板∪待裁决∪pendingAskCount∪pendingApprovalCount) */
export interface BoardNeedsYou {
  needed: boolean
  count: number
}

/** 折叠态视图模型(输入=焦点批次行集) */
export interface BoardStrip {
  status: 'running' | 'settled'
  /** running 计数=终态/总行(如 "2/5") */
  countText: string
  /** settled 文案:无归档「N 个子任务完成」/有归档「结清 · N 完成 M 归档」 */
  settleText?: string
  needsYou: boolean
}

export interface BoardProjection {
  rows: BoardRow[]
  needsYou: BoardNeedsYou
  strip: BoardStrip
  /** 限窗标记(true=有行被限窗裁剪) */
  windowed: boolean
}

export interface BoardProjectionOptions {
  /** 待回答 ask 计数(壳注入,并入 needsYou) */
  pendingAskCount: number
  /** 待审批计数(壳注入,并入 needsYou) */
  pendingApprovalCount: number
  now: number
  /** 终态行限窗条数(缺省 10;要你∪进行中行全量保) */
  terminalWindow?: number
}

const DEFAULT_TERMINAL_WINDOW = 10

function isTerminal(status: BoardItemStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

function isNeedsYou(status: BoardItemStatus): boolean {
  return status === 'pending' || status === 'blocked' || status === 'failed'
}

/** 行级 needsYou 判定唯一事实点（待认领∪需拍板∪待裁决；additive 导出——工作计划树投影复用，不新造第二套判据） */
export function boardRowNeedsYou(status: BoardItemStatus): boolean {
  return isNeedsYou(status)
}

/**
 * 行级「要不要用户拍板」窄判定（additive；工作计划树手机端显示语义专用）：
 * 只认 blocked（受阻/待裁决——真卡在等用户），**不含 pending（待认领=灰调等待认领）与 failed（失败红字自成一相）**。
 * 与宽口径 boardRowNeedsYou（桌面看板「要你关照」=待认领∪需拍板∪待裁决）并存——受众不同，严禁互换：
 * 桌面看板把待认领也算「要你」是板级提醒语义；手机长条的琥珀=唯一中断信号，只该在真等用户拍板时亮。
 */
export function boardRowNeedsUserDecision(status: BoardItemStatus): boolean {
  return status === 'blocked'
}

/** 行序组:0=要你(待认领∪需拍板∪待裁决) 1=进行中 2=已交付 3=已取消(最后) */
function rowRank(status: BoardItemStatus): number {
  if (isNeedsYou(status)) return 0
  if (status === 'in_progress') return 1
  if (status === 'completed') return 2
  return 3
}

/** 留痕行用词区分:by='system'=失败记录(死亡回流/交付失败),否则=退回记录(人工退回) */
function historyLine(entry: BoardReleaseEntry): string {
  if (entry.by === 'system') return `失败记录：${entry.reason}`
  return `退回记录：${entry.by}：${entry.reason}${entry.suggestedTo ? `；建议下一任:${entry.suggestedTo}` : ''}`
}

function postLine(item: BoardItem): string | null {
  const body = item.note ?? item.description
  return body ? `发帖提议：${body}` : null
}

/**
 * 进展行来源完整规则:
 * - 进行中 = note 优先 → null(事实兜底由壳用 feed 拼装)
 * - 需拍板 = note(受阻原因)→ 最新留痕 → 发帖说明
 * - 待认领/待裁决 = 最新 releaseHistory(失败记录/退回记录)→ 发帖说明(note 或 description)
 * - 终态 = result → 归档说明(最新留痕 reason)
 */
export function buildBoardProgressText(item: BoardItem): string | null {
  const history = item.releaseHistory ?? []
  const latest = history.length > 0 ? history[history.length - 1] : undefined
  switch (item.status) {
    case 'in_progress':
      return item.note ?? null
    case 'blocked':
      return item.note ?? (latest ? historyLine(latest) : postLine(item))
    case 'pending':
    case 'failed':
      return latest ? historyLine(latest) : postLine(item)
    case 'completed':
    case 'cancelled':
      return item.result ?? (latest ? `归档说明：${latest.reason}` : null)
  }
}

/** 焦点批次行集:batchId 最新的批次(按该批最早条目 createdAt 定序;无 batchId=隐式一批;单批即该批) */
function focusBatchItems(items: BoardItem[]): BoardItem[] {
  const groups = new Map<string, BoardItem[]>()
  for (const it of items) {
    const key = it.batchId ?? ''
    const arr = groups.get(key)
    if (arr) arr.push(it)
    else groups.set(key, [it])
  }
  if (groups.size === 0) return []
  let focusKey = ''
  let focusEarliest = Number.NEGATIVE_INFINITY
  for (const key of [...groups.keys()].sort()) {
    let earliest = Number.POSITIVE_INFINITY
    for (const it of groups.get(key)!) earliest = Math.min(earliest, it.createdAt)
    if (earliest > focusEarliest || (earliest === focusEarliest && key > focusKey)) {
      focusEarliest = earliest
      focusKey = key
    }
  }
  return groups.get(focusKey)!
}

function buildStrip(items: BoardItem[], needsYou: BoardNeedsYou): BoardStrip {
  const focus = focusBatchItems(items)
  const total = focus.length
  let completed = 0
  let cancelled = 0
  let open = 0
  for (const it of focus) {
    if (it.status === 'completed') completed++
    else if (it.status === 'cancelled') cancelled++
    else open++
  }
  const settled = open === 0
  const countText = `${completed + cancelled}/${total}`
  const settleText = settled
    ? cancelled === 0
      ? `${completed} 个子任务完成`
      : `结清 · ${completed} 完成 ${cancelled} 归档`
    : undefined
  return { status: settled ? 'settled' : 'running', countText, settleText, needsYou: needsYou.needed }
}

export function buildBoardProjection(items: BoardItem[], opts: BoardProjectionOptions): BoardProjection {
  const sorted = [...items].sort((a, b) => {
    const rank = rowRank(a.status) - rowRank(b.status)
    if (rank !== 0) return rank
    if (!isTerminal(a.status) && !isTerminal(b.status)) {
      const ka = a.status === 'in_progress' ? (a.claimedAt ?? a.createdAt) : a.createdAt
      const kb = b.status === 'in_progress' ? (b.claimedAt ?? b.createdAt) : b.createdAt
      if (ka !== kb) return ka - kb
    } else if (a.updatedAt !== b.updatedAt) {
      // 终态沉底:completed 按完成先后、cancelled 最后(组序已分),组内按完成时间
      return a.updatedAt - b.updatedAt
    }
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const rows: BoardRow[] = sorted.map((item) => {
    const cappedResult = item.result !== undefined ? capBoardText(item.result) : undefined
    return {
      itemId: item.id,
      title: item.title,
      assignee: item.assignee ?? null,
      status: item.status,
      // 回流态分流（M7 增量 2）：只改徽章文案，status/needsYou/rowRank 一律不动
      label: item.status === 'pending' && boardBindingCandidate(item) === 'reflowed'
        ? BOARD_REFLOW_LABEL
        : BOARD_STATUS_LABEL[item.status],
      progressText: buildBoardProgressText(item),
      claimedAt: item.claimedAt,
      detail: {
        description: item.description,
        note: item.note,
        blockedReason: item.status === 'blocked' ? item.note : undefined,
        result: cappedResult?.value,
        resultTruncated: cappedResult?.truncated,
        releaseHistory: item.releaseHistory ? [...item.releaseHistory] : undefined,
        failCount: item.failCount,
        claimedByTaskId: item.claimedByTaskId,
        batchId: item.batchId,
        createdBy: item.createdBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        stagnationAfter: item.stagnationAfter,
      },
    }
  })

  // 限窗:要你∪进行中行全量保;终态行按最近 updatedAt 保留 terminalWindow 条,其余标 clipped(要你行永不裁剪)
  const windowSize = opts.terminalWindow ?? DEFAULT_TERMINAL_WINDOW
  const terminalRows = rows.filter((r) => isTerminal(r.status))
  if (terminalRows.length > windowSize) {
    const byRecency = [...terminalRows].sort((a, b) => b.detail.updatedAt - a.detail.updatedAt)
    for (const row of byRecency.slice(windowSize)) row.clipped = true
  }

  let boardNeeds = 0
  for (const it of items) {
    if (isNeedsYou(it.status)) boardNeeds++
  }
  const needsCount = boardNeeds + (opts.pendingAskCount ?? 0) + (opts.pendingApprovalCount ?? 0)
  const needsYou: BoardNeedsYou = { needed: needsCount > 0, count: needsCount }

  return {
    rows,
    needsYou,
    strip: buildStrip(items, needsYou),
    windowed: rows.some((r) => r.clipped === true),
  }
}
