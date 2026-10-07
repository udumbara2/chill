/**
 * connect 服务（P0–P5 事务流水线，唯一 connect 事实点）
 *
 * 添加模型 = 在一个凭证域（AuthRealm）上建立模型身份（ModelIdentity）的可用绑定（ModelBinding）。
 * 用户只提供：凭证 + 启用哪些身份；域由 key 形态自识别（声明表 catalog/providerProfiles.ts），
 * 能力来自探测/目录/声明（带来源标记）。整条操作要么全成、要么无痕（V4）。
 *
 *   P0 定域     key 形态/URL/目录 → AuthRealm（结果写入绑定数据，运行时不重推）
 *   P1 写凭证   无则编码落库 → 立即回读验证（匿名域跳过）；
 *               同域已有凭证 → 复用（传入值忽略，防误粘贴覆盖在用 key）；覆盖仅走显式 rotate（I4）
 *   P2 发现鉴权 GET /models（transport.listModels）；端点不支持时退化为「声明清单 + 最小 chat 鉴权」；
 *               无传输层注入时跳过（add_model 兼容包装走此路——旧行为零网络不变）
 *   P3 能力探测 能探则探（probed）→ 目录（catalog）→ 保守缺省（declared）；用户显式声明恒为 declared 且优先
 *   P4 原子提交 身份 + N 个绑定 + 凭证归属：逐项 tmp+rename 落盘 + 失败补偿删除已落盘项
 *               （凭证除外——两向语义：注册失败凭证保留）；selected-models 尽力而为
 *   P5 回执     仅在提交后报成功；失败一律上抛可行动原因
 */
import { ModelType, ModelModality } from '../../types/models';
import type { ModelInfo, CapabilitySource, CapabilitySourceMarks } from '../../types/models';
import { modelInfoService, getProviderEndpointTemplate } from './modelInfoService';
import { providerManager, resolveCredentialId } from './providerManager';
import { resolveRealmId, findRealmDeclaration } from './realms';
import {
  resolveApiModelId,
  identityKeyOf,
  deriveLocalName,
  assertUpstreamIdentityFields,
  assertNotLocalAliasAsUpstreamId,
  assertFinalNameAvailable,
  applyMultiBindingDisplayNames,
} from './modelIdentity';
import { isSafeCardName } from '../credentials/storageKey';
import { getModelSeeds } from './catalog/modelCatalog';
import { SecureStorageService } from '../secureStorageService';
import { SelectedModelsService } from '../selectedModelsService';

/** P3 能力探测结果（transport 产出；缺省字段进下一级来源） */
export interface ProbedCapabilities {
  supportedModalities?: ModelModality[];
  maxContextTokens?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
}

/** connect 传输层（P2/P3 注入；测试用假传输层，壳注入真实 HTTP 传输层） */
export interface ConnectTransport {
  /** GET /models：返回上游模型 ID 清单；端点不支持返回 null（进入退化路径）；鉴权被拒等失败须 throw 可行动错误 */
  listModels(baseURL: string, apiKey: string): Promise<string[] | null>;
  /** 最小 chat 鉴权（/models 退化路径的鉴权证明）；失败 throw 可行动错误 */
  minimalChatAuth(baseURL: string, apiKey: string, apiModelId: string): Promise<void>;
  /** 能力探测（可选）；探不到返回 null */
  probeCapabilities?(baseURL: string, apiKey: string, apiModelId: string): Promise<ProbedCapabilities | null>;
}

export interface ConnectCapabilityInput {
  supported_modalities?: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  supports_thinking?: boolean;
  supports_streaming?: boolean;
  supports_tools?: boolean;
  temperature?: number;
  fixed_params?: Record<string, any>;
  unsupported_params?: string[];
}

export interface ConnectIdentityInput {
  /** 上游真实 API 模型 ID（必填；请求体 model 字段唯一来源） */
  apiModelId: string;
  /** 存量兼容投影（add_model 的 model_name）；缺省按 apiModelId 派生消歧链生成 */
  legacyName?: string;
  display_name?: string;
  description?: string;
  version?: string;
  documentation?: string;
  /** 别名（上游 ID）CSV */
  alias_models?: string;
  /** 方言（本地名消歧链第三级用，如 anthropic） */
  dialect?: string;
  /** 显式独立凭证域（个别绑定需独立 Key 时）；缺省用请求级定域 */
  credentialRealm?: string;
  capabilities?: ConnectCapabilityInput;
}

