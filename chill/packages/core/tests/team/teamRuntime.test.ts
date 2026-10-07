import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
  getTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import { executeTeamBoard, executeTeamStatus } from '../../src/services/team/teamBoardTool.ts'
import { TeamTemplateService, setTeamServiceForIndex } from '../../src/services/team/TeamTemplateService.ts'
import { executeUseTeam } from '../../src/services/team/useTeamTool.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { BOARD_RESULT_MAX_CHARS } from '../../src/services/team/teamRuntimeTypes.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

const VALID = `
name: news-team
version: 1
title: 热点团队
description: 调研+撰稿的热点生产班底
members:
  - agent: researcher
    role: 调研员
  - agent: writer
    role: 撰稿人
`

const TEAM_B = 'name: ops-team\nversion: 1\nmembers: [{agent: ops}]'

/** 内存 fs 桩(支持 renameFile,记录全部写入以验证原子写与快照内容) */
function memFs(files: Record<string, string> = {}): IFileSystemProvider & { written: Map<string, string> } {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const written = new Map<string, string>()
  return {
    written,
    getCurrentDirectory: () => null,
    readFile: async (p: string) =>
      written.has(norm(p))
        ? { success: true, data: { content: written.get(norm(p))! } }
        : files[norm(p)] !== undefined
          ? { success: true, data: { content: files[norm(p)] } }
          : { success: false, error: 'nf' },
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
    listDirectory: async (dir: string) => ({
      success: true,
      data: { files: Object.keys(files).filter((f) => f.startsWith(norm(dir) + '/')).map((f) => ({ name: f.slice(norm(dir).length + 1), type: 'file' })) },
    }),
    fileExists: async (p: string) => ({ success: true, data: norm(p) in files }),
  } as unknown as IFileSystemProvider & { written: Map<string, string> }
}

function makeRuntime(fs?: IFileSystemProvider & { written: Map<string, string> }): TeamRuntimeService {
  const svc = new TeamRuntimeService(fs ?? memFs(), '/team-runs')
  setTeamRuntimeService(svc)
  return svc
}

async function formNewsTeam(svc: TeamRuntimeService): Promise<string> {
  const { runId } = await svc.formFromDefinition({
    name: 'news-team',
    version: 1,
    members: [
      { agent: 'researcher', role: '调研员' },
      { agent: 'writer', role: '撰稿人' },
    ],
  })
  return runId
}

beforeEach(() => {
  resetTeamRuntimeService()
  resetTaskRegistry()
})

// ---------- 成队与生命周期 ----------

test('成队: use_team 路径按 YAML 落地 roster(standby),快照原子写落盘', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  const runId = await formNewsTeam(svc)
  assert.match(runId, /^news-team-\d+-[a-z0-9]+$/)
  const team = svc.getActiveTeam()!
  assert.equal(team.name, 'news-team')
  assert.deepEqual(team.roster.map((e) => [e.name, e.status]), [
    ['researcher', 'standby'],
    ['writer', 'standby'],
  ])
  assert.equal(team.roster[0].role, '调研员')
  // 原子写:tmp+rename,最终文件存在且无 .tmp 残留
  const rosterSnap = fs.written.get(`/team-runs/${runId}/roster.json`)
  const boardSnap = fs.written.get(`/team-runs/${runId}/board.json`)
  assert.ok(rosterSnap && boardSnap)
  assert.ok(![...fs.written.keys()].some((k) => k.endsWith('.tmp')))
  assert.deepEqual(JSON.parse(rosterSnap).roster.length, 2)
  assert.equal(JSON.parse(boardSnap).boardRevision, 0)
})

test('成队: ad-hoc 惰性成队(ensureAdHocTeam 无队时建临时队,有队时复用)', async () => {
  const svc = makeRuntime()
  const t1 = svc.ensureAdHocTeam()
  assert.match(t1.runId, /^adhoc-/)
  assert.equal(t1.name, undefined)
  const t2 = svc.ensureAdHocTeam()
  assert.equal(t2.runId, t1.runId)
})

