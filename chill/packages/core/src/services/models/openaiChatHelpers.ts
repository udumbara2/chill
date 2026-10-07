import type OpenAI from 'openai'
import type { ModelResponse, StreamCallback } from '../../types/models'
import { accumulateToolCallDelta, finalizeToolCalls } from './toolCallStream'
import { isWireTraceEnabled, traceWireChunk } from './wireTrace'

/**
 * 转换 OpenAI 响应为 ModelResponse 格式
 */
export function convertOpenAIResponseToModelResponse(response: any): ModelResponse {
  const choice = response.choices[0]
  const message = choice.message

  return {
    content: message.content || '',
    reasoningContent: message.reasoning_content || '',
    // M7增量3·决策26：非流式路径同样过终局校验（畸形抛 MalformedToolCallError，由 handler 重试包装接住）
    toolCalls: finalizeToolCalls(message.tool_calls || []),
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
 * 处理流式响应（工具调用分片经 toolCallStream 单调累积 + 终局校验——M7增量3·决策26：
 * 服务端分片带显式 null 不再抹掉好值；终局畸形抛 MalformedToolCallError 由 handler 重试）
 */
export async function handleStreamResponse(
  client: OpenAI,
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

    // 原始线缆捕获（M7增量3·决策33）：默认关；开启时逐 chunk 落 ndjson（诊断证据，静默失败）
    if (isWireTraceEnabled()) traceWireChunk(String(requestParams?.model ?? ''), chunk)

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
        toolCalls = accumulateToolCallDelta(delta, toolCalls)
        streamCallback({
          content: delta.content,
          reasoningContent: delta.reasoning_content,
          toolCalls,
          isStreamComplete: false,
        })
      }
    }
  }

  // 终局校验（M7增量3·决策26）：id/name/arguments 不合法抛 MalformedToolCallError，
  // 由 openAIChatHandler 的重试包装丢弃本轮输出并重发一次
  toolCalls = finalizeToolCalls(toolCalls)

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
