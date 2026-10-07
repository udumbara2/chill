/**
 * board 工具(会话级共享看板 · V1.6)
 *
 * 身份与权限纪律(决策 9):
 * - 调用方身份只从网关注入的 __origin 解析(taskId 反查工位登记;参数自报身份字段一律忽略);
 * - Lead 全权(含 remove/adjudicate/unblock/cancel_item);worker=read/claim/update 自己条目 note/release 自己/post;
 * - 免审批:看板是内存+快照工具,非文件写工具——不进 PreToolUse 文件写审批面(与 team_board 同规则)。
 * 单一工具 action 参数化;归属约束的结构性判定在 boardCore(仅认领人或 Lead/仅 Lead),本层再收窄
 * worker 的 update 面(只许 note)与强制归属(by/assignee/taskId 一律取工位登记,不听自报)。
 */

import type { ToolDefinition } from '../../types/models'
import {
  getSessionBoardService,
  type SessionBoardService,
} from './SessionBoardService'
import { BOARD_STATUS_LABEL } from './boardProjection'
import { BoardError, type BoardCaller, type BoardItem } from './boardTypes'

/** 板工具名单(网关/工具分类共用) */
export const BOARD_TOOL_NAME = 'board'

/** worker 的系统提示 note 行为契约(只注入 Worker 环境;主会话不注入) */
export const BOARD_NOTE_CONTRACT =
  '【看板 note 约定】你是会话看板上的工位，名下条目已在开工时自动认领。关键节点请用 board 工具的 update 动作写 note（最新进展，一两句话即可）：开工定调、取得阶段性结果、遇到阻塞或需要拍板时都要更新——Lead 与用户据此看见推进情况；任务交付由系统自动结项，你不必自行置终态。'

export const boardToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: BOARD_TOOL_NAME,
    description:
      '会话共享看板(多方读写的任务契约;create_task_list 只是你自己的私人草稿,成员不可见)。' +
      '动作:read 读(不传 id=列表,每条一行摘要;传 id=该项全文);post 挂任务项;claim 领下一条(仅 pending 可成;可带 id 领指定条目,无 id=领最早待认领;意图认领——你跑完当前任务时系统自动拉起你领的下一条);' +
      'update 更新进展 note(仅认领人;关键节点必写——开工/阶段性结果/受阻时各写一两句话);' +
      'release 退回(仅认领人或 Lead,必填原因,可附建议人选);remove 删除(仅 Lead);' +
      'adjudicate 裁决待裁决条目(仅 Lead:cancel=终止 / retry=回池再试);unblock 解除需拍板(仅 Lead);cancel_item 撤单(仅 Lead)。' +
      '结项纪律:做完等系统自动结项,不要自行置终态;做不了的任务用 release 退回并写明原因,不要烂在手里。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'post', 'claim', 'update', 'release', 'remove', 'adjudicate', 'unblock', 'cancel_item'],
          description: '看板动作',
        },
        id: { type: 'string', description: '条目 id(claim/update/release/remove/adjudicate/unblock/cancel_item 必填;read 单项全文时传)' },
        title: { type: 'string', description: '任务项标题(post 必填)' },
        description: { type: 'string', description: '任务项说明(post 可选)' },
        batch_id: { type: 'string', description: 'post 可选:批次 id(分组属性)' },
        note: { type: 'string', description: '最新进展(update 用,限长 4KB;post 可选作发帖说明)' },
        result: { type: 'string', description: '交付结果摘要(update 仅 Lead 可写,限长 4KB)' },
        stagnation_after: { type: 'number', description: 'update 仅 Lead 可写:该任务的静默容忍分钟数' },
        reason: { type: 'string', description: 'release/cancel_item 必填:原因(留痕)' },
        suggested_to: { type: 'string', description: 'release 可选:建议的下一任认领人(工位名)' },
        decision: { type: 'string', enum: ['cancel', 'retry'], description: 'adjudicate 必填:cancel=终止 / retry=回池再试(失败计数保留)' },
      },
      required: ['action'],
    },
  },
}

interface BoardToolOrigin {
  source?: string
  taskId?: string
  subagentType?: string
}

const LEAD_ONLY_ACTIONS = new Set(['remove', 'adjudicate', 'unblock', 'cancel_item'])