test('换队: 异名 use_team 归档当前队(含 ad-hoc)再成新队;归档解除钉住', async () => {
  const svc = makeRuntime()
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })
  // 钉住一条该队成员的 transcript
  getTaskRegistry().retainTranscript('call-1', {
    messages: [], subagentType: 'researcher', taskDescription: 'x',
    pinned: true, teamId: svc.getActiveTeam()!.runId, memberName: 'researcher',
  })
  const { runId, archivedRunId } = await svc.formFromDefinition({
    name: 'news-team', version: 1, members: [{ agent: 'researcher' }],
  })
  assert.ok(archivedRunId?.startsWith('adhoc-'))
  assert.notEqual(runId, archivedRunId)
  assert.deepEqual(svc.getActiveTeam()!.roster.map((e) => e.status), ['standby'])
  // 旧队钉住已解除
  assert.equal(getTaskRegistry().getTranscript('call-1')!.pinned, false)
})

test('use_team 端到端: 同名幂等(重复调用不动 roster/board);异名归档换队;未装配降级', async () => {
  const fs = memFs({ '/user/teams/news-team.yaml': VALID, '/user/teams/ops-team.yaml': TEAM_B })
  const templateSvc = new TeamTemplateService(fs, '/user/teams')
  await templateSvc.initialize()
  setTeamServiceForIndex(templateSvc)
  const runtime = makeRuntime(memFs())

  // 未成队时调用 → 成队
  const r1 = await executeUseTeam(JSON.stringify({ name: 'news-team' }))
  assert.equal(r1.success, true, r1.error)
  assert.match(r1.data!, /团队已激活/)
  const runId = runtime.getActiveTeam()!.runId

  // 同名重复调用 → 幂等纯重读(先改运行时状态再验证未动)
  await runtime.registerMember({ agent: 'researcher', taskId: 'call-9' })
  await runtime.boardPost({ title: '写初稿', createdBy: 'lead' })
  const r2 = await executeUseTeam(JSON.stringify({ name: 'news-team' }))
  assert.match(r2.data!, /已是当前活动团队/)
  assert.equal(runtime.getActiveTeam()!.runId, runId)
  assert.equal(runtime.getActiveTeam()!.roster.find((e) => e.name === 'researcher')!.status, 'running')
  assert.equal(runtime.getActiveTeam()!.board.length, 1)

  // 异名调用 → 归档换队
  const r3 = await executeUseTeam(JSON.stringify({ name: 'ops-team' }))
  assert.match(r3.data!, /此前的活动团队已归档/)
  assert.equal(runtime.getActiveTeam()!.name, 'ops-team')

  // 未装配降级(纯只读+注明未成队)
  resetTeamRuntimeService()
  const r4 = await executeUseTeam(JSON.stringify({ name: 'news-team' }))
  assert.equal(r4.success, true)
  assert.match(r4.data!, /团队运行时未装配/)
  assert.equal(getTeamRuntimeService(), undefined)
})

// ---------- 花名册 ----------

test('花名册: standby 复用 + 撞名自动派生后缀(batch 同模板扇出)', async () => {
  const svc = makeRuntime()
  await formNewsTeam(svc)
  // 首次派活复用 standby 条目
  const { entry: e1 } = await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })
  assert.equal(e1.name, 'researcher')
  assert.equal(e1.status, 'running')
  assert.equal(e1.currentTaskId, 'call-1')
  assert.equal(svc.getActiveTeam()!.roster.length, 2)
  // 同模板第二个实例 → 派生 -2(不顶掉第一个)
  const { entry: e2 } = await svc.registerMember({ agent: 'researcher', taskId: 'call-2' })
  assert.equal(e2.name, 'researcher-2')
  const { entry: e3 } = await svc.registerMember({ agent: 'researcher', taskId: 'call-3' })
  assert.equal(e3.name, 'researcher-3')
  // member_name 覆盖
  const { entry: e4 } = await svc.registerMember({ agent: 'researcher', memberName: '深研员', taskId: 'call-4' })
  assert.equal(e4.name, '深研员')
  // 归属反查
  assert.equal(svc.getMemberNameByTaskId('call-2'), 'researcher-2')
  assert.equal(svc.isMemberTask('call-3'), true)
  assert.equal(svc.isMemberTask('call-999'), false)
  assert.equal(svc.isMemberTask(undefined), false)
})

