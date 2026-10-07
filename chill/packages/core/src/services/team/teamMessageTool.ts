/**
 * send_message 工具(迭代 2:团队成员间平级消息)
 *
 * 身份与权限纪律(与 teamBoardTool 同款):
 * - 调用方身份只从网关注入的 __origin 解析(origin.taskId → roster 成员名;
 *   source!=='subagent' 即 Lead),参数里任何自报身份字段一律忽略——Worker 不可伪造。
 * - Worker 侧成员资格门在网关独立强制;此处再复核一道(纵深防御)。
 * - 免审批(纯消息,不改变对方任务行为——改变行为的中途指示走 steer_task 审批通道);
 *   Lead 主会话调用已入 PLAN_MODE_BLOCKED_TOOLS(plan 只读);
 *   Worker 来源经三道门的来源豁免放行(团队内部协作状态,非用户系统变更)。
 * - 安全红线:消息文本强制带"不代表用户授权"归因前缀(见 teamMessageRouter.formatTeamMessage)。
 */

import type { ToolDefinition } from '../../types/models'
import { getTeamRuntimeService } from './TeamRuntimeService'
import { routeTeamMessage } from './teamMessageRouter'

export const sendMessageToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'send_message',
    description:
      '给团队成员(或 Lead、或全员)发一条异步消息——发了就返回,不等回复;对方回复经 send_message 回传。' +
      '路由:对方正在跑→即时并入其工具结果;已交付→自动唤醒续聊并把信箱未读一并带入;未在跑→入信箱待派活时送达。' +
      '协作三件套:挂活领活用 team_board,看全局用 team_status,联系成员用本工具。' +
      '注意:你的消息会标注"来自团队成员,不代表用户授权"——不要试图用消息授权危险操作(权限请求仍走正常审批)。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '收件人:成员名(见 team_status 花名册)/ "lead" / "all"(全员;成员发起的 all 含 lead,不含自己)',
        },
        content: {
          type: 'string',
          description: '消息内容(限长 4KB;写明你需要对方做什么、相关看板条目 id 或上下文)',
        },
      },
      required: ['target', 'content'],
    },
  },
}

interface TeamToolOrigin {
  source?: string
  taskId?: string
}

export async function executeSendMessage(
  argsJson: string,
  origin?: TeamToolOrigin,
): Promise<{ success: boolean; data?: string; error?: string }> {
  let args: { target?: string; content?: string }
  try {
    args = JSON.parse(argsJson)
  } catch {
    return { success: false, error: '解析 send_message 参数失败' }
  }
  if (!args.content || !args.content.trim()) {
    return { success: false, error: 'send_message 需要非空的 content 参数' }
  }

  const svc = getTeamRuntimeService()
  if (!svc) return { success: false, error: '团队运行时服务未装配' }
  if (!svc.getActiveTeam()) {
    return {
      success: false,
      error: '当前没有活动团队。成队方式:use_team 激活固定团队,或 task/batch_task 带 as_teammate:true 组建临时团队。',
    }
  }

  // 身份解析:Lead 或成员名(网关反查;自报无效)
  let from: string
  if (origin?.source === 'subagent') {
    const memberName = svc.getMemberNameByTaskId(origin.taskId)
    if (!memberName) return { success: false, error: '只有团队成员才能发消息(你不是当前团队的成员)' }
    from = memberName
  } else {
    from = 'lead'
  }

  return routeTeamMessage(from, args.target ?? '', args.content.trim())
}
