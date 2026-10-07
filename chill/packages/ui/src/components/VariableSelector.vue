<template>
  <div class="variable-selector">
    <button 
      class="variable-button"
      @click="toggleDropdown"
      :disabled="availableVariables.length === 0"
      :title="availableVariables.length === 0 ? '没有可用变量' : '插入变量'"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
      </svg>
    </button>
    
    <div v-if="isOpen" class="variable-dropdown">
      <div class="dropdown-header">
        <span>可用变量</span>
        <button class="close-button" @click="closeDropdown">×</button>
      </div>
      
      <div class="dropdown-content" @wheel.stop>
        <template v-if="groupedVariables.upstream.length > 0">
          <div class="variable-group-title">上游消息</div>
          <div 
            v-for="(variable, index) in groupedVariables.upstream" 
            :key="'upstream-' + index"
            class="variable-item"
            :class="{ 'recommended': variable.recommended }"
            @click="selectVariable(variable)"
          >
            <div class="variable-header">
              <span v-if="variable.recommended" class="recommended-badge">⭐</span>
              <div class="variable-path">{{ variable.path }}</div>
              <span v-if="variable.type" class="variable-type">{{ variable.type }}</span>
            </div>
            <div class="variable-description">{{ variable.description }}</div>
            <div v-if="variable.note" class="variable-note">{{ variable.note }}</div>
          </div>
        </template>
        
        <template v-if="groupedVariables.tool.length > 0">
          <div class="variable-group-title">前序工具输出</div>
          <div 
            v-for="(variable, index) in groupedVariables.tool" 
            :key="'tool-' + index"
            class="variable-item"
            :class="{ 'recommended': variable.recommended }"
            @click="selectVariable(variable)"
          >
            <div class="variable-header">
              <span v-if="variable.recommended" class="recommended-badge">⭐</span>
              <div class="variable-path">{{ variable.path }}</div>
              <span v-if="variable.type" class="variable-type">{{ variable.type }}</span>
            </div>
            <div class="variable-description">{{ variable.description }}</div>
            <div v-if="variable.note" class="variable-note">{{ variable.note }}</div>
          </div>
        </template>
        
        <div v-if="availableVariables.length === 0" class="empty-message">
          当前工具之前没有其他工具
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

export interface Variable {
  path: string
  description: string
  recommended?: boolean
  type?: string
  note?: string
  group?: 'upstream' | 'tool'
}

interface Props {
  availableVariables: Variable[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'insert': [variable: Variable]
}>()

const isOpen = ref(false)

const groupedVariables = computed(() => {
  const upstream = props.availableVariables.filter(v => v.group === 'upstream')
  const tool = props.availableVariables.filter(v => v.group === 'tool')
  return { upstream, tool }
})

const toggleDropdown = () => {
  isOpen.value = !isOpen.value
}

const closeDropdown = () => {
  isOpen.value = false
}

const selectVariable = (variable: Variable) => {
  emit('insert', variable)
  closeDropdown()
}

const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as HTMLElement
  if (!target.closest('.variable-selector')) {
    closeDropdown()
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.variable-selector {
  position: relative;
  display: inline-block;
}

.variable-button {
  padding: 4px 8px;
  background: transparent;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #606266;
  transition: all 0.2s;
}

.variable-button:hover:not(:disabled) {
  border-color: #409eff;
  color: #409eff;
}

.variable-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.variable-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background: white;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  z-index: 1000;
  min-width: 300px;
  max-width: 400px;
}

.dropdown-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid #ebeef5;
  font-weight: 500;
  font-size: 13px;
  color: #303133;
}

.close-button {
  background: transparent;
  border: none;
  font-size: 18px;
  color: #909399;
  cursor: pointer;
  padding: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

.close-button:hover {
  background: #f5f7fa;
  color: #606266;
}

.dropdown-content {
  max-height: 300px;
  overflow-y: auto;
  overflow-x: hidden;
}

.dropdown-content::-webkit-scrollbar {
  width: 6px;
}

.dropdown-content::-webkit-scrollbar-thumb {
  background-color: #c0c4cc;
  border-radius: 3px;
}

.dropdown-content::-webkit-scrollbar-track {
  background-color: #f5f7fa;
}

.variable-group-title {
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  color: #909399;
  background: #f5f7fa;
  border-bottom: 1px solid #ebeef5;
}

.variable-item {
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.2s;
  border-bottom: 1px solid #f5f7fa;
}

.variable-item:last-child {
  border-bottom: none;
}

.variable-item:hover {
  background: #f5f7fa;
}

.variable-item.recommended {
  background: #fff9e6;
  border-left: 3px solid #f5a623;
}

.variable-item.recommended:hover {
  background: #fff3cc;
}

.variable-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.recommended-badge {
  font-size: 12px;
}

.variable-path {
  font-family: 'Courier New', monospace;
  font-size: 12px;
  color: #409eff;
}

.variable-description {
  font-size: 12px;
  color: #909399;
}

.variable-type {
  font-size: 10px;
  color: #999;
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
  margin-left: 4px;
}

.variable-note {
  font-size: 11px;
  color: #e6a23c;
  margin-top: 4px;
  font-style: italic;
}

.empty-message {
  padding: 12px;
  text-align: center;
  color: #909399;
  font-size: 13px;
}
</style>
