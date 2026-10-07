/**
 * mediaPublisher.ts — 媒体直传发布器（纯逻辑，传输注入，jest 直测；RN/Node 双安全）。
 *
 * 职责：sealMediaBlob 整块加密（每附件随机密钥）→ 随机 32hex 名 → 注入 put 上传 → 产出 static offer 字段。
 * 不做：offer 投递 / receipt 等待 / 回退编排（session.ts 职责——presence 门控在那一层）。
 * 行业同构：WhatsApp/Signal/微信 = 客户端加密上传 blob + 消息传指针+密钥（控制面/数据面分离）。
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import nacl from 'tweetnacl';
import { sealMediaBlob, MEDIA_NAME_RE, FILE_MAX_BYTES } from './envelope';

/** 直传传输：PUT /media/<name>（密文整块）；返回 HTTP 状态码（201=发布成功；0=网络失败） */
export type PutMedia = (name: string, wire: Uint8Array, onProgress?: (pct: number) => void) => Promise<number>;

export type PublishOutcome =
  | { ok: true; name: string; key: string; size: number; sha256: string }
  | { ok: false; reason: 'too-large' | 'put-failed'; status?: number };

/** 随机密文名：<32hex>.bin（128-bit 熵——不可猜名即读取凭据；与 relay MEDIA 名形对齐）。
 *  随机源用 tweetnacl randomBytes（envelope 同源——jest/RN 双环境已实证；直用 crypto.getRandomValues 在 jest 不稳） */
export function randomMediaName(): string {
  const b = nacl.randomBytes(16); // 16 字节 = 32 hex 字符 = 128-bit 熵（与 MEDIA_NAME_RE 对齐）
  let hex = '';
  for (const x of b) hex += x.toString(16).padStart(2, '0');
  const name = `${hex}.bin`;
  return MEDIA_NAME_RE.test(name) ? name : randomMediaName();
}

/** 发布：加密 → 上传 → 产出 offer 字段。任何 put 失败由调用方回退（分片路径保底）。 */
export async function publishMedia(opts: {
  bytes: Uint8Array;
  put: PutMedia;
  onProgress?: (pct: number) => void;
}): Promise<PublishOutcome> {
  const { bytes, put } = opts;
  if (bytes.length === 0 || bytes.length > FILE_MAX_BYTES) return { ok: false, reason: 'too-large' };
  const { wire, keyB64u } = sealMediaBlob(bytes);
  const name = randomMediaName();
  const status = await put(name, wire, opts.onProgress);
  if (status !== 201) return { ok: false, reason: 'put-failed', status };
  return { ok: true, name, key: keyB64u, size: bytes.length, sha256: bytesToHex(sha256(bytes)) };
}

// ---------- static receipt 等待的 presence 门控决策（纯函数，jest 直测） ----------
// 设计定案（实测教训）：receipt 超时回退仅当桌面在线（旧桌面判定）；离线不回退——
// 否则把媒体灌回信箱，复活「桌面离线 3 张顶满 5MB 信箱」的旧病。

export const STATIC_RECEIPT_TICK_MS = 2_000;
/** 在线累计满此窗仍无回执 → 判旧桌面 → 回退分片路径 */
export const STATIC_RECEIPT_ONLINE_WINDOW_MS = 20_000;
/** 等待总时长上限（桌面一直不上线 → 诚实失败；媒体已在服务器保留 48h，可重试） */
export const STATIC_WAIT_MAX_MS = 15 * 60_000;

export type ReceiptWaitDecision = 'wait' | 'fallback' | 'timeout-error';

/** 每拍决策：在线累计满窗 → fallback；总时长到顶 → timeout-error；其余 → wait（离线恒 wait） */
export function receiptWaitStep(online: boolean, onlineAccumMs: number, waitedMs: number): ReceiptWaitDecision {
  if (waitedMs >= STATIC_WAIT_MAX_MS) return 'timeout-error';
  if (online && onlineAccumMs >= STATIC_RECEIPT_ONLINE_WINDOW_MS) return 'fallback';
  return 'wait';
}
