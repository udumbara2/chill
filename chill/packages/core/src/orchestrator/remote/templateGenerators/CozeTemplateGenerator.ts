import { BaseTemplateGenerator } from './BaseTemplateGenerator'
import { BridgeProtocol, TemplatePriority, TemplateType, PriorityScope } from '../../types'
import type { SubagentTemplate, BridgeConfig } from '../../types'
import type { RemoteAgentConfig } from '../../../types/workflow'

/**
 * Coze 平台模板生成器
 * 将 Coze 远程Agent配置转换为 Subagent 模板
 */
export class CozeTemplateGenerator extends BaseTemplateGenerator {
  /**
   * 生成 Coze 模板文件内容
   * @param config - Coze远程Agent配置
   * @returns 生成的模板文件内容
   */
  async generate(config: RemoteAgentConfig): Promise<string> {
    const template = await this.generateTemplateObject(config)
    const frontmatter = this.generateFrontmatter(template)
    const body = this.generateBody(config)
    return frontmatter + body
  }

  async generateTemplateObject(config: RemoteAgentConfig): Promise<SubagentTemplate> {
    if (config.type !== 'coze') {
      throw new Error('CozeTemplateGenerator 只支持 type 为 coze 的配置')
    }

    if (!config.bot_id) {
      throw new Error('Coze 配置必须包含 bot_id')
    }

    const subagentType = `coze-${config.bot_id}`
    const agentName = config.name || `Coze Bot: ${config.bot_id}`
    const agentDescription = config.description || `Coze 平台远程 Agent - Bot ID: ${config.bot_id}`

    return {
      name: agentName,
      description: agentDescription,
      subagent_type: subagentType,
      type: TemplateType.REMOTE_API,
      priority: TemplatePriority.REMOTE,
      priority_scope: PriorityScope.REMOTE,
      bridge_protocol: BridgeProtocol.COZE,
      bridge_config: this.buildBridgeConfig(config),
      system_prompt: this.generateSystemPrompt(config),
    }
  }

  /**
   * 删除模板文件
   * @param _subagentType - Subagent类型标识符（即 bot_id）
   */
  async delete(_subagentType: string): Promise<void> {
    // 实际删除操作由 RemoteAgentRegistrar 通过 IPC 调用主进程完成
    // 这里只返回，实际删除逻辑在外层处理
  }

  /**
   * 构建桥接配置
   * @param config - Coze配置
   * @returns 桥接配置对象
   */
  private buildBridgeConfig(config: RemoteAgentConfig): BridgeConfig {
    return {
      endpoint: config.baseURL || 'https://api.coze.cn',
      auth_type: 'api_key',
      // token 不保存到模板，运行时从环境变量读取
      api_key_env: `COZE_TOKEN_${config.bot_id?.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
      timeout: 60,
    }
  }

  /**
   * 生成系统提示词
   * @param config - Coze配置
   * @returns 系统提示词
   */
  private generateSystemPrompt(config: RemoteAgentConfig): string {
    return `你是一个 Coze 平台远程 Agent 的代理。\n\n当用户需要调用此 Agent 时，你会将用户的请求转发给 Coze Bot (ID: ${config.bot_id})。\n\n请确保：\n1. 理解用户的意图\n2. 将请求转换为适合 Coze Bot 处理的格式\n3. 返回 Coze Bot 的响应给用户`
  }

  /**
   * 生成模板正文内容
   * @param config - Coze配置
   * @returns 模板正文
   */
  private generateBody(config: RemoteAgentConfig): string {
    return `## Coze Bot 配置\n\n- **Bot ID**: ${config.bot_id}\n- **API 端点**: ${config.baseURL || 'https://api.coze.cn'}\n\n## 使用说明\n\n此 Subagent 用于调用 Coze 平台上的 Bot。\n\n### 认证方式\n\nToken 通过环境变量 \`COZE_TOKEN_${config.bot_id?.toUpperCase().replace(/[^A-Z0-9]/g, '_')}\` 读取，请勿将 Token 硬编码在模板中。\n\n### 调用示例\n\n\`\`\`\n用户：请帮我使用 Coze Bot 处理以下问题...\n\`\`\`\n`
  }
}
