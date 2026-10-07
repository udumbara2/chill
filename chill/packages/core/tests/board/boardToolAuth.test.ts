import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionBoardService,
  resetSessionBoardService,
  setSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import { BoardStore } from '../../src/services/board/boardStore.ts'
import { executeBoard } from '../../src/services/board/boardTool.ts'

const SID = 'sess-1'
/** Worker 来源(网关注入形态;subagentType 网关可信,参数自报身份无效) */
const W1 = { source: 'subagent', taskId: 'tc-1', subagentType: 'explore' }
const W2 = { source: 'subagent', taskId: 'tc-2', subagentType: 'writer' }

async function setup(t: TestContext): Promise<SessionBoardService> {
  const dir = await mkdtemp(join(tmpdir(), 'board-tool-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  t.after(async () => {
    resetSessionBoardService()
    await rm(dir, { recursive: true, force: true })
  })
  return svc
}

function call(payload: object, origin?: object, sessionId: string = SID) {
  return executeBoard(JSON.stringify(payload), origin as never, sessionId)
}

test('Lead 全权:post/claim/update(result)/release/remove/adjudicate/unblock/cancel_item/read', async (t) => {
  const svc = await setup(t)
  // post + read 列表/全文
  const posted = await call({ action: 'post', title: '任务一', description: '说明', note: '提议' })
  assert.equal(posted.success, true)
  const id = /\[(\w+)\]/.exec(posted.data!)![1]
  const list = await call({ action: 'read' })
  assert.match(list.data!, /任务一/)
  const full = await call({ action: 'read', id })
  assert.match(full.data!, /说明/)

  // claim(assignee='lead',无任务绑定)
  const claimed = await call({ action: 'claim', id })
  assert.equal(claimed.success, true)
  const item = (await svc.readBoard(SID)).items[0]
  assert.equal(item.assignee, 'lead')
  assert.equal(item.claimedByTaskId, undefined)

  // update:note/result/stagnation_after 全可
  const upd = await call({ action: 'update', id, note: '进展', result: '交付', stagnation_after: 30 })
  assert.equal(upd.success, true)

  // unblock 仅 Lead:经服务置 blocked(工具不暴露 block 动作)后 Lead 解除
  await svc.block(SID, id, { reason: '等拍板' }, { role: 'lead' })
  const un = await call({ action: 'unblock', id })
  assert.equal(un.success, true)
  assert.equal((await svc.readBoard(SID)).items.find((i) => i.id === id)!.status, 'in_progress')

  // release → 重新 claim
  const rel = await call({ action: 'release', id, reason: '重新分工' })
  assert.equal(rel.success, true)
  await call({ action: 'claim', id })

  // remove 仅 Lead:先建另一条走 cancel_item,再删
  const p2 = await call({ action: 'post', title: '任务二' })
  const id2 = /\[(\w+)\]/.exec(p2.data!)![1]
  const cancel = await call({ action: 'cancel_item', id: id2, reason: '用户撤单' })
  assert.equal(cancel.success, true)
  assert.equal((await svc.readBoard(SID)).items.find((i) => i.id === id2)!.status, 'cancelled')
  const rmRes = await call({ action: 'remove', id: id2 })
  assert.equal(rmRes.success, true)

  // adjudicate 仅 Lead:造 failed(待裁决)后裁决 retry
  const p3 = await call({ action: 'post', title: '任务三' })
  const id3 = /\[(\w+)\]/.exec(p3.data!)![1]
  await svc.claim(SID, id3, { assignee: 'w9', claimedByTaskId: 't9' })
  await svc.settleByTaskId('t9', 'failed')
  await svc.claim(SID, id3, { assignee: 'w9', claimedByTaskId: 't8' })
  await svc.settleByTaskId('t8', 'failed') // 第 2 败 → 待裁决
  const adj = await call({ action: 'adjudicate', id: id3, decision: 'retry' })
  assert.equal(adj.success, true)
  assert.match(adj.data!, /失败计数保留:2/)
})

