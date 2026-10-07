/**
 * mediaFetcher.ts — d→m 文件拉取纯逻辑（Range 断点续拉 + 逐片认证 + 整文件 sha256 对账 + 取消）。
 * 与 mediaPublisherV2 镜像对称（上传↔拉取），传输/存储全部注入（getRange/appendTemp/tempSize/
 * hashTemp/finalizeTemp/discardTemp），jest 零 mock 基础设施。
 *
 * 仅 chunked（fmt:2）形态——d→m 方向一律 v2 分片语义（新方向无旧端兼容包袱，单一路径；
 * 收到非 chunked 形态 = 诚实报错，本方向不产生）。
 *
 * .part 断点语义：暂存文件存的是"已认证明文"（逐片 openMediaChunk 通过才追加）——
 * tempSize 即明文进度，续拉片号 = tempSize / MEDIA_CHUNK_BYTES；非整片边界 = 半截写入
 * （append 中断的残余），不可信，丢弃重来。密文不落暂存（解密在片边界完成）。
 */
import {
  openMediaChunk,
  mediaChunkRange,
  mediaWireSize,
  sanitizeFileName,
  b64uDecode,
  isB64u,
  MEDIA_CHUNK_BYTES,
  MEDIA_MAX_BYTES,
  MEDIA_NAME_RE,
  type FileOfferBody,
} from './envelope';

// ---------- 注入接口（session 用 fetch + blob-util 实现；jest 用内存 fake） ----------

/** Range 拉取（206 语义；HTTP 非 2xx 抛 FetchHttpError，网络断抛任意错误 → io） */
export type GetRange = (url: string, start: number, end: number) => Promise<Uint8Array>;
/** 追加已认证明文到暂存（.part 断点） */
export type AppendTemp = (fileId: string, bytes: Uint8Array) => Promise<void>;
/** 暂存当前大小（无暂存 = 0） */
export type TempSize = (fileId: string) => Promise<number>;
/** 暂存整文件 sha256 hex（全齐后整体对账） */
export type HashTemp = (fileId: string) => Promise<string>;
/** 全齐且对账通过 → 定稿为暂存明文路径（交付层读取源） */
export type FinalizeTemp = (fileId: string) => Promise<string>;
/** 丢弃暂存（过期/损坏清场；取消与网络断保留断点） */
export type DiscardTemp = (fileId: string) => Promise<void>;

/** HTTP 非 2xx 错误（getRange 注入方抛此型，拉取器据此分类：404/410 → expired，其余 → io） */
export class FetchHttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

export interface FetchOfferedFileOptions {
  offer: FileOfferBody;
  /** 密文名 → 全 URL（session 用自身 relayUrl 拼 /static/media/<name>——绝对 URL 不跨信任边界） */
  urlFor: (name: string) => string;
  getRange: GetRange;
  appendTemp: AppendTemp;
  tempSize: TempSize;
  hashTemp: HashTemp;
  finalizeTemp: FinalizeTemp;
  discardTemp: DiscardTemp;
  /** 进度回调（明文口径：已认证追加字节 / 总字节） */
  onProgress?: (received: number, total: number) => void;
  /** 取消检查（片边界生效；取消 = 中止拉取保留断点，不是扔掉已拉字节） */
  isCancelled?: () => boolean;
  now?: () => number;
}

export type FetchFileOutcome =
  | { ok: true; stagingPath: string; size: number; safeName: string }
  | { ok: false; error: 'expired' | 'corrupt' | 'io' | 'aborted'; detail?: string };

/**
 * d→m offer 形状校验（移植桌面 handleStaticOffer 的判据 + 本方向仅 chunked 收窄）。
 * 与桌面判据的一处差异：wireSize 用精确等值（mediaWireSize(size)——fmt:2 钉死 512KB 片，
 * 桌面发送端恰按此产出）替代桌面的区间判据；桌面区间下界（size+64）会误拒单片小文件
 * （d→m 小文件也是单片 v2——真实界 = size+40）。
 */
export function validateIncomingOffer(
  offer: FileOfferBody,
): { ok: true; st: NonNullable<FileOfferBody['static']> } | { ok: false; detail: string } {
  const st = offer?.static;
  if (
    typeof offer?.fileId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(offer.fileId) || // fileId 兼作暂存文件名——字符白名单防路径穿越
    typeof offer.name !== 'string' ||
    typeof offer.size !== 'number' ||
    !Number.isInteger(offer.size) ||
    offer.size <= 0 ||
    offer.size > MEDIA_MAX_BYTES ||
    typeof offer.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(offer.sha256) ||
    st === undefined ||
    st === null
  ) {
    return { ok: false, detail: 'offer 基本字段不合法' };
  }
  if (st.fmt !== 2) return { ok: false, detail: '非 v2 分片形态（d→m 方向不产生 v1 要约）' };
  if (
    typeof st.name !== 'string' ||
    !MEDIA_NAME_RE.test(st.name) ||
    typeof st.key !== 'string' ||
    !isB64u(st.key) ||
    typeof st.wireSize !== 'number' ||
    st.wireSize !== mediaWireSize(offer.size) ||
    typeof st.nonce !== 'string' ||
    !isB64u(st.nonce)
  ) {
    return { ok: false, detail: 'static 指针不合法' };
  }
  return { ok: true, st };
}

