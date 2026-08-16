<template>
  <div class="collapsible-panel">
    <div class="panel-header" @click="toggle">
      <span class="panel-title">{{ title }}</span>
      <div class="panel-header-right">
        <slot name="header-actions"></slot>
        <svg 
          class="panel-icon" 
          :class="{ 'expanded': isExpanded }"
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </div>
    </div>
    <transition name="panel-content">
      <div v-show="isExpanded" class="panel-content">
        <slot></slot>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

interface Props {
  title?: string
  defaultExpanded?: boolean
  expanded?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  defaultExpanded: false,
  expanded: undefined
})

const isExpanded = ref(props.defaultExpanded)

const toggle = () => {
  isExpanded.value = !isExpanded.value
}

watch(() => props.expanded, (newExpanded) => {
  if (newExpanded !== undefined) {
    isExpanded.value = newExpanded
  }
})

defineExpose({
  isExpanded,
  toggle
})
</script>

<style scoped>
.collapsible-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s;
  border-radius: 6px;
  background-color: var(--background-secondary, #f9fafb);
  border: 1px solid var(--border-color-light, #f3f4f6);
}

.panel-header:hover {
  background-color: var(--border-color, #e5e7eb);
}

.panel-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary, #6b7280);
}

.panel-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-icon {
  width: 14px;
  height: 14px;
  transition: transform 0.2s;
  flex-shrink: 0;
  color: var(--text-secondary, #6b7280);
}

.panel-icon.expanded {
  transform: rotate(90deg);
}

.panel-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.panel-content-enter-active,
.panel-content-leave-active {
  transition: all 0.3s ease;
  max-height: 500px;
  opacity: 1;
  overflow: hidden;
}

.panel-content-enter-from,
.panel-content-leave-to {
  max-height: 0;
  opacity: 0;
}
</style>
