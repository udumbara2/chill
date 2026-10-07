import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListPromptsResultSchema
} from '@modelcontextprotocol/sdk/types.js'
import type { MCPServerConfig } from '../../types/mcp'
import { TransportDetector } from './transportDetector'

interface ConnectionEntry {
  client: Client
  transport: StdioClientTransport | StreamableHTTPClientTransport
  config: MCPServerConfig
  status: 'disconnected' | 'connecting' | 'connected'
}

export type StatusChangeCallback = (event: {
  connectionId: string
  status: 'connecting' | 'connected' | 'disconnected'
  transportType?: string
}) => void

export class MCPConnectionManager {
  private connections: Map<string, ConnectionEntry> = new Map()
  private statusChangeCallbacks: StatusChangeCallback[] = []

  onStatusChange(callback: StatusChangeCallback): void {
    this.statusChangeCallbacks.push(callback)
  }

  private emitStatusChange(connectionId: string, status: 'connecting' | 'connected' | 'disconnected', transportType?: string): void {
    for (const cb of this.statusChangeCallbacks) {
      try {
        cb({ connectionId, status, transportType })
      } catch {
        // 回调异常不影响主流程
      }
    }
  }

  async connect(
    config: MCPServerConfig,
    connectionId?: string
  ): Promise<{ success: boolean; error?: string; transportType?: string; connectionId?: string }> {
    const id = connectionId || `conn_${Date.now()}_${Math.random().toString(36).slice(2)}`

    if (this.connections.has(id)) {
      return { success: false, error: `连接ID ${id} 已存在，请先断开现有连接`, connectionId: id }
    }

    let transportType: string | undefined

    try {
      transportType = TransportDetector.detect(config)

      this.connections.set(id, {
        client: null as unknown as Client,
        transport: null as unknown as StdioClientTransport,
        config,
        status: 'connecting'
      })

      this.emitStatusChange(id, 'connecting', transportType)

      const client = new Client({
        name: config.clientName || 'chill',
        version: config.clientVersion || '1.0.0'
      })

      let transport: StdioClientTransport | StreamableHTTPClientTransport

      if (transportType === 'stdio') {
        if (!config.command) {
          this.connections.delete(id)
          this.emitStatusChange(id, 'disconnected', transportType)
          return { success: false, error: 'stdio传输需要配置command字段', connectionId: id }
        }
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: config.env || (process.env as Record<string, string>),
          cwd: config.cwd,
          stderr: 'pipe'
        })
      } else {
        if (!config.url) {
          this.connections.delete(id)
          this.emitStatusChange(id, 'disconnected', transportType)
          return { success: false, error: 'HTTP传输需要配置url字段', connectionId: id }
        }
        const cleanedUrl = config.url.trim().replace(/[`"]/g, '')
        transport = new StreamableHTTPClientTransport(new URL(cleanedUrl), {
          requestInit: {
            headers: config.headers || {}
          },
          // SSE 监听流断开不重连（重连强度与推送需求对齐——上下文压缩显示约定同源语义）：
          // 监听流仅供服务器主动推送（纯工具服务器用不到，工具调用走 POST 自己的响应流）；
          // SDK 重试计数在"成功-断开"循环里清零、任何非零上限都是无界累积，且每次重连在共享
          // signal 上泄漏一个 abort 监听器（实测 75s 内 MaxListenersExceeded 洪泛）——0 是唯一硬界
          //（时延三字段是 SDK 类型的必填项，值取 SDK 默认；maxRetries=0 时永不生效）
          reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 30000, reconnectionDelayGrowFactor: 1.5, maxRetries: 0 }
        })
      }

      await client.connect(transport)

      this.connections.set(id, { client, transport, config, status: 'connected' })

      this.emitStatusChange(id, 'connected', transportType)

      return { success: true, transportType, connectionId: id }
    } catch (error) {
      this.connections.delete(id)
      this.emitStatusChange(id, 'disconnected', transportType)
      const errorMessage = error instanceof Error ? error.message : '连接时发生未知错误'
      return { success: false, error: errorMessage, connectionId: id }
    }
  }

  async disconnect(connectionId: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.connections.get(connectionId)
    if (!entry) {
      return { success: false, error: `连接 ${connectionId} 不存在` }
    }

    try {
      await entry.client.close()
      this.connections.delete(connectionId)
      this.emitStatusChange(connectionId, 'disconnected')
      return { success: true }
    } catch (error) {
      this.emitStatusChange(connectionId, 'disconnected')
      const errorMessage = error instanceof Error ? error.message : '断开连接时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async disconnectAll(): Promise<{ success: boolean; error?: string }> {
    try {
      const connectionIds = Array.from(this.connections.keys())
      for (const id of connectionIds) {
        const entry = this.connections.get(id)
        if (entry) {
          try {
            await entry.client.close()
          } catch {
            // 单个连接关闭失败不中断
          }
          this.emitStatusChange(id, 'disconnected')
        }
      }
      this.connections.clear()
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '断开所有连接时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  listConnections(): Array<{ connectionId: string; name?: string; transportType: string; status: string }> {
    return Array.from(this.connections.entries()).map(([id, entry]) => ({
      connectionId: id,
      name: entry.config.name,
      transportType: TransportDetector.detect(entry.config),
      status: entry.status
    }))
  }

  getStatus(connectionId: string): 'disconnected' | 'connecting' | 'connected' {
    const entry = this.connections.get(connectionId)
    return entry ? entry.status : 'disconnected'
  }

  private resolveClient(connectionId: string): { client: Client; id: string } {
    const entry = this.connections.get(connectionId)
    if (!entry || entry.status !== 'connected') {
      throw new Error(`连接 ${connectionId} 不可用`)
    }
    return { client: entry.client, id: connectionId }
  }

  async listTools(connectionId: string): Promise<{ success: boolean; tools?: any[]; error?: string }> {
    try {
      const { client } = this.resolveClient(connectionId)
      const result = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema)
      return { success: true, tools: result.tools }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取工具列表时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async listResources(connectionId: string): Promise<{ success: boolean; resources?: any[]; error?: string }> {
    try {
      const { client } = this.resolveClient(connectionId)
      const result = await client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema)
      return { success: true, resources: result.resources }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取资源列表时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async listPrompts(connectionId: string): Promise<{ success: boolean; prompts?: any[]; error?: string }> {
    try {
      const { client } = this.resolveClient(connectionId)
      const result = await client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema)
      return { success: true, prompts: result.prompts }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取提示词列表时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async callTool(
    name: string,
    args: Record<string, any>,
    connectionId: string
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    try {
      const { client } = this.resolveClient(connectionId)
      const result = await client.callTool({ name, arguments: args })
      return { success: true, result }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '调用工具时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async readResource(
    uri: string,
    connectionId: string
  ): Promise<{ success: boolean; content?: any; error?: string }> {
    try {
      const { client } = this.resolveClient(connectionId)
      const result = await client.readResource({ uri })
      return { success: true, content: result.contents }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '读取资源时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }

  async getPrompt(
    name: string,
    args: Record<string, any>,
    connectionId: string
  ): Promise<{ success: boolean; prompt?: any; error?: string }> {
    try {
      const { client } = this.resolveClient(connectionId)
      const result = await client.getPrompt({ name, arguments: args })
      return { success: true, prompt: result.messages }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取提示词时发生未知错误'
      return { success: false, error: errorMessage }
    }
  }
}
