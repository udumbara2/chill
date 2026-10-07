/**
 * 模型身份 / 绑定命名（纯函数，唯一事实点）
 *
 * 概念分层（规划「二、2」）：
 * - ModelIdentity 模型身份 = provider × 上游真实 API 模型 ID（能力的家）
 * - ModelBinding 模型绑定 = 身份 × 凭证域 × 方言（切换列表的一项，本地注册名是它的外键）
 *
 * 命名三元分离：显示名（人看，「身份 · 通道短名」拼装）/ 本地注册名（引用与绑定，
 * 派生消歧链产出，须过 isSafeCardName）/ 存储键（凭证层编码，见 credentials/storageKey）。
 * 请求字段（apiModelId/defaultModel/availableModels）只装上游 ID——本地注册名不得写入（V6）。
 */
import type { ModelInfo } from '../../types/models';
import { providerManager, resolveCredentialId } from './providerManager';
import { realmDisplayName } from './realms';
import { isSafeCardName } from '../credentials/storageKey';

/** 读取上游真实模型 ID：apiModelId 优先，旧卡回退 adapterConfig.defaultModel（绝不回退本地注册名） */
export function resolveApiModelId(card: {
  apiModelId?: string;
  adapterConfig?: { defaultModel?: string };
}): string {
  return card.apiModelId ?? card.adapterConfig?.defaultModel ?? '';
}

/** 模型身份键：provider 稳定 id × 上游 ID（同名不同供应商是不同身份，防撞名污染能力） */
export function identityKeyOf(card: {
  provider: string;
  apiModelId?: string;
  adapterConfig?: { defaultModel?: string };
}): string {
  return `${providerManager.idFor(card.provider)}\u0000${resolveApiModelId(card)}`;
}

