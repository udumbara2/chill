import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider';
import { getProviderProfiles } from './catalog/modelCatalog';
import * as path from 'path';

/**
 * 供应商信息
 * id 为稳定标识（英文小写，用于 key 文件命名等存储场景），name 为显示名
 */
export interface ProviderInfo {
  id: string;
  name: string;
  builtIn: boolean;
}

/**
 * 旧名 → 稳定 id 映射（常量）
 * loadProviders 兼容旧条目、providerKeyMigration 改名、resolveId 静态兜底共用此表
 */
export const LEGACY_PROVIDER_ID_MAP: Record<string, string> = {
  '智谱AI': 'zhipu',
  'DeepSeek': 'deepseek',
  'Moonshot AI': 'moonshot',
  'glm46': 'zhipu', // GLM 4.6 时代按模型版本命名的遗留
};

/** 内置种子 provider（id 稳定，name 为显示名）；事实源 = catalog/providerProfiles.json，此处派生映射 */
export const SEED_PROVIDERS: ProviderInfo[] = getProviderProfiles().map(p => ({
  id: p.id,
  name: p.name,
  builtIn: true,
}));

/**
 * 自定义 provider 的 id 规则：小写、去空格/连字符/下划线（保留字母数字与 CJK 字符）
 * 如 'Moonshot AI'→'moonshotai'、'智谱AI'→'智谱ai'
 */
export function slugifyProviderId(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]+/g, '');
}

/**
 * 供应商管理器
 * 负责 providers.json 的加载、查询、新增、持久化；Map 按 id 索引
 */
export class ProviderManager {
  private static instance: ProviderManager;
  private providers: Map<string, ProviderInfo> = new Map();
  private fileSystemProvider: IFileSystemProvider | null = null;
  private providersDir: string = '';

  private constructor() {}

  static getInstance(): ProviderManager {
    if (!ProviderManager.instance) {
      ProviderManager.instance = new ProviderManager();
    }
    return ProviderManager.instance;
  }

  setFileSystemProvider(provider: IFileSystemProvider): void {
    this.fileSystemProvider = provider;
  }

  setProvidersDir(dirPath: string): void {
    this.providersDir = dirPath;
  }

  /**
   * 从磁盘加载 providers.json，末尾自动合并内置种子（不覆盖已有条目）。
   * 兼容旧格式：无 id 字段的条目按映射表/slug 当场赋 id（落盘由 providerKeyMigration 完成）。
   */
  async loadProviders(): Promise<void> {
    if (!this.fileSystemProvider) {
      console.warn('ProviderManager: fileSystemProvider 未设置，跳过加载');
      return;
    }
    const dir = this.providersDir;
    if (!dir) {
      throw new Error('ProviderManager: providersDir 未设置，请先调用 setProvidersDir()');
    }
    try {
      const filePath = path.join(dir, 'providers.json');
      const result = await this.fileSystemProvider.readFile(filePath);
      if (result.success && result.data) {
        const content = typeof result.data === 'string'
          ? result.data
          : result.data.content || '';
        const list: Array<Partial<ProviderInfo> & { name: string }> = JSON.parse(content);
        for (const entry of list) {
          if (!entry?.name) continue;
          const id = entry.id ?? LEGACY_PROVIDER_ID_MAP[entry.name] ?? slugifyProviderId(entry.name);
          this.providers.set(id, { id, name: entry.name, builtIn: entry.builtIn ?? false });
        }
      }
    } catch {
      // providers.json 不存在（尚未播种），由下方种子数据填充
    }
    // 合并内置种子（不覆盖已有条目），保证 Map 始终是全集，saveToDisk 全量回写不丢条目。
    // 名称感知抑制：磁盘上同名不同 id 的条目（如旧版 add_model 自建的"阿里云百炼"）不再
    // 叠加种子副本——一个显示名只保留一个条目，磁盘条目优先（其 id 背后已有用户的 Key 文件与模型卡）
    for (const seed of SEED_PROVIDERS) {
      if (this.providers.has(seed.id)) continue;
      let nameTaken = false;
      for (const p of this.providers.values()) {
        if (p.name === seed.name) {
          nameTaken = true;
          break;
        }
      }
      if (!nameTaken) {
        this.providers.set(seed.id, { ...seed });
      }
    }
  }

  /**
   * 解析 provider 标识为稳定 id
   * 查找顺序：① Map（id 或 name）② 静态旧名映射表 ③ 种子供应商静态表（不依赖 Map/loadProviders 初始化——
   * 防"启动窗口期按 slug 兜底分叉"，keys 目录曾同时出现 zhipu.key 与 阿里云百炼.key 即此类漂移）
   * ④ 原样返回
   */
  resolveId(nameOrId: string): string {
    if (!nameOrId) return nameOrId;
    if (this.providers.has(nameOrId)) return nameOrId;
    for (const p of this.providers.values()) {
      if (p.name === nameOrId) return p.id;
    }
    if (LEGACY_PROVIDER_ID_MAP[nameOrId]) return LEGACY_PROVIDER_ID_MAP[nameOrId];
    const seed = SEED_PROVIDERS.find(p => p.id === nameOrId || p.name === nameOrId);
    return seed?.id ?? nameOrId;
  }

  /**
   * 统一取 id 入口：已知 provider → resolveId；未知 → slug
   * /key set 与 addProvider 同走此路，保证同一 provider 永远落在同一个 key 文件名
   */
  idFor(nameOrId: string): string {
    if (!nameOrId) return nameOrId;
    if (this.providers.has(nameOrId)) return nameOrId;
    for (const p of this.providers.values()) {
      if (p.name === nameOrId) return p.id;
    }
    if (LEGACY_PROVIDER_ID_MAP[nameOrId]) return LEGACY_PROVIDER_ID_MAP[nameOrId];
    const seed = SEED_PROVIDERS.find(p => p.id === nameOrId || p.name === nameOrId);
    if (seed) return seed.id;
    return slugifyProviderId(nameOrId);
  }

