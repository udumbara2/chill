/**
 * 共享看板 · 状态机类型(唯一事实点)
 *
 * 看板是跨会话/跨壳共享的工单板:轻量板(subagentType·短序号工位)与团队板(成员名|'lead' 工位)
 * 共用同一套条目状态机。mutation 语义在 boardCore(纯函数、不查 roster),落盘在 boardStore,
 * 显示判定在 boardProjection(纯函数)。与 teamRuntimeTypes 的关系:后者 re-export 本文件的
 * 看板类型,保既有 import 路径零破坏(team 运行时收编 boardCore 是 V4.1 的事)。
 */

/**
 * 条目状态(6 态:team 运行时原 4 态只增 blocked/cancelled)。
 * label 归 boardProjection,此处给出徽章文案词表倾向:
 * - pending     = 待认领 (回池可领)
 * - in_progress = 进行中 (已认领在办)
 * - blocked     = 需拍板 (认领人在办,卡在待回答的 ask/决策)
 * - completed   = 已交付 (终态)
 * - cancelled   = 已取消 (终态;用户撤单/会话删除/裁决取消/归档清场)
 * - failed      = 待裁决 (语义钉死=「失败待裁决」:交付失败≥2 次停留此态,等 Lead adjudicate;非终态)
 * 终态 = completed | cancelled;其余为在途。
 */
export type BoardItemStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled' | 'failed'

/** settle 的结局(任务/条目生命周期回写) */
export type BoardSettleOutcome = 'completed' | 'failed' | 'cancelled'

/** 裁决出口(failed=待裁决条目):cancel=终态撤销 / retry=回池再试(failCount 不清零) */
export type BoardAdjudication = 'cancel' | 'retry'

/** 归属约束的调用方身份(参数化,不查 roster;lead=板主/管理员的结构化角色) */
export type BoardCaller = { role: 'lead' } | { role: 'worker'; assignee: string }

/**
 * 留痕条目(releaseHistory 通用历史:退回/失败/死亡回流/取消/裁决一律追加在此)。
 * 投影按 by 区分用词:by='system' →「失败记录」,否则 →「退回记录」。
 */
export interface BoardReleaseEntry {
  /** 留痕人(工位名;系统自动回流固定 'system') */
  by: string
  reason: string
  suggestedTo?: string
  at: number
}

/** 看板条目(result/note 限长 4KB 保护上下文) */
export interface BoardItem {
  id: string
  title: string
  description?: string
  status: BoardItemStatus
  /** 认领人=工位名(语义放宽:team=成员名|'lead',轻量板=subagentType·短序号;归属约束的比对键) */
  assignee?: string
  /** 认领时的任务绑定(自动结项关联数据:settle completed 且绑定匹配才自动结项,零启发式;
   *  lead 认领无绑定=undefined) */
  claimedByTaskId?: string
  /** 认领时刻(显示层"已认领 N 分钟"计时基线——updatedAt 会被后续 update 顶掉,故单设;
   *  release/死亡回流清除,纯增量:旧数据无此字段 = 不显示时长) */
  claimedAt?: number
  /** 挂项人(工位名) */
  createdBy: string
  /** 交付结果摘要(限长 4KB,超出截断并明示) */
  result?: string
  /** 最新进展(只增;4KB 截断同 result;blocked 时兼作受阻原因) */
  note?: string
  /** 分组属性(批量挂项的批次 id;投影 strip 焦点批次口径读它) */
  batchId?: string
  /** 失败计数(只增:交付失败 +1,裁决 retry 不清零;≥2 置 failed 待裁决停留) */
  failCount?: number
  /** 留痕历史(退回/失败/死亡回流/取消/裁决) */
  releaseHistory?: BoardReleaseEntry[]
  /** 任务级静默容忍声明(分钟;watchdog 停滞检测读它) */
  stagnationAfter?: number
  /** 分解链(只增):本行由任务清单哪一项分解而来(=清单项 id;team_board post 的 parent_task_id 写入)。
   *  纯增量:旧落盘数据无此字段=无链——工作计划树投影按无链根层并列/断链孤儿提升处理,不猜新父 */
  parentTaskId?: string
  createdAt: number
  updatedAt: number
}

/** 板状态(内存为真相、文件为快照;revision=全局 CAS 单调计数,每次 mutation 自增一) */
export interface BoardState {
  /** 会话级板 id(=sessionId;轻量板=会话 id,团队板=runId) */
  boardId: string
  revision: number
  items: BoardItem[]
  createdAt: number
  updatedAt: number
  /** 归档标记(archiveBoard 写入=会话删除语义;结清快照保留,文件不删) */
  archivedAt?: number
  archiveReason?: string
}

/** 结构化错误码(归属约束违规/状态机拒绝/查无条目都抛 BoardError,调用方可按 code 分支)。
 *  SNAPSHOT_CORRUPT=快照损坏(store.load 隔离后抛出;ensureBoard 据此分流——损坏可重开新板,IO 错误须上抛) */
export type BoardErrorCode = 'ITEM_NOT_FOUND' | 'NOT_CLAIMABLE' | 'FORBIDDEN' | 'INVALID_STATE' | 'INVALID_INPUT' | 'SNAPSHOT_CORRUPT'

/** 结构化错误(看板操作的唯一错误形态) */
export class BoardError extends Error {
  readonly code: BoardErrorCode
  readonly itemId?: string

  constructor(code: BoardErrorCode, message: string, itemId?: string) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    this.itemId = itemId
  }
}

/** result/note 限长(上下文保护;与 team 的 BOARD_RESULT_MAX_CHARS 同源同值) */
export const BOARD_RESULT_MAX_CHARS = 4096

/** 4KB 截断标注(唯一格式化点,core 习惯;boardCore 写入与 boardProjection 展示共用) */
export function capBoardText(text: string): { value: string; truncated: boolean } {
  if (text.length <= BOARD_RESULT_MAX_CHARS) return { value: text, truncated: false }
  return { value: `${text.slice(0, BOARD_RESULT_MAX_CHARS)}\n…(超出 4KB,已截断)`, truncated: true }
}

/**
 * 「待处置的失败活」判据(唯一事实点;门的候选集与「待重派」label 分流共用,不许各处自己定):
 * - reflowed：`pending` 且留痕含 `by:'system'` 的自动回流条目 —— **同时吸住"交付失败回流"与"死亡回流"**
 *   （后者 failCount 不涨,故不能用 failCount 判定）；可带 board_item_id 直接复用。
 * - pending-adjudication：`failed`(待裁决,连续失败 ≥2) 且留痕含 system —— 需先 adjudicate(retry) 回池再复用。
 * 人工退回（release by=工位名）不算候选：那是人的决定，不是失败尝试。
 */
export type BoardBindingCandidateState = 'reflowed' | 'pending-adjudication'

export function boardBindingCandidate(item: BoardItem): BoardBindingCandidateState | null {
  const autoReturned = (item.releaseHistory ?? []).some((e) => e.by === 'system')
  if (!autoReturned) return null
  if (item.status === 'pending') return 'reflowed'
  if (item.status === 'failed') return 'pending-adjudication'
  return null
}
