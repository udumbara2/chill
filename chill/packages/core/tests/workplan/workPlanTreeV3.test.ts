/**
 * buildWorkPlanTree v4 · 保留界 1 矩阵（对照 tmp/plan-strip-persist-core-v1.md（v2 三审全 PASS））
 *
 * 分两段：
 * - 纯函数段：批进度保留/单批完成常驻（零时间维）/两代已结清留最新/并行共存/失败拖批/
 *   断链参与分组/平局稳定序（输入序无关）/有链零改动——零时间注入，无需 mock now；
 * - wiring 段：结清后常驻无再推（a）/新代结清旧代让位（b）/update 推后改变代序（c）/
 *   重启恢复后已结清代照常投影（d）——SessionBoardService 内存板（照 wireWorkPlan.test.ts 先例）+ 真实时序（debounce 5ms）。
 * 既有回归（场景 2/9/规则④、状态映射全表等）在 workPlanTreeV2.test.ts（两用例已按 v4 重估）。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWorkPlanTree } from '../../src/services/workplan/workPlanTree.ts'
import type { TaskItem } from '../../src/types/models.ts'
import type { BoardItem } from '../../src/services/board/boardTypes.ts'
import { setWorkPlanMirrorStoreForTest, WorkPlanMirrorStore } from '../../src/services/workplan/workPlanMirrorStore.ts'
import {
  wireWorkPlan,
  makeWorkPlanSyncBridgeDeps,
  resetWorkPlanWiringStateForTest,
} from '../../src/services/relayEngineWiring.ts'
import type { RelayBridge } from '../../src/services/relay/RelayBridge.ts'
import {
  SessionBoardService,
  setSessionBoardService,
  resetSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'

const T0 = 1_700_000_000_000 // 固定时间基（updatedAt 构造锚点；投影本身零时间维）

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id,
  content: `清单项 ${id}`,
  status: 'pending',
  createdAt: new Date(T0),
  updatedAt: new Date(T0),
  ...over,
})

const bitem = (id: string, over: Partial<BoardItem> = {}): BoardItem => ({
  id,
  title: `看板行 ${id}`,
  status: 'pending',
  createdBy: 'lead',
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

// ---------- 纯函数段：保留界 1 矩阵 ----------

// 边界 #1：批进度保留——同批 3 行 1 完成 → 整批投影（completed 行=进度展示）
test('v4-#1 批进度保留：同批1行完成不退场，整批3行投影', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [],
    boardItems: [
      bitem('r1', { status: 'completed', batchId: 'b1', updatedAt: T0 + 1000 }),
      bitem('r2', { status: 'in_progress', batchId: 'b1' }),
      bitem('r3', { status: 'in_progress', batchId: 'b1' }),
    ],
  })
  assert.equal(tree.length, 3)
  assert.deepEqual(tree.map((i) => i.status), ['completed', 'in_progress', 'in_progress'])
})

// 边界 #2：单批完成常驻（核心——长条落定常驻）：已结清批是最近一代 → 永投影，无任何时间退场
test('v4-#2 单批完成常驻：已结清批作为最近一代永远投影（零时间维）', () => {
  const items = [
    bitem('r1', { status: 'completed', batchId: 'b1', updatedAt: T0 + 1000 }),
    bitem('r2', { status: 'completed', batchId: 'b1', updatedAt: T0 + 3000 }),
    bitem('r3', { status: 'cancelled', batchId: 'b1', updatedAt: T0 + 2000 }),
  ]
  const tree = buildWorkPlanTree({ mirrorTasks: [], boardItems: items })
  assert.equal(tree.length, 3) // 全终态整批照常投影（v3 的"期满退场"已退役）
  assert.deepEqual(tree.map((i) => i.status), ['completed', 'completed', 'cancelled'])
  // 历史 updatedAt（旧世界的时间戳）同样常驻——时间不再参与判定
  const ancient = buildWorkPlanTree({
    mirrorTasks: [],
    boardItems: [bitem('old', { status: 'completed', updatedAt: 1 })],
  })
  assert.equal(ancient.length, 1)
})

// 边界 #9：单行批自然退化（无 batchId=一单一批）——完成即最近一代，常驻
test('v4-#9 单行批：无batchId行自成单行批，完成后常驻', () => {
  const solo = bitem('s1', { status: 'completed', updatedAt: T0 + 1000 })
  assert.equal(buildWorkPlanTree({ mirrorTasks: [], boardItems: [solo] }).length, 1)
})

// 边界 #4/#5：失败/回流行拖住整批（failed/pending/blocked 均非终态，整批=未结清 → 全投影）
test('v4-#4/#5 失败拖批：任一非终态行拖住整批投影（含completed兄弟行）', () => {
  for (const hold of ['failed', 'pending', 'blocked', 'in_progress'] as const) {
    const tree = buildWorkPlanTree({
      mirrorTasks: [],
      boardItems: [
        bitem('r1', { status: 'completed', batchId: 'b1' }),
        bitem('r2', { status: hold, batchId: 'b1' }),
      ],
    })
    assert.equal(tree.length, 2, `hold=${hold} 应整批投影`)
  }
})

// 边界 #8：两代已结清——只留最新代（settledAt 最大者），更早的让位（结构事件退场）
test('v4-#8 两代已结清：留最新代（settledAt 最大），旧代让位不投影', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [],
    boardItems: [
      bitem('a1', { status: 'completed', batchId: 'batchA', updatedAt: T0 + 1000 }), // 旧代
      bitem('b1', { status: 'completed', batchId: 'batchB', updatedAt: T0 + 999_000 }), // 最新代
    ],
  })
  assert.deepEqual(tree.map((i) => i.id), ['b1'])
})

// 边界 #8b（v4.1 顶掉即刻化）：存在活跃批时已结清批立即让位（新任务发起即顶掉，不等新批结清）
test('v4-#8b 新任务即刻顶掉：活跃批出现时已结清批全部立即让位（树=仅活跃批）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [],
    boardItems: [
      bitem('a1', { status: 'completed', batchId: 'batchA', updatedAt: T0 + 1000 }), // 旧完成代
      bitem('c1', { status: 'in_progress', batchId: 'batchC' }), // 新任务发起
      bitem('c2', { status: 'pending', batchId: 'batchC' }),
    ],
  })
  assert.deepEqual(tree.map((i) => i.id), ['c1', 'c2'], '旧完成代立即让位，树=仅新活跃批')
})

// 边界 #8b-2：旧代让位后新批完成 → 新代成为保留代（常驻恢复，无回摆）
test('v4-#8b-2 顶掉后落定：新批完成后成为保留代（✓ 常驻，旧代不回摆）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [],
    boardItems: [
      bitem('a1', { status: 'completed', batchId: 'batchA', updatedAt: T0 + 1000 }),
      bitem('c1', { status: 'completed', batchId: 'batchC', updatedAt: T0 + 999_000 }),
    ],
  })
  assert.deepEqual(tree.map((i) => i.id), ['c1'], '无活跃批：新代=最近代保留，旧代让位不回摆')
})

// 边界 #8c：平局稳定序（输入序无关）——两批同 settledAt，按组键字典序取首；行序交换不改变留谁
test('v4-#8c 平局稳定序：同settledAt按组键字典序取首，输入序无关（跨推送稳定）', () => {
  const batchA = [bitem('a1', { status: 'completed', batchId: 'batchA', updatedAt: T0 + 1000 })]
  const batchB = [bitem('b1', { status: 'completed', batchId: 'batchB', updatedAt: T0 + 1000 })]
  const order1 = buildWorkPlanTree({ mirrorTasks: [], boardItems: [...batchA, ...batchB] })
  const order2 = buildWorkPlanTree({ mirrorTasks: [], boardItems: [...batchB, ...batchA] })
  assert.deepEqual(order1.map((i) => i.id), ['a1'], 'A 键字典序在前 → 留 A')
  assert.deepEqual(order2.map((i) => i.id), ['a1'], '行序交换仍留 A（不依赖输入序）')
})

// 边界 #11：断链孤儿提升后参与批分组（不是逐行滤除）
test('v4-#11 断链孤儿：提升根层后按批分组（同批兄弟在办→终态孤儿投影）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1')],
    boardItems: [
      bitem('orphan-done', { status: 'completed', parentTaskId: 't-gone', batchId: 'b1' }), // 断链+终态
      bitem('orphan-live', { status: 'in_progress', parentTaskId: 't-gone', batchId: 'b1' }), // 断链+在办
    ],
  })
  assert.deepEqual(tree.map((i) => i.id), ['t1', 'orphan-done', 'orphan-live']) // 同批同命：在办兄弟拖住终态孤儿
})

// 边界 #14：update 推后 updatedAt → 该批成为最新代（代序由 settledAt 决定，时间只排序不退场）
test('v4-#14 代序由settledAt决定：update推后→该批成为最新代被保留', () => {
  const base = [
    bitem('r1', { status: 'completed', batchId: 'b1', updatedAt: T0 + 1000 }),
    bitem('r2', { status: 'completed', batchId: 'b2', updatedAt: T0 + 2000 }),
  ]
  // b2 较新 → 留 b2
  assert.deepEqual(buildWorkPlanTree({ mirrorTasks: [], boardItems: base }).map((i) => i.id), ['r2'])
  // b1 被推后到 T0+9000（如写 note）→ b1 成为最新代 → 留 b1
  const pushed = [{ ...base[0]!, updatedAt: T0 + 9000 }, base[1]!]
  assert.deepEqual(buildWorkPlanTree({ mirrorTasks: [], boardItems: pushed }).map((i) => i.id), ['r1'])
})

// 边界 #10：有链行不受⑦影响（completed 子行随清单父项全态投影）
test('v4-#10 有链零改动：挂链completed子行永显（随清单生命周期走）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [task('t1', { status: 'in_progress' })],
    boardItems: [bitem('c1', { status: 'completed', parentTaskId: 't1', batchId: 'b1' })],
  })
  assert.equal(tree.length, 1)
  assert.equal(tree[0]!.children![0]!.status, 'completed')
})

// ---------- wiring 段：保留界 1 事件驱动（结清常驻/代际让位/重启恢复） ----------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function makeFakeBridge(): { bridge: RelayBridge; pushes: string[] } {
  const pushes: string[] = []
  const bridge = { pushWorkPlanState: (sid: string) => pushes.push(sid) } as unknown as RelayBridge
  return { bridge, pushes }
}

/** 内存假板 store（照 wireWorkPlan.test.ts 先例，免落盘；用例 d 用文件型） */
function memBoardStore() {
  const store = new Map<string, unknown>()
  return {
    load: async (id: string) => store.get(id) as never,
    save: async (s: { boardId: string }) => void store.set(s.boardId, s),
    exists: async (id: string) => store.has(id),
    archiveBoard: async () => { throw new Error('测试不需要') },
  }
}

