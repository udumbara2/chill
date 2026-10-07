import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { StandardSubagentExecutor } from '../../src/execution/StandardSubagentExecutor.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import { SelectedModelsService } from '../../src/services/selectedModelsService.ts'
import { getTemplateManager, resetTemplateManager } from '../../src/orchestrator/managers/SubagentTemplateManager.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
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

function makeTemplate(extra: Partial<SubagentTemplate>): SubagentTemplate {
  return { name: '测试模板', subagent_type: 'test-agent', priority: BUILTIN_PRIORITY, model: FAKE.name, ...extra }
}

const REVIEWER_TEMPLATE: SubagentTemplate = {
  name: '结果评审者', subagent_type: 'reviewer', priority: BUILTIN_PRIORITY, model: FAKE.name,
  tools: ['read_file'],
}

function setup(t: TestContext): void {
  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  modelInfoService.addModelInfo(FAKE)

  const sessionService = SelectedModelsService.getInstance()
  const originalStore = (sessionService as any)._store
  SelectedModelsService.setDefaultStore(memStore())

  resetTaskRegistry()
  getTemplateManager().setAllTemplates([makeTemplate({}), REVIEWER_TEMPLATE])

  t.after(() => {
    modelInfoService.clearAllModelInfos()
    for (const m of originalModels) modelInfoService.addModelInfo(m)
    ;(sessionService as any)._store = originalStore
    resetTemplateManager()
    resetTaskRegistry()
  })
}

const secureStorage = { getApiKey: async () => 'fake-key' } as unknown as ISecureStorage

interface CapturedRequest {
  subagentType?: string
  userMessage?: string
  priorMessages?: unknown[]
  authorizedTools?: string[]
}

/**
 * 按 subagentType 分派响应的 mock forkManager：
 * worker 首轮 FAIL 版交付 → 评审 FAIL → 打回修正 PASS 版交付 → 复评 PASS
 */
function makeReviewFlowForkManager(log: CapturedRequest[]) {
  const workerConversation = [{ role: 'system', content: 'sys' }, { role: 'user', content: '任务' }, { role: 'assistant', content: 'v1' }]
  const reworkConversation = [...workerConversation, { role: 'user', content: '评审意见' }, { role: 'assistant', content: 'v2' }]
  let workerCalls = 0
  const factory = () => ({
    createEnvironment: async (subagentType: string) => ({
      sendRequest: async (req: CapturedRequest) => {
        log.push({ ...req, subagentType })
        if (subagentType === 'reviewer') {
          const isReworked = (req.userMessage ?? '').includes('交付v2')
          return { success: true, output: isReworked ? '复核通过。\nVERDICT: PASS' : '缺测试输出。\nVERDICT: FAIL' }
        }
        workerCalls++
        return workerCalls === 1
          ? { success: true, output: '交付v1', conversation: workerConversation }
          : { success: true, output: '交付v2', conversation: reworkConversation }
      },
      destroy: async () => {},
    }),
  }) as unknown as TemplateSubagentForkManager
  return factory
}

