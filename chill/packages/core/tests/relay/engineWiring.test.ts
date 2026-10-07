import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createEngineEnqueue,
  wireApprovalChannel,
  makeResolveApproval,
  makeListPendingApprovals,
  makeListRecentSettledApprovals,
  makeListRecentSettledAsks,
  wireToolStatus,
  wireBeatBoundary,
  wirePermissionMode,
  wireTurnStream,
  wireHistoryInvalidated,
  wireActiveSession,
  wireSessionCatalogWatch,
  makeEnsureActiveSession,
  makeEnsureNewSession,
  makeSessionSyncBridgeDeps,
} from '../../src/services/relayEngineWiring.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import { getApprovalChannel, resetApprovalChannel } from '../../src/services/approvals.ts'
import { getAskChannel, resetAskChannel } from '../../src/services/askChannel.ts'
import { ToolCallStatus } from '../../src/types/models.ts'
import type { RelayBridge } from '../../src/services/relay/RelayBridge.ts'

/** 记录型假桥（只实现 wiring 用到的公开方法；M6：pushToolEvent 首参=会话归属） */
function fakeBridge() {
  const calls: { method: string; args: unknown[] }[] = []
  const bridge = {
    pushReasoning: (text: string) => calls.push({ method: 'pushReasoning', args: [text] }),
    pushStreamChunk: (chunk: unknown) => calls.push({ method: 'pushStreamChunk', args: [chunk] }),
    pushToolEvent: (sessionId: string | null, text: string, toolCallId: string, detail?: unknown) =>
      calls.push({ method: 'pushToolEvent', args: [sessionId, text, toolCallId, detail] }),
    advanceBeat: () => calls.push({ method: 'advanceBeat', args: [] }),
    pushApprovalRequest: (p: unknown) => calls.push({ method: 'pushApprovalRequest', args: [p] }),
    pushApprovalResolved: (s: unknown) => calls.push({ method: 'pushApprovalResolved', args: [s] }),
    pushModeState: (m: string) => calls.push({ method: 'pushModeState', args: [m] }),
    pushSessionEvent: (body: unknown) => calls.push({ method: 'pushSessionEvent', args: [body] }),
  } as unknown as RelayBridge
  return { bridge, calls }
}

/** 假引擎：enqueueExternalMessage 回放指定 chunk 序列（M6：流式镜像走被动广播，本路径只交付终态） */
function fakeEngine(chunks: { content?: string; reasoningContent?: string }[], result: { content: string; aborted: boolean; deniedReason?: string }) {
  return {
    enqueueExternalMessage: async (_input: unknown, _callbacks?: { streamCallback?: (c: unknown) => void; onIngested?: () => void | Promise<void> }) => {
      for (const c of chunks) _callbacks?.streamCallback?.(c)
      return result
    },
  } as never
}

test('engineWiring: createEngineEnqueue 只交付轮次终态（M6：流式镜像走 TURN_STREAM_CHUNK 被动广播，不经 per-turn 回调双源直推）', async () => {
  const { bridge, calls } = fakeBridge()
  const engine = fakeEngine(
    [
      { reasoningContent: '想一' },
      { content: '答' },
      { content: '案' },
    ],
    { content: '答案', aborted: false },
  )
  const enqueue = createEngineEnqueue(engine as never)
  const deltas: string[] = []
  const r = await enqueue({ text: '问' }, { onDelta: (d) => deltas.push(d) })

  assert.equal(r.content, '答案')
  assert.deepEqual(deltas, []) // onDelta 不再被喂（防与广播重复）
  assert.deepEqual(calls, []) // 桥不经本路径收到任何推送
  void bridge
})

test('engineWiring: deniedReason 透传（hook deny 回执链）', async () => {
  const engine = fakeEngine([], { content: '', aborted: false, deniedReason: '含敏感指令' })
  const enqueue = createEngineEnqueue(engine as never)
  const r = await enqueue('危险', () => {})
  assert.equal(r.deniedReason, '含敏感指令')
})

