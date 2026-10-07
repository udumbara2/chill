import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectPersistence } from '../../src/persistence/ProjectPersistence.ts'
import type { ProjectRecord } from '../../src/persistence/ProjectPersistence.ts'
import type { IPathProvider } from '../../src/interfaces/IPathProvider.ts'

const T = (s: number) => `2025-01-01T00:00:${String(s).padStart(2, '0')}.000Z`

interface Ctx {
  dir: string
  file: string
  A: ProjectPersistence
  B: ProjectPersistence
}

function setup(): Ctx {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-pp-test-'))
  const file = join(dir, 'projects.json')
  const provider = { getUserDataPath: () => dir, getUserHomePath: () => dir } as IPathProvider
  // A/B 两个实例模拟两端（各自持有独立的 lastWrittenMtime 基线，等价于两个进程）
  const A = new ProjectPersistence(provider, file)
  const B = new ProjectPersistence(provider, file)
  return { dir, file, A, B }
}

function cleanup(ctx: Ctx): void {
  ctx.A.unwatch()
  ctx.B.unwatch()
  fs.rmSync(ctx.dir, { recursive: true, force: true })
}

function proj(id: string, name: string, order: number, extra?: Partial<ProjectRecord>): ProjectRecord {
  return { id, name, createdAt: T(0), updatedAt: T(0), order, ...extra }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await sleep(50)
  }
}

/** 同一毫秒内连续写可能拿到相同 mtime；外部写入后确保 mtime 真的前进 */
function ensureMtimeAdvanced(file: string, before: number): void {
  const st = fs.statSync(file)
  if (st.mtimeMs <= before) {
    fs.utimesSync(file, st.atime, new Date(before + 1000))
  }
}

test('save/list/delete：upsert 按 id 去重，list 按 order 升序', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A } = ctx

  // 文件不存在时 list 返回空表
  let res = await A.list()
  assert.equal(res.success, true)
  assert.deepEqual(res.records, [])

  await A.save(proj('p2', '乙', 2))
  await A.save(proj('p1', '甲', 1))
  // 同 id 再 save = 更新（改名）
  await A.save(proj('p1', '甲改', 1, { updatedAt: T(5) }))
  res = await A.list()
  assert.deepEqual(res.records?.map(p => p.id), ['p1', 'p2'])
  assert.equal(res.records?.[0].name, '甲改')

  await A.delete('p1')
  res = await A.list()
  assert.deepEqual(res.records?.map(p => p.id), ['p2'])

  // 原子写不留 .tmp 残留
  assert.equal(fs.existsSync(`${ctx.file}.tmp`), false)
})

test('save 合并：双端各自 upsert 不丢对方项目（读盘按 id 合并）', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  await A.save(proj('p1', '甲', 1))
  // B 内存里没有 p1，直接 upsert 自己的 p2 —— 读盘合并后 p1 必须仍在
  await B.save(proj('p2', '乙', 2))
  const res = await A.list()
  assert.deepEqual(res.records?.map(p => p.id), ['p1', 'p2'])

  // B 删除 p1 → A 再 upsert p3 不复活 p1
  await B.delete('p1')
  await A.save(proj('p3', '丙', 3))
  const res2 = await A.list()
  assert.deepEqual(res2.records?.map(p => p.id), ['p2', 'p3'])
})

test('loadIfNewer: 自写返回 null；外部修改返回整表；首次无基线返回 null', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  await A.save(proj('p1', '甲', 1))

  // 自身写入后：mtime 与基线一致 → records: null（零读盘）
  let res = await A.loadIfNewer()
  assert.equal(res.success, true)
  assert.equal(res.records, null)

  // 外部（B 实例）修改 → A 锚定命中
  const before = fs.statSync(ctx.file).mtimeMs
  await B.save(proj('p2', '乙', 2))
  ensureMtimeAdvanced(ctx.file, before)
  res = await A.loadIfNewer()
  assert.ok(res.records)
  assert.equal(res.records.length, 2)

  // 采纳后基线已更新 → 再次调用返回 null
  res = await A.loadIfNewer()
  assert.equal(res.records, null)
})

test('watch: 自写不触发 cb；外部修改触发 cb(整表)；删除触发 cb(null)', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  await A.save(proj('p1', '甲', 1))

  const events: Array<ProjectRecord[] | null> = []
  A.watch(r => events.push(r))
  await sleep(300)
  assert.equal(events.length, 0)

  // 自身 save → 回声过滤
  await A.save(proj('p2', '乙', 2))
  await sleep(300)
  assert.equal(events.length, 0)

  // 外部修改 → cb(整表)
  const before = fs.statSync(ctx.file).mtimeMs
  await B.save(proj('p3', '丙', 3))
  ensureMtimeAdvanced(ctx.file, before)
  await waitFor(() => events.length === 1)
  assert.ok(events[0])
  assert.equal(events[0].length, 3)

  // 对端删除文件 → cb(null)，不抛错
  fs.unlinkSync(ctx.file)
  await waitFor(() => events.length === 2)
  assert.equal(events[1], null)
})


test('save 合并：folderPath 可选字段保留——对端不带字段的写入不抹掉绑定，带字段则更新', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  // A 保存带文件夹绑定的项目；B（对端/旧版）整记录更新同 id 项目但不带 folderPath → 绑定必须仍在
  await A.save(proj('p1', '甲', 1, { folderPath: '/data/proj-a' }))
  await B.save(proj('p1', '甲改', 1, { updatedAt: T(5) }))
  let res = await A.list()
  assert.equal(res.records?.[0].name, '甲改')
  assert.equal(res.records?.[0].folderPath, '/data/proj-a')

  // 绑定变更：保存方带新 folderPath → incoming wins
  await B.save(proj('p1', '甲改', 1, { folderPath: '/data/proj-b', updatedAt: T(10) }))
  res = await A.list()
  assert.equal(res.records?.[0].folderPath, '/data/proj-b')

  // 双方都无该字段 → 记录不出现该字段（旧记录形态不变）
  await A.save(proj('p2', '乙', 2))
  await B.save(proj('p2', '乙改', 2, { updatedAt: T(5) }))
  res = await A.list()
  const p2 = res.records?.find(p => p.id === 'p2')
  assert.ok(p2)
  assert.equal(p2.folderPath, undefined)
  const raw = JSON.parse(fs.readFileSync(ctx.file, 'utf-8')) as ProjectRecord[]
  assert.equal('folderPath' in raw.find(p => p.id === 'p2')!, false)
})
