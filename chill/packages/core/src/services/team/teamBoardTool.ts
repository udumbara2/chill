/**
 * team_board / team_status 工具(迭代 1:团队共享看板 + 只读总览)
 *
 * 身份与权限纪律:
 * - 调用方身份只从网关注入的 __origin 解析(origin.taskId → roster 成员名;
 *   source!=='subagent' 即 Lead 全权),参数里任何自报身份字段一律忽略——Worker 不可伪造。
 * - Worker 侧的成员资格门在网关(TemplateSubagentForkManager)独立强制;
 *   此处再复核一道(纵深防御),非成员 Worker 响亮拒绝。
 * - 免审批:看板是团队协作内部状态,不触用户系统;变更类动作已在 plan 模式
 *   经 PLAN_MODE_BLOCKED_TOOLS 拦截(team_board),team_status 只读放行。
 */

import type { ToolDefinition } from '../../types/models'
import { getTeamRuntimeService, type TeamCaller } from './TeamRuntimeService'
import { routeTeamMessage } from './teamMessageRouter'
import { canBoardAction } from './teamPolicy'
import { formatTokenSpend } from './teamLedgerFormat'
import type { BoardItem, BoardItemStatus } from './teamRuntimeTypes'

/** 团队工具名单(网关成员资格门判定用) */
export const TEAM_TOOL_NAMES: readonly string[] = ['team_board', 'team_status', 'send_message']

export const teamBoardToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'team_board',
    description:
      '团队共享白板(多方读写的任务契约;注意:create_task_list 只是你自己的私人草稿,成员不可见——要让成员领活必须挂到这里)。' +
      '动作:post 挂任务项(人人可挂,可带 stagnation_after 声明该任务的静默容忍分钟数,缺省用团队默认;' +
      '若该活是把任务清单某项分解出来的,带 parent_task_id=<清单项 id>——工作计划树据此把本行嵌进父项,不带则按根层并列显示);claim 认领(仅 pending 可成,防两人撞同一活);' +
      'release 退回认领池(仅认领人或 Lead;必填原因,可附建议人选;退回后条目回到待认领,他人可领);' +
      'update 更新状态/附交付结果(仅认领人或 Lead);read 读(不传 id=列表,每条一行摘要;传 id=该项全文);remove 删除(仅 Lead);' +
      'adjudicate 裁决待裁决条目(仅 Lead;decision=retry 回池再试[失败计数保留]/cancel 终止)。' +
      '结项纪律:完成的工作项用 update 标 completed 并附结果摘要;团队成员开工前先 read 看板、做完认领下一项;做不了的任务用 release 退回并写明原因,不要烂在手里。' +
      '需要联系其他成员时用 send_message;看全局用 team_status;协作权限由授权快照门控(team_policy read 可查)。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['post', 'claim', 'release', 'update', 'read', 'remove', 'adjudicate'], description: '看板动作' },
        id: { type: 'string', description: '条目 id(claim/release/update/remove/read/adjudicate 单项时必填)' },
        title: { type: 'string', description: '任务项标题(post 必填)' },
        description: { type: 'string', description: '任务项说明(post 可选)' },
        stagnation_after: { type: 'number', description: 'post 可选:该任务的静默容忍分钟数(超过无进展视为停滞;缺省用团队默认)' },
        parent_task_id: { type: 'string', description: 'post 可选:分解链——本条目由任务清单哪一项分解而来(=该清单项 id;工作计划树显示据此把本行嵌进父项,缺省=无链根层并列)' },
        reason: { type: 'string', description: 'release 必填:退回原因(留痕,帮助 Lead 与下一位认领人)' },
        suggested_to: { type: 'string', description: 'release 可选:建议的下一任认领人(成员名)' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: '目标状态(update 可选)' },
        result: { type: 'string', description: '交付结果摘要(update 可选,限长 4KB)' },
        decision: { type: 'string', enum: ['cancel', 'retry'], description: 'adjudicate 必填:retry=回池再试(失败计数保留)/cancel=终止' },
      },
      required: ['action'],
    },
  },
}

