import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps, SessionScope } from '../../src/engine/types.ts'
import type { Message, ToolCall } from '../../src/types/models.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { executeTaskToolCalls } from '../../src/services/delegation/delegationTools.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import {
  registerDelegationHookDispatcher,
  unregisterDelegationHookDispatcher,
  setDelegationHookDispatcher,
  getLegacyDelegationHookDispatcher,
} from '../../src/services/delegation/delegationTools.ts'

/**
 * 多会话归因（2.6 必测全集）：
 * ① 双引擎并发跑轮（stub 模型）——工具归因（__origin 各归各）；
 * ② planMode 隔离（A 进 plan 不拦 B）+ 引擎状态隔离（A 触发 PLAN_MODE_ENTERED 后 B.planMode 仍 false）；
 * ③ B 批准 goal A 不进 goal；
 * ④ 备份归因/hooks 上下文（scope 现读）+ 事件载荷各归各；
 * ⑤ 双引擎各自委派后台任务，hook 派发各回各的 runner；
 * ⑥ Worker 网关无归因调用行为逐位不变（专项回归）。
 */

const T0 = new Date('2025-01-01T00:00:00Z')

/** 共享假总线（on/off/emit；双引擎同 bus 才能验证 2.5 过滤） */
class FakeBus {
  private listeners = new Map<string, Set<(payload: unknown) => void>>()
  on(event: string, cb: (payload: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
  }
  off(event: string, cb: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(cb)
  }
  emit(event: string, payload?: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload)
  }
}

/** 记录型 stub executor（工具归因断言用；registerSessionScope 透传以便 scope 解析） */
function makeCaptureExecutor() {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const scopes = new Map<string, SessionScope>()
  return {
    calls,
    scopes,
    executor: {
      execute: () => ({ success: true }),
      executeAsync: async (toolName: string, args: string) => {
        calls.push({ toolName, args: JSON.parse(args) })
        return { success: true, data: { content: 'ok' } }
      },
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map<string, { success: boolean }>(),
      registerSessionScope: (handle: string, scope: SessionScope) => {
        scopes.set(handle, scope)
      },
      unregisterSessionScope: (handle: string) => {
        scopes.delete(handle)
      },
    } as unknown as BuiltInToolExecutor,
  }
}

interface EngineEnv {
  engine: ChatEngine
  bus: FakeBus
}

function makeEngine(
  bus: FakeBus,
  executor: BuiltInToolExecutor,
  options: { workDir?: string; toolCalls?: { id: string; name: string; arguments: string }[]; hookRunner?: unknown } = {},
): EngineEnv {
  let firstCall = true
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async () => {
        if (firstCall && options.toolCalls) {
          firstCall = false
          return {
            content: '',
            toolCalls: options.toolCalls.map<ToolCall>((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        }
        return { content: 'ok' }
      },
    },
    modelInfo: { getModelsWithApiKeys: async () => [], getModelInfoByName: () => undefined } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () => ({ success: false }),
    } as any,
    builtInToolExecutor: executor,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: bus,
    workDir: options.workDir,
    ...(options.hookRunner ? { hookRunner: options.hookRunner as ChatEngineDeps['hookRunner'] } : {}),
  }
  return { engine: new ChatEngine(deps), bus }
}

