/**
 * fileSendBridge.test.ts — d→m 文件发送桥级测试（仿 staticMedia.test.ts 全 fake 装配）。
 * 覆盖：offer 信封形状与方向、caps 门两种拒绝、denylist 命中、0字节/超帽拒绝、
 * receipt 等待器（正常/早到/超时/重投去重）、无等待器的迟到 receipt 也发通告。
 */
import { test } from 'node:test'
import assert from 'node:assert'
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
  CAP_FILE_RECV,
  MEDIA_MAX_BYTES,
  type Envelope,
  type DerivedSecrets,
  type FileOfferBody,
} from '../../src/services/relay/envelope'
import type { RelayTransport, RelayHttp, BoxMessage } from '../../src/services/relay/RelayTransport'

interface SendEnv {
  bridge: RelayBridge
  feed: (msg: BoxMessage) => Promise<void>
  phone: (type: string, body: Record<string, unknown>) => BoxMessage
  posted: () => Envelope[]
  mediaStore: Map<string, { bytes: Uint8Array; offsets: number[] }>
  receipts: Array<{ fileId: string; ok: boolean; error?: string; name?: string; sessionId?: string }>
  fs: Map<string, { bytes: Uint8Array; mtimeMs: number }>
}

function makeSendEnv(
  over: {
    noPutMedia?: boolean
    caseInsensitive?: boolean
    /** statFile 覆盖（超帽等场景伪造大小） */
    statImpl?: (p: string) => Promise<{ size: number; mtimeMs: number; isFile: boolean } | null>
  } = {},
): SendEnv {
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
  const mediaStore = new Map<string, { bytes: Uint8Array; offsets: number[] }>()
  const receipts: SendEnv['receipts'] = []
  const fsMap = new Map<string, { bytes: Uint8Array; mtimeMs: number }>()
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
    enqueue: async (input: EnqueueInput): Promise<EnqueueResult> => ({ content: `回复:${input.text}`, aborted: false }),
    resolveApproval: () => true,
    listPendingApprovals: () => [],
    getActiveSessionId: () => 's1',
    onAlarm: () => {},
    loadSeenIds: async () => [],
    saveSeenIds: async () => {},
    // d→m 出向注入（全 fake）
    resolvePath: async (p: string) => p, // 测试路径一律按绝对路径给
    homeDir: 'C:\\Users\\tester',
    ...(over.caseInsensitive ? { caseInsensitivePaths: true } : {}),
    statFile:
      over.statImpl ??
      (async (p: string) => {
        const f = fsMap.get(p)
        return f ? { size: f.bytes.length, mtimeMs: f.mtimeMs, isFile: true } : null
      }),
    readFileSlice: async (p: string, offset: number, length: number) => {
      const f = fsMap.get(p)
      if (!f) throw new Error('ENOENT')
      return f.bytes.subarray(offset, offset + length)
    },
    ...(over.noPutMedia
      ? {}
      : {
          putMedia: async (name: string, offset: number, total: number, bytes: Uint8Array) => {
            const cur = mediaStore.get(name) ?? { bytes: new Uint8Array(total), offsets: [] }
            cur.bytes.set(bytes, offset)
            cur.offsets.push(offset)
            mediaStore.set(name, cur)
            return { status: 201 }
          },
        }),
    onFileReceipt: (r: SendEnv['receipts'][number]) => receipts.push(r),
  }
  const bridge = new RelayBridge(deps as never)
  bridge.start()
  return {
    bridge,
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
    mediaStore,
    receipts,
    fs: fsMap,
  }
}

/** 喂一条带 file-recv 能力的 presence.ping（caps 门放行） */
async function phoneOnlineWithCaps(env: SendEnv): Promise<void> {
  await env.feed(env.phone('presence.ping', { caps: [CAP_FILE_RECV] }))
}

const offersOf = (env: SendEnv) => env.posted().filter((e) => e.type === 'file.offer')

