import type { MCPServerConfig } from '@assistant-ai/core'
import { MCPConnectionManager } from '@assistant-ai/core'
import type { IMCPClient } from '@assistant-ai/core'

export class CLIMCPClient implements IMCPClient {
  private manager = new MCPConnectionManager()
  private activeConnectionId: string | undefined = undefined

  private resolveConnectionId(connectionId?: string): string {
    const id = connectionId || this.activeConnectionId
    if (!id) {
      throw new Error('没有可用的活跃连接')
    }
    return id
  }

  async connectWithId(
    config: MCPServerConfig,
    connectionId?: string
  ): Promise<{ success: boolean; error?: string; transportType?: string; connectionId?: string }> {
    const result = await this.manager.connect(config, connectionId)
    if (result.success && result.connectionId && !this.activeConnectionId) {
      this.activeConnectionId = result.connectionId
    }
    return result
  }

  async disconnectWithId(connectionId: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.manager.disconnect(connectionId)
    if (result.success && this.activeConnectionId === connectionId) {
      this.activeConnectionId = undefined
    }
    return result
  }

  async getConnectionStatus(): Promise<{
    success: boolean
    status?: 'disconnected' | 'connecting' | 'connected'
    isConnected?: boolean
    error?: string
  }> {
    const activeId = this.activeConnectionId
    if (!activeId) {
      return { success: true, status: 'disconnected', isConnected: false }
    }

    const status = this.manager.getStatus(activeId)

    return {
      success: true,
      status,
      isConnected: status === 'connected'
    }
  }

  async listConnections(): Promise<{
    success: boolean
    connections?: any[]
    error?: string
  }> {
    try {
      const connections = this.manager.listConnections().map((c: any) => ({
        ...c,
        isConnected: c.status === 'connected'
      }))

      return { success: true, connections }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取连接列表时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async getActiveConnectionId(): Promise<string | undefined> {
    const activeId = this.activeConnectionId
    if (!activeId) {
      return undefined
    }
    const status = this.manager.getStatus(activeId)
    if (status !== 'connected') {
      return undefined
    }
    return activeId
  }

  isConnected(): boolean {
    const activeId = this.activeConnectionId
    if (!activeId) {
      return false
    }
    return this.manager.getStatus(activeId) === 'connected'
  }

  getStatus(): 'disconnected' | 'connecting' | 'connected' {
    const activeId = this.activeConnectionId
    if (!activeId) {
      return 'disconnected'
    }
    return this.manager.getStatus(activeId)
  }

  reset(): void {
    this.manager.disconnectAll()
    this.activeConnectionId = undefined
  }

  async listTools(connectionId?: string): Promise<{
    success: boolean
    tools?: any[]
    error?: string
    connectionId?: string
  }> {
    try {
      const id = this.resolveConnectionId(connectionId)
      const result = await this.manager.listTools(id)

      if (!result.success || !result.tools) {
        return { success: false, error: result.error }
      }

      return { success: true, tools: result.tools, connectionId: id }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取工具列表时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async listResources(connectionId?: string): Promise<{
    success: boolean
    resources?: any[]
    error?: string
    connectionId?: string
  }> {
    try {
      const id = this.resolveConnectionId(connectionId)
      const result = await this.manager.listResources(id)
      return { success: result.success, resources: result.resources || [], error: result.error, connectionId: id }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取资源列表时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async listPrompts(connectionId?: string): Promise<{
    success: boolean
    prompts?: any[]
    error?: string
    connectionId?: string
  }> {
    try {
      const id = this.resolveConnectionId(connectionId)
      const result = await this.manager.listPrompts(id)
      return { success: result.success, prompts: result.prompts || [], error: result.error, connectionId: id }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取提示词列表时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async callTool(
    toolName: string,
    args?: Record<string, any>,
    connectionId?: string
  ): Promise<{
    success: boolean
    result?: any
    error?: string
    connectionId?: string
  }> {
    try {
      const id = this.resolveConnectionId(connectionId)
      const result = await this.manager.callTool(toolName, args || {}, id)
      return { success: result.success, result: result.result?.content, error: result.error, connectionId: id }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '调用工具时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async readResource(
    params: { uri: string },
    connectionId?: string
  ): Promise<{
    success: boolean
    content?: any
    error?: string
    connectionId?: string
  }> {
    try {
      if (!params?.uri) {
        throw new Error('资源URI不能为空')
      }
      const id = this.resolveConnectionId(connectionId)
      const result = await this.manager.readResource(params.uri, id)
      return { success: result.success, content: result.content, error: result.error, connectionId: id }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '读取资源时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async getPrompt(
    params: { name: string; arguments?: { [key: string]: string } },
    connectionId?: string
  ): Promise<{
    success: boolean
    prompt?: any
    error?: string
    connectionId?: string
  }> {
    try {
      if (!params?.name) {
        throw new Error('提示词名称不能为空')
      }
      const id = this.resolveConnectionId(connectionId)
      const result = await this.manager.getPrompt(params.name, params.arguments || {}, id)
      return { success: result.success, prompt: result.prompt, error: result.error, connectionId: id }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取提示词时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }
}
