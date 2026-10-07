import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'

/**
 * SessionScope（1.4/1.7/1.8）：scope 各归各——workDir 隔离（A 引擎目录变更不影响 B）、
 * sessionId/turnId/planMode 现读、dispose 注销后回退 legacy 单槽、
 * task→engineHandle→scope 反查（2.3）。
 */

const T0 = new Date('2025-01-01T00:00:00Z')

function makeRecord(id: string, workdir?: string): SessionRecord {
  return {
    id,
    title: `标题-${id}`,
    messages: [{ role: 'user' as Message['role'], content: 'hi', timestamp: T0 }],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...(workdir ? { workdir } : {}),
  }
}

function makeRealExecutor(): BuiltInToolExecutor {
  return new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
}

interface MakeEngineOptions {
  records?: Record<string, SessionRecord>
  workDir?: string
  executor?: BuiltInToolExecutor
}

function makeEngine(options: MakeEngineOptions = {}): { engine: ChatEngine; executor: BuiltInToolExecutor } {
  const executor = options.executor ?? makeRealExecutor()
  const deps: ChatEngineDeps = {
    modelCaller: { callOnce: async () => ({ content: 'ok' }) },
    modelInfo: { getModelsWithApiKeys: async () => [], getModelInfoByName: () => undefined } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async (id: string) => {
        const record = options.records?.[id]
        return record ? { success: true, record } : { success: false }
      },
    } as any,
    builtInToolExecutor: executor,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    workDir: options.workDir,
  }
  return { engine: new ChatEngine(deps), executor }
}

test('scope 各归各：sessionId/planMode 现读、workDir 隔离（A 目录变更不影响 B）', async (t) => {
  const executor = makeRealExecutor()
  const a = makeEngine({ workDir: '/proj-a', executor })
  const b = makeEngine({ workDir: '/proj-b', executor })
  t.after(() => {
    a.engine.dispose()
    b.engine.dispose()
  })

  await a.engine.sendMessage({ text: 'A 首轮' })
  await b.engine.sendMessage({ text: 'B 首轮' })

  const scopeA = a.engine.getSessionScope()
  const scopeB = b.engine.getSessionScope()
  assert.notEqual(scopeA.handle, scopeB.handle, '句柄各归各')
  assert.equal(scopeA.getSessionId(), a.engine.getSessionState().sessionId)
  assert.equal(scopeB.getSessionId(), b.engine.getSessionState().sessionId)
  assert.notEqual(scopeA.getSessionId(), scopeB.getSessionId())

  // workDir 隔离：A 引擎目录变更不影响 B 的 scope.cwd
  assert.equal(scopeA.getCwd(), '/proj-a')
  assert.equal(scopeB.getCwd(), '/proj-b')
  a.engine.setWorkDir('/proj-a-moved')
  assert.equal(scopeA.getCwd(), '/proj-a-moved', 'A 目录变更生效')
  assert.equal(scopeB.getCwd(), '/proj-b', 'B 不受 A 变更影响')

  // planMode 隔离：A 进 plan，B 的 scope 旗标不动
  a.engine.setPlanMode(true)
  assert.equal(scopeA.getPlanMode(), true)
  assert.equal(scopeB.getPlanMode(), false)

  // executor 按归因解析（2.2）：handle 直查
  const byHandleA = executor.resolveScopeByOrigin({ source: 'main', handle: scopeA.handle } as any)
  const byHandleB = executor.resolveScopeByOrigin({ source: 'main', handle: scopeB.handle } as any)
  assert.equal(byHandleA, scopeA)
  assert.equal(byHandleB, scopeB)

  // 2.3：subagent 无 handle 时 task→engineHandle→scope 反查
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  getTaskRegistry().register({
    taskId: 't-b',
    toolCallId: 't-b',
    subagentType: 'x',
    description: '',
    batchId: 'batch-1',
    engineHandle: scopeB.handle,
  })
  const byTask = executor.resolveScopeByOrigin({ source: 'subagent', taskId: 't-b' } as any)
  assert.equal(byTask, scopeB, 'task→engineHandle→scope 反查命中 B')

  // 无归因（老任务/异常路径）= legacy 回退
  assert.equal(executor.resolveScopeByOrigin({ source: 'subagent', taskId: 'nope' } as any), null)
  assert.equal(executor.resolveScopeByOrigin(undefined), null)
})

test('workDir 钉住/解钉（1.7）：loadSession 按 record.workdir 钉住；解钉回活读 deps.workDir', async (t) => {
  const { engine } = makeEngine({
    workDir: '/default',
    records: { 's-pinned': makeRecord('s-pinned', '/record-dir') },
  })
  t.after(() => engine.dispose())

  await engine.loadSession('s-pinned')
  assert.equal(engine.getWorkDir(), '/record-dir', 'loadSession 按 record.workdir 钉住')

  engine.setWorkDir('/explicit')
  assert.equal(engine.getWorkDir(), '/explicit')
  engine.setWorkDir(undefined)
  assert.equal(engine.getWorkDir(), '/default', '解钉=回退活读 deps.workDir（CLI 旧行为）')

  engine.startNewSession()
  assert.equal(engine.getWorkDir(), '/default', '新会话取 deps.workDir 现值（未钉住）')
})

test('dispose 注销后回退 legacy 单槽（1.4）', async (t) => {
  const executor = makeRealExecutor()
  const legacyCtx = { sessionId: 'legacy-sid', cwd: '/legacy' }
  executor.setHookContextProvider?.(() => legacyCtx)
  const a = makeEngine({ workDir: '/proj-a', executor })

  await a.engine.sendMessage({ text: 'x' })
  const handle = a.engine.getScopeHandle()
  assert.ok(executor.resolveScopeByOrigin({ source: 'main', handle } as any), '注册期内可解析')

  a.engine.dispose()
  t.after(() => executor.setHookContextProvider?.(() => legacyCtx))
  assert.equal(executor.resolveScopeByOrigin({ source: 'main', handle } as any), null, 'dispose 后注销')
})
