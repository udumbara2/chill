import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptTaskEventSource,
  decideWorkPlanSync,
  mirrorTaskAdded,
  mirrorTaskDeleted,
  mirrorTaskListCreated,
  mirrorTaskStatusUpdated,
  type WorkPlanMirror,
} from '../../src/services/workplan/workPlanMirror.ts'
import type { TaskItem } from '../../src/types/models.ts'

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id,
  content: `任务 ${id}`,
  status: 'pending',
  createdAt: new Date('2026-09-29T00:00:00Z'),
  updatedAt: new Date('2026-09-29T00:00:00Z'),
  ...over,
})

// ---------- ① 来源过滤统一规则 ----------

test('来源过滤（黑名单制）：拒 subagent；undefined/main/mobile 照收（mobile=手机发起轮次的主引擎调用）', () => {
  assert.equal(acceptTaskEventSource(undefined), true)
  assert.equal(acceptTaskEventSource('main'), true)
  assert.equal(acceptTaskEventSource('mobile'), true)
  assert.equal(acceptTaskEventSource('subagent'), false)
})

// ---------- ② 四事件镜像应用 ----------

test('TASK_LIST_CREATED：整表替换（唯一建条目点）', () => {
  const m: WorkPlanMirror = new Map()
  mirrorTaskListCreated(m, 's1', [task('a'), task('b')])
  assert.equal(m.get('s1')!.length, 2)
  // 再次创建=整表替换（旧条目不残留）
  mirrorTaskListCreated(m, 's1', [task('c')])
  assert.deepEqual(m.get('s1')!.map((t) => t.id), ['c'])
  // 按 sessionId 分键互不影响
  mirrorTaskListCreated(m, 's2', [task('x')])
  assert.deepEqual(m.get('s1')!.map((t) => t.id), ['c'])
  assert.deepEqual(m.get('s2')!.map((t) => t.id), ['x'])
})

test('TASK_STATUS_UPDATED：按 id 更新（content/result 有值才覆盖）；未知 id 与空镜像跳过不建条目', () => {
  const m: WorkPlanMirror = new Map()
  assert.equal(mirrorTaskStatusUpdated(m, 's1', 'a', 'in_progress'), false) // 空镜像
  mirrorTaskListCreated(m, 's1', [task('a'), task('b')])
  assert.equal(mirrorTaskStatusUpdated(m, 's1', 'zzz', 'completed'), false) // 未知 id
  assert.equal(mirrorTaskStatusUpdated(m, 's1', 'a', 'completed', undefined, '完成'), true)
  const item = m.get('s1')!.find((t) => t.id === 'a')!
  assert.equal(item.status, 'completed')
  assert.equal(item.result, '完成')
  assert.equal(item.content, '任务 a') // content 未携带不覆盖
  assert.equal(mirrorTaskStatusUpdated(m, 's1', 'a', 'failed', '改名了'), true)
  assert.equal(m.get('s1')![0]!.content, '改名了')
})

test('TASK_DELETED：按 id 过滤；空镜像/未知 id 跳过', () => {
  const m: WorkPlanMirror = new Map()
  assert.equal(mirrorTaskDeleted(m, 's1', 'a'), false) // 空镜像
  mirrorTaskListCreated(m, 's1', [task('a'), task('b')])
  assert.equal(mirrorTaskDeleted(m, 's1', 'zzz'), false) // 未知 id
  assert.equal(mirrorTaskDeleted(m, 's1', 'a'), true)
  assert.deepEqual(m.get('s1')!.map((t) => t.id), ['b'])
})

test('TASK_ADDED：追加；空镜像不建条目（精确自愈条件=下一次 create_task_list）', () => {
  const m: WorkPlanMirror = new Map()
  assert.equal(mirrorTaskAdded(m, 's1', task('a')), false) // 空镜像不建条目
  assert.equal(m.has('s1'), false)
  mirrorTaskListCreated(m, 's1', [task('a')])
  assert.equal(mirrorTaskAdded(m, 's1', task('b')), true)
  assert.deepEqual(m.get('s1')!.map((t) => t.id), ['a', 'b'])
})

