import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { mkdtemp, readFile, rm, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MS_EPOCH_FLOOR,
  nextSnapshotRev,
  migrateSnapshotRev,
  adoptSnapshotRev,
} from '../../src/services/snapshotRev.ts'
import {
  SessionBoardService,
  resetSessionBoardService,
  setSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import { BoardStore, isCorruptSnapshotError } from '../../src/services/board/boardStore.ts'
import { BoardError } from '../../src/services/board/boardTypes.ts'
import { eventBus, EVENTS, type BoardChangedPayload } from '../../src/utils/eventBus.ts'
import { makeBoardSyncBridgeDeps } from '../../src/services/relayEngineWiring.ts'
import { setWorkPlanMirrorStoreForTest, WorkPlanMirrorStore } from '../../src/services/workplan/workPlanMirrorStore.ts'
import { makeWorkPlanSyncBridgeDeps } from '../../src/services/relayEngineWiring.ts'

async function makeService(t: TestContext): Promise<{ svc: SessionBoardService; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-rev-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  t.after(async () => {
    resetSessionBoardService()
    await rm(dir, { recursive: true, force: true })
  })
  return { svc, dir }
}

// ---------------- 纯函数 ----------------

test('nextSnapshotRev:严格递增且 ≥ prev+1(同毫秒多 bump 不塌)', () => {
  let prev = 0
  for (let i = 0; i < 50; i++) {
    const next = nextSnapshotRev(prev)
    assert.ok(next > prev, `应严格递增: ${prev} → ${next}`)
    assert.ok(next >= prev + 1)
    prev = next
  }
  assert.ok(prev >= MS_EPOCH_FLOOR, '从 0 起步的纪元应被抬到时间基')
})

test('migrateSnapshotRev:旧小计数→时间基;已时间基幂等保留', () => {
  const migrated = migrateSnapshotRev(22)
  assert.ok(migrated >= MS_EPOCH_FLOOR, '小计数应被迁移到毫秒纪元')
  const big = Date.now() + 12345
  assert.equal(migrateSnapshotRev(big), big, '时间基原样保留')
  assert.equal(migrateSnapshotRev(migrateSnapshotRev(5)), migrateSnapshotRev(5), '二次迁移幂等')
})

test('adoptSnapshotRev:至少高于手机上报值一线', () => {
  const known = MS_EPOCH_FLOOR + 999
  assert.ok(adoptSnapshotRev(known) > known)
})

// ---------------- 纪元纪律(事故钉子) ----------------

test('【钉子】板损坏重置后,新板对外 rev ≥ 任何旧纪元小计数(2026-10-07 事故根治)', async (t) => {
  const { svc, dir } = await makeService(t)
  // 模拟旧纪元板文件被撕裂(非合法 JSON)
  await writeFile(join(dir, 'sess-sick.json'), '{"boardId":"sess-sick","revision":87,"items":[{"id":"x', 'utf8')
  const board = await svc.ensureBoard('sess-sick')
  // 手机存量 boardMeta.rev 可能是旧纪元的任何小计数(事故现场≈几十)——新板必须高过它们全部
  assert.ok(board.revision >= MS_EPOCH_FLOOR, `损坏重开的新板 rev 应为时间基,实际 ${board.revision}`)
  // 损坏件已隔离留证
  const files = await readdir(dir)
  const corpse = files.find((f) => f.startsWith('sess-sick.json.corrupt-'))
  assert.ok(corpse, `应留隔离尸体: ${files.join(', ')}`)
})

test('【钉子】板文件被删(旧会话)→ 新板 rev 仍 ≥ 手机存量(门②)', async (t) => {
  const { svc } = await makeService(t)
  // 不写文件直接访问=文件丢失形态
  const board = await svc.ensureBoard('sess-gone')
  assert.ok(board.revision >= MS_EPOCH_FLOOR)
})

test('load 迁移:旧小计数文件读入即抬升且落盘;时间基文件不动', async (t) => {
  const { svc, dir } = await makeService(t)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'sess-old.json'),
    JSON.stringify({ boardId: 'sess-old', revision: 22, items: [], createdAt: 1, updatedAt: 1 }),
    'utf8',
  )
  const board = await svc.ensureBoard('sess-old')
  assert.ok(board.revision >= MS_EPOCH_FLOOR, `旧纪元 22 应迁移,实际 ${board.revision}`)
  const onDisk = JSON.parse(await readFile(join(dir, 'sess-old.json'), 'utf8'))
  assert.ok(onDisk.revision >= MS_EPOCH_FLOOR, '迁移应落盘(重启不重复迁移)')

  const big = Date.now() + 5000
  await writeFile(
    join(dir, 'sess-new.json'),
    JSON.stringify({ boardId: 'sess-new', revision: big, items: [], createdAt: 1, updatedAt: 1 }),
    'utf8',
  )
  const untouched = await svc.ensureBoard('sess-new')
  assert.equal(untouched.revision, big, '时间基不重复抬升')
})

test('mutation 在迁移后的纪元内继续单调(+1 语义保持)', async (t) => {
  const { svc } = await makeService(t)
  const r0 = await svc.getRevision('sess-m')
  await svc.post('sess-m', { title: 'A', createdBy: 'lead' })
  const r1 = await svc.getRevision('sess-m')
  assert.ok(r1 > r0)
  await svc.post('sess-m', { title: 'B', createdBy: 'lead' })
  const r2 = await svc.getRevision('sess-m')
  assert.ok(r2 > r1)
})

// ---------------- 对账采纳 ----------------

