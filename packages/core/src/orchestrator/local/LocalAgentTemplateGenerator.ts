import { BridgeProtocol, TemplatePriority, TemplateType, PriorityScope } from '../types'
import type { SubagentTemplate, BridgeConfig } from '../types'
import type { SavedAgent } from '../../types/workflow'

/**
 * Local Agent 模板生成器
 * 将本地保存的 SavedAgent 转换为 Subagent 模板
 */
export class LocalAgentTemplateGenerator {
  /**
   * 生成 Local Agent 模板文件内容
   * @param agent - 本地保存的Agent
   * @returns 生成的模板文件内容
   */
  async generate(agent: SavedAgent): Promise<string> {
    const template = this.generateTemplateObject(agent)
    const frontmatter = this.generateFrontmatter(template)
    const body = this.generateBody(agent)
    return frontmatter + body
  }

  generateTemplateObject(agent: SavedAgent): SubagentTemplate {
    if (!agent.metadata?.id) {
      throw new Error('Local Agent 必须包含 metadata.id')
    }

    const subagentType = `local-${agent.metadata.id}`
    const tools = agent.metadata.agentCard?.skills?.map(s => s.id) || []

    return {
      name: agent.metadata.name,
      description: agent.metadata.description || agent.metadata.agentCard?.description,
      subagent_type: subagentType,
      type: TemplateType.REMOTE_API,
      priority: TemplatePriority.REMOTE,
      priority_scope: PriorityScope.REMOTE,
      bridge_protocol: BridgeProtocol.LOCAL_A2A,
      bridge_config: this.buildBridgeConfig(agent),
      tools: tools.length > 0 ? tools : undefined,
      system_prompt: this.generateSystemPrompt(agent),
    }
  }

  /**
   * 构建桥接配置
   */
  private buildBridgeConfig(agent: SavedAgent): BridgeConfig {
    return {
      endpoint: 'http://localhost:3000/a2a',
      auth_type: 'none',
      agent_id: agent.metadata.id,
      timeout: 300,
    }
  }

  /**
   * 生成系统提示词
   */
  private generateSystemPrompt(agent: SavedAgent): string {
    const skills = agent.metadata.agentCard?.skills || []
    return `你是本地Agent：${agent.metadata.name}。

${agent.metadata.description || ''}

核心能力：
${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}

执行方式：通过本地A2A协议调用`
  }

  /**
   * 生成 frontmatter
   */
  private generateFrontmatter(template: SubagentTemplate): string {
    const frontmatterData = {
      name: template.name,
      description: template.description,
      subagent_type: template.subagent_type,
      type: template.type,
      priority: template.priority,
      priority_scope: template.priority_scope,
      bridge_protocol: template.bridge_protocol,
      bridge_config: template.bridge_config,
      tools: template.tools,
    }

    const cleanData = Object.fromEntries(
      Object.entries(frontmatterData).filter(([_, v]) => v !== undefined),
    )

    return `---\n${this.objectToYaml(cleanData)}---\n\n`
  }

  /**
   * 将对象转换为YAML格式
   */
  private objectToYaml(obj: Record<string, any>, indent = 0): string {
    const spaces = '  '.repeat(indent)
    let yaml = ''

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue

      if (typeof value === 'object' && !Array.isArray(value)) {
        yaml += `${spaces}${key}:\n`
        yaml += this.objectToYaml(value, indent + 1)
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          yaml += `${spaces}${key}: []\n`
        } else {
          yaml += `${spaces}${key}:\n`
          for (const item of value) {
            yaml += `${spaces}- ${item}\n`
          }
        }
      } else if (typeof value === 'string') {
        if (value.includes(':') || value.includes('#') || value.includes('\n')) {
          yaml += `${spaces}${key}: "${value.replace(/"/g, '\\"')}"\n`
        } else {
          yaml += `${spaces}${key}: ${value}\n`
        }
      } else {
        yaml += `${spaces}${key}: ${value}\n`
      }
    }

    return yaml
  }

  /**
   * 生成模板正文
   */
  private generateBody(agent: SavedAgent): string {
    const skills = agent.metadata.agentCard?.skills || []
    return `## 角色
${agent.metadata.name} - ${agent.metadata.description || '本地A2A Agent'}

## 核心能力
${skills.map(s => `- **${s.name}**: ${s.description}`).join('\n') || '- 执行复杂任务'}

## 执行约束
- 通过本地A2A服务执行，endpoint: http://localhost:3000/a2a
- 执行结果遵循A2A协议标准格式

## 来源信息
- Agent ID: ${agent.metadata.id}
- 版本: ${agent.metadata.version}
- 创建时间: ${new Date(agent.metadata.createdAt).toISOString()}
`
  }
}