export interface ConnectRequest {
  provider: string;
  /** 凭证；同域已有 → 复用（传入值忽略）；匿名域可缺省 */
  credential?: string;
  /** 匿名域声明（本地模型无凭证）：跳过 P1 */
  anonymous?: boolean;
  baseURL?: string;
  protocol?: string;
  /** 全新 provider 显示名（路径 3）；缺省用 provider 原文 */
  providerDisplayName?: string;
  identities: ConnectIdentityInput[];
  /** 传输层（缺省 = 无传输层，跳过 P2 发现鉴权——add_model 兼容包装保旧行为零网络） */
  transport?: ConnectTransport;
}

export interface ConnectBindingOutcome {
  name: string;
  displayName: string;
  apiModelId: string;
  credentialRealm: string;
  capabilitySources: CapabilitySourceMarks;
}

export interface ConnectOutcome {
  bindings: ConnectBindingOutcome[];
  credentialAction: 'stored' | 'reused' | 'anonymous';
  /** P2 发现清单（null = 无 /models 或无传输层） */
  discovered: string[] | null;
  /** selected-models 登记失败需手动启用的绑定（尽力而为，不回滚连接） */
  manualEnableNeeded: string[];
}

const providerToModelType: Record<string, ModelType> = {
  '智谱AI': ModelType.GLM,
  'DeepSeek': ModelType.DEEPSEEK,
  'Moonshot AI': ModelType.KIMI_K2,
};

const MODALITY_MAP: Record<string, ModelModality> = {
  text: ModelModality.TEXT,
  image: ModelModality.IMAGE,
  audio: ModelModality.AUDIO,
  video: ModelModality.VIDEO,
  function_calling: ModelModality.FUNCTION_CALLING,
  json_mode: ModelModality.JSON_MODE,
  thinking_mode: ModelModality.THINKING_MODE,
  reasoning_mode: ModelModality.REASONING_MODE,
  context_continuation: ModelModality.CONTEXT_CONTINUATION,
  fim_completion: ModelModality.FIM_COMPLETION,
};

/** 保守缺省（P3 末级；来源标记 declared） */
const CONSERVATIVE_DEFAULTS = {
  supportedModalities: [ModelModality.TEXT],
  maxContextTokens: 128000,
  maxOutputTokens: 4096,
  supportsThinking: false,
  supportsStreaming: true,
  supportsTools: true,
};

export function parseSupportedModalities(csv: string): ModelModality[] {
  return csv
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s)
    .map(s => {
      const modality = MODALITY_MAP[s];
      if (!modality) {
        throw new Error(`不支持的能力模态: ${s}。可选值: ${Object.keys(MODALITY_MAP).join(', ')}`);
      }
      return modality;
    });
}

/** 目录能力快照：同厂商同身份（上游 ID）的出厂种子卡（能力的家 = 身份，来源单一 catalog） */
function catalogCapabilities(provider: string, apiModelId: string): ProbedCapabilities | undefined {
  const pid = providerManager.idFor(provider);
  const seed = getModelSeeds().find(
    s => s.builtIn && providerManager.idFor(s.provider) === pid && resolveApiModelId(s) === apiModelId,
  );
  if (!seed) return undefined;
  return {
    supportedModalities: seed.supportedModalities,
    maxContextTokens: seed.maxContextTokens,
    maxOutputTokens: seed.maxOutputTokens,
    supportsThinking: seed.supportsThinking,
    supportsStreaming: seed.supportsStreaming,
    supportsTools: seed.supportsTools,
  };
}

/** P3 收敛后的身份能力值（进 ModelInfo 的模型级字段） */
interface ConvergedCapabilities {
  supportedModalities: ModelModality[];
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
}

