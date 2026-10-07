import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import { routeTeamMessage, formatTeamMessage } from '../../src/services/team/teamMessageRouter.ts'
import { executeSendMessage } from '../../src/services/team/teamMessageTool.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { TEAM_MESSAGE_MAX_CHARS } from '../../src/services/team/teamRuntimeTypes.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/** 内存 fs(记录写入,验证信箱落盘) */
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
    fileExists: async () => ({ success: false }),
  } as unknown as IFileSystemProvider & { written: Map<string, string> }
}

function makeRuntime(fs = memFs()): TeamRuntimeService {
  const svc = new TeamRuntimeService(fs, '/team-runs')
  setTeamRuntimeService(svc)
  return svc
}

/** 两名成员的临时团队(a 运行中带环境绑定,b 空闲带 transcript) */
async function setupTeam(svc: TeamRuntimeService) {
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-a' })
  getTaskRegistry().bindEnvironment('call-a', { id: 'env-a' } as never)
  await svc.registerMember({ agent: 'writer', taskId: 'call-b' })
  getTaskRegistry().bindEnvironment('call-b', { id: 'env-b' } as never)
  svc.syncOnTaskSettle('call-b', 'completed', 'call-b')
  getTaskRegistry().unbindEnvironment('call-b')
  getTaskRegistry().retainTranscript('call-b', {
    messages: [], subagentType: 'writer', taskDescription: 'x',
    pinned: true, teamId: svc.getActiveTeam()!.runId, memberName: 'writer',
  })
}

beforeEach(() => {
  resetTeamRuntimeService()
  resetTaskRegistry()
})

// ---------- 消息格式化 ----------

test('格式化: 归因前缀 + 防 laundering 声明 + 回传指引 + 4KB 限长', () => {
  const m = formatTeamMessage('researcher', '那个数据哪来的?')
  assert.match(m, /【团队成员 researcher 的消息】/)
  assert.match(m, /不代表用户授权/)
  assert.match(m, /target 填 'researcher'/)

  const fromLead = formatTeamMessage('lead', '收到')
  assert.match(fromLead, /【Lead 的消息】/)
  assert.match(fromLead, /escalate_to_lead/)

  const big = formatTeamMessage('a', 'x'.repeat(TEAM_MESSAGE_MAX_CHARS + 100))
  assert.match(big, /已截断/)
})

// ---------- 三态路由 ----------

test('running → steer 即时捎带并入信箱标已投', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  await setupTeam(svc)

  const r = await routeTeamMessage('lead', 'researcher', '补充一条要求')
  assert.equal(r.success, true, r.error)
  assert.match(r.data!, /已即时投递/)
  // steer 队列里有归因格式消息(经 drainSteerByEnvId 可见)
  const notes = getTaskRegistry().drainSteerByEnvId('env-a')
  assert.equal(notes.length, 1)
  assert.match(notes[0], /【Lead 的消息】/)
  // 信箱档案有记录且已标 delivered
  const inbox = JSON.parse(fs.written.get(`/team-runs/${svc.getActiveTeam()!.runId}/inboxes/researcher.json`)!)
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].delivered, true)
})

test('idle+transcript → 唤醒续聊(wake 收到归因消息;唤醒中标记由 settle 解除)', async () => {
  const svc = makeRuntime()
  await setupTeam(svc)

  const wakeCalls: Array<{ id: string; args: unknown }> = []
  const r = await routeTeamMessage('researcher', 'writer', '数据出处给我一下', {
    wake: async (id: string, args: unknown) => {
      wakeCalls.push({ id, args })
      return { success: true, content: 'ok' }
    },
  })
  assert.equal(r.success, true, r.error)
  assert.match(r.data!, /已唤醒 writer 续聊/)
  assert.equal(wakeCalls.length, 1)
  const wakeArgs = wakeCalls[0].args as { toolCallId?: string; message?: string }
  assert.equal(wakeArgs.toolCallId, 'call-b')
  assert.match(wakeArgs.message!, /【团队成员 researcher 的消息】/)
  // 唤醒中标记已立(settle 才解除)
  assert.equal(svc.isWaking('writer'), true)
  // 唤醒期间再发 → 只入信箱不二次唤醒
  const r2 = await routeTeamMessage('lead', 'writer', '追加一条', {
    wake: async () => {
      throw new Error('不应被再次唤醒')
    },
  })
  assert.match(r2.data!, /唤醒中/)
  // 真实链路中 executeResumeTask 内部 resumeMember 会置 running;此处模拟后 settle → 标记解除
  await svc.resumeMember(svc.getActiveTeam()!.runId, 'writer', 'call-b2')
  svc.syncOnTaskSettle('call-b2', 'completed')
  assert.equal(svc.isWaking('writer'), false)
})

