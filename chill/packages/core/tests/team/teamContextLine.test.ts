import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTeamContextLine, NO_TEAM_CONTEXT_LINE } from '../../src/services/team/teamContextLine.ts'
import { buildRuntimeProjection } from '../../src/services/team/runtimeProjection.ts'
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

function makeMember(name: string, status: TeamRunState['roster'][number]['status']) {
  return { name, agent: 'general-purpose', status, joinedAt: 0 }
}

test('无团队:返回固定中性指引行(null/undefined 同语义)', () => {
  assert.equal(buildTeamContextLine(null), NO_TEAM_CONTEXT_LINE)
  assert.equal(buildTeamContextLine(undefined), NO_TEAM_CONTEXT_LINE)
  assert.match(NO_TEAM_CONTEXT_LINE, /当前没有活动团队/)
  assert.match(NO_TEAM_CONTEXT_LINE, /忽略本行/) // 中性、不诱导组队
})

test('有团队:一行摘要含团队名/成员计数/看板四计数/账本行', () => {
  const line = buildTeamContextLine(
    makeTeam({
      roster: [makeMember('调研员', 'running'), makeMember('撰稿员', 'standby'), makeMember('校对员', 'standby')],
      board: [
        { id: 'b1', title: 'A', status: 'pending', createdBy: 'lead', createdAt: 0, updatedAt: 0 },
        { id: 'b2', title: 'B', status: 'in_progress', createdBy: 'lead', createdAt: 0, updatedAt: 0 },
        { id: 'b3', title: 'C', status: 'completed', createdBy: 'lead', createdAt: 0, updatedAt: 0 },
      ],
      snapshot: makeSnapshot(),
      ledger: { spentTokens: 1200, memberCount: 3 },
    }),
  )
  assert.ok(!line.includes('\n'), '固定一行')
  assert.match(line, /团队「热点速报组」/)
  assert.match(line, /成员 3\(执行中1\/待命2\)/) // 零计数状态不出现
  assert.match(line, /看板 待认领1\/进行中1\/已完成1\/失败0/)
  assert.match(line, /账本 1200/)
  assert.ok(!line.includes('已超'))
})

test('临时团队:无队名时标"临时团队"', () => {
  const line = buildTeamContextLine(makeTeam({ name: undefined }))
  assert.match(line, /临时团队/)
  assert.match(line, /成员 0/)
})

test('超预算:账本行带(已超)标注(判定透传 isOverTokenBudget,恰好等于上限=超)', () => {
  const line = buildTeamContextLine(
    makeTeam({
      snapshot: makeSnapshot(100),
      ledger: { spentTokens: 100, memberCount: 0 },
    }),
  )
  assert.match(line, /账本 100 \/ 100\(已超\)/)
})

test('估值账本:~ 前缀与(估值)标注经投影三态透传', () => {
  const line = buildTeamContextLine(
    makeTeam({
      snapshot: makeSnapshot(),
      ledger: { spentTokens: 2300, memberCount: 1, estimated: true },
    }),
  )
  assert.match(line, /账本 ~2300\(估值\)/)
})

test('V4.2 计数语义不变:看板四计数与投影 boardCounts 对账(薄包装零新判定,收编后输出不变)', () => {
  const board: TeamRunState['board'] = [
    { id: 'b1', title: 'A', status: 'pending', createdBy: 'lead', createdAt: 0, updatedAt: 0 },
    { id: 'b2', title: 'B', status: 'in_progress', createdBy: 'lead', createdAt: 0, updatedAt: 0 },
    { id: 'b3', title: 'C', status: 'completed', createdBy: 'lead', createdAt: 0, updatedAt: 0 },
    { id: 'b4', title: 'D', status: 'failed', createdBy: 'lead', createdAt: 0, updatedAt: 0 },
    { id: 'b5', title: 'E', status: 'failed', createdBy: 'lead', createdAt: 0, updatedAt: 0 },
  ]
  const team = makeTeam({ board, snapshot: makeSnapshot(), ledger: { spentTokens: 0, memberCount: 1 } })
  const line = buildTeamContextLine(team)
  assert.match(line, /看板 待认领1\/进行中1\/已完成1\/失败2/)
  // 与投影 boardCounts 同账(收编改吃 boardProjection 后计数不漂)
  const projectionTeam = buildRuntimeProjection(team, []).team!
  assert.deepEqual(projectionTeam.boardCounts, { pending: 1, inProgress: 1, completed: 1, failed: 2 })
})
