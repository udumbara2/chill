import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayBridge, type EnqueueResult } from '../../src/services/relay/RelayBridge.ts'
import {
  generateKeyPair,
  ecdhShared,
  deriveSecrets,
  mailboxIdFromPub,
  encryptEnvelope,
  decryptEnvelope,
  makeEnvelope,
  type Envelope,
  type KeyPairB64,
  type BoardStateBody,
  type BoardSyncBody,
} from '../../src/services/relay/envelope.ts'
import type { RelayTransport, RelayHttp, BoxMessage } from '../../src/services/relay/RelayTransport.ts'
import { makeBoardSyncBridgeDeps, wireBoard } from '../../src/services/relayEngineWiring.ts'
import {
  SessionBoardService,
  resetSessionBoardService,
  setSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import { BoardStore } from '../../src/services/board/boardStore.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import { resetTeamRuntimeService, setTeamRuntimeService } from '../../src/services/team/TeamRuntimeService.ts'

/** 精简版桥测试环境（relayBridge.test.ts 同构；本文件聚焦 M7 board 通道） */
function makeEnv(over: { confirmed?: boolean; currentSessionId?: string | null } = {}) {
  const desk: KeyPairB64 = generateKeyPair()
  const phone: KeyPairB64 = generateKeyPair()
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)

  let msgHandler: (msg: BoxMessage) => void = () => {}
  const transport: RelayTransport = {
    connect: async () => {},
    close: () => {},
    connected: true,
    onMessage: (cb) => {
      msgHandler = cb
    },
    onClose: () => {},
  }
  const posts: { path: string; body: { blob?: string; id?: number } }[] = []
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      if (method === 'POST') posts.push({ path, body: (opts.body ?? {}) as never })
      return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
    },
  }
  let currentSessionId: string | null = over.currentSessionId === undefined ? 's-current' : over.currentSessionId
  /** buildBoardState 测试旋钮：默认回一个可辨识的最小状态体 */
  let revCounter = 0
  const buildCalls: { sessionId: string; knownRev?: string | number }[] = []
  const buildBoardState = async (sessionId: string, knownRev?: string | number): Promise<BoardStateBody> => {
    buildCalls.push({ sessionId, ...(knownRev !== undefined ? { knownRev } : {}) })
    revCounter++
    return {
      sessionId,
      rev: String(revCounter),
      rows: [
        {
          itemId: 'b1',
          title: '任务一',
          assignee: 'explore·A',
          status: 'in_progress',
          label: '进行中',
          progressText: '推进中',
          detail: {},
        },
      ],
      strip: { status: 'running', countText: '0/1', needsYou: true },
      needsYou: { needed: true, count: 1 },
      windowed: false,
      full: knownRev === undefined,
    }
  }
  const bridge = new RelayBridge({
    transport,
    http,
    secrets,
    myBox,
    peerBox,
    deskPub: desk.publicKey,
    phonePub: phone.publicKey,
    deviceName: '测试机',
    pairingToken: 'pair-token',
    confirmed: over.confirmed ?? true,
    enqueue: async (): Promise<EnqueueResult> => ({ content: 'ok', aborted: false }),
    resolveApproval: () => false,
    listPendingApprovals: () => [],
    getActiveSessionId: () => currentSessionId,
    buildBoardState,
  })
  bridge.start()

  function phoneEnvelope(type: string, body: Record<string, unknown>, id?: string): BoxMessage {
    const env = makeEnvelope(type, peerBox, myBox, body)
    if (id) env.id = id
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  function phoneSend(text: string): BoxMessage {
    return phoneEnvelope('chat.user', { text })
  }
  function readPostedEnvelopes(): Envelope[] {
    return posts
      .filter((p) => p.path === `/box/${peerBox}` && typeof p.body.blob === 'string')
      .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
      .filter((d) => d.ok)
      .map((d) => (d as { ok: true; envelope: Envelope }).envelope)
  }
  async function feed(msg: BoxMessage): Promise<void> {
    msgHandler(msg)
    await new Promise((r) => setTimeout(r, 25))
  }
  return { bridge, phoneEnvelope, phoneSend, readPostedEnvelopes, feed, buildCalls, posts }
}

