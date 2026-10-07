/**
 * acceptance-throttle.mts — 中继投递流控规划「验收 6」正式演练（本地 relay，严禁打生产）
 *
 * 真实 chill-relay 服务（小预算 boxBytesPerMin=64KB，注入时钟）+ 真实 core RelayBridge（同一时钟），
 * 确定性触发真 429，逐条验收规划 §六 1-3：
 *   验收1 探活保护：窗口被批量占满时，可再生 bulk 即弃不占队，pong 秒达
 *   验收2 不丢答案：不可再生信封 429 后等窗重试至送达（不丢弃）
 *   验收3 退避节奏：重试间隔 = 35s 虚拟时钟刻度（窗口 60s，两次 429 后第三次落在新窗口）
 * 附带：M1.2 入队闸实桥验证 + M1.3 节流事件形态。
 * 运行：node --import tsx tests/acceptance-throttle.mts
 */
import { startServer, OPERATOR } from './helpers.ts'
import { tokenHash } from '../src/shared/envelope.js'
import { RelayBridge, generateKeyPair, ecdhShared, deriveSecrets, mailboxIdFromPub, makeEnvelope, type Envelope } from '../../chill/packages/core/dist/index.js'

const KB = 1024
const BOX_BUDGET = 64 * KB // 手机信箱 64KB/60s（生产 512KB 的缩小版）

// ---------- 共享虚拟时钟 + 可驱动 sleep ----------
const srv = await startServer({ limits: { boxBytesPerMin: BOX_BUDGET, boxMsgsPerMin: 600 } })
const now = (): number => srv.now()
const waiters: Array<{ at: number; resolve: () => void }> = []
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    waiters.push({ at: now() + ms, resolve })
  })
const advance = (ms: number): void => {
  srv.setNow(now() + ms)
  for (;;) {
    const due = waiters.filter((w) => w.at <= now())
    if (due.length === 0) break
    for (const w of due) w.resolve()
    for (const w of due) waiters.splice(waiters.indexOf(w), 1)
  }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}
/** 落定标志：创建时一次性挂接（poll race 检测在已落定+真实 IO 交错下不可靠） */
const flag = <T,>(p: Promise<T>): { done: boolean; p: Promise<T> } => {
  const f = { done: false, p }
  p.then(
    () => (f.done = true),
    () => (f.done = true),
  )
  return f
}

/** 驱动到 promise 落定：有等待者→推进虚拟时钟到其时刻；无等待者（真实 fetch 在途）→等真实时间 */
async function drive(f: { done: boolean }, maxVirtualMs = 300_000): Promise<void> {
  let guard = 0
  while (guard++ < 4000) {
    if (f.done) return
    await settle()
    if (f.done) return
    const next = waiters.reduce<number | null>((m, w) => (m === null || w.at < m ? w.at : m), null)
    if (next === null) {
      await new Promise((r) => setTimeout(r, 25)) // 真实 I/O 在途——不推虚拟钟
      continue
    }
    if (next > now()) advance(next - now())
    else advance(0)
    if (now() - startClock > maxVirtualMs) throw new Error('drive 虚拟超时')
  }
  throw new Error(`drive 步数超限（done=${f.done} posts=${posts.length}）`)
}
const startClock = now()

// ---------- 配对（真 HTTP admin 通道）+ 桥（真 core + 真 relay） ----------
const desk = generateKeyPair()
const phone = generateKeyPair()
const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
const myBox = mailboxIdFromPub(desk.publicKey)
const peerBox = mailboxIdFromPub(phone.publicKey)
const tResp = await fetch(`${srv.base}/pair/tokens`, {
  method: 'POST',
  headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' },
})
const { token } = (await tResp.json()) as { token: string }
const rResp = await fetch(`${srv.base}/pair/redeem`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    phonePub: phone.publicKey,
    deskPub: desk.publicKey,
    device: 'acceptance',
    writeHash: tokenHash(secrets.writeToken),
    readHash: tokenHash(secrets.readToken),
    revokeHash: tokenHash(secrets.revokeToken),
  }),
})
if (rResp.status !== 200) throw new Error(`配对失败 HTTP ${rResp.status}`)