test('① 双引擎并发跑轮：工具归因 __origin 各归各（handle/sessionId/turnId）', async (t) => {
  const cap = makeCaptureExecutor()
  const bus = new FakeBus()
  const a = makeEngine(bus, cap.executor, {
    toolCalls: [{ id: 'tc-a', name: 'query_task_status', arguments: '{"task_id":"a"}' }],
  })
  const b = makeEngine(bus, cap.executor, {
    toolCalls: [{ id: 'tc-b', name: 'query_task_status', arguments: '{"task_id":"b"}' }],
  })
  t.after(() => {
    a.engine.dispose()
    b.engine.dispose()
  })

  // 并发跑轮（stub 模型）
  await Promise.all([a.engine.sendMessage({ text: 'A 请查任务' }), b.engine.sendMessage({ text: 'B 请查任务' })])

  assert.equal(cap.calls.length, 2, '两引擎各执行一次工具')
  const callA = cap.calls.find((c) => (c.args as any).__origin?.sessionId === a.engine.getSessionState().sessionId)
  const callB = cap.calls.find((c) => (c.args as any).__origin?.sessionId === b.engine.getSessionState().sessionId)
  assert.ok(callA && callB, '两次调用各自可按 sessionId 归属')
  assert.equal((callA!.args as any).__origin.source, 'main')
  assert.equal((callA!.args as any).__origin.handle, a.engine.getScopeHandle())
  assert.equal((callB!.args as any).__origin.handle, b.engine.getScopeHandle())
  assert.ok((callA!.args as any).__origin.turnId, 'turnId 随调用流动')
  assert.equal((callA!.args as any).task_id, 'a', '原参数不失真')
})

test('② planMode 隔离：A 进 plan 不拦 B；A 触发 PLAN_MODE_ENTERED 后 B.planMode 仍 false', async (t) => {
  // plan 门用真 executor（决策管线在 executor 内）；事件总线用共享 FakeBus（验证 2.5 过滤）
  const realExecutor = new BuiltInToolExecutor(
    { getCurrentDirectory: () => '/tmp' } as any,
    {} as any,
    {} as any,
    {} as any,
  )
  realExecutor.setAutoApply(true) // 写直通档：跳过审批弹窗（本用例只关心 plan 门，不关心写结果）
  const bus = new FakeBus()
  const a = makeEngine(bus, realExecutor, { workDir: '/proj-a' })
  const b = makeEngine(bus, realExecutor, { workDir: '/proj-b' })
  t.after(() => {
    a.engine.dispose()
    b.engine.dispose()
  })
  await a.engine.sendMessage({ text: 'A' })
  await b.engine.sendMessage({ text: 'B' })

  // A 进 plan（引擎为状态源，事件带 sessionId）
  a.engine.setPlanMode(true)
  assert.equal(a.engine.getSessionState().planMode, true)
  assert.equal(b.engine.getSessionState().planMode, false, 'A 触发 PLAN_MODE_ENTERED 后 B.planMode 仍 false（2.5 过滤）')

  // plan 门按归因解析：A 的调用被拦、B 的调用不被拦（2.2）
  const resA = await realExecutor.executeAsync(
    'create_file',
    JSON.stringify({ path: '/tmp/x.txt', content: '1', __origin: { source: 'main', handle: a.engine.getScopeHandle() } }),
    'tc-a1',
  )
  assert.equal(resA.success, false)
  assert.match(String(resA.error), /规划模式/, 'A 归因调用被 plan 门拦截')
  const resB = await realExecutor.executeAsync(
    'create_file',
    JSON.stringify({ path: '/tmp/y.txt', content: '1', __origin: { source: 'main', handle: b.engine.getScopeHandle() } }),
    'tc-b1',
  )
  assert.ok(!String(resB.error ?? '').includes('规划模式'), 'B 归因调用不被 A 的 plan 门拦截')
})

