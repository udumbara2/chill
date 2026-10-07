import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  executeTaskToolCall,
  executeQueryTaskStatus,
  executeCancelTask,
  executeBatchTask,
  setDelegationContextProvider,
  setTaskEnvironmentDestroyer,
  type DelegationContext,
} from '../../src/services/delegation/delegationTools.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { getTaskExecutor, resetTaskExecutor } from '../../src/orchestrator/executor/TaskExecutor.ts'
import { getTemplateManager, resetTemplateManager } from '../../src/orchestrator/managers/SubagentTemplateManager.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import type { ToolCall, ModelInfo, ModelType } from '../../src/types/models.ts'
import type { TaskToolOutput, SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { ISubagentExecutor } from '../../src/execution/ISubagentExecutor.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'
import type { IsolatedEnvironment } from '../../src/orchestrator/isolation/types.ts'

// ModelType/TemplatePriority 是 enum（不可经 node 类型擦除运行时导入），测试里用字符串字面量替代
const GLM = 'glm' as ModelType
const BUILTIN_PRIORITY = 3 as TemplatePriority

const FAKE_MODEL = {
  type: GLM,
  name: 'fake-model',
  displayName: 'fake-model',
  provider: 'TestProvider',
  builtIn: false,
  description: '测试模型',
  adapterConfig: { protocol: 'openai-chat', baseURL: 'https://api.test/fake', defaultModel: 'fake-model' },
  supportedModalities: [],
  availableModels: ['fake-model'],
  supportedParameters: [],
  maxOutputTokens: 4000,
  maxContextTokens: 8000,
  supportsStreaming: false,
  supportsTools: false,
  supportsThinking: false,
  version: '1',
  documentation: '',
} as ModelInfo

const secureStorage = { getApiKey: async () => 'fake-key' } as unknown as ISecureStorage

function makeTemplate(): SubagentTemplate {
  return { name: '测试模板', subagent_type: 'test-agent', priority: BUILTIN_PRIORITY, model: FAKE_MODEL.name }
}

/** 装配全局单例（模型注册表 / 模板管理器 / 两个待测单例复位）；t.after 恢复原状 */
function setup(t: TestContext): void {
  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  modelInfoService.addModelInfo(FAKE_MODEL)

  resetTaskExecutor()
  resetTaskRegistry()
  getTemplateManager().setAllTemplates([makeTemplate()])

  t.after(() => {
    modelInfoService.clearAllModelInfos()
    for (const m of originalModels) modelInfoService.addModelInfo(m)
    resetTaskExecutor()
    resetTaskRegistry()
    resetTemplateManager()
    setDelegationContextProvider(null)
    setTaskEnvironmentDestroyer(null)
  })
}

function makeTaskToolCall(id: string, taskId: string): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'task',
      arguments: JSON.stringify({
        task_id: taskId,
        subagent_type: 'test-agent',
        task_description: '测试任务',
        success_criteria: '完成',
      }),
    },
  }
}

/** 可控 settle 的假执行器：execute 挂起直到手动 resolve */
function makeDeferredExecutor() {
  let settle!: (v: Record<string, unknown>) => void
  const gate = new Promise<Record<string, unknown>>((res) => {
    settle = res
  })
  const executor: ISubagentExecutor = { execute: async () => gate }
  return { executor, settle }
}

/** 等后台 settle 回调链（.then 序列）跑完 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

/** 最小构造 BuiltInToolExecutor（任务管理 case 不触达四个依赖） */
function makeBuiltInExecutor(): BuiltInToolExecutor {
  return new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
}

test('environmentKey 透传: 执行器收到 toolCall.id 作环境绑定键（cancel 关联的前提）', async (t) => {
  setup(t)
  let receivedKey: string | undefined
  const executor: ISubagentExecutor = {
    execute: async (_template, _desc, _params, _start, _tools, _available, _apiKey, _baseURL, environmentKey) => {
      receivedKey = environmentKey
      return { status: 'completed', final_output: 'done' }
    },
  }
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-key', 'k'), { toolMetadata: [], toolDefinitions: [] })
  await flush()
  assert.equal(receivedKey, 'tc-key')
})

