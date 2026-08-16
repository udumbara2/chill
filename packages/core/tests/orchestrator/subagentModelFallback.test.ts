import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalSubagentAdapter } from '../../src/orchestrator/executor/LocalSubagentAdapter.ts'
import { StandardSubagentExecutor } from '../../src/execution/StandardSubagentExecutor.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import { SelectedModelsService } from '../../src/services/selectedModelsService.ts'
import type { TestContext } from 'node:test'
import type { ModelInfo, ModelType } from '../../src/types/models.ts'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'
import type { ISubagentExecutor } from '../../src/execution/ISubagentExecutor.ts'
import type { SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { TemplateSubagentForkManager } from '../../src/orchestrator/isolation/TemplateSubagentForkManager.ts'

// ModelType/TemplatePriority 是 enum（不可经 node 类型擦除运行时导入），测试里用字面量替代
const GLM = 'glm' as ModelType
const BUILTIN_PRIORITY = 3 as TemplatePriority

// 四个 fake 模型各配一个可辨识的 baseURL：adapter 侧断言 executor 收到的 baseURL，
// executor 侧断言 forkManager 收到的 config.model，即可判断兜底链命中了哪一级
const REGISTRY = fakeModel('fake-registry-default', 'https://api.test/registry-default')
const OVERRIDE = fakeModel('fake-override', 'https://api.test/override')
const TEMPLATE_M = fakeModel('fake-template', 'https://api.test/template')
const SESSION = fakeModel('fake-session', 'https://api.test/session')

function fakeModel(name: string, baseURL: string): ModelInfo {
  return {
    type: GLM,
    name,
    displayName: name,
    provider: 'TestProvider',
    builtIn: false,
    description: '测试模型',
    adapterConfig: { protocol: 'openai-chat', baseURL, defaultModel: name },
    supportedModalities: [],
    apiURL: '',
    availableModels: [name],
    supportedParameters: [],
    maxOutputTokens: 4000,
    maxContextTokens: 8000,
    supportsStreaming: false,
    supportsTools: false,
    supportsThinking: false,
    version: '1',
    documentation: '',
  } as ModelInfo
}

/** 内存 KV store（同 IKeyValueStore 形状），替代 SelectedModelsService 的真实存储 */
function memStore(): IKeyValueStore {
  const m = new Map<string, string>()
  return {
    getItem: k => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v) },
    removeItem: k => { m.delete(k) },
    clear: () => m.clear(),
  }
}

/**
 * 装配全局单例：模型注册表清空后注册 fake 模型（REGISTRY 第一个插入 → 注册表默认），
 * SelectedModelsService 挂内存 store；t.after 恢复原状，避免污染其他测试文件
 */
function setup(t: TestContext): { sessionService: SelectedModelsService } {
  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  for (const m of [REGISTRY, OVERRIDE, TEMPLATE_M, SESSION]) modelInfoService.addModelInfo(m)

  const sessionService = SelectedModelsService.getInstance()
  const originalStore = (sessionService as any)._store
  SelectedModelsService.setDefaultStore(memStore())

  t.after(() => {
    modelInfoService.clearAllModelInfos()
    for (const m of originalModels) modelInfoService.addModelInfo(m)
    ;(sessionService as any)._store = originalStore
  })

  return { sessionService }
}

const secureStorage = { getApiKey: async () => 'fake-key' } as unknown as ISecureStorage

function makeTemplate(model?: string): SubagentTemplate {
  return { name: '测试模板', subagent_type: 'test-agent', priority: BUILTIN_PRIORITY, model }
}

/** adapter + 记录 baseURL 的 mock executor */
function makeAdapter() {
  const calls: Array<{ baseURL?: string }> = []
  const executor: ISubagentExecutor = {
    execute: async (_template, _desc, _params, _start, _tools, _available, _apiKey, baseURL) => {
      calls.push({ baseURL })
      return { status: 'completed', final_output: 'ok' }
    },
  }
  return { adapter: new LocalSubagentAdapter(secureStorage, executor), calls }
}

