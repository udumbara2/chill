import type { SubagentTemplate, DefaultParameters, TaskToolOutput } from '../types'
import { TaskExecutionStatus } from '../types'
import type { ILocalAgentExecutor } from '../../interfaces/ILocalAgentExecutor'

export class LocalA2AAdapter {
  private localAgentExecutor: ILocalAgentExecutor

  constructor(localAgentExecutor: ILocalAgentExecutor) {
    this.localAgentExecutor = localAgentExecutor
  }

  async execute(
    template: SubagentTemplate,
    taskDescription: string,
    _mergedParams: DefaultParameters,
    startTime: number
  ): Promise<TaskToolOutput> {
    try {
      const agentId = template.bridge_config?.agent_id
      if (!agentId) {
        throw new Error('Local Agent 模板缺少 agent_id')
      }

      const loadResult = await this.localAgentExecutor.agentLoad(agentId)
      if (!loadResult.success || !loadResult.agent) {
        throw new Error(`加载 Agent ${agentId} 失败: ${loadResult.error}`)
      }
      const savedAgent = loadResult.agent

      const a2aMessage = {
        role: 'user',
        parts: [{ type: 'text', text: taskDescription }]
      }

      const result = await this.localAgentExecutor.a2aExecuteTask(
        savedAgent,
        {
          id: `task-${Date.now()}`,
          message: a2aMessage
        }
      )

      const endTime = Date.now()

      if (result.success) {
        const a2aResult = result.result as any
        const outputText = a2aResult?.artifacts?.[0]?.parts?.map((p: any) => p.text).join('\n') || ''
        return {
          status: TaskExecutionStatus.COMPLETED,
          final_output: outputText,
          resource_usage: {
            execution_time: endTime - startTime,
            iterations: 1,
          },
        }
      } else {
        return {
          status: TaskExecutionStatus.FAILED,
          final_output: '',
          error_info: {
            code: 'LOCAL_A2A_ERROR',
            message: result.error || '本地A2A执行失败',
          },
        }
      }
    } catch (error) {
      return {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : '本地执行失败',
        },
      }
    }
  }
}
