/**
 * fileSender.ts — d→m 文件发送器（桌面→手机；纯逻辑，Node-free 红线：禁 node:* 与 Buffer，
 * renderer/RN 安全，与 envelope.ts 同款纪律）。
 *
 * 一律 v2 分片语义（单片 = 小文件，与整包同成本；d→m 是全新方向、无旧端兼容包袱，
 * 单一路径删掉整个 v1 分支）。镜像手机 mediaPublisherV2 的结构与纪律：
 * 传输全部注入（statFile/readSlice/putChunk），node:test 零 mock 可测。
 *
 * 流程：statFile（护栏基线）→ 流式 sha256 → newMediaFileKeys → 逐片 readSlice→sealMediaChunk→
 * PUT@offset（409 读 current 再同步续传；429 固定 35s 重试同一片不当失败——沿用手机
 * fileUploader 的真机实测教训）→ 完成后 re-stat（桌面文件边传边改的竞态护栏）→ 产出 offer。
 * 校验单点在 RelayBridge.sendFileToMobile（denylist/存在性/空文件/帽），本模块只做传输与对账。
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
  b64uEncode,
  randomUuid,
  sanitizeFileName,
  type FileOfferBody,
} from './envelope';

// ---------- 注入接口 ----------

/** 文件切片读取（offset/length 明文口径；壳侧 Node fs / IPC 实现） */
export type ReadFileSlice = (offset: number, length: number) => Promise<Uint8Array>;

/** 文件 stat（mutated 护栏数据源：发送前与完成后各调一次，双调比对） */
export type StatFile = () => Promise<{ size: number; mtimeMs: number }>;

/**
 * 单片 PUT 结果（注入方把 HTTP 转成结构化返回）：
 * 2xx = 追加成功；409 + current = 服务端当前密文长度（发送器负责再同步循环）；
 * 429 = 中继限频（固定 35s 等待后重试同一片，不当失败）；其余状态/抛错 = 传输失败（指数退避）。
 */
export interface PutChunkResult {
  status: number;
  /** 409 时服务端已确认的 .part 长度（密文字节） */
  current?: number;
}

/** 密文分片上传（name=MEDIA_NAME_RE 密文名，offset/total 为密文口径字节） */
export type PutMediaChunk = (
  name: string,
  offset: number,
  total: number,
  bytes: Uint8Array,
) => Promise<PutChunkResult>;

// ---------- 选项与产出 ----------

export interface SendFileOptions {
  /** 原始文件名（sanitizeFileName 清洗后入 offer——路径穿越防御） */
  name: string;
  /** 缺省按扩展名内置映射表推断（卡片图标与[打开]行为都靠它，不靠调用方自觉） */
  mime?: string;
  /** 发出方当前会话 id（卡片长在产生它的那轮对话里） */
  sessionId?: string;
  readSlice: ReadFileSlice;
  statFile: StatFile;
  putChunk: PutMediaChunk;
  /** 上传进度回调（明文口径已发字节/总字节——桌面侧用户不能在沉默的终端前干等） */
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  /** 取消旗标（每片边界检查；取消 = 已上传密文保留在中继，48h TTL 自然清扫） */
  isCancelled?: () => boolean;
  /** 休眠注入（429/退避用；测试传假休眠） */
  sleep?: (ms: number) => Promise<void>;
  /** 时钟注入（expiresAt 计算；测试可固定） */
  now?: () => number;
  /** 单片重试上限（429/网络失败退避后仍失败则终局；缺省 5） */
  maxChunkRetries?: number;
}

export type SendFileOutcome =
  | { ok: true; offer: FileOfferBody }
  | {
      ok: false;
      reason:
        | 'file-read' // statFile/readSlice 失败
        | 'empty' // 0 字节文件（零分片算术边缘，诚实拒绝——桥层同闸双保险）
        | 'too-large' // > MEDIA_MAX_BYTES
        | 'cancelled'
        | 'upload-failed'
        | 'conflict-unresolved' // 409 对齐次数超限（服务端状态异常）
        | 'file-mutated'; // 边传边改（re-stat 护栏命中）
      detail?: string;
    };