test('engineWiring: wireApprovalChannel 事件→桥方法转发；退订后不再转发', async () => {
  const { bridge, calls } = fakeBridge()
  const off = wireApprovalChannel(bridge)

  eventBus.emit(EVENTS.APPROVAL_REQUESTED, { toolCallId: 'tc-1', kind: 'write', origin: { source: 'main' } })
  eventBus.emit(EVENTS.APPROVAL_SETTLED, { toolCallId: 'tc-1', approved: true, by: 'phone' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'pushApprovalRequest')
  assert.equal(calls[1].method, 'pushApprovalResolved')
  assert.deepEqual(calls[1].args[0], { toolCallId: 'tc-1', approved: true, by: 'phone' })

  off()
  eventBus.emit(EVENTS.APPROVAL_REQUESTED, { toolCallId: 'tc-2', kind: 'write', origin: { source: 'main' } })
  assert.equal(calls.length, 2) // 退订生效
})

test('engineWiring: makeResolveApproval 转发 ApprovalChannel 且 by=phone；decision 映射', async (t) => {
  resetApprovalChannel()
  t.after(() => resetApprovalChannel())
  const ch = getApprovalChannel()
  const settled: unknown[] = []
  const listener = (s: unknown) => settled.push(s)
  eventBus.on(EVENTS.APPROVAL_SETTLED, listener)
  t.after(() => eventBus.off(EVENTS.APPROVAL_SETTLED, listener))

  const resolve = makeResolveApproval()
  const p = ch.request({ toolCallId: 'tc-w1', kind: 'write', origin: { source: 'mobile' } }, { timeoutMs: 5000 })

  assert.equal(resolve('tc-w1', 'approve'), true)
  const r = await p
  assert.equal(r.approved, true)
  assert.deepEqual(settled[0], { toolCallId: 'tc-w1', approved: true, by: 'phone' })

  // 已定落后返回 false
  assert.equal(resolve('tc-w1', 'reject'), false)

  // reject 的 reason 映射
  const p2 = ch.request({ toolCallId: 'tc-w2', kind: 'write', origin: { source: 'mobile' } }, { timeoutMs: 5000 })
  resolve('tc-w2', 'reject')
  const r2 = await p2
  assert.equal(r2.approved, false)
  assert.equal(r2.reason, '手机端拒绝')

  // allowSession（手机「本次会话放行」第三钮）：opts → resolution.allowSession（与 CLI [s]/桌面 UI 同源字段）
  const p3 = ch.request({ toolCallId: 'tc-w3', kind: 'command', command: '点击', sessionGrantable: true, origin: { source: 'mobile' } }, { timeoutMs: 5000 })
  resolve('tc-w3', 'approve', { allowSession: true })
  const r3 = await p3
  assert.equal(r3.approved, true)
  assert.equal(r3.allowSession, true)
})

test('engineWiring: makeListPendingApprovals 转发 ApprovalChannel.listPending', async (t) => {
  resetApprovalChannel()
  t.after(() => resetApprovalChannel())
  const ch = getApprovalChannel()
  const list = makeListPendingApprovals()
  assert.deepEqual(list(), [])
  const p = ch.request({ toolCallId: 'tc-lp', kind: 'command', command: 'ls', origin: { source: 'main' } })
  assert.deepEqual(list().map((x) => x.toolCallId), ['tc-lp'])
  ch.resolve('tc-lp', { approved: true })
  await p
})

test('engineWiring: makeListRecentSettledApprovals/Asks 转发两个 channel 的近期落定环', async (t) => {
  resetApprovalChannel()
  resetAskChannel()
  t.after(() => {
    resetApprovalChannel()
    resetAskChannel()
  })
  const ch = getApprovalChannel()
  const p = ch.request({ toolCallId: 'tc-rs', kind: 'write', path: 'C:\\x.txt', origin: { source: 'main' } })
  ch.resolve('tc-rs', { approved: true }, 'phone')
  await p
  const settledApprovals = makeListRecentSettledApprovals()()
  assert.equal(settledApprovals.length, 1)
  assert.equal(settledApprovals[0].payload.toolCallId, 'tc-rs')
  assert.equal(settledApprovals[0].approved, true)
  assert.equal(settledApprovals[0].by, 'phone')

  const ach = getAskChannel()
  const q = ach.ask('问题')
  ach.resolve(ach.listPending()[0].id, '答', 'local')
  await q
  const settledAsks = makeListRecentSettledAsks()()
  assert.equal(settledAsks.length, 1)
  assert.equal(settledAsks[0].payload.question, '问题')
  assert.equal(settledAsks[0].answer, '答')
})

test('engineWiring: wireToolStatus 状态映射+detail 结构化（RUNNING/SUCCESS/FAILED/REJECTED）；sessionId 透传为首参；无名无锚跳过；退订生效', async () => {
  const { bridge, calls } = fakeBridge()
  const off = wireToolStatus(bridge)

  const emit = (status: ToolCallStatus, name?: string, extra?: Record<string, unknown>) =>
    eventBus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, {
      sessionId: 's-t',
      toolCallStatus: status,
      toolCall: name ? { function: { name } } : undefined,
      ...(name ? { toolCallId: `id-${name}` } : {}),
      ...extra,
    })

  emit(ToolCallStatus.RUNNING, 'Write', { toolParameters: { path: 'C:\\a.txt' } })
  emit(ToolCallStatus.SUCCESS, 'Write', { toolParameters: { path: 'C:\\a.txt' }, toolResult: { content: '写入完成' } })
  emit(ToolCallStatus.FAILED, 'Bash', { toolParameters: { command: 'rm -rf /' } })
  emit(ToolCallStatus.REJECTED, 'Edit', { toolParameters: { path: 'C:\\b.txt' } })
  emit(ToolCallStatus.PENDING, 'execute_powershell', { toolParameters: { command: 'ls' } }) // PENDING=待审批（命令类工具在审批门前），必须出块收敛思考区
  emit(ToolCallStatus.PENDING) // 无名跳过

  const texts = calls.map((c) => c.args[1])
  assert.deepEqual(texts, ['调用工具 Write…', 'Write 完成', 'Bash 失败', 'Edit 被拒绝', 'execute_powershell 等待审批'])
  assert.ok(calls.every((c) => c.args[0] === 's-t')) // M6：会话归属透传（桥内附着门控）
  // detail 结构化：参数摘要 + 结果预览 + 状态 + toolCallId 锚
  const first = calls[0]
  assert.equal(first.args[2], 'id-Write')
  assert.deepEqual(first.args[3], { name: 'Write', status: 'running', paramsSummary: 'C:\\a.txt' })
  const second = calls[1]
  assert.deepEqual(second.args[3], { name: 'Write', status: 'success', paramsSummary: 'C:\\a.txt', resultPreview: '写入完成' })
  const rejected = calls[3]
  assert.deepEqual(rejected.args[3], { name: 'Edit', status: 'rejected', paramsSummary: 'C:\\b.txt' })

  off()
  emit(ToolCallStatus.RUNNING, 'Edit', { toolParameters: {} })
  assert.equal(calls.length, 5)
})

