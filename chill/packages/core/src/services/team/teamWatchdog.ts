/**
 * 团队探测器(原子化灵活协作机制 · 一期迭代 4):保险丝基础设施化
 *
 * 定位:系统服务,非 agent、非原子;只读基板(花名册/看板/账本/快照)+ 写留痕,不执行任何任务动作。
 * 三类信号(全部事件驱动,无常驻轮询):
 * - 冲突:同一任务 release ≥2 次(认领争抢/循环退回)——onChange 即判定;
 * - 预算异常:token 消耗超过预算上限(进行中任务不受扩张闸限制)——onChange 即判定;
 * - 停滞:任务级截止——每个未认领/进行中任务按其 stagnationAfter(缺省团队默认)算截止点,
 *   onChange 时重算最近截止点设一次性定时器,静默到期才醒(调研任务与执行任务天然不同容忍度)。
 * 触发动作(三通道之①):写 snapshot.unfreeze(临时恢复 lead 干预原子,留痕)+ 回流队列消息
 * (用户可见)+ TEAM_WATCHDOG_ALERT 事件 → ChatEngine drain 既有骨架唤醒 lead;
 * 平息收回:看板恢复活动或无未决项 → 自动收回;解冻后 M 分钟未平息 → 升级提醒(每团队每事件一次)。
 * 通道②用户指令(team_policy//team policy)与③lead 申请不在本服务(前台的既有通道)。
 */

import { eventBus, EVENTS } from '../../utils/eventBus'
import { getTaskRegistry } from '../delegation/taskRegistry'
import { getTeamRuntimeService, type TeamRuntimeService } from './TeamRuntimeService'
import { LEAD_GATEABLE_TOOLS } from './teamPolicy'
import type { BoardItem, TeamRunState, TeamUnfreeze } from './teamRuntimeTypes'

/** 团队级默认静默容忍(分钟;任务级 stagnationAfter 未声明时用它) */
export const TEAM_DEFAULT_STAGNATION_MIN = 10
/** 解冻后未平息的升级时限(分钟;每团队每事件只报一次) */
export const TEAM_WATCHDOG_ESCALATE_MIN = 30

export interface TeamWatchdogOptions {
  /** 测试可调:覆盖团队级默认静默容忍(分钟) */
  stagnationMin?: number
  /** 测试可调:升级时限(分钟) */
  escalateAfterMin?: number
}

const TYPE_LABEL: Record<string, string> = {
  conflict: '冲突',
  budget: '预算异常',
  stagnation: '停滞',
}

let unsubscribe: (() => void) | undefined
let stagnationTimer: ReturnType<typeof setTimeout> | undefined
let escalateTimer: ReturnType<typeof setTimeout> | undefined
let escalateFiredForUnfreezeAt: number | undefined
/** 节流:runId:type:itemId 每团队每事件只报一次 */
const firedKeys = new Set<string>()
let opts: TeamWatchdogOptions = {}

export function startTeamWatchdog(options?: TeamWatchdogOptions): void {
  stopTeamWatchdog()
  opts = options ?? {}
  const svc = getTeamRuntimeService()
  if (!svc) return
  unsubscribe = svc.onChange(recompute)
  recompute()
}

export function stopTeamWatchdog(): void {
  unsubscribe?.()
  unsubscribe = undefined
  clearStagnationTimer()
  clearEscalateTimer()
  firedKeys.clear()
  escalateFiredForUnfreezeAt = undefined
}

/** 测试用:重置节流记录(不触碰订阅) */
export function resetTeamWatchdogFired(): void {
  firedKeys.clear()
  escalateFiredForUnfreezeAt = undefined
}

function clearStagnationTimer(): void {
  if (stagnationTimer) {
    clearTimeout(stagnationTimer)
    stagnationTimer = undefined
  }
}

function clearEscalateTimer(): void {
  if (escalateTimer) {
    clearTimeout(escalateTimer)
    escalateTimer = undefined
  }
}

function recompute(): void {
  const svc = getTeamRuntimeService()
  const team = svc?.getActiveTeam()
  if (!svc || !team) {
    clearStagnationTimer()
    clearEscalateTimer()
    return
  }

  // ① 冲突:同一条目被成员/Lead 退回 ≥2 次
  // (只计人为退回:by='system' 的死亡自动回流是"回收"不是"认领困难"——
  // 实测误报:timeout 杀死的自动回流 + 1 次成员纪律退回被凑成 2 次触发)
  for (const item of team.board) {
    const humanReleases = (item.releaseHistory ?? []).filter((r) => r.by !== 'system')
    if (humanReleases.length >= 2) {
      const last = humanReleases.at(-1)!
      tryFire(svc, team, 'conflict', item.id, `看板条目 [${item.id}] ${item.title} 已被退回 ${humanReleases.length} 次(最近:${last.by} 退回,原因:${last.reason})——疑似认领困难或职责错配`)
    }
  }

  // ② 预算异常:token 消耗超上限
  const budget = team.snapshot?.budget
  const spent = team.ledger?.spentTokens
  if (budget?.maxTokens !== undefined && spent !== null && spent !== undefined && spent > budget.maxTokens) {
    tryFire(svc, team, 'budget', 'ledger', `团队 token 消耗 ${spent} 已超过预算上限 ${budget.maxTokens}(进行中任务不受扩张闸拦截,消耗仍在增长)`)
  }

  // ③ 平息收回 / 升级计时(watchdog 解冻态)
  const unfreeze = team.snapshot?.unfreeze
  if (unfreeze?.by === 'watchdog') {
    const activityAfter = team.board.some((i) => i.updatedAt > unfreeze.at)
    const hasOpen = team.board.some((i) => i.status === 'pending' || i.status === 'in_progress')
    if (activityAfter || !hasOpen) {
      void svc.clearUnfreeze('平息收回:看板已恢复活动或无未决项')
      clearEscalateTimer()
    } else {
      scheduleEscalate(unfreeze)
    }
  } else {
    clearEscalateTimer()
  }

  // ④ 停滞:重算最近截止点,设一次性定时器
  scheduleStagnation(team)
}

