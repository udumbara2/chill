import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPersistence } from '../../src/persistence/SessionPersistence.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import type { IPathProvider } from '../../src/interfaces/IPathProvider.ts'
import type { Message, MessageRole } from '../../src/types/models.ts'

const USER = 'user' as MessageRole

const T = (s: number) => `2025-01-01T00:00:${String(s).padStart(2, '0')}.000Z`

interface Ctx {
  dir: string
  sdir: string
  A: SessionPersistence
  fileOf: (id: string) => string
  quarantineOf: (id: string) => string
}

function setup(): Ctx {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-gates-test-'))
  const sdir = join(dir, 'sessions')
  const provider = { getUserDataPath: () => dir, getUserHomePath: () => dir } as IPathProvider
  const A = new SessionPersistence(provider, sdir)
  return {
    dir,
    sdir,
    A,
    fileOf: (id) => join(sdir, `${id}.json`),
    quarantineOf: (id) => join(sdir, 'quarantine', `${id}.ndjson`),
  }
}

function cleanup(ctx: Ctx): void {
  ctx.A.unwatch()
  fs.rmSync(ctx.dir, { recursive: true, force: true })
}

function record(id: string, messages: Message[]): SessionRecord {
  return { id, title: 'test', messages, createdAt: T(0), updatedAt: T(0) }
}

/** 事故实证形态（会话 1790344238830-ro7xyr idx66-68 的最小复刻） */
const incidentMessages = (): Message[] => [
  { role: 'user', content: '组一个团队…', timestamp: new Date(T(0)) } as Message,
  {
    role: 'assistant',
    content: '',
    timestamp: new Date(T(1)),
    toolCalls: [
      { index: 0, id: null, type: 'function', function: { arguments: '{"action":"post"}', name: null } },
      { index: 1, id: null, type: 'function', function: { arguments: '{"q":"新闻"}', name: null } },
    ],
  } as unknown as Message,
  { role: 'tool', content: '工具调用失败: 未找到工具: null', timestamp: new Date(T(2)), toolCallId: null } as unknown as Message,
  { role: 'tool', content: '工具调用失败: 未找到工具: null', timestamp: new Date(T(3)), toolCallId: null } as unknown as Message,
]

function readSidecar(ctx: Ctx, id: string): any[] {
  const raw = fs.readFileSync(ctx.quarantineOf(id), 'utf-8')
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

test('写闸：save 带事故形态 → 盘上只留合法消息，sidecar 原文保全 3 条', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  await ctx.A.save(record('s1', incidentMessages()))
  const onDisk = JSON.parse(fs.readFileSync(ctx.fileOf('s1'), 'utf-8')) as SessionRecord
  assert.equal(onDisk.messages.length, 1)
  assert.equal(onDisk.messages[0].role, 'user')
  const side = readSidecar(ctx, 's1')
  assert.equal(side.length, 3)
  assert.ok(side.every((x) => typeof x.reason === 'string' && x.message && x.key))
  // 原文保全：assistant 的两个 null toolCalls 原样在 sidecar 里
  const badAssistant = side.find((x) => x.message.role === 'assistant')
  assert.equal(badAssistant.message.toolCalls.length, 2)
  assert.equal(badAssistant.message.toolCalls[0].id, null)
})

test('写闸·merge：盘上既有非法消息（旧版遗留）在下一次任意 save 时被清掉', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  // 绕过 save 直写一个被污染的会话文件（模拟旧版 chill 或手改产物）
  fs.writeFileSync(ctx.fileOf('s1'), JSON.stringify(record('s1', incidentMessages()), null, 2), 'utf-8')
  // 引擎内存只有合法部分（正常视角）再 save —— merge 以盘为基底，坏消息随 merge 进入 toWrite 后被写闸剔除
  await ctx.A.save(record('s1', [{ role: 'user', content: '组一个团队…', timestamp: new Date(T(0)) } as Message]))
  const onDisk = JSON.parse(fs.readFileSync(ctx.fileOf('s1'), 'utf-8')) as SessionRecord
  assert.equal(onDisk.messages.length, 1)
  assert.equal(onDisk.messages[0].role, 'user')
})