test('engineWiring: wireBeatBoundary 事件→advanceBeat 转发；退订生效', async () => {
  const { bridge, calls } = fakeBridge()
  const off = wireBeatBoundary(bridge)
  eventBus.emit(EVENTS.ASSISTANT_MESSAGE_CREATED, { message: { isSubResponse: true } })
  eventBus.emit(EVENTS.ASSISTANT_MESSAGE_CREATED, { message: { isSubResponse: true } })
  assert.equal(calls.filter((c) => c.method === 'advanceBeat').length, 2)
  off()
  eventBus.emit(EVENTS.ASSISTANT_MESSAGE_CREATED, { message: { isSubResponse: true } })
  assert.equal(calls.filter((c) => c.method === 'advanceBeat').length, 2)
})

test('engineWiring: wirePermissionMode 事件→pushModeState 转发；退订后不再转发', () => {
  const { bridge, calls } = fakeBridge()
  const off = wirePermissionMode(bridge)
  eventBus.emit(EVENTS.PERMISSION_MODE_CHANGED, { mode: 'fullAccess', by: 'phone' })
  eventBus.emit(EVENTS.PERMISSION_MODE_CHANGED, { mode: 'boundary', by: 'local' })
  assert.deepEqual(
    calls.map((c) => [c.method, c.args[0]]),
    [
      ['pushModeState', 'fullAccess'],
      ['pushModeState', 'boundary'],
    ],
  )
  off()
  eventBus.emit(EVENTS.PERMISSION_MODE_CHANGED, { mode: 'readonly', by: 'local' })
  assert.equal(calls.length, 2)
})


// ---------- M6：会话同步装配 ----------

