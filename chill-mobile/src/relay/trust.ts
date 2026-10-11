/**
 * trust.ts — TLS 信任三态（2026-10-11 规划迭代 B，F1 手机侧）。
 *
 * 信任解析四行表（SSOT；与 android/.../CaTrustModule.kt 执行层、规划 §3 三方对齐）：
 *   QR 有 caCert（base64 DER，随码分发的完整信任锚）→ pinned：只信该 CA（严格钉住）
 *   QR 无 caCert 有 caFP（须==内置，session.pair 把关）   → legacy：内置 CA（现状逐位）
 *   QR 两者皆无（公共证书，如 Let's Encrypt）             → system：系统 CA（WebPKI）
 *   无持久化 tls（冷启动/旧配对态）                        → 缺省快照 = 内置（兼容锚）
 *
 * 设计纪律（规划定案）：
 * - never connect before verify：QR 直携完整证书，拒绝指纹 TOFU 的先连后验观察窗口
 * - caCert 与 caFP 不做交叉校验——同一 QR 内无主次信任源，交叉校验是安全剧场（留痕）
 * - 严格钉住不并内置：作者 CA 不得成为第三方自建用户的隐式备用根（对抗性评估发现 1）
 * - 明文知情同意在决策现场：ws:// 中继在配对态可见警示（cleartextWarning）
 */
import { NativeModules } from 'react-native';
import { sha256 } from '@noble/hashes/sha256';
import { b64uEncode } from './envelope';
import { fromByteArray as bytesToB64 } from 'base64-js';
import { CA_FP } from './ca-bundle';
import type { PhoneState } from './storage';

/** PhoneState.tls 判别式（additive；缺省=legacy 内置态） */
export type TlsTrust =
  | { mode: 'pinned'; caB64: string }
  | { mode: 'system' };

interface CaTrustNative {
  setTrust(opts: { pinnedCaB64?: string; useSystemCa?: boolean }): Promise<boolean>;
}

function native(): CaTrustNative | undefined {
  return (NativeModules as Record<string, unknown>)['CaTrustModule'] as CaTrustNative | undefined;
}

const B64_RE = /^[A-Za-z0-9+/\-_]+={0,2}$/;

/**
 * 配对信任判定（纯函数，jest 直测；规划 R3 起四态五分支）。
 * 只判形状与协议语义；证书可解析性/指纹匹配由取材流程与原生层证明。
 * - caCert（旧桌面过渡）→ pinned（直接钉住码内材料）
 * - caFP≠内置 + wss → **bootstrap**（材料经 /pair/ca/:fp 取材 + QR 指纹锚校验后钉住——新常态）
 * - caFP==内置 → legacy（缺省快照；作者场景零网络直通）
 * - 皆无 → system（公共证书）
 * - caFP≠内置 + 非 wss → abort（畸形载荷——CA 模式只存在于 wss）
 */
export function resolvePairingTrust(qr: {
  caCert?: unknown;
  caFP?: unknown;
  relay?: unknown;
}): { ok: true; tls: PhoneState['tls']; bootstrap?: boolean } | { ok: false; error: string } {
  if (typeof qr.caCert === 'string' && qr.caCert !== '') {
    if (!B64_RE.test(qr.caCert)) {
      return { ok: false, error: 'caCert 不是合法 base64，可能是伪造/损坏的二维码，中止配对' };
    }
    // 严格钉住；不与 caFP 交叉校验（见文件头纪律）
    return { ok: true, tls: { mode: 'pinned', caB64: qr.caCert } };
  }
  if (qr.caCert !== undefined && qr.caCert !== null && typeof qr.caCert !== 'string') {
    return { ok: false, error: 'caCert 字段类型非法，中止配对' };
  }
  if (typeof qr.caFP === 'string' && qr.caFP !== '') {
    if (qr.caFP === CA_FP) {
      return { ok: true, tls: undefined }; // legacy：==内置（已按锚等值确认）
    }
    if (typeof qr.relay === 'string' && qr.relay.startsWith('wss://')) {
      return { ok: true, tls: undefined, bootstrap: true }; // 引导取材（材料待锚校验）
    }
    return { ok: false, error: 'caFP 与内置 CA 不符且非 wss 中继（畸形载荷），中止配对' };
  }
  return { ok: true, tls: { mode: 'system' } };
}

/** 明文中继的配对态警示文案（决策现场呈现；纯函数便于单测） */
export function cleartextWarning(relay: string): string {
  return relay.startsWith('ws://')
    ? '⚠ 该中继为明文连接（ws://）——传输不经加密，仅建议家庭网络使用'
    : '';
}

