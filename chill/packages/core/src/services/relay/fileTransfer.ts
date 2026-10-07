/**
 * fileTransfer.ts — file.* 协议族的桌面侧重组器（纯状态机、Node-free）。
 *
 * 职责边界（单一事实点）：
 * - offer 预检（单文件帽 / 并发未完成总量帽 / 参数合法性）与扩展名白名单清洗
 * - chunk 按 (fileId,seq) 幂等收块（at-least-once 容忍重复与乱序到达）
 * - 齐块重组 + sha256 整体校验（恰好一次把字节交还给调用方）
 * - abort / 两档 TTL 清扫（未完成 FILE_TRANSFER_TTL_MS / 完成态 FILE_SETTLED_TTL_MS）
 * - 完成态注册表：chat.user attachments 的解析依据（重复 offer 幂等重发 receipt 不重复落盘）
 *
 * 不做 IO：落盘（saveAttachment）与回执（file.receipt）由 RelayBridge/装配层承担——
 * 本文件是 services/relay/ 的 Node-free 红线成员（renderer/RN 安全，jest 直测）。
 * 传输类型无关：name/mime 只是元数据，消费语义在桌面既有摄入管线。
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  b64uDecode,
  FILE_CHUNK_BYTES,
  FILE_MAX_BYTES,
  FILE_MAX_PENDING_BYTES,
  FILE_TRANSFER_TTL_MS,
  FILE_SETTLED_TTL_MS,
  type FileOfferBody,
} from './envelope';

// ---------- 扩展名白名单（防路径注入的最后闸：落盘文件名 = uuid + 白名单扩展名） ----------

/** 取文件名扩展名（最后一个点段，小写）；无点/空段返回 '' */
function rawExtension(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** 白名单清洗：`^[A-Za-z0-9]{1,10}$` 之外的一切形态剥除为无名扩展（''） */
export function sanitizeFileExtension(name: string): string {
  const ext = rawExtension(name);
  return /^[A-Za-z0-9]{1,10}$/.test(ext) ? ext : '';
}

// ---------- 状态形态 ----------

export interface PendingTransfer {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  chunks: number;
  received: Map<number, Uint8Array>;
  receivedBytes: number;
  lastActivityAt: number;
}

/** 完成态（落盘成功的注册条目；chat.user attachments 解析与重复 offer 幂等的依据） */
export interface SettledTransfer {
  fileId: string;
  name: string;
  mime: string;
  /** 总字节数（引用行展示与账面留痕） */
  size: number;
  /** 桌面侧落盘引用（saveAttachment 的返回；媒体走 fileId 引用链 / 文档走绝对路径引用行） */
  savedRef: string;
  settledAt: number;
}

export interface FileTransferStore {
  pending: Map<string, PendingTransfer>;
  settled: Map<string, SettledTransfer>;
}

export function createFileTransferStore(): FileTransferStore {
  return { pending: new Map(), settled: new Map() };
}

// ---------- offer ----------

export type OfferOutcome =
  | { ok: false; error: string }
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true; settled: SettledTransfer };

export function offerFile(
  store: FileTransferStore,
  o: FileOfferBody,
  now: number = Date.now(),
): OfferOutcome {
  // 参数合法性（fail-closed：畸形 offer 一律拒绝，不建幽灵传输）
  if (!o.fileId || typeof o.fileId !== 'string') return { ok: false, error: 'fileId 缺失' };
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 255) {
    return { ok: false, error: '文件名非法' };
  }
  if (!Number.isInteger(o.size) || o.size <= 0) return { ok: false, error: 'size 非法' };
  if (o.size > FILE_MAX_BYTES) {
    return { ok: false, error: `超过单文件上限 ${Math.floor(FILE_MAX_BYTES / 1024 / 1024)}MB` };
  }
  if (!/^[0-9a-f]{64}$/.test(o.sha256)) return { ok: false, error: 'sha256 形态非法' };
  if (!Number.isInteger(o.chunks) || o.chunks < 1 || o.chunks > Math.ceil(o.size / FILE_CHUNK_BYTES) + 1) {
    return { ok: false, error: 'chunks 非法' };
  }
  // 已完成的重复 offer：幂等（重发 receipt，不重复落盘/不重建缓冲）
  const settled = store.settled.get(o.fileId);
  if (settled) return { ok: true, duplicate: true, settled };
  // 未完成传输的重复 offer：容限续传语义（手机断线重发的正常形态——保留既有缓冲）
  if (store.pending.has(o.fileId)) return { ok: true, duplicate: false };
  // 并发未完成总量帽（按申报 size 计，防申报小实发大之外的最坏内存）
  let pendingBytes = 0;
  for (const p of store.pending.values()) pendingBytes += p.size;
  if (pendingBytes + o.size > FILE_MAX_PENDING_BYTES) {
    return { ok: false, error: '桌面并发传输过多，请稍后再试' };
  }
  store.pending.set(o.fileId, {
    fileId: o.fileId,
    name: o.name,
    mime: typeof o.mime === 'string' ? o.mime : 'application/octet-stream',
    size: o.size,
    sha256: o.sha256.toLowerCase(),
    chunks: o.chunks,
    received: new Map(),
    receivedBytes: 0,
    lastActivityAt: now,
  });
  return { ok: true, duplicate: false };
}

