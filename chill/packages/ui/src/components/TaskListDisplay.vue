<template>
  <div class="task-pill-display">
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

    <!-- 进度药丸（唯一活体：直读 taskListStore，点击就地展开） -->
    <div class="task-pill" @click="toggleExpanded">
      <svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 11l3 3L22 4"/>
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
      </svg>
      <span class="pill-title">任务 {{ completedCount }}/{{ tasks.length }}</span>
      <span v-if="allTasksCompleted" class="task-completion-text">已完成</span>
      <button
        v-if="tasks.length > 0"
        class="clear-btn"
        @click.stop="handleClear"
        title="清空任务列表"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <svg class="expand-icon" :class="{ 'expanded': expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>

    <!-- 展开的完整清单 -->
    <transition name="expand">
      <div v-show="expanded" class="task-list-content">
        <div v-for="task in tasks" :key="task.id" class="task-item">
          <div class="task-status-icon">
            <svg v-if="task.status === 'pending'" class="status-icon pending" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
            </svg>
            <svg v-else-if="task.status === 'in_progress'" class="status-icon loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" stroke-opacity="0.3"/>
              <path d="M12 2 A10 10 0 0 1 12 22" stroke-linecap="round">
                <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
              </path>
            </svg>
            <svg v-else-if="task.status === 'completed'" class="status-icon completed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="16 8 10 16 8 13" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <svg v-else-if="task.status === 'failed'" class="status-icon failed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15" stroke-linecap="round" stroke-linejoin="round"/>
              <line x1="9" y1="9" x2="15" y2="15" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="task-content" :class="{ 'completed-text': task.status === 'completed' }">{{ task.content }}</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { TaskItem } from '@assistant-ai/core'
import { useTaskListStore } from '../stores/taskListStore'

/**
 * 任务进度药丸（任务清单显示约定的唯一活体）。
 * 零 props：直读 taskListStore（TaskListManager onChange 响应式活体），严禁快照。
 * 折叠态只显示 N/M（不显示当前任务名——长文案会把药丸拉宽拉偏）；
 * 聊天流留痕由 ToolLineDisplay（4 个任务工具）+ todoLanding 合成行承担。
 */
const taskListStore = useTaskListStore()
const tasks = computed<TaskItem[]>(() => taskListStore.tasks)

const expanded = ref(false)
const toggleExpanded = () => {
  expanded.value = !expanded.value
}

const completedCount = computed(() => tasks.value.filter(task => task.status === 'completed').length)

const showConfirmDialog = ref(false)

const incompleteCount = computed(() => tasks.value.filter(task => task.status !== 'completed' && task.status !== 'failed').length)

const allTasksCompleted = computed(() => tasks.value.length > 0 && tasks.value.every(task => task.status === 'completed' || task.status === 'failed'))

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
.task-pill-display {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

/* 进度药丸：浅色、左对齐、自适应宽度（颜色只给状态图标，与工具行同一语言） */
.task-pill {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  background: rgba(59, 130, 246, 0.05);
  border: 1px solid rgba(59, 130, 246, 0.12);
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
  max-width: 100%;
  min-width: 0;
  transition: background-color 0.2s ease;
}

.task-pill:hover {
  background: rgba(59, 130, 246, 0.09);
}

.pill-icon {
  width: 14px;
  height: 14px;
  color: #3b82f6;
  flex-shrink: 0;
}

.pill-title {
  font-size: 0.8125rem;
  color: #4b5563;
  font-weight: 500;
  flex-shrink: 0;
}

.task-completion-text {
  font-size: 0.8125rem;
  color: #10b981;
  flex-shrink: 0;
}

.status-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.status-icon.loading {
  color: #3b82f6;
}

.status-icon.pending {
  color: #9ca3af;
}

.status-icon.completed {
  color: #10b981;
}

.status-icon.failed {
  color: #ef4444;
}

.clear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  border-radius: 50%;
  flex-shrink: 0;
  padding: 0;
  transition: color 0.2s ease, background-color 0.2s ease;
}

.clear-btn:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

.clear-btn svg {
  width: 12px;
  height: 12px;
}

.expand-icon {
  width: 14px;
  height: 14px;
  color: #9ca3af;
  flex-shrink: 0;
  transition: transform 0.2s ease;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

/* 展开的完整清单：浅色安静面板 */
.task-list-content {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  margin-top: 0.375rem;
  padding: 0.375rem 0.625rem;
  background: rgba(0, 0, 0, 0.02);
  border-radius: 8px;
  max-width: 100%;
  max-height: 240px;
  overflow-y: auto;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.125rem 0;
  min-width: 0;
}

.task-status-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.task-content {
  font-size: 0.8125rem;
  color: #4b5563;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.task-content.completed-text {
  color: #9ca3af;
  text-decoration: line-through;
}

/* 确认对话框（浅色化，结构与交互不变） */
.confirm-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.confirm-dialog {
  background: #ffffff;
  border-radius: 8px;
  padding: 1.25rem;
  min-width: 320px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}

.confirm-dialog-title {
  font-size: 0.9375rem;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 0.5rem;
}

.confirm-dialog-content {
  font-size: 0.875rem;
  color: #6b7280;
  margin-bottom: 1rem;
}

.confirm-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.confirm-btn {
  padding: 0.375rem 0.875rem;
  border-radius: 6px;
  font-size: 0.875rem;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.2s ease;
}

.confirm-btn.cancel {
  background: #f3f4f6;
  color: #4b5563;
  border-color: #e5e7eb;
}

.confirm-btn.cancel:hover {
  background: #e5e7eb;
}

.confirm-btn.confirm {
  background: #ef4444;
  color: #ffffff;
}

.confirm-btn.confirm:hover {
  background: #dc2626;
}

.expand-enter-active,
.expand-leave-active {
  transition: max-height 0.2s ease-in-out, opacity 0.2s ease-in-out;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}

.expand-enter-to,
.expand-leave-from {
  max-height: 300px;
  opacity: 1;
}
</style>