test('③ B 批准 goal A 不进 goal（2.5 归属过滤 + 1.6 互斥钩子）', async (t) => {
  const cap = makeCaptureExecutor()
  const bus = new FakeBus()
  let otherActive = false
  const make = (): EngineEnv => {
    let firstCall = true
    const deps: ChatEngineDeps = {
      modelCaller: {
        callOnce: async () => {
          if (firstCall) {
            firstCall = false
            return { content: '', toolCalls: [{ id: 'tc', type: 'function', function: { name: 'query_task_status', arguments: '{}' } }] }
          }
          return { content: 'ok' }
        },
      },
      modelInfo: { getModelsWithApiKeys: async () => [], getModelInfoByName: () => undefined } as any,
      selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
      sessionStore: { save: async () => ({ success: true }), load: async () => ({ success: false }) } as any,
      builtInToolExecutor: cap.executor,
      mcpService: { getAggregatedOpenAITools: async () => [] } as any,
      eventBus: bus,
      hasOtherActiveGoal: () => otherActive,
    }
    return { engine: new ChatEngine(deps), bus }
  }
  const a = make()
  const b = make()
  t.after(() => {
    a.engine.dispose()
    b.engine.dispose()
  })
  await a.engine.sendMessage({ text: 'A' })
  await b.engine.sendMessage({ text: 'B' })

  // B 批准 propose_goal（executor 发事件的语义等价：带 B 的 sessionId 上共享总线）
  bus.emit(EVENTS.GOAL_PROPOSAL_ACCEPTED, {
    objective: 'B 的目标',
    successCriteria: '判据',
    sessionId: b.engine.getSessionState().sessionId,
  })
  assert.equal(b.engine.isGoalMode(), true, 'B 进入目标模式')
  assert.equal(a.engine.isGoalMode(), false, 'A 不进 goal（2.5 过滤）')

  // 1.6 跨引擎互斥：另有目标在跑时 setGoal 拒绝
  otherActive = true
  const c = make()
  t.after(() => c.engine.dispose())
  assert.throws(() => c.engine.setGoal('C 的目标'), /另一个会话正在目标模式/)
  assert.equal(c.engine.isGoalMode(), false)
  otherActive = false
})

test('④ 备份归因/hooks 上下文经 scope 现读；事件载荷各归各', async (t) => {
  resetTaskRegistry()
  const realExecutor = new BuiltInToolExecutor(
    { getCurrentDirectory: () => '/tmp' } as any,
    {} as any,
    {} as any,
    {} as any,
  )
  const bus = new FakeBus()
  const hookCallsA: Array<{ sessionId: string; cwd: string }> = []
  const hookCallsB: Array<{ sessionId: string; cwd: string }> = []
  const runnerA = {
    dispatch: async (event: string, ctx: any) => {
      if (event === 'PreToolUse') hookCallsA.push({ sessionId: ctx.sessionId, cwd: ctx.cwd })
      return null
    },
  }
  const runnerB = {
    dispatch: async (event: string, ctx: any) => {
      if (event === 'PreToolUse') hookCallsB.push({ sessionId: ctx.sessionId, cwd: ctx.cwd })
      return null
    },
  }
  const a = makeEngine(bus, realExecutor, { workDir: '/proj-a', hookRunner: runnerA })
  const b = makeEngine(bus, realExecutor, { workDir: '/proj-b', hookRunner: runnerB })
  t.after(() => {
    a.engine.dispose()
    b.engine.dispose()
    resetTaskRegistry()
  })
  await a.engine.sendMessage({ text: 'A' })
  await b.engine.sendMessage({ text: 'B' })

  // hooks 上下文各归各：subagent 调用按 task→engineHandle→scope 解析出 B 的 runner 与上下文
  getTaskRegistry().register({
    taskId: 't-of-b',
    toolCallId: 't-of-b',
    subagentType: 'x',
    description: '',
    batchId: 'batch-x',
    engineHandle: b.engine.getScopeHandle(),
  })
  await realExecutor.executeAsync(
    'query_task_status',
    JSON.stringify({ __origin: { source: 'subagent', taskId: 't-of-b' } }),
    'tc-hook',
  )
  assert.equal(hookCallsA.length, 0, 'A 的 runner 未被调用')
  assert.equal(hookCallsB.length, 1, 'B 的 runner 收到派发（各回各 runner）')
  assert.equal(hookCallsB[0].sessionId, b.engine.getSessionState().sessionId, 'hooks 上下文 sessionId 归 B')
  assert.equal(hookCallsB[0].cwd, '/proj-b', 'hooks 上下文 cwd 归 B（scope 现读）')

  // 备份归因：无归因回退 legacy 单槽（现状语义）
  realExecutor.setHookContextProvider?.(() => ({ sessionId: 'legacy-sid', cwd: '/legacy', turnId: 'user:legacy' }))
  const backupCtx = realExecutor.getBackupAttributionContext()
  assert.equal(backupCtx.sessionId, 'legacy-sid')
  assert.equal(backupCtx.turnId, 'user:legacy')

  // 事件载荷各归各：引擎侧 feed 事件带自己的 sessionId（先挂监听再触发）
  const seenPlan: any[] = []
  const seenGoal: any[] = []
  const recPlan = (p: any) => seenPlan.push(p)
  const recGoal = (p: any) => seenGoal.push(p)
  bus.on(EVENTS.PLAN_MODE_ENTERED, recPlan)
  bus.on(EVENTS.GOAL_STARTED, recGoal)
  a.engine.setPlanMode(true) // PLAN_MODE_ENTERED（带 A 的 sessionId）
  bus.off(EVENTS.PLAN_MODE_ENTERED, recPlan)
  b.engine.setGoal('B 的目标') // GOAL_STARTED（带 B 的 sessionId）
  bus.off(EVENTS.GOAL_STARTED, recGoal)

  assert.equal(seenPlan.length, 1)
  assert.equal(seenPlan[0].sessionId, a.engine.getSessionState().sessionId, 'PLAN 事件载荷归 A')
  assert.notEqual(seenPlan[0].sessionId, b.engine.getSessionState().sessionId)
  assert.equal(seenGoal.length, 1)
  assert.equal(seenGoal[0].sessionId, b.engine.getSessionState().sessionId, 'GOAL 事件载荷归 B')
})

