<template>
  <div class="tool-selector">
    <div class="selected-tools" v-if="selectedTools.length > 0">
      <div 
        v-for="tool in selectedTools" 
        :key="tool.function.name"
        class="tool-tag"
      >
        <span class="tool-name">{{ tool.function.name }}</span>
        <button 
          class="tool-remove" 
          @click="removeTool(tool)"
          title="删除工具"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
    
    <div class="tool-dropdown-container">
      <button 
        class="add-button" 
        @click.stop="toggleDropdown"
        :class="{ 'open': isDropdownOpen }"
        title="添加工具"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
      
      <div class="dropdown-menu" v-if="isDropdownOpen" v-click-outside="closeDropdown">
        <div class="dropdown-header">
          <span class="dropdown-title">选择工具</span>
          <button class="close-button" @click="closeDropdown">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        
        <div class="dropdown-content" @wheel.stop>
          <div v-if="isLoading" class="loading-text">加载中...</div>
          <div v-else-if="availableTools.length === 0" class="empty-text">没有可用工具</div>
          <div v-else class="tool-list-container">
            <label 
              v-for="tool in availableTools" 
              :key="tool.function.name"
              class="tool-item"
            >
              <input 
                type="checkbox" 
                :value="tool.function.name"
                v-model="tempSelectedTools"
                class="tool-checkbox"
              />
              <div class="tool-info">
                <div class="tool-name">{{ tool.function.name }}</div>
                <div class="tool-description">{{ tool.function.description }}</div>
              </div>
            </label>
          </div>
        </div>
        
        <div class="dropdown-footer">
          <button class="confirm-button" @click="confirmSelection" :disabled="tempSelectedTools.length === 0">
            确定 ({{ tempSelectedTools.length }})
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { MCPService } from '@assistant-ai/core'
import type { ToolDefinition } from '@assistant-ai/core'

interface Props {
  selectedTools?: ToolDefinition[]
}

const props = withDefaults(defineProps<Props>(), {
  selectedTools: () => []
})

const emit = defineEmits<{
  'update:selectedTools': [tools: ToolDefinition[]]
}>()

const mcpService = new MCPService()
const availableTools = ref<ToolDefinition[]>([])
const isLoading = ref(false)
const isDropdownOpen = ref(false)
const tempSelectedTools = ref<string[]>([])

const selectedTools = ref<ToolDefinition[]>([...props.selectedTools])

const loadTools = async () => {
  isLoading.value = true
  try {
    availableTools.value = await mcpService.getAggregatedOpenAITools()
  } catch (error) {
    console.error('Failed to load tools:', error)
    availableTools.value = []
  } finally {
    isLoading.value = false
  }
}

const toggleDropdown = () => {
  if (!isDropdownOpen.value) {
    tempSelectedTools.value = selectedTools.value.map(t => t.function.name)
    loadTools()
  }
  isDropdownOpen.value = !isDropdownOpen.value
}

const closeDropdown = () => {
  isDropdownOpen.value = false
}

const removeTool = (tool: ToolDefinition) => {
  selectedTools.value = selectedTools.value.filter(t => t.function.name !== tool.function.name)
  emit('update:selectedTools', selectedTools.value)
}

const confirmSelection = () => {
  const selectedToolDefinitions = tempSelectedTools.value
    .map(toolName => availableTools.value.find(tool => tool.function.name === toolName))
    .filter(Boolean) as ToolDefinition[]
  
  selectedTools.value = selectedToolDefinitions
  emit('update:selectedTools', selectedTools.value)
  closeDropdown()
}

watch(() => props.selectedTools, (newTools) => {
  selectedTools.value = [...newTools]
}, { deep: true })

onMounted(() => {
  loadTools()
})

const vClickOutside = {
  mounted(el: HTMLElement, binding: any) {
    const clickOutsideHandler = (event: MouseEvent) => {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value()
      }
    }
    ;(el as any)._clickOutside = clickOutsideHandler
    document.addEventListener('click', clickOutsideHandler)
  },
  unmounted(el: HTMLElement) {
    const handler = (el as any)._clickOutside
    if (handler) {
      document.removeEventListener('click', handler)
    }
  }
}
</script>

<style scoped>
.tool-selector {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  min-height: 36px;
}

.selected-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
}

.tool-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background-color: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.2);
  border-radius: 4px;
  font-size: 12px;
  color: #3b82f6;
}

.tool-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  background: none;
  border: none;
  color: #3b82f6;
  cursor: pointer;
  border-radius: 2px;
  transition: background-color 0.2s;
}

.tool-remove:hover {
  background-color: rgba(59, 130, 246, 0.2);
}

.tool-dropdown-container {
  position: relative;
}

.add-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background-color: var(--background-secondary, #f9fafb);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 4px;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  transition: all 0.2s;
}

.add-button:hover {
  background-color: #3b82f6;
  border-color: #3b82f6;
  color: white;
}

.add-button.open {
  background-color: #3b82f6;
  border-color: #3b82f6;
  color: white;
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  min-width: 280px;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  max-height: 400px;
  display: flex;
  flex-direction: column;
}

.dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--border-color-light, #f3f4f6);
}

.dropdown-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #111827);
}

.close-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: none;
  border: none;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.close-button:hover {
  background-color: var(--background-secondary, #f9fafb);
  color: var(--text-primary, #111827);
}

.dropdown-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.dropdown-content::-webkit-scrollbar {
  width: 6px;
  height: 6px;
  background: transparent;
}

.dropdown-content::-webkit-scrollbar-track {
  background: var(--background-secondary, #f9fafb);
  border-radius: 3px;
}

.dropdown-content::-webkit-scrollbar-thumb {
  background: rgba(203, 213, 225, 0.6);
  border-radius: 3px;
  transition: background-color 0.2s;
}

.dropdown-content::-webkit-scrollbar-thumb:hover {
  background: rgba(100, 116, 139, 0.8);
}

.tool-list-container {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.tool-item:hover {
  background-color: var(--background-secondary, #f9fafb);
}

.tool-checkbox {
  margin-top: 2px;
  cursor: pointer;
}

.tool-info {
  flex: 1;
  min-width: 0;
}

.tool-info .tool-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary, #111827);
  margin-bottom: 2px;
}

.tool-description {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dropdown-footer {
  padding: 12px;
  border-top: 1px solid var(--border-color-light, #f3f4f6);
  display: flex;
  justify-content: flex-end;
}

.confirm-button {
  padding: 6px 16px;
  background-color: #3b82f6;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.confirm-button:hover:not(:disabled) {
  background-color: #2563eb;
}

.confirm-button:disabled {
  background-color: #9ca3af;
  cursor: not-allowed;
  opacity: 0.7;
}

.empty-text,
.loading-text {
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
  padding: 12px;
  text-align: center;
}
</style>
