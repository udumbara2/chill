/**
 * fileSender.test.ts — d→m 文件发送器纯逻辑测试（全 fake 注入，零 mock 基础设施）。
 * 覆盖：单片/多片、409 再同步、429 退避、中途取消、mutated 护栏、空文件/超帽、
 * mime 推断与文件名清洗、加密→openMediaChunk 解密往返对账（golden 风格实测）。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import {
  sendFile,
  FILE_OFFER_TTL_MS,
  RATE_LIMIT_RETRY_MS,
  mimeFromFileName,
  type PutChunkResult,
  type SendFileOptions,
} from '../../src/services/relay/fileSender'
import {
  MEDIA_CHUNK_BYTES,
  MEDIA_MAX_BYTES,
  MEDIA_NAME_RE,
  mediaWireSize,
  mediaChunkRange,
  openMediaChunk,
  b64uDecode,
} from '../../src/services/relay/envelope'

/** 内存文件 + 上传捕获的假装配 */
function makeEnv(data: Uint8Array, over: Partial<{
  putImpl: (name: string, offset: number, total: number, bytes: Uint8Array) => Promise<PutChunkResult>
  statSeq: Array<{ size: number; mtimeMs: number }>
  isCancelled: () => boolean
}> = {}) {
  const puts: Array<{ name: string; offset: number; total: number; bytes: Uint8Array }> = []
  const sleeps: number[] = []
  let statCalls = 0
  const statSeq = over.statSeq ?? [{ size: data.length, mtimeMs: 1000 }, { size: data.length, mtimeMs: 1000 }]
  const base: SendFileOptions = {
    name: 'report.pdf',
    sessionId: 's1',
    statFile: async () => statSeq[Math.min(statCalls++, statSeq.length - 1)]!,
    readSlice: async (offset, length) => data.subarray(offset, offset + length),
    putChunk: async (name, offset, total, bytes) => {
      puts.push({ name, offset, total, bytes })
      return over.putImpl ? over.putImpl(name, offset, total, bytes) : { status: 201 }
    },
    sleep: async (ms) => { sleeps.push(ms) },
    now: () => 5_000_000,
    ...(over.isCancelled ? { isCancelled: over.isCancelled } : {}),
  }
  return { base, puts, sleeps }
}

/** 按密文 offset 拼装捕获的分片 → 服务端密文流 */
function assembleWire(puts: Array<{ offset: number; bytes: Uint8Array }>, wireSize: number): Uint8Array {
  const wire = new Uint8Array(wireSize)
  for (const p of puts) wire.set(p.bytes, p.offset)
  return wire
}

/** 逐片解密（与对端 openMediaChunk 对账）→ 明文 */
function decryptWire(wire: Uint8Array, keyB64u: string, nonceB64u: string, size: number): Uint8Array {
  const fileNonce = b64uDecode(nonceB64u)
  const chunks = Math.ceil(size / MEDIA_CHUNK_BYTES)
  const plain = new Uint8Array(size)
  let off = 0
  for (let i = 0; i < chunks; i++) {
    const { start, end } = mediaChunkRange(size, i)
    const p = openMediaChunk(wire.subarray(start, end + 1), keyB64u, fileNonce, i)
    assert.ok(p, `分片 ${i} 解密失败`)
    plain.set(p, off)
    off += p.length
  }
  assert.equal(off, size)
  return plain
}

test('单片（小文件）：offer 形状完整 + 加密→解密往返对账', async () => {
  const data = new Uint8Array(1000)
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 251
  const env = makeEnv(data)
  const r = await sendFile(env.base)
  assert.ok(r.ok)
  const offer = r.offer
  // offer 形状：fileId/name/mime/size/sha256/static{fmt:2}/expiresAt/sessionId
  assert.match(offer.fileId, /^[0-9a-f-]{36}$/)
  assert.equal(offer.name, 'report.pdf')
  assert.equal(offer.mime, 'application/pdf')
  assert.equal(offer.size, data.length)
  assert.equal(offer.sha256, bytesToHex(sha256(data)))
  assert.equal(offer.chunks, 0)
  assert.equal(offer.sessionId, 's1')
  assert.equal(offer.expiresAt, 5_000_000 + FILE_OFFER_TTL_MS, 'expiresAt = 完成时刻 + 48h')
  const st = offer.static!
  assert.ok(MEDIA_NAME_RE.test(st.name))
  assert.equal(st.fmt, 2)
  assert.equal(st.wireSize, mediaWireSize(data.length))
  assert.ok(st.nonce)
  // 单片一次 PUT（offset 0，total=wireSize）
  assert.equal(env.puts.length, 1)
  assert.equal(env.puts[0]!.offset, 0)
  assert.equal(env.puts[0]!.total, st.wireSize)
  // 解密往返对账
  const wire = assembleWire(env.puts, st.wireSize!)
  const plain = decryptWire(wire, st.key, st.nonce!, data.length)
  assert.deepEqual(plain, data)
  assert.equal(bytesToHex(sha256(plain)), offer.sha256)
})