test('花名册: settle 回写(idle/failed)与 running 守卫(取消后二次 settle 不覆写)', async () => {
  const svc = makeRuntime()
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })
  svc.syncOnTaskSettle('call-1', 'completed', 'call-1')
  let e = svc.getActiveTeam()!.roster[0]
  assert.equal(e.status, 'idle')
  assert.equal(e.transcriptKey, 'call-1')
  // running 守卫:已离开 running 的条目,同 taskId 的二次 settle 幂等忽略
  svc.syncOnTaskSettle('call-1', 'failed')
  assert.equal(svc.getActiveTeam()!.roster[0].status, 'idle')

  await svc.registerMember({ agent: 'writer', taskId: 'call-2' })
  svc.syncOnTaskSettle('call-2', 'failed')
  assert.equal(svc.getActiveTeam()!.roster[1].status, 'failed')
  // 未登记的任务号是无操作
  svc.syncOnTaskSettle('ghost', 'completed')
  e = svc.getActiveTeam()!.roster[0]
  assert.equal(e.status, 'idle')
})

test('花名册: resume 续员(重新置 running + 换绑新 taskId;异队/无名拒绝)', async () => {
  const svc = makeRuntime()
  svc.ensureAdHocTeam()
  const teamId = svc.getActiveTeam()!.runId
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })
  svc.syncOnTaskSettle('call-1', 'completed')
  assert.equal((await svc.resumeMember(teamId, 'researcher', 'call-9')).resumed, true)
  const e = svc.getActiveTeam()!.roster[0]
  assert.equal(e.status, 'running')
  assert.equal(e.currentTaskId, 'call-9')
  assert.equal((await svc.resumeMember('other-team-1-x', 'researcher', 'call-10')).resumed, false)
  assert.equal((await svc.resumeMember(teamId, 'ghost', 'call-11')).resumed, false)
})

// ---------- 看板 ----------

test('看板: post/claim/update/read/remove 全流程 + revision 自增 + 快照', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  const runId = svc.ensureAdHocTeam().runId
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })

  const { item, revision } = await svc.boardPost({ title: '搜集资料', description: '中英文检索', createdBy: 'lead' })
  assert.equal(item.status, 'pending')
  assert.equal(revision, 1)

  const claimed = await svc.boardClaim(item.id, 'researcher')
  assert.equal(claimed.item.assignee, 'researcher')
  assert.equal(claimed.item.status, 'in_progress')
  assert.equal(claimed.revision, 2)

  const updated = await svc.boardUpdate(item.id, 'researcher', { status: 'completed', result: '已交付摘要' })
  assert.equal(updated.item.result, '已交付摘要')
  assert.equal(updated.revision, 3)

  assert.equal(svc.boardGet(item.id)!.status, 'completed')
  assert.equal(svc.boardList()!.items.length, 1)

  const removed = await svc.boardRemove(item.id, 'lead')
  assert.equal(removed.revision, 4)
  assert.equal(svc.boardList()!.items.length, 0)

  // 快照含最新 revision(等落盘写完再读)
  await svc.flush()
  const snap = JSON.parse(fs.written.get(`/team-runs/${runId}/board.json`)!)
  assert.equal(snap.boardRevision, 4)
})

