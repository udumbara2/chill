import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  block,
  claim,
  createBoard,
  onTaskSettle,
  post,
  settle,
  adjudicate,
} from '../../src/services/board/boardCore.ts'
import type { BoardCaller, BoardState } from '../../src/services/board/boardTypes.ts'

const lead: BoardCaller = { role: 'lead' }

function empty(): BoardState {
  return createBoard('sess-1')
}

function addItem(state: BoardState, title: string): { state: BoardState; id: string } {
  const res = post(state, { title, createdBy: 'lead' })
  return { state: res.state, id: res.item.id }
}

test('onTaskSettle 自动结项:claimedByTaskId 匹配才结,result 标注自动结项', () => {
  let s = empty()
  const a = addItem(s, 'A')
  s = a.state
  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  const res = onTaskSettle(s, 't1', 'completed', { result: '交付内容' })
  const item = res.state.items.find((i) => i.id === a.id)!
  assert.equal(item.status, 'completed')
  assert.equal(item.result, '交付内容\n(自动结项:认领人任务交付)')
  assert.deepEqual(res.settledIds, [a.id])
})

test('onTaskSettle 自动结项:绑定不匹配/lead 认领无绑定不动', () => {
  let s = empty()
  const a = addItem(s, 'A') // 绑 t2,任务 t1 结项不碰
  s = a.state
  const b = addItem(s, 'B') // lead 认领无绑定
  s = b.state
  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't2' }).state
  s = claim(s, b.id, { assignee: 'lead' }).state
  const res = onTaskSettle(s, 't1', 'completed', { result: 'x' })
  assert.equal(res.settledIds.length, 0)
  assert.equal(res.state.items.find((i) => i.id === a.id)!.status, 'in_progress')
  assert.equal(res.state.items.find((i) => i.id === b.id)!.status, 'in_progress')
})

test('onTaskSettle 自动结项:绑定匹配但非 in_progress(blocked)不结', () => {
  let s = empty()
  const a = addItem(s, 'A')
  s = a.state
  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s = block(s, a.id, { reason: '等拍板' }, { role: 'worker', assignee: 'w1' }).state
  const res = onTaskSettle(s, 't1', 'completed', { result: 'x' })
  assert.equal(res.settledIds.length, 0)
  assert.equal(res.state.items[0].status, 'blocked')
})

test('死亡回流:认领人任务失败,其 in_progress 与 blocked 条目一并回 pending(blocked 附认领人已死)', () => {
  let s = empty()
  const a = addItem(s, 'A') // w1 进行中,绑定 t1
  s = a.state
  const b = addItem(s, 'B') // w1 受阻
  s = b.state
  const c = addItem(s, 'C') // w2 进行中,他人不动
  s = c.state
  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s = claim(s, b.id, { assignee: 'w1' }).state
  s = block(s, b.id, { reason: '等拍板' }, { role: 'worker', assignee: 'w1' }).state
  s = claim(s, c.id, { assignee: 'w2', claimedByTaskId: 't9' }).state

  const res = onTaskSettle(s, 't1', 'failed')
  const A = res.state.items.find((i) => i.id === a.id)!
  const B = res.state.items.find((i) => i.id === b.id)!
  const C = res.state.items.find((i) => i.id === c.id)!
  // A 是绑定 t1 的交付失败条目:失败记录 + failCount 1 → 回流
  assert.equal(A.status, 'pending')
  assert.equal(A.failCount, 1)
  // B 是同工位的受阻条目:一并回流 + 认领人已死 记录,不计 failCount
  assert.equal(B.status, 'pending')
  assert.equal(B.failCount, undefined)
  const bHist = B.releaseHistory!.at(-1)!
  assert.equal(bHist.by, 'system')
  assert.match(bHist.reason, /认领人已死/)
  // 认领字段清空
  assert.equal(A.assignee, undefined)
  assert.equal(A.claimedAt, undefined)
  assert.equal(A.claimedByTaskId, undefined)
  // 他人条目不动
  assert.equal(C.status, 'in_progress')
})

