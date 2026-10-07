import { ModelType, type ModelService, type ModelConfig, type ToolDefinition, type StreamCallback } from '../../types/models';
import type { ModelAdapterConfig } from '../../types/models';
import { BaseModelService } from './baseModelService';
import { modelInfoService } from './modelInfoService';
import { resolveCredentialId, resolveKeySlotId } from './providerManager';
import { resolveApiModelId } from './modelIdentity';
import { SelectedModelsService } from '../selectedModelsService';
import type { ISecureStorage } from '../../interfaces/ISecureStorage';
import { MCPService } from '../mcp/mcpService';
import type { ToolRegistry } from '../toolExecutorRegistry';
import type { ProtocolHandler } from './protocolHandler';

/**
 * 标准化配置参数的键名格式
 * 将下划线格式转换为驼峰格式，确保配置能够正确合并
 * @param config 需要标准化的配置对象
 * @returns 标准化后的配置对象
 */
export function normalizeConfigKeys(config: any): any {
  const normalizedConfig: any = {};

  for (const [key, value] of Object.entries(config)) {
    // 将下划线格式转换为驼峰格式
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    normalizedConfig[camelKey] = value;
  }

  return normalizedConfig;
}

/**
 * 合并层白名单（V3 影子旁路封堵）：userParams/extraConfig/customConfig 合并进 baseConfig 前，
 * 剔除凭证与端点字段（含下划线变体——normalizeConfigKeys 会把 api_key 转成 apiKey 精确命中
 * baseConfig 上层遮蔽解析凭证）。采样参数可覆盖；凭证与端点永不被覆盖，一律以
 * resolveCredentialId 解析 + adapterConfig.baseURL 为准。
 */
export function stripCredentialOverrides(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'apiKey' || key === 'api_key' || key === 'baseURL' || key === 'base_url') continue;
    out[key] = value;
  }
  return out;
}

/**
 * 模型服务工厂
 * 用于统一管理和调用不同模型
 */
export class ModelServiceFactory {
  private static instance: ModelServiceFactory;
  private modelServices: Map<string, ModelService> = new Map();
  private secureStorage: ISecureStorage | null = null;
  private taskListStoreGetter?: () => { 
    hasTasks: () => boolean; 
    buildTaskStatusSummary: () => string; 
    buildCompletedTasksSummary: () => string 
  };
  private teamContextGetter?: () => string | null;
  private _mcpService: MCPService | null = null

  private get mcpService(): MCPService {
    if (!this._mcpService) {
      this._mcpService = new MCPService()
    }
    return this._mcpService
  }

  private constructor() {
  }

  static getInstance(): ModelServiceFactory {
    if (!ModelServiceFactory.instance) {
      ModelServiceFactory.instance = new ModelServiceFactory();
    }
    return ModelServiceFactory.instance;
  }

  static initialize(
    secureStorage: ISecureStorage,
    mcpStoreGetter?: () => { getMCPToolsEnabled: () => boolean },
    taskListStoreGetter?: () => { 
      hasTasks: () => boolean; 
      buildTaskStatusSummary: () => string; 
      buildCompletedTasksSummary: () => string 
    },
    teamContextGetter?: () => string | null
  ): void {
    const instance = ModelServiceFactory.getInstance();
    instance.secureStorage = secureStorage;
    if (mcpStoreGetter) {
      instance.mcpService.setMCPStoreGetter(mcpStoreGetter);
    }
    if (taskListStoreGetter) {
      instance.taskListStoreGetter = taskListStoreGetter;
    }
    if (teamContextGetter) {
      instance.teamContextGetter = teamContextGetter;
    }
  }

