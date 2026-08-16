import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPersistence } from '../../src/persistence/SessionPersistence.ts'
import type { SessionRecord, CompactionCheckpoint } from '../../src/persistence/SessionPersistence.ts'
import type { IPathProvider } from '../../src/interfaces/IPathProvider.ts'
import type { Message, MessageRole } from '../../src/types/models.ts'

// MessageRole 是 enum（不可经 node 类型擦除运行时导入），测试里用字符串字面量替代
const USER = 'user' as MessageRole
const ASSISTANT = 'assistant' as MessageRole
const TOOL = 'tool' as MessageRole

const T = (s: number) => `2025-01-01T00:00:${String(s).padStart(2, '0')}.000Z`

interface Ctx {
  dir: string
  sdir: string
  A: SessionPersistence
  B: SessionPersistence
  fileOf: (id: string) => string
}

function setup(): Ctx {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-sp-test-'))
  const sdir = join(dir, 'sessions')
  const provider = { getUserDataPath: () => dir, getUserHomePath: () => dir } as IPathProvider
  // A/B 两个实例模拟两端（各自持有独立的 lastWrittenMtime 基线，等价于两个进程）
  const A = new SessionPersistence(provider, sdir)
  const B = new SessionPersistence(provider, sdir)
  return { dir, sdir, A, B, fileOf: (id: string) => join(sdir, `${id}.json`) }
}

function cleanup(ctx: Ctx): void {
  ctx.A.unwatch()
  ctx.B.unwatch()
  fs.rmSync(ctx.dir, { recursive: true, force: true })
}

function msg(role: MessageRole, isoTime: string, content: string, toolCallId?: string): Message {
  const m: Message = { role, content, timestamp: new Date(isoTime) }
  if (toolCallId) m.toolCallId = toolCallId
  return m
}

function record(id: string, messages: Message[], extra?: Partial<SessionRecord>): SessionRecord {
  return {
    id,
    title: 'test',
    messages,
    createdAt: T(0),
    updatedAt: T(0),
    ...extra
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await sleep(50)
  }
}

/** 同一毫秒内连续写可能拿到相同 mtime；外部写入后确保 mtime 真的前进，模拟真实的"稍后写入" */
function ensureMtimeAdvanced(file: string, before: number): void {
  const st = fs.statSync(file)
  if (st.mtimeMs <= before) {
    fs.utimesSync(file, st.atime, new Date(before + 1000))
  }
}

test('merge: 双端交替追加全部保留，按 timestamp 排序，同 timestamp 稳定（盘上在前）', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  // 交替追加：B 写入 a2 后，A 用不含 a2 的内存再保存，a2 必须仍在
  await A.save(record('s1', [msg(USER, T(1), 'u1')]))
  await B.save(record('s1', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(3), 'a2')]))
  await A.save(record('s1', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  const { record: r } = await A.load('s1')
  assert.ok(r)
  assert.deepEqual(r.messages.map(m => m.content), ['u1', 'a1', 'a2'])

  // 同 timestamp：盘上的消息排在新来的前面
  await A.save(record('s2', [msg(USER, T(9), '盘上消息')]))
  await B.save(record('s2', [msg(USER, T(9), '盘上消息'), msg(ASSISTANT, T(9), '新来消息')]))
  const { record: r2 } = await A.load('s2')
  assert.ok(r2)
  assert.equal(r2.messages.length, 2)
  assert.deepEqual(r2.messages.map(m => m.content), ['盘上消息', '新来消息'])
})

test('merge: 同 ms 多条不同 toolCallId 的 tool 消息全部保留', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A } = ctx

  await A.save(record('s', [msg(USER, T(1), 'u')]))
  await A.save(record('s', [
    msg(USER, T(1), 'u'),
    msg(TOOL, T(2), 'r1', 'tc-1'),
    msg(TOOL, T(2), 'r2', 'tc-2'),
    msg(TOOL, T(2), 'r3', 'tc-3')
  ]))
  const { record: r } = await A.load('s')
  assert.ok(r)
  assert.equal(r.messages.length, 4)
  assert.deepEqual(
    r.messages.filter(m => m.role === TOOL).map(m => m.content),
    ['r1', 'r2', 'r3']
  )
})

