import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  executeTaskToolCall,
  executeTaskToolCalls,
  type DelegationContext,
} from '../../src/services/delegation/delegationTools.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { getTaskExecutor, resetTaskExecutor } from '../../src/orchestrator/executor/TaskExecutor.ts'
import { getTemplateManager, resetTemplateManager } from '../../src/orchestrator/managers/SubagentTemplateManager.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import type { ToolCall } from '../../src/types/models.ts'
import type { ModelInfo, ModelType } from '../../src/types/models.ts'
import type { TaskToolOutput } from '../../src/orchestrator/types.ts'
import type { SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { ISubagentExecutor } from '../../src/execution/ISubagentExecutor.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'

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

const TASK_ARGS = JSON.stringify({
  task_id: 'alias-x',
  subagent_type: 'test-agent',
  task_description: '测试任务',
  success_criteria: '完成',
})

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

test('占位语义: 登记后立即返回占位，settle 后注册表终态且 notifyTaskSettled 被调', async (t) => {
  setup(t)
  const { executor, settle } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)

  const notified: Array<{ toolCallId: string; output: TaskToolOutput }> = []
  const ctx: DelegationContext = {
    toolMetadata: [],
    toolDefinitions: [],
    notifyTaskSettled: (toolCallId, output) => notified.push({ toolCallId, output }),
  }

  const placeholder = await executeTaskToolCall(makeTaskToolCall('tc-1', 'alias-1'), ctx)
  // 占位仍走 TaskToolOutput 形态：status=RUNNING，文案含受理说明
  assert.equal(placeholder.status, 'running')
  assert.ok(placeholder.final_output.includes('已受理，后台执行中'))
  assert.ok(placeholder.final_output.includes('届时请整合结果答复用户'))

  // 已登记（执行未 settle，状态 running）
  const registry = getTaskRegistry()
  const entry = registry.getByToolCallId('tc-1')!
  assert.ok(entry)
  assert.equal(entry.status, 'running')
  assert.equal(entry.taskId, 'alias-1')
  assert.equal(entry.subagentType, 'test-agent')
  assert.equal(notified.length, 0)

  // settle：注册表落终态 + 回调被调
  settle({ status: 'completed', final_output: 'done' })
  await flush()
  assert.equal(registry.getByToolCallId('tc-1')!.status, 'completed')
  assert.equal(notified.length, 1)
  assert.equal(notified[0].toolCallId, 'tc-1')
  assert.equal(notified[0].output.final_output, 'done')
})

test('同轮多 task: 共享 batchId 登记，未齐不报、齐后整批入待汇报', async (t) => {
  setup(t)
  const gates: Array<(v: Record<string, unknown>) => void> = []
  const executor: ISubagentExecutor = {
    execute: async () => new Promise<Record<string, unknown>>((res) => gates.push(res)),
  }
  getTaskExecutor(secureStorage, executor)

  const ctx: DelegationContext = { toolMetadata: [], toolDefinitions: [] }
  const results = await executeTaskToolCalls(
    [makeTaskToolCall('tc-a', 'a'), makeTaskToolCall('tc-b', 'b')],
    ctx,
  )
  assert.equal(results.length, 2)
  assert.ok(results.every((r) => r.taskOutput.status === 'running'))

  const registry = getTaskRegistry()
  const a = registry.getByToolCallId('tc-a')!
  const b = registry.getByToolCallId('tc-b')!
  assert.equal(a.batchId, b.batchId) // 同轮共享一个 batchId

  await flush() // 等两个执行都抵达假执行器（登记到 execute 之间隔着数层 await）
  assert.equal(gates.length, 2)

  gates[0]({ status: 'completed', final_output: 'A' })
  await flush()
  assert.deepEqual(registry.drainPendingReports(), []) // 未齐不报

  gates[1]({ status: 'completed', final_output: 'B' })
  await flush()
  const drained = registry.drainPendingReports() // 齐后整批入队
  assert.equal(drained.length, 1)
  assert.equal(drained[0].length, 2)
})

test('sync 选项（-p 特判路径）: 不登记、不回调，await 真实执行结果', async (t) => {
  setup(t)
  const executor: ISubagentExecutor = {
    execute: async () => ({ status: 'completed', final_output: 'done' }),
  }
  getTaskExecutor(secureStorage, executor)

  let notifyCount = 0
  const ctx: DelegationContext = {
    toolMetadata: [],
    toolDefinitions: [],
    notifyTaskSettled: () => {
      notifyCount++
    },
  }
  const output = await executeTaskToolCall(makeTaskToolCall('tc-p', 'p'), ctx, undefined, { sync: true })
  assert.equal(output.status, 'completed')
  assert.equal(output.final_output, 'done')
  assert.equal(getTaskRegistry().getByToolCallId('tc-p'), undefined)
  await flush()
  assert.equal(notifyCount, 0)
})

/** 最小构造 BuiltInToolExecutor（case 'task' 不触达四个依赖） */
function makeBuiltInExecutor(): BuiltInToolExecutor {
  return new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
}

test('-p 特判: nonInteractiveMode 下 executeAsync(task) 走同步路径，不登记后台任务', async (t) => {
  setup(t)
  const executor: ISubagentExecutor = {
    execute: async () => ({ status: 'completed', final_output: 'done' }),
  }
  getTaskExecutor(secureStorage, executor)

  const builtIn = makeBuiltInExecutor()
  builtIn.setNonInteractiveMode('auto')
  const result = await builtIn.executeAsync('task', TASK_ARGS, 'tc-ni')
  assert.equal(result.success, true)
  assert.equal(result.data.content, 'done') // 同步真实结果
  assert.equal(getTaskRegistry().getByToolCallId('tc-ni'), undefined)
})

test('交互模式: executeAsync(task) 返回受理占位并登记', async (t) => {
  setup(t)
  const { executor } = makeDeferredExecutor() // 不 settle，保持 running
  getTaskExecutor(secureStorage, executor)

  const builtIn = makeBuiltInExecutor()
  const result = await builtIn.executeAsync('task', TASK_ARGS, 'tc-i')
  assert.equal(result.success, true) // 占位是受理回执而非失败
  assert.ok(result.data.content.includes('已受理，后台执行中'))
  assert.equal(getTaskRegistry().getByToolCallId('tc-i')!.status, 'running')
})

test('plan 模式: task 豁免放行（Subagent 工具集由引擎过滤为只读）——正常登记注册表并返回受理占位', async (t) => {
  setup(t)
  getTaskExecutor(secureStorage, { execute: async () => ({}) })

  const builtIn = makeBuiltInExecutor()
  builtIn.setPlanMode(true)
  const result = await builtIn.executeAsync('task', TASK_ARGS, 'tc-plan')
  assert.equal(result.success, true)
  assert.ok(result.data.content.includes('已受理，后台执行中'))
  assert.equal(getTaskRegistry().getByToolCallId('tc-plan')!.status, 'running')
})

test('-p readonly: task 被非交互只读门拦截，占位逻辑不执行', async (t) => {
  setup(t)
  getTaskExecutor(secureStorage, { execute: async () => ({}) })

  const builtIn = makeBuiltInExecutor()
  builtIn.setNonInteractiveMode('readonly')
  const result = await builtIn.executeAsync('task', TASK_ARGS, 'tc-ro')
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('非交互只读模式'))
  assert.equal(getTaskRegistry().list().length, 0)
})