test('offer 信封形状与方向：d→m、v2 static 指针、expiresAt/sessionId、密文已在中继', async () => {
  const env = makeSendEnv()
  const data = new Uint8Array(2000)
  for (let i = 0; i < data.length; i++) data[i] = (i * 13) % 251
  env.fs.set('/work/报告.pdf', { bytes: data, mtimeMs: 42 })
  await phoneOnlineWithCaps(env)
  const progress: Array<[number, number]> = []
  const t0 = Date.now()
  const r = await env.bridge.sendFileToMobile({
    path: '/work/报告.pdf',
    sessionId: 's1',
    onProgress: (s, t) => progress.push([s, t]),
  })
  assert.match(r.fileId, /^[0-9a-f-]{36}$/)
  assert.ok(
    r.expiresAt >= t0 + 48 * 60 * 60 * 1000 && r.expiresAt <= Date.now() + 48 * 60 * 60 * 1000,
    'expiresAt = PUT 完成时刻 + 48h',
  )
  const offers = offersOf(env)
  assert.equal(offers.length, 1)
  const offer = offers[0]!
  assert.equal(offer.from.length > 0 && offer.to.length > 0, true)
  const body = offer.body as unknown as FileOfferBody
  assert.equal(body.fileId, r.fileId)
  assert.equal(body.name, '报告.pdf')
  assert.equal(body.mime, 'application/pdf')
  assert.equal(body.size, data.length)
  assert.equal(body.sessionId, 's1')
  assert.equal(body.expiresAt, r.expiresAt)
  assert.equal(body.static?.fmt, 2)
  assert.ok(body.static?.wireSize)
  // 密文已完整落"中继"（putMedia 假装配）
  const stored = env.mediaStore.get(body.static!.name)
  assert.ok(stored)
  assert.equal(stored!.bytes.length, body.static!.wireSize)
  assert.deepEqual(progress, [[data.length, data.length]])
})

test('caps 门两种病因两种话：未上线 / 版本过旧', async () => {
  const env = makeSendEnv()
  env.fs.set('/work/a.txt', { bytes: new Uint8Array(8), mtimeMs: 1 })
  // 从未见过 ping
  await assert.rejects(
    () => env.bridge.sendFileToMobile({ path: '/work/a.txt' }),
    /手机尚未上线/,
  )
  // 见过 ping 但无 caps（旧版手机 body={}）
  await env.feed(env.phone('presence.ping', {}))
  await assert.rejects(
    () => env.bridge.sendFileToMobile({ path: '/work/a.txt' }),
    /手机端版本过旧/,
  )
  // 带 file-recv 能力后放行
  await phoneOnlineWithCaps(env)
  const r = await env.bridge.sendFileToMobile({ path: '/work/a.txt' })
  assert.ok(r.fileId)
})

test('denylist：~/.chill/**、*.pem、.env* 命中即拒；Windows 大小写不敏感', async () => {
  const env = makeSendEnv({ caseInsensitive: true })
  await phoneOnlineWithCaps(env)
  const puts = (p: string) => env.fs.set(p, { bytes: new Uint8Array(4), mtimeMs: 1 })
  puts('C:\\Users\\tester\\.chill\\relay.lock')
  puts('C:\\Keys\\server.pem')
  puts('C:\\Keys\\PRIVATE.KEY')
  puts('/work/.env.local')
  puts('/work/normal.txt')
  await assert.rejects(() => env.bridge.sendFileToMobile({ path: 'C:\\Users\\tester\\.chill\\relay.lock' }), /\.chill/)
  await assert.rejects(() => env.bridge.sendFileToMobile({ path: 'C:\\Keys\\server.pem' }), /密钥类/)
  await assert.rejects(() => env.bridge.sendFileToMobile({ path: 'C:\\Keys\\PRIVATE.KEY' }), /密钥类/, '大小写不敏感命中')
  await assert.rejects(() => env.bridge.sendFileToMobile({ path: '/work/.env.local' }), /\.env/)
  const r = await env.bridge.sendFileToMobile({ path: '/work/normal.txt' })
  assert.ok(r.fileId, '正常文件放行')
  assert.equal(offersOf(env).length, 1, '被拒绝的不发 offer')
})

test('路径校验：不存在/目录/0字节/超帽 各自诚实拒绝', async () => {
  const env = makeSendEnv()
  await phoneOnlineWithCaps(env)
  env.fs.set('/work/empty.bin', { bytes: new Uint8Array(0), mtimeMs: 1 })
  await assert.rejects(() => env.bridge.sendFileToMobile({ path: '/work/ghost.bin' }), /不存在/)
  await assert.rejects(() => env.bridge.sendFileToMobile({ path: '/work/empty.bin' }), /空文件/)
  // 目录（isFile=false）
  const dirEnv = makeSendEnv({ statImpl: async () => ({ size: 10, mtimeMs: 1, isFile: false }) })
  await phoneOnlineWithCaps(dirEnv)
  await assert.rejects(() => dirEnv.bridge.sendFileToMobile({ path: '/work/dir' }), /不是普通文件/)
  // 超帽（statImpl 伪造 >100MB）
  const bigEnv = makeSendEnv({ statImpl: async () => ({ size: MEDIA_MAX_BYTES + 1, mtimeMs: 1, isFile: true }) })
  await phoneOnlineWithCaps(bigEnv)
  await assert.rejects(() => bigEnv.bridge.sendFileToMobile({ path: '/work/big.bin' }), /超过上限/)
  // bytes 形态的空文件同闸
  await assert.rejects(
    () => env.bridge.sendFileToMobile({ bytes: new Uint8Array(0), name: 'x.bin' }),
    /空文件/,
  )
})

