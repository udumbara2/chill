/**
 * Skill解析器
 * 解析SKILL.md文件，校验frontmatter字段合法性
 */

import { dirname } from 'path'
import matter from 'gray-matter'
import type { SkillMeta } from '../types/skill'

/** SKILL.md解析结果 */
export interface SkillParseResult {
  success: boolean
  skill?: SkillMeta
  error?: string
}

/** skill name命名规范：小写字母/数字/连字符，不首尾连字符，不连续连字符 */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 解析SKILL.md文件内容
 * @param content - 文件内容
 * @param filePath - 文件路径（用于错误提示）
 * @returns 解析结果
 */
export function parseSkillMd(content: string, filePath: string): SkillParseResult {
  try {
    const parsed = matter(content)
    const frontmatter = parsed.data
    const body = parsed.content.trim()

    // 校验必填字段：name
    if (!frontmatter.name || typeof frontmatter.name !== 'string') {
      return { success: false, error: `SKILL.md缺少必填字段 "name" (${filePath})` }
    }
    const skillName = frontmatter.name.trim()

    // 校验name格式
    if (!NAME_PATTERN.test(skillName)) {
      return {
        success: false,
        error: `skill name "${skillName}" 不符合命名规范，只能包含小写字母、数字和连字符，且不能首尾或连续使用连字符 (${filePath})`,
      }
    }
    if (skillName.length > 64) {
      return { success: false, error: `skill name "${skillName}" 超过64字符限制 (${filePath})` }
    }

    // 校验name与目录名一致（从filePath中提取目录名）
    const dirName = filePath.replace(/[/\\]SKILL\.md$/i, '').split(/[/\\]/).pop() || ''
    if (skillName !== dirName) {
      return {
        success: false,
        error: `skill name "${skillName}" 与目录名 "${dirName}" 不一致 (${filePath})`,
      }
    }

    // 校验必填字段：description
    if (!frontmatter.description || typeof frontmatter.description !== 'string') {
      return { success: false, error: `SKILL.md缺少必填字段 "description" (${filePath})` }
    }
    const description = frontmatter.description.trim()
    if (description.length === 0 || description.length > 1024) {
      return {
        success: false,
        error: `skill description 必须为1-1024字符 (${filePath})`,
      }
    }

    // 校验可选字段：compatibility（若提供则校验长度1-500）
    let compatibility: string | undefined
    if (typeof frontmatter.compatibility === 'string') {
      const raw = frontmatter.compatibility.trim()
      if (raw.length === 0 || raw.length > 500) {
        return {
          success: false,
          error: `skill compatibility 若提供则必须为1-500字符 (${filePath})`,
        }
      }
      compatibility = raw
    }

    // 解析可选字段：allowed-tools（空格分隔的工具名列表）
    let allowedTools: string[] | undefined
    if (typeof frontmatter['allowed-tools'] === 'string') {
      allowedTools = frontmatter['allowed-tools'].trim().split(/\s+/).filter(Boolean)
    }

    const skill: SkillMeta = {
      name: skillName,
      description,
      body,
      sourcePath: filePath,
      basePath: dirname(filePath),
      compatibility,
      allowedTools,
    }

    return { success: true, skill }
  } catch (error: any) {
    return { success: false, error: `解析SKILL.md失败 (${filePath}): ${error.message}` }
  }
}