  /** 显示名（未知时原样返回输入） */
  getDisplayName(nameOrId: string): string {
    const p = this.providers.get(this.resolveId(nameOrId));
    return p?.name ?? nameOrId;
  }

  /** 检查供应商是否存在（兼容 id 或 name 入参） */
  providerExists(nameOrId: string): boolean {
    if (this.providers.has(nameOrId)) return true;
    for (const p of this.providers.values()) {
      if (p.name === nameOrId) return true;
    }
    return false;
  }

  /** 获取指定供应商信息（兼容 id 或 name 入参） */
  getProvider(nameOrId: string): ProviderInfo | undefined {
    return this.providers.get(this.resolveId(nameOrId));
  }

  /** 获取所有供应商 */
  getAllProviders(): ProviderInfo[] {
    return Array.from(this.providers.values());
  }

  /** 新增供应商并持久化到磁盘（无 id 时按 idFor 规则生成） */
  async addProvider(provider: Partial<ProviderInfo> & { name: string }): Promise<void> {
    const id = provider.id ?? this.idFor(provider.name);
    this.providers.set(id, { id, name: provider.name, builtIn: provider.builtIn ?? false });
    await this.saveToDisk();
  }

  /** 公开落盘：把当前 Map（含 id 与种子）写回 providers.json，供迁移收尾调用 */
  async persistProviders(): Promise<void> {
    await this.saveToDisk();
  }

  /** 将内存中的供应商数据写回 providers.json */
  private async saveToDisk(): Promise<void> {
    if (!this.fileSystemProvider || !this.providersDir) return;
    const list = Array.from(this.providers.values());
    const filePath = path.join(this.providersDir, 'providers.json');
    await this.fileSystemProvider.writeFile(filePath, JSON.stringify(list, null, 2));
  }
}

export const providerManager = ProviderManager.getInstance();

/**
 * 端点 URL 归一化（key 槽位指纹形态）：trim、host 小写、去默认端口、去尾斜杠
 * 同一端点的不同书写形态（/v1 与 /v1/、大小写 host）必须归一到同一指纹，否则同端点裂成两槽
 */
export function normalizeEndpointUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.host.toLowerCase().replace(/:(80|443)$/, '');
    return `${host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

/**
 * API Key 槽位 id：key 的真实归属是「provider × 端点通道」，不是品牌——同一品牌可有多个认证域
 * （实例：小米按量 sk- key 走 api.xiaomimimo.com、Token Plan tp- key 走 token-plan-cn.xiaomimimo.com，
 * 同品牌两套 Key 互不可换）。规则：
 * - baseURL 缺省 / provider 无端点模板（自定义供应商）/ baseURL 归一化后等于模板端点
 *   → 裸 providerId（现状语义，存量 Key 零迁移）
 * - 内置供应商 + 非模板端点（Coding Plan/Token Plan/批量端点等独立通道）→ `${providerId}#${归一化端点}`
 * 命名约定：'#' 分隔；后缀为可读 host+path（/key list 直接可辨）；providerKeyMigration 对含 '#'
 * 的文件名显式跳过（槽位不属 provider 域）。
 * 纪律：add/modify 存 Key、运行时取 Key、状态投影、remove 清理必须统一经本函数——任何一处自拼字符串即分叉。
 */
export function resolveKeySlotId(providerNameOrId: string, baseURL?: string): string {
  const providerId = providerManager.idFor(providerNameOrId);
  if (!baseURL) return providerId;
  const profile = getProviderProfiles().find(p => p.id === providerId || p.name === providerNameOrId);
  if (!profile) return providerId;
  if (normalizeEndpointUrl(baseURL) === normalizeEndpointUrl(profile.endpoint.baseURL)) return providerId;
  return `${providerId}#${normalizeEndpointUrl(baseURL)}`;
}

/**
 * 统一 resolve 凭证域入口（存/取/状态投影/generate 选型/删除清理一律经它，保 V5）：
 * 显式 credentialRealm 优先（固化值），缺省按 resolveKeySlotId 派生（旧卡兼容）。
 * 运行时不得绕过本函数用 baseURL 现推——P0 定域结果已写入绑定数据，现推会与固化值分叉。
 */
export function resolveCredentialId(card: {
  provider: string;
  credentialRealm?: string;
  adapterConfig?: { baseURL?: string };
}): string {
  return card.credentialRealm ?? resolveKeySlotId(card.provider, card.adapterConfig?.baseURL);
}

/**
 * 列出某 provider 的凭证域（key 槽位）清单——`/key set`/`/key delete`/UI 键表单共用（定域语义）：
 * 有绑定按绑定去重（经 resolveCredentialId，尊重显式 credentialRealm）；
 * 多域时调用方必须让用户选域（或 --url 显式），禁止静默缺省；
 * 无任何绑定时退化为模板域（裸 id）。
 */
export function listKeySlotDomains(
  providerNameOrId: string,
  cards: Array<{ provider: string; credentialRealm?: string; adapterConfig?: { baseURL?: string } }>,
): string[] {
  const pid = providerManager.idFor(providerNameOrId);
  const slots = new Set<string>();
  for (const c of cards) {
    if (providerManager.idFor(c.provider) !== pid) continue;
    slots.add(resolveCredentialId(c));
  }
  if (slots.size === 0) slots.add(pid);
  return Array.from(slots);
}
