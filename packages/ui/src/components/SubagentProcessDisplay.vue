<template>
  <div class="subagent-process-display" v-if="showDisplay">
    <div class="subagent-header">
      <div class="header-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M8 12h8" />
          <path d="M12 8v8" />
        </svg>
      </div>
      <div class="header-title">Subagent 后台任务</div>
      <div class="header-stats">
        <span class="stat-item running" v-if="runningCount > 0">{{ runningCount }} 后台进行中</span>
        <span class="stat-item completed" v-if="completedCount > 0">{{ completedCount }} 已完成</span>
        <span class="stat-item failed" v-if="failedCount > 0">{{ failedCount }} 失败</span>
      </div>
    </div>

    <div class="subagent-content">
      <!-- 任务列表 -->
      <div class="task-list">
        <div 
          v-for="task in processInfos" 
          :key="task.taskId"
          class="task-card"
          :class="{ 'expanded': expandedTasks.has(task.taskId) }"
        >
          <!-- 任务卡片头部 -->
          <div class="task-card-header" @click="toggleExpand(task.taskId)">
            <div class="task-status-indicator" :class="task.status"></div>
            <div class="task-title">
              <span class="task-type">{{ task.subagentType }}</span>
              <span class="task-id">{{ truncateTaskId(task.taskId) }}</span>
            </div>
            <div class="task-status-badge" :class="task.status">
              {{ getStatusText(task.status) }}
            </div>
            <div class="expand-icon" :class="{ 'expanded': expandedTasks.has(task.taskId) }">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>
          </div>

          <!-- 任务卡片内容（展开时显示） -->
          <div class="task-card-content" v-show="expandedTasks.has(task.taskId)">
            <!-- 任务描述 -->
            <div class="task-description" v-if="task.description">
              {{ task.description }}
            </div>

            <!-- 实时输出 -->
            <div class="output-section" v-if="task.output">
              <div class="section-title">执行输出</div>
              <div class="output-content">
                <pre>{{ task.output }}</pre>
              </div>
            </div>

            <!-- 执行结果 -->
            <div class="result-section" v-if="task.result">
              <div class="section-title">执行结果</div>
              <div class="result-content">
                <pre v-if="task.result.final_output">{{ task.result.final_output }}</pre>
                <div v-if="task.result.error_info" class="error-info">
                  <div class="error-code">错误代码: {{ task.result.error_info.code }}</div>
                  <div class="error-message">{{ task.result.error_info.message }}</div>
                </div>
              </div>
            </div>

            <!-- 资源使用 -->
            <div class="resource-section" v-if="task.result?.resource_usage">
              <div class="section-title">资源使用</div>
              <div class="resource-items">
                <div class="resource-item" v-if="task.result.resource_usage.tokens_used">
                  <span class="resource-label">Token:</span>
                  <span class="resource-value">{{ task.result.resource_usage.tokens_used }}</span>
                </div>
                <div class="resource-item" v-if="task.result.resource_usage.execution_time">
                  <span class="resource-label">时间:</span>
                  <span class="resource-value">{{ formatTime(task.result.resource_usage.execution_time) }}</span>
                </div>
                <div class="resource-item" v-if="task.result.resource_usage.iterations">
                  <span class="resource-label">迭代:</span>
                  <span class="resource-value">{{ task.result.resource_usage.iterations }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface ResourceUsage {
  tokens_used?: number
  execution_time?: number
  iterations?: number
}

interface ErrorInfo {
  code: string
  message: string
  details?: string
}

interface TaskResult {
  final_output?: string
  error_info?: ErrorInfo
  resource_usage?: ResourceUsage
}

interface ProcessInfo {
  taskId: string
  subagentType: string
  description: string
  status: 'idle' | 'running' | 'completed' | 'failed'
  output: string
  result?: TaskResult
}

interface Props {
  processInfos: ProcessInfo[]
}

const props = defineProps<Props>()

// 展开状态管理
const expandedTasks = ref<Set<string>>(new Set())

// 是否显示组件
const showDisplay = computed(() => {
  return props.processInfos.length > 0 && props.processInfos.some(t => t.status !== 'idle')
})

// 统计数量
const runningCount = computed(() => props.processInfos.filter(t => t.status === 'running').length)
const completedCount = computed(() => props.processInfos.filter(t => t.status === 'completed').length)
const failedCount = computed(() => props.processInfos.filter(t => t.status === 'failed').length)

// 获取状态文本（委派默认后台执行：进行中任务均在后台跑，不阻塞主对话）
const getStatusText = (status: string): string => {
  switch (status) {
    case 'running':
      return '后台进行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return ''
  }
}

// 截断任务ID显示
const truncateTaskId = (taskId: string): string => {
  if (taskId.length <= 12) return taskId
  return taskId.slice(0, 6) + '...' + taskId.slice(-6)
}

// 切换展开状态
const toggleExpand = (taskId: string) => {
  if (expandedTasks.value.has(taskId)) {
    expandedTasks.value.delete(taskId)
  } else {
    expandedTasks.value.add(taskId)
  }
}

// 格式化时间
const formatTime = (ms: number): string => {
  if (ms < 1000) {
    return `${ms}ms`
  }
  return `${(ms / 1000).toFixed(2)}s`
}
</script>

<style scoped>
.subagent-process-display {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: linear-gradient(180deg, #faf9f6 0%, #f5f4f0 100%);
  border-right: 1px solid var(--border-color);
  overflow: hidden;
}

.subagent-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem;
  background: rgba(139, 92, 246, 0.05);
  border-bottom: 1px solid rgba(139, 92, 246, 0.1);
  flex-shrink: 0;
}

.header-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: rgba(139, 92, 246, 0.1);
  border-radius: 8px;
  color: #8b5cf6;
  flex-shrink: 0;
}

