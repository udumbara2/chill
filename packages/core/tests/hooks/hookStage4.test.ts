import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import { HookConfigLoader } from '../../src/services/hooks/HookConfigLoader.ts'
import { HookRunner } from '../../src/services/hooks/HookRunner.ts'
import type { IHookProcessRunner, HookProcessResult } from '../../src/services/hooks/IHookProcessRunner.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'
import { executeTaskToolCalls, setDelegationHookDispatcher } from '../../src/services/delegation/delegationTools.ts'
import { getTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { TemplateSubagentForkManager } from '../../src/orchestrator/isolation/TemplateSubagentForkManager.ts'
import type { ToolCall } from '../../src/types/models.ts'

/**
 * hooks 系统 core 集成测试（阶段 4 挂载点）：
 * Stop（无 goal 强制续跑 + 上限 5 次 + stop_hook_active；goal 激活时与评估器共存 + 熔断计数）、
 * SessionEnd（幂等 + 1.5s 共享预算）、Notification/GoalTransition（eventBus 映射表 + 熔断请示）、
 * PreCompact/PostCompact、PreDelegation/PostDelegation、Worker MCP 来源标记与咽喉覆盖。
 * 真实 HookRunner + 假执行通道（FakeRunner）；引擎侧最小 fake deps（模式同 hookIntegration.test.ts）。
 */

const CONFIG_PATH = '/home/user/.chill/hooks.json'

/** 内存假 fsProvider（HookConfigLoader 用） */
function makeFakeFs(files: Map<string, string>): IFileSystemProvider {
  return {
    readFile: async (p: string) => {
      const content = files.get(p)
      return content === undefined ? { success: false, error: 'not found' } : { success: true, data: { content } }
    },
    writeFile: async (p: string, content: string) => {
      files.set(p, content)
      return { success: true }
    },
    deleteFile: async (p: string) => {
      files.delete(p)
      return { success: true }
    },
    listDirectory: async () => ({ success: true, data: { files: [] } }),
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => ({ success: true, data: files.has(p) }),
    getPathType: async () => ({ success: true, data: { type: 'file' as const } }),
  }
}

/** 假执行通道：记录调用（input 已解析 + timeoutMs），按 responder 返回 */
class FakeRunner implements IHookProcessRunner {
  calls: Array<{ command: string; input: Record<string, unknown>; timeoutMs?: number }> = []
  responder: (input: Record<string, unknown>) => HookProcessResult | Promise<HookProcessResult>

  constructor(responder: FakeRunner['responder']) {
    this.responder = responder
  }

  async run(command: string, inputJson: string, timeoutMs?: number): Promise<HookProcessResult> {
    const input = JSON.parse(inputJson) as Record<string, unknown>
    this.calls.push({ command, input, timeoutMs })
    return this.responder(input)
  }
}

const ok = (stdout = ''): HookProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
const block = (reason: string): HookProcessResult => ({ exitCode: 2, stdout: '', stderr: reason, timedOut: false })

/** 组装真实 HookRunner（假 fs 配置 + 假执行通道） */
function makeHookRunner(config: unknown, responder: FakeRunner['responder']) {
  const files = new Map<string, string>()
  files.set(CONFIG_PATH, JSON.stringify(config))
  const loader = new HookConfigLoader(makeFakeFs(files), CONFIG_PATH)
  const fakeRunner = new FakeRunner(responder)
  const runner = new HookRunner({ loader, processRunner: fakeRunner })
  return { runner, fakeRunner }
}

/** 可用的假事件总线（记录发射 + 真实监听派发；通知轨映射表测试依赖真实的 on/emit） */
class FakeBus {
  events: Array<{ event: string; payload: any }> = []
  private listeners = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, cb: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event)!.push(cb)
  }

  off(event: string, cb: (...args: any[]) => void): void {
    const list = this.listeners.get(event)
    if (!list) return
    const i = list.indexOf(cb)
    if (i > -1) list.splice(i, 1)
  }

  emit(event: string, payload?: any): void {
    this.events.push({ event, payload })
    for (const cb of this.listeners.get(event) ?? []) cb(payload)
  }
}

interface EngineEnvOptions {
  responder: FakeRunner['responder']
  /**
   * 评估器判定（模型系统提示含"独立评估器"的调用按此应答；缺省 achieved）。
   * 普通对话轮一律返回 'ok'（无工具调用直接收尾）。
   */
  evaluatorVerdict?: Record<string, unknown>
  /** 熔断请示应答通道（goal_circuit_break 测试用） */
  userInputAnswer?: string
}

