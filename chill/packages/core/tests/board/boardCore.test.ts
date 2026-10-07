import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adjudicate,
  block,
  cancelItem,
  claim,
  createBoard,
  post,
  read,
  release,
  remove,
  settle,
  unblock,
  update,
} from '../../src/services/board/boardCore.ts'
import {
  BOARD_RESULT_MAX_CHARS,
  BoardError,
  type BoardCaller,
} from '../../src/services/board/boardTypes.ts'

const lead: BoardCaller = { role: 'lead' }
const w1: BoardCaller = { role: 'worker', assignee: 'w1' }
const w2: BoardCaller = { role: 'worker', assignee: 'w2' }

function isBoardError(code: string) {
  return (err: unknown) => err instanceof BoardError && err.code === code
}

function seed(title = '任务', extra: Partial<Parameters<typeof post>[1]> = {}) {
  let state = createBoard('sess-1')
  const res = post(state, { title, createdBy: 'lead', ...extra })
  state = res.state
  return { state, id: res.item.id }
}

test('createBoard: 空板 revision 0', () => {
  const state = createBoard('sess-1')
  assert.equal(state.revision, 0)
  assert.equal(state.items.length, 0)
  assert.equal(state.boardId, 'sess-1')
})

test('post: 挂项得 pending 条目,字段齐全', () => {
  const state = createBoard('sess-1')
  const res = post(state, { title: '调研', description: '做调研', batchId: 'b-1', createdBy: 'w1', note: '提议做' })
  assert.equal(res.item.status, 'pending')
  assert.equal(res.item.title, '调研')
  assert.equal(res.item.description, '做调研')
  assert.equal(res.item.batchId, 'b-1')
  assert.equal(res.item.createdBy, 'w1')
  assert.equal(res.item.note, '提议做')
  assert.equal(res.revision, 1)
  // 纯函数:输入状态不被修改
  assert.equal(state.items.length, 0)
  assert.equal(state.revision, 0)
})

test('post: 缺 title 抛 INVALID_INPUT', () => {
  const state = createBoard('sess-1')
  assert.throws(() => post(state, { title: '  ', createdBy: 'lead' }), isBoardError('INVALID_INPUT'))
})

test('六态流转全矩阵:pending→in_progress→blocked→in_progress→completed', () => {
  const { state, id } = seed()
  const c1 = claim(state, id, { assignee: 'w1', claimedByTaskId: 't1' })
  assert.equal(c1.item.status, 'in_progress')
  const b1 = block(c1.state, id, { reason: '等拍板' }, w1)
  assert.equal(b1.item.status, 'blocked')
  assert.equal(b1.item.note, '等拍板')
  const u1 = unblock(b1.state, id, lead)
  assert.equal(u1.item.status, 'in_progress')
  const s1 = settle(u1.state, id, 'completed', { result: '交付摘要' })
  assert.equal(s1.item.status, 'completed')
  assert.equal(s1.item.result, '交付摘要')
})

test('六态流转全矩阵:in_progress→pending(release 退回)→in_progress 再认领', () => {
  const { state, id } = seed()
  const c1 = claim(state, id, { assignee: 'w1' })
  const r1 = release(c1.state, id, { by: 'w1', reason: '需要专门领域知识', suggestedTo: 'w2' })
  assert.equal(r1.item.status, 'pending')
  assert.equal(r1.item.assignee, undefined)
  const c2 = claim(r1.state, id, { assignee: 'w2' })
  assert.equal(c2.item.status, 'in_progress')
  assert.equal(c2.item.assignee, 'w2')
})

test('六态流转全矩阵:pending→cancelled(cancelItem 撤单留痕)', () => {
  const { state, id } = seed()
  const x1 = cancelItem(state, id, { by: 'lead', reason: '用户撤单' })
  assert.equal(x1.item.status, 'cancelled')
  assert.equal(x1.item.releaseHistory!.length, 1)
  assert.equal(x1.item.releaseHistory![0].reason, '用户撤单')
})

