import type { MCPServerConfig } from '@assistant-ai/core'
import { getHostAPI } from '../host/hostApi'

/**
 * Electron渲染进程MCP客户端适配器
 * 通过IPC与主进程的MCP服务通信，提供简化的MCP操作接口
 */
export class ElectronMCPClient {
  private connectionStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected'
  private lastError: string | undefined = undefined

  /**
   * 统一错误处理方法
   */
  private handleError(operation: string, error: any): { success: boolean; error: string } {
    const errorMessage = error instanceof Error ? error.message : `${operation}时发生未知错误`
    this.lastError = errorMessage
    return {
      success: false,
      error: errorMessage
    }
  }

  /**
   * 通用列表获取方法
   * @param config 方法配置
   * @param connectionId 可选的连接ID
   * @returns 统一格式的列表结果
   */
  private async getListData(
    config: {
      method: string;
      displayName: string;
      hasLegacyAPI: boolean;
      hasWithIdAPI: boolean;
      noConnectionIdError?: string;
    },
    connectionId?: string
  ): Promise<{ success: boolean; data?: any[]; error?: string; connectionId?: string }> {
    const { method, displayName, hasLegacyAPI, hasWithIdAPI, noConnectionIdError } = config
    
    try {
      let result: any
      const host = getHostAPI()
      // 动态名探测视图（按名查找、存在即调用——宿主能力探测语义，成员均为函数）
      const dyn = host as unknown as Record<string, ((...args: unknown[]) => Promise<any>) | undefined>

      // 根据实际API支持情况选择调用方式
      if (connectionId && hasWithIdAPI) {
        // 使用带连接ID的API（注意：编译后API名称可能没有WithId后缀）
        const apiName = `mcp${method.charAt(0).toUpperCase() + method.slice(1)}WithId`
        const fallbackApiName = `mcp${method.charAt(0).toUpperCase() + method.slice(1)}`

        // 优先尝试WithId版本，然后是编译后的版本，最后是通用版本
        let foundApi = false
        if (dyn[apiName]) {
          result = await dyn[apiName]!(connectionId)
          foundApi = true
        } else if (dyn[fallbackApiName]) {
          result = await dyn[fallbackApiName]!(connectionId)
          foundApi = true
        }
        
        if (!foundApi) {
          return {
            success: false,
            error: `API方法不存在: ${apiName} 和 ${fallbackApiName}`
          }
        }
      } else if (!connectionId && hasLegacyAPI) {
        // 使用原有API
        const apiName = `mcp${method.charAt(0).toUpperCase() + method.slice(1)}`
        result = await dyn[apiName]!()
      } else {
        // API不支持的情况
        return {
          success: false,
          error: hasWithIdAPI && connectionId 
            ? 'MCP服务不支持该操作'
            : hasLegacyAPI 
              ? '需要指定连接ID才能执行该操作'
              : noConnectionIdError || 'MCP服务不支持该操作'
        }
      }
      
      // 统一的结果处理
      // 修正字段映射逻辑：listTools->tools, listResources->resources, listPrompts->prompts
      let dataField: string
      if (result.success) {
        if (method === 'listTools') dataField = 'tools'
        else if (method === 'listResources') dataField = 'resources'
        else if (method === 'listPrompts') dataField = 'prompts'
        else dataField = method.slice(4)
      } else {
        dataField = method.slice(4)
        this.lastError = result.error || undefined
      }
      
      return {
        success: result.success,
        data: result[dataField] || result.data,
        error: result.error,
        connectionId: result.connectionId
      }
    } catch (error) {
      return this.handleError(displayName, error)
    }
  }



  /**
   * 获取MCP工具列表
   * @param connectionId 可选的连接ID，如果有多个连接时必须指定
   */
  async listTools(connectionId?: string): Promise<{ success: boolean; tools?: any[]; error?: string; connectionId?: string }> {
    const result = await this.getListData({
      method: 'listTools',
      displayName: '获取工具列表',
      hasLegacyAPI: true,
      hasWithIdAPI: true
    }, connectionId)
    
    return {
      success: result.success,
      tools: result.data,
      error: result.error,
      connectionId: result.connectionId
    }
  }

  /**
   * 获取MCP资源列表
   * @param connectionId 可选的连接ID，如果有多个连接时必须指定
   */
  async listResources(connectionId?: string): Promise<{ success: boolean; resources?: any[]; error?: string; connectionId?: string }> {
    const result = await this.getListData({
      method: 'listResources',
      displayName: '获取资源列表',
      hasLegacyAPI: false,
      hasWithIdAPI: true,
      noConnectionIdError: '需要指定连接ID才能获取资源列表'
    }, connectionId)
    
    return {
      success: result.success,
      resources: result.data,
      error: result.error,
      connectionId: result.connectionId
    }
  }

