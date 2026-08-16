import type OpenAI from 'openai'
import type { MCPService } from '../mcp/mcpService'
import type { ModelResponse, StreamCallback } from '../../types/models'

/**
 * 转换 OpenAI 响应为 ModelResponse 格式
 */
export function convertOpenAIResponseToModelResponse(response: any): ModelResponse {
  const choice = response.choices[0]
  const message = choice.message

  return {
    content: message.content || '',
    reasoningContent: message.reasoning_content || '',
    toolCalls: message.tool_calls || [],
    usage: response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          ...(response.usage.prompt_tokens_details?.cached_tokens !== undefined || response.usage.prompt_cache_hit_tokens !== undefined
            ? { cacheReadTokens: response.usage.prompt_tokens_details?.cached_tokens ?? response.usage.prompt_cache_hit_tokens }
            : {}),
          ...(response.usage.prompt_cache_miss_tokens !== undefined
            ? { cacheWriteTokens: response.usage.prompt_cache_miss_tokens }
            : {}),
        }
      : undefined,
  }
}

/**
 * 处理流式响应
 * 从 BaseModelService.handleStreamResponse 提取为独立函数
 */
export async function handleStreamResponse(
  client: OpenAI,
  mcpService: MCPService,
  requestParams: any,
  streamCallback: StreamCallback,
  abortController?: AbortController
): Promise<ModelResponse> {
  let fullContent = ''
  let fullReasoningContent = ''
  let toolCalls: any[] = []
  /** 末块 usage(stream_options.include_usage 时由 API 在 [DONE] 前下发)；
   *  缓存字段宽型：OpenAI prompt_tokens_details.cached_tokens / DeepSeek prompt_cache_hit_tokens+prompt_cache_miss_tokens */
  let usage: {
    prompt_tokens: number; completion_tokens: number; total_tokens: number
    prompt_tokens_details?: { cached_tokens?: number }
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  } | undefined
  /** 思考计时打点：首个/末个 reasoning delta 到达时间（差值即思考时长，随最终响应透出） */
  let firstReasoningAt: number | null = null
  let lastReasoningAt: number | null = null

  const stream = (await client.chat.completions.create({
    ...requestParams,
    signal: abortController?.signal,
  })) as any

  for await (const chunk of stream) {
    if (abortController?.signal.aborted) {
      throw new Error('Request aborted')
    }

    // usage 末块:choices 为空、usage 在场
    if (chunk.usage) {
      usage = chunk.usage
      continue
    }

    const delta = chunk.choices[0]?.delta
    if (delta) {
      if (delta.content) {
        fullContent += delta.content
        streamCallback({
          content: delta.content,
          reasoningContent: delta.reasoning_content,
          toolCalls: delta.tool_calls,
          isStreamComplete: false,
        })
      }

      if (delta.reasoning_content) {
        const now = Date.now()
        if (firstReasoningAt === null) firstReasoningAt = now
        lastReasoningAt = now
        fullReasoningContent += delta.reasoning_content
        streamCallback({
          content: delta.content,
          reasoningContent: delta.reasoning_content,
          toolCalls: delta.tool_calls,
          isStreamComplete: false,
        })
      }

      if (delta.tool_calls) {
        toolCalls = mcpService.processStreamToolCalls(delta, toolCalls)
        streamCallback({
          content: delta.content,
          reasoningContent: delta.reasoning_content,
          toolCalls,
          isStreamComplete: false,
        })
      }
    }
  }

  streamCallback({
    content: '',
    reasoningContent: '',
    toolCalls,
    isStreamComplete: true,
  })

  return {
    content: fullContent,
    reasoningContent: fullReasoningContent,
    thinkingDurationMs:
      firstReasoningAt !== null && lastReasoningAt !== null ? lastReasoningAt - firstReasoningAt : undefined,
    toolCalls,
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          ...(usage.prompt_tokens_details?.cached_tokens !== undefined || usage.prompt_cache_hit_tokens !== undefined
            ? { cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens }
            : {}),
          ...(usage.prompt_cache_miss_tokens !== undefined
            ? { cacheWriteTokens: usage.prompt_cache_miss_tokens }
            : {}),
        }
      : undefined,
  }
}