test('评审回路: require_review 全链路——交付→评审FAIL→打回修正→复评PASS，轨迹附输出，评审事件发射', async (t) => {
  setup(t)
  const log: CapturedRequest[] = []
  const reviewEvents: Array<{ round: number; verdict: string }> = []
  const onReview = (p: { round: number; verdict: string }) => reviewEvents.push(p)
  eventBus.on(EVENTS.SUBAGENT_TASK_REVIEW, onReview)
  t.after(() => eventBus.off(EVENTS.SUBAGENT_TASK_REVIEW, onReview))

  const executor = new StandardSubagentExecutor(secureStorage, makeReviewFlowForkManager(log))
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '修复样式', {}, 0,
    [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } } as ToolDefinition],
    ['read_file'],
    undefined, undefined, undefined,
    { successCriteria: 'pnpm test 全绿', requireReview: true }
  )

  assert.equal(result.status, 'completed')
  const output = result.final_output as string
  assert.ok(output.includes('交付v2'), '最终输出为修正版')
  assert.ok(output.includes('【评审轨迹】'), '轨迹附录存在')
  assert.ok(output.includes('第1轮：未通过'), '轨迹含打回轮')
  assert.ok(output.includes('第2轮：通过'), '轨迹含复评轮')
  assert.ok(output.includes('验证闭环通过'), '结论为通过')

  // 执行序列：worker → reviewer(FAIL) → worker(修正,带种子) → reviewer(PASS)
  assert.deepEqual(log.map((r) => r.subagentType), ['test-agent', 'reviewer', 'test-agent', 'reviewer'])
  // 评审任务文本含成功标准与 worker 交付全文
  assert.ok(log[1].userMessage!.includes('pnpm test 全绿'))
  assert.ok(log[1].userMessage!.includes('交付v1'))
  // 打回修正带 transcript 种子与评审意见
  assert.ok(Array.isArray(log[2].priorMessages) && log[2].priorMessages!.length === 3, '修正带原对话种子')
  assert.ok(log[2].userMessage!.includes('缺测试输出'), '评审意见进入打回指令')
  // 复评看到的是修正版交付
  assert.ok(log[3].userMessage!.includes('交付v2'))

  // 评审事件逐轮发射
  assert.deepEqual(reviewEvents.map((e) => [e.round, e.verdict]), [[1, 'FAIL'], [2, 'PASS']])

  // transcript 为含修正轮的最新对话（resume 接续点）
  assert.equal((result.conversation as unknown[]).length, 5)
})

test('评审回路: 评审/修正子执行不在 resume 空间留痕（不经 delegation 层）', async (t) => {
  setup(t)
  const log: CapturedRequest[] = []
  const executor = new StandardSubagentExecutor(secureStorage, makeReviewFlowForkManager(log))
  await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '任务', {}, 0, undefined, undefined, undefined, undefined, 'bind-key-1',
    { successCriteria: '标准', requireReview: true }
  )
  // executor 级执行不写 transcript 区（留存是 delegation 层 settle 的职责）
  assert.equal(getTaskRegistry().list().length, 0, '评审子执行不注册任务条目')
  assert.equal(getTaskRegistry().getTranscript('bind-key-1'), undefined, 'executor 内不留存 transcript')
  // 环境绑定在 finally 中已解绑
  assert.equal(getTaskRegistry().getEnvironment('bind-key-1'), undefined, '环境绑定已清理')
})

test('评审回路: require_review 缺省时不进回路（回归）', async (t) => {
  setup(t)
  const log: CapturedRequest[] = []
  const executor = new StandardSubagentExecutor(secureStorage, makeReviewFlowForkManager(log))
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '任务', {}, 0
  )
  assert.equal(result.status, 'completed')
  assert.equal(log.length, 1, '只有 worker 一次执行，无评审')
  assert.ok(!(result.final_output as string).includes('【评审轨迹】'), '无轨迹附录')
})

test('评审回路: reviewer 模板不存在 → 按通过记录并标注（不冤杀合法交付）', async (t) => {
  setup(t)
  getTemplateManager().setAllTemplates([makeTemplate({})])  // 无 reviewer
  const log: CapturedRequest[] = []
  const executor = new StandardSubagentExecutor(secureStorage, makeReviewFlowForkManager(log))
  const result = await executor.execute(
    makeTemplate({}) as unknown as Record<string, unknown>,
    '任务', {}, 0, undefined, undefined, undefined, undefined, undefined,
    { successCriteria: '标准', requireReview: true }
  )
  assert.equal(result.status, 'completed')
  assert.ok((result.final_output as string).includes('评审执行失败'), '轨迹标注异常路径')
  assert.ok((result.final_output as string).includes('验证闭环通过'), '按通过收尾')
})