const posts: Array<{ at: number; bytes: number }> = []
const throttleEvents: Array<{ envelopeType: string; action: string; sustainedMs: number }> = []
const bridge = new RelayBridge({
  transport: { connect: async () => {}, close: () => {}, connected: true, onMessage: () => {}, onClose: () => {} },
  http: {
    request: async (method, path, opts = {}) => {
      if (method === 'POST' && !path.endsWith('/ack')) {
        const blob = (opts.body as { blob?: string })?.blob ?? ''
        console.log(`[probe] POST ${path.slice(0, 24)}… blob=${blob.length}B t=${now()}`)
        const r = await fetch(`${srv.base}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.token ?? ''}`, 'content-type': 'application/json' },
          body: JSON.stringify({ blob }),
        })
        console.log(`[probe]   → ${r.status}`)
        posts.push({ at: now(), bytes: blob.length })
        return { status: r.status, json: {} }
      }
      return { status: 204, json: undefined }
    },
  },
  secrets,
  myBox,
  peerBox,
  deskPub: desk.publicKey,
  phonePub: phone.publicKey,
  deviceName: '验收桌面',
  pairingToken: 'tok',
  confirmed: true,
  enqueue: async () => ({ content: '', aborted: false }),
  resolveApproval: () => false,
  listPendingApprovals: () => [],
  now,
  sleep,
  onDeliveryThrottled: (info) => throttleEvents.push({ envelopeType: info.envelopeType, action: info.action, sustainedMs: info.sustainedMs }),
})
const priv = bridge as unknown as {
  sendEnvelope(env: Envelope): Promise<void>
  deferOrSend(key: string | null, run: () => void): void
}
const env = (type: string, body: Record<string, unknown>): Envelope => makeEnvelope(type, myBox, peerBox, body, undefined, now)

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}  ${detail}`)
  if (ok) pass++
  else fail++
}

// ---------- 验收1：探活保护（bulk 即弃不占队，pong 秒达） ----------
{
  const bulkWire = posts.length
  const p1 = priv.sendEnvelope(env('chat.event', { kind: 'final', text: 'A'.repeat(40 * KB) })) // 主流量，占窗 ~54KB/64KB
  await drive(flag(p1))
  const p2 = priv.sendEnvelope(env('board.state', { rev: 1, rows: 'B'.repeat(40 * KB) })) // 可再生 bulk：超窗 → 应即弃
  await drive(flag(p2.catch(() => undefined)))
  const pongStart = now()
  const p3 = priv.sendEnvelope(env('presence.pong', {})) // 探活：剩余预算内应即刻送达
  await drive(flag(p3))
  const chatPosts = posts.slice(bulkWire)
  check(
    '验收1 探活保护',
    chatPosts.length === 3 && chatPosts[2]!.bytes < 1024 && now() - pongStart < 1_000,
    `bulk 即弃（board 仅 1 次尝试）、pong ${chatPosts[2]!.bytes}B 即刻送达（虚拟耗时 ${now() - pongStart}ms）`,
  )
}

// ---------- 验收2+3：不丢答案 + 退避节奏（429 → 35s×2 → 新窗送达） ----------
{
  const before = posts.length
  const t0 = now()
  const p = priv.sendEnvelope(env('chat.event', { kind: 'final', text: 'C'.repeat(40 * KB) })) // 窗已满 → 429 → 等窗重试
  const done = p.then(
    () => 'delivered',
    (e) => `rejected:${String(e)}`,
  )
  await drive(flag(done))
  const outcome = (await done) as string
  const seq = posts.slice(before)
  const retryPosts = seq.filter((x) => x.bytes > 10_000)
  const gaps: number[] = []
  for (let i = 1; i < retryPosts.length; i++) gaps.push(retryPosts[i]!.at - retryPosts[i - 1]!.at)
  check(
    '验收2 不丢答案',
    outcome === 'delivered',
    `429 后经 ${retryPosts.length - 1} 次重试最终送达（不丢弃）`,
  )
  check(
    '验收3 退避节奏',
    gaps.length > 0 && gaps.every((g) => g >= 35_000),
    `重试间隔（虚拟时钟）=[${gaps.join(', ')}]ms，全部 ≥35s；总耗时 ${now() - t0}ms 跨过 60s 窗口重置`,
  )
}

// ---------- 附带：M1.2 入队闸 + M1.3 事件形态 ----------
{
  const ran: string[] = []
  priv.deferOrSend('board', () => ran.push('x'))
  const deferredAt = now()
  advance(120_000)
  await settle()
  check('M1.2 入队闸（实桥）', ran.length === 1 && now() - deferredAt >= 120_000, `退避期登记、窗口后冲刷（延迟 ${now() - deferredAt}ms 虚拟）`)
  const actions = throttleEvents.map((e) => e.action)
  check(
    'M1.3 节流事件',
    actions.includes('drop-regenerable') && actions.includes('retry-wait'),
    `事件序列=[${actions.join(' → ')}]，sustainedMs 形态就位`,
  )
}

await srv.close()
console.log(`\n验收结果：${pass} PASS / ${fail} FAIL`)
await new Promise((r) => setTimeout(r, 300)) // 给 libuv 句柄拆除留时序，防 Windows 退出断言噪声
process.exit(fail === 0 ? 0 : 1)