test('看板: 归属约束(非认领人 update 被拒;认领人可;lead 全权;remove 仅 lead)', async () => {
  const svc = makeRuntime()
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })
  await svc.registerMember({ agent: 'writer', taskId: 'call-2' })
  const { item } = await svc.boardPost({ title: '写初稿', createdBy: 'lead' })

  // 未认领时非 lead 也不可 update(尚无人认领)
  await assert.rejects(svc.boardUpdate(item.id, 'writer', { status: 'completed' }), /仅认领人或 Lead/)
  await svc.boardClaim(item.id, 'researcher')
  // 非认领人被拒
  await assert.rejects(svc.boardUpdate(item.id, 'writer', { status: 'completed' }), /由 researcher 认领/)
  // 认领人可
  await svc.boardUpdate(item.id, 'researcher', { result: '初稿完成' })
  // lead 全权
  await svc.boardUpdate(item.id, 'lead', { status: 'completed' })
  assert.equal(svc.boardGet(item.id)!.status, 'completed')
  // remove 仅 lead
  await assert.rejects(svc.boardRemove(item.id, 'writer'), /仅 Lead/)
  await svc.boardRemove(item.id, 'lead')
})

test('看板: claim 并发防重(仅 pending 可成,第二个响亮失败)', async () => {
  const svc = makeRuntime()
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })
  await svc.registerMember({ agent: 'writer', taskId: 'call-2' })
  const { item } = await svc.boardPost({ title: '核查事实', createdBy: 'lead' })

  const results = await Promise.allSettled([
    svc.boardClaim(item.id, 'researcher'),
    svc.boardClaim(item.id, 'writer'),
  ])
  const succeeded = results.filter((r) => r.status === 'fulfilled')
  const failed = results.filter((r) => r.status === 'rejected')
  assert.equal(succeeded.length, 1)
  assert.equal(failed.length, 1)
  assert.match((failed[0] as PromiseRejectedResult).reason.message, /不可认领/)
  assert.equal(svc.boardGet(item.id)!.assignee, 'researcher')
})

test('看板: result 限长截断(4KB)并明示', async () => {
  const svc = makeRuntime()
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })
  const { item } = await svc.boardPost({ title: 'x', createdBy: 'lead' })
  await svc.boardClaim(item.id, 'researcher')
  const big = 'a'.repeat(BOARD_RESULT_MAX_CHARS + 500)
  const r = await svc.boardUpdate(item.id, 'researcher', { result: big })
  assert.equal(r.resultTruncated, true)
  assert.ok(svc.boardGet(item.id)!.result!.length < big.length)
  assert.match(svc.boardGet(item.id)!.result!, /已截断/)
})

test('看板: 无活动团队时响亮报错并指引成队', async () => {
  const svc = makeRuntime()
  await assert.rejects(svc.boardPost({ title: 'x', createdBy: 'lead' }), /当前没有活动团队/)
  assert.equal(svc.boardList(), undefined)
})

// ---------- 工具层(身份解析/防伪造/格式化) ----------

