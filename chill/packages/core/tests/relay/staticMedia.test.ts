/**
 * staticMedia.test.ts — 媒体直传桥级测试：static offer → 异步拉取 → 解密 → 对账 → 落盘 → receipt。
 * 覆盖：全链路/未装配/404 重试自愈/密钥错/哈希不符/重复 offer 幂等/abort 迟到作废/不阻塞信箱排空/畸形参数。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import {
  RelayBridge,
  type EnqueueResult,
  type EnqueueInput,
} from '../../src/services/relay/RelayBridge'
import {
  generateKeyPair,
  ecdhShared,
  deriveSecrets,
  encryptEnvelope,
  decryptEnvelope,
  makeEnvelope,
  mailboxIdFromPub,
  sealMediaBlob,
  type Envelope,
  type DerivedSecrets,
  type FileOfferBody,
  type FileReceiptBody,
} from '../../src/services/relay/envelope'
import type { RelayTransport, RelayHttp, BoxMessage } from '../../src/services/relay/RelayTransport'

interface StaticEnv {
  feed: (msg: BoxMessage) => Promise<void>
  phone: (type: string, body: Record<string, unknown>) => BoxMessage
  posted: () => Envelope[]
  acks: () => number[]
  enqueued: EnqueueInput[]
  saved: Array<{ bytes: Uint8Array; name: string }>
  mediaStore: Map<string, Uint8Array>
  setFetch: (impl: (name: string) => Promise<Uint8Array>) => void
}

function makeStaticEnv(over: { noFetchMedia?: boolean } = {}): StaticEnv {
  const desk = generateKeyPair()
  const phone = generateKeyPair()
  const shared = ecdhShared(phone.secretKey, desk.publicKey)
  const secrets: DerivedSecrets = deriveSecrets(shared)
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  let msgHandler: (m: BoxMessage) => void = () => {}
  const transport: RelayTransport = {
    connect: async () => {},
    close: () => {},
    onClose: () => {},
    onMessage: (h) => {
      msgHandler = h
    },
  }
  const http: RelayHttp = {
    request: async (method, path, opts) => {
      posts.push({ path, body: (opts?.body ?? {}) as Record<string, unknown> })
      return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
    },
  }
  const enqueued: EnqueueInput[] = []
  const saved: Array<{ bytes: Uint8Array; name: string }> = []
  const mediaStore = new Map<string, Uint8Array>()
  let fetchImpl: (name: string) => Promise<Uint8Array> = async (name) => {
    const hit = mediaStore.get(name)
    if (!hit) throw new Error('HTTP 404')
    return hit
  }
  const deps: Record<string, unknown> = {
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
    enqueue: async (input: EnqueueInput): Promise<EnqueueResult> => {
      enqueued.push(input)
      return { content: `回复:${input.text}`, aborted: false }
    },
    resolveApproval: () => true,
    listPendingApprovals: () => [],
    getActiveSessionId: () => 's1',
    onAlarm: () => {},
    loadSeenIds: async () => [],
    saveSeenIds: async () => {},
    saveAttachment: async (bytes: Uint8Array, name: string) => {
      saved.push({ bytes, name })
      return `2026/09/${name}`
    },
    resolveAttachments: async (settled: Array<{ fileId: string; name: string; savedRef: string; size: number }>) => ({
      refText: settled.map((s) => `[附件] ${s.name}（/att/${s.savedRef}，${s.size}B）`).join('\n'),
      attachmentRefs: settled.map((s) => ({ ref: s.fileId, name: s.name, mime: 'application/octet-stream' })),
    }),
    ...(over.noFetchMedia ? {} : { fetchMedia: (name: string) => fetchImpl(name) }),
  }
  const bridge = new RelayBridge(deps as never)
  bridge.start()
  return {
    feed: async (msg) => {
      msgHandler(msg)
      await new Promise((r) => setTimeout(r, 30))
    },
    phone: (type, body) => {
      const env = makeEnvelope(type, peerBox, myBox, body)
      return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
    },
    posted: () =>
      posts
        .filter((p) => p.path === `/box/${peerBox}` && typeof p.body['blob'] === 'string')
        .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body['blob'] as string))
        .filter((d) => d.ok)
        .map((d) => (d.ok ? d.envelope : null))
        .filter((e): e is Envelope => e !== null),
    acks: () => posts.filter((p) => p.path.endsWith('/ack')).map((p) => p.body['id'] as number),
    enqueued,
    saved,
    mediaStore,
    setFetch: (impl) => {
      fetchImpl = impl
    },
  }
}

const hex32 = (c: string): string => c.repeat(32)
const receiptsOf = (env: StaticEnv) => env.posted().filter((e) => e.type === 'file.receipt')

/** 轮询等待条件成立（异步拉取完成时点不确定） */
async function until(cond: () => boolean, ms = 1500): Promise<boolean> {
  for (let i = 0; i < ms / 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 20))
  return cond()
}

