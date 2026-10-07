import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import { SessionRegistry } from '../../src/services/sessionRegistry/SessionRegistry.ts'

/**
 * SessionRegistry（1.2/1.8）：双引擎并存、open 幂等/单写者、detach 重键、
 * 订阅列表多订阅者、close 语义（封口→endSession→dispose）、load 失败不留半生引擎。
 */

const T0 = new Date('2025-01-01T00:00:00Z')

function makeRecord(id: string): SessionRecord {
  return {
    id,
    title: `标题-${id}`,
    messages: [{ role: 'user' as Message['role'], content: 'hi', timestamp: T0 }],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }
}

interface EnvOptions {
  records?: Record<string, SessionRecord>
}

/** 最小 fake deps（模式同 goalMode.test.ts）；返回工厂供 registry 使用 */
function makeFactory(options: EnvOptions = {}) {
  const saved: SessionRecord[] = []
  const disposed: string[] = []
  const createEngine = (): ChatEngine => {
    const deps: ChatEngineDeps = {
      modelCaller: {
        callOnce: async () => ({ content: 'ok' }),
      },
      modelInfo: {
        getModelsWithApiKeys: async () => [],
        getModelInfoByName: () => undefined,
      } as any,
      selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
      sessionStore: {
        save: async (record: SessionRecord) => {
          saved.push(record)
          return { success: true }
        },
        load: async (id: string) => {
          const record = options.records?.[id]
          return record ? { success: true, record } : { success: false }
        },
      } as any,
      builtInToolExecutor: {
        execute: () => ({ success: true }),
        executeAsync: async () => ({ success: true }),
        setPlanMode: () => {},
        getAutoApply: () => false,
        getNonInteractiveMode: () => null,
        applyAutoApplyBatch: async () => new Map(),
      } as any,
      mcpService: { getAggregatedOpenAITools: async () => [] } as any,
      eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    }
    const engine = new ChatEngine(deps)
    // dispose 侦探（包一层观察调用，不改行为）
    const origDispose = engine.dispose.bind(engine)
    engine.dispose = () => {
      disposed.push(engine.getSessionState().sessionId ?? '(null)')
      origDispose()
    }
    return engine
  }
  return { createEngine, saved, disposed }
}

test('双引擎并存 + open 无 id 立即铸 id（1.1）', async () => {
  const { createEngine } = makeFactory()
  const registry = new SessionRegistry({ createEngine })
  const a = await registry.open()
  const b = await registry.open()
  assert.ok(a && b)
  assert.notEqual(a, b, 'open() 两次 = 两个引擎')
  const aId = a!.getSessionState().sessionId
  const bId = b!.getSessionState().sessionId
  assert.ok(aId && bId, 'open() 无 id 时即铸 sessionId')
  assert.notEqual(aId, bId)
  assert.equal(registry.has(aId!), true)
  assert.equal(registry.get(aId!), a)
  assert.deepEqual(registry.list().sort(), [aId, bId].sort())
  await registry.disposeAll()
})

test('open 幂等/单写者：同 id 只建一个引擎；load 失败不留半生引擎', async () => {
  const { createEngine, disposed } = makeFactory({ records: { 's-ok': makeRecord('s-ok') } })
  const registry = new SessionRegistry({ createEngine })
  const first = await registry.open('s-ok')
  const again = await registry.open('s-ok')
  assert.ok(first)
  assert.equal(first, again, 'open 幂等：同 id 返回既有引擎')

  const missing = await registry.open('s-nope')
  assert.equal(missing, null, 'load 失败返回 null')
  assert.equal(registry.has('s-nope'), false, 'load 失败不留半生引擎')
  assert.equal(disposed.length, 1, '半生引擎已 dispose')
  await registry.disposeAll()
})

test('detach 重键（1.1/1.3）：detachSession 换新 id 后 registry 跟随重键', async () => {
  const { createEngine } = makeFactory({ records: { 's-old': makeRecord('s-old') } })
  const registry = new SessionRegistry({ createEngine })
  const engine = await registry.open('s-old')
  assert.ok(engine)
  assert.equal(registry.get('s-old'), engine)

  engine!.detachSession()
  const newId = engine!.getSessionState().sessionId
  assert.ok(newId && newId !== 's-old', 'detach 换新 id')
  assert.equal(registry.get('s-old'), undefined, '旧键已摘')
  assert.equal(registry.get(newId!), engine, '新键已登记')
  assert.deepEqual(registry.list(), [newId])
  await registry.disposeAll()
})

