import { test } from 'node:test'
import assert from 'node:assert/strict'
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
} from '../../src/services/relay/envelope.ts'
import type { RelayTransport, RelayHttp, BoxMessage } from '../../src/services/relay/RelayTransport.ts'

/**
 * 迭代 F 回归：
 * - F-1 压轴：429 拨钟（可控 deps.sleep）× 切换附着交错——A 的 final 在出向链积压期间
 *   用户切到 B，送达信封的归属戳仍为 A（旧惰性盖章会盖成 B——生产串台根因）。
 * - F-2：onSessionAttached 在 attach 路径与发言路径都触发（applyAttachment 全路径）。
 */

function makeEnv() {
  const desk: KeyPairB64 = generateKeyPair()
  const phone: KeyPairB64 = generateKeyPair()
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)
  let msgHandler: (msg: BoxMessage) => void = () => {}
  const transport: RelayTransport = {
    connect: async () => {}, close: () => {}, connected: true,
    onMessage: (cb) => { msgHandler = cb }, onClose: () => {},
  }
  const posts: Array<{ path: string; body: { blob?: string }; status: number }> = []
  /** 可控退避：第一次 POST /box（非 ack）返回 429 并挂起 sleep——测试在挂起窗口切附着 */
  let releaseSleep: (() => void) | null = null
  let throttledOnce = false
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      if (method === 'POST') {
        const isBox = !path.endsWith('/ack')
        if (isBox && !throttledOnce) {
          throttledOnce = true
          posts.push({ path, body: (opts.body ?? {}) as never, status: 429 })
          return { status: 429, json: { error: 'rate_limited' } }
        }
        posts.push({ path, body: (opts.body ?? {}) as never, status: path.endsWith('/ack') ? 204 : 201 })
        return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
      }
      return { status: 200, json: {} }
    },
  }
  const attachedEvents: Array<string | null> = []
  let currentSessionId: string | null = 's-active'
  const alarms: string[] = []
  const bridge = new RelayBridge({
    transport, http, secrets, myBox, peerBox,
    deskPub: desk.publicKey, phonePub: phone.publicKey,
    deviceName: 'F 测试', pairingToken: 't', confirmed: true,
    enqueue: async (): Promise<EnqueueResult> => ({ content: 'A 的回复', aborted: false }),
    resolveApproval: () => true,
    listPendingApprovals: () => [],
    getActiveSessionId: () => currentSessionId,
    ensureActiveSession: async (id) => { currentSessionId = id; return 'ok' as const },
    ensureNewSession: async () => 'ok' as const,
    onAlarm: (m) => alarms.push(m),
    onSessionAttached: (sid) => attachedEvents.push(sid),
    // 可控拨钟：429 退避挂起直到 releaseSleep
    sleep: () =>
      new Promise<void>((resolve) => {
        releaseSleep = resolve
      }),
  })
  bridge.start()
  const phoneSend = (text: string, id: string, sessionId?: string): void => {
    const env = makeEnvelope('chat.user', peerBox, myBox, sessionId !== undefined ? { text, sessionId } : { text })
    env.id = id
    msgHandler({ id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! })
  }
  const phoneEnvelope = (type: string, body: Record<string, unknown>): void => {
    msgHandler({ id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', makeEnvelope(type, peerBox, myBox, body))! })
  }
  const readDelivered = (): Envelope[] =>
    posts
      .filter((p) => p.status === 201 && typeof p.body.blob === 'string')
      .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
      .filter((d) => d.ok)
      .map((d) => (d as { ok: true; envelope: Envelope }).envelope)
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15))
  return { bridge, phoneSend, phoneEnvelope, readDelivered, tick, attachedEvents, alarms, getReleaseSleep: () => releaseSleep }
}

test('F-1 压轴：429 积压期间切附着——final 归属戳仍是目标会话 A（非新附着 B）', async () => {
  const env = makeEnv()
  // A 发言（显式 s-a）→ 轮次即完 → final 撞 429 挂起（可控 sleep 占住出向链）
  env.phoneSend('A 的任务', 'env-fa', 's-a')
  await env.tick()
  await env.tick()
  // 挂起窗口：用户切到 B（附着变更；旧惰性盖章此刻读 attached=新值）
  env.phoneEnvelope('session.attach', { sessionId: 's-b' })
  await env.tick()
  // 放行 429 退避 → final 重试送达
  const release = env.getReleaseSleep()
  assert.ok(release, '429 退避应挂起中（sleep 已注入）')
  release()
  await env.tick()
  await env.tick()
  const finals = env.readDelivered().filter((e) => e.type === 'chat.event' && e.body['kind'] === 'final')
  assert.equal(finals.length, 1, 'final 经重试送达')
  assert.equal(finals[0]!.body['sessionId'], 's-a', '归属戳=内容所属会话 A（生产时刻捕获）——不是积压期间的新附着 B')
})

test('F-2：onSessionAttached 在 attach 路径与发言路径都触发（applyAttachment 全路径）', async () => {
  const env = makeEnv()
  env.phoneEnvelope('session.attach', { sessionId: 's-x' })
  await env.tick()
  env.phoneSend('对 s-y 发言', 'env-fy', 's-y')
  await env.tick()
  await env.tick()
  assert.ok(env.attachedEvents.includes('s-x'), 'attach 路径触发')
  assert.ok(env.attachedEvents.includes('s-y'), '发言即附着路径触发（幂等——serve 侧 setActive 同值无害）')
})
