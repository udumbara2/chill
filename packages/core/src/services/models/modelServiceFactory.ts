import { ModelType, type ModelService, type ModelConfig, type ToolDefinition, type StreamCallback } from '../../types/models';
import type { ModelAdapterConfig } from '../../types/models';
import { BaseModelService } from './baseModelService';
import { modelInfoService } from './modelInfoService';
import { providerManager } from './providerManager';
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
    }
  ): void {
    const instance = ModelServiceFactory.getInstance();
    instance.secureStorage = secureStorage;
    if (mcpStoreGetter) {
      instance.mcpService.setMCPStoreGetter(mcpStoreGetter);
    }
    if (taskListStoreGetter) {
      instance.taskListStoreGetter = taskListStoreGetter;
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
    
    // 如果已存在相同配置的服务实例，直接返回
    if (this.modelServices.has(serviceKey)) {
      return this.modelServices.get(serviceKey)!;
    }

    // 获取模型配置，合并自定义配置
    const finalConfig = await this.getDefaultConfig(modelType, customConfig, modelName);

    // 创建新的服务实例（动态创建 BaseModelService，通过 adapterConfig 路由）
    const adapterConfig: ModelAdapterConfig | undefined = modelInfoService.getModelInfoByName(modelName ?? '')?.adapterConfig
    const service = new BaseModelService(finalConfig, modelType, this.mcpService, 'chat')
    if (adapterConfig) {
      service.setAdapterConfig(adapterConfig)
    }

    // 设置MCP Store获取器（如果已设置）
    // BaseModelService 无 setMCPStoreGetter，跳过
    // 设置TaskList Store获取器（如果已设置）
    if (this.taskListStoreGetter && 'setTaskListStoreGetter' in service) {
      (service as any).setTaskListStoreGetter(this.taskListStoreGetter);
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

    // 统一按 provider 名称获取 API Key（经 resolveId 落到稳定 id 命名空间）
    const providerName = info?.provider ?? modelType;
    const apiKey = await this.secureStorage?.getApiKey(providerManager.resolveId(providerName)) ?? '';

    const ac = info?.adapterConfig;

    let baseConfig: ModelConfig;
    if (ac) {
      const model = ac.defaultModel || safeModelName || '';
      baseConfig = {
        model,
        apiKey,
        baseURL: ac.baseURL,
        temperature: ac.defaultTemperature,
        maxTokens: ac.defaultMaxTokens,
        ...(ac.extraBodyParams ? { extraBodyParams: ac.extraBodyParams } : {}),
      };
    } else {
      throw new Error(`No adapterConfig found for model: ${safeModelName ?? modelType}. Every model must define adapterConfig in ModelInfo.`)
    }
    
    // 如果有自定义配置，合并到基础配置中
    if (customConfig) {
      // 【修复】标准化参数名格式，将下划线格式转换为驼峰格式
      const normalizedConfig = normalizeConfigKeys(customConfig);
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
    const customConfig: Partial<ModelConfig> = { ...userParams, ...(options?.extraConfig || {}) }

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