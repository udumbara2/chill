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

/**
 * V4.1 收编回归:team 板同用 boardCore 规则的行为锁——
 * - 二次失败→failed(待裁决)停留(旧实现无限回流;行为变更显式化);
 * - release 三清(对齐 boardCore,清 claimedByTaskId——旧实现不清);
 * - revision 对齐(boardCore 每 API 调用 +1;settle 咽喉单次,不逐条);
 * - 裁决经 team_board 工具通路(adjudicate 权限=Lead)。
 */

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

async function asMember(agent: string, taskId: string, payload: object) {
  await svc.registerMember({ agent, taskId })
  return executeTeamBoard(JSON.stringify(payload), { source: 'subagent', taskId })
}

test('V4.1 二次失败→待裁决停留(不再三度回流);裁决经 team_board(仅 Lead),retry 不清 failCount', async () => {
  const id = await postItem('两次失败的活')
  await asMember('researcher', 't1', { action: 'claim', id })
  svc.syncOnTaskSettle('t1', 'failed')
  let item = svc.boardGet(id)!
  assert.equal(item.status, 'pending', '一败:回流认领池')
  assert.equal(item.failCount, 1)

  await asMember('researcher', 't2', { action: 'claim', id })
  svc.syncOnTaskSettle('t2', 'failed')
  item = svc.boardGet(id)!
  assert.equal(item.status, 'failed', '二败:停在 failed(待裁决),不再回流')
  assert.equal(item.failCount, 2)

  // 裁决权限=Lead:成员被结构性拒绝
  const memberTry = await executeTeamBoard(
    JSON.stringify({ action: 'adjudicate', id, decision: 'retry' }),
    { source: 'subagent', taskId: 't2' },
  )
  assert.equal(memberTry.success, false)
  assert.match(memberTry.error!, /仅 Lead/)

  // 会话一句话=Lead 先 read 再裁决(retry 回池,failCount 不清零)
  const read = await executeTeamBoard(JSON.stringify({ action: 'read', id }))
  assert.equal(read.success, true)
  assert.match(read.data!, /失败/)
  const adj = await executeTeamBoard(JSON.stringify({ action: 'adjudicate', id, decision: 'retry' }))
  assert.equal(adj.success, true, adj.error)
  item = svc.boardGet(id)!
  assert.equal(item.status, 'pending')
  assert.equal(item.failCount, 2, '裁决 retry 不清零')

  // 三败仍停待裁决(failCount 递增不重置)
  await asMember('researcher', 't3', { action: 'claim', id })
  svc.syncOnTaskSettle('t3', 'failed')
  item = svc.boardGet(id)!
  assert.equal(item.status, 'failed')
  assert.equal(item.failCount, 3)

  // cancel 出口=终态
  const adj2 = await executeTeamBoard(JSON.stringify({ action: 'adjudicate', id, decision: 'cancel' }))
  assert.equal(adj2.success, true, adj2.error)
  assert.equal(svc.boardGet(id)!.status, 'cancelled')
})

test('V4.1 release 三清对齐:清 assignee/claimedAt/claimedByTaskId(旧实现不清绑定)', async () => {
  const id = await postItem('三清活')
  await asMember('researcher', 't1', { action: 'claim', id })
  const claimed = svc.boardGet(id)!
  assert.equal(claimed.claimedByTaskId, 't1')
  assert.notEqual(claimed.claimedAt, undefined)

  const rel = await executeTeamBoard(
    JSON.stringify({ action: 'release', id, reason: '需要专门领域知识' }),
    { source: 'subagent', taskId: 't1' },
  )
  assert.equal(rel.success, true, rel.error)
  const item = svc.boardGet(id)!
  assert.equal(item.status, 'pending')
  assert.equal(item.assignee, undefined)
  assert.equal(item.claimedAt, undefined)
  assert.equal(item.claimedByTaskId, undefined, '三清:残留绑定会让换绑/自动结项误配')
})

test('V4.1 revision 对齐 boardCore:每 API 调用 +1;settle 咽喉单次(不逐条)', async () => {
  const a = await postItem('A')
  const b = await postItem('B')
  assert.equal(svc.boardList()!.revision, 2)
  await asMember('researcher', 't1', { action: 'claim', id: a })
  const { item: bItem } = await svc.boardClaim(b, 'researcher')
  assert.equal(bItem.status, 'in_progress')
  const revBefore = svc.boardList()!.revision
  // settle 咽喉:自动结项 2 条绑定条目 → revision 只 +1(boardCore 一次 mutation;旧实现逐条 +1)
  svc.syncOnTaskSettle('t1', 'completed', undefined, undefined, '交付')
  assert.equal(svc.boardList()!.revision, revBefore + 1)
  assert.equal(svc.boardGet(a)!.status, 'completed')
  assert.equal(svc.boardGet(b)!.status, 'completed')
})

test('V4.1 update status 映射 boardCore 状态机:completed=结项/failed=交付失败(带 failCount)/pending=退回', async () => {
  const id = await postItem('映射活')
  await asMember('researcher', 't1', { action: 'claim', id })
  // failed 交付失败:failCount++ + 回流(一次)
  const f1 = await svc.boardUpdate(id, 'researcher', { status: 'failed', result: 'API 限流' })
  assert.equal(f1.item.status, 'pending')
  assert.equal(f1.item.failCount, 1)
  assert.match(f1.item.result!, /API 限流/)
  // 同成员再认领(t1 仍在办)→ completed 结项(result 随带)
  const re = await executeTeamBoard(JSON.stringify({ action: 'claim', id }), { source: 'subagent', taskId: 't1' })
  assert.equal(re.success, true, re.error)
  const done = await svc.boardUpdate(id, 'researcher', { status: 'completed', result: '交付摘要' })
  assert.equal(done.item.status, 'completed')
  assert.equal(done.item.result, '交付摘要')
})
