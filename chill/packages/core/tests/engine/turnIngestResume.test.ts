import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'

/**
 * M7增量3·决策30/31 引擎侧测试：
 * ① onIngested 两段式时序：用户消息持久化后、模型调用前触发；
 * ② hook deny → onIngested 不触发（未收录即消费）；
 * ③ 轮次失败 → roundFailure 合成留痕入史 + 异常上抛（永不沉默）；
 * ④ resumePendingRound：尾部未回复的 user 消息重跑不重复 append；尾部非 user 返回 false。
 */

const T0 = new Date('2025-01-01T00:00:00Z')

function makeRecord(messages: Message[]): SessionRecord {
  return {
    id: 's1',
    title: 't',
    titleSource: 'default',
    messages,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }
}

interface EngineEnvOptions {
  modelBehavior?: 'ok' | 'boom'
  hookRunner?: unknown
}

function makeEngineEnv(options: EngineEnvOptions = {}) {
  let modelCalls = 0
  const savedRecords: SessionRecord[] = []
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async () => {
        modelCalls++
        if (options.modelBehavior === 'boom') throw new Error('模拟模型侧故障')
        return { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async (record: SessionRecord) => {
        savedRecords.push(JSON.parse(JSON.stringify(record)))
        return { success: true }
      },
      load: async () => ({
        success: true,
        record: makeRecord([{ role: 'user' as Message['role'], content: '崩溃前的消息', timestamp: T0 }]),
      }),
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true, data: { content: 'sync-result' } }),
      executeAsync: async () => ({ success: true, data: { content: 'r' } }),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    ...(options.hookRunner ? { hookRunner: options.hookRunner as ChatEngineDeps['hookRunner'] } : {}),
  }
  return { deps, modelCalls: () => modelCalls, savedRecords }
}

test('① onIngested 时序：用户消息已落盘、模型调用前触发，且只触发一次', async () => {
  const env = makeEngineEnv()
  const engine = new ChatEngine(env.deps)
  await engine.loadSession('s1')
  let fired = 0
  let modelCallsAtFire = -1
  let savedAtFire = false
  const result = await engine.enqueueExternalMessage({ text: '手机来的消息', origin: 'mobile' }, {
    onIngested: () => {
      fired++
      modelCallsAtFire = env.modelCalls()
      // 回调触发时：消息已在内存历史 + 已持久化（本次 save 的记录含该消息）
      savedAtFire = env.savedRecords.some((r) => r.messages.some((m) => m.content === '手机来的消息'))
    },
  })
  assert.equal(fired, 1)
  assert.equal(modelCallsAtFire, 0, 'onIngested 必须在模型调用之前')
  assert.ok(savedAtFire, 'onIngested 触发时用户消息必须已持久化')
  assert.equal(result.content, 'ok')
  // 最终历史：原 user + 新 user + assistant
  const roles = engine.getHistory().map((m) => `${m.role}:${m.content}`)
  assert.deepEqual(roles, ['user:崩溃前的消息', 'user:手机来的消息', 'assistant:ok'])
})

test('② hook deny：onIngested 不触发（未收录即消费，不写台账不重投）', async () => {
  const denyRunner = {
    dispatch: async () => ({
      verdict: { type: 'deny', reason: '拦截' },
      systemMessages: [],
      additionalContext: [],
    }),
  }
  const env = makeEngineEnv({ hookRunner: denyRunner })
  const engine = new ChatEngine(env.deps)
  await engine.loadSession('s1')
  let fired = 0
  const result = await engine.enqueueExternalMessage({ text: '危险', origin: 'mobile' }, {
    onIngested: () => {
      fired++
    },
  })
  assert.equal(fired, 0)
  assert.equal(result.deniedReason, '拦截')
})

test('③ 轮次失败：roundFailure 合成留痕入史 + 异常原样上抛（永不沉默）', async () => {
  const env = makeEngineEnv({ modelBehavior: 'boom' })
  const engine = new ChatEngine(env.deps)
  await engine.loadSession('s1')
  await assert.rejects(engine.sendMessage({ text: '会失败的消息' }), /模拟模型侧故障/)
  const history = engine.getHistory()
  const last = history[history.length - 1]
  assert.equal(last.synthetic, 'roundFailure')
  assert.ok(last.content.includes('模拟模型侧故障'))
  // 下一轮模型请求经出口闸：roundFailure 是 user 角色合成消息（内容照常进上下文），无需特判
  assert.equal(last.role, 'user')
})

test('④ resumePendingRound：尾部未回复 user 消息重跑，不重复 append；尾部非 user 返回 null', async () => {
  const env = makeEngineEnv()
  const engine = new ChatEngine(env.deps)
  await engine.loadSession('s1') // 盘上尾部 = user「崩溃前的消息」未回复
  const result = await engine.resumePendingRound()
  assert.ok(result !== null, '应返回轮次结果')
  assert.equal(result.content, 'ok')
  const history = engine.getHistory()
  // 恰一条「崩溃前的消息」+ 一条 assistant 回复（无重复 append）
  assert.equal(history.filter((m) => m.content === '崩溃前的消息').length, 1)
  assert.equal(history[history.length - 1].role, 'assistant')
  assert.equal(history[history.length - 1].content, 'ok')
  // 尾部已是 assistant：无可恢复轮
  assert.equal(await engine.resumePendingRound(), null)
})
