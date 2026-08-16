import type { ProtocolHandler, ProtocolHandlerContext } from '../protocolHandler'
import type { Message, ToolDefinition, ModelConfig, ModelResponse, StreamCallback } from '../../../types/models'
import { handleStreamResponse, convertOpenAIResponseToModelResponse } from '../openaiChatHelpers'
import { normalizeBody } from '../normalizeBody'
import OpenAI from 'openai'

/**
 * OpenAI Chat 协议处理器
 * 合并 GLM / DeepSeek / Kimi 三个子类的 callModelAPI 共同逻辑
 */
export const openAIChatHandler: ProtocolHandler = {
  capabilities: {
    chat: true,
    toolCalling: true,
    streaming: true,
    outputModalities: ['text'],
  },

  async call(
    messages: Message[],
    tools: ToolDefinition[],
    config: ModelConfig,
    context: ProtocolHandlerContext,
    streamCallback?: StreamCallback,
    abortController?: AbortController
  ): Promise<ModelResponse> {
    const { mcpService, adapterConfig } = context

    // 从 adapterConfig 自行创建 SDK 客户端
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: adapterConfig.baseURL,
      dangerouslyAllowBrowser: true,
      defaultHeaders: adapterConfig.headers || {},
      // 使用运行时原生 fetch，避免 SDK 回退到 node-fetch v2（DEP0040/DEP0169 警告）
      fetch: globalThis.fetch,
    })

    // 转换消息格式为 OpenAI 格式
    const openaiMessages = mcpService.convertMessagesToOpenAIFormatWithToolSupport(messages)

    // 构建请求体
    const body: any = {
      model: config.model,
      messages: openaiMessages,
      stream: config.stream !== undefined ? config.stream : !!streamCallback,
      temperature: config.temperature ?? 0.7,
    }

    // 流式请求返回 token 用量（OpenAI/DeepSeek 兼容；不支持时可经 adapterConfig.unsupportedParams 剔除）
    if (body.stream) {
      body.stream_options = { include_usage: true }
    }

    // max_tokens（由 adapterConfig.defaultMaxTokens 通过 getDefaultConfig 设置）
    if (config.maxTokens !== undefined) {
      body.max_tokens = config.maxTokens
    }

    // top_p
    if (config.topP !== undefined) {
      body.top_p = config.topP
    }

    // 工具定义
    if (tools && tools.length > 0) {
      body.tools = tools
    }

    // thinking 格式转换
    if (config.thinking !== undefined) {
      body.thinking = { type: config.thinking ? 'enabled' : 'disabled' }
    }

    // reasoningEffort（DeepSeek V4 Pro）
    if (config.reasoningEffort) {
      body.reasoning_effort = config.reasoningEffort
    }

    // 归一化：剔除 unsupportedParams、合并 extraBodyParams、覆盖 fixedParams（硬约束最后应用）
    const finalBody = normalizeBody(body, adapterConfig)

    // 流式 / 非流式分支
    if (finalBody.stream && streamCallback) {
      return handleStreamResponse(client, mcpService, finalBody, streamCallback, abortController)
    }

    const response = await client.chat.completions.create({
      ...finalBody,
      signal: abortController?.signal,
    })

    return convertOpenAIResponseToModelResponse(response)
  },
}
