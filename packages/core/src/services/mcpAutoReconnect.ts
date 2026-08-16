import type { IMCPClient } from '../interfaces/IMCPClient'
import type { MCPServerConfig } from '../types/mcp'
import type { MCPConfigPersistence } from './mcp/MCPConfigPersistence'
import { eventBus, EVENTS } from '../utils/eventBus'

class MCPAutoReconnectService {
  private static instance: MCPAutoReconnectService
  private mcpClient: IMCPClient | null = null
  private persistence: MCPConfigPersistence | null = null
  private reconnectionInProgress: Set<string> = new Set()

  private constructor() {}

  public static getInstance(): MCPAutoReconnectService {
    if (!MCPAutoReconnectService.instance) {
      MCPAutoReconnectService.instance = new MCPAutoReconnectService()
    }
    return MCPAutoReconnectService.instance
  }

  public configure(persistence: MCPConfigPersistence, mcpClient: IMCPClient): void {
    this.persistence = persistence
    this.mcpClient = mcpClient
  }

  public async initialize(): Promise<void> {
    try {
      await new Promise(resolve => setTimeout(resolve, 500))
      await this.reconnectPreviouslyConnectedServers()
    } catch (error) {
      console.error('MCP自动重连服务初始化失败:', error)
    }
  }

  private getPersistence(): MCPConfigPersistence {
    if (!this.persistence) {
      throw new Error('MCPAutoReconnectService is not configured. Call configure() first.')
    }
    return this.persistence
  }

  private getMCPClient(): IMCPClient {
    if (!this.mcpClient) {
      throw new Error('MCPAutoReconnectService is not configured. Call configure() first.')
    }
    return this.mcpClient
  }

  private async reconnectPreviouslyConnectedServers(): Promise<void> {
    try {
      const persistence = this.getPersistence()
      const configuredServers = await persistence.loadServers()
      if (!Array.isArray(configuredServers) || configuredServers.length === 0) {
        return
      }

      const states = persistence.loadStates()
      const serversToReconnect: MCPServerConfig[] = []

      for (const server of configuredServers) {
        const serverName = server.name || 'unnamed-server'
        const state = states[serverName]

        // 自动重连策略：
        // - 无状态记录（新添加）→ 尝试连接
        // - connected: true → 尝试重连
        // - connected: false（用户主动断开）→ 不重连
        if (!state || state.connected) {
          serversToReconnect.push(server)
        }
      }

      if (serversToReconnect.length === 0) {
        return
      }

      const batchSize = 3
      for (let i = 0; i < serversToReconnect.length; i += batchSize) {
        const batch = serversToReconnect.slice(i, i + batchSize)
        await Promise.all(
          batch.map(server => this.connectServerSafely(server))
        )
      }

      eventBus.emit(EVENTS.MCP_CONNECTION_CHANGED)
    } catch (error) {
      console.error('重连过程中发生错误:', error)
    }
  }

  private getStableConnectionId(serverName: string): string {
    const cleanedName = serverName
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
    return `mcp-${cleanedName}`
  }

  private async connectServerSafely(server: MCPServerConfig): Promise<void> {
    const serverName = server.name || 'unnamed-server'

    if (this.reconnectionInProgress.has(serverName)) {
      return
    }

    this.reconnectionInProgress.add(serverName)

    try {
      const serverConfig = JSON.parse(JSON.stringify(server))
      const stableConnectionId = this.getStableConnectionId(serverName)
      const client = this.getMCPClient()

      const result = await client.connectWithId(serverConfig, stableConnectionId)

      if (result.success) {
        return
      }

      if (result.error?.includes('已存在')) {
        await client.disconnectWithId(stableConnectionId)
        await new Promise(resolve => setTimeout(resolve, 100))
        await client.connectWithId(serverConfig, stableConnectionId)
      }
    } catch (error) {
      console.warn(`服务器 ${serverName} 连接失败:`, error)
    } finally {
      this.reconnectionInProgress.delete(serverName)
    }
  }
}

export const mcpAutoReconnectService = MCPAutoReconnectService.getInstance()