test('唤醒失败统一滞留:消息在信箱且发送方获告知,唤醒中标记解除', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  await setupTeam(svc)

  const r = await routeTeamMessage('lead', 'writer', '重写一段', {
    wake: async () => ({ success: false, error: '配额已满' }),
  })
  assert.match(r.data!, /唤醒失败/)
  assert.match(r.data!, /配额已满/)
  assert.match(r.data!, /已入信箱不丢/)
  assert.equal(svc.isWaking('writer'), false)
  const inbox = JSON.parse(fs.written.get(`/team-runs/${svc.getActiveTeam()!.runId}/inboxes/writer.json`)!)
  assert.equal(inbox[0].delivered, false)
})

test('standby → 入信箱不唤醒,如实回执', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  await svc.formFromDefinition({ name: 't', version: 1, members: [{ agent: 'ops' }] })
  const r = await routeTeamMessage('lead', 'ops', '开工简报')
  assert.match(r.data!, /尚未在跑/)
  assert.match(r.data!, /下次被派活时投递/)
  const inbox = JSON.parse(fs.written.get(`/team-runs/${svc.getActiveTeam()!.runId}/inboxes/ops.json`)!)
  assert.equal(inbox[0].content.includes('开工简报'), true)
})

test('spawn 窗口(running 但环境未绑定)→ 信箱持有不二次唤醒', async () => {
  const svc = makeRuntime()
  await setupTeam(svc)
  // 解绑 a 的环境但保持 running(spawn 中)
  getTaskRegistry().unbindEnvironment('call-a')
  const r = await routeTeamMessage('lead', 'researcher', '启动中请稍后', {
    wake: async () => {
      throw new Error('不应唤醒(running 中)')
    },
  })
  assert.match(r.data!, /正在启动/)
})

// ---------- lead / all / 校验 ----------

test('member→lead: 入 Lead 送达队列 + lead 信箱落盘', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  await setupTeam(svc)

  const r = await executeSendMessage(
    JSON.stringify({ target: 'lead', content: '素材不足,请补充检索范围' }),
    { source: 'subagent', taskId: 'call-a' },
  )
  assert.equal(r.success, true, r.error)
  const pending = getTaskRegistry().drainTeamMessages()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].from, 'researcher')
  const inbox = JSON.parse(fs.written.get(`/team-runs/${svc.getActiveTeam()!.runId}/inboxes/lead.json`)!)
  assert.equal(inbox[0].delivered, false)
})

test('target=all: 逐成员投递 + 成员发起的 all 含 lead;部分失败汇总', async () => {
  const svc = makeRuntime()
  await setupTeam(svc)
  const r = await routeTeamMessage('researcher', 'all', '进度同步一下', {
    wake: async () => ({ success: false, error: '配额满' }),
  })
  assert.equal(r.success, true, r.error)
  assert.match(r.data!, /广播完成/)
  assert.match(r.data!, /writer/)
  // lead 也收到(成员发起的 all 含 lead)
  assert.equal(getTaskRegistry().drainTeamMessages().length, 1)
})

test('校验: 自发拒绝;未知成员报错列名册;无团队响亮报错;非成员 Worker 防伪造', async () => {
  const svc = makeRuntime()
  await setupTeam(svc)

  const r1 = await executeSendMessage(JSON.stringify({ target: 'researcher', content: 'x' }), { source: 'subagent', taskId: 'call-a' })
  assert.match(r1.error!, /不能给自己发消息/)

  const r2 = await routeTeamMessage('lead', 'ghost', 'x')
  assert.match(r2.error!, /不在花名册/)
  assert.match(r2.error!, /researcher/)

  // 防伪造:非成员 Worker(origin taskId 不在花名册)被拒
  const r3 = await executeSendMessage(JSON.stringify({ target: 'lead', content: 'x' }), { source: 'subagent', taskId: 'call-999' })
  assert.match(r3.error!, /不是当前团队的成员/)

  // 无团队
  resetTeamRuntimeService()
  const r4 = await executeSendMessage(JSON.stringify({ target: 'lead', content: 'x' }))
  assert.match(r4.error!, /未装配|没有活动团队/)
})

