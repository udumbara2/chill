import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseTeamDefinition, serializeTeam } from '../../src/team/teamSerializer.ts'
import { TeamRuntimeService, setTeamRuntimeService, resetTeamRuntimeService } from '../../src/services/team/TeamRuntimeService.ts'
import { executeApprovePlan } from '../../src/services/delegation/approvePlanTool.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { executeResumeTask } from '../../src/services/delegation/delegationTools.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

const noopFs = {
  writeFile: async () => ({ success: true }),
  renameFile: async () => ({ success: true }),
  readFile: async () => ({ success: false, error: 'nf' }),
  deleteFile: async () => ({ success: true }),
} as unknown as IFileSystemProvider

beforeEach(() => {
  resetTeamRuntimeService()
  resetTaskRegistry()
})

// ---------- DSL plan_first ----------

test('DSL: plan_first 解析/校验/序列化双向', () => {
  const withPlan = parseTeamDefinition(
    'name: t\nversion: 1\nmembers: [{agent: a, plan_first: true}, {agent: b}]',
  )
  assert.equal(withPlan.success, true, withPlan.error)
  assert.equal(withPlan.definition!.members[0].plan_first, true)
  assert.equal(withPlan.definition!.members[1].plan_first, undefined)

  // 非布尔报错
  assert.match(parseTeamDefinition('name: t\nversion: 1\nmembers: [{agent: a, plan_first: "yes"}]').error!, /plan_first 必须是布尔值/)

  // 序列化:真才写,假/缺省省略;往返无损
  const text = serializeTeam(withPlan.definition!)
  assert.ok(text.includes('plan_first: true'))
  const back = parseTeamDefinition(text).definition!
  assert.equal(back.members[0].plan_first, true)
  assert.equal(back.members[1].plan_first, undefined)
  const noPlan = parseTeamDefinition('name: t\nversion: 1\nmembers: [{agent: a}]').definition!
  assert.ok(!serializeTeam(noPlan).includes('plan_first'))
})

// ---------- roster planFirst ----------

test('roster: formFromDefinition 落地 planFirst;approve 语义独立于团队也可用', async () => {
  const svc = new TeamRuntimeService(noopFs, '/team-runs')
  setTeamRuntimeService(svc)
  await svc.formFromDefinition({
    name: 't', version: 1,
    members: [{ agent: 'a', plan_first: true }, { agent: 'b' }],
  })
  const roster = svc.getActiveTeam()!.roster
  assert.equal(roster[0].planFirst, true)
  assert.equal(roster[1].planFirst, undefined)
})

// ---------- planPending 生命周期 ----------

test('planPending: completed+requirePlan 置真;failed/cancel 置假;resumeMember 清除', async () => {
  const svc = new TeamRuntimeService(noopFs, '/team-runs')
  setTeamRuntimeService(svc)
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'a', taskId: 'call-1' })

  // 普通完成 → 不置真
  svc.syncOnTaskSettle('call-1', 'completed', 'call-1', false)
  assert.equal(svc.getActiveTeam()!.roster[0].planPending, undefined)

  // plan 任务完成 → 置真(同模板再次登记会派生新条目,按 currentTaskId 找)
  await svc.registerMember({ agent: 'a', taskId: 'call-2' })
  svc.syncOnTaskSettle('call-2', 'completed', 'call-2', true)
  const e2 = svc.getActiveTeam()!.roster.find((e) => e.currentTaskId === 'call-2')!
  assert.equal(e2.planPending, true)

  // resumeMember(approve 后续跑)→ 清除
  await svc.resumeMember(svc.getActiveTeam()!.runId, e2.name, 'call-3')
  assert.equal(e2.planPending, undefined)
})

// ---------- approve_plan ----------

type ResumeFn = typeof executeResumeTask
function fakeResume(calls: Array<{ id: string; args: Record<string, unknown> }>): ResumeFn {
  return (async (id: string, args: Record<string, unknown>) => {
    calls.push({ id, args })
    return { success: true, content: 'ok' }
  }) as unknown as ResumeFn
}

/** 造一条带计划的 transcript + 注册条目(可带 parent 链) */
function seedPlanTask(toolCallId: string, parentToolCallId?: string, planOriginalTools?: string[]) {
  const registry = getTaskRegistry()
  registry.register({
    taskId: toolCallId, toolCallId, subagentType: 'writer', description: 'd', batchId: 'b1',
    parentToolCallId,
  })
  registry.markSettled(toolCallId, { status: 'completed' as never, final_output: '计划全文' })
  registry.retainTranscript(toolCallId, {
    messages: [], subagentType: 'writer', taskDescription: 'd',
    requireReview: true, availableTools: ['read_file'],
    requirePlan: true, planOriginalTools,
  })
}

