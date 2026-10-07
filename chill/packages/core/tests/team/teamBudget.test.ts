import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import { executeTeamBoard } from '../../src/services/team/teamBoardTool.ts'
import { executeTeamPolicy } from '../../src/services/team/teamPolicyTool.ts'
import { executeTeamStatus } from '../../src/services/team/teamBoardTool.ts'
import { setTeamBudgetDefaultsProvider } from '../../src/services/team/teamPolicy.ts'
import { checkSpawnGates } from '../../src/services/collab/admission.ts'
import { resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'
import type { ToolCall } from '../../src/types/models.ts'

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

afterEach(() => {
  setTeamBudgetDefaultsProvider(null)
})

/** 按成员名判拉新门(admission 纯判定;原经 delegationTools 薄包装的调用形态已于迭代 2 退役) */
/** 按成员名判拉新门(admission 纯判定;原经 delegationTools 薄包装的调用形态已于迭代 2 退役) */
function spawnGateFor(memberName: string): string | null {
  return checkSpawnGates({ member: memberName })
}

// ---------- 账本 ----------

test('memberCount:新建条目才计数,standby 复用不占新名额', async () => {
  assert.equal(svc.getActiveTeam()!.ledger!.memberCount, 1) // 成队时 roster=1
  await svc.registerMember({ agent: 'writer', taskId: 't1' })
  assert.equal(svc.getActiveTeam()!.ledger!.memberCount, 2)
  // standby 复用(researcher 在册 standby)→ 不增
  await svc.registerMember({ agent: 'researcher', taskId: 't2' })
  assert.equal(svc.getActiveTeam()!.ledger!.memberCount, 2)
})

test('addTokenSpend:聚合入账;undefined/0 不入账;null 起点转数值', async () => {
  assert.equal(svc.getActiveTeam()!.ledger!.spentTokens, null)
  svc.addTokenSpend(undefined)
  svc.addTokenSpend(0)
  assert.equal(svc.getActiveTeam()!.ledger!.spentTokens, null)
  svc.addTokenSpend(120)
  svc.addTokenSpend(80)
  assert.equal(svc.getActiveTeam()!.ledger!.spentTokens, 200)
})

test('addTokenSpend:估值置位(estimated 单向)——任一笔估值置真,后续实测不清除', async () => {
  const ledger = svc.getActiveTeam()!.ledger!
  assert.equal(ledger.estimated, undefined)
  svc.addTokenSpend(120, true) // 估值入账
  assert.equal(ledger.estimated, true)
  svc.addTokenSpend(80) // 实测入账:单向,不清除估值标记
  assert.equal(ledger.spentTokens, 200)
  assert.equal(ledger.estimated, true)
  svc.addTokenSpend(50, true) // 混合置位保持
  assert.equal(ledger.estimated, true)
})

test('addTokenSpend:无入账(null/0/undefined)时 estimated 不置位,账本保"未知"态', async () => {
  const ledger = svc.getActiveTeam()!.ledger!
  svc.addTokenSpend(undefined, true)
  svc.addTokenSpend(0, true)
  assert.equal(ledger.spentTokens, null)
  assert.equal(ledger.estimated, undefined)
})

test('depth:registerMember 记录嵌套深度', async () => {
  const { entry } = await svc.registerMember({ agent: 'writer', taskId: 't1', depth: 2 })
  assert.equal(entry.depth, 2)
})

// ---------- 成员拉新门 ----------

test('拉新门:Lead 发起/队外来源不拦(向后兼容红线)', async () => {
  const leadCall = {
    id: 'c1',
    function: { name: 'task', arguments: JSON.stringify({ subagent_type: 'x', task_description: 'y' }) },
  } as unknown as ToolCall
  assert.equal(checkSpawnGates('lead'), null)
  // 无团队时:lead 判定仍放行;成员在无活动团队属异常(响亮报出)
  resetTeamRuntimeService()
  assert.equal(checkSpawnGates('lead'), null)
  assert.match(spawnGateFor('researcher')!, /不在任何活动团队/)
})

test('拉新门:成员无 task 授权 → 拒绝并指引请示(默认快照即此态)', async () => {
  await svc.registerMember({ agent: 'researcher', taskId: 't1' })
  const err = spawnGateFor('researcher')
  assert.match(err!, /未授予你委派/)
  assert.match(err!, /send_message/)
})

test('拉新门:授权后放行;人数预算满 → 硬闸拒绝', async () => {
  await svc.registerMember({ agent: 'researcher', taskId: 't1' })
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['task', 'team_board', 'send_message', 'team_policy:read'] } },
    'lead',
    '授予拉新',
  )
  assert.equal(spawnGateFor('researcher'), null)
  // 人数预算 1(在册已有 researcher,拉新=第 2 人超限)
  await svc.updateSnapshot({ budget: { maxMembers: 1 } }, 'lead', '收紧人数')
  const err = spawnGateFor('researcher')
  assert.match(err!, /人数预算已达上限/)
})

