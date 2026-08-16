<template>
  <div class="task-tool-display">
    <div class="task-tool-header" @click="toggleExpanded">
      <div class="status-icon">
        <!-- 运行中状态 - 显示旋转动画 -->
        <svg v-if="status === 'running'" class="loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.3" />
          <path d="M12 2 A10 10 0 0 1 12 22" stroke-linecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
          </path>
        </svg>
        <!-- 成功状态 -->
        <svg v-else-if="status === 'success'" class="success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <!-- 失败状态 -->
        <svg v-else-if="status === 'failed'" class="failed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round" stroke-linejoin="round" />
          <line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="task-info">
        <div class="task-name">{{ displayName }}</div>
      </div>
      <div class="expand-icon" :class="{ 'expanded': expanded }">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
    </div>

    <!-- 展开详情 -->
    <transition name="expand">
      <div v-show="expanded" class="task-tool-details">
        <!-- 子任务类型 - 只在有有效类型时显示 -->
        <div v-if="subagentType && subagentType !== '未知类型'" class="detail-section">
          <div class="detail-label">子任务类型</div>
          <div class="detail-value">{{ subagentType }}</div>
        </div>

        <!-- 任务描述 -->
        <div v-if="taskDescription" class="detail-section">
          <div class="detail-label">任务描述</div>
          <div class="detail-value description">{{ taskDescription }}</div>
        </div>

        <!-- 成功标准 -->
        <div v-if="successCriteria" class="detail-section">
          <div class="detail-label">成功标准</div>
          <div class="detail-value success-criteria">{{ successCriteria }}</div>
        </div>

        <!-- 可用工具 -->
        <div v-if="availableTools && availableTools.length > 0" class="detail-section">
          <div class="detail-label">可用工具</div>
          <div class="detail-value tools-list">
            <span v-for="(tool, index) in availableTools" :key="index" class="tool-tag">
              {{ tool }}
            </span>
          </div>
        </div>

        <!-- 覆盖参数 -->
        <div v-if="hasOverrideParameters" class="detail-section">
          <div class="detail-label">覆盖参数</div>
          <div class="detail-value override-params">
            <div v-if="overrideParameters.model" class="override-item">
              <span class="override-key">模型:</span>
              <span class="override-value">{{ overrideParameters.model }}</span>
            </div>
            <div v-if="overrideParameters.max_iterations !== undefined" class="override-item">
              <span class="override-key">最大迭代:</span>
              <span class="override-value">{{ overrideParameters.max_iterations }}</span>
            </div>
            <div v-if="overrideParameters.token_budget !== undefined" class="override-item">
              <span class="override-key">Token预算:</span>
              <span class="override-value">{{ overrideParameters.token_budget }}</span>
            </div>
            <div v-if="overrideParameters.timeout !== undefined" class="override-item">
              <span class="override-key">超时:</span>
              <span class="override-value">{{ overrideParameters.timeout }}秒</span>
            </div>
            <div v-if="overrideParameters.temperature !== undefined" class="override-item">
              <span class="override-key">温度:</span>
              <span class="override-value">{{ overrideParameters.temperature }}</span>
            </div>
          </div>
        </div>

        <!-- 执行结果 -->
        <div v-if="result" class="detail-section">
          <div class="detail-label">执行结果</div>
          <div class="detail-value result">{{ formatResult(result) }}</div>
        </div>

        <!-- 错误信息 -->
        <div v-if="errorInfo" class="detail-section error">
          <div class="detail-label">错误信息</div>
          <div class="detail-value error-message">{{ errorInfo.message }}</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

interface Props {
  toolName: string
  status: 'running' | 'success' | 'failed'
  parameters?: Record<string, any>
  result?: any
}

const props = withDefaults(defineProps<Props>(), {
  parameters: () => ({}),
  result: undefined
})

// 计算是否有详细信息可显示
const hasDetailedInfo = computed(() => {
  const type = props.parameters?.subagent_type
  const hasType = type && type !== 'unknown'
  const hasDescription = props.parameters?.task_description
  const hasCriteria = props.parameters?.success_criteria
  const hasTools = props.parameters?.available_tools?.length > 0
  const hasOverride = props.parameters?.override_parameters && 
    Object.keys(props.parameters.override_parameters).length > 0
  return hasType || hasDescription || hasCriteria || hasTools || hasOverride
})

// 初始折叠，等有详细信息后自动展开
const expanded = ref(false)

// 监听参数变化，当有详细信息时自动展开
watch(() => props.parameters, (newParams, oldParams) => {
  const newHasInfo = hasDetailedInfo.value
  const oldHasInfo = oldParams?.subagent_type && oldParams.subagent_type !== 'unknown'
  // 当从没有信息变为有信息时，自动展开
  if (newHasInfo && !oldHasInfo) {
    expanded.value = true
  }
}, { deep: true })

