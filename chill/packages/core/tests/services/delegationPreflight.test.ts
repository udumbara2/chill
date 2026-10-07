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
import {
  LocalSubagentAdapter,
  resolveSubagentModelConfig,
} from '../../src/orchestrator/executor/LocalSubagentAdapter.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { ToolCall } from '../../src/types/models.ts'
import type { ModelInfo, ModelType } from '../../src/types/models.ts'
import type { SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { ISubagentExecutor } from '../../src/execution/ISubagentExecutor.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'

// ModelType/TemplatePriority 是 enum（不可经 node 类型擦除运行时导入），测试里用字符串字面量替代
const GLM = 'glm' as ModelType
const BUILTIN_PRIORITY = 3 as TemplatePriority

/** 正常模型（有 baseURL） */
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

/** 缺 baseURL 的模型（adapterConfig.baseURL 为空） */
const NO_URL_MODEL = {
  ...FAKE_MODEL,
  name: 'no-url-model',
  displayName: 'no-url-model',
  adapterConfig: { protocol: 'openai-chat', baseURL: '', defaultModel: 'no-url-model' },
} as ModelInfo

function makeSecureStorage(apiKey: string): ISecureStorage {
  return { getApiKey: async () => apiKey } as unknown as ISecureStorage
}

function makeTemplate(subagentType: string, model?: string): SubagentTemplate {
  return { name: '测试模板', subagent_type: subagentType, priority: BUILTIN_PRIORITY, model }
}

interface SetupOptions {
  /** 注册到模型注册表的模型（缺省仅 FAKE_MODEL） */
  models?: ModelInfo[]
  /** 注册到模板管理器的模板（缺省 test-agent → FAKE_MODEL） */
  templates?: SubagentTemplate[]
  /** secureStorage 返回的 API Key（缺省 'fake-key'；传 '' 模拟缺 key） */
  apiKey?: string
}

/** 装配全局单例（模型注册表 / 模板管理器 / 两个待测单例复位）；t.after 恢复原状 */
function setup(t: TestContext, options: SetupOptions = {}) {
  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  for (const m of options.models ?? [FAKE_MODEL]) modelInfoService.addModelInfo(m)

  resetTaskExecutor()
  resetTaskRegistry()
  getTemplateManager().setAllTemplates(
    options.templates ?? [makeTemplate('test-agent', FAKE_MODEL.name)]
  )

  const secureStorage = makeSecureStorage(options.apiKey ?? 'fake-key')

  t.after(() => {
    modelInfoService.clearAllModelInfos()
    for (const m of originalModels) modelInfoService.addModelInfo(m)
    resetTaskExecutor()
    resetTaskRegistry()
    resetTemplateManager()
  })

  return { secureStorage }
}

function makeTaskToolCall(id: string, subagentType: string, taskId = id): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'task',
      arguments: JSON.stringify({
        task_id: taskId,
        subagent_type: subagentType,
        task_description: '测试任务',
        success_criteria: '完成',
      }),
    },
  }
}

/** 记录调用次数的假执行器（预检失败时不应被触达） */
function makeCountingExecutor() {
  const state = { calls: 0 }
  const executor: ISubagentExecutor = {
    execute: async () => {
      state.calls++
      return { status: 'completed', final_output: 'done' }
    },
  }
  return { executor, state }
}

const CTX: DelegationContext = { toolMetadata: [], toolDefinitions: [] }

test('preflight 通过: 正常登记注册表并返回受理占位', async (t) => {
  const { secureStorage } = setup(t)
  const { executor } = makeCountingExecutor()
  getTaskExecutor(secureStorage, executor)

  const output = await executeTaskToolCall(makeTaskToolCall('tc-ok', 'test-agent'), CTX)
  assert.equal(output.status, 'running')
  assert.ok(output.final_output.includes('已受理，后台执行中'))
  assert.equal(getTaskRegistry().getByToolCallId('tc-ok')!.status, 'running')
})

