import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message, MessageRole, ToolCallStatus } from '../../src/types/models.ts'
import type { TaskToolOutput, TaskExecutionStatus } from '../../src/orchestrator/types.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import {
  getTaskRegistry,
  resetTaskRegistry,
  type TaskRegistry,
} from '../../src/services/delegation/taskRegistry.ts'

/**
 * 后台任务回流（T2）测试：真实 ChatEngine + 最小 fake deps。
 * 注册表是进程内单例——测试直接登记/落地任务模拟 delegation 层时序
 * （真实路径：delegation 层先 markSettled 入队，再回调引擎 notifyTaskSettled）。
 *
 * enum（MessageRole/ToolCallStatus/TaskExecutionStatus）不可运行时导入，一律字符串字面量。
 */

const COMPLETED = 'completed' as TaskExecutionStatus
const FAILED_EXEC = 'failed' as TaskExecutionStatus
const TOOL = 'tool' as MessageRole
const USER = 'user' as MessageRole
const ASSISTANT = 'assistant' as MessageRole
const STATUS_RUNNING = 'running' as ToolCallStatus
const STATUS_SUCCESS = 'success' as ToolCallStatus

function completedOutput(text: string): TaskToolOutput {
  return { status: COMPLETED, final_output: text }
}

function failedOutput(message: string): TaskToolOutput {
  return { status: FAILED_EXEC, final_output: '', error_info: { code: 'FAILED', message } }
}

const T0 = new Date('2025-01-01T00:00:00Z')
const userMsg: Message = { role: USER, content: '之前的问题', timestamp: T0 }
const assistantMsg: Message = { role: ASSISTANT, content: '之前的答复', timestamp: T0 }

/** task 占位 TOOL 消息（T1 非阻塞化形态：受理文案 + toolCallStatus=running） */
function placeholderMessage(toolCallId: string): Message {
  return {
    role: TOOL,
    content: JSON.stringify({ content: `任务已受理，后台执行中（任务标识: alias-${toolCallId}）` }),
    toolCallId,
    toolCallStatus: STATUS_RUNNING,
    timestamp: T0,
  }
}

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

function registerTask(registry: TaskRegistry, toolCallId: string, batchId: string, description: string) {
  return registry.register({
    taskId: `alias-${toolCallId}`,
    toolCallId,
    subagentType: 'code-reviewer',
    description,
    batchId,
  })
}

interface MakeDepsOptions {
  onCall?: (messages: Message[], callIndex: number) => Promise<any> | any
  loadRecord?: SessionRecord
  executeAsync?: () => Promise<{ success: boolean; data?: any; error?: string }>
}

function makeDeps(options: MakeDepsOptions = {}) {
  const calls: Message[][] = []
  const state = { saves: 0 }
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        calls.push(params.messages)
        if (options.onCall) return options.onCall(params.messages, calls.length - 1)
        return { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => {
        state.saves++
        return { success: true }
      },
      load: async () =>
        options.loadRecord ? { success: true, record: options.loadRecord } : { success: false },
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true }),
      executeAsync: options.executeAsync ?? (async () => ({ success: true })),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
  }
  return { deps, calls, state }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 某次模型调用的消息序列里是否含带 keyword 的回流通知（合成 user 消息） */
function hasNotice(messages: Message[], keyword?: string): boolean {
  return messages.some(
    (m) =>
      m.role === USER &&
      typeof m.content === 'string' &&
      m.content.includes('【后台任务完成通知】') &&
      (keyword === undefined || m.content.includes(keyword))
  )
}

test('写回路径：settle 后改写正确占位消息（内容/状态），并触发回流汇报', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps, calls, state } = makeDeps({
    loadRecord: makeRecord([
      userMsg,
      assistantMsg,
      placeholderMessage('tc-1'),
    ]),
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')

  registerTask(registry, 'tc-1', 'b1', '审查改动')
  registry.markSettled('tc-1', completedOutput('审查结果：3 个问题'))
  const savesBefore = state.saves
  await engine.notifyTaskSettled('tc-1', completedOutput('审查结果：3 个问题'))

  // 占位被改写为真实结果（与 buildTaskToolMessage 终态形态一致：{ content } JSON）
  const toolMsg = engine.getHistory().find((m) => m.role === TOOL && m.toolCallId === 'tc-1')
  assert.ok(toolMsg)
  assert.equal(toolMsg.content, JSON.stringify({ content: '审查结果：3 个问题' }))
  assert.equal(toolMsg.toolCallStatus, STATUS_SUCCESS)
  // writeBack 自带落盘
  assert.ok(state.saves > savesBefore, '写回应触发落盘')
  // 单任务批次完成即入队 → 空闲引擎立即回流一轮，通知含任务清单
  assert.equal(calls.length, 1)
  assert.ok(hasNotice(calls[0], '审查改动'))
  engine.dispose()
})