/** StandardSubagentExecutor + 记录 subagentConfig 的 mock forkManager */
function makeStandardExecutor() {
  const configs: Array<Record<string, unknown>> = []
  const forkManagerFactory = () => ({
    createEnvironment: async (_type: string, config: Record<string, unknown>) => {
      configs.push(config)
      return {
        sendRequest: async () => ({ success: true, output: 'ok' }),
        destroy: async () => {},
      }
    },
  }) as unknown as TemplateSubagentForkManager
  return { executor: new StandardSubagentExecutor(secureStorage, forkManagerFactory), configs }
}

/** 同一场景下同时驱动 adapter 与 executor，返回两处实际选用的模型标识 */
async function runBoth(template: SubagentTemplate, mergedParams: Record<string, unknown>) {
  const { adapter, calls } = makeAdapter()
  const { executor, configs } = makeStandardExecutor()
  const result = await adapter.execute(template, '子任务', mergedParams, 0)
  assert.equal(result.status, 'completed')
  const record = await executor.execute(
    template as unknown as Record<string, unknown>,
    '子任务',
    mergedParams,
    0
  )
  assert.equal(record.status, 'completed')
  return { adapterBaseURL: calls[0]?.baseURL, executorModel: configs[0]?.model as string }
}

test('override 优先：mergedParams.model 盖过模板/会话/注册表', async (t) => {
  const { sessionService } = setup(t)
  sessionService.saveCurrentModelName(SESSION.name)
  const got = await runBoth(makeTemplate(TEMPLATE_M.name), { model: OVERRIDE.name })
  assert.equal(got.adapterBaseURL, OVERRIDE.adapterConfig.baseURL)
  assert.equal(got.executorModel, OVERRIDE.name)
})

test('模板优先：无 override 时模板 model 盖过会话/注册表', async (t) => {
  const { sessionService } = setup(t)
  sessionService.saveCurrentModelName(SESSION.name)
  const got = await runBoth(makeTemplate(TEMPLATE_M.name), {})
  assert.equal(got.adapterBaseURL, TEMPLATE_M.adapterConfig.baseURL)
  assert.equal(got.executorModel, TEMPLATE_M.name)
})

test('会话优先：无 override 且无模板 model 时跟随当前会话模型', async (t) => {
  const { sessionService } = setup(t)
  sessionService.saveCurrentModelName(SESSION.name)
  const got = await runBoth(makeTemplate(), {})
  assert.equal(got.adapterBaseURL, SESSION.adapterConfig.baseURL)
  assert.equal(got.executorModel, SESSION.name)
})

test('注册表兜底：getCurrentModelName() 返回 null 时落注册表默认', async (t) => {
  const { sessionService } = setup(t)
  // store 为空，未选过会话模型
  assert.equal(sessionService.getCurrentModelName(), null)
  const got = await runBoth(makeTemplate(), {})
  assert.equal(got.adapterBaseURL, REGISTRY.adapterConfig.baseURL)
  assert.equal(got.executorModel, REGISTRY.name)
})

test('注册表兜底：store 未初始化（getStore 抛错 → getCurrentModelName 返回 null）', async (t) => {
  const { sessionService } = setup(t)
  // 直接置空私有 _store，模拟 worker/未初始化环境下 getStore() 抛错
  ;(sessionService as any)._store = null
  const got = await runBoth(makeTemplate(), {})
  assert.equal(got.adapterBaseURL, REGISTRY.adapterConfig.baseURL)
  assert.equal(got.executorModel, REGISTRY.name)
})

test('注册表兜底：getCurrentModelName() 自身抛异常时同样落注册表默认', async (t) => {
  const { sessionService } = setup(t)
  const original = sessionService.getCurrentModelName
  ;(sessionService as any).getCurrentModelName = () => { throw new Error('boom') }
  t.after(() => { (sessionService as any).getCurrentModelName = original })
  const got = await runBoth(makeTemplate(), {})
  assert.equal(got.adapterBaseURL, REGISTRY.adapterConfig.baseURL)
  assert.equal(got.executorModel, REGISTRY.name)
})
