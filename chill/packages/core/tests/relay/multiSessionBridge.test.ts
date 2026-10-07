import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayBridge, type EnqueueResult, type EnqueueInput } from '../../src/services/relay/RelayBridge.ts'
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
} from '../../src/services/relay/envelope.ts'
import type { RelayTransport, RelayHttp, BoxMessage } from '../../src/services/relay/RelayTransport.ts'
import type { PendingRoundEntry } from '../../src/services/relay/RelayBridge.ts'

/**
 * M0.4a/0.4b/M0.3（多会话并行规划）桥级回归：
 * - 压轴：A 轮次进行中，B 的注入**即刻开始**不被楔（入向链按目标会话分键）；
 * - 钉子①：缺省目标一次解析（链键 = enqueue 目标）；
 * - 0.4b 交错：attach 切换冲刷离开会话的格；B 流式中 A 落定不再打掉 B 的流（分键前
 *   单份 deltaClosed 会被 A 的终态置位 → B 后续 delta 全丢——本组锁死该修复）；
 * - M0.3：advanceBeat 按归属会话门控；
 * - 钉子③：并发清账落盘串行——终态确定性（两次清除后快照为空）。
 */

interface PendingRound {
  input: EnqueueInput
  resolve: (r: EnqueueResult) => void
}

function makeEnv(over: { currentSessionId?: string | null } = {}) {
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
  const posts: { path: string; token: string; body: { blob?: string; id?: number } }[] = []
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      if (method === 'POST') posts.push({ path, token: opts.token ?? '', body: (opts.body ?? {}) as never })
      return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
    },
  }
  /** 受控 enqueue：每条消息挂起直到 finishRound 手动放行——压轴断言的数据源 */
  const startedRounds: EnqueueInput[] = []
  const pendingRounds = new Map<string, PendingRound>()
  const alarms: string[] = []
  let currentSessionId: string | null = over.currentSessionId === undefined ? 's-active' : over.currentSessionId
  const ledgerSaves: PendingRoundEntry[][] = []
  let ledgerOnDisk: PendingRoundEntry[] = []
  const bridge = new RelayBridge({
    transport,
    http,
    secrets,
    myBox,
    peerBox,
    deskPub: desk.publicKey,
    phonePub: phone.publicKey,
    deviceName: '测试桌面',
    pairingToken: 'pair-token',
    confirmed: true,
    enqueue: (input, opts) =>
      new Promise<EnqueueResult>((resolve) => {
        startedRounds.push(input)
        pendingRounds.set(input.clientId!, { input, resolve })
        // 模拟引擎两段式回调契约：消息已持久化（台账收录 + ACK 由桥在回调内完成）
        void opts?.onIngested?.()
      }),
    resolveApproval: () => true,
    listPendingApprovals: () => [],
    getActiveSessionId: () => currentSessionId,
    ensureActiveSession: async (id) => {
      currentSessionId = id
      return 'ok'
    },
    ensureNewSession: async () => {
      currentSessionId = 's-newborn'
      return 'ok'
    },
    onAlarm: (m) => alarms.push(m),
    loadPendingRounds: async () => ledgerOnDisk,
    savePendingRounds: async (entries) => {
      ledgerSaves.push(entries.map((e) => ({ ...e })))
      ledgerOnDisk = entries
    },
  })
  bridge.start()

  function phoneSend(text: string, id: string, sessionId?: string): BoxMessage {
    const env = makeEnvelope('chat.user', peerBox, myBox, sessionId !== undefined ? { text, sessionId } : { text })
    env.id = id
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  function phoneEnvelope(type: string, body: Record<string, unknown>, id?: string): BoxMessage {
    const env = makeEnvelope(type, peerBox, myBox, body)
    if (id) env.id = id
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  function readPostedEnvelopes(): Envelope[] {
    return posts
      .filter((p) => p.path === `/box/${peerBox}` && typeof p.body.blob === 'string')
      .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
      .filter((d) => d.ok)
      .map((d) => (d as { ok: true; envelope: Envelope }).envelope)
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15))
  async function waitUntil(cond: () => boolean, ms = 500): Promise<void> {
    const deadline = Date.now() + ms
    while (!cond() && Date.now() < deadline) await tick()
    assert.ok(cond(), 'waitUntil 超时')
  }
  function finishRound(clientId: string, content = '完成'): void {
    const p = pendingRounds.get(clientId)
    pendingRounds.delete(clientId)
    p?.resolve({ content, aborted: false })
  }
  return {
    bridge, phoneSend, phoneEnvelope, readPostedEnvelopes, waitUntil, tick, finishRound,
    startedRounds, alarms, ledgerSaves, feed: async (msg: BoxMessage) => { msgHandler(msg); await tick() },
  }
}

