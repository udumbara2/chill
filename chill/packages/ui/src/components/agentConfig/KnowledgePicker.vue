<template>
  <div class="ac-picker">
    <div v-if="!availableKnowledge.length" class="ac-dim">暂无知识库（可先在知识库设置中创建）</div>
    <label v-for="k in availableKnowledge" :key="k.name" class="ac-check ac-check-block">
      <input type="checkbox" :checked="modelValue.includes(k.name)" @change="toggle(k.name)" :disabled="disabled" />
      <span class="ac-check-name">{{ k.name }}</span>
      <span class="ac-dim">{{ k.description }}</span>
    </label>
    <div class="ac-hint">不选 = 不绑定知识库</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { knowledgeStore } from '@assistant-ai/core'

/**
 * 知识库复选组（AgentEditor 与 ModelNode 共用；数据源 = knowledgeStore）
 */
const props = withDefaults(defineProps<{ modelValue: string[]; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const availableKnowledge = ref<Array<{ name: string; description?: string }>>([])
knowledgeStore.listKnowledgeBases().then((list) => {
  availableKnowledge.value = list.map((k) => ({ name: k.name, description: k.description }))
}).catch(() => {})

function toggle(name: string): void {
  const next = props.modelValue.includes(name)
    ? props.modelValue.filter((s) => s !== name)
    : [...props.modelValue, name]
  emit('update:modelValue', next)
}
</script>

<style scoped>
.ac-picker {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.ac-dim {
  font-size: 0.75rem;
  font-weight: 400;
  color: #9ca3af;
}
.ac-hint {
  font-size: 0.6875rem;
  color: #9ca3af;
}
.ac-check {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: #374151;
}
.ac-check-block {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
}
.ac-check-name {
  font-weight: 500;
  color: #1f2937;
}
</style>