test('touchRevisionAtLeast:手机存量高于本端→抬升+落盘+发事件;不低=零动作', async (t) => {
  const { svc, dir } = await makeService(t)
  await svc.post('sess-ad', { title: 'A', createdBy: 'lead' })
  const r0 = await svc.getRevision('sess-ad')

  const seen: BoardChangedPayload[] = []
  const handler = (p: BoardChangedPayload) => seen.push(p)
  eventBus.on(EVENTS.BOARD_CHANGED, handler)
  t.after(() => eventBus.off(EVENTS.BOARD_CHANGED, handler))

  const floor = r0 + 12345 // 手机存量高于本端(跨纪元/丢更新形态)
  const raised = await svc.touchRevisionAtLeast('sess-ad', floor)
  assert.ok(raised > floor, `采纳后应高于手机上报值,实际 ${raised} ≤ ${floor}`)
  assert.ok(seen.some((p) => p.sessionId === 'sess-ad' && p.revision === raised), '采纳应发 BOARD_CHANGED')
  const onDisk = JSON.parse(await readFile(join(dir, 'sess-ad.json'), 'utf8'))
  assert.equal(onDisk.revision, raised, '采纳应落盘')

  const unchanged = await svc.touchRevisionAtLeast('sess-ad', floor) // 已高于→零动作
  assert.equal(unchanged, raised)
})

test('buildBoardState 应答采纳:knownRev > 本端 → 应答 rev > knownRev(必过手机 LWW)', async (t) => {
  const { svc, dir } = await makeService(t)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'sess-sync.json'),
    JSON.stringify({ boardId: 'sess-sync', revision: 22, items: [], createdAt: 1, updatedAt: 1 }),
    'utf8',
  )
  const deps = makeBoardSyncBridgeDeps()
  const body = await deps.buildBoardState('sess-sync', '87') // 手机上报 87 > 22
  assert.ok(Number(body.rev) > 87, `应答 rev 应高于手机存量,实际 ${body.rev}`)
  assert.equal(body.full, true, '采纳后应答全量')
})

test('buildWorkPlanState 应答采纳:knownRev > 本端 → 采纳+落盘', async (t) => {
  const tmpBase = await mkdtemp(join(tmpdir(), 'wp-adopt-'))
  setWorkPlanMirrorStoreForTest(new WorkPlanMirrorStore(tmpBase))
  t.after(async () => {
    setWorkPlanMirrorStoreForTest(null)
    await rm(tmpBase, { recursive: true, force: true })
  })
  const deps = makeWorkPlanSyncBridgeDeps()
  const huge = MS_EPOCH_FLOOR + 4321 // 手机存量(时间基旧值)远高于本端 0
  const body = await deps.buildWorkPlanState('sess-wp-adopt', String(huge))
  assert.ok(Number(body.rev) > huge, `树应答 rev 应高于手机存量,实际 ${body.rev}`)
  assert.equal(body.full, true)
  // 落盘断言:mirror store 里该会话 rev ≥ 应答值(重启不丢采纳)
  const snap = JSON.parse(await readFile(join(tmpBase, '.chill', 'workplan-mirror.json'), 'utf8'))
  assert.ok(snap.sessions['sess-wp-adopt'].rev >= Number(body.rev))
})

// ---------------- 存储遏制 ----------------

test('BoardStore.load:ENOENT=undefined;损坏=SNAPSHOT_CORRUPT+隔离;IO 错误上抛不吞', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'board-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new BoardStore(dir)
  assert.equal(await store.load('nope'), undefined, 'ENOENT=合法没有板')

  await writeFile(join(dir, 'bad.json'), '{{{撕裂', 'utf8')
  await assert.rejects(() => store.load('bad'), (err: unknown) => isCorruptSnapshotError(err))
  const files = await readdir(dir)
  assert.ok(files.some((f) => f.startsWith('bad.json.corrupt-')), '损坏件应被隔离留证')
  assert.ok(!files.includes('bad.json'), '原位已让给新板(下次 save)')

  // IPC 形态判别:只剩 message 的克隆 Error 也能识别(前缀存活)
  const ipcClone = new Error('看板快照损坏(非合法 JSON):/some/path')
  assert.ok(isCorruptSnapshotError(ipcClone))
  assert.ok(!isCorruptSnapshotError(new Error('ENOENT: no such file')))
  assert.ok(!isCorruptSnapshotError(new BoardError('INVALID_INPUT', '别的问题')))
})

test('BoardStore.save:tmp 名含 pid(并发写者不同路径),落盘后无残留', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'board-save-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new BoardStore(dir)
  const state = { boardId: 'b1', revision: MS_EPOCH_FLOOR + 1, items: [], createdAt: 1, updatedAt: 1 }
  await store.save(state as never)
  await store.save({ ...state, revision: state.revision + 1 } as never)
  const files = await readdir(dir)
  assert.ok(files.includes('b1.json'), '正式件在位')
  assert.ok(!files.some((f) => f.includes('.tmp-')), `不应有 tmp 残留: ${files.join(', ')}`)
})

test('ensureBoard:IO 类错误上抛(不新建覆盖好文件),损坏类才重开新板', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'svc-io-'))
  const svc = new SessionBoardService(
    new (class extends BoardStore {
      public override async load(): Promise<never> {
        throw Object.assign(new Error('EBUSY: resource locked or unavailable'), { code: 'EBUSY' })
      }
    })(dir) as never,
  )
  setSessionBoardService(svc)
  t.after(() => resetSessionBoardService())
  await assert.rejects(() => svc.ensureBoard('sess-io'), (err: unknown) => {
    const msg = err instanceof Error ? err.message : ''
    return msg.includes('EBUSY') // 上抛原错误,不当"没有板"
  })
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})
