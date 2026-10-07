import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayBridge, type EnqueueResult, type PendingRoundEntry } from '../../src/services/relay/RelayBridge.ts'
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
 * M7增量3·决策30/31：台账驱动的投递状态机测试。
 * 五分支穷举（deny / pre-persist 失败 / 台账写失败 / 正常收录 / 收录后轮次失败）
 * + 崩溃窗口收敛（重投尾部同文 / 台账命中续跑 / 启动扫账）。
 */

type EnqueueMode = 'ok' | 'deny' | 'throw-pre' | 'throw-post'

interface LedgerEnvOptions {
  enqueueMode?: EnqueueMode
  ledgerSaveFails?: boolean
  initialLedger?: PendingRoundEntry[]
  tail?: { role: string; content: string } | null
  resumeResult?: { content: string; aborted: boolean } | null
  startBridge?: boolean
}

function makeLedgerEnv(over: LedgerEnvOptions = {}) {
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
      if (method === 'POST') posts.push({ path, token: opts.token ?? '', body: (opts.body ?? {}) as never })
      return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
    },
  }

  const enqueued: string[] = []
  const ingestFired: string[] = []
  const alarms: string[] = []
  const seenSaved: string[][] = []
  const resumeCalls: number[] = []
  const ensureCalls: string[] = []
  let ledger: PendingRoundEntry[] = [...(over.initialLedger ?? [])]
  let enqueueMode: EnqueueMode = over.enqueueMode ?? 'ok'
  let tail = over.tail ?? null

  const bridge = new RelayBridge({
    transport,
    http,
    secrets,
    myBox,
    peerBox,
    deskPub: desk.publicKey,
    phonePub: phone.publicKey,
    deviceName: '测试桌面',
    pairingToken: 'token',
    confirmed: true,
    enqueue: async (input, opts): Promise<EnqueueResult> => {
      const text = input.text
      enqueued.push(text)
      if (enqueueMode === 'throw-pre') throw new Error('注入即炸')
      if (enqueueMode === 'ok' || enqueueMode === 'throw-post') {
        if (opts?.onIngested) {
          ingestFired.push(text)
          await opts.onIngested()
        }
      }
      if (enqueueMode === 'throw-post') throw new Error('轮次进行中炸了')
      if (enqueueMode === 'deny') return { content: '', aborted: false, deniedReason: '含敏感词' }
      return { content: `回复:${text}`, aborted: false }
    },
    resolveApproval: () => true,
    listPendingApprovals: () => [],
    onAlarm: (m) => alarms.push(m),
    loadSeenIds: async () => [],
    saveSeenIds: async (ids) => {
      seenSaved.push([...ids])
    },
    loadPendingRounds: async () => [...ledger],
    savePendingRounds: async (entries) => {
      if (over.ledgerSaveFails) throw new Error('盘满')
      ledger = [...entries]
    },
    resumeRound: async () => {
      resumeCalls.push(1)
      return over.resumeResult === undefined ? { content: '恢复的回复', aborted: false } : over.resumeResult
    },
    peekSessionTail: async () => tail,
    getActiveSessionId: () => 's1',
    ensureActiveSession: async (id) => {
      ensureCalls.push(id)
      return 'ok'
    },
  })
  if (over.startBridge !== false) bridge.start()

  function phoneSend(text: string, envId?: string, sessionId?: string): BoxMessage {
    const env = makeEnvelope('chat.user', peerBox, myBox, sessionId !== undefined ? { text, sessionId } : { text })
    if (envId) env.id = envId
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  function readPostedEnvelopes(): Envelope[] {
    const out: Envelope[] = []
    for (const p of posts) {
      if (p.path === `/box/${peerBox}` && typeof p.body.blob === 'string') {
        const dec = decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob)
        if (dec.ok) out.push(dec.envelope)
      }
    }
    return out
  }
  const acks = () => posts.filter((p) => p.path.endsWith('/ack')).map((p) => p.body.id)
  async function feed(msg: BoxMessage): Promise<void> {
    msgHandler(msg)
    await new Promise((r) => setTimeout(r, 25))
  }
  return {
    bridge: () => bridge,
    phoneSend,
    readPostedEnvelopes,
    acks,
    feed,
    enqueued,
    ingestFired,
    alarms,
    seenSaved,
    resumeCalls,
    ensureCalls,
    ledger: () => ledger,
    setEnqueueMode: (m: EnqueueMode) => {
      enqueueMode = m
    },
    setTail: (t: { role: string; content: string } | null) => {
      tail = t
    },
  }
}

