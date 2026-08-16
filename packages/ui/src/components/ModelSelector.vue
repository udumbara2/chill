<template>
  <div class="model-selector">
    <div 
      class="model-selector-trigger"
      @click="toggleDropdown"
    >
      <div class="model-selector-text">
        <span class="selected-model-label">
          {{ internalSelectedModel ? internalSelectedModel.displayName : '选择模型' }}
        </span>
      </div>
      <svg 
        class="dropdown-icon" 
        :class="{ 'expanded': isDropdownOpen }"
        viewBox="0 0 24 24" 
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    
    <div v-if="isDropdownOpen" class="model-dropdown" :class="{ 'dropdown-bottom': dropdownPosition === 'bottom' }">
      <div class="model-list" @wheel.stop>
        <div 
          v-for="model in availableModels" 
          :key="model.name"
          class="model-item"
          :class="{ 'selected': internalSelectedModel && internalSelectedModel.name === model.name }"
          @click="selectModel(model)"
        >
          <div class="model-info">
            <div class="model-name">{{ model.displayName }}</div>
          </div>
          <div class="model-features">
            <span v-if="model.supportsThinking" class="feature-tag thinking">推理</span>
            <span v-if="model.supportsTools" class="feature-tag tools">工具</span>
            <span 
              v-for="modality in getModalitiesToShow(model)" 
              :key="modality"
              class="feature-tag modality"
            >
              {{ getModalityLabel(modality) }}
            </span>
          </div>
        </div>
      </div>
      <div v-if="availableModels.length === 0" class="empty-state">
        <p>没有可用的模型</p>
        <p class="empty-hint">请先在设置中添加模型</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { SelectedModelsService } from '@assistant-ai/core'
import type { ModelInfo } from '@assistant-ai/core'
import { ModelModality, deriveModelKind } from '@assistant-ai/core'

interface Props {
  dropdownPosition?: 'top' | 'bottom'
  selectedModel?: ModelInfo | null
}

const props = withDefaults(defineProps<Props>(), {
  dropdownPosition: 'top',
  selectedModel: null
})

// 定义事件
const emit = defineEmits<{
  modelSelected: [model: ModelInfo | null]
}>()

// 组件状态
const isDropdownOpen = ref(false)
const internalSelectedModel = ref<ModelInfo | null>(props.selectedModel)
const availableModels = ref<ModelInfo[]>([])

// 监听 props.selectedModel 变化，同步到内部状态
watch(() => props.selectedModel, (newModel) => {
  internalSelectedModel.value = newModel
}, { immediate: true })

// 加载已选择的模型
const loadSelectedModels = () => {
  const selectedModelsService = SelectedModelsService.getInstance()
  // 使用面分层：切换器只列 chat 模型（生成模型经 generate_* 工具使用）
  availableModels.value = selectedModelsService.getSelectedModels()
    .filter(m => deriveModelKind(m.adapterConfig?.protocol) === 'chat')
  
  // 如果当前选中的模型不在可用列表中，清除选择
  if (internalSelectedModel.value && !availableModels.value.some(m => m.name === internalSelectedModel.value!.name)) {
    internalSelectedModel.value = null
    emit('modelSelected', null)
  }
  
  // 注意：不再自动选择第一个模型，因为模型选择应该由父组件控制
  // 父组件通过 props.selectedModel 传递当前选中的模型
}

// 获取要显示的模态列表（排除已由其他标签显示的技术细节模态）
const getModalitiesToShow = (model: ModelInfo): ModelModality[] => {
  if (!model.supportedModalities) return []
  
  // 排除已由supportsThinking和supportsTools表示的模态
  // 同时排除REASONING_MODE，因为supportsThinking已经显示为"推理"
  const excludedModalities: ModelModality[] = []
  if (model.supportsThinking) {
    excludedModalities.push(ModelModality.THINKING_MODE)
    excludedModalities.push(ModelModality.REASONING_MODE)
  }
  if (model.supportsTools) {
    excludedModalities.push(ModelModality.FUNCTION_CALLING)
  }
  
  // 排除技术细节模态（不在ModelSelector中显示）
  const technicalModalities: ModelModality[] = [
    ModelModality.JSON_MODE,
    ModelModality.CONTEXT_CONTINUATION,
    ModelModality.FIM_COMPLETION
  ]
  
  return model.supportedModalities.filter(m => 
    !excludedModalities.includes(m) && !technicalModalities.includes(m)
  )
}

// 获取模态显示标签
const getModalityLabel = (modality: ModelModality): string => {
  const labelMap: Record<ModelModality, string> = {
    [ModelModality.TEXT]: '文本',
    [ModelModality.IMAGE]: '图片',
    [ModelModality.AUDIO]: '音频',
    [ModelModality.VIDEO]: '视频',
    [ModelModality.FUNCTION_CALLING]: '函数',
    [ModelModality.JSON_MODE]: 'JSON',
    [ModelModality.THINKING_MODE]: '推理',
    [ModelModality.REASONING_MODE]: '推理',
    [ModelModality.CONTEXT_CONTINUATION]: '上下文',
    [ModelModality.FIM_COMPLETION]: 'FIM'
  }
  return labelMap[modality] || modality
}