test('query_task_status: 空参列全部；按键单查；不存在报错；完成后含结果摘要', async (t) => {
  setup(t)
  const { executor, settle } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)
  await executeTaskToolCall(makeTaskToolCall('tc-q1', 'alias-q1'), { toolMetadata: [], toolDefinitions: [] })

  // 空参列出全部
  const all = executeQueryTaskStatus({})
  assert.equal(all.success, true)
  assert.ok(all.content!.includes('test-agent'))
  assert.ok(all.content!.includes('进行中'))

  // 按 toolCallId / task_id 单查（两个键都接受）
  assert.ok(executeQueryTaskStatus({ toolCallId: 'tc-q1' }).content!.includes('alias-q1'))
  assert.ok(executeQueryTaskStatus({ task_id: 'alias-q1' }).content!.includes('tc-q1'))

  // 不存在 → 明确错误
  const missing = executeQueryTaskStatus({ task_id: 'nope' })
  assert.equal(missing.success, false)
  assert.ok(missing.error!.includes('未找到任务'))

  // settle 后含结果摘要
  settle({ status: 'completed', final_output: '审查完成，发现 3 个问题' })
  await flush()
  const done = executeQueryTaskStatus({ toolCallId: 'tc-q1' })
  assert.ok(done.content!.includes('已完成'))
  assert.ok(done.content!.includes('结果摘要'))
  assert.ok(done.content!.includes('审查完成'))
})

test('query_task_status: 长结果被截断时，摘要尾巴明示全文去向（防绕路翻存档）', async (t) => {
  setup(t)
  const { executor, settle } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)
  await executeTaskToolCall(makeTaskToolCall('tc-q2', 'alias-q2'), { toolMetadata: [], toolDefinitions: [] })

  // 超长结果（>200 字符）→ 截断 + 去向提示；短结果 → 原样无提示
  settle({ status: 'completed', final_output: '长报告'.repeat(100) })
  await flush()
  const done = executeQueryTaskStatus({ toolCallId: 'tc-q2' })
  assert.ok(done.content!.includes('摘要已截断'), '截断应有明示')
  assert.ok(done.content!.includes('完整结果已写回委派时的工具消息'), '截断应指明全文去向')
  assert.ok(!done.content!.includes('长报告'.repeat(67)), '全文不应完整出现在摘要里（截断上限 200 字符）')
})

test('cancel_task: 标记取消 + Worker 环境销毁（环境映射路径）+ 占位写回"已取消"；不单独入待汇报', async (t) => {
  setup(t)
  const { executor } = makeDeferredExecutor() // 不 settle，保持 running
  getTaskExecutor(secureStorage, executor)
  const notified: Array<{ toolCallId: string; output: TaskToolOutput }> = []
  const ctx: DelegationContext = {
    toolMetadata: [],
    toolDefinitions: [],
    notifyTaskSettled: (id, output) => notified.push({ toolCallId: id, output }),
  }
  setDelegationContextProvider(() => ctx)

  await executeTaskToolCall(makeTaskToolCall('tc-c1', 'alias-c1'), ctx)

  // 模拟 StandardSubagentExecutor 的环境绑定（键 = 透传的 toolCallId）
  let destroyed = false
  const fakeEnv = { destroy: async () => { destroyed = true } } as unknown as IsolatedEnvironment
  getTaskRegistry().bindEnvironment('tc-c1', fakeEnv)

  const result = await executeCancelTask({ task_id: 'alias-c1' })
  assert.equal(result.success, true)
  assert.ok(result.content!.includes('已取消'))
  assert.equal(destroyed, true) // Worker 环境被销毁
  assert.equal(getTaskRegistry().getEnvironment('tc-c1'), undefined) // 绑定已清
  assert.equal(getTaskRegistry().getByToolCallId('tc-c1')!.status, 'cancelled')

  // 占位写回经 notifyTaskSettled 通道：内容"已取消" + CANCELLED
  assert.equal(notified.length, 1)
  assert.equal(notified[0].toolCallId, 'tc-c1')
  assert.equal(notified[0].output.error_info?.code, 'CANCELLED')

  // 主动取消不单独进待汇报（单任务批次全取消 → 不入队）
  assert.deepEqual(getTaskRegistry().drainPendingReports(), [])

  // 已落地任务重复取消 → 明确错误
  const again = await executeCancelTask({ toolCallId: 'tc-c1' })
  assert.equal(again.success, false)
  assert.ok(again.error!.includes('无法取消'))
})

