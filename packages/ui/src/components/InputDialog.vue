<template>
  <Teleport to="body">
    <Transition name="input-dialog">
      <div v-if="isOpen" class="input-dialog-overlay" @click="handleCancel">
        <div class="input-dialog-container" @click.stop>
          <div class="input-dialog-header">
            <h3 class="input-dialog-title">{{ title }}</h3>
          </div>
          <div class="input-dialog-body">
            <input
              ref="inputRef"
              v-model="inputValue"
              type="text"
              class="input-dialog-input"
              :placeholder="placeholder"
              @keyup.enter="handleConfirm"
              @keyup.escape="handleCancel"
            />
          </div>
          <div class="input-dialog-footer">
            <button class="input-dialog-button cancel-button" @click="handleCancel">
              取消
            </button>
            <button class="input-dialog-button confirm-button" @click="handleConfirm">
              确定
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

interface Props {
  isOpen?: boolean
  title?: string
  placeholder?: string
  defaultValue?: string
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: false,
  title: '输入',
  placeholder: '',
  defaultValue: ''
})

const emit = defineEmits<{
  confirm: [value: string]
  cancel: []
}>()

const inputRef = ref<HTMLInputElement | null>(null)
const inputValue = ref('')

watch(() => props.isOpen, async (newVal) => {
  if (newVal) {
    inputValue.value = props.defaultValue
    await nextTick()
    inputRef.value?.focus()
    inputRef.value?.select()
  }
})

const handleConfirm = () => {
  if (inputValue.value.trim()) {
    emit('confirm', inputValue.value.trim())
  }
}

const handleCancel = () => {
  emit('cancel')
}
</script>

<style scoped>
.input-dialog-overlay {
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

.input-dialog-container {
  background-color: var(--background-primary, #ffffff);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 320px;
  max-width: 480px;
  padding: 24px;
}

.input-dialog-header {
  margin-bottom: 16px;
}

.input-dialog-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary, #111827);
}

.input-dialog-body {
  margin-bottom: 24px;
}

.input-dialog-input {
  width: 100%;
  padding: 8px 12px;
  font-size: 14px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  background-color: var(--background-primary, #ffffff);
  color: var(--text-primary, #111827);
  outline: none;
  box-sizing: border-box;
}

.input-dialog-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.input-dialog-input::placeholder {
  color: var(--text-tertiary, #9ca3af);
}

.input-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.input-dialog-button {
  padding: 8px 20px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
  outline: none;
}

.cancel-button {
  background-color: var(--background-secondary, #f3f4f6);
  color: var(--text-primary, #111827);
}

.cancel-button:hover {
  background-color: var(--background-tertiary, #e5e7eb);
}

.confirm-button {
  background-color: #3b82f6;
  color: white;
}

.confirm-button:hover {
  background-color: #2563eb;
}

.input-dialog-enter-active,
.input-dialog-leave-active {
  transition: opacity 0.2s ease;
}

.input-dialog-enter-from,
.input-dialog-leave-to {
  opacity: 0;
}

.input-dialog-enter-to,
.input-dialog-leave-from {
  opacity: 1;
}
</style>
