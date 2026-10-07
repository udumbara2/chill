import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setWorkPlanMirrorStoreForTest, WorkPlanMirrorStore } from '../../src/services/workplan/workPlanMirrorStore.ts'
import {
  wireWorkPlan,
  makeWorkPlanSyncBridgeDeps,
  resetWorkPlanWiringStateForTest,
} from '../../src/services/relayEngineWiring.ts'
import type { RelayBridge } from '../../src/services/relay/RelayBridge.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import {
  SessionBoardService,
  getSessionBoardService,
  setSessionBoardService,
  resetSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import type { TaskItem } from '../../src/types/models.ts'

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id,
  content: `任务 ${id}`,
  status: 'pending',
  createdAt: new Date('2026-09-29T00:00:00Z'),
  updatedAt: new Date('2026-09-29T00:00:00Z'),
  ...over,
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 假桥：wireWorkPlan 只触 pushWorkPlanState（附着门控在真桥内，不在本层） */
function makeFakeBridge(): { bridge: RelayBridge; pushes: string[] } {
  const pushes: string[] = []
  const bridge = { pushWorkPlanState: (sid: string) => pushes.push(sid) } as unknown as RelayBridge
  return { bridge, pushes }
}

let tmpBase = ''
beforeEach(() => {
  resetWorkPlanWiringStateForTest()
  // 镜像落盘重定向到临时目录（防测试写真实 ~/.chill/workplan-mirror.json）
  tmpBase = mkdtempSync(join(tmpdir(), 'wpstore-'))
  setWorkPlanMirrorStoreForTest(new WorkPlanMirrorStore(tmpBase))
})
afterEach(() => {
  setWorkPlanMirrorStoreForTest(null)
  rmSync(tmpBase, { recursive: true, force: true })
})

// ---------- ① 镜像 source 过滤 ----------

test('wiring：subagent 写入被拒（不建镜像、不推、rev 不动）；main/无来源/mobile 照收', async () => {
  const { bridge, pushes } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', source: 'subagent', taskId: 'worker-1', tasks: [task('a')] })
    await sleep(30)
    assert.deepEqual(pushes, [])
    let state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.rev, '0')
    assert.deepEqual(state.items, []) // 诚实空态

    eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', source: 'main', tasks: [task('a')] })
    await sleep(30)
    assert.deepEqual(pushes, ['s1'])
    state = await deps.buildWorkPlanState('s1', undefined)
    const rev1 = Number(state.rev)
    assert.ok(rev1 > 0) // 时间基 rev（13 位毫秒戳）
    assert.deepEqual(state.items.map((i) => i.id), ['a'])

    // 无来源（旧发射方/缺归因）同样收
    eventBus.emit(EVENTS.TASK_STATUS_UPDATED, { sessionId: 's1', taskId: 'a', status: 'completed', result: 'done' })
    await sleep(30)
    state = await deps.buildWorkPlanState('s1', undefined)
    const rev2 = Number(state.rev)
    assert.ok(rev2 > rev1) // 严格单调递增
    assert.equal(state.items[0]!.status, 'completed')

    // mobile 来源（手机发起轮次的主引擎调用）照收——本功能主场景：用户在手机上看助手建清单
    eventBus.emit(EVENTS.TASK_STATUS_UPDATED, { sessionId: 's1', source: 'mobile', taskId: 'a', status: 'in_progress' })
    await sleep(30)
    state = await deps.buildWorkPlanState('s1', undefined)
    assert.ok(Number(state.rev) > rev2) // 严格单调递增
    assert.equal(state.items[0]!.status, 'in_progress')
  } finally {
    off()
  }
})

// ---------- ② 四事件经事件总线进镜像 ----------

test('wiring：整表替换/更新/删除/追加四事件链路（防抖合并取最终态）', async () => {
  const { bridge, pushes } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    // 窗口内成串变更 → 合并为一次推送
    eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', tasks: [task('a'), task('b')] })
    eventBus.emit(EVENTS.TASK_STATUS_UPDATED, { sessionId: 's1', taskId: 'a', status: 'in_progress' })
    eventBus.emit(EVENTS.TASK_ADDED, { sessionId: 's1', task: task('c') })
    eventBus.emit(EVENTS.TASK_DELETED, { sessionId: 's1', taskId: 'b' })
    await sleep(30)
    assert.deepEqual(pushes, ['s1']) // trailing 防抖：四次变更一次推
    const state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.full, true)
    assert.deepEqual(
      state.items.map((i) => [i.id, i.status]),
      [
        ['a', 'in_progress'],
        ['c', 'pending'],
      ],
    )
  } finally {
    off()
  }
})

test('wiring：未知 id 更新/空镜像增删 不建条目也不触发推送（精确自愈=下一次 create_task_list）', async () => {
  const { bridge, pushes } = makeFakeBridge()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    eventBus.emit(EVENTS.TASK_STATUS_UPDATED, { sessionId: 's1', taskId: 'a', status: 'completed' })
    eventBus.emit(EVENTS.TASK_ADDED, { sessionId: 's1', task: task('a') })
    eventBus.emit(EVENTS.TASK_DELETED, { sessionId: 's1', taskId: 'a' })
    await sleep(30)
    assert.deepEqual(pushes, [])
    // 建条目后：未知 id 更新同样不推
    eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', tasks: [task('a')] })
    await sleep(30)
    assert.deepEqual(pushes, ['s1'])
    eventBus.emit(EVENTS.TASK_STATUS_UPDATED, { sessionId: 's1', taskId: 'zzz', status: 'completed' })
    await sleep(30)
    assert.deepEqual(pushes, ['s1'])
  } finally {
    off()
  }
})

