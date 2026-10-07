/**
 * buildWorkPlanTree v2 · 13 场景矩阵（对照实施规划第五节验收走查表）
 * 场景编号与规划一致；「切会话/重连/离线(rev 对账)」在 wireWorkPlan.test.ts 覆盖，
 * 「纯委派维持现状」= 无看板行 → 同场景 11 空态（此处不重复）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkPlanTree } from '../../src/services/workplan/workPlanTree.ts'
import type { TaskItem } from '../../src/types/models.ts'
import type { BoardItem } from '../../src/services/board/boardTypes.ts'

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id,
  content: `清单项 ${id}`,
  status: 'pending',
  createdAt: new Date('2026-09-30T00:00:00Z'),
  updatedAt: new Date('2026-09-30T00:00:00Z'),
  ...over,
})

const bitem = (id: string, over: Partial<BoardItem> = {}): BoardItem => ({
  id,
  title: `看板行 ${id}`,
  status: 'pending',
  createdBy: 'lead',
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

// 场景 1：纯待办清单（无看板）——平铺，无 children 无 actor
test('场景1 纯待办清单：平铺清单项，无 actor/needsYou/children', () => {
  const tree = buildWorkPlanTree({ mirrorTasks: [task('a'), task('b'), task('c')] })
  assert.equal(tree.length, 3)
  assert.deepEqual(tree.map((i) => i.status), ['pending', 'pending', 'pending'])
  for (const item of tree) {
    assert.equal(item.actor, undefined)
    assert.equal(item.needsYou, undefined)
    assert.equal(item.children, undefined)
  }
})

// 场景 2：清单+团队有链 —— 看板行嵌进父项卡
test('场景2 清单+团队有链：parentTaskId 命中清单项 → 嵌为 children（actor=认领成员名）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1', { content: '竞品调研', status: 'in_progress' }), task('t2')],
    boardItems: [
      bitem('b1', { title: '对比定价策略', status: 'in_progress', assignee: '分析师', parentTaskId: 't1' }),
      bitem('b2', { title: '整理功能矩阵', status: 'pending', parentTaskId: 't1' }),
    ],
  })
  assert.equal(tree.length, 2)
  const parent = tree[0]!
  assert.equal(parent.children!.length, 2)
  assert.deepEqual(parent.children![0], {
    id: 'b1',
    content: '对比定价策略',
    status: 'in_progress',
    actor: '分析师',
  })
  // 未认领子行：actor='待认领'（灰调等待认领相位——**不**标 needsYou，琥珀只留给需拍板档）
  assert.equal(parent.children![1]!.actor, '待认领')
  assert.equal(parent.children![1]!.needsYou, undefined)
  assert.equal(tree[1]!.children, undefined) // t2 无链
})

// 场景 3：清单+看板无链 —— 根层并列平铺（清单项之后）
test('场景3 清单+看板无链：无 parentTaskId 行 → 根层追加在清单项之后', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1'), task('t2')],
    boardItems: [bitem('b1', { assignee: '研究员' }), bitem('b2')],
  })
  assert.deepEqual(tree.map((i) => i.id), ['t1', 't2', 'b1', 'b2'])
  assert.equal(tree[2]!.actor, '研究员')
  assert.equal(tree[3]!.actor, '待认领')
})

// 场景 4：看板全待认领 —— 灰调相位：pending + actor='待认领'（**非** needsYou：等待认领 ≠ 等你拍板）
test('场景4 看板全待认领：全部 pending+待认领，不标 needsYou（灰调相位）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [],
    boardItems: [bitem('b1'), bitem('b2'), bitem('b3')],
  })
  assert.equal(tree.length, 3)
  for (const item of tree) {
    assert.equal(item.status, 'pending')
    assert.equal(item.actor, '待认领')
    assert.equal(item.needsYou, undefined)
  }
})

// 场景 5：仅子 Agent 无清单（象限 1）—— 看板行平铺即全树
test('场景5 仅子 Agent 无清单：树=看板行平铺', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [],
    boardItems: [bitem('b1', { status: 'in_progress', assignee: 'explore·A1' })],
  })
  assert.equal(tree.length, 1)
  assert.deepEqual(tree[0], {
    id: 'b1',
    content: '看板行 b1',
    status: 'in_progress',
    actor: 'explore·A1',
  })
})

// 场景 6：多成员并行 —— 多个 in_progress 并存，各自 actor
test('场景6 多成员并行：多蓝点并存，actor 各自归属', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1', { status: 'in_progress' })],
    boardItems: [
      bitem('b1', { status: 'in_progress', assignee: '分析师', parentTaskId: 't1' }),
      bitem('b2', { status: 'in_progress', assignee: '研究员', parentTaskId: 't1' }),
    ],
  })
  assert.deepEqual(tree[0]!.children!.map((c) => [c.status, c.actor]), [
    ['in_progress', '分析师'],
    ['in_progress', '研究员'],
  ])
})

// 场景 7：失败/死亡回流 —— 失败行=红字相位（不占琥珀）；回流行=待认领灰调
test('场景7 失败/回流：failed 行 status=failed（非 needsYou 红字相）；回流行回 pending+待认领（灰调相）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [],
    boardItems: [
      bitem('b1', { status: 'failed', assignee: '分析师', failCount: 2 }),
      bitem('b2', {
        status: 'pending',
        releaseHistory: [{ by: 'system', reason: '认领任务失败：模型超时', at: 1 }],
      }),
    ],
  })
  assert.equal(tree[0]!.status, 'failed')
  assert.equal(tree[0]!.needsYou, undefined) // 失败=红字警示，不是"等你拍板"
  assert.equal(tree[0]!.actor, '分析师')
  assert.equal(tree[1]!.status, 'pending')
  assert.equal(tree[1]!.actor, '待认领')
  assert.equal(tree[1]!.needsYou, undefined) // 回流待认领=灰调等待
})

// 场景 8：串行多团队/批次 —— 无链行按看板序稳定追加
test('场景8 串行追加：无链看板行按看板序稳定排在清单后', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1')],
    boardItems: [
      bitem('b1', { batchId: 'g1' }),
      bitem('b2', { batchId: 'g1' }),
      bitem('b3', { batchId: 'g2' }),
    ],
  })
  assert.deepEqual(tree.map((i) => i.id), ['t1', 'b1', 'b2', 'b3'])
})

// 场景 9：全部完成 —— 全 completed（含父项自动结项）
test('场景9 全部完成：清单项与看板行全 completed', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1', { status: 'completed' }), task('t2', { status: 'completed', result: '交付物 X' })],
    boardItems: [bitem('b1', { status: 'completed', assignee: '分析师', parentTaskId: 't1', result: '定价报告' })],
  })
  assert.deepEqual(tree.map((i) => i.status), ['completed', 'completed'])
  assert.equal(tree[0]!.note, '自动结项')
  assert.equal(tree[0]!.children![0]!.result, '定价报告')
  assert.equal(tree[1]!.result, '交付物 X')
})

// 场景 10：needsYou —— blocked(需拍板)行：status 映 failed + needsYou + note=受阻原因
test('场景10 needsYou：blocked 行映 failed+needsYou，受阻原因进 note', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1', { status: 'in_progress' })],
    boardItems: [
      bitem('b1', { status: 'blocked', assignee: '分析师', note: '定价口径待确认', parentTaskId: 't1' }),
    ],
  })
  const child = tree[0]!.children![0]!
  assert.equal(child.status, 'failed') // blocked/failed 同映 failed，相位靠 needsYou 区分
  assert.equal(child.needsYou, true)
  assert.equal(child.note, '定价口径待确认')
})

// 场景 11：什么都没有 —— 空树（长条不出现的数据基础）
test('场景11 什么都没有：空镜像+空看板 → 空树', () => {
  assert.deepEqual(buildWorkPlanTree({ mirrorTasks: [], boardItems: [] }), [])
  assert.deepEqual(buildWorkPlanTree({ mirrorTasks: [] }), [])
})

// 场景 13：断链孤儿提升 —— parentTaskId 悬空 → 根层（不丢行不猜新父）
test('场景13 断链孤儿提升：parentTaskId 指向不存在的清单项 → 提升为顶层', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1')],
    boardItems: [
      bitem('b1', { parentTaskId: 't-已被删除' }), // 清单重建/删父项后的断链
      bitem('b2', { parentTaskId: 't1' }),
    ],
  })
  assert.deepEqual(tree.map((i) => i.id), ['t1', 'b1']) // b1 提升根层不丢行
  assert.equal(tree[0]!.children!.length, 1)
  assert.equal(tree[0]!.children![0]!.id, 'b2')
})

// 规则 ④：父项自动结项派生（三个相位）
test('规则④ 父项自动结项：全 completed→completed+note；有在办→in_progress；无在办有未完→保持镜像原状态', () => {
  // 全 completed → 自动结项（即使镜像原状态是 in_progress，也不 mutate 镜像只派生输出）
  const done = buildWorkPlanTree({
    mirrorTasks: [task('t1', { status: 'in_progress' })],
    boardItems: [
      bitem('b1', { status: 'completed', parentTaskId: 't1' }),
      bitem('b2', { status: 'completed', parentTaskId: 't1' }),
    ],
  })
  assert.equal(done[0]!.status, 'completed')
  assert.equal(done[0]!.note, '自动结项')

  // 至少一个 in_progress → 父项 in_progress（即使镜像是 pending）
  const running = buildWorkPlanTree({
    mirrorTasks: [task('t1', { status: 'pending' })],
    boardItems: [
      bitem('b1', { status: 'in_progress', parentTaskId: 't1' }),
      bitem('b2', { status: 'pending', parentTaskId: 't1' }),
    ],
  })
  assert.equal(running[0]!.status, 'in_progress')
  assert.equal(running[0]!.note, undefined)

  // 有 children 无在办有未完（全 pending 待认领）→ 保持镜像原状态
  const waiting = buildWorkPlanTree({
    mirrorTasks: [task('t1', { status: 'pending' })],
    boardItems: [bitem('b1', { status: 'pending', parentTaskId: 't1' })],
  })
  assert.equal(waiting[0]!.status, 'pending')

  // 有 children 含 failed（非 completed 非 in_progress）→ 保持镜像原状态（失败不自动结项不上提）
  const failed = buildWorkPlanTree({
    mirrorTasks: [task('t1', { status: 'in_progress' })],
    boardItems: [bitem('b1', { status: 'failed', parentTaskId: 't1' })],
  })
  assert.equal(failed[0]!.status, 'in_progress')
})

// 状态映射全表：无链未结清态全投影；无链终态行为各自单行批——已结清批按界 1 保留最近一代
test('状态映射：看板六态 → 树项五态（有活跃批时终态 solo 批让位，blocked/failed 同映 failed）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [],
    boardItems: [
      bitem('b1', { status: 'pending' }),
      bitem('b2', { status: 'in_progress', assignee: 'A' }),
      bitem('b3', { status: 'completed', assignee: 'A' }),
      bitem('b4', { status: 'cancelled' }),
      bitem('b5', { status: 'blocked', assignee: 'A' }),
      bitem('b6', { status: 'failed', assignee: 'A' }),
    ],
  })
  // v4.1：b1/b2/b5/b6 为活跃批 → 终态 solo 批 b3/b4 立即让位——剩 b1/b2/b5/b6，b5 blocked 映 failed
  assert.deepEqual(tree.map((i) => i.status), ['pending', 'in_progress', 'failed', 'failed'])
  // needsYou 行级=窄判定：仅 blocked（b5，现第三位）置真；pending（待认领）/failed（失败自成一相）不标
  assert.deepEqual(tree.map((i) => i.needsYou === true), [false, false, true, false])
})

// 规则⑦边界：有链行全态投影（completed/cancelled 直出——六态映射意图在此验证）
test('状态映射：有链全态投影（completed/cancelled 直出，规则④派生不受⑦影响）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1', { status: 'in_progress' })],
    boardItems: [
      bitem('b1', { status: 'completed', assignee: 'A', parentTaskId: 't1' }),
      bitem('b2', { status: 'cancelled', parentTaskId: 't1' }),
    ],
  })
  assert.equal(tree.length, 1)
  assert.deepEqual(tree[0]!.children!.map((c) => c.status), ['completed', 'cancelled'])
})

// 规则⑦连锁：父项被批次清扫（镜像只剩新批）→ 挂靠旧批的看板行断链 → 断链 solo 批按界 1：最近已结清代保留、更早让位/in_flight 提升
test('规则⑦连锁：父项清扫后断链终态让位、in_flight 提升根层', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t9')], // 新批（旧批已被 mirrorTaskAdded 批次清扫翻篇）
    boardItems: [
      bitem('b-old-done', { status: 'completed', parentTaskId: 't1', updatedAt: 1_700_000_000_100 }), // 断链终态（最近代）→ 保留
      bitem('b-old-live', { status: 'in_progress', assignee: 'A', parentTaskId: 't1' }), // 断链在办 → 提升
      bitem('b-old-cancelled', { status: 'cancelled', parentTaskId: 't2', updatedAt: 1_699_999_999_000 }), // 断链取消（更早代）→ 让位
    ],
  })
  assert.deepEqual(tree.map((i) => i.id), ['t9', 'b-old-live']) // 在办孤儿提升，终态孤儿立即让位（v4.1：有活跃批）
  assert.equal(tree[1]!.actor, 'A')
})

// 行序稳定性 ⑤：多次调用同输入同输出（手机端 DFS 取焦点叶子的前提）
test('规则⑤ 行序稳定：清单序→无链行序，children 按看板序', () => {
  const input = {
    mirrorTasks: [task('t2'), task('t1')], // 镜像序即显示序（不按 id 重排）
    boardItems: [
      bitem('b2', { parentTaskId: 't1' }),
      bitem('b1', { parentTaskId: 't1' }),
      bitem('b3'),
    ],
  }
  const a = buildWorkPlanTree(input)
  const b = buildWorkPlanTree(input)
  assert.deepEqual(a, b)
  assert.deepEqual(a.map((i) => i.id), ['t2', 't1', 'b3'])
  assert.deepEqual(a[1]!.children!.map((c) => c.id), ['b2', 'b1']) // 看板序
})
