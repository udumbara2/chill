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
import { TaskExecutionStatus, TemplateType } from '../types'
import { getTemplateManager } from '../managers/SubagentTemplateManager'
import { LocalSubagentAdapter } from './LocalSubagentAdapter'
import type { IRemoteExecutor } from './RemoteExecutorAdapter'
import type { ISecureStorage } from '../../interfaces/ISecureStorage'
import type { ISubagentExecutor } from '../../execution/ISubagentExecutor'
import type { SubagentExecuteExtras } from '../../execution/ISubagentExecutor'
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
  /** 远程执行适配器（通过 setRemoteAdapter 注入） */
  private remoteAdapter: IRemoteExecutor | null = null

  constructor(
    secureStorage?: ISecureStorage,
    subagentExecutor?: ISubagentExecutor
  ) {
    this.localAdapter = new LocalSubagentAdapter(secureStorage!, subagentExecutor!)
  }

  /**
   * 直接执行模板对象(绕过 templateManager 查表):
   * 深绑定 workflow 节点(具名模板或匿名临时模板)与 resume 等场景的执行通道。
   */
  async executeTemplateDirect(
    template: SubagentTemplate,
    taskDescription: string,
    tools?: ToolDefinition[],
    availableTools?: string[],
    environmentKey?: string,
    extras?: SubagentExecuteExtras,
  ): Promise<TaskToolOutput> {
    return this.localAdapter.execute(template, taskDescription, {}, Date.now(), tools, availableTools, environmentKey, extras)
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
   * @param toolMetadata - 工具元数据列表（保留参数；available_tools 解析已收敛到 StandardSubagentExecutor 优先级链）
   * @param tools - 工具定义列表，用于传递给 Subagent
   * @returns Task 工具输出结果
   */
  async executeFromToolCall(
    toolCall: ToolCall,
    _toolMetadata: ToolMetadata[],
    tools?: ToolDefinition[],
    /** 团队成员标记(delegationTools 已按会话级团队状态判定;经 extras 下行到 Worker 注入看板工具定义) */
    teamMember?: boolean,
    /** 团队信箱未读提示(种子注入;成员开工即见全部积压消息) */
    inboxNote?: string,
    /** 计划批准门(阶段 1 只读规划,批准后 approve_plan 续跑) */
    requirePlan?: boolean,
    /** 编排工具池豁免(迭代 3:授权快照授予该成员的编排工具,执行器池子放行;安全判定在 delegation 层) */
    grantedOrchestrationTools?: string[]
  ): Promise<TaskToolOutput> {
    // 1. 解析 TaskToolInput
    const taskInput = this.parseTaskToolInput(toolCall.function.arguments)

    // 2. available_tools 原样透传(优先级链唯一解析点在 StandardSubagentExecutor):
    //    不指定/空 = 跟随模板默认(模板未声明 tools = 零工具);["none"] = 显式清零;
    //    显式名单 = 覆盖模板默认。此处不再做"空→全量"放大。

    // 3. 调用 execute 继续执行（透传 toolCall.id 作环境绑定键：cancel_task 经它直达 Worker 环境）
    return await this.execute(taskInput, tools, toolCall.id, teamMember, inboxNote, requirePlan, grantedOrchestrationTools)
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
        require_review: parsed.require_review,
        available_tools: parsed.available_tools,  // 解析模型指定的可用工具列表
        override_parameters: parsed.override_parameters,
        prior_messages: parsed.prior_messages,  // resume 种子（内部载体，仅 resume_task 注入）
        require_plan: parsed.require_plan,  // 计划批准门（阶段 1 只读规划）
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
  async execute(input: TaskToolInput, tools?: ToolDefinition[], environmentKey?: string, teamMember?: boolean, inboxNote?: string, requirePlan?: boolean, grantedOrchestrationTools?: string[]): Promise<TaskToolOutput> {
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
      // success_criteria / require_review 经 extras 贯通到执行器与 Worker（此前 success_criteria 在调度层被静默丢弃）
      return await this.dispatchExecution(
        template,
        input.task_description,
        mergedParams,
        startTime,
        tools,
        input.available_tools,  // ← 传递 Lead Agent 指定的工具列表
        environmentKey,
        {
          successCriteria: input.success_criteria,
          requireReview: input.require_review,
          priorMessages: input.prior_messages,
          teamMember,
          inboxNote,
          requirePlan,
          grantedOrchestrationTools,
        }
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

    // 远程模板（REMOTE_MCP / REMOTE_API）不走本地模型解析链，跳过模型检查；
    // 但 require_review 依赖本地 transcript 修正通道，远程模板无从支撑——明确报错而非静默降级
    const templateType = processResult.template.type || TemplateType.BUILTIN
    if (templateType !== TemplateType.BUILTIN && templateType !== TemplateType.CUSTOM) {
      if (input.require_review) {
        return (
          `无法启动委派: 远程模板（${templateType}）不支持 require_review——` +
          '评审回路的打回修正依赖本地执行上下文，远程 agent 无此通道。请改用本地模板，或去掉 require_review。'
        )
      }
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
    environmentKey?: string,
    extras?: SubagentExecuteExtras
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
          environmentKey,
          extras
        )

      case TemplateType.REMOTE_MCP:
      case TemplateType.REMOTE_API:
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
export function getTaskExecutor(secureStorage?: ISecureStorage, subagentExecutor?: ISubagentExecutor): TaskExecutor {
  if (!globalTaskExecutor) {
    globalTaskExecutor = new TaskExecutor(secureStorage, subagentExecutor)
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
