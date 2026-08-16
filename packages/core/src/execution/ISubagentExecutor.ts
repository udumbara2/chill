import type { ToolDefinition } from '../types/models'

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
    environmentKey?: string
  ): Promise<Record<string, unknown>>
}
