import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTaskToolCall, setDelegationContextProvider, setTaskEnvironmentDestroyer } from '../../src/services/delegation/delegationTools.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { getTaskExecutor, resetTaskExecutor } from '../../src/orchestrator/executor/TaskExecutor.ts'
import { getTemplateManager, resetTemplateManager } from '../../src/orchestrator/managers/SubagentTemplateManager.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import type { ToolCall, ModelInfo, ModelType } from '../../src/types/models.ts'
import type { SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'
import type { ISubagentExecutor } from '../../src/execution/ISubagentExecutor.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'
import {
  SessionBoardService,
  resetSessionBoardService,
  setSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import { BoardStore } from '../../src/services/board/boardStore.ts'

/**
 * V3.1 拉活三步全链:claim 意图(不绑任务键)→ settle 识别(工位有已认领未绑条目)→
 * 同工位带种子续跑(executeResumeTask,1 任务=1 进程=1 toolCallId)+ 换绑 claimedByTaskId=新键。
 * 拉活不新建板条目(它就是被认领那条的执行)。
 */

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
const CONVERSATION = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '测试任务' },
  { role: 'assistant', content: 'done' },
]

async function setup(t: TestContext): Promise<SessionBoardService> {
  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  modelInfoService.addModelInfo(FAKE_MODEL)
  resetTaskExecutor()
  resetTaskRegistry()
  getTemplateManager().setAllTemplates([
    { name: '测试模板', subagent_type: 'test-agent', priority: BUILTIN_PRIORITY, model: FAKE_MODEL.name } as SubagentTemplate,
  ])
  const dir = await mkdtemp(join(tmpdir(), 'board-intent-'))
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
        __origin: { source: 'main', handle: 'h1', sessionId: 'sess-1' },
      }),
    },
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > 4000) throw new Error(`waitFor 超时: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('拉活三步:claim 意图(不绑键)→ settle 识别 → 续跑 spawn+换绑 → 换绑后按新键自动结项;不新建条目', async (t) => {
  const svc = await setup(t)
  const gates: Array<(v: Record<string, unknown>) => void> = []
  const executor: ISubagentExecutor = {
    execute: async () => new Promise<Record<string, unknown>>((res) => gates.push(res)),
  }
  getTaskExecutor(secureStorage, executor)

  // ①直跑 spawn:自动 post+claim 条目 A(test-agent·A 绑 tc-1)
  await executeTaskToolCall(makeTaskToolCall('tc-1', 'alias-1'), { toolMetadata: [], toolDefinitions: [] })
  await waitFor(() => gates.length === 1, '首个执行启动')
  let items = (await svc.readBoard('sess-1')).items
  assert.equal(items.length, 1)
  const workstation = items[0]!.assignee!
  assert.match(workstation, /^test-agent·/) // 工位=subagentType·短序号

  // ②同工位 claim 意图:认领下一条(不绑任务键,意图态)
  const b = await svc.post('sess-1', { title: '下一条活', createdBy: 'lead', description: '续做内容' })
  const claimed = await svc.claim('sess-1', b.id, { assignee: workstation })
  assert.equal(claimed.status, 'in_progress')
  assert.equal(claimed.claimedByTaskId, undefined) // 意图态:未绑
  assert.equal(svc.findIntentItems('sess-1', workstation).map((i) => i.id).includes(b.id), true)

  // ③settle 识别+续跑:首个任务 completed(带 conversation=种子)→ 自动结项 A → 识别意图条目 → 种子续跑
  gates[0]!({ status: 'completed', final_output: 'done', conversation: CONVERSATION })
  await waitFor(async () => {
    items = (await svc.readBoard('sess-1')).items
    return items.find((i) => i.id === b.id)?.claimedByTaskId !== undefined
  }, '续跑换绑')

  const rebound = items.find((i) => i.id === b.id)!
  assert.match(rebound.claimedByTaskId!, /^intent-/) // 新 toolCallId(1 任务=1 进程=1 toolCallId)
  assert.equal(items.find((i) => i.claimedByTaskId === 'tc-1')!.status, 'completed') // A 自动结项
  assert.equal(items.length, 2) // 拉活不新建条目

  // ④换绑后自动结项仍按新 taskId:续跑执行 settle → 条目 B 自动结项
  await waitFor(() => gates.length === 2, '续跑进程启动')
  gates[1]!({ status: 'completed', final_output: '续完', conversation: CONVERSATION })
  await waitFor(async () => {
    items = (await svc.readBoard('sess-1')).items
    return items.find((i) => i.id === b.id)?.status === 'completed'
  }, '换绑后自动结项')
  const done = items.find((i) => i.id === b.id)!
  assert.match(done.result!, /自动结项:认领人任务交付/)
  assert.equal(items.length, 2) // 全程 2 条目(A/B),无拉活幽灵条目
})

test('拉活识别:失败任务死亡回流吞掉意图条目(回 pending),不触发续跑', async (t) => {
  const svc = await setup(t)
  const gates: Array<(v: Record<string, unknown>) => void> = []
  const executor: ISubagentExecutor = {
    execute: async () => new Promise<Record<string, unknown>>((res) => gates.push(res)),
  }
  getTaskExecutor(secureStorage, executor)

  await executeTaskToolCall(makeTaskToolCall('tc-2', 'alias-2'), { toolMetadata: [], toolDefinitions: [] })
  await waitFor(() => gates.length === 1, '执行启动')
  const a = (await svc.readBoard('sess-1')).items[0]!
  const b = await svc.post('sess-1', { title: '意图条目', createdBy: 'lead' })
  await svc.claim('sess-1', b.id, { assignee: a.assignee! })

  gates[0]!({ status: 'failed', final_output: '', error_info: { message: 'x' } })
  await waitFor(async () => {
    const items = (await svc.readBoard('sess-1')).items
    return items.find((i) => i.id === b.id)?.status === 'pending'
  }, '死亡回流含意图条目')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(gates.length, 1) // 没有续跑 spawn
  const items = (await svc.readBoard('sess-1')).items
  assert.equal(items.find((i) => i.id === b.id)!.assignee, undefined) // 回池清认领
  assert.equal(items.find((i) => i.id === b.id)!.claimedByTaskId, undefined)
})

test('换绑(rebindClaim)语义:意图条目绑定新键后,自动结项按新键匹配(旧键不再命中)', async (t) => {
  const svc = await setup(t)
  const b = await svc.post('sess-1', { title: '活', createdBy: 'lead' })
  await svc.claim('sess-1', b.id, { assignee: 'explore·A' })
  await svc.rebindClaim('sess-1', b.id, 'tc-new')
  const after = (await svc.readBoard('sess-1')).items[0]!
  assert.equal(after.claimedByTaskId, 'tc-new')
  assert.equal(after.status, 'in_progress')
  // 旧键不命中(零动作),新键自动结项
  const miss = await svc.settleByTaskId('tc-old', 'completed')
  assert.equal(miss.settledIds.length, 0)
  const hit = await svc.settleByTaskId('tc-new', 'completed', { result: '交付' })
  assert.deepEqual(hit.settledIds, [b.id])
  assert.equal((await svc.readBoard('sess-1')).items[0]!.status, 'completed')
})