test('merge: 同一条 assistant 消息（同 role+timestamp）连续保存 N 次 → 仅 1 条且为最终版', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A } = ctx

  for (const content of ['a', 'ab', 'abc', 'abcd']) {
    await A.save(record('s', [msg(ASSISTANT, T(5), content)]))
  }
  const { record: r } = await A.load('s')
  assert.ok(r)
  assert.equal(r.messages.length, 1)
  assert.equal(r.messages[0].content, 'abcd')
})

test('merge: Date 对象与 ISO 字符串混合的 timestamp 归一化，消息数不变', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A } = ctx

  // 内存是 Date 对象，落盘后变 ISO 字符串；再用 Date 对象的内存视图保存，不得判为两条
  await A.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  const raw = JSON.parse(fs.readFileSync(ctx.fileOf('s'), 'utf-8'))
  assert.equal(typeof raw.messages[0].timestamp, 'string')

  await A.save(record('s', [
    msg(USER, T(1), 'u1 改'),
    msg(ASSISTANT, T(2), 'a1'),
    msg(USER, T(3), 'u2')
  ]))
  const { record: r } = await A.load('s')
  assert.ok(r)
  assert.equal(r.messages.length, 3)
  assert.equal(r.messages[0].content, 'u1 改')

  // 保存→读回（timestamp 已是 ISO 字符串）→改内容再保存 → 消息数仍不变
  r.messages[0].content = 'u1 再改'
  await A.save(r)
  const { record: r2 } = await A.load('s')
  assert.ok(r2)
  assert.equal(r2.messages.length, 3)
  assert.equal(r2.messages[0].content, 'u1 再改')
})

test('merge: 工具循环途中对端写入，后续保存不丢对端消息', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  // A 开始一轮工具循环：user → assistant 工具调用
  await A.save(record('s', [msg(USER, T(1), 'u1')]))
  await A.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), '调用工具')]))
  // B（对端）在工具执行间隙从盘读出后追加一条自己的消息
  const { record: disk } = await B.load('s')
  assert.ok(disk)
  disk.messages.push(msg(USER, T(3), '对端插入'))
  await B.save(disk)
  // A 继续工具循环：tool 结果 → 最终 assistant（A 的内存里没有"对端插入"）
  await A.save(record('s', [
    msg(USER, T(1), 'u1'),
    msg(ASSISTANT, T(2), '调用工具'),
    msg(TOOL, T(4), '工具结果', 'tc-1')
  ]))
  await A.save(record('s', [
    msg(USER, T(1), 'u1'),
    msg(ASSISTANT, T(2), '调用工具'),
    msg(TOOL, T(4), '工具结果', 'tc-1'),
    msg(ASSISTANT, T(5), '最终回复')
  ]))

  const { record: r } = await A.load('s')
  assert.ok(r)
  assert.equal(r.messages.length, 5)
  assert.deepEqual(r.messages.map(m => m.content), ['u1', '调用工具', '对端插入', '工具结果', '最终回复'])
})

