<template>
  <div class="text-input">
    <textarea
      :value="value"
      :placeholder="placeholder"
      class="input-textarea"
      rows="3"
      @input="handleInput"
    ></textarea>
  </div>
</template>

<script setup lang="ts">
interface Props {
  value?: string
  placeholder?: string
}

const emit = defineEmits<{
  'update:value': [value: string]
}>()

withDefaults(defineProps<Props>(), {
  value: '',
  placeholder: '输入系统提示词...'
})

function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  emit('update:value', target.value)
}
</script>

<style scoped>
.text-input {
  width: 100%;
}

.input-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-primary, #111827);
  background-color: var(--background-primary, #ffffff);
  resize: vertical;
  min-height: 60px;
  max-height: 150px;
  line-height: 1.4;
}

.input-textarea:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.input-textarea::placeholder {
  color: var(--text-tertiary, #9ca3af);
}
</style>
