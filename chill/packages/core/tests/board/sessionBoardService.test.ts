import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionBoardService,
  nextWorkstationId,
  resetSessionBoardService,
  setSessionBoardService,
  getSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import { BoardStore } from '../../src/services/board/boardStore.ts'
import { eventBus, EVENTS, type BoardChangedPayload } from '../../src/utils/eventBus.ts'
import type { BoardItem } from '../../src/services/board/boardTypes.ts'

async function makeService(t: TestContext): Promise<{ svc: SessionBoardService; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  t.after(async () => {
    resetSessionBoardService()
    await rm(dir, { recursive: true, force: true })
  })
  return { svc, dir }
}

test('懒建板:首次访问建板;再次访问同一实例(内存为真相)', async (t) => {
  const { svc } = await makeService(t)
  const board = await svc.ensureBoard('sess-1')
  assert.equal(board.boardId, 'sess-1')
  assert.equal(board.items.length, 0)
  const again = await svc.ensureBoard('sess-1')
  assert.equal(again, board) // 内存为真相:同一实例
})

test('落盘:mutation 后快照更新;重置内存后从快照恢复(含工位索引回填)', async (t) => {
  const { svc, dir } = await makeService(t)
  const posted = await svc.autoPostAndClaim({
    sessionId: 'sess-1',
    batchId: 'b-1',
    taskId: 'tc-1',
    subagentType: 'explore',
    title: '调研任务',
  })
  assert.equal(posted!.workstation, 'explore·A')
  const raw = JSON.parse(await readFile(join(dir, 'sess-1.json'), 'utf8'))
  assert.equal(raw.items.length, 1)
  assert.equal(raw.items[0].status, 'in_progress')

  svc.reset() // 清内存,只留快照
  const restored = await svc.readBoard('sess-1')
  assert.equal(restored.items.length, 1)
  assert.equal(restored.items[0].assignee, 'explore·A')
  // claimedByTaskId → 工位索引回填(settle 桥可用)
  assert.equal(svc.workstationOf('sess-1', 'tc-1'), 'explore·A')
  assert.equal(svc.sessionIdOfTask('tc-1'), 'sess-1')
})

test('boardChanged 事件:每次 mutation 落盘后发出(sessionId/boardId/revision)', async (t) => {
  const { svc } = await makeService(t)
  const seen: BoardChangedPayload[] = []
  const handler = (p: BoardChangedPayload) => seen.push(p)
  eventBus.on(EVENTS.BOARD_CHANGED, handler)
  t.after(() => eventBus.off(EVENTS.BOARD_CHANGED, handler))

  const item = await svc.post('sess-1', { title: 'A', createdBy: 'lead' })
  await svc.claim('sess-1', item.id, { assignee: 'w1' })
  assert.equal(seen.length, 2)
  assert.equal(seen[0].sessionId, 'sess-1')
  assert.equal(seen[0].boardId, 'sess-1')
  // revision 单调（rev 纪律:纪元起点时间基,纪元内 +1——绝对值不再是小计数,断言改为严格递增）
  assert.ok(seen[1].revision > seen[0].revision, `revision 应严格递增: ${seen[0].revision} → ${seen[1].revision}`)
})

test('工位 id:subagentType·短序号,板内全局递增(A/B/…/Z/AA);跨前缀互不挤占', async (t) => {
  const { svc } = await makeService(t)
  const a = await svc.spawnWorkstation('sess-1', 'explore', 't1')
  const b = await svc.spawnWorkstation('sess-1', 'explore', 't2')
  const w = await svc.spawnWorkstation('sess-1', 'writer', 't3')
  assert.equal(a, 'explore·A')
  assert.equal(b, 'explore·B')
  assert.equal(w, 'writer·A')
  assert.equal(svc.workstationOf('sess-1', 't2'), 'explore·B')
  assert.equal(svc.workstationOf('sess-1', 'nope'), undefined)

  // 纯函数:26 用尽进位到 AA
  let fake: string[] = []
  for (let i = 0; i < 26; i++) {
    const id = nextWorkstationId(fake, 'explore')
    fake = [...fake, id]
    assert.equal(id, `explore·${String.fromCharCode(65 + i)}`)
  }
  assert.equal(nextWorkstationId(fake, 'explore'), 'explore·AA')
})

