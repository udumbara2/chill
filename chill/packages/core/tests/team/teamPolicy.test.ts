import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applySnapshotUpdate,
  assertExemptionsIntact,
  assertLegalGrants,
  canBoardAction,
  canSpawnWithinBudget,
  createDefaultSnapshot,
  DEFAULT_MEMBER_GRANTS,
  hasGrant,
  summarizeSnapshot,
} from '../../src/services/team/teamPolicy.ts'
import type { TeamSnapshot } from '../../src/services/team/teamRuntimeTypes.ts'

// ---------- 合法值校验 ----------

test('assertLegalGrants: 合法值通过,非法值响亮抛错', () => {
  assertLegalGrants(['task', 'team_board:claim', 'team_board:release', 'team_board', 'send_message'], 'm1')
  assert.throws(() => assertLegalGrants(['fly_to_moon'], 'm1'), /不合法/)
})

test('assertLegalGrants: * 仅限 lead', () => {
  assertLegalGrants(['*'], 'lead')
  assert.throws(() => assertLegalGrants(['*'], 'm1'), /仅限 lead/)
})

// ---------- 豁免校验(堵提权后门) ----------

test('assertExemptionsIntact: 成员不可收走请示通道与快照只读', () => {
  assert.throws(() => assertExemptionsIntact({ m1: ['team_board'] }), /send_message/)
  assert.throws(() => assertExemptionsIntact({ m1: ['send_message'] }), /team_policy:read/)
  assert.doesNotThrow(() => assertExemptionsIntact({ m1: ['send_message', 'team_policy:read'] }))
})

test('assertExemptionsIntact: lead 不可收走 team_policy(* 全权视为保有)', () => {
  assert.throws(() => assertExemptionsIntact({ lead: ['task'] }), /team_policy/)
  assert.doesNotThrow(() => assertExemptionsIntact({ lead: ['*'] }))
  assert.doesNotThrow(() => assertExemptionsIntact({ lead: ['team_policy'] }))
})

// ---------- 默认快照生成 ----------

test('createDefaultSnapshot: 默认 = 现状语义(lead 全权,成员三团队工具+请示+快照只读)', () => {
  const snap = createDefaultSnapshot()
  assert.equal(snap.source, 'default')
  assert.deepEqual(snap.grants.lead, ['*'])
  assert.deepEqual(snap.defaultMemberGrants, [...DEFAULT_MEMBER_GRANTS])
  assert.equal(snap.budget.maxMembers, undefined)
  assert.equal(snap.history.length, 1)
  assert.equal(snap.history[0].by, 'system')
})

test('createDefaultSnapshot: YAML policy 段生成初始快照(source=template,budget 生效)', () => {
  const snap = createDefaultSnapshot({ budget: { max_members: 6, max_depth: 2 }, default_member_grants: ['send_message', 'team_policy:read', 'team_board'] })
  assert.equal(snap.source, 'template')
  assert.equal(snap.budget.maxMembers, 6)
  assert.equal(snap.budget.maxDepth, 2)
  assert.deepEqual(snap.defaultMemberGrants, ['send_message', 'team_policy:read', 'team_board'])
})

test('createDefaultSnapshot: policy 里的非法授权在成队时响亮拒绝', () => {
  assert.throws(() => createDefaultSnapshot({ default_member_grants: ['not_a_tool'] }), /不合法/)
  assert.throws(() => createDefaultSnapshot({ grants: { m1: ['team_board'] } }), /send_message/)
})

// ---------- hasGrant / canBoardAction ----------

test('hasGrant: 快照缺失 = 默认语义(向后兼容红线)', () => {
  assert.equal(hasGrant(undefined, 'lead', 'task'), true)
  assert.equal(hasGrant(undefined, 'lead', 'team_board:remove'), true)
  assert.equal(hasGrant(undefined, 'm1', 'team_board'), true)
  assert.equal(hasGrant(undefined, 'm1', 'team_board:claim'), true) // 工具级覆盖 action 级
  assert.equal(hasGrant(undefined, 'm1', 'task'), false)
  assert.equal(hasGrant(undefined, 'm1', 'send_message'), true)
})

function snapWith(grants: Record<string, string[]>, defaultMemberGrants?: string[]): TeamSnapshot {
  return {
    grants: { lead: ['team_policy'], ...grants },
    defaultMemberGrants: defaultMemberGrants ?? ['send_message', 'team_policy:read'],
    budget: {},
    source: 'lead',
    createdAt: Date.now(),
    history: [],
  }
}

test('hasGrant: 快照在时按表判定;未登记成员落 defaultMemberGrants', () => {
  const snap = snapWith({ lead: ['team_policy'], m1: ['team_board:claim', 'send_message', 'team_policy:read'] })
  assert.equal(hasGrant(snap, 'm1', 'team_board:claim'), true)
  assert.equal(hasGrant(snap, 'm1', 'team_board:post'), false)
  assert.equal(hasGrant(snap, 'm2', 'task'), false) // m2 未登记 → 缺省授权
  assert.equal(hasGrant(snap, 'lead', 'task'), false) // lead 被收走
})

test('hasGrant: 解冻态临时恢复 lead 的 restoredGrants', () => {
  const snap = snapWith({})
  assert.equal(hasGrant(snap, 'lead', 'task'), false)
  snap.unfreeze = { by: 'watchdog', at: Date.now(), reason: '停滞', restoredGrants: ['task'] }
  assert.equal(hasGrant(snap, 'lead', 'task'), true)
})

