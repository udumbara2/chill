import type { TaskItem, TaskStatus } from '../types/models'
import type { ApprovalOrigin } from '../services/approvals'
import { eventBus, EVENTS } from '../utils/eventBus'

export interface PastStep {
  taskId: string
  stepIndex: number
  action: string
  result: string
  timestamp: Date
}

// 工作计划树迭代 0：四事件载荷补可选归因字段（source=调用来源/taskId=委派任务 id；只增，旧消费方无感）。
// 消费方过滤统一规则（黑名单制）：拒 'subagent'（Worker 写入整表覆盖会污染主清单）；
// undefined/'main'/'mobile'（手机发起轮次的主引擎调用）照收。
export interface TaskListCreatedEvent {
  tasks: TaskItem[]
  sessionId?: string
  source?: ApprovalOrigin['source']
  taskId?: string
}

export interface TaskStatusUpdatedEvent {
  taskId: string
  status: TaskStatus
  content?: string
  result?: string
  sessionId?: string
  source?: ApprovalOrigin['source']
}

export interface TaskDeletedEvent {
  taskId: string
  sessionId?: string
  source?: ApprovalOrigin['source']
}

export interface TaskAddedEvent {
  task: TaskItem
  sessionId?: string
  source?: ApprovalOrigin['source']
  taskId?: string
}

export class TaskListManager {
  tasks: TaskItem[] = []
  pastSteps: PastStep[] = []

  private _isEventListenerSetup = false
  private _onChangeCallbacks: Array<() => void> = []

  onChange(callback: () => void): void {
    this._onChangeCallbacks.push(callback)
  }

  private _notifyChange(): void {
    for (const cb of this._onChangeCallbacks) {
      cb()
    }
  }

  hasTasks(): boolean {
    return this.tasks.length > 0
  }

  getTaskById(taskId: string): TaskItem | undefined {
    return this.tasks.find(t => t.id === taskId)
  }

  getTasksByStatus(status: TaskStatus): TaskItem[] {
    return this.tasks.filter(t => t.status === status)
  }

  addTask(task: TaskItem): void {
    this.tasks.push(task)
    this._notifyChange()
  }

  updateTaskStatus(taskId: string, status: TaskStatus, content?: string, result?: string): void {
    const task = this.tasks.find(t => t.id === taskId)
    if (task) {
      task.status = status
      task.updatedAt = new Date()
      if (content !== undefined) {
        task.content = content
      }
      if (result !== undefined) {
        task.result = result
      }
      this._notifyChange()
    }
  }

  addPastStep(step: PastStep): void {
    this.pastSteps.push(step)
    this._notifyChange()
  }

  clearTasks(): void {
    this.tasks = []
    this.pastSteps = []
    this._notifyChange()
  }

  setTasks(newTasks: TaskItem[]): void {
    this.tasks = newTasks
    this._notifyChange()
  }

  buildTaskStatusSummary(): string {
    const tasks = this.tasks
    if (tasks.length === 0) {
      return ''
    }

    const pending = tasks.filter(t => t.status === 'pending')
    const inProgress = tasks.filter(t => t.status === 'in_progress')
    const completed = tasks.filter(t => t.status === 'completed')
    const failed = tasks.filter(t => t.status === 'failed')

    const lines: string[] = ['## 当前任务状态']
    lines.push(`- 总任务数: ${tasks.length}`)
    lines.push(`- 待处理: ${pending.length}`)
    lines.push(`- 进行中: ${inProgress.length}`)
    lines.push(`- 已完成: ${completed.length}`)
    lines.push(`- 失败: ${failed.length}`)

    if (inProgress.length > 0) {
      lines.push('\n### 正在执行的任务')
      inProgress.forEach((task, index) => {
        lines.push(`${index + 1}. [${task.id}] ${task.content}`)
      })
    }

    if (pending.length > 0) {
      lines.push('\n### 待执行的任务')
      pending.forEach((task, index) => {
        lines.push(`${index + 1}. [${task.id}] ${task.content}`)
      })
    }

    return lines.join('\n')
  }

  buildCompletedTasksSummary(): string {
    const tasks = this.tasks
    const completedTasks = tasks.filter(t => t.status === 'completed' && t.result)
    const failedTasks = tasks.filter(t => t.status === 'failed')

    if (completedTasks.length === 0 && failedTasks.length === 0) {
      return ''
    }

    const lines: string[] = ['## 已完成任务结果']

    if (completedTasks.length > 0) {
      lines.push('\n### 成功完成的任务')
      completedTasks.forEach((task, index) => {
        lines.push(`${index + 1}. [${task.id}] ${task.content}`)
        if (task.result) {
          lines.push(`   结果: ${task.result}`)
        }
      })
    }

    if (failedTasks.length > 0) {
      lines.push('\n### 失败的任务')
      failedTasks.forEach((task, index) => {
        lines.push(`${index + 1}. [${task.id}] ${task.content}`)
        if (task.result) {
          lines.push(`   错误: ${task.result}`)
        }
      })
    }

    return lines.join('\n')
  }

  private _handleTaskListCreated = (event: TaskListCreatedEvent): void => {
    this.tasks = event.tasks
    this._notifyChange()
  }

  private _handleTaskStatusUpdated = (event: TaskStatusUpdatedEvent): void => {
    this.updateTaskStatus(event.taskId, event.status, event.content, event.result)
  }

  private _handleTaskDeleted = (event: TaskDeletedEvent): void => {
    this.tasks = this.tasks.filter(t => t.id !== event.taskId)
    this._notifyChange()
  }

  private _handleTaskAdded = (event: TaskAddedEvent): void => {
    this.tasks.push(event.task)
    this._notifyChange()
  }

  setupEventListeners(): void {
    if (this._isEventListenerSetup) return
    eventBus.on(EVENTS.TASK_LIST_CREATED, this._handleTaskListCreated)
    eventBus.on(EVENTS.TASK_STATUS_UPDATED, this._handleTaskStatusUpdated)
    eventBus.on(EVENTS.TASK_DELETED, this._handleTaskDeleted)
    eventBus.on(EVENTS.TASK_ADDED, this._handleTaskAdded)
    this._isEventListenerSetup = true
  }

  teardownEventListeners(): void {
    eventBus.off(EVENTS.TASK_LIST_CREATED, this._handleTaskListCreated)
    eventBus.off(EVENTS.TASK_STATUS_UPDATED, this._handleTaskStatusUpdated)
    eventBus.off(EVENTS.TASK_DELETED, this._handleTaskDeleted)
    eventBus.off(EVENTS.TASK_ADDED, this._handleTaskAdded)
    this._isEventListenerSetup = false
  }
}
