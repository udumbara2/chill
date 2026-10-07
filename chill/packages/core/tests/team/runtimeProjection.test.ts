import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeProjection, type RuntimeProcessTask } from '../../src/services/team/runtimeProjection.ts'
import { buildBoardProjection } from '../../src/services/board/boardProjection.ts'
import { isOverTokenBudget } from '../../src/services/team/teamPolicy.ts'
import type { TeamRunState, TeamSnapshot } from '../../src/services/team/teamRuntimeTypes.ts'

function makeSnapshot(maxTokens?: number): TeamSnapshot {
  return {
    grants: { lead: ['*'] },
    defaultMemberGrants: [],
    budget: { maxTokens },
    source: 'default',
    createdAt: 0,
    history: [],
  }
}

function makeTeam(overrides?: Partial<TeamRunState>): TeamRunState {
  return {
    runId: 't-1',
    name: '热点速报组',
    createdAt: 0,
    roster: [],
    board: [],
    boardRevision: 0,
    ...overrides,
  }
}

function makeTask(taskId: string, status: RuntimeProcessTask['status'] = 'running'): RuntimeProcessTask {
  return { taskId, subagentType: 'explore', description: `任务 ${taskId}`, status, output: '' }
}

// ---------------- isOverTokenBudget(判定 SSOT 同族;恰好等于上限 = 超) ----------------

test('isOverTokenBudget 边界:快照/账本/maxTokens/spent 任一缺失 → false', () => {
  assert.equal(isOverTokenBudget(undefined, undefined), false)
  assert.equal(isOverTokenBudget(makeSnapshot(100), undefined), false)
  assert.equal(isOverTokenBudget(makeSnapshot(undefined), { spentTokens: 200, memberCount: 1 }), false)
  assert.equal(isOverTokenBudget(makeSnapshot(100), { spentTokens: null, memberCount: 1 }), false)
})

test('isOverTokenBudget 边界:恰好等于上限 → true;未达/超出按比较', () => {
  assert.equal(isOverTokenBudget(makeSnapshot(100), { spentTokens: 100, memberCount: 1 }), true)
  assert.equal(isOverTokenBudget(makeSnapshot(100), { spentTokens: 99, memberCount: 1 }), false)
  assert.equal(isOverTokenBudget(makeSnapshot(100), { spentTokens: 101, memberCount: 1 }), true)
})

// ---------------- buildRuntimeProjection ----------------

test('空态:无团队且无任务 → hasRuntime=false,药丸不出现', () => {
  const p = buildRuntimeProjection(null, [])
  assert.equal(p.team, null)
  assert.deepEqual(p.independentTasks, [])
  assert.equal(p.runningCount, 0)
  assert.equal(p.allDone, false)
  assert.equal(p.overBudget, false)
  assert.equal(p.hasRuntime, false)
})

test('无团队:全部进程任务进独立任务区;idle 条目不计入', () => {
  const tasks = [makeTask('a', 'running'), makeTask('b', 'completed'), makeTask('c', 'idle')]
  const p = buildRuntimeProjection(undefined, tasks)
  assert.equal(p.team, null)
  assert.deepEqual(p.independentTasks.map((t) => t.taskId), ['a', 'b'])
  assert.equal(p.runningCount, 1)
  assert.equal(p.allDone, false)
  assert.equal(p.hasRuntime, true)
})

test('全部落地:有任务且全部终态 → allDone=true(折叠态 ✓ 全部完成)', () => {
  const p = buildRuntimeProjection(null, [makeTask('a', 'completed'), makeTask('b', 'cancelled')])
  assert.equal(p.allDone, true)
  assert.equal(p.runningCount, 0)
})