test('M7 handleBoardSync：rev 落后/未知 → full=true 全量；rev 已一致 → full=false 纯确认', async () => {
  const env = makeEnv()
  // 未知 rev（空=全量）
  await env.feed(env.phoneEnvelope('board.sync', { sessionId: 's-b' }, 'sync-1'))
  // 已知 rev 透传给组包口
  await env.feed(env.phoneEnvelope('board.sync', { sessionId: 's-b', rev: '3' }, 'sync-2'))

  assert.deepEqual(env.buildCalls, [
    { sessionId: 's-b' },
    { sessionId: 's-b', knownRev: '3' },
  ])
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'board.state')
  assert.equal(posted.length, 2)
  assert.equal(posted[0]!.body['full'], true) // 空 rev=全量
  assert.equal((posted[0]!.body as unknown as BoardStateBody).rows.length, 1)
  // 对照：组包口的 rev 对账语义（full 由 knownRev 比较得出;此处 mock 按 knownRev 在场判)
  assert.equal(posted[1]!.body['full'], false)
  // 应答带 replyTo=board.sync 的信封 id（同 catalog.state 归组）
  assert.equal(posted[0]!.replyTo, 'sync-1')
  assert.equal(posted[1]!.replyTo, 'sync-2')
})

test('M7 pushBoardState 出向保序（boardSendChain 串行）', async () => {
  const env = makeEnv()
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-b' }))
  env.bridge.pushBoardState('s-b')
  env.bridge.pushBoardState('s-b')
  env.bridge.pushBoardState('s-b')
  await new Promise((r) => setTimeout(r, 60))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'board.state')
  assert.equal(posted.length, 3)
  const revs = posted.map((p) => (p.body as unknown as BoardStateBody).rev)
  assert.deepEqual(revs, ['1', '2', '3']) // 组包序=发送序
})

test('M7 附着门控：非附着会话不推（决策 15），附着会话才推', async () => {
  const env = makeEnv()
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-mine' }))
  const before = env.readPostedEnvelopes().filter((e) => e.type === 'board.state').length
  env.bridge.pushBoardState('s-other') // 非附着会话
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(env.readPostedEnvelopes().filter((e) => e.type === 'board.state').length, before)

  env.bridge.pushBoardState('s-mine') // 附着会话
  await new Promise((r) => setTimeout(r, 40))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'board.state')
  assert.equal(posted.length, before + 1)
  assert.equal((posted.at(-1)!.body as unknown as BoardStateBody).sessionId, 's-mine')
})

test('M7 快速路径：board.sync 不排在被轮次楔死的链后（不碰引擎）', async () => {
  const env = makeEnv()
  let releaseRound: (r: EnqueueResult) => void = () => {}
  const roundGate = new Promise<EnqueueResult>((res) => {
    releaseRound = res
  })
  env.bridge['deps'].enqueue = () => roundGate // 轮次挂起（模拟等审批）

  const feedPromise = env.feed(env.phoneSend('触发长轮次'))
  await new Promise((r) => setTimeout(r, 50)) // 轮次已阻塞在 enqueue

  await env.feed(env.phoneEnvelope('board.sync', { sessionId: 's-fast' }))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'board.state')
  assert.equal(posted.length, 1) // 链被楔死仍立即应答
  assert.equal((posted[0]!.body as unknown as BoardStateBody).sessionId, 's-fast')

  releaseRound({ content: '完成', aborted: false })
  await feedPromise
})