let tmpBase = ''
beforeEach(() => {
  resetWorkPlanWiringStateForTest()
  tmpBase = mkdtempSync(join(tmpdir(), 'wpv4-'))
  setWorkPlanMirrorStoreForTest(new WorkPlanMirrorStore(tmpBase))
})
afterEach(() => {
  setWorkPlanMirrorStoreForTest(null)
  resetSessionBoardService()
  rmSync(tmpBase, { recursive: true, force: true })
})

async function postBatchClaim(svc: SessionBoardService, sid: string, batchId: string, ids: string[]) {
  for (const id of ids) {
    await svc.autoPostAndClaim({ sessionId: sid, batchId, taskId: `tc-${id}`, subagentType: 'general-purpose', title: `子任务 ${id}` })
  }
}

// 用例 a：批结清 → 定格帧推送 → 常驻（无期满再推——v4：已结清批不再因时间退场）
test('v4-wiring-a 批结清常驻：结清推送后无期满再推，树保持全终态整批', async () => {
  setSessionBoardService(new SessionBoardService(memBoardStore()))
  const svc = (await import('../../src/services/board/SessionBoardService.ts')).getSessionBoardService()!
  const { bridge, pushes } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    await postBatchClaim(svc, 's1', 'batch-a', ['1', '2', '3'])
    await sleep(30)
    let state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.items.length, 3) // 三行 in_progress
    // 整批 settle（settledAt=最后一次 settle 的 updatedAt）
    for (const id of ['1', '2', '3']) await svc.settleByTaskId(`tc-${id}`, 'completed', { result: `交付 ${id}` })
    await sleep(30)
    const pushesAfterSettle = pushes.length
    assert.ok(pushesAfterSettle >= 2, 'settle 后必有推送')
    state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.items.length, 3) // 定格帧：全终态整批保留
    assert.deepEqual(state.items.map((i) => i.status), ['completed', 'completed', 'completed'])
    // v4 核心断言：远超旧 10s 定格窗口的时长后——无再推（时间流逝不触发推送）、树保持常驻
    await sleep(200)
    assert.equal(pushes.length, pushesAfterSettle, '无期满再推（时间窗机制已退役）')
    state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.items.length, 3, '已结清批常驻（最近一代）')
  } finally {
    off()
  }
})

