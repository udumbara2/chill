/**
 * Skill SYSTEM 消息构建器
 * 将已加载的 skill 元数据注入对话上下文（渐进式披露阶段1）
 */

import { MessageRole } from '../types/models'
import type { Message } from '../types/models'
import type { SkillMeta } from '../types/skill'

/**
 * 构建 skill 元数据 SYSTEM 消息
 * @param skills - 已加载的 skill 列表
 * @returns SYSTEM 消息对象，若无 skill 则返回 null
 */
export function buildSkillSystemMessage(skills: SkillMeta[]): Message | null {
  if (skills.length === 0) return null

  const skillLines = skills.map(s => {
    const parts = [`- **${s.name}**: ${s.description} (SKILL.md: ${s.sourcePath}`]
    if (s.availableDirs && s.availableDirs.length > 0) {
      parts.push(`，资源: ${s.availableDirs.join(', ')}`)
    }
    if (s.compatibility) {
      parts.push(`，环境要求: ${s.compatibility}`)
    }
    if (s.allowedTools && s.allowedTools.length > 0) {
      parts.push(`，免审批工具: ${s.allowedTools.join(', ')}`)
    }
    return `${parts.join('')})`
  }).join('\n')

  let content = `## 可用技能\n\n${skillLines}\n\n如果你决定使用某个技能，请先调用read_file读取对应的SKILL.md获取完整指令。`

  const hasSelfIterate = skills.some(s => s.name === 'self-iterate')
  if (hasSelfIterate) {
    content += '\n\n**重要**：当用户要求修改、改进、优化本助手项目自身的源代码时（包括但不限于UI界面、颜色风格、功能逻辑、bug修复、配置文件等），必须使用 self-iterate 技能，不要直接修改源代码文件。请先调用 read_file 读取 self-iterate 的 SKILL.md 获取完整流程指令。'
  }

  const hasResources = skills.some(s => s.availableDirs && s.availableDirs.length > 0)
  if (hasResources) {
    content += '\n技能资源目录说明：资源文件位于SKILL.md所在目录的对应子目录中；scripts/下的脚本可用execute_powershell运行，references/和assets/下的文件可用read_file读取'
  }

  return {
    role: MessageRole.SYSTEM,
    content,
    timestamp: new Date(),
  }
}
