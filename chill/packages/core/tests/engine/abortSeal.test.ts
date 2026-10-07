import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message, MessageRole, ToolCallStatus } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import {
  getTaskRegistry,
  resetTaskRegistry,
  type TaskRegistry,
} from '../../src/services/delegation/taskRegistry.ts'

/**
 * 中断轮封口落盘（seal 替代 rollback）测试：真实 ChatEngine + 最小 fake deps（模式同 taskReflow.test.ts）。
 * 验证：
 * - abort 于首次 API 调用中 → user 消息保留并落盘，无幽灵 toolCalls；
 * - abort 于后续 API 调用中 → 已完成步骤（assistant + 全部 tool 结果）保留并落盘，producedMessages 非空；
 * - 每个工具步骤完成即落盘（每步 persist，硬崩溃兜底）；
 * - seal 分类（白盒）：注册表 running → RUNNING 占位；无登记 → FAILED 中断标记；已有结果跳过；
 * - 非 abort 异常 → 封口+落盘后错误照常抛出；
 * - 已入史的 RUNNING task 占位不被封口；
 * - regenerate abort → rollback 语义不回归（旧末轮恢复）。
 *
 * enum（MessageRole/ToolCallStatus）不可运行时导入，一律字符串字面量。
 */

const USER = 'user' as MessageRole
const ASSISTANT = 'assistant' as MessageRole
const TOOL = 'tool' as MessageRole
const STATUS_RUNNING = 'running' as ToolCallStatus
const STATUS_FAILED = 'failed' as ToolCallStatus
const STATUS_SUCCESS = 'success' as ToolCallStatus

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

function toolCall(id: string, name: string, args = '{}') {
  return { id, type: 'function' as const, function: { name, arguments: args } }
}

interface MakeDepsOptions {
  /** 按调用序号返回模型响应；Promise 永不 resolve 可模拟挂起（abort 测试） */
  onCall?: (callIndex: number) => Promise<any> | any
  loadRecord?: SessionRecord
  executeAsync?: (toolName: string, args: string, toolCallId: string) => Promise<{ success: boolean; data?: any; error?: string }>
}

function makeDeps(options: MakeDepsOptions = {}) {
  const calls: Message[][] = []
  const saved: SessionRecord[] = []
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        calls.push(params.messages)
        if (options.onCall) return options.onCall(calls.length - 1)
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
        saved.push(record)
        return { success: true }
      },
      load: async () =>
        options.loadRecord ? { success: true, record: options.loadRecord } : { success: false },
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true, data: { content: 'sync-result' } }),
      executeAsync:
        options.executeAsync ??
        (async (toolName: string) => ({ success: true, data: { content: `result-of-${toolName}` } })),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
  }
  return { deps, calls, saved }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const hang = () => new Promise<any>(() => {})

/** 会话加载（createdThisRun=false，跳过自动标题干扰 save 计数） */
async function engineWithHistory(messages: Message[], options: MakeDepsOptions = {}) {
  const { deps, calls, saved } = makeDeps({ ...options, loadRecord: makeRecord(messages) })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  return { engine, calls, saved }
}

test('abort 于首次 API 调用中：user 消息保留并落盘，无幽灵 toolCalls', async () => {
  const { engine, saved } = await engineWithHistory(
    [{ role: USER, content: '旧消息', timestamp: T0 }],
    { onCall: () => hang() }
  )
  const turn = engine.sendMessage({ text: '新问题' })
  await sleep(10)
  engine.abort()
  const result = await turn

  assert.equal(result.aborted, true)
  assert.deepEqual(result.producedMessages, [])
  const history = engine.getHistory()
  assert.equal(history.length, 2, '旧消息 + 本轮 user')
  assert.equal(history[1].role, USER)
  assert.equal(history[1].content, '新问题')
  // 封口落盘：磁盘记录含本轮 user 消息
  assert.ok(saved.length >= 1, '中断轮已落盘')
  const last = saved[saved.length - 1]
  assert.ok(last.messages.some((m) => m.role === USER && m.content === '新问题'))
  assert.ok(!last.messages.some((m) => m.toolCalls && m.toolCalls.length > 0), '无悬空 toolCalls')
  engine.dispose()
})

test('abort 于后续 API 调用中：已完成步骤保留并落盘，producedMessages 非空', async () => {
  const { engine, saved } = await engineWithHistory(
    [{ role: USER, content: '旧消息', timestamp: T0 }],
    {
      onCall: (i) =>
        i === 0
          ? { content: '先读两个文件', toolCalls: [toolCall('t1', 'read_file', '{"path":"a"}'), toolCall('t2', 'read_file', '{"path":"b"}')] }
          : hang(),
    }
  )
  const turn = engine.sendMessage({ text: '读文件' })
  await sleep(10)
  engine.abort()
  const result = await turn

  assert.equal(result.aborted, true)
  // 逐条入史：assistant + 2 条 tool 结果全部保留（producedMessages 不再为空）
  assert.equal(result.producedMessages.length, 3)
  const history = engine.getHistory()
  const assistantMsg = history.find((m) => m.role === ASSISTANT && m.toolCalls)
  assert.ok(assistantMsg, 'assistant 工具调用消息保留')
  for (const id of ['t1', 't2']) {
    const toolMsg = history.find((m) => m.role === TOOL && m.toolCallId === id)
    assert.ok(toolMsg, `tool 结果 ${id} 保留`)
    assert.equal(toolMsg!.toolCallStatus, STATUS_SUCCESS as string, '已执行完的结果是 success，不补中断标记')
  }
  // 邻接配对完整：每个 toolCall 都有对应 tool 消息
  // 落盘：最后一条记录含全部已完成步骤
  const last = saved[saved.length - 1]
  assert.ok(last.messages.some((m) => m.role === TOOL && m.toolCallId === 't1'))
  assert.ok(last.messages.some((m) => m.role === TOOL && m.toolCallId === 't2'))
  engine.dispose()
})

