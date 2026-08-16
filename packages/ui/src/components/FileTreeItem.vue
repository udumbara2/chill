<template>
  <div class="file-tree-item">
    <div
      class="file-item-row"
      :style="{ paddingLeft: level * 16 + 'px' }"
      :class="{ 'is-directory': item.type === 'directory', 'is-editing': isEditing }"
      @click="handleClick"
      @contextmenu.prevent.stop="handleContextMenu"
    >
      <span class="file-icon">
        <svg v-if="item.type === 'directory'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path v-if="isExpanded" d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          <path v-else d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </span>
      <template v-if="isEditing">
        <input
          ref="editInputRef"
          v-model="editName"
          type="text"
          class="edit-input"
          @click.stop
          @keyup.enter="handleRenameConfirm"
          @keyup.escape="handleRenameCancel"
          @blur="handleRenameConfirm"
        />
      </template>
      <template v-else>
        <span class="file-name">{{ item.name }}</span>
        <span v-if="item.type === 'directory'" class="expand-icon">
          <svg v-if="isExpanded" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </span>
      </template>
    </div>
    <div v-if="item.type === 'directory' && isExpanded" class="file-children">
      <FileTreeItem
        v-for="child in children"
        :key="child.id"
        :item="child"
        :all-files="allFiles"
        :expanded-ids="expandedIds"
        :level="level + 1"
        :editing-id="editingId"
        @toggle="$emit('toggle', $event)"
        @file-click="$emit('file-click', $event)"
        @context-menu="$emit('context-menu', $event)"
        @rename-confirm="$emit('rename-confirm', $event)"
        @rename-cancel="$emit('rename-cancel')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'

interface FileItem {
  id: string
  name: string
  path: string
  type: 'file' | 'directory'
  parentId: string | null
}

const props = defineProps<{
  item: FileItem
  allFiles: FileItem[]
  expandedIds: Set<string>
  level: number
  editingId?: string | null
}>()

const emit = defineEmits<{
  (e: 'toggle', id: string): void
  (e: 'file-click', path: string): void
  (e: 'context-menu', data: { item: FileItem; x: number; y: number }): void
  (e: 'rename-confirm', data: { item: FileItem; newName: string }): void
  (e: 'rename-cancel'): void
}>()

const editInputRef = ref<HTMLInputElement | null>(null)
const editName = ref('')
const isRenameConfirmed = ref(false)

const isExpanded = computed(() => props.expandedIds.has(props.item.id))

const isEditing = computed(() => props.editingId === props.item.id)

const children = computed(() => {
  return props.allFiles.filter(f => f.parentId === props.item.id)
})

watch(isEditing, async (newVal) => {
  if (newVal) {
    editName.value = props.item.name
    isRenameConfirmed.value = false
    await nextTick()
    editInputRef.value?.focus()
    editInputRef.value?.select()
  }
})

const handleClick = () => {
  if (isEditing.value) return
  if (props.item.type === 'directory') {
    emit('toggle', props.item.id)
  } else {
    emit('file-click', props.item.path)
  }
}

const handleContextMenu = (event: MouseEvent) => {
  emit('context-menu', { item: props.item, x: event.clientX, y: event.clientY })
}

const handleRenameConfirm = () => {
  if (isRenameConfirmed.value) return
  isRenameConfirmed.value = true
  
  const trimmedName = editName.value.trim()
  if (trimmedName && trimmedName !== props.item.name) {
    emit('rename-confirm', { item: props.item, newName: trimmedName })
  } else {
    emit('rename-cancel')
  }
}

const handleRenameCancel = () => {
  editName.value = props.item.name
  emit('rename-cancel')
}
</script>

<style scoped>
.file-tree-item {
  user-select: none;
}

.file-item-row {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background-color var(--transition-fast);
}

.file-item-row:hover {
  background-color: var(--background-secondary);
}

.file-item-row.is-directory {
  font-weight: 500;
}

.file-icon {
  display: flex;
  align-items: center;
  margin-right: 6px;
  color: var(--text-secondary);
}

.file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.expand-icon {
  display: flex;
  align-items: center;
  color: var(--text-secondary);
  margin-left: 4px;
}

.file-children {
  border-left: 1px solid var(--border-color);
  margin-left: 12px;
}

.edit-input {
  flex: 1;
  padding: 2px 6px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background-color: var(--background-primary);
  color: var(--text-primary);
  outline: none;
}

.edit-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}
</style>