/** P3：逐字段收敛（用户显式 declared > probed > catalog > 保守缺省 declared），返回值 + 来源标记 */
function convergeCapabilities(
  input: ConnectCapabilityInput | undefined,
  probed: ProbedCapabilities | null,
  catalog: ProbedCapabilities | undefined,
): { values: ConvergedCapabilities; sources: CapabilitySourceMarks } {
  const pick = <T>(declared: T | undefined, probedVal: T | undefined, catalogVal: T | undefined, fallback: T): [T, CapabilitySource] => {
    if (declared !== undefined) return [declared as T, 'declared'];
    if (probedVal !== undefined) return [probedVal as T, 'probed'];
    if (catalogVal !== undefined) return [catalogVal as T, 'catalog'];
    return [fallback, 'declared'];
  };

  const [modalities, mSrc] = input?.supported_modalities !== undefined
    ? [parseSupportedModalities(input.supported_modalities), 'declared' as CapabilitySource]
    : pick(undefined, probed?.supportedModalities, catalog?.supportedModalities, CONSERVATIVE_DEFAULTS.supportedModalities);
  const [maxContext, cSrc] = pick(input?.max_context_tokens, probed?.maxContextTokens, catalog?.maxContextTokens, CONSERVATIVE_DEFAULTS.maxContextTokens);
  const [maxOutput, oSrc] = pick(input?.max_output_tokens, probed?.maxOutputTokens, catalog?.maxOutputTokens, CONSERVATIVE_DEFAULTS.maxOutputTokens);
  const [thinking, tSrc] = pick(input?.supports_thinking, probed?.supportsThinking, catalog?.supportsThinking, CONSERVATIVE_DEFAULTS.supportsThinking);
  const [streaming, sSrc] = pick(input?.supports_streaming, probed?.supportsStreaming, catalog?.supportsStreaming, CONSERVATIVE_DEFAULTS.supportsStreaming);
  const [tools, toolSrc] = pick(input?.supports_tools, probed?.supportsTools, catalog?.supportsTools, CONSERVATIVE_DEFAULTS.supportsTools);

  return {
    values: {
      supportedModalities: modalities,
      maxContextTokens: maxContext,
      maxOutputTokens: maxOutput,
      supportsThinking: thinking,
      supportsStreaming: streaming,
      supportsTools: tools,
    },
    sources: {
      supportedModalities: mSrc,
      maxContextTokens: cSrc,
      maxOutputTokens: oSrc,
      supportsThinking: tSrc,
      supportsStreaming: sSrc,
      supportsTools: toolSrc,
    },
  };
}

/**
 * connect 主流程（P0–P5）。失败一律 throw 可行动 Error（零痕迹或补偿删除，见 P1/P4）。
 */
