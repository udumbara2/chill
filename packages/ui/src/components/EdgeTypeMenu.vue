<template>
  <div class="edge-type-menu" :style="menuStyle">
    <div v-if="showDefault" class="menu-item" @click="handleSelectDefault">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="4" y1="20" x2="20" y2="20"/>
        <line x1="4" y1="4" x2="20" y2="4"/>
        <line x1="4" y1="4" x2="4" y2="20"/>
        <line x1="20" y1="4" x2="20" y2="20"/>
      </svg>
      <span class="menu-label">无条件</span>
    </div>
    <div class="menu-item" @click="handleSelectConditional">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="4" y1="20" x2="20" y2="20"/>
        <line x1="4" y1="4" x2="20" y2="4"/>
        <line x1="4" y1="4" x2="4" y2="20"/>
        <line x1="20" y1="4" x2="20" y2="20"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
      <span class="menu-label">添加条件</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  x?: number
  y?: number
  showDefault?: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  select: [type: 'default' | 'conditional']
}>()

const menuStyle = computed(() => ({
  left: `${props.x || 0}px`,
  top: `${props.y || 0}px`
}))

const handleSelectDefault = () => {
  emit('select', 'default')
}

const handleSelectConditional = () => {
  emit('select', 'conditional')
}
</script>

<style scoped>
.edge-type-menu {
  position: fixed;
  background: white;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 8px 0;
  min-width: 150px;
  z-index: 1000;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background-color 0.2s;
  border-radius: 4px;
}

.menu-item:hover {
  background-color: #f3f4f6;
}

.menu-item svg {
  color: #6b7280;
}

.menu-item:hover svg {
  color: #3b82f6;
}

.menu-label {
  font-size: 14px;
  color: #374151;
  font-weight: 500;
}
</style>
