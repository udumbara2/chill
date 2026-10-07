/**
 * fileTransfer.test.ts — file.* 重组器（纯状态机）单测。
 * 覆盖：offer 预检（帽/参数/并发/重复）、chunk 幂等与乱序、sha256 校验成败、
 * abort/settle/drop、两档 TTL 清扫、扩展名白名单清洗。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import {
  createFileTransferStore,
  offerFile,
  receiveChunk,
  settleTransfer,
  dropTransfer,
  abortTransfer,
  getSettled,
  sweepTransfers,
  sanitizeFileExtension,
} from '../../src/services/relay/fileTransfer'
import {
  b64uEncode,
  FILE_CHUNK_BYTES,
  FILE_MAX_BYTES,
  FILE_TRANSFER_TTL_MS,
  FILE_SETTLED_TTL_MS,
  type FileOfferBody,
} from '../../src/services/relay/envelope'

function offerOf(bytes: Uint8Array, fileId = 'f1', name = 'a.bin', chunks = 1): FileOfferBody {
  return { fileId, name, mime: 'application/octet-stream', size: bytes.length, sha256: bytesToHex(sha256(bytes)), chunks }
}

function chunkBytes(total: number): Uint8Array {
  const b = new Uint8Array(total)
  for (let i = 0; i < total; i++) b[i] = i % 251
  return b
}

test('offer 预检：超单文件帽拒绝（错误信息含上限）', () => {
  const store = createFileTransferStore()
  const bytes = new Uint8Array(FILE_MAX_BYTES + 1)
  const r = offerFile(store, { fileId: 'x', name: 'big.bin', mime: '', size: bytes.length, sha256: '0'.repeat(64), chunks: 1 })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /5MB/)
})

test('offer 预检：畸形参数 fail-closed（fileId/size/sha256/chunks）', () => {
  const store = createFileTransferStore()
  const ok = offerFile(store, offerOf(new Uint8Array(10)), 'a')
  assert.equal(ok.ok, true)
  assert.equal(offerFile(store, { fileId: '', name: 'x', mime: '', size: 10, sha256: '0'.repeat(64), chunks: 1 }).ok, false)
  assert.equal(offerFile(store, { fileId: 'b', name: 'x', mime: '', size: 0, sha256: '0'.repeat(64), chunks: 1 }).ok, false)
  assert.equal(offerFile(store, { fileId: 'c', name: 'x', mime: '', size: 10, sha256: 'zz', chunks: 1 }).ok, false)
  assert.equal(offerFile(store, { fileId: 'd', name: 'x', mime: '', size: 10, sha256: '0'.repeat(64), chunks: 0 }).ok, false)
})

test('offer 并发帽：Σpending.size 超帽拒绝新传输', () => {
  const store = createFileTransferStore()
  const half = 4500 * 1024 // 4.5MB（< 5MB 单文件帽）
  const mk = (id: string) => offerOf(chunkBytes(half), id, `${id}.bin`, Math.ceil(half / FILE_CHUNK_BYTES))
  // 4 × 4.5MB = 18MB < 20MB 全过；第 5 个（22.5MB 累计）被并发帽拒绝
  assert.equal(offerFile(store, mk('h1'), 1).ok, true)
  assert.equal(offerFile(store, mk('h2'), 1).ok, true)
  assert.equal(offerFile(store, mk('h3'), 1).ok, true)
  assert.equal(offerFile(store, mk('h4'), 1).ok, true)
  const r = offerFile(store, mk('h5'), 1)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /并发/)
})

test('chunk 流：乱序+重复到达，齐块恰好一次 complete 且 sha256 通过', () => {
  const store = createFileTransferStore()
  const bytes = chunkBytes(FILE_CHUNK_BYTES * 2 + 100)
  const chunks = Math.ceil(bytes.length / FILE_CHUNK_BYTES)
  const r = offerFile(store, offerOf(bytes, 'f-ok', 'photo.jpg', chunks), 1)
  assert.equal(r.ok, true)
  // 先发 seq1 再发 seq0（乱序），seq1 重发一次（重复）
  const seq1 = bytes.subarray(FILE_CHUNK_BYTES, FILE_CHUNK_BYTES * 2)
  assert.deepEqual(receiveChunk(store, 'f-ok', 1, b64uEncode(seq1), 2), { kind: 'stored' })
  assert.deepEqual(receiveChunk(store, 'f-ok', 1, b64uEncode(seq1), 3), { kind: 'dup' })
  const seq2 = bytes.subarray(FILE_CHUNK_BYTES * 2)
  assert.deepEqual(receiveChunk(store, 'f-ok', 2, b64uEncode(seq2), 3), { kind: 'stored' })
  const final = receiveChunk(store, 'f-ok', 0, b64uEncode(bytes.subarray(0, FILE_CHUNK_BYTES)), 4)
  assert.equal(final.kind, 'complete')
  if (final.kind === 'complete') {
    assert.deepEqual(final.bytes, bytes)
    assert.equal(final.transfer.size, bytes.length)
  }
  // 完成后缓冲已清：再来的迟到分块 = unknown
  assert.deepEqual(receiveChunk(store, 'f-ok', 2, b64uEncode(new Uint8Array(10)), 5), { kind: 'unknown' })
})

test('chunk 流：sha256 不符 → corrupt，传输移除', () => {
  const store = createFileTransferStore()
  const bytes = chunkBytes(50)
  offerFile(store, { fileId: 'f-bad', name: 'x.bin', mime: '', size: bytes.length, sha256: '1'.repeat(64), chunks: 1 })
  const r = receiveChunk(store, 'f-bad', 0, b64uEncode(bytes), 1)
  assert.equal(r.kind, 'corrupt')
  assert.equal(store.pending.has('f-bad'), false)
})

test('chunk 流：单块超 FILE_CHUNK_BYTES 拒收为 unknown', () => {
  const store = createFileTransferStore()
  const big = chunkBytes(FILE_CHUNK_BYTES + 1)
  offerFile(store, { fileId: 'f-big', name: 'x.bin', mime: '', size: big.length, sha256: bytesToHex(sha256(big)), chunks: 1 })
  assert.deepEqual(receiveChunk(store, 'f-big', 0, b64uEncode(big), 1), { kind: 'unknown' })
})

test('重复 offer：未完成=续传受理；已完成=幂等返回 settled（重发 receipt 依据）', () => {
  const store = createFileTransferStore()
  const bytes = chunkBytes(30)
  offerFile(store, offerOf(bytes, 'f-dup'), 1)
  assert.equal(offerFile(store, offerOf(bytes, 'f-dup'), 2).ok, true) // 未完成重复 → 续传
  const complete = receiveChunk(store, 'f-dup', 0, b64uEncode(bytes), 2)
  assert.equal(complete.kind, 'complete')
  settleTransfer(store, 'f-dup', '2026/09/uuid.bin', { name: 'a.bin', mime: '', size: bytes.length }, 3)
  const again = offerFile(store, offerOf(bytes, 'f-dup'), 4)
  assert.equal(again.ok, true)
  if (again.ok && again.duplicate) {
    assert.equal(again.settled.savedRef, '2026/09/uuid.bin')
  }
  assert.equal(getSettled(store, 'f-dup')?.name, 'a.bin')
})

test('abort/drop：abort 只清未完成；drop 连完成态一并清', () => {
  const store = createFileTransferStore()
  const bytes = chunkBytes(20)
  offerFile(store, offerOf(bytes, 'f-a'), 1)
  offerFile(store, offerOf(bytes, 'f-b'), 1)
  const c = receiveChunk(store, 'f-b', 0, b64uEncode(bytes), 1)
  assert.equal(c.kind, 'complete')
  settleTransfer(store, 'f-b', 'ref-b', { name: 'b', mime: '', size: 20 }, 1)
  abortTransfer(store, 'f-a')
  abortTransfer(store, 'f-b') // 迟到的 abort 不回收已落盘事实
  assert.equal(store.pending.has('f-a'), false)
  assert.ok(getSettled(store, 'f-b'))
  dropTransfer(store, 'f-b')
  assert.equal(getSettled(store, 'f-b'), null)
})

test('两档 TTL：未完成 10 分钟、完成态 30 分钟', () => {
  const store = createFileTransferStore()
  const bytes = chunkBytes(10)
  offerFile(store, offerOf(bytes, 'f-t1'), 1000)
  offerFile(store, offerOf(bytes, 'f-t2'), 1000)
  const c = receiveChunk(store, 'f-t2', 0, b64uEncode(bytes), 1000)
  assert.equal(c.kind, 'complete')
  settleTransfer(store, 'f-t2', 'r', { name: 'x', mime: '', size: 10 }, 1000)
  sweepTransfers(store, 1000 + FILE_TRANSFER_TTL_MS + 1)
  assert.equal(store.pending.has('f-t1'), false, '未完成超 10 分钟被清')
  assert.ok(getSettled(store, 'f-t2'), '完成态 10 分钟+ 不清')
  sweepTransfers(store, 1000 + FILE_SETTLED_TTL_MS + 1)
  assert.equal(getSettled(store, 'f-t2'), null, '完成态超 30 分钟被清')
})

test('扩展名白名单：合法保留、非法剥除、无扩展名空串', () => {
  assert.equal(sanitizeFileExtension('照片.JPG'), 'jpg')
  assert.equal(sanitizeFileExtension('report.pdf'), 'pdf')
  assert.equal(sanitizeFileExtension('archive.tar.gz'), 'gz')
  assert.equal(sanitizeFileExtension('evil.exe%2F..'), '')
  assert.equal(sanitizeFileExtension('noext'), '')
  assert.equal(sanitizeFileExtension('trailing.'), '')
  assert.equal(sanitizeFileExtension('超长扩展名.abcdefghijklmnopqrst'), '')
})