// 切换下拉菜单
const toggleDropdown = () => {
  isDropdownOpen.value = !isDropdownOpen.value
  if (isDropdownOpen.value) {
    loadSelectedModels()
  }
}

// 选择模型
const selectModel = (model: ModelInfo) => {
  internalSelectedModel.value = model
  isDropdownOpen.value = false

  // 保存当前选择的模型
  const selectedModelsService = SelectedModelsService.getInstance()
  selectedModelsService.saveCurrentModelName(model.name)

  emit('modelSelected', model)
}

// 点击外部关闭下拉菜单
const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as Element
  if (!target.closest('.model-selector')) {
    isDropdownOpen.value = false
  }
}

// 组件挂载时加载模型
onMounted(() => {
  loadSelectedModels()
  document.addEventListener('click', handleClickOutside)

  // 只有在父组件没有提供 selectedModel 时，才自动恢复上次选择的模型
  // 这样可以避免覆盖父组件（如工作流节点）传递的模型选择状态
  // 同时保持 Chat 模块的模型记忆功能
  if (!props.selectedModel) {
    const selectedModelsService = SelectedModelsService.getInstance()
    const savedModel = selectedModelsService.getCurrentModel()
    if (savedModel && availableModels.value.some(m => m.name === savedModel.name)) {
      internalSelectedModel.value = savedModel
      emit('modelSelected', savedModel)
    }
  }
})

// 组件卸载时移除事件监听
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.model-selector {
  position: relative;
  display: inline-block;
}

.model-selector-trigger {
  display: flex;
  align-items: center;
  height: 24px;
  padding: 2px 6px;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}

.model-selector-text {
  flex: 1;
  text-align: right;
  margin-right: 6px;
}

.model-selector-trigger:hover {
  color: #3b82f6;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(147, 197, 253, 0.2) 100%);
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.25);
}

.model-selector-trigger:active {
  transform: scale(0.98);
}

.selected-model-label {
  white-space: nowrap;
  max-width: min(200px, 60vw);
  overflow: hidden;
  text-overflow: ellipsis;
}

.dropdown-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  transition: transform 0.2s;
}

.dropdown-icon.expanded {
  transform: rotate(180deg);
}

.model-dropdown {
  position: absolute;
  bottom: 100%;
  right: 0;
  z-index: 100;
  width: min(320px, 80vw);
  min-width: 280px;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  margin-bottom: 4px;
  max-height: 300px;
  overflow: hidden;
}

.model-dropdown.dropdown-bottom {
  bottom: auto;
  top: 100%;
  right: auto;
  left: 0;
  margin-bottom: 0;
  margin-top: 4px;
}

.dropdown-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color-light, #f3f4f6);
  background-color: var(--background-secondary, #f9fafb);
}

.dropdown-title {
  font-weight: 600;
  color: var(--text-primary, #111827);
  font-size: 13px;
}

.model-list {
  max-height: 250px;
  overflow-y: auto;
  padding: 4px 0;
}

.model-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  cursor: pointer;
  transition: background-color 0.2s;
  border-bottom: 1px solid var(--border-color-light, #f3f4f6);
}

.model-item:last-child {
  border-bottom: none;
}

.model-item:hover {
  background-color: var(--background-secondary, #f9fafb);
}

.model-item.selected {
  background-color: rgba(59, 130, 246, 0.1);
  border-left: 3px solid #3b82f6;
}

.model-info {
  flex: 1;
}

.model-name {
  font-weight: 500;
  color: var(--text-primary, #111827);
  font-size: 13px;
  word-break: break-word;
  white-space: normal;
  line-height: 1.4;
}

.model-provider {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  margin-top: 2px;
}

.model-features {
  display: flex;
  gap: 4px;
}

.feature-tag {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.feature-tag.thinking {
  background-color: rgba(139, 92, 246, 0.1);
  color: #8b5cf6;
}

.feature-tag.tools {
  background-color: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.feature-tag.modality {
  background-color: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.empty-state {
  padding: 32px 16px;
  text-align: center;
}

.empty-state p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
}

.empty-hint {
  font-size: 12px !important;
  color: var(--text-tertiary, #9ca3af) !important;
  margin-top: 4px !important;
}

.model-list::-webkit-scrollbar {
  width: 6px;
}

.model-list::-webkit-scrollbar-track {
  background: var(--background-secondary, #f9fafb);
}

.model-list::-webkit-scrollbar-thumb {
  background: rgba(203, 213, 225, 0.6);
  border-radius: 3px;
}

.model-list::-webkit-scrollbar-thumb:hover {
  background: rgba(100, 116, 139, 0.8);
}
</style>