test('六态流转全矩阵:in_progress→failed(待裁决)→cancelled(adjudicate cancel)', () => {
  const { state, id } = seed()
  let s = claim(state, id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s = settle(s, id, 'failed').state // 第 1 次失败 → 回流 pending
  assert.equal(s.items[0].status, 'pending')
  s = claim(s, id, { assignee: 'w1', claimedByTaskId: 't2' }).state
  s = settle(s, id, 'failed').state // 第 2 次失败 → 停留 failed(待裁决)
  assert.equal(s.items[0].status, 'failed')
  const a1 = adjudicate(s, id, 'cancel', lead)
  assert.equal(a1.item.status, 'cancelled')
})

test('六态流转全矩阵:failed(待裁决)→pending(adjudicate retry,failCount 不清零)', () => {
  const { state, id } = seed()
  let s = claim(state, id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s = settle(s, id, 'failed').state
  s = claim(s, id, { assignee: 'w1', claimedByTaskId: 't2' }).state
  s = settle(s, id, 'failed').state
  const a1 = adjudicate(s, id, 'retry', lead)
  assert.equal(a1.item.status, 'pending')
  assert.equal(a1.item.failCount, 2)
  assert.equal(a1.item.assignee, undefined)
})

test('claim 原子防重:已认领/非 pending 一律 NOT_CLAIMABLE', () => {
  const { state, id } = seed()
  const c1 = claim(state, id, { assignee: 'w1' })
  assert.throws(() => claim(c1.state, id, { assignee: 'w2' }), isBoardError('NOT_CLAIMABLE'))
  const b1 = block(c1.state, id, { reason: 'x' }, w1)
  assert.throws(() => claim(b1.state, id, { assignee: 'w2' }), isBoardError('NOT_CLAIMABLE'))
})

test('归属约束:update 仅认领人或 Lead(权限矩阵)', () => {
  const { state, id } = seed()
  const c1 = claim(state, id, { assignee: 'w1' })
  assert.throws(() => update(c1.state, id, { note: '偷改' }, w2), isBoardError('FORBIDDEN'))
  const u1 = update(c1.state, id, { note: '进展' }, w1)
  assert.equal(u1.item.note, '进展')
  const u2 = update(c1.state, id, { note: 'Lead 代记' }, lead)
  assert.equal(u2.item.note, 'Lead 代记')
  // 无人认领的 pending:仅 Lead
  const { state: s2, id: id2 } = seed('另一任务')
  assert.throws(() => update(s2, id2, { note: 'x' }, w1), isBoardError('FORBIDDEN'))
})

test('归属约束:release 仅认领人或 Lead;remove 仅 Lead;adjudicate 仅 Lead', () => {
  const { state, id } = seed()
  const c1 = claim(state, id, { assignee: 'w1' })
  assert.throws(() => release(c1.state, id, { by: 'w2', reason: 'x' }), isBoardError('FORBIDDEN'))
  const rLead = release(c1.state, id, { by: 'lead', reason: '重新分工' })
  assert.equal(rLead.item.status, 'pending')
  assert.throws(() => remove(c1.state, id, w1), isBoardError('FORBIDDEN'))
  assert.equal(remove(c1.state, id, lead).state.items.length, 0)

  let s = claim(state, id, { assignee: 'w1', claimedByTaskId: 't1' }).state
  s = settle(s, id, 'failed').state
  s = claim(s, id, { assignee: 'w1', claimedByTaskId: 't2' }).state
  s = settle(s, id, 'failed').state
  assert.throws(() => adjudicate(s, id, 'retry', w1), isBoardError('FORBIDDEN'))
})

test('归属约束:block/unblock 仅认领人或 Lead', () => {
  const { state, id } = seed()
  const c1 = claim(state, id, { assignee: 'w1' })
  assert.throws(() => block(c1.state, id, { reason: 'x' }, w2), isBoardError('FORBIDDEN'))
  const b1 = block(c1.state, id, { reason: '等拍板' }, w1)
  assert.throws(() => unblock(b1.state, id, w2), isBoardError('FORBIDDEN'))
})

test('release 留痕:by/reason/suggestedTo/at 齐全,清 assignee/claimedAt/claimedByTaskId', () => {
  const { state, id } = seed()
  const c1 = claim(state, id, { assignee: 'w1', claimedByTaskId: 't1' })
  assert.equal(c1.item.claimedAt !== undefined, true)
  const r1 = release(c1.state, id, { by: 'w1', reason: '需要专门领域知识', suggestedTo: 'w2' })
  const hist = r1.item.releaseHistory!
  assert.equal(hist.length, 1)
  assert.equal(hist[0].by, 'w1')
  assert.equal(hist[0].reason, '需要专门领域知识')
  assert.equal(hist[0].suggestedTo, 'w2')
  assert.equal(typeof hist[0].at, 'number')
  assert.equal(r1.item.assignee, undefined)
  assert.equal(r1.item.claimedAt, undefined)
  assert.equal(r1.item.claimedByTaskId, undefined)
  assert.equal(r1.previousAssignee, 'w1')
})

test('release: 非进行中拒绝;缺原因拒绝', () => {
  const { state, id } = seed()
  assert.throws(() => release(state, id, { by: 'lead', reason: 'x' }), isBoardError('INVALID_STATE'))
  const c1 = claim(state, id, { assignee: 'w1' })
  assert.throws(() => release(c1.state, id, { by: 'w1', reason: '   ' }), isBoardError('INVALID_INPUT'))
})

test('状态机拒绝非法转移(settle/cancelItem/block/unblock/adjudicate)', () => {
  const { state, id } = seed()
  assert.throws(() => settle(state, id, 'completed'), isBoardError('INVALID_STATE'))
  assert.throws(() => block(state, id, { reason: 'x' }, lead), isBoardError('INVALID_STATE'))
  assert.throws(() => unblock(state, id, lead), isBoardError('INVALID_STATE'))
  assert.throws(() => adjudicate(state, id, 'retry', lead), isBoardError('INVALID_STATE'))
  const x1 = cancelItem(state, id, { by: 'lead', reason: '撤' })
  assert.throws(() => cancelItem(x1.state, id, { by: 'lead', reason: '再撤' }), isBoardError('INVALID_STATE'))
  assert.throws(() => settle(x1.state, id, 'failed'), isBoardError('INVALID_STATE'))
})

test('查无条目抛 ITEM_NOT_FOUND', () => {
  const state = createBoard('sess-1')
  assert.throws(() => claim(state, 'nope', { assignee: 'w1' }), isBoardError('ITEM_NOT_FOUND'))
})

test('revision 单调:每次 mutation 自增一,read 不增', () => {
  let { state, id } = seed()
  assert.equal(state.revision, 1)
  state = claim(state, id, { assignee: 'w1' }).state
  assert.equal(state.revision, 2)
  state = update(state, id, { note: 'n' }, w1).state
  assert.equal(state.revision, 3)
  state = block(state, id, { reason: 'r' }, w1).state
  assert.equal(state.revision, 4)
  state = unblock(state, id, w1).state
  assert.equal(state.revision, 5)
  state = release(state, id, { by: 'w1', reason: 'r' }).state
  assert.equal(state.revision, 6)
  assert.equal(read(state).revision, 6)
  state = claim(state, id, { assignee: 'w1' }).state
  state = settle(state, id, 'completed').state
  assert.equal(state.revision, 8)
})

test('4KB 截断:post note / update note+result / settle result 超限截断并明示', () => {
  const over = 'x'.repeat(BOARD_RESULT_MAX_CHARS + 100)
  const state = createBoard('sess-1')
  const p = post(state, { title: 't', createdBy: 'lead', note: over })
  assert.equal(p.noteTruncated, true)
  assert.equal(p.item.note!.length, BOARD_RESULT_MAX_CHARS + '\n…(超出 4KB,已截断)'.length)
  assert.match(p.item.note!, /…\(超出 4KB,已截断\)$/)

  const c = claim(p.state, p.item.id, { assignee: 'w1' })
  const u = update(c.state, p.item.id, { note: over, result: over }, w1)
  assert.equal(u.noteTruncated, true)
  assert.equal(u.resultTruncated, true)
  assert.match(u.item.result!, /…\(超出 4KB,已截断\)$/)

  const s = settle(u.state, p.item.id, 'failed')
  const again = claim(s.state, p.item.id, { assignee: 'w1' })
  const done = settle(again.state, p.item.id, 'completed', { result: over })
  assert.equal(done.resultTruncated, true)
  assert.match(done.item.result!, /…\(超出 4KB,已截断\)$/)
})