test('镜像存副本：改写事件载荷对象不回流污染镜像', () => {
  const m: WorkPlanMirror = new Map()
  const t = task('a')
  mirrorTaskListCreated(m, 's1', [t])
  t.status = 'failed'
  assert.equal(m.get('s1')![0]!.status, 'pending')
})

// ---------- ③ rev 对账 ----------

test('rev 对账：一致纯确认（ack）；落后/未知/缺省/null 全量（full）', () => {
  assert.equal(decideWorkPlanSync(3, '3'), 'ack')
  assert.equal(decideWorkPlanSync(3, 3), 'ack') // 数字形态同值也一致（字符串传输口径）
  assert.equal(decideWorkPlanSync(3, '2'), 'full') // 落后
  assert.equal(decideWorkPlanSync(3, '9'), 'full') // 超前（core 重启 rev 归零后的陈旧 rev 同路）
  assert.equal(decideWorkPlanSync(0, '1'), 'full')
  assert.equal(decideWorkPlanSync(3, undefined), 'full')
  assert.equal(decideWorkPlanSync(3, null), 'full')
  assert.equal(decideWorkPlanSync(3, 'abc'), 'full') // 异常值
})

// ---------- ④ 批次清扫（横条批次化迭代：settled + 结构性事件的确定事实界限） ----------

test('TASK_ADDED 批次清扫：settled（非空全 completed）清单 add → 旧批翻篇，镜像替换为 [新任务]', () => {
  const m: WorkPlanMirror = new Map()
  mirrorTaskListCreated(m, 's1', [task('a', { status: 'completed' }), task('b', { status: 'completed' })])
  const changed = mirrorTaskAdded(m, 's1', task('n1'))
  assert.equal(changed, true)
  assert.deepEqual(m.get('s1')!.map((t) => t.id), ['n1']) // 旧批 a/b 翻篇，只含新任务
  // 第二次 add：此刻 n1 为 pending → 非 settled → 正常追加（同批共存）
  mirrorTaskAdded(m, 's1', task('n2'))
  assert.deepEqual(m.get('s1')!.map((t) => t.id), ['n1', 'n2'])
})

test('TASK_ADDED 不误清：有 pending/in_progress/failed 活跃项的清单 add → 追加共存（连续工作流语义）', () => {
  for (const active of ['pending', 'in_progress', 'failed'] as const) {
    const m: WorkPlanMirror = new Map()
    mirrorTaskListCreated(m, 's1', [task('done', { status: 'completed' }), task('live', { status: active })])
    mirrorTaskAdded(m, 's1', task('n1'))
    assert.deepEqual(m.get('s1')!.map((t) => t.id), ['done', 'live', 'n1'], `活跃态 ${active} 时不清扫`)
  }
})

test('TASK_ADDED 不误清边界：failed 批不清扫（警示不被新批冲掉），全 completed 才算 settled', () => {
  const m: WorkPlanMirror = new Map()
  mirrorTaskListCreated(m, 's1', [task('a', { status: 'completed' }), task('f', { status: 'failed' })])
  mirrorTaskAdded(m, 's1', task('n1'))
  assert.deepEqual(m.get('s1')!.map((t) => t.id), ['a', 'f', 'n1']) // failed 警示留存
})

test('settled 后 update 旧项不触发清扫（update 非结构性事件，镜像只按 id 更新）', () => {
  const m: WorkPlanMirror = new Map()
  mirrorTaskListCreated(m, 's1', [task('a', { status: 'completed' })])
  const changed = mirrorTaskStatusUpdated(m, 's1', 'a', 'completed', '改个结果摘要', 'done')
  assert.equal(changed, true)
  assert.equal(m.get('s1')!.length, 1) // 树不变（清扫只在 add/create 路径）
  // 但下一次 add 仍按最新 settled 态判定清扫
  mirrorTaskAdded(m, 's1', task('n1'))
  assert.deepEqual(m.get('s1')!.map((t) => t.id), ['n1'])
})

test('批次清扫 × 空镜像保护：删键后 add 不建条目语义保持（替换实现不可绕过 if(!list) 守卫）', () => {
  const m: WorkPlanMirror = new Map()
  // 空镜像（无键）：add 不建条目（中途启动边界语义保持）
  assert.equal(mirrorTaskAdded(m, 's1', task('n1')), false)
  assert.equal(m.has('s1'), false)
})