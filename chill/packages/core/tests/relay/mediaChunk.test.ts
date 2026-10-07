/**
 * mediaChunk.test.ts — v2 分片确定性 nonce 原语黄金向量：
 * 确定性（同片重加密逐字节恒等）/ 跨片不碰撞 / 位置算术 / 大文件 wireSize / 解密往返。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import {
  newMediaFileKeys,
  mediaChunkNonce,
  sealMediaChunk,
  openMediaChunk,
  mediaWireSize,
  mediaChunkRange,
  MEDIA_CHUNK_BYTES,
  MEDIA_MAX_BYTES,
} from '../../src/services/relay/envelope'

test('确定性：同一 (file,key) 的第 i 片重加密任意次 → 密文逐字节恒等（续传正确性的原语级前提）', () => {
  const { fileNonce, keyB64u } = newMediaFileKeys()
  const plain = new Uint8Array(MEDIA_CHUNK_BYTES)
  for (let i = 0; i < plain.length; i++) plain[i] = i % 251
  const w1 = sealMediaChunk(plain, keyB64u, fileNonce, 7)
  const w2 = sealMediaChunk(plain, keyB64u, fileNonce, 7)
  const w3 = sealMediaChunk(plain, keyB64u, fileNonce, 7)
  assert.deepEqual(w1, w2)
  assert.deepEqual(w2, w3)
  // App 被杀后"重新生成" nonce 参数不变（fileNonce 从磁盘重读）——同一 fileNonce 参数即同一密文
  const w4 = sealMediaChunk(plain, keyB64u, Uint8Array.from(fileNonce), 7)
  assert.deepEqual(w1, w4)
})

test('跨片不碰撞：不同 i 的 nonce 互异（uint64be 递增）', () => {
  const { fileNonce } = newMediaFileKeys()
  const nonces = new Set<string>()
  for (let i = 0; i < 100; i++) nonces.add(Buffer.from(mediaChunkNonce(fileNonce, i)).toString('hex'))
  assert.equal(nonces.size, 100)
  // 不同 fileNonce → 同 i 也互异
  const fn2 = newMediaFileKeys().fileNonce
  assert.notEqual(
    Buffer.from(mediaChunkNonce(fileNonce, 0)).toString('hex'),
    Buffer.from(mediaChunkNonce(fn2, 0)).toString('hex'),
  )
})

test('解密往返：seal→open 恢复明文；篡改一字节 → MAC 验真失败（null）', () => {
  const { fileNonce, keyB64u } = newMediaFileKeys()
  const plain = new Uint8Array(1000)
  for (let i = 0; i < plain.length; i++) plain[i] = (i * 7) % 256
  const wire = sealMediaChunk(plain, keyB64u, fileNonce, 3)
  assert.deepEqual(openMediaChunk(wire, keyB64u, fileNonce, 3), plain)
  // 篡改密文
  const tampered = Uint8Array.from(wire)
  tampered[tampered.length - 1] ^= 0xff
  assert.equal(openMediaChunk(tampered, keyB64u, fileNonce, 3), null)
  // 错 fileNonce（等效错片号——nonce 派生错）→ 验真失败
  assert.equal(openMediaChunk(wire, keyB64u, newMediaFileKeys().fileNonce, 3), null)
  assert.equal(openMediaChunk(wire, keyB64u, fileNonce, 4), null)
  // 错钥
  assert.equal(openMediaChunk(wire, newMediaFileKeys().keyB64u, fileNonce, 3), null)
})

test('位置算术：mediaChunkRange 首片 0、末片精确；mediaWireSize 与分片拼接总长一致', () => {
  const totalPlain = MEDIA_CHUNK_BYTES * 2 + 12345 // 3 片：512K + 512K + 12345
  const r0 = mediaChunkRange(totalPlain, 0)
  const r1 = mediaChunkRange(totalPlain, 1)
  const r2 = mediaChunkRange(totalPlain, 2)
  assert.equal(r0.start, 0)
  assert.equal(r0.end, 24 + MEDIA_CHUNK_BYTES + 16 - 1)
  assert.equal(r1.start, r0.end + 1)
  assert.equal(r2.end + 1, mediaWireSize(totalPlain))
  // wireSize 精确验证
  const ws = mediaWireSize(totalPlain)
  assert.equal(ws, 2 * (24 + MEDIA_CHUNK_BYTES + 16) + (24 + 12345 + 16))
  // 单片文件
  const single = mediaWireSize(100)
  assert.equal(single, 24 + 100 + 16)
  assert.equal(mediaChunkRange(100, 0).end, single - 1)
})

test('大整数片号：uint64 nonce 可容纳 GB 级文件（100MB/512KB = 200 片；1GB = 2048 片）', () => {
  const { fileNonce, keyB64u } = newMediaFileKeys()
  const plain = new Uint8Array(10)
  const w200 = sealMediaChunk(plain, keyB64u, fileNonce, 200)
  assert.deepEqual(openMediaChunk(w200, keyB64u, fileNonce, 200), plain)
  const w2048 = sealMediaChunk(plain, keyB64u, fileNonce, 2048)
  assert.deepEqual(openMediaChunk(w2048, keyB64u, fileNonce, 2048), plain)
  // MEDIA_MAX_BYTES = 100MB（v2 策略帽单源）
  assert.equal(MEDIA_MAX_BYTES, 100 * 1024 * 1024)
})
