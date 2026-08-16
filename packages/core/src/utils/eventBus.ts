/**
 * 简单的事件总线实现，用于组件间通信
 */
class EventBus {
  private events: Map<string, Array<(...args: any[]) => void>> = new Map()

  /**
   * 监听事件
   */
  on(event: string, callback: (...args: any[]) => void): void {
    if (!this.events.has(event)) {
      this.events.set(event, [])
    }
    this.events.get(event)!.push(callback)
  }

  /**
   * 触发事件
   */
  emit(event: string, ...args: any[]): void {
    if (this.events.has(event)) {
      this.events.get(event)!.forEach(callback => {
        try {
          callback(...args)
        } catch (error) {
          console.error(`事件总线执行回调错误:`, error)
        }
      })
    }
  }

  /**
   * 移除事件监听
   */
  off(event: string, callback: (...args: any[]) => void): void {
    if (this.events.has(event)) {
      const callbacks = this.events.get(event)!
      const index = callbacks.indexOf(callback)
      if (index > -1) {
        callbacks.splice(index, 1)
      }
    }
  }

  /**
   * 清空所有事件
   */
  clear(): void {
    this.events.clear()
  }
}

// 创建全局事件总线实例
export const eventBus = new EventBus()

// 定义常用事件名称
export const EVENTS = {
  MCP_PROMPTS_CHANGED: 'mcp-prompts-changed', // MCP提示词发生变化
  MCP_CONNECTION_CHANGED: 'mcp-connection-changed', // MCP连接状态变化
  INSERT_TEXT: 'insert-text', // 插入文本到输入框
  PROMPT_SELECT_FROM_DROPDOWN: 'prompt-select-from-dropdown', // 从聊天界面prompt图标下拉列表选择prompt（单击）
  PROMPT_SEND_FROM_DROPDOWN: 'prompt-send-from-dropdown', // 从聊天界面prompt图标下拉列表直接发送prompt（双击）
  PROMPT_NEED_PARAMETERS: 'prompt-need-parameters', // 通知InputArea显示参数对话框
  TOOL_CALL_STATUS_CHANGED: 'tool-call-status-changed', // 工具调用状态变化
  TOOL_MESSAGE_CREATED: 'tool-message-created', // 工具消息创建
  ASSISTANT_MESSAGE_CREATED: 'assistant-message-created', // 助手消息创建（用于工具调用后的新响应）
  TASK_LIST_CREATED: 'task-list-created', // 任务列表创建
  GENERATION_PROGRESS: 'generation-progress', // 生成任务（视频/图片）轮询进度
  PLAN_APPROVED: 'plan-approved', // 规划被用户批准（自动退出规划模式）
  PLAN_MODE_ENTERED: 'plan-mode-entered', // 模型调用 enter_plan_mode 进入规划模式（退出只能由用户决定）
  // ==================== 目标模式事件 ====================
  GOAL_STARTED: 'goal-started', // 用户经 /goal 设定目标，进入目标模式（载荷含 objective/maxRounds）
  GOAL_ACHIEVED: 'goal-achieved', // 评估器判定目标达成，自动退出目标模式（载荷含 reason/roundCount）
  GOAL_CLEARED: 'goal-cleared', // 目标被清除（/goal clear、达成/放弃后退出、会话切换）
  GOAL_BUDGET_EXHAUSTED: 'goal-budget-exhausted', // 轮次硬顶/连续无进展熔断/目标受阻：自动暂停并请示用户（无应答通道时直接清除）
  GOAL_PAUSED: 'goal-paused', // 目标暂停（/goal pause 或熔断请示）
  GOAL_RESUMED: 'goal-resumed', // 目标恢复推进（/goal resume 或熔断请示追加预算）
  GOAL_PROPOSAL_ACCEPTED: 'goal-proposal-accepted', // 用户批准 propose_goal 提议（executor→引擎，引擎据此真正开启目标模式）
  GOAL_UPDATED: 'goal-updated', // write_goal 修订目标/判据（executor→引擎，引擎更新状态并落盘）
  TASK_STATUS_UPDATED: 'task-status-updated', // 任务状态更新
  TASK_DELETED: 'task-deleted', // 任务删除
  TASK_ADDED: 'task-added', // 任务添加
  // ==================== 迭代2：资源执行事件 ====================
  RESOURCE_EXECUTION_STARTED: 'resource-execution-started', // 资源执行开始
  RESOURCE_EXECUTION_COMPLETED: 'resource-execution-completed', // 资源执行完成
  RESOURCE_EXECUTION_FAILED: 'resource-execution-failed', // 资源执行失败
  // ==================== 设置相关事件 ====================
  OPEN_SETTINGS: 'open-settings', // 打开设置界面
  SWITCH_SETTINGS_TAB: 'switch-settings-tab', // 切换设置Tab
  // ==================== 通用审批通道事件 ====================
  APPROVAL_REQUESTED: 'approval-requested', // 审批请求（圈外写/命令确认；载荷含 kind/路径/command/diff 预览/归属）
  APPROVAL_RESOLVED: 'approval-resolved', // 壳侧审批回答（y 批准 / d 批准并加目录 / n 拒绝）
  // ==================== hooks 事件 ====================
  HOOK_MESSAGE: 'hook-message', // hook 面向用户的信息（systemMessage/警告/拦截理由；载荷 { event, messages: string[] }，core 只抛不渲染）
  // ==================== 文件操作确认事件 ====================
  FILE_OPERATION_CONFIRMED: 'file-operation-confirmed', // 用户确认执行文件操作
  FILE_OPERATION_REJECTED: 'file-operation-rejected', // 用户拒绝执行文件操作
  // ==================== 编辑器同步事件 ====================
  EDITOR_SYNC_OPEN_FILE: 'editor-sync-open-file', // 同步打开文件到编辑器
  // ==================== 差异预览事件 ====================
  DIFF_PREVIEW_CLEAR: 'diff-preview-clear', // 清除差异预览装饰
  // ==================== 待确认操作事件 ====================
  PENDING_OPERATIONS_ADD: 'pending-operations-add', // 添加待确认操作
  PENDING_OPERATIONS_CLEAR: 'pending-operations-clear', // 清除所有待确认操作
  PENDING_OPERATIONS_APPLY_ALL: 'pending-operations-apply-all', // 应用所有待确认操作
  PENDING_OPERATIONS_REJECT_ALL: 'pending-operations-reject-all', // 拒绝所有待确认操作
  // ==================== 文件切换事件 ====================
  SWITCH_TO_FILE_TAB: 'switch-to-file-tab', // 切换到指定文件的 tab
  // ==================== 快照请求事件 ====================
  REQUEST_SNAPSHOT: 'request-snapshot', // AI调用工具前请求生成快照
  // ==================== Subagent 委派事件 ====================
  SUBAGENT_TASK_STARTED: 'subagent-task-started', // task 工具委派 Subagent 开始执行
  SUBAGENT_TASK_COMPLETED: 'subagent-task-completed', // task 委派执行完成（载荷携带 taskOutput）
  SUBAGENT_TASK_FAILED: 'subagent-task-failed', // task 委派执行失败（载荷携带 taskOutput）
  // ==================== 上下文管理事件 ====================
  CONTEXT_AUTO_COMPACTED: 'context-auto-compacted', // R2 自动压缩完成（载荷 { checkpoint, previousUsage?, ratio }；壳层订阅渲染"已自动压缩"提示）
  CONTEXT_OVERFLOW_RECOVERED: 'context-overflow-recovered', // R3 溢出恢复完成（载荷 { checkpoint }；壳层订阅渲染"上下文超限已自动恢复"）
} as const
