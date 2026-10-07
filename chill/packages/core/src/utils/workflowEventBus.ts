/**
 * 工作流专用事件总线，与全局 eventBus 完全隔离
 * 使用 workflow:* 前缀的事件名，避免与 Chat 模块事件冲突
 */
class WorkflowEventBus {
  private events: Map<string, Array<(...args: any[]) => void>> = new Map()
  private forwardTarget: NamespacedWorkflowEventBus | null = null

  on(event: string, callback: (...args: any[]) => void): void {
    if (!this.events.has(event)) {
      this.events.set(event, [])
    }
    this.events.get(event)!.push(callback)
  }

  emit(event: string, ...args: any[]): void {
    // 先触发本地监听
    if (this.events.has(event)) {
      this.events.get(event)!.forEach((callback) => {
        try {
          callback(...args)
        } catch (error) {
          console.error(`工作流事件总线执行回调错误:`, error)
        }
      })
    }
    // 如果设置了转发目标，同时转发
    if (this.forwardTarget) {
      this.forwardTarget.emit(event, ...args)
    }
  }

  off(event: string, callback: (...args: any[]) => void): void {
    if (this.events.has(event)) {
      const callbacks = this.events.get(event)!
      const index = callbacks.indexOf(callback)
      if (index > -1) {
        callbacks.splice(index, 1)
      }
    }
  }

  clear(): void {
    this.events.clear()
  }

  /**
   * 设置事件转发目标
   * @param target - 命名空间事件总线
   * @returns 取消转发的函数
   */
  forwardTo(target: NamespacedWorkflowEventBus): () => void {
    this.forwardTarget = target
    return () => {
      this.forwardTarget = null
    }
  }
}

export const workflowEventBus = new WorkflowEventBus()

/**
 * 基于workflowId的命名空间事件总线
 * 每个工作流实例拥有独立的事件命名空间，实现工作流间的事件隔离
 */
export class NamespacedWorkflowEventBus {
  private workflowId: string
  private eventBus: WorkflowEventBus

  constructor(workflowId: string) {
    this.workflowId = workflowId
    this.eventBus = new WorkflowEventBus()
  }

  /**
   * 获取命名空间前缀
   */
  private getNamespacedEvent(event: string): string {
    return `${this.workflowId}:${event}`
  }

  /**
   * 监听事件
   */
  on(event: string, callback: (...args: any[]) => void): void {
    const namespacedEvent = this.getNamespacedEvent(event)
    this.eventBus.on(namespacedEvent, callback)
  }

  /**
   * 触发事件
   */
  emit(event: string, ...args: any[]): void {
    const namespacedEvent = this.getNamespacedEvent(event)
    this.eventBus.emit(namespacedEvent, ...args)
  }

  /**
   * 取消监听事件
   */
  off(event: string, callback: (...args: any[]) => void): void {
    const namespacedEvent = this.getNamespacedEvent(event)
    this.eventBus.off(namespacedEvent, callback)
  }

  /**
   * 获取workflowId
   */
  getWorkflowId(): string {
    return this.workflowId
  }

  /**
   * 清理所有事件监听
   */
  clear(): void {
    this.eventBus.clear()
  }
}

export const WORKFLOW_EVENTS = {
  STREAM_START: 'workflow:stream:start',
  STREAM_CHUNK: 'workflow:stream:chunk',
  STREAM_COMPLETE: 'workflow:stream:complete',
  STREAM_ERROR: 'workflow:stream:error',
  TOOL_CALL_STARTED: 'workflow:tool:call:started',
  TOOL_CALL_COMPLETED: 'workflow:tool:call:completed',
  TOOL_CALL_FAILED: 'workflow:tool:call:failed',
  NODE_STARTED: 'workflow:node:started',
  NODE_COMPLETED: 'workflow:node:completed',
  INTERRUPT: 'workflow:interrupt',
  EDGE_EDIT: 'workflow:edge:edit',
  EDGE_DELETE: 'workflow:edge:delete',
  EDGE_CONTEXT_MENU: 'workflow:edge:contextmenu',
  BRANCH_HOVER: 'workflow:branch:hover',
  BRANCH_LEAVE: 'workflow:branch:leave',
  LOOP_STARTED: 'workflow:loop:started',
  LOOP_COMPLETED: 'workflow:loop:completed',
  LOOP_ITERATION_UPDATED: 'workflow:loop:iteration:updated',
  NODE_CREATE: 'workflow:node:create',
} as const