test('worker 受限:read/post/claim/update note/release 自己条目可;Lead 专属四动作拒绝', async (t) => {
  await setup(t)
  const posted = await call({ action: 'post', title: 'W1 挂项', note: '提议' }, W1)
  assert.equal(posted.success, true)
  const id = /\[(\w+)\]/.exec(posted.data!)![1]
  await call({ action: 'claim', id }, W1)

  // worker update 自己条目 note 可
  assert.equal((await call({ action: 'update', id, note: '关键节点:完成调研' }, W1)).success, true)
  // worker update result/stagnation_after 拒绝
  const badResult = await call({ action: 'update', id, result: '想交付' }, W1)
  assert.equal(badResult.success, false)
  assert.match(badResult.error!, /仅 Lead 可写/)
  // worker release 自己条目可(缺原因拒绝)
  assert.equal((await call({ action: 'release', id, reason: '做不了' }, W1)).success, true)

  // Lead 专属动作:remove/adjudicate/unblock/cancel_item 全拒
  for (const action of ['remove', 'adjudicate', 'unblock', 'cancel_item']) {
    const res = await call({ action, id, decision: 'retry' }, W1)
    assert.equal(res.success, false, `worker 不可用 ${action}`)
    assert.match(res.error!, /仅 Lead 可用/)
  }

  // worker update/release 他人条目拒(boardCore 归属约束)
  const other = await call({ action: 'post', title: 'W2 挂项' }, W2)
  const otherId = /\[(\w+)\]/.exec(other.data!)![1]
  await call({ action: 'claim', id: otherId }, W2)
  const cross = await call({ action: 'update', id: otherId, note: '偷改' }, W1)
  assert.equal(cross.success, false)
  assert.match(cross.error!, /仅认领人或 Lead/)
  const crossRel = await call({ action: 'release', id: otherId, reason: 'x' }, W1)
  assert.equal(crossRel.success, false)
})

test('身份数据驱动:工位经 __origin.taskId 反查,参数自报无效', async (t) => {
  const svc = await setup(t)
  // Worker 的 post:createdBy 强制为工位(接口根本不收自报 createdBy)
  const posted = await call({ action: 'post', title: '匿名挂项', created_by: '伪造者', assignee: '伪造者' }, W1)
  assert.equal(posted.success, true)
  const item = (await svc.readBoard(SID)).items[0]
  assert.equal(item.createdBy, 'explore·A') // 工位来自网关注入的 subagentType·短序号
  assert.notEqual(item.createdBy, '伪造者')

  // claim(领下一条,意图态):认领人强制为本工位;不绑任务键——自报 claimed_by_task_id/assignee 一律无效
  const claimed = await call({ action: 'claim', id: item.id, claimed_by_task_id: '伪造任务', assignee: '伪造者' }, W1)
  assert.equal(claimed.success, true)
  const after = (await svc.readBoard(SID)).items[0]
  assert.equal(after.assignee, 'explore·A')
  assert.equal(after.claimedByTaskId, undefined) // V3 意图认领:不绑键(续跑换绑);自报键不采

  // release:by 强制为本工位
  const rel = await call({ action: 'release', id: item.id, reason: '退回', by: 'lead' }, W1)
  assert.equal(rel.success, true)
  assert.equal((await svc.readBoard(SID)).items[0].releaseHistory!.at(-1)!.by, 'explore·A')

  // 无 origin 的 subagent 来源缺 taskId:响亮拒绝
  const noTask = await call({ action: 'post', title: 'x' }, { source: 'subagent' })
  assert.equal(noTask.success, false)
  assert.match(noTask.error!, /taskId/)

  // 缺 sessionId:响亮拒绝
  const noSid = await call({ action: 'read' }, undefined, '')
  assert.equal(noSid.success, false)
  assert.match(noSid.error!, /sessionId/)
})

test('未装配服务:响亮报错', async () => {
  resetSessionBoardService()
  const res = await executeBoard(JSON.stringify({ action: 'read' }), undefined, SID)
  assert.equal(res.success, false)
  assert.match(res.error!, /未装配/)
})