test('M0.4a 压轴：A 轮次进行中，B 的注入即刻开始不被楔（链按目标会话分键）', async () => {
  const env = makeEnv()
  void env.feed(env.phoneSend('A 任务', 'env-a', 's-a'))
  await env.waitUntil(() => env.startedRounds.length === 1)
  // A 的轮次挂起中——B 到达：必须立刻开始注入（旧全局链会排在 A 的整轮之后）
  void env.feed(env.phoneSend('B 任务', 'env-b', 's-b'))
  await env.waitUntil(() => env.startedRounds.length === 2)
  assert.equal(env.startedRounds[1]!.sessionId, 's-b', 'enqueue 输入携带目标会话（M0.1′ 直寻路由）')
  assert.equal(env.startedRounds[0]!.sessionId, 's-a')
  // 放行 A 后 B 仍挂起（各自独立），再放行 B
  env.finishRound('env-a')
  env.finishRound('env-b')
  await env.waitUntil(() => env.readPostedEnvelopes().some((e) => e.type === 'chat.event' && e.body['kind'] === 'final' && e.replyTo === 'env-b'))
  const finals = env.readPostedEnvelopes().filter((e) => e.type === 'chat.event' && e.body['kind'] === 'final')
  assert.equal(finals.length, 2, '两会话各自落定回执')
})

test('M0.4a 钉子①：缺省目标入链前一次解析——活跃漂移不错配（enqueue 目标 = 入链时的活跃）', async () => {
  const env = makeEnv({ currentSessionId: 's-first' })
  void env.feed(env.phoneSend('旧手机消息', 'env-legacy')) // 无 sessionId
  await env.waitUntil(() => env.startedRounds.length === 1)
  assert.equal(env.startedRounds[0]!.sessionId, 's-first', '缺省目标按入链时活跃一次解析并随输入透传')
  env.finishRound('env-legacy')
})

test('M0.4b 交错一：attach 切换冲刷离开会话的格（旧会话尾部 delta 带自己的锚出队）', async () => {
  const env = makeEnv()
  void env.feed(env.phoneSend('A 轮', 'env-a2', 's-a'))
  await env.waitUntil(() => env.startedRounds.length === 1)
  // A 流式（附着 s-a，发言即附着）：缓冲未到冲刷窗口
  env.bridge.pushStreamChunk({ sessionId: 's-a', kind: 'delta', text: 'A 的半截输出' })
  // 用户切到 B（attach 冲刷 A 的格，锚 = A 的消息 id）
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-b' }))
  const deltas = env.readPostedEnvelopes().filter((e) => e.type === 'chat.event' && e.body['kind'] === 'delta')
  assert.equal(deltas.length, 1, 'A 的滞留缓冲在离开时冲刷')
  assert.equal(deltas[0]!.replyTo, 'env-a2', '冲刷内容带 A 自己的锚（不串到新会话）')
  assert.equal(deltas[0]!.body['text'], 'A 的半截输出')
  env.finishRound('env-a2')
})