test('merge: compactions 按 id 并集合并，对端无该字段不丢（头号坑回归）', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  const cmp = (id: string, createdAt: string, upTo: string): CompactionCheckpoint => ({
    id,
    createdAt,
    upToTimestamp: upTo,
    summary: `总结-${id}`,
  })

  // A 压缩过（带 compactions）；B（对端/旧版）保存不含该字段的记录 → c1 必须仍在
  await A.save(record('s', [msg(USER, T(1), 'u1')], {
    compactions: [cmp('c1', '2025-01-01T01:00:00.000Z', T(5))],
  }))
  await B.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  let r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.messages.length, 2)
  assert.deepEqual(r.compactions?.map(c => c.id), ['c1'])

  // 双端各有 checkpoint：按 id 并集，按 createdAt 升序
  await B.save(record('s', [msg(USER, T(1), 'u1')], {
    compactions: [cmp('c2', '2025-01-01T02:00:00.000Z', T(8))],
  }))
  r = (await A.load('s')).record
  assert.ok(r)
  assert.deepEqual(r.compactions?.map(c => c.id), ['c1', 'c2'])

  // 同 id 新的 wins（覆盖而非重复）
  await A.save(record('s', [msg(USER, T(1), 'u1')], {
    compactions: [
      { ...cmp('c1', '2025-01-01T01:00:00.000Z', T(5)), summary: '总结-c1-更新' },
      cmp('c2', '2025-01-01T02:00:00.000Z', T(8)),
    ],
  }))
  r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.compactions?.length, 2)
  assert.equal(r.compactions?.[0].summary, '总结-c1-更新')
})

test('merge: 双方都无 compactions 时记录不出现该字段（未压缩会话形态不变）', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  await A.save(record('s', [msg(USER, T(1), 'u1')]))
  await B.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  const { record: r } = await A.load('s')
  assert.ok(r)
  assert.equal(r.compactions, undefined)
  const raw = JSON.parse(fs.readFileSync(ctx.fileOf('s'), 'utf-8'))
  assert.equal('compactions' in raw, false)
})

test('merge: lastUsage 持久化与合并——incoming 优先，对端无该字段不丢', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  const usage = (n: number) => ({ promptTokens: n, completionTokens: 10, totalTokens: n + 10 })

  // A 保存带实测用量的记录；B（对端/旧版）保存不含该字段的记录 → 用量必须仍在
  await A.save(record('s', [msg(USER, T(1), 'u1')], { lastUsage: usage(1000) }))
  await B.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  let r = (await A.load('s')).record
  assert.ok(r)
  assert.deepEqual(r.lastUsage, usage(1000))

  // 保存方有更新用量 → incoming wins
  await B.save(record('s', [msg(USER, T(1), 'u1')], { lastUsage: usage(2000) }))
  r = (await A.load('s')).record
  assert.ok(r)
  assert.deepEqual(r.lastUsage, usage(2000))

  // 双方都无该字段 → 记录不出现该字段（旧记录形态不变）
  await A.save(record('s2', [msg(USER, T(1), 'u1')]))
  await B.save(record('s2', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  const r2 = (await A.load('s2')).record
  assert.ok(r2)
  assert.equal(r2.lastUsage, undefined)
  const raw = JSON.parse(fs.readFileSync(ctx.fileOf('s2'), 'utf-8'))
  assert.equal('lastUsage' in raw, false)
})

test('merge: projectId 持久化与合并——incoming 优先，对端旧版写盘无该字段不丢（迭代 4 头号防护）', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  // A（UI 端）保存带项目归属的记录；B（对端/旧版 CLI）保存不含该字段的记录 → 归属必须仍在
  await A.save(record('s', [msg(USER, T(1), 'u1')], { projectId: 'proj-1' }))
  await B.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  let r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.messages.length, 2)
  assert.equal(r.projectId, 'proj-1')

  // 归属变更（"移动到项目"）：保存方带新 projectId → incoming wins
  await B.save(record('s', [msg(USER, T(1), 'u1')], { projectId: 'proj-2' }))
  r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.projectId, 'proj-2')

  // 双方都无该字段 → 记录不出现该字段（CLI 旧记录形态不变）
  await A.save(record('s2', [msg(USER, T(1), 'u1')]))
  await B.save(record('s2', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  const r2 = (await A.load('s2')).record
  assert.ok(r2)
  assert.equal(r2.projectId, undefined)
  const raw = JSON.parse(fs.readFileSync(ctx.fileOf('s2'), 'utf-8'))
  assert.equal('projectId' in raw, false)
})

