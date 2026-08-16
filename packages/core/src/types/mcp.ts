// MCP服务器配置接口
export interface MCPServerConfig {
  /**
   * MCP服务器URL（HTTP传输类型必需）
   */
  url?: string
  /**
   * 服务器名称（可选）
   */
  name?: string
  /**
   * 自定义请求头（可选，HTTP传输类型使用）
   */
  headers?: Record<string, string>
  /**
   * 客户端名称（可选）
   */
  clientName?: string
  /**
   * 客户端版本（可选）
   */
  clientVersion?: string
  /**
   * 连接超时时间（毫秒）
   */
  timeout?: number
  
  /**
   * 传输类型（可选，默认auto自动检测）
   */
  transportType?: "auto" | "stdio" | "http"
  
  /**
   * 用户原始输入的JSON字符串（可选）
   */
  originalJson?: string
  
  /**
   * stdio传输类型的可执行命令（stdio传输类型必需）
   */
  command?: string
  /**
   * stdio传输类型的命令行参数（可选）
   */
  args?: string[]
  /**
   * stdio传输类型的工作目录（可选）
   */
  cwd?: string
  /**
   * stdio传输类型的环境变量（可选）
   */
  env?: Record<string, string>
}

// MCP服务器连接状态
export interface MCPServer {
  /**
   * MCP服务器配置
   */
  config: MCPServerConfig
  /**
   * 是否已连接
   */
  connected: boolean
  /**
   * 最后连接时间
   */
  lastConnectedAt?: Date
  /**
   * 连接错误信息
   */
  lastError?: string
}

// MCP工具定义
export interface Tool {
  /**
   * 工具名称
   */
  name: string
  /**
   * 工具描述
   */
  description?: string
  /**
   * 工具输入模式
   */
  inputSchema?: any
  /**
   * 工具模式类型
   */
  schema?: any
}

// MCP工具调用结果
export interface ToolResult {
  /**
   * 工具调用结果
   */
  result: any
  /**
   * 错误信息（如果有）
   */
  error?: string
}

// MCP客户端事件
export interface MCPClientEvent {
  /**
   * 事件类型
   */
  type: 'connecting' | 'connected' | 'disconnected' | 'error'
  /**
   * 事件数据
   */
  data?: any
  /**
   * 错误信息
   */
  error?: string
  /**
   * 时间戳
   */
  timestamp: Date
}

// MCP服务器工具列表响应
export interface ListToolsResponse {
  /**
   * 工具列表
   */
  tools: Tool[]
  /**
   * 响应类型
   */
  _meta?: any
}

// MCP服务器工具调用响应
export interface CallToolResponse {
  /**
   * 工具调用的内容对象列表
   */
  content: Array<{
    type: 'text' | 'image' | 'audio' | 'resource' | 'tool-result'
    text?: string
    data?: string
    mimeType?: string
    _meta?: Record<string, unknown>
  }>
  /**
   * 可选的JSON对象，代表结构化结果
   */
  structuredContent?: Record<string, unknown>
  /**
   * 是否出现错误
   */
  isError?: boolean
  /**
   * 错误信息（如果有）
   */
  error?: string
  /**
   * 响应类型
   */
  _meta?: any
}

// 传输类型定义
export type TransportType = "stdio" | "http"

// 配置验证结果
export interface ConfigValidationResult {
  /**
   * 验证是否通过
   */
  valid: boolean
  /**
   * 检测到的传输类型（验证通过时）
   */
  transportType?: TransportType
  /**
   * 验证错误信息（验证失败时）
   */
  error?: string
}
