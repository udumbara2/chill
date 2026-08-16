<template>
  <div class="task-list-display" :class="{ 'compact': compact }">
    <!-- 确认对话框 -->
    <div v-if="showConfirmDialog" class="confirm-dialog-overlay" @click="cancelClear">
      <div class="confirm-dialog" @click.stop>
        <div class="confirm-dialog-title">确认清空任务列表</div>
        <div class="confirm-dialog-content">
          当前还有 {{ incompleteCount }} 个未完成的任务，确定要清空吗？
        </div>
        <div class="confirm-dialog-actions">
          <button class="confirm-btn cancel" @click="cancelClear">取消</button>
          <button class="confirm-btn confirm" @click="confirmClear">确定</button>
        </div>
      </div>
    </div>
    
    <!-- 标题区域 -->
    <div class="task-list-header" @click="toggleExpanded">
      <div class="header-left">
        <svg class="task-list-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 11l3 3L22 4"/>
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
        </svg>
        <!-- 始终显示任务进度 -->
        <span class="task-list-title">任务进度 {{ completedCount }}/{{ normalizedTasks.length }}</span>
        <!-- 折叠状态下额外显示当前任务状态 -->
        <template v-if="!expanded && currentActiveTask">
          <div class="current-task-static">
            <div class="current-task-icon">
              <!-- pending: 空心圆 -->
              <svg v-if="currentActiveTask.status === 'pending'" class="status-icon pending" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
              </svg>
              <!-- in_progress: 固定区域显示旋转动画，消息流显示静态图标 -->
              <svg v-else-if="currentActiveTask.status === 'in_progress' && showClearButton" class="status-icon loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.3"/>
                <path d="M12 2 A10 10 0 0 1 12 22" stroke-linecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
                </path>
              </svg>
              <svg v-else-if="currentActiveTask.status === 'in_progress' && !showClearButton" class="status-icon in-progress-static" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="9"/>
                <circle cx="12" cy="12" r="4" fill="currentColor"/>
              </svg>
              <!-- completed: 勾选图标 -->
              <svg v-else-if="currentActiveTask.status === 'completed'" class="status-icon completed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="16 8 10 16 8 13" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <!-- failed: 错误图标 -->
              <svg v-else-if="currentActiveTask.status === 'failed'" class="status-icon failed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="9" y1="9" x2="15" y2="15" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <span class="current-task-name">{{ currentActiveTask.content }}</span>
          </div>
        </template>
        <!-- 所有任务完成且没有当前活动任务时显示已完成（仅在固定区域显示，消息流中不显示） -->
        <template v-else-if="showClearButton && !expanded && allTasksCompleted && normalizedTasks.length > 0">
          <span class="task-completion-text">已完成</span>
        </template>
      </div>
      <div class="header-right">
        <!-- 清空按钮 -->
        <button 
          v-if="showClearButton && normalizedTasks.length > 0"
          class="clear-btn"
          @click.stop="handleClear"
          title="清空任务列表"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <svg 
          class="expand-icon" 
          :class="{ 'expanded': expanded }"
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          stroke-width="2"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
    </div>

    <!-- 任务列表区域 -->
    <transition name="expand">
      <div v-show="expanded" class="task-list-content">
        <div 
          v-for="task in normalizedTasks" 
          :key="task.id" 
          class="task-item"
          :class="{ 'compact-item': compact }"
        >
          <div class="task-status-icon">
            <!-- pending: 空心圆 -->
            <svg v-if="task.status === 'pending'" class="status-icon pending" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
            </svg>
            <!-- in_progress: 固定区域显示旋转动画，消息流显示静态图标 -->
            <svg v-else-if="task.status === 'in_progress' && showClearButton" class="status-icon loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" stroke-opacity="0.3"/>
              <path d="M12 2 A10 10 0 0 1 12 22" stroke-linecap="round">
                <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
              </path>
            </svg>
            <svg v-else-if="task.status === 'in_progress' && !showClearButton" class="status-icon in-progress-static" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <circle cx="12" cy="12" r="9"/>
               <circle cx="12" cy="12" r="4" fill="currentColor"/>
             </svg>
            <!-- completed: 勾选图标 -->
            <svg v-else-if="task.status === 'completed'" class="status-icon completed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="16 8 10 16 8 13" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <!-- failed: 错误图标 -->
            <svg v-else-if="task.status === 'failed'" class="status-icon failed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15" stroke-linecap="round" stroke-linejoin="round"/>
              <line x1="9" y1="9" x2="15" y2="15" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="task-content" :class="{ 'compact-text': compact, 'completed-text': task.status === 'completed' }">{{ task.content }}</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import type { TaskItem } from '@assistant-ai/core'