test('订阅列表多订阅者（1.3）：单槽与多订阅并存互不覆盖', async () => {
  const { createEngine } = makeFactory()
  const registry = new SessionRegistry({ createEngine })
  const engine = await registry.open()
  assert.ok(engine)
  const seenA: (string | null)[] = []
  const seenB: (string | null)[] = []
  const legacy: (string | null)[] = []
  const offA = engine!.subscribeActiveSessionChanged((id) => seenA.push(id))
  engine!.subscribeActiveSessionChanged((id) => seenB.push(id))
  engine!.onActiveSessionChanged = (id) => legacy.push(id)

  engine!.startNewSession()
  await engine!.sendMessage({ text: 'x' }) // 铸 id → 通知

  assert.equal(seenA.length, 2, '订阅者 A 收到 null→新 id 两次通知')
  assert.equal(seenB.length, 2, '订阅者 B 同样收到（多订阅并存）')
  assert.equal(legacy.length, 2, 'legacy 单槽同样收到（并存不互斥）')
  assert.equal(seenA[1], seenB[1], '两订阅者收到同一 id')

  offA()
  engine!.startNewSession()
  assert.equal(seenA.length, 2, '退订后 A 不再收到')
  assert.equal(seenB.length, 3, 'B 仍收到')
  await registry.disposeAll()
})

test('close 语义（1.2）：有在途轮先 abort 封口 → endSession → dispose；幂等', async () => {
  const { createEngine, disposed } = makeFactory({ records: { 's-x': makeRecord('s-x') } })
  const registry = new SessionRegistry({ createEngine })
  const engine = await registry.open('s-x')
  assert.ok(engine)

  const closed = await registry.close('s-x')
  assert.equal(closed, true)
  assert.equal(disposed.length, 1, '已 dispose')
  assert.equal(registry.has('s-x'), false)

  const closedAgain = await registry.close('s-x')
  assert.equal(closedAgain, false, 'close 幂等：未知 id 返回 false 不抛错')
  assert.equal(disposed.length, 1)
})

test('disposeAll（1.2）：全部收口', async () => {
  const { createEngine, disposed } = makeFactory()
  const registry = new SessionRegistry({ createEngine })
  await registry.open()
  await registry.open()
  await registry.disposeAll()
  assert.equal(disposed.length, 2)
  assert.deepEqual(registry.list(), [])
})

test('close(goal 会话) 后 goal 状态/文件清干净、新 goal 可开（1.6 验收 · 发现 #10）', async () => {
  const goalStoreCalls: string[] = []
  const createEngine = (): ChatEngine => {
    const deps: ChatEngineDeps = {
      modelCaller: { callOnce: async () => ({ content: 'ok' }) },
      modelInfo: { getModelsWithApiKeys: async () => [], getModelInfoByName: () => undefined } as any,
      selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
      sessionStore: { save: async () => ({ success: true }), load: async () => ({ success: false }) } as any,
      builtInToolExecutor: {
        execute: () => ({ success: true }),
        executeAsync: async () => ({ success: true }),
        setPlanMode: () => {},
        getAutoApply: () => false,
        getNonInteractiveMode: () => null,
        applyAutoApplyBatch: async () => new Map(),
      } as any,
      mcpService: { getAggregatedOpenAITools: async () => [] } as any,
      eventBus: { on: () => {}, off: () => {}, emit: () => {} },
      goalStore: {
        save: () => goalStoreCalls.push('save'),
        archive: () => goalStoreCalls.push('archive'),
        clear: () => goalStoreCalls.push('clear'),
      },
    }
    return new ChatEngine(deps)
  }
  const registry = new SessionRegistry({ createEngine })
  const a = await registry.open()
  assert.ok(a)
  a!.setGoal('目标 A')
  assert.ok(a!.isGoalMode())
  assert.ok(goalStoreCalls.includes('save'))

  await registry.close(a!.getSessionState().sessionId!)
  assert.ok(goalStoreCalls.includes('clear'), 'close(goal 会话) 清了 goal 文件')
  assert.equal(a!.isGoalMode(), false, 'goal 状态已清')

  // 新 goal 可开（无残留互斥源）
  const b = await registry.open()
  assert.ok(b)
  b!.setGoal('目标 B')
  assert.ok(b!.isGoalMode(), '新 goal 可正常开启')
  await registry.disposeAll()
})