test('autoPostAndClaim:spawn 即认领(永无 pending),title 摘要 + batchId + claimedByTaskId', async (t) => {
  const { svc } = await makeService(t)
  const res = await svc.autoPostAndClaim({
    sessionId: 'sess-1',
    batchId: 'b-1',
    taskId: 'tc-1',
    subagentType: 'explore',
    title: '调研任务',
    description: '全文说明',
  })
  assert.equal(res!.item.status, 'in_progress')
  assert.equal(res!.item.assignee, 'explore·A')
  assert.equal(res!.item.claimedByTaskId, 'tc-1')
  assert.equal(res!.item.batchId, 'b-1')
  assert.equal(res!.item.createdBy, 'lead')
  assert.equal(typeof res!.item.claimedAt, 'number')

  // 嵌套委派:无 sessionId 时经 parentTaskId 反查板
  const nested = await svc.autoPostAndClaim({
    parentTaskId: 'tc-1',
    batchId: 'b-1',
    taskId: 'tc-2',
    subagentType: 'writer',
    title: '子任务',
  })
  assert.equal(nested!.sessionId, 'sess-1')
  // 非会话路径:无 sessionId 也无 parent → 不挂板
  const orphan = await svc.autoPostAndClaim({ batchId: 'b-1', taskId: 'tc-x', subagentType: 'x', title: 'x' })
  assert.equal(orphan, null)
})

test('settleByTaskId:未登记任务无操作;已登记任务走 boardCore.onTaskSettle', async (t) => {
  const { svc } = await makeService(t)
  await svc.settleByTaskId('unknown-task', 'completed') // 无操作,不抛
  await svc.autoPostAndClaim({ sessionId: 'sess-1', batchId: 'b-1', taskId: 'tc-1', subagentType: 'explore', title: 'A' })
  await svc.settleByTaskId('tc-1', 'completed', { result: '交付' })
  const { items } = await svc.readBoard('sess-1')
  assert.equal(items[0].status, 'completed')
  assert.match(items[0].result!, /自动结项:认领人任务交付/)
})

test('archive:在途条目 cancelItem 留痕、终态不动、归档标记落盘', async (t) => {
  const { svc, dir } = await makeService(t)
  await svc.autoPostAndClaim({ sessionId: 'sess-1', batchId: 'b-1', taskId: 'tc-1', subagentType: 'explore', title: 'A' })
  const done = await svc.post('sess-1', { title: '已完成', createdBy: 'lead' })
  await svc.claim('sess-1', done.id, { assignee: 'w1', claimedByTaskId: 't-done' })
  await svc.settleByTaskId('t-done', 'completed', { result: '交付' })
  const open = await svc.post('sess-1', { title: '在途', createdBy: 'lead' })
  await svc.claim('sess-1', open.id, { assignee: 'w2' })

  await svc.archive('sess-1', '会话删除')
  const raw = JSON.parse(await readFile(join(dir, 'sess-1.json'), 'utf8'))
  assert.equal(typeof raw.archivedAt, 'number')
  assert.equal(raw.archiveReason, '会话删除')
  assert.equal(raw.items.length, 3)
  const byId = new Map(raw.items.map((i: BoardItem) => [i.id, i]))
  assert.equal(byId.get(done.id).status, 'completed') // 终态不动
  assert.equal(byId.get(open.id).status, 'cancelled') // 在途撤单
  assert.match(byId.get(open.id).releaseHistory.at(-1).reason, /看板归档:会话删除/)
})

test('投影:getProjection 透传 buildBoardProjection', async (t) => {
  const { svc } = await makeService(t)
  await svc.post('sess-1', { title: 'A', createdBy: 'lead' })
  const p = await svc.getProjection('sess-1', { pendingAskCount: 0, pendingApprovalCount: 0, now: Date.now() })
  assert.equal(p.rows.length, 1)
  assert.equal(p.rows[0].label, '待认领')
  assert.equal(p.needsYou.needed, true)
})

test('单例装配:set/get/reset', async (t) => {
  const { svc } = await makeService(t)
  assert.equal(getSessionBoardService(), svc)
  resetSessionBoardService()
  assert.equal(getSessionBoardService(), undefined)
  void t
})

// ---------- M7 增量 2：attachAttempt（在既有条目上开始一次尝试） ----------

