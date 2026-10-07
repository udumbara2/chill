/**
 * M7 增量 2：工作单元与执行尝试分层 —— 派活侧全链测试。
 *
 * 覆盖：
 * ① 幽灵不可现：派活→失败回流→带 board_item_id 重派 = 板上始终一行（失败史留存、按新键结项）；
 * ② 条件门：有回流/待裁决活而未表态 → 拒绝且零痕迹（不登记/不挂行/不启动）；board_item_id / new_work 均放行；
 *    嵌套（subagent 来源）放行；人工退回的 pending 行不算候选；board_item_id 无效/终态/被占用 → 拒绝；
 * ③ 计划批准门：阶段 1（只读规划）不结项；批准轮回同一行；对已终态工作的追问仍新建（追问边界）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeResumeTask,
  executeTaskToolCall,
  setDelegationContextProvider,
  setTaskEnvironmentDestroyer,
} from '../../src/services/delegation/delegationTools.ts'
import { executeApprovePlan } from '../../src/services/delegation/approvePlanTool.ts'
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

async function setup(t: TestContext): Promise<{ svc: SessionBoardService; gates: Array<(v: Record<string, unknown>) => void> }> {
  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  modelInfoService.addModelInfo(FAKE_MODEL)
  resetTaskExecutor()
  resetTaskRegistry()
  getTemplateManager().setAllTemplates([
    { name: '测试模板', subagent_type: 'test-agent', priority: BUILTIN_PRIORITY, model: FAKE_MODEL.name } as SubagentTemplate,
  ])
  const dir = await mkdtemp(join(tmpdir(), 'attach-dispatch-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  const gates: Array<(v: Record<string, unknown>) => void> = []
  const executor: ISubagentExecutor = {
    execute: async () => new Promise<Record<string, unknown>>((res) => gates.push(res)),
  }
  getTaskExecutor(secureStorage, executor)
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
  return { svc, gates }
}

function makeCall(
  id: string,
  taskId: string,
  extra: Record<string, unknown> = {},
  sessionId = 'sess-1',
): ToolCall {
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
        ...extra,
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

const itemsOf = async (svc: SessionBoardService, sessionId = 'sess-1') => (await svc.readBoard(sessionId)).items

test('M7 增量 2：派活→失败回流→带 board_item_id 重派 = 全程一行，失败史留存', async (t) => {
  const { svc, gates } = await setup(t)

  // ① 首次派活（板空 → 门放行）→ 自动挂行并绑定 tc-1
  const first = await executeTaskToolCall(makeCall('tc-1', 'alias-1'), { toolMetadata: [], toolDefinitions: [] })
  assert.equal(first.status, 'running')
  await waitFor(() => gates.length === 1, '首个执行启动')
  let items = await itemsOf(svc)
  assert.equal(items.length, 1)
  const rowId = items[0]!.id
  assert.equal(items[0]!.claimedByTaskId, 'tc-1')
  assert.equal(items[0]!.status, 'in_progress')

  // ② 失败 → 回流认领池（failCount=1）；完成通知登记回流条目 id（重派写法的来源）
  gates[0]!({ status: 'failed', final_output: '', error_info: { message: '429 额度不足' } })
  await waitFor(async () => (await itemsOf(svc))[0]!.status === 'pending', '失败回流')
  // 板上回流先于通知登记（markBoardReflow 在 settle 桥返回之后），故这里要等登记、不能只看板
  await waitFor(() => (getTaskRegistry().getByToolCallId('tc-1')?.boardReflow?.length ?? 0) > 0, '回流条目登记到完成通知')
  items = await itemsOf(svc)
  assert.equal(items[0]!.failCount, 1)
  assert.equal(items[0]!.releaseHistory?.length, 1)
  assert.deepEqual(getTaskRegistry().getByToolCallId('tc-1')?.boardReflow, [rowId])

  // ③ 带回流条目 id 重派：不新增行，同一行开始第二次尝试
  await executeTaskToolCall(makeCall('tc-2', 'alias-2', { board_item_id: rowId }), {
    toolMetadata: [],
    toolDefinitions: [],
  })
  await waitFor(() => gates.length === 2, '重派执行启动')
  items = await itemsOf(svc)
  assert.equal(items.length, 1, '幽灵不可现：重派不产生第二行')
  assert.equal(items[0]!.id, rowId)
  assert.equal(items[0]!.status, 'in_progress')
  assert.equal(items[0]!.claimedByTaskId, 'tc-2')
  assert.equal(items[0]!.failCount, 1, '失败史留存')
  assert.equal(items[0]!.releaseHistory?.length, 1)

  // ④ 第二次尝试成功 → 同一行结项
  gates[1]!({ status: 'completed', final_output: '这次成了', conversation: CONVERSATION })
  await waitFor(async () => (await itemsOf(svc))[0]!.status === 'completed', '重派结项')
  items = await itemsOf(svc)
  assert.equal(items.length, 1)
  assert.match(items[0]!.result!, /这次成了/)
})

test('M7 增量 2 条件门：有回流活而未表态 → 拒绝且零痕迹；board_item_id / new_work / 嵌套派活均放行', async (t) => {
  const { svc, gates } = await setup(t)

  // 造一条回流行（第 1 次交付失败自动回流）
  const row = await svc.post('sess-1', { title: '上一轮失败的活', createdBy: 'lead' })
  await svc.claim('sess-1', row.id, { assignee: 'explore·A', claimedByTaskId: 'tc-old' })
  await svc.settleByTaskId('tc-old', 'failed')

  // ① 不表态 → 预检拒绝：点名候选 + 两条出路；零痕迹（不登记、不挂行、不启动）
  const denied = await executeTaskToolCall(makeCall('tc-2', 'alias-2'), { toolMetadata: [], toolDefinitions: [] })
  assert.equal(denied.status, 'failed')
  assert.equal(denied.error_info?.code, 'PREFLIGHT_FAILED')
  const msg = denied.error_info!.message!
  assert.match(msg, /待处置的失败活/)
  assert.match(msg, new RegExp(row.id))
  assert.match(msg, /board_item_id/)
  assert.match(msg, /new_work: true/)
  assert.equal(getTaskRegistry().getByToolCallId('tc-2'), undefined, '门拒绝=不登记')
  assert.equal((await itemsOf(svc)).length, 1, '门拒绝=不挂行')
  assert.equal(gates.length, 0, '门拒绝=不启动执行')

  // ② 带 new_work 声明（确是新活）→ 放行并新挂一行
  await executeTaskToolCall(makeCall('tc-3', 'alias-3', { new_work: true }), { toolMetadata: [], toolDefinitions: [] })
  await waitFor(() => gates.length === 1, '声明新活后启动')
  assert.equal((await itemsOf(svc)).length, 2)

  // ③ 带 board_item_id → 复用回流行（不新增）
  await executeTaskToolCall(makeCall('tc-4', 'alias-4', { board_item_id: row.id }), {
    toolMetadata: [],
    toolDefinitions: [],
  })
  await waitFor(() => gates.length === 2, '绑定复用后启动')
  const items = await itemsOf(svc)
  assert.equal(items.length, 2, '复用不新增行')
  assert.equal(items.find((i) => i.id === row.id)!.claimedByTaskId, 'tc-4')

  // ④ 嵌套派活（worker 来源）放行：子工作单元不可能知道会话里那条回流活的来历
  const nested = makeCall('tc-5', 'alias-5')
  const nestedArgs = JSON.parse(nested.function.arguments) as Record<string, unknown>
  nestedArgs.__origin = { source: 'subagent', handle: 'h2', sessionId: 'sess-1' }
  nested.function.arguments = JSON.stringify(nestedArgs)
  await executeTaskToolCall(nested, { toolMetadata: [], toolDefinitions: [] })
  await waitFor(() => gates.length === 3, '嵌套派活启动')
  assert.equal((await itemsOf(svc)).length, 3)

  // ⑤ 人工退回的 pending 行不算候选（人的决定 ≠ 失败尝试）→ 另一会话放行
  const released = await svc.post('sess-2', { title: '人工退回的活', createdBy: 'lead' })
  await svc.claim('sess-2', released.id, { assignee: 'explore·A', claimedByTaskId: 'tc-r1' })
  await svc.release('sess-2', released.id, { by: 'explore·A', reason: '需要专门领域知识' })
  await executeTaskToolCall(makeCall('tc-6', 'alias-6', {}, 'sess-2'), { toolMetadata: [], toolDefinitions: [] })
  await waitFor(() => gates.length === 4, '人工退回行不拦新活')
  assert.equal((await itemsOf(svc, 'sess-2')).length, 2)
})

test('M7 增量 2 条件门：board_item_id 无效 / 终态 / 被执行者占用 → 拒绝且零痕迹', async (t) => {
  const { svc, gates } = await setup(t)

  // ① 无效 id
  const bad = await executeTaskToolCall(makeCall('tc-a', 'alias-a', { board_item_id: 'no-such-row' }), {
    toolMetadata: [],
    toolDefinitions: [],
  })
  assert.equal(bad.status, 'failed')
  assert.match(bad.error_info!.message!, /找不到/)

  // ② 终态条目
  const done = await svc.post('sess-1', { title: '已交付的活', createdBy: 'lead' })
  await svc.claim('sess-1', done.id, { assignee: 'explore·A', claimedByTaskId: 'tc-d1' })
  await svc.settleByTaskId('tc-d1', 'completed', { result: '交付' })
  const revived = await executeTaskToolCall(makeCall('tc-b', 'alias-b', { board_item_id: done.id }), {
    toolMetadata: [],
    toolDefinitions: [],
  })
  assert.equal(revived.status, 'failed')
  assert.match(revived.error_info!.message!, /终态，不可复用/)

  // ③ 被执行者占用的在途条目
  const busy = await svc.post('sess-1', { title: '有人在做的活', createdBy: 'lead' })
  await svc.claim('sess-1', busy.id, { assignee: 'explore·B', claimedByTaskId: 'tc-hold' })
  const grabbed = await executeTaskToolCall(makeCall('tc-c', 'alias-c', { board_item_id: busy.id }), {
    toolMetadata: [],
    toolDefinitions: [],
  })
  assert.equal(grabbed.status, 'failed')
  assert.match(grabbed.error_info!.message!, /正由 tc-hold 执行中/)

  // 三次拒绝都零痕迹
  assert.equal(getTaskRegistry().getByToolCallId('tc-a'), undefined)
  assert.equal(getTaskRegistry().getByToolCallId('tc-b'), undefined)
  assert.equal(getTaskRegistry().getByToolCallId('tc-c'), undefined)
  assert.equal(gates.length, 0)
  assert.equal((await itemsOf(svc)).length, 2)
})

test('M7 增量 2 计划批准门：阶段 1 不结项；批准轮回同一行；对已终态工作的追问仍新建', async (t) => {
  const { svc, gates } = await setup(t)

  // ① 派一个带计划批准门的任务（板空 → 门放行）
  await executeTaskToolCall(makeCall('tc-plan', 'alias-plan', { require_plan: true }), {
    toolMetadata: [],
    toolDefinitions: [],
  })
  await waitFor(() => gates.length === 1, '计划阶段启动')
  let items = await itemsOf(svc)
  assert.equal(items.length, 1)
  const rowId = items[0]!.id
  assert.equal(items[0]!.claimedByTaskId, 'tc-plan')

  // ② 阶段 1 交付【计划】→ completed 但**不结项**（行留在进行中，不假报已交付）
  gates[0]!({ status: 'completed', final_output: '【待批准的计划】先 A 后 B', conversation: CONVERSATION })
  await new Promise((r) => setTimeout(r, 150))
  items = await itemsOf(svc)
  assert.equal(items[0]!.status, 'in_progress', '计划阶段不算活干完')
  assert.equal(items[0]!.result, undefined)

  // ③ 批准 → 续跑回同一行（不新增）
  const approved = await executeApprovePlan('tc-approve', { task_id: 'alias-plan', approved: true })
  assert.equal(approved.success, true, JSON.stringify(approved))
  await waitFor(() => gates.length === 2, '批准轮启动')
  items = await itemsOf(svc)
  assert.equal(items.length, 1, '批准轮不新增行')
  assert.equal(items[0]!.id, rowId)
  assert.equal(items[0]!.status, 'in_progress')
  assert.equal(items[0]!.claimedByTaskId, 'tc-approve')

  // ④ 正式执行完成 → 同一行结项
  gates[1]!({ status: 'completed', final_output: '正式执行交付', conversation: CONVERSATION })
  await waitFor(async () => (await itemsOf(svc))[0]!.status === 'completed', '批准轮结项')
  items = await itemsOf(svc)
  assert.equal(items.length, 1)
  assert.match(items[0]!.result!, /正式执行交付/)

  // ⑤ 边界：对**已终态**工作的追问 = 新工作单元（追问不动）
  const asked = await executeResumeTask('tc-ask', {
    toolCallId: 'tc-approve',
    message: '再补一问',
    __origin: { source: 'main', handle: 'h1', sessionId: 'sess-1' },
  } as never)
  assert.equal(asked.success, true, JSON.stringify(asked))
  await waitFor(() => gates.length === 3, '追问执行启动')
  items = await itemsOf(svc)
  assert.equal(items.length, 2, '追问已终态工作 → 新行')
  assert.equal(items.find((i) => i.id === rowId)!.status, 'completed', '原行不受影响')
})