test('工具层: team_board/team_status 身份解析与防伪造', async () => {
  const svc = makeRuntime()
  // 无团队 → 响亮报错附成队指引
  const r0 = await executeTeamBoard(JSON.stringify({ action: 'read' }))
  assert.equal(r0.success, false)
  assert.match(r0.error!, /成队方式/)

  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })

  // lead(无 __origin)挂项
  const r1 = await executeTeamBoard(JSON.stringify({ action: 'post', title: '搜集资料' }))
  assert.equal(r1.success, true, r1.error)
  assert.match(r1.data!, /已挂上看板/)
  const itemId = svc.boardList()!.items[0].id

  // 成员(网关注入 origin)认领
  const r2 = await executeTeamBoard(JSON.stringify({ action: 'claim', id: itemId }), { source: 'subagent', taskId: 'call-1' })
  assert.equal(r2.success, true, r2.error)

  // 防伪造:非成员 Worker(origin taskId 不在花名册)即使参数自报也被拒
  const r3 = await executeTeamBoard(
    JSON.stringify({ action: 'update', id: itemId, status: 'completed', result: '假交付', as: 'researcher' }),
    { source: 'subagent', taskId: 'call-999' },
  )
  assert.equal(r3.success, false)
  assert.match(r3.error!, /不是当前团队的成员/)

  // 其他成员(在册但非认领人)被拒
  await svc.registerMember({ agent: 'writer', taskId: 'call-2' })
  const r4 = await executeTeamBoard(JSON.stringify({ action: 'update', id: itemId, status: 'completed' }), { source: 'subagent', taskId: 'call-2' })
  assert.equal(r4.success, false)
  assert.match(r4.error!, /仅认领人或 Lead/)

  // team_status:lead 可见快照(花名册+看板计数+runId)
  const r5 = await executeTeamStatus('{}')
  assert.equal(r5.success, true, r5.error)
  assert.match(r5.data!, /临时团队/)
  assert.match(r5.data!, /researcher/)
  assert.match(r5.data!, /进行中 1/)
})

test('工具层: read 列表为一行摘要,read(id) 取全文', async () => {
  const svc = makeRuntime()
  svc.ensureAdHocTeam()
  await svc.boardPost({ title: '任务A', description: '长说明', createdBy: 'lead' })
  const id = svc.boardList()!.items[0].id
  const list = await executeTeamBoard(JSON.stringify({ action: 'read' }))
  assert.match(list.data!, /# 团队看板/)
  assert.match(list.data!, /任务A/)
  assert.ok(!list.data!.includes('长说明'))
  const single = await executeTeamBoard(JSON.stringify({ action: 'read', id }))
  assert.match(single.data!, /长说明/)
})

// ---------- 门归属(编排黑名单/plan 只读门) ----------

test('门归属: use_team 入编排黑名单;use_team/team_board 入 plan 只读门,team_status 放行', async () => {
  const { ORCHESTRATION_TOOL_NAMES } = await import('../../src/orchestrator/types.ts')
  const { PLAN_MODE_BLOCKED_TOOLS } = await import('../../src/orchestrator/toolPolicy.ts')
  // 编排权归 Lead:Worker 网关对 use_team 永不放行(有成队/归档副作用)
  assert.ok(ORCHESTRATION_TOOL_NAMES.includes('use_team'))
  assert.ok(!ORCHESTRATION_TOOL_NAMES.includes('team_board'))
  assert.ok(!ORCHESTRATION_TOOL_NAMES.includes('team_status'))
  // plan 只读:变更类拦截,只读放行
  assert.ok(PLAN_MODE_BLOCKED_TOOLS.includes('use_team'))
  assert.ok(PLAN_MODE_BLOCKED_TOOLS.includes('team_board'))
  assert.ok(!PLAN_MODE_BLOCKED_TOOLS.includes('team_status'))
})

test('花名册: 角色名 member_name 复用同 agent 的 standby 条目(防幽灵重复)并迁移信箱', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  // 固定团队:成员以模板名 standby 在册(与实测场景同构)
  await svc.formFromDefinition({
    name: 'daily-news-team',
    version: 1,
    members: [
      { agent: 'general-purpose', role: '调研员' },
      { agent: 'document-writer', role: '撰稿人' },
    ],
  })
  // standby 期间有人按模板名发过简报(入信箱待派活)
  await svc.appendInbox('general-purpose', { from: 'lead', content: '开工简报', at: 1, delivered: false })

  // Lead 以角色名派活 → 复用同 agent 的 standby 条目并改名,不产生重复
  const { entry, undelivered } = await svc.registerMember({ agent: 'general-purpose', memberName: '调研员', taskId: 'call-1' })
  assert.equal(svc.getActiveTeam()!.roster.length, 2)
  assert.equal(entry.name, '调研员')
  assert.equal(entry.role, '调研员')
  assert.equal(entry.status, 'running')
  // 旧名信箱已迁移并随登记 drain
  assert.deepEqual(undelivered.map((m) => m.content), ['开工简报'])
  // 花名册里不再有 general-purpose 条目
  assert.ok(!svc.getActiveTeam()!.roster.some((e) => e.name === 'general-purpose'))

  // 无 member_name 时按模板名直接复用(原有路径不回归)
  const r2 = await svc.registerMember({ agent: 'document-writer', taskId: 'call-2' })
  assert.equal(r2.entry.name, 'document-writer')
  assert.equal(svc.getActiveTeam()!.roster.length, 2)
})

