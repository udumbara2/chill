import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeBatchTask,
  executeCancelTask,
  executeResumeTask,
  executeTaskToolCall,
  setDelegationContextProvider,
  setTaskEnvironmentDestroyer,
  type DelegationContext,
} from '../../src/services/delegation/delegationTools.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { getTaskExecutor, resetTaskExecutor } from '../../src/orchestrator/executor/TaskExecutor.ts'
import { getTemplateManager, resetTemplateManager } from '../../src/orchestrator/managers/SubagentTemplateManager.ts'
import {
  SessionBoardService,
  resetSessionBoardService,
  setSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import { BoardStore } from '../../src/services/board/boardStore.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import type { TaskToolOutput, SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { ToolCall, ModelInfo, ModelType } from '../../src/types/models.ts'
import type { ISubagentExecutor } from '../../src/execution/ISubagentExecutor.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'
import type { IsolatedEnvironment } from '../../src/orchestrator/isolation/types.ts'

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

async function setup(t: TestContext): Promise<SessionBoardService> {
  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  modelInfoService.addModelInfo(FAKE_MODEL)
  resetTaskExecutor()
  resetTaskRegistry()
  getTemplateManager().setAllTemplates([makeTemplate()])

  const dir = await mkdtemp(join(tmpdir(), 'board-bridge-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)

  t.after(async () => {
    modelInfoService.clearAllModelInfos()
    for (const m of originalModels) modelInfoService.addModelInfo(m)
    resetTaskExecutor()
    resetTaskRegistry()
    resetTemplateManager()
    setDelegationContextProvider(null)
    setTaskEnvironmentDestroyer(null)
    resetSessionBoardService()
    await rm(dir, { recursive: true, force: true })
  })
  return svc
}

/** 可控 settle 的假执行器 */
function makeDeferredExecutor() {
  let settle!: (v: Record<string, unknown>) => void
  const gate = new Promise<Record<string, unknown>>((res) => {
    settle = res
  })
  const executor: ISubagentExecutor = { execute: async () => gate }
  return { executor, settle }
}

function makeTaskToolCall(id: string, taskId: string, sessionId = 'sess-1'): ToolCall {
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
        __origin: { source: 'main', handle: 'h1', sessionId },
      }),
    },
  }
}

