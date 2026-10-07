/**
 * 团队状态上下文注入行(团队状态上下文注入 · 迭代 1)
 *
 * 定位:Lead 主会话每轮模型调用前注入的一行团队状态——拆掉 Lead 组队前"掉坑→爬坑"的
 *   固定剧目(根因=状态全盲:团队运行时状态不在 Lead 上下文里,唯一探针对"无团队"报错)。
 * 纪律:
 *   - 薄包装 buildRuntimeProjection(state, [])(摘要 SSOT,零新写计数/格式化逻辑——
 *     看板计数/账本三态/超预算判定全部取投影产物);
 *   - 固定一行、中性、不诱导组队;
 *   - Worker(fork 子进程)与 workflow 节点不装配 getter,天然不注入(prompt 零变化)。
 */

import type { TeamRunState, TeamMemberStatus } from './teamRuntimeTypes'
import { buildRuntimeProjection } from './runtimeProjection'

/** 无团队时的中性一行(指引成队方式但不诱导:不需要协作时明示忽略本行;
 *  顺序含义必须点破——实测:Lead 明知"没有团队"仍先试挂看板再失败,因为没说看板依赖团队) */
export const NO_TEAM_CONTEXT_LINE =
  '当前没有活动团队(仅当任务需要多人协作时才用 use_team 或 task 带 as_teammate:true 成队;看板等团队工具须先成队后才可用;不需要协作时忽略本行)'

const MEMBER_STATUS_LABEL: Record<TeamMemberStatus, string> = {
  running: '执行中',
  idle: '空闲',
  standby: '待命',
  failed: '失败',
}

/**
 * 团队状态注入行:
 * 无团队 → 中性指引行;有团队 → 一行摘要(团队名/临时团队 · 成员 N(各状态计数) · 看板四计数 · 账本行含已超标注)。
 */
export function buildTeamContextLine(teamState: TeamRunState | null | undefined): string {
  const team = buildRuntimeProjection(teamState, []).team
  if (!team) return NO_TEAM_CONTEXT_LINE

  // 成员各状态计数(只取非零项;成员行与状态由投影供给,此处仅聚合计数)
  const statusCounts = new Map<TeamMemberStatus, number>()
  for (const m of team.members) statusCounts.set(m.status, (statusCounts.get(m.status) ?? 0) + 1)
  const statusText = [...statusCounts.entries()].map(([s, n]) => `${MEMBER_STATUS_LABEL[s]}${n}`).join('/')
  const memberText = `成员 ${team.members.length}${statusText ? `(${statusText})` : ''}`

  const b = team.boardCounts
  const boardText = `看板 待认领${b.pending}/进行中${b.inProgress}/已完成${b.completed}/失败${b.failed}`
  const ledgerText = `账本 ${team.ledgerText}${team.overBudget ? '(已超)' : ''}`

  return `${team.name ? `团队「${team.name}」` : '临时团队'} · ${memberText} · ${boardText} · ${ledgerText}`
}
