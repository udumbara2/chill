import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { TaskListManager, eventBus, EVENTS } from '@assistant-ai/core'
import type { PastStep, TaskListCreatedEvent, TaskStatusUpdatedEvent, TaskDeletedEvent, TaskAddedEvent, TaskItem, TaskStatus } from '@assistant-ai/core'

export type { TaskItem, TaskStatus }
export type { PastStep, TaskListCreatedEvent, TaskStatusUpdatedEvent, TaskDeletedEvent, TaskAddedEvent }

export const useTaskListStore = defineStore('taskList', () => {
  const manager = new TaskListManager()

  const tasks = ref<TaskItem[]>([])
  const pastSteps = ref<PastStep[]>([])

  manager.onChange(() => {
    tasks.value = [...manager.tasks]
    pastSteps.value = [...manager.pastSteps]
  })

  const hasTasks = computed(() => tasks.value.length > 0)

  // 3.3/发现 #12：TASK_* 按载荷 sessionId 过滤——后台引擎的任务更新不再写入前台清单。
  // 不再走 manager.setupEventListeners（无过滤直订 eventBus），改在本 store 注册过滤后转发
  // manager 公共 API（无归因载荷按现状渲染，与单引擎时代一致）。getActiveId 由调用处注入
  // （ChatArea：() => getActiveSessionId()），避免 store ↔ services 循环依赖。
  // 工作计划树迭代 0：补来源过滤——黑名单制拒 'subagent'（Worker 写入整表覆盖会污染主清单；
  // 0.2 已在定义层剥离 Worker 清单工具，本层为兜底）；'mobile'（手机发起轮次的主引擎调用）照收。
  let offs: Array<() => void> = []
  const setupEventListeners = (getActiveId?: () => string | null): void => {
    if (offs.length > 0) return
    const ok = (sid: unknown, source?: string): boolean =>
      (!getActiveId || !sid || sid === getActiveId()) && source !== 'subagent'
    const onCreated = (e: TaskListCreatedEvent): void => {
      if (ok(e.sessionId, e.source)) manager.setTasks(e.tasks)
    }
    const onStatus = (e: TaskStatusUpdatedEvent): void => {
      if (ok(e.sessionId, e.source)) manager.updateTaskStatus(e.taskId, e.status, e.content, e.result)
    }
    const onDeleted = (e: TaskDeletedEvent): void => {
      if (ok(e.sessionId, e.source)) manager.setTasks(manager.tasks.filter(t => t.id !== e.taskId))
    }
    const onAdded = (e: TaskAddedEvent): void => {
      if (ok(e.sessionId, e.source)) manager.addTask(e.task)
    }
    eventBus.on(EVENTS.TASK_LIST_CREATED, onCreated)
    eventBus.on(EVENTS.TASK_STATUS_UPDATED, onStatus)
    eventBus.on(EVENTS.TASK_DELETED, onDeleted)
    eventBus.on(EVENTS.TASK_ADDED, onAdded)
    offs = [
      () => eventBus.off(EVENTS.TASK_LIST_CREATED, onCreated),
      () => eventBus.off(EVENTS.TASK_STATUS_UPDATED, onStatus),
      () => eventBus.off(EVENTS.TASK_DELETED, onDeleted),
      () => eventBus.off(EVENTS.TASK_ADDED, onAdded),
    ]
  }
  const teardownEventListeners = (): void => {
    offs.forEach((off) => off())
    offs = []
  }

  return {
    tasks,
    pastSteps,
    hasTasks,
    addTask: (task: TaskItem) => manager.addTask(task),
    updateTaskStatus: (taskId: string, status: TaskStatus, content?: string, result?: string) =>
      manager.updateTaskStatus(taskId, status, content, result),
    addPastStep: (step: PastStep) => manager.addPastStep(step),
    clearTasks: () => manager.clearTasks(),
    setTasks: (newTasks: TaskItem[]) => manager.setTasks(newTasks),
    getTaskById: (taskId: string) => manager.getTaskById(taskId),
    getTasksByStatus: (status: TaskStatus) => manager.getTasksByStatus(status),
    setupEventListeners,
    teardownEventListeners,
    buildTaskStatusSummary: () => manager.buildTaskStatusSummary(),
    buildCompletedTasksSummary: () => manager.buildCompletedTasksSummary()
  }
})
