import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { TaskListManager } from '@assistant-ai/core'
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
    setupEventListeners: () => manager.setupEventListeners(),
    teardownEventListeners: () => manager.teardownEventListeners(),
    buildTaskStatusSummary: () => manager.buildTaskStatusSummary(),
    buildCompletedTasksSummary: () => manager.buildCompletedTasksSummary()
  }
})
