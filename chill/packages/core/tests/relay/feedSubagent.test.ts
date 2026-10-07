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
  KNOWN_TYPES,
  type Envelope,
  type KeyPairB64,
  type FeedSubagentBody,
} from '../../src/services/relay/envelope.ts'
import type { RelayTransport, RelayHttp, BoxMessage } from '../../src/services/relay/RelayTransport.ts'
import { wireFeedSubagent } from '../../src/services/relayEngineWiring.ts'
import {
  SessionBoardService,
  resetSessionBoardService,
  setSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import { BoardStore } from '../../src/services/board/boardStore.ts'
import { eventBus, EVENTS, type SubagentToolCallPayload } from '../../src/utils/eventBus.ts'

function makeEnv(over: { confirmed?: boolean; attached?: string | null } = {}) {
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
  const posts: { path: string; body: { blob?: string } }[] = []
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      if (method === 'POST') posts.push({ path, body: (opts.body ?? {}) as never })
      return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
    },
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
    getActiveSessionId: () => 's-current',
    buildBoardState: async (sessionId: string) => ({
      sessionId,
      rev: '1',
      rows: [],
      strip: { status: 'settled', countText: '0/0', settleText: '0 个子任务完成', needsYou: false },
      needsYou: { needed: false, count: 0 },
      windowed: false,
      full: true,
    }),
  })
  bridge.start()

  function phoneEnvelope(type: string, body: Record<string, unknown>, id?: string): BoxMessage {
    const env = makeEnvelope(type, peerBox, myBox, body)
    if (id) env.id = id
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  async function attach(sessionId: string | null): Promise<void> {
    msgHandler(phoneEnvelope('session.attach', { sessionId }))
    await new Promise((r) => setTimeout(r, 25))
  }
  function readPostedEnvelopes(): Envelope[] {
    return posts
      .filter((p) => p.path === `/box/${peerBox}` && typeof p.body.blob === 'string')
      .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
      .filter((d) => d.ok)
      .map((d) => (d as { ok: true; envelope: Envelope }).envelope)
  }
  return { bridge, attach, readPostedEnvelopes, posts }
}

function feedBody(over: Partial<FeedSubagentBody> = {}): FeedSubagentBody {
  return {
    toolCallId: 'tc-f1',
    toolName: 'read_file',
    kind: 'builtin',
    argsSummary: '{"path":"a.ts"}',
    status: 'running',
    at: 1000,
    taskId: 'tc-task',
    ...over,
  }
}

test('V2 线形往返：feed.subagent 入 KNOWN_TYPES 且加解密字段无损', () => {
  assert.ok(KNOWN_TYPES.has('feed.subagent'))
  const desk: KeyPairB64 = generateKeyPair()
  const phone: KeyPairB64 = generateKeyPair()
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)
  const body = feedBody({ status: 'success', resultSummary: '读完', durationMs: 420 })
  const env = makeEnvelope('feed.subagent', myBox, peerBox, body as unknown as Record<string, unknown>)
  const wire = encryptEnvelope(secrets.keyD2M, peerBox, 'd2m', env)!
  const dec = decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', wire)
  assert.ok(dec.ok)
  const back = (dec as { ok: true; envelope: Envelope }).envelope.body as unknown as FeedSubagentBody
  assert.deepEqual(back, body)
})

test('V2 pushFeedSubagent 出向保序（queueOut FIFO）', async () => {
  const env = makeEnv()
  await env.attach('s-b')
  env.bridge.pushFeedSubagent('s-b', feedBody({ toolCallId: 'a', at: 1 }))
  env.bridge.pushFeedSubagent('s-b', feedBody({ toolCallId: 'b', at: 2 }))
  env.bridge.pushFeedSubagent('s-b', feedBody({ toolCallId: 'c', at: 3 }))
  await new Promise((r) => setTimeout(r, 40))
  const feeds = env.readPostedEnvelopes().filter((e) => e.type === 'feed.subagent')
  assert.deepEqual(feeds.map((e) => (e.body as unknown as FeedSubagentBody).toolCallId), ['a', 'b', 'c'])
})

test('V2 附着门控：非附着会话的 Worker 进展不推（决策 15）', async () => {
  const env = makeEnv()
  await env.attach('s-mine')
  env.bridge.pushFeedSubagent('s-other', feedBody({ taskId: 'tc-other' }))
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(env.readPostedEnvelopes().filter((e) => e.type === 'feed.subagent').length, 0)
  env.bridge.pushFeedSubagent('s-mine', feedBody({ taskId: 'tc-mine' }))
  await new Promise((r) => setTimeout(r, 40))
  const feeds = env.readPostedEnvelopes().filter((e) => e.type === 'feed.subagent')
  assert.equal(feeds.length, 1)
  assert.equal((feeds[0]!.body as unknown as FeedSubagentBody).taskId, 'tc-mine')
})

