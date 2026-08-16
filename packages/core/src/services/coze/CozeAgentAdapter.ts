import { CozeAPI, COZE_CN_BASE_URL, RoleType } from '@coze/api'
import type { AgentCard } from '../../types/workflow'

/**
 * Coze Adapter配置接口
 */
export interface CozeAdapterConfig {
  /** Bot ID */
  bot_id: string
  /** Token（从SecureStorageService获取） */
  token: string
  /** API基础URL */
  baseURL?: string
}

/**
 * Coze Agent适配器
 * 封装Coze API调用，提供统一的Agent接口
 */
export class CozeAgentAdapter {
  private client: CozeAPI
  private config: CozeAdapterConfig

  /**
   * 创建Coze Agent适配器
   * @param config 适配器配置
   */
  constructor(config: CozeAdapterConfig) {
    this.config = config
    this.client = new CozeAPI({
      token: config.token,
      baseURL: config.baseURL || COZE_CN_BASE_URL,
      allowPersonalAccessTokenInBrowser: true,
    })
  }

  /**
   * 非流式聊天
   * @param message 用户消息
   * @returns 响应内容
   */
  async chat(message: string): Promise<{ content: string }> {
    try {
      const result = await this.client.chat.createAndPoll({
        bot_id: this.config.bot_id,
        additional_messages: [
          {
            role: RoleType.User,
            content: message,
            content_type: 'text',
          },
        ],
      })

      // 提取助手回复内容
      let content = ''
      for (const message of result.messages || []) {
        if (message.role === RoleType.Assistant && message.content) {
          content += message.content
        }
      }

      return { content }
    } catch (error) {
      console.error('Coze chat error:', error)
      throw new Error(`Coze聊天调用失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 流式聊天
   * @param message 用户消息
   * @returns 异步迭代器
   */
  async *chatStream(message: string): AsyncGenerator<string, void, unknown> {
    try {
      const stream = await this.client.chat.stream({
        bot_id: this.config.bot_id,
        additional_messages: [
          {
            role: RoleType.User,
            content: message,
            content_type: 'text',
          },
        ],
      })

      for await (const event of stream) {
        // 处理消息增量事件
        if (event.event === 'conversation.message.delta') {
          const delta = event.data
          if (delta?.content) {
            yield delta.content
          }
        }
        // 处理聊天完成事件
        else if (event.event === 'conversation.chat.completed') {
          // 聊天完成，可以在这里处理完成逻辑
          break
        }
      }
    } catch (error) {
      console.error('Coze chat stream error:', error)
      throw new Error(`Coze流式聊天调用失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 获取Bot信息
   * @returns AgentCard格式信息
   */
  async getBotInfo(): Promise<AgentCard> {
    try {
      const botInfo = await this.client.bots.retrieve({
        bot_id: this.config.bot_id,
      })

      // 转换为AgentCard格式
      return {
        name: botInfo.name || 'Unknown Bot',
        description: botInfo.description || '',
        version: '1.0.0',
        capabilities: {
          streaming: true,
        },
        skills: [],
      }
    } catch (error) {
      console.error('Coze getBotInfo error:', error)
      throw new Error(`获取Bot信息失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
