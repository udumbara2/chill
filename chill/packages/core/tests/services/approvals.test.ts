import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ApprovalChannel,
  getApprovalChannel,
  resetApprovalChannel,
  type ApprovalRequestPayload,
  type ApprovalResolution,
} from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'

function payload(overrides: Partial<ApprovalRequestPayload>): ApprovalRequestPayload {
  return {
    toolCallId: 'tc-1',
    kind: 'write',
    origin: { source: 'main' },
    ...overrides,
  }
}

/** 监听一个事件一次（返回捕获的载荷），用后自动摘除 */
function once<T = any>(event: string): { fired: () => T[] } {
  const captured: T[] = []
  const listener = (data: T) => captured.push(data)
  eventBus.on(event, listener)
  return {
    fired: () => {
      eventBus.off(event, listener)
      return captured
    },
  }
}

test('审批通道: 发起请求发 APPROVAL_REQUESTED，批准后 resolve', async () => {
  const ch = new ApprovalChannel()
  const requested = once(EVENTS.APPROVAL_REQUESTED)

  const p = ch.request(
    payload({ kind: 'write', path: 'D:\\out\\a.txt', diffPreview: '+ hello', origin: { source: 'subagent', subagentType: 'document-writer', taskId: 'task-1' } }),
  )
  const events = requested.fired()
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'write')
  assert.equal(events[0].path, 'D:\\out\\a.txt')
  assert.equal(events[0].diffPreview, '+ hello')
  assert.equal(events[0].origin.source, 'subagent')
  assert.equal(events[0].origin.subagentType, 'document-writer')

  assert.equal(ch.resolve('tc-1', { approved: true }), true)
  const resolution = await p
  assert.equal(resolution.approved, true)
})

test('审批通道: 拒绝（含原因）与 [d] 选项（addDir 携带目录）', async () => {
  const ch = new ApprovalChannel()

  const p1 = ch.request(payload({ toolCallId: 'tc-n' }))
  ch.resolve('tc-n', { approved: false, reason: '不允许写桌面' })
  const r1 = await p1
  assert.equal(r1.approved, false)
  assert.equal(r1.reason, '不允许写桌面')

  const p2 = ch.request(payload({ toolCallId: 'tc-d', path: 'D:\\out\\a.txt' }))
  ch.resolve('tc-d', { approved: true, addDir: 'D:\\out' })
  const r2 = await p2
  assert.equal(r2.approved, true)
  assert.equal(r2.addDir, 'D:\\out')

  // 无此挂起返回 false
  assert.equal(ch.resolve('tc-none', { approved: true }), false)
})

test('审批通道: 并发请求按到达顺序逐个呈现（listPending = 插入序）', async () => {
  const ch = new ApprovalChannel()
  const p1 = ch.request(payload({ toolCallId: 'tc-1' }))
  const p2 = ch.request(payload({ toolCallId: 'tc-2' }))
  const p3 = ch.request(payload({ toolCallId: 'tc-3' }))

  assert.deepEqual(
    ch.listPending().map((x) => x.toolCallId),
    ['tc-1', 'tc-2', 'tc-3'],
  )

  ch.resolve('tc-2', { approved: true })
  assert.deepEqual(
    ch.listPending().map((x) => x.toolCallId),
    ['tc-1', 'tc-3'],
  )
  ch.resolve('tc-1', { approved: true })
  ch.resolve('tc-3', { approved: false })
  await Promise.all([p1, p2, p3])
  assert.deepEqual(ch.listPending(), [])
})

test('审批通道: 按任务 reject 挂起审批（cancel_task 预留），只影响该任务', async () => {
  const ch = new ApprovalChannel()
  const p1 = ch.request(payload({ toolCallId: 'tc-a', origin: { source: 'subagent', taskId: 'task-1' } }))
  const p2 = ch.request(payload({ toolCallId: 'tc-b', origin: { source: 'subagent', taskId: 'task-2' } }))

  const count = ch.rejectApprovalsForTask('task-1', '任务已取消')
  assert.equal(count, 1)

  const r1 = await p1
  assert.equal(r1.approved, false)
  assert.equal(r1.reason, '任务已取消')

  // 另一个任务的挂起不受影响
  assert.deepEqual(
    ch.listPending().map((x) => x.toolCallId),
    ['tc-b'],
  )
  ch.resolve('tc-b', { approved: true })
  await p2
})

