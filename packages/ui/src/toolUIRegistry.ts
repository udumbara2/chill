import type { Component } from 'vue'
import { markRaw } from 'vue'
import ToolCallDisplay from './components/ToolCallDisplay.vue'
import TaskListDisplay from './components/TaskListDisplay.vue'
import AgentToolDisplay from './components/AgentToolDisplay.vue'
import TaskToolDisplay from './components/TaskToolDisplay.vue'
import PowerShellCommandDisplay from './components/PowerShellCommandDisplay.vue'
import FileOperationConfirmDisplay from './components/FileOperationConfirmDisplay.vue'
import FileReaderDisplay from './components/FileReaderDisplay.vue'
import ContentInsertDisplay from './components/ContentInsertDisplay.vue'
import ContentReplaceDisplay from './components/ContentReplaceDisplay.vue'
import ContentDeleteDisplay from './components/ContentDeleteDisplay.vue'

const TOOL_COMPONENT_MAP: Record<string, Component> = {
  'create_task_list': markRaw(TaskListDisplay),
  'update_task_status': markRaw(TaskListDisplay),
  'delete_task': markRaw(TaskListDisplay),
  'add_task': markRaw(TaskListDisplay),
  'task': markRaw(TaskToolDisplay),
  'execute_powershell': markRaw(PowerShellCommandDisplay),
  'create_file': markRaw(FileOperationConfirmDisplay),
  'delete_file': markRaw(FileOperationConfirmDisplay),
  'read_file': markRaw(FileReaderDisplay),
  'insert_content': markRaw(ContentInsertDisplay),
  'replace_content': markRaw(ContentReplaceDisplay),
  'delete_content': markRaw(ContentDeleteDisplay),
}

Object.freeze(TOOL_COMPONENT_MAP)

/**
 * 判断工具是否为AGENT工具
 * @param toolName 工具名称
 * @returns 是否为AGENT工具
 */
export function isAgentTool(toolName: string): boolean {
  return toolName.startsWith('execute_local_agent_') || toolName.startsWith('execute_remote_agent_')
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
  // 其他工具使用默认映射或ToolCallDisplay
  return TOOL_COMPONENT_MAP[toolName] ?? markRaw(ToolCallDisplay)
}

export function hasCustomToolUI(toolName: string): boolean {
  return toolName in TOOL_COMPONENT_MAP || isAgentTool(toolName)
}

export function getRegisteredTools(): string[] {
  return Object.keys(TOOL_COMPONENT_MAP)
}
