/**
 * 隔离环境类型定义
 * 用于定义 Subagent 隔离运行环境的接口和类型
 */

import type { ToolDefinition, ModelAdapterConfig } from '../../types/models'

/**
 * Subagent 请求接口
 * 主进程发送给 Worker 的请求数据
 */
export interface SubagentRequest {
  /** 任务ID */
  taskId: string
  /** Subagent 类型 */
  subagentType: string
  /** Subagent 配置 */
  subagentConfig: {
    /** 模型名称 */
    model?: string
    /** 模型类型 */
    modelType?: string
    /** 适配器配置 */
    adapterConfig?: ModelAdapterConfig
    /** 温度参数 */
    temperature?: number
    /** 最大Token数 */
    maxTokens?: number
    /** 最大迭代次数 */
    maxIterations?: number
    /** 系统提示词 */
    systemPrompt?: string
    /** 用户提示词模板 */
    userPromptTemplate?: string
    /** API密钥 */
    apiKey?: string
    /** API基础URL */
    baseURL?: string
    /** 任务超时（秒；模板 timeout 贯通到 fork 层，缺省 600） */
    timeout?: number
  }
  /** 用户消息（任务描述） */
  userMessage: string
  /** 系统提示词 */
  systemPrompt: string
  /** 工具定义列表 */
  toolDefinitions?: ToolDefinition[]
  /** 授权工具列表 */
  authorizedTools?: string[]
}

/**
 * Subagent 响应接口
 * Worker 返回给主进程的结果数据
 */
export interface SubagentResponse {
  /** 是否成功 */
  success: boolean
  /** 输出内容 */
  output?: string
  /** 错误信息 */
  error?: string
  /** 工具调用记录 */
  toolCalls?: Array<{
    name: string
    arguments: Record<string, any>
    result?: any
  }>
  /** Token 使用情况 */
  tokenUsage?: {
    input: number
    output: number
    total: number
  }
  /** 迭代次数 */
  iterations?: number
}

/**
 * 隔离环境接口
 * 封装 Subagent 的运行环境
 */
export interface IsolatedEnvironment {
  /** 环境唯一标识 */
  id: string
  /**
   * 发送请求到隔离环境
   * @param request - Subagent 请求
   * @returns Subagent 响应
   */
  sendRequest: (request: SubagentRequest) => Promise<SubagentResponse>
  /**
   * 销毁隔离环境
   * 清理资源、终止进程
   */
  destroy: () => Promise<void>
}

/**
 * 模板 Subagent 管理器接口
 * 管理隔离环境的创建和销毁
 */
export interface TemplateSubagentManager {
  /**
   * 创建隔离环境
   * @param subagentType - Subagent 类型
   * @param subagentConfig - Subagent 配置
   * @returns 隔离环境实例
   */
  createEnvironment: (
    subagentType: string,
    subagentConfig: any
  ) => Promise<IsolatedEnvironment>
  /**
   * 销毁所有隔离环境
   * 应用退出时调用
   */
  destroyAllEnvironments: () => Promise<void>
}

/**
 * Worker 配置接口
 * 通过环境变量传递给 Worker 的配置
 */
export interface WorkerConfig {
  /** Subagent 类型 */
  subagentType: string
  /** Subagent 配置 */
  subagentConfig: {
    model?: string
    temperature?: number
    maxTokens?: number
    maxIterations?: number
    /** API 密钥（可能随环境变量传入；日志输出须脱敏） */
    apiKey?: string
  }
  /** 环境ID */
  envId: string
}

/**
 * IPC 消息类型
 */
export enum IPCMessageType {
  REQUEST = 'request',
  RESPONSE = 'response',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  TOOL_CALL_REQUEST = 'tool_call_request',
  TOOL_CALL_RESPONSE = 'tool_call_response',
  ERROR = 'error',
}

/**
 * Worker 工具调用请求载荷（TOOL_CALL_REQUEST 的 payload）
 * kind 缺省 'mcp' 兼容既有 WorkerMCPool；'builtin' 为内置工具经 IPC 转发宿主真实执行器
 */
export interface WorkerToolCallRequest {
  /** 工具类别：builtin=内置工具（转发宿主真实执行器，继承宿主确认/autoApply 语义）；mcp=MCP 工具（默认） */
  kind?: 'builtin' | 'mcp'
  toolName: string
  args: Record<string, any>
  /** 内置工具调用的 toolCallId（宿主确认流以其为键） */
  toolCallId?: string
  /** Subagent 授权工具名单（宿主网关复核依据；编排工具永不放行） */
  authorizedTools?: string[]
  connectionId?: string
}

/**
 * IPC 消息接口
 */
export interface IPCMessage {
  /** 消息类型 */
  type: IPCMessageType
  /** 消息ID */
  id: string
  /** 消息数据 */
  payload: any
}