// ---------- ③ rev 对账经 buildWorkPlanState ----------

test('wiring：sync 对账——一致纯确认（items 空），落后/未知全量树', async () => {
  const { bridge } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', tasks: [task('a'), task('b')] })
    await sleep(30)
    const current = await deps.buildWorkPlanState('s1', undefined)
    const ack = await deps.buildWorkPlanState('s1', current.rev) // 手机 rev 一致 → 纯确认（items 空）
    assert.equal(ack.full, false)
    assert.deepEqual(ack.items, [])
    const stale = await deps.buildWorkPlanState('s1', '0') // 手机 rev 落后（0 < 时间基 rev）→ 全量树
    assert.equal(stale.full, true)
    assert.equal(stale.items.length, 2)
    const unknown = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(unknown.full, true)
    // 无镜像会话：诚实空态（rev 0；手机 rev 一致也回纯确认，绝不错误显示）
    const empty = await deps.buildWorkPlanState('s-void', undefined)
    assert.equal(empty.rev, '0')
    assert.equal(empty.full, true)
    assert.deepEqual(empty.items, [])
  } finally {
    off()
  }
})

// ---------- 缺归因事件归当前活动会话 ----------

test('wiring：缺 sessionId 事件经 getActiveSessionId 归当前活动会话', async () => {
  const { bridge, pushes } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5, getActiveSessionId: () => 's-active' })
  try {
    eventBus.emit(EVENTS.TASK_LIST_CREATED, { tasks: [task('a')] })
    await sleep(30)
    assert.deepEqual(pushes, ['s-active'])
    const state = await deps.buildWorkPlanState('s-active', undefined)
    assert.equal(state.items.length, 1)
  } finally {
    off()
  }
})

// ---------- 退订后不再收 ----------

test('wiring：退订后事件不再进镜像', async () => {
  const { bridge, pushes } = makeFakeBridge()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', tasks: [task('a')] })
  await sleep(30)
  assert.deepEqual(pushes, ['s1'])
  off()
  eventBus.emit(EVENTS.TASK_STATUS_UPDATED, { sessionId: 's1', taskId: 'a', status: 'completed' })
  await sleep(30)
  assert.deepEqual(pushes, ['s1'])
})

// ---------- 迭代 2：看板双源（BOARD_CHANGED/TEAM_BOARD_CHANGED 同窗订阅 + 组包并板） ----------

test('wiring：BOARD_CHANGED/TEAM_BOARD_CHANGED 触发同一防抖推送（rev 双源单计数器）', async () => {
  const { bridge, pushes } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', tasks: [task('a')] })
    await sleep(30)
    assert.deepEqual(pushes, ['s1'])
    const revAfterTasks = Number((await deps.buildWorkPlanState('s1', undefined)).rev)
    // 看板变更：镜像不动，rev 照涨照推（与清单变更同一单调计数器）
    eventBus.emit(EVENTS.BOARD_CHANGED, { sessionId: 's1' })
    eventBus.emit(EVENTS.TEAM_BOARD_CHANGED, { sessionId: 's1' })
    await sleep(30)
    assert.deepEqual(pushes, ['s1', 's1']) // 两次看板事件防抖合并为一次推
    const state = await deps.buildWorkPlanState('s1', undefined)
    assert.ok(Number(state.rev) > revAfterTasks) // 看板 bump 与清单同一单调计数器（双源单 rev）
    // 无 sessionId 的看板事件同样归当前活动会话（有 getter 时）
  } finally {
    off()
  }
})

test('wiring：buildWorkPlanState 并入会话轻量板行（核心状态直读，与清单镜像合并投影）', async () => {
  // 内存假 store 装配轻量板（照 boardSync.test 的 setSessionBoardService 先例，免落盘）
  const store = new Map<string, unknown>()
  setSessionBoardService(
    new SessionBoardService({
      load: async (id: string) => store.get(id) as never,
      save: async (s: { boardId: string }) => void store.set(s.boardId, s),
      exists: async (id: string) => store.has(id),
      archiveBoard: async () => { throw new Error('测试不需要') },
    }),
  )
  const { bridge, pushes } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    // 轻量板一行（parentTaskId 命中清单项 → 嵌套）
    const svc = getSessionBoardService()!
    const posted = await svc.post('s1', { title: '对比定价策略', createdBy: 'lead', parentTaskId: 'a' })
    await svc.claim('s1', posted.id, { assignee: '分析师' })
    eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', tasks: [task('a', { content: '竞品调研' })] })
    await sleep(30)
    assert.ok(pushes.length >= 1)
    assert.equal(pushes.at(-1), 's1')
    const state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.full, true)
    assert.equal(state.items.length, 1)
    assert.equal(state.items[0]!.content, '竞品调研')
    assert.equal(state.items[0]!.status, 'in_progress') // 父项派生：有在办子项
    assert.deepEqual(state.items[0]!.children, [
      { id: posted.id, content: '对比定价策略', status: 'in_progress', actor: '分析师' },
    ])
  } finally {
    off()
    resetSessionBoardService()
  }
})
