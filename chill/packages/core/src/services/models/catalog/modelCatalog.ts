import type { ModelAdapterConfig, ModelInfo } from '../../../types/models';
// 数据模块(原 .json 转换;vite/esbuild 不支持 import attribute,TS 数据模块三端零障碍)
import profiles from './providerProfiles';
import modelSeeds from './modelSeeds';

/**
 * 厂商预设（数据文件 providerProfiles.json 的类型与读取入口）
 *
 * 厂商级信息（端点、文档链接、厂商级参数约束）的唯一事实源，
 * 此前冗余在每张内置模型卡上。模型卡只存模型级字段；
 * 出厂种子卡加载时经 applyProviderProfile 折叠补齐（见 modelInfoService.getBuiltInSeedModels）。
 * 磁盘用户卡不参与折叠——用户显式写的值永远优先。
 */

/** 凭证域（AuthRealm）声明：key 形态→域匹配规则 + 显示短名（声明式数据，不散落代码分支） */
export interface RealmDeclaration {
  /** 显示短名（「Token Plan」「按量付费」），供「身份 · 通道短名」拼装 */
  displayName: string;
  /** 规范端点；template:true = 厂商模板端点（凭证域 = 裸 providerId） */
  endpoint: { template: true } | { baseURL: string };
  /** key 形态 hint（前缀匹配，如 'tp-'/'sk-'）——识别不了才问端点 */
  keyPrefixHints?: string[];
}

/** 厂商预设 */
export interface ProviderProfile {
  /** 稳定标识（英文小写，与 providerManager 的 id 一致） */
  id: string;
  /** 显示名（与种子卡 provider 字段一致） */
  name: string;
  /** 注册/文档链接 */
  docUrl: string;
  /** 厂商端点模板 */
  endpoint: {
    protocol: string;
    baseURL: string;
  };
  /** 凭证域声明（可选；未声明的域走 host/供应商显示名缺省短名） */
  realms?: RealmDeclaration[];
  /** 厂商级参数约束（可选）；折叠时在卡上同名字段之下 */
  constraints?: {
    /** 硬约束：最后应用、强制覆盖 */
    fixedParams?: Record<string, any>;
    extraBodyParams?: Record<string, any>;
    /** 从请求体中剔除的参数 */
    unsupportedParams?: string[];
  };
}

// 编译期结构校验（realm 的 template 字面量在数据模块中被拓宽为 boolean，经断言收窄；取值不变式由 connectService.test.ts 守住）
const providerProfiles: ProviderProfile[] = profiles as unknown as ProviderProfile[];

/** 获取全部厂商预设（内置种子 provider 的唯一事实源） */
export function getProviderProfiles(): ProviderProfile[] {
  return providerProfiles;
}

/** 按 id 或 name 查找厂商预设；未命中返回 undefined */
export function getProviderProfileByName(nameOrId: string): ProviderProfile | undefined {
  return providerProfiles.find(p => p.id === nameOrId || p.name === nameOrId);
}

/**
 * 把厂商预设折叠到一张出厂种子卡上（仅种子卡使用，勿作用于磁盘用户卡）。
 * 折叠规则：
 * - endpoint.protocol/baseURL 只补卡上缺失的字段；
 * - constraints 在下、卡上同名字段在上（卡显式写的值永远赢；
 *   fixedParams/extraBodyParams 按键合并，unsupportedParams 卡有则整组取卡）。
 * 卡未匹配到预设或无 adapterConfig 时原样返回。
 */
export function applyProviderProfile(card: ModelInfo): ModelInfo {
  const profile = getProviderProfileByName(card.provider);
  if (!profile || !card.adapterConfig) return card;

  const adapterConfig = { ...card.adapterConfig };
  if (!adapterConfig.protocol) adapterConfig.protocol = profile.endpoint.protocol;
  if (!adapterConfig.baseURL) adapterConfig.baseURL = profile.endpoint.baseURL;

  const constraints = profile.constraints;
  if (constraints) {
    if (constraints.fixedParams || adapterConfig.fixedParams) {
      adapterConfig.fixedParams = { ...constraints.fixedParams, ...adapterConfig.fixedParams };
    }
    if (constraints.extraBodyParams || adapterConfig.extraBodyParams) {
      adapterConfig.extraBodyParams = { ...constraints.extraBodyParams, ...adapterConfig.extraBodyParams };
    }
    if (!adapterConfig.unsupportedParams && constraints.unsupportedParams) {
      adapterConfig.unsupportedParams = constraints.unsupportedParams;
    }
  }

  return { ...card, adapterConfig };
}

/**
 * 出厂模型卡的 JSON 原始形态（modelSeeds.json）：
 * 厂商级字段（protocol/baseURL/fixedParams/extraBodyParams）已上移 providerProfiles.json，
 * 故 adapterConfig 中允许缺失，由折叠补齐；其余字段与 ModelInfo 相同。
 */
export type SeedModel = Omit<ModelInfo, 'adapterConfig'> & {
  adapterConfig: Pick<ModelAdapterConfig, 'defaultModel'> & Partial<ModelAdapterConfig>;
};

// 编译期结构校验（枚举字段在 JSON 中为字符串，经断言宽化；取值不变式由 modelSeeds.test.ts 守住）
const seedModels = modelSeeds as SeedModel[];

/**
 * 获取出厂模型种子卡（折叠厂商预设后的完整 ModelInfo）。
 * 单一合成点：所有入口（loadAllModels/reloadFromDisk/migrateKeys、测试）都拿到自包含的卡。
 */
export function getModelSeeds(): ModelInfo[] {
  return seedModels.map(seed => applyProviderProfile(seed as ModelInfo));
}