test('写闸·去重：同一批非法消息重复落盘触发，sidecar 只记一次账', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const bad = record('s1', [
    { role: 'tool', content: 'x', timestamp: new Date(T(5)), toolCallId: null } as unknown as Message,
  ])
  await ctx.A.save(bad, 'replace')
  await ctx.A.save(bad, 'replace')
  assert.equal(readSidecar(ctx, 's1').length, 1)
})

test('写闸·fail-open：隔离区不可写（被同名文件占位）→ 消息保留不丢', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  fs.writeFileSync(join(ctx.sdir, 'quarantine'), '不是目录', 'utf-8') // 占位堵死 mkdir
  await ctx.A.save(record('s1', incidentMessages()))
  const onDisk = JSON.parse(fs.readFileSync(ctx.fileOf('s1'), 'utf-8')) as SessionRecord
  // 隔离失败：原样保留（宁可带病落盘——出口闸兜底请求侧——也不静默丢数据）
  assert.equal(onDisk.messages.length, 4)
})

test('读闸：load 直接打开被污染文件 → 返回隔离报告 + 干净记录 + 盘上自愈；二次 load 静默', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  fs.writeFileSync(ctx.fileOf('s1'), JSON.stringify(record('s1', incidentMessages()), null, 2), 'utf-8')
  const r1 = await ctx.A.load('s1')
  assert.ok(r1.success && r1.record)
  assert.equal(r1.record.messages.length, 1)
  assert.equal(r1.quarantined?.length, 3)
  assert.ok(r1.quarantined!.some((x) => x.reason.includes('toolCalls[0].id')))
  assert.ok(r1.quarantined!.some((x) => x.reason.includes('toolCallId')))
  // 盘上已自愈
  const onDisk = JSON.parse(fs.readFileSync(ctx.fileOf('s1'), 'utf-8')) as SessionRecord
  assert.equal(onDisk.messages.length, 1)
  // sidecar 原文保全
  assert.equal(readSidecar(ctx, 's1').length, 3)
  // 二次 load：无报告、不再写盘（mtime 不变）
  const mtimeAfterHeal = fs.statSync(ctx.fileOf('s1')).mtimeMs
  const r2 = await ctx.A.load('s1')
  assert.equal(r2.quarantined, undefined)
  assert.equal(fs.statSync(ctx.fileOf('s1')).mtimeMs, mtimeAfterHeal)
})

test('读闸：干净文件 load 不触发任何写（mtime 不变）', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  await ctx.A.save(record('s1', [{ role: 'user', content: 'ok', timestamp: new Date(T(0)) } as Message]))
  const before = fs.statSync(ctx.fileOf('s1')).mtimeMs
  const r = await ctx.A.load('s1')
  assert.equal(r.quarantined, undefined)
  assert.equal(fs.statSync(ctx.fileOf('s1')).mtimeMs, before)
})

test('读闸·loadIfNewer：外部污染文件 → 锚定读取返回隔离报告 + 干净记录 + 盘上自愈', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  await ctx.A.save(record('s1', [{ role: 'user', content: 'ok', timestamp: new Date(T(0)) } as Message]))
  // 首次 loadIfNewer：建基线返回 null（既有语义）
  const r0 = await ctx.A.loadIfNewer('s1')
  assert.equal(r0.record, null)
  // 外部（另一进程视角）直写污染文件并确保 mtime 前进
  const before = fs.statSync(ctx.fileOf('s1')).mtimeMs
  fs.writeFileSync(ctx.fileOf('s1'), JSON.stringify(record('s1', incidentMessages()), null, 2), 'utf-8')
  const st = fs.statSync(ctx.fileOf('s1'))
  if (st.mtimeMs <= before) fs.utimesSync(ctx.fileOf('s1'), st.atime, new Date(before + 1000))
  const r1 = await ctx.A.loadIfNewer('s1')
  assert.ok(r1.success && r1.record)
  assert.equal(r1.record.messages.length, 1)
  assert.equal(r1.quarantined?.length, 3)
  // 盘上自愈；再次锚定读取静默
  const r2 = await ctx.A.loadIfNewer('s1')
  assert.equal(r2.record, null) // mtime 已被自愈回写锚定，无新变更
})