function tryFire(svc: TeamRuntimeService, team: TeamRunState, type: 'conflict' | 'budget' | 'stagnation', itemId: string, reason: string): void {
  const key = `${team.runId}:${type}:${itemId}`
  if (firedKeys.has(key)) return
  firedKeys.add(key)
  const unfreeze: TeamUnfreeze = { by: 'watchdog', at: Date.now(), reason, restoredGrants: [...LEAD_GATEABLE_TOOLS] }
  void svc.setUnfreeze(unfreeze, `探测器解冻(${TYPE_LABEL[type]}):${reason}`)
  getTaskRegistry().enqueueTeamMessage({
    from: '系统探测器(watchdog)',
    content:
      `【团队异常 · ${TYPE_LABEL[type]}】${reason}\n` +
      `已临时解冻 Lead 的干预工具(${LEAD_GATEABLE_TOOLS.join('/')}),请 Lead 立即处置(可分派/纠偏/调整授权);` +
      `看板恢复活动后解冻自动收回,${opts.escalateAfterMin ?? TEAM_WATCHDOG_ESCALATE_MIN} 分钟未平息将升级提醒用户。`,
    at: Date.now(),
  })
  eventBus.emit(EVENTS.TEAM_WATCHDOG_ALERT, {})
}

/**
 * 停滞检测对象(判定归位:watchdog 管"没人推进",任务 timeout 管"有人推进但超时"):
 * pending(无人认领)与认领人非 running(idle/failed/standby/lead 认领)的条目才检测;
 * 认领人 running 的条目豁免——它有确定的生命周期上限(timeout ?? 600 双点缺省),
 * 空转被 timeout 杀死→死亡回流闭环,不需要 watchdog 重复盯防(上轮误报即此类)。
 */
function stagnantCandidates(team: TeamRunState): BoardItem[] {
  return team.board.filter((i) => {
    if (i.status === 'pending') return true
    if (i.status !== 'in_progress') return false
    if (!i.assignee || i.assignee === 'lead') return true
    return team.roster.find((e) => e.name === i.assignee)?.status !== 'running'
  })
}

function itemDeadline(item: BoardItem): number {
  const toleranceMin = item.stagnationAfter ?? opts.stagnationMin ?? TEAM_DEFAULT_STAGNATION_MIN
  return item.updatedAt + toleranceMin * 60_000
}

function scheduleStagnation(team: TeamRunState): void {
  clearStagnationTimer()
  const items = stagnantCandidates(team)
  if (items.length === 0) return
  const earliest = Math.min(...items.map(itemDeadline))
  const delay = Math.max(earliest - Date.now(), 0)
  stagnationTimer = setTimeout(() => {
    stagnationTimer = undefined
    const svc = getTeamRuntimeService()
    const current = svc?.getActiveTeam()
    if (!svc || !current) return
    // 到期复查(定时器是"最近截止点"快照,期间状态可能已变;只报确实过期且未报过的)
    const now = Date.now()
    for (const item of stagnantCandidates(current)) {
      if (itemDeadline(item) <= now) {
        const mins = Math.round((now - item.updatedAt) / 60_000)
        tryFire(svc, current, 'stagnation', item.id, `看板条目 [${item.id}] ${item.title} 已 ${mins} 分钟无进展(状态 ${item.status}${item.assignee ? `,认领人 ${item.assignee}` : ',无人认领'})——团队疑似停滞`)
      }
    }
    // 复查后重排(可能还有未到期项)
    scheduleStagnation(current)
  }, delay)
}

function scheduleEscalate(unfreeze: TeamUnfreeze): void {
  if (escalateFiredForUnfreezeAt === unfreeze.at) return
  clearEscalateTimer()
  const deadline = unfreeze.at + (opts.escalateAfterMin ?? TEAM_WATCHDOG_ESCALATE_MIN) * 60_000
  const delay = Math.max(deadline - Date.now(), 0)
  escalateTimer = setTimeout(() => {
    escalateTimer = undefined
    const svc = getTeamRuntimeService()
    const current = svc?.getActiveTeam()
    if (!svc || !current || current.snapshot?.unfreeze?.at !== unfreeze.at) return
    if (escalateFiredForUnfreezeAt === unfreeze.at) return
    escalateFiredForUnfreezeAt = unfreeze.at
    getTaskRegistry().enqueueTeamMessage({
      from: '系统探测器(watchdog)',
      content:
        `【升级提醒】团队异常(${unfreeze.reason})解冻已 ${opts.escalateAfterMin ?? TEAM_WATCHDOG_ESCALATE_MIN} 分钟仍未平息。` +
        '请用户关注:可直接指示 Lead 收紧(如"现在你来管"),或用 /team policy 直接调整授权。',
      at: Date.now(),
    })
    eventBus.emit(EVENTS.TEAM_WATCHDOG_ALERT, {})
  }, delay)
}
