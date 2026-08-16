<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="file-context-menu"
      :style="{ left: x + 'px', top: y + 'px' }"
    >
      <template v-if="item">
        <div class="menu-item" @click="handleRename">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          <span>重命名</span>
        </div>
        <div class="menu-item" @click="handleDelete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          <span>删除</span>
        </div>
        <template v-if="item.type === 'directory'">
          <div class="menu-divider"></div>
          <div class="menu-item" @click="handleCreateFile">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
            <span>新建文件</span>
          </div>
          <div class="menu-item" @click="handleCreateFolder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/>
              <line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
            <span>新建文件夹</span>
          </div>
        </template>
      </template>
      <template v-else-if="rootPath">
        <div class="menu-item" @click="handleCreateFile">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="18" x2="12" y2="12"/>
            <line x1="9" y1="15" x2="15" y2="15"/>
          </svg>
          <span>新建文件</span>
        </div>
        <div class="menu-item" @click="handleCreateFolder">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
          <span>新建文件夹</span>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
interface FileItem {
  id: string
  name: string
  path: string
  type: 'file' | 'directory'
  parentId: string | null
}

interface Props {
  isOpen?: boolean
  x?: number
  y?: number
  item?: FileItem | null
  rootPath?: string
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: false,
  x: 0,
  y: 0,
  item: null,
  rootPath: ''
})

const emit = defineEmits<{
  rename: [item: FileItem]
  delete: [item: FileItem]
  'create-file': [parentPath: string]
  'create-folder': [parentPath: string]
  close: []
}>()

const handleRename = () => {
  if (props.item) {
    emit('rename', props.item)
  }
  emit('close')
}

const handleDelete = () => {
  if (props.item) {
    emit('delete', props.item)
  }
  emit('close')
}

const handleCreateFile = () => {
  const parentPath = props.item?.path || props.rootPath
  if (parentPath) {
    emit('create-file', parentPath)
  }
  emit('close')
}

const handleCreateFolder = () => {
  const parentPath = props.item?.path || props.rootPath
  if (parentPath) {
    emit('create-folder', parentPath)
  }
  emit('close')
}
</script>

<style scoped>
.file-context-menu {
  position: fixed;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 160px;
  padding: 4px 0;
  z-index: 10001;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary, #111827);
  transition: background-color 0.15s;
}

.menu-item:hover {
  background-color: var(--background-secondary, #f3f4f6);
}

.menu-item svg {
  flex-shrink: 0;
  color: var(--text-secondary, #6b7280);
}

.menu-divider {
  height: 1px;
  background-color: var(--border-color, #e5e7eb);
  margin: 4px 0;
}
</style>