test('preflight: 模板不存在 → 同步报错，不登记、无占位、不触达执行器', async (t) => {
  const { secureStorage } = setup(t)
  const { executor, state } = makeCountingExecutor()
  getTaskExecutor(secureStorage, executor)

  const started: string[] = []
  const onStarted = (p: { taskId: string }) => started.push(p.taskId)
  eventBus.on(EVENTS.SUBAGENT_TASK_STARTED, onStarted)
  t.after(() => eventBus.off(EVENTS.SUBAGENT_TASK_STARTED, onStarted))

  const output = await executeTaskToolCall(makeTaskToolCall('tc-ghost', 'ghost-agent'), CTX)
  assert.equal(output.status, 'failed')
  assert.equal(output.error_info?.code, 'PREFLIGHT_FAILED')
  assert.ok(output.error_info?.message.includes('未找到'))
  // 不登记注册表、无占位、无 STARTED 事件、不触达执行器（→ 无后续通知）
  assert.equal(getTaskRegistry().list().length, 0)
  assert.equal(started.length, 0)
  assert.equal(state.calls, 0)
})

test('preflight: 模型不存在（模板 model 未注册）→ 同步报错含模型名与修复建议', async (t) => {
  const { secureStorage } = setup(t, {
    templates: [makeTemplate('test-agent', 'claude-3-sonnet-20240229')],
  })
  const { executor, state } = makeCountingExecutor()
  getTaskExecutor(secureStorage, executor)

  const output = await executeTaskToolCall(makeTaskToolCall('tc-nomodel', 'test-agent'), CTX)
  assert.equal(output.status, 'failed')
  assert.equal(output.error_info?.code, 'PREFLIGHT_FAILED')
  assert.ok(output.error_info?.message.includes('无法启动委派'))
  assert.ok(output.error_info?.message.includes('claude-3-sonnet-20240229'))
  assert.ok(output.error_info?.message.includes('baseURL'))
  assert.ok(output.error_info?.message.includes('跟随当前会话模型'))
  assert.equal(getTaskRegistry().list().length, 0)
  assert.equal(state.calls, 0)
})

test('preflight: 模型缺 baseURL → 同步报错', async (t) => {
  const { secureStorage } = setup(t, {
    models: [NO_URL_MODEL],
    templates: [makeTemplate('test-agent', NO_URL_MODEL.name)],
  })
  const { executor, state } = makeCountingExecutor()
  getTaskExecutor(secureStorage, executor)

  const output = await executeTaskToolCall(makeTaskToolCall('tc-nourl', 'test-agent'), CTX)
  assert.equal(output.status, 'failed')
  assert.ok(output.error_info?.message.includes(NO_URL_MODEL.name))
  assert.ok(output.error_info?.message.includes('baseURL'))
  assert.equal(getTaskRegistry().list().length, 0)
  assert.equal(state.calls, 0)
})

test('preflight: 模型缺 API Key → 同步报错', async (t) => {
  const { secureStorage } = setup(t, { apiKey: '' })
  const { executor, state } = makeCountingExecutor()
  getTaskExecutor(secureStorage, executor)

  const output = await executeTaskToolCall(makeTaskToolCall('tc-nokey', 'test-agent'), CTX)
  assert.equal(output.status, 'failed')
  assert.ok(output.error_info?.message.includes(FAKE_MODEL.name))
  assert.ok(output.error_info?.message.includes('API Key'))
  assert.equal(getTaskRegistry().list().length, 0)
  assert.equal(state.calls, 0)
})

test('preflight: 同轮多 task 各自预检——不过的同步报错，其余正常登记+占位', async (t) => {
  const { secureStorage } = setup(t, {
    templates: [
      makeTemplate('test-agent', FAKE_MODEL.name),
      makeTemplate('bad-agent', 'claude-3-sonnet-20240229'),
    ],
  })
  const { executor, state } = makeCountingExecutor()
  getTaskExecutor(secureStorage, executor)

  const results = await executeTaskToolCalls(
    [makeTaskToolCall('tc-good', 'test-agent'), makeTaskToolCall('tc-bad', 'bad-agent')],
    CTX
  )
  assert.equal(results.length, 2)
  const good = results.find((r) => r.toolCall.id === 'tc-good')!
  const bad = results.find((r) => r.toolCall.id === 'tc-bad')!
  assert.equal(good.taskOutput.status, 'running')
  assert.ok(good.taskOutput.final_output.includes('已受理，后台执行中'))
  assert.equal(bad.taskOutput.status, 'failed')
  assert.equal(bad.taskOutput.error_info?.code, 'PREFLIGHT_FAILED')

  // 仅通过预检的登记注册表
  const registry = getTaskRegistry()
  assert.equal(registry.list().length, 1)
  assert.equal(registry.getByToolCallId('tc-good')!.status, 'running')
  assert.equal(registry.getByToolCallId('tc-bad'), undefined)
})