// 用例 b（v4.1）：新批出现（未结清）→ 旧已结清代立即让位（顶掉即刻化）；双完落定后新代常驻
test('v4-wiring-b 新任务即刻顶掉：新批出现时旧已结清代立即让位，落定后新代常驻', async () => {
  setSessionBoardService(new SessionBoardService(memBoardStore()))
  const svc = (await import('../../src/services/board/SessionBoardService.ts')).getSessionBoardService()!
  const { bridge } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    await postBatchClaim(svc, 's1', 'batchA', ['a'])
    await svc.settleByTaskId('tc-a', 'completed')
    await sleep(30)
    let state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.items.length, 1, 'A 完成：无活跃批 → 保留代常驻')
    // 新任务 B 发起（未结清）→ A 立即让位（BOARD_CHANGED 事件触发推送）
    await postBatchClaim(svc, 's1', 'batchB', ['b'])
    await sleep(30)
    state = await deps.buildWorkPlanState('s1', undefined)
    assert.deepEqual(state.items.map((i) => i.content), ['子任务 b'], '新任务发起：旧代 A 立即让位（顶掉即刻）')
    // B 也完成 → B 成为保留代（✓ 常驻）
    await svc.settleByTaskId('tc-b', 'completed')
    await sleep(30)
    state = await deps.buildWorkPlanState('s1', undefined)
    assert.deepEqual(state.items.map((i) => i.content), ['子任务 b'], '落定：新代 B 常驻（A 不回摆）')
  } finally {
    off()
  }
})

