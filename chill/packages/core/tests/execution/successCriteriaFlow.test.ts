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

/** StandardSubagentExecutor + 捕获 SubagentRequest 的 mock forkManager */
function makeExecutor() {
  const requests: Array<{ userMessage?: string; priorMessages?: unknown[] }> = []
  const forkManagerFactory = () => ({
    createEnvironment: async () => ({
      sendRequest: async (req: { userMessage?: string; priorMessages?: unknown[] }) => {
        requests.push(req)
        return { success: true, output: 'ok' }
      },
      destroy: async () => {},
    }),
  }) as unknown as TemplateSubagentForkManager
  return { executor: new StandardSubagentExecutor(secureStorage, forkManagerFactory), requests }
}

test('成功标准贯通: extras.success_criteria 拼入 userMessage，附交付证据契约', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '修复登录页样式', {}, 0,
    [ { type: 'function', function: { name: 'read_file', description: '', parameters: {} } } as ToolDefinition ],
    ['read_file'],
    undefined, undefined, undefined,
    { successCriteria: 'pnpm test 全绿；登录页在 375px 宽度下不溢出' }
  )
  assert.equal(result.status, 'completed')
  assert.equal(requests.length, 1)
  const msg = requests[0].userMessage ?? ''
  assert.ok(msg.includes('修复登录页样式'), '任务描述保留')
  assert.ok(msg.includes('【成功标准】'), '成功标准块存在')
  assert.ok(msg.includes('pnpm test 全绿；登录页在 375px 宽度下不溢出'), '成功标准原文透传')
  assert.ok(msg.includes('【交付要求】'), '交付证据契约存在')
  assert.ok(msg.includes('验证证据'), '证据要求存在')
})

test('成功标准贯通: extras 缺省时 userMessage 与现状一致（回归）', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '纯任务描述', {}, 0,
    undefined, undefined, undefined, undefined, undefined
  )
  const msg = requests[0].userMessage ?? ''
  assert.equal(msg, '纯任务描述', '无 extras 时 userMessage 就是任务描述原文')
})

test('成功标准贯通: userPromptTemplate 预包装在 extras.successCriteria 下仍然先生效', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  await executor.execute(
    makeTemplate({ user_prompt_template: '请完成：{{task_description}}（模板包装）' }) as unknown as Record<string, unknown>,
    '任务X', {}, 0,
    undefined, undefined, undefined, undefined, undefined,
    { successCriteria: '标准Y' }
  )
  const msg = requests[0].userMessage ?? ''
  assert.ok(msg.startsWith('请完成：任务X（模板包装）'), '模板预包装先应用于任务描述')
  assert.ok(msg.includes('【成功标准】\n标准Y'), '成功标准拼在包装后文本之后')
})

test('resume 种子: extras.priorMessages 存在时跳过 userPromptTemplate 预包装', async (t) => {
  setup(t)
  const { executor, requests } = makeExecutor()
  await executor.execute(
    makeTemplate({ user_prompt_template: '请完成：{{task_description}}（模板包装）' }) as unknown as Record<string, unknown>,
    '第三点改成 XX', {}, 0,
    undefined, undefined, undefined, undefined, undefined,
    { priorMessages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '原任务' }] }
  )
  const msg = requests[0].userMessage ?? ''
  assert.equal(msg, '第三点改成 XX', '追问原文，不被模板二次包装')
})

test('resume 种子: extras.priorMessages 透传进 SubagentRequest；Worker conversation 随结果带出', async (t) => {
  setup(t)
  const prior = [{ role: 'system', content: 'sys' }, { role: 'user', content: '原任务' }]
  const conversation = [...prior, { role: 'assistant', content: '原答复' }]
  const requests: Array<{ priorMessages?: unknown[] }> = []
  const forkManagerFactory = () => ({
    createEnvironment: async () => ({
      sendRequest: async (req: { priorMessages?: unknown[] }) => {
        requests.push(req)
        return { success: true, output: 'ok', conversation }
      },
      destroy: async () => {},
    }),
  }) as unknown as TemplateSubagentForkManager
  const executor = new StandardSubagentExecutor(secureStorage, forkManagerFactory)

  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '追问', {}, 0,
    undefined, undefined, undefined, undefined, undefined,
    { priorMessages: prior }
  )
  assert.deepEqual(requests[0].priorMessages, prior, '种子消息原样透传给 Worker')
  assert.deepEqual(result.conversation, conversation, 'Worker 的 conversation 顺流带出')
})

test('resume 种子: 无 priorMessages 时 SubagentRequest 不带该键（向后兼容）', async (t) => {
  setup(t)
  const requests: Array<Record<string, unknown>> = []
  const forkManagerFactory = () => ({
    createEnvironment: async () => ({
      sendRequest: async (req: Record<string, unknown>) => {
        requests.push(req)
        return { success: true, output: 'ok' }
      },
      destroy: async () => {},
    }),
  }) as unknown as TemplateSubagentForkManager
  const executor = new StandardSubagentExecutor(secureStorage, forkManagerFactory)

  await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '新任务', {}, 0
  )
  assert.equal('priorMessages' in requests[0], false, '非 resume 请求不带 priorMessages 键')
})