test('cancel_task: 缺参与不存在任务返回明确错误；destroyer 通道（UI 跨进程）兜底', async (t) => {
  setup(t)
  const { executor } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)

  // 缺参
  const noArgs = await executeCancelTask({})
  assert.equal(noArgs.success, false)
  assert.ok(noArgs.error!.includes('task_id 或 toolCallId'))

  // 不存在
  const missing = await executeCancelTask({ task_id: 'ghost' })
  assert.equal(missing.success, false)
  assert.ok(missing.error!.includes('未找到任务'))

  // 无本地环境绑定时走注入的 destroyer 通道（渲染进程 → 主进程 IPC 场景）
  await executeTaskToolCall(makeTaskToolCall('tc-c2', 'alias-c2'), { toolMetadata: [], toolDefinitions: [] })
  let destroyerKey: string | undefined
  setTaskEnvironmentDestroyer(async (key) => {
    destroyerKey = key
    return true
  })
  const r = await executeCancelTask({ toolCallId: 'tc-c2' })
  assert.equal(r.success, true)
  assert.equal(destroyerKey, 'tc-c2')
  assert.equal(getTaskRegistry().getByToolCallId('tc-c2')!.status, 'cancelled')
})

test('batch_task: 参数校验（空数组 / 缺必填字段）', async (t) => {
  setup(t)
  const empty = await executeBatchTask('bt-x', { tasks: [] })
  assert.equal(empty.success, false)
  assert.ok(empty.error!.includes('非空数组'))

  const missing = await executeBatchTask('bt-x', { tasks: [{ task_description: '无类型' }] })
  assert.equal(missing.success, false)
  assert.ok(missing.error!.includes('subagent_type'))
})

test('batch_task: 批量受理（共享批次 + 一条占位），成员 settle 进度式重写，齐后终态汇总', async (t) => {
  setup(t)
  const gates: Array<(v: Record<string, unknown>) => void> = []
  const executor: ISubagentExecutor = {
    execute: async () => new Promise<Record<string, unknown>>((res) => gates.push(res)),
  }
  getTaskExecutor(secureStorage, executor)
  const notified: Array<{ toolCallId: string; output: TaskToolOutput }> = []
  const ctx: DelegationContext = {
    toolMetadata: [],
    toolDefinitions: [],
    notifyTaskSettled: (id, output) => notified.push({ toolCallId: id, output }),
  }
  setDelegationContextProvider(() => ctx)

  const accepted = await executeBatchTask('bt-1', {
    tasks: [
      { subagent_type: 'test-agent', task_description: '任务甲' },
      { subagent_type: 'test-agent', task_description: '任务乙' },
    ],
  })
  assert.equal(accepted.success, true)
  assert.ok(accepted.content!.includes('2 个任务'))

  // N 条登记：共享 batchId，成员记录批次占位根 id
  const registry = getTaskRegistry()
  const m0 = registry.getByToolCallId('bt-1#0')!
  const m1 = registry.getByToolCallId('bt-1#1')!
  assert.equal(m0.status, 'running')
  assert.equal(m0.batchId, m1.batchId)
  assert.equal(m0.batchRootToolCallId, 'bt-1')
  assert.equal(m1.batchRootToolCallId, 'bt-1')

  await flush()
  assert.equal(gates.length, 2)

  // 成员甲 settle → 批次占位进度式重写（RUNNING 1/2）
  const longReport = `甲报告全文:${'详'.repeat(500)}` // 远超 200 字——终态须完整回传（结果保真，平台不截断）
  gates[0]({ status: 'completed', final_output: longReport })
  await flush()
  const progress = notified.find((n) => n.toolCallId === 'bt-1')!
  assert.ok(progress)
  assert.equal(progress.output.status, 'running')
  assert.ok(progress.output.final_output.includes('1/2'))

  // 成员乙 settle → 齐后终态汇总（COMPLETED，含各成员完整结果）
  gates[1]({ status: 'completed', final_output: '乙结果' })
  await flush()
  const final = notified.filter((n) => n.toolCallId === 'bt-1').at(-1)!
  assert.equal(final.output.status, 'completed')
  assert.ok(final.output.final_output.includes(longReport), '成员完整报告不被截断')
  assert.ok(final.output.final_output.includes('乙结果'))

  // 齐后整批入待汇报
  const drained = registry.drainPendingReports()
  assert.equal(drained.length, 1)
  assert.equal(drained[0].length, 2)
})

