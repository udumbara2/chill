/**
 * 模板序列化器：parseTemplate 的逆运算（SubagentTemplate → frontmatter+正文 .md）。
 *
 * 与 TemplateParser 构成"解析⇄序列化"双向同构——UI 编辑器预览/保存、
 * SavedAgent 迁移、未来的 install_agent 等能力共用同一序列化器（放 core 共用）。
 *
 * 纯净原则：空可选字段不落入 frontmatter（"不写=默认"语义与解析器一致）；
 * 字段顺序与内置模板风格一致（type → subagent_type → name → description → 权限 → 资源 → 参数）。
 */

import matter from 'gray-matter'
import type { SubagentTemplate } from '../types'

/** 单值标量字段（非空才写入；按内置模板风格的顺序） */
const SCALAR_FIELDS = [
  'type',
  'subagent_type',
  'name',
  'description',
  'model',
  'user_prompt_template',
  'priority',
  'priority_scope',
  'is_overridable',
  'version',
  'author',
  'bridge_protocol',
] as const

/** 字符串数组字段（非空数组才写入） */
const STRING_ARRAY_FIELDS = ['tools', 'disallowed_tools', 'skills', 'knowledge', 'tags'] as const

/**
 * 序列化模板对象为 .md 文件内容。
 * @param template - 模板对象（name/subagent_type 必填，由调用方先过 validateSubagentType/parseTemplate 校验）
 * @returns frontmatter + 正文的完整文件内容
 */
export function serializeTemplate(template: SubagentTemplate): string {
  const data: Record<string, unknown> = {}

  for (const field of SCALAR_FIELDS) {
    const value = template[field as keyof SubagentTemplate]
    if (value !== undefined && value !== null && value !== '') {
      data[field] = value
    }
  }
  if (template.readonly !== undefined) data.readonly = template.readonly
  if (template.memory) data.memory = template.memory
  for (const field of STRING_ARRAY_FIELDS) {
    const value = template[field as keyof SubagentTemplate] as string[] | undefined
    if (Array.isArray(value) && value.length > 0) {
      data[field] = value
    }
  }
  if (template.default_parameters && Object.keys(template.default_parameters).length > 0) {
    data.default_parameters = template.default_parameters
  }
  if (template.bridge_config && Object.keys(template.bridge_config).length > 0) {
    data.bridge_config = template.bridge_config
  }

  const body = (template.system_prompt ?? '').trim()
  // gray-matter stringify：frontmatter + 正文（正文前留一空行，与内置模板风格一致）
  return matter.stringify(body ? `\n${body}\n` : '\n', data)
}
