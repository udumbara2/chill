<template>
  <select
    class="ac-input"
    :value="modelValue"
    :disabled="disabled"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option value="">无（默认，无独立记忆空间）</option>
    <option value="user">user 个人（跨项目通用）</option>
    <option value="project">project 项目（随项目共享）</option>
    <option value="local">local 本地（仅本机目录）</option>
  </select>
</template>

<script setup lang="ts">
/**
 * 记忆作用域下拉（AgentEditor 与 ModelNode 共用）
 */
withDefaults(defineProps<{ modelValue: string; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<style scoped>
.ac-input {
  width: 100%;
  padding: 0.375rem 0.5rem;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 0.8125rem;
  color: #1f2937;
  background: #fff;
}
.ac-input:focus {
  outline: none;
  border-color: #8b5cf6;
}
</style>
