<template>
  <div class="parameter-dialog-overlay" v-if="visible" @click="handleCancel">
    <div class="parameter-dialog" @click.stop>
      <div class="dialog-header">
        <h3>Prompt 参数设置</h3>
        <button class="close-button" @click="handleCancel">×</button>
      </div>
      
      <div class="dialog-content">
        <!-- 错误提示 -->
        <div v-if="validationErrors.length > 0" class="validation-errors">
          <div v-for="error in validationErrors" :key="error" class="error-message">
            {{ error }}
          </div>
        </div>
        
        <form @submit.prevent="handleConfirm">
          <div v-for="param in parameters" :key="param.name" class="parameter-item">
            <label class="parameter-label">
              {{ param.name }}
              <span v-if="param.required" class="required-indicator">*</span>
              <span v-if="param.description" class="parameter-description">
                {{ param.description }}
              </span>
            </label>
            <input 
              type="text" 
              v-model="paramValues[param.name]"
              class="parameter-input"
              :placeholder="param.defaultValue || ''"
            />
          </div>
          
          <div class="dialog-actions">
            <button type="button" class="btn-secondary" @click="handleCancel">
              取消
            </button>
            <button type="submit" class="btn-primary">
              确认
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

interface PromptParameter {
  name: string
  description?: string
  defaultValue?: string
  required?: boolean
}

interface Props {
  visible: boolean
  parameters: PromptParameter[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  confirm: [paramArguments: Record<string, string>]
  cancel: []
}>()

const paramValues = ref<Record<string, string>>({})
const validationErrors = ref<string[]>([])

const handleConfirm = () => {
  validationErrors.value = [] // 清除之前错误
  
  // 验证必填参数
  const missingParams = []
  for (const param of props.parameters) {
    if (param.required && !paramValues.value[param.name]?.trim()) {
      missingParams.push(param.name)
    }
  }
  
  if (missingParams.length > 0) {
    validationErrors.value = [`请填写必填参数: ${missingParams.join(', ')}`]
    return // 非阻塞，继续允许输入
  }
  
  emit('confirm', paramValues.value)
  paramValues.value = {}
}

const handleCancel = () => {
  emit('cancel')
  paramValues.value = {}
  validationErrors.value = [] // 清除错误状态
}
</script>

<style scoped>
.parameter-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 11000;
}

.parameter-dialog {
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  max-width: 500px;
  width: 90%;
  max-height: 80vh;
  overflow: hidden;
}

.dialog-header {
  padding: 14px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: relative;
}

.dialog-header::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 20px;
  right: 20px;
  height: 1px;
  background: linear-gradient(90deg, 
    transparent 0%, 
    rgba(255, 248, 255, 1) 15%, 
    rgba(255, 238, 250, 1) 22%, 
    rgba(255, 225, 245, 1) 30%, 
    rgba(255, 215, 240, 1) 38%, 
    rgba(255, 235, 230, 1) 46%, 
    rgba(255, 240, 210, 1) 54%, 
    rgba(255, 245, 190, 1) 62%, 
    rgba(250, 255, 170, 1) 70%, 
    rgba(200, 255, 180, 1) 78%, 
    rgba(170, 255, 170, 1) 84%, 
    rgba(160, 250, 190, 1) 90%, 
    rgba(155, 245, 200, 1) 96%, 
    transparent 100%
  );
}

.dialog-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 400;
  color: var(--vscode-foreground, #1f2937);
  letter-spacing: 0.2px;
}

.close-button {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  padding: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--vscode-descriptionForeground, #6b7280);
  transition: all 0.15s ease;
}

.close-button:hover {
  background: rgba(255, 255, 255, 0.4);
  color: var(--vscode-foreground, #1f2937);
}

.dialog-content {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.parameter-item {
  padding: 8px 0;
}

.parameter-item + .parameter-item {
  margin-top: 8px;
}

.parameter-label {
  display: block;
  margin-bottom: 4px;
  font-weight: 400;
  color: var(--vscode-foreground, #1f2937);
  font-size: 13px;
  letter-spacing: 0.1px;
}

.parameter-description {
  display: block;
  font-weight: 300;
  color: var(--vscode-descriptionForeground, #6b7280);
  font-size: 12px;
  margin-top: 2px;
  line-height: 1.4;
}

.required-indicator {
  color: #dc3545;
  font-weight: bold;
  margin-left: 4px;
}

.validation-errors {
  margin-bottom: 16px;
  padding: 12px 16px;
  background-color: rgba(255, 235, 235, 0.9);
  border-radius: 8px;
  backdrop-filter: blur(4px);
}

.error-message {
  color: #c53030;
  font-size: 13px;
  font-weight: 400;
  margin-bottom: 4px;
}

.error-message:last-child {
  margin-bottom: 0;
}

.parameter-input {
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  box-sizing: border-box;
  background-color: rgba(255, 255, 255, 0.8);
  color: var(--vscode-foreground, #1f2937);
  transition: all 0.2s ease;
}

.parameter-input:focus {
  outline: none;
  background-color: rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.3);
}

.dialog-actions {
  padding: 20px;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-primary, .btn-secondary {
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
  border: none;
  transition: all 0.2s ease;
  letter-spacing: 0.2px;
}

.btn-primary {
  background: var(--vscode-button-background, #007acc);
  color: var(--vscode-button-foreground, #ffffff);
  box-shadow: 0 2px 4px rgba(0, 122, 204, 0.2);
}

.btn-primary:hover {
  background: var(--vscode-button-hoverBackground, #005a9e);
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 122, 204, 0.3);
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.6);
  color: var(--vscode-foreground, #1f2937);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.8);
  transform: translateY(-1px);
}

.btn-secondary {
  background: white;
  color: #666;
  border-color: #ddd;
}

.btn-secondary:hover {
  background: #f5f5f5;
  border-color: #ccc;
}
</style>