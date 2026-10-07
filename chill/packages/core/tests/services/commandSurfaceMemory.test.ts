/**
 * commandSurfaceMemory.test.ts — 记忆库管理命令族（memory / memory.list / memory.show /
 * memory.delete / memory.seen）行为测试。
 * 覆盖：list 投影（new 判定单源 + updated_at 降序 + newCount 汇总）、show 单条与大小写不敏感、
 * delete 成功/未找到、seen 水位写入、缺端口诚实 unsupported、buildCommandState memoryNewCount
 * 条件装配（undefined=未装配 ≠ 0）、目录下发规格（memory 行非 managedOnly 下发、四 internal 不下发）。
 * 单一事实点在 memoryStore（水位/newCount）+ commandSurface（命令面）——本套件经命令面验证整链。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeCommand, buildCommandState, commandCatalog, type MemoryCommandPort, type MemoryCommandEntry } from '../../src/services/commands/commandSurface.ts'

// ==================== fakes ====================

function makeEntry(over: Partial<MemoryCommandEntry> & { name: string }): MemoryCommandEntry {
  return {
    type: 'user', hook: '示例钩子', body: '正文内容', importance: 5,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    last_used_at: '2026-10-01T00:00:00.000Z', usage_count: 0,
    ...over,
  }
}

function makeMemoryPort(entries: MemoryCommandEntry[], seenAt: string | null) {
  const state = { seenAt, removed: [] as string[], seenWrites: [] as string[] }
  const port: MemoryCommandPort = {
    list: async () => entries,
    readSeenAt: async () => state.seenAt,
    writeSeenAt: async (ts) => { state.seenWrites.push(ts); state.seenAt = ts },
    isNewerEntry: (e, s) => s === null || e.updated_at > s,
    remove: async (title) => {
      const t = entries.find(e => e.name.toLowerCase() === title.toLowerCase())
      if (!t) return { success: false, error: `未找到记忆: ${title}` }
      state.removed.push(t.name)
      entries.splice(entries.indexOf(t), 1)
      return { success: true }
    },
  }
  return { port, state }
}

// ==================== memory.list ====================

test('memory.list：new 判定单源 + updated_at 降序 + newCount 汇总', async () => {
  const { port } = makeMemoryPort(
    [
      makeEntry({ name: '旧记忆', updated_at: '2026-10-01T00:00:00.000Z' }),
      makeEntry({ name: '新记忆A', updated_at: '2026-10-05T00:00:00.000Z' }),
      makeEntry({ name: '新记忆B', updated_at: '2026-10-06T00:00:00.000Z' }),
    ],
    '2026-10-04T00:00:00.000Z',
  )
  const r = await executeCommand({ memoryStore: port }, 'memory.list', {})
  assert.ok(r.ok)
  const data = (r as { data?: { items?: Array<{ name: string; new: boolean }>; total: number; newCount: number } }).data!
  assert.equal(data.total, 3)
  assert.equal(data.newCount, 2, '水位后 2 条为 new')
  assert.deepEqual(data.items!.map(i => i.name), ['新记忆B', '新记忆A', '旧记忆'], 'updated_at 降序')
  assert.deepEqual(data.items!.map(i => i.new), [true, true, false])
  assert.ok(!('body' in (data.items![0] as object)), '投影不含 body（预算瘦身）')
})

test('memory.list：无水位（从未巡检）全部视为新', async () => {
  const { port } = makeMemoryPort([makeEntry({ name: 'x' })], null)
  const r = await executeCommand({ memoryStore: port }, 'memory.list', {})
  assert.ok(r.ok)
  assert.equal((r as { data?: { newCount: number } }).data!.newCount, 1)
})

// ==================== memory.show / memory.delete ====================

test('memory.show：标题大小写不敏感 + 全文返回', async () => {
  const { port } = makeMemoryPort([makeEntry({ name: '搜索偏好', body: '全文正文' })], null)
  const r = await executeCommand({ memoryStore: port }, 'memory.show', { title: '搜索偏好' })
  assert.ok(r.ok)
  const entry = (r as { data?: { entry?: { body: string } } }).data!.entry!
  assert.equal(entry.body, '全文正文', 'show 返回 body 全文')
})

test('memory.show：validateArgs 拦截缺标题', async () => {
  const r = await executeCommand({ memoryStore: makeMemoryPort([], null).port }, 'memory.show', {})
  assert.ok(!r.ok)
  assert.equal((r as { error: { code: string } }).error.code, 'invalid_args')
})

test('memory.delete：删除成功回流标题；未找到诚实失败', async () => {
  const { port, state } = makeMemoryPort([makeEntry({ name: '待删' })], null)
  const ok = await executeCommand({ memoryStore: port }, 'memory.delete', { title: '待删' })
  assert.ok(ok.ok)
  assert.deepEqual(state.removed, ['待删'])
  const miss = await executeCommand({ memoryStore: port }, 'memory.delete', { title: '不存在' })
  assert.ok(!miss.ok)
})

// ==================== memory.seen ====================

test('memory.seen：水位写入（打开面板即归零语义）', async () => {
  const { port, state } = makeMemoryPort([], null)
  const r = await executeCommand({ memoryStore: port }, 'memory.seen', {})
  assert.ok(r.ok)
  assert.equal(state.seenWrites.length, 1)
})

// ==================== 缺端口诚实 unsupported ====================

test('memory.*：缺 memoryStore 端口诚实 unsupported', async () => {
  for (const cmd of ['memory.list', 'memory.show', 'memory.delete', 'memory.seen']) {
    const r = await executeCommand({}, cmd, cmd === 'memory.show' || cmd === 'memory.delete' ? { title: 'x' } : {})
    assert.ok(!r.ok, cmd + ' 无端口应失败')
    assert.equal((r as { error: { code: string } }).error.code, 'unsupported')
  }
})

// ==================== buildCommandState memoryNewCount ====================

test('buildCommandState：memory 读口装配→memoryNewCount；未装配→字段缺省（≠0）', () => {
  const engine = { getSessionState: () => ({ sessionId: 's1', planMode: false, isRunning: false }), getContextStatus: () => null }
  const withPort = buildCommandState({ engine, memory: { getNewCount: () => 3 } }) as Record<string, unknown>
  assert.equal(withPort['memoryNewCount'], 3)
  const noPort = buildCommandState({ engine }) as Record<string, unknown>
  assert.ok(!('memoryNewCount' in noPort), '未装配=字段缺省（诚实未知，≠0）')
})

// ==================== 目录下发规格 ====================

test('目录下发：memory 行在册；四 internal 命令不下发', () => {
  const catalog = commandCatalog()
  assert.ok(catalog.some(c => c.id === 'memory'), 'memory 目录行在册（npm 模式同样有记忆，非 managedOnly）')
  for (const id of ['memory.list', 'memory.show', 'memory.delete', 'memory.seen']) {
    assert.ok(!catalog.some(c => c.id === id), id + ' 是 internal 不应下发目录')
  }
})