  /**
   * 获取MCP提示词列表
   * @param connectionId 可选的连接ID，如果有多个连接时必须指定
   */
  async listPrompts(connectionId?: string): Promise<{ success: boolean; prompts?: any[]; error?: string; connectionId?: string }> {
    const result = await this.getListData({
      method: 'listPrompts',
      displayName: '获取提示词列表',
      hasLegacyAPI: false,
      hasWithIdAPI: true,
      noConnectionIdError: '需要指定连接ID才能获取提示词列表'
    }, connectionId)
    
    return {
      success: result.success,
      prompts: result.data,
      error: result.error,
      connectionId: result.connectionId
    }
  }

  /**
   * 读取MCP资源内容
   * @param params 资源参数，包含uri
   * @param connectionId 可选的连接ID，如果有多个连接时必须指定
   */
  async readResource(params: { uri: string }, connectionId?: string): Promise<{ success: boolean; content?: any; error?: string; connectionId?: string }> {
    try {
      if (!params?.uri) {
        throw new Error('资源URI不能为空')
      }
      
      let actualConnectionId = connectionId
      if (!actualConnectionId) {
        const activeConnectionId = await this.getActiveConnectionId()
        if (!activeConnectionId) {
          throw new Error('没有可用的活跃连接')
        }
        actualConnectionId = activeConnectionId
      }
      
      let result
      const host = getHostAPI()
      if (host.mcpReadResourceWithId) {
        result = await host.mcpReadResourceWithId(params.uri, actualConnectionId)
      } else {
        result = await host.mcpReadResource(params.uri, actualConnectionId)
      }
      
      if (result.success) {
        return {
          success: true,
          content: result.content,
          connectionId: actualConnectionId
        }
      } else {
        this.lastError = result.error || '读取资源内容失败'
        return {
          success: false,
          error: this.lastError,
          connectionId: actualConnectionId
        }
      }
    } catch (error) {
      return this.handleError('读取资源内容', error)
    }
  }

  /**
   * 获取MCP提示词内容
   * @param params 提示词参数，包含name和可选的arguments
   * @param connectionId 可选的连接ID，如果有多个连接时必须指定
   */
  async getPrompt(params: { name: string; arguments?: { [key: string]: string } }, connectionId?: string): Promise<{ success: boolean; prompt?: any; error?: string; connectionId?: string }> {
    try {
      if (!params?.name) {
        throw new Error('提示词名称不能为空')
      }
      
      let actualConnectionId = connectionId
      if (!actualConnectionId) {
        const activeConnectionId = await this.getActiveConnectionId()
        if (!activeConnectionId) {
          throw new Error('没有可用的活跃连接')
        }
        actualConnectionId = activeConnectionId
      }
      
      let result
      const args = params.arguments || {}
      
      const host = getHostAPI()
      if (host.mcpGetPromptWithId) {
        result = await host.mcpGetPromptWithId(params.name, args, actualConnectionId)
      } else {
        result = await host.mcpGetPrompt(params.name, args, actualConnectionId)
      }
      
      if (result.success) {
        return {
          success: true,
          prompt: result.prompt,
          connectionId: actualConnectionId
        }
      } else {
        this.lastError = result.error || '获取提示词失败'
        return {
          success: false,
          error: this.lastError,
          connectionId: actualConnectionId
        }
      }
    } catch (error) {
      return this.handleError('获取提示词', error)
    }
  }

  /**
   * 获取MCP连接状态
   */
  async getConnectionStatus(): Promise<{ success: boolean; status?: 'disconnected' | 'connecting' | 'connected'; isConnected?: boolean; error?: string }> {
    try {
      const result = await getHostAPI().mcpGetConnectionStatus()
      
      if (result.success) {
        // 处理返回的数据结构
        let finalStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected'
        let finalIsConnected = false
        
        if (result.connections && Array.isArray(result.connections)) {
          // 返回了多个连接，获取第一个活跃连接的状态
          const activeConnections = result.connections.filter((conn: any) => 
            conn.status === 'connected' || conn.isConnected
          )
          
          if (activeConnections.length > 0) {
            const latestConnection = activeConnections[0]
            finalStatus = latestConnection.status || 'connected'
            finalIsConnected = true
          } else {
            finalStatus = 'disconnected'
            finalIsConnected = false
          }
        } else if (result.status) {
          // 返回了单个连接状态
          finalStatus = result.status
          finalIsConnected = result.isConnected || result.status === 'connected'
        }
        
        // 更新本地状态
        this.connectionStatus = finalStatus
        
        const statusResult = {
          success: true,
          status: finalStatus,
          isConnected: finalIsConnected
        }
        
        return statusResult
      } else {
        this.lastError = result.error || undefined
        return {
          success: false,
          error: this.lastError
        }
      }
    } catch (error) {
      return this.handleError('获取连接状态', error)
    }
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connectionStatus === 'connected'
  }

