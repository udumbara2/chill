<template>
  <div class="start-node" :class="{ 'node-collapsed': isCollapsed, 'node-selected': props.selected }">
    <div class="node-header">
      <div class="node-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <polygon points="10 8 16 12 10 16 10 8"/>
        </svg>
      </div>
      <NodeTitle 
        :title="nodeTitle" 
        @update:title="handleTitleUpdate"
      />
      <button 
        class="collapse-button" 
        @click="toggleCollapse"
        :title="isCollapsed ? '展开' : '折叠'"
      >
        <svg v-if="!isCollapsed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="18 15 12 9 6 15"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div class="node-status" :class="statusClass">
        {{ statusText }}
      </div>
    </div>
    
    <div class="node-content" v-show="!isCollapsed">
      <div class="node-section">
        <div class="section-label">文字输入</div>
        <TextInput
          v-model:value="textInput"
          placeholder="输入文字内容..."
          @update:value="handleTextInputUpdate"
        />
      </div>
      
      <div class="node-section">
        <div class="section-label">文件路径</div>
        <div class="file-input-container">
          <div v-for="(_, index) in fileInputs" :key="index" class="file-input-item">
            <TextInput
              v-model="fileInputs[index]"
              :placeholder="`文件路径 ${index + 1}`"
            />
            <button class="remove-file-button" @click="removeFileInput(index)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <button class="add-file-button" @click="addFileInput">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            添加文件
          </button>
        </div>
      </div>
    </div>
    
    <Handle type="source" id="start-source" :position="Position.Right" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import type { NodeProps } from '@vue-flow/core'
import NodeTitle from './NodeTitle.vue'
import TextInput from './TextInput.vue'

interface StartNodeData {
  label?: string
  textInput?: string
  fileInputs?: string[]
  isCollapsed?: boolean
}

const props = defineProps<NodeProps<StartNodeData>>()

const nodeTitle = ref(props.data.label || '开始节点')
const textInput = ref(props.data.textInput || '')
const fileInputs = ref<string[]>(props.data.fileInputs || [])
const nodeStatus = ref<'idle' | 'running' | 'completed' | 'error'>('idle')
// 从 props.data 初始化折叠状态，如果没有则默认为折叠
const isCollapsed = ref(props.data.isCollapsed !== undefined ? props.data.isCollapsed : true)

const statusClass = computed(() => `status-${nodeStatus.value}`)

const statusText = computed(() => {
  const statusMap: Record<string, string> = {
    idle: '就绪',
    running: '运行中',
    completed: '完成',
    error: '错误'
  }
  return statusMap[nodeStatus.value] || '未知'
})

const handleTitleUpdate = (newTitle: string) => {
  nodeTitle.value = newTitle
  props.data.label = newTitle
}

const handleTextInputUpdate = (value: string) => {
  textInput.value = value
}

const addFileInput = () => {
  fileInputs.value.push('')
}

const removeFileInput = (index: number) => {
  fileInputs.value.splice(index, 1)
}

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
  // 同步到 props.data 以保留状态
  props.data.isCollapsed = isCollapsed.value
}

watch([textInput, fileInputs], () => {
  props.data.textInput = textInput.value
  props.data.fileInputs = fileInputs.value
}, { deep: true })

// 监听 props.data 变化，当切换工作流时重置内部状态
watch(() => props.data, (newData, oldData) => {
  // 如果 data 对象引用变化（切换工作流），重置内部状态
  if (newData !== oldData) {
    textInput.value = newData.textInput || ''
    fileInputs.value = newData.fileInputs || []
    nodeTitle.value = newData.label || '开始节点'
    isCollapsed.value = newData.isCollapsed !== undefined ? newData.isCollapsed : true
  }
}, { immediate: true, deep: true })

onMounted(() => {
})

defineExpose({
  textInput,
  fileInputs
})
</script>

<style scoped>
.start-node {
  min-width: 280px;
  max-width: 400px;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.start-node.node-selected {
  border-color: #8b5cf6;
  box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.2);
}

.start-node.node-collapsed {
  width: auto;
  min-width: 120px;
  max-width: 300px;
}

.node-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background-color: var(--background-secondary, #f9fafb);
  border-bottom: 1px solid var(--border-color-light, #f3f4f6);
}

.node-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background-color: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.collapse-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  padding: 0;
  margin-left: auto;
}

.collapse-button:hover {
  background-color: rgba(107, 114, 128, 0.1);
  color: var(--text-primary, #111827);
}

.collapse-button svg {
  flex-shrink: 0;
}

.node-status {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.status-idle {
  background-color: rgba(107, 114, 128, 0.1);
  color: #6b7280;
}

.status-running {
  background-color: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.status-completed {
  background-color: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.status-error {
  background-color: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.node-content {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.node-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary, #6b7280);
}

.file-input-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-input-item {
  display: flex;
  gap: 8px;
  align-items: center;
}

.file-input-item :deep(.text-input) {
  flex: 1;
}

.remove-file-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background-color: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.remove-file-button:hover {
  background-color: rgba(239, 68, 68, 0.2);
}

.add-file-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  background-color: transparent;
  color: var(--text-secondary, #6b7280);
  border: 1px dashed var(--border-color, #d1d5db);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.add-file-button:hover {
  background-color: var(--background-secondary, #f9fafb);
  color: var(--text-primary, #111827);
  border-color: var(--text-secondary, #6b7280);
}

.add-file-button svg {
  color: var(--text-secondary, #6b7280);
}

.add-file-button:hover svg {
  color: var(--text-primary, #111827);
}
</style>
