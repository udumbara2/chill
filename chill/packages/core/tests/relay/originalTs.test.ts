/**
 * originalTs.test.ts — 信封生命周期迭代2 core 侧（重放钉位根治）验收：
 * requestedAt 折进 payload（单一事实源）；pushAskRequest/pushApprovalRequest 三路径统一携带 originalTs
 * （条件展开：无 requestedAt 不上线该键）；落定环重放同样携带。
 * 对应 chill-archive/verify-current.md 验收标准 1-6。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayBridge } from '../../src/services/relay/RelayBridge.ts'
import {
  generateKeyPair,
  ecdhShared,
  deriveSecrets,
  mailboxIdFromPub,
  decryptEnvelope,
  type Envelope,
} from '../../src/services/relay/envelope.ts'
import type { RelayTransport, RelayHttp } from '../../src/services/relay/RelayTransport.ts'
import { AskChannel, type AskRequestPayload, type SettledAskRecord } from '../../src/services/askChannel.ts'
import { ApprovalChannel } from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'

// ---------- 标准 1-3：payload 折进 requestedAt（channel 直调） ----------

test('AskChannel：payload 折进 requestedAt（≈发起时刻）+ 落定环内嵌携带（单一事实源）', async () => {
  const ch = new AskChannel()
  const seen: AskRequestPayload[] = []
  const off = (p: AskRequestPayload) => seen.push(p)
  eventBus.on(EVENTS.ASK_REQUESTED, off)
  try {
    const before = Date.now()
    const promise = ch.ask('q?', [{ label: 'A', description: '' }], false, undefined, { sessionId: 'S1' })
    const payload = seen[0]!
    assert.equal(typeof payload.requestedAt, 'number')
    assert.ok(payload.requestedAt! >= before && payload.requestedAt! <= Date.now() + 1000)
    // meta.requestedAt 与 payload.requestedAt 同源（同一时钟读取，不二次取时钟）
    ch.resolve(payload.id, 'A', 'local')
    await promise
    const ring = ch.listRecentSettled()
    const rec = ring.find((r) => r.payload.id === payload.id)!
    assert.equal(rec.payload.requestedAt, payload.requestedAt) // 环记录经 payload 内嵌自动携带
    assert.equal((rec as unknown as Record<string, unknown>)['requestedAt'], undefined) // 无顶层冗余字段
  } finally {
    eventBus.off(EVENTS.ASK_REQUESTED, off)
  }
})

test('ApprovalChannel：payload 折进 requestedAt（desktop/mobile 起源同构）+ 落定环内嵌携带', async () => {
  const ch = new ApprovalChannel()
  const seen: { toolCallId: string; requestedAt?: number }[] = []
  const off = (p: { toolCallId: string; requestedAt?: number }) => seen.push(p)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, off)
  try {
    const promise = ch.request({ toolCallId: 'tc-1', kind: 'write', path: '/tmp/x', origin: { source: 'main' } })
    assert.equal(typeof seen[0]!.requestedAt, 'number')
    ch.resolve('tc-1', { approved: true }, 'local')
    await promise
    const rec = ch.listRecentSettled().find((r) => r.payload.toolCallId === 'tc-1')!
    assert.equal(rec.payload.requestedAt, seen[0]!.requestedAt)
  } finally {
    eventBus.off(EVENTS.APPROVAL_REQUESTED, off)
  }
})

// ---------- 标准 4-6：信封 originalTs（桥投递捕获） ----------

function makeBridge() {
  const desk = generateKeyPair()
  const phone = generateKeyPair()
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)
  const transport: RelayTransport = { connect: async () => {}, close: () => {}, connected: true, onMessage: () => {}, onClose: () => {} }
  const posts: { path: string; body: { blob?: string } }[] = []
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      if (method === 'POST') posts.push({ path, body: (opts.body ?? {}) as never })
      return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
    },
  }
  let settledAsks: SettledAskRecord[] = []
  const bridge = new RelayBridge({
    transport, http, secrets, myBox, peerBox,
    deskPub: desk.publicKey, phonePub: phone.publicKey,
    deviceName: 't', pairingToken: 't', confirmed: true,
    enqueue: async (text) => ({ content: text, aborted: false }),
    resolveApproval: () => true, listPendingApprovals: () => [],
    resolveAsk: () => true, listPendingAsks: () => [],
    listRecentSettledAsks: () => settledAsks,
    onAlarm: () => {},
  })
  bridge.start()
  const readEnvs = (): Envelope[] =>
    posts
      .filter((p) => p.path === `/box/${peerBox}` && typeof p.body.blob === 'string')
      .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
      .filter((d) => d.ok)
      .map((d) => (d as { ok: true; envelope: Envelope }).envelope)
  const settle = () => new Promise((r) => setTimeout(r, 30)) // 出向 FIFO 冲刷
  return { bridge, readEnvs, settle, setSettledAsks: (l: SettledAskRecord[]) => { settledAsks = l } }
}

test('pushAskRequest：有 requestedAt → body.originalTs 等值；无 → 不上线该键（条件展开，旧端兼容）', async () => {
  const { bridge, readEnvs, settle } = makeBridge()
  bridge.pushAskRequest({ id: 'q1', question: 'q', requestedAt: 12345, sessionId: 'S1' })
  bridge.pushAskRequest({ id: 'q2', question: 'q2' }) // 无 requestedAt
  await settle()
  const envs = readEnvs().filter((e) => e.type === 'ask.request')
  assert.equal(envs.length, 2)
  assert.equal(envs[0]!.body['originalTs'], 12345)
  assert.equal('originalTs' in envs[1]!.body, false)
})

test('pushApprovalRequest 同构：originalTs 条件展开携带', async () => {
  const { bridge, readEnvs, settle } = makeBridge()
  bridge.pushApprovalRequest({ toolCallId: 'tc-9', kind: 'command', command: 'ls', origin: { source: 'main' }, requestedAt: 777 })
  await settle()
  const env = readEnvs().find((e) => e.type === 'approval.request')!
  assert.equal(env.body['originalTs'], 777)
})

test('落定环重放（resyncPendingAsks）：重放对同样携带 originalTs（三路径零分叉）', async () => {
  const { bridge, readEnvs, settle, setSettledAsks } = makeBridge()
  setSettledAsks([
    { payload: { id: 'q-old', question: 'old q', requestedAt: 555, sessionId: 'S1' }, answer: 'A', by: 'phone', settledAt: 600 },
  ])
  bridge.resyncPendingAsks()
  await settle()
  const envs = readEnvs()
  const req = envs.find((e) => e.type === 'ask.request')!
  const res = envs.find((e) => e.type === 'ask.resolved')!
  assert.equal(req.body['originalTs'], 555) // 重放的 request 钉原始时刻（钉位根治点）
  assert.equal(res.body['id'], 'q-old') // 落定通告随行（终态愈合对）
})