  /**
   * 获取当前连接状态
   */
  getStatus(): 'disconnected' | 'connecting' | 'connected' {
    return this.connectionStatus
  }

  /**
   * 获取最后的错误信息
   */
  getLastError(): string | undefined {
    return this.lastError
  }

  /**
   * 获取客户端信息
   */
  getClientInfo() {
    return {
      name: 'chill',
      version: '1.0.0',
      isConnected: this.isConnected(),
      connectionStatus: this.connectionStatus,
      lastError: this.lastError
    }
  }

  /**
   * 重置客户端状态（用于清理连接）
   */
  reset() {
    this.connectionStatus = 'disconnected'
    this.lastError = undefined
  }

  // ========== 新增支持连接ID的方法 ==========

  /**
   * 支持连接ID的连接
   */
  async connectWithId(config: MCPServerConfig, connectionId?: string): Promise<{ success: boolean; error?: string; transportType?: string; connectionId?: string }> {
    try {
      const result = await getHostAPI().mcpConnectWithId(config, connectionId)
      
      if (result.success) {
        return result
      } else {
        return result
      }
    } catch (error) {
      return this.handleError('连接', error)
    }
  }

  /**
   * 断开指定连接
   */
  async disconnectWithId(connectionId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await getHostAPI().mcpDisconnectWithId(connectionId)

      if (result.success) {
        this.connectionStatus = 'disconnected'
        this.lastError = undefined
      } else {
        this.lastError = result.error || undefined
      }

      return result
    } catch (error) {
      return this.handleError('断开连接', error)
    }
  }

  /**
   * 获取所有连接列表
   */
  async listConnections(): Promise<{ success: boolean; connections?: any[]; error?: string }> {
    try {
      const result = await getHostAPI().mcpListConnections()
      
      if (!result.success) {
        this.lastError = result.error || null
      }

      return result
    } catch (error) {
      return this.handleError('获取连接列表', error)
    }
  }

  /**
   * 调用指定工具
   */
  async callTool(
    toolName: string, 
    args?: Record<string, any>, 
    connectionId?: string
  ): Promise<{ success: boolean; result?: any; error?: string; connectionId?: string }> {
    try {
      // 如果没有指定连接ID，获取活跃连接ID
      let actualConnectionId = connectionId
      if (!actualConnectionId) {
        const activeConnectionId = await this.getActiveConnectionId()
        
        if (!activeConnectionId) {
          throw new Error('没有可用的活跃连接')
        }
        actualConnectionId = activeConnectionId
      }

      // 调用宿主的 mcpCallToolWithId 方法（带回退逻辑）
      const host = getHostAPI()
      let result
      if (host.mcpCallToolWithId) {
        result = await host.mcpCallToolWithId(toolName, args, actualConnectionId)
      } else {
        // 旧宿主防御回退（当前 preload 无 mcpCallTool：undefined 调用走 handleError，保持原行为）
        result = await (host as any).mcpCallTool(toolName, args, actualConnectionId)
      }
      
      if (result.success) {
        return {
          success: true,
          result: result.result,
          connectionId: result.connectionId || actualConnectionId
        }
      } else {
        const errorMsg = result.error || `工具调用失败: ${toolName}`
        return {
          success: false,
          error: errorMsg,
          connectionId: actualConnectionId
        }
      }
    } catch (error) {
      return this.handleError('调用工具', error)
    }
  }

  /**
   * 获取活跃连接ID
   */
  async getActiveConnectionId(): Promise<string | undefined> {
    try {
      const connectionsResponse = await this.listConnections()
      
      if (!connectionsResponse.success || !connectionsResponse.connections) {
        return undefined
      }
      
      const connectedConnections = connectionsResponse.connections.filter(conn => 
        conn.status === 'connected' || conn.isConnected
      )
      
      if (connectedConnections.length === 0) {
        return undefined
      }
      
      const latestConnection = connectedConnections.sort((a, b) => {
        const timeA = a.connectedAt || a.lastConnected || 0
        const timeB = b.connectedAt || b.lastConnected || 0
        return timeB - timeA
      })[0]
      
      const resultId = latestConnection.id || latestConnection.connectionId
      
      if (!resultId) {
        return undefined
      }
      
      return resultId
    } catch (error) {
      return undefined
    }
  }
}

/**
 * MCP客户端单例实例
 */
let mcpClientInstance: ElectronMCPClient | null = null

/**
 * 获取MCP客户端单例
 */
export function getMCPClient(): ElectronMCPClient {
  if (!mcpClientInstance) {
    mcpClientInstance = new ElectronMCPClient()
  }
  return mcpClientInstance
}

/**
 * 重新创建MCP客户端实例（用于重置连接）
 */
export function resetMCPClient(): ElectronMCPClient {
  if (mcpClientInstance) {
    mcpClientInstance.reset()
  }
  mcpClientInstance = new ElectronMCPClient()
  return mcpClientInstance
}