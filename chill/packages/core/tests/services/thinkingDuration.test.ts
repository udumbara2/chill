import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleStreamResponse,
  convertOpenAIResponseToModelResponse,
} from '../../src/services/models/openaiChatHelpers.ts'

/** 伪流式 client：chunks 由生成器依序吐出（create 返回 async iterable 即可） */
function fakeClient(gen: () => AsyncGenerator<any>): any {
  return { chat: { completions: { create: async () => gen() } } }
}

const delta = (d: any): any => ({ choices: [{ delta: d }] })
const noop = (): void => {}

test('流式打点：首个→末个 reasoning delta 时间差作为 thinkingDurationMs 透出', async () => {
  const realNow = Date.now
  let t = 1_000_000
  Date.now = () => t
  try {
    const gen = async function* (): AsyncGenerator<any> {
      yield delta({ reasoning_content: '想一' }) // 首个 delta @ t
      t += 2000
      yield delta({ reasoning_content: '想二' }) // 末个 delta @ t+2000
      t += 5000 // 正文耗时不计入思考时长
      yield delta({ content: '答' })
    }
    const resp = await handleStreamResponse(fakeClient(gen), {}, noop)
    assert.equal(resp.thinkingDurationMs, 2000)
    assert.equal(resp.reasoningContent, '想一想二')
    assert.equal(resp.content, '答')
  } finally {
    Date.now = realNow
  }
})

test('流式无 reasoning delta：thinkingDurationMs 缺省', async () => {
  const gen = async function* (): AsyncGenerator<any> {
    yield delta({ content: '答' })
  }
  const resp = await handleStreamResponse(fakeClient(gen), {}, noop)
  assert.equal(resp.thinkingDurationMs, undefined)
})

test('非流式路径：不打点，响应无 thinkingDurationMs 字段', () => {
  const resp = convertOpenAIResponseToModelResponse({
    choices: [{ message: { content: '答', reasoning_content: '想' } }],
  })
  assert.equal(resp.reasoningContent, '想')
  assert.equal('thinkingDurationMs' in resp, false)
})
