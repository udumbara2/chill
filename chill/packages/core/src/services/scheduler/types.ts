/**
 * 定时任务（Scheduled Tasks）的类型定义
 *
 * 定时任务是"新的事件源"（让事件发生），与 hooks（事件到了做什么）正交。
 * 本包只做 core 地基：任务定义 / cron 解析 / 持久化 / 调度判定；
 * 引擎接线（合成消息注入 runTurn）与工具注册由后续波次完成。
 */

import type { IFileMtimeProvider } from '../hooks/types'

/** 复用 hooks 的 mtime 窄接口（IFileSystemProvider 无 stat 能力，mtime 由壳层窄接口提供） */
export type { IFileMtimeProvider }

/** 任务归属：project=绑 workDir（该项目任意活跃会话可触发）；session=绑 sessionId（仅该会话） */
export type TaskScope = 'project' | 'session'

/** 任务状态：active=调度中；done=已完结（一次性已触发 / until 到期）；orphaned=归属会话已删除 */
export type TaskStatus = 'active' | 'done' | 'orphaned'

/**
 * 定时任务定义（~/.chill/scheduled-tasks.json 清单元素）。
 * cron 与 at 二选一：cron → recurring=true；at → recurring=false（一次性）。
 */
export interface ScheduledTask {
  id: string
  /** 5 段 cron（分 时 日 月 周，本地时区）；周期任务必填 */
  cron?: string
  /** 一次性触发时刻（RFC 3339 显式 offset，含糊报错）；一次性任务必填 */
  at?: string
  /** 到点注入会话的提示词（≤ 8KB） */
  prompt: string
  /** cron=true；at=false */
  recurring: boolean
  scope: TaskScope
  /** scope=project 时的绑定目录 */
  workDir?: string
  /** scope=session 时的绑定会话 */
  sessionId?: string
  /** 可选截止（RFC 3339）：最后一次触发后转 done；缺省长期有效 */
  until?: string
  createdAt: string
  /** 最近一次实际触发时刻（ISO）；未触发过为空。乐观判重的唯一比对字段（lastRun 不参与判重） */
  lastFireAt?: string
  fireCount: number
  status: TaskStatus
  /**
   * 最近一次执行记录（markFired 与 lastFireAt 同一次原子写写入，无双写竞态）：
   * 展示/审计用；firedAt 在 completed 时与 lastFireAt 同刻。失败/中断只写本字段
   * （outcome='failed'），不推进 lastFireAt/fireCount——下一自然触发点重试的语义不变。
   */
  lastRun?: {
    firedAt: string
    coalescedCount?: number
    outcome: 'completed' | 'failed'
  }
}

/** 创建入参（validateAndCreate 的输入；id/createdAt/fireCount/status 由服务填充） */
export interface NewTaskInput {
  cron?: string
  at?: string
  prompt: string
  recurring: boolean
  scope: TaskScope
  workDir?: string
  sessionId?: string
  until?: string
}

/** 一次到期触发的判定结果（tick 内部与 onFire 回调共用） */
export interface FireDecision {
  task: ScheduledTask
  /** 合并补跑计数：1=正常单次；N=错过 N 次合并为一次（collapse-to-latest） */
  coalescedCount: number
  /** 本次应触发时刻（ms，未加 jitter 的 cron 槽位 / at 原时刻） */
  scheduledAt: number
}

/** 逾期记录（detectOverdue 的返回元素；启动/会话激活时供调用方决策） */
export interface OverdueRecord {
  task: ScheduledTask
  /** 错过的应触发次数（≥1） */
  missedCount: number
  /** 最早一次错过的应触发时刻（ms） */
  firstMissedAt: number
  /** 当前上下文是否匹配归属（不匹配者由调用方决定搁置或提示，不自动补跑） */
  scopeMatches: boolean
}

/** scheduled-tasks.json 文件外层结构（带版本号便于演进） */
export interface ScheduledTasksFileShape {
  version?: number
  tasks?: ScheduledTask[]
}
