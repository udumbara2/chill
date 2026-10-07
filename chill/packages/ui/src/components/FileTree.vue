<template>
  <div class="file-tree-container" @click="handleContainerClick" @contextmenu.prevent="handleRootContextMenu">
    <div v-if="files.length === 0" class="file-tree-empty">
      暂无文件
    </div>
    <div v-else class="file-tree-list">
      <FileTreeItem
        v-for="item in rootItems"
        :key="item.id"
        :item="item"
        :all-files="files"
        :expanded-ids="expanded"
        :loading-dirs="loadingDirs"
        :error-of="errorOf"
        :level="0"
        :editing-id="editingId"
        @toggle="toggleExpand"
        @retry="handleRetry"
        @file-click="handleFileClick"
        @context-menu="handleContextMenu"
        @rename-confirm="handleRenameConfirm"
        @rename-cancel="handleRenameCancel"
      />
    </div>
    <FileContextMenu
      :is-open="contextMenuOpen"
      :x="contextMenuX"
      :y="contextMenuY"
      :item="contextMenuItem"
      :root-path="rootPath"
      @rename="handleMenuRename"
      @delete="handleMenuDelete"
      @restore-backup="handleMenuRestoreBackup"
      @create-file="handleMenuCreateFile"
      @create-folder="handleMenuCreateFolder"
      @close="closeContextMenu"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import FileTreeItem from './FileTreeItem.vue'
import FileContextMenu from './FileContextMenu.vue'

interface FileItem {
  id: string
  name: string
  path: string
  type: 'file' | 'directory'
  parentId: string | null
}

const props = defineProps<{
  files: FileItem[]
  rootPath?: string
  /** 已展开目录（受控：fileTreeStore 的归一化键集合；展开状态数据层持有，组件重挂不丢） */
  expanded: Set<string>
  /** 取数中目录（归一化键集合，目录行「加载中…」提示数据源） */
  loadingDirs: Set<string>
  /** 取数失败信息（归一化键 → 文案，目录行「无法访问（点击重试）」数据源） */
  errorOf: Map<string, string>
}>()

const emit = defineEmits<{
  (e: 'file-click', path: string): void
  (e: 'file-delete', item: FileItem): void
  (e: 'file-restore', item: FileItem): void
  (e: 'file-rename', data: { item: FileItem; newName: string }): void
  (e: 'file-create', data: { parentPath: string; type: 'file' | 'directory' }): void
  /** 展开/收起点击上抛（条目 id = 原始路径；store toggleExpand 内部归一） */
  (e: 'toggle', id: string): void
  /** 错误条目「点击重试」上抛（条目 id = 原始路径） */
  (e: 'retry', id: string): void
}>()

const editingId = ref<string | null>(null)

const contextMenuOpen = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuItem = ref<FileItem | null>(null)

const rootItems = computed(() => {
  return props.files.filter(f => f.parentId === null)
})

const toggleExpand = (id: string) => {
  emit('toggle', id)
}

const handleRetry = (id: string) => {
  emit('retry', id)
}

const handleFileClick = (path: string) => {
  emit('file-click', path)
}

const handleContainerClick = () => {
  closeContextMenu()
}

const handleRootContextMenu = (event: MouseEvent) => {
  if (!props.rootPath) return
  contextMenuItem.value = null
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuOpen.value = true
}

const handleContextMenu = (data: { item: FileItem; x: number; y: number }) => {
  contextMenuItem.value = data.item
  contextMenuX.value = data.x
  contextMenuY.value = data.y
  contextMenuOpen.value = true
}

const closeContextMenu = () => {
  contextMenuOpen.value = false
  contextMenuItem.value = null
}

const handleMenuRename = (item: FileItem) => {
  editingId.value = item.id
}

const handleMenuDelete = (item: FileItem) => {
  emit('file-delete', item)
}

const handleMenuRestoreBackup = (item: FileItem) => {
  emit('file-restore', item)
}

const handleMenuCreateFile = (parentPath: string) => {
  emit('file-create', { parentPath, type: 'file' })
}

const handleMenuCreateFolder = (parentPath: string) => {
  emit('file-create', { parentPath, type: 'directory' })
}

const handleRenameConfirm = (data: { item: FileItem; newName: string }) => {
  emit('file-rename', data)
  editingId.value = null
}

const handleRenameCancel = () => {
  editingId.value = null
}

const handleGlobalClick = () => {
  closeContextMenu()
}

onMounted(() => {
  document.addEventListener('click', handleGlobalClick)
})

onUnmounted(() => {
  document.removeEventListener('click', handleGlobalClick)
})
</script>

<style scoped>
.file-tree-container {
  width: 100%;
  height: 100%;
  overflow: auto;
}

.file-tree-list {
  padding: var(--spacing-2);
}

.file-tree-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 14px;
}
</style>
