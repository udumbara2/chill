/**
 * 模板解析器
 * 使用 gray-matter 解析 frontmatter + markdown 格式的模板文件
 */

import matter from 'gray-matter'
import type { SubagentTemplate, TemplateParseResult } from '../types'
import { TemplateType, PriorityScope, BridgeProtocol } from '../types'
import { validateStringArrayField, warnIfZeroToolsWithMounts } from './stringArrayField'

/**
 * 解析模板文件内容
 * @param content - 模板文件内容
 * @param filePath - 文件路径（用于错误信息）
 * @returns 解析结果
 */
export function parseTemplate(content: string, filePath?: string): TemplateParseResult {
  try {
    // 使用 gray-matter 解析 frontmatter 和 content
    const parsed = matter(content)
    const frontmatter = parsed.data
    const markdownContent = parsed.content

    // 校验必填字段：name
    if (!frontmatter.name || typeof frontmatter.name !== 'string') {
      return {
        success: false,
        error: `模板缺少必填字段 "name"${filePath ? ` (${filePath})` : ''}`,
      }
    }

    // 校验必填字段：subagent_type
    if (!frontmatter.subagent_type || typeof frontmatter.subagent_type !== 'string') {
      return {
        success: false,
        error: `模板缺少必填字段 "subagent_type"${filePath ? ` (${filePath})` : ''}`,
      }
    }

    // 校验 subagent_type 命名规范
    // 规则：小写字母+连字符，无空格/特殊字符/中文
    const subagentType = frontmatter.subagent_type
    const validPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
    if (!validPattern.test(subagentType)) {
      return {
        success: false,
        error: `subagent_type "${subagentType}" 不符合命名规范，只能包含小写字母、数字和连字符${filePath ? ` (${filePath})` : ''}`,
      }
    }

    // 运行时类型校验：验证 type 字段
    if (frontmatter.type && !isValidTemplateType(frontmatter.type)) {
      return {
        success: false,
        error: `无效的 type 值 "${frontmatter.type}"，必须是 ${Object.values(TemplateType).join(', ')} 之一${filePath ? ` (${filePath})` : ''}`,
      }
    }

    // 运行时类型校验：验证 priority_scope 字段
    if (frontmatter.priority_scope && !isValidPriorityScope(frontmatter.priority_scope)) {
      return {
        success: false,
        error: `无效的 priority_scope 值 "${frontmatter.priority_scope}"，必须是 ${Object.values(PriorityScope).join(', ')} 之一${filePath ? ` (${filePath})` : ''}`,
      }
    }

    // 运行时类型校验：验证 bridge_protocol 字段
    if (frontmatter.bridge_protocol && !isValidBridgeProtocol(frontmatter.bridge_protocol)) {
      return {
        success: false,
        error: `无效的 bridge_protocol 值 "${frontmatter.bridge_protocol}"，必须是 ${Object.values(BridgeProtocol).join(', ')} 之一${filePath ? ` (${filePath})` : ''}`,
      }
    }

    // 运行时类型校验：验证 memory 字段（per-agent 记忆作用域）
    if (frontmatter.memory && !isValidMemoryScope(frontmatter.memory)) {
      return {
        success: false,
        error: `无效的 memory 值 "${frontmatter.memory}"，必须是 user, project, local 之一${filePath ? ` (${filePath})` : ''}`,
      }
    }

    // 运行时类型校验：skills / knowledge / tools / disallowed_tools（字符串数组）
    // 规则单一事实源：stringArrayField.ts（空数组/关键字归一化 + 警告，不再硬报错）
    const warnings: string[] = []
    const infos: string[] = []
    const at = filePath ? ` (${filePath})` : ''
    const normalizedArrays: Partial<Record<'skills' | 'knowledge' | 'tools' | 'disallowed_tools', string[] | undefined>> = {}
    for (const field of ['skills', 'knowledge', 'tools', 'disallowed_tools'] as const) {
      const result = validateStringArrayField(field, frontmatter[field], `模板字段 "${field}"`)
      if (result.error) {
        return { success: false, error: `${result.error}${at}` }
      }
      if (result.warning) warnings.push(`${result.warning}${at}`)
      if (result.info) infos.push(`${result.info}${at}`)
      normalizedArrays[field] = result.value
    }
    // hedged 警告：声明 memory/knowledge 但零工具（省略）→ 可能部分不生效
    const mountWarning = warnIfZeroToolsWithMounts(
      { tools: normalizedArrays.tools, memory: frontmatter.memory, knowledge: normalizedArrays.knowledge },
      `模板 "${frontmatter.name}"`,
    )
    if (mountWarning) warnings.push(`${mountWarning}${at}`)

    // 运行时类型校验：验证 readonly 字段（布尔值）
    if (frontmatter.readonly !== undefined && typeof frontmatter.readonly !== 'boolean') {
      return {
        success: false,
        error: `无效的 readonly 值，必须是布尔值（true/false）${filePath ? ` (${filePath})` : ''}`,
      }
    }

    // 构建模板对象
    const template: SubagentTemplate = {
      name: frontmatter.name,
      description: frontmatter.description || '',
      subagent_type: subagentType,
      priority: frontmatter.priority || 3, // 默认 BUILTIN = 3
      parameters: frontmatter.parameters || {},
      system_prompt: markdownContent.trim(),
      user_prompt_template: frontmatter.user_prompt_template,
      sourcePath: filePath,
      version: frontmatter.version || '1.0.0',
      author: frontmatter.author || '',
      tags: frontmatter.tags || [],
      // 新字段（可选，保持向后兼容）
      type: frontmatter.type,
      priority_scope: frontmatter.priority_scope,
      is_overridable: frontmatter.is_overridable,
      model: frontmatter.model,
      tools: normalizedArrays.tools,
      disallowed_tools: normalizedArrays.disallowed_tools,
      readonly: frontmatter.readonly,
      memory: frontmatter.memory,
      skills: normalizedArrays.skills,
      knowledge: normalizedArrays.knowledge,
      default_parameters: frontmatter.default_parameters,
      bridge_protocol: frontmatter.bridge_protocol,
      bridge_config: frontmatter.bridge_config,
    }

    return {
      success: true,
      template,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(infos.length > 0 ? { infos } : {}),
    }
  } catch (error: any) {
    return {
      success: false,
      error: `解析模板失败${filePath ? ` (${filePath})` : ''}: ${error.message}`,
    }
  }
}