test('写回路径：失败任务写回"工具调用失败"文本 + FAILED 状态', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps } = makeDeps({
    loadRecord: makeRecord([userMsg, assistantMsg, placeholderMessage('tc-1')]),
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')

  registerTask(registry, 'tc-1', 'b1', '审查改动')
  registry.markSettled('tc-1', failedOutput('执行超时'))
  await engine.notifyTaskSettled('tc-1', failedOutput('执行超时'))

  const toolMsg = engine.getHistory().find((m) => m.role === TOOL && m.toolCallId === 'tc-1')
  assert.ok(toolMsg)
  assert.equal(toolMsg.content, '工具调用失败: 执行超时')
  assert.equal(toolMsg.toolCallStatus, 'failed')
  engine.dispose()
})

test('写回路径：cancel_task 的 CANCELLED 通知写回"已取消" + REJECTED 状态(不 FAILED、不进 drain)', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps } = makeDeps({
    loadRecord: makeRecord([userMsg, assistantMsg, placeholderMessage('tc-1')]),
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')

  // cancel_task 的实际流程:先 markCancelled,再经 notifyTaskSettled 通道回 CANCELLED output
  registerTask(registry, 'tc-1', 'b1', '审查改动')
  registry.markCancelled('tc-1')
  await engine.notifyTaskSettled('tc-1', {
    status: FAILED_EXEC,
    final_output: '任务已被取消。',
    error_info: { code: 'CANCELLED', message: '任务被 cancel_task 主动取消' },
  })

  const toolMsg = engine.getHistory().find((m) => m.role === TOOL && m.toolCallId === 'tc-1')
  assert.ok(toolMsg)
  assert.equal(toolMsg.content, '任务已被取消。')
  assert.equal(toolMsg.toolCallStatus, 'rejected')
  engine.dispose()
})

test('批次齐否：同批未齐不回流，齐后整批合并为一条通知', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps, calls } = makeDeps({
    loadRecord: makeRecord([
      userMsg,
      assistantMsg,
      placeholderMessage('tc-1'),
      placeholderMessage('tc-2'),
    ]),
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')

  registerTask(registry, 'tc-1', 'b1', '任务一')
  registerTask(registry, 'tc-2', 'b1', '任务二')

  // 第一个落地：批次未齐 → 不回流
  registry.markSettled('tc-1', completedOutput('结果一'))
  await engine.notifyTaskSettled('tc-1', completedOutput('结果一'))
  assert.equal(calls.length, 0, '批次未齐不应回流')

  // 第二个落地：批次齐 → 整批一条通知
  registry.markSettled('tc-2', completedOutput('结果二'))
  await engine.notifyTaskSettled('tc-2', completedOutput('结果二'))
  assert.equal(calls.length, 1, '批次齐后整批汇报一轮')
  assert.ok(hasNotice(calls[0], '任务一'))
  assert.ok(hasNotice(calls[0], '任务二'))
  engine.dispose()
})

test('batch_task 初始占位（executeOneToolCall 路径）按 isBatchRoot 甄别标 RUNNING', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps } = makeDeps({
    onCall: (_m, i) =>
      i === 0
        ? {
            content: '',
            toolCalls: [
              {
                id: 'tc-b',
                type: 'function',
                function: {
                  name: 'batch_task',
                  arguments: '{"tasks":[{"subagent_type":"document-writer","task_description":"写"}]}',
                },
              },
            ],
          }
        : { content: '收尾' },
    executeAsync: async () => ({
      success: true,
      data: { content: '批量任务已受理: 1 个任务后台执行中（批次标识: b1）' },
    }),
  })
  const engine = new ChatEngine(deps)
  // batch_task 登记形态：成员派生 id + batchRootToolCallId 指向占位根（executeAsync 已 mock，手动登记）
  registry.register({
    taskId: 'tc-b#0',
    toolCallId: 'tc-b#0',
    subagentType: 'document-writer',
    description: '写',
    batchId: 'b1',
    batchRootToolCallId: 'tc-b',
  })
  await engine.sendMessage({ text: '批量派活' })
  const placeholder = engine.getHistory().find((m) => m.role === TOOL && m.toolCallId === 'tc-b')
  assert.ok(placeholder)
  assert.equal(placeholder.toolCallStatus, STATUS_RUNNING, '批次受理占位须标 RUNNING（供孤儿清扫与显示层识别）')
  engine.dispose()
})

