/**
 * storage.ts — 配对状态持久化（react-native-keychain，KEK 包裹等效存储）。
 * 协议义务：redeem 首次发出前必须本地持久化密钥对+token（重启恢复原对续传，严禁重新生成）。
 */
import * as Keychain from 'react-native-keychain';

export interface PhoneState {
  secretKey: string; // base64url
  publicKey: string; // base64url
  token: string;
  deskPub: string;
  relay: string;
  name: string;
  /** M6：桌面设备名（QR 的 name 字段；agents 表填充数据源。可选，旧状态记录向后兼容） */
  deskName?: string;
  confirmed: boolean;
  helloSent: boolean;
  /** 更新发现（additive，向后兼容）：上次清单检查时刻（epoch ms；频控 ≥60s；仅成功取到响应才推进） */
  lastUpdateCheckAt?: number;
  /** 更新发现（additive）：用户已"稍后"的快照号（同快照不再打扰；新快照自然再现卡片） */
  dismissedSnapshot?: string | null;
  /** 更新发现（additive）：上次检查结果码（found:<快照>/up-to-date/bad-manifest/http-<n>/network-error）——设置页诊断行数据源 */
  lastUpdateStatus?: string;
  /**
   * TLS 信任态（additive，2026-10-11 规划迭代 B）：扫码时刻 QR 声明的信任集。
   * pinned=严格钉住 QR 带来的 CA；system=公共证书（WebPKI）；缺省=legacy（内置 CA，旧配对态兼容锚）。
   * 判定 SSOT=trust.ts resolvePairingTrust；执行层=android CaTrustModule。
   */
  tls?: { mode: 'pinned'; caB64: string } | { mode: 'system' };
}

const SERVICE = 'chill.pairing';

export async function loadPhoneState(): Promise<PhoneState | null> {
  try {
    const r = await Keychain.getGenericPassword({ service: SERVICE });
    if (!r) return null;
    return JSON.parse(r.password) as PhoneState;
  } catch {
    return null;
  }
}

export async function savePhoneState(state: PhoneState): Promise<void> {
  await Keychain.setGenericPassword('chill', JSON.stringify(state), { service: SERVICE });
}

export async function clearPhoneState(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}

/** 已见信封 id 的持久化（重启后重投去重兜底） */
const SEEN_SERVICE = 'chill.seen-ids';

export async function loadSeenIds(): Promise<string[]> {
  try {
    const r = await Keychain.getGenericPassword({ service: SEEN_SERVICE });
    if (!r) return [];
    const raw = JSON.parse(r.password);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export async function saveSeenIds(ids: string[]): Promise<void> {
  await Keychain.setGenericPassword('chill', JSON.stringify(ids), { service: SEEN_SERVICE });
}