/** 等 settle 回调链(含看板落盘 IO)收敛 */
async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > 3000) throw new Error(`waitFor 超时: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('settle 站点①直跑任务:settle 自动结项(claimedByTaskId 匹配),result 标注自动结项', async (t) => {
  const svc = await setup(t)
  const { executor, settle } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-1', 'alias-1'), { toolMetadata: [], toolDefinitions: [] })
  // spawn 即认领:板上已挂 in_progress 条目,工位=test-agent·A
  let items = (await svc.readBoard('sess-1')).items
  assert.equal(items.length, 1)
  assert.equal(items[0].status, 'in_progress')
  assert.equal(items[0].assignee, 'test-agent·A')
  assert.equal(items[0].claimedByTaskId, 'tc-1')

  settle({ status: 'completed', final_output: 'done' })
  await waitFor(async () => {
    items = (await svc.readBoard('sess-1')).items
    return items[0]?.status === 'completed'
  }, '直跑 settle 自动结项')
  assert.equal(items[0].result, 'done\n(自动结项:认领人任务交付)')
})

test('settle 站点②batch 成员:settle 各自结项,互不串扰', async (t) => {
  const svc = await setup(t)
  const gates: Array<(v: Record<string, unknown>) => void> = []
  const executor: ISubagentExecutor = {
    execute: async () => new Promise<Record<string, unknown>>((res) => gates.push(res)),
  }
  getTaskExecutor(secureStorage, executor)

  const res = await executeBatchTask(
    'bt-1',
    {
      tasks: [
        { subagent_type: 'test-agent', task_description: '成员活一' },
        { subagent_type: 'test-agent', task_description: '成员活二' },
      ],
      __origin: { source: 'main', handle: 'h1', sessionId: 'sess-1' },
    } as never,
  )
  assert.equal(res.success, true)
  await waitFor(() => gates.length === 2, '批次两成员启动')

  let items = (await svc.readBoard('sess-1')).items
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((i) => i.assignee).sort(), ['test-agent·A', 'test-agent·B'])
  assert.ok(items.every((i) => i.status === 'in_progress'))

  gates[0]({ status: 'completed', final_output: '一交付' })
  await waitFor(async () => {
    items = (await svc.readBoard('sess-1')).items
    return items.find((i) => i.claimedByTaskId === 'bt-1#0')?.status === 'completed'
  }, 'batch 成员 settle')
  const member0 = items.find((i) => i.claimedByTaskId === 'bt-1#0')!
  const member1 = items.find((i) => i.claimedByTaskId === 'bt-1#1')!
  assert.equal(member0.result, '一交付\n(自动结项:认领人任务交付)')
  assert.equal(member1.status, 'in_progress') // 另一成员互不串扰
})

test('settle 站点③resume:追问条目 spawn 即认领,settle 自动结项', async (t) => {
  const svc = await setup(t)
  const { executor, settle } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)
  getTaskRegistry().retainTranscript('orig-1', {
    messages: [{ role: 'user', content: '原任务' }],
    subagentType: 'test-agent',
    taskDescription: '原任务',
  })

  const res = await executeResumeTask('rs-1', {
    toolCallId: 'orig-1',
    message: '追问细节',
    __origin: { source: 'main', handle: 'h1', sessionId: 'sess-1' },
  } as never)
  assert.equal(res.success, true)

  let items = (await svc.readBoard('sess-1')).items
  assert.equal(items.length, 1)
  assert.equal(items[0].status, 'in_progress')
  assert.equal(items[0].claimedByTaskId, 'rs-1')
  assert.equal(items[0].assignee, 'test-agent·A')
  assert.match(items[0].title, /^追问/)

  settle({ status: 'completed', final_output: '追问答复' })
  await waitFor(async () => {
    items = (await svc.readBoard('sess-1')).items
    return items[0]?.status === 'completed'
  }, 'resume settle 自动结项')
  assert.equal(items[0].result, '追问答复\n(自动结项:认领人任务交付)')
})

test('settle 站点④cancel 路径:死亡回流(条目回待认领池,留痕认领人任务被取消)', async (t) => {
  const svc = await setup(t)
  const { executor } = makeDeferredExecutor() // 不 settle,保持 running
  getTaskExecutor(secureStorage, executor)
  const ctx: DelegationContext = { toolMetadata: [], toolDefinitions: [] }
  setDelegationContextProvider(() => ctx)

  await executeTaskToolCall(makeTaskToolCall('tc-c1', 'alias-c1'), ctx)
  const fakeEnv = { destroy: async () => {} } as unknown as IsolatedEnvironment
  getTaskRegistry().bindEnvironment('tc-c1', fakeEnv)

  const result = await executeCancelTask({ toolCallId: 'tc-c1' })
  assert.equal(result.success, true)

  const items = (await svc.readBoard('sess-1')).items
  assert.equal(items.length, 1)
  // settle 'cancelled'=死亡回流回 pending(终态 cancelled 只走 cancelItem/裁决/归档)
  assert.equal(items[0].status, 'pending')
  assert.equal(items[0].assignee, undefined)
  assert.equal(items[0].claimedByTaskId, undefined)
  const hist = items[0].releaseHistory!.at(-1)!
  assert.equal(hist.by, 'system')
  assert.match(hist.reason, /认领人任务被取消/)
})

test('未装配 SessionBoardService:spaw/settle 全程无操作不抛(既有测试零旁侧)', async (t) => {
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
    setTaskEnvironmentDestroyer(null)
    resetSessionBoardService()
  })
  const { executor, settle } = makeDeferredExecutor()
  getTaskExecutor(secureStorage, executor)
  const output = await executeTaskToolCall(makeTaskToolCall('tc-x', 'alias-x'), { toolMetadata: [], toolDefinitions: [] })
  assert.equal(output.status, 'running')
  settle({ status: 'completed', final_output: 'done' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(getTaskRegistry().getByToolCallId('tc-x')!.status, 'completed')
})
