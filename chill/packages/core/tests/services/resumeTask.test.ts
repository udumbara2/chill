import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  executeTaskToolCall,
  executeResumeTask,
  executeQueryTaskStatus,
  setDelegationContextProvider,
} from '../../src/services/delegation/delegationTools.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { getTaskExecutor, resetTaskExecutor } from '../../src/orchestrator/executor/TaskExecutor.ts'
import { getTemplateManager, resetTemplateManager } from '../../src/orchestrator/managers/SubagentTemplateManager.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import type { ToolCall, ModelInfo, ModelType } from '../../src/types/models.ts'
import type { SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { ISubagentExecutor, SubagentExecuteExtras } from '../../src/execution/ISubagentExecutor.ts'
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

/** 等后台 settle 回调链（.then 序列）跑完 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

const CONVERSATION = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '测试任务' },
  { role: 'assistant', content: 'done' },
]

test('transcript 留存: 任务成功且带 conversation → 注册表可查；query_task_status 标注可追问', async (t) => {
  setup(t)
  const executor: ISubagentExecutor = {
    execute: async () => ({ status: 'completed', final_output: 'done', conversation: CONVERSATION }),
  }
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-r1', 'alias-r1'), { toolMetadata: [], toolDefinitions: [] })
  await flush()

  const transcript = getTaskRegistry().getTranscript('tc-r1')
  assert.ok(transcript, 'transcript 已留存')
  assert.deepEqual(transcript!.messages, CONVERSATION)
  assert.equal(transcript!.subagentType, 'test-agent')
  assert.equal(transcript!.successCriteria, '完成')
  // task_id 别名同样可查
  assert.ok(getTaskRegistry().getTranscript('alias-r1'))

  const status = executeQueryTaskStatus({ toolCallId: 'tc-r1' })
  assert.ok(status.content!.includes('可追问'), 'query_task_status 标注可追问')
})

test('transcript 留存: 失败任务不留存；成功但无 conversation 不留存', async (t) => {
  setup(t)
  const executor: ISubagentExecutor = {
    execute: async (_t, desc) => desc.includes('失败')
      ? { status: 'failed', final_output: '', error_info: { message: 'x' } }
      : { status: 'completed', final_output: 'done' },  // 无 conversation
  }
  getTaskExecutor(secureStorage, executor)

  const failCall = makeTaskToolCall('tc-f1', 'alias-f1')
  failCall.function.arguments = JSON.stringify({
    ...JSON.parse(failCall.function.arguments),
    task_description: '这个任务会失败',
  })
  await executeTaskToolCall(failCall, { toolMetadata: [], toolDefinitions: [] })
  await executeTaskToolCall(makeTaskToolCall('tc-f2', 'alias-f2'), { toolMetadata: [], toolDefinitions: [] })
  await flush()
  assert.equal(getTaskRegistry().getTranscript('tc-f1'), undefined, '失败任务不留存')
  assert.equal(getTaskRegistry().getTranscript('tc-f2'), undefined, '无 conversation 不留存')
})

test('transcript LRU: 超 10 条淘汰最久未刷新者', async (t) => {
  setup(t)
  const registry = getTaskRegistry()
  for (let i = 0; i < 12; i++) {
    registry.retainTranscript(`k${i}`, { messages: [], subagentType: 'a', taskDescription: `t${i}` })
  }
  assert.equal(registry.getTranscript('k0'), undefined, '最老者被淘汰')
  assert.equal(registry.getTranscript('k1'), undefined, '次老者被淘汰')
  assert.ok(registry.getTranscript('k2'), '较新者保留')
  assert.ok(registry.getTranscript('k11'), '最新者保留')

  // 刷新提位：刷新 k2 后 k2 不再是最老
  registry.retainTranscript('k2', { messages: [], subagentType: 'a', taskDescription: 't2-new' })
  registry.retainTranscript('k12', { messages: [], subagentType: 'a', taskDescription: 't12' })
  assert.ok(registry.getTranscript('k2'), '刷新后提位不被淘汰')
  assert.equal(registry.getTranscript('k3'), undefined, '未刷新的次老者被淘汰')
})

test('resume_task: 无 transcript → 明确报错并指引重新委派', async (t) => {
  setup(t)
  getTaskExecutor(secureStorage, { execute: async () => ({ status: 'completed', final_output: 'x' }) })

  const result = await executeResumeTask('tc-resume-1', { task_id: '不存在', message: '改一下' })
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('不可追问'), '明确告知不可追问')
  assert.ok(result.error!.includes('重新委派'), '指引用 task 重新委派')
})

test('resume_task: 缺 message → 明确报错', async (t) => {
  setup(t)
  const result = await executeResumeTask('tc-resume-2', { task_id: 'x' })
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('message'))
})

test('resume_task 端到端: 种子下行 + 占位受理 + settle 后 transcript 刷新（追问链可持续）', async (t) => {
  setup(t)
  const receivedExtras: Array<SubagentExecuteExtras | undefined> = []
  const executor: ISubagentExecutor = {
    execute: async (_tp, _d, _p, _s, _tools, _av, _k, _b, _key, extras) => {
      receivedExtras.push(extras)
      // 追问执行带回新的 conversation（含追问轮）
      const isResume = !!extras?.priorMessages
      return {
        status: 'completed',
        final_output: isResume ? '修订版' : '初版',
        conversation: isResume
          ? [...CONVERSATION, { role: 'user', content: '第三点改成 XX' }, { role: 'assistant', content: '修订版' }]
          : CONVERSATION,
      }
    },
  }
  getTaskExecutor(secureStorage, executor)

  // 首次委派
  await executeTaskToolCall(makeTaskToolCall('tc-e1', 'alias-e1'), { toolMetadata: [], toolDefinitions: [] })
  await flush()
  assert.equal(receivedExtras.length, 1)
  assert.equal(receivedExtras[0]?.priorMessages, undefined, '首次委派无种子')

  // 追问（task_id 别名寻址）
  const accepted = await executeResumeTask('tc-e1-followup', { task_id: 'alias-e1', message: '第三点改成 XX' })
  assert.equal(accepted.success, true)
  assert.ok(accepted.content!.includes('追问已受理'), '返回受理占位')
  await flush()

  // 种子下行：extras 带原 transcript 与成功标准
  assert.equal(receivedExtras.length, 2)
  assert.deepEqual(receivedExtras[1]?.priorMessages, CONVERSATION, '原 transcript 作为种子下行')
  assert.equal(receivedExtras[1]?.successCriteria, '完成', '原成功标准沿用')

  // 注册表新条目：记 parentToolCallId，占位期状态 running 已 settle 为 completed
  const followupEntry = getTaskRegistry().getByToolCallId('tc-e1-followup')
  assert.ok(followupEntry, '追问条目已登记')
  assert.equal(followupEntry!.parentToolCallId, 'tc-e1', '记录父任务')
  assert.equal(followupEntry!.status, 'completed')
  assert.ok(followupEntry!.description.startsWith('追问: '), '描述带追问前缀')

  // transcript 刷新：追问条目可查，内容为含追问轮的新对话
  const newTranscript = getTaskRegistry().getTranscript('tc-e1-followup')
  assert.ok(newTranscript, '追问后 transcript 已刷新')
  assert.equal(newTranscript!.messages.length, CONVERSATION.length + 2, '新对话含追问轮')

  // 二次追问（追问链）：以新 transcript 为种子
  const second = await executeResumeTask('tc-e1-followup-2', { toolCallId: 'tc-e1-followup', message: '再改一点' })
  assert.equal(second.success, true)
  await flush()
  assert.equal(receivedExtras.length, 3)
  assert.equal((receivedExtras[2]?.priorMessages as unknown[]).length, CONVERSATION.length + 2, '二次追问种子为刷新后的对话')
})

test('resume_task: override_parameters 与原任务参数合并（调用方覆盖优先）', async (t) => {
  setup(t)
  const receivedParams: Array<Record<string, unknown>> = []
  const executor: ISubagentExecutor = {
    execute: async (_tp, _d, mergedParams) => {
      receivedParams.push(mergedParams as Record<string, unknown>)
      return { status: 'completed', final_output: 'done', conversation: CONVERSATION }
    },
  }
  getTaskExecutor(secureStorage, executor)

  const call = makeTaskToolCall('tc-o1', 'alias-o1')
  call.function.arguments = JSON.stringify({
    ...JSON.parse(call.function.arguments),
    override_parameters: { timeout: 300, temperature: 0.5 },
  })
  await executeTaskToolCall(call, { toolMetadata: [], toolDefinitions: [] })
  await flush()

  await executeResumeTask('tc-o1-f', { toolCallId: 'tc-o1', message: '改', override_parameters: { timeout: 900 } })
  await flush()
  assert.equal(receivedParams[1].timeout, 900, '调用方覆盖优先')
  assert.equal(receivedParams[1].temperature, 0.5, '原任务参数沿用')
})

test('resume_task: preflight 失败（模板已删）→ 同步报错，不登记幽灵任务', async (t) => {
  setup(t)
  const executor: ISubagentExecutor = {
    execute: async () => ({ status: 'completed', final_output: 'done', conversation: CONVERSATION }),
  }
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-p1', 'alias-p1'), { toolMetadata: [], toolDefinitions: [] })
  await flush()
  assert.ok(getTaskRegistry().getTranscript('tc-p1'))

  // 模板被删（任务执行后）
  getTemplateManager().setAllTemplates([])

  const result = await executeResumeTask('tc-p1-f', { toolCallId: 'tc-p1', message: '改' })
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('未找到'), 'preflight 报错模板不存在')
  assert.equal(getTaskRegistry().getByToolCallId('tc-p1-f'), undefined, '不登记幽灵任务')
})

test('resume_task: -p 同步特判 → await 真实结果，不登记后台任务', async (t) => {
  setup(t)
  const executor: ISubagentExecutor = {
    execute: async (_tp, _d, _p, _s, _t, _a, _k, _b, _key, extras) => ({
      status: 'completed',
      final_output: extras?.priorMessages ? '修订版' : '初版',
      conversation: CONVERSATION,
    }),
  }
  getTaskExecutor(secureStorage, executor)

  // 同步首次委派（-p 路径不注册条目，但 transcript 照存）
  await executeTaskToolCall(makeTaskToolCall('tc-s1', 'alias-s1'), { toolMetadata: [], toolDefinitions: [] }, undefined, { sync: true })
  await flush()
  assert.ok(getTaskRegistry().getTranscript('tc-s1'), 'sync 路径 transcript 照存')

  const result = await executeResumeTask('tc-s1-f', { toolCallId: 'tc-s1', message: '改' }, { sync: true })
  assert.equal(result.success, true)
  assert.equal(result.content, '修订版', 'sync 返回真实执行结果')
  assert.equal(getTaskRegistry().getByToolCallId('tc-s1-f'), undefined, 'sync 不登记后台任务')
})