  /**
   * 创建或获取模型服务实例
   * @param modelType 模型类型
   * @param customConfig 可选的自定义配置
   * @param modelName 可选的模型名称，用于指定具体的模型
   * @returns 模型服务实例
   */
  async createModelService(modelType: ModelType, customConfig?: Partial<ModelConfig>, modelName?: string): Promise<ModelService> {
    const serviceKey = customConfig
      ? `${modelType}_${modelName || 'default'}_${JSON.stringify(customConfig)}`
      : `${modelType}_${modelName || 'default'}`;

    // 窗口回填（窗口准入 SSOT=outputBudget.ts）：命中缓存也刷新（用户改卡后下一次创建即现值）
    const info = modelInfoService.getModelInfoByName(modelName ?? '');

    // 如果已存在相同配置的服务实例，直接返回
    if (this.modelServices.has(serviceKey)) {
      const cached = this.modelServices.get(serviceKey)!;
      cached.maxContextTokens = info?.maxContextTokens;
      return cached;
    }

    // 获取模型配置，合并自定义配置
    const finalConfig = await this.getDefaultConfig(modelType, customConfig, modelName);

    // 创建新的服务实例（动态创建 BaseModelService，通过 adapterConfig 路由）
    const adapterConfig: ModelAdapterConfig | undefined = info?.adapterConfig
    const service = new BaseModelService(finalConfig, modelType, this.mcpService, 'chat')
    if (adapterConfig) {
      service.setAdapterConfig(adapterConfig)
    }
    service.maxContextTokens = info?.maxContextTokens

    // 设置MCP Store获取器（如果已设置）
    // BaseModelService 无 setMCPStoreGetter，跳过
    // 设置TaskList Store获取器（如果已设置）
    if (this.taskListStoreGetter && 'setTaskListStoreGetter' in service) {
      (service as any).setTaskListStoreGetter(this.taskListStoreGetter);
    }
    // 设置团队状态上下文获取器（如果已设置；Worker/workflow 实例未经本工厂装配,天然不注入）
    if (this.teamContextGetter && 'setTeamContextGetter' in service) {
      (service as any).setTeamContextGetter(this.teamContextGetter);
    }

    // 缓存服务实例
    this.modelServices.set(serviceKey, service);
    return service;
  }

  /**
   * 获取模型类型的默认配置
   * @param modelType 模型类型
   * @param customConfig 可选的自定义配置
   * @param modelName 可选的模型名称，用于指定具体的模型
   * @returns 默认配置
   */
  private async getDefaultConfig(modelType: ModelType, customConfig?: Partial<ModelConfig>, modelName?: string): Promise<ModelConfig> {
    const safeModelName = typeof modelName === 'string' ? modelName : undefined

    // 优先从 adapterConfig 读取
    const info = modelInfoService.getModelInfoByName(safeModelName ?? '');

    // 统一按凭证域取 API Key（resolveCredentialId：显式 credentialRealm 优先，缺省 provider × 端点通道派生）
    const apiKey = await this.secureStorage?.getApiKey(info ? resolveCredentialId(info) : resolveKeySlotId(String(modelType), undefined)) ?? '';

    let baseConfig: ModelConfig;
    if (info?.adapterConfig) {
      const ac = info.adapterConfig;
      // 请求字段只装上游事实（V6）：apiModelId 优先，旧卡回退 defaultModel，绝不回退本地注册名
      const model = resolveApiModelId(info) || '';
      baseConfig = {
        model,
        apiKey,
        baseURL: ac.baseURL,
        temperature: ac.defaultTemperature,
        maxTokens: ac.defaultMaxTokens,
      };
    } else {
      throw new Error(`No adapterConfig found for model: ${safeModelName ?? modelType}. Every model must define adapterConfig in ModelInfo.`)
    }

    // 如果有自定义配置，合并到基础配置中
    if (customConfig) {
      // 【修复】标准化参数名格式，将下划线格式转换为驼峰格式；合并前剔除凭证/端点字段（白名单）
      const normalizedConfig = normalizeConfigKeys(stripCredentialOverrides(customConfig));
      const finalConfig = { ...baseConfig, ...normalizedConfig };
      return finalConfig;
    }

    return baseConfig;
  }

  /**
   * 检查模型是否支持思考模式
   * @param modelType 模型类型
   * @param modelName 可选的模型名称，如果不提供则基于模型类型判断
   * @returns 是否支持思考模式
   */
  supportsThinkingMode(_modelType: ModelType, modelName?: string): boolean {
    // 基于模型名称从 ModelInfo 中读取
    if (modelName) {
      const modelInfo = modelInfoService.getModelInfoByName(modelName)
      if (modelInfo) {
        return modelInfo.supportsThinking
      }
    }
    return false
  }

