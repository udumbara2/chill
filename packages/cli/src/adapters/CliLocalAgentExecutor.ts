import type { ILocalAgentExecutor, AgentLoadResult, AgentExecuteResult } from '@assistant-ai/core'
import { AgentFileManager } from '@assistant-ai/core'
import { executeA2ATaskSync } from '@assistant-ai/core'
import type { SavedAgent, A2ATaskParams } from '@assistant-ai/core'

export class CliLocalAgentExecutor implements ILocalAgentExecutor {
  private agentFileManager: AgentFileManager

  constructor(agentFileManager: AgentFileManager) {
    this.agentFileManager = agentFileManager
  }

  async agentLoad(id: string): Promise<AgentLoadResult> {
    return this.agentFileManager.loadAgent(id) as unknown as AgentLoadResult
  }

  async a2aExecuteTask(agent: any, params: Record<string, any>): Promise<AgentExecuteResult> {
    var result = await executeA2ATaskSync(agent as unknown as SavedAgent, params as unknown as A2ATaskParams)
    return { success: true, result }
  }
}