/**
 * 拉取主循环：断点定位 → 逐片 Range 拉取+认证+追加 → 整文件 sha256 对账 → 定稿。
 * 错误分类（receipt 枚举同源）：
 * - expired：要约 expiresAt 已过（本地判，零网络）/ 服务端 404·410（清场）——丢弃断点；
 * - corrupt：逐片认证失败 / 片长不符 / 整文件 sha256 不符——确定性 nonce 下重拉同结果，断点不推进并清场；
 * - io：网络断 / 暂存读写失败——保留断点，[重试]从断点续（Range offset 由 tempSize 推导）；
 * - aborted：用户取消——保留断点。
 */
export async function fetchOfferedFile(opts: FetchOfferedFileOptions): Promise<FetchFileOutcome> {
  const { offer, urlFor, getRange, appendTemp, tempSize, hashTemp, finalizeTemp, discardTemp, onProgress, isCancelled } = opts;
  const now = opts.now ?? Date.now;
  const fileId = offer.fileId;

  const v = validateIncomingOffer(offer);
  if (!v.ok) return { ok: false, error: 'corrupt', detail: v.detail };
  const st = v.st;
  const size = offer.size;

  // 过期本地判（诚实：不消耗一次必然 410 的网络请求）
  if (typeof offer.expiresAt === 'number' && now() > offer.expiresAt) {
    await discardTemp(fileId).catch(() => {});
    return { ok: false, error: 'expired', detail: '要约已过期（48h 保留期已过）' };
  }

  const fileNonce = b64uDecode(st.nonce!);
  if (fileNonce.length !== 16) return { ok: false, error: 'corrupt', detail: '分片 nonce 长度不合法' };
  const url = urlFor(st.name);
  const chunks = Math.ceil(size / MEDIA_CHUNK_BYTES);

  // 断点定位：tempSize = 已认证明文字节；非整片边界（半截写入残余）不可信 → 丢弃重来
  let have: number;
  try {
    have = await tempSize(fileId);
  } catch (e) {
    return { ok: false, error: 'io', detail: `断点读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (have < 0 || have > size || (have % MEDIA_CHUNK_BYTES !== 0 && have !== size)) {
    await discardTemp(fileId).catch(() => {});
    have = 0;
  }

  // have === size = 断点已完整（上次拉齐后对账/定稿环节中断）→ 跳过拉取直进对账
  for (let i = have / MEDIA_CHUNK_BYTES; have < size && i < chunks; i++) {
    if (isCancelled?.()) return { ok: false, error: 'aborted' };
    const { start, end } = mediaChunkRange(size, i);
    let wire: Uint8Array;
    try {
      wire = await getRange(url, start, end);
    } catch (e) {
      if (e instanceof FetchHttpError && (e.status === 404 || e.status === 410)) {
        await discardTemp(fileId).catch(() => {}); // 服务端已清场，断点无意义
        return { ok: false, error: 'expired', detail: `密文已不在中继（HTTP ${e.status}）` };
      }
      return { ok: false, error: 'io', detail: e instanceof Error ? e.message : String(e) }; // 网络断：保留断点
    }
    if (wire.length !== end - start + 1) {
      await discardTemp(fileId).catch(() => {});
      return { ok: false, error: 'corrupt', detail: `片 ${i} 长度不符（${wire.length} ≠ ${end - start + 1}）` };
    }
    const plain = openMediaChunk(wire, st.key, fileNonce, i);
    if (!plain) {
      // 逐片认证失败 = 密文被篡改/密钥不符——确定性 nonce 下重拉同片必然同结果，不推进断点
      await discardTemp(fileId).catch(() => {});
      return { ok: false, error: 'corrupt', detail: `片 ${i} 解密/认证失败` };
    }
    try {
      await appendTemp(fileId, plain);
    } catch (e) {
      return { ok: false, error: 'io', detail: `暂存写入失败：${e instanceof Error ? e.message : String(e)}` };
    }
    have += plain.length;
    onProgress?.(have, size);
  }

  if (isCancelled?.()) return { ok: false, error: 'aborted' };

  // 整文件 sha256 对账（明文口径；对账不过 = 暂存不可信，清场）
  let hex: string;
  try {
    hex = (await hashTemp(fileId)).toLowerCase();
  } catch (e) {
    return { ok: false, error: 'io', detail: `暂存哈希失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (hex !== offer.sha256.toLowerCase()) {
    await discardTemp(fileId).catch(() => {});
    return { ok: false, error: 'corrupt', detail: '整文件 sha256 对账不符' };
  }

  try {
    const stagingPath = await finalizeTemp(fileId);
    return { ok: true, stagingPath, size, safeName: sanitizeFileName(offer.name) };
  } catch (e) {
    return { ok: false, error: 'io', detail: `暂存定稿失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