test('孤儿清扫：批次占位（isBatchRoot、无在途成员）同样标记"已中断"', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps } = makeDeps({
    loadRecord: makeRecord([userMsg, assistantMsg, placeholderMessage('root-9')]),
  })
  const engine = new ChatEngine(deps)
  // 批次成员全部落地（无在途）而占位仍 RUNNING = 幽灵（进程曾退出），应被清扫
  registry.register({
    taskId: 'root-9#0',
    toolCallId: 'root-9#0',
    subagentType: 'document-writer',
    description: '写',
    batchId: 'b9',
    batchRootToolCallId: 'root-9',
  })
  registry.markSettled('root-9#0', completedOutput('结果'))
  await engine.loadSession('s1')
  const orphan = engine.getHistory().find((m) => m.toolCallId === 'root-9')
  assert.ok(orphan)
  assert.equal(orphan.toolCallStatus, 'failed')
  assert.ok(typeof orphan.content === 'string' && orphan.content.includes('已中断（进程退出）'))
  engine.dispose()
})

test('batch_task：成员 settle 经批次根 id 进度式重写共享占位，批齐后写回终态并触发回流', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps, calls } = makeDeps({
    loadRecord: makeRecord([userMsg, assistantMsg, placeholderMessage('root-1')]),
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')

  // batch_task 登记形态：成员以派生 id 登记、根 id 存于 batchRootToolCallId（根自身无登记）
  for (const [i, desc] of [[0, '任务一'], [1, '任务二']] as const) {
    registry.register({
      taskId: `root-1#${i}`,
      toolCallId: `root-1#${i}`,
      subagentType: 'document-writer',
      description: desc,
      batchId: 'b1',
      batchRootToolCallId: 'root-1',
    })
  }

  // 成员一落地：批次未齐 → 进度式重写共享占位（仍 RUNNING），不回流
  registry.markSettled('root-1#0', completedOutput('结果一'))
  await engine.notifyTaskSettled('root-1', {
    status: 'running' as TaskExecutionStatus,
    final_output: '批量任务执行中: 1/2 已落地，全部完成后会收到通知',
  })
  const progress = engine.getHistory().find((m) => m.toolCallId === 'root-1')
  assert.ok(progress)
  assert.equal(progress.toolCallStatus, STATUS_RUNNING)
  assert.ok(typeof progress.content === 'string' && progress.content.includes('1/2'))
  assert.equal(calls.length, 0, '批次未齐不应回流')

  // 成员二落地：批次齐 → 终态写回共享占位 + 整批回流汇报
  registry.markSettled('root-1#1', completedOutput('结果二'))
  await engine.notifyTaskSettled('root-1', {
    status: COMPLETED,
    final_output: '批量任务已全部落地（共 2 个），结果如下，请整合后答复用户',
  })
  const terminal = engine.getHistory().find((m) => m.toolCallId === 'root-1')
  assert.ok(terminal)
  assert.equal(terminal.toolCallStatus, STATUS_SUCCESS)
  assert.equal(calls.length, 1, '批次齐后整批汇报一轮')
  assert.ok(hasNotice(calls[0], '任务一'))
  assert.ok(hasNotice(calls[0], '任务二'))
  engine.dispose()
})