// 用例 c（v4.1）：update 保留代行（note）→ 该代仍保留常驻（让位代已被物理删，无从 update——场景自然消失）
test('v4-wiring-c update保留代：推后updatedAt不破坏常驻（让位代已删，场景收敛到保留代）', async () => {
  setSessionBoardService(new SessionBoardService(memBoardStore()))
  const svc = (await import('../../src/services/board/SessionBoardService.ts')).getSessionBoardService()!
  const { bridge } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    await postBatchClaim(svc, 's1', 'batch-a', ['x'])
    await postBatchClaim(svc, 's1', 'batch-b', ['y'])
    await svc.settleByTaskId('tc-x', 'completed')
    await sleep(20)
    await svc.settleByTaskId('tc-y', 'completed')
    await sleep(80) // flush：sweep 已物理删让位代 x（板上只剩保留代 y）
    let state = await deps.buildWorkPlanState('s1', undefined)
    assert.deepEqual(state.items.map((i) => i.content), ['子任务 y'], 'x 让位已删 → 树=保留代 y')
    // update 保留代 y 行写 note → updatedAt 推后 → y 仍保留（常驻不破坏；settledAt 自保持）
    const board = await svc.readBoard('s1')
    const yItem = board.items.find((it) => it.title === '子任务 y')!
    await svc.update('s1', yItem.id, { note: '交付补充说明' }, { role: 'worker', assignee: yItem.assignee! })
    await sleep(60)
    state = await deps.buildWorkPlanState('s1', undefined)
    assert.deepEqual(state.items.map((i) => i.content), ['子任务 y'], 'update 保留代不破坏常驻')
  } finally {
    off()
  }
})

