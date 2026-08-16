<template>
  <div class="tool-call-display">
    <div class="tool-call-header" @click="toggleExpanded">
      <div class="status-icon">
        <svg v-if="status === 'running'" class="loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.3" />
          <path d="M12 2 A10 10 0 0 1 12 22" stroke-linecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
          </path>
        </svg>
        <svg v-else-if="status === 'success'" class="success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="status === 'failed'" class="failed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round" stroke-linejoin="round" />
          <line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="tool-name">{{ toolName }}<span v-if="mcpServerName">/{{ mcpServerName }}</span></div>
    </div>
    <transition name="expand">
      <div v-show="expanded" class="tool-call-details">
        <div v-if="parameters && Object.keys(parameters).length > 0" class="parameters-section">
          <div v-for="(value, key) in parameters" :key="key" class="parameter-item">
            <div class="parameter-key">{{ key }}</div>
            <div class="parameter-value">{{ formatValue(value) }}</div>
          </div>
        </div>
        <div v-if="hasResult" class="divider"></div>
        <div v-if="hasResult" class="result-section">
          <div class="result-label">执行结果</div>
          <div class="result-value">{{ formatResult(result) }}</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface Props {
  toolName: string
  mcpServerName?: string
  status: 'running' | 'success' | 'failed'
  parameters?: Record<string, any>
  result?: string | object
}

const props = withDefaults(defineProps<Props>(), {
  mcpServerName: '',
  parameters: () => ({}),
  result: ''
})

const expanded = ref(false)

const toggleExpanded = () => {
  expanded.value = !expanded.value
}

const formatValue = (value: any): string => {
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

const hasResult = computed(() => {
  return props.result !== undefined && props.result !== null && props.result !== ''
})

const formatResult = (result: string | object | undefined): string => {
  if (result === undefined || result === null) {
    return ''
  }
  if (typeof result === 'object') {
    return JSON.stringify(result, null, 2)
  }
  return String(result)
}
</script>

<style scoped>
.tool-call-display {
  margin: 0.5rem 0;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(59, 130, 246, 0.03);
  border: 1px solid rgba(59, 130, 246, 0.1);
  max-width: fit-content;
}

.tool-call-header {
  display: flex;
  align-items: center;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  user-select: none;
  gap: 0.5rem;
  transition: background-color 0.2s ease;
}

.tool-call-header:hover {
  background: rgba(59, 130, 246, 0.05);
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  color: #3b82f6;
}

.success-icon {
  width: 16px;
  height: 16px;
  color: #10b981;
}

.failed-icon {
  width: 16px;
  height: 16px;
  color: #ef4444;
}

.tool-name {
  font-size: 0.875rem;
  color: #6b7280;
  font-weight: 500;
}

.tool-name span {
  color: #9ca3af;
}

.tool-call-details {
  padding: 0.5rem 0.75rem;
  padding-top: 0;
}

.parameters-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.parameter-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.parameter-key {
  font-size: 0.75rem;
  color: #9ca3af;
  font-weight: 500;
}

.parameter-value {
  font-size: 0.8125rem;
  color: #6b7280;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  background: rgba(0, 0, 0, 0.02);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
}

.divider {
  height: 1px;
  background: rgba(59, 130, 246, 0.1);
  margin: 0.5rem 0;
}

.result-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.result-label {
  font-size: 0.75rem;
  color: #9ca3af;
  font-weight: 500;
}

.result-value {
  font-size: 0.8125rem;
  color: #6b7280;
  white-space: pre-wrap;
  word-break: break-word;
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
  max-height: 500px;
  opacity: 1;
}
</style>