export async function connectModels(req: ConnectRequest): Promise<ConnectOutcome> {
  const identities = req.identities.filter(i => i?.apiModelId?.trim());
  if (identities.length === 0) {
    throw new Error('缺少要启用的模型身份（models / api_model_id）——connect 只接受上游真实模型 ID');
  }

  // ---------- P0 定域 ----------
  const endpointTemplate = getProviderEndpointTemplate(req.provider);
  // 请求级域（key 形态优先于端点；每身份可经 credentialRealm 显式独立域）
  const requestRealm = resolveRealmId({
    provider: req.provider,
    credential: req.credential,
    baseURL: req.baseURL,
  });
  // key 形态已定域时端点缺省取该域规范端点（路径 1「粘贴 key → 勾选」零手填）；否则厂商模板
  const realmDecl = findRealmDeclaration(req.provider, requestRealm);
  const realmEndpoint = realmDecl && 'baseURL' in realmDecl.endpoint ? realmDecl.endpoint.baseURL : undefined;
  const effectiveBaseURL = req.baseURL || realmEndpoint || endpointTemplate?.baseURL;
  const protocol = req.protocol || endpointTemplate?.protocol;
  if (!effectiveBaseURL || !protocol) {
    throw new Error(
      `缺少 ${!effectiveBaseURL ? 'base_url' : 'protocol'}：${req.provider} 不是内置供应商，无法派生默认端点，请显式提供后重试`,
    );
  }

  const realmsOf = new Map<string, string>(); // apiModelId → realm
  for (const id of identities) {
    realmsOf.set(id.apiModelId, id.credentialRealm ?? requestRealm);
  }

  // ---------- P1 写凭证（匿名域跳过；同域已有 → 复用、传入值忽略） ----------
  let credentialAction: ConnectOutcome['credentialAction'] = 'anonymous';
  if (!req.anonymous) {
    credentialAction = await writeCredentialsP1(req, requestRealm, Array.from(new Set(realmsOf.values())), effectiveBaseURL);
  }

  const effectiveKey = req.anonymous ? '' : (await SecureStorageService.getApiKey(requestRealm)) || '';

  // ---------- P2 发现鉴权 ----------
  let discovered: string[] | null = null;
  if (req.transport) {
    try {
      discovered = await req.transport.listModels(effectiveBaseURL, effectiveKey);
      if (discovered === null) {
        // 退化：声明清单 + 最小 chat 鉴权（仅 chat 方言可发最小 chat；其余方言跳过鉴权证明）
        if (protocol === 'openai-chat' || protocol === 'anthropic-messages') {
          await req.transport.minimalChatAuth(effectiveBaseURL, effectiveKey, identities[0].apiModelId);
        }
      }
    } catch (e) {
      // 鉴权被拒/不可达：不注册、零残留——本次新写入的凭证一并清理（否则复用语义会锁死错误 key，
      // 重试永远修不好）；既有凭证不动
      if (credentialAction === 'stored') {
        for (const realm of new Set(realmsOf.values())) {
          try { await SecureStorageService.deleteApiKey(realm); } catch { /* 清理尽力而为 */ }
        }
      }
      throw e;
    }
  }

  // ---------- P3 能力探测（逐身份、逐字段来源标记；能探则探，探不到用目录值，再缺保守缺省） ----------
  const prepared = identities.map(id => ({ id, probed: null as ProbedCapabilities | null }));
  for (const p of prepared) {
    if (req.transport?.probeCapabilities && (discovered === null || discovered.includes(p.id.apiModelId))) {
      try {
        p.probed = await req.transport.probeCapabilities(effectiveBaseURL, effectiveKey, p.id.apiModelId);
      } catch {
        p.probed = null; // 探测失败不阻断——降级目录/缺省
      }
    }
  }

  // ---------- P4 原子提交 ----------
  // 写入口校验 + 命名（先全部算好，任一失败零痕迹）
  const planned: Array<{ id: ConnectIdentityInput; card: ModelInfo; realm: string }> = [];
  const taken = new Set(modelInfoService.getAllModelInfos().map(m => m.name));
  for (const { id, probed } of prepared) {
    const apiModelId = id.apiModelId.trim();
    assertNotLocalAliasAsUpstreamId(apiModelId, n => modelInfoService.getModelInfoByName(n));
    const realm = realmsOf.get(apiModelId)!;
    // 同身份同域已有绑定 = 重复连接（绑定 = 身份 × 域，已存在无需再造一项）
    const dup = modelInfoService.getAllModelInfos().find(
      m => resolveApiModelId(m) === apiModelId
        && providerManager.idFor(m.provider) === providerManager.idFor(req.provider)
        && resolveCredentialId(m) === realm,
    );
    if (dup) {
      throw new Error(`身份 ${apiModelId} 在通道 ${realm} 已有绑定 ${dup.name}，无需重复连接`);
    }
    const name = resolveBindingName(id, apiModelId, realm, taken);
    taken.add(name);

    const { values: caps, sources } = convergeCapabilities(id.capabilities, probed, catalogCapabilities(req.provider, apiModelId));
    const aliasModels = id.alias_models
      ? id.alias_models.split(',').map(s => s.trim()).filter(s => s)
      : [];
    const apiIds = [apiModelId, ...aliasModels];
    assertUpstreamIdentityFields({
      localName: name,
      apiModelId,
      defaultModel: apiModelId,
      availableModels: apiIds,
    });

    const displayName = id.display_name || (id.legacyName ?? apiModelId);
    const modelInfo: ModelInfo = {
      type: providerToModelType[req.provider] || ModelType.CUSTOM,
      name,
      displayName,
      provider: req.provider,
      builtIn: false,
      apiModelId,
      credentialRealm: realm,
      capabilitySources: sources,
      description: id.description || undefined,
      version: id.version,
      documentation: id.documentation,
      adapterConfig: {
        protocol,
        baseURL: effectiveBaseURL,
        defaultModel: apiModelId,
        defaultMaxTokens: caps.maxOutputTokens,
        defaultTemperature: id.capabilities?.temperature ?? 0.7,
        ...(id.capabilities?.fixed_params !== undefined ? { fixedParams: id.capabilities.fixed_params } : {}),
        ...(id.capabilities?.unsupported_params !== undefined ? { unsupportedParams: id.capabilities.unsupported_params } : {}),
      },
      supportedModalities: caps.supportedModalities,
      availableModels: apiIds,
      supportedParameters: [],
      maxContextTokens: caps.maxContextTokens,
      maxOutputTokens: caps.maxOutputTokens,
      supportsStreaming: caps.supportsStreaming,
      supportsTools: caps.supportsTools,
      supportsThinking: caps.supportsThinking,
    };
    planned.push({ id, card: modelInfo, realm });
  }

  // 提交：逐项落盘 + 失败补偿删除已落盘项（凭证除外）；selected-models 尽力而为
  const committed: ModelInfo[] = [];
  try {
    // provider 归属标签：首次连接自动登记（P4 的一部分；登记失败不回滚凭证）
    if (!providerManager.providerExists(req.provider)) {
      await providerManager.addProvider({
        name: req.providerDisplayName || req.provider,
        builtIn: false,
      });
    }
    for (const { card } of planned) {
      // 提交前最终名占用检查：被不同身份占用 → 报错拒绝（严禁 Map.set/写文件静默覆盖）
      assertFinalNameAvailable(card.name, identityKeyOf(card), n => modelInfoService.getModelInfoByName(n));
      modelInfoService.addModelInfo(card);
      try {
        await modelInfoService.saveCustomModel(card);
      } catch (e) {
        modelInfoService.removeModelInfo(card.name);
        throw new Error(
          `模型卡落盘失败：${e instanceof Error ? e.message : e}（内存注册已回滚；已写入的凭证保留，重试可复用）`,
        );
      }
      committed.push(card);
    }
  } catch (e) {
    // 失败补偿：删除本次已落盘的模型卡（凭证除外——两向语义）
    for (const card of committed) {
      modelInfoService.removeModelInfo(card.name);
      try { await modelInfoService.deleteCustomModelFile(card.name); } catch { /* 补偿删除尽力而为 */ }
    }
    throw e;
  }

  // selected-models 登记：尽力而为（失败不回滚连接，回执提示手动启用）
  const manualEnableNeeded: string[] = [];
  for (const card of committed) {
    try {
      SelectedModelsService.getInstance().addSelectedModel(card);
    } catch {
      manualEnableNeeded.push(card.name);
    }
  }
  applyMultiBindingDisplayNames(modelInfoService.getAllModelInfos());

  // ---------- P5 回执 ----------
  return {
    bindings: planned.map(({ card }) => ({
      name: card.name,
      displayName: card.displayName,
      apiModelId: card.apiModelId!,
      credentialRealm: card.credentialRealm!,
      capabilitySources: card.capabilitySources ?? {},
    })),
    credentialAction,
    discovered,
    manualEnableNeeded,
  };
}