export const teamStatusToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'team_status',
    description:
      '团队只读总览(免审批):花名册(成员/角色/状态)+ 看板快照(各状态计数与每条一行摘要)+ runId 与归档目录。' +
      'Lead 巡查用——成员结项靠自觉,若发现"活干完了板上还挂着",用 team_board 提醒或代行 update。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}

interface TeamToolOrigin {
  source?: string
  taskId?: string
}

/** 调用方身份解析:Lead 全权;Worker 经 roster 反查成员名(自报字段不参与) */
function resolveCaller(origin?: TeamToolOrigin): { caller?: TeamCaller; error?: string } {
  const svc = getTeamRuntimeService()
  if (!svc) return { error: '团队运行时服务未装配' }
  if (!svc.getActiveTeam()) {
    return {
      error: '当前没有活动团队。成队方式:use_team 激活固定团队,或 task/batch_task 带 as_teammate:true 组建临时团队。',
    }
  }
  if (origin?.source === 'subagent') {
    const memberName = svc.getMemberNameByTaskId(origin.taskId)
    if (!memberName) return { error: '只有团队成员才能执行该操作(你不是当前团队的成员)' }
    return { caller: memberName }
  }
  return { caller: 'lead' }
}

const STATUS_LABEL: Record<BoardItemStatus, string> = {
  pending: '待认领',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  blocked: '需拍板',
  cancelled: '已取消',
}

function formatItemLine(item: BoardItem): string {
  const people = [item.assignee ? `认领:${item.assignee}` : '', `挂:${item.createdBy}`].filter(Boolean).join(' ')
  return `- [${item.id}] (${STATUS_LABEL[item.status]}) ${item.title}  ${people}`
}

function formatItemFull(item: BoardItem): string {
  const lines = [formatItemFullHeader(item)]
  if (item.description) lines.push(`说明: ${item.description}`)
  if (item.result) lines.push(`结果: ${item.result}`)
  if (item.stagnationAfter) lines.push(`静默容忍: ${item.stagnationAfter} 分钟`)
  if (item.releaseHistory && item.releaseHistory.length > 0) {
    lines.push('退回历史:')
    for (const r of item.releaseHistory) {
      lines.push(`- [${new Date(r.at).toLocaleString()}] ${r.by} 退回:${r.reason}${r.suggestedTo ? `(建议下一任:${r.suggestedTo})` : ''}`)
    }
  }
  lines.push(`创建于 ${new Date(item.createdAt).toLocaleString()},更新于 ${new Date(item.updatedAt).toLocaleString()}`)
  return lines.join('\n')
}

function formatItemFullHeader(item: BoardItem): string {
  return `[${item.id}] ${item.title}(${STATUS_LABEL[item.status]};认领:${item.assignee ?? '无'};挂:${item.createdBy})`
}