test('engineWiring: wireTurnStream 事件→pushStreamChunk 转发；退订生效', () => {
  const { bridge, calls } = fakeBridge()
  const off = wireTurnStream(bridge)
  const chunk = { sessionId: 's1', kind: 'delta' as const, text: '增量' }
  eventBus.emit(EVENTS.TURN_STREAM_CHUNK, chunk)
  eventBus.emit(EVENTS.TURN_STREAM_CHUNK, { sessionId: 's1', kind: 'reasoning', text: '思考' })
  assert.deepEqual(calls.map((c) => [c.method, c.args[0]]), [
    ['pushStreamChunk', chunk],
    ['pushStreamChunk', { sessionId: 's1', kind: 'reasoning', text: '思考' }],
  ])
  off()
  eventBus.emit(EVENTS.TURN_STREAM_CHUNK, chunk)
  assert.equal(calls.length, 2)
})

test('engineWiring: wireHistoryInvalidated 事件→history.invalidated；无 sessionId 不推；退订生效', () => {
  const { bridge, calls } = fakeBridge()
  const off = wireHistoryInvalidated(bridge)
  eventBus.emit(EVENTS.HISTORY_INVALIDATED, { sessionId: 's-regen' })
  eventBus.emit(EVENTS.HISTORY_INVALIDATED, {}) // 无 sessionId：fail-safe 不推
  assert.deepEqual(calls, [{ method: 'pushSessionEvent', args: [{ kind: 'history.invalidated', sessionId: 's-regen' }] }])
  off()
  eventBus.emit(EVENTS.HISTORY_INVALIDATED, { sessionId: 's-x' })
  assert.equal(calls.length, 1)
})

test('engineWiring: wireActiveSession 装配引擎单槽→active.changed；退订恢复原槽', () => {
  const { bridge, calls } = fakeBridge()
  const engine = { onActiveSessionChanged: null as null | ((id: string | null) => void) } as never
  const off = wireActiveSession(bridge, engine)
  ;(engine as { onActiveSessionChanged: (id: string | null) => void }).onActiveSessionChanged('s-new')
  ;(engine as { onActiveSessionChanged: (id: string | null) => void }).onActiveSessionChanged(null)
  assert.deepEqual(calls, [
    { method: 'pushSessionEvent', args: [{ kind: 'active.changed', sessionId: 's-new' }] },
    { method: 'pushSessionEvent', args: [{ kind: 'active.changed', sessionId: null }] },
  ])
  off()
  assert.equal((engine as { onActiveSessionChanged: unknown }).onActiveSessionChanged, null)
})

test('engineWiring: makeEnsureActiveSession——loadSession 成功/不存在/守卫忙三态映射', async () => {
  const mk = (behavior: 'ok' | 'notfound' | 'busy') =>
    makeEnsureActiveSession({
      loadSession: async () => {
        if (behavior === 'busy') throw new Error('生成进行中，请先 abort()')
        return behavior === 'ok'
      },
    } as never)
  assert.equal(await mk('ok')('s1'), 'ok')
  assert.equal(await mk('notfound')('s1'), 'notfound')
  assert.equal(await mk('busy')('s1'), 'busy')
})