/** 要约 TTL（= PUT 完成时刻 + 48h，与中继成品 TTL 对齐——过期收件端本地可判） */
export const FILE_OFFER_TTL_MS = 48 * 60 * 60 * 1000;

/** 429 固定等待：35 秒（> 60s 窗口的半程，保证任何窗口位重置——手机 fileUploader 真机实测教训同值） */
export const RATE_LIMIT_RETRY_MS = 35_000;

/** 单片密文长度（nonce 24B + ct(明文+16B MAC)）——409 对齐算术基准 */
const CHUNK_WIRE_SIZE = 24 + MEDIA_CHUNK_BYTES + 16;

// ---------- mime 扩展名映射（缺省 application/octet-stream） ----------

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 图像/视频与 engine/mediaMention 的 MEDIA_EXTENSIONS 同值
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** 扩展名 → mime（小写取段；未知一律 application/octet-stream） */
export function mimeFromFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXT[name.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

// ---------- 发送主流程 ----------

/**
 * 单文件发送（v2 分片唯一路径）：
 * 409 再同步——服务端返回 current 长度 → 跳片对齐（确定性 nonce 保证同片密文恒等，重复片自愈）；
 * 429 限频——固定 35s 重试同一片；其余失败——指数退避 1s→2s→4s… 封顶 30s。
 */
export async function sendFile(opts: SendFileOptions): Promise<SendFileOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const maxChunkRetries = opts.maxChunkRetries ?? 5;

  let st1: { size: number; mtimeMs: number };
  try {
    st1 = await opts.statFile();
  } catch (err) {
    return { ok: false, reason: 'file-read', detail: err instanceof Error ? err.message : String(err) };
  }
  const size = st1.size;
  if (size <= 0) return { ok: false, reason: 'empty' };
  if (size > MEDIA_MAX_BYTES) return { ok: false, reason: 'too-large' };

  // ---------- 流式 sha256（整文件对账指纹随 offer 走） ----------
  const hasher = sha256.create();
  for (let off = 0; off < size; off += MEDIA_CHUNK_BYTES) {
    if (opts.isCancelled?.()) return { ok: false, reason: 'cancelled' };
    const len = Math.min(MEDIA_CHUNK_BYTES, size - off);
    let chunk: Uint8Array;
    try {
      chunk = await opts.readSlice(off, len);
    } catch (err) {
      return { ok: false, reason: 'file-read', detail: err instanceof Error ? err.message : String(err) };
    }
    hasher.update(chunk);
  }
  const sha256Hex = bytesToHex(hasher.digest());

  // ---------- 逐片加密 + PUT@offset ----------
  const { fileNonce, keyB64u } = newMediaFileKeys();
  const wireSize = mediaWireSize(size);
  const chunks = Math.ceil(size / MEDIA_CHUNK_BYTES);
  const name = randomMediaName();

  // 已确认的服务端 .part 长度（= 累计已上传密文字节）
  let serverOffset = 0;
  // 防死循环：同一片的 409 对齐次数上限（超过 = 服务端状态异常，诚实报败）
  let reentries = 0;
  const maxReentries = chunks * 2;

  for (let i = 0; i < chunks; i++) {
    if (opts.isCancelled?.()) return { ok: false, reason: 'cancelled' };
    if (++reentries > maxReentries) {
      return { ok: false, reason: 'conflict-unresolved', detail: `409 对齐次数超限（${reentries} > ${maxReentries}）` };
    }

    const { start: wireStart } = mediaChunkRange(size, i);
    const plainLen = Math.min(MEDIA_CHUNK_BYTES, size - i * MEDIA_CHUNK_BYTES);
    let plain: Uint8Array;
    try {
      plain = await opts.readSlice(i * MEDIA_CHUNK_BYTES, plainLen);
    } catch (err) {
      return { ok: false, reason: 'file-read', detail: err instanceof Error ? err.message : String(err) };
    }
    const wire = sealMediaChunk(plain, keyB64u, fileNonce, i);

    // 服务端已有此片（之前响应丢失但实际成功）→ 跳过
    if (serverOffset >= wireStart + wire.length) {
      opts.onProgress?.(Math.min((i + 1) * MEDIA_CHUNK_BYTES, size), size);
      continue;
    }

    let uploaded = false;
    let lastErr: string | null = null;
    for (let attempt = 0; attempt <= maxChunkRetries; attempt++) {
      if (opts.isCancelled?.()) return { ok: false, reason: 'cancelled' };
      let r: PutChunkResult;
      try {
        r = await opts.putChunk(name, wireStart, wireSize, wire);
      } catch (err) {
        r = { status: -1 };
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (r.status >= 200 && r.status < 300) {
        uploaded = true;
        serverOffset = wireStart + wire.length;
        break;
      }
      if (r.status === 409 && typeof r.current === 'number' && Number.isInteger(r.current) && r.current >= 0) {
        serverOffset = r.current;
        if (r.current >= wireStart + wire.length) {
          uploaded = true; // 服务端已有此片
          break;
        }
        if (r.current > wireStart) {
          uploaded = true; // 服务端领先（前片实际成功但本片是旧重试）→ 跳过本片继续
          break;
        }
        if (r.current < wireStart) {
          // 服务端落后 → 对齐到服务端实际位置的片重发
          const alignChunk = Math.floor(r.current / CHUNK_WIRE_SIZE);
          if (alignChunk < i) {
            i = alignChunk - 1; // 抵消 for 的 i++——下一轮从 alignChunk 继续
            uploaded = true;
            break;
          }
          // alignChunk == i（服务端正好在本片起点）→ 正常重试本片
        }
        // current == wireStart → 正常重试
        continue;
      }
      if (r.status === 429) {
        // 中继限频：固定 35s 重试同一片，不当失败（消耗一次重试额度防无限）
        lastErr = '中继限频（429）';
        if (attempt < maxChunkRetries) await sleep(RATE_LIMIT_RETRY_MS);
        continue;
      }
      // 其余传输失败 → 指数退避 1s→2s→4s… 封顶 30s
      if (r.status > 0) lastErr = `HTTP ${r.status}`;
      if (attempt < maxChunkRetries) await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
    if (!uploaded) {
      return { ok: false, reason: 'upload-failed', detail: `片 ${i}/${chunks} 上传失败：${lastErr ?? '重试耗尽'}` };
    }
    opts.onProgress?.(Math.min((i + 1) * MEDIA_CHUNK_BYTES, size), size);
  }

  // ---------- mutated 护栏：上传完成后 re-stat，边传边改即诚实报败 ----------
  let st2: { size: number; mtimeMs: number };
  try {
    st2 = await opts.statFile();
  } catch (err) {
    return { ok: false, reason: 'file-read', detail: err instanceof Error ? err.message : String(err) };
  }
  if (st2.size !== st1.size || st2.mtimeMs !== st1.mtimeMs) {
    return { ok: false, reason: 'file-mutated', detail: '文件在发送过程中被修改，请重新发送' };
  }

  // ---------- 产出 offer（expiresAt = PUT 完成时刻 + 48h，与中继成品 TTL 对齐） ----------
  const offer: FileOfferBody = {
    fileId: randomUuid(), // 既有信封 id 同款生成路径（makeEnvelope 内部也是 randomUuid），不新造
    name: sanitizeFileName(opts.name),
    mime: opts.mime ?? mimeFromFileName(opts.name),
    size,
    sha256: sha256Hex,
    chunks: 0, // static 路径无信箱分块——恒 0
    static: { name, key: keyB64u, fmt: 2, wireSize, nonce: b64uEncode(fileNonce) },
    expiresAt: now() + FILE_OFFER_TTL_MS,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  };
  return { ok: true, offer };
}

// ---------- 辅助 ----------

/** 密文名（32hex = 128-bit 熵，不可猜名即读取凭据；与手机 mediaPublisherV2 同形） */
function randomMediaName(): string {
  const b = nacl.randomBytes(16);
  let hex = '';
  for (const x of b) hex += x.toString(16).padStart(2, '0');
  const name = `${hex}.bin`;
  return MEDIA_NAME_RE.test(name) ? name : randomMediaName();
}
