import type { ToolDefinition } from '../types/models'

/**
 * 委派执行的下行附加信息（success_criteria 贯通 / 评审回路 / resume 种子续聊共用）：
 * 一个参数对象承载全部新增下行信息，避免 execute 连续加位置参数。
 */
export interface SubagentExecuteExtras {
  /** 任务成功标准（task 的 success_criteria 贯通到 Worker 的 userMessage） */
  successCriteria?: string
  /** 是否要求验证闭环（评审回路：独立评审 agent 核验证据，不达标打回修正） */
  requireReview?: boolean
  /** resume 种子消息（原任务的完整对话 transcript；存在时 Worker 以其为对话起点续聊） */
  priorMessages?: unknown[]
  /** 团队成员标记(下行到 Worker:注入 team_board/team_status 定义;安全判定在宿主网关,此标记仅管可见性) */
  teamMember?: boolean
  /** 团队信箱未读提示(种子注入的统一 drain 形态;成员开工即见全部积压消息) */
  inboxNote?: string
  /** 计划批准门(阶段 1:只读规划,effectiveTools 强制剔修改性,输出"【待批准的计划】") */
  requirePlan?: boolean
  /** 编排工具池豁免(迭代 3:授权快照授予的编排工具名,pool/available_tools 的编排过滤对它放行) */
  grantedOrchestrationTools?: string[]
}

export interface ISubagentExecutor {
  execute(
    template: Record<string, unknown>,
    taskDescription: string,
    mergedParams: Record<string, unknown>,
    startTime: number,
    tools?: ToolDefinition[],
    availableTools?: string[],
    apiKey?: string,
    baseURL?: string,
    /** 注册表环境绑定键（toolCall.id，cancel_task 的 destroy 通道；缺省回退执行器内部 taskId） */
    environmentKey?: string,
    /** 下行附加信息（成功标准/评审标记/resume 种子；缺省行为与既有语义一致） */
    extras?: SubagentExecuteExtras
  ): Promise<Record<string, unknown>>
}
