/**
 * TUI `@` agent 菜单（数据源动态）
 *
 * 与 commandMenu 的静态注册表不同：模板可热更新（自定义模板目录 watcher），
 * 每次过滤时从 getTemplateManager().getAllTemplates() 现取，列表始终为最新全量
 * （内置 + 个人 + 项目 + 远程）。`@` = 提及一个实体，此处仅列 agent 类。
 */
import { getTemplateManager } from '@assistant-ai/core'

export interface AgentMenuEntry {
  /** 提及名（含前导 @，取 subagent_type 为匹配键） */
  name: string
  /** 能力描述（模板 description，缺省为空串） */
  desc: string
}

/** `@` 前缀过滤（菜单用）：输入 '@cod' → subagent_type 以 'cod' 开头的模板 */
export function filterAgentMenu(prefix: string): AgentMenuEntry[] {
  const p = prefix.startsWith('@') ? prefix.slice(1) : prefix
  return getTemplateManager()
    .getAllTemplates()
    .filter((t) => t.subagent_type.startsWith(p))
    .map((t) => ({ name: `@${t.subagent_type}`, desc: t.description ?? '' }))
}
