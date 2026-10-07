import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import { executeTeamBoard } from '../../src/services/team/teamBoardTool.ts'
import { resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
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
  await svc.formFromDefinition({
    name: 'news-team',
    version: 1,
    members: [{ agent: 'researcher' }, { agent: 'writer' }],
  })
})

async function postItem(title = '调研任务'): Promise<string> {
  const res = await executeTeamBoard(JSON.stringify({ action: 'post', title }))
  assert.equal(res.success, true)
  return /\[(\w+)\]/.exec(res.data!)![1]
}

/** 成员身份调用(taskId 经 registerMember 绑定) */
async function asMember(agent: string, taskId: string, payload: object) {
  await svc.registerMember({ agent, taskId })
  return executeTeamBoard(JSON.stringify(payload), { source: 'subagent', taskId })
}

test('release: 认领人退回 → 回到待认领 + 认领人清空 + 历史留痕', async () => {
  const id = await postItem()
  const claim = await asMember('researcher', 't1', { action: 'claim', id })
  assert.equal(claim.success, true)
  const rel = await executeTeamBoard(
    JSON.stringify({ action: 'release', id, reason: '需要专门领域知识', suggested_to: 'writer' }),
    { source: 'subagent', taskId: 't1' },
  )
  assert.equal(rel.success, true)
  const item = svc.boardGet(id)!
  assert.equal(item.status, 'pending')
  assert.equal(item.assignee, undefined)
  assert.equal(item.releaseHistory!.length, 1)
  assert.equal(item.releaseHistory![0].reason, '需要专门领域知识')
  assert.equal(item.releaseHistory![0].suggestedTo, 'writer')
})

test('release: 他人不能退回我的任务;缺原因拒绝;非进行中拒绝', async () => {
  const id = await postItem()
  await asMember('researcher', 't1', { action: 'claim', id })
  const byOther = await asMember('writer', 't2', { action: 'release', id, reason: '抢活' })
  assert.equal(byOther.success, false)
  assert.match(byOther.error!, /仅认领人或 Lead/)
  const noReason = await executeTeamBoard(JSON.stringify({ action: 'release', id }), { source: 'subagent', taskId: 't1' })
  assert.equal(noReason.success, false)
  assert.match(noReason.error!, /reason/)
  const notInProgress = await executeTeamBoard(JSON.stringify({ action: 'release', id: await postItem(), reason: 'x' }))
  assert.equal(notInProgress.success, false)
  assert.match(notInProgress.error!, /进行中/)
})

test('release: Lead 退回成员任务 → 原认领人收到通知(信箱)', async () => {
  const id = await postItem()
  await asMember('researcher', 't1', { action: 'claim', id })
  const rel = await executeTeamBoard(JSON.stringify({ action: 'release', id, reason: '优先级调整' }))
  assert.equal(rel.success, true)
  const unread = await svc.unreadCounts()
  assert.ok((unread['researcher'] ?? 0) >= 1, '原认领人信箱应有通知')
  const msgs = await svc.drainInbox('researcher')
  assert.match(msgs.map((m) => m.content).join('\n'), /退回归领池/)
})

test('授权门控:快照收走 claim 后成员认领被响亮拒绝并指引请示;放开后恢复', async () => {
  const id = await postItem()
  await svc.registerMember({ agent: 'researcher', taskId: 't1' })
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['team_board:post', 'team_board:read', 'send_message', 'team_policy:read'] } },
    'lead',
    '收紧:不许认领',
  )
  const denied = await executeTeamBoard(JSON.stringify({ action: 'claim', id }), { source: 'subagent', taskId: 't1' })
  assert.equal(denied.success, false)
  assert.match(denied.error!, /未授予你 team_board 的 claim 权限/)
  assert.match(denied.error!, /send_message/)
  await svc.updateSnapshot(
    { grants: { lead: ['*'], researcher: ['team_board', 'send_message', 'team_policy:read'] } },
    'lead',
    '放开',
  )
  const allowed = await executeTeamBoard(JSON.stringify({ action: 'claim', id }), { source: 'subagent', taskId: 't1' })
  assert.equal(allowed.success, true)
})

test('授权门控:默认快照(零行为变化红线)——成员 claim/release 全放行', async () => {
  const id = await postItem()
  const claim = await asMember('researcher', 't1', { action: 'claim', id })
  assert.equal(claim.success, true)
  const rel = await executeTeamBoard(JSON.stringify({ action: 'release', id, reason: 'x' }), { source: 'subagent', taskId: 't1' })
  assert.equal(rel.success, true)
})

