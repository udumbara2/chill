import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertMessagesToAnthropicFormat } from '../../src/services/models/handlers/anthropicChatHelpers.ts'
import { MessageRole, type Message } from '../../src/types/models.ts'

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function toolMsg(content: Message['content']): Message {
  return { role: MessageRole.TOOL, content, toolCallId: 'toolu_1', timestamp: new Date() }
}

const userMsg: Message = { role: MessageRole.USER, content: '看一下屏幕', timestamp: new Date() }

/** 转换结果中的首个 tool_result 块（转换器会把相邻同角色消息合并，不能按下标取） */
function firstToolResult(messages: any[]): any {
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : []
    const tr = blocks.find((b: any) => b.type === 'tool_result')
    if (tr) return tr
  }
  return undefined
}

test('tool_result：字符串 content 保持原文（既有行为不变）', () => {
  const { messages } = convertMessagesToAnthropicFormat([userMsg, toolMsg('执行完成')])
  const tr = firstToolResult(messages)
  assert.equal(tr.tool_use_id, 'toolu_1')
  assert.equal(tr.content, '执行完成')
})

test('tool_result：ContentPart[] content 转为 text + image base64 source 块', () => {
  const { messages } = convertMessagesToAnthropicFormat([
    userMsg,
    toolMsg([
      { type: 'text', text: '{"content":"截图尺寸 1280×720"}' },
      { type: 'image_url', image_url: { url: PNG_DATA_URI } },
    ]),
  ])
  const tr = firstToolResult(messages)
  assert.equal(tr.tool_use_id, 'toolu_1')
  assert.ok(Array.isArray(tr.content))
  assert.deepEqual(tr.content[0], { type: 'text', text: '{"content":"截图尺寸 1280×720"}' })
  assert.deepEqual(tr.content[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    },
  })
})

test('tool_result：数组 content 中非法 data URI 的图像块被跳过（不产出坏块）', () => {
  const { messages } = convertMessagesToAnthropicFormat([
    userMsg,
    toolMsg([
      { type: 'text', text: '摘要' },
      { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
    ]),
  ])
  const tr = firstToolResult(messages)
  assert.deepEqual(tr.content, [{ type: 'text', text: '摘要' }])
})
