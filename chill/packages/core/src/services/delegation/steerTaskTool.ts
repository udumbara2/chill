/**
 * steer_task 工具:向运行中的 Worker(委派任务/工作流节点)注入中途指示
 *
 * 落地机制(不新增 IPC 通道):消息入 taskRegistry 的 steer 队列,
 * 宿主工具调用网关在该 Worker 下一次工具调用时随 TOOL_CALL_RESPONSE 捎带下发,
 * Worker 把它以"[来自 Lead 的中途指示]"前缀并入工具结果,模型自然看见并遵循。
 *
 * 时机限制:指示在下一次工具调用时生效;Worker 不再调工具时不落地
 * (任务已近尾声,用 resume_task 事后纠偏)。
 */

import type { ToolDefinition } from '../../types/models'
import { getTaskRegistry } from './taskRegistry'
import type { RegisteredTask } from './taskRegistry'

export const steerTaskToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'steer_task',
    description:
      '向一个仍在进行中的后台委派任务(或工作流节点)注入一条中途指示,引导其调整后续行动' +
      '(如"收窄到国内新闻""优先核实数据来源")。指示在该 Worker 下一次工具调用时生效;' +
      '若它不再调用工具则不会落地(任务已近尾声,改用 resume_task 事后纠偏)。' +
      '已落地(完成/失败/已取消)的任务不可注入。需用户审批。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '任务标识(委派时的 task_id 参数;与 toolCallId 二选一)',
        },
        toolCallId: {
          type: 'string',
          description: '任务的工具调用标识(注册表主键;与 task_id 二选一)',
        },
        message: {
          type: 'string',
          description: '要注入的中途指示(自然语言,一条;Worker 会以"来自 Lead 的中途指示"形式看到)',
        },
      },
      required: ['message'],
    },
  },
}

export interface SteerTaskResult {
  success: boolean
  data?: string
  error?: string
}

export interface SteerTaskPreview extends SteerTaskResult {
  /** 定位到的任务(审批展示用;校验失败为空) */
  task?: RegisteredTask
}

/** 校验与任务定位(审批前预览;不入队) */
export async function executeSteerTaskPreview(args: {
  task_id?: string
  toolCallId?: string
  message?: string
}): Promise<SteerTaskPreview> {
  const message = args.message?.trim()
  if (!message) return { success: false, error: 'message 不能为空(要注入的中途指示内容)' }
  const registry = getTaskRegistry()
  const task = args.toolCallId
    ? registry.getByToolCallId(args.toolCallId)
    : args.task_id
      ? registry.getByTaskId(args.task_id)
      : undefined
  if (!task) {
    const running = registry.listRunning().map((t) => `- ${t.taskId}(${t.subagentType}): ${t.description.slice(0, 40)}`)
    return {
      success: false,
      error: `未找到任务 ${args.toolCallId ?? args.task_id ?? '(未指定)'}。` +
        (running.length > 0 ? `进行中任务:\n${running.join('\n')}` : '当前没有进行中的后台任务。'),
    }
  }
  if (task.status !== 'running') {
    return { success: false, error: `任务 ${task.taskId} 已落地(${task.status}),不可注入中途指示;如需纠偏请用 resume_task。` }
  }
  return { success: true, task }
}

/** steer_task 执行(审批在 builtInToolExecutor 内,与 cancel_scheduled_task 同款确认通道) */
export async function executeSteerTask(args: {
  task_id?: string
  toolCallId?: string
  message?: string
}): Promise<SteerTaskResult> {
  const preview = await executeSteerTaskPreview(args)
  if (!preview.success || !preview.task) {
    return { success: preview.success, ...(preview.error ? { error: preview.error } : {}) }
  }
  const registry = getTaskRegistry()
  // 归因前缀在入队点自带(mergeSteerNote 只并入不加帽——团队消息经同队列,归属不可混淆)
  const attributed = `[来自 Lead 的中途指示]: ${args.message!.trim()}\n请结合该指示调整后续行动。`
  if (!registry.enqueueSteer(preview.task.toolCallId, attributed)) {
    return { success: false, error: `任务 ${preview.task.taskId} 没有活跃的 Worker 环境(可能即将结束),指示无法落地;如需纠偏请用 resume_task。` }
  }
  return {
    success: true,
    data: `中途指示已入队,将在任务 ${preview.task.taskId}(${preview.task.subagentType})下一次工具调用时生效。`,
  }
}
