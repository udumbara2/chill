<template>
  <div class="boolean-toggle-container">
    <div class="toggle-switch" :class="{ 'toggle-enabled': value }" @click="toggleValue">
      <div class="toggle-slider" :class="{ 'slider-enabled': value }"></div>
    </div>
    <span class="toggle-label" :class="{ 'label-enabled': value }">
      {{ value ? '启用' : '禁用' }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  modelValue: boolean;
  label?: string;
}

interface Emits {
  'update:modelValue': [value: boolean];
}

const props = withDefaults(defineProps<Props>(), {
  label: ''
});

const emit = defineEmits<Emits>();

const value = computed({
  get: () => props.modelValue,
  set: (val: boolean) => emit('update:modelValue', val)
});

const toggleValue = () => {
  value.value = !value.value;
};
</script>

<style scoped>
.boolean-toggle-container {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toggle-switch {
  position: relative;
  width: 48px;
  height: 24px;
  background-color: #ccc;
  border-radius: 12px;
  cursor: pointer;
  transition: background-color 0.3s ease;
  border: 2px solid #ddd;
}

.toggle-enabled {
  background-color: #4a90e2;
  border-color: #357abd;
}

.toggle-slider {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 18px;
  height: 18px;
  background-color: white;
  border-radius: 50%;
  transition: transform 0.3s ease;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.slider-enabled {
  transform: translateX(24px);
}

.toggle-label {
  font-size: 14px;
  color: #666;
  font-weight: 500;
  min-width: 32px;
  transition: color 0.3s ease;
}

.label-enabled {
  color: #4a90e2;
}

/* 悬停效果 */
.toggle-switch:hover {
  border-color: #4a90e2;
}
</style>