test('approve_plan: 参数与目标校验(缺 task_id / 无上下文 / 非 plan 任务 / 打回缺 feedback)', async () => {
  assert.match((await executeApprovePlan('c0', {})).error!, /需要.*task_id/)
  assert.match((await executeApprovePlan('c1', { task_id: 'ghost' })).error!, /无执行上下文/)

  seedPlanTask('root-1')
  // 非 plan 任务:重写 transcript 去掉 requirePlan
  getTaskRegistry().retainTranscript('plain-1', { messages: [], subagentType: 'x', taskDescription: 'd' })
  assert.match((await executeApprovePlan('c2', { task_id: 'plain-1' })).error!, /不是计划批准门任务/)

  assert.match((await executeApprovePlan('c3', { task_id: 'root-1', approved: false })).error!, /feedback/)
  assert.match((await executeApprovePlan('c4', { task_id: 'root-1' })).error!, /approved/)
})

test('approve_plan 批准: 根任务 planOriginalTools 扩容 + requireReview 透传 + 计数清理', async () => {
  seedPlanTask('root-2', undefined, ['read_file', 'create_file'])
  const calls: Array<{ id: string; args: Record<string, unknown> }> = []
  const r = await executeApprovePlan('approve-1', { task_id: 'root-2', approved: true }, { resume: fakeResume(calls) })
  assert.equal(r.success, true, r.error)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.available_tools, ['read_file', 'create_file'])
  assert.equal(calls[0].args.require_review, true)
  assert.match(calls[0].args.message as string, /计划已批准/)
})

test('approve_plan 批准: planOriginalTools 缺省 → 透传 undefined(模板默认;切勿 [all]——available_tools 无 all 关键字)', async () => {
  seedPlanTask('root-3', undefined, undefined)
  const calls: Array<{ id: string; args: Record<string, unknown> }> = []
  await executeApprovePlan('approve-2', { task_id: 'root-3', approved: true }, { resume: fakeResume(calls) })
  assert.equal(calls[0].args.available_tools, undefined)
  // 阶段 2 不再只读
  assert.equal(calls[0].args.require_plan, false)
})

test('approve_plan 打回: 只读集 + 反馈;轮次沿 parentToolCallId 归并,两轮后第三轮拒绝并指引', async () => {
  seedPlanTask('root-4')
  const registry = getTaskRegistry()
  const calls: Array<{ id: string; args: Record<string, unknown> }> = []

  // 第一轮打回(root-4)
  const r1 = await executeApprovePlan('a1', { task_id: 'root-4', approved: false, feedback: '结构重写' }, { resume: fakeResume(calls) })
  assert.equal(r1.success, true, r1.error)
  assert.deepEqual(calls[0].args.available_tools, ['read_file']) // 只读留存集
  assert.equal(calls[0].args.require_plan, true) // 打回轮保持只读规划
  assert.match(calls[0].args.message as string, /第 1\/2 轮/)

  // 模拟第一轮打回的 resume 注册与留存(follow-up 链)
  registry.register({
    taskId: 'root-4-followup', toolCallId: 'root-4-followup', subagentType: 'writer', description: '追问', batchId: 'b2',
    parentToolCallId: 'root-4',
  })
  registry.retainTranscript('root-4-followup', {
    messages: [], subagentType: 'writer', taskDescription: '追问',
    availableTools: ['read_file'], requirePlan: true, planOriginalTools: undefined,
  })

  // 第二轮打回(follow-up id)→ 归并到根,计数为 2
  const r2 = await executeApprovePlan('a2', { task_id: 'root-4-followup', approved: false, feedback: '再改' }, { resume: fakeResume(calls) })
  assert.equal(r2.success, true, r2.error)
  assert.match(calls[1].args.message as string, /第 2\/2 轮/)

  // 第三轮 → 封顶拒绝,不再发起 resume
  const before = calls.length
  const r3 = await executeApprovePlan('a3', { task_id: 'root-4-followup', approved: false, feedback: '还改' }, { resume: fakeResume(calls) })
  assert.equal(r3.success, false)
  assert.match(r3.error!, /上限/)
  assert.match(r3.error!, /cancel_task/)
  assert.equal(calls.length, before)
})

test('approve_plan 批准: 打回轮中批准 → 从根任务 transcript 读 planOriginalTools(链条污染免疫)', async () => {
  seedPlanTask('root-5', undefined, ['create_file'])
  const registry = getTaskRegistry()
  // 打回轮的 transcript 留存会用只读集覆盖 planOriginalTools(模拟污染)
  registry.register({
    taskId: 'root-5-followup', toolCallId: 'root-5-followup', subagentType: 'writer', description: '追问', batchId: 'b2',
    parentToolCallId: 'root-5',
  })
  registry.retainTranscript('root-5-followup', {
    messages: [], subagentType: 'writer', taskDescription: '追问',
    availableTools: ['read_file'], requirePlan: true, planOriginalTools: ['read_file'],
  })
  const calls: Array<{ id: string; args: Record<string, unknown> }> = []
  const r = await executeApprovePlan('a9', { task_id: 'root-5-followup', approved: true }, { resume: fakeResume(calls) })
  assert.equal(r.success, true, r.error)
  assert.deepEqual(calls[0].args.available_tools, ['create_file'])
})

