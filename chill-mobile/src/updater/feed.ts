/**
 * feed.ts — 更新发现：feed 路径派生 + 版本清单解析（纯逻辑，jest 直测）。
 *
 * 派生（与桌面 guardian mobile-push.js feedInfo 黄金向量对齐，deskPubFp 运行时自证兜底）：
 *   base64url 解码为 32 字节原始公钥 → sha256 → 小写 hex → 前 24 位
 *   feed 路径 = `apk/feed-<fp>.json`（静态通道"不可猜文件名即访问凭据"——高熵公钥派生满足之）
 *
 * parseManifest 纪律（fail-closed）：形状不符/超 4KB（防清单炸弹）/deskPubFp 不匹配本机派生
 *   → 一律 null（调用方静默丢弃，绝不弹卡）。
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { b64uDecode } from '../relay/envelope';

/** deskPub（base64url）→ 指纹（小写 hex 前 24 位）；畸形输入返回 null */
export function deskPubFingerprint(deskPub: string): string | null {
  try {
    const raw = b64uDecode(deskPub);
    if (raw.length !== 32) return null;
    return bytesToHex(sha256(raw)).slice(0, 24);
  } catch {
    return null;
  }
}

/** feed 相对路径（`apk/feed-<fp>.json`）；畸形 deskPub 返回 null（未配对/损坏由调用方跳过） */
export function updateFeedPath(deskPub: string): string | null {
  const fp = deskPubFingerprint(deskPub);
  return fp === null ? null : `apk/feed-${fp}.json`;
}

/** 版本清单（形状校验后的可信形态） */
export interface UpdateManifest {
  snapshot: string;
  apkUrl: string;
  sha256: string;
  size: number;
  builtAt: string;
  /** 更新说明（默认无——隐私纪律：goal 文本属敏感面，--notes 显式才写入） */
  notes?: string;
}

/** 清单体积帽（防清单炸弹：畸形/超限一体拒绝） */
export const MANIFEST_MAX_BYTES = 4096;

/**
 * 解析清单文本：形状校验 + 体积帽 + deskPubFp 自证（防派生错位/错喂）。
 * 任何不合规 → null（fail-closed，调用方静默）。
 */
export function parseManifest(text: string, myDeskPub: string): UpdateManifest | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MANIFEST_MAX_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null) return null;
  const m = j as Record<string, unknown>;
  if (m['v'] !== 1) return null;
  if (typeof m['snapshot'] !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(m['snapshot'])) return null;
  if (typeof m['apkUrl'] !== 'string' || !/^https?:\/\//.test(m['apkUrl'])) return null;
  if (typeof m['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(m['sha256'])) return null;
  if (!Number.isInteger(m['size']) || (m['size'] as number) <= 0) return null;
  if (typeof m['builtAt'] !== 'string' || m['builtAt'].length === 0 || m['builtAt'].length > 40) return null;
  // deskPubFp 自证：清单必须产自本机配对的桌面（错喂/运营者挪用他桌清单 → 拒）
  const myFp = deskPubFingerprint(myDeskPub);
  if (myFp === null || m['deskPubFp'] !== myFp) return null;
  const notes = m['notes'];
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 200)) return null;
  return {
    snapshot: m['snapshot'],
    apkUrl: m['apkUrl'],
    sha256: m['sha256'],
    size: m['size'] as number,
    builtAt: m['builtAt'],
    ...(notes !== undefined ? { notes } : {}),
  };
}

// ---------- 发现频控（App 钩子消费；纯函数入 jest） ----------

/**
 * 发现检查的最小间隔。一次检查 = 一个 ≤4KB 的 GET（比前台探活还便宜），
 * 60s 只为去抖快速切换风暴。曾用 1h——把「推送→打开→弹卡」工作流堵死一小时
 * （它保护的成本不存在：此端点开销低于 App 每次前台本来就发出的探活）。
 */
export const DISCOVERY_MIN_INTERVAL_MS = 60_000;

/** 频控判定：距上次检查不足间隔 → false。时钟只在上次取到响应时推进（网络错误不消耗间隔）。 */
export function shouldCheckUpdate(lastCheckAt: number | undefined | null, now: number): boolean {
  if (lastCheckAt === undefined || lastCheckAt === null) return true;
  return now - lastCheckAt >= DISCOVERY_MIN_INTERVAL_MS;
}