function formatItemLine(item: BoardItem): string {
  const people = [item.assignee ? `认领:${item.assignee}` : '', `挂:${item.createdBy}`].filter(Boolean).join(' ')
  return `- [${item.id}] (${BOARD_STATUS_LABEL[item.status]}) ${item.title}  ${people}`
}

function formatItemFull(item: BoardItem): string {
  const lines = [`[${item.id}] ${item.title}(${BOARD_STATUS_LABEL[item.status]};认领:${item.assignee ?? '无'};挂:${item.createdBy})`]
  if (item.description) lines.push(`说明: ${item.description}`)
  if (item.batchId) lines.push(`批次: ${item.batchId}`)
  if (item.note) lines.push(`进展: ${item.note}`)
  if (item.result) lines.push(`结果: ${item.result}`)
  if (item.failCount) lines.push(`失败计数: ${item.failCount}`)
  if (item.stagnationAfter) lines.push(`静默容忍: ${item.stagnationAfter} 分钟`)
  if (item.releaseHistory && item.releaseHistory.length > 0) {
    lines.push('留痕:')
    for (const r of item.releaseHistory) {
      lines.push(`- [${new Date(r.at).toLocaleString()}] ${r.by}: ${r.reason}${r.suggestedTo ? `(建议:${r.suggestedTo})` : ''}`)
    }
  }
  lines.push(`创建于 ${new Date(item.createdAt).toLocaleString()},更新于 ${new Date(item.updatedAt).toLocaleString()}`)
  return lines.join('\n')
}

/**
 * 调用方身份解析(参数自报无效):
 * 非 Worker 来源=Lead 全权;Worker 经 taskId 反查工位登记(绕过 spawn 点的存量任务按 subagentType 现场派生)。
 */
async function resolveBoardCaller(
  svc: SessionBoardService,
  sessionId: string,
  origin?: BoardToolOrigin,
): Promise<{ caller: BoardCaller; workstation: string } | { error: string }> {
  if (!origin || origin.source !== 'subagent') {
    return { caller: { role: 'lead' }, workstation: 'lead' }
  }
  if (!origin.taskId) {
    return { error: '无法识别你的工位归属(__origin 缺 taskId)——看板变更已拒绝' }
  }
  const workstation = await svc.ensureWorkstation(sessionId, origin.taskId, origin.subagentType ?? 'worker')
  return { caller: { role: 'worker', assignee: workstation }, workstation }
}