test('engineWiring: makeSessionSyncBridgeDeps——catalog 全量/增量应答 + pageHistory 透传', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-sync-'))
  try {
    fs.writeFileSync(
      path.join(dir, 's1.json'),
      JSON.stringify({
        id: 's1',
        title: '会话一',
        messages: [{ role: 'user', content: '你好', timestamp: '2026-09-10T00:00:00.000Z' }],
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:01:00.000Z',
      }),
      'utf-8',
    )
    const deps = makeSessionSyncBridgeDeps({
      sessionsDir: dir,
      listProjects: async () => [],
      loadSession: async () => null,
      getActiveSessionId: () => 's1',
      ensureActiveSession: async () => 'ok',
    })
    // known 空 → full 全量
    const full = await deps.buildCatalogState!({})
    assert.equal(full.full, true)
    assert.equal(full.sessions.length, 1)
    assert.equal(full.sessions[0]!.id, 's1')
    assert.equal(full.activeSessionId, 's1')
    assert.ok(full.projectsRev)
    // 已知版本一致 → 增量为空
    const inc = await deps.buildCatalogState!({
      projectsRev: full.projectsRev,
      sessions: { s1: '2026-09-10T00:01:00.000Z' },
    })
    assert.equal(inc.full, false)
    assert.equal(inc.sessions.length, 0)
    assert.equal(inc.projects.length, 0)
    // 已知版本过旧 → 增量携带变化条目
    const stale = await deps.buildCatalogState!({
      projectsRev: full.projectsRev,
      sessions: { s1: '2026-09-10T00:00:00.000Z', 's-gone': '2026-09-09T00:00:00.000Z' },
    })
    assert.equal(stale.sessions.length, 1)
    assert.deepEqual(stale.deletes, ['s-gone'])
    // pageHistory 透传（loadSession null → notFound）
    const page = await deps.pageHistory!('s1', undefined, undefined)
    assert.equal(page.notFound, true)
    assert.equal(page.done, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('engineWiring: wireSessionCatalogWatch——目录变更 → session.created/metadata.upsert/title.changed/session.deleted；初始基线静默', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-watch-'))
  const { bridge, calls } = fakeBridge()
  const writeRec = (id: string, over: Record<string, unknown> = {}) =>
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        title: '标题',
        messages: [{ role: 'user', content: '正文', timestamp: '2026-09-10T00:00:00.000Z' }],
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
        ...over,
      }),
      'utf-8',
    )
  const events = () => calls.filter((c) => c.method === 'pushSessionEvent').map((c) => c.args[0] as { kind: string; sessionId?: string; session?: { id: string } })
  const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`waitFor 超时：${JSON.stringify(events())}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  // 初始基线静默：wire 之前已存在的会话进首期快照，不报 created
  //（先于 wire 写入是确定性要求——晚于首期扫描的写入会被 diff 视为新增）
  writeRec('s-existing')
  const off = wireSessionCatalogWatch(bridge, {
    sessionsDir: dir,
    listProjects: async () => [],
    debounceMs: 10,
  })
  try {
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(events(), [])

    // 新建 → session.created
    writeRec('s-new')
    await waitFor(() => events().some((e) => e.kind === 'session.created' && e.session?.id === 's-new'))

    // updatedAt 变化 → metadata.upsert
    writeRec('s-new', { updatedAt: '2026-09-10T00:05:00.000Z' })
    await waitFor(() => events().some((e) => e.kind === 'metadata.upsert' && e.session?.id === 's-new'))

    // 改名（不动 updatedAt）→ title.changed
    writeRec('s-new', { title: '新标题', titleSource: 'manual', updatedAt: '2026-09-10T00:05:00.000Z' })
    await waitFor(() => events().some((e) => e.kind === 'title.changed' && e.sessionId === 's-new'))

    // 删除 → session.deleted
    fs.unlinkSync(path.join(dir, 's-new.json'))
    await waitFor(() => events().some((e) => e.kind === 'session.deleted' && e.sessionId === 's-new'))
  } finally {
    off()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test("engineWiring: makeEnsureNewSession——空会话复用/有历史新建/忙时 busy 三态", async () => {
  // 空会话复用：无历史 → 不 startNewSession，只落 id
  const calls: string[] = []
  const emptyEngine = {
    getHistory: () => [],
    startNewSession: () => { calls.push('startNewSession') },
    ensureSessionId: () => { calls.push('ensureSessionId'); return 's-born' },
  } as never
  assert.equal(await makeEnsureNewSession(emptyEngine)(), 'ok')
  assert.deepEqual(calls, ['ensureSessionId'])

  // 有历史 → startNewSession + 落 id
  const calls2: string[] = []
  const busyEngine = {
    getHistory: () => [{ role: 'user', content: '旧', timestamp: new Date() }],
    startNewSession: () => { calls2.push('startNewSession') },
    ensureSessionId: () => { calls2.push('ensureSessionId'); return 's-new' },
  } as never
  assert.equal(await makeEnsureNewSession(busyEngine)(), 'ok')
  assert.deepEqual(calls2, ['startNewSession', 'ensureSessionId'])

  // 守卫忙（startNewSession throw）→ busy
  const blockedEngine = {
    getHistory: () => [{ role: 'user', content: '旧', timestamp: new Date() }],
    startNewSession: () => { throw new Error('生成进行中，请先 abort()') },
    ensureSessionId: () => 'never',
  } as never
  assert.equal(await makeEnsureNewSession(blockedEngine)(), 'busy')
})
