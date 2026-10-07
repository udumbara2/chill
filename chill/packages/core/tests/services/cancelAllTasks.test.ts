import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  executeTaskToolCall,
  executeBatchTask,
  cancelAllRunningTasks,
  executeQueryTaskStatus,
  setDelegationContextProvider,
} from '../../src/services/delegation/delegationTools.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { getTaskExecutor, resetTaskExecutor } from '../../src/orchestrator/executor/TaskExecutor.ts'
import { getTemplateManager, resetTemplateManager } from '../../src/orchestrator/managers/SubagentTemplateManager.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import type { ToolCall, ModelInfo, ModelType } from '../../src/types/models.ts'
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

/** 可控 settle 的假执行器：execute 挂起直到手动 resolve；记录 destroy 的假环境经注册表绑定 */
function makeDeferredExecutor(destroyLog: string[]) {
  const gates = new Map<string, (v: Record<string, unknown>) => void>()
  const executor: ISubagentExecutor = {
    execute: async (_t, _d, _p, _s, _tools, _av, _k, _b, environmentKey) => {
      const key = environmentKey ?? 'unknown'
      // 假环境绑定（cancel 的 destroy 通道）；绑定键与 cancel_task 同键
      getTaskRegistry().bindEnvironment(key, {
        id: `env-${key}`,
        sendRequest: async () => ({ success: true }),
        destroy: async () => { destroyLog.push(key) },
      })
      return new Promise<Record<string, unknown>>((res) => gates.set(key, res))
    },
  }
  return { executor, gates }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

test('cancelAllRunningTasks: 3 个 running（含 1 个 batch 成员）全部取消，环境逐个销毁', async (t) => {
  setup(t)
  const destroyLog: string[] = []
  const { executor } = makeDeferredExecutor(destroyLog)
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-a1', 'a1'), { toolMetadata: [], toolDefinitions: [] })
  await executeTaskToolCall(makeTaskToolCall('tc-a2', 'a2'), { toolMetadata: [], toolDefinitions: [] })
  await executeBatchTask('tc-batch', { tasks: [{ subagent_type: 'test-agent', task_description: '成员任务' }] })
  await flush()
  assert.equal(getTaskRegistry().listRunning().length, 3)

  const result = await cancelAllRunningTasks()
  assert.equal(result.cancelled, 3)
  await flush()

  assert.equal(getTaskRegistry().listRunning().length, 0, '无 running 残留')
  assert.deepEqual(
    getTaskRegistry().list().map((x) => x.status),
    ['cancelled', 'cancelled', 'cancelled'],
  )
  assert.equal(destroyLog.length, 3, '每个环境都被销毁')

  // 占位写回语义与单 cancel 一致（已取消）
  const status = executeQueryTaskStatus({})
  assert.ok(status.content!.includes('已取消'))
})

test('cancelAllRunningTasks: 0 个 running → 返回 0，无副作用', async (t) => {
  setup(t)
  getTaskExecutor(secureStorage, { execute: async () => ({ status: 'completed', final_output: 'x' }) })

  const result = await cancelAllRunningTasks()
  assert.equal(result.cancelled, 0)
  assert.equal(getTaskRegistry().list().length, 0)
})

test('cancelAllRunningTasks: 已落地任务不受影响（仅 running 被取消）', async (t) => {
  setup(t)
  const destroyLog: string[] = []
  const { executor, gates } = makeDeferredExecutor(destroyLog)
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-done', 'done'), { toolMetadata: [], toolDefinitions: [] })
  await executeTaskToolCall(makeTaskToolCall('tc-run', 'run'), { toolMetadata: [], toolDefinitions: [] })
  gates.get('tc-done')!({ status: 'completed', final_output: 'done' })
  await flush()

  const result = await cancelAllRunningTasks()
  assert.equal(result.cancelled, 1)
  assert.equal(getTaskRegistry().getByToolCallId('tc-done')!.status, 'completed', '已完成任务状态不变')
  assert.equal(getTaskRegistry().getByToolCallId('tc-run')!.status, 'cancelled')
})
