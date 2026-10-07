/**
 * approve_plan 工具(迭代 3:计划批准门的 Lead 引导路径)
 *
 * 阶段 1(只读规划)完成后,Lead 用本工具批准或打回:
 * - 批准:以根任务 transcript 的 planOriginalTools 扩容续跑(undefined=模板默认,直接透传——
 *   transcript 留存的是 Lead 原始 available_tools,readonly 过滤只在 executor 的 effectiveTools 层,
 *   不碰 transcript;切勿传 ['all']:'all' 关键字只在模板层有意义,available_tools 里不是合法输入,
 *   会被 typo 校验当字面量拒绝)。
 *   requireReview 透传(require_plan + require_review 组合开时评审不在批准路径静默丢失);
 *   批准轮 require_plan: false(阶段 2 不再只读),打回轮 require_plan: true(保持只读规划)。
 * - 打回:轮数+1(封顶 2)后以只读留存集续跑修订;轮次沿 parentToolCallId 链归并到根任务
 *   (打回即 resume,每轮新 toolCallId,不归并则封顶失效)。
 * 本工具是引导路径(轮次封顶+自动算工具集);resume_task 是手动路径(自由但不受轮次封顶管束)。
 * 免用户审批(Lead 的内部编排决策,不触用户系统);
 * 已入 ORCHESTRATION_TOOL_NAMES(Worker 永不达)与 PLAN_MODE_BLOCKED_TOOLS(批准=启动真实执行)。
 */

import type { ToolDefinition } from '../../types/models'
import { getTaskRegistry } from './taskRegistry'
import { executeResumeTask, type TaskManagementResult } from './delegationTools'

/** 打回轮次上限(防无限规划空转;CC 无上限是常驻 teammate 场景,chill Worker 是任务级,空转即烧钱) */
const MAX_PLAN_ROUNDS = 2

export const approvePlanToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'approve_plan',
    description:
      '计划批准门:对 require_plan/plan_first 任务交付的【待批准的计划】做出批准或打回。' +
      '批准(approved=true)后成员带完整工具严格按计划正式开工;打回(approved=false,附 feedback)成员以只读环境修订重报(最多两轮)。' +
      '仅对标记了 require_plan 的任务有效(可在任务结果中看到【待批准的计划】前缀)。' +
      '注意:本工具是引导路径(轮次封顶+自动选择工具集);也可以用 resume_task 手动追问(自由但不受轮次封顶管束)。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '计划任务的标识(交付【待批准的计划】的任务;打回轮次沿追问链归并到根任务)',
        },
        approved: {
          type: 'boolean',
          description: 'true=批准开工(带完整工具);false=打回修订(只读,需附 feedback)',
        },
        feedback: {
          type: 'string',
          description: '打回反馈(approved=false 时必填):计划哪里不行、怎么改——具体可执行',
        },
      },
      required: ['task_id', 'approved'],
    },
  },
}

/** 沿 parentToolCallId 链回溯到根任务 id(打回即 resume,每轮新 id,轮次计数与 planOriginalTools 都以根为准) */
function resolveRootToolCallId(key: string): string {
  const registry = getTaskRegistry()
  let id = key
  for (let i = 0; i < 20; i++) {
    const entry = registry.getByToolCallId(id) ?? registry.getByTaskId(id)
    if (!entry?.parentToolCallId) return entry?.toolCallId ?? id
    id = entry.parentToolCallId
  }
  return id
}

export async function executeApprovePlan(
  toolCallId: string,
  args: { task_id?: string; approved?: boolean; feedback?: string },
  deps?: { resume?: typeof executeResumeTask },
): Promise<TaskManagementResult> {
  const resume = deps?.resume ?? executeResumeTask
  const key = args.task_id
  if (!key) {
    return { success: false, error: 'approve_plan 需要提供 task_id(交付【待批准的计划】的任务标识)' }
  }
  const registry = getTaskRegistry()
  const transcript = registry.getTranscript(key)
  if (!transcript) {
    return {
      success: false,
      error: `该任务无执行上下文(${key}):可能未成功完成、上下文已被挤占、或进程已重启。请用 task 重新委派。`,
    }
  }
  if (!transcript.requirePlan) {
    return { success: false, error: `任务 ${key} 不是计划批准门任务(未带 require_plan)。普通任务请用 resume_task 追问纠偏。` }
  }

  const rootId = resolveRootToolCallId(key)
  const rootTranscript = registry.getTranscript(rootId) ?? transcript

  if (args.approved === true) {
    registry.clearPlanRounds(rootId)
    return resume(toolCallId, {
      toolCallId: key,
      message:
        '【计划已批准】你的计划已获 Lead 批准。请严格按已批准的计划正式执行(现在你有完整工具);' +
        '交付要求不变:最终回复须包含结果本体与验证证据。',
      available_tools: rootTranscript.planOriginalTools,
      require_review: transcript.requireReview === true,
      // 阶段 2 正式执行:不再只读(显式 false,覆盖 transcript 链条携带的 true)
      require_plan: false,
    })
  }

  if (args.approved === false) {
    if (!args.feedback || !args.feedback.trim()) {
      return { success: false, error: '打回(approved=false)需要非空的 feedback:计划哪里不行、怎么改' }
    }
    const rounds = registry.incrementPlanRound(rootId)
    if (rounds > MAX_PLAN_ROUNDS) {
      return {
        success: false,
        error:
          `计划打回已达 ${MAX_PLAN_ROUNDS} 轮上限(根任务 ${rootId}),不再发起第 ${rounds} 轮打回——` +
          '请改用 approve_plan 批准开工、steer_task 直接给出执行指示、或 cancel_task 终止该任务后重新委派。',
      }
    }
    return resume(toolCallId, {
      toolCallId: key,
      message:
        `【计划未批准·第 ${rounds}/${MAX_PLAN_ROUNDS} 轮打回】请根据以下反馈修订计划并重新交付完整计划` +
        `(仍为只读规划,禁止任何修改性操作):\n${args.feedback.trim()}`,
      available_tools: transcript.availableTools,
      // 打回轮保持只读规划(显式 true;executor 经此参数剔修改性工具)
      require_plan: true,
    })
  }

  return { success: false, error: 'approve_plan 需要显式的 approved 参数(true=批准开工 / false=打回修订)' }
}