test('M7 分片：超 45KB 明文预算按 rows 贪心分包，同 replyTo 归组', async () => {
  const env = makeEnv()
  // 造超预算投影（40 行 × ~6KB ≈ 240KB）
  const bigRow = (i: number) => ({
    itemId: `b${i}`,
    title: '行',
    assignee: null,
    status: 'completed' as const,
    label: '已交付',
    progressText: null,
    detail: { result: 'r'.repeat(6000) },
  })
  env.bridge['deps'].buildBoardState = async (sessionId: string): Promise<BoardStateBody> => ({
    sessionId,
    rev: '9',
    rows: Array.from({ length: 40 }, (_, i) => bigRow(i)),
    strip: { status: 'running', countText: '0/40', needsYou: false },
    needsYou: { needed: false, count: 0 },
    windowed: true,
    full: true,
  })

  await env.feed(env.phoneEnvelope('board.sync', { sessionId: 's-big', rev: '1' } satisfies BoardSyncBody as never))
  await new Promise((r) => setTimeout(r, 120))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'board.state')
  assert.ok(posted.length >= 3, `应分多片（实得 ${posted.length}）`)
  const chunks = posted.map((p) => (p.body as unknown as BoardStateBody).chunk!)
  const total = (posted[0]!.body as unknown as BoardStateBody).chunks!
  assert.equal(total, posted.length)
  assert.deepEqual(chunks, Array.from({ length: total }, (_, i) => i)) // 0..n-1 连续
  // 同 replyTo 归组（都锚 board.sync 信封）
  assert.ok(posted.every((p) => p.replyTo === posted[0]!.replyTo))
  // chunk 0 携带标量骨架，其余 chunk 仅 rows 切片（标量同值）
  const c0 = posted[0]!.body as unknown as BoardStateBody
  const cN = posted.at(-1)!.body as unknown as BoardStateBody
  assert.equal(c0.strip.countText, '0/40')
  assert.equal(cN.full, true)
  assert.ok(cN.rows.length > 0)
  const rowCount = posted.reduce((n, p) => n + (p.body as unknown as BoardStateBody).rows.length, 0)
  assert.equal(rowCount, 40) // 行不丢不重
})

test('M7 resyncBoard 补推：附着会话 / chat.sync 触发', async () => {
  const env = makeEnv()
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-r' }))
  const before = env.readPostedEnvelopes().filter((e) => e.type === 'board.state').length

  env.bridge.resyncBoard()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(env.readPostedEnvelopes().filter((e) => e.type === 'board.state').length, before + 1)

  // chat.sync（连接建立订阅信号）→ 同步补推
  await env.feed(env.phoneEnvelope('chat.sync', {}))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'board.state')
  assert.equal(posted.length, before + 2)
  assert.equal((posted.at(-1)!.body as unknown as BoardStateBody).sessionId, 's-r')
})

test('M7 wireBoard：防抖合并——300ms 窗内多次 BOARD_CHANGED 只推一次', async () => {
  const pushed: string[] = []
  const fakeBridge = { pushBoardState: (sid: string) => pushed.push(sid) } as unknown as RelayBridge
  const unsub = wireBoard(fakeBridge) // 缺省 300ms 防抖
  try {
    eventBus.emit(EVENTS.BOARD_CHANGED, { sessionId: 's-d', boardId: 's-d', revision: 1 })
    await new Promise((r) => setTimeout(r, 50))
    eventBus.emit(EVENTS.BOARD_CHANGED, { sessionId: 's-d', boardId: 's-d', revision: 2 })
    await new Promise((r) => setTimeout(r, 50))
    eventBus.emit(EVENTS.BOARD_CHANGED, { sessionId: 's-d', boardId: 's-d', revision: 3 })
    assert.deepEqual(pushed, []) // 窗内未发
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(pushed, ['s-d']) // 合并为一次
  } finally {
    unsub()
  }
})

