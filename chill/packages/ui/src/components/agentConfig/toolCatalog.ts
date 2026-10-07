import { computed } from 'vue'
import { BUILTIN_TOOLS, TOOL_CATEGORY } from '@assistant-ai/core'

/** 编排工具（task 系 + search_tools）不可分配给 agent，目录层统一过滤 */
const ORCHESTRATION = new Set(['task', 'batch_task', 'resume_task', 'query_task_status', 'cancel_task', 'search_tools'])

/**
 * 工具目录（按类别分组）——AgentEditor 工具区与 ModelNode 黑名单勾选共用同一数据源。
 * 返回 computed 以保持与既有调用方的响应式习惯一致。
 */
export function useToolCatalog() {
  const toolGroups = computed(() => {
    const groups = new Map<string, string[]>()
    for (const t of BUILTIN_TOOLS) {
      if (ORCHESTRATION.has(t)) continue
      const cat = TOOL_CATEGORY[t] ?? '其他'
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(t)
    }
    return Array.from(groups.entries()).map(([category, names]) => ({ category, names }))
  })
  return { toolGroups }
}