export async function executeBoard(
  argsJson: string,
  origin?: BoardToolOrigin,
  sessionId?: string,
): Promise<{ success: boolean; data?: string; error?: string }> {
  let args: {
    action?: string
    id?: string
    title?: string
    description?: string
    batch_id?: string
    note?: string
    result?: string
    stagnation_after?: number
    reason?: string
    suggested_to?: string
    decision?: string
  }
  try {
    args = JSON.parse(argsJson)
  } catch {
    return { success: false, error: '解析 board 参数失败' }
  }
  const svc = getSessionBoardService()
  if (!svc) return { success: false, error: '会话看板服务未装配' }
  if (!sessionId) return { success: false, error: '无法识别会话归属(__origin 缺 sessionId)——看板操作已拒绝' }
  const action = args.action
  if (!action) return { success: false, error: 'board 缺少 action 参数' }

  const resolved = await resolveBoardCaller(svc, sessionId, origin)
  if ('error' in resolved) return { success: false, error: resolved.error }
  const { caller, workstation } = resolved

  if (LEAD_ONLY_ACTIONS.has(action) && caller.role !== 'lead') {
    return { success: false, error: `board ${action} 仅 Lead 可用(Worker 可用: read/post/claim/update note/release 自己条目)` }
  }

  try {
    switch (action) {
      case 'read': {
        const { items, revision } = await svc.readBoard(sessionId)
        if (args.id) {
          const item = items.find((i) => i.id === args.id)
          if (!item) return { success: false, error: `看板条目 ${args.id} 不存在` }
          return { success: true, data: formatItemFull(item) }
        }
        const lines = items.length > 0 ? items.map(formatItemLine) : ['(空)']
        return { success: true, data: `看板(版本 ${revision}):\n${lines.join('\n')}` }
      }
      case 'post': {
        if (!args.title?.trim()) return { success: false, error: 'post 缺少 title' }
        const item = await svc.post(sessionId, {
          title: args.title,
          description: args.description,
          batchId: args.batch_id,
          createdBy: workstation,
          note: args.note,
        })
        return { success: true, data: `已挂项 [${item.id}] ${item.title}` }
      }
      case 'claim': {
        // V3.1 拉活:claim=「领下一条」意图态——不绑任务键(续跑时换绑),可带 id 领指定条目,
        // 无 id=领最早 pending。归属强制:认领人=本工位(参数自报无效)
        let targetId = args.id
        if (!targetId) {
          const { items } = await svc.readBoard(sessionId)
          const earliest = items
            .filter((i) => i.status === 'pending')
            .sort((a, b) => a.createdAt - b.createdAt)[0]
          if (!earliest) return { success: false, error: '没有待认领条目(板上无 pending)' }
          targetId = earliest.id
        }
        const item = await svc.claim(sessionId, targetId, { assignee: workstation })
        return { success: true, data: `已认领 [${item.id}] ${item.title}(意图认领,任务续跑时自动绑定)` }
      }
      case 'update': {
        if (!args.id) return { success: false, error: 'update 缺少 id' }
        // worker 只许更新自己条目的 note(Lead 全面)
        if (caller.role === 'worker') {
          if (args.result !== undefined || args.stagnation_after !== undefined) {
            return { success: false, error: 'update 的 result/stagnation_after 仅 Lead 可写;Worker 请只更新 note(最新进展)' }
          }
          if (args.note === undefined) return { success: false, error: 'update 缺少 note(Worker 的 update 仅用于写进展 note)' }
        }
        const res = await svc.update(sessionId, args.id, {
          note: args.note,
          result: args.result,
          stagnationAfter: args.stagnation_after,
        }, caller)
        const marks = [res.noteTruncated ? 'note 已截断' : '', res.resultTruncated ? 'result 已截断' : ''].filter(Boolean)
        return { success: true, data: `已更新 [${res.item.id}]${marks.length > 0 ? `(${marks.join(';')})` : ''}` }
      }
      case 'release': {
        if (!args.id) return { success: false, error: 'release 缺少 id' }
        if (!args.reason?.trim()) return { success: false, error: 'release 必须填写原因' }
        // 归属强制:by=本工位(Lead 经 'lead');boardCore 再复核仅认领人或 Lead
        const item = await svc.release(sessionId, args.id, {
          by: caller.role === 'lead' ? 'lead' : workstation,
          reason: args.reason,
          suggestedTo: args.suggested_to,
        })
        return { success: true, data: `已退回 [${item.id}] ${item.title}(回待认领)` }
      }
      case 'remove': {
        if (!args.id) return { success: false, error: 'remove 缺少 id' }
        await svc.remove(sessionId, args.id, caller)
        return { success: true, data: `已删除看板条目 ${args.id}` }
      }
      case 'adjudicate': {
        if (!args.id) return { success: false, error: 'adjudicate 缺少 id' }
        if (args.decision !== 'cancel' && args.decision !== 'retry') {
          return { success: false, error: "adjudicate 的 decision 必须是 'cancel' 或 'retry'" }
        }
        const item = await svc.adjudicate(sessionId, args.id, args.decision, caller)
        return { success: true, data: `已裁决 [${item.id}] → ${BOARD_STATUS_LABEL[item.status]}${item.failCount ? `(失败计数保留:${item.failCount})` : ''}` }
      }
      case 'unblock': {
        if (!args.id) return { success: false, error: 'unblock 缺少 id' }
        const item = await svc.unblock(sessionId, args.id, caller)
        return { success: true, data: `已解除需拍板 [${item.id}] → 进行中` }
      }
      case 'cancel_item': {
        if (!args.id) return { success: false, error: 'cancel_item 缺少 id' }
        // 留痕归属强制:by='lead'(用户撤单/会话删除经 Lead 侧;不听自报)
        const item = await svc.cancelItem(sessionId, args.id, { by: 'lead', reason: args.reason ?? '撤单' })
        return { success: true, data: `已撤单 [${item.id}] ${item.title}` }
      }
      default:
        return { success: false, error: `未知的 board action: ${action}` }
    }
  } catch (err) {
    if (err instanceof BoardError) return { success: false, error: err.message }
    return { success: false, error: err instanceof Error ? err.message : '看板操作失败' }
  }
}
