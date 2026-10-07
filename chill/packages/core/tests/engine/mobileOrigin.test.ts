import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import {
  ApprovalChannel,
  resetApprovalChannel,
  onApprovalPendingChange,
  type ApprovalRequestPayload,
} from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'

/**
 * M2 mobile origin 测试：
 * ① mobile 注入轮 → 工具调用 args 携带 __origin:{source:'mobile'}（hooks 之后注入，非 mobile 轮不带）；
 * ② enqueueExternalMessage 薄包装 + UserPromptSubmit deny → deniedReason 回执填充；
 * ③ M5 全起源同规则：fullAccess 档下 mobile 起源也直通（安全档已删除，唯一真相源 = permissionMode）；
 * ④ 审批通道 mobile 起源 5 分钟超时自动拒绝语义（注入超时毫秒）+ 落定清定时器 + 非 mobile 无超时；
 * ⑤ setPermissionMode 事件：实际变更发 PERMISSION_MODE_CHANGED（by 透传）、同值不发。
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
  firstTurnToolCalls?: { id: string; name: string; arguments: string }[]
  hookRunner?: unknown
}

function makeEngineEnv(options: EngineEnvOptions = {}) {
  const executorCalls: { toolName: string; args: string }[] = []
  let firstCall = true
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async () => {
        if (firstCall && options.firstTurnToolCalls) {
          firstCall = false
          return {
            content: '',
            toolCalls: options.firstTurnToolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
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
      load: async () => ({ success: true, record: makeRecord([{ role: 'user' as Message['role'], content: 'hi', timestamp: T0 }]) }),
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true, data: { content: 'sync-result' } }),
      executeAsync: async (toolName: string, args: string) => {
        executorCalls.push({ toolName, args })
        return { success: true, data: { content: `result-of-${toolName}` } }
      },
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    ...(options.hookRunner ? { hookRunner: options.hookRunner as ChatEngineDeps['hookRunner'] } : {}),
  }
  return { deps, executorCalls }
}

test('① mobile 注入轮：工具调用 args 携带 __origin.mobile 全量归因；普通轮带 source:main', async () => {
  const { deps, executorCalls } = makeEngineEnv({
    firstTurnToolCalls: [{ id: 'tc1', name: 'execute_powershell', arguments: '{"command":"echo hi"}' }],
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await engine.enqueueExternalMessage({ text: '帮我看看目录', origin: 'mobile' })
  assert.equal(executorCalls.length, 1)
  const args = JSON.parse(executorCalls[0].args)
  // 2.1 主会话注入全量 __origin（沿 mobile 先例）：source:mobile + handle/sessionId/turnId 归因
  assert.equal(args.__origin.source, 'mobile')
  assert.equal(typeof args.__origin.handle, 'string')
  assert.ok(args.__origin.handle.length > 0)
  assert.equal(args.__origin.sessionId, 's1')
  assert.ok(typeof args.__origin.turnId === 'string' && args.__origin.turnId.startsWith('user:'))
  assert.equal(args.command, 'echo hi') // 原参数不失真

  // 普通轮（2.1 起）：同样注入全量 __origin，source 为 main（CLI 单引擎行为语义不变，仅增保留字段）
  executorCalls.length = 0
  const env2 = makeEngineEnv({
    firstTurnToolCalls: [{ id: 'tc2', name: 'execute_powershell', arguments: '{"command":"echo hi"}' }],
  })
  const engine2 = new ChatEngine(env2.deps)
  await engine2.loadSession('s1')
  await engine2.sendMessage({ text: '本地消息' })
  assert.equal(env2.executorCalls.length, 1)
  const args2 = JSON.parse(env2.executorCalls[0].args)
  assert.equal(args2.__origin.source, 'main')
  assert.equal(args2.__origin.sessionId, 's1')
  assert.equal(args2.command, 'echo hi') // 原参数不失真
})

test('② UserPromptSubmit hook deny：deniedReason 填充（回执手机"消息被拦截"用）', async () => {
  const denyRunner = {
    dispatch: async () => ({
      verdict: { type: 'deny', reason: '含敏感指令' },
      systemMessages: [],
      additionalContext: [],
    }),
  }
  const { deps } = makeEngineEnv({ hookRunner: denyRunner })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  const result = await engine.enqueueExternalMessage({ text: '危险指令', origin: 'mobile' })
  assert.equal(result.deniedReason, '含敏感指令')
  assert.equal(result.producedMessages.length, 0)
})

function makeRealExecutor(calls: Array<{ command: string }>) {
  const codeExecutor = {
    executePowerShell: async (command: string) => {
      calls.push({ command })
      return { success: true, output: `ok:${command}` }
    },
  }
  return new BuiltInToolExecutor({} as any, {} as any, {} as any, codeExecutor as any)
}

function onceApproval(): { fired: () => ApprovalRequestPayload[] } {
  const captured: ApprovalRequestPayload[] = []
  const listener = (data: ApprovalRequestPayload) => captured.push(data)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  return {
    fired: () => {
      eventBus.off(EVENTS.APPROVAL_REQUESTED, listener)
      return captured
    },
  }
}

test('③ M5 全起源同规则：fullAccess 档下 mobile 起源 execute_powershell 直通（安全档已删除）', async (t) => {
  t.after(() => resetApprovalChannel())
  // fullAccess 下 mobile 起源与非 mobile 同规则：直通不审批（唯一真相源 = permissionMode）
  const calls: Array<{ command: string }> = []
  const executor = makeRealExecutor(calls)
  executor.setAutoApply(true) // fullAccess
  const requested = onceApproval()
  const direct = await executor.executeAsync(
    'execute_powershell',
    JSON.stringify({ command: 'echo b', __origin: { source: 'mobile' } }),
    'tc-m1',
  )
  assert.equal(direct.success, true)
  assert.equal(calls.length, 1) // 直通执行
  assert.equal(requested.fired().length, 0) // 无审批弹窗
})

test('⑤ setPermissionMode：实际变更发 PERMISSION_MODE_CHANGED（by 透传）；同值不发', () => {
  const executor = makeRealExecutor([])
  const changed: unknown[] = []
  const listener = (d: unknown) => changed.push(d)
  eventBus.on(EVENTS.PERMISSION_MODE_CHANGED, listener)
  try {
    executor.setPermissionMode('boundary') // 同值（默认 boundary）→ 不发
    assert.equal(changed.length, 0)
    executor.setPermissionMode('fullAccess', 'phone')
    assert.deepEqual(changed, [{ mode: 'fullAccess', by: 'phone' }])
    executor.setPermissionMode('boundary') // 缺省 by='local'
    assert.deepEqual(changed[1], { mode: 'boundary', by: 'local' })
    assert.equal(changed.length, 2)
  } finally {
    eventBus.off(EVENTS.PERMISSION_MODE_CHANGED, listener)
  }
})

test('④ 审批通道：mobile 起源超时自动拒绝；落定清定时器；非 mobile 无超时', async () => {
  resetApprovalChannel()
  const channel = new ApprovalChannel()

  // 超时自动拒绝（注入 50ms 代替 5 分钟）
  const pendingStates: boolean[] = []
  const off = onApprovalPendingChange((p) => pendingStates.push(p))
  const timedOut = await channel.request(
    { toolCallId: 'tc-t1', kind: 'command', command: 'rm -rf x', origin: { source: 'mobile' } },
    { timeoutMs: 50 },
  )
  assert.deepEqual(timedOut, { approved: false, reason: '审批超时已拒绝' })
  assert.equal(channel.listPending().length, 0) // 挂起登记已清
  assert.deepEqual(pendingStates, [true, false]) // enter/leave 严格配对，无泄漏
  off()

  // 落定（批准）清定时器：批准后不会再被超时转拒绝
  const approvedP = channel.request(
    { toolCallId: 'tc-t2', kind: 'command', command: 'echo', origin: { source: 'mobile' } },
    { timeoutMs: 30 },
  )
  assert.equal(channel.resolve('tc-t2', { approved: true }), true)
  assert.deepEqual(await approvedP, { approved: true })
  await new Promise((r) => setTimeout(r, 60)) // 超过原超时点，无二次落定（Promise 单落定语义守住）
  assert.equal(channel.listPending().length, 0)

  // 非 mobile 起源：无超时，挂起直到手动回答
  const mainP = channel.request({ toolCallId: 'tc-t3', kind: 'write', path: '/x', origin: { source: 'main' } })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(channel.listPending().length, 1) // 仍挂起
  channel.resolve('tc-t3', { approved: false, reason: '手动拒绝' })
  const mainRes = await mainP
  assert.equal(mainRes.approved, false)
  resetApprovalChannel()
})

test('⑥ clientId 贯穿：enqueueExternalMessage 携带 clientId → 落盘用户消息携带同值（buildUserMessage 透传）', async () => {
  const { deps } = makeEngineEnv()
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await engine.enqueueExternalMessage({ text: '带身份的消息', origin: 'mobile', clientId: 'env-uuid-7' })
  const userMsg = engine.getHistory().find((m) => m.role === 'user' && m.content === '带身份的消息')!
  assert.equal(userMsg.clientId, 'env-uuid-7')
  // 不携带时不产出字段（本地轮零污染）
  const engine2 = new ChatEngine(makeEngineEnv().deps)
  await engine2.loadSession('s1')
  await engine2.sendMessage({ text: '本地消息' })
  const localMsg = engine2.getHistory().find((m) => m.role === 'user' && m.content === '本地消息')!
  assert.equal(localMsg.clientId, undefined)
})
