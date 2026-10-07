import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import { executeTeamBoard, executeTeamStatus } from '../../src/services/team/teamBoardTool.ts'
import { executeTeamPolicy } from '../../src/services/team/teamPolicyTool.ts'
import { resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * 探针去刺(迭代 2):只读探查(team_status / team_policy read)对"无团队"应答"空"而非"错";
 * 写操作(team_board post / team_policy update)报错语义一字不动。
 */

/** 内存 fs 桩(与 teamSnapshot.test.ts 同款) */
function memFs(): IFileSystemProvider & { written: Map<string, string> } {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const written = new Map<string, string>()
  return {
    written,
    getCurrentDirectory: () => null,
    readFile: async (p: string) =>
      written.has(norm(p))
        ? { success: true, data: { content: written.get(norm(p))! } }
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
    listDirectory: async () => ({ success: true, data: { files: [] } }),
    fileExists: async () => ({ success: true, data: false }),
  } as unknown as IFileSystemProvider & { written: Map<string, string> }
}

let svc: TeamRuntimeService

beforeEach(() => {
  resetTeamRuntimeService()
  resetTaskRegistry()
  svc = new TeamRuntimeService(memFs(), '/team-runs')
  setTeamRuntimeService(svc)
})

test('team_status 空态:无团队返回正常文案(指引保留,错误形态消除)', async () => {
  const res = await executeTeamStatus('{}')
  assert.equal(res.success, true)
  assert.match(res.data!, /当前没有活动团队/)
  assert.match(res.data!, /成队方式/)
  // Worker 来源同样拿到空态而非红字(只读无泄漏)
  const asMember = await executeTeamStatus('{}', { source: 'subagent', taskId: 't-x' })
  assert.equal(asMember.success, true)
  assert.match(asMember.data!, /当前没有活动团队/)
})

test('team_policy read 空态:无团队返回"无授权快照"文案', async () => {
  const res = await executeTeamPolicy('{"action":"read"}')
  assert.equal(res.success, true)
  assert.match(res.data!, /当前没有活动团队/)
  assert.match(res.data!, /无授权快照/)
})

test('写操作仍报错:team_board post / team_policy update 无团队错误语义一字不动', async () => {
  const post = await executeTeamBoard(JSON.stringify({ action: 'post', title: 'x' }))
  assert.equal(post.success, false)
  assert.match(post.error!, /当前没有活动团队。成队方式:use_team 激活固定团队,或 task\/batch_task 带 as_teammate:true 组建临时团队。/)

  const update = await executeTeamPolicy(JSON.stringify({ action: 'update', budget: { max_members: 2 }, note: 'x' }))
  assert.equal(update.success, false)
  assert.match(update.error!, /当前没有活动团队。成队方式:use_team 激活固定团队,或 task\/batch_task 带 as_teammate:true 组建临时团队。/)
})

test('回归:有团队时 team_status / team_policy read 输出不变', async () => {
  svc.ensureAdHocTeam()
  await svc.registerMember({ agent: 'researcher', taskId: 'call-1' })
  const status = await executeTeamStatus('{}')
  assert.equal(status.success, true, status.error)
  assert.match(status.data!, /临时团队/)
  assert.match(status.data!, /researcher/)
  const read = await executeTeamPolicy('{}')
  assert.equal(read.success, true)
  assert.match(read.data!, /授权快照/)
})
