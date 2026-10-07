import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MalformedToolCallError,
  withMalformedRetry,
} from '../../src/services/models/toolCallStream.ts'
import { handleStreamResponse, convertOpenAIResponseToModelResponse } from '../../src/services/models/openaiChatHelpers.ts'

function fakeClient(gen: () => AsyncGenerator<any>): any {
  return { chat: { completions: { create: async () => gen() } } }
}
const delta = (d: any): any => ({ choices: [{ delta: d }] })
const noop = (): void => {}

// ---------- withMalformedRetry（决策26 重试策略单点） ----------

test('重试策略：畸形→重试一次成功，共调用 2 次，用户无感', async () => {
  let calls = 0
  const r = await withMalformedRetry(async () => {
    calls++
    if (calls === 1) throw new MalformedToolCallError('第一次畸形')
    return 'ok'
  })
  assert.equal(r, 'ok')
  assert.equal(calls, 2)
})

test('重试策略：两次畸形 → 第二次异常上抛（有界不循环），共调用 2 次', async () => {
  let calls = 0
  await assert.rejects(
    withMalformedRetry(async () => {
      calls++
      throw new MalformedToolCallError(`第${calls}次畸形`)
    }),
    MalformedToolCallError,
  )
  assert.equal(calls, 2)
})

test('重试策略：abort 已触发 → 不重试直接上抛（共调用 1 次）', async () => {
  let calls = 0
  await assert.rejects(
    withMalformedRetry(
      async () => {
        calls++
        throw new MalformedToolCallError('畸形')
      },
      () => true,
    ),
    MalformedToolCallError,
  )
  assert.equal(calls, 1)
})

test('重试策略：非畸形异常不重试（网络错等交给既有错误处理）', async () => {
  let calls = 0
  await assert.rejects(
    withMalformedRetry(async () => {
      calls++
      throw new Error('connection reset')
    }),
    /connection reset/,
  )
  assert.equal(calls, 1)
})

// ---------- helpers 接线（流式 finalize + 非流式校验的端到端行为） ----------

test('流式端到端：事故形态（好首片 + null 后续片）累积出完好 toolCalls', async () => {
  const gen = async function* (): AsyncGenerator<any> {
    yield delta({ tool_calls: [{ index: 0, id: 'call_00_x', type: 'function', function: { name: 'team_board', arguments: '{"a' } }] })
    yield delta({ tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '":1}' } }] })
  }
  const resp = await handleStreamResponse(fakeClient(gen), { stream: true }, noop)
  assert.equal(resp.toolCalls.length, 1)
  assert.equal(resp.toolCalls[0].id, 'call_00_x')
  assert.equal(resp.toolCalls[0].function.name, 'team_board')
  assert.equal(resp.toolCalls[0].function.arguments, '{"a":1}')
})

test('流式端到端：全程无有效 name → finalize 抛 MalformedToolCallError', async () => {
  const gen = async function* (): AsyncGenerator<any> {
    yield delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: null, arguments: '{}' } }] })
  }
  await assert.rejects(handleStreamResponse(fakeClient(gen), { stream: true }, noop), MalformedToolCallError)
})

test('非流式端到端：null id/name 的 tool_calls 抛 MalformedToolCallError（事故 idx66 形态）', () => {
  assert.throws(
    () =>
      convertOpenAIResponseToModelResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { index: 0, id: null, type: 'function', function: { name: null, arguments: '{"action":"post"}' } },
                { index: 1, id: null, type: 'function', function: { name: null, arguments: '{"q":"新闻"}' } },
              ],
            },
          },
        ],
      }),
    MalformedToolCallError,
  )
})

test('非流式端到端：合法 tool_calls 正常转换不受影响', () => {
  const r = convertOpenAIResponseToModelResponse({
    choices: [
      {
        message: {
          content: '好',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
        },
      },
    ],
  })
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.toolCalls[0].function.name, 'read_file')
})
