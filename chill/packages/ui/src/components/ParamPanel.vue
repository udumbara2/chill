<template>
  <div class="param-panel">
    <div v-if="!selectedModel" class="empty-message">
      请先选择模型
    </div>
    <CollapsiblePanel v-else title="参数设置" :default-expanded="false">
      <template #header-actions>
        <span class="param-count">({{ selectedParamNames.length }})</span>
      </template>
      <div class="param-list">
        <div 
          v-for="param in selectedParameters" 
          :key="param.name"
          class="param-item"
        >
          <div class="param-item-row">
            <label class="param-label">
              {{ formatParamName(param.name) }}
              <span v-if="param.required" class="required-mark">*</span>
            </label>
            
            <div class="param-input-wrapper">
              <input 
                v-if="param.type === ParameterType.NUMBER"
                type="number"
                v-model.number="paramValues[param.name]"
                :min="getMinValue(param)"
                :max="getMaxValue(param)"
                :step="getStepValue(param)"
                class="param-input param-input-number"
                :placeholder="param.description"
              />
              
              <input 
                v-else-if="param.type === ParameterType.STRING"
                type="text"
                v-model="paramValues[param.name]"
                class="param-input param-input-text"
                :placeholder="param.description"
              />
              
              <select 
                v-else-if="param.type === ParameterType.BOOLEAN"
                v-model="paramValues[param.name]"
                class="param-input param-select param-input-boolean"
              >
                <option :value="true">true</option>
                <option :value="false">false</option>
              </select>
              
              <input 
                v-else-if="param.type === ParameterType.ARRAY"
                type="text"
                v-model="arrayValues[param.name]"
                @blur="handleArrayBlur(param.name)"
                class="param-input param-input-text"
                placeholder="逗号分隔的值，如: a,b,c"
              />
              
              <input 
                v-else-if="param.type === ParameterType.OBJECT"
                type="text"
                v-model="objectValues[param.name]"
                @blur="handleObjectBlur(param.name)"
                class="param-input param-input-text"
                placeholder='JSON格式，如: {"key": "value"}'
              />
            </div>
            
            <button class="remove-param-button" @click="removeParameter(param.name)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          
          <div v-if="param.description" class="param-description">
            {{ param.description }}
          </div>
        </div>

        <div class="add-param-section">
          <button class="add-param-button" @click="toggleAddMenu">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            添加参数
          </button>
          
          <div v-if="showAddMenu" class="add-param-menu">
            <div 
              v-for="param in availableParameters" 
              :key="param.name"
              class="menu-item"
              @click="addParameter(param.name)"
            >
              <span class="menu-item-text">{{ formatParamName(param.name) }}</span>
              <span v-if="param.required" class="required-mark">*</span>
            </div>
          </div>
        </div>
      </div>
    </CollapsiblePanel>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import CollapsiblePanel from './CollapsiblePanel.vue'
import type { ModelInfo, ModelParameter } from '@assistant-ai/core'
import { ParameterType } from '@assistant-ai/core'

interface Props {
  selectedModel?: ModelInfo | null
  parameters?: Record<string, any>
}

const props = withDefaults(defineProps<Props>(), {
  selectedModel: null,
  parameters: () => ({})
})

const emit = defineEmits<{
  'update:parameters': [parameters: Record<string, any>]
}>()

const paramValues = ref<Record<string, any>>({})
const arrayValues = ref<Record<string, string>>({})
const objectValues = ref<Record<string, string>>({})
const showAddMenu = ref(false)
const selectedParamNames = ref<string[]>([])
const isEmitting = ref(false)

const toggleAddMenu = () => {
  showAddMenu.value = !showAddMenu.value
}

const addParameter = (paramName: string) => {
  if (!selectedParamNames.value.includes(paramName)) {
    selectedParamNames.value.push(paramName)
    const param = editableParameters.value.find(p => p.name === paramName)
    if (param && param.defaultValue !== undefined) {
      paramValues.value[paramName] = param.defaultValue
    } else {
      switch (param?.type) {
        case ParameterType.NUMBER:
          paramValues.value[paramName] = 0
          break
        case ParameterType.STRING:
          paramValues.value[paramName] = ''
          break
        case ParameterType.BOOLEAN:
          paramValues.value[paramName] = false
          break
        case ParameterType.ARRAY:
          paramValues.value[paramName] = []
          arrayValues.value[paramName] = ''
          break
        case ParameterType.OBJECT:
          paramValues.value[paramName] = null
          objectValues.value[paramName] = ''
          break
      }
    }
    emitParameters()
  }
  showAddMenu.value = false
}

const removeParameter = (paramName: string) => {
  const index = selectedParamNames.value.indexOf(paramName)
  if (index > -1) {
    selectedParamNames.value.splice(index, 1)
    delete paramValues.value[paramName]
    delete arrayValues.value[paramName]
    delete objectValues.value[paramName]
    emitParameters()
  }
}

const editableParameters = computed(() => {
  if (!props.selectedModel) return []
  
  return props.selectedModel.supportedParameters.filter(param => {
    return param.name !== 'model' && 
           param.name !== 'messages' && 
           param.name !== 'tools'
  })
})

const availableParameters = computed(() => {
  return editableParameters.value.filter(param => 
    !selectedParamNames.value.includes(param.name)
  )
})

const selectedParameters = computed(() => {
  return editableParameters.value.filter(param => 
    selectedParamNames.value.includes(param.name)
  )
})