export async function executeTeamBoard(
  argsJson: string,
  origin?: TeamToolOrigin,
): Promise<{ success: boolean; data?: string; error?: string }> {
  let args: { action?: string; id?: string; title?: string; description?: string; stagnation_after?: number; parent_task_id?: string; reason?: string; suggested_to?: string; status?: BoardItemStatus; result?: string; decision?: string }
  try {
    args = JSON.parse(argsJson)
  } catch {
    return { success: false, error: '解析 team_board 参数失败' }
  }
  const { caller, error } = resolveCaller(origin)
  if (error || !caller) return { success: false, error: error ?? '身份解析失败' }
  const svc = getTeamRuntimeService()!

  // 授权快照门控(迭代 2;SSOT=teamPolicy.canBoardAction):变更类动作按 grant 判定;
  // 无授权响亮失败并指引请示通道(豁免永可用);快照缺省=默认语义(全放行,向后兼容)
  const action = args.action ?? ''
  if (['post', 'claim', 'release', 'update', 'remove', 'adjudicate'].includes(action) && !canBoardAction(svc.getSnapshot(), caller, action)) {
    return {
      success: false,
      error: `当前授权快照未授予你 team_board 的 ${action} 权限。可经 send_message 向 Lead 请示(请示通道永远可用),由 Lead 调整授权(team_policy)或代为执行。`,
    }
  }

  try {
    switch (args.action) {
      case 'post': {
        if (!args.title) return { success: false, error: 'post 缺少必填参数 title' }
        if (args.stagnation_after !== undefined && (typeof args.stagnation_after !== 'number' || args.stagnation_after <= 0)) {
          return { success: false, error: 'stagnation_after 必须是正数(分钟)' }
        }
        if (args.parent_task_id !== undefined && (typeof args.parent_task_id !== 'string' || !args.parent_task_id.trim())) {
          return { success: false, error: 'parent_task_id 必须是非空字符串(=任务清单项 id)' }
        }
        const { item, revision } = await svc.boardPost({ title: args.title, description: args.description, createdBy: caller, stagnationAfter: args.stagnation_after, parentTaskId: args.parent_task_id })
        return { success: true, data: `已挂上看板 [${item.id}] ${item.title}(白板版本 ${revision})` }
      }
      case 'claim': {
        if (!args.id) return { success: false, error: 'claim 缺少必填参数 id' }
        const { item, revision } = await svc.boardClaim(args.id, caller)
        return { success: true, data: `已认领 [${item.id}] ${item.title}(白板版本 ${revision})。完成后记得 update 结项并附结果摘要;做不了就 release 退回并写明原因。` }
      }
      case 'release': {
        if (!args.id) return { success: false, error: 'release 缺少必填参数 id' }
        if (!args.reason) return { success: false, error: 'release 缺少必填参数 reason(退回原因,留痕并帮助下一位认领人)' }
        const { item, revision, previousAssignee } = await svc.boardRelease(args.id, caller, { reason: args.reason, suggestedTo: args.suggested_to })
        // Lead 退回他人认领的任务时通知原认领人(复用消息路由;成员自己退回无需通知)
        if (caller === 'lead' && previousAssignee && previousAssignee !== 'lead') {
          await routeTeamMessage(
            'lead',
            previousAssignee,
            `你认领的任务 [${item.id}] ${item.title} 已被 Lead 退回归领池。原因:${args.reason}${args.suggested_to ? `;建议下一任:${args.suggested_to}` : ''}。如需说明情况请回复,或认领其他待认领任务。`,
          )
        }
        return { success: true, data: `已退回 [${item.id}] ${item.title} 到认领池(白板版本 ${revision})。原因已留痕${args.suggested_to ? `,建议下一任:${args.suggested_to}` : ''}。` }
      }
      case 'update': {
        if (!args.id) return { success: false, error: 'update 缺少必填参数 id' }
        if (!args.status && args.result === undefined) return { success: false, error: 'update 需要 status 或 result 至少其一' }
        const { item, revision, resultTruncated } = await svc.boardUpdate(args.id, caller, { status: args.status, result: args.result })
        const truncatedNote = resultTruncated ? '(结果超出 4KB 已截断)' : ''
        return { success: true, data: `已更新 [${item.id}] ${item.title} → ${STATUS_LABEL[item.status]}${truncatedNote}(白板版本 ${revision})` }
      }
      case 'read': {
        if (args.id) {
          const item = svc.boardGet(args.id)
          if (!item) return { success: false, error: `看板条目 ${args.id} 不存在` }
          return { success: true, data: formatItemFull(item) }
        }
        const list = svc.boardList()!
        if (list.items.length === 0) return { success: true, data: `(白板为空,版本 ${list.revision})。用 team_board(post) 挂任务项。` }
        return {
          success: true,
          data: `# 团队看板(版本 ${list.revision})\n${list.items.map(formatItemLine).join('\n')}`,
        }
      }
      case 'remove': {
        if (!args.id) return { success: false, error: 'remove 缺少必填参数 id' }
        const { revision } = await svc.boardRemove(args.id, caller)
        return { success: true, data: `已删除看板条目 ${args.id}(白板版本 ${revision})` }
      }
      case 'adjudicate': {
        // 裁决(仅 Lead——boardCore 结构性拒绝非 Lead):failed(待裁决)三出口之一,会话一句话=先 read 再裁决
        if (!args.id) return { success: false, error: 'adjudicate 缺少必填参数 id' }
        if (args.decision !== 'cancel' && args.decision !== 'retry') {
          return { success: false, error: "adjudicate 缺少必填参数 decision('retry'=回池再试/'cancel'=终止)" }
        }
        const { item, revision } = await svc.boardAdjudicate(args.id, args.decision, caller)
        return {
          success: true,
          data: `已裁决 [${item.id}] ${item.title} → ${STATUS_LABEL[item.status]}${item.failCount ? `(失败计数保留:${item.failCount})` : ''}(白板版本 ${revision})`,
        }
      }
      default:
        return { success: false, error: `未知动作 "${args.action ?? '(空)'}"(可选: post/claim/release/update/read/remove/adjudicate)` }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '看板操作失败' }
  }
}

