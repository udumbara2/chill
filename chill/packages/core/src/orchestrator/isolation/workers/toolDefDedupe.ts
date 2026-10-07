/**
 * 工具定义按名去重(纯函数,可单测)
 *
 * Worker 的工具定义 = 固定注入(escalate_to_lead/team_board/team_status/send_message)
 * + 授权名单过滤结果。Lead 在 available_tools 里重复声明同名工具时,
 * 重复定义下发到模型端会触发 400 "Tool names must be unique"——统一在去重点拦截。
 */

/** 按 function.name 去重,保序留首;无名条目丢弃 */
export function dedupeToolDefsByName<T extends { function?: { name?: string } }>(defs: T[]): T[] {
  const seen = new Set<string>()
  return defs.filter((d) => {
    const n = d.function?.name ?? ''
    if (!n || seen.has(n)) return false
    seen.add(n)
    return true
  })
}
