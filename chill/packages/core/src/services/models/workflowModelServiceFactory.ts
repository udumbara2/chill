import { ModelType, type ModelService, type ModelConfig, type ToolDefinition, type StreamCallback, type Message, type ModelResponse } from '../../types/models';
import type { ModelAdapterConfig } from '../../types/models';
import { BaseModelService } from './baseModelService';
import { modelInfoService } from './modelInfoService';
import { resolveCredentialId, resolveKeySlotId } from './providerManager';
import { resolveApiModelId } from './modelIdentity';
import type { ISecureStorage } from '../../interfaces/ISecureStorage';
import { MCPService } from '../mcp/mcpService';
import type { ToolRegistry } from '../toolExecutorRegistry';
import { normalizeConfigKeys } from './modelServiceFactory';

export interface WorkflowModelServiceFactory {
  createModelService(
    modelType: ModelType,
    customConfig?: Partial<ModelConfig>,
    modelName?: string
  ): Promise<ModelService>;

  sendMessage(
    modelType: ModelType,
    messages: Message[],
    tools?: ToolDefinition[],
    registry?: ToolRegistry,
    streamCallback?: StreamCallback,
    customConfig?: Partial<ModelConfig>,
    abortController?: AbortController,
    modelName?: string
  ): Promise<ModelResponse>;
}

class WorkflowModelServiceFactoryImpl implements WorkflowModelServiceFactory {
  private mcpStoreGetter?: () => { getMCPToolsEnabled: () => boolean };
  private secureStorage?: ISecureStorage;

  constructor(mcpStoreGetter?: () => { getMCPToolsEnabled: () => boolean }, secureStorage?: ISecureStorage) {
    this.mcpStoreGetter = mcpStoreGetter;
    this.secureStorage = secureStorage;
  }

  setMCPStoreGetter(mcpStoreGetter: () => { getMCPToolsEnabled: () => boolean }): void {
    this.mcpStoreGetter = mcpStoreGetter;
  }

  async createModelService(
    modelType: ModelType,
    customConfig?: Partial<ModelConfig>,
    modelName?: string
  ): Promise<ModelService> {
    const mcpService = new MCPService();
    if (this.mcpStoreGetter) {
      mcpService.setMCPStoreGetter(this.mcpStoreGetter);
    }

    const finalConfig = await this.getDefaultConfig(modelType, customConfig, modelName);

    const info = modelInfoService.getModelInfoByName(modelName ?? '')
    const adapterConfig: ModelAdapterConfig | undefined = info?.adapterConfig
    const service = new BaseModelService(finalConfig, modelType, mcpService, 'workflow')
    if (adapterConfig) {
      service.setAdapterConfig(adapterConfig)
    }
    // 窗口回填（窗口准入 SSOT=outputBudget.ts；本工厂无缓存，每次创建现值）
    service.maxContextTokens = info?.maxContextTokens

    return service;
  }

  async sendMessage(
    modelType: ModelType,
    messages: Message[],
    tools?: ToolDefinition[],
    registry?: ToolRegistry,
    streamCallback?: StreamCallback,
    customConfig?: Partial<ModelConfig>,
    abortController?: AbortController,
    modelName?: string
  ): Promise<ModelResponse> {
    const service = await this.createModelService(modelType, customConfig, modelName);
    
    const result = await service.sendMessage(messages, tools, registry, streamCallback, abortController);
    
    return result;
  }

  private filterEmptyValues(config: any): any {
    const filteredConfig: any = {};
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && value !== null && value !== '') {
        if (Array.isArray(value) && value.length === 0) {
          continue;
        }
        if (typeof value === 'object' && Object.keys(value).length === 0) {
          continue;
        }
        filteredConfig[key] = value;
      }
    }
    return filteredConfig;
  }

  private async getDefaultConfig(modelType: ModelType, customConfig?: Partial<ModelConfig>, modelName?: string): Promise<ModelConfig> {
    // 优先使用传入的apiKey，如果不存在才从安全存储获取
    let apiKey = '';

    // 与 chat 模式一致：统一按凭证域取 key（resolveCredentialId：显式 credentialRealm 优先，
    // 缺省 provider × 端点通道派生），废弃旧的按 modelType / modelName 取 key 的约定
    const info = modelInfoService.getModelInfoByName(modelName ?? '')

    if (customConfig?.apiKey) {
      apiKey = customConfig.apiKey;
    } else {
      // 主进程中SecureStorageService可能无法使用（window不存在）
      try {
        apiKey = await this.secureStorage?.getApiKey(info ? resolveCredentialId(info) : resolveKeySlotId(String(modelType), undefined)) ?? '';
      } catch (e) {
        // 主进程中window不存在，忽略错误
        apiKey = '';
      }
    }

    // 如果传入的apiKey为空且无法从安全存储获取，打印警告
    if (!apiKey && !customConfig?.apiKey) {
      console.warn(`[WorkflowModelService] API Key not found for ${info?.provider ?? modelType}, may cause authentication failure`);
    }
    let baseConfig: ModelConfig;

    // 优先从 adapterConfig 读取
    const ac = info?.adapterConfig
    if (ac) {
      baseConfig = {
        // 请求字段只装上游事实（V6）：apiModelId 优先，旧卡回退 defaultModel，绝不回退本地注册名
        model: resolveApiModelId(info!) || '',
        apiKey,
        baseURL: ac.baseURL,
        temperature: ac.defaultTemperature,
        maxTokens: ac.defaultMaxTokens,
      }
    } else {
      throw new Error(`No adapterConfig found for model: ${modelName ?? modelType}. Every model must define adapterConfig in ModelInfo.`)
    }

    if (customConfig) {
      const normalizedConfig = normalizeConfigKeys(customConfig);
      const filteredConfig = this.filterEmptyValues(normalizedConfig);
      const finalConfig = { ...baseConfig, ...filteredConfig };
      return finalConfig;
    }

    return baseConfig;
  }
}

export function createWorkflowModelServiceFactory(
  mcpStoreGetter?: () => { getMCPToolsEnabled: () => boolean },
  secureStorage?: ISecureStorage
): WorkflowModelServiceFactory {
  return new WorkflowModelServiceFactoryImpl(mcpStoreGetter, secureStorage);
}