/**
 * 把信任态应用到原生层（OkHttp 全局信任快照；redeem 走 TLS，必须先于任何连接调用）。
 * t=null → 缺省快照（内置 CA；重置/legacy 场景）。原生模块缺失（jest 环境）静默跳过——
 * 真机缺失即原生层保持缺省快照，与旧 APK 行为一致。
 */
export async function applyTrustToNative(t: TlsTrust | null): Promise<void> {
  const m = native();
  if (!m) return;
  if (t && t.mode === 'pinned') {
    await m.setTrust({ pinnedCaB64: t.caB64 });
  } else if (t && t.mode === 'system') {
    await m.setTrust({ useSystemCa: true });
  } else {
    await m.setTrust({});
  }
}

// ---------- 引导取材（配对小码规划 R3：材料经指纹锚鉴别获取） ----------

/** 取材器：GET url → 响应体文本（JSON {caB64}）。手机=原生匿名 TLS 单次 GET；e2e/探针注入 Node https 版 */
export type CaFetcher = (url: string) => Promise<string>;

/**
 * 原生取材器（CaTrustModule.fetchCaAnonymously）：临时 OkHttpClient（宽容 TrustManager——
 * 材料真伪由 QR caFP 锚校验，隧道只承担加密不承担认证）+ hostname 校验保持 OkHttp 缺省
 * 逐位相同（IP SAN 场景现役依赖）+ 与钉住单例物理隔离。取材超时/失败如实抛错。
 */
export function nativeCaFetcher(): CaFetcher | undefined {
  const m = (NativeModules as Record<string, unknown>)['CaTrustModule'] as
    | { fetchCaAnonymously?: (url: string) => Promise<string> }
    | undefined;
  if (typeof m?.fetchCaAnonymously === 'function') {
    return (url: string) => m.fetchCaAnonymously!(url);
  }
  return undefined;
}

/**
 * 引导取材 + 锚校验（获取≠信任——载荷验证前零信任，QR 指纹是唯一锚）：
 * ① GET {relay(wss→https)}/pair/ca/{caFP} ② sha256(材料字节) base64url ≠ caFP ⇒ 中止
 * （MITM 替换/重放/缓存损坏一律被锚拦死）③ 相等 ⇒ 回 {caB64}（钉住用 DER 提取见 caBytesToDerB64）。
 * 寻址 URL 只含 caFP（公开材料）——配对令牌永不出现在引导信道（竞争 redeem 无从发起）。
 */
export async function bootstrapPairingCa(
  qr: { relay: string; caFP: string },
  fetcher: CaFetcher,
): Promise<{ caB64: string } | { error: string }> {
  const base = qr.relay.replace(/^ws/, 'http').replace(/\/+$/, '');
  let body: string;
  try {
    body = await fetcher(`${base}/pair/ca/${qr.caFP}`);
  } catch (e) {
    return { error: `证书取材失败（${String(e)}）——中继版本过旧或网络不通，稍后重扫或升级中继` };
  }
  let caB64: unknown;
  try {
    caB64 = (JSON.parse(body) as { caB64?: unknown })?.caB64;
  } catch {
    return { error: '证书取材响应不是合法 JSON（中继版本过旧？）' };
  }
  if (typeof caB64 !== 'string' || caB64 === '') {
    return { error: '证书取材响应缺 caB64（中继版本过旧？）' };
  }
  return { caB64 };
}

/**
 * 材料字节（PEM 或裸 DER）→ Kotlin 钉住所需的标准 base64(DER)。
 * PEM 提取 CERTIFICATE 体（标准 base64 原样，保留 padding）；裸 DER 直接编码。
 * 与 QR 锚校验用的「原始字节 hash」严格分离：校验按文件字节，钉住按证书 DER。
 */
export function caBytesToDerB64(bytes: Uint8Array): string | null {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 32));
  if (head.includes('-----BEGIN')) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const m = text.match(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/);
    if (!m) return null;
    return m[1]!.replace(/\s+/g, '');
  }
  return bytesToB64(bytes);
}

/** QR 锚校验：sha256(材料原始字节) 的 base64url === caFP（与桌面 caFingerprint 同口径） */
export function caBytesMatchFp(bytes: Uint8Array, caFP: string): boolean {
  return b64uEncode(sha256(bytes)) === caFP;
}

/** base64（标准，容忍 url 变体）→ 字节；坏输入返回 null */
export function caB64ToBytes(s: string): Uint8Array | null {
  try {
    const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
    const withPad = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const bin = atob(withPad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
