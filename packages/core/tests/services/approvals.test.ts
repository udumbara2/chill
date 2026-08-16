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
