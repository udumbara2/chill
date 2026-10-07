import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngineEnqueue, createEngineEnqueueBy } from '../../src/services/relayEngineWiring.ts'
import type { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { EnqueueInput } from '../../src/services/relay/RelayBridge.ts'

/**
 * M0.1′（多会话并行规划）enqueue 路由回归：
 * - createEngineEnqueueBy：resolve 按 input.sessionId 直寻引擎（多会话 registry 宿主），
 *   无 id 回退 fallback；
 * - createEngineEnqueue（旧装配）：绑定引擎恒定——有 id 也回退绑定引擎
 *  （其 ensureActiveSession 已把唯一引擎切到目标会话，行为逐位不变）。
 */

function makeFakeEngine(name: string): { engine: ChatEngine; inputs: Array<{ text: string; origin?: string; clientId?: string }>; resolve: (content: string) => void } {
  const inputs: Array<{ text: string; origin?: string; clientId?: string }> = []
  let resolve!: (content: string) => void
  const pending = new Promise<string>((r) => {
    resolve = r
  })
  const engine = {
    enqueueExternalMessage: async (input: { text: string; origin?: string; clientId?: string }) => {
      inputs.push(input)
      const content = await pending
      return { content, aborted: false }
    },
  } as unknown as ChatEngine
  return { engine, inputs, resolve: (c: string) => resolve(c) }
}

test('M0.1 createEngineEnqueueBy：按 sessionId 直寻引擎；无 id 回退 fallback', async () => {
  const a = makeFakeEngine('A')
  const b = makeFakeEngine('B')
  const fallback = makeFakeEngine('F')
  const registry = new Map<string, ChatEngine>([
    ['s-a', a.engine],
    ['s-b', b.engine],
  ])
  const enqueue = createEngineEnqueueBy((sessionId) => registry.get(sessionId ?? '') ?? fallback.engine)

  const pa = enqueue({ text: '去 A', sessionId: 's-a', clientId: 'env-1' })
  const pb = enqueue({ text: '去 B', sessionId: 's-b', clientId: 'env-2' })
  const pf = enqueue({ text: '无 id 走回退', clientId: 'env-3' })
  const pn = enqueue({ text: '未知 id 走回退', sessionId: 's-none', clientId: 'env-4' })

  assert.equal(a.inputs.length, 1, 'A 引擎收到 s-a 消息')
  assert.equal(b.inputs.length, 1, 'B 引擎收到 s-b 消息')
  assert.equal(fallback.inputs.length, 2, '无 id/未知 id 都落到 fallback')
  assert.equal(a.inputs[0]!.text, '去 A')
  assert.equal(a.inputs[0]!.origin, 'mobile', 'origin=mobile 透传（手机注入语义）')
  assert.equal(a.inputs[0]!.clientId, 'env-1', 'clientId 透传（overlay 回声匹配键）')

  a.resolve('A 的回复')
  b.resolve('B 的回复')
  fallback.resolve('回退回复')
  const [ra, rb, rf, rn] = await Promise.all([pa, pb, pf, pn])
  assert.equal(ra.content, 'A 的回复')
  assert.equal(rb.content, 'B 的回复')
  assert.equal(rf.content, '回退回复')
  assert.equal(rn.content, '回退回复')
})

test('M0.1 createEngineEnqueue（旧装配）：有 id 也回退绑定引擎（行为逐位不变）', async () => {
  const bound = makeFakeEngine('绑定')
  const enqueue = createEngineEnqueue(bound.engine)
  const p = enqueue({ text: '带 id 也好', sessionId: 's-anywhere', clientId: 'env-9' })
  assert.equal(bound.inputs.length, 1, '单引擎装配忽略 sessionId——始终绑定的引擎')
  assert.equal((bound.inputs[0] as { text: string }).text, '带 id 也好')
  bound.resolve('绑定引擎回复')
  assert.equal((await p).content, '绑定引擎回复')
})
