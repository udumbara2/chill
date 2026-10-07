import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approxTokensForRound } from '../../src/services/models/approxTokens.ts'
import { MessageRole, type Message, type ModelResponse } from '../../src/types/models.ts'

function msg(content: Message['content'], extra?: Partial<Message>): Message {
  return { role: MessageRole.USER, content, timestamp: new Date(), ...extra }
}

test('纯文本:2 字符/token 比率,prompt/completion 分侧', () => {
  const r = approxTokensForRound([msg('a'.repeat(100))], { content: 'b'.repeat(20) })
  assert.deepEqual(r, { promptTokens: 50, completionTokens: 10, totalTokens: 60 })
})

test('媒体块转为占位符(base64 不爆估)', () => {
  const huge = 'x'.repeat(100000)
  const r = approxTokensForRound(
    [msg([{ type: 'text', text: '看一看' } as any, { type: 'image_url', image_url: { url: `data:image/png;base64,${huge}` } } as any])],
    { content: '好' },
  )
  // '看一看'(3) + ' [图片]'(拼接含空格,4) = 7 字符 → 4;输出 1 字符 → 1
  assert.equal(r.promptTokens, 4)
  assert.equal(r.completionTokens, 1)
})

test('计费载荷含 reasoningContent 与 toolCalls 序列化(输入侧)', () => {
  const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }]
  const serializedLen = JSON.stringify(toolCalls).length
  const r = approxTokensForRound(
    [msg('q'.repeat(10), { reasoningContent: 'r'.repeat(10), toolCalls: toolCalls as any })],
    { content: '' },
  )
  assert.equal(r.promptTokens, Math.round((10 + 10 + serializedLen) / 2))
})

test('计费载荷含 reasoningContent 与 toolCalls 序列化(输出侧)', () => {
  const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"b","content":"xx"}' } }]
  const serializedLen = JSON.stringify(toolCalls).length
  const r = approxTokensForRound(
    [msg('hi')],
    { content: 'c'.repeat(6), reasoningContent: 't'.repeat(4), toolCalls: toolCalls as any } as ModelResponse,
  )
  assert.equal(r.completionTokens, Math.round((6 + 4 + serializedLen) / 2))
})

test('下限 1:空输入/空输出不归零(0 会被当无计量数据)', () => {
  const r = approxTokensForRound([msg('')], { content: '' })
  assert.deepEqual(r, { promptTokens: 1, completionTokens: 1, totalTokens: 2 })
})