test('merge: workdir 持久化与合并——incoming 优先，对端旧版写盘无该字段不丢（与 projectId 同一防护）', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  // A（绑定方）保存带工作目录的记录；B（对端/旧版 CLI）保存不含该字段的记录 → workdir 必须仍在
  await A.save(record('s', [msg(USER, T(1), 'u1')], { workdir: '/data/proj-a' }))
  await B.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  let r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.messages.length, 2)
  assert.equal(r.workdir, '/data/proj-a')

  // 工作目录变更：保存方带新 workdir → incoming wins
  await B.save(record('s', [msg(USER, T(1), 'u1')], { workdir: '/data/proj-b' }))
  r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.workdir, '/data/proj-b')

  // 双方都无该字段 → 记录不出现该字段（CLI 旧记录形态不变）
  await A.save(record('s2', [msg(USER, T(1), 'u1')]))
  await B.save(record('s2', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  const r2 = (await A.load('s2')).record
  assert.ok(r2)
  assert.equal(r2.workdir, undefined)
  const raw = JSON.parse(fs.readFileSync(ctx.fileOf('s2'), 'utf-8'))
  assert.equal('workdir' in raw, false)
})

test('merge: 标量优先级 manual > auto > default，updatedAt 取 max、createdAt 取 min', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  await A.save(record('s', [], { title: '默认标题', titleSource: 'default' }))
  await B.save(record('s', [], { title: '自动标题', titleSource: 'auto' }))
  let r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.title, '自动标题')
  assert.equal(r.titleSource, 'auto')

  await A.save(record('s', [], { title: '手动标题', titleSource: 'manual' }))
  await B.save(record('s', [], { title: '另一个自动', titleSource: 'auto' }))
  r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.title, '手动标题')
  assert.equal(r.titleSource, 'manual')

  // 标量 min/max
  await A.save(record('s2', [], { createdAt: '2025-06-01T00:00:00.000Z', updatedAt: '2025-06-10T00:00:00.000Z' }))
  await B.save(record('s2', [], { createdAt: '2025-05-01T00:00:00.000Z', updatedAt: '2025-06-05T00:00:00.000Z' }))
  const r2 = (await A.load('s2')).record
  assert.ok(r2)
  assert.equal(r2.createdAt, '2025-05-01T00:00:00.000Z')
  assert.equal(r2.updatedAt, '2025-06-10T00:00:00.000Z')
})

test('merge: 旧格式记录（无 titleSource、无 tasks）合并不报错', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A } = ctx

  // 手写一份旧格式会话文件
  const oldRecord = {
    id: 'old',
    title: '旧会话',
    messages: [{ role: 'user', content: '旧消息', timestamp: T(1) }],
    createdAt: T(1),
    updatedAt: T(1)
  }
  fs.writeFileSync(ctx.fileOf('old'), JSON.stringify(oldRecord, null, 2), 'utf-8')

  const result = await A.save(record('old', [
    msg(USER, T(1), '旧消息'),
    msg(ASSISTANT, T(2), '新回复')
  ], { title: '智能标题', titleSource: 'auto' }))
  assert.equal(result.success, true)

  const { record: r } = await A.load('old')
  assert.ok(r)
  assert.equal(r.messages.length, 2)
  assert.deepEqual(r.messages.map(m => m.content), ['旧消息', '新回复'])
  // 旧记录 titleSource 缺省视为 default，auto 标题胜出
  assert.equal(r.title, '智能标题')
  assert.equal(r.titleSource, 'auto')
})

test('replace: 整盘覆写不被合并干扰，覆写后 merge 基于新内容继续', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A } = ctx

  await A.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1'), msg(TOOL, T(3), 't1', 'tc-1')]))
  // replace：被删除的消息不因合并复活
  await A.save(record('s', [msg(USER, T(1), 'u1')]), 'replace')
  let r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.messages.length, 1)
  assert.equal(r.messages[0].content, 'u1')

  // replace 之后 merge 基于覆写内容继续合并
  await A.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(4), 'a2')]))
  r = (await A.load('s')).record
  assert.ok(r)
  assert.equal(r.messages.length, 2)
  assert.deepEqual(r.messages.map(m => m.content), ['u1', 'a2'])
})

