import type { MCPServerConfig } from '../types/mcp'

export interface IMCPClient {
  connectWithId(config: MCPServerConfig, connectionId?: string): Promise<{ success: boolean; error?: string; transportType?: string; connectionId?: string }>
  disconnectWithId(connectionId: string): Promise<{ success: boolean; error?: string }>
  listTools(connectionId?: string): Promise<{ success: boolean; tools?: any[]; error?: string; connectionId?: string }>
  listResources(connectionId?: string): Promise<{ success: boolean; resources?: any[]; error?: string; connectionId?: string }>
  listPrompts(connectionId?: string): Promise<{ success: boolean; prompts?: any[]; error?: string; connectionId?: string }>
  callTool(toolName: string, args?: Record<string, any>, connectionId?: string): Promise<{ success: boolean; result?: any; error?: string; connectionId?: string }>
  readResource(params: { uri: string }, connectionId?: string): Promise<{ success: boolean; content?: any; error?: string; connectionId?: string }>
  getPrompt(params: { name: string; arguments?: { [key: string]: string } }, connectionId?: string): Promise<{ success: boolean; prompt?: any; error?: string; connectionId?: string }>
  getConnectionStatus(): Promise<{ success: boolean; status?: 'disconnected' | 'connecting' | 'connected'; isConnected?: boolean; error?: string }>
  listConnections(): Promise<{ success: boolean; connections?: any[]; error?: string }>
  getActiveConnectionId(): Promise<string | undefined>
  isConnected(): boolean
  getStatus(): 'disconnected' | 'connecting' | 'connected'
  reset(): void
}