export async function executeTeamStatus(
  _argsJson: string,
  origin?: TeamToolOrigin,
): Promise<{ success: boolean; data?: string; error?: string }> {
  const svc = getTeamRuntimeService()
  if (!svc) return { success: false, error: '团队运行时服务未装配' }
  // 探针去刺(迭代 2):只读探查对"不存在"应答"空"而非"错"(指引文案保留,错误形态消除);
  // 写操作(team_board post/claim/update/release)仍走 resolveCaller 报错,语义一字不动
  if (!svc.getActiveTeam()) {
    return {
      success: true,
      data: '当前没有活动团队。成队方式:use_team 激活固定团队,或 task/batch_task 带 as_teammate:true 组建临时团队。',
    }
  }
  const { error } = resolveCaller(origin)
  if (error) return { success: false, error }
  const team = svc.getActiveTeam()!

  const memberStatusLabel: Record<string, string> = { standby: '待命', running: '执行中', idle: '空闲', failed: '失败' }
  const rosterLines = team.roster.map(
    (e) => `- ${e.name}(@${e.agent}${e.role ? `,${e.role}` : ''}):${e.planPending ? '待批准(计划已交付,用 approve_plan 批准或打回)' : (memberStatusLabel[e.status] ?? e.status)}`,
  )
  const counts: Record<BoardItemStatus, number> = { pending: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 }
  for (const item of team.board) counts[item.status]++

  const unread = await svc.unreadCounts()
  const unreadText =
    Object.keys(unread).length > 0
      ? Object.entries(unread).map(([m, n]) => `${m}: ${n} 条`).join(',')
      : '无'

  const lines = [
    `# 团队状态:${team.name ? `「${team.name}」` : '临时团队'}(runId: ${team.runId})`,
    '',
    `## 花名册(${team.roster.length} 人)`,
    ...(rosterLines.length > 0 ? rosterLines : ['(空)']),
    '',
    `## 看板(版本 ${team.boardRevision}):待认领 ${counts.pending} / 进行中 ${counts.in_progress} / 已完成 ${counts.completed} / 失败 ${counts.failed}`,
    ...(team.board.length > 0 ? team.board.map(formatItemLine) : ['(空)']),
    '',
    `## 未读消息:${unreadText}`,
  ]
  // 预算段(迭代 3):账本(已用)对快照(上限);缺省不限时明示;token 三态(未知/~N(估值)/N)走 core 单一格式化点
  const budget = team.snapshot?.budget
  const ledger = team.ledger
  lines.push(
    '',
    `## 预算:人数 ${ledger?.memberCount ?? team.roster.length}/${budget?.maxMembers ?? '不限'} · ` +
      `token ${formatTokenSpend(ledger)}/${budget?.maxTokens ?? '不限'} · ` +
      `深度上限 ${budget?.maxDepth ?? '不限'}`,
  )
  return { success: true, data: lines.join('\n') }
}
