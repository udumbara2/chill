import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import {
  admitReviewSpawn,
  admitWorkflowSpawn,
  checkSpawnGates,
  computeGrantedOrchestration,
  enrollWorkerSpawn,
  resolveSpawnCaller,
} from '../../src/services/collab/admission.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

function memFs(): IFileSystemProvider & { written: Map<string, string> } {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const written = new Map<string, string>()
  return {
    written,
    getCurrentDirectory: () => null,
    readFile: async (p: string) =>
      written.has(norm(p)) ? { success: true, data: { content: written.get(norm(p))! } } : { success: false, error: 'nf' },
    writeFile: async (p: string, content: string) => {
      written.set(norm(p), content)
      return { success: true }
    },
    renameFile: async (from: string, to: string) => {
      written.set(norm(to), written.get(norm(from)) ?? '')
      written.delete(norm(from))
      return { success: true }
    },
    deleteFile: async () => ({ success: true }),
    listDirectory: async () => ({ success: true, data: { files: [] } }),
    fileExists: async () => ({ success: true, data: false }),
  } as unknown as IFileSystemProvider & { written: Map<string, string> }
}

let svc: TeamRuntimeService

beforeEach(async () => {
  resetTeamRuntimeService()
  resetTaskRegistry()
  svc = new TeamRuntimeService(memFs(), '/team-runs')
  setTeamRuntimeService(svc)
  await svc.formFromDefinition({ name: 'news-team', version: 1, members: [{ agent: 'researcher' }] })
})

// ---------- caller 解析 ----------

test('caller 解析:无 origin/非 subagent = lead;在册成员 taskId = member;未登记 taskId = lead', async () => {
  assert.equal(resolveSpawnCaller(undefined), 'lead')
  assert.equal(resolveSpawnCaller({ source: 'user' }), 'lead')
  await svc.registerMember({ agent: 'researcher', taskId: 't1' })
  assert.deepEqual(resolveSpawnCaller({ source: 'subagent', taskId: 't1' }), { member: 'researcher' })
  assert.equal(resolveSpawnCaller({ source: 'subagent', taskId: 'ghost' }), 'lead')
})

// ---------- 拉新门 ----------

test('拉新门:lead 放行;成员无授权拒绝;授权+预算+深度三闸', async () => {
  assert.equal(checkSpawnGates('lead'), null)
  await svc.registerMember({ agent: 'researcher', taskId: 't1', depth: 1 })
  assert.match(checkSpawnGates({ member: 'researcher' })!, /未授予你委派/)
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['task', 'team_board', 'send_message', 'team_policy:read'] } },
    'lead',
    'x',
  )
  assert.equal(checkSpawnGates({ member: 'researcher' }), null)
  await svc.updateSnapshot({ budget: { maxMembers: 1 } }, 'lead', 'x')
  assert.match(checkSpawnGates({ member: 'researcher' })!, /人数预算已达上限/)
  await svc.updateSnapshot({ budget: { maxDepth: 1 } }, 'lead', 'x')
  assert.match(checkSpawnGates({ member: 'researcher' })!, /嵌套深度超限/)
})

// ---------- 授权计算 ----------

test('授权计算:豁免只含编排工具;回退链(词干/模板/缺省);零工为空', async () => {
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['task', 'team_board', 'send_message', 'team_policy:read'], 'general-purpose': ['batch_task', 'send_message', 'team_policy:read'] } },
    'lead',
    'x',
  )
  assert.deepEqual(computeGrantedOrchestration('researcher', 'researcher'), ['task'])
  assert.deepEqual(computeGrantedOrchestration('researcher-2', 'researcher'), ['task']) // 词干回退
  assert.deepEqual(computeGrantedOrchestration('someone', 'general-purpose'), ['batch_task']) // 模板回退
  assert.deepEqual(computeGrantedOrchestration('someone', 'other'), []) // 缺省无编排
  assert.deepEqual(computeGrantedOrchestration(undefined, 'any'), []) // 零工
})

// ---------- 身份解析与登记(enroll) ----------

test('enroll:有队默认入队(成员名/团队标签/缺省豁免);as_teammate=false 退出;无服务不炸', async () => {
  const joined = await enrollWorkerSpawn({ caller: 'lead', agent: 'writer', taskId: 't9' })
  assert.equal(joined.joined, true)
  assert.equal(joined.memberName, 'writer')
  assert.equal(joined.teamLabel, '「news-team」')
  assert.equal(joined.depth, 1)
  assert.deepEqual(joined.grantedOrchestrationTools, [])
  assert.ok(svc.getActiveTeam()!.roster.some((e) => e.name === 'writer'))

  const out = await enrollWorkerSpawn({ caller: 'lead', agent: 'ghost', asTeammate: false, taskId: 't10' })
  assert.equal(out.joined, false)

  resetTeamRuntimeService()
  const noSvc = await enrollWorkerSpawn({ caller: 'lead', agent: 'x', taskId: 't11' })
  assert.equal(noSvc.joined, false)
})

test('enroll:成员拉新 depth=父+1;授权成员入队带豁免', async () => {
  await svc.registerMember({ agent: 'researcher', taskId: 't1', depth: 1 })
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['task', 'team_board', 'send_message', 'team_policy:read'] } },
    'lead',
    'x',
  )
  const child = await enrollWorkerSpawn({ caller: { member: 'researcher' }, agent: 'writer', taskId: 't2' })
  assert.equal(child.depth, 2)
  // researcher 有 task 授权 → 新成员按词干/模板回退查(此处新成员 writer 落缺省,无豁免)
  assert.deepEqual(child.grantedOrchestrationTools, [])
  // 给新成员按模板名授权后入队带豁免
  await svc.updateSnapshot(
    { grants: { lead: ['*'], writer: ['task', 'team_board', 'send_message', 'team_policy:read'] } },
    'lead',
    'x',
  )
  const child2 = await enrollWorkerSpawn({ caller: 'lead', agent: 'writer', memberName: 'writer-2', taskId: 't3' })
  assert.deepEqual(child2.grantedOrchestrationTools, ['task'])
})

// ---------- workflow / 评审回路 caller(迭代 3 语义钉死) ----------

test('workflow caller:匿名单元,永不入队(有活动团队也不变),roster/registry 零影响', async () => {
  const rosterBefore = svc.getActiveTeam()!.roster.length
  const registryBefore = getTaskRegistry().list().length
  const admission = admitWorkflowSpawn()
  assert.equal(admission.joined, false)
  assert.deepEqual(admission.grantedOrchestrationTools, [])
  assert.equal(svc.getActiveTeam()!.roster.length, rosterBefore, 'workflow 节点不得产生花名册条目')
  assert.equal(getTaskRegistry().list().length, registryBefore, 'workflow 节点不得产生注册表条目')
})

test('system:review caller:不计配额不计账本(评审回路内部 spawn 豁免,现状语义)', () => {
  const admission = admitReviewSpawn()
  assert.equal(admission.joined, false)
  assert.deepEqual(admission.grantedOrchestrationTools, [])
})