test('post: stagnation_after 写入条目;非法值拒绝;read 单项展示退回历史', async () => {
  const bad = await executeTeamBoard(JSON.stringify({ action: 'post', title: 'x', stagnation_after: -5 }))
  assert.equal(bad.success, false)
  const res = await executeTeamBoard(JSON.stringify({ action: 'post', title: '调研', stagnation_after: 30 }))
  assert.equal(res.success, true)
  const id = /\[(\w+)\]/.exec(res.data!)![1]
  assert.equal(svc.boardGet(id)!.stagnationAfter, 30)
  await asMember('researcher', 't1', { action: 'claim', id })
  await executeTeamBoard(JSON.stringify({ action: 'release', id, reason: '信息不足' }), { source: 'subagent', taskId: 't1' })
  const read = await executeTeamBoard(JSON.stringify({ action: 'read', id }))
  assert.match(read.data!, /静默容忍: 30 分钟/)
  assert.match(read.data!, /退回历史/)
  assert.match(read.data!, /信息不足/)
})

test('认领人死亡/被取消:其进行中条目自动回流认领池(settle 回写点;实测教训回归)', async () => {
  const id = await postItem()
  await asMember('researcher', 't1', { action: 'claim', id })
  assert.equal(svc.boardGet(id)!.status, 'in_progress')
  svc.syncOnTaskSettle('t1', 'failed')
  const item = svc.boardGet(id)!
  assert.equal(item.status, 'pending')
  assert.equal(item.assignee, undefined)
  assert.equal(item.releaseHistory!.length, 1)
  assert.equal(item.releaseHistory![0].by, 'system')
  assert.match(item.releaseHistory![0].reason, /失败/)
})

test('认领人完成交付:不回流而是自动结项(结项闭环;claimedByTaskId 绑定匹配)', async () => {
  const id = await postItem()
  await asMember('researcher', 't1', { action: 'claim', id })
  svc.syncOnTaskSettle('t1', 'completed')
  // completed 不触发死亡回流(那是 failed/cancelled 的事),而是自动结项
  assert.equal(svc.boardGet(id)!.status, 'completed')
  assert.match(svc.boardGet(id)!.result!, /自动结项/)
})

test('认领人被取消:条目同样自动回流', async () => {
  const id = await postItem()
  await asMember('researcher', 't1', { action: 'claim', id })
  svc.syncOnTaskSettle('t1', 'cancelled')
  assert.equal(svc.boardGet(id)!.status, 'pending')
  assert.match(svc.boardGet(id)!.releaseHistory![0].reason, /被取消/)
})

// ---------- 结项闭环(claimedByTaskId 数据绑定) ----------

test('结项闭环:绑定本任务的条目在 completed 时自动结项(含 result 与标注)', async () => {
  const id = await postItem()
  await asMember('researcher', 't1', { action: 'claim', id })
  const item = svc.boardGet(id)!
  assert.equal(item.claimedByTaskId, 't1', 'claim 时记录任务绑定')
  svc.syncOnTaskSettle('t1', 'completed', undefined, undefined, '交付物全文')
  const after = svc.boardGet(id)!
  assert.equal(after.status, 'completed')
  assert.match(after.result!, /交付物全文/)
  assert.match(after.result!, /\(自动结项:认领人任务交付\)/)
})

test('结项闭环:lead 认领的条目无绑定,不自动结项(lead 的活 lead 自己结)', async () => {
  const id = await postItem()
  const claim = await executeTeamBoard(JSON.stringify({ action: 'claim', id })) // 无 origin → lead 认领
  assert.equal(claim.success, true)
  assert.equal(svc.boardGet(id)!.claimedByTaskId, undefined, 'lead 认领不记录绑定')
  svc.syncOnTaskSettle('t1', 'completed', undefined, undefined, '某成员的交付')
  assert.equal(svc.boardGet(id)!.status, 'in_progress')
})

test('结项闭环:requirePlan 完成(阶段 1)不结项;批准轮(无 requirePlan)结项', async () => {
  const id = await postItem()
  await asMember('researcher', 't1', { action: 'claim', id })
  svc.syncOnTaskSettle('t1', 'completed', undefined, true, '阶段1计划')
  assert.equal(svc.boardGet(id)!.status, 'in_progress', '阶段 1 完成 ≠ 活干完,不结项')
  // 批准轮:resumeMember 换绑 t1→t2,完成后(无 requirePlan)应结项
  await svc.resumeMember(svc.getActiveTeam()!.runId, 'researcher', 't2')
  assert.equal(svc.boardGet(id)!.claimedByTaskId, 't2', 'resumeMember 换绑同步改绑')
  svc.syncOnTaskSettle('t2', 'completed', undefined, false, '正式交付')
  assert.equal(svc.boardGet(id)!.status, 'completed')
})

test('结项闭环:误结边界——别的任务的 settle 不误结本条目', async () => {
  const id = await postItem()
  await asMember('researcher', 't1', { action: 'claim', id })
  // 另一个成员/另一任务 settle:本条目绑定 t1,不应被 t-other 结项
  svc.syncOnTaskSettle('t-other', 'completed', undefined, undefined, '别的交付')
  assert.equal(svc.boardGet(id)!.status, 'in_progress')
})
