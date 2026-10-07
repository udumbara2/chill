/**
 * commandSurfaceCd.test.ts — C+D 手机端命令面扩展行为测试
 * 覆盖：task.detail（活动/非活动/截断/未知/降级/缺参）、improve.confirmed（双 zone 投影）、
 * improve.confirmed.decide（四向流转矩阵 + 幂等 + 非法参数）。
 * 账本隔离：improvementLedger 单例 init 到 os.tmpdir 临时目录（独立进程，不碰真实账本）。
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeCommand, COMMAND_REGISTRY, resolveCommand } from '../../src/services/commands/commandSurface.ts'
import { improvementLedger } from '../../src/services/improvementLedger.ts'
import { parseProposals } from '../../src/services/ImprovementProposalManager.ts'
import { MessageRole, type Message } from '../../src/types/models.ts'

// ---------- 临时账本装配 ----------

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cd-cmd-test-'))
const ledgerPath = path.join(tmpDir, 'improvement-proposals.md')

const fsProvider = {
  readFile: async (p: string) => {
    try {
      return { success: true, data: { content: await fsp.readFile(p, 'utf8') } }
    } catch {
      return { success: false, error: 'ENOENT' }
    }
  },
  writeFile: async (p: string, c: string) => {
    await fsp.writeFile(p, c, 'utf8')
    return { success: true }
  },
  renameFile: async (a: string, b: string) => {
    await fsp.rename(a, b)
    return { success: true }
  },
  statFile: async (p: string) => {
    try {
      const st = await fsp.stat(p)
      return { success: true, data: { mtimeMs: st.mtimeMs, size: st.size } }
    } catch {
      return { success: false }
    }
  },
}

const SEED = `# 改进候选

## 待确认
- [2026-10-01] **功能**：待审条目A
  **组**：测试组

## 已确认
- [2026-09-01] **功能**：已确认甲
  **组**：G1
- [2026-09-05] **功能**：已确认乙
  **组**：G2

## 已实现
（暂无）

## 已关闭
- [2026-08-01] **功能**：已关闭丙
  **组**：G3
`

async function seedLedger(): Promise<void> {
  await fsp.writeFile(ledgerPath, SEED, 'utf8')
}

async function readZones(): Promise<{ confirmed: string[]; discarded: string[]; closed: string[]; pending: string[] }> {
  const parsed = parseProposals(await fsp.readFile(ledgerPath, 'utf8'))
  return {
    confirmed: parsed.confirmed.map((e) => e.title),
    discarded: parsed.discarded.map((e) => e.title),
    closed: parsed.closed.map((e) => e.title),
    pending: parsed.pending.map((e) => e.title),
  }
}

before(async () => {
  improvementLedger.init(fsProvider as never, { getUserDataPath: () => tmpDir } as never)
  await seedLedger()
})

// ---------- 注册表属性 ----------

test('C+D 三命令注册属性：fast / internal / managedOnly，decide 带 confirm 风险级', () => {
  const ids = ['task.detail', 'improve.confirmed', 'improve.confirmed.decide']
  assert.equal(COMMAND_REGISTRY.filter((c) => ids.includes(c.id)).length, 3, '三条都在注册表')
  for (const id of ids) {
    const spec = resolveCommand(id)!
    assert.equal(spec.channel, 'fast', `${id} 应为 fast`)
    assert.equal(spec.internal, true, `${id} 应 internal（不进目录）`)
    assert.equal(spec.managedOnly, true, `${id} 应 managedOnly`)
  }
  assert.equal(resolveCommand('improve.confirmed.decide')!.risk, 'confirm')
})

// ---------- task.detail ----------

function toolMsg(toolCallId: string, content: string, status = 'success'): Message {
  return {
    role: MessageRole.TOOL,
    content,
    toolCallId,
    toolCallStatus: status as Message['toolCallStatus'],
    timestamp: new Date(),
  } as Message
}

test('task.detail 活动会话：engine 内存直读 + {content} JSON 解包', async () => {
  const engine = {
    getSessionState: () => ({ sessionId: 's1', isRunning: false }),
    getHistory: () => [toolMsg('other', 'x'), toolMsg('tc-1', JSON.stringify({ content: '交付物全文 ABC' }))],
  }
  const r = await executeCommand({ engine: engine as never }, 'task.detail', { sessionId: 's1', taskId: 'tc-1' })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal((r.data as { deliverable: string }).deliverable, '交付物全文 ABC')
    assert.equal((r.data as { truncated: boolean }).truncated, false)
    assert.equal((r.data as { status: string | null }).status, 'success')
  }
})

test('task.detail 非活动会话：sessions.readMessages 通道', async () => {
  const sessions = {
    readMessages: async () => [toolMsg('tc-9', JSON.stringify({ content: '非活动会话交付物' }))],
    patchTitle: async () => ({ success: true }),
    delete: async () => ({ success: true }),
  }
  const r = await executeCommand({ sessions: sessions as never }, 'task.detail', { sessionId: 's2', taskId: 'tc-9' })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal((r.data as { deliverable: string }).deliverable, '非活动会话交付物')
})

test('task.detail 截断：超 24KB 输入 → truncated=true 且应答 < 45KB 预算', async () => {
  const big = '长'.repeat(30 * 1024) // 90KB 字节
  const sessions = { readMessages: async () => [toolMsg('tc-big', JSON.stringify({ content: big }))] }
  const r = await executeCommand({ sessions: sessions as never }, 'task.detail', { sessionId: 's', taskId: 'tc-big' })
  assert.equal(r.ok, true)
  if (r.ok) {
    const d = r.data as { deliverable: string; truncated: boolean }
    assert.equal(d.truncated, true)
    assert.ok(d.deliverable.includes('已截断'), '截断标注在场')
    assert.ok(new TextEncoder().encode(JSON.stringify(r.data)).length < 45 * 1024, '应答整体 < 45KB')
  }
})

test('task.detail 未知 taskId → guard 诚实错误', async () => {
  const sessions = { readMessages: async () => [toolMsg('tc-1', 'x')] }
  const r = await executeCommand({ sessions: sessions as never }, 'task.detail', { sessionId: 's', taskId: 'nope' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, 'guard')
})

test('task.detail 通道未装配 → unsupported 降级', async () => {
  const r = await executeCommand({}, 'task.detail', { sessionId: 's', taskId: 'tc' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, 'unsupported')
})

test('task.detail 缺参 → invalid_args', async () => {
  const r = await executeCommand({}, 'task.detail', { sessionId: 's' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, 'invalid_args')
})

// ---------- improve.confirmed（读） ----------

test('improve.confirmed 默认 zone=confirmed：倒序 + total 正确', async () => {
  await seedLedger()
  const r = await executeCommand({}, 'improve.confirmed', {})
  assert.equal(r.ok, true)
  if (r.ok) {
    const d = r.data as { zone: string; total: number; entries: Array<{ title: string; date: string }> }
    assert.equal(d.zone, 'confirmed')
    assert.equal(d.total, 2)
    assert.deepEqual(d.entries.map((e) => e.title), ['已确认乙', '已确认甲'], '按日期倒序')
  }
})

test('improve.confirmed zone=closed → 已关闭区（parsed.discarded，命名暗坑防错）', async () => {
  const r = await executeCommand({}, 'improve.confirmed', { zone: 'closed' })
  assert.equal(r.ok, true)
  if (r.ok) {
    const d = r.data as { total: number; entries: Array<{ title: string }> }
    assert.equal(d.total, 1)
    assert.equal(d.entries[0].title, '已关闭丙')
  }
})

// ---------- improve.confirmed.decide（四向流转矩阵） ----------

test('decide close：已确认 → 已关闭归档', async () => {
  await seedLedger()
  const r = await executeCommand({}, 'improve.confirmed.decide', { titles: ['已确认甲'], action: 'close' })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal((r.data as { applied: number }).applied, 1)
  const z = await readZones()
  assert.deepEqual(z.confirmed, ['已确认乙'])
  assert.ok(z.discarded.includes('已确认甲'))
})

test('decide implement：已确认 → 已实现（手工结账）', async () => {
  await seedLedger()
  const r = await executeCommand({}, 'improve.confirmed.decide', { titles: ['已确认乙'], action: 'implement' })
  assert.equal(r.ok, true)
  const z = await readZones()
  assert.deepEqual(z.confirmed, ['已确认甲'])
  assert.deepEqual(z.closed, ['已确认乙'])
})

test('decide requeue：已确认 → 待确认重审', async () => {
  await seedLedger()
  const r = await executeCommand({}, 'improve.confirmed.decide', { titles: ['已确认甲'], action: 'requeue' })
  assert.equal(r.ok, true)
  const z = await readZones()
  assert.deepEqual(z.confirmed, ['已确认乙'])
  assert.deepEqual(z.pending, ['待审条目A', '已确认甲'])
})

test('decide reopen：已关闭 → 已确认（误关恢复）', async () => {
  await seedLedger()
  const r = await executeCommand({}, 'improve.confirmed.decide', { titles: ['已关闭丙'], action: 'reopen' })
  assert.equal(r.ok, true)
  const z = await readZones()
  assert.deepEqual(z.discarded, [])
  assert.deepEqual([...z.confirmed].sort(), ['已确认甲', '已确认乙', '已关闭丙'].sort(), 'reopen 追加恢复，原有甲乙保留')
})

test('decide 未命中 title → applied=0 幂等且账本不变', async () => {
  await seedLedger()
  const r = await executeCommand({}, 'improve.confirmed.decide', { titles: ['不存在的条目'], action: 'close' })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal((r.data as { applied: number }).applied, 0)
  const z = await readZones()
  assert.equal(z.confirmed.length, 2)
  assert.equal(z.discarded.length, 1)
})

test('decide 非法 action / 空 titles → invalid_args', async () => {
  const r1 = await executeCommand({}, 'improve.confirmed.decide', { titles: ['x'], action: 'delete' })
  assert.equal(r1.ok, false)
  if (!r1.ok) assert.equal(r1.error.code, 'invalid_args')
  const r2 = await executeCommand({}, 'improve.confirmed.decide', { titles: [], action: 'close' })
  assert.equal(r2.ok, false)
})

test('decide 跨区非法流转（对已实现区条目 close）→ 未命中幂等', async () => {
  await seedLedger()
  await executeCommand({}, 'improve.confirmed.decide', { titles: ['已确认甲'], action: 'implement' })
  const r = await executeCommand({}, 'improve.confirmed.decide', { titles: ['已确认甲'], action: 'close' })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal((r.data as { applied: number }).applied, 0, '已实现区条目不再命中 close')
  const z = await readZones()
  assert.deepEqual(z.closed, ['已确认甲'], '条目留在已实现区')
})
