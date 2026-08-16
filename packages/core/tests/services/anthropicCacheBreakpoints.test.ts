import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAnthropicCacheBreakpoints } from '../../src/services/models/handlers/anthropicChatHelpers.ts'

/**
 * R0 Anthropic 缓存断点单测（纯策略函数）：
 * system 升格 blocks / tools 末项 / 最后一条消息末块（string 升格、blocks 原位）；
 * 字段缺失安全跳过；3 断点 ≤ 官方上限 4。
 */

const CC = { type: 'ephemeral' }

test('system string 升格为 blocks 并带断点；tools 末项带断点（非末项不带）', () => {
  const body: any = {
    system: '你是助手',
    tools: [{ name: 'a' }, { name: 'b' }],
    messages: [{ role: 'user', content: 'hi' }],
  }
  applyAnthropicCacheBreakpoints(body)
  assert.deepEqual(body.system, [{ type: 'text', text: '你是助手', cache_control: CC }])
  assert.equal(body.tools[0].cache_control, undefined)
  assert.deepEqual(body.tools[1].cache_control, CC)
})

test('最后一条消息 string content 升格 blocks；非最后一条不动', () => {
  const body: any = {
    messages: [
      { role: 'user', content: '旧消息' },
      { role: 'assistant', content: '回复' },
      { role: 'user', content: '新消息' },
    ],
  }
  applyAnthropicCacheBreakpoints(body)
  assert.equal(body.messages[0].content, '旧消息')
  assert.deepEqual(body.messages[2].content, [{ type: 'text', text: '新消息', cache_control: CC }])
})

test('最后一条消息 blocks content：末块原位加断点（不升格不重建）', () => {
  const body: any = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '前' }, { type: 'text', text: '后' }] },
    ],
  }
  applyAnthropicCacheBreakpoints(body)
  assert.equal(body.messages[0].content[0].cache_control, undefined)
  assert.deepEqual(body.messages[0].content[1].cache_control, CC)
  assert.equal(body.messages[0].content[1].text, '后')
})

test('字段缺失（无 system/tools、空消息、空 content）安全跳过不抛', () => {
  const body: any = { messages: [] }
  applyAnthropicCacheBreakpoints(body) // 不抛
  const body2: any = { messages: [{ role: 'user', content: [] }] }
  applyAnthropicCacheBreakpoints(body2) // 空 blocks 数组跳过
  const body3: any = {}
  applyAnthropicCacheBreakpoints(body3) // 全缺省跳过
})