test('canBoardAction: action 级判定', () => {
  const snap = snapWith({ m1: ['team_board:claim', 'send_message', 'team_policy:read'] })
  assert.equal(canBoardAction(snap, 'm1', 'claim'), true)
  assert.equal(canBoardAction(snap, 'm1', 'post'), false)
  assert.equal(canBoardAction(undefined, 'm1', 'claim'), true) // 默认语义
})

test('resolveGrants/hasGrant 回退链:派生名去后缀 → 模板名 → 缺省(实测 bug:授 reader-a 但实例叫 reader-a-2)', () => {
  const snap = snapWith({ 'reader-a': ['task', 'team_board', 'send_message', 'team_policy:read'] })
  // 派生实例 reader-a-2 命中词干 reader-a 的授权
  assert.equal(hasGrant(snap, 'reader-a-2', 'task'), true)
  assert.equal(hasGrant(snap, 'reader-a-2', 'team_board:claim'), true)
  // 模板名回退
  const snap2 = snapWith({ 'general-purpose': ['task', 'send_message', 'team_policy:read'] })
  assert.equal(hasGrant(snap2, 'someone', 'task', 'general-purpose'), true)
  // 都不沾 → 落缺省(无 task)
  assert.equal(hasGrant(snap2, 'someone', 'task'), false)
})

// ---------- 预算闸 ----------

test('canSpawnWithinBudget: 无快照/无预算 = 放行;人数硬闸;token 扩张闸(无计量数据不生效)', () => {
  assert.equal(canSpawnWithinBudget(undefined, 5, 100).ok, true)
  const snap = snapWith({})
  snap.budget = { maxMembers: 3 }
  assert.equal(canSpawnWithinBudget(snap, 2, null).ok, true)
  const full = canSpawnWithinBudget(snap, 3, null)
  assert.equal(full.ok, false)
  assert.match(full.reason!, /人数预算已达上限/)
  snap.budget = { maxTokens: 1000 }
  assert.equal(canSpawnWithinBudget(snap, 0, null).ok, true) // 无数据 → 闸不生效
  assert.equal(canSpawnWithinBudget(snap, 0, 500).ok, true)
  assert.equal(canSpawnWithinBudget(snap, 0, 1000).ok, false)
})

// ---------- 热更新 ----------

test('applySnapshotUpdate: 留痕 + 清除 unfreeze + source 映射', () => {
  const snap = createDefaultSnapshot()
  snap.unfreeze = { by: 'watchdog', at: Date.now(), reason: '停滞', restoredGrants: ['task'] }
  const next = applySnapshotUpdate(snap, { budget: { maxMembers: 5 } }, 'lead', '用户说:最多 5 人')
  assert.equal(next.budget.maxMembers, 5)
  assert.equal(next.unfreeze, undefined) // 显式布线覆盖探测态
  assert.equal(next.source, 'lead')
  assert.equal(next.history.length, 2)
  assert.equal(next.history[1].note, '用户说:最多 5 人')
  const direct = applySnapshotUpdate(next, { budget: { maxMembers: 8 } }, 'user-direct', '/team policy')
  assert.equal(direct.source, 'user-direct')
})

test('applySnapshotUpdate: grants 按成员合并——部分提交不挤掉未提交成员(实测:lead:* 被整表替换挤掉)', () => {
  const snap = createDefaultSnapshot()
  // 只提交 m1 的授权,lead 的 * 与其他成员必须原样保留
  const next = applySnapshotUpdate(snap, { grants: { m1: ['team_board', 'send_message', 'team_policy:read'] } }, 'lead', '只收 m1')
  assert.deepEqual(next.grants.lead, ['*'], 'lead 的 * 不得被部分更新挤掉')
  assert.deepEqual(next.grants.m1, ['team_board', 'send_message', 'team_policy:read'])
  // 再提交 m2,m1 与 lead 仍保留
  const next2 = applySnapshotUpdate(next, { grants: { m2: ['send_message', 'team_policy:read'] } }, 'lead', '再收 m2')
  assert.deepEqual(next2.grants.lead, ['*'])
  assert.deepEqual(next2.grants.m1, ['team_board', 'send_message', 'team_policy:read'])
  assert.deepEqual(next2.grants.m2, ['send_message', 'team_policy:read'])
})

test('applySnapshotUpdate: 非法授权与收走豁免都拒绝', () => {
  const snap = createDefaultSnapshot()
  assert.throws(() => applySnapshotUpdate(snap, { defaultMemberGrants: ['task'] }, 'lead', 'x'), /send_message/)
  assert.throws(() => applySnapshotUpdate(snap, { grants: { lead: [] } }, 'lead', 'x'), /team_policy/)
})

// ---------- 摘要 ----------

test('summarizeSnapshot: 缺省与在案两种形态', () => {
  assert.match(summarizeSnapshot(undefined), /无授权快照/)
  const snap = createDefaultSnapshot({ budget: { max_members: 4 } })
  const text = summarizeSnapshot(snap)
  assert.match(text, /人数上限 4/)
  assert.match(text, /token 上限 不限/)
  assert.match(text, /lead: \*/)
})
