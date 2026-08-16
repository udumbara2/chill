/**
 * TaskExecutor - Task 工具执行调度模块
 * 步骤6：移除 createModelService 方法，更新构造函数
 */

import type {
  TaskToolInput,
  TaskToolOutput,
  SubagentTemplate,
  DefaultParameters,
} from '../types'
import { TaskExecutionStatus, TemplateType, BridgeProtocol } from '../types'
import { ORCHESTRATION_TOOL_NAMES } from '../types'
import { getTemplateManager } from '../managers/SubagentTemplateManager'
import { LocalSubagentAdapter } from './LocalSubagentAdapter'
import { LocalA2AAdapter } from './LocalA2AAdapter'
import type { IRemoteExecutor } from './RemoteExecutorAdapter'
import type { ILocalAgentExecutor } from '../../interfaces/ILocalAgentExecutor'
import type { ISecureStorage } from '../../interfaces/ISecureStorage'
import type { ISubagentExecutor } from '../../execution/ISubagentExecutor'
import type { ToolDefinition } from '../../types/models'
import type { ToolCall } from '../../types/models'
import type { ToolMetadata } from '../types'

/**
 * 参数处理结果
 */
interface ParameterProcessResult {
  /** 是否成功 */
  success: boolean
  /** 模板对象 */
  template?: SubagentTemplate
  /** 合并后的参数 */
  mergedParams?: DefaultParameters
  /** 错误信息 */
  error?: string
}

/**
 * Task 执行调度器
 */
export class TaskExecutor {
  /** 本地执行适配器 */
  private localAdapter: LocalSubagentAdapter
  /** 本地A2A执行适配器 */
  private localA2AAdapter: LocalA2AAdapter
  /** 远程执行适配器（通过 setRemoteAdapter 注入） */
  private remoteAdapter: IRemoteExecutor | null = null

  constructor(
    secureStorage?: ISecureStorage,
    subagentExecutor?: ISubagentExecutor,
    localAgentExecutor?: ILocalAgentExecutor
  ) {
    this.localAdapter = new LocalSubagentAdapter(secureStorage!, subagentExecutor!)
    this.localA2AAdapter = new LocalA2AAdapter(localAgentExecutor!)
  }

  /**
   * 设置远程执行适配器
   */
  setRemoteAdapter(adapter: IRemoteExecutor): void {
    this.remoteAdapter = adapter
  }

  /**
   * 从 ToolCall 执行 Task 任务
   * 这是 TaskExecutor 的入口方法，负责解析参数、设置 available_tools 并执行
   * @param toolCall - 原始工具调用
   * @param toolMetadata - 工具元数据列表，用于设置 available_tools
   * @param tools - 工具定义列表，用于传递给 Subagent
   * @returns Task 工具输出结果
   */
  async executeFromToolCall(
    toolCall: ToolCall,
    toolMetadata: ToolMetadata[],
    tools?: ToolDefinition[]
  ): Promise<TaskToolOutput> {
    // 1. 解析 TaskToolInput
    const taskInput = this.parseTaskToolInput(toolCall.function.arguments)

    // 2. 设置 available_tools
    // 如果模型没有指定 available_tools，则使用所有工具作为默认值（编排工具除外——防嵌套委派）
    if (!taskInput.available_tools || taskInput.available_tools.length === 0) {
      if (toolMetadata.length > 0) {
        taskInput.available_tools = toolMetadata
          .map(tool => tool.name)
          .filter(name => !ORCHESTRATION_TOOL_NAMES.includes(name))
      }
    }

    // 3. 调用 execute 继续执行（透传 toolCall.id 作环境绑定键：cancel_task 经它直达 Worker 环境）
    return await this.execute(taskInput, tools, toolCall.id)
  }

  /**
   * 解析 Task 工具输入参数
   * @param argsJson - JSON 格式的参数字符串
   * @returns TaskToolInput 对象
   */
  private parseTaskToolInput(argsJson: string): TaskToolInput {
    try {
      const parsed = JSON.parse(argsJson)
      return {
        task_id: parsed.task_id,
        subagent_type: parsed.subagent_type,
        task_description: parsed.task_description,
        success_criteria: parsed.success_criteria,
        available_tools: parsed.available_tools,  // 解析模型指定的可用工具列表
        override_parameters: parsed.override_parameters,
      }
    } catch (error) {
      throw new Error(`解析 Task 工具参数失败: ${error}`)
    }
  }

