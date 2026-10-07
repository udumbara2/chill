<template>
  <div class="editor-tabs">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="editor-tab"
      :class="{ 'is-active': tab.id === activeTabId }"
      @click="$emit('tab-click', tab.id)"
    >
      <span class="tab-name">{{ tab.name }}</span>
      <button
        class="tab-close"
        @click.stop="$emit('tab-close', tab.id)"
        title="关闭"
      >
        ×
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface TabItem {
  id: string
  name: string
  path: string
  isHtml?: boolean
}

defineProps<{
  tabs: TabItem[]
  activeTabId: string | null
}>()

defineEmits<{
  'tab-click': [id: string]
  'tab-close': [id: string]
}>()
</script>

<style scoped>
.editor-tabs {
  display: flex;
  align-items: center;
  background-color: var(--background-secondary);
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  flex-shrink: 0;
}

.editor-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-right: 1px solid var(--border-color);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  background-color: var(--background-secondary);
  transition: all 0.2s;
  white-space: nowrap;
}

.editor-tab:hover {
  background-color: var(--background-hover);
  color: var(--text-primary);
}

.editor-tab.is-active {
  background-color: var(--background-primary);
  color: var(--text-primary);
  border-bottom: 2px solid var(--primary-color);
}

.tab-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition: all 0.2s;
}

.tab-close:hover {
  background-color: rgba(0, 0, 0, 0.1);
  color: var(--text-primary);
}
</style>
