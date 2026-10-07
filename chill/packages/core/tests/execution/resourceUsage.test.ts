import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { StandardSubagentExecutor } from '../../src/execution/StandardSubagentExecutor.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import { SelectedModelsService } from '../../src/services/selectedModelsService.ts'
import type { ModelInfo, ModelType } from '../../src/types/models.ts'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'
import type { SubagentTemplate, TaskToolOutput, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { TemplateSubagentForkManager } from '../../src/orchestrator/isolation/TemplateSubagentForkManager.ts'
import type { SubagentResponse } from '../../src/orchestrator/isolation/types.ts'

const GLM = 'glm' as ModelType
const BUILTIN_PRIORITY = 3 as TemplatePriority

const FAKE = {
  type: GLM,
  name: 'fake-model',
  displayName: 'fake-model',
  provider: 'TestProvider',
  builtIn: false,
  description: '测试模型',
  adapterConfig: { protocol: 'openai-chat', baseURL: 'https://api.test/fake', defaultModel: 'fake-model' },
  supportedModalities: [],
  apiURL: '',
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

function memStore(): IKeyValueStore {
  const m = new Map<string, string>()
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => { m.set(k, v) },
    delete: async (k: string) => { m.delete(k) },
    getAll: async () => Object.fromEntries(m),
  } as unknown as IKeyValueStore
}

function setup(t: TestContext): void {
  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  modelInfoService.addModelInfo(FAKE)
  const sessionService = SelectedModelsService.getInstance()
  const originalStore = (sessionService as any)._store
  SelectedModelsService.setDefaultStore(memStore())
  t.after(() => {
    modelInfoService.clearAllModelInfos()
    for (const m of originalModels) modelInfoService.addModelInfo(m)
    ;(sessionService as any)._store = originalStore
  })
}

const secureStorage = { getApiKey: async () => 'fake-key' } as unknown as ISecureStorage

function makeExecutor(workerResponse: SubagentResponse) {
  const forkManagerFactory = () => ({
    createEnvironment: async () => ({
      sendRequest: async () => workerResponse,
      destroy: async () => {},
    }),
  }) as unknown as TemplateSubagentForkManager
  return new StandardSubagentExecutor(secureStorage, forkManagerFactory)
}

const template = { name: '测试模板', subagent_type: 'test-agent', priority: BUILTIN_PRIORITY } as SubagentTemplate

test('成功返回带 resource_usage:实测 token 入账(断点修复:此前成功路径丢弃计量数据)', async (t) => {
  setup(t)
  const executor = makeExecutor({
    success: true,
    output: '完成',
    iterations: 3,
    tokenUsage: { input: 100, output: 50, total: 150 },
  })
  const result = (await executor.execute(
    template as unknown as Record<string, unknown>, '任务', {}, Date.now(),
  )) as unknown as TaskToolOutput
  assert.equal(result.status, 'completed')
  assert.equal(result.resource_usage!.tokens_used, 150)
  assert.equal(result.resource_usage!.tokens_estimated, undefined)
  assert.equal(result.resource_usage!.iterations, 3)
  assert.ok(typeof result.resource_usage!.execution_time === 'number' && result.resource_usage!.execution_time! >= 0)
})

test('成功返回带 resource_usage:估值标记透传(tokens_estimated)', async (t) => {
  setup(t)
  const executor = makeExecutor({
    success: true,
    output: '完成',
    iterations: 1,
    tokenUsage: { input: 30, output: 15, total: 45, estimated: true },
  })
  const result = (await executor.execute(
    template as unknown as Record<string, unknown>, '任务', {}, Date.now(),
  )) as unknown as TaskToolOutput
  assert.equal(result.resource_usage!.tokens_used, 45)
  assert.equal(result.resource_usage!.tokens_estimated, true)
})

test('成功但 Worker 无计量数据(asyncTask):tokens_used 缺省,不入账语义保持', async (t) => {
  setup(t)
  const executor = makeExecutor({ success: true, output: '完成' })
  const result = (await executor.execute(
    template as unknown as Record<string, unknown>, '任务', {}, Date.now(),
  )) as unknown as TaskToolOutput
  assert.equal(result.status, 'completed')
  assert.equal(result.resource_usage!.tokens_used, undefined)
})

test('失败返回不带 resource_usage(无入账语义)', async (t) => {
  setup(t)
  const executor = makeExecutor({ success: false, error: '模型调用失败' })
  const result = (await executor.execute(
    template as unknown as Record<string, unknown>, '任务', {}, Date.now(),
  )) as unknown as TaskToolOutput
  assert.equal(result.status, 'failed')
  assert.equal(result.resource_usage, undefined)
})
