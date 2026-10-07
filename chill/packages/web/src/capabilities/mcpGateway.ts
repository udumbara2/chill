/**
 * MCP 服务网关（M3.5）
 *
 * 照桌面 ElectronMCPService 同构移植（core MCPConnectionManager 单例持有连接，
 * stdio spawn 在本进程）；状态变化经 WS ev 帧广播（mcp-status-update）。
 * 浏览器侧 ElectronMCPClient 经 wsHost 直达此处——零渲染层改动。
 */
import { MCPConnectionManager } from '@assistant-ai/core'

export class McpGateway {
  private manager = new MCPConnectionManager()
  private listeners = new Set<(n: string, d: unknown) => void>()

  constructor() {
    this.manager.onStatusChange(({ connectionId, status, transportType }) => {
      const conn = this.manager.listConnections().find((c) => c.connectionId === connectionId)
      this.emit('mcp-status-update', {
        connectionId,
        status,
        serverName: conn?.name || undefined,
        timestamp: Date.now(),
      })
      void transportType
    })
  }

  onEvent(cb: (n: string, d: unknown) => void): void {
    this.listeners.add(cb)
  }

  private emit(n: string, d: unknown): void {
    for (const cb of this.listeners) { try { cb(n, d) } catch { /* 不扩散 */ } }
  }

  getStatus(): Promise<unknown> {
    return Promise.resolve(this.manager.listConnections().map((c) => ({
      id: c.connectionId,
      status: c.status,
      transportType: c.transportType,
    })))
  }

  connect(config: unknown, connectionId?: string): Promise<unknown> {
    return this.manager.connect(config as never, connectionId)
  }

  disconnect(connectionId: string): Promise<unknown> {
    return this.manager.disconnect(connectionId)
  }

  listConnections(): Promise<unknown> {
    return Promise.resolve(this.manager.listConnections())
  }

  // 连接 id 类型断言说明：manager 的方法签名要求必填 string，但桌面先例
  // （ElectronMCPService → manager）运行时一直传 undefined（=默认连接语义）——照旧。
  listTools(connectionId?: string): Promise<unknown> {
    return this.manager.listTools(connectionId as string)
  }

  listResources(connectionId?: string): Promise<unknown> {
    return this.manager.listResources(connectionId as string)
  }

  readResource(uri: string, connectionId?: string): Promise<unknown> {
    return this.manager.readResource(uri, connectionId as string)
  }

  getPrompt(name: string, args: unknown, connectionId?: string): Promise<unknown> {
    return this.manager.getPrompt(name, args as never, connectionId as string)
  }

  listPrompts(connectionId?: string): Promise<unknown> {
    return this.manager.listPrompts(connectionId as string)
  }

  async callTool(toolName: string, args?: Record<string, unknown>, connectionId?: string): Promise<unknown> {
    try {
      let actual = connectionId
      if (!actual) {
        // 工具名反查归属连接（桌面同款语义；connectionId 类型可缺——防御性跳过残缺项）
        for (const conn of this.manager.listConnections()) {
          const cid = conn.connectionId
          if (!cid || conn.status !== 'connected') continue
          const tools = await this.manager.listTools(cid)
          if (tools.success && (tools.tools as Array<{ name: string }> | undefined)?.some((t) => t.name === toolName)) {
            actual = cid
            break
          }
        }
        if (!actual) {
          const first = this.manager.listConnections().find((c) => c.status === 'connected' && c.connectionId)
          if (!first?.connectionId) throw new Error('没有活跃的MCP连接')
          actual = first.connectionId
        }
      }
      return await this.manager.callTool(toolName, args ?? {}, actual)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '工具调用失败' }
    }
  }
}
