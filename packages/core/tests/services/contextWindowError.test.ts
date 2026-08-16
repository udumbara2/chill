import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isContextWindowExceeded } from '../../src/services/contextWindowError.ts'

/**
 * R3 窗口超限错误识别单测：各 provider 官方文案命中；非超限错误（abort/网络/普通 400）不误判。
 */

test('各 provider 超限文案命中', () => {
  assert.equal(isContextWindowExceeded(new Error("This model's maximum context length is 128000 tokens. However, you requested ... Request failed with status code 400. Error code: context_length_exceeded")), true)
  assert.equal(isContextWindowExceeded(new Error('maximum context length is 8192 tokens')), true)
  assert.equal(isContextWindowExceeded(new Error('prompt is too long: 21000 tokens > 2000 maximum')), true)
  assert.equal(isContextWindowExceeded(new Error('input length and `max_tokens` exceed context limit: 20999 + 4096 > 20480')), true)
})

test('非超限错误不误判（漏判只是少一次恢复，误判会触发不必要的强制压缩）', () => {
  assert.equal(isContextWindowExceeded(new Error('Request aborted')), false)
  assert.equal(isContextWindowExceeded(new Error('Request failed with status code 500')), false)
  assert.equal(isContextWindowExceeded(new Error('rate limit exceeded')), false)
  assert.equal(isContextWindowExceeded(new Error('tool execution failed')), false)
  // 泛化词不收录：防误判
  assert.equal(isContextWindowExceeded(new Error('the context window is a feature')), false)
  assert.equal(isContextWindowExceeded(null), false)
  assert.equal(isContextWindowExceeded(undefined), false)
  assert.equal(isContextWindowExceeded(42), false)
  assert.equal(isContextWindowExceeded(''), false)
})
