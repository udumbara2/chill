<template>
  <div class="ac-picker">
    <div v-if="!availableSkills.length" class="ac-dim">暂无已启用的技能</div>
    <label v-for="s in availableSkills" :key="s.name" class="ac-check ac-check-block">
      <input type="checkbox" :checked="modelValue.includes(s.name)" @change="toggle(s.name)" :disabled="disabled" />
      <span class="ac-check-name">{{ s.name }}</span>
      <span class="ac-dim">{{ s.description }}</span>
    </label>
    <div class="ac-hint">不选 = 不预载技能（它仍可用通用能力）</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { getSkillRegistry } from '@assistant-ai/core'

/**
 * 技能复选组（AgentEditor 与 ModelNode 共用；数据源 = 已启用技能注册表）
 */
const props = withDefaults(defineProps<{ modelValue: string[]; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const availableSkills = computed(() => {
  try {
    return getSkillRegistry().getEnabled()
  } catch {
    return []
  }
})

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