const formatParamName = (name: string): string => {
  return name
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

const getMinValue = (param: ModelParameter): number | undefined => {
  if (param.name === 'temperature') return 0
  if (param.name === 'top_p') return 0
  if (param.name === 'presence_penalty') return -2
  if (param.name === 'frequency_penalty') return -2
  return undefined
}

const getMaxValue = (param: ModelParameter): number | undefined => {
  if (param.name === 'temperature') return 2
  if (param.name === 'top_p') return 1
  if (param.name === 'presence_penalty') return 2
  if (param.name === 'frequency_penalty') return 2
  return undefined
}

const getStepValue = (param: ModelParameter): number | string => {
  if (param.name === 'temperature') return 0.1
  if (param.name === 'top_p') return 0.1
  return 1
}

const handleArrayBlur = (paramName: string) => {
  const value = arrayValues.value[paramName]
  if (value) {
    paramValues.value[paramName] = value.split(',').map(s => s.trim())
  } else {
    paramValues.value[paramName] = []
  }
  emitParameters()
}

const handleObjectBlur = (paramName: string) => {
  const value = objectValues.value[paramName]
  if (value) {
    try {
      paramValues.value[paramName] = JSON.parse(value)
    } catch (e) {
      console.error(`Invalid JSON for parameter ${paramName}:`, e)
    }
  } else {
    paramValues.value[paramName] = null
  }
  emitParameters()
}

const emitParameters = () => {
  emit('update:parameters', { ...paramValues.value })
}

const initializeParameters = () => {
  if (!props.selectedModel) return
  
  paramValues.value = {}
  arrayValues.value = {}
  objectValues.value = {}
  
  const defaultParams = ['temperature', 'max_tokens']
  
  selectedParamNames.value.forEach(paramName => {
    const param = editableParameters.value.find(p => p.name === paramName)
    if (param && param.defaultValue !== undefined) {
      paramValues.value[paramName] = param.defaultValue
    } else if (param) {
      switch (param.type) {
        case ParameterType.NUMBER:
          paramValues.value[paramName] = 0
          break
        case ParameterType.STRING:
          paramValues.value[paramName] = ''
          break
        case ParameterType.BOOLEAN:
          paramValues.value[paramName] = false
          break
        case ParameterType.ARRAY:
          paramValues.value[paramName] = []
          arrayValues.value[paramName] = ''
          break
        case ParameterType.OBJECT:
          paramValues.value[paramName] = null
          objectValues.value[paramName] = ''
          break
      }
    }
  })
  
  defaultParams.forEach(paramName => {
    if (!selectedParamNames.value.includes(paramName)) {
      const param = editableParameters.value.find(p => p.name === paramName)
      if (param) {
        selectedParamNames.value.push(paramName)
        if (param.defaultValue !== undefined) {
          paramValues.value[paramName] = param.defaultValue
        } else {
          switch (param.type) {
            case ParameterType.NUMBER:
              paramValues.value[paramName] = 0
              break
            case ParameterType.STRING:
              paramValues.value[paramName] = ''
              break
            case ParameterType.BOOLEAN:
              paramValues.value[paramName] = false
              break
            case ParameterType.ARRAY:
              paramValues.value[paramName] = []
              arrayValues.value[paramName] = ''
              break
            case ParameterType.OBJECT:
              paramValues.value[paramName] = null
              objectValues.value[paramName] = ''
              break
          }
        }
      }
    }
  })
  
  emitParameters()
}

watch(() => props.selectedModel, () => {
  initializeParameters()
}, { immediate: true })

watch(() => props.parameters, (newParams) => {
  if (Object.keys(newParams).length > 0) {
    paramValues.value = { ...newParams }
    selectedParamNames.value = Object.keys(newParams).filter(key => 
      editableParameters.value.some(p => p.name === key)
    )
  }
}, { immediate: true, deep: true })

watch(paramValues, (newValues) => {
  if (isEmitting.value) return
  
  isEmitting.value = true
  emit('update:parameters', { ...newValues })
  nextTick(() => {
    isEmitting.value = false
  })
}, { deep: true })
</script>

<style scoped>
.param-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-message {
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
  text-align: center;
  padding: 20px 0;
}

.param-count {
  color: var(--text-secondary, #6b7280);
  font-weight: normal;
  margin-left: 4px;
}

.param-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.add-param-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.add-param-button {
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

.add-param-button:hover {
  background-color: var(--background-secondary, #f9fafb);
  color: var(--text-primary, #111827);
  border-color: var(--text-secondary, #6b7280);
}

.add-param-button svg {
  color: var(--text-secondary, #6b7280);
}

.add-param-button:hover svg {
  color: var(--text-primary, #111827);
}

.add-param-menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.menu-item:hover {
  background-color: var(--background-secondary, #f9fafb);
}

.menu-item-text {
  font-size: 13px;
  color: var(--text-primary, #111827);
}

.param-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background-color: var(--background-secondary, #f9fafb);
  border-radius: 6px;
}

.param-item-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.param-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary, #111827);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  min-width: auto;
  width: auto;
}

.param-input-wrapper {
  display: flex;
  align-items: center;
  flex: 1;
}

.param-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-primary, #111827);
  background-color: var(--background-primary, #ffffff);
  transition: border-color 0.2s;
}

.param-input-number {
  width: 80px;
  min-width: 80px;
}

.param-input-text {
  width: 100%;
}

.param-input-boolean {
  width: 80px;
  min-width: 80px;
}

.param-input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.param-select {
  cursor: pointer;
}

.remove-param-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.remove-param-button:hover {
  background-color: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.required-mark {
  color: #ef4444;
  font-weight: bold;
}

.param-description {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  line-height: 1.4;
}
</style>
