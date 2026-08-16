<template>
  <div class="file-operation-display">
    <div class="operation-header">
      <div class="header-left">
        <div class="status-icon">
          <svg v-if="status === 'pending'" class="pending-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 8v4l3 3"/>
          </svg>
          <svg v-else-if="status === 'running'" class="loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.3"/>
            <path d="M12 2 A10 10 0 0 1 12 22" stroke-linecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
            </path>
          </svg>
          <svg v-else-if="status === 'success'" class="success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg v-else-if="status === 'failed' || status === 'rejected'" class="failed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round" stroke-linejoin="round"/>
            <line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <span class="operation-icon">{{ operationIcon }}</span>
        <span 
          class="operation-path" 
          :class="{ 'clickable': canExpand }"
          @click="toggleExpand"
        >
          {{ displayPath }}
          <svg 
            v-if="canExpand" 
            class="expand-icon" 
            :class="{ 'expanded': isExpanded }"
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            stroke-width="2"
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>
      </div>

    </div>
    <div v-if="canExpand && isExpanded" class="file-list">
      <div 
        v-for="(path, index) in filePaths" 
        :key="index" 
        class="file-item"
      >
        <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="file-name">{{ getFileName(path) }}</span>
        <span class="file-path">{{ path }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface Props {
  toolName: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'rejected'
  parameters?: Record<string, any>
  toolCallId?: string
}

const props = withDefaults(defineProps<Props>(), {
  parameters: () => ({}),
  toolCallId: ''
})

const isExpanded = ref(false)

const filePath = computed(() => props.parameters?.path || '')
const filePaths = computed(() => props.parameters?.paths || [])

const canExpand = computed(() => {
  return props.toolName === 'delete_file' && filePaths.value.length > 1
})

const operationIcon = computed(() => {
  if (props.toolName === 'create_file') return '📄'
  if (props.toolName === 'delete_file') return '🗑️'
  return '📁'
})

const displayPath = computed(() => {
  if (props.toolName === 'create_file') {
    return filePath.value
  }
  if (props.toolName === 'delete_file') {
    if (filePaths.value.length === 1) {
      return filePaths.value[0]
    }
    return `${filePaths.value.length} 个文件`
  }
  return ''
})



const getFileName = (path: string): string => {
  if (!path) return ''
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

const toggleExpand = () => {
  if (canExpand.value) {
    isExpanded.value = !isExpanded.value
  }
}
</script>

<style scoped>
.file-operation-display {
  display: inline-flex;
  flex-direction: column;
  margin: 0.25rem 0;
}

.operation-header {
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

.pending-icon {
  color: #f59e0b;
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

.operation-path {
  font-size: 0.75rem;
  color: #374151;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.operation-path.clickable {
  cursor: pointer;
  border-radius: 4px;
  padding: 0.125rem 0.25rem;
  margin: -0.125rem -0.25rem;
  transition: background-color 0.2s ease;
}

.operation-path.clickable:hover {
  background: rgba(0, 0, 0, 0.05);
}

.expand-icon {
  width: 12px;
  height: 12px;
  color: #6b7280;
  transition: transform 0.2s ease;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.file-list {
  margin-top: 0.25rem;
  padding: 0.375rem 0.5rem;
  background: rgba(0, 0, 0, 0.02);
  border-radius: 4px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}

.file-item:last-child {
  border-bottom: none;
}

.file-icon {
  width: 12px;
  height: 12px;
  color: #6b7280;
  flex-shrink: 0;
}

.file-name {
  font-size: 0.6875rem;
  font-weight: 500;
  color: #374151;
}

.file-path {
  font-size: 0.625rem;
  color: #9ca3af;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