test('drain：引擎 running 时不插队，主轮正常收尾后串行汇报（含回流轮中新齐批次）', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const { deps, calls } = makeDeps({
    loadRecord: makeRecord([userMsg, assistantMsg]),
    onCall: async (_m, i) => {
      if (i === 0) {
        await gate // 主轮挂起，模拟生成进行中
        return { content: '主轮答复' }
      }
      if (i === 1) {
        // 回流轮进行中：另一批次落地入队（drain 只读注册表队列，下轮串行再报）
        registry.markSettled('tc-2', completedOutput('结果二'))
        return { content: '汇报一' }
      }
      return { content: '汇报二' }
    },
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  registerTask(registry, 'tc-1', 'b1', '任务一')
  registerTask(registry, 'tc-2', 'b2', '任务二')

  const sendPromise = engine.sendMessage({ text: '用户消息' })
  await sleep(10)
  registry.markSettled('tc-1', completedOutput('结果一'))
  await engine.notifyTaskSettled('tc-1', completedOutput('结果一'))
  assert.equal(calls.length, 1, 'running 时不插队回流')

  release()
  await sendPromise
  // 主轮正常收尾 → drain 批次一（calls[1]）；回流轮中批次二落地 → while 串行再报（calls[2]）
  assert.equal(calls.length, 3)
  assert.ok(hasNotice(calls[1], '任务一'))
  assert.ok(hasNotice(calls[2], '任务二'))
  engine.dispose()
})

test('drain：abort 收尾的轮不立即 drain，留到下一轮正常结束再报', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps, calls } = makeDeps({
    loadRecord: makeRecord([userMsg, assistantMsg, placeholderMessage('tc-1')]),
    onCall: (_m, i) => (i === 0 ? new Promise(() => {}) : { content: 'ok' }), // 主轮永久挂起
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  registerTask(registry, 'tc-1', 'b1', '任务一')

  const sendPromise = engine.sendMessage({ text: '用户消息' })
  await sleep(10)
  registry.markSettled('tc-1', completedOutput('结果一'))
  await engine.notifyTaskSettled('tc-1', completedOutput('结果一'))
  engine.abort()
  const result = await sendPromise
  assert.equal(result.aborted, true)
  assert.equal(calls.length, 1, 'abort 收尾不立即 drain')

  // 下一个自然触发点：下一轮正常结束 → 批次再报
  await engine.sendMessage({ text: '再问一句' })
  assert.equal(calls.length, 3)
  assert.ok(hasNotice(calls[2], '任务一'))
  engine.dispose()
})

test('drain：回流轮自身被 abort 时批次 requeue，下一个自然触发点再报', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps, calls } = makeDeps({
    loadRecord: makeRecord([userMsg, assistantMsg, placeholderMessage('tc-1')]),
    onCall: (_m, i) => (i === 0 ? new Promise(() => {}) : { content: 'ok' }), // 回流轮（首次调用）永久挂起
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  registerTask(registry, 'tc-1', 'b1', '任务一')

  registry.markSettled('tc-1', completedOutput('结果一'))
  const settlePromise = engine.notifyTaskSettled('tc-1', completedOutput('结果一'))
  await sleep(10)
  assert.equal(calls.length, 1, '回流轮已发起')
  engine.abort()
  await settlePromise

  // 批次已放回队列：下一轮正常结束再报（calls[1]=主轮，calls[2]=回流再报）
  await engine.sendMessage({ text: '再来' })
  assert.equal(calls.length, 3)
  assert.ok(hasNotice(calls[2], '任务一'))
  engine.dispose()
})

test('会话护栏：有 running 后台任务时 loadSession/startNewSession/detachSession 抛错', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps } = makeDeps({ loadRecord: makeRecord([userMsg, assistantMsg]) })
  const engine = new ChatEngine(deps)

  registerTask(registry, 'tc-1', 'b1', '任务一')
  await assert.rejects(engine.loadSession('s1'), /有 1 个后台任务进行中，请等待完成或先取消/)
  assert.throws(() => engine.startNewSession(), /有 1 个后台任务进行中/)
  assert.throws(() => engine.detachSession(), /有 1 个后台任务进行中/)

  // 全部落地后护栏放开
  registry.markSettled('tc-1', completedOutput('结果一'))
  assert.doesNotThrow(() => engine.startNewSession())
  engine.dispose()
})

test('孤儿清扫：会话加载时 RUNNING 占位标记为"已中断（进程退出）"，正常消息不受影响', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const doneMsg: Message = {
    role: TOOL,
    content: JSON.stringify({ content: '真实结果' }),
    toolCallId: 'tc-done',
    toolCallStatus: STATUS_SUCCESS,
    timestamp: T0,
  }
  const { deps, state } = makeDeps({
    loadRecord: makeRecord([
      userMsg,
      assistantMsg,
      placeholderMessage('tc-orphan'), // 注册表无记录 → 孤儿
      doneMsg,
    ]),
  })
  const engine = new ChatEngine(deps)

  const savesBefore = state.saves
  await engine.loadSession('s1')

  const orphan = engine.getHistory().find((m) => m.toolCallId === 'tc-orphan')
  assert.ok(orphan)
  assert.equal(orphan.toolCallStatus, 'failed')
  assert.ok(typeof orphan.content === 'string' && orphan.content.includes('已中断（进程退出）'))
  const done = engine.getHistory().find((m) => m.toolCallId === 'tc-done')
  assert.ok(done)
  assert.equal(done.toolCallStatus, STATUS_SUCCESS, '正常消息不受影响')
  assert.ok(state.saves > savesBefore, '清扫后落盘')
  engine.dispose()
})