test('有团队:成员行按 currentTaskId 精确匹配任务描述;绑定任务不进独立区', () => {
  const team = makeTeam({
    roster: [
      { name: '调研员', agent: 'explore', status: 'running', currentTaskId: 'a', joinedAt: 0 },
      { name: '校对员', agent: 'review', status: 'standby', joinedAt: 0 },
    ],
  })
  const tasks = [makeTask('a', 'running'), makeTask('x', 'running')]
  const p = buildRuntimeProjection(team, tasks)
  assert.equal(p.team?.members.length, 2)
  assert.equal(p.team?.members[0].task?.taskId, 'a')
  assert.equal(p.team?.members[1].task, undefined)
  assert.deepEqual(p.independentTasks.map((t) => t.taskId), ['x'])
  assert.equal(p.runningCount, 2)
})

test('有团队:成员任务已终态仍按绑定归属成员(不进独立区)', () => {
  const team = makeTeam({
    roster: [{ name: '调研员', agent: 'explore', status: 'idle', currentTaskId: 'a', joinedAt: 0 }],
  })
  const p = buildRuntimeProjection(team, [makeTask('a', 'completed')])
  assert.deepEqual(p.independentTasks, [])
  assert.equal(p.team?.members[0].task?.status, 'completed')
  assert.equal(p.allDone, true)
})

test('有团队:看板计数按状态聚类', () => {
  const mk = (id: string, status: 'pending' | 'in_progress' | 'completed' | 'failed') => ({
    id, title: id, status, createdBy: 'lead', createdAt: 0, updatedAt: 0,
  })
  const team = makeTeam({
    board: [mk('1', 'pending'), mk('2', 'in_progress'), mk('3', 'in_progress'), mk('4', 'completed'), mk('5', 'failed')],
  })
  const p = buildRuntimeProjection(team, [])
  assert.deepEqual(p.team?.boardCounts, { pending: 1, inProgress: 2, completed: 1, failed: 1 })
  assert.equal(p.hasRuntime, true)
})

test('账本行:formatTokenSpend 三态 + 上限拼接;超预算标记透传 isOverTokenBudget', () => {
  const under = makeTeam({ snapshot: makeSnapshot(10000), ledger: { spentTokens: 200, memberCount: 2 } })
  const pUnder = buildRuntimeProjection(under, [])
  assert.equal(pUnder.team?.ledgerText, '200 / 10000')
  assert.equal(pUnder.overBudget, false)

  const over = makeTeam({ snapshot: makeSnapshot(100), ledger: { spentTokens: 200, memberCount: 2, estimated: true } })
  const pOver = buildRuntimeProjection(over, [])
  assert.equal(pOver.team?.ledgerText, '~200(估值) / 100')
  assert.equal(pOver.overBudget, true)

  const noData = makeTeam({ snapshot: makeSnapshot(100) })
  const pNoData = buildRuntimeProjection(noData, [])
  assert.equal(pNoData.team?.ledgerText, '未知 / 100')
  assert.equal(pNoData.overBudget, false)
})

// ---------------- 看板显示三段式(成员行 claim / boardGroups / pendingWarning) ----------------

const mkItem = (
  id: string,
  status: 'pending' | 'in_progress' | 'completed' | 'failed',
  extra?: Partial<TeamRunState['board'][number]>,
): TeamRunState['board'][number] => ({
  id,
  title: `条目${id}`,
  status,
  createdBy: 'lead',
  createdAt: 0,
  updatedAt: 0,
  ...extra,
})

test('成员行 claim:匹配 assignee===成员名 且进行中的条目;lead 认领/他人认领/已完成不计', () => {
  const team = makeTeam({
    roster: [
      { name: '调研员', agent: 'explore', status: 'running', joinedAt: 0 },
      { name: '校对员', agent: 'review', status: 'standby', joinedAt: 0 },
    ],
    board: [
      mkItem('1', 'in_progress', { assignee: '调研员', claimedAt: 12345 }),
      mkItem('2', 'in_progress', { assignee: 'lead', claimedAt: 999 }), // lead 认领不计成员行
      mkItem('3', 'completed', { assignee: '校对员' }), // 已完成不计
    ],
  })
  const p = buildRuntimeProjection(team, [])
  assert.deepEqual(p.team?.members[0].claim, { itemTitle: '条目1', claimedAt: 12345 })
  assert.equal(p.team?.members[1].claim, undefined)
})