  /**
   * 执行 Task 任务
   * @param input - Task 工具输入参数
   * @param tools - 工具定义列表，用于传递给 Subagent
   * @param environmentKey - 注册表环境绑定键（toolCall.id；cancel_task 的 destroy 通道）
   * @returns Task 工具输出结果
   */
  async execute(input: TaskToolInput, tools?: ToolDefinition[], environmentKey?: string): Promise<TaskToolOutput> {
    const startTime = Date.now()

    try {
      // 功能2a：参数处理
      const processResult = await this.validateAndMergeParameters(input)

      if (!processResult.success || !processResult.template || !processResult.mergedParams) {
        return {
          status: TaskExecutionStatus.FAILED,
          final_output: '',
          error_info: {
            code: 'PARAMETER_ERROR',
            message: processResult.error || '参数处理失败',
          },
        }
      }

      const { template, mergedParams } = processResult

      // 功能2b：执行分发
      // 【关键修复】传递 available_tools，让 Lead Agent 指定的工具能够生效
      return await this.dispatchExecution(
        template,
        input.task_description,
        mergedParams,
        startTime,
        tools,
        input.available_tools,  // ← 传递 Lead Agent 指定的工具列表
        environmentKey
      )
    } catch (error) {
      return {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : '任务执行失败',
          details: error instanceof Error ? error.stack : undefined,
        },
      }
    }
  }

  /**
   * 功能2a：验证并合并参数
   * @param input - Task 工具输入参数
   * @returns 参数处理结果
   */
  private async validateAndMergeParameters(
    input: TaskToolInput
  ): Promise<ParameterProcessResult> {
    // 1. 校验 subagent_type 对应模板是否存在
    const templateManager = getTemplateManager()
    const template = templateManager.getTemplateByType(input.subagent_type)

    if (!template) {
      return {
        success: false,
        error: `未找到 subagent_type 为 "${input.subagent_type}" 的模板`,
      }
    }

    // 2. 合并参数：Task 传入参数 + 模板默认配置
    // 规则：Task 传入的参数优先级高于模板默认配置
    const mergedParams: DefaultParameters = {
      // 先应用模板默认参数
      ...template.default_parameters,
      // 再用 Task 传入的参数覆盖
      ...(input.override_parameters?.max_iterations !== undefined && {
        max_iterations: input.override_parameters.max_iterations,
      }),
      ...(input.override_parameters?.token_budget !== undefined && {
        token_budget: input.override_parameters.token_budget,
      }),
      ...(input.override_parameters?.timeout !== undefined && {
        timeout: input.override_parameters.timeout,
      }),
      ...(input.override_parameters?.temperature !== undefined && {
        temperature: input.override_parameters.temperature,
      }),
      ...(input.override_parameters?.model !== undefined && {
        model: input.override_parameters.model,
      }),
      ...(input.override_parameters?.max_tokens !== undefined && {
        maxTokens: input.override_parameters.max_tokens,
      }),
    }

    return {
      success: true,
      template,
      mergedParams,
    }
  }

  /**
   * 委派可启动性预检（delegation 层登记注册表前调用，防"启动即失败"的幽灵通知）：
   * ① 模板存在；② 模型兜底链能解析出模型；③ 该模型有可用 baseURL；④ API Key 非空。
   * 模型解析与执行路径同源（localAdapter.resolveModelConfig → resolveSubagentModelConfig），
   * 远程模板不经本地模型链，跳过模型检查。
   * @param input - Task 工具输入参数
   * @returns null = 可启动；否则为同步错误文案（说明原因与修复建议）
   */
  async preflightDelegation(input: TaskToolInput): Promise<string | null> {
    // ① 模板存在 + 参数合并（与 execute 同一条 validateAndMergeParameters）
    const processResult = await this.validateAndMergeParameters(input)
    if (!processResult.success || !processResult.template || !processResult.mergedParams) {
      return processResult.error || '参数处理失败'
    }

    // 远程模板（REMOTE_MCP / REMOTE_API）不走本地模型解析链，跳过模型检查
    const templateType = processResult.template.type || TemplateType.BUILTIN
    if (templateType !== TemplateType.BUILTIN && templateType !== TemplateType.CUSTOM) {
      return null
    }

    // ②③④ 模型链解析 + baseURL + API Key（与执行路径同源的解析函数）
    const config = await this.localAdapter.resolveModelConfig(
      processResult.template,
      processResult.mergedParams
    )
    if (!config.modelName) {
      return (
        '无法启动委派: 未能解析出可用模型（未选择会话模型且注册表无默认模型）。' +
        '请先选择会话模型，或在 override_parameters.model 中指定模型。'
      )
    }
    const missing: string[] = []
    if (!config.baseURL) missing.push('baseURL')
    if (!config.apiKey) missing.push('API Key')
    if (missing.length > 0) {
      return (
        `无法启动委派: 模型 ${config.modelName} 未配置（缺 ${missing.join('/')}）。` +
        '请检查模板的 model 字段，或移除后跟随当前会话模型。'
      )
    }
    return null
  }

  /**
   * 功能2b：执行分发
   * @param template - Subagent 模板
   * @param taskDescription - 任务描述
   * @param mergedParams - 合并后的参数
   * @param startTime - 开始时间
   * @param tools - 工具定义列表，用于传递给 Subagent
   * @param availableTools - Lead Agent 指定的可用工具列表
   * @returns Task 工具输出结果
   */
  private async dispatchExecution(
    template: SubagentTemplate,
    taskDescription: string,
    mergedParams: DefaultParameters,
    startTime: number,
    tools?: ToolDefinition[],
    availableTools?: string[],
    environmentKey?: string
  ): Promise<TaskToolOutput> {
    // 根据 type 匹配执行方式（最小版只支持 builtin/custom 的本地执行）
    const templateType = template.type || TemplateType.BUILTIN

    switch (templateType) {
      case TemplateType.BUILTIN:
      case TemplateType.CUSTOM:
        // 步骤6：本地执行改为通过 LocalSubagentAdapter 调用 TemplateSubagentForkManager
        // 不再需要创建 BaseModelService，隔离环境在 Worker 中创建
        return await this.localAdapter.execute(
          template,
          taskDescription,
          mergedParams,
          startTime,
          tools,
          availableTools,
          environmentKey
        )

      case TemplateType.REMOTE_MCP:
      case TemplateType.REMOTE_API:
        // 检查是否为本地A2A协议
        if (template.bridge_protocol === BridgeProtocol.LOCAL_A2A) {
          return await this.localA2AAdapter.execute(
            template,
            taskDescription,
            mergedParams,
            startTime
          )
        }
        // COZE / MCP 协议：通过远程执行适配器
        if (this.remoteAdapter) {
          return await this.remoteAdapter.execute(
            template,
            taskDescription,
            mergedParams,
            startTime
          )
        }
        // 未注入远程适配器
        return {
          status: TaskExecutionStatus.FAILED,
          final_output: '',
          error_info: {
            code: 'UNSUPPORTED_TYPE',
            message: `远程执行适配器未配置，暂不支持 ${templateType} 类型的模板执行`,
          },
        }

      default:
        return {
          status: TaskExecutionStatus.FAILED,
          final_output: '',
          error_info: {
            code: 'UNKNOWN_TYPE',
            message: `未知的模板类型: ${templateType}`,
          },
        }
    }
  }
}

/**
 * 全局 TaskExecutor 实例
 */
let globalTaskExecutor: TaskExecutor | null = null

/**
 * 获取全局 TaskExecutor 实例
 * @returns TaskExecutor 实例
 */
export function getTaskExecutor(secureStorage?: ISecureStorage, subagentExecutor?: ISubagentExecutor, localAgentExecutor?: ILocalAgentExecutor): TaskExecutor {
  if (!globalTaskExecutor) {
    globalTaskExecutor = new TaskExecutor(secureStorage, subagentExecutor, localAgentExecutor)
  }
  return globalTaskExecutor
}

/**
 * 检查全局 TaskExecutor 是否已初始化
 * 供 delegation 层防御性检测：getTaskExecutor 是"首个调用者定参"单例，
 * 宿主（CLI CliContext / UI main.ts）须先于 task 工具执行完成注入式初始化
 * @returns 是否已初始化
 */
export function isTaskExecutorInitialized(): boolean {
  return globalTaskExecutor !== null
}

/**
 * 重置全局 TaskExecutor 实例
 * 主要用于测试
 */
export function resetTaskExecutor(): void {
  globalTaskExecutor = null
}
