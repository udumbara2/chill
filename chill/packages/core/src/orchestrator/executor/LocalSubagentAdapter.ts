import type { SubagentTemplate, DefaultParameters, TaskToolOutput } from '../types'
import { TaskExecutionStatus } from '../types'
import type { ISecureStorage } from '../../interfaces/ISecureStorage'
import type { ISubagentExecutor, SubagentExecuteExtras } from '../../execution/ISubagentExecutor'
import { ModelType, type ToolDefinition } from '../../types/models'
import { modelInfoService } from '../../services/models/modelInfoService'
import { resolveCredentialId, resolveKeySlotId } from '../../services/models/providerManager'
import { SelectedModelsService } from '../../services/selectedModelsService'

/**
 * Subagent 模型配置解析结果（adapter 执行与委派 preflight 共用的单一事实源）
 */
export interface SubagentModelConfig {
  /** 兜底链解析出的模型名；四级链全空时为 null */
  modelName: string | null
  modelType: ModelType
  /** 按 provider 解析的 API Key（未配置为空字符串） */
  apiKey: string
  /** 注册表中的 baseURL（模型未注册或未配置时为 null） */
  baseURL: string | null
}

/**
 * 当前会话模型名；SelectedModelsService 未初始化或读取异常时返回 null（落到注册表默认）
 */
function getSessionModelName(): string | null {
  try {
    return SelectedModelsService.getInstance().getCurrentModelName()
  } catch {
    return null
  }
}

function resolveModelType(modelName?: string): ModelType {
  if (!modelName) return ModelType.GLM
  return modelInfoService.getModelInfoByName(modelName)?.type ?? ModelType.GLM
}

/**
 * 解析 Subagent 模型配置（LocalSubagentAdapter.execute 与委派 preflight 共用，
 * 禁止复制出第二份——两处必须走同一条解析链，否则预检与执行会漂移）。
 * 模型兜底链：委派 override > 模板 model > 当前会话模型 > 注册表默认；
 * key 解析与主对话同约定：统一经 resolveCredentialId 取凭证域（与 add_model 的存储名目一致）。
 */
export async function resolveSubagentModelConfig(
  template: SubagentTemplate,
  mergedParams: DefaultParameters,
  secureStorage: ISecureStorage
): Promise<SubagentModelConfig> {
  const modelName =
    mergedParams.model || template.model || getSessionModelName() || modelInfoService.getDefaultModelName() || null
  const info = modelName ? modelInfoService.getModelInfoByName(modelName) : undefined
  const modelType = info?.type ?? resolveModelType(modelName ?? undefined)
  const apiKey = modelName
    ? (await secureStorage.getApiKey(
        info ? resolveCredentialId(info) : resolveKeySlotId(modelName, undefined),
      )) || ''
    : ''
  const baseURL = info?.adapterConfig?.baseURL ?? null
  return { modelName, modelType, apiKey, baseURL }
}

export class LocalSubagentAdapter {
  private secureStorage: ISecureStorage
  private subagentExecutor: ISubagentExecutor

  constructor(secureStorage: ISecureStorage, subagentExecutor: ISubagentExecutor) {
    this.secureStorage = secureStorage
    this.subagentExecutor = subagentExecutor
  }

  /**
   * 解析模型配置（暴露给 TaskExecutor 的委派预检；与 execute 共用 resolveSubagentModelConfig）
   */
  resolveModelConfig(
    template: SubagentTemplate,
    mergedParams: DefaultParameters
  ): Promise<SubagentModelConfig> {
    return resolveSubagentModelConfig(template, mergedParams, this.secureStorage)
  }

  async execute(
    template: SubagentTemplate,
    taskDescription: string,
    mergedParams: DefaultParameters,
    startTime: number,
    tools?: ToolDefinition[],
    availableTools?: string[],
    /** 注册表环境绑定键（toolCall.id），透传给执行器做 Worker 环境绑定 */
    environmentKey?: string,
    /** 下行附加信息（成功标准/评审标记/resume 种子），透传给执行器 */
    extras?: SubagentExecuteExtras
  ): Promise<TaskToolOutput> {
    try {
      // 模型配置解析与委派 preflight 同源（resolveSubagentModelConfig）：
      // 兜底链 override > 模板 model > 会话模型 > 注册表默认
      const config = await this.resolveModelConfig(template, mergedParams)
      if (!config.baseURL) {
        throw new Error(`No baseURL found for model: ${config.modelName ?? config.modelType}. Every model must define adapterConfig.baseURL in ModelInfo.`)
      }

      const result = await this.subagentExecutor.execute(
        template as unknown as Record<string, unknown>,
        taskDescription,
        mergedParams as unknown as Record<string, unknown>,
        startTime,
        tools,
        availableTools,
        config.apiKey,
        config.baseURL,
        environmentKey,
        extras
      )

      return result as unknown as TaskToolOutput
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        return {
          status: TaskExecutionStatus.TIMEOUT,
          final_output: '',
          error_info: {
            code: 'TIMEOUT',
            message: '任务执行超时',
            details: error.message,
          },
        }
      }

      return {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : '本地执行失败',
          details: error instanceof Error ? error.stack : undefined,
        },
      }
    }
  }
}
