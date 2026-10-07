<template>
  <Teleport to="body">
    <Transition name="save-dialog">
      <div v-if="isOpen" class="save-dialog-overlay" @click="handleCancel">
        <div class="save-dialog-container" @click.stop>
          <div class="save-dialog-header">
            <h3 class="save-dialog-title">{{ dialogTitle }}</h3>
          </div>
          <div class="save-dialog-body">
            <div class="form-group">
              <label for="workflow-name" class="form-label">工作流名称</label>
              <input
                id="workflow-name"
                v-model="workflowName"
                type="text"
                class="form-input"
                placeholder="请输入工作流名称"
                @keyup.enter="handleConfirm"
                ref="nameInput"
              />
            </div>
            <div class="form-group">
              <label for="workflow-key" class="form-label">调用键（小写字母/数字/连字符，模型按它调用）</label>
              <input
                id="workflow-key"
                v-model="workflowKey"
                type="text"
                class="form-input"
                placeholder="如 tech-article"
                @keyup.enter="handleConfirm"
              />
            </div>
          </div>
          <div class="save-dialog-footer">
            <button class="save-dialog-button cancel-button" @click="handleCancel">
              取消
            </button>
            <button
              class="save-dialog-button confirm-button"
              :disabled="!workflowName.trim() || !isKeyValid || isSaving"
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
  isSaving?: boolean
  initialName?: string
  mode?: 'save' | 'saveAs'
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: false,
  isSaving: false,
  initialName: '',
  mode: 'save'
})

const emit = defineEmits<{
  confirm: [name: string, key: string]
  cancel: []
}>()

const workflowName = ref('')
const workflowKey = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
let keyTouched = false

/** 名称 → 调用键建议:ASCII 小写连字符;非 ASCII(如中文)无法推导时留空由用户填 */
function suggestKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

watch(workflowName, (name) => {
  if (!keyTouched) workflowKey.value = suggestKey(name)
})
watch(workflowKey, () => {
  keyTouched = true
})

// 计算对话框标题
const dialogTitle = computed(() => {
  return props.mode === 'saveAs' ? '另存为工作流' : '保存工作流'
})

// 计算确认按钮文本
const confirmButtonText = computed(() => {
  if (props.isSaving) return '保存中...'
  return props.mode === 'saveAs' ? '另存为' : '保存'
})

const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const isKeyValid = computed(() => KEY_PATTERN.test(workflowKey.value.trim()))

// 当对话框打开时，聚焦输入框
watch(() => props.isOpen, (newVal) => {
  if (newVal) {
    // 使用传入的初始名称，如果是 saveAs 模式则清空
    workflowName.value = props.mode === 'saveAs' ? '' : props.initialName
    keyTouched = false
    workflowKey.value = suggestKey(workflowName.value)
    nextTick(() => {
      nameInput.value?.focus()
    })
  }
})

const handleConfirm = () => {
  const name = workflowName.value.trim()
  const key = workflowKey.value.trim()
  if (name && key && !props.isSaving) {
    emit('confirm', name, key)
  }
}

const handleCancel = () => {
  emit('cancel')
}
</script>

<style scoped>
.save-dialog-overlay {
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

.save-dialog-container {
  background-color: var(--background-primary, #ffffff);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 400px;
  max-width: 560px;
  padding: 24px;
}

.save-dialog-header {
  margin-bottom: 20px;
}

.save-dialog-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary, #111827);
}

.save-dialog-body {
  margin-bottom: 24px;
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

.form-input {
  padding: 10px 12px;
  border: 1px solid var(--border-color, #d1d5db);
  border-radius: 6px;
  font-size: 14px;
  color: var(--text-primary, #111827);
  background-color: var(--background-primary, #ffffff);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.form-input:focus {
  outline: none;
  border-color: var(--primary-color, #3b82f6);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.form-input::placeholder {
  color: var(--text-tertiary, #9ca3af);
}

.save-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.save-dialog-button {
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
.save-dialog-enter-active,
.save-dialog-leave-active {
  transition: opacity 0.2s ease;
}

.save-dialog-enter-from,
.save-dialog-leave-to {
  opacity: 0;
}

.save-dialog-enter-active .save-dialog-container,
.save-dialog-leave-active .save-dialog-container {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.save-dialog-enter-from .save-dialog-container,
.save-dialog-leave-to .save-dialog-container {
  transform: scale(0.95);
  opacity: 0;
}
</style>
