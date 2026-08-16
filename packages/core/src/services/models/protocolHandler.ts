import type { Message, ToolDefinition, ModelConfig, ModelResponse, StreamCallback, ModelAdapterConfig } from '../../types/models'
import type OpenAI from 'openai'
import type { MCPService } from '../mcp/mcpService'

/**
 * 协议处理器上下文
 * 替代原 service 参数，只暴露 handler 必需的依赖
 */
export interface ProtocolHandlerContext {
  mcpService: MCPService
  client?: OpenAI
  config: ModelConfig
  adapterConfig: ModelAdapterConfig
}

/**
 * 协议处理器接口
 * 通过静态注册表实现协议路由，支持任意协议扩展
 */
export interface ProtocolHandler {
  capabilities: {
    chat: boolean
    toolCalling: boolean
    streaming: boolean
    outputModalities: ('text' | 'image' | 'video' | 'audio')[]
    asyncTask?: boolean
  }
  call(
    messages: Message[],
    tools: ToolDefinition[],
    config: ModelConfig,
    context: ProtocolHandlerContext,
    streamCallback?: StreamCallback,
    abortController?: AbortController
  ): Promise<ModelResponse>
  submitTask?(
    messages: Message[],
    tools: ToolDefinition[],
    config: ModelConfig,
    context: ProtocolHandlerContext,
    streamCallback?: StreamCallback,
    abortController?: AbortController
  ): Promise<{ taskId: string }>
  pollTask?(
    taskId: string,
    context: ProtocolHandlerContext,
    streamCallback?: StreamCallback,
    abortController?: AbortController
  ): Promise<{ status: 'pending' | 'completed' | 'failed'; result?: ModelResponse }>
}