test('工具定义去重: 固定注入与授权名单重复声明时按名去重(防 400)', async () => {
  const { dedupeToolDefsByName } = await import('../../src/orchestrator/isolation/workers/toolDefDedupe.ts')
  const def = (name: string) => ({ type: 'function' as const, function: { name } })
  const out = dedupeToolDefsByName([def('escalate_to_lead'), def('team_board'), def('read_file'), def('team_board'), def('send_message'), def('send_message')])
  assert.deepEqual(out.map((d) => d.function.name), ['escalate_to_lead', 'team_board', 'read_file', 'send_message'])
})

// ---------- transcript 钉住 ----------

test('钉住: pinned 跳过 LRU 剪枝;全钉住时宁超上限不丢成员', () => {
  const registry = getTaskRegistry()
  // 10 条普通 + 3 条钉住
  for (let i = 0; i < 10; i++) {
    registry.retainTranscript(`plain-${i}`, { messages: [], subagentType: 'x', taskDescription: '' })
  }
  for (let i = 0; i < 3; i++) {
    registry.retainTranscript(`pin-${i}`, { messages: [], subagentType: 'x', taskDescription: '', pinned: true, teamId: 'team-1', memberName: `m${i}` })
  }
  // 超上限后淘汰最久未钉住者,钉住的 3 条全保留
  assert.ok(registry.getTranscript('pin-0'))
  assert.ok(registry.getTranscript('pin-2'))
  assert.equal(registry.getTranscript('plain-0'), undefined)
  // 解钉后回归 LRU:再存 10 条普通,旧 pin 被自然淘汰
  registry.unpinTeamTranscripts('team-1')
  for (let i = 0; i < 10; i++) {
    registry.retainTranscript(`new-${i}`, { messages: [], subagentType: 'x', taskDescription: '' })
  }
  assert.equal(registry.getTranscript('pin-0'), undefined)
})

// ---------- 跨进程观测(UI 快照区):存活双字段 ----------

test('观测字段: activate 写入 hostPid=process.pid 并随快照落盘', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  const runId = await formNewsTeam(svc)
  const team = svc.getActiveTeam()!
  assert.equal(team.hostPid, process.pid)
  const snap = JSON.parse(fs.written.get(`/team-runs/${runId}/snapshot.json`)!)
  assert.equal(snap.hostPid, process.pid)
  assert.equal(snap.archivedAt, undefined)
})

test('观测字段: archive 落 archivedAt 标记后清活动态;二次归档幂等', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  const runId = await formNewsTeam(svc)
  const before = Date.now()
  const archived = await svc.archive()
  assert.equal(archived, runId)
  assert.equal(svc.getActiveTeam(), undefined)
  const snap = JSON.parse(fs.written.get(`/team-runs/${runId}/snapshot.json`)!)
  assert.ok(typeof snap.archivedAt === 'number' && snap.archivedAt >= before)
  assert.equal(snap.hostPid, process.pid)
  // 幂等:无活动团队再归档返回 undefined,不重复写
  const writes = fs.written.size
  assert.equal(await svc.archive(), undefined)
  assert.equal(fs.written.size, writes)
})

