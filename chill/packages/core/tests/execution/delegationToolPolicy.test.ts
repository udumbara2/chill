import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StandardSubagentExecutor } from '../../src/execution/StandardSubagentExecutor.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import { SelectedModelsService } from '../../src/services/selectedModelsService.ts'
import type { TestContext } from 'node:test'
import type { ModelInfo, ModelType, ToolDefinition } from '../../src/types/models.ts'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'
import type { SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { TemplateSubagentForkManager } from '../../src/orchestrator/isolation/TemplateSubagentForkManager.ts'
import { PLAN_MODE_BLOCKED_TOOLS } from '../../src/services/builtInTools.ts'

// ModelType/TemplatePriority 是 enum（不可经 node 类型擦除运行时导入），测试里用字面量替代
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
    getItem: k => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v) },
    removeItem: k => { m.delete(k) },
    clear: () => m.clear(),
  }
}

/** 装配模型注册表与会话模型单例；t.after 恢复原状（同 subagentModelFallback.test.ts 模式） */
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

function makeTemplate(extra: Partial<SubagentTemplate>): SubagentTemplate {
  return { name: '测试模板', subagent_type: 'test-agent', priority: BUILTIN_PRIORITY, ...extra }
}

function toolDef(name: string): ToolDefinition {
  return { type: 'function', function: { name, description: '', parameters: {} } } as ToolDefinition
}

/** StandardSubagentExecutor + 捕获 SubagentRequest 的 mock forkManager */
function makeExecutor() {
  const requests: Array<{ authorizedTools?: string[]; toolDefinitions?: unknown[] }> = []
  const forkManagerFactory = () => ({
    createEnvironment: async () => ({
      sendRequest: async (req: { authorizedTools?: string[]; toolDefinitions?: unknown[] }) => {
        requests.push(req)
        return { success: true, output: 'ok' }
      },
      destroy: async () => {},
    }),
  }) as unknown as TemplateSubagentForkManager
  return { executor: new StandardSubagentExecutor(secureStorage, forkManagerFactory), requests }
}

const ALL_TOOLS = ['read_file', 'create_file', 'execute_powershell', 'grep'].map(toolDef)

test('优先级链: Lead 显式指派 → 覆盖模板默认名单（不是交集/天花板）', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({ tools: ['read_file', 'grep'] }) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    ['read_file', 'create_file'], // Lead 指派了模板名单外的 create_file → 覆盖生效
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(requests[0]?.authorizedTools, ['read_file', 'create_file'])
})

test('优先级链: Lead 显式指派 + readonly 约束 → 约束叠加（修改性工具被剔除）', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({ readonly: true }) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    ['read_file', 'create_file', 'execute_powershell'],
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(requests[0]?.authorizedTools, ['read_file'])
})

test('优先级链: Lead 未指派 + 模板省略 tools → 零默认（空名单 + 空定义下放）', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    undefined,
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(requests[0]?.authorizedTools, [])
  assert.deepEqual(requests[0]?.toolDefinitions, [], '零工具应下发放空定义')
})

test('优先级链: Lead 未指派 + 模板 [all] + readonly → 全量剔编排再剔修改性', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({ tools: ['all'], readonly: true }) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    undefined,
  )
  assert.equal(result.status, 'completed')
  const authorized = requests[0]?.authorizedTools ?? []
  assert.ok(authorized.includes('read_file') && authorized.includes('grep'))
  for (const name of authorized) {
    assert.ok(!PLAN_MODE_BLOCKED_TOOLS.includes(name), `${name} 不应出现在 readonly 授权名单`)
  }
})

test('优先级链: 委派 ["none"] → 显式零工具（无视模板默认）', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({ tools: ['all'] }) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    ['none'],
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(requests[0]?.authorizedTools, [])
  assert.deepEqual(requests[0]?.toolDefinitions, [])
})

test('优先级链: 委派 ["none", x] 混写 → 语义矛盾响亮报错，不起 Worker', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    ['none', 'read_file'],
  )
  assert.equal(result.status, 'failed')
  assert.match((result.error_info as { message: string }).message, /语义矛盾/)
  assert.equal(requests.length, 0)
})

test('优先级链: 名单 typo → executor 层响亮报错，不起 Worker（Worker mismatchError 仅双保险）', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({ tools: ['all'] }) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    ['read_fiel'], // typo
  )
  assert.equal(result.status, 'failed')
  assert.match((result.error_info as { message: string }).message, /不存在或未在当前会话注册/)
  assert.equal(requests.length, 0)
})

test('优先级链: 模板名单 typo 同样 executor 层报错', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({ tools: ['ghost_tool'] }) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    undefined,
  )
  assert.equal(result.status, 'failed')
  assert.match((result.error_info as { message: string }).message, /ghost_tool/)
  assert.equal(requests.length, 0)
})

test('优先级链: Lead 未指派 + 模板名单 → 按名单（含约束叠加）', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({ tools: ['read_file', 'create_file'], readonly: true }) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    undefined,
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(requests[0]?.authorizedTools, ['read_file'])
})

test('优先级链: Lead 显式指派（模板省略 tools）→ 按指派原样透传', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    ['read_file', 'create_file'],
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(requests[0]?.authorizedTools, ['read_file', 'create_file'])
})

test('优先级链: Lead 显式指派 + disallowed 约束 → 扣除黑名单', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({ disallowed_tools: ['execute_powershell'] }) as unknown as Record<string, unknown>,
    '子任务', {}, 0,
    ALL_TOOLS,
    ['read_file', 'execute_powershell'],
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(requests[0]?.authorizedTools, ['read_file'])
})
