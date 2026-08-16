import type { IMCPClient } from '../../interfaces/IMCPClient';

/**
 * 工具服务 - 封装MCP服务器工具的获取和调用功能
 * 使用ElectronMCPClient接口
 */
export class ToolsService {
  constructor(private mcpClient: IMCPClient) {}



  /**
   * 调用指定的MCP工具
   * @param toolName 工具名称
   * @param args 工具参数
   * @param connectionId 连接ID（可选）
   * @returns 工具调用结果
   */
  async callTool(toolName: string, args?: Record<string, any>, connectionId?: string): Promise<any> {
    try {
      // 验证工具名称
      if (!toolName || typeof toolName !== 'string') {
        throw new Error('工具名称不能为空')
      }

      // 验证参数格式
      if (args && typeof args !== 'object') {
        throw new Error('工具参数必须是对象类型')
      }

      // 连接ID验证和处理 - 智能连接选择
      let actualConnectionId = connectionId
      if (!actualConnectionId) {
        try {
          // 智能选择包含目标工具的连接
          actualConnectionId = await this.selectConnectionForTool(toolName)
          if (!actualConnectionId) {
            // 回退到默认的活跃连接选择
            const activeConnectionId = await this.mcpClient.getActiveConnectionId?.()
            if (activeConnectionId) {
              actualConnectionId = activeConnectionId
            }
          }
        } catch (err) {
          // 回退到默认方法
          try {
            const activeConnectionId = await this.mcpClient.getActiveConnectionId?.()
            if (activeConnectionId) {
              actualConnectionId = activeConnectionId
            }
          } catch (fallbackErr) {
            // 静默忽略回退错误
          }
        }
      }

      if (!actualConnectionId) {
        throw new Error('无法确定要使用的MCP连接ID')
      }

      // 检查MCP连接状态
      const connected = await this.isClientConnected()
      if (!connected) {
        throw new Error('MCP客户端未连接')
      }

      const result = await this.mcpClient.callTool(toolName, args, actualConnectionId)

      if (!result.success) {
        throw new Error(result.error || `工具调用失败: ${toolName}`)
      }

      return result.result
    } catch (error) {
      console.error(`❌ ToolsService: 工具调用失败: ${toolName}`, error)
      throw error
    }
  }

  /**
   * 智能选择包含指定工具的连接
   * @param toolName 工具名称
   * @returns 包含该工具的连接ID，如果没有找到则返回undefined
   */
  private async selectConnectionForTool(toolName: string): Promise<string | undefined> {
    try {
      // 获取所有连接列表
      const connectionsResponse = await this.mcpClient.listConnections()
      if (!connectionsResponse.success || !connectionsResponse.connections) {
        return undefined
      }
      
      // 遍历每个连接，检查是否包含目标工具
      for (const connection of connectionsResponse.connections) {
        const isConnected = connection.connected === true || connection.status === 'connected'
        if (!isConnected) {
          continue
        }
        
        const connId = connection.connectionId || connection.id
        if (!connId) {
          continue
        }
        
        try {
          const toolsResponse = await this.mcpClient.listTools(connId)
          
          if (toolsResponse.success && toolsResponse.tools) {
            const toolNames = toolsResponse.tools.map((tool: any) => tool.name)
            
            if (toolNames.includes(toolName)) {
              return connId
            }
          }
        } catch (toolError) {
          // 静默忽略工具列表获取错误
        }
      }
      
      return undefined
    } catch (error) {
      console.error('ToolsService.selectConnectionForTool: 智能连接选择失败:', error)
      return undefined
    }
  }

  /**
   * 检查MCP连接是否已建立
   * @returns 连接状态
   */
  private async isClientConnected(): Promise<boolean> {
    try {
      // 直接检查主进程的MCP连接状态，而不是渲染进程的本地状态
      const statusResult = await this.mcpClient.getConnectionStatus()
      
      if (!statusResult.success) {
        console.warn('MCP连接状态检查失败:', statusResult.error)
        return false
      }
      
      const isConnected = statusResult.isConnected || statusResult.status === 'connected'
      
      return isConnected
    } catch (error) {
      console.error('MCP连接状态检查异常:', error)
      return false
    }
  }

  /**
   * 获取工具调用历史（简化版）
   * @returns 最近调用的工具列表（最多10条）
   */
  getToolCallHistory(): Array<{ name: string; args?: any; timestamp: Date; success: boolean }> {
    // 这里可以实现工具调用历史记录功能
    // 目前返回空数组作为占位符
    return []
  }

  /**
   * 验证工具调用参数
   * @param toolName 工具名称
   * @param args 调用参数
   * @returns 验证结果
   */
  validateToolArguments(toolName: string, args?: Record<string, any>): { valid: boolean; error?: string } {
    if (!toolName || typeof toolName !== 'string') {
      return { valid: false, error: '工具名称不能为空' }
    }

    if (args && typeof args !== 'object') {
      return { valid: false, error: '工具参数必须是对象类型' }
    }

    // 如果有参数，可以在这里添加更简单的验证逻辑
    return { valid: true }
  }
}