test('attachAttempt 四态分流：pending 认领 / 在途换绑 / 待裁决拒绝指路 / 终态拒绝', async (t) => {
  const { svc } = await makeService(t)

  // ① pending → 认领（派新工位 + 绑定任务键 + 登记工位索引）
  const a = await svc.post('sess-1', { title: '活 A', createdBy: 'lead', batchId: 'batch-1' })
  const attached = await svc.attachAttempt('sess-1', a.id, { claimedByTaskId: 'tc-1', subagentType: 'explore' })
  assert.equal(attached.status, 'in_progress')
  assert.match(attached.assignee!, /^explore·/)
  assert.equal(attached.claimedByTaskId, 'tc-1')
  assert.equal(attached.batchId, 'batch-1') // 工作单元身份不变
  assert.equal(attached.createdAt, a.createdAt)
  assert.equal(svc.sessionIdOfTask('tc-1'), 'sess-1') // 工位索引（board update 身份反查 + feed 归属依赖它）

  // ② 在途且已绑定 + 非"自己这一次执行" → 拒绝（防两个执行者做同一件活）
  await assert.rejects(
    () => svc.attachAttempt('sess-1', a.id, { claimedByTaskId: 'tc-2', subagentType: 'explore' }),
    /正由 tc-1 执行中/,
  )
  // ②' 在途 + 接管自己这一次执行的旧键（计划批准轮/打回轮等续跑）→ 换绑成功
  const rebound = await svc.attachAttempt('sess-1', a.id, {
    claimedByTaskId: 'tc-2',
    subagentType: 'explore',
    takeOverFromTaskId: 'tc-1',
  })
  assert.equal(rebound.claimedByTaskId, 'tc-2')
  assert.equal(rebound.status, 'in_progress')
  assert.equal(rebound.assignee, attached.assignee) // 换绑不动 assignee

  // ③ 待裁决（交付失败 2 次）→ 拒绝并指路 adjudicate(retry)
  //    注意：死亡的失败回流按 assignee 归组（同一工位的在途条目一并回流）——这里用不同工位，别误伤活 A
  const b = await svc.post('sess-1', { title: '活 B', createdBy: 'lead' })
  await svc.claim('sess-1', b.id, { assignee: 'coder·A', claimedByTaskId: 'tc-b1' })
  await svc.settleByTaskId('tc-b1', 'failed')
  await svc.claim('sess-1', b.id, { assignee: 'coder·B', claimedByTaskId: 'tc-b2' })
  await svc.settleByTaskId('tc-b2', 'failed')
  const frozen = (await svc.readBoard('sess-1')).items.find((i) => i.id === b.id)!
  assert.equal(frozen.status, 'failed')
  await assert.rejects(
    () => svc.attachAttempt('sess-1', b.id, { claimedByTaskId: 'tc-b3', subagentType: 'explore' }),
    /待裁决[\s\S]*adjudicate/,
  )

  // ④ 终态 → 拒绝（终态不可离开）
  await svc.settleByTaskId('tc-2', 'completed', { result: '交付' })
  assert.equal((await svc.readBoard('sess-1')).items.find((i) => i.id === a.id)!.status, 'completed')
  await assert.rejects(
    () => svc.attachAttempt('sess-1', a.id, { claimedByTaskId: 'tc-3', subagentType: 'explore' }),
    /终态，不可复用/,
  )

  // ⑤ 条目不在本会话板上 → 响亮拒绝
  await assert.rejects(
    () => svc.attachAttempt('sess-1', 'no-such-item', { claimedByTaskId: 'tc-4', subagentType: 'explore' }),
    /不在会话 sess-1 的板上/,
  )
})

test('attachAttempt 复用回流条目：历史留存、按新键自动结项（一件活一行）', async (t) => {
  const { svc } = await makeService(t)
  const row = await svc.post('sess-1', { title: '会被重派的活', createdBy: 'lead' })
  await svc.claim('sess-1', row.id, { assignee: 'explore·A', claimedByTaskId: 'tc-old' })
  const settled = await svc.settleByTaskId('tc-old', 'failed')
  assert.deepEqual(settled.reflowedIds, [row.id]) // 第 1 次失败 → 回流认领池

  const before = (await svc.readBoard('sess-1')).items
  assert.equal(before.length, 1)
  const reflowed = before[0]!
  assert.equal(reflowed.status, 'pending')
  assert.equal(reflowed.failCount, 1)
  assert.equal(reflowed.releaseHistory?.length, 1)

  // 重派：同一行上开始第二次尝试（不新建行）
  const again = await svc.attachAttempt('sess-1', row.id, { claimedByTaskId: 'tc-new', subagentType: 'explore' })
  assert.equal(again.status, 'in_progress')
  assert.equal(again.failCount, 1) // 失败史只增不丢
  assert.equal(again.releaseHistory?.length, 1)
  assert.equal((await svc.readBoard('sess-1')).items.length, 1) // 全程一行
  const done = await svc.settleByTaskId('tc-new', 'completed', { result: '这次成了' })
  assert.deepEqual(done.settledIds, [row.id])
  const final = (await svc.readBoard('sess-1')).items
  assert.equal(final.length, 1)
  assert.equal(final[0]!.status, 'completed')
  assert.match(final[0]!.result!, /这次成了/)
})