test('观测字段: 异名换队时旧队带 archivedAt 落盘,新队带 hostPid(双队留档可区分死活)', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  const oldRunId = await formNewsTeam(svc)
  const { runId: newRunId, archivedRunId } = await svc.formFromDefinition({
    name: 'ops-team',
    version: 1,
    members: [{ agent: 'ops' }],
  })
  assert.equal(archivedRunId, oldRunId)
  const oldSnap = JSON.parse(fs.written.get(`/team-runs/${oldRunId}/snapshot.json`)!)
  assert.ok(typeof oldSnap.archivedAt === 'number')
  const newSnap = JSON.parse(fs.written.get(`/team-runs/${newRunId}/snapshot.json`)!)
  assert.equal(newSnap.archivedAt, undefined)
  assert.equal(newSnap.hostPid, process.pid)
})

test('观测字段: 壳注入 hostPid 优先于 process.pid(渲染进程 polyfill 无 pid 的场景)', async () => {
  const fs = memFs()
  const svc = new TeamRuntimeService(fs, '/team-runs', { hostPid: 42424 })
  setTeamRuntimeService(svc)
  const runId = await formNewsTeam(svc)
  assert.equal(svc.getActiveTeam()!.hostPid, 42424)
  const snap = JSON.parse(fs.written.get(`/team-runs/${runId}/snapshot.json`)!)
  assert.equal(snap.hostPid, 42424)
})

// ---------- M7 增量 1：团队归属会话 + 团队板变更事件 ----------

test('增量：成队登记归属会话（formFromDefinition/ensureAdHocTeam 带 sessionId；缺省不写字段）', async () => {
  const svc = makeRuntime()
  const { runId } = await svc.formFromDefinition(
    { name: 'sess-team', version: 1, members: [{ agent: 'a' }] },
    'sess-1',
  )
  const team = svc.getActiveTeam()!
  assert.equal(team.runId, runId)
  assert.equal(team.sessionId, 'sess-1')

  // 缺省（旧调用形态）：不写字段（旧语义不变）
  const svc2 = makeRuntime()
  await svc2.formFromDefinition({ name: 'legacy-team', version: 1, members: [{ agent: 'a' }] })
  assert.equal(svc2.getActiveTeam()!.sessionId, undefined)

  // ad-hoc：新建带归属；已存在老态补登归属
  const svc3 = makeRuntime()
  const adhoc = svc3.ensureAdHocTeam('sess-3')
  assert.equal(adhoc.sessionId, 'sess-3')
  const svc4 = makeRuntime()
  const old = svc4.ensureAdHocTeam() // 先建（无归属）
  assert.equal(old.sessionId, undefined)
  const same = svc4.ensureAdHocTeam('sess-4') // 再带会话调用 → 补登
  assert.equal(same.runId, old.runId)
  assert.equal(same.sessionId, 'sess-4')
})