test('分支③+settle成功：正常轮——ACK 恰一次(ingest 时)、final 推送、台账先记后清、seen 落盘', async () => {
  const env = makeLedgerEnv()
  await env.feed(env.phoneSend('正常消息', 'E-ok', 's1'))
  assert.deepEqual(env.enqueued, ['正常消息'])
  assert.deepEqual(env.ingestFired, ['正常消息'])
  assert.equal(env.acks().length, 1)
  const finals = env.readPostedEnvelopes().filter((e) => e.body['kind'] === 'final')
  assert.equal(finals.length, 1)
  assert.equal(finals[0].body['text'], '回复:正常消息')
  assert.deepEqual(env.ledger(), [], '轮次落定后台账应清空')
  assert.ok(env.seenSaved.some((ids) => ids.includes('E-ok')), 'settle 后 envelope 落 seen-ids')
})

test('分支①：deny——ACK+拦截 notice，不写台账不落 seen，onIngested 不触发', async () => {
  const env = makeLedgerEnv({ enqueueMode: 'deny' })
  await env.feed(env.phoneSend('危险', 'E-deny', 's1'))
  assert.equal(env.ingestFired.length, 0)
  assert.equal(env.acks().length, 1)
  const notices = env.readPostedEnvelopes().filter((e) => e.body['kind'] === 'notice')
  assert.ok(notices.some((n) => String(n.body['text']).includes('消息被拦截')))
  assert.deepEqual(env.ledger(), [])
  assert.ok(!env.seenSaved.some((ids) => ids.includes('E-deny')))
})

test('分支②：pre-persist 失败——不 ACK、撤内存标记；重投后成功收敛（重投能再注入）', async () => {
  const env = makeLedgerEnv({ enqueueMode: 'throw-pre' })
  const msg = env.phoneSend('第一次会炸', 'E-pre', 's1')
  await env.feed(msg)
  assert.equal(env.acks().length, 0, '什么都没落盘 → 不 ACK 等重投')
  assert.ok(env.alarms.some((a) => a.includes('未 ACK 将重投')))
  assert.deepEqual(env.ledger(), [])
  // 服务器重投（同信封 id）→ 内存标记已撤销 → 重新注入，这次成功
  env.setEnqueueMode('ok')
  await env.feed({ ...msg, id: msg.id + 50 })
  assert.deepEqual(env.enqueued, ['第一次会炸', '第一次会炸'], '重投应重新注入（第一次没有收录）')
  assert.equal(env.acks().length, 1)
})

test('分支⑤：收录后轮次失败——ACK(已发)+失败 notice+清账+落 seen（永不沉默）', async () => {
  const env = makeLedgerEnv({ enqueueMode: 'throw-post' })
  await env.feed(env.phoneSend('会失败的轮', 'E-post', 's1'))
  assert.deepEqual(env.ingestFired, ['会失败的轮'])
  assert.equal(env.acks().length, 1, 'ingest 时已 ACK（投递与处理解耦）')
  const notices = env.readPostedEnvelopes().filter((e) => e.body['kind'] === 'notice')
  assert.ok(notices.some((n) => String(n.body['text']).includes('本轮处理失败')), '手机必须收到失败回执')
  assert.deepEqual(env.ledger(), [], '失败也是落定 → 清账')
  assert.ok(env.seenSaved.some((ids) => ids.includes('E-post')))
  // 再重投：seen 命中 → 静默 ACK，不重复注入
  const msg2 = env.phoneSend('会失败的轮', 'E-post', 's1')
  await env.feed(msg2)
  assert.equal(env.enqueued.length, 1)
  assert.equal(env.acks().length, 2)
})

