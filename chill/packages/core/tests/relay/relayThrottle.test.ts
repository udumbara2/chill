/**
 * relayThrottle.test.ts — 投递流控单测（中继投递流控规划 M1.4）
 *
 * 覆盖：M1.1 可再生性分治（不可重生试成功/超限丢弃；可再生即弃零重试）、
 * M1.2 入队闸（退避期延迟 + 同键折叠 + null 键保序）、catalog 分包组原子性（组内片撞 429 整组作废）、
 * stop() 取消在途退避（serve 优雅自退不被 35s 挂住）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayBridge } from '../../src/services/relay/RelayBridge.ts'
import {
  generateKeyPair,
  ecdhShared,
  deriveSecrets,
  mailboxIdFromPub,
  makeEnvelope,
  type Envelope,
  type KeyPairB64,
} from '../../src/services/relay/envelope.ts'
import type { RelayTransport, RelayHttp } from '../../src/services/relay/RelayTransport.ts'

/** 流控测试环境：真实双端密钥 + 可编程 http + 可注入 sleep/now（sleep 即拨时钟） */
function makeEnv(over: { sleep?: (ms: number) => Promise<void> } = {}) {
  const desk: KeyPairB64 = generateKeyPair()
  const phone: KeyPairB64 = generateKeyPair()
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)
  const transport: RelayTransport = {
    connect: async () => {},
    close: () => {},
    connected: true,
    onMessage: () => {},
    onClose: () => {},
  }
  const posts: { path: string; blob: string }[] = []
  let statuses: number[] = []
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      if (method === 'POST' && !path.endsWith('/ack')) {
        posts.push({ path, blob: (opts.body as { blob?: string })?.blob ?? '' })
        const st = statuses.length > 0 ? statuses.shift()! : 201
        return { status: st, json: { id: 1 } }
      }
      return { status: 204, json: undefined }
    },
  }
  const sleepCalls: number[] = []
  const throttleEvents: { envelopeType: string; action: string; sustainedMs: number }[] = []
  let nowMs = 1_000_000
  const defaultSleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms)
    // 隔一个真实 tick 再拨时钟——同步拨钟会让同刻的后续 deferOrSend 误判退避已过（测试工件，非产品缺陷）
    await new Promise((r) => setTimeout(r, 0))
    nowMs += ms
  }
  const bridge = new RelayBridge({
    transport,
    http,
    secrets,
    myBox,
    peerBox,
    deskPub: desk.publicKey,
    phonePub: phone.publicKey,
    deviceName: '测试桌面',
    pairingToken: 'tok',
    confirmed: true,
    enqueue: async () => ({ content: '', aborted: false }),
    resolveApproval: () => false,
    listPendingApprovals: () => [],
    now: () => nowMs,
    sleep: over.sleep ?? defaultSleep,
    onDeliveryThrottled: (info) =>
      throttleEvents.push({ envelopeType: info.envelopeType, action: info.action, sustainedMs: info.sustainedMs }),
  })
  const priv = bridge as unknown as {
    sendEnvelope(env: Envelope): Promise<void>
    sendCatalogStateNow(state: unknown, replyTo?: string): Promise<void>
    deferOrSend(key: string | null, run: () => void): void
    throttledUntil: number
  }
  const env = (type: string, body: Record<string, unknown> = {}): Envelope =>
    makeEnvelope(type, myBox, peerBox, body, undefined, () => nowMs)
  return {
    bridge,
    priv,
    env,
    posts,
    sleepCalls,
    throttleEvents,
    setNow: (n: number) => {
      nowMs = n
    },
    getNow: () => nowMs,
    /** 设定后续 POST 响应状态序列（闭包可见——直接改返回属性 mock 看不到） */
    setStatuses: (arr: number[]) => {
      statuses = arr
    },
  }
}

test('A1 不可再生信封：429×2 后重试成功（35s 等窗×2、不丢弃）', async () => {
  const t = makeEnv()
  t.setStatuses([429, 429, 201])
  await t.priv.sendEnvelope(t.env('chat.event', { kind: 'final', text: 'hi' }))
  assert.equal(t.posts.length, 3, '共三次 POST')
  assert.deepEqual(t.sleepCalls, [35_000, 35_000], '每次 429 等一个窗口半程')
  assert.deepEqual(t.throttleEvents.map((e) => e.action), ['retry-wait', 'retry-wait'], '两次均为重试事件')
})

test('A2 不可再生信封：恒 429 → 1+5 次后超限丢弃 + drop-exhausted 事件', async () => {
  const t = makeEnv()
  t.setStatuses(Array<number>(10).fill(429))
  await assert.rejects(t.priv.sendEnvelope(t.env('notice', {})), /重试超限/)
  assert.equal(t.posts.length, 6, '首发+5 次重试')
  assert.equal(t.sleepCalls.length, 5, '第 6 次不再等待直接弃')
  assert.equal(t.throttleEvents[t.throttleEvents.length - 1]!.action, 'drop-exhausted')
})

test('A3 可再生信封：撞 429 即弃（单次 POST、零 sleep、drop-regenerable）——防 FIFO 头阻塞 175s', async () => {
  const t = makeEnv()
  t.setStatuses([429, 201, 201])
  await assert.rejects(t.priv.sendEnvelope(t.env('board.state', { rev: 1 })), /可再生/)
  assert.equal(t.posts.length, 1, '不重试')
  assert.equal(t.sleepCalls.length, 0, '零等待')
  assert.deepEqual(t.throttleEvents.map((e) => e.action), ['drop-regenerable'])
})

test('A4 入队闸：退避期延迟 + 同键折叠（board 最新胜）+ null 键保序追加', async () => {
  const t = makeEnv()
  t.priv.throttledUntil = t.getNow() + 10_000
  const ran: string[] = []
  t.priv.deferOrSend('board', () => ran.push('board-1'))
  t.priv.deferOrSend('board', () => ran.push('board-2'))
  t.priv.deferOrSend(null, () => ran.push('history-a'))
  assert.deepEqual(ran, [], '退避期一律不执行')
  await new Promise((r) => setTimeout(r, 20)) // 冲刷经注入 sleep 即时完成
  assert.deepEqual(ran, ['board-2', 'history-a'], '同键折叠留最新，null 键按序保留')
})

test('A5 stop()：取消在途 35s 等待（serve 优雅自退不被挂住）', async () => {
  const neverSleep = (): Promise<void> => new Promise<void>(() => {})
  const t = makeEnv({ sleep: neverSleep })
  t.setStatuses(Array<number>(10).fill(429))
  const p = t.priv.sendEnvelope(t.env('chat.event', {}))
  const caught = p.catch((e) => String(e))
  await new Promise((r) => setTimeout(r, 10))
  t.bridge.stop()
  assert.equal(await caught, 'Error: bridge 已停止')
})

test('A6 catalog 分包组原子性：组内第 2 片撞 429 → 整组作废（第 3 片不再发）', async () => {
  const t = makeEnv()
  t.setStatuses([201, 429, 201, 201])
  // 3 个 ~30KB 的会话条目 → 45KB 预算切成 3 片
  const sessions = [1, 2, 3].map((i) => ({ id: `s${i}`, title: 'A'.repeat(30_000), updated: '2026-10-03' }))
  await assert.rejects(
    t.priv.sendCatalogStateNow({ sessions, projects: [], activeSessionId: null, projectsRev: 1, full: true }),
    /可再生/,
  )
  assert.equal(t.posts.length, 2, 'chunk0 成功、chunk1 弃、chunk2 永不发')
})
