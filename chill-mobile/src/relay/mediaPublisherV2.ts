/**
 * mediaPublisherV2.ts — v2 分片上传纯逻辑（路径化流式 + 确定性 nonce + 409 再同步 + 取消 + 流式哈希）。
 * 与 v1 publishMedia 平行（小文件仍走 v1 整包快路；大文件走本模块——tray 按 size 判别）。
 * 传输全部注入（putChunk/readSlice/getFileSize），jest 零 mock 基础设施。
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import nacl from 'tweetnacl';
import {
  newMediaFileKeys,
  sealMediaChunk,
  mediaChunkRange,
  mediaWireSize,
  MEDIA_CHUNK_BYTES,
  MEDIA_MAX_BYTES,
  MEDIA_NAME_RE,
  FILE_MAX_BYTES,
  b64uEncode,
} from './envelope';

// ---------- 类型 ----------

export type PutChunk = (
  name: string,
  offset: number,
  total: number,
  wire: Uint8Array,
) => Promise<number | { conflict: number }>; // 201=追加 ok / {conflict: N}=409 服务端当前

export type ReadSlice = (path: string, start: number, length: number) => Promise<Uint8Array>;

export type GetFileSize = (path: string) => Promise<number>;

export interface UploadV2Options {
  path: string;
  putChunk: PutChunk;
  readSlice: ReadSlice;
  getFileSize: GetFileSize;
  onProgress?: (pct: number) => void;
  onStage?: (stage: 'hashing' | 'uploading') => void;
  isCancelled?: () => boolean;
  /** 每片退避基线 ms（jest 可缩短） */
  retryBaseMs?: number;
  maxChunkRetries?: number;
}

export type UploadV2Outcome =
  | { ok: true; name: string; key: string; nonce: string; size: number; wireSize: number; sha256: string }
  | { ok: false; reason: 'too-large' | 'file-read' | 'cancelled' | 'upload-failed' | 'conflict-unresolved'; detail?: string };

/** >5MB 走 v2 分片；≤5MB 走 v1 整包（信箱回退网覆盖） */
export const V2_THRESHOLD_BYTES = FILE_MAX_BYTES;

/** 单片密文长度（nonce 24B + ct(明文+16B MAC)） */
const CHUNK_WIRE_SIZE = 24 + MEDIA_CHUNK_BYTES + 16;

// ---------- 上传主循环 ----------

/**
 * v2 分片上传：流式哈希（准备阶段）→ 逐片读+加密+PUT@offset（上传阶段）。
 * 409 再同步：服务端返回 conflict 长度 → 跳片对齐（重复片自愈——确定性 nonce 保证同片密文恒等）。
 * 取消：isCancelled() 在每片边界检查；取消 = 已上传片保留在服务器（24h TTL 自然清扫）。
 */