test('loadIfNewer: 自写返回 null；外部修改返回 record；首次无基线返回 null', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  await A.save(record('s', [msg(USER, T(1), 'u1')]))

  // 自身写入后：mtime 与基线一致 → null（零读盘）
  let res = await A.loadIfNewer('s')
  assert.equal(res.success, true)
  assert.equal(res.record, null)

  // 外部（B 实例）修改 → A 锚定命中
  const before = fs.statSync(ctx.fileOf('s')).mtimeMs
  await B.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))
  ensureMtimeAdvanced(ctx.fileOf('s'), before)
  res = await A.loadIfNewer('s')
  assert.equal(res.success, true)
  assert.ok(res.record)
  assert.equal(res.record.messages.length, 2)

  // 采纳后基线已更新 → 再次调用返回 null
  res = await A.loadIfNewer('s')
  assert.equal(res.record, null)

  // 全新实例（无该 id 基线）：首次调用建基线并返回 null，不视为"更新"
  const C = new SessionPersistence({ getUserDataPath: () => ctx.dir, getUserHomePath: () => ctx.dir } as IPathProvider, ctx.sdir)
  res = await C.loadIfNewer('s')
  assert.equal(res.success, true)
  assert.equal(res.record, null)
  // 基线建立后外部再改 → 能检出
  const before2 = fs.statSync(ctx.fileOf('s')).mtimeMs
  await B.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1'), msg(USER, T(3), 'u2')]))
  ensureMtimeAdvanced(ctx.fileOf('s'), before2)
  res = await C.loadIfNewer('s')
  assert.ok(res.record)
  assert.equal(res.record.messages.length, 3)
})

test('watch: 自写不触发 cb；外部修改触发 cb(record)；删除触发 cb(null)；unwatch 后零事件', async (t) => {
  const ctx = setup()
  t.after(() => cleanup(ctx))
  const { A, B } = ctx

  await A.save(record('s', [msg(USER, T(1), 'u1')]))
  // watch 启动前的外部变更不属于事件（启动即建基线）
  await B.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1')]))

  const events: Array<SessionRecord | null> = []
  A.watch('s', r => events.push(r))
  await sleep(300)
  assert.equal(events.length, 0)

  // 自身 save → 回声过滤，绝不触发 cb
  await A.save(record('s', [msg(USER, T(1), 'u1'), msg(ASSISTANT, T(2), 'a1'), msg(USER, T(3), 'u2')]))
  await sleep(300)
  assert.equal(events.length, 0)

  // 外部修改 → cb(record)
  const before = fs.statSync(ctx.fileOf('s')).mtimeMs
  await B.save(record('s', [
    msg(USER, T(1), 'u1'),
    msg(ASSISTANT, T(2), 'a1'),
    msg(USER, T(3), 'u2'),
    msg(ASSISTANT, T(4), 'a2')
  ]))
  ensureMtimeAdvanced(ctx.fileOf('s'), before)
  await waitFor(() => events.length === 1)
  assert.ok(events[0])
  assert.equal(events[0].messages.length, 4)

  // 采纳后基线已更新：同一变更的后续事件不重复触发
  await sleep(300)
  assert.equal(events.length, 1)

  // 对端删除 → cb(null)，不抛错
  fs.unlinkSync(ctx.fileOf('s'))
  await waitFor(() => events.length === 2)
  assert.equal(events[1], null)

  // unwatch 后零事件
  A.unwatch('s')
  await B.save(record('s', [msg(USER, T(1), 'u1')]))
  await sleep(400)
  assert.equal(events.length, 2)
})
