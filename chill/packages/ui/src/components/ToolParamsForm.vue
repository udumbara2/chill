<template>
  <div class="tool-params-form">
    <div v-if="!tool" class="empty-text">
      请先选择工具
    </div>
    
    <div v-else-if="!properties || Object.keys(properties).length === 0" class="empty-text">
      该工具无需参数
    </div>
    
    <div v-else class="params-list">
      <div 
        v-for="(prop, propName) in properties" 
        :key="propName"
        class="param-item"
      >
        <div class="param-header">
          <span class="param-name">
            {{ prop.description || propName }}
            <span v-if="isRequired(propName)" class="required-mark">*</span>
          </span>
          <span class="param-type">{{ prop.type }}</span>
        </div>
        
        <div class="param-input-wrapper">
          <div class="param-input">
            <input
              v-if="prop.type === 'string' && !prop.enum"
              type="text"
              :value="localParams[propName] || ''"
              @input="updateParam(propName, ($event.target as HTMLInputElement).value)"
              :placeholder="prop.description || propName"
              class="text-input"
              :ref="el => setInputRef(propName, el as HTMLInputElement)"
            />
            
            <input
              v-else-if="prop.type === 'number' || prop.type === 'integer'"
              type="number"
              :value="localParams[propName] ?? prop.default ?? ''"
              @input="updateParam(propName, Number(($event.target as HTMLInputElement).value))"
              :placeholder="prop.description || propName"
              class="number-input"
              :ref="el => setInputRef(propName, el as HTMLInputElement)"
            />
            
            <label v-else-if="prop.type === 'boolean'" class="checkbox-label">
              <input
                type="checkbox"
                :checked="localParams[propName] ?? prop.default ?? false"
                @change="updateParam(propName, ($event.target as HTMLInputElement).checked)"
                class="checkbox-input"
              />
              <span>{{ prop.description || propName }}</span>
            </label>
            
            <select
              v-else-if="prop.enum"
              :value="localParams[propName] ?? prop.default ?? ''"
              @change="updateParam(propName, ($event.target as HTMLSelectElement).value)"
              class="select-input"
            >
              <option value="">请选择...</option>
              <option v-for="option in prop.enum" :key="option" :value="option">
                {{ option }}
              </option>
            </select>
            
            <textarea
              v-else-if="prop.type === 'array'"
              :value="Array.isArray(localParams[propName]) ? localParams[propName].join('\n') : ''"
              @input="updateArrayParam(propName, ($event.target as HTMLTextAreaElement).value)"
              :placeholder="prop.description || propName + ' (每行一个)'"
              class="textarea-input"
              rows="3"
              :ref="el => setInputRef(propName, el as HTMLTextAreaElement)"
            />
            
            <textarea
              v-else-if="prop.type === 'string' && (prop.description?.includes('正文') || prop.description?.includes('内容') || prop.description?.includes('代码'))"
              :value="localParams[propName] || ''"
              @input="updateParam(propName, ($event.target as HTMLTextAreaElement).value)"
              :placeholder="prop.description || propName"
              class="textarea-input"
              rows="3"
              :ref="el => setInputRef(propName, el as HTMLTextAreaElement)"
            />
            
            <input
              v-else
              type="text"
              :value="localParams[propName] || ''"
              @input="updateParam(propName, ($event.target as HTMLInputElement).value)"
              :placeholder="prop.description || propName"
              class="text-input"
              :ref="el => setInputRef(propName, el as HTMLInputElement)"
            />
          </div>
          
          <VariableSelector
            v-if="toolIndex !== undefined && selectedTools && selectedTools.length > 0"
            :available-variables="availableVariables"
            @insert="handleInsertVariable(propName, $event)"
          />
        </div>
        
        <div v-if="prop.default !== undefined" class="param-default">
          默认值: {{ prop.default }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, ref } from 'vue'
import type { ToolDefinition } from '@assistant-ai/core'
import VariableSelector from './VariableSelector.vue'
import type { Variable } from './VariableSelector.vue'
import type { WorkflowNode } from '@assistant-ai/core'

interface Props {
  tool: ToolDefinition | null
  modelValue: Record<string, any>
  toolIndex?: number
  selectedTools?: ToolDefinition[]
  state?: any
  upstreamNode?: WorkflowNode | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: Record<string, any>]
}>()

const properties = computed(() => {
  return props.tool?.function.parameters?.properties || {}
})

const requiredParams = computed(() => {
  return props.tool?.function.parameters?.required || []
})

const localParams = ref<Record<string, any>>({ ...props.modelValue })

const inputRefs = ref<Record<string, HTMLInputElement | HTMLTextAreaElement>>({})

const setInputRef = (propName: string, el: HTMLInputElement | HTMLTextAreaElement | null) => {
  if (el) {
    inputRefs.value[propName] = el
  }
}

