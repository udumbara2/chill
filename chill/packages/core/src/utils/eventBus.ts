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
  USER_MESSAGE_CREATED: 'user-message-created', // 合成留痕 user 消息入史（goalTick/scheduledTask/todoLanding 等；只增——正常发话的 user 行由壳侧乐观渲染不经此事件）：载荷 { module?, sessionId?, message }
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
  OPEN_AGENT_EDITOR: 'open-agent-editor', // 打开 Agent 编辑器（载荷 { slug? }——带 slug 为编辑该模板，否则新建）
  SWITCH_SETTINGS_TAB: 'switch-settings-tab', // 切换设置Tab
  // ==================== 通用审批通道事件 ====================
  APPROVAL_REQUESTED: 'approval-requested', // 审批请求（圈外写/命令确认；载荷含 kind/路径/command/diff 预览/归属）
  APPROVAL_RESOLVED: 'approval-resolved', // 壳侧审批回答（y 批准 / d 批准并加目录 / n 拒绝）
  APPROVAL_SETTLED: 'approval-settled', // 审批落定通告（M4：载荷 { toolCallId, approved, by, reason? }；远程呈现端据此将卡片置灰）
  ASK_REQUESTED: 'ask-requested', // 通用提问请求（M4e：userInputProvider 全类别请示；载荷 AskRequestPayload）
  ASK_SETTLED: 'ask-settled', // 通用提问落定通告（M4e：载荷 { id, answer, by }；各呈现面据此收摊/置灰）
  PERMISSION_MODE_CHANGED: 'permission-mode-changed', // 权限模式变更（M5：载荷 { mode, by }，by='local'|'phone'；唯一变更通告口，各端据此收敛）
  DESKTOP_CONTROL_TOGGLED: 'desktop-control-toggled', // 桌面能力开关变更（载荷 { on }；唯一变更通告口——CLI 本地 /desktop 与手机 desktop.set 经 desktopControl 共享核心收敛，relay 桥订阅即时推 cmd.state）
  AUTOSWITCH_TOGGLED: 'autoswitch-toggled', // 自迭代后自动版本切换开关变更（载荷 { on }；同上经共享核心收敛）
  TURN_STREAM_CHUNK: 'turn-stream-chunk', // M6 引擎被动流广播：载荷 { sessionId, kind: 'delta'|'reasoning'|'tool', text }；任何轮次（本机/手机发起）都广播，纯广播不落盘；kind=tool 不走本通道（既有 TOOL_CALL_STATUS_CHANGED，不双源）
  HISTORY_INVALIDATED: 'history-invalidated', // M6 非追加式历史变更（regenerate 截断重建）：载荷 { sessionId }；relay 桥据此推 history.invalidated（手机清空该会话副本重拉）
  TURN_STARTED: 'turn-started', // 轮次启动广播：载荷 { sessionId }；runTurn 入口（ensureSessionId 后、try 块内）发出——多引擎归因；与 TURN_SETTLED 严格配对（见 ChatEngine 两个 running mutation 点旁的守卫注释）。消费方：relay 桥运行态转换推送（running.changed）与双端会话列表"运行中"标志
  TURN_SETTLED: 'turn-settled', // M6c 轮次落定广播：载荷 { sessionId }；runTurn finally 发出（成功/中断/异常全覆盖）——relay 桥据此推 session.event round.settled（手机在"轮真正结束"时做一次尾部拉齐收敛；轮中的移动目标拉取会造成 DB 副本与 overlay 双份渲染，已由用户实测证实）
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
  SUBAGENT_TASK_FAILED: 'subagent-task-failed',
  TEAM_WATCHDOG_ALERT: 'team-watchdog-alert', // 团队探测器警报(watchdog 触发/升级;ChatEngine 订阅后走 drain 骨架唤醒 lead) // task 委派执行失败（载荷携带 taskOutput）
  SUBAGENT_TASK_REVIEW: 'subagent-task-review', // 评审回路单轮落地（载荷: taskId/subagentType/round/verdict/feedback）
  SUBAGENT_TOOL_CALL: 'subagent-tool-call', // Worker 工具调用观测(fork 网关旁听两发射点:入口 running/统一响应点 success/failed;执行过程面板数据源)
  // ==================== 共享看板事件 ====================
  BOARD_CHANGED: 'board-changed', // 会话看板变更（SessionBoardService 每次 mutation 落盘后发出；载荷 BoardChangedPayload）
  TEAM_BOARD_CHANGED: 'team-board-changed', // 团队板变更（TeamRuntimeService 板 mutation 后发出；载荷 TeamBoardChangedPayload——手机显示并集的触发源，与会话板事件分立）
  // ==================== 上下文管理事件 ====================
  CONTEXT_AUTO_COMPACTED: 'context-auto-compacted', // R2 自动压缩完成（载荷 { checkpoint, previousUsage?, ratio }；壳层订阅渲染"已自动压缩"提示）
  CONTEXT_OVERFLOW_RECOVERED: 'context-overflow-recovered', // R3 溢出恢复完成（载荷 { checkpoint }；壳层订阅渲染"上下文超限已自动恢复"）
  // ==================== relay 文件传输事件 ====================
  FILE_RECEIPT: 'file-receipt', // d→m 文件发送的手机回执（载荷 FileReceiptPayload；无等待器的迟到 receipt 同样发出——送达事实须让用户可见；壳订阅落会话提示，TUI 走 notice 机制不裸打印）
  // ==================== relay 投递流控事件（中继投递流控规划 M1.3）====================
  RELAY_DELIVERY_THROTTLED: 'relay:delivery-throttled', // 429 背压事实（载荷 DeliveryThrottleInfo；壳判定持续>2min 落 serve-alarm——"手机为什么显示离线"的现成答案）
} as const

