<template>
  <Teleport to="body">
    <Transition name="confirm-dialog">
      <div v-if="isOpen" class="confirm-dialog-overlay" @click="handleCancel">
        <div class="confirm-dialog-container" @click.stop>
          <div class="confirm-dialog-header">
            <h3 class="confirm-dialog-title">{{ title }}</h3>
          </div>
          <div class="confirm-dialog-body">
            <p class="confirm-dialog-message">{{ message }}</p>
          </div>
          <div class="confirm-dialog-footer">
            <button class="confirm-dialog-button cancel-button" @click="handleCancel">
              取消
            </button>
            <button class="confirm-dialog-button confirm-button" @click="handleConfirm">
              确定
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
interface Props {
  isOpen?: boolean
  title?: string
  message?: string
}

withDefaults(defineProps<Props>(), {
  isOpen: false,
  title: '确认',
  message: '确定要执行此操作吗？'
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const handleConfirm = () => {
  emit('confirm')
}

const handleCancel = () => {
  emit('cancel')
}
</script>

<style scoped>
.confirm-dialog-overlay {
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

.confirm-dialog-container {
  background-color: var(--background-primary, #ffffff);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 320px;
  max-width: 480px;
  padding: 24px;
}

.confirm-dialog-header {
  margin-bottom: 16px;
}

.confirm-dialog-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary, #111827);
}

.confirm-dialog-body {
  margin-bottom: 24px;
}

.confirm-dialog-message {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary, #6b7280);
  line-height: 1.5;
  white-space: pre-line;
}

.confirm-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.confirm-dialog-button {
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
  background-color: #ef4444;
  color: white;
}

.confirm-button:hover {
  background-color: #dc2626;
}

.confirm-dialog-enter-active,
.confirm-dialog-leave-active {
  transition: opacity 0.2s ease;
}

.confirm-dialog-enter-from,
.confirm-dialog-leave-to {
  opacity: 0;
}

.confirm-dialog-enter-to,
.confirm-dialog-leave-from {
  opacity: 1;
}
</style>
