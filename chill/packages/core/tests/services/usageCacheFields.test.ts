import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertOpenAIResponseToModelResponse } from '../../src/services/models/openaiChatHelpers.ts'
import { parseAnthropicResponse } from '../../src/services/models/handlers/anthropicChatHelpers.ts'

/**
 * usage 缓存字段抽取单测（三协议响应形态 mock → ModelResponse.usage 映射）：
 * - OpenAI：prompt_tokens_details.cached_tokens
 * - DeepSeek（openai-chat 协议）：prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - Anthropic：cache_read_input_tokens / cache_creation_input_tokens
 * - 协议未报告缓存字段 → 字段缺省（optional，客户端不被迫实现）
 */

test('OpenAI 形态：cached_tokens → cacheReadTokens；无 miss 字段则 cacheWriteTokens 缺省', () => {
  const r = convertOpenAIResponseToModelResponse({
    choices: [{ message: { content: 'hi' } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
    },
  })
  assert.equal(r.usage?.cacheReadTokens, 800)
  assert.equal(r.usage?.cacheWriteTokens, undefined)
  assert.equal(r.usage?.promptTokens, 1000)
})

test('OpenAI 形态：无 prompt_tokens_details → 两缓存字段都缺省', () => {
  const r = convertOpenAIResponseToModelResponse({
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
  })
  assert.equal(r.usage?.cacheReadTokens, undefined)
  assert.equal(r.usage?.cacheWriteTokens, undefined)
})

test('DeepSeek 形态：prompt_cache_hit_tokens/miss_tokens → cacheRead/WriteTokens', () => {
  const r = convertOpenAIResponseToModelResponse({
    choices: [{ message: { content: 'hi' } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_cache_hit_tokens: 600,
      prompt_cache_miss_tokens: 400,
    },
  })
  assert.equal(r.usage?.cacheReadTokens, 600)
  assert.equal(r.usage?.cacheWriteTokens, 400)
})

test('Anthropic 形态：cache_read/creation_input_tokens → cacheRead/WriteTokens', () => {
  const r = parseAnthropicResponse({
    content: [{ type: 'text', text: 'hi' }],
    usage: {
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 300,
    },
  })
  assert.equal(r.usage?.cacheReadTokens, 700)
  assert.equal(r.usage?.cacheWriteTokens, 300)
  assert.equal(r.usage?.promptTokens, 1000)
  assert.equal(r.usage?.totalTokens, 1050)
})

test('Anthropic 形态：无缓存字段 → 缺省（optional）', () => {
  const r = parseAnthropicResponse({
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 1000, output_tokens: 50 },
  })
  assert.equal(r.usage?.cacheReadTokens, undefined)
  assert.equal(r.usage?.cacheWriteTokens, undefined)
})