/**
 * 验证 subagent_type 命名规范
 * @param subagentType - 要验证的类型标识符
 * @returns 是否有效
 */
export function validateSubagentType(subagentType: string): boolean {
  // 规则：小写字母+连字符，无空格/特殊字符/中文
  const validPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
  return validPattern.test(subagentType)
}

/**
 * 验证 TemplateType 枚举值
 * @param value - 要验证的值
 * @returns 是否有效
 */
function isValidTemplateType(value: string): value is TemplateType {
  return Object.values(TemplateType).includes(value as TemplateType)
}

/**
 * 验证 PriorityScope 枚举值
 * @param value - 要验证的值
 * @returns 是否有效
 */
function isValidPriorityScope(value: string): value is PriorityScope {
  return Object.values(PriorityScope).includes(value as PriorityScope)
}

/**
 * 验证 BridgeProtocol 枚举值
 * @param value - 要验证的值
 * @returns 是否有效
 */
function isValidBridgeProtocol(value: string): value is BridgeProtocol {
  return Object.values(BridgeProtocol).includes(value as BridgeProtocol)
}

/**
 * 验证 memory 作用域值（per-agent 记忆：user/project/local）
 * @param value - 要验证的值
 * @returns 是否有效
 */
function isValidMemoryScope(value: string): value is 'user' | 'project' | 'local' {
  return value === 'user' || value === 'project' || value === 'local'
}

/**
 * 批量解析模板文件
 * @param files - 文件内容数组 {content, path}
 * @returns 解析成功的模板数组、错误信息数组与警告数组（警告不阻断加载）
 */
export function parseTemplates(files: Array<{ content: string; path: string }>): {
  templates: SubagentTemplate[]
  errors: string[]
  warnings: string[]
  infos: string[]
} {
  const templates: SubagentTemplate[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const infos: string[] = []

  for (const file of files) {
    const result = parseTemplate(file.content, file.path)

    if (result.success && result.template) {
      templates.push(result.template)
      if (result.warnings) warnings.push(...result.warnings)
      if (result.infos) infos.push(...result.infos)
    } else {
      // 无效模板返回 null，不中断扫描，记录错误
      errors.push(result.error || `未知错误: ${file.path}`)
    }
  }

  return { templates, errors, warnings, infos }
}
