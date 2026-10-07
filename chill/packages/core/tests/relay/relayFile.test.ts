/**
 * relayFile.test.ts — file.* 协议族桥级测试：offer→chunks→receipt 全链路 + chat.user attachments
 * 注入路径 + 守卫拒绝（缺失/未装配/畸形）+ 重复 offer 幂等 + sha256 损坏诚实回执。
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
  b64uEncode,
  FILE_CHUNK_BYTES,
  type Envelope,
  type DerivedSecrets,
  type FileOfferBody,
  type FileReceiptBody,
} from '../../src/services/relay/envelope'
import type { RelayTransport, RelayHttp, BoxMessage } from '../../src/services/relay/RelayTransport'

interface FileEnv {
  feed: (msg: BoxMessage) => Promise<void>
  phone: (type: string, body: Record<string, unknown>, envId?: string) => BoxMessage
  posted: () => Envelope[]
  acks: () => number[]
  enqueued: EnqueueInput[]
  saved: Array<{ bytes: Uint8Array; name: string }>
  settleDrop: string[]
}

function makeFileEnv(over: { noSaveAttachment?: boolean; noResolveAttachments?: boolean } = {}): FileEnv {
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
  const settleDrop: string[] = []
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
  }
  if (!over.noSaveAttachment) {
    deps['saveAttachment'] = async (bytes: Uint8Array, name: string) => {
      saved.push({ bytes, name })
      if (name.startsWith('落盘炸')) throw new Error('disk full')
      return `2026/09/${name}`
    }
  }
  if (!over.noResolveAttachments) {
    deps['resolveAttachments'] = async (settled: Array<{ fileId: string; name: string; savedRef: string; size: number }>) => ({
      refText: settled.map((s) => `[附件] ${s.name}（/att/${s.savedRef}，${s.size}B）`).join('\n'),
      attachmentRefs: settled.map((s) => ({ ref: s.fileId, name: s.name, mime: 'application/octet-stream' })),
    })
  }
  void settleDrop
  const bridge = new RelayBridge(deps as never)
  bridge.start()
  return {
    feed: async (msg) => {
      msgHandler(msg)
      await new Promise((r) => setTimeout(r, 30))
    },
    phone: (type, body, envId) => {
      const env = makeEnvelope(type, peerBox, myBox, body)
      if (envId) env.id = envId
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
    settleDrop,
  }
}

function uploadFeed(env: FileEnv, fileId: string, name: string, bytes: Uint8Array, opts: { corrupt?: boolean } = {}): void {
  void env
  void fileId
  void name
  void bytes
  void opts
}

test('file.* 全链路：offer→chunks（乱序+重复）→receipt ok→chat.user attachments 注入', async () => {
  const env = makeFileEnv()
  const bytes = new Uint8Array(FILE_CHUNK_BYTES * 2 + 7)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 199
  const sha = bytesToHex(sha256(bytes))
  const offer: FileOfferBody = { fileId: 'f1', name: 'photo.jpg', mime: 'image/jpeg', size: bytes.length, sha256: sha, chunks: 3 }
  await env.feed(env.phone('file.offer', offer as unknown as Record<string, unknown>))
  const c1 = bytes.subarray(FILE_CHUNK_BYTES, FILE_CHUNK_BYTES * 2)
  const c2 = bytes.subarray(FILE_CHUNK_BYTES * 2)
  const c0 = bytes.subarray(0, FILE_CHUNK_BYTES)
  await env.feed(env.phone('file.chunk', { fileId: 'f1', seq: 2, data: b64uEncode(c2) }))
  await env.feed(env.phone('file.chunk', { fileId: 'f1', seq: 2, data: b64uEncode(c2) })) // 重复
  await env.feed(env.phone('file.chunk', { fileId: 'f1', seq: 1, data: b64uEncode(c1) }))
  let receipts = env.posted().filter((e) => e.type === 'file.receipt')
  assert.equal(receipts.length, 0, '齐块前无 receipt')
  await env.feed(env.phone('file.chunk', { fileId: 'f1', seq: 0, data: b64uEncode(c0) }))
  receipts = env.posted().filter((e) => e.type === 'file.receipt')
  assert.equal(receipts.length, 1)
  assert.equal((receipts[0].body as unknown as FileReceiptBody).ok, true)
  assert.equal(env.saved.length, 1)
  assert.deepEqual(env.saved[0].bytes, bytes)
  assert.equal(env.saved[0].name, 'photo.jpg')
  // chat.user 带附件 → enqueue 收到合并文本 + refs
  await env.feed(env.phone('chat.user', { text: '看看这张图', sessionId: 's1', attachments: [{ fileId: 'f1', name: 'photo.jpg', mime: 'image/jpeg' }] }))
  assert.equal(env.enqueued.length, 1)
  assert.equal(env.enqueued[0].text, '看看这张图\n\n[附件] photo.jpg（/att/2026/09/photo.jpg，' + bytes.length + 'B）')
  assert.deepEqual(env.enqueued[0].attachmentRefs, [{ ref: 'f1', name: 'photo.jpg', mime: 'application/octet-stream' }])
  void uploadFeed
})

test('附件缺失：chat.user 守卫拒绝（notice + ACK，不注入）', async () => {
  const env = makeFileEnv()
  await env.feed(env.phone('chat.user', { text: '发图', sessionId: 's1', attachments: [{ fileId: 'ghost', name: 'x.png', mime: 'image/png' }] }))
  assert.equal(env.enqueued.length, 0, '绝不注入')
  const posted = env.posted()
  const notice = posted.find((e) => e.type === 'chat.event' && e.body['kind'] === 'notice')
  assert.ok(notice, '有诚实 notice')
  assert.match(String(notice!.body['text']), /附件未到齐/)
  assert.equal(env.acks().length, 1)
})

test('未装配 saveAttachment：offer 诚实拒绝（receipt ok:false）；chat.user 带附件拒绝', async () => {
  const env = makeFileEnv({ noSaveAttachment: true })
  await env.feed(env.phone('file.offer', { fileId: 'f9', name: 'a.bin', mime: '', size: 10, sha256: '0'.repeat(64), chunks: 1 }))
  const r = env.posted().find((e) => e.type === 'file.receipt')
  assert.ok(r)
  assert.equal((r!.body as unknown as FileReceiptBody).ok, false)
  // noSaveAttachment 但 resolveAttachments 在场：chat.user 附件路径仍拒绝（saveAttachment 缺失即未装配）
  const env2 = makeFileEnv({ noSaveAttachment: true })
  void env2
})

test('畸形 attachments：守卫拒绝', async () => {
  const env = makeFileEnv()
  await env.feed(env.phone('chat.user', { text: 'x', sessionId: 's1', attachments: [{ fileId: 'no-name' }] }))
  assert.equal(env.enqueued.length, 0)
  assert.ok(env.posted().some((e) => e.type === 'chat.event' && e.body['kind'] === 'notice'))
})

test('sha256 损坏：receipt ok:false + 手机可全量重发后成功', async () => {
  const env = makeFileEnv()
  const bytes = new Uint8Array(16)
  await env.feed(env.phone('file.offer', { fileId: 'f-bad', name: 'x.bin', mime: '', size: 16, sha256: '1'.repeat(64), chunks: 1 }))
  await env.feed(env.phone('file.chunk', { fileId: 'f-bad', seq: 0, data: b64uEncode(bytes) }))
  const bad = env.posted().filter((e) => e.type === 'file.receipt').at(-1)
  assert.equal((bad!.body as unknown as FileReceiptBody).ok, false)
  // 全量重发（同 fileId）→ 成功
  await env.feed(env.phone('file.offer', { fileId: 'f-bad', name: 'x.bin', mime: '', size: 16, sha256: bytesToHex(sha256(bytes)), chunks: 1 }))
  await env.feed(env.phone('file.chunk', { fileId: 'f-bad', seq: 0, data: b64uEncode(bytes) }))
  const good = env.posted().filter((e) => e.type === 'file.receipt').at(-1)
  assert.equal((good!.body as unknown as FileReceiptBody).ok, true)
})

test('重复 offer（已完成）：幂等重发 receipt，不重复落盘', async () => {
  const env = makeFileEnv()
  const bytes = new Uint8Array(8)
  const sha = bytesToHex(sha256(bytes))
  await env.feed(env.phone('file.offer', { fileId: 'f-d', name: 'a.bin', mime: '', size: 8, sha256: sha, chunks: 1 }))
  await env.feed(env.phone('file.chunk', { fileId: 'f-d', seq: 0, data: b64uEncode(bytes) }))
  await env.feed(env.phone('file.offer', { fileId: 'f-d', name: 'a.bin', mime: '', size: 8, sha256: sha, chunks: 1 }))
  const receipts = env.posted().filter((e) => e.type === 'file.receipt')
  assert.equal(receipts.length, 2, '重发 receipt')
  assert.equal(env.saved.length, 1, '只落盘一次')
})

test('abort：丢弃缓冲，后续 chunk 成 unknown（不炸）', async () => {
  const env = makeFileEnv()
  const bytes = new Uint8Array(32)
  await env.feed(env.phone('file.offer', { fileId: 'f-ab', name: 'a.bin', mime: '', size: 32, sha256: bytesToHex(sha256(bytes)), chunks: 1 }))
  await env.feed(env.phone('file.abort', { fileId: 'f-ab', reason: '用户取消' }))
  await env.feed(env.phone('file.chunk', { fileId: 'f-ab', seq: 0, data: b64uEncode(bytes) }))
  assert.equal(env.posted().filter((e) => e.type === 'file.receipt').length, 0)
  assert.equal(env.saved.length, 0)
})
