import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { StandardSubagentExecutor } from '../../src/execution/StandardSubagentExecutor.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import { SelectedModelsService } from '../../src/services/selectedModelsService.ts'
import { PLAN_MODE_BLOCKED_TOOLS } from '../../src/services/builtInTools.ts'
import type { ModelInfo, ModelType, ToolDefinition } from '../../src/types/models.ts'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'
import type { SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { TemplateSubagentForkManager } from '../../src/orchestrator/isolation/TemplateSubagentForkManager.ts'

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

function toolDef(name: string): ToolDefinition {
  return { type: 'function', function: { name, description: '', parameters: {} } } as ToolDefinition
}
const ALL_TOOLS = ['read_file', 'create_file', 'execute_powershell', 'grep'].map(toolDef)

interface CapturedRequest {
  authorizedTools?: string[]
  toolDefinitions?: unknown[]
  userMessage?: string
}

function makeExecutor() {
  const requests: CapturedRequest[] = []
  const forkManagerFactory = () => ({
    createEnvironment: async () => ({
      sendRequest: async (req: CapturedRequest) => {
        requests.push(req)
        return { success: true, output: '计划:第一步分析,第二步产出。' }
      },
      destroy: async () => {},
    }),
  }) as unknown as TemplateSubagentForkManager
  return { executor: new StandardSubagentExecutor(secureStorage, forkManagerFactory), requests }
}

function makeTemplate(extra: Partial<SubagentTemplate>): SubagentTemplate {
  return { name: '测试模板', subagent_type: 'test-agent', priority: BUILTIN_PRIORITY, ...extra }
}

test('requirePlan: 阶段 1 强制剔修改性工具(即使 Lead 指派了),只读工具保留', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '写一份报告', {}, 0,
    ALL_TOOLS,
    ['read_file', 'create_file', 'execute_powershell'],
    undefined, undefined, undefined,
    { requirePlan: true },
  )
  assert.equal(result.status, 'completed')
  const authorized = requests[0]?.authorizedTools ?? []
  assert.deepEqual(authorized, ['read_file'])
  for (const name of authorized) {
    assert.ok(!PLAN_MODE_BLOCKED_TOOLS.includes(name), `${name} 不应出现在阶段 1 授权名单`)
  }
})

test('requirePlan: 规划指令注入 userMessage;输出带【待批准的计划】前缀与 approve_plan CTA', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '写一份报告', {}, 0,
    ALL_TOOLS,
    ['read_file'],
    undefined, undefined, undefined,
    { requirePlan: true },
  )
  assert.equal(result.status, 'completed')
  assert.match(requests[0]?.userMessage ?? '', /【只读规划阶段】/)
  assert.match(requests[0]?.userMessage ?? '', /完整计划作为最终回复交付/)
  assert.match(result.final_output as string, /^【待批准的计划】/)
  assert.match(result.final_output as string, /approve_plan\(task_id, approved, feedback\?\)/)
})

test('requirePlan 缺省: 输出无前缀、工具不剔(向后兼容)', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '写一份报告', {}, 0,
    ALL_TOOLS,
    ['read_file', 'create_file'],
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(requests[0]?.authorizedTools, ['read_file', 'create_file'])
  assert.ok(!(result.final_output as string).startsWith('【待批准的计划】'))
})