test('M0.4b 交错二：B 流式中 A 落定——B 的流不中断（分键前 A 的终态会把共享 deltaClosed 置位丢掉 B 的后续 delta）', async () => {
  const env = makeEnv()
  // A 先发言（轮次挂起；附着 s-a），随后用户切看 B 并对 B 发言（B 轮次流式中）
  void env.feed(env.phoneSend('A 轮', 'env-a3', 's-a'))
  await env.waitUntil(() => env.startedRounds.length === 1)
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-b' }))
  void env.feed(env.phoneSend('B 轮', 'env-b3', 's-b'))
  await env.waitUntil(() => env.startedRounds.length === 2)
  env.bridge.pushStreamChunk({ sessionId: 's-b', kind: 'delta', text: 'B 流式中' })
  env.bridge.advanceBeat('s-b') // 冲刷 B 格（beat 0 出队）
  await env.tick()
  // A 落定（final + deltaClosed=true 置位——只许作用于 A 自己的格）
  env.finishRound('env-a3')
  await env.waitUntil(() => env.readPostedEnvelopes().some((e) => e.type === 'chat.event' && e.body['kind'] === 'final' && e.replyTo === 'env-a3'))
  // B 的后续 delta 必须继续出向且带 B 的锚（分键前：A 的终态置共享 deltaClosed → B 后续全丢）
  env.bridge.pushStreamChunk({ sessionId: 's-b', kind: 'delta', text: 'B 续流' })
  env.bridge.advanceBeat('s-b') // beat 1 出队——B 的节拍也未被 A 干扰
  await env.tick() // 出向 FIFO 微任务排空
  const bDeltas = env.readPostedEnvelopes().filter((e) => e.type === 'chat.event' && e.body['kind'] === 'delta' && e.replyTo === 'env-b3')
  assert.deepEqual(
    bDeltas.map((e) => [e.body['text'], e.body['beat']]),
    [['B 流式中', 0], ['B 续流', 1]],
    'B 的流全程带自己锚、节拍连续、不被 A 落定打断',
  )
  env.finishRound('env-b3')
})

test('M0.3 节拍门控：非附着会话的子响应不进拍（多引擎同跑不跳拍）', async () => {
  const env = makeEnv()
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-a' }))
  env.bridge.pushStreamChunk({ sessionId: 's-a', kind: 'delta', text: 'A beat0 正文' })
  // 后台会话 s-c 的子响应到达——不得冲刷/进拍 A 的视图
  env.bridge.advanceBeat('s-c')
  let deltas = env.readPostedEnvelopes().filter((e) => e.type === 'chat.event' && e.body['kind'] === 'delta')
  assert.equal(deltas.length, 0, '非附着会话的节拍不冲刷 A 的缓冲')
  // A 自己的子响应进拍 → 冲刷 beat0
  env.bridge.advanceBeat('s-a')
  await env.tick() // 出向 FIFO 微任务排空
  deltas = env.readPostedEnvelopes().filter((e) => e.type === 'chat.event' && e.body['kind'] === 'delta')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0]!.body['beat'], 0)
})

test('M0.4a 钉子③：并发清账落盘串行——两轮各自落定后终态为空（无乱序复活）', async () => {
  const env = makeEnv()
  void env.feed(env.phoneSend('A 轮', 'env-a4', 's-a'))
  void env.feed(env.phoneSend('B 轮', 'env-b4', 's-b'))
  await env.waitUntil(() => env.startedRounds.length === 2)
  await env.waitUntil(() => env.ledgerSaves.length >= 2) // 两条台账已收录
  env.finishRound('env-a4')
  env.finishRound('env-b4')
  await env.waitUntil(() => env.ledgerSaves.length >= 4, 1000) // 两次清账落盘完成
  const last = env.ledgerSaves[env.ledgerSaves.length - 1]!
  assert.equal(last.length, 0, '末次快照为空（保序链保证末次=最完整）')
})
