import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSeedMessages, buildConversation } from '../../src/orchestrator/isolation/workers/conversationTranscript.ts'

test('种子续聊: priorMessages + 新追问，不重复加 system、无模板包装', () => {
  const prior = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '原任务' },
    { role: 'assistant', content: '原答复' },
  ]
  const messages = buildSeedMessages(prior, '第三点改成 XX') as Array<{ role: string; content: string }>
  assert.equal(messages.length, 4)
  assert.deepEqual(messages.slice(0, 3).map(m => m.role), ['system', 'user', 'assistant'])
  assert.equal(messages[3].role, 'user')
  assert.equal(messages[3].content, '第三点改成 XX')
  // system 只出现一次（transcript 已含，不重复加）
  assert.equal(messages.filter(m => m.role === 'system').length, 1)
})

test('种子续聊: 不修改原 transcript 数组（不可变）', () => {
  const prior = [{ role: 'system', content: 'sys' }]
  const messages = buildSeedMessages(prior, '追问')
  assert.equal(prior.length, 1, '原数组不被追加')
  assert.equal((messages as unknown[]).length, 2)
})

test('transcript 拼装: 请求消息 + 工具循环增量 + 末轮 assistant 消息', () => {
  const requestMessages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '任务' },
  ]
  const response = {
    content: '最终答复',
    reasoningContent: '推理过程',
    producedMessages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1' }] },
      { role: 'tool', content: '工具结果', toolCallId: 'c1' },
    ],
  }
  const conversation = buildConversation(requestMessages, response) as Array<Record<string, unknown>>
  assert.equal(conversation.length, 5)
  assert.deepEqual(conversation.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'assistant'])
  const finalMsg = conversation[4]
  assert.equal(finalMsg.content, '最终答复')
  assert.equal(finalMsg.reasoningContent, '推理过程')
})

test('transcript 拼装: producedMessages 缺省时 = 请求消息 + 末轮 assistant', () => {
  const conversation = buildConversation(
    [{ role: 'system', content: 'sys' }, { role: 'user', content: '任务' }],
    { content: '答复' }
  ) as Array<Record<string, unknown>>
  assert.equal(conversation.length, 3)
  assert.equal(conversation[2].role, 'assistant')
  assert.equal(conversation[2].content, '答复')
})