/** 429 背压事实载荷（RELAY_DELIVERY_THROTTLED；RelayBridge → wiring → 壳）
 *  since=本轮流控起点（首发 429 时刻；送达成功且退避期满后复位）——壳据 sustainedMs 判定"持续"告警 */
export interface DeliveryThrottleInfo {
  at: number
  since: number
  sustainedMs: number
  envelopeType: string
  action: 'retry-wait' | 'drop-regenerable' | 'drop-exhausted'
}

/** d→m 文件发送回执载荷（FILE_RECEIPT；RelayBridge → wiring → 壳） */
export interface FileReceiptPayload {
  fileId: string
  ok: boolean
  /** 失败原因（d→m 枚举：expired/corrupt/io/aborted；或自由文本） */
  error?: string
  /** 发出时登记的元数据（桌面重启后迟到的 receipt 可能缺失——等待器随进程消失） */
  name?: string
  sessionId?: string
}

/**
 * 会话看板变更载荷（BOARD_CHANGED;SessionBoardService 每次 mutation 落盘后发出）
 */
export interface BoardChangedPayload {
  /** 会话 id（=boardId,会话级板的唯一键） */
  sessionId: string
  boardId: string
  /** 全局 CAS 计数（变更后的 revision） */
  revision: number
}

/**
 * 团队板变更载荷（TEAM_BOARD_CHANGED;TeamRuntimeService 板 mutation 后发出）。
 * sessionId 为团队归属会话（TeamRunState.sessionId，旧数据缺省=undefined → 桥侧不推、不并入手机显示）。
 */
export interface TeamBoardChangedPayload {
  runId: string
  sessionId?: string
  /** 团队板 CAS 计数（变更后的 boardRevision） */
  revision: number
}

/**
 * Worker 工具调用观测载荷(SUBAGENT_TOOL_CALL;fork 网关两个发射点:handleToolCallRequest 入口 running、
 * 统一响应点 respondToolCall 按 payload.success 发 success/failed——编排/团队门/名单拒绝与执行成败全分支覆盖)。
 * 截断纪律:argsSummary/resultSummary 发射点强制 ≤4KB/字段(BOARD_RESULT_MAX_CHARS 先例——
 * 防 MB 级巨型载荷[TUI RangeError 史],不是防可读性;展示层折叠 ~200 字符、展开可见至 4KB)。
 */
export interface SubagentToolCallPayload {
  /** 父任务 toolCall.id(resolveOrigin(envId) 反查;查不到绑定的罕见路径缺省——壳侧无归属不显示) */
  taskId?: string
  subagentType?: string
  /** Worker 侧工具调用 id(request.toolCallId;缺失时回退 IPC requestId) */
  toolCallId: string
  toolName: string
  kind: string
  /** 参数摘要(发射点截断 4KB) */
  argsSummary: string
  status: 'running' | 'success' | 'failed'
  /** 结果/失败原因摘要(截断 4KB;running 无此字段) */
  resultSummary?: string
  durationMs?: number
  at: number
}