test('多片（>512KB）：逐片 PUT 偏移正确 + 拼装解密 == 原文', async () => {
  const size = MEDIA_CHUNK_BYTES + 100 // 两片
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) data[i] = (i * 7) % 253
  const progress: Array<[number, number]> = []
  const env = makeEnv(data)
  const r = await sendFile({ ...env.base, onProgress: (s, t) => progress.push([s, t]) })
  assert.ok(r.ok)
  assert.equal(env.puts.length, 2, '两片两次 PUT')
  assert.equal(env.puts[0]!.offset, 0)
  assert.equal(env.puts[1]!.offset, mediaChunkRange(size, 1).start)
  assert.deepEqual(progress, [[MEDIA_CHUNK_BYTES, size], [size, size]], '进度按片推进（明文口径）')
  const st = r.offer.static!
  const plain = decryptWire(assembleWire(env.puts, st.wireSize!), st.key, st.nonce!, size)
  assert.deepEqual(plain, data)
})

test('409 再同步：服务端报 current=0（响应丢失但实际未写）→ 同片重发成功', async () => {
  const data = new Uint8Array(300)
  let calls = 0
  const env = makeEnv(data, {
    putImpl: async () => {
      calls++
      return calls === 1 ? { status: 409, current: 0 } : { status: 201 }
    },
  })
  const r = await sendFile(env.base)
  assert.ok(r.ok)
  assert.equal(calls, 2, '409 后重发同一片')
  assert.equal(env.puts[0]!.offset, 0)
  assert.equal(env.puts[1]!.offset, 0, '重发同一片同偏移')
})

test('409 服务端领先（current 已含本片）→ 跳过不重复上传', async () => {
  const size = MEDIA_CHUNK_BYTES + 100
  const data = new Uint8Array(size)
  const secondStart = mediaChunkRange(size, 1).start
  let calls = 0
  const env = makeEnv(data, {
    putImpl: async (_n, offset) => {
      calls++
      // 第二片 PUT 时服务端声称已有全部（第一片实际成功但响应丢失的场景变体）
      if (offset === secondStart) return { status: 409, current: mediaWireSize(size) }
      return { status: 201 }
    },
  })
  const r = await sendFile(env.base)
  assert.ok(r.ok)
  assert.equal(calls, 2)
})

test('429 限频：固定 35s 等待后重试同一片，不当失败', async () => {
  const data = new Uint8Array(64)
  let calls = 0
  const env = makeEnv(data, {
    putImpl: async () => {
      calls++
      return calls <= 2 ? { status: 429 } : { status: 201 }
    },
  })
  const r = await sendFile(env.base)
  assert.ok(r.ok)
  assert.equal(calls, 3)
  assert.deepEqual(env.sleeps, [RATE_LIMIT_RETRY_MS, RATE_LIMIT_RETRY_MS], '两次 429 各固定等 35s')
})

test('429 重试耗尽 → upload-failed（诚实报败不谎报）', async () => {
  const data = new Uint8Array(64)
  const env = makeEnv(data, { putImpl: async () => ({ status: 429 }) })
  const r = await sendFile({ ...env.base, maxChunkRetries: 2 })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'upload-failed')
  assert.match(r.detail ?? '', /429|限频/)
})

test('中途取消：isCancelled 在第一片后置真 → cancelled，后续片不再上传', async () => {
  const size = MEDIA_CHUNK_BYTES * 2
  const data = new Uint8Array(size)
  let cancelled = false
  const env = makeEnv(data, {
    isCancelled: () => cancelled,
    putImpl: async () => {
      cancelled = true // 第一片上传后用户取消
      return { status: 201 }
    },
  })
  const r = await sendFile(env.base)
  assert.ok(!r.ok)
  assert.equal(r.reason, 'cancelled')
  assert.equal(env.puts.length, 1, '取消后不再传后续片')
})

test('mutated 护栏：上传完成后 re-stat 变了 → file-mutated', async () => {
  const data = new Uint8Array(128)
  const env = makeEnv(data, {
    statSeq: [{ size: 128, mtimeMs: 1000 }, { size: 128, mtimeMs: 2000 }],
  })
  const r = await sendFile(env.base)
  assert.ok(!r.ok)
  assert.equal(r.reason, 'file-mutated')
})

test('0 字节拒绝 / 超帽拒绝（发送器侧双保险——桥层是第一闸）', async () => {
  const empty = makeEnv(new Uint8Array(0))
  const r1 = await sendFile(empty.base)
  assert.ok(!r1.ok)
  assert.equal(r1.reason, 'empty')
  const big = makeEnv(new Uint8Array(1), {
    statSeq: [{ size: MEDIA_MAX_BYTES + 1, mtimeMs: 1 }, { size: MEDIA_MAX_BYTES + 1, mtimeMs: 1 }],
  })
  const r2 = await sendFile(big.base)
  assert.ok(!r2.ok)
  assert.equal(r2.reason, 'too-large')
})

test('mime 推断与文件名清洗：扩展名映射表缺省 octet-stream；路径分隔符剥离', async () => {
  assert.equal(mimeFromFileName('a.png'), 'image/png')
  assert.equal(mimeFromFileName('a.PDF'), 'application/pdf')
  assert.equal(mimeFromFileName('a.xyz'), 'application/octet-stream')
  assert.equal(mimeFromFileName('noext'), 'application/octet-stream')
  const data = new Uint8Array(8)
  const env = makeEnv(data)
  const r = await sendFile({ ...env.base, name: 'dir/evil/../报告 v2.md' })
  assert.ok(r.ok)
  assert.equal(r.offer.mime, 'text/markdown')
  assert.ok(!/[\\/]/.test(r.offer.name), 'offer 名不携路径分隔符')
  assert.ok(r.offer.name.endsWith('.md'))
})