test('分支③异常路径：台账写失败——不 ACK（安全不对称），轮次照常完成', async () => {
  const env = makeLedgerEnv({ ledgerSaveFails: true })
  await env.feed(env.phoneSend('盘满时的消息', 'E-full', 's1'))
  assert.equal(env.ingestFired.length, 1)
  assert.equal(env.acks().length, 0, '台账写失败绝不 ACK（防无台账 ACK+崩溃=永无回音）')
  assert.ok(env.alarms.some((a) => a.includes('台账')))
  const finals = env.readPostedEnvelopes().filter((e) => e.body['kind'] === 'final')
  assert.equal(finals.length, 1, '轮次本身照常完成（final 仍推送）')
})

test('崩溃窗口·尾部同文：重投命中"消息已在盘"→ 不重复注入，ACK+续跑+final', async () => {
  const env = makeLedgerEnv({ tail: { role: 'user', content: '崩溃窗口里的消息' } })
  const msg = env.phoneSend('崩溃窗口里的消息', 'E-win', 's1')
  await env.feed(msg)
  assert.deepEqual(env.enqueued, [], '消息已在盘上 → 绝不重复 append')
  assert.equal(env.acks().length, 1)
  assert.equal(env.resumeCalls.length, 1, '走恢复路径续跑')
  const finals = env.readPostedEnvelopes().filter((e) => e.body['kind'] === 'final')
  assert.ok(finals.some((f) => f.body['text'] === '恢复的回复' && f.replyTo === 'E-win'))
  assert.deepEqual(env.ledger(), [])
})

test('崩溃窗口·台账命中：收录后未落定的重投 → ACK+续跑，不重复注入', async () => {
  const env = makeLedgerEnv({
    initialLedger: [{ envelopeId: 'E-crash', sessionId: 's1', text: '崩溃前发的', replyTo: 'E-crash', createdAt: '2026-09-26T05:00:00.000Z' }],
    tail: { role: 'user', content: '崩溃前发的' },
    startBridge: false,
  })
  env.bridge().start()
  await new Promise((r) => setTimeout(r, 25)) // 启动扫账先跑（tail 命中 → 续跑）
  assert.equal(env.resumeCalls.length, 1)
  assert.deepEqual(env.ledger(), [], '启动扫账清账')
  // 续跑落定后服务器重投同信封：seen 未含（未走 settle 落盘）→ 走尾部检测（此时尾部已是 assistant）
  // → 台账空、尾部非原 text → 不注入，ACK 收敛（答案此前已经 resume 路径 final 回执）
  env.setTail({ role: 'assistant', content: '恢复的回复' })
  const msg = env.phoneSend('崩溃前发的', 'E-crash', 's1')
  await env.feed(msg)
  assert.deepEqual(env.enqueued, [], '绝不重复注入')
  assert.equal(env.acks().length, 1, '重投被 ACK 收敛')
})

test('崩溃窗口·启动扫账·尾部已回复：清账即可（幂等收敛，无需续跑）', async () => {
  const env = makeLedgerEnv({
    initialLedger: [{ envelopeId: 'E-settled', sessionId: 's1', text: '其实已回复', replyTo: 'E-settled', createdAt: '2026-09-26T05:00:00.000Z' }],
    tail: { role: 'assistant', content: '上次崩前的回复' },
  })
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(env.resumeCalls.length, 0, '尾部已回复 → 不续跑')
  assert.deepEqual(env.ledger(), [], '清账收敛')
})
