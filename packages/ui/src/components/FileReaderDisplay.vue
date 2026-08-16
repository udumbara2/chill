<template>
  <div class="file-reader-display">
    <div class="reader-header">
      <div class="header-left">
        <div class="status-icon">
          <svg v-if="status === 'running'" class="loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.3"/>
            <path d="M12 2 A10 10 0 0 1 12 22" stroke-linecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
            </path>
          </svg>
          <svg v-else-if="status === 'success'" class="success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg v-else-if="status === 'failed'" class="failed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round" stroke-linejoin="round"/>
            <line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <span class="operation-icon">📖</span>
        <span class="file-path">{{ displayPath }}</span>
        <span v-if="lineRange" class="line-range">{{ lineRange }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  toolName: string
  status: 'running' | 'success' | 'failed'
  parameters?: Record<string, any>
  result?: {
    content?: string
    totalLines?: number
    startLine?: number
    endLine?: number
  }
}

const props = withDefaults(defineProps<Props>(), {
  parameters: () => ({}),
  result: undefined
})

const filePath = computed(() => props.parameters?.path || '')

const lineRange = computed(() => {
  const startLine = props.result?.startLine
  const endLine = props.result?.endLine
  const totalLines = props.result?.totalLines
  
  if (startLine !== undefined && endLine !== undefined) {
    if (totalLines !== undefined && (endLine - startLine + 1) < totalLines) {
      return `第 ${startLine}-${endLine} 行`
    }
  }
  return ''
})

const displayPath = computed(() => {
  return filePath.value
})


</script>

<style scoped>
.file-reader-display {
  display: inline-flex;
  flex-direction: column;
  margin: 0.25rem 0;
}

.reader-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  user-select: none;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.status-icon svg {
  width: 100%;
  height: 100%;
}

.loading-spinner {
  color: #3b82f6;
}

.success-icon {
  color: #10b981;
}

.failed-icon {
  color: #ef4444;
}

.operation-icon {
  font-size: 0.75rem;
}

.file-path {
  font-size: 0.75rem;
  color: #374151;
}

.line-range {
  font-size: 0.6875rem;
  color: #6b7280;
  background: rgba(0, 0, 0, 0.05);
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
}


</style>
