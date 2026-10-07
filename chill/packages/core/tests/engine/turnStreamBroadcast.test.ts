import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message, MessageRole } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import { EVENTS } from '../../src/utils/eventBus.ts'

/**
 * M6 引擎被动流广播（TURN_STREAM_CHUNK）+ 历史失效（HISTORY_INVALIDATED）+ 当前会话通告测试。
 * 真实 ChatEngine + 最小 fake deps（模式同 abortSeal.test.ts）；deps.eventBus 用收集型桩。
 * 验证：
 * - sendMessage 的流式 chunk 原样透传主动回调的同时广播上总线（sessionId/kind/text；kind=tool 不在此通道）；
 * - 本机轮同样广播（sendMessage 即本机路径；被动广播不区分发起端）；
 * - regenerate 成功（replace 落定）广播 HISTORY_INVALIDATED；abort 回滚不广播；
 * - onActiveSessionChanged 在 id 诞生/loadSession/startNewSession/detachSession 各点触发。
 */

const USER = 'user' as MessageRole
const ASSISTANT = 'assistant' as MessageRole
const T0 = new Date('2025-01-01T00:00:00Z')
const T1 = new Date('2025-01-01T00:01:00Z')

interface CollectedEvent {
  name: string
  payload: unknown
}

function makeDeps(options: {
  onCall?: (callIndex: number, params: { streamCallback?: (c: unknown) => void }) => Promise<unknown> | unknown
  loadRecord?: SessionRecord
  events?: CollectedEvent[]
} = {}) {
  const saved: SessionRecord[] = []
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: { streamCallback?: (c: unknown) => void }) =>
        options.onCall ? options.onCall(0, params) : { content: 'ok' },
    } as never,
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => undefined,
    } as never,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as never,
    sessionStore: {
      save: async (record: SessionRecord) => {
        saved.push(record)
        return { success: true }
      },
      load: async () =>
        options.loadRecord ? { success: true, record: options.loadRecord } : { success: false },
    } as never,
    builtInToolExecutor: {
      execute: () => ({ success: true, data: { content: 'sync-result' } }),
      executeAsync: async (toolName: string) => ({ success: true, data: { content: `result-of-${toolName}` } }),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
    } as never,
    mcpService: { getAggregatedOpenAITools: async () => [] } as never,
    eventBus: {
      on: () => {},
      off: () => {},
      emit: (name: string, payload: unknown) => options.events?.push({ name, payload }),
    } as never,
  }
  return { deps, saved }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const hang = () => new Promise<unknown>(() => {})

test('TURN_STREAM_CHUNK：流式 chunk 广播（delta/reasoning 各一条，携带 sessionId），主动回调原样透传', async () => {
  const events: CollectedEvent[] = []
  const { deps } = makeDeps({
    events,
    onCall: (_i, params) => {
      params.streamCallback?.({ content: '答', isStreamComplete: false })
      params.streamCallback?.({ reasoningContent: '想', isStreamComplete: false })
      params.streamCallback?.({ content: '案', isStreamComplete: true })
      return { content: '答案' }
    },
  })
  const engine = new ChatEngine(deps)
  const active: string[] = []
  engine.onActiveSessionChanged = (id) => active.push(id ?? 'null')
  const received: unknown[] = []
  const result = await engine.sendMessage({ text: '问' }, { streamCallback: (c) => received.push(c) })

  assert.equal(result.content, '答案')
  assert.equal(received.length, 3) // 主动路径原样透传不回归
  const chunks = events.filter((e) => e.name === EVENTS.TURN_STREAM_CHUNK)
  const sessionId = engine.getSessionState().sessionId
  assert.ok(sessionId !== null)
  assert.deepEqual(
    chunks.map((e) => e.payload),
    [
      { sessionId, kind: 'delta', text: '答' },
      { sessionId, kind: 'reasoning', text: '想' },
      { sessionId, kind: 'delta', text: '案' },
    ],
  )
  // 会话 id 诞生（null → 新 id）通告 active.changed
  assert.deepEqual(active, [sessionId])
  engine.dispose()
})

test('HISTORY_INVALIDATED：regenerate 成功（replace 落定）广播；abort 回滚不广播', async () => {
  const record: SessionRecord = {
    id: 's1',
    title: 't',
    titleSource: 'default',
    messages: [
      { role: USER, content: '旧问题', timestamp: T0 },
      { role: ASSISTANT, content: '旧回答', timestamp: T1 },
    ],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:01:00.000Z',
  }
  // 成功路径：replace 落定 → 广播失效信号
  const events: CollectedEvent[] = []
  const { deps } = makeDeps({ events, loadRecord: record, onCall: () => ({ content: '新回答' }) })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  const result = await engine.regenerate()
  assert.equal(result.aborted, false)
  const invalidated = events.filter((e) => e.name === EVENTS.HISTORY_INVALIDATED)
  assert.deepEqual(invalidated.map((e) => e.payload), [{ sessionId: 's1' }])
  engine.dispose()

  // abort 路径：rollback 不落盘（盘与内存一致）→ 不广播
  const events2: CollectedEvent[] = []
  const { deps: deps2 } = makeDeps({ events: events2, loadRecord: record, onCall: () => hang() })
  const engine2 = new ChatEngine(deps2)
  await engine2.loadSession('s1')
  const turn = engine2.regenerate()
  await sleep(10)
  engine2.abort()
  const result2 = await turn
  assert.equal(result2.aborted, true)
  assert.equal(events2.filter((e) => e.name === EVENTS.HISTORY_INVALIDATED).length, 0)
  // 旧末轮恢复（rollback 语义不回归；断言风格对齐 abortSeal.test.ts 的 regenerate abort 用例）
  const history = engine2.getHistory()
  assert.equal(history[history.length - 1]!.content, '旧回答')
  engine2.dispose()
})

test('onActiveSessionChanged：startNewSession(null) → id 诞生 → loadSession → detachSession(换新 id)', async () => {
  const record: SessionRecord = {
    id: 's-load',
    title: 't',
    messages: [{ role: USER, content: 'hi', timestamp: T0 }],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }
  const { deps } = makeDeps({ loadRecord: record })
  const engine = new ChatEngine(deps)
  const active: (string | null)[] = []
  engine.onActiveSessionChanged = (id) => active.push(id)

  engine.startNewSession()
  assert.deepEqual(active, [null])
  await engine.sendMessage({ text: '首轮' }) // ensureSessionId 诞生新 id
  assert.equal(active.length, 2)
  const bornId = active[1]
  assert.ok(typeof bornId === 'string' && bornId.length > 0)

  await engine.loadSession('s-load')
  assert.deepEqual(active[2], 's-load')
  // 1.1：detachSession 改"保留历史、换新 id"（id 与生俱来，不再置 null 等下次落盘铸造）
  engine.detachSession()
  assert.equal(active.length, 4)
  const detachedId = active[3]
  assert.ok(typeof detachedId === 'string' && detachedId.length > 0, 'detach 后立即是新 id')
  assert.notEqual(detachedId, 's-load')
  assert.equal(engine.getHistory().length, 1, 'detach 保留历史')
  engine.dispose()
})