/** 把任意上游 ID 派生成文件名安全的本地名主干（禁 `/\:*?"<>|` 及空白，同 isSafeCardName） */
export function safeNameStem(apiModelId: string): string {
  const stem = apiModelId
    .replace(/[\\/:*?"<>|\s\x00-\x1f]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return stem || 'model';
}

/**
 * 凭证域 → 域安全 slug（本地注册名消歧用，形态如 `token-plan-cn`）：
 * 取 realm 后缀 host 的首 DNS 标签（自定义域名的区分标签通常在最左，如 token-plan-cn / api），
 * 裸模板域取 provider 稳定 id；产出保证过 isSafeCardName。
 */
export function realmSlug(realmId: string): string {
  const hash = realmId.indexOf('#');
  const suffix = hash >= 0 ? realmId.slice(hash + 1) : '';
  let raw = '';
  if (suffix) {
    const host = suffix.replace(/^[^/]*:\/\//, '').split('/')[0].split(':')[0];
    raw = host.split('.')[0] || host;
  } else {
    raw = realmId;
  }
  const slug = safeNameStem(raw).toLowerCase();
  return isSafeCardName(slug) ? slug : 'realm';
}

/**
 * 凭证域显示短名（「身份 · 通道短名」的通道侧）：
 * realm 声明短名优先（catalog/providerProfiles.ts 的 realms 声明），
 * 自定义域缺省 host，裸模板域缺省供应商显示名。
 */
export function realmShortName(realmId: string, providerNameOrId?: string): string {
  const declared = providerNameOrId ? realmDisplayName(providerNameOrId, realmId) : undefined;
  if (declared) return declared;
  const hash = realmId.indexOf('#');
  if (hash >= 0) {
    const suffix = realmId.slice(hash + 1);
    const host = suffix.replace(/^[^/]*:\/\//, '').split('/')[0].split(':')[0];
    return host || realmId;
  }
  return providerNameOrId ? providerManager.getDisplayName(providerNameOrId) : realmId;
}

/** 显示名拼装：同身份多绑定时「身份 · 通道短名」 */
export function composeBindingDisplayName(identityLabel: string, realmId: string, providerNameOrId?: string): string {
  return `${identityLabel} · ${realmShortName(realmId, providerNameOrId)}`;
}

/**
 * 本地注册名派生消歧链（确定性）：
 * `apiModelId` → `apiModelId@<域安全slug>` → `apiModelId@<域安全slug>-<方言>` → 仍冲突追加 `-N`。
 * isTaken 命中即推进下一级（跨身份占用同样推进——中转与官方常共用模型名）；
 * 仍无法得到安全名时抛错（严禁静默覆盖，与 P4 失败补偿同语义）。
 */
export function deriveLocalName(
  apiModelId: string,
  realmId: string,
  opts: { dialect?: string; isTaken: (name: string) => boolean },
): string {
  const stem = safeNameStem(apiModelId);
  const slug = realmSlug(realmId);
  const candidates: string[] = [stem, `${stem}@${slug}`];
  if (opts.dialect) candidates.push(`${stem}@${slug}-${safeNameStem(opts.dialect).toLowerCase()}`);
  const base = candidates[candidates.length - 1];
  for (let n = 2; n <= 99; n++) candidates.push(`${base}-${n}`);

  for (const name of candidates) {
    if (isSafeCardName(name) && !opts.isTaken(name)) return name;
  }
  throw new Error(`无法为上游模型 ${apiModelId}（域 ${realmId}）派生未占用的本地注册名——请显式指定 model_name`);
}

/**
 * 提交前最终名占用检查：被同一身份占用 = 复用/报重复；被不同身份占用 = 报错拒绝
 * （严禁 Map.set/写文件静默覆盖）。返回可继续提交的名称。
 */
export function assertFinalNameAvailable(
  finalName: string,
  currentIdentityKey: string,
  lookup: (name: string) => { provider: string; apiModelId?: string; adapterConfig?: { defaultModel?: string } } | undefined,
): void {
  const existing = lookup(finalName);
  if (!existing) return;
  if (identityKeyOf(existing) === currentIdentityKey) {
    throw new Error(`模型 ${finalName} 已存在（同一身份的既有绑定），无法重复添加`);
  }
  throw new Error(`模型名 ${finalName} 已被其他身份占用（${identityKeyOf(existing).replace('\u0000', ' / ')}），拒绝覆盖——请改用其他注册名`);
}

/**
 * 写入口校验：apiModelId / defaultModel / availableModels 只收上游 ID（本地注册名不得写入）。
 * 判定：本卡 name 与上游 ID 不同串时，name 不得出现在这三个字段；
 * name 与上游 ID 同串（旧契约：model_name 即请求编码）时放行——那是上游 ID 的身份，不是假名。
 */
export function assertUpstreamIdentityFields(input: {
  localName: string;
  apiModelId: string;
  defaultModel?: string;
  availableModels?: string[];
}): void {
  const apiModelId = input.apiModelId?.trim();
  if (!apiModelId) {
    throw new Error('apiModelId（上游真实模型 ID）不得为空——请求字段只装 API 事实');
  }
  if (input.localName === apiModelId) return;
  if (input.defaultModel === input.localName) {
    throw new Error(`defaultModel 只收上游 ID，不得写入本地注册名 ${input.localName}（应为 ${apiModelId}）`);
  }
  if (input.availableModels?.includes(input.localName)) {
    throw new Error(`availableModels 只收上游 ID，不得写入本地注册名 ${input.localName}（应为 ${apiModelId}）`);
  }
}

/**
 * 上游 ID 反占位校验：api_model_id/request_model 不得填另一个绑定的本地注册名
 * （那是假名，不是 API 事实——查注册表判定，纯函数注入 lookup）。
 */
export function assertNotLocalAliasAsUpstreamId(
  apiModelId: string,
  lookup: (name: string) => { apiModelId?: string; adapterConfig?: { defaultModel?: string } } | undefined,
): void {
  const existing = lookup(apiModelId);
  if (!existing) return;
  if (resolveApiModelId(existing) !== apiModelId) {
    throw new Error(
      `apiModelId 不得填本地注册名 ${apiModelId}（其上游 ID 为 ${resolveApiModelId(existing)}）——只收上游真实模型 ID`,
    );
  }
}

/**
 * 同身份多绑定显示名拼装（内存投影，不回写磁盘——每次加载幂等重推，同 refreshSeedMetadata 先例）：
 * 同一身份（provider × 上游 ID）绑定 ≥2 个凭证域时，displayName 统一为「身份 · 通道短名」；
 * 单绑定保持既有 displayName 不动（显示名是可派生元数据，多绑定场景由系统收敛）。
 */
export function applyMultiBindingDisplayNames(cards: ModelInfo[]): void {
  const groups = new Map<string, ModelInfo[]>();
  for (const c of cards) {
    const key = identityKeyOf(c);
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const m of members) {
      m.displayName = composeBindingDisplayName(resolveApiModelId(m), resolveCredentialId(m), m.provider);
    }
  }
}