/** P1：逐域凭证写入/复用（匿名域跳过） */
async function writeCredentialsP1(
  req: ConnectRequest,
  requestRealm: string,
  realms: string[],
  baseURL: string,
): Promise<ConnectOutcome['credentialAction']> {
  let action: ConnectOutcome['credentialAction'] = 'reused';
  for (const realm of realms) {
    const hasExisting = await SecureStorageService.hasApiKey(realm);
    if (hasExisting) {
      // 复用语义：同域已有凭证 → 传入值忽略（防误粘贴覆盖在用 key）
      continue;
    }
    if (realm !== requestRealm) {
      throw new Error(`通道 ${realm} 尚无 API Key，请先配置该域凭证（/key set 或 rotate）后重试`);
    }
    if (!req.credential || !req.credential.trim()) {
      throw new Error(
        `供应商 ${req.provider} 在端点 ${baseURL} 尚无 API Key，请提供 api_key 参数（该供应商其他端点通道的 Key 不通用）`,
      );
    }
    const stored = await SecureStorageService.storeApiKey(realm, req.credential.trim());
    if (!stored) {
      throw new Error(`API Key 保存失败（通道 ${realm} 写入未成功）——模型未注册、零残留`);
    }
    const readback = await SecureStorageService.getApiKey(realm);
    if (!readback) {
      await SecureStorageService.deleteApiKey(realm);
      throw new Error(`API Key 回读验证失败（通道 ${realm}）——模型未注册，半写入凭证已清理`);
    }
    action = 'stored';
  }
  return action;
}

/** 绑定本地注册名：legacyName（兼容）> 派生消歧链；占用即推进/拒绝，严禁静默覆盖 */
function resolveBindingName(
  id: ConnectIdentityInput,
  apiModelId: string,
  realm: string,
  taken: Set<string>,
): string {
  if (id.legacyName !== undefined) {
    if (!isSafeCardName(id.legacyName)) {
      throw new Error(
        `model_name 含非法字符（禁 / \\ : * ? " < > | 与空白）：${id.legacyName}——请换用安全的本地注册名`,
      );
    }
    if (taken.has(id.legacyName) || modelInfoService.getModelInfoByName(id.legacyName)) {
      throw new Error(`模型 ${id.legacyName} 已存在，无法重复添加`);
    }
    return id.legacyName;
  }
  return deriveLocalName(apiModelId, realm, {
    dialect: id.dialect,
    isTaken: n => taken.has(n) || !!modelInfoService.getModelInfoByName(n),
  });
}