test('审批通道: APPROVAL_RESOLVED 事件路径同样落定（单例，与生产一致）', async (t) => {
  resetApprovalChannel()
  t.after(() => resetApprovalChannel())
  const ch = getApprovalChannel()
  const p = ch.request(payload({ toolCallId: 'tc-ev' }))

  eventBus.emit(EVENTS.APPROVAL_RESOLVED, { toolCallId: 'tc-ev', approved: true } as { toolCallId: string } & ApprovalResolution)
  const r = await p
  assert.equal(r.approved, true)
})

test('审批通道: 命令类请求经 APPROVAL_RESOLVED 落定（可携带改过的命令与工作目录）', async (t) => {
  resetApprovalChannel()
  t.after(() => resetApprovalChannel())
  const ch = getApprovalChannel()

  const p = ch.request(
    payload({
      toolCallId: 'tc-cmd',
      kind: 'command',
      command: 'echo hi',
      purpose: '测试',
      intent: '验证',
      workingDirectory: 'C:\\proj',
    }),
  )

  // 壳侧回答事件可携带改过的命令与工作目录(旧 PowerShell 确认流语义在新通道延续)
  eventBus.emit(EVENTS.APPROVAL_RESOLVED, { toolCallId: 'tc-cmd', approved: true, command: 'echo edited', workingDirectory: 'C:\\proj' } as { toolCallId: string } & ApprovalResolution)
  const r = await p
  assert.equal(r.approved, true)
  assert.equal(r.command, 'echo edited')
  assert.equal(r.workingDirectory, 'C:\\proj')
})


// ---------- M4：落定通告（APPROVAL_SETTLED）与 timeoutAt ----------

test('审批通道(M4): resolve 落定发 APPROVAL_SETTLED（by 默认 local；显式 phone）', async () => {
  const ch = new ApprovalChannel()
  const settled = once(EVENTS.APPROVAL_SETTLED)

  const p1 = ch.request(payload({ toolCallId: 'tc-s1' }))
  ch.resolve('tc-s1', { approved: true })
  await p1

  const p2 = ch.request(payload({ toolCallId: 'tc-s2' }))
  ch.resolve('tc-s2', { approved: false, reason: '手机端拒绝' }, 'phone')
  await p2

  const events = settled.fired()
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { toolCallId: 'tc-s1', approved: true, by: 'local' })
  assert.deepEqual(events[1], { toolCallId: 'tc-s2', approved: false, by: 'phone', reason: '手机端拒绝' })
})

test('审批通道(M4): 二次 resolve 返 false 且 APPROVAL_SETTLED 只发一次（幂等落定）', async () => {
  const ch = new ApprovalChannel()
  const settled = once(EVENTS.APPROVAL_SETTLED)

  const p = ch.request(payload({ toolCallId: 'tc-idem' }))
  assert.equal(ch.resolve('tc-idem', { approved: true }), true)
  assert.equal(ch.resolve('tc-idem', { approved: false }), false)
  await p

  const events = settled.fired()
  assert.equal(events.length, 1)
  assert.equal(events[0].by, 'local')
})

test('审批通道(M4): mobile 起源 payload 附带 timeoutAt（源头绝对死线）；非 mobile 不带', async () => {
  const ch = new ApprovalChannel()
  const requested = once(EVENTS.APPROVAL_REQUESTED)

  const before = Date.now()
  const p1 = ch.request(payload({ toolCallId: 'tc-m', origin: { source: 'mobile' } }), { timeoutMs: 60_000 })
  const p2 = ch.request(payload({ toolCallId: 'tc-desk', origin: { source: 'main' } }))

  const events = requested.fired()
  assert.equal(events.length, 2)
  const m = events.find((e) => e.toolCallId === 'tc-m')!
  const d = events.find((e) => e.toolCallId === 'tc-desk')!
  assert.ok(m.timeoutAt >= before + 60_000 && m.timeoutAt <= Date.now() + 60_000)
  assert.equal(d.timeoutAt, undefined)
  // listPending 携带同一份 effectivePayload
  assert.equal(ch.listPending().find((x) => x.toolCallId === 'tc-m')!.timeoutAt, m.timeoutAt)

  ch.resolve('tc-m', { approved: true })
  ch.resolve('tc-desk', { approved: true })
  await Promise.all([p1, p2])
})