test('回归: YAML plan_first 驱动(原始 args 无 require_plan)→ transcript 记录有效值,approve_plan 不拒收', async (t) => {
  // 全管道装配(仿 delegationAsync 基建):假执行器 + 假模型 + 测试模板 + 团队(YAML plan_first)
  const {
    executeTaskToolCalls,
  } = await import('../../src/services/delegation/delegationTools.ts')
  const { getTaskExecutor, resetTaskExecutor } = await import('../../src/orchestrator/executor/TaskExecutor.ts')
  const { getTemplateManager, resetTemplateManager } = await import('../../src/orchestrator/managers/SubagentTemplateManager.ts')
  const { modelInfoService } = await import('../../src/services/models/modelInfoService.ts')
  const { SelectedModelsService } = await import('../../src/services/selectedModelsService.ts')

  const originalModels = modelInfoService.getAllModelInfos()
  modelInfoService.clearAllModelInfos()
  modelInfoService.addModelInfo({
    type: 'glm', name: 'fake-model', displayName: 'fake-model', provider: 'TestProvider', builtIn: false,
    description: '', adapterConfig: { protocol: 'openai-chat', baseURL: 'https://api.test/fake', defaultModel: 'fake-model' },
    supportedModalities: [], apiURL: '', availableModels: ['fake-model'], supportedParameters: [],
    maxOutputTokens: 4000, maxContextTokens: 8000, supportsStreaming: false, supportsTools: false,
    supportsThinking: false, version: '1', documentation: '',
  } as never)
  const sessionService = SelectedModelsService.getInstance()
  const originalStore = (sessionService as any)._store
  SelectedModelsService.setDefaultStore({
    get: async () => null, set: async () => {}, delete: async () => {}, getAll: async () => ({}),
  } as never)
  resetTaskExecutor()
  getTemplateManager().setAllTemplates([{ name: '写手', subagent_type: 'writer-agent', priority: 3, model: 'fake-model' } as never])
  const { secureStorage } = await import('../../src/services/secureStorageService.ts').catch(() => ({ secureStorage: undefined as never }))
  void secureStorage
  let settle!: (v: Record<string, unknown>) => void
  const gate = new Promise<Record<string, unknown>>((res) => { settle = res })
  getTaskExecutor({ getApiKey: async () => 'fake-key' } as never, { execute: async () => gate } as never)
  t.after(() => {
    modelInfoService.clearAllModelInfos()
    for (const m of originalModels) modelInfoService.addModelInfo(m)
    ;(sessionService as any)._store = originalStore
    resetTaskExecutor()
    resetTemplateManager()
  })

  // 团队:writer-agent 开 plan_first(YAML 驱动)
  const svc = new TeamRuntimeService(noopFs, '/team-runs')
  setTeamRuntimeService(svc)
  await svc.formFromDefinition({ name: 'plan-team', version: 1, members: [{ agent: 'writer-agent', plan_first: true }] })

  // 委派:不带 require_plan 参数(纯 YAML 驱动)
  const toolCall = {
    id: 'tc-plan-1', type: 'function',
    function: {
      name: 'task',
      arguments: JSON.stringify({
        task_id: 'plan-alias-1', subagent_type: 'writer-agent', task_description: '写稿', success_criteria: '完成',
      }),
    },
  } as never
  await executeTaskToolCalls([toolCall], { toolMetadata: [], toolDefinitions: [] } as never)
  settle({ status: 'completed', final_output: '【待批准的计划】……', conversation: [{ role: 'user', content: 'x' }] })
  await new Promise((r) => setTimeout(r, 0))

  // 关键断言:transcript 记录了有效 requirePlan;approve_plan 批准不再被拒
  const transcript = getTaskRegistry().getTranscript('tc-plan-1')
  assert.equal(transcript?.requirePlan, true, 'YAML plan_first 驱动时 transcript 必须记录有效 requirePlan')
  const calls: Array<{ id: string; args: Record<string, unknown> }> = []
  const r = await executeApprovePlan('ap-1', { task_id: 'plan-alias-1', approved: true }, { resume: fakeResume(calls) })
  assert.equal(r.success, true, r.error)
  assert.equal(calls.length, 1)
})

test('approve_plan 门归属: 入编排黑名单 + plan 只读门', async () => {
  const { ORCHESTRATION_TOOL_NAMES } = await import('../../src/orchestrator/types.ts')
  const { PLAN_MODE_BLOCKED_TOOLS } = await import('../../src/orchestrator/toolPolicy.ts')
  assert.ok(ORCHESTRATION_TOOL_NAMES.includes('approve_plan'))
  assert.ok(PLAN_MODE_BLOCKED_TOOLS.includes('approve_plan'))
})

test('planRounds: markCancelled 清理计数', async () => {
  const registry = getTaskRegistry()
  seedPlanTask('root-6')
  registry.incrementPlanRound('root-6')
  registry.incrementPlanRound('root-6')
  // 取消根任务 → 清理(再注册同名新任务后重新计数从 1 开始)
  registry.register({ taskId: 'root-6-cancel', toolCallId: 'root-6-cancel', subagentType: 'w', description: '', batchId: 'b3' })
  registry.markCancelled('root-6-cancel')
  registry.clearPlanRounds('root-6')
  assert.equal(registry.incrementPlanRound('root-6'), 1)
})
