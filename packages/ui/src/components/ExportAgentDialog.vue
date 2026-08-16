<template>
  <Teleport to="body">
    <Transition name="export-dialog">
      <div v-if="isOpen" class="export-dialog-overlay" @click="handleCancel">
        <div class="export-dialog-container" @click.stop>
          <div class="export-dialog-header">
            <h3 class="export-dialog-title">保存为AGENT</h3>
          </div>
          <div class="export-dialog-body">
            <div class="form-group">
              <label for="agent-name" class="form-label">AGENT名称</label>
              <input
                id="agent-name"
                v-model="agentName"
                type="text"
                class="form-input"
                placeholder="请输入AGENT名称"
                @keyup.enter="handleConfirm"
                ref="nameInput"
              />
            </div>
            <div class="form-group">
              <label for="agent-description" class="form-label">描述（可选）</label>
              <textarea
                id="agent-description"
                v-model="agentDescription"
                class="form-textarea"
                placeholder="请输入AGENT描述"
                rows="3"
              />
            </div>
            <div class="form-group checkbox-group">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  v-model="autoSyncEnabled"
                  class="checkbox-input"
                />
                <span class="checkbox-text">自动同步更新</span>
              </label>
              <span class="checkbox-hint">当源智能体更新时，自动更新此AGENT</span>
            </div>
          </div>
          <div class="export-dialog-footer">
            <button class="export-dialog-button cancel-button" @click="handleCancel">
              取消
            </button>
            <button
              class="export-dialog-button confirm-button"
              :disabled="!agentName.trim() || isExporting"
              @click="handleConfirm"
            >
              {{ confirmButtonText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'

interface Props {
  isOpen?: boolean
  isExporting?: boolean
  initialName?: string
  sourceWorkflowId?: string
  sourceWorkflowVersion?: number
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: false,
  isExporting: false,
  initialName: '',
  sourceWorkflowId: '',
  sourceWorkflowVersion: 1
})

const emit = defineEmits<{
  confirm: [name: string, description: string, autoSyncEnabled: boolean, sourceWorkflowId: string, sourceWorkflowVersion: number]
  cancel: []
}>()

const agentName = ref('')
const agentDescription = ref('')
const autoSyncEnabled = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)

// 计算确认按钮文本
const confirmButtonText = computed(() => {
  if (props.isExporting) return '保存中...'
  return '保存'
})

// 当对话框打开时，聚焦输入框
watch(() => props.isOpen, (newVal) => {
  if (newVal) {
    agentName.value = props.initialName
    agentDescription.value = ''
    autoSyncEnabled.value = false
    nextTick(() => {
      nameInput.value?.focus()
    })
  }
})

const handleConfirm = () => {
  const name = agentName.value.trim()
  if (name && !props.isExporting) {
    emit('confirm', name, agentDescription.value.trim(), autoSyncEnabled.value, props.sourceWorkflowId, props.sourceWorkflowVersion)
  }
}

const handleCancel = () => {
  emit('cancel')
}
</script>

<style scoped>
.export-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.export-dialog-container {
  background-color: var(--background-primary, #ffffff);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 400px;
  max-width: 560px;
  padding: 24px;
}

.export-dialog-header {
  margin-bottom: 20px;
}

.export-dialog-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary, #111827);
}

.export-dialog-body {
  margin-bottom: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #111827);
}

.form-input,
.form-textarea {
  padding: 10px 12px;
  border: 1px solid var(--border-color, #d1d5db);
  border-radius: 6px;
  font-size: 14px;
  color: var(--text-primary, #111827);
  background-color: var(--background-primary, #ffffff);
  transition: border-color 0.2s, box-shadow 0.2s;
  font-family: inherit;
}

.form-input:focus,
.form-textarea:focus {
  outline: none;
  border-color: var(--primary-color, #3b82f6);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.form-input::placeholder,
.form-textarea::placeholder {
  color: var(--text-tertiary, #9ca3af);
}

.form-textarea {
  resize: vertical;
  min-height: 80px;
}

.checkbox-group {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.checkbox-input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.checkbox-text {
  font-size: 14px;
  color: var(--text-primary, #111827);
}

.checkbox-hint {
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
  margin-left: 24px;
  width: 100%;
}

.export-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.export-dialog-button {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid transparent;
}

.cancel-button {
  background-color: var(--background-secondary, #f3f4f6);
  color: var(--text-secondary, #6b7280);
  border-color: var(--border-color, #d1d5db);
}

.cancel-button:hover {
  background-color: var(--background-tertiary, #e5e7eb);
}

.confirm-button {
  background-color: var(--primary-color, #3b82f6);
  color: white;
}

.confirm-button:hover:not(:disabled) {
  background-color: var(--primary-hover, #2563eb);
}

.confirm-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 过渡动画 */
.export-dialog-enter-active,
.export-dialog-leave-active {
  transition: opacity 0.2s ease;
}

.export-dialog-enter-from,
.export-dialog-leave-to {
  opacity: 0;
}

.export-dialog-enter-active .export-dialog-container,
.export-dialog-leave-active .export-dialog-container {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.export-dialog-enter-from .export-dialog-container,
.export-dialog-leave-to .export-dialog-container {
  transform: scale(0.95);
  opacity: 0;
}
</style>
