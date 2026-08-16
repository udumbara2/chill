/**
 * RemoteExecutorAdapter - 远程 Agent 执行适配器
 * 封装 CozeAgentAdapter 和 A2aClient 调用，输出 TaskToolOutput
 */
import { CozeAgentAdapter } from '../../services/coze/CozeAgentAdapter'
import { A2AClient } from '../../services/a2aClient'
import type { ISecureStorage } from '../../interfaces/ISecureStorage'
import { BridgeProtocol, TaskExecutionStatus } from '../types'
import type { SubagentTemplate, DefaultParameters, TaskToolOutput } from '../types'

/**
 * 远程执行器接口
 */
export interface IRemoteExecutor {
  execute(
    template: SubagentTemplate,
    taskDescription: string,
    mergedParams: DefaultParameters,
    startTime: number
  ): Promise<TaskToolOutput>
}

/**
 * 远程 Agent 执行适配器
 * 根据 bridge_protocol 选择合适的执行方式
 */
export class RemoteExecutorAdapter implements IRemoteExecutor {
  private secureStorage: ISecureStorage

  constructor(secureStorage: ISecureStorage) {
    this.secureStorage = secureStorage
  }

  async execute(
    template: SubagentTemplate,
    taskDescription: string,
    _mergedParams: DefaultParameters,
    startTime: number
  ): Promise<TaskToolOutput> {
    const protocol = template.bridge_protocol

    try {
      if (protocol === BridgeProtocol.COZE) {
        return await this.executeCoze(template, taskDescription, startTime)
      }

      if (protocol === BridgeProtocol.MCP) {
        return await this.executeA2A(template, taskDescription, startTime)
      }

      return {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: 'UNSUPPORTED_PROTOCOL',
          message: `不支持的远程协议: ${protocol}`,
        },
      }
    } catch (error) {
      return {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: 'REMOTE_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : '远程执行失败',
          details: error instanceof Error ? error.stack : undefined,
        },
      }
    }
  }

  /**
   * 执行 Coze Bot Agent
   */
  private async executeCoze(
    template: SubagentTemplate,
    taskDescription: string,
    startTime: number
  ): Promise<TaskToolOutput> {
    const botId = template.subagent_type.replace('coze-', '')
    const token = await this.secureStorage.getApiKey('coze')

    if (!token) {
      return {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: 'MISSING_TOKEN',
          message: 'Coze Token 未配置，请在设置中配置 Coze Token',
        },
      }
    }

    const cozeAdapter = new CozeAgentAdapter({
      bot_id: botId,
      token,
      baseURL: template.bridge_config?.endpoint,
    })

    const result = await cozeAdapter.chat(taskDescription)

    return {
      status: TaskExecutionStatus.COMPLETED,
      final_output: result.content,
      resource_usage: {
        execution_time: Date.now() - startTime,
      },
    }
  }

  /**
   * 执行 A2A MCP Agent
   */
  private async executeA2A(
    template: SubagentTemplate,
    taskDescription: string,
    startTime: number
  ): Promise<TaskToolOutput> {
    const url = template.bridge_config?.endpoint || ''

    if (!url) {
      return {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: 'MISSING_URL',
          message: 'A2A Agent 未配置服务 URL',
        },
      }
    }

    const a2aClient = new A2AClient({
      url,
      timeout: 60000,
    })

    const response = await a2aClient.sendTask({
      sessionId: `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      message: {
        role: 'user',
        parts: [{ type: 'text', text: taskDescription }],
      },
    })

    if (response.error) {
      return {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: 'A2A_ERROR',
          message: response.error.message,
        },
      }
    }

    const output = response.message?.parts?.map(p => p.text).join('\n') || ''

    return {
      status: TaskExecutionStatus.COMPLETED,
      final_output: output,
      resource_usage: {
        execution_time: Date.now() - startTime,
      },
    }
  }
}