const getUpstreamNodeDescription = computed(() => {
  const node = props.upstreamNode
  if (!node) return ''
  
  const label = node.data?.label || '未命名节点'
  const nodeType = node.type
  
  switch (nodeType) {
    case 'start': {
      const fileInputs = (node.data as any)?.fileInputs || []
      const textInput = (node.data as any)?.textInput
      if (fileInputs.length > 0) {
        return `来自「${label}」的文件路径`
      } else if (textInput) {
        return `来自「${label}」的用户输入`
      }
      return `来自「${label}」节点`
    }
    case 'model': {
      const modelName = (node.data as any)?.selectedModel?.name || '未知模型'
      return `来自「${label}」(${modelName})的回复`
    }
    case 'tool': {
      const tools = (node.data as any)?.selectedTools || []
      if (tools.length > 0) {
        const lastTool = tools[tools.length - 1]
        const lastToolName = lastTool?.function?.name || '未知工具'
        return `来自「${label}」工具(${lastToolName})的结果`
      }
      return `来自「${label}」节点`
    }
    default:
      return `来自「${label}」节点`
  }
})

const availableVariables = computed<Variable[]>(() => {
  if (props.toolIndex === undefined || !props.selectedTools) {
    return []
  }
  
  const variables: Variable[] = []
  const upstreamDesc = getUpstreamNodeDescription.value
  
  variables.push({
    path: `{{messages[-1].content}}`,
    description: upstreamDesc ? `${upstreamDesc}的消息` : `上游节点的最后一条消息`,
    type: `string | ContentPart[]`,
    recommended: true,
    group: 'upstream'
  })
  
  variables.push({
    path: `{{text}}`,
    description: `用户输入的文本`,
    type: `string`,
    group: 'upstream'
  })
  
  if (props.state && props.state.messages && Array.isArray(props.state.messages) && props.state.messages.length > 0) {
    const lastMessage = props.state.messages[props.state.messages.length - 1]
    if (lastMessage && lastMessage.content) {
      const preview = typeof lastMessage.content === 'string' 
        ? lastMessage.content.substring(0, 50) + (lastMessage.content.length > 50 ? '...' : '')
        : '[多模态内容]'
      variables[0].description = upstreamDesc 
        ? `${upstreamDesc}的消息: "${preview}"`
        : `上游节点的最后一条消息: "${preview}"`
    }
  }
  
  for (let i = 0; i < props.toolIndex; i++) {
    const tool = props.selectedTools[i]
    if (tool) {
      variables.push({
        path: `{{tools[${i}].result}}`,
        description: `工具 ${i + 1} (${tool.function.name}) 的完整结果`,
        type: `object`,
        group: 'tool'
      })
      
      variables.push({
        path: `{{tools[${i}].result.success}}`,
        description: `工具 ${i + 1} (${tool.function.name}) 的执行状态`,
        type: `boolean`,
        group: 'tool'
      })
      
      variables.push({
        path: `{{tools[${i}].result.data}}`,
        description: `工具 ${i + 1} (${tool.function.name}) 的数据`,
        type: `any`,
        note: `成功时存在，具体结构取决于工具`,
        group: 'tool'
      })
      
      variables.push({
        path: `{{tools[${i}].result.error}}`,
        description: `工具 ${i + 1} (${tool.function.name}) 的错误信息`,
        type: `string`,
        note: `失败时存在`,
        group: 'tool'
      })
    }
  }
  
  return variables
})

watch(() => props.modelValue, (newVal) => {
  localParams.value = { ...newVal }
}, { deep: true })

const isRequired = (propName: string): boolean => {
  return requiredParams.value.includes(propName)
}

const updateParam = (propName: string, value: any) => {
  localParams.value[propName] = value
  emit('update:modelValue', { ...localParams.value })
}

const updateArrayParam = (propName: string, value: string) => {
  const array = value.split('\n').filter(item => item.trim())
  localParams.value[propName] = array
  emit('update:modelValue', { ...localParams.value })
}

const handleInsertVariable = (propName: string, variable: Variable) => {
  const currentValue = localParams.value[propName] || ''
  const newValue = currentValue + variable.path
  
  updateParam(propName, newValue)
  
  const inputEl = inputRefs.value[propName]
  if (inputEl) {
    inputEl.focus()
  }
}
</script>

<style scoped>
.tool-params-form {
  width: 100%;
}

.empty-text {
  color: #999;
  font-size: 12px;
  text-align: center;
  padding: 12px;
}

.params-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.param-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.param-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.param-name {
  font-size: 12px;
  font-weight: 500;
  color: #333;
}

.required-mark {
  color: #e74c3c;
  margin-left: 2px;
}

.param-type {
  font-size: 10px;
  color: #999;
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
}

.param-input-wrapper {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.param-input {
  flex: 1;
}

.text-input,
.number-input,
.select-input,
.textarea-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 12px;
  transition: border-color 0.2s;
}

.text-input:focus,
.number-input:focus,
.select-input:focus,
.textarea-input:focus {
  outline: none;
  border-color: #3498db;
}

.textarea-input {
  resize: vertical;
  font-family: inherit;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}

.checkbox-input {
  cursor: pointer;
}

.param-default {
  font-size: 10px;
  color: #999;
}
</style>
