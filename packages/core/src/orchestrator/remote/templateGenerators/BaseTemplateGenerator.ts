import type { SubagentTemplate } from '../../types'
import type { RemoteAgentConfig } from '../../../types/workflow'

/**
 * 模板生成器抽象基类
 * 定义所有远程Agent模板生成器的通用接口
 */
export abstract class BaseTemplateGenerator {
  /**
   * 生成模板文件内容
   * @param config - 远程Agent配置
   * @returns 生成的模板文件内容（markdown格式）
   */
  abstract generate(config: RemoteAgentConfig): Promise<string>

  /**
   * 删除模板文件
   * @param subagentType - Subagent类型标识符
   */
  abstract delete(subagentType: string): Promise<void>

  /**
   * 获取模板文件路径
   * @param subagentType - Subagent类型标识符
   * @returns 模板文件的完整路径
   */
  protected getTemplatePath(subagentType: string): string {
    const sanitizedType = this.sanitizeSubagentType(subagentType)
    return `${sanitizedType}.md`
  }

  /**
   * 生成 frontmatter
   * @param template - Subagent模板数据
   * @returns YAML frontmatter字符串
   */
  protected generateFrontmatter(template: SubagentTemplate): string {
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
      parameters: template.parameters,
      default_parameters: template.default_parameters,
    }

    // 移除undefined值
    const cleanData = Object.fromEntries(
      Object.entries(frontmatterData).filter(([_, v]) => v !== undefined),
    )

    return `---\n${this.objectToYaml(cleanData)}---\n\n`
  }

  /**
   * 将对象转换为YAML格式
   * @param obj - 要转换的对象
   * @param indent - 缩进级别
   * @returns YAML字符串
   */
  private objectToYaml(obj: Record<string, any>, indent = 0): string {
    const spaces = '  '.repeat(indent)
    let yaml = ''

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        continue
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        yaml += `${spaces}${key}:\n`
        yaml += this.objectToYaml(value, indent + 1)
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          yaml += `${spaces}${key}: []\n`
        } else {
          yaml += `${spaces}${key}:\n`
          for (const item of value) {
            if (typeof item === 'object') {
              yaml += `${spaces}-\n`
              yaml += this.objectToYaml(item, indent + 2)
            } else {
              yaml += `${spaces}- ${item}\n`
            }
          }
        }
      } else if (typeof value === 'string') {
        // 如果字符串包含特殊字符，使用引号包裹
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
   * 清理subagent_type中的非法字符
   * @param subagentType - 原始subagent_type
   * @returns 清理后的subagent_type
   */
  protected sanitizeSubagentType(subagentType: string): string {
    // 替换特殊字符为下划线
    return subagentType.replace(/[^a-zA-Z0-9_-]/g, '_')
  }
}