test('static 全链路：发布→offer→异步拉取→解密→对账→落盘→receipt ok；chat.user attachments 解析零改动', async () => {
  const env = makeStaticEnv()
  const plain = new Uint8Array(300)
  for (let i = 0; i < plain.length; i++) plain[i] = (i * 7) % 251
  const sealed = sealMediaBlob(plain)
  const mediaName = hex32('c') + '.bin'
  const offer: FileOfferBody = {
    fileId: 'sf1', name: 'photo.jpg', mime: 'image/jpeg', size: plain.length,
    sha256: bytesToHex(sha256(plain)), chunks: 0,
    static: { name: mediaName, key: sealed.keyB64u },
  }
  env.mediaStore.set(mediaName, sealed.wire)
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  assert.equal(env.acks().length, 1, '立即 ACK')
  assert.ok(await until(() => receiptsOf(env).length === 1), 'receipt 到达')
  assert.equal((receiptsOf(env)[0].body as unknown as FileReceiptBody).ok, true)
  assert.equal(env.saved.length, 1)
  assert.deepEqual(env.saved[0].bytes, plain)
  assert.equal(env.saved[0].name, 'photo.jpg')
  // settled 注册表同形 → chat.user attachments 走既有解析（零改动断言）
  await env.feed(env.phone('chat.user', { text: '看看', sessionId: 's1', attachments: [{ fileId: 'sf1', name: 'photo.jpg', mime: 'image/jpeg' }] }))
  assert.equal(env.enqueued.length, 1)
  assert.deepEqual(env.enqueued[0].attachmentRefs, [{ ref: 'sf1', name: 'photo.jpg', mime: 'application/octet-stream' }])
})

test('未装配 fetchMedia：static offer 诚实拒绝（receipt ok:false）', async () => {
  const env = makeStaticEnv({ noFetchMedia: true })
  const plain = new Uint8Array(8)
  const sealed = sealMediaBlob(plain)
  const offer: FileOfferBody = {
    fileId: 'sf2', name: 'a.bin', mime: '', size: plain.length,
    sha256: bytesToHex(sha256(plain)), chunks: 0,
    static: { name: hex32('a') + '.bin', key: sealed.keyB64u },
  }
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  const r = receiptsOf(env).at(-1)
  assert.ok(r)
  assert.equal((r!.body as unknown as FileReceiptBody).ok, false)
  assert.match(String((r!.body as unknown as FileReceiptBody).error), /未装配媒体拉取/)
})

test('拉取 404 → receipt ok:false → 手机重试（媒体补位后）成功——自愈', async () => {
  const env = makeStaticEnv()
  const plain = new Uint8Array(16)
  const sealed = sealMediaBlob(plain)
  const mediaName = hex32('d') + '.bin'
  const offer: FileOfferBody = {
    fileId: 'sf3', name: 'a.bin', mime: '', size: plain.length,
    sha256: bytesToHex(sha256(plain)), chunks: 0,
    static: { name: mediaName, key: sealed.keyB64u },
  }
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  assert.ok(await until(() => receiptsOf(env).length === 1))
  assert.equal((receiptsOf(env)[0].body as unknown as FileReceiptBody).ok, false, '404 诚实回执')
  // 媒体补位后手机重发同一 offer → 成功
  env.mediaStore.set(mediaName, sealed.wire)
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  assert.ok(await until(() => receiptsOf(env).length === 2 && (receiptsOf(env)[1].body as unknown as FileReceiptBody).ok))
  assert.equal(env.saved.length, 1)
})

test('密钥错（AEAD 验真失败）→ receipt ok:false', async () => {
  const env = makeStaticEnv()
  const plain = new Uint8Array(12)
  const sealed = sealMediaBlob(plain)
  const wrongKey = sealMediaBlob(new Uint8Array(1)).keyB64u
  const offer: FileOfferBody = {
    fileId: 'sf4', name: 'a.bin', mime: '', size: plain.length,
    sha256: bytesToHex(sha256(plain)), chunks: 0,
    static: { name: hex32('e') + '.bin', key: wrongKey },
  }
  env.mediaStore.set(hex32('e') + '.bin', sealed.wire)
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  assert.ok(await until(() => receiptsOf(env).length === 1))
  assert.equal((receiptsOf(env)[0].body as unknown as FileReceiptBody).ok, false)
  assert.match(String((receiptsOf(env)[0].body as unknown as FileReceiptBody).error), /解密失败/)
  assert.equal(env.saved.length, 0)
})

