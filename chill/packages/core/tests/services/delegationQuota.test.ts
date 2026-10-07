import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  executeTaskToolCall,
  executeBatchTask,
  executeResumeTask,
  setDelegationContextProvider,
} from '../../src/services/delegation/delegationTools.ts'
import {
  checkDelegationQuota,
  setDelegationQuotaProvider,
  getDelegationQuota,
  DEFAULT_DELEGATION_MAX_CONCURRENT,
  DEFAULT_DELEGATION_MAX_CUMULATIVE,
} from '../../src/services/delegation/quota.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { getTaskExecutor, resetTaskExecutor } from '../../src/orchestrator/executor/TaskExecutor.ts'
import { getTemplateManager, resetTemplateManager } from '../../src/orchestrator/managers/SubagentTemplateManager.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import type { ToolCall, ModelInfo, ModelType } from '../../src/types/models.ts'
import type { SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { ISubagentExecutor } from '../../src/execution/ISubagentExecutor.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'

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

function setup(t: TestContext, quota?: { maxConcurrent?: number; maxCumulative?: number }): void {
  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  modelInfoService.addModelInfo(FAKE_MODEL)

  resetTaskExecutor()
  resetTaskRegistry()
  getTemplateManager().setAllTemplates([makeTemplate()])
  setDelegationQuotaProvider(quota ? () => quota : null)

  t.after(() => {
    modelInfoService.clearAllModelInfos()
    for (const m of originalModels) modelInfoService.addModelInfo(m)
    resetTaskExecutor()
    resetTaskRegistry()
    resetTemplateManager()
    setDelegationContextProvider(null)
    setDelegationQuotaProvider(null)
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

/** 可控 settle 的假执行器 */
function makeDeferredExecutor() {
  const gates = new Map<string, (v: Record<string, unknown>) => void>()
  const executor: ISubagentExecutor = {
    execute: async (_t, _d, _p, _s, _tools, _av, _k, _b, environmentKey) =>
      new Promise<Record<string, unknown>>((res) => gates.set(environmentKey ?? 'x', res)),
  }
  return { executor, gates }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

const CONVERSATION = [{ role: 'user', content: 't' }, { role: 'assistant', content: 'a' }]

// ---------- 判定纯函数 ----------

test('checkDelegationQuota: 并发超限 → 报错含出路指引；未超限 → null', () => {
  const quota = { maxConcurrent: 6, maxCumulative: 200 }
  const err = checkDelegationQuota({ running: 6, total: 10 }, quota)!
  assert.ok(err.includes('并发上限（6）'))
  assert.ok(err.includes('query_task_status'))
  assert.ok(err.includes('/limits'))
  assert.equal(checkDelegationQuota({ running: 5, total: 10 }, quota), null)
})

test('checkDelegationQuota: 累计超限 → 报错含进程内语义；incoming 计入', () => {
  const quota = { maxConcurrent: 10, maxCumulative: 200 }
  assert.equal(checkDelegationQuota({ running: 0, total: 198 }, quota, 2), null)
  const err = checkDelegationQuota({ running: 0, total: 199 }, quota, 2)!
  assert.ok(err.includes('累计上限（200）'))
  assert.ok(err.includes('含已落地'))
})

test('checkDelegationQuota: 并发优先于累计判定', () => {
  const err = checkDelegationQuota({ running: 6, total: 199 }, { maxConcurrent: 6, maxCumulative: 200 })!
  assert.ok(err.includes('并发'))
})

// ---------- 默认值与 provider ----------

test('getDelegationQuota: 未注入 provider → 默认值(6/200)', async (t) => {
  setup(t)
  const q = getDelegationQuota()
  assert.equal(q.maxConcurrent, DEFAULT_DELEGATION_MAX_CONCURRENT)
  assert.equal(q.maxCumulative, DEFAULT_DELEGATION_MAX_CUMULATIVE)
})

test('getDelegationQuota: 非法值回退默认', async (t) => {
  setup(t, { maxConcurrent: -3, maxCumulative: 0 })
  const q = getDelegationQuota()
  assert.equal(q.maxConcurrent, 6)
  assert.equal(q.maxCumulative, 200)
})

// ---------- task 入口 ----------

test('task 入口: 并发满 → QUOTA_EXCEEDED 不登记；落地一个后放行', async (t) => {
  setup(t, { maxConcurrent: 2, maxCumulative: 100 })
  const { executor, gates } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-q1', 'q1'), { toolMetadata: [], toolDefinitions: [] })
  await executeTaskToolCall(makeTaskToolCall('tc-q2', 'q2'), { toolMetadata: [], toolDefinitions: [] })
  const third = await executeTaskToolCall(makeTaskToolCall('tc-q3', 'q3'), { toolMetadata: [], toolDefinitions: [] })
  assert.equal(third.status, 'failed')
  assert.equal(third.error_info?.code, 'QUOTA_EXCEEDED')
  assert.equal(getTaskRegistry().getByToolCallId('tc-q3'), undefined, '不登记幽灵任务')

  gates.get('tc-q1')!({ status: 'completed', final_output: 'done', conversation: CONVERSATION })
  await flush()
  const fourth = await executeTaskToolCall(makeTaskToolCall('tc-q4', 'q4'), { toolMetadata: [], toolDefinitions: [] })
  assert.equal(fourth.status, 'running', '落地释放额度后放行')
})

test('task 入口: 累计满 → 拒绝；调大 provider 后放行', async (t) => {
  let cap = 2
  setup(t, { maxConcurrent: 100, maxCumulative: 2 })
  setDelegationQuotaProvider(() => ({ maxConcurrent: 100, maxCumulative: cap }))
  const { executor, gates } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-c1', 'c1'), { toolMetadata: [], toolDefinitions: [] })
  await executeTaskToolCall(makeTaskToolCall('tc-c2', 'c2'), { toolMetadata: [], toolDefinitions: [] })
  await flush()  // 等执行链推进到 executor.execute（gate 登记点）
  gates.get('tc-c1')!({ status: 'completed', final_output: 'd', conversation: CONVERSATION })
  gates.get('tc-c2')!({ status: 'completed', final_output: 'd', conversation: CONVERSATION })
  await flush()
  // running=0 但累计=2 满
  const third = await executeTaskToolCall(makeTaskToolCall('tc-c3', 'c3'), { toolMetadata: [], toolDefinitions: [] })
  assert.equal(third.error_info?.code, 'QUOTA_EXCEEDED')
  assert.ok(third.error_info?.message.includes('累计'))

  cap = 5
  const fourth = await executeTaskToolCall(makeTaskToolCall('tc-c4', 'c4'), { toolMetadata: [], toolDefinitions: [] })
  assert.equal(fourth.status, 'running', '调大累计后放行')
})

// ---------- batch 入口 ----------

test('batch 入口: 整批原子拒绝（部分容量也不半登记）', async (t) => {
  setup(t, { maxConcurrent: 2, maxCumulative: 100 })
  const { executor } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-b0', 'b0'), { toolMetadata: [], toolDefinitions: [] })
  // running=1，批 2 个 → 1+2 > 2 整批拒
  const result = await executeBatchTask('tc-batch', {
    tasks: [
      { subagent_type: 'test-agent', task_description: '成员1' },
      { subagent_type: 'test-agent', task_description: '成员2' },
    ],
  })
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('并发'))
  assert.equal(getTaskRegistry().listRunning().length, 1, '无成员被半登记')
})

test('batch 入口: 批量计入累计（批 3 个 + 已有 198 → 整批拒）', async (t) => {
  setup(t, { maxConcurrent: 100, maxCumulative: 200 })
  const registry = getTaskRegistry()
  for (let i = 0; i < 198; i++) {
    registry.register({ taskId: `h${i}`, toolCallId: `th${i}`, subagentType: 'a', description: 'd', batchId: 'hb' })
    registry.markSettled(`th${i}`, { status: 'completed' as never, final_output: 'x' })
  }
  const { executor } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)

  const result = await executeBatchTask('tc-batch-cum', {
    tasks: [
      { subagent_type: 'test-agent', task_description: 'm1' },
      { subagent_type: 'test-agent', task_description: 'm2' },
      { subagent_type: 'test-agent', task_description: 'm3' },
    ],
  })
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('累计'))
})

// ---------- resume 入口 ----------

test('resume 入口: 并发满 → 拒绝追问', async (t) => {
  setup(t, { maxConcurrent: 1, maxCumulative: 100 })
  const { executor } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)

  // 先做成一个可追问的已完成任务（把并发让出来前的准备）
  const { executor: doneExecutor } = (() => {
    const e: ISubagentExecutor = {
      execute: async () => ({ status: 'completed', final_output: '初版', conversation: CONVERSATION }),
    }
    return { executor: e }
  })()
  resetTaskExecutor()
  getTaskExecutor(secureStorage, doneExecutor)
  await executeTaskToolCall(makeTaskToolCall('tc-r0', 'r0'), { toolMetadata: [], toolDefinitions: [] })
  await flush()
  assert.ok(getTaskRegistry().getTranscript('tc-r0'))

  // 占满并发（另一个任务在跑），追问应被拒
  resetTaskExecutor()
  const { executor: deferred } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, deferred)
  await executeTaskToolCall(makeTaskToolCall('tc-occupy', 'occupy'), { toolMetadata: [], toolDefinitions: [] })

  const result = await executeResumeTask('tc-r0-f', { toolCallId: 'tc-r0', message: '改' })
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('并发'), '追问被并发闸门拒绝')
})
