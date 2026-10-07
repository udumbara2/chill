import type { Component } from 'vue'
import { markRaw } from 'vue'
import ToolLineDisplay from './components/ToolLineDisplay.vue'
import AgentToolDisplay from './components/AgentToolDisplay.vue'
import TaskToolDisplay from './components/TaskToolDisplay.vue'

// 内容族（领域卡片：子代理委派/远程 Agent 过程）保留专属组件；
// 行族与长尾工具全部收敛为 ToolLineDisplay + toolDisplay.ts 描述表（工具调用显示约定）。
// 任务清单 4 工具不在此映射——任务清单显示 = 进度药丸唯一活体 + 工具行留痕（约定 5）
const TOOL_COMPONENT_MAP: Record<string, Component> = {
  'task': markRaw(TaskToolDisplay),
}

Object.freeze(TOOL_COMPONENT_MAP)

/**
 * 判断工具是否为AGENT工具（本地工作流 Agent 已退役，仅剩远程 Agent 通道）
 * @param toolName 工具名称
 * @returns 是否为AGENT工具
 */
export function isAgentTool(toolName: string): boolean {
  return toolName.startsWith('execute_remote_agent_')
}

/**
 * 获取工具对应的UI组件
 * @param toolName 工具名称
 * @returns 对应的Vue组件
 */
export function getToolComponent(toolName: string): Component {
  // AGENT工具使用专门的AgentToolDisplay组件
  if (isAgentTool(toolName)) {
    return markRaw(AgentToolDisplay)
  }
  // 内容族映射；其余全部走统一工具行
  return TOOL_COMPONENT_MAP[toolName] ?? markRaw(ToolLineDisplay)
}