test('⑤ 双引擎各自委派后台任务：hook 派发各回各的 runner', async (t) => {
  const cap = makeCaptureExecutor()
  const bus = new FakeBus()
  const denied: string[] = []
  const runnerA = {
    dispatch: async () => ({ verdict: { type: 'deny', reason: 'A 拦截' }, systemMessages: [], additionalContext: [] }),
  }
  const runnerB = {
    dispatch: async () => ({ verdict: { type: 'deny', reason: 'B 拦截' }, systemMessages: [], additionalContext: [] }),
  }
  const a = makeEngine(bus, cap.executor, { hookRunner: runnerA })
  const b = makeEngine(bus, cap.executor, { hookRunner: runnerB })
  t.after(() => {
    a.engine.dispose()
    b.engine.dispose()
    denied.length = 0
  })
  await a.engine.sendMessage({ text: 'A' })
  await b.engine.sendMessage({ text: 'B' })
  void denied

  const mkTaskCall = (id: string, handle: string): ToolCall => ({
    id,
    type: 'function',
    function: {
      name: 'task',
      arguments: JSON.stringify({
        task_id: id,
        subagent_type: 'test-agent',
        task_description: '测试',
        __origin: { source: 'main', handle },
      }),
    },
  })

  // PreDelegation 按 __origin.handle 路由到各引擎的派发器（hook deny 即可证明"到过谁家"）
  const resultsA = await executeTaskToolCalls([mkTaskCall('task-a', a.engine.getScopeHandle())])
  assert.match(String(resultsA[0].taskOutput.error_info?.message), /A 拦截/, 'A 的委派走 A 的 hookRunner')
  const resultsB = await executeTaskToolCalls([mkTaskCall('task-b', b.engine.getScopeHandle())])
  assert.match(String(resultsB[0].taskOutput.error_info?.message), /B 拦截/, 'B 的委派走 B 的 hookRunner')
})