// ---------- chunk ----------

export type ChunkOutcome =
  | { kind: 'unknown' } // 无此传输（offer 未到/已被清理）——迟到分块丢弃
  | { kind: 'dup' } // 重复分块（幂等忽略）
  | { kind: 'stored' } // 已入缓冲
  | { kind: 'complete'; bytes: Uint8Array; transfer: PendingTransfer } // 齐块且校验通过（恰好一次交还字节）
  | { kind: 'corrupt'; error: string }; // 齐块但校验失败（传输已移除 → receipt ok:false）

export function receiveChunk(
  store: FileTransferStore,
  fileId: string,
  seq: number,
  dataB64u: string,
  now: number = Date.now(),
): ChunkOutcome {
  const p = store.pending.get(fileId);
  if (!p) return { kind: 'unknown' };
  if (!Number.isInteger(seq) || seq < 0 || seq >= p.chunks) return { kind: 'unknown' };
  if (p.received.has(seq)) return { kind: 'dup' };
  let bytes: Uint8Array;
  try {
    bytes = b64uDecode(dataB64u);
  } catch {
    return { kind: 'unknown' }; // 畸形 base64url 视同无效分块（不推进也不毒化缓冲）
  }
  if (bytes.length === 0 || bytes.length > FILE_CHUNK_BYTES) return { kind: 'unknown' };
  p.received.set(seq, bytes);
  p.receivedBytes += bytes.length;
  p.lastActivityAt = now;
  if (p.received.size < p.chunks) return { kind: 'stored' };
  // 齐块：重组 + 校验（一次性）
  const all = new Uint8Array(p.receivedBytes);
  let off = 0;
  for (let i = 0; i < p.chunks; i++) {
    const b = p.received.get(i);
    if (!b) {
      // 声明 chunks 与实际收块数不一致（防御：chunks 校验已限，此处理论不可达）
      store.pending.delete(fileId);
      return { kind: 'corrupt', error: '分块数与声明不一致' };
    }
    all.set(b, off);
    off += b.length;
  }
  const digest = bytesToHex(sha256(all));
  store.pending.delete(fileId); // 无论校验成败，缓冲使命结束（失败即终态，不保留半成品）
  if (off !== p.size || digest !== p.sha256) {
    return { kind: 'corrupt', error: 'sha256 校验失败（传输损坏），请重发' };
  }
  return { kind: 'complete', bytes: all, transfer: p };
}

// ---------- 完成 / 失败 / 取消 ----------

/** 调用方在 saveAttachment 成功后回填（进入完成态注册表） */
export function settleTransfer(
  store: FileTransferStore,
  fileId: string,
  savedRef: string,
  meta: { name: string; mime: string; size: number },
  now: number = Date.now(),
): SettledTransfer {
  const settled: SettledTransfer = { fileId, savedRef, settledAt: now, ...meta };
  store.settled.set(fileId, settled);
  return settled;
}

/** 调用方落盘失败（receipt ok:false 后清除，防半成品占位） */
export function dropTransfer(store: FileTransferStore, fileId: string): void {
  store.pending.delete(fileId);
  store.settled.delete(fileId);
}

/** file.abort：丢弃未完成缓冲；已完成的不动（手机迟到的 abort 不回收已落盘事实） */
export function abortTransfer(store: FileTransferStore, fileId: string): void {
  store.pending.delete(fileId);
}

/** chat.user attachments 解析依据 */
export function getSettled(store: FileTransferStore, fileId: string): SettledTransfer | null {
  return store.settled.get(fileId) ?? null;
}

// ---------- TTL 清扫（两档） ----------

export function sweepTransfers(store: FileTransferStore, now: number = Date.now()): void {
  for (const [id, p] of store.pending) {
    if (now - p.lastActivityAt > FILE_TRANSFER_TTL_MS) store.pending.delete(id);
  }
  for (const [id, s] of store.settled) {
    if (now - s.settledAt > FILE_SETTLED_TTL_MS) store.settled.delete(id);
  }
}