  /**
   * 获取模型的 capabilities
   * 通过 ModelInfo.adapterConfig.protocol 查找对应 handler 的 capabilities
   * @param modelName 模型名称（如 'claude-sonnet-4'）
   */
  getModelCapabilities(modelName: string): ProtocolHandler['capabilities'] {
    const info = modelInfoService.getModelInfoByName(modelName);
    const protocol = info?.adapterConfig?.protocol ?? 'openai-chat';
    const handler = BaseModelService.protocolHandlers[protocol];
    if (!handler) {
      return { chat: true, toolCalling: true, streaming: true, outputModalities: ['text'] };
    }
    return handler.capabilities;
  }

  /**
   * 发送消息到指定模型
   * @param modelType 模型类型
   * @param messages 消息列表
   * @param tools 可选的工具定义列表
   * @param registry 可选的工具注册表
   * @param streamCallback 可选的流式响应回调
   * @param customConfig 可选的自定义配置
   * @param abortController 可选的中断控制器
   * @returns 模型响应
   */
  async sendMessage(
    modelType: ModelType,
    messages: any[],
    tools?: ToolDefinition[],
    registry?: ToolRegistry,
    streamCallback?: StreamCallback,
    customConfig?: Partial<ModelConfig>,
    modelName?: string,
    abortController?: AbortController
  ) {
    try {
      const service = await this.createModelService(modelType, customConfig, modelName);
      const response = await service.sendMessage(messages, tools, registry, streamCallback, abortController);
      return response;
    } catch (error) {
      throw error;
    }
  }

  /**
   * CLI / UI 聊天的统一模型调用入口
   * 
   * 根据 modelName 自动解析 ModelInfo（含 type 和 adapterConfig），
   * 并从 SelectedModelsService 获取用户设置的模型参数，
   * 确保 CLI 和 UI 模式走同一套调用路径。
   * 
   * @param modelName 模型名称（必填，如 "deepseek-v4-flash"）
   * @param messages 消息列表
   * @param options 可选配置
   */
  async sendChatMessage(
    modelName: string,
    messages: any[],
    options?: {
      tools?: ToolDefinition[],
      registry?: ToolRegistry,
      streamCallback?: StreamCallback,
      extraConfig?: Partial<ModelConfig>,
      abortController?: AbortController,
    }
  ) {
    const info = modelInfoService.getModelInfoByName(modelName)
    if (!info) {
      throw new Error(`模型未注册: ${modelName}`)
    }

    const userParams = SelectedModelsService.getInstance().getModelParameters(modelName) || {}
    // 合并层白名单：userParams/extraConfig 的凭证/端点覆盖在进入 customConfig 前剔除（V3）
    const customConfig: Partial<ModelConfig> = {
      ...stripCredentialOverrides(userParams),
      ...stripCredentialOverrides(options?.extraConfig || {}),
    }

    return this.sendMessage(
      info.type,
      messages,
      options?.tools,
      options?.registry,
      options?.streamCallback,
      customConfig,
      modelName,
      options?.abortController,
    )
  }

  /**
   * 清除缓存的服务实例
   * @param modelType 可选，指定要清除的模型类型
   */
  clearCache(modelType?: ModelType): void {
    if (modelType) {
      // 清除指定模型类型的缓存
      for (const key of Array.from(this.modelServices.keys())) {
        if (key.startsWith(`${modelType}_`)) {
          this.modelServices.delete(key);
        }
      }
    } else {
      // 清除所有缓存
      this.modelServices.clear();
    }
  }

  /**
   * 获取所有模型信息
   */
  getAllModelInfos() {
    return modelInfoService.getAllModelInfos();
  }

  /**
   * 根据供应商获取模型信息
   */
  getModelInfosByProvider(provider: string) {
    return modelInfoService.getModelInfosByProvider(provider);
  }

  /**
   * 根据模型名称获取模型信息
   */
  getModelInfoByName(modelName: string) {
    return modelInfoService.getModelInfoByName(modelName);
  }

  /**
   * 获取支持特定模态的模型信息
   */
  getModelInfosByModality(modality: any) {
    return modelInfoService.getModelInfosByModality(modality);
  }
}

// 导出工厂实例
export const modelServiceFactory = ModelServiceFactory.getInstance();