test('sync 路径（-p 特判）行为不变: 不走 preflight，错误仍来自执行路径', async (t) => {
  const { secureStorage } = setup(t, {
    templates: [makeTemplate('test-agent', 'claude-3-sonnet-20240229')],
  })
  const { executor, state } = makeCountingExecutor()
  getTaskExecutor(secureStorage, executor)

  const output = await executeTaskToolCall(makeTaskToolCall('tc-sync', 'test-agent'), CTX, undefined, {
    sync: true,
  })
  assert.equal(output.status, 'failed')
  // 执行路径的模型解析错误（No baseURL found），而非 PREFLIGHT_FAILED
  assert.notEqual(output.error_info?.code, 'PREFLIGHT_FAILED')
  assert.ok(output.error_info?.message.includes('No baseURL found'))
  assert.equal(getTaskRegistry().list().length, 0)
  assert.equal(state.calls, 0) // adapter 在调用执行器前抛出
})

test('一致性: adapter 与 preflight 共用同一解析函数 resolveSubagentModelConfig', async (t) => {
  const { secureStorage } = setup(t)
  const template = makeTemplate('test-agent', FAKE_MODEL.name)
  const mergedParams = {}

  // adapter.resolveModelConfig（preflight 经 TaskExecutor 走的就是它）与共享函数结果一致
  const adapter = new LocalSubagentAdapter(secureStorage, { execute: async () => ({}) })
  const viaAdapter = await adapter.resolveModelConfig(template, mergedParams)
  const viaShared = await resolveSubagentModelConfig(template, mergedParams, secureStorage)
  assert.deepEqual(viaAdapter, viaShared)

  // adapter.execute 传给执行器的 apiKey/baseURL 即解析结果
  const seen: Array<{ apiKey?: string; baseURL?: string }> = []
  const recording: ISubagentExecutor = {
    execute: async (_t, _d, _p, _s, _tools, _available, apiKey, baseURL) => {
      seen.push({ apiKey, baseURL })
      return { status: 'completed', final_output: 'ok' }
    },
  }
  const execAdapter = new LocalSubagentAdapter(secureStorage, recording)
  const result = await execAdapter.execute(template, '子任务', mergedParams, 0)
  assert.equal(result.status, 'completed')
  assert.equal(seen[0].apiKey, viaShared.apiKey)
  assert.equal(seen[0].baseURL, viaShared.baseURL)
  assert.equal(viaShared.modelName, FAKE_MODEL.name)
})

test('preflight: 远程模板 + require_review → 明确报错（无 transcript 修正通道），不登记幽灵任务', async (t) => {
  const remoteTemplate = {
    ...makeTemplate('remote-agent', FAKE_MODEL.name),
    type: 'remote-api' as SubagentTemplate['type'],
  }
  const { secureStorage } = setup(t, { templates: [remoteTemplate] })
  const { executor, state } = makeCountingExecutor()
  getTaskExecutor(secureStorage, executor)

  const call = makeTaskToolCall('tc-remote-review', 'remote-agent')
  call.function.arguments = JSON.stringify({
    ...JSON.parse(call.function.arguments),
    require_review: true,
  })
  const output = await executeTaskToolCall(call, CTX)
  assert.equal(output.status, 'failed')
  assert.equal(output.error_info?.code, 'PREFLIGHT_FAILED')
  assert.ok(output.error_info?.message.includes('不支持 require_review'), '报错明示原因')
  assert.equal(getTaskRegistry().list().length, 0, '不登记幽灵任务')
  assert.equal(state.calls, 0, '不触达执行器')
})

test('preflight: 远程模板不带 require_review → 照常放行（回归）', async (t) => {
  const remoteTemplate = {
    ...makeTemplate('remote-agent-2', FAKE_MODEL.name),
    type: 'remote-api' as SubagentTemplate['type'],
  }
  const { secureStorage } = setup(t, { templates: [remoteTemplate] })
  const { executor } = makeCountingExecutor()
  getTaskExecutor(secureStorage, executor)

  const output = await executeTaskToolCall(makeTaskToolCall('tc-remote-ok', 'remote-agent-2'), CTX)
  assert.equal(output.status, 'running', '远程模板无 require_review 时预检通过、正常受理')
})