test('死亡回流:settle 单条目 failed/cancelled 时同工位在途条目一并回流', () => {
  let s = empty()
  const a = addItem(s, 'A')
  s = a.state
  const b = addItem(s, 'B')
  s = b.state
  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s = claim(s, b.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  const res = settle(s, a.id, 'failed')
  const A = res.state.items.find((i) => i.id === a.id)!
  const B = res.state.items.find((i) => i.id === b.id)!
  assert.equal(A.status, 'pending')
  assert.equal(A.failCount, 1)
  assert.equal(B.status, 'pending') // 同工位在途条目死亡回流
  assert.match(B.releaseHistory!.at(-1)!.reason, /认领人任务失败/)

  // cancelled:不计 failCount
  let s2 = empty()
  const x = addItem(s2, 'X')
  s2 = x.state
  const y = addItem(s2, 'Y')
  s2 = y.state
  s2 = claim(s2, x.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s2 = claim(s2, y.id, { assignee: 'w1' }).state
  const res2 = settle(s2, x.id, 'cancelled')
  const X = res2.state.items.find((i) => i.id === x.id)!
  const Y = res2.state.items.find((i) => i.id === y.id)!
  assert.equal(X.status, 'pending')
  assert.equal(X.failCount, undefined)
  assert.equal(Y.status, 'pending')
  assert.match(Y.releaseHistory!.at(-1)!.reason, /认领人任务被取消/)
})

test('failCount 递增与 ≥2→failed(待裁决)停留,不再回流', () => {
  let s = empty()
  const a = addItem(s, 'A')
  s = a.state
  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s = onTaskSettle(s, 't1', 'failed').state
  let A = s.items[0]
  assert.equal(A.status, 'pending')
  assert.equal(A.failCount, 1)
  assert.match(A.releaseHistory!.at(-1)!.reason, /失败记录|交付失败/)

  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't2' }).state
  s = onTaskSettle(s, 't2', 'failed').state
  A = s.items[0]
  assert.equal(A.status, 'failed')
  assert.equal(A.failCount, 2)
  // 停留待裁决:不是 pending,不能再认领
  assert.equal(A.assignee, 'w1') // 冻结归属快照(裁决上下文)
})

test('adjudicate 两出口:retry 回池不清 failCount;cancel 终态也不清', () => {
  let s = empty()
  const a = addItem(s, 'A')
  s = a.state
  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s = onTaskSettle(s, 't1', 'failed').state
  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't2' }).state
  s = onTaskSettle(s, 't2', 'failed').state
  assert.equal(s.items[0].status, 'failed')

  const retry = adjudicate(s, a.id, 'retry', lead)
  assert.equal(retry.item.status, 'pending')
  assert.equal(retry.item.failCount, 2)
  assert.equal(retry.item.assignee, undefined)

  // 再失败(第 3 次)依旧停留 failed
  let s2 = claim(retry.state, a.id, { assignee: 'w1', claimedByTaskId: 't3' }).state
  s2 = onTaskSettle(s2, 't3', 'failed').state
  assert.equal(s2.items[0].status, 'failed')
  assert.equal(s2.items[0].failCount, 3)

  const cancel = adjudicate(s2, a.id, 'cancel', lead)
  assert.equal(cancel.item.status, 'cancelled')
  assert.equal(cancel.item.failCount, 3)
})

test('onTaskSettle cancelled:绑定工位死亡回流,不计 failCount', () => {
  let s = empty()
  const a = addItem(s, 'A')
  s = a.state
  const b = addItem(s, 'B')
  s = b.state
  s = claim(s, a.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s = claim(s, b.id, { assignee: 'w1' }).state
  s = block(s, b.id, { reason: '等拍板' }, { role: 'worker', assignee: 'w1' }).state
  const res = onTaskSettle(s, 't1', 'cancelled')
  const A = res.state.items.find((i) => i.id === a.id)!
  const B = res.state.items.find((i) => i.id === b.id)!
  assert.equal(A.status, 'pending')
  assert.equal(A.failCount, undefined)
  assert.equal(B.status, 'pending')
  assert.match(B.releaseHistory!.at(-1)!.reason, /认领人已死/)
})

test('onTaskSettle 无绑定条目匹配任务=零动作', () => {
  let s = empty()
  const a = addItem(s, 'A')
  s = a.state
  s = claim(s, a.id, { assignee: 'w1' }).state // 无 claimedByTaskId
  const res = onTaskSettle(s, 't1', 'failed')
  assert.equal(res.reflowedIds.length, 0)
  assert.equal(res.frozenIds.length, 0)
  assert.equal(res.state.items[0].status, 'in_progress')
  assert.equal(res.state.revision, s.revision + 1) // 仍是单次 mutation(revision 单调)
})