test('batch_task 成员取消: 标记 cancelled + 批次占位更新；批次齐否把取消算落地', async (t) => {
  setup(t)
  const gates: Array<(v: Record<string, unknown>) => void> = []
  const executor: ISubagentExecutor = {
    execute: async () => new Promise<Record<string, unknown>>((res) => gates.push(res)),
  }
  getTaskExecutor(secureStorage, executor)
  const notified: Array<{ toolCallId: string; output: TaskToolOutput }> = []
  const ctx: DelegationContext = {
    toolMetadata: [],
    toolDefinitions: [],
    notifyTaskSettled: (id, output) => notified.push({ toolCallId: id, output }),
  }
  setDelegationContextProvider(() => ctx)

  await executeBatchTask('bt-c', {
    tasks: [
      { subagent_type: 'test-agent', task_description: '甲' },
      { subagent_type: 'test-agent', task_description: '乙' },
    ],
  })
  await flush()
  assert.equal(gates.length, 2)

  // 取消成员甲 → 成员标记 cancelled，批次占位更新（含"已取消"）
  const cancel = await executeCancelTask({ toolCallId: 'bt-c#0' })
  assert.equal(cancel.success, true)
  assert.equal(getTaskRegistry().getByToolCallId('bt-c#0')!.status, 'cancelled')
  const progress = notified.filter((n) => n.toolCallId === 'bt-c').at(-1)!
  assert.ok(progress.output.final_output.includes('已取消'))
  // 批次未齐（乙仍 running）→ 不入待汇报
  assert.deepEqual(getTaskRegistry().drainPendingReports(), [])

  // 成员乙 settle → 批次齐（取消算落地），整批入待汇报（有一个非取消落地任务）
  gates[1]({ status: 'completed', final_output: '乙结果' })
  await flush()
  const drained = getTaskRegistry().drainPendingReports()
  assert.equal(drained.length, 1)
  assert.equal(drained[0].length, 2)
})

test('batch_task: -p 特判（sync）各任务同步并行执行，禁止登记后台任务', async (t) => {
  setup(t)
  const executor: ISubagentExecutor = {
    execute: async () => ({ status: 'completed', final_output: 'done' }),
  }
  getTaskExecutor(secureStorage, executor)

  const result = await executeBatchTask('bt-p', {
    tasks: [
      { subagent_type: 'test-agent', task_description: '甲' },
      { subagent_type: 'test-agent', task_description: '乙' },
    ],
  }, { sync: true })
  assert.equal(result.success, true)
  assert.ok(result.content!.includes('同步执行完成'))
  assert.equal(getTaskRegistry().list().length, 0) // 未登记
})

test('-p（auto 档）: executeAsync(batch_task) 走同步路径，返回真实汇总', async (t) => {
  setup(t)
  const executor: ISubagentExecutor = {
    execute: async () => ({ status: 'completed', final_output: 'done' }),
  }
  getTaskExecutor(secureStorage, executor)

  const builtIn = makeBuiltInExecutor()
  builtIn.setNonInteractiveMode('auto')
  const result = await builtIn.executeAsync(
    'batch_task',
    JSON.stringify({ tasks: [{ subagent_type: 'test-agent', task_description: '甲' }] }),
    'bt-ni'
  )
  assert.equal(result.success, true)
  assert.ok(result.data.content.includes('同步执行完成'))
  assert.equal(getTaskRegistry().list().length, 0)
})

test('门归属: plan 豁免 batch_task（登记 + 批次占位），-p readonly 拦截；放行 query_task_status / cancel_task', async (t) => {
  setup(t)
  getTaskExecutor(secureStorage, { execute: async () => ({}) })
  const batchArgs = JSON.stringify({ tasks: [{ subagent_type: 'test-agent', task_description: '甲' }] })

  // plan 模式：batch_task 豁免（Subagent 工具集由引擎过滤为只读）——正常登记 + 返回批次占位
  const planExec = makeBuiltInExecutor()
  planExec.setPlanMode(true)
  const accepted = await planExec.executeAsync('batch_task', batchArgs, 'bt-plan')
  assert.equal(accepted.success, true)
  assert.ok(accepted.data.content.includes('批量任务已受理'))
  assert.equal(getTaskRegistry().list().length, 1, '成员已登记（派生 id）')
  assert.ok(getTaskRegistry().getByToolCallId('bt-plan#0'))

  // plan 下 query/cancel 放行（不被门拦截）
  const query = await planExec.executeAsync('query_task_status', '{}', 'q-1')
  assert.equal(query.success, true)
  const cancel = await planExec.executeAsync('cancel_task', JSON.stringify({ task_id: 'ghost' }), 'c-1')
  assert.equal(cancel.success, false)
  assert.ok(cancel.error!.includes('未找到任务')) // 业务错误而非门拦截

  // -p readonly：batch_task 被拦
  const roExec = makeBuiltInExecutor()
  roExec.setNonInteractiveMode('readonly')
  const roBlocked = await roExec.executeAsync('batch_task', batchArgs, 'bt-ro')
  assert.equal(roBlocked.success, false)
  assert.ok(roBlocked.error!.includes('非交互只读模式'))
  assert.equal(getTaskRegistry().list().length, 1, 'readonly 拦截后不新增登记')
})
