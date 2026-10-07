import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBoardProgressText, buildBoardProjection } from '../../src/services/board/boardProjection.ts'
import {
  BOARD_RESULT_MAX_CHARS,
  type BoardItem,
  type BoardItemStatus,
  type BoardReleaseEntry,
} from '../../src/services/board/boardTypes.ts'

function item(over: Partial<BoardItem> & { id: string; status: BoardItemStatus }): BoardItem {
  return {
    title: `标题-${over.id}`,
    createdBy: 'lead',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function project(items: BoardItem[], opts: Partial<Parameters<typeof buildBoardProjection>[1]> = {}) {
  return buildBoardProjection(items, { pendingAskCount: 0, pendingApprovalCount: 0, now: 1000, ...opts })
}

const sysEntry: BoardReleaseEntry = { by: 'system', reason: '交付失败(第 1 次),条目自动回流认领池', at: 1 }
const humanEntry: BoardReleaseEntry = { by: 'w1', reason: '需要专门领域知识', suggestedTo: 'w2', at: 2 }

test('行序:要你置顶(待认领∪需拍板∪待裁决)→进行中→终态沉底(completed 按完成先后、cancelled 最后)', () => {
  const rows = project([
    item({ id: 'X1', status: 'cancelled', createdAt: 5, updatedAt: 10 }),
    item({ id: 'C1', status: 'completed', createdAt: 55, updatedAt: 300 }),
    item({ id: 'I1', status: 'in_progress', createdAt: 50, claimedAt: 200 }),
    item({ id: 'B1', status: 'blocked', createdAt: 150 }),
    item({ id: 'F1', status: 'failed', createdAt: 120 }),
    item({ id: 'C2', status: 'completed', createdAt: 60, updatedAt: 250 }),
    item({ id: 'P1', status: 'pending', createdAt: 100 }),
  ]).rows
  assert.deepEqual(
    rows.map((r) => r.itemId),
    ['P1', 'F1', 'B1', 'I1', 'C2', 'C1', 'X1'],
  )
})

test('行态徽章 label 六态词表', () => {
  const rows = project([
    item({ id: 'a', status: 'pending' }),
    item({ id: 'b', status: 'in_progress', assignee: 'w1' }),
    item({ id: 'c', status: 'blocked', assignee: 'w1' }),
    item({ id: 'd', status: 'completed' }),
    item({ id: 'e', status: 'cancelled' }),
    item({ id: 'f', status: 'failed' }),
  ]).rows
  const label = new Map(rows.map((r) => [r.itemId, r.label]))
  assert.equal(label.get('a'), '待认领')
  assert.equal(label.get('b'), '进行中')
  assert.equal(label.get('c'), '需拍板')
  assert.equal(label.get('d'), '已交付')
  assert.equal(label.get('e'), '已取消')
  assert.equal(label.get('f'), '待裁决')
})

test('进展行:进行中=note 优先→null', () => {
  assert.equal(
    buildBoardProgressText(item({ id: 'a', status: 'in_progress', note: '正在写第二章' })),
    '正在写第二章',
  )
  assert.equal(buildBoardProgressText(item({ id: 'b', status: 'in_progress' })), null)
})

test('进展行:待认领=最新留痕,失败记录/退回记录用词区分', () => {
  const sys = buildBoardProgressText(item({ id: 'a', status: 'pending', releaseHistory: [humanEntry, sysEntry] }))
  assert.equal(sys, `失败记录：${sysEntry.reason}`) // 取最新一条
  const human = buildBoardProgressText(item({ id: 'b', status: 'pending', releaseHistory: [humanEntry] }))
  assert.equal(human, '退回记录：w1：需要专门领域知识；建议下一任:w2')
  // 待裁决同规则(最新留痕=失败记录)
  assert.equal(
    buildBoardProgressText(item({ id: 'c', status: 'failed', releaseHistory: [sysEntry] })),
    `失败记录：${sysEntry.reason}`,
  )
})

test('进展行:无留痕=发帖说明(note 或 description 生成「发帖提议:」)', () => {
  assert.equal(buildBoardProgressText(item({ id: 'a', status: 'pending', note: '提议做 X' })), '发帖提议：提议做 X')
  assert.equal(
    buildBoardProgressText(item({ id: 'b', status: 'pending', description: '把报告写了' })),
    '发帖提议：把报告写了',
  )
  // note 优先于 description
  assert.equal(
    buildBoardProgressText(item({ id: 'c', status: 'pending', note: 'n', description: 'd' })),
    '发帖提议：n',
  )
  assert.equal(buildBoardProgressText(item({ id: 'd', status: 'pending' })), null)
})

test('进展行:需拍板=受阻原因(note)优先;终态=result/归档说明', () => {
  assert.equal(buildBoardProgressText(item({ id: 'a', status: 'blocked', note: '缺 API key' })), '缺 API key')
  assert.equal(
    buildBoardProgressText(item({ id: 'b', status: 'completed', result: '交付摘要' })),
    '交付摘要',
  )
  assert.equal(
    buildBoardProgressText(item({ id: 'c', status: 'cancelled', releaseHistory: [{ by: 'lead', reason: '用户撤单', at: 1 }] })),
    '归档说明：用户撤单',
  )
})

test('needsYou:待认领∪需拍板∪待裁决∪pendingAskCount∪pendingApprovalCount 全板', () => {
  const items = [
    item({ id: 'a', status: 'pending' }),
    item({ id: 'b', status: 'blocked' }),
    item({ id: 'c', status: 'failed' }),
    item({ id: 'd', status: 'in_progress' }),
    item({ id: 'e', status: 'completed' }),
  ]
  const p = project(items, { pendingAskCount: 2, pendingApprovalCount: 3 })
  assert.equal(p.needsYou.count, 3 + 2 + 3)
  assert.equal(p.needsYou.needed, true)
  const quiet = project([item({ id: 'a', status: 'completed' })])
  assert.equal(quiet.needsYou.count, 0)
  assert.equal(quiet.needsYou.needed, false)
})

test('strip 焦点批次口径:两批次混合行时计数只算最新批(按该批最早条目 createdAt 定序)', () => {
  const rows = project([
    // 旧批 b1:最早 10
    item({ id: 'a', status: 'completed', batchId: 'b1', createdAt: 10, updatedAt: 11 }),
    item({ id: 'b', status: 'cancelled', batchId: 'b1', createdAt: 20, updatedAt: 21 }),
    item({ id: 'c', status: 'pending', batchId: 'b1', createdAt: 30 }),
    // 新批 b2:最早 40 → 焦点
    item({ id: 'd', status: 'completed', batchId: 'b2', createdAt: 40, updatedAt: 41 }),
    item({ id: 'e', status: 'completed', batchId: 'b2', createdAt: 50, updatedAt: 51 }),
  ])
  assert.equal(rows.strip.countText, '2/2') // 只算 b2;全板混算会是 3/5
  assert.equal(rows.strip.status, 'settled')
  assert.equal(rows.strip.settleText, '2 个子任务完成')
})

test('strip:running 计数=终态/总行;settled 文案无归档/有归档两态', () => {
  const running = project([
    item({ id: 'a', status: 'completed', batchId: 'b1', createdAt: 1, updatedAt: 2 }),
    item({ id: 'b', status: 'in_progress', batchId: 'b1', createdAt: 3, assignee: 'w1' }),
    item({ id: 'c', status: 'blocked', batchId: 'b1', createdAt: 4, assignee: 'w1' }),
  ])
  assert.equal(running.strip.status, 'running')
  assert.equal(running.strip.countText, '1/3')
  assert.equal(running.strip.settleText, undefined)

  const settledWithArchive = project([
    item({ id: 'a', status: 'completed', batchId: 'b1', createdAt: 1, updatedAt: 2 }),
    item({ id: 'b', status: 'completed', batchId: 'b1', createdAt: 3, updatedAt: 4 }),
    item({ id: 'c', status: 'cancelled', batchId: 'b1', createdAt: 5, updatedAt: 6 }),
  ])
  assert.equal(settledWithArchive.strip.status, 'settled')
  assert.equal(settledWithArchive.strip.settleText, '结清 · 2 完成 1 归档')

  // 无 batchId=隐式一批(单批即该批)
  const single = project([
    item({ id: 'a', status: 'completed', createdAt: 1, updatedAt: 2 }),
    item({ id: 'b', status: 'completed', createdAt: 3, updatedAt: 4 }),
  ])
  assert.equal(single.strip.countText, '2/2')
  assert.equal(single.strip.settleText, '2 个子任务完成')
})

test('限窗:终态行超窗口标 clipped,要你∪进行中行全量保、要你行永不裁剪', () => {
  const items: BoardItem[] = []
  for (let i = 1; i <= 12; i++) {
    items.push(item({ id: `C${i}`, status: 'completed', createdAt: i, updatedAt: i }))
  }
  items.push(item({ id: 'OLD-P', status: 'pending', createdAt: 0 }))
  items.push(item({ id: 'OLD-F', status: 'failed', createdAt: 0 }))
  items.push(item({ id: 'RUN', status: 'in_progress', createdAt: 0, assignee: 'w1' }))

  const p = project(items) // 缺省终态窗口 10
  const byId = new Map(p.rows.map((r) => [r.itemId, r]))
  // 最旧的 2 条终态被限窗
  assert.equal(byId.get('C1')!.clipped, true)
  assert.equal(byId.get('C2')!.clipped, true)
  assert.equal(byId.get('C11')!.clipped, undefined)
  assert.equal(byId.get('C12')!.clipped, undefined)
  // 要你行/进行中行永不裁剪(哪怕比被裁的终态还旧)
  assert.equal(byId.get('OLD-P')!.clipped, undefined)
  assert.equal(byId.get('OLD-F')!.clipped, undefined)
  assert.equal(byId.get('RUN')!.clipped, undefined)
  assert.equal(p.windowed, true)
  assert.equal(p.rows.length, 15) // 全量行仍在,裁剪只是标记

  // 未触发限窗
  const small = project([item({ id: 'a', status: 'completed', updatedAt: 1 })])
  assert.equal(small.windowed, false)
})

test('第三层 detail 随行下发:result 全文/留痕/note/受阻原因/failCount/batchId 等齐全', () => {
  const over = 'y'.repeat(BOARD_RESULT_MAX_CHARS + 10)
  const rows = project([
    item({
      id: 'a',
      status: 'blocked',
      assignee: 'w1',
      description: '写报告',
      note: '缺 API key',
      batchId: 'b1',
      failCount: 2,
      releaseHistory: [sysEntry],
      stagnationAfter: 30,
      createdAt: 10,
      updatedAt: 20,
    }),
    item({ id: 'b', status: 'completed', result: over, createdAt: 5, updatedAt: 6 }),
  ]).rows
  const A = rows.find((r) => r.itemId === 'a')!
  assert.equal(A.detail.blockedReason, '缺 API key')
  assert.equal(A.detail.note, '缺 API key')
  assert.equal(A.detail.description, '写报告')
  assert.equal(A.detail.failCount, 2)
  assert.equal(A.detail.batchId, 'b1')
  assert.equal(A.detail.createdBy, 'lead')
  assert.equal(A.detail.createdAt, 10)
  assert.equal(A.detail.updatedAt, 20)
  assert.equal(A.detail.stagnationAfter, 30)
  assert.deepEqual(A.detail.releaseHistory, [sysEntry])
  const B = rows.find((r) => r.itemId === 'b')!
  assert.equal(B.detail.result!.length, BOARD_RESULT_MAX_CHARS + '\n…(超出 4KB,已截断)'.length)
  assert.match(B.detail.result!, /…\(超出 4KB,已截断\)$/)
})

test('claimedAt 计时基线随行;assignee 工位徽章文本透传(无主 null)', () => {
  const rows = project([
    item({ id: 'a', status: 'in_progress', assignee: 'researcher-2', claimedAt: 123 }),
    item({ id: 'b', status: 'pending' }),
  ]).rows
  assert.equal(rows.find((r) => r.itemId === 'a')!.claimedAt, 123)
  assert.equal(rows.find((r) => r.itemId === 'a')!.assignee, 'researcher-2')
  assert.equal(rows.find((r) => r.itemId === 'b')!.assignee, null)
})

test('strip.needsYou 透传要你信号', () => {
  const p = project([item({ id: 'a', status: 'completed' })], { pendingAskCount: 1 })
  assert.equal(p.strip.needsYou, true)
})

// ---------- M7 增量 2：回流态行 label 分流「待重派」 ----------

test('M7 增量 2：回流态行 label=待重派（判据=带 by:system 的留痕），status/needsYou/行序不动', () => {
  const p = project([
    item({ id: 'fresh', status: 'pending' }), // 从没人做过 → 待认领
    item({ id: 'reflowed', status: 'pending', failCount: 1, releaseHistory: [sysEntry] }),
    item({ id: 'human', status: 'pending', releaseHistory: [humanEntry] }), // 人工退回 ≠ 失败尝试
    item({ id: 'frozen', status: 'failed', failCount: 2, releaseHistory: [sysEntry] }),
  ])
  const byId = new Map(p.rows.map((r) => [r.itemId, r]))
  assert.equal(byId.get('fresh')!.label, '待认领')
  assert.equal(byId.get('reflowed')!.label, '待重派')
  assert.equal(byId.get('human')!.label, '待认领') // 人的退回不是"上一轮失败"
  assert.equal(byId.get('frozen')!.label, '待裁决') // 待裁决要的是裁决，不是重派

  // 状态与信号一律不动：三者都是要你，行序同在要你组
  assert.equal(byId.get('reflowed')!.status, 'pending')
  assert.equal(p.needsYou.count, 4)
  assert.equal(p.rows[0]!.label === '待重派' || p.rows[0]!.label === '待认领', true)
})