/** 最小 fake deps 的引擎环境（FakeBus + 评估器可辨别的 modelCaller） */
function makeEngineEnv(config: unknown, options: EngineEnvOptions) {
  const { runner, fakeRunner } = makeHookRunner(config, options.responder)
  const bus = new FakeBus()
  const modelCalls: Array<{ messages: any[] }> = []
  const evaluatorVerdict = options.evaluatorVerdict ?? { verdict: 'achieved', progress: true, reason: '判据已被证据满足' }

  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        modelCalls.push({ messages: params.messages })
        const first = params.messages?.[0]
        if (first?.role === 'system' && String(first.content).includes('独立评估器')) {
          return { content: JSON.stringify(evaluatorVerdict) }
        }
        return { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () => ({ success: false }),
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true, data: { content: 'sync-result' } }),
      executeAsync: async (toolName: string) => ({ success: true, data: { content: `result-of-${toolName}` } }),
      setPlanMode: () => {},
      setGoalMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
      setHookRunner: () => {},
      setHookContextProvider: () => {},
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: bus,
    hookRunner: runner,
    workDir: '/proj',
    ...(options.userInputAnswer !== undefined
      ? { getUserInputProvider: () => ({ ask: async () => options.userInputAnswer! }) }
      : {}),
  }
  return { deps, runner, fakeRunner, bus, modelCalls }
}

