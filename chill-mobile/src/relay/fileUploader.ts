/**
 * fileUploader.ts — file.* 协议族手机侧上传器（纯逻辑，RN/Node 双安全，jest 直测）。
 *
 * 职责：分片（FILE_CHUNK_BYTES 单源）→ sha256 整体指纹 → offer/chunk 串行投递
 * （每封等落定再发下一封——信箱 FIFO 保序的发送侧前提）→ 429/网络失败指数退避。
 * 不做：receipt 等待与 chat.user 编排（session.ts 职责——receipt 门控在那一层）；
 * 不含 fetch/RN API——投递与休眠全部注入，测试零 mock 基础设施。
 * 常量与线形全部来自 envelope.ts（core 单源同步生成，禁手改）。
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { b64uEncode, FILE_CHUNK_BYTES, FILE_MAX_BYTES } from './envelope';

/** 投递函数：入参线形信封（type+body），返回 HTTP 状态码（201=受理） */
export type PostEnvelope = (env: { type: string; body: Record<string, unknown> }) => Promise<number>;

export type UploadOutcome =
  | 'ok' // 全部分块投递完成（≠桌面已确认——receipt 由 session 层等待）
  | 'cancelled'
  | 'too-large'
  | 'post-failed'; // 非 429 的拒绝或退避重试耗尽

export interface UploadOptions {
  fileId: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  post: PostEnvelope;
  /** 进度回调（0-100，按已投递分块计） */
  onProgress?: (pct: number) => void;
  /** 取消旗标（外部置 true 即在下一分块前停） */
  isCancelled?: () => boolean;
  /** 休眠注入（退避用；jest 传假时钟） */
  sleep?: (ms: number) => Promise<void>;
  /** 单封重试上限（429/网络失败退避后仍失败则终局；缺省 5） */
  maxRetries?: number;
}

/** 退避序列（纯函数）：1s→2s→4s→8s→16s→30s 封顶——速率自适应（不假设服务器配置） */
export function nextChunkRetryMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/**
 * 带退避的单封投递：
 * - 429（速率限制）：固定 35s 等待（信箱窗口 60s——35s 足够任何窗口位重置；指数退避 31s 总量不够，真机实测教训）
 * - 5xx（服务器抖动）：指数退避 1s→2s→4s… 封顶 30s
 */
export async function postWithRetry(
  env: { type: string; body: Record<string, unknown> },
  post: PostEnvelope,
  sleep: (ms: number) => Promise<void>,
  maxRetries: number,
): Promise<'ok' | 'retry-exhausted' | 'rejected'> {
  for (let attempt = 0; ; attempt++) {
    const status = await post(env);
    if (status === 201) return 'ok';
    if (status === 429 && attempt < maxRetries) {
      await sleep(RATE_LIMIT_RETRY_MS);
      continue;
    }
    if (status >= 500 && attempt < maxRetries) {
      await sleep(nextChunkRetryMs(attempt));
      continue;
    }
    return status === 429 || status >= 500 ? 'retry-exhausted' : 'rejected';
  }
}

/** 429 固定等待：35 秒（> 60s 窗口的半程，保证任何窗口位重置） */
export const RATE_LIMIT_RETRY_MS = 35_000;

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 单文件上传：offer → chunk×N 串行（每封等落定再发下一封）。
 * 返回 'ok' 只代表全部分块已被信箱受理——桌面确认（file.receipt）由调用方门控。
 */
export async function uploadFile(opts: UploadOptions): Promise<UploadOutcome> {
  const { fileId, name, mime, bytes, post } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 5;
  if (bytes.length === 0) return 'post-failed';
  if (bytes.length > FILE_MAX_BYTES) return 'too-large';
  const chunks = Math.ceil(bytes.length / FILE_CHUNK_BYTES);
  const offer = {
    type: 'file.offer',
    body: {
      fileId,
      name,
      mime,
      size: bytes.length,
      sha256: bytesToHex(sha256(bytes)),
      chunks,
    } as Record<string, unknown>,
  };
  const offerR = await postWithRetry(offer, post, sleep, maxRetries);
  if (offerR !== 'ok') return 'post-failed';
  opts.onProgress?.(0);
  for (let seq = 0; seq < chunks; seq++) {
    if (opts.isCancelled?.()) return 'cancelled';
    const from = seq * FILE_CHUNK_BYTES;
    const chunkEnv = {
      type: 'file.chunk',
      body: { fileId, seq, data: b64uEncode(bytes.subarray(from, from + FILE_CHUNK_BYTES)) } as Record<string, unknown>,
    };
    const r = await postWithRetry(chunkEnv, post, sleep, maxRetries);
    if (r !== 'ok') return 'post-failed';
    opts.onProgress?.(Math.round(((seq + 1) / chunks) * 100));
  }
  return 'ok';
}

/** 组装 chat.user 的 attachments 载荷（与桌面 parseChatUserAttachments 对齐：≤5 项） */
export function buildAttachments(files: Array<{ fileId: string; name: string; mime: string }>): Array<Record<string, string>> {
  return files.slice(0, 5).map((f) => ({ fileId: f.fileId, name: f.name, mime: f.mime }));
}