export async function uploadFileV2(opts: UploadV2Options): Promise<UploadV2Outcome> {
  const {
    path,
    putChunk,
    readSlice,
    getFileSize,
    onProgress,
    onStage,
    isCancelled,
    retryBaseMs = 1000,
    maxChunkRetries = 5,
  } = opts;

  let size: number;
  try {
    size = await getFileSize(path);
  } catch {
    return { ok: false, reason: 'file-read', detail: '无法读取文件大小' };
  }
  if (size <= 0) return { ok: false, reason: 'file-read', detail: '空文件' };
  if (size > MEDIA_MAX_BYTES) return { ok: false, reason: 'too-large' };

  // ---------- 阶段 1：流式哈希（准备中——100MB ≈ 5~15s） ----------
  onStage?.('hashing');
  const hasher = sha256.create();
  for (let off = 0; off < size; off += MEDIA_CHUNK_BYTES) {
    if (isCancelled?.()) return { ok: false, reason: 'cancelled' };
    const len = Math.min(MEDIA_CHUNK_BYTES, size - off);
    const chunk = await readSlice(path, off, len);
    hasher.update(chunk);
  }
  const sha256Hex = bytesToHex(hasher.digest());

  // ---------- 阶段 2：逐片加密+上传 ----------
  onStage?.('uploading');
  const { fileNonce, keyB64u } = newMediaFileKeys();
  const wireSize = mediaWireSize(size);
  const chunks = Math.ceil(size / MEDIA_CHUNK_BYTES);
  const name = randomMediaNameV2();

  // 已确认的服务端 .part 长度（= 累计已上传密文字节）
  let serverOffset = 0;
  // 防死循环：同一片的 409 对齐次数上限（超过=服务端状态异常，诚实报败）
  let reentries = 0;
  const maxReentries = chunks * 2;

  for (let i = 0; i < chunks; i++) {
    if (isCancelled?.()) return { ok: false, reason: 'cancelled' };
    if (++reentries > maxReentries) {
      return { ok: false, reason: 'conflict-unresolved', detail: `409 对齐次数超限（${reentries} > ${maxReentries}）` };
    }

    const { start: wireStart } = mediaChunkRange(size, i);
    const plainLen = Math.min(MEDIA_CHUNK_BYTES, size - i * MEDIA_CHUNK_BYTES);
    const plain = await readSlice(path, i * MEDIA_CHUNK_BYTES, plainLen);
    const wire = sealMediaChunk(plain, keyB64u, fileNonce, i);

    // 服务端已有此片（之前响应丢失但实际成功）→ 跳过
    if (serverOffset >= wireStart + wire.length) {
      onProgress?.(Math.round(((i + 1) / chunks) * 100));
      continue;
    }

    // 重试循环
    let uploaded = false;
    let lastErr: string | null = null;
    for (let attempt = 0; attempt <= maxChunkRetries; attempt++) {
      if (isCancelled?.()) return { ok: false, reason: 'cancelled' };
      try {
        const result = await putChunk(name, wireStart, wireSize, wire);
        if (typeof result === 'number' && result === 201) {
          uploaded = true;
          serverOffset = wireStart + wire.length;
          break;
        }
        if (typeof result === 'object' && result !== null && 'conflict' in result) {
          const conflict = (result as { conflict: number }).conflict;
          serverOffset = conflict;
          if (conflict >= wireStart + wire.length) {
            uploaded = true; // 服务端已有此片
            break;
          }
          if (conflict > wireStart) {
            // 服务端领先（前片实际成功但本片是旧重试）→ 跳过本片继续
            uploaded = true;
            break;
          }
          // conflict < wireStart 或 == wireStart → 对齐到服务端实际位置的片重发
          if (conflict < wireStart) {
            const alignChunk = Math.floor(conflict / CHUNK_WIRE_SIZE);
            if (alignChunk < i) {
              i = alignChunk; // for 循环 i++ 后从 alignChunk+1 继续——不，我们要从 alignChunk 继续
              i--; // 减 1 抵消 for 的 i++
              uploaded = true; // 跳出重试，外层 for 重新对齐
              break;
            }
            // alignChunk == i（服务端正好在本片起点）→ 正常重试本片
          }
          // conflict == wireStart → 正常重试
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      // 网络类失败 → 指数退避
      if (attempt < maxChunkRetries && !uploaded) {
        await new Promise<void>((r) => setTimeout(() => r(), retryBaseMs * Math.min(30, 2 ** attempt)));
      }
    }
    if (!uploaded) {
      return { ok: false, reason: 'upload-failed', detail: `片 ${i}/${chunks} 上传失败：${lastErr ?? '重试耗尽'}` };
    }
    onProgress?.(Math.round(((i + 1) / chunks) * 100));
  }

  return {
    ok: true,
    name,
    key: keyB64u,
    nonce: b64uEncode(fileNonce),
    size,
    wireSize,
    sha256: sha256Hex,
  };
}

// ---------- 辅助 ----------

function randomMediaNameV2(): string {
  const b = nacl.randomBytes(16); // 16 字节 = 32 hex 字符 = 128-bit 熵
  let hex = '';
  for (const x of b) hex += x.toString(16).padStart(2, '0');
  const name = `${hex}.bin`;
  return MEDIA_NAME_RE.test(name) ? name : randomMediaNameV2();
}

/** v2 offer static 字段组装（session.ts 消费） */
export function buildStaticV2(r: {
  name: string;
  key: string;
  nonce: string;
  wireSize: number;
}): { name: string; key: string; fmt: number; wireSize: number; nonce: string } {
  return { ...r, fmt: 2 };
}
