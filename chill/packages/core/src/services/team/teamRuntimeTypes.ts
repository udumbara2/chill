/**
 * 团队运行时状态类型(迭代 1:roster + 共享看板)
 *
 * 与团队 YAML 资产(team/types.ts 的 TeamDefinition)严格分离:
 * 资产是"出生证明"(静态声明),本文件是"运行态"(会话级、进程内真相 + 落盘快照)。
 * 运行时 roster 是成队时刻的快照——YAML 热改不影响在跑的队。
 */

/** 成员状态:standby=花名册在册未派活 / running=任务执行中 / idle=交付可待 / failed=上次任务失败 */
export type TeamMemberStatus = 'standby' | 'running' | 'idle' | 'failed'

/** 花名册条目(成员身份 = 名字,进程内唯一;撞名自动派生 -2/-3 后缀) */
export interface RosterEntry {
  /** 成员名(默认 = subagent_type,task 的 member_name 可覆盖;撞名自动加后缀) */
  name: string
  /** 成员引用的单 Agent 模板标识 */
  agent: string
  /** 分工短语(来自团队 YAML 或临时说明) */
  role?: string
  /** 计划批准门(来自团队 YAML 的 plan_first;登记点据此默认 require_plan) */
  planFirst?: boolean
  /** 待批准(阶段 1 计划已交付待 Lead approve_plan;approve/cancel/failed 时清除) */
  planPending?: boolean
  status: TeamMemberStatus
  /** 当前/最近一次委派的绑定键(toolCall.id;网关经它反查成员资格与归属) */
  currentTaskId?: string
  /** transcript 留存键(迭代 2 消息唤醒的种子) */
  transcriptKey?: string
  /** 嵌套深度(迭代 3:lead 直派=1,成员拉新=父+1;预算 maxDepth 的帽子读它) */
  depth?: number
  joinedAt: number
}

// ---- 看板类型迁移至 services/board/boardTypes(共享看板状态机唯一事实点),此处 re-export 保兼容 ----
import type { BoardItem } from '../board/boardTypes'
export type { BoardItem, BoardItemStatus, BoardReleaseEntry } from '../board/boardTypes'
export { BOARD_RESULT_MAX_CHARS } from '../board/boardTypes'

// ---------------- 授权快照(原子化灵活协作机制 · 一期迭代 1) ----------------

/**
 * 原子授权粒度:工具名('task')或 action 级('team_board:claim')。
 * 合法值集 = 编排工具名(PLAN_MODE_BLOCKED_TOOLS 清单)+ team_board action 名(见 teamPolicy.ts 校验)。
 */
export type AtomGrant = string

/** 团队预算(必填字段,值可缺省 = 不设限即现状语义;闸的逻辑在迭代 3) */
export interface TeamBudget {
  maxMembers?: number
  maxTokens?: number
  maxDepth?: number
}

/** 团队账本(迭代 3 填逻辑;spentTokens 为 null = 无计量数据,参考 contextPressure no-usage 先例) */
export interface TeamLedger {
  spentTokens: number | null
  memberCount: number
  /** 任一笔入账为字符估值(服务商未回报 usage)时置真(单向,实测+估值混合也标估值);展示/拦截理由据此标注 ~ */
  estimated?: boolean
}

/** 快照变更留痕(by = 谁改的;note = 原文指令/原因) */
export interface SnapshotHistoryEntry {
  at: number
  by: 'lead' | 'user-direct' | 'system' | 'watchdog'
  note: string
}

/** 解冻态(迭代 4 填逻辑):watchdog/用户/lead 申请三通道临时恢复 lead 干预原子;平息收回 */
export interface TeamUnfreeze {
  by: 'watchdog' | 'user' | 'lead-escalate'
  at: number
  reason: string
  restoredGrants: AtomGrant[]
}

/**
 * 授权快照(成队时生成,随团队状态落盘;授权的唯一载体)。
 * grants 键 = 成员名或 'lead';**defaultMemberGrants = 拉新入队新成员的缺省授权**(缺它自主拉新链条卡死)。
 * 缺失(undefined)时 teamPolicy 一律按默认快照语义(=现状)判定——向后兼容红线。
 */
export interface TeamSnapshot {
  grants: Record<string, AtomGrant[]>
  defaultMemberGrants: AtomGrant[]
  budget: TeamBudget
  /** 快照来源:default=系统默认 / template=团队 YAML policy 段 / user/lead/user-direct=后续热更新的最近来源 */
  source: 'default' | 'template' | 'user' | 'lead' | 'user-direct'
  createdAt: number
  history: SnapshotHistoryEntry[]
  unfreeze?: TeamUnfreeze
}

/** 活动团队运行态(每会话/进程一个;进程退出即归档,落盘文件留档只读) */
export interface TeamRunState {
  /** <name|adhoc>-<时间戳>-<随机串>(防双进程同毫秒撞名) */
  runId: string
  /** 固定团队名;ad-hoc 临时团队为 undefined */
  name?: string
  /** 归属会话 id（成队时登记；手机显示并集按此匹配——旧数据无字段=不并入手机显示，向后兼容） */
  sessionId?: string
  createdAt: number
  roster: RosterEntry[]
  board: BoardItem[]
  /** 全局唯一 CAS 计数,每次 mutation 自增(条目级不单设 revision) */
  boardRevision: number
  /** 授权快照(成队时由 activate() 生成;缺省 = 默认语义,向后兼容) */
  snapshot?: TeamSnapshot
  /** 预算账本(迭代 3 填逻辑) */
  ledger?: TeamLedger
  /** 宿主进程 pid(activate 时写入;跨进程观测的存活地面真值,观测方 kill(pid,0) 探测) */
  hostPid?: number
  /** 归档时间戳(archive() 写入并落盘;异名换队=进程活着但团队已结束,观测方据此即隐) */
  archivedAt?: number
}

/** 信箱消息(迭代 2;真相源 = team-runs/<runId>/inboxes/<member>.json,路由 = 投递尝试) */
export interface TeamInboxMessage {
  /** 发送者(成员名或 'lead';归属在投递与展示全链保留) */
  from: string
  content: string
  at: number
  /** 投递才算已读(steer 入队成功/拼入种子/回流 drain 时置真) */
  delivered: boolean
}

/** send_message 的 content 限长(上下文保护) */
export const TEAM_MESSAGE_MAX_CHARS = 4096
