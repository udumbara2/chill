import { BaseTemplateGenerator } from './BaseTemplateGenerator'
import { BridgeProtocol, TemplatePriority, TemplateType, PriorityScope } from '../../types'
import type { SubagentTemplate, BridgeConfig } from '../../types'
import type { RemoteAgentConfig } from '../../../types/workflow'

/**
 * A2A 协议模板生成器
 * 将 A2A 远程Agent配置转换为 Subagent 模板
 */
export class A2ATemplateGenerator extends BaseTemplateGenerator {
  /**
   * 生成 A2A 模板文件内容
   * @param config - A2A远程Agent配置
   * @returns 生成的模板文件内容
   */
  async generate(config: RemoteAgentConfig): Promise<string> {
    const template = await this.generateTemplateObject(config)
    const frontmatter = this.generateFrontmatter(template)
    const body = this.generateBody(config, template.subagent_type)
    return frontmatter + body
  }

  async generateTemplateObject(config: RemoteAgentConfig): Promise<SubagentTemplate> {
    if (config.type !== 'remote_agent') {
      throw new Error('A2ATemplateGenerator 只支持 type 为 remote_agent 的配置')
    }

    if (!config.url) {
      throw new Error('A2A 配置必须包含 url')
    }

    const subagentType = this.generateSubagentType(config.url)
    const tools = this.extractToolsFromAgentCard(config.agentCard)
    const agentName = config.name || config.agentCard?.name || `A2A Agent: ${subagentType}`
    const agentDescription = config.description || config.agentCard?.description || `A2A 协议远程 Agent - URL: ${config.url}`

    return {
      name: agentName,
      description: agentDescription,
      subagent_type: subagentType,
      type: TemplateType.REMOTE_MCP,
      priority: TemplatePriority.REMOTE,
      priority_scope: PriorityScope.REMOTE,
      bridge_protocol: BridgeProtocol.MCP,
      bridge_config: this.buildBridgeConfig(config),
      tools: tools.length > 0 ? tools : undefined,
      system_prompt: this.generateSystemPrompt(config, subagentType),
    }
  }

  /**
   * 删除模板文件
   * @param subagentType - Subagent类型标识符
   */
  async delete(subagentType: string): Promise<void> {
    // 实际删除操作由 RemoteAgentRegistrar 通过 IPC 调用主进程完成
    // 这里只返回，实际删除逻辑在外层处理
    console.log(`[A2ATemplateGenerator] 准备删除模板: ${subagentType}`)
  }

  /**
   * 生成 subagent_type
   * 使用 URL 的 SHA256 哈希前16位
   * @param url - A2A服务URL
   * @returns 唯一标识符
   */
  private generateSubagentType(url: string): string {
    // 简单的哈希实现（实际项目中可以使用 crypto-js 或 Node.js crypto）
    let hash = 0
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // 转换为32位整数
    }
    // 转换为16进制字符串并取前16位
    const hexHash = Math.abs(hash).toString(16).padStart(16, '0')
    return `a2a-${hexHash.substring(0, 16)}`
  }

  /**
   * 从 AgentCard 提取 capabilities 作为 tools
   * @param agentCard - Agent Card信息
   * @returns tools 列表
   */
  private extractToolsFromAgentCard(agentCard?: { capabilities?: { streaming?: boolean; pushNotifications?: boolean; stateTransitionHistory?: boolean }; skills?: { id: string; name: string; description?: string }[] }): string[] {
    const tools: string[] = []

    if (!agentCard) {
      return tools
    }

    // 提取 capabilities 作为工具
    if (agentCard.capabilities) {
      if (agentCard.capabilities.streaming) {
        tools.push('a2a-streaming')
      }
      if (agentCard.capabilities.pushNotifications) {
        tools.push('a2a-push-notifications')
      }
      if (agentCard.capabilities.stateTransitionHistory) {
        tools.push('a2a-state-history')
      }
    }

    // 提取 skills 作为工具
    if (agentCard.skills) {
      for (const skill of agentCard.skills) {
        tools.push(`a2a-skill-${skill.id}`)
      }
    }

    return tools
  }

  /**
   * 构建桥接配置
   * @param config - A2A配置
   * @returns 桥接配置对象
   */
  private buildBridgeConfig(config: RemoteAgentConfig): BridgeConfig {
    const bridgeConfig: BridgeConfig = {
      endpoint: config.url,
      auth_type: config.auth?.type || 'none',
      timeout: 60,
    }

    // 如果认证类型为 api_key，设置环境变量名
    if (config.auth?.type === 'api_key' && config.auth.apiKey && config.url) {
      bridgeConfig.api_key_env = `A2A_API_KEY_${this.generateSubagentType(config.url).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
    }

    return bridgeConfig
  }

  /**
   * 生成系统提示词
   * @param config - A2A配置
   * @param subagentType - Subagent类型标识符
   * @returns 系统提示词
   */
  private generateSystemPrompt(config: RemoteAgentConfig, subagentType: string): string {
    const agentName = config.agentCard?.name || 'A2A Agent'
    const skills = config.agentCard?.skills?.map(s => s.name).join(', ') || '通用任务'

    return `你是一个 A2A 协议远程 Agent 的代理。\n\n当用户需要调用此 Agent 时，你会将用户的请求转发给 ${agentName} (ID: ${subagentType})。\n\n支持的能力：${skills}\n\n请确保：\n1. 理解用户的意图\n2. 将请求转换为适合 A2A Agent 处理的格式\n3. 返回 A2A Agent 的响应给用户`
  }

  /**
   * 生成模板正文内容
   * @param config - A2A配置
   * @param subagentType - Subagent类型标识符
   * @returns 模板正文
   */
  private generateBody(config: RemoteAgentConfig, subagentType: string): string {
    const capabilities = config.agentCard?.capabilities
    const skills = config.agentCard?.skills

    let capabilitiesText = ''
    if (capabilities) {
      const caps: string[] = []
      if (capabilities.streaming) caps.push('流式响应')
      if (capabilities.pushNotifications) caps.push('推送通知')
      if (capabilities.stateTransitionHistory) caps.push('状态历史')
      if (caps.length > 0) {
        capabilitiesText = `\n- **支持的能力**: ${caps.join(', ')}`
      }
    }

    let skillsText = ''
    if (skills && skills.length > 0) {
      skillsText = `\n- **技能列表**:\n${skills.map(s => `  - ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n')}`
    }

    return `## A2A Agent 配置\n\n- **Agent ID**: ${subagentType}\n- **服务 URL**: ${config.url}${capabilitiesText}${skillsText}\n\n## 使用说明\n\n此 Subagent 用于调用 A2A 协议的远程 Agent。\n\n### 认证方式\n\n${config.auth?.type === 'api_key' ? `API Key 通过环境变量 \`${this.buildBridgeConfig(config).api_key_env}\` 读取，请勿将 Key 硬编码在模板中。` : '此 Agent 不需要认证。'}\n\n### 调用示例\n\n\`\`\`\n用户：请帮我使用 A2A Agent 处理以下问题...\n\`\`\`\n`
  }
}
