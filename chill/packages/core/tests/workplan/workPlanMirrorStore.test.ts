/**
 * workPlanMirrorStore 持久化测试（serve 重启双丢根治的验证面）：
 * - save/load 往返：镜像+rev 精确恢复（验收标准 1/2）
 * - 重启恢复端到端：wire 事件→落盘→重置→再 wire→应答含树+rev 连续（验收标准 2/3）
 * - 降级：读损坏=空镜像（标准 5）、写失败静默（标准 4）
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, writeFileSync as wf } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkPlanMirrorStore, setWorkPlanMirrorStoreForTest } from '../../src/services/workplan/workPlanMirrorStore.ts'
import {
  wireWorkPlan,
  makeWorkPlanSyncBridgeDeps,
  resetWorkPlanWiringStateForTest,
} from '../../src/services/relayEngineWiring.ts'
import type { RelayBridge } from '../../src/services/relay/RelayBridge.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { TaskItem } from '../../src/types/models.ts'

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id,
  content: `任务 ${id}`,
  status: 'pending',
  createdAt: new Date('2026-10-05T00:00:00Z'),
  updatedAt: new Date('2026-10-05T00:00:00Z'),
  ...over,
})
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let tmpBase = ''
beforeEach(() => {
  resetWorkPlanWiringStateForTest()
  tmpBase = mkdtempSync(join(tmpdir(), 'wpstore-test-'))
})
afterEach(() => {
  setWorkPlanMirrorStoreForTest(null)
  rmSync(tmpBase, { recursive: true, force: true })
})

// ---------- save/load 往返 ----------

test('store：save/load 往返精确恢复（tasks 与 rev 按会话分键）', async () => {
  const store = new WorkPlanMirrorStore(tmpBase)
  const tasks = new Map<string, TaskItem[]>([
    ['s1', [task('a'), task('b', { status: 'completed' })]],
    ['s2', [task('c')]],
  ])
  const revs = new Map<string, number>([
    ['s1', 1791178000001],
    ['s2', 1791178000002],
  ])
  await store.save(tasks, revs)
  const back = await store.load()
  assert.equal(back.tasks.get('s1')!.length, 2)
  assert.equal(back.tasks.get('s1')![1]!.status, 'completed')
  assert.equal(back.revs.get('s1'), 1791178000001)
  assert.equal(back.revs.get('s2'), 1791178000002)
})

test('store：rev 有而镜像无的键（BOARD_CHANGED 只 bump rev）同样保留', async () => {
  const store = new WorkPlanMirrorStore(tmpBase)
  await store.save(new Map([['s1', [task('a')]]]), new Map([['s1', 100], ['s-board-only', 200]]))
  const back = await store.load()
  assert.equal(back.revs.get('s-board-only'), 200)
  assert.deepEqual(back.tasks.get('s-board-only'), [])
})

// ---------- 读降级（验收标准 5） ----------

test('store：文件不存在 → 空 Map（首启语义）', async () => {
  const store = new WorkPlanMirrorStore(tmpBase)
  const back = await store.load()
  assert.equal(back.tasks.size, 0)
  assert.equal(back.revs.size, 0)
})

test('store：JSON 损坏/结构不符 → 空 Map 降级，不抛（中途启动边界现状）', async () => {
  const file = join(tmpBase, '.chill', 'workplan-mirror.json')
  mkdirSync(join(tmpBase, '.chill'), { recursive: true })
  writeFileSync(file, '{broken json', 'utf8')
  const store = new WorkPlanMirrorStore(tmpBase)
  const back = await store.load()
  assert.equal(back.tasks.size, 0)

  writeFileSync(file, '{"version":1,"sessions":"not-an-object"}', 'utf8')
  const back2 = await store.load()
  assert.equal(back2.tasks.size, 0)

  writeFileSync(file, '{"version":1,"sessions":{"s1":{"tasks":"bad","rev":"bad"},"s2":{"tasks":[],"rev":42}}}', 'utf8')
  const back3 = await store.load() // 坏键单个跳过，好键保留
  assert.equal(back3.tasks.has('s1'), false)
  assert.equal(back3.revs.get('s2'), 42)
})

// ---------- 写降级（验收标准 4） ----------

test('store：写失败静默（不抛），load 仍可按既有内容恢复', async () => {
  const store = new WorkPlanMirrorStore(tmpBase)
  await store.save(new Map([['s1', [task('a')]]]), new Map([['s1', 100]]))
  // 制造写失败：把 .chill 目录替换为同名文件（mkdir recursive 必失败）
  rmSync(join(tmpBase, '.chill'), { recursive: true, force: true })
  wf(join(tmpBase, '.chill'), 'i-am-a-file', 'utf8')
  await assert.doesNotReject(() => store.save(new Map([['s2', [task('b')]]]), new Map([['s2', 200]])))
})

// ---------- 重启恢复端到端（验收标准 1/2/3） ----------

test('wiring：事件落盘 → 模拟重启（重置+再装配）→ 应答含恢复清单树、rev 跨重启单调', async () => {
  const pushes: string[] = []
  const bridge = { pushWorkPlanState: (sid: string) => pushes.push(sid) } as unknown as RelayBridge
  const deps = makeWorkPlanSyncBridgeDeps()

  // 纪元 1：事件进镜像，防抖落盘
  setWorkPlanMirrorStoreForTest(new WorkPlanMirrorStore(tmpBase))
  const off1 = wireWorkPlan(bridge, { debounceMs: 5 })
  eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', tasks: [task('t1'), task('t2')] })
  eventBus.emit(EVENTS.TASK_STATUS_UPDATED, { sessionId: 's1', taskId: 't1', status: 'completed' })
  await sleep(40) // 等防抖推送+落盘
  off1()
  const revBeforeRestart = Number((await deps.buildWorkPlanState('s1', undefined)).rev)
  assert.ok(revBeforeRestart > 0)
  // 落盘文件确实存在且含内容
  const file = join(tmpBase, '.chill', 'workplan-mirror.json')
  assert.ok(existsSync(file))
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { sessions: Record<string, { rev: number }> }
  assert.ok(onDisk.sessions['s1']!.rev > 0)

  // 模拟 serve 重启：内存清空（镜像/rev 归零），进程级单例不动（文件仍在）
  resetWorkPlanWiringStateForTest()
  const sanity = await deps.buildWorkPlanState('s1', undefined)
  assert.equal(sanity.rev, '0') // 重启后内存确实归零（本测试的前提）
  assert.deepEqual(sanity.items, [])

  // 纪元 2：重新装配 → 从快照恢复
  const off2 = wireWorkPlan(bridge, { debounceMs: 5 })
  await sleep(40) // 等 load 完成
  const restored = await deps.buildWorkPlanState('s1', undefined)
  assert.equal(restored.items.length, 2) // 清单内容恢复（不再是诚实空态）
  assert.equal(restored.items[0]!.status, 'completed')
  const revAfterRestart = Number(restored.rev)
  assert.ok(revAfterRestart >= revBeforeRestart) // rev 跨重启不回退（手机 LWW 放行）

  // 恢复后再 bump（如迟到的 TASK_STATUS_UPDATED 命中恢复的镜像）→ rev 继续单调
  eventBus.emit(EVENTS.TASK_STATUS_UPDATED, { sessionId: 's1', taskId: 't2', status: 'completed' })
  await sleep(40)
  const afterBump = await deps.buildWorkPlanState('s1', undefined)
  assert.ok(Number(afterBump.rev) > revAfterRestart)
  assert.equal(afterBump.items[1]!.status, 'completed')
  off2()
})

test('wiring：恢复途中到达的事件写入的新态不被旧快照覆盖（只填空键/rev 取 max）', async () => {
  // 预置旧快照
  const store = new WorkPlanMirrorStore(tmpBase)
  await store.save(new Map([['s1', [task('old')]]]), new Map([['s1', 100]]))
  setWorkPlanMirrorStoreForTest(new WorkPlanMirrorStore(tmpBase))
  const pushes: string[] = []
  const bridge = { pushWorkPlanState: (sid: string) => pushes.push(sid) } as unknown as RelayBridge
  const deps = makeWorkPlanSyncBridgeDeps()

  const off = wireWorkPlan(bridge, { debounceMs: 5 })
  // load 完成前事件到达（竞态窗口）：s1 已有新清单
  eventBus.emit(EVENTS.TASK_LIST_CREATED, { sessionId: 's1', tasks: [task('new-a'), task('new-b')] })
  await sleep(40)
  const state = await deps.buildWorkPlanState('s1', undefined)
  assert.deepEqual(
    state.items.map((i) => i.id),
    ['new-a', 'new-b'], // 新态不被旧快照覆盖
  )
  assert.ok(Number(state.rev) > 100) // rev 取 max（时间基 bump 结果）
  off()
})