test('sha256 不符（offer 带错哈希）→ receipt ok:false', async () => {
  const env = makeStaticEnv()
  const plain = new Uint8Array(20)
  const sealed = sealMediaBlob(plain)
  const offer: FileOfferBody = {
    fileId: 'sf5', name: 'a.bin', mime: '', size: plain.length,
    sha256: 'f'.repeat(64), chunks: 0, // 错哈希
    static: { name: hex32('f') + '.bin', key: sealed.keyB64u },
  }
  env.mediaStore.set(hex32('f') + '.bin', sealed.wire)
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  assert.ok(await until(() => receiptsOf(env).length === 1))
  assert.match(String((receiptsOf(env)[0].body as unknown as FileReceiptBody).error), /校验失败/)
})

test('重复 offer（已完成）→ 幂等 receipt，不重复落盘；在途重复 offer 不重启拉取', async () => {
  const env = makeStaticEnv()
  let fetchCalls = 0
  env.setFetch(async (name) => {
    fetchCalls++
    const hit = env.mediaStore.get(name)
    if (!hit) throw new Error('HTTP 404')
    return hit
  })
  const plain = new Uint8Array(9)
  const sealed = sealMediaBlob(plain)
  const offer: FileOfferBody = {
    fileId: 'sf6', name: 'a.bin', mime: '', size: plain.length,
    sha256: bytesToHex(sha256(plain)), chunks: 0,
    static: { name: hex32('1') + '.bin', key: sealed.keyB64u },
  }
  env.mediaStore.set(hex32('1') + '.bin', sealed.wire)
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>)) // 在途重复（若拉取已完成则走 settled 幂等）
  assert.ok(await until(() => receiptsOf(env).length >= 1))
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>)) // 已完成重复
  assert.ok(await until(() => receiptsOf(env).length >= 2), '重复 offer 至少补发一次 receipt')
  assert.ok((receiptsOf(env).every((r) => (r.body as unknown as FileReceiptBody).ok)))
  assert.equal(env.saved.length, 1)
  assert.equal(fetchCalls, 1, '重复 offer 不重启拉取')
})

test('abort 在途 → 迟到拉取结果作废（无 receipt、不落盘）', async () => {
  const env = makeStaticEnv()
  let resolveFetch!: (v: Uint8Array) => void
  env.setFetch(() => new Promise<Uint8Array>((r) => { resolveFetch = r }))
  const plain = new Uint8Array(6)
  const sealed = sealMediaBlob(plain)
  const offer: FileOfferBody = {
    fileId: 'sf7', name: 'a.bin', mime: '', size: plain.length,
    sha256: bytesToHex(sha256(plain)), chunks: 0,
    static: { name: hex32('2') + '.bin', key: sealed.keyB64u },
  }
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  await env.feed(env.phone('file.abort', { fileId: 'sf7', reason: '用户取消' }))
  resolveFetch(sealed.wire)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(receiptsOf(env).length, 0, '作废：无 receipt')
  assert.equal(env.saved.length, 0, '作废：不落盘')
})

test('不阻塞信箱排空：拉取慢速进行中，后续 chat.user 照常注入', async () => {
  const env = makeStaticEnv()
  env.setFetch(() => new Promise<Uint8Array>((r) => setTimeout(() => r(new Uint8Array(4)), 200)))
  const offer: FileOfferBody = {
    fileId: 'sf8', name: 'a.bin', mime: '', size: 4,
    sha256: bytesToHex(sha256(new Uint8Array(4))), chunks: 0,
    static: { name: hex32('3') + '.bin', key: sealMediaBlob(new Uint8Array(4)).keyB64u },
  }
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  // 拉取 200ms 进行中——普通消息必须照常处理（inline await 会卡 200ms+）
  await env.feed(env.phone('chat.user', { text: '别的消息', sessionId: 's1' }))
  assert.equal(env.enqueued.length, 1, '排空不被媒体拉取阻塞')
})

test('畸形 static offer：坏名形/坏密钥/超帽 → receipt ok:false 参数不合法', async () => {
  const env = makeStaticEnv()
  const plain = new Uint8Array(4)
  const sealed = sealMediaBlob(plain)
  const cases: FileOfferBody[] = [
    { fileId: 'x1', name: 'a.bin', mime: '', size: 4, sha256: bytesToHex(sha256(plain)), chunks: 0, static: { name: 'not-hex.bin', key: sealed.keyB64u } },
    { fileId: 'x2', name: 'a.bin', mime: '', size: 4, sha256: bytesToHex(sha256(plain)), chunks: 0, static: { name: hex32('4') + '.bin', key: '!!!not-b64u!!!' } },
    { fileId: 'x3', name: 'a.bin', mime: '', size: 6 * 1024 * 1024, sha256: bytesToHex(sha256(plain)), chunks: 0, static: { name: hex32('4') + '.bin', key: sealed.keyB64u } },
  ]
  for (const offer of cases) {
    await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  }
  const rs = receiptsOf(env)
  assert.equal(rs.length, cases.length)
  for (const r of rs) {
    assert.equal((r.body as unknown as FileReceiptBody).ok, false)
    assert.match(String((r.body as unknown as FileReceiptBody).error), /参数不合法|超/)
  }
})