import { useTaskListStore } from '../stores/taskListStore'

const taskListStore = useTaskListStore()

interface Props {
  tasks?: TaskItem[]
  compact?: boolean
  defaultExpanded?: boolean
  toolName?: string
  mcpServerName?: string
  status?: 'running' | 'success' | 'failed'
  parameters?: Record<string, any>
  result?: string | object
  showClearButton?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  compact: false,
  defaultExpanded: true,
  showClearButton: true
})

const normalizedTasks = computed<TaskItem[]>(() => {
  if (props.tasks && props.tasks.length > 0) {
    return props.tasks
  }
  
  if (props.parameters?.tasks && Array.isArray(props.parameters.tasks)) {
    return props.parameters.tasks.map((task: any) => ({
      id: task.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      content: task.content || task.description || '',
      status: 'pending' as const,
      createdAt: new Date(),
      updatedAt: new Date()
    }))
  }
  
  return []
})

const expanded = ref(props.defaultExpanded)

const completedCount = computed(() => {
  return normalizedTasks.value.filter(task => task.status === 'completed').length
})

const toggleExpanded = () => {
  expanded.value = !expanded.value
}

const showConfirmDialog = ref(false)

const incompleteCount = computed(() => {
  return normalizedTasks.value.filter(task => task.status !== 'completed' && task.status !== 'failed').length
})

const allTasksCompleted = computed(() => {
  return normalizedTasks.value.every(task => task.status === 'completed' || task.status === 'failed')
})

const recentlyCompletedTask = ref<TaskItem | null>(null)
let completionDisplayTimer: ReturnType<typeof setTimeout> | null = null
const COMPLETION_DISPLAY_DURATION = 800

const previousTaskStates = ref<Map<string, string>>(new Map())

watch(
  () => normalizedTasks.value,
  (newTasks) => {
    const newTaskStates = new Map<string, string>()
    
    newTasks.forEach(task => {
      newTaskStates.set(task.id, task.status)
      
      const previousStatus = previousTaskStates.value.get(task.id)
      
      if (previousStatus && 
          previousStatus !== 'completed' && 
          previousStatus !== 'failed' &&
          (task.status === 'completed' || task.status === 'failed')) {
        
        if (completionDisplayTimer) {
          clearTimeout(completionDisplayTimer)
        }
        
        recentlyCompletedTask.value = { ...task }
        
        completionDisplayTimer = setTimeout(() => {
          recentlyCompletedTask.value = null
          completionDisplayTimer = null
        }, COMPLETION_DISPLAY_DURATION)
      }
    })
    
    previousTaskStates.value = newTaskStates
  },
  { deep: true }
)

onUnmounted(() => {
  if (completionDisplayTimer) {
    clearTimeout(completionDisplayTimer)
  }
})

const currentActiveTask = computed(() => {
  if (recentlyCompletedTask.value) {
    return recentlyCompletedTask.value
  }
  
  const inProgressTask = normalizedTasks.value.find(task => task.status === 'in_progress')
  if (inProgressTask) return inProgressTask
  
  const pendingTask = normalizedTasks.value.find(task => task.status === 'pending')
  if (pendingTask) return pendingTask
  
  return null
})