test('审批通道(M4): mobile 超时路径发 APPROVAL_SETTLED by=timeout', async () => {
  const ch = new ApprovalChannel()
  const settled = once(EVENTS.APPROVAL_SETTLED)

  const p = ch.request(payload({ toolCallId: 'tc-to', origin: { source: 'mobile' } }), { timeoutMs: 30 })
  const r = await p
  assert.equal(r.approved, false)
  assert.equal(r.reason, '审批超时已拒绝')

  const events = settled.fired()
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { toolCallId: 'tc-to', approved: false, by: 'timeout', reason: '审批超时已拒绝' })
})

test('审批通道(M4): rejectApprovalsForTask 发 APPROVAL_SETTLED by=cancelled', async () => {
  const ch = new ApprovalChannel()
  const settled = once(EVENTS.APPROVAL_SETTLED)

  const p1 = ch.request(payload({ toolCallId: 'tc-c1', origin: { source: 'subagent', taskId: 'task-x' } }))
  const p2 = ch.request(payload({ toolCallId: 'tc-c2', origin: { source: 'subagent', taskId: 'task-y' } }))

  ch.rejectApprovalsForTask('task-x')
  await p1

  const events = settled.fired()
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { toolCallId: 'tc-c1', approved: false, by: 'cancelled', reason: '任务已取消' })

  ch.resolve('tc-c2', { approved: true })
  await p2
})

// ---------- 近期落定环（终态愈合重放的数据源） ----------

test('审批通道: 近期落定环——三条落定路径（resolve/超时/批量拒绝）均记录且字段完整', async () => {
  const ch = new ApprovalChannel()
  const p1 = ch.request(payload({ toolCallId: 'tc-r1', path: 'D:\a.txt' }))
  ch.resolve('tc-r1', { approved: true }, 'phone')
  await p1
  const p2 = ch.request(payload({ toolCallId: 'tc-r2', origin: { source: 'mobile' } }), { timeoutMs: 30 })
  await p2 // 超时自动拒绝
  const p3 = ch.request(payload({ toolCallId: 'tc-r3', origin: { source: 'subagent', taskId: 'task-z' } }))
  ch.rejectApprovalsForTask('task-z')
  await p3

  const ring = ch.listRecentSettled()
  assert.equal(ring.length, 3)
  assert.deepEqual(
    ring.map((r) => [r.payload.toolCallId, r.approved, r.by]),
    [
      ['tc-r1', true, 'phone'],
      ['tc-r2', false, 'timeout'],
      ['tc-r3', false, 'cancelled'],
    ],
  )
  assert.equal(ring[0].payload.path, 'D:\a.txt') // 请求载荷随环携带（重放建卡用）
  assert.equal(ring[1].reason, '审批超时已拒绝')
  assert.ok(ring.every((r) => typeof r.settledAt === 'number'))
})

test('审批通道: 落定环 cap 200（超出挤掉最旧）', async () => {
  const ch = new ApprovalChannel()
  for (let i = 0; i < 205; i++) {
    const p = ch.request(payload({ toolCallId: `tc-cap-${i}` }))
    ch.resolve(`tc-cap-${i}`, { approved: true })
    await p
  }
  const ring = ch.listRecentSettled()
  assert.equal(ring.length, 200)
  assert.equal(ring[0].payload.toolCallId, 'tc-cap-5')
})

test('审批通道: 落定环 TTL 惰性剔除超龄条目', async () => {
  const ch = new ApprovalChannel()
  const realNow = Date.now
  let fake = realNow()
  Date.now = () => fake
  try {
    const p = ch.request(payload({ toolCallId: 'tc-old' }))
    ch.resolve('tc-old', { approved: true })
    await p
    assert.equal(ch.listRecentSettled().length, 1)
    fake += 31 * 60 * 1000 // 31 分钟后（超 30min 留存窗）
    assert.equal(ch.listRecentSettled().length, 0)
  } finally {
    Date.now = realNow
  }
})