test('未装配 putMedia：发送时诚实报错（构造宽容）', async () => {
  const env = makeSendEnv({ noPutMedia: true })
  env.fs.set('/work/a.txt', { bytes: new Uint8Array(8), mtimeMs: 1 })
  await phoneOnlineWithCaps(env)
  await assert.rejects(() => env.bridge.sendFileToMobile({ path: '/work/a.txt' }), /未装配文件上传能力/)
})

test('receipt 等待器：正常到达 → resolve {ok:true} + onFileReceipt 通告带 name', async () => {
  const env = makeSendEnv()
  env.fs.set('/work/报告.pdf', { bytes: new Uint8Array(16), mtimeMs: 1 })
  await phoneOnlineWithCaps(env)
  const { fileId } = await env.bridge.sendFileToMobile({ path: '/work/报告.pdf', sessionId: 's1' })
  const waiting = env.bridge.waitFileReceipt(fileId, 1000)
  await env.feed(env.phone('file.receipt', { fileId, ok: true }))
  const r = await waiting
  assert.deepEqual(r, { ok: true })
  assert.equal(env.receipts.length, 1)
  assert.equal(env.receipts[0]!.fileId, fileId)
  assert.equal(env.receipts[0]!.name, '报告.pdf')
  assert.equal(env.receipts[0]!.sessionId, 's1')
})

test('receipt 等待器：早到（等待器注册前到达）→ 暂存立取；失败回执带 error', async () => {
  const env = makeSendEnv()
  env.fs.set('/work/a.txt', { bytes: new Uint8Array(8), mtimeMs: 1 })
  await phoneOnlineWithCaps(env)
  const { fileId } = await env.bridge.sendFileToMobile({ path: '/work/a.txt' })
  // receipt 先于 waitFileReceipt 到达
  await env.feed(env.phone('file.receipt', { fileId, ok: false, error: 'io' }))
  const r = await env.bridge.waitFileReceipt(fileId, 1000)
  assert.deepEqual(r, { ok: false, error: 'io' })
})

test('receipt 等待器：超时 resolve null（待接收，不谎报失败）', async () => {
  const env = makeSendEnv()
  const r = await env.bridge.waitFileReceipt('never-coming', 50)
  assert.equal(r, null)
})

test('receipt 重投由 env.id 去重层吸收：同一条 receipt 只通告一次', async () => {
  const env = makeSendEnv()
  env.fs.set('/work/a.txt', { bytes: new Uint8Array(8), mtimeMs: 1 })
  await phoneOnlineWithCaps(env)
  const { fileId } = await env.bridge.sendFileToMobile({ path: '/work/a.txt' })
  const msg = env.phone('file.receipt', { fileId, ok: true })
  await env.feed(msg)
  await env.feed(msg) // 重投（同 env.id）
  assert.equal(env.receipts.length, 1, '去重层吸收重投')
})

test('无等待器的迟到 receipt 也发 onFileReceipt（桌面重启后送达事实仍可见；无登记则无名）', async () => {
  const env = makeSendEnv()
  await phoneOnlineWithCaps(env)
  // 本桥从未发出该 fileId（模拟重启后等待器/登记消失）
  await env.feed(env.phone('file.receipt', { fileId: 'ghost-file', ok: true }))
  assert.equal(env.receipts.length, 1)
  assert.equal(env.receipts[0]!.fileId, 'ghost-file')
  assert.equal(env.receipts[0]!.name, undefined)
})

test('bytes 直发形态：name 必填、入 offer', async () => {
  const env = makeSendEnv()
  await phoneOnlineWithCaps(env)
  await assert.rejects(() => env.bridge.sendFileToMobile({ bytes: new Uint8Array(4) }), /文件名/)
  const r = await env.bridge.sendFileToMobile({ bytes: new Uint8Array(64), name: 'note.md', mime: 'text/markdown' })
  const body = offersOf(env)[0]!.body as unknown as FileOfferBody
  assert.equal(body.fileId, r.fileId)
  assert.equal(body.name, 'note.md')
  assert.equal(body.mime, 'text/markdown')
})