test('boardGroups:固定序(待认领/进行中/已完成/失败退回)且空组不出现;字段含退回历史', () => {
  const releaseHistory = [{ by: '调研员', reason: '反爬换源', suggestedTo: '撰稿员', at: 100 }]
  const team = makeTeam({
    board: [
      mkItem('1', 'completed', { assignee: '调研员', result: 'done' }),
      mkItem('2', 'pending'),
      mkItem('3', 'failed', { assignee: '调研员', releaseHistory }),
      mkItem('4', 'in_progress', { assignee: '调研员', claimedAt: 7 }),
    ],
  })
  const p = buildRuntimeProjection(team, [])
  const groups = p.team!.boardGroups
  assert.deepEqual(groups.map((g) => g.status), ['pending', 'in_progress', 'completed', 'failed'])
  assert.equal(groups[1].items[0].claimedAt, 7)
  assert.deepEqual(groups[3].items[0].releaseHistory, releaseHistory)
  assert.equal(groups[2].items[0].result, 'done')
})

test('boardGroups 空看板:无分组;pendingWarning 缺省', () => {
  const p = buildRuntimeProjection(makeTeam(), [])
  assert.deepEqual(p.team?.boardGroups, [])
  assert.equal(p.team?.pendingWarning, undefined)
})

test('pendingWarning:取最早一条待认领(最久滞留=最高信号)+ 总条数', () => {
  const team = makeTeam({
    board: [
      mkItem('1', 'pending', { createdAt: 300 }),
      mkItem('2', 'pending', { createdAt: 100, title: '最早待认领' }),
      mkItem('3', 'in_progress', { assignee: '调研员' }),
    ],
  })
  const p = buildRuntimeProjection(team, [])
  assert.deepEqual(p.team?.pendingWarning, { title: '最早待认领', createdAt: 100, count: 2 })
})

// ---------------- V4.2 收编:boardGroups/pendingWarning 与 boardProjection 同源 ----------------

test('V4.2 同源一致性:boardGroups 组内序=boardProjection 行序;pendingWarning=投影行序首条 pending', () => {
  const team = makeTeam({
    board: [
      mkItem('p2', 'pending', { createdAt: 200, title: '晚挂的' }),
      mkItem('p1', 'pending', { createdAt: 100, title: '早挂的' }),
      mkItem('d2', 'completed', { updatedAt: 200 }),
      mkItem('d1', 'completed', { updatedAt: 100 }),
      mkItem('f1', 'failed', { assignee: '调研员' }),
      mkItem('i1', 'in_progress', { assignee: '调研员', claimedAt: 5 }),
    ],
  })
  const projection = buildBoardProjection(team.board, { pendingAskCount: 0, pendingApprovalCount: 0, now: 0 })
  const p = buildRuntimeProjection(team, [])
  // 同组同序:每组 items 序 === boardProjection.rows 过滤后的行序(不再各算一套)
  for (const g of p.team!.boardGroups) {
    assert.deepEqual(
      g.items.map((i) => i.id),
      projection.rows.filter((r) => r.status === g.status).map((r) => r.itemId),
      `组 ${g.status} 与投影行序不一致`,
    )
  }
  // pending 组=最久滞留在前(投影行序);completed 组=完成先后(投影行序)
  assert.deepEqual(
    p.team!.boardGroups.find((g) => g.status === 'pending')!.items.map((i) => i.id),
    ['p1', 'p2'],
  )
  assert.deepEqual(
    p.team!.boardGroups.find((g) => g.status === 'completed')!.items.map((i) => i.id),
    ['d1', 'd2'],
  )
  // pendingWarning = 投影行序首条 pending(要你判定/序同源);计数语义不变(待认领总条数)
  const firstPending = projection.rows.find((r) => r.status === 'pending')!
  assert.deepEqual(p.team!.pendingWarning, {
    title: firstPending.title,
    createdAt: firstPending.detail.createdAt,
    count: 2,
  })
})