test('每步落盘：两轮工具步骤 + 轮末，persist 每步触发', async () => {
  const { engine, saved } = await engineWithHistory(
    [{ role: USER, content: '旧消息', timestamp: T0 }],
    {
      onCall: (i) => {
        if (i === 0) return { content: '', toolCalls: [toolCall('t1', 'read_file')] }
        if (i === 1) return { content: '', toolCalls: [toolCall('t2', 'read_file')] }
        return { content: '完成' }
      },
    }
  )
  const result = await engine.sendMessage({ text: '两步任务' })
  assert.equal(result.aborted, false)
  // 步骤 1 落盘 + 步骤 2 落盘 + 轮末落盘 = 3 次
  assert.equal(saved.length, 3, '每个合法前缀形成即落盘')
  engine.dispose()
})

test('seal 分类（白盒）：注册表 running 补 RUNNING 占位，无登记补 FAILED，已有结果跳过', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { engine } = await engineWithHistory([{ role: USER, content: '旧消息', timestamp: T0 }])

  // 白盒构造半截步骤：assistant 发起 3 个调用，仅 tc-done 有结果
  const e = engine as any
  e.history.push({
    role: ASSISTANT,
    content: '',
    toolCalls: [toolCall('tc-run', 'task'), toolCall('tc-miss', 'read_file'), toolCall('tc-done', 'read_file')],
    timestamp: new Date(),
  })
  e.history.push({ role: TOOL, content: 'done', toolCallId: 'tc-done', toolCallStatus: 'success', timestamp: new Date() })
  registry.register({ taskId: 'alias-tc-run', toolCallId: 'tc-run', subagentType: 'coder', description: '任务', batchId: 'b1' })

  const produced: Message[] = []
  e.sealIncompleteToolRound(produced)

  const runMsg = engine.getHistory().find((m) => m.role === TOOL && m.toolCallId === 'tc-run')
  assert.ok(runMsg, '注册表 running 的调用补占位')
  assert.equal(runMsg!.toolCallStatus, STATUS_RUNNING as string, '补 RUNNING 占位而非 FAILED（任务还在跑）')
  const missMsg = engine.getHistory().find((m) => m.role === TOOL && m.toolCallId === 'tc-miss')
  assert.ok(missMsg, '无登记的调用补中断标记')
  assert.equal(missMsg!.toolCallStatus, STATUS_FAILED as string)
  assert.match(String(missMsg!.content), /已被中断/)
  assert.equal(
    engine.getHistory().filter((m) => m.role === TOOL && m.toolCallId === 'tc-done').length,
    1,
    '已有结果的调用不重复补'
  )
  assert.equal(produced.length, 2, '封口补的两条消息进 producedMessages')
  engine.dispose()
})

test('非 abort 异常：封口+落盘后错误照常抛出', async () => {
  const { engine, saved } = await engineWithHistory(
    [{ role: USER, content: '旧消息', timestamp: T0 }],
    {
      onCall: (i) => {
        if (i === 0) return { content: '', toolCalls: [toolCall('t1', 'read_file')] }
        throw new Error('网络连接中断')
      },
    }
  )
  await assert.rejects(engine.sendMessage({ text: '会失败的一轮' }), /网络连接中断/)
  const history = engine.getHistory()
  assert.ok(history.some((m) => m.role === TOOL && m.toolCallId === 't1'), '已完成步骤保留')
  assert.ok(saved.length >= 1, '异常轮已封口落盘')
  engine.dispose()
})

test('已入史的 RUNNING task 占位不被封口', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry: TaskRegistry = getTaskRegistry()
  const { engine } = await engineWithHistory([{ role: USER, content: '旧消息', timestamp: T0 }], {
    onCall: (i) => (i === 0 ? { content: '', toolCalls: [toolCall('tc-task', 'task', '{"description":"x"}')] } : hang()),
    executeAsync: async (toolName: string, _args: string, toolCallId: string) => {
      if (toolName === 'task') {
        registry.register({ taskId: `alias-${toolCallId}`, toolCallId, subagentType: 'coder', description: 'x', batchId: 'b1' })
        return { success: true, data: { content: '任务已受理，后台执行中' } }
      }
      return { success: true, data: { content: 'ok' } }
    },
  })
  const turn = engine.sendMessage({ text: '派活' })
  await sleep(10)
  engine.abort()
  const result = await turn

  assert.equal(result.aborted, true)
  const placeholders = engine.getHistory().filter((m) => m.role === TOOL && m.toolCallId === 'tc-task')
  assert.equal(placeholders.length, 1, '占位只有一条，封口不追加')
  assert.equal(placeholders[0].toolCallStatus, STATUS_RUNNING as string, '占位保持 RUNNING（等 settle 写回）')
  engine.dispose()
})

test('regenerate abort：rollback 语义不回归（旧末轮恢复，不落盘抹除）', async () => {
  const { engine, saved } = await engineWithHistory(
    [
      { role: USER, content: '问题', timestamp: T0 },
      { role: ASSISTANT, content: '原答案', timestamp: new Date('2025-01-01T00:01:00Z') },
    ],
    { onCall: () => hang() }
  )
  const turn = engine.regenerate()
  await sleep(10)
  engine.abort()
  const result = await turn

  assert.equal(result.aborted, true)
  const history = engine.getHistory()
  assert.equal(history[history.length - 1].content, '原答案', '中断的重做恢复原答案')
  assert.ok(saved.length === 0, 'rollback 路径不落盘（磁盘旧记录保持不动）')
  engine.dispose()
})