// ---------- wireFeedSubagent 合并窗口 ----------

function fakeBridge() {
  const pushed: { sessionId: string | null; body: FeedSubagentBody }[] = []
  return {
    pushed,
    bridge: {
      pushFeedSubagent: (sessionId: string | null, body: FeedSubagentBody) => {
        pushed.push({ sessionId, body })
      },
    } as unknown as RelayBridge,
  }
}

function emit(p: Partial<SubagentToolCallPayload>): void {
  eventBus.emit(EVENTS.SUBAGENT_TOOL_CALL, {
    toolCallId: 'tc-f1',
    toolName: 'read_file',
    kind: 'builtin',
    argsSummary: 'args',
    status: 'running',
    at: Date.now(),
    ...p,
  } satisfies SubagentToolCallPayload)
}

test('V2 合并窗口：同窗同 toolCallId 归并（latest-wins，running→success 只推终态）；异 id 各推一条', async () => {
  const fb = fakeBridge()
  const off = wireFeedSubagent(fb.bridge, { windowMs: 80 })
  try {
    emit({ toolCallId: 'tc-f1', status: 'running', at: 1 })
    emit({ toolCallId: 'tc-f2', status: 'running', at: 2 })
    emit({ toolCallId: 'tc-f1', status: 'success', at: 3, resultSummary: '好', durationMs: 5 })
    assert.equal(fb.pushed.length, 0) // 窗口内不发
    await new Promise((r) => setTimeout(r, 140))
    assert.equal(fb.pushed.length, 2) // 一窗一批:tc-f1 归并后 + tc-f2
    const f1 = fb.pushed.find((p) => p.body.toolCallId === 'tc-f1')!
    assert.equal(f1.body.status, 'success') // running 被同窗终态覆盖
    assert.equal(f1.body.resultSummary, '好')
  } finally {
    off()
  }
})

test('V2 合并窗口：跨窗口分批（固定窗口首条起算,连续洪峰不积压）', async () => {
  const fb = fakeBridge()
  const off = wireFeedSubagent(fb.bridge, { windowMs: 100 })
  try {
    emit({ toolCallId: 'a', at: 1 })
    await new Promise((r) => setTimeout(r, 60))
    emit({ toolCallId: 'b', at: 2 }) // 同窗（窗从首条起算）
    await new Promise((r) => setTimeout(r, 100)) // 总 160ms > 窗口
    assert.equal(fb.pushed.length, 2) // 第一批 a+b
    emit({ toolCallId: 'c', at: 3 })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(fb.pushed.length, 3) // 第二批 c
    assert.deepEqual(fb.pushed.map((p) => p.body.toolCallId), ['a', 'b', 'c'])
  } finally {
    off()
  }
})

test('V2 合并窗口：乱序旧帧丢弃（at 比较 latest-wins）；无锚（缺 toolCallId）不产出', async () => {
  const fb = fakeBridge()
  const off = wireFeedSubagent(fb.bridge, { windowMs: 60 })
  try {
    emit({ toolCallId: 'tc-x', status: 'success', at: 2000 })
    emit({ toolCallId: 'tc-x', status: 'running', at: 1000 }) // 乱序旧帧
    eventBus.emit(EVENTS.SUBAGENT_TOOL_CALL, { toolCallId: '', toolName: 'x', kind: 'builtin', argsSummary: '', status: 'running', at: 3000 })
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(fb.pushed.length, 1)
    assert.equal(fb.pushed[0]!.body.status, 'success')
  } finally {
    off()
  }
})

test('V2 wireFeedSubagent 会话归属：经看板工位索引反查 taskId→sessionId；退订后短路', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feed-wire-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  try {
    await svc.autoPostAndClaim({ sessionId: 's-b', batchId: 'b1', taskId: 'tc-task', subagentType: 'explore', title: '活' })
    const fb = fakeBridge()
    const off = wireFeedSubagent(fb.bridge, { windowMs: 40 })
    emit({ taskId: 'tc-task', toolCallId: 'tc-f9', status: 'running', at: 1 })
    emit({ taskId: 'tc-unknown', toolCallId: 'tc-f8', status: 'running', at: 1 })
    await new Promise((r) => setTimeout(r, 100))
    const mine = fb.pushed.find((p) => p.body.toolCallId === 'tc-f9')!
    assert.equal(mine.sessionId, 's-b') // 板工位索引反查
    const unknown = fb.pushed.find((p) => p.body.toolCallId === 'tc-f8')!
    assert.equal(unknown.sessionId, null) // 无归属=桥内门控拒
    // 退订后短路（含 preload 通道残余回调场景）
    off()
    emit({ taskId: 'tc-task', toolCallId: 'tc-f7', status: 'running', at: 2 })
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(fb.pushed.filter((p) => p.body.toolCallId === 'tc-f7').length, 0)
  } finally {
    resetSessionBoardService()
    await rm(dir, { recursive: true, force: true })
  }
})