test('buildTaskToolMessage：RUNNING 占位走受理分支（非失败文案）', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const { deps } = makeDeps()
  const engine = new ChatEngine(deps)
  const toolCall = {
    id: 'tc-1',
    type: 'function',
    function: { name: 'task', arguments: '{}' },
  } as any

  const running = (engine as any).buildTaskToolMessage({
    toolCall,
    taskOutput: { status: 'running' as TaskExecutionStatus, final_output: '任务已受理，后台执行中' },
  })
  assert.equal(running.toolCallStatus, STATUS_RUNNING)
  assert.ok(running.content.includes('任务已受理'))
  assert.ok(!running.content.includes('工具调用失败'), '占位不得产出失败文案')

  const failed = (engine as any).buildTaskToolMessage({
    toolCall,
    taskOutput: failedOutput('执行异常'),
  })
  assert.equal(failed.toolCallStatus, 'failed')
  assert.ok(failed.content.includes('工具调用失败'))
  engine.dispose()
})

test('通知文本：任务条目带 toolCallId（与 query_task_status 格式一致），同名任务可区分', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const { deps, calls } = makeDeps({
    loadRecord: makeRecord([
      userMsg,
      assistantMsg,
      placeholderMessage('tc-1'),
      placeholderMessage('tc-2'),
    ]),
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')

  // 两个 task_id 别名相同的任务（不同 toolCallId、不同批次）
  registry.register({
    taskId: 'same-alias',
    toolCallId: 'tc-1',
    subagentType: 'document-writer',
    description: '写文档',
    batchId: 'b1',
  })
  registry.register({
    taskId: 'same-alias',
    toolCallId: 'tc-2',
    subagentType: 'document-writer',
    description: '写文档',
    batchId: 'b2',
  })
  registry.markSettled('tc-1', completedOutput('结果一'))
  await engine.notifyTaskSettled('tc-1', completedOutput('结果一'))
  registry.markSettled('tc-2', completedOutput('结果二'))
  await engine.notifyTaskSettled('tc-2', completedOutput('结果二'))

  assert.equal(calls.length, 2)
  // 第二轮回流的消息序列含历史消息（含第一轮通知），取各自最后一轮通知（数组尾部倒查）
  const lastNotice = (msgs: Message[]) =>
    [...msgs].reverse().find(
      (m) => m.role === USER && typeof m.content === 'string' && m.content.includes('【后台任务完成通知】')
    )
  const notice1 = lastNotice(calls[0])
  const notice2 = lastNotice(calls[1])
  assert.ok(notice1 && notice2)
  assert.ok((notice1.content as string).includes('toolCallId=tc-1'))
  assert.ok((notice2.content as string).includes('toolCallId=tc-2'))
  engine.dispose()
})

test('单 task 占位（executeOneToolCall 路径）按注册表甄别标 RUNNING', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const registry = getTaskRegistry()
  const makeTaskCallDeps = () =>
    makeDeps({
      onCall: (_m, i) =>
        i === 0
          ? {
              content: '',
              toolCalls: [
                {
                  id: 'tc-1',
                  type: 'function',
                  function: {
                    name: 'task',
                    arguments:
                      '{"task_id":"t1","subagent_type":"code-reviewer","task_description":"审查","success_criteria":"完成"}',
                  },
                },
              ],
            }
          : { content: '收尾' },
      executeAsync: async () => ({
        success: true,
        data: { content: '任务已受理，后台执行中（任务标识: t1）' },
      }),
    })

  // 注册表有 running 记录（交互模式登记）→ 占位标 RUNNING
  const a = makeTaskCallDeps()
  const engineA = new ChatEngine(a.deps)
  registerTask(registry, 'tc-1', 'b1', '审查')
  await engineA.sendMessage({ text: '派活' })
  const placeholder = engineA.getHistory().find((m) => m.role === TOOL && m.toolCallId === 'tc-1')
  assert.ok(placeholder)
  assert.equal(placeholder.toolCallStatus, STATUS_RUNNING)
  engineA.dispose()

  // 注册表无记录（-p 同步语义，executeAsync 返回真实结果）→ 维持 SUCCESS
  resetTaskRegistry()
  const b = makeTaskCallDeps()
  const engineB = new ChatEngine(b.deps)
  await engineB.sendMessage({ text: '派活' })
  const real = engineB.getHistory().find((m) => m.role === TOOL && m.toolCallId === 'tc-1')
  assert.ok(real)
  assert.equal(real.toolCallStatus, STATUS_SUCCESS)
  engineB.dispose()
})