/** 条件轮询等待（通知轨 fire-and-forget 的落地等待用） */
async function waitFor(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`waitFor 超时: ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** 构造 task 工具调用 */
function makeTaskCall(id: string, subagentType: string): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'task',
      arguments: JSON.stringify({
        task_id: id,
        subagent_type: subagentType,
        task_description: '做点事',
        success_criteria: '完成',
      }),
    },
  }
}

// ==================== Stop（回合结束决策点） ====================

test('Stop deny（无 goal）：强制续跑复用 goalTick 式合成消息，stop_hook_active 第 2 次起 true', async (t) => {
  let stopCalls = 0
  const { deps, fakeRunner } = makeEngineEnv(
    { hooks: { Stop: [{ hooks: [{ command: 'verify.mjs' }] }] } },
    {
      responder: () => {
        stopCalls++
        return stopCalls <= 2 ? block(`校验未通过 ${stopCalls}`) : ok()
      },
    },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  await engine.sendMessage({ text: '做完了' })

  const stopDispatches = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'Stop')
  assert.equal(stopDispatches.length, 3, '初始 1 次 + 2 次强制续跑后各评估 1 次')
  assert.equal(stopDispatches[0].input.stop_hook_active, false, '首次 stop_hook_active=false')
  assert.equal(stopDispatches[1].input.stop_hook_active, true, '第 2 次起 stop_hook_active=true')
  assert.equal(stopDispatches[2].input.stop_hook_active, true)

  const forcedMsgs = engine
    .getHistory()
    .filter((m) => m.synthetic === 'goalTick' && typeof m.content === 'string' && m.content.includes('【完成校验未通过】'))
  assert.equal(forcedMsgs.length, 2, '每次 deny 合成一条续跑消息')
  assert.match(String(forcedMsgs[0].content), /校验未通过 1/, 'hook reason 作为消息内容')
})

test('Stop deny（无 goal）：连续阻断上限 5 次后不再续跑', async (t) => {
  const { deps, fakeRunner, bus } = makeEngineEnv(
    { hooks: { Stop: [{ hooks: [{ command: 'never-pass.mjs' }] }] } },
    { responder: () => block('永不通过') },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  await engine.sendMessage({ text: '做完了' })

  const stopDispatches = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'Stop')
  assert.equal(stopDispatches.length, 6, '初始 1 次 + 5 次续跑后各 1 次（第 6 次阻断被拒绝）')
  const forcedMsgs = engine
    .getHistory()
    .filter((m) => m.synthetic === 'goalTick' && typeof m.content === 'string' && m.content.includes('【完成校验未通过】'))
  assert.equal(forcedMsgs.length, 5, '强制续跑上限 5 次')
  const hookEvents = bus.events.filter((e) => e.event === EVENTS.HOOK_MESSAGE)
  assert.ok(
    hookEvents.some((e) => String(e.payload.messages).includes('防死循环上限')),
    '达到上限应告知用户',
  )
})

test('Stop + goal：评估器 achieved 但 hook deny 时强制续跑，且计入 goal 熔断计数（maxRounds 到顶熔断）', async (t) => {
  const { deps, fakeRunner, bus } = makeEngineEnv(
    { hooks: { Stop: [{ hooks: [{ command: 'acceptance.mjs' }] }] } },
    {
      responder: () => block('验收脚本未通过'),
      evaluatorVerdict: { verdict: 'achieved', progress: true, reason: '证据满足' },
    },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  engine.setGoal('目标X', '判据Y', 2) // maxRounds=2：hook 强制续跑若不计数将无限循环
  await engine.sendMessage({ text: '开始' })

  // 无应答通道 → 熔断退回"发事件 + clearGoal"
  assert.equal(engine.isGoalMode(), false, '熔断后目标已清除')
  assert.ok(bus.events.some((e) => e.event === EVENTS.GOAL_BUDGET_EXHAUSTED), '到顶应走熔断')
  assert.ok(!bus.events.some((e) => e.event === EVENTS.GOAL_ACHIEVED), 'hook deny 压制了 achieved 归档')

  const stopDispatches = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'Stop')
  assert.equal(stopDispatches.length, 3, '初始轮 + 2 轮强制续跑后各评估 1 次')
  const forcedTicks = engine
    .getHistory()
    .filter((m) => m.synthetic === 'goalTick' && typeof m.content === 'string' && m.content.includes('【完成校验拦截】'))
  assert.equal(forcedTicks.length, 2, '2 轮 hook 强制续跑（= maxRounds 熔断计数兜住）')
  assert.match(String(forcedTicks[0].content), /验收脚本未通过/, 'hook reason 进入推进消息')
})

test('Stop + goal：评估器 achieved 且 hook 放行时正常达成（决策源共存基线）', async (t) => {
  const { deps, fakeRunner, bus } = makeEngineEnv(
    { hooks: { Stop: [{ hooks: [{ command: 'acceptance.mjs' }] }] } },
    {
      responder: () => ok(),
      evaluatorVerdict: { verdict: 'achieved', progress: true, reason: '证据满足' },
    },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  engine.setGoal('目标X', '判据Y', 5)
  await engine.sendMessage({ text: '开始' })

  assert.ok(bus.events.some((e) => e.event === EVENTS.GOAL_ACHIEVED), 'hook 放行时 achieved 正常归档')
  assert.equal(engine.isGoalMode(), false)
  const stopDispatches = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'Stop')
  assert.equal(stopDispatches.length, 1, 'Stop hooks 在决策点被咨询一次')
  const ticks = engine.getHistory().filter((m) => m.synthetic === 'goalTick')
  assert.equal(ticks.length, 0, '达成即停，无续跑')
})

// ==================== SessionEnd ====================

test('SessionEnd：endSession 幂等（多次调用 + dispose 只触发一次），1.5s 共享预算兜底', async (t) => {
  const { deps, fakeRunner } = makeEngineEnv(
    { hooks: { SessionEnd: [{ hooks: [{ command: 'cleanup.mjs' }] }] } },
    {
      responder: async () => {
        // 慢 handler（3s）：远超共享预算，验证 endSession 不被拖住
        await new Promise((r) => {
          const timer = setTimeout(r, 3000)
          timer.unref?.()
        })
        return ok()
      },
    },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  const startedAt = Date.now()
  await Promise.all([engine.endSession(), engine.endSession()])
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed >= 1400 && elapsed < 2800, `共享 1.5s 预算兜底（实测 ${elapsed}ms）`)

  await engine.endSession()
  engine.dispose()
  await engine.endSession()

  const endCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'SessionEnd')
  assert.equal(endCalls.length, 1, '多次 endSession + dispose 只触发一次')
  assert.ok((endCalls[0].timeoutMs ?? Infinity) <= 1500, '单 handler 超时压缩进共享预算')
})

test('SessionEnd：dispose 兜底触发（壳层未显式调用 endSession 时）', async (t) => {
  const { deps, fakeRunner } = makeEngineEnv(
    { hooks: { SessionEnd: [{ hooks: [{ command: 'cleanup.mjs' }] }] } },
    { responder: () => ok() },
  )
  const engine = new ChatEngine(deps)
  engine.dispose()
  await engine.endSession()

  const endCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'SessionEnd')
  assert.equal(endCalls.length, 1)
  assert.equal(endCalls[0].input.cwd, '/proj')
})

// ==================== Notification + GoalTransition（eventBus 映射表） ====================

test('GoalTransition：eventBus 六事件映射为六子类型 matcher_value，matcher 精确过滤', async (t) => {
  const { deps, fakeRunner, bus } = makeEngineEnv(
    {
      hooks: {
        GoalTransition: [
          { hooks: [{ command: 'all.mjs' }] },
          { matcher: 'achieved', hooks: [{ command: 'on-achieved.mjs' }] },
        ],
      },
    },
    { responder: () => ok() },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  bus.emit(EVENTS.GOAL_STARTED, { objective: 'x' })
  bus.emit(EVENTS.GOAL_ACHIEVED, { reason: 'y' })
  bus.emit(EVENTS.GOAL_CLEARED, {})
  bus.emit(EVENTS.GOAL_PAUSED, {})
  bus.emit(EVENTS.GOAL_RESUMED, {})
  bus.emit(EVENTS.GOAL_BUDGET_EXHAUSTED, { reason: 'z' })

  await waitFor(
    () => fakeRunner.calls.filter((c) => c.input.hook_event_name === 'GoalTransition').length >= 7,
    'GoalTransition 七次派发（all.mjs×6 + on-achieved.mjs×1）',
  )
  const allCalls = fakeRunner.calls.filter((c) => c.command === 'all.mjs')
  // 通知轨并行 fire-and-forget，到达顺序非契约——按集合比较
  assert.deepEqual(
    allCalls.map((c) => c.input.matcher_value).sort(),
    ['achieved', 'budget_exhausted', 'cleared', 'paused', 'resumed', 'started'],
  )
  const achievedCalls = fakeRunner.calls.filter((c) => c.command === 'on-achieved.mjs')
  assert.equal(achievedCalls.length, 1, 'matcher=achieved 只在达成时命中')
  assert.equal(achievedCalls[0].input.matcher_value, 'achieved')
  assert.equal(allCalls[0].input.payload.objective, 'x', 'bus 载荷原样透传 payload 字段')
})

test('Notification：APPROVAL_REQUESTED（全局总线）与 goal 熔断请示两路触发', async (t) => {
  const { deps, fakeRunner } = makeEngineEnv(
    { hooks: { Notification: [{ hooks: [{ command: 'notify.mjs' }] }] } },
    {
      responder: () => ok(),
      evaluatorVerdict: { verdict: 'blocked', progress: false, reason: '缺少关键权限' },
      userInputAnswer: '3', // 熔断请示：放弃目标
    },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  // 路①：审批请求（approvals.ts 发在全局 eventBus）
  eventBus.emit(EVENTS.APPROVAL_REQUESTED, { toolCallId: 'tc-n1', kind: 'write', path: '/x', origin: { source: 'main' } })
  // 路②：goal 熔断请示（handleGoalCircuitBreak 的 userInputProvider.ask 前）
  engine.setGoal('目标X', '判据Y', 5)
  await engine.sendMessage({ text: '开始' }) // 评估器判 blocked → 熔断请示

  await waitFor(
    () => fakeRunner.calls.filter((c) => c.input.hook_event_name === 'Notification').length >= 2,
    'Notification 两路派发',
  )
  const values = fakeRunner.calls
    .filter((c) => c.input.hook_event_name === 'Notification')
    .map((c) => c.input.matcher_value)
  assert.ok(values.includes('approval'), '审批请求 → matcher_value=approval')
  assert.ok(values.includes('goal_circuit_break'), '熔断请示 → matcher_value=goal_circuit_break')
  assert.equal(engine.isGoalMode(), false, '用户放弃后目标已清除')
})

// ==================== PreCompact / PostCompact ====================

test('PreCompact deny：压缩中止、记录完全不动；matcher_value=manual', async (t) => {
  const { deps, fakeRunner } = makeEngineEnv(
    { hooks: { PreCompact: [{ matcher: 'manual', hooks: [{ command: 'guard-compact.mjs' }] }] } },
    { responder: () => block('现在不要压缩') },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  await engine.sendMessage({ text: '第 1 轮' })
  await engine.sendMessage({ text: '第 2 轮' })
  await engine.sendMessage({ text: '第 3 轮' })

  await assert.rejects(() => engine.compactHistory(), /现在不要压缩/)
  assert.equal(engine.getSessionState().compactions.length, 0, 'deny 后无 checkpoint 落盘')
  const preCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PreCompact')
  assert.equal(preCalls.length, 1)
  assert.equal(preCalls[0].input.matcher_value, 'manual')
})

test('PostCompact：checkpoint 落盘后触发，additionalContext 注入下一轮上下文', async (t) => {
  const { deps, fakeRunner, modelCalls } = makeEngineEnv(
    {
      hooks: {
        PostCompact: [
          {
            matcher: 'manual',
            hooks: [{ command: 'post-compact.mjs' }],
          },
        ],
      },
    },
    {
      responder: () =>
        ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: 'POST-COMPACT-CTX' } })),
    },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  await engine.sendMessage({ text: '第 1 轮' })
  await engine.sendMessage({ text: '第 2 轮' })
  await engine.sendMessage({ text: '第 3 轮' })
  const { checkpoint } = await engine.compactHistory()
  assert.ok(checkpoint.id)

  const postCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PostCompact')
  assert.equal(postCalls.length, 1)
  assert.equal(postCalls[0].input.matcher_value, 'manual')

  const before = modelCalls.length
  await engine.sendMessage({ text: '压缩后继续' })
  const newCalls = modelCalls.slice(before)
  const systemTexts = newCalls
    .flatMap((c) => c.messages)
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content))
  assert.ok(systemTexts.some((t) => t.includes('POST-COMPACT-CTX')), '注入内容应在下一轮组装上下文中')
})

// ==================== PreDelegation / PostDelegation ====================

test('PreDelegation deny：拒绝委派（reason 反馈模型），不登记、不发 STARTED；matcher 按 subagent_type 过滤', async (t) => {
  const startedEvents: any[] = []
  const listener = (p: any) => startedEvents.push(p)
  eventBus.on(EVENTS.SUBAGENT_TASK_STARTED, listener)
  t.after(() => {
    eventBus.off(EVENTS.SUBAGENT_TASK_STARTED, listener)
    setDelegationHookDispatcher(null)
  })

  const { deps, fakeRunner } = makeEngineEnv(
    {
      hooks: {
        PreDelegation: [{ matcher: 'code-reviewer', hooks: [{ command: 'review-guard.mjs' }] }],
      },
    },
    { responder: () => block('委派需要人工确认') },
  )
  const engine = new ChatEngine(deps) // 构造时注册委派 hook 派发器
  t.after(() => engine.dispose())

  // 命中 matcher：deny 拒绝委派
  const denied = await executeTaskToolCalls([makeTaskCall('tc-del-1', 'code-reviewer')], {
    toolMetadata: [],
    toolDefinitions: [],
  })
  assert.equal(denied[0].taskOutput.error_info?.code, 'DELEGATION_DENIED')
  assert.match(denied[0].taskOutput.error_info?.message ?? '', /委派需要人工确认/)
  assert.equal(getTaskRegistry().getByToolCallId('tc-del-1'), undefined, 'deny 后不登记注册表')
  assert.equal(startedEvents.length, 0, 'deny 后不发 SUBAGENT_TASK_STARTED')

  // 未命中 matcher：放行到 preflight（模板不存在 → 预检失败），hook 不再触发
  const passed = await executeTaskToolCalls([makeTaskCall('tc-del-2', 'nonexistent-xyz')], {
    toolMetadata: [],
    toolDefinitions: [],
  })
  assert.equal(passed[0].taskOutput.error_info?.code, 'PREFLIGHT_FAILED')
  const preCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PreDelegation')
  assert.equal(preCalls.length, 1, 'matcher 未命中零派发')
  assert.equal(preCalls[0].input.matcher_value, 'code-reviewer', 'matcher_value = subagent_type')
  assert.equal(preCalls[0].input.tool_name, 'task')
})

test('PostDelegation：settle 链注入式触发（含结果摘要），additionalContext 进入主会话下一轮上下文', async (t) => {
  t.after(() => setDelegationHookDispatcher(null))
  const { deps, fakeRunner, modelCalls } = makeEngineEnv(
    {
      hooks: {
        PostDelegation: [{ hooks: [{ command: 'audit.mjs' }] }],
      },
    },
    {
      responder: () =>
        ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostDelegation', additionalContext: 'DELEGATION-NOTE' } })),
    },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  // sync 路径免 preflight（模板不存在 → 执行失败 settle，PostDelegation 仍触发）
  const results = await executeTaskToolCalls(
    [makeTaskCall('tc-del-3', 'nonexistent-xyz')],
    { toolMetadata: [], toolDefinitions: [] },
    undefined,
    { sync: true },
  )
  assert.equal(results[0].taskOutput.status, 'failed')

  await waitFor(
    () => fakeRunner.calls.some((c) => c.input.hook_event_name === 'PostDelegation'),
    'PostDelegation 派发',
  )
  const postCall = fakeRunner.calls.find((c) => c.input.hook_event_name === 'PostDelegation')!
  assert.equal(postCall.input.task_status, 'failed', '结果摘要随 stdin 透传')
  assert.equal(typeof postCall.input.result_summary, 'string')

  const before = modelCalls.length
  await engine.sendMessage({ text: '整合结果' })
  const systemTexts = modelCalls
    .slice(before)
    .flatMap((c) => c.messages)
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content))
  assert.ok(systemTexts.some((t) => t.includes('DELEGATION-NOTE')), 'additionalContext 应注入下一轮上下文')
})

// ==================== Worker MCP 覆盖（来源标记 + 咽喉 hooks） ====================

/** 直接驱动网关私有入口（IPC 处理函数），child 用假 send 捕获回包 */
function makeGatewayHarness() {
  const sent: any[] = []
  const mcpCalls: Array<{ toolName: string; args: any }> = []
  const child = { send: (msg: any) => sent.push(msg) }
  const mcpService = {
    getToolsService: () => ({
      callTool: async (toolName: string, args: any) => {
        mcpCalls.push({ toolName, args })
        return { content: 'mcp-result' }
      },
    }),
  }
  const fm = new TemplateSubagentForkManager(mcpService as any)
  const invoke = (toolName: string, args: Record<string, unknown>) =>
    (fm as any).handleToolCallRequest(
      child,
      { id: 'r1', payload: { toolName, args, kind: 'mcp', connectionId: 'c1', toolCallId: 'tc-mcp-1' } },
      'reviewer-1699999999999-abcdef123',
    )
  return { sent, mcpCalls, invoke }
}

test('Worker MCP：PreToolUse deny 拒绝调用（来源标记 __origin 随 hook 载荷透传，不进工具入参）', async (t) => {
  const { deps, fakeRunner } = makeEngineEnv(
    { hooks: { PreToolUse: [{ matcher: 'mcp_search', hooks: [{ command: 'mcp-guard.mjs' }] }] } },
    { responder: () => block('Worker 禁止该 MCP 工具') },
  )
  const engine = new ChatEngine(deps) // 构造时注册 Worker MCP 派发通道
  t.after(() => engine.dispose())

  const { sent, mcpCalls, invoke } = makeGatewayHarness()
  await invoke('mcp_search', { q: 1 })

  assert.equal(mcpCalls.length, 0, 'deny 后 MCP 工具不执行')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.success, false)
  assert.match(sent[0].payload.error, /Worker 禁止该 MCP 工具/)

  const preCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PreToolUse')
  assert.equal(preCalls.length, 1)
  assert.equal((preCalls[0].input.__origin as any)?.source, 'subagent', '来源标记随 hook 载荷透传')
  assert.equal((preCalls[0].input.__origin as any)?.subagentType, 'reviewer')
  assert.equal(preCalls[0].input.tool_name, 'mcp_search')
})

test('Worker MCP：放行路径 args 无 __origin 污染；PostToolUse 附加上下文拼入结果回传 Worker', async (t) => {
  const { deps } = makeEngineEnv(
    {
      hooks: {
        PreToolUse: [{ matcher: 'mcp_search', hooks: [{ command: 'noop.mjs' }] }],
        PostDelegation: [], // 占位：保持配置形态合法
        PostToolUse: [{ matcher: 'mcp_search', hooks: [{ command: 'mcp-audit.mjs' }] }],
      },
    },
    {
      responder: (input) =>
        input.hook_event_name === 'PostToolUse'
          ? ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'MCP-NOTE' } }))
          : ok(),
    },
  )
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  const { sent, mcpCalls, invoke } = makeGatewayHarness()
  await invoke('mcp_search', { q: 1 })

  assert.equal(mcpCalls.length, 1)
  assert.deepEqual(mcpCalls[0].args, { q: 1 }, '工具入参原样发往 MCP server（无 __origin 污染）')
  assert.equal(sent[0].payload.success, true)
  assert.match(sent[0].payload.result.content, /mcp-result/)
  assert.match(sent[0].payload.result.content, /MCP-NOTE/, 'hook 附加上下文拼入结果文本')
})
