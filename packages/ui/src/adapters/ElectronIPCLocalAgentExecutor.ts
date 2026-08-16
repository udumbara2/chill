/// <reference path="../env.d.ts" />

import type { ILocalAgentExecutor, AgentLoadResult, AgentExecuteResult } from '@assistant-ai/core'

export class ElectronIPCLocalAgentExecutor implements ILocalAgentExecutor {
  async agentLoad(id: string): Promise<AgentLoadResult> {
    const result = await window.electronAPI.agentLoad(id)
    return result
  }

  async a2aExecuteTask(agent: any, params: Record<string, any>): Promise<AgentExecuteResult> {
    const result = await window.electronAPI.a2aExecuteTask(agent, params)
    return result
  }
}