// 监听状态变化，任务完成后自动折叠
watch(() => props.status, (newStatus, oldStatus) => {
  // 当从 running 变为 success 或 failed 时，自动折叠
  if (oldStatus === 'running' && (newStatus === 'success' || newStatus === 'failed')) {
    expanded.value = false
  }
})

// 计算显示名称
const displayName = computed(() => {
  const type = props.parameters?.subagent_type
  // 只在有有效类型且不是unknown时显示类型
  if (type && type !== 'unknown') {
    return `执行子任务 (${type})`
  }
  return '执行子任务'
})

// 从参数中获取子任务类型
const subagentType = computed(() => {
  const type = props.parameters?.subagent_type
  // 返回空字符串而不是'未知类型'，这样v-if不会显示
  return type && type !== 'unknown' ? type : ''
})

// 从参数中获取任务描述
const taskDescription = computed(() => {
  return props.parameters?.task_description || ''
})

// 从参数中获取成功标准
const successCriteria = computed(() => {
  return props.parameters?.success_criteria
})

// 从参数中获取可用工具列表
const availableTools = computed(() => {
  return props.parameters?.available_tools
})

// 从参数中获取覆盖参数
const overrideParameters = computed(() => {
  return props.parameters?.override_parameters || {}
})

// 是否有覆盖参数
const hasOverrideParameters = computed(() => {
  const params = overrideParameters.value
  return params.model !== undefined ||
    params.max_iterations !== undefined ||
    params.token_budget !== undefined ||
    params.timeout !== undefined ||
    params.temperature !== undefined
})

// 错误信息
const errorInfo = computed(() => {
  if (props.result?.error_info) {
    return props.result.error_info
  }
  return null
})

const toggleExpanded = () => {
  expanded.value = !expanded.value
}

const formatResult = (result: any): string => {
  if (typeof result === 'object') {
    if (result.final_output) {
      return result.final_output
    }
    return JSON.stringify(result, null, 2)
  }
  return String(result)
}
</script>

<style scoped>
.task-tool-display {
  margin: 0.5rem 0;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(139, 92, 246, 0.05);
  border: 1px solid rgba(139, 92, 246, 0.15);
  max-width: fit-content;
  min-width: 280px;
}

.task-tool-header {
  display: flex;
  align-items: center;
  padding: 0.75rem 1rem;
  cursor: pointer;
  user-select: none;
  gap: 0.75rem;
  transition: background-color 0.2s ease;
}

.task-tool-header:hover {
  background: rgba(139, 92, 246, 0.08);
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.loading-spinner {
  width: 100%;
  height: 100%;
  color: #8b5cf6;
}

.success-icon {
  width: 100%;
  height: 100%;
  color: #10b981;
}

.failed-icon {
  width: 100%;
  height: 100%;
  color: #ef4444;
}

.task-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.task-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: #1f2937;
}

.task-status-text {
  font-size: 0.75rem;
  color: #6b7280;
}

.expand-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: #9ca3af;
  transition: transform 0.2s ease;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.expand-icon svg {
  width: 100%;
  height: 100%;
}

.task-tool-details {
  padding: 0.75rem 1rem;
  border-top: 1px solid rgba(139, 92, 246, 0.1);
  background: rgba(139, 92, 246, 0.02);
}

.detail-section {
  margin-bottom: 0.75rem;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-section.error {
  background: rgba(239, 68, 68, 0.05);
  padding: 0.5rem;
  border-radius: 4px;
  border-left: 3px solid #ef4444;
}

.detail-label {
  font-size: 0.75rem;
  color: #9ca3af;
  margin-bottom: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.detail-value {
  font-size: 0.8125rem;
  color: #374151;
  word-break: break-word;
}

.detail-value.description {
  color: #4b5563;
  font-style: italic;
}

.detail-value.result {
  background: rgba(255, 255, 255, 0.5);
  padding: 0.5rem;
  border-radius: 4px;
  border: 1px solid rgba(139, 92, 246, 0.1);
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

.detail-value.error-message {
  color: #ef4444;
  font-size: 0.75rem;
}

/* 成功标准样式 */
.detail-value.success-criteria {
  color: #059669;
  font-style: italic;
  padding: 0.375rem;
  background: rgba(16, 185, 129, 0.05);
  border-radius: 4px;
  border-left: 3px solid #10b981;
}

/* 工具列表样式 */
.tools-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.tool-tag {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  background: rgba(139, 92, 246, 0.1);
  color: #7c3aed;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
}

/* 覆盖参数样式 */
.override-params {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.override-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
}

.override-key {
  color: #6b7280;
  min-width: 70px;
}

.override-value {
  color: #374151;
  font-weight: 500;
}

/* 展开动画 */
.expand-enter-active,
.expand-leave-active {
  transition: all 0.2s ease;
  max-height: 500px;
  opacity: 1;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}
</style>