test('⑥ Worker 网关无归因调用行为逐位不变（专项回归）', async (t) => {
  const realExecutor = new BuiltInToolExecutor(
    { getCurrentDirectory: () => '/tmp' } as any,
    {} as any,
    {} as any,
    {} as any,
  )
  realExecutor.setAutoApply(true) // 写直通档：跳过审批弹窗（本用例只关心 plan 门回退语义）
  // legacy 单槽现状：hookContextProvider / setPlanMode / hookRunner 全走单槽
  realExecutor.setHookContextProvider?.(() => ({ sessionId: 'legacy-sid', cwd: '/legacy' }))
  const legacyRunnerCalls: string[] = []
  realExecutor.setHookRunner({
    dispatch: async (event: string) => {
      legacyRunnerCalls.push(event)
      return null
    },
  } as any)

  // ① 无 __origin 的调用：Worker 咽喉短路（主会话 hooks 不在此咽喉）——hooks 不触发，逐位不变
  await realExecutor.executeAsync('query_task_status', '{}', 'tc-no-origin')
  assert.deepEqual(legacyRunnerCalls, [], '主会话短路：Worker 咽喉不派发 hooks')

  // ② 无归因 subagent 调用（无 handle、task 未登记）：plan 门回退 legacy 单旗标，逐位不变
  realExecutor.setPlanMode(true)
  const res = await realExecutor.executeAsync(
    'create_file',
    JSON.stringify({ path: '/tmp/z.txt', content: '1', __origin: { source: 'subagent', taskId: 'unbound-task' } }),
    'tc-worker-1',
  )
  assert.equal(res.success, false)
  assert.match(String(res.error), /规划模式/, '无归因 Worker 调用按 legacy 单旗标被 plan 门拦截')
  realExecutor.setPlanMode(false)
  const res2 = await realExecutor.executeAsync(
    'create_file',
    JSON.stringify({ path: '/tmp/z.txt', content: '1', __origin: { source: 'subagent', taskId: 'unbound-task' } }),
    'tc-worker-2',
  )
  assert.ok(!String(res2.error ?? '').includes('规划模式'), 'legacy 旗标关闭后不再被 plan 门拦截')

  // ③ 无归因 Worker 咽喉 hooks：走 legacy 单槽 runner、legacy 上下文（逐位不变）
  const res3 = await realExecutor.executeAsync(
    'query_task_status',
    JSON.stringify({ __origin: { source: 'subagent', taskId: 'unbound-task' } }),
    'tc-worker-3',
  )
  assert.ok(res3, '调用完成')
  assert.ok(legacyRunnerCalls.includes('PreToolUse'), '无归因 Worker 调用派发到 legacy 单槽 runner')

  // ④ 备份归因无归因回退：形状与现状一致
  const backupCtx = realExecutor.getBackupAttributionContext()
  assert.equal(backupCtx.sessionId, 'legacy-sid')
  assert.equal(backupCtx.turnId, undefined)

  // ⑤ legacy 派发器单槽语义不变（dispose 身份核对用的读口可用）
  assert.equal(typeof getLegacyDelegationHookDispatcher, 'function')
  setDelegationHookDispatcher(null)
  t.after(() => setDelegationHookDispatcher(null))
  void registerDelegationHookDispatcher
  void unregisterDelegationHookDispatcher
})

test('②′ 引擎状态隔离补充：A 的 PLAN_APPROVED 不解 B 的 planMode', async (t) => {
  const cap = makeCaptureExecutor()
  const bus = new FakeBus()
  const a = makeEngine(bus, cap.executor)
  const b = makeEngine(bus, cap.executor)
  t.after(() => {
    a.engine.dispose()
    b.engine.dispose()
  })
  await a.engine.sendMessage({ text: 'A' })
  await b.engine.sendMessage({ text: 'B' })
  a.engine.setPlanMode(true)
  b.engine.setPlanMode(true)
  // A 退出 plan（事件带 A 的 sessionId）→ B 不受影响
  a.engine.setPlanMode(false)
  assert.equal(a.engine.getSessionState().planMode, false)
  assert.equal(b.engine.getSessionState().planMode, true, 'B 的 planMode 不被 A 的 PLAN_APPROVED 翻转')
})