test('拉新门:token 预算耗尽 → 扩张闸拒绝(进行中任务不受影响);无计量数据不拦', async () => {
  await svc.registerMember({ agent: 'researcher', taskId: 't1' })
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['task', 'team_board', 'send_message', 'team_policy:read'] }, budget: { maxTokens: 1000 } },
    'lead',
    'x',
  )
  assert.equal(spawnGateFor('researcher'), null) // spentTokens=null → 闸不生效
  svc.addTokenSpend(1500)
  const err = spawnGateFor('researcher')
  assert.match(err!, /token 预算已耗尽/)
  assert.doesNotMatch(err!, /含估值/) // 全实测不带估值标注
})

test('拉新门:估值入账破预算 → 拦截理由带"(含估值)"(估值得出的拦截必须可识别)', async () => {
  await svc.registerMember({ agent: 'researcher', taskId: 't1' })
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['task', 'team_board', 'send_message', 'team_policy:read'] }, budget: { maxTokens: 1000 } },
    'lead',
    'x',
  )
  svc.addTokenSpend(1500, true) // 估值入账
  const err = spawnGateFor('researcher')
  assert.match(err!, /token 预算已耗尽/)
  assert.match(err!, /\(含估值\)/)
})

test('拉新门:深度帽(成员深度 1,maxDepth=2 → 拉新达 2 放行;maxDepth=1 → 拒)', async () => {
  await svc.registerMember({ agent: 'researcher', taskId: 't1', depth: 1 })
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['task', 'team_board', 'send_message', 'team_policy:read'] }, budget: { maxDepth: 2 } },
    'lead',
    'x',
  )
  assert.equal(spawnGateFor('researcher'), null)
  await svc.updateSnapshot({ budget: { maxDepth: 1 } }, 'lead', 'x')
  assert.match(spawnGateFor('researcher')!, /嵌套深度超限/)
})

test('拉新门:派生实例命中词干授权(实测 bug:授 reader-a,实例 reader-a-2 也应有拉新权)', async () => {
  // 两次注册同名成员 → 第二次派生为 researcher-2
  await svc.registerMember({ agent: 'researcher', memberName: 'researcher', taskId: 't1' })
  await svc.registerMember({ agent: 'researcher', memberName: 'researcher', taskId: 't2' })
  const roster = svc.getActiveTeam()!.roster.map((e) => e.name)
  assert.ok(roster.includes('researcher-2'), `应派生出 researcher-2,实际: ${roster}`)
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['task', 'team_board', 'send_message', 'team_policy:read'] } },
    'lead',
    '授予词干名',
  )
  assert.equal(spawnGateFor('researcher-2'), null)
})

// ---------- team_policy 预算越界闸 ----------

test('team_policy 预算越系统默认上限 → deny;限内放行', async () => {
  setTeamBudgetDefaultsProvider(() => ({ maxMembers: 5 }))
  const denied = await executeTeamPolicy(JSON.stringify({ action: 'update', budget: { max_members: 10 }, note: '扩到 10' }))
  assert.equal(denied.success, false)
  assert.match(denied.error!, /超过系统默认/)
  const ok = await executeTeamPolicy(JSON.stringify({ action: 'update', budget: { max_members: 3 }, note: '收紧到 3' }))
  assert.equal(ok.success, true)
})

// ---------- team_status 预算段 ----------

test('team_status:预算段展示账本/上限(未知 token 态明示)', async () => {
  const res = await executeTeamStatus('{}')
  assert.equal(res.success, true)
  assert.match(res.data!, /## 预算:人数 1\/不限 · token 未知\/不限 · 深度上限 不限/)
  svc.addTokenSpend(300)
  const res2 = await executeTeamStatus('{}')
  assert.match(res2.data!, /token 300\/不限/)
})

test('team_status:估值入账展示 ~N(估值)(三态走 core 单一格式化点)', async () => {
  svc.addTokenSpend(300, true)
  const res = await executeTeamStatus('{}')
  assert.match(res.data!, /token ~300\(估值\)\/不限/)
  // 混合(先估值后实测):单向置位,仍标估值
  svc.addTokenSpend(100)
  const res2 = await executeTeamStatus('{}')
  assert.match(res2.data!, /token ~400\(估值\)\/不限/)
})