test('M7 makeBoardSyncBridgeDeps：rev 对账（落后/未知=full 全量，已一致=纯确认）+ needsYou 计数并入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-sync-deps-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  try {
    const deps = makeBoardSyncBridgeDeps()
    await svc.post('sess-b', { title: '待认领活', createdBy: 'lead' })
    const rev = await svc.getRevision('sess-b')

    // 未知 rev → full=true 全量行
    const full = await deps.buildBoardState!('sess-b')
    assert.equal(full.full, true)
    assert.equal(full.rev, String(rev))
    assert.equal(full.rows.length, 1)
    assert.equal(full.rows[0]!.label, '待认领')
    assert.equal(full.needsYou.needed, true) // 待认领计入要你
    assert.equal(full.strip.status, 'running')

    // 已知 rev=当前 → full=false 纯确认（rows 空,标量照带）
    const confirm = await deps.buildBoardState!('sess-b', String(rev))
    assert.equal(confirm.full, false)
    assert.deepEqual(confirm.rows, [])
    assert.equal(confirm.needsYou.needed, true)
    assert.equal(confirm.rev, String(rev))

    // 落后 rev → full=true
    const stale = await deps.buildBoardState!('sess-b', '0')
    assert.equal(stale.full, true)
    assert.equal(stale.rows.length, 1)
  } finally {
    resetSessionBoardService()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- M7 增量 1：团队板并入手机显示（并集投影 + 团队板事件订阅） ----------

test('M7 增量：board.state 并入同会话活动团队板行（full=true；不匹配/旧数据不并入）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-union-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  try {
    await svc.post('s1', { title: '会话板任务', createdBy: 'lead' })
    const sessionRev = await svc.getRevision('s1')
    const teamItem = {
      id: 't1',
      title: '团队看板任务',
      status: 'pending' as const,
      createdBy: 'lead',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const deps = makeBoardSyncBridgeDeps()

    // ① 归属匹配（sessionId === 会话）：并入 + 一律 full=true（团队板独立 CAS，无单调合并 rev）
    setTeamRuntimeService({
      getActiveTeam: () => ({ runId: 'r1', sessionId: 's1' }),
      boardList: () => ({ revision: 1, items: [teamItem] }),
    } as never)
    const st1 = await deps.buildBoardState!('s1', String(sessionRev))
    const titles1 = st1.rows.map((r) => r.title)
    assert.ok(titles1.includes('团队看板任务'), '团队板行应并入')
    assert.ok(titles1.includes('会话板任务'), '会话板行仍在')
    assert.equal(st1.full, true, '含团队板行一律全量')

    // ② 归属不匹配（团队属别的会话）：不并入 + rev 已知 → 纯确认
    setTeamRuntimeService({
      getActiveTeam: () => ({ runId: 'r1', sessionId: 's2' }),
      boardList: () => ({ revision: 1, items: [teamItem] }),
    } as never)
    const st2 = await deps.buildBoardState!('s1', String(sessionRev))
    assert.deepEqual(st2.rows, [], '不匹配会话不并入（rev 一致=纯确认空行）')
    assert.equal(st2.full, false)

    // ③ 旧数据（无 sessionId）：不并入（保守零回归）
    setTeamRuntimeService({
      getActiveTeam: () => ({ runId: 'r1' }),
      boardList: () => ({ revision: 1, items: [teamItem] }),
    } as never)
    const st3 = await deps.buildBoardState!('s1')
    assert.ok(!st3.rows.map((r) => r.title).includes('团队看板任务'), '无归属旧数据不并入')
  } finally {
    resetSessionBoardService()
    resetTeamRuntimeService()
    await rm(dir, { recursive: true, force: true })
  }
})

test('M7 增量：wireBoard 订阅 TEAM_BOARD_CHANGED（同防抖窗口合并一次；无归属不推）', async () => {
  const pushed: string[] = []
  const fakeBridge = { pushBoardState: (sid: string) => pushed.push(sid) } as unknown as RelayBridge
  const unsub = wireBoard(fakeBridge)
  try {
    eventBus.emit(EVENTS.TEAM_BOARD_CHANGED, { runId: 'r1', sessionId: 's-t', revision: 1 })
    await new Promise((r) => setTimeout(r, 50))
    eventBus.emit(EVENTS.TEAM_BOARD_CHANGED, { runId: 'r1', sessionId: 's-t', revision: 2 })
    assert.deepEqual(pushed, []) // 窗内未发
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(pushed, ['s-t']) // 合并为一次
    // 旧数据无归属：不推
    eventBus.emit(EVENTS.TEAM_BOARD_CHANGED, { runId: 'r1', revision: 3 })
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(pushed, ['s-t'])
  } finally {
    unsub()
  }
})
