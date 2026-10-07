import type { ProtocolHandler, ProtocolHandlerContext } from '../protocolHandler'
import type { Message, ToolDefinition, ModelConfig, ModelResponse, StreamCallback } from '../../../types/models'
import { normalizeBody } from '../normalizeBody'
import {
  convertMessagesToAnthropicFormat,
  convertToolsToAnthropicFormat,
  parseAnthropicResponse,
  handleAnthropicStream,
  applyAnthropicCacheBreakpoints,
} from './anthropicChatHelpers'

/**
 * Anthropic Messages 协议处理器（Claude 系模型）
 * 转换全部在 anthropicChatHelpers 内（不复用 OpenAI 形状的 mcpService 转换）。
 */
export const anthropicChatHandler: ProtocolHandler = {
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
    abortController?: AbortController,
  ): Promise<ModelResponse> {
    const { adapterConfig } = context

    const { system, messages: anthropicMessages } = convertMessagesToAnthropicFormat(messages)

    const body: Record<string, any> = {
      model: config.model,
      max_tokens: config.maxTokens ?? adapterConfig.defaultMaxTokens ?? 4096,
      messages: anthropicMessages,
      // 与 openAIChatHandler 同款对齐：流式必须同时满足"通道存在"（streamCallback），
      // 无 callback 的一次性后台调用带 stream:true 会收到 SDK Stream 对象而非完整响应
      stream: !!streamCallback && config.stream !== false,
    }
    if (system) body.system = system
    if (config.temperature !== undefined) body.temperature = config.temperature
    if (tools && tools.length > 0) {
      body.tools = convertToolsToAnthropicFormat(tools)
    }
    // R0 缓存断点（Anthropic prompt caching；见 applyAnthropicCacheBreakpoints 注释）
    applyAnthropicCacheBreakpoints(body)
    const finalBody = normalizeBody(body, adapterConfig)

    // baseURL 容错：以 /v1 结尾追加 /messages，否则追加 /v1/messages
    const base = adapterConfig.baseURL.replace(/\/+$/, '')
    const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        ...(adapterConfig.headers || {}),
      },
      body: JSON.stringify(finalBody),
      signal: abortController?.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Anthropic 请求失败: HTTP ${response.status} ${text.slice(0, 300)}`)
    }

    if (finalBody.stream && streamCallback) {
      return handleAnthropicStream(response, streamCallback)
    }

    return parseAnthropicResponse(await response.json())
  },
}