// 用例 e（v4.1）：让位即删行——板上僵尸行（让位批）被物理清除（board 与树生命周期对齐）
test('v4-wiring-e 让位即删行：启动/推送前让位批僵尸行被物理清除', async () => {
  setSessionBoardService(new SessionBoardService(memBoardStore()))
  const svc = (await import('../../src/services/board/SessionBoardService.ts')).getSessionBoardService()!
  const { bridge } = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  try {
    // 两代已结清：batchA（旧）+ batchB（新）——都完成
    await postBatchClaim(svc, 's1', 'batchA', ['a'])
    await sleep(20)
    await postBatchClaim(svc, 's1', 'batchB', ['b'])
    await svc.settleByTaskId('tc-a', 'completed')
    await sleep(20)
    await svc.settleByTaskId('tc-b', 'completed')
    await sleep(60) // 防抖 flush：sweep（删 A 僵尸行）→ remove 触发新 bump → 下一轮推干净板
    await sleep(60)
    const board = await svc.readBoard('s1')
    assert.equal(board.items.length, 1, '让位代 A 被物理删除，板上只留保留代 B')
    assert.equal(board.items[0]!.title, '子任务 b')
    const state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.items.length, 1, '树投影与板一致（1 行）')
  } finally {
    off()
  }
})

// 用例 d：重启恢复——off 后重连（load 恢复镜像 + 板文件恢复）→ 已结清代照常投影（(e) 补排退役不丢树）
test('v4-wiring-d 重启恢复：装配恢复后已结清代照常投影', async () => {
  // 文件型板 store（跨"重启"持久）
  const boardDir = mkdtempSync(join(tmpdir(), 'wpv4-board-'))
  const bpath = (id: string) => join(boardDir, `${id}.json`)
  const fileStore = {
    // 端口契约（2026-10-07 显式化）：ENOENT=undefined（合法没有板）；其他 IO 错误上抛
    load: async (id: string) => {
      try {
        return JSON.parse(readFileSync(bpath(id), 'utf8')) as never
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
        throw err
      }
    },
    save: async (s: { boardId: string }) => void writeFileSync(bpath(s.boardId), JSON.stringify(s)),
    exists: async (id: string) => existsSync(bpath(id)),
    archiveBoard: async () => { throw new Error('测试不需要') },
  }
  setSessionBoardService(new SessionBoardService(fileStore))
  const svc = (await import('../../src/services/board/SessionBoardService.ts')).getSessionBoardService()!
  // 第一段：挂行+结清 → 定格帧推过
  const b1 = makeFakeBridge()
  const deps = makeWorkPlanSyncBridgeDeps()
  const off1 = wireWorkPlan(b1.bridge, { debounceMs: 5 })
  await postBatchClaim(svc, 's1', 'batch-a', ['k'])
  await svc.settleByTaskId('tc-k', 'completed')
  await sleep(30)
  let state = await deps.buildWorkPlanState('s1', undefined)
  assert.equal(state.items.length, 1) // 定格帧
  off1() // 模拟进程退出
  await sleep(30)
  // 第二段：重连（镜像经 WorkPlanMirrorStore(tmpBase) 恢复、板经文件恢复）→ 已结清代照常投影
  const b2 = makeFakeBridge()
  const off2 = wireWorkPlan(b2.bridge, { debounceMs: 5 })
  try {
    await sleep(30)
    state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.items.length, 1, '重启后已结清代照常投影（常驻，无需补排）')
    // 静置（远超旧 10s 窗口的缩影）→ 无时间触发推送，树不变
    const n = b2.pushes.length
    await sleep(200)
    assert.equal(b2.pushes.length, n, '重启后无时间驱动的推送（事件驱动唯一）')
    state = await deps.buildWorkPlanState('s1', undefined)
    assert.equal(state.items.length, 1)
  } finally {
    off2()
    rmSync(boardDir, { recursive: true, force: true })
  }
})
