/**
 * 凭证域（AuthRealm）声明解析（规则表 = catalog/providerProfiles.ts 的 realms 字段，此处只做匹配）
 *
 * 概念：密钥互认的认证空间——Token Plan 与按量是两个域；一域一密钥。
 * 域指纹（realm 全名）与 key 存储槽位同规（resolveKeySlotId）：
 * 模板域 = 裸 providerId；独立域 = `providerId#归一化端点`。
 * P0 定域顺序：显式 credentialRealm → key 形态（keyPrefixHints）→ 端点/模板派生。
 */
import { getProviderProfiles, type RealmDeclaration } from './catalog/modelCatalog';
import { normalizeEndpointUrl, providerManager, resolveKeySlotId } from './providerManager';

/** 域指纹：模板域 = 裸 providerId；独立域 = providerId#归一化端点（与 resolveKeySlotId 同一编码） */
export function realmIdFor(providerNameOrId: string, declaration: RealmDeclaration): string {
  const pid = providerManager.idFor(providerNameOrId);
  if ('template' in declaration.endpoint) return pid;
  return `${pid}#${normalizeEndpointUrl(declaration.endpoint.baseURL)}`;
}

/** 按域指纹反查声明；未声明返回 undefined（自定义域/未声明厂商） */
export function findRealmDeclaration(providerNameOrId: string, realmId: string): RealmDeclaration | undefined {
  const profile = getProviderProfiles().find(p => p.id === providerManager.idFor(providerNameOrId) || p.name === providerNameOrId);
  if (!profile?.realms) return undefined;
  return profile.realms.find(r => realmIdFor(providerNameOrId, r) === realmId);
}

/**
 * key 形态 → 域声明（P0 第一识别源）：凭证前缀命中 keyPrefixHints 即定域；
 * 识别不了返回 undefined（调用方回退端点/模板派生）。
 */
export function matchRealmByKeyPrefix(providerNameOrId: string, credential: string): RealmDeclaration | undefined {
  const profile = getProviderProfiles().find(p => p.id === providerManager.idFor(providerNameOrId) || p.name === providerNameOrId);
  if (!profile?.realms) return undefined;
  const key = credential.trim();
  return profile.realms.find(r => r.keyPrefixHints?.some(hint => key.startsWith(hint)));
}

/** 域显示短名（声明优先）；未声明返回 undefined（调用方走 host/供应商名缺省） */
export function realmDisplayName(providerNameOrId: string, realmId: string): string | undefined {
  return findRealmDeclaration(providerNameOrId, realmId)?.displayName;
}

/**
 * P0 定域：key 形态优先（声明表），识别不了按端点/模板派生（= resolveKeySlotId 现状语义）。
 * key 形态命中但显式端点指向另一域时报错拒绝（防「按量 key 填到 Token Plan 通道」静默错绑）。
 */
export function resolveRealmId(input: {
  provider: string;
  credential?: string;
  baseURL?: string;
  credentialRealm?: string;
}): string {
  if (input.credentialRealm) return input.credentialRealm;
  const byKey = input.credential ? matchRealmByKeyPrefix(input.provider, input.credential) : undefined;
  if (byKey) {
    const keyRealm = realmIdFor(input.provider, byKey);
    if (input.baseURL) {
      const urlRealm = resolveKeySlotId(input.provider, input.baseURL);
      if (urlRealm !== keyRealm && urlRealm !== providerManager.idFor(input.provider)) {
        throw new Error(
          `凭证形态指向通道「${byKey.displayName}」（${keyRealm}），但端点指向 ${urlRealm}——疑似 key 填错通道，请核对后重试`,
        );
      }
    }
    return keyRealm;
  }
  return resolveKeySlotId(input.provider, input.baseURL);
}