// ---------- 信箱读写 ----------

test('信箱: 并发 append 不丢消息;drain 标 delivered 且保序', async () => {
  const fs = memFs()
  const svc = makeRuntime(fs)
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })

  await Promise.all([
    svc.appendInbox('researcher', { from: 'lead', content: 'm1', at: 1, delivered: false }),
    svc.appendInbox('researcher', { from: 'writer', content: 'm2', at: 2, delivered: false }),
    svc.appendInbox('researcher', { from: 'lead', content: 'm3', at: 3, delivered: false }),
  ])
  const unread = await svc.drainInbox('researcher')
  assert.equal(unread.length, 3)
  assert.deepEqual(unread.map((m) => m.content), ['m1', 'm2', 'm3'])
  // 再 drain 为空(已标 delivered)
  assert.equal((await svc.drainInbox('researcher')).length, 0)
  // 档案仍在(delivered=true)
  const inbox = JSON.parse(fs.written.get(`/team-runs/${svc.getActiveTeam()!.runId}/inboxes/researcher.json`)!)
  assert.equal(inbox.length, 3)
  assert.ok(inbox.every((m: { delivered: boolean }) => m.delivered))
})

test('member_name 非法字符响亮拒绝(防信箱文件名炸)', async () => {
  const svc = makeRuntime()
  svc.ensureAdHocTeam()
  await assert.rejects(svc.registerMember({ agent: 'x', memberName: 'bad/name', taskId: 'c1' }), /非法字符/)
})

test('unreadCounts: 含成员与 lead,已读后清零', async () => {
  const svc = makeRuntime()
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })
  await svc.appendInbox('researcher', { from: 'lead', content: 'm', at: 1, delivered: false })
  await svc.appendInbox('lead', { from: 'researcher', content: 'm2', at: 2, delivered: false })
  const counts = await svc.unreadCounts()
  assert.deepEqual(counts, { researcher: 1, lead: 1 })
  await svc.drainInbox('researcher')
  assert.deepEqual(await svc.unreadCounts(), { lead: 1 })
})

// ---------- 门来源豁免 ----------

test('门豁免: subagent 来源的团队工具过 plan 门;主会话照拦;Worker 修改性工具照拦', () => {
  const executor = new BuiltInToolExecutor(memFs() as never, {} as never, {} as never, {} as never)
  const ex = executor as unknown as {
    planMode: boolean
    makePlanModeLink: () => { evaluateSync: (ctx: Record<string, unknown>) => { type: string } }
  }
  ex.planMode = true
  const link = ex.makePlanModeLink()

  // 团队成员的 send_message/team_board → 放行(团队内部协作状态)
  assert.equal(link.evaluateSync({ toolName: 'send_message', toolInput: { __origin: { source: 'subagent' } } }).type, 'allow')
  assert.equal(link.evaluateSync({ toolName: 'team_board', toolInput: { __origin: { source: 'subagent' } } }).type, 'allow')
  // 主会话(无 __origin)的 send_message → 拦截(plan 只读)
  assert.equal(link.evaluateSync({ toolName: 'send_message', toolInput: {} }).type, 'deny')
  // Worker 的修改性工具 → 照拦(写边界不动)
  assert.equal(link.evaluateSync({ toolName: 'create_file', toolInput: { __origin: { source: 'subagent' } } }).type, 'deny')
})

// ---------- 注册与门归属 ----------

test('门归属: send_message 在 TEAM_TOOL_NAMES/PLAN_MODE_BLOCKED_TOOLS,不在 ORCHESTRATION', async () => {
  const { TEAM_TOOL_NAMES } = await import('../../src/services/team/teamBoardTool.ts')
  const { ORCHESTRATION_TOOL_NAMES } = await import('../../src/orchestrator/types.ts')
  const { PLAN_MODE_BLOCKED_TOOLS } = await import('../../src/orchestrator/toolPolicy.ts')
  assert.ok(TEAM_TOOL_NAMES.includes('send_message'))
  assert.ok(PLAN_MODE_BLOCKED_TOOLS.includes('send_message'))
  assert.ok(!ORCHESTRATION_TOOL_NAMES.includes('send_message'))
})
