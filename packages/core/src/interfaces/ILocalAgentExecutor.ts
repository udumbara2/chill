export interface AgentLoadResult {
  success: boolean
  agent?: any
  error?: string
}

export interface AgentExecuteResult {
  success: boolean
  result?: any
  error?: string
}

export interface ILocalAgentExecutor {
  agentLoad(id: string): Promise<AgentLoadResult>
  a2aExecuteTask(agent: any, params: Record<string, any>): Promise<AgentExecuteResult>
}
