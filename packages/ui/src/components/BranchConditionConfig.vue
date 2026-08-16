<template>
  <div class="branch-condition-config">
    <!-- Content Type Configuration -->
    <template v-if="conditionType === 'content'">
      <div class="config-section">
        <label class="config-label">内容操作符</label>
        <select :value="config.operator" @change="updateConfig('operator', ($event.target as HTMLSelectElement).value)" class="config-select">
          <option value="equals">等于</option>
          <option value="not_equals">不等于</option>
          <option value="contains">包含</option>
          <option value="not_contains">不包含</option>
          <option value="starts_with">开头是</option>
          <option value="ends_with">结尾是</option>
          <option value="regex">正则匹配</option>
        </select>
      </div>
      <div class="config-section">
        <label class="config-label">比较值</label>
        <input 
          :value="config.value" 
          @input="updateConfig('value', ($event.target as HTMLInputElement).value)"
          type="text" 
          class="config-input" 
          placeholder="例如：hi、hello、成功" 
        />
      </div>
    </template>
    
    <!-- State Field Configuration -->
    <template v-if="conditionType === 'state_field'">
      <div class="config-section">
        <label class="config-label">字段名</label>
        <select :value="config.field" @change="updateConfig('field', ($event.target as HTMLSelectElement).value)" class="config-select">
          <option value="">请选择字段</option>
          <option v-for="field in availableFields" :key="field.value" :value="field.value">
            {{ field.label }}
          </option>
        </select>
        <p class="field-description" v-if="config.field && getFieldDescription(config.field)">
          {{ getFieldDescription(config.field) }}
        </p>
      </div>
      <div class="config-section">
        <label class="config-label">操作符</label>
        <select :value="config.operator" @change="updateConfig('operator', ($event.target as HTMLSelectElement).value)" class="config-select">
          <option value="eq">等于 (==)</option>
          <option value="ne">不等于 (!=)</option>
          <option value="gt">大于 (>)</option>
          <option value="lt">小于 (<)</option>
          <option value="gte">大于等于 (>=)</option>
          <option value="lte">小于等于 (<=)</option>
          <option value="contains">包含</option>
          <option value="not_contains">不包含</option>
        </select>
      </div>
      <div class="config-section">
        <label class="config-label">比较值</label>
        <input 
          :value="config.value" 
          @input="updateConfig('value', ($event.target as HTMLInputElement).value)"
          type="text" 
          class="config-input" 
          placeholder="例如：hello、true、123" 
        />
      </div>
    </template>
    
    <!-- Expression Configuration -->
    <template v-if="conditionType === 'expression'">
      <div class="config-section">
        <label class="config-label">条件表达式</label>
        <textarea 
          :value="config.expression" 
          @input="updateConfig('expression', ($event.target as HTMLTextAreaElement).value)"
          class="config-textarea" 
          placeholder="输入条件表达式，例如：status == 'success' AND iterationCount > 3"
          rows="2"
        ></textarea>
      </div>
    </template>
    
    <!-- Tool Call Configuration -->
    <template v-if="conditionType === 'tool_call'">
      <div class="config-section">
        <p class="config-hint">工具调用条件不需要额外配置，当模型返回工具调用时自动匹配。</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface FieldOption {
  value: string
  label: string
  description?: string
}

interface Props {
  conditionType: 'tool_call' | 'content' | 'state_field' | 'expression'
  conditionConfig?: Record<string, any>
  availableFields?: FieldOption[]
}

const props = withDefaults(defineProps<Props>(), {
  conditionConfig: () => ({}),
  availableFields: () => []
})

const emit = defineEmits<{
  'update:conditionConfig': [config: Record<string, any>]
}>()

const config = computed(() => props.conditionConfig)

const updateConfig = (key: string, value: any) => {
  emit('update:conditionConfig', {
    ...config.value,
    [key]: value
  })
}

const getFieldDescription = (fieldValue: string): string => {
  const field = props.availableFields.find(f => f.value === fieldValue)
  return field?.description || ''
}
</script>

<style scoped>
.branch-condition-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-label {
  font-size: 12px;
  font-weight: 500;
  color: #374151;
}

.config-select,
.config-input,
.config-textarea {
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
  background: white;
}

.config-select:focus,
.config-input:focus,
.config-textarea:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.config-textarea {
  resize: vertical;
  font-family: inherit;
}

.field-description {
  font-size: 11px;
  color: #6b7280;
  margin: 4px 0 0 0;
}

.config-hint {
  font-size: 12px;
  color: #6b7280;
  font-style: italic;
  margin: 0;
}
</style>
