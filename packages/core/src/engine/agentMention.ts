/**
 * `@` 提及解析（agent 提及）
 *
 * `@` = 提及一个实体：带扩展名（@图.png）= 文件提及（现阶段媒体类，壳侧先行提取）；
 * kebab-case 无点号（@security-reviewer）= agent 提及（本模块）。
 * 仅当名称精确匹配某个模板的 subagent_type 才算命中，不匹配按普通文本处理。
 */

/**
 * 从用户文本中解析显式点名的 agent
 * @param text - 用户输入文本
 * @param availableTypes - 可用模板的 subagent_type 集合（getAllTemplates() 全量）
 * @returns 第一个命中模板的 type；都不命中返回 {}
 */
export function parseAgentMentions(
  text: string,
  availableTypes: Set<string>,
): { explicitAgent?: string } {
  const pattern = /@([a-z0-9]+(?:-[a-z0-9]+)*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (availableTypes.has(match[1])) {
      return { explicitAgent: match[1] }
    }
  }
  return {}
}

/**
 * 裸提及解析（直聊语义）：整条消息只有一个 `@subagent_type`、无其他任何内容。
 * 命中 = 用户"喊名字"——切换前台直聊（壳层走 /front 等价路径，零模型往返）；
 * 带任务内容 = 委派（走 parseAgentMentions 语义）。
 * @returns 命中返回 type；带内容/多个提及/未知 type 返回 undefined
 */
export function parseBareAgentMention(
  text: string,
  availableTypes: Set<string>,
): string | undefined {
  const match = /^@([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(text.trim())
  if (!match || !availableTypes.has(match[1])) return undefined
  return match[1]
}