const handleClear = () => {
  if (allTasksCompleted.value) {
    // 所有任务已完成，直接清理
    taskListStore.clearTasks()
  } else {
    // 有未完成任务，显示确认对话框
    showConfirmDialog.value = true
  }
}

const confirmClear = () => {
  taskListStore.clearTasks()
  showConfirmDialog.value = false
}

const cancelClear = () => {
  showConfirmDialog.value = false
}
</script>

<style scoped>
.task-list-display {
  background: rgba(30, 41, 59, 0.95);
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #e2e8f0;
}

.task-list-display.compact {
  border-radius: 6px;
}

.task-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s ease;
}

.task-list-header:hover {
  background: rgba(255, 255, 255, 0.05);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.task-list-icon {
  width: 16px;
  height: 16px;
  color: #3b82f6;
}

.task-list-title {
  font-size: 0.875rem;
  font-weight: 500;
  color: #e2e8f0;
}

/* 当前任务静态显示 */
.current-task-static {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: 0.5rem;
  flex: 1;
  overflow: hidden;
  min-width: 0;
}

.current-task-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.current-task-icon .status-icon {
  width: 14px;
  height: 14px;
}

.current-task-icon .status-icon.pending {
  color: #94a3b8;
}

.current-task-icon .status-icon.loading {
  color: #3b82f6;
}

.status-icon.in-progress-static {
  color: #3b82f6;
}

.current-task-icon .status-icon.completed {
  color: #22c55e;
}

.current-task-icon .status-icon.failed {
  color: #ef4444;
}

.current-task-name {
  font-size: 0.875rem;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.task-completion-text {
  font-size: 0.875rem;
  color: #22c55e;
  margin-left: 0.5rem;
  font-weight: 500;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.clear-btn {
  background: none;
  border: none;
  padding: 0.25rem;
  cursor: pointer;
  color: #94a3b8;
  transition: color 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.clear-btn:hover {
  color: #ef4444;
}

.clear-btn svg {
  width: 14px;
  height: 14px;
}

.expand-icon {
  width: 16px;
  height: 16px;
  color: #94a3b8;
  transition: transform 0.2s ease;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.task-list-content {
  padding: 0 1rem 1rem;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.task-item:last-child {
  border-bottom: none;
}

.task-item.compact-item {
  padding: 0.25rem 0;
  gap: 0.5rem;
}

.task-status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.status-icon {
  width: 16px;
  height: 16px;
}

.status-icon.pending {
  color: #64748b;
}

.status-icon.loading {
  color: #3b82f6;
}

.status-icon.completed {
  color: #10b981;
}

.status-icon.failed {
  color: #ef4444;
}

.task-content {
  font-size: 0.875rem;
  color: #cbd5e1;
  flex: 1;
}

.task-content.compact-text {
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-content.completed-text {
  text-decoration: line-through;
  opacity: 0.6;
}

/* 展开/折叠过渡动画 */
.expand-enter-active,
.expand-leave-active {
  transition: all 0.2s ease;
  max-height: 500px;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}

/* 确认对话框样式 */
.confirm-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.confirm-dialog {
  background: rgba(30, 41, 59, 0.98);
  border-radius: 8px;
  padding: 1.5rem;
  min-width: 300px;
  max-width: 400px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
}

.confirm-dialog-title {
  font-size: 1rem;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 0.75rem;
}

.confirm-dialog-content {
  font-size: 0.875rem;
  color: #94a3b8;
  margin-bottom: 1.25rem;
  line-height: 1.5;
}

.confirm-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.confirm-btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
}

.confirm-btn.cancel {
  background: rgba(255, 255, 255, 0.1);
  color: #e2e8f0;
}

.confirm-btn.cancel:hover {
  background: rgba(255, 255, 255, 0.15);
}

.confirm-btn.confirm {
  background: #ef4444;
  color: white;
}

.confirm-btn.confirm:hover {
  background: #dc2626;
}
</style>
