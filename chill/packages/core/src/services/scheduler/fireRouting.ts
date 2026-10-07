/**
 * fireRouting.ts —— 定向路由纯函数（M2，规划《定时任务 serve 持钟与定向路由》）。
 *
 * 触发路由由任务自身的 scope 决定，与「谁持钟」「哪个会话恰好活跃」无关：
 * - scope=session：在册→engine；不在册但盘上有→load；都不行→orphan（清账）
 * - scope=project：在册 workDir 匹配引擎（活跃优先、其次最近活跃）；无在册→该目录
 *   最近会话 load；无会话→newSession（无人值守兜底，到点必有归宿）
 *
 * 纯函数、Node-free：registry/sessionIndex/文件探测全部经快照注入（可测逻辑下沉 core，
 * 双壳共用唯一事实点；宿主只负责执行决策）。workDir 匹配语义与 SchedulerService.scopeMatches
 * 同款（normalizeDir 单源复用）。
 */

import type { ScheduledTask } from './types'
import { normalizeDir } from './SchedulerService'

/** 宿主注入的路由快照（全部现读；决策执行归宿主） */
export interface FireTargetSnapshot {
  /** registry 在册引擎快照：sessionId + 引擎本地 workDir + 活跃标志 + 最近活跃时刻 */
  engines: Array<{ sessionId: string; workDir: string; isActive?: boolean; lastActiveAt?: number }>
  /** 会话文件存在性（session 装载可达性判定；损坏文件按不存在处理=诚实 orphan） */
  sessionExists: (sessionId: string) => boolean
  /** 该 workDir 下最近会话 id（sessionIndex 数据源；无会话=undefined） */
  latestSessionInDir: (workDir: string) => string | undefined
}

/** 路由决策：宿主按 kind 执行（engine=直寻注入 / load=registry.open 装载后注入 /
 *  newSession=registry.create+setWorkDir 钉住后注入 / orphan=markOrphaned 清账） */
export type FireTargetDecision =
  | { kind: 'engine'; sessionId: string }
  | { kind: 'load'; sessionId: string }
  | { kind: 'newSession'; workDir: string }
  | { kind: 'orphan'; reason: string }

/** workDir 归一匹配（与 scopeMatches 同一语义：反斜杠归正、去尾斜杠、小写） */
function sameDir(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return normalizeDir(a) === normalizeDir(b)
}

/**
 * 定向路由决策（唯一事实点）：
 * - session 任务绑定的会话不再可达（盘上无文件）→ orphan——与 M5 会话删除清账同一状态语义；
 * - project 任务 workDir 在盘上已不存在（目录删除/外置盘离线）→ 照常 newSession（工具调用
 *   在该目录下自然报错、轮次可完成可观测；不做存在性拦截——临时离线≠项目已死，误杀即丢任务）。
 */
export function resolveScheduledFireTarget(task: ScheduledTask, snap: FireTargetSnapshot): FireTargetDecision {
  if (task.scope === 'session') {
    if (!task.sessionId) return { kind: 'orphan', reason: '任务缺 sessionId（清单损坏）' }
    const inRegistry = snap.engines.some((e) => e.sessionId === task.sessionId)
    if (inRegistry) return { kind: 'engine', sessionId: task.sessionId }
    if (snap.sessionExists(task.sessionId)) return { kind: 'load', sessionId: task.sessionId }
    return { kind: 'orphan', reason: `归属会话 ${task.sessionId} 不存在（已删除或损坏）` }
  }

  // scope=project
  const matches = snap.engines.filter((e) => sameDir(e.workDir, task.workDir))
  if (matches.length > 0) {
    // 活跃优先；其次最近活跃（lastActiveAt 缺省按 0——纯顺序兜底）
    const active = matches.find((e) => e.isActive)
    if (active) return { kind: 'engine', sessionId: active.sessionId }
    const recent = [...matches].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
    return { kind: 'engine', sessionId: recent.sessionId }
  }
  const latest = task.workDir ? snap.latestSessionInDir(task.workDir) : undefined
  if (latest && snap.sessionExists(latest)) return { kind: 'load', sessionId: latest }
  return { kind: 'newSession', workDir: task.workDir ?? '' }
}