.header-icon svg {
  width: 18px;
  height: 18px;
}

.header-title {
  flex: 1;
  font-size: 0.9375rem;
  font-weight: 600;
  color: #1f2937;
}

.header-stats {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.stat-item {
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
}

.stat-item.running {
  background: rgba(139, 92, 246, 0.1);
  color: #8b5cf6;
}

.stat-item.completed {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.stat-item.failed {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.subagent-content {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.task-card {
  background: rgba(255, 255, 255, 0.6);
  border-radius: 8px;
  border: 1px solid rgba(139, 92, 246, 0.1);
  overflow: hidden;
  transition: all 0.2s ease;
}

.task-card:hover {
  border-color: rgba(139, 92, 246, 0.2);
  box-shadow: 0 2px 4px rgba(139, 92, 246, 0.05);
}

.task-card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  cursor: pointer;
  user-select: none;
}

.task-status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.task-status-indicator.running {
  background: #8b5cf6;
  animation: pulse 2s infinite;
}

.task-status-indicator.completed {
  background: #10b981;
}

.task-status-indicator.failed {
  background: #ef4444;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.task-title {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.task-type {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #1f2937;
}

.task-id {
  font-size: 0.6875rem;
  color: #6b7280;
  font-family: 'JetBrains Mono', monospace;
}

.task-status-badge {
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  flex-shrink: 0;
}

.task-status-badge.running {
  background: rgba(139, 92, 246, 0.1);
  color: #8b5cf6;
}

.task-status-badge.completed {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.task-status-badge.failed {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.expand-icon {
  width: 16px;
  height: 16px;
  color: #6b7280;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.expand-icon svg {
  width: 100%;
  height: 100%;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.task-card-content {
  padding: 0 0.75rem 0.75rem;
  border-top: 1px solid rgba(139, 92, 246, 0.05);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.task-description {
  font-size: 0.8125rem;
  color: #4b5563;
  font-style: italic;
  padding-top: 0.5rem;
}

.output-section,
.result-section,
.resource-section {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.section-title {
  font-size: 0.6875rem;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.output-content,
.result-content {
  background: rgba(17, 24, 39, 0.95);
  border-radius: 6px;
  padding: 0.5rem;
  max-height: 150px;
  overflow-y: auto;
}

.output-content pre,
.result-content pre {
  margin: 0;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  color: #e5e7eb;
  white-space: pre-wrap;
  word-break: break-word;
}

.error-info {
  padding: 0.5rem;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 4px;
  border-left: 3px solid #ef4444;
}

.error-code {
  font-size: 0.6875rem;
  font-weight: 600;
  color: #ef4444;
  margin-bottom: 0.25rem;
}

.error-message {
  font-size: 0.75rem;
  color: #dc2626;
}

.resource-items {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.resource-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 4px;
  border: 1px solid rgba(139, 92, 246, 0.1);
  font-size: 0.6875rem;
}

.resource-label {
  color: #6b7280;
}

.resource-value {
  color: #8b5cf6;
  font-weight: 600;
}

/* 滚动条样式 */
.subagent-content::-webkit-scrollbar,
.output-content::-webkit-scrollbar,
.result-content::-webkit-scrollbar {
  width: 4px;
}

.subagent-content::-webkit-scrollbar-track,
.output-content::-webkit-scrollbar-track,
.result-content::-webkit-scrollbar-track {
  background: transparent;
}

.subagent-content::-webkit-scrollbar-thumb,
.output-content::-webkit-scrollbar-thumb,
.result-content::-webkit-scrollbar-thumb {
  background: rgba(139, 92, 246, 0.2);
  border-radius: 2px;
}

.subagent-content::-webkit-scrollbar-thumb:hover,
.output-content::-webkit-scrollbar-thumb:hover,
.result-content::-webkit-scrollbar-thumb:hover {
  background: rgba(139, 92, 246, 0.4);
}
</style>
