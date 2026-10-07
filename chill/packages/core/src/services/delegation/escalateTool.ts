/**
 * escalate_to_lead 工具:Worker 执行中向 Lead 上报请示(非阻塞)
 *
 * Worker 侧固定注册(不占 authorizedTools 名额;网关白名单豁免复核);
 * 宿主执行 = 上报内容入 taskRegistry.pendingEscalations 队列,
 * 经委派回流同款 drain 骨架(自然触发点合成消息)送达 Lead 执行上下文,
 * Lead 自主处置(补派/纠偏/调整分工)——用户仅同级可见,非默认行动方。
 * 阻塞式问答(Worker 暂停等 Lead 回复)不在本语义内。
 */

import type { ToolDefinition } from '../../types/models'
import { getTaskRegistry } from './taskRegistry'

/** Worker 可上报工具的名单常量(网关 authorizedTools 复核的白名单豁免;单点事实源) */
export const ESCALATE_TOOL_NAME = 'escalate_to_lead'

export const escalateToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: ESCALATE_TOOL_NAME,
    description:
      '(仅 Subagent/Worker 可用)执行中遇到拿不准的情况时向 Lead 上报请示:素材不足、范围过大、方向存疑、需要决策等。' +
      '上报是非阻塞的——调用后继续完成你能完成的部分;Lead 收到后会自主处置(补派/纠偏/调整分工),如需指示会随后到达。',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '上报内容(遇到的情况与影响)',
        },
        suggestion: {
          type: 'string',
          description: '可选:给 Lead 的处置建议(如"建议补充一轮调研""建议收窄主题")',
        },
      },
      required: ['message'],
    },
  },
}

/** escalate_to_lead 宿主执行:入 pendingEscalations 队列(drain 骨架送达 Lead) */
export async function executeEscalateToLead(argsJson: string, origin?: {
  source?: string
  subagentType?: string
  taskId?: string
}): Promise<{ success: boolean; data?: string; error?: string }> {
  let args: { message?: string; suggestion?: string }
  try {
    args = JSON.parse(argsJson)
  } catch {
    return { success: false, error: '解析 escalate_to_lead 参数失败' }
  }
  const message = args.message?.trim()
  if (!message) return { success: false, error: 'message 不能为空(上报内容)' }
  getTaskRegistry().enqueueEscalation({
    subagentType: origin?.subagentType ?? 'unknown',
    taskId: origin?.taskId,
    message,
    suggestion: args.suggestion?.trim() || undefined,
  })
  return {
    success: true,
    data: '已上报 Lead。请继续完成你能完成的部分;Lead 收到后会自主处置,如需指示会随后到达(可用 resume_task 追问或 steer_task 中途指示)。',
  }
}