test('增量：团队板 mutation 发 TEAM_BOARD_CHANGED（载荷 runId/sessionId/revision；无归属不携带 sessionId）', async () => {
  const svc = makeRuntime()
  await svc.formFromDefinition({ name: 'evt-team', version: 1, members: [{ agent: 'a' }] }, 'sess-e')
  const seen: Array<{ runId: string; sessionId?: string; revision: number }> = []
  const listener = (p: unknown): void => void seen.push(p as never)
  eventBus.on(EVENTS.TEAM_BOARD_CHANGED, listener)
  try {
    const post = await svc.boardPost({ title: '任务甲', createdBy: 'lead' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.runId, svc.getActiveTeam()!.runId)
    assert.equal(seen[0]!.sessionId, 'sess-e')
    assert.equal(seen[0]!.revision, 1)

    await svc.boardClaim(post.item.id, 'lead')
    assert.equal(seen.length, 2)
    assert.equal(seen[1]!.revision, 2)
  } finally {
    eventBus.off(EVENTS.TEAM_BOARD_CHANGED, listener)
  }

  // 旧数据（无归属）：事件照发但不携带 sessionId（桥侧不推）
  const svc2 = makeRuntime()
  await svc2.formFromDefinition({ name: 'no-sess', version: 1, members: [{ agent: 'a' }] })
  const seen2: Array<{ sessionId?: string }> = []
  const listener2 = (p: unknown) => seen2.push(p as never)
  eventBus.on(EVENTS.TEAM_BOARD_CHANGED, listener2)
  try {
    await svc2.boardPost({ title: '任务乙', createdBy: 'lead' })
    assert.equal(seen2.length, 1)
    assert.equal(seen2[0]!.sessionId, undefined)
  } finally {
    eventBus.off(EVENTS.TEAM_BOARD_CHANGED, listener2)
  }
})

// ---------- M7 增量 2：团队板 attachAttempt（在既有团队板条目上开始一次尝试） ----------

test('增量：团队板 attachAttempt 四态（pending 认领 / 在途换绑 / 占用拒绝 / 待裁决与终态拒绝）', async () => {
  const svc = makeRuntime()
  await formNewsTeam(svc)

  // ① pending → 认领（显式绑定 taskId + assignee=成员名）
  const a = (await svc.boardPost({ title: '团队活 A', createdBy: 'lead' })).item
  const claimed = await svc.attachAttempt(a.id, 'tc-1', 'researcher')
  assert.equal(claimed.status, 'in_progress')
  assert.equal(claimed.assignee, 'researcher')
  assert.equal(claimed.claimedByTaskId, 'tc-1')

  // ② 在途且已绑定 + 非"自己这一次执行" → 拒绝（不许把别人的在途活改派）
  await assert.rejects(
    () => svc.attachAttempt(a.id, 'tc-2', 'writer'),
    /正由 tc-1 执行中/,
  )
  // ②' 接管自己这一次执行的旧键（在途续跑）→ 换绑成功且不动 assignee
  const rebound = await svc.attachAttempt(a.id, 'tc-2', 'writer', { takeOverFromTaskId: 'tc-1' })
  assert.equal(rebound.claimedByTaskId, 'tc-2')
  assert.equal(rebound.assignee, 'researcher')

  // ③ 待裁决（交付失败 2 次）→ 拒绝并指路 adjudicate(retry)
  //    team 半边结项由 syncOnTaskSettle 驱动（按 roster.currentTaskId 匹配）→ 先登记成员再认领
  const b = (await svc.boardPost({ title: '团队活 B', createdBy: 'lead' })).item
  await svc.registerMember({ agent: 'writer', memberName: 'writer', taskId: 'tc-b1' })
  await svc.attachAttempt(b.id, 'tc-b1', 'writer')
  svc.syncOnTaskSettle('tc-b1', 'failed') // 第 1 次失败 → 回流认领池
  assert.equal(svc.boardGet(b.id)!.status, 'pending')
  await svc.registerMember({ agent: 'writer', memberName: 'writer-2', taskId: 'tc-b2' })
  await svc.attachAttempt(b.id, 'tc-b2', 'writer')
  svc.syncOnTaskSettle('tc-b2', 'failed') // 第 2 次失败 → 停在待裁决
  const frozen = svc.boardGet(b.id)!
  assert.equal(frozen.status, 'failed')
  await assert.rejects(
    () => svc.attachAttempt(b.id, 'tc-b3', 'writer'),
    /待裁决[\s\S]*adjudicate/,
  )

  // ④ 终态 → 拒绝
  await svc.boardUpdate(a.id, 'lead', { status: 'completed', result: '交付' })
  assert.equal(svc.boardGet(a.id)!.status, 'completed')
  await assert.rejects(
    () => svc.attachAttempt(a.id, 'tc-3', 'writer'),
    /终态，不可复用/,
  )

  // ⑤ 条目不在团队板 → 响亮拒绝
  await assert.rejects(
    () => svc.attachAttempt('no-such-item', 'tc-4', 'writer'),
    /不在团队板/,
  )
})
