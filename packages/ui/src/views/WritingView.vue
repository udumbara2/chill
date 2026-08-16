<template>
  <div class="writing-view-layout">
    <!-- 顶部工具栏（编辑器自持：打开文件下拉，自 Home 菜单行迁入） -->
    <div class="writing-toolbar">
      <div class="open-folder-dropdown">
        <button
          class="open-folder-btn"
          @click="handleOpenFolderClick"
          title="打开文件"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
        <div
          v-if="showFolderDropdown"
          class="dropdown-menu"
          @mouseleave="showFolderDropdown = false"
        >
          <div class="dropdown-item" @click="handleOpenFolder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            打开文件夹
          </div>
          <div class="dropdown-item" @click="handleOpenFile">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            打开文件
          </div>
        </div>
      </div>
    </div>

    <div class="writing-body">
    <!-- 文件浏览器侧边栏 -->
    <div
      v-if="currentDirectory && showSidebar"
      class="writing-sidebar"
      :style="{ width: sidebarWidth + 'px' }"
    >
      <div class="sidebar-header">
        <span class="sidebar-title">{{ directoryName }}</span>
      </div>
      <div class="sidebar-content">
        <FileTree
          :files="files"
          :root-path="currentDirectory || ''"
          @file-click="handleFileClick"
          @file-delete="handleFileDelete"
          @file-rename="handleFileRename"
          @file-create="handleFileCreate"
        />
      </div>
      <!-- 拖拽调整手柄 -->
      <div class="sidebar-resize-handle" @mousedown="startResizeSidebar"></div>
    </div>

    <!-- 侧边栏拉出触发区域（当侧边栏关闭时显示） -->
    <div
      v-if="currentDirectory && !showSidebar"
      class="sidebar-pull-trigger"
      @mousedown="startPullSidebar"
      title="拖拽以打开文件列表"
    ></div>

    <!-- 写作模块主视图 -->
    <div class="writing-main-content">
      <div v-if="!currentDirectory" class="writing-placeholder">
        <span>请点击"打开文件夹"选择一个目录</span>
      </div>
      <div v-else class="writing-editor-container">
        <EditorTabs
          :tabs="tabs"
          :active-tab-id="activeTabId"
          @tab-click="handleTabClick"
          @tab-close="handleTabClose"
        />
        <TextEditor
          v-if="activeTabId"
          ref="editorRef"
          :content="currentFileContent"
          :save-status="saveStatus"
          :file-path="currentFilePath"
          :editable="!readonly"
          @save="handleSave"
          @content-change="handleContentChange"
        />
        <div v-if="activeTabId && hasPendingOperationsForCurrentFile" class="pending-operations-warning">
          当前文件有待确认的修改，请先确认或拒绝
        </div>
        <div v-if="formatLossWarning" class="format-loss-warning">
          已按纯文本保存：加粗/标题/列表等富文本格式不会保留（markdown/纯文本内容全保真，不受影响）
        </div>
        <div v-if="!activeTabId" class="writing-editor-placeholder">
          <span>选择文件以编辑</span>
        </div>
      </div>
    </div>
    <ConfirmDialog
      :is-open="deleteConfirmOpen"
      title="确认删除"
      :message="deleteConfirmMessage"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
    <ConfirmDialog
      :is-open="closeConfirmOpen"
      title="未保存的修改"
      message="该文件有未保存的修改，关闭将丢失这些修改。仍要关闭吗？"
      @confirm="confirmCloseTab"
      @cancel="cancelCloseTab"
    />
    <InputDialog
      :is-open="createDialogOpen"
      :title="createDialogTitle"
      :placeholder="createDialogPlaceholder"
      @confirm="confirmCreate"
      @cancel="cancelCreate"
    />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import FileTree from '../components/FileTree.vue'
import TextEditor from '../components/TextEditor.vue'
import EditorTabs from '../components/EditorTabs.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import InputDialog from '../components/InputDialog.vue'
import { useWritingViewStore } from '../stores/writingViewStore'
import { usePendingOperationsStore, type PendingOperation } from '../stores/pendingOperationsStore'
import { useResizablePanel } from '../composables/useResizablePanel'
import { eventBus, EVENTS } from '@assistant-ai/core'
import { safeGenerateSnapshot } from '../utils/snapshotManager'
import type { DiffOperation } from '../extensions/DiffPreviewExtension'

interface FileItem {
  id: string
  name: string
  path: string
  type: 'file' | 'directory'
  parentId: string | null
}

const props = withDefaults(defineProps<{
  /** 只看/参与意图（ContentDock 传入）：true 时编辑器只读、禁保存 */
  readonly?: boolean
}>(), {
  readonly: false
})

const writingViewStore = useWritingViewStore()
const pendingOperationsStore = usePendingOperationsStore()

// tabs/tabContents/activeTabId 已上提 writingViewStore（编辑器销毁/重挂不丢状态）
const { tabs, activeTabId, tabContents } = storeToRefs(writingViewStore)

const files = ref<FileItem[]>([])
// 初值取自 store：编辑器随 dock 渲染分层销毁/重挂时，目录归属不丢（重挂后 onMounted 重列文件树）
const currentDirectory = ref<string | null>(writingViewStore.currentDirectory)
const editorRef = ref<InstanceType<typeof TextEditor> | null>(null)
const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
// 格式保真范围明示：富文本格式（加粗/标题等）保存即丢，保存时在 UI 提示
const formatLossWarning = ref(false)
let formatLossWarningTimer: ReturnType<typeof setTimeout> | null = null

const deleteConfirmOpen = ref(false)
const deleteConfirmMessage = ref('')
const pendingDeleteItem = ref<FileItem | null>(null)

const createDialogOpen = ref(false)
const createDialogTitle = ref('')
const createDialogPlaceholder = ref('')
const pendingCreateData = ref<{ parentPath: string; type: 'file' | 'directory' } | null>(null)

const plainTextToHtml = (text: string): string => {
  if (!text) return '<p></p>'
  const lines = text.split('\n')
  return lines.map(line => `<p>${line || '&nbsp;'}</p>`).join('')
}

// 富文本格式检测：htmlToPlainText 会丢弃这些标签（加粗/标题/列表等），保存时据此提示有损
const RICH_TEXT_TAG_RE = /<(strong|b|em|i|u|s|del|ins|mark|h[1-6]|ul|ol|li|blockquote|code|pre|a|hr)[\s/>]/i

const htmlToPlainText = (html: string): string => {
  if (!html) return ''
  let text = html
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  text = text.replace(/\n$/, '')
  return text
}

// 侧边栏显示/隐藏与拖拽调宽（并入 useResizablePanel；collapsed 即原 showSidebar 取反）
const {
  width: sidebarWidth,
  collapsed: sidebarCollapsed,
  startResize: startResizeSidebar,
  startPull
} = useResizablePanel({
  defaultWidth: 250,
  minWidth: 200,
  maxWidth: 400,
  collapseThreshold: 100,
  direction: 'right'
})

// 保留原 showSidebar 读写语义（loadFiles 等处直接赋值）
const showSidebar = computed({
  get: () => !sidebarCollapsed.value,
  set: (v: boolean) => { sidebarCollapsed.value = !v }
})

const startPullSidebar = (e: MouseEvent) => startPull(e)

const directoryName = computed(() => {
  if (!currentDirectory.value) return ''
  const parts = currentDirectory.value.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || currentDirectory.value
})

const loadFiles = (newFiles: FileItem[], directory: string) => {
  const isNewDirectory = currentDirectory.value !== directory
  files.value = newFiles
  currentDirectory.value = directory
  if (isNewDirectory) {
    showSidebar.value = true
    sidebarWidth.value = 250
  }
}

// 顶部工具栏：打开文件下拉菜单显示状态
const showFolderDropdown = ref(false)

// 点击打开文件夹按钮（显示下拉菜单）
const handleOpenFolderClick = () => {
  showFolderDropdown.value = !showFolderDropdown.value
}

// 打开文件夹（自 Home 菜单行迁入，组件内直接调用）
const handleOpenFolder = async () => {
  showFolderDropdown.value = false
  try {
    const response = await window.electronAPI.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择文件夹'
    })

    if (!response.success) {
      console.error('打开对话框失败:', response.error)
      return
    }

    const result = response.result
    if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return
    }

    const selectedPath = result.filePaths[0]
    console.log('选择的目录:', selectedPath)

    const listResponse = await window.electronAPI.fileListDirectory(selectedPath)

    if (!listResponse.success) {
      console.error('获取文件列表失败:', listResponse.error)
      return
    }

    if (listResponse.files) {
      loadFiles(listResponse.files, selectedPath)
    }

    await window.electronAPI.fileWatchStart(selectedPath)

  } catch (error) {
    console.error('打开文件夹时发生错误:', error)
  }
}

// 打开文件（自 Home 菜单行迁入，组件内直接调用）
const handleOpenFile = async () => {
  showFolderDropdown.value = false
  try {
    const response = await window.electronAPI.showOpenDialog({
      properties: ['openFile'],
      title: '选择文件'
    })

    if (!response.success) {
      console.error('打开对话框失败:', response.error)
      return
    }

    const result = response.result
    if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return
    }

    const selectedPath = result.filePaths[0]
    console.log('选择的文件:', selectedPath)

    await handleFileClick(selectedPath)

  } catch (error) {
    console.error('打开文件时发生错误:', error)
  }
}

const isHtmlFile = (path: string): boolean => {
  return path.toLowerCase().endsWith('.html') || path.toLowerCase().endsWith('.htm')
}

const handleFileClick = async (path: string) => {
  const existingTab = tabs.value.find(tab => tab.path === path)
  
  if (existingTab) {
    activeTabId.value = existingTab.id
    return
  }

  try {
    const response = await window.electronAPI.fileRead(path)
    
    if (response.success && response.content !== undefined) {
      if (!currentDirectory.value) {
        const dirPath = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
        currentDirectory.value = dirPath
      }
      const fileName = path.replace(/\\/g, '/').split('/').pop() || path
      const tabId = `tab-${Date.now()}`
      tabs.value.push({ id: tabId, name: fileName, path, isHtml: isHtmlFile(path) })
      const content = isHtmlFile(path) 
        ? `<pre style="white-space: pre-wrap; word-wrap: break-word; font-family: monospace; padding: 16px;">${response.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`
        : plainTextToHtml(response.content)
      
      tabContents.value[tabId] = content
      activeTabId.value = tabId
      
      setTimeout(() => {
        safeGenerateSnapshot(
          path,
          () => editorRef.value?.getSnapshot() || null,
          pendingOperationsStore
        )
      }, 100)
    } else {
      console.error('读取文件失败:', response.error)
    }
  } catch (error) {
    console.error('读取文件时发生错误:', error)
  }
}

const handleFileDelete = (item: FileItem) => {
  pendingDeleteItem.value = item
  deleteConfirmMessage.value = item.type === 'directory'
    ? `确定要删除文件夹"${item.name}"吗？\n文件夹内的所有文件都将被移到回收站。`
    : `确定要删除文件"${item.name}"吗？\n文件将被移到回收站。`
  deleteConfirmOpen.value = true
}

const confirmDelete = async () => {
  if (!pendingDeleteItem.value) return
  
  const item = pendingDeleteItem.value
  deleteConfirmOpen.value = false
  pendingDeleteItem.value = null
  
  try {
    const response = await window.electronAPI.fileDelete(item.path)
    if (response.success) {
      if (item.type === 'file') {
        closeTabByPath(item.path)
      } else {
        tabs.value = tabs.value.filter(tab => !tab.path.startsWith(item.path))
        Object.keys(tabContents.value).forEach(tabId => {
          const tab = tabs.value.find(t => t.id === tabId)
          if (!tab) {
            delete tabContents.value[tabId]
          }
        })
      }
    } else {
      console.error('删除失败:', response.error)
    }
  } catch (error) {
    console.error('删除时发生错误:', error)
  }
}

const cancelDelete = () => {
  deleteConfirmOpen.value = false
  pendingDeleteItem.value = null
}

const handleFileRename = async (data: { item: FileItem; newName: string }) => {
  const { item, newName } = data
  const oldPath = item.path
  const pathParts = oldPath.replace(/\\/g, '/').split('/')
  pathParts[pathParts.length - 1] = newName
  const newPath = pathParts.join('/')
  
  try {
    const response = await window.electronAPI.fileRename(oldPath, newPath)
    if (response.success) {
      if (item.type === 'file') {
        const tab = tabs.value.find(t => t.path === oldPath)
        if (tab) {
          tab.path = newPath
          tab.name = newName
        }
      } else {
        tabs.value.forEach(tab => {
          if (tab.path.startsWith(oldPath)) {
            tab.path = tab.path.replace(oldPath, newPath)
            const tabName = tab.path.replace(/\\/g, '/').split('/').pop() || tab.name
            tab.name = tabName
          }
        })
      }
    } else {
      console.error('重命名失败:', response.error)
    }
  } catch (error) {
    console.error('重命名时发生错误:', error)
  }
}

const handleFileCreate = (data: { parentPath: string; type: 'file' | 'directory' }) => {
  pendingCreateData.value = data
  createDialogTitle.value = data.type === 'file' ? '新建文件' : '新建文件夹'
  createDialogPlaceholder.value = data.type === 'file' ? '请输入文件名' : '请输入文件夹名'
  createDialogOpen.value = true
}

const confirmCreate = async (name: string) => {
  if (!pendingCreateData.value) return
  
  const { parentPath, type } = pendingCreateData.value
  createDialogOpen.value = false
  pendingCreateData.value = null
  
  const newPath = `${parentPath}/${name}`.replace(/\\/g, '/')
  
  try {
    const response = type === 'file'
      ? await window.electronAPI.fileCreate(newPath)
      : await window.electronAPI.fileMkdir(newPath)
    
    if (!response.success) {
      console.error('创建失败:', response.error)
    }
  } catch (error) {
    console.error('创建时发生错误:', error)
  }
}

const cancelCreate = () => {
  createDialogOpen.value = false
  pendingCreateData.value = null
}

const reloadFile = async (path: string) => {
  const existingTab = tabs.value.find(tab => tab.path === path)
  
  try {
    const response = await window.electronAPI.fileRead(path)
    if (response.success && response.content !== undefined) {
      const content = isHtmlFile(path) 
        ? `<pre style="white-space: pre-wrap; word-wrap: break-word; font-family: monospace; padding: 16px;">${response.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`
        : plainTextToHtml(response.content)
      
      if (existingTab) {
        tabContents.value[existingTab.id] = content
        if (editorRef.value && activeTabId.value === existingTab.id) {
          pendingOperationsStore.clearDocumentSnapshot(path)
          editorRef.value.setContent(content)
          
          setTimeout(() => {
            safeGenerateSnapshot(
              path,
              () => editorRef.value?.getSnapshot() || null,
              pendingOperationsStore
            )
          }, 100)
        }
      } else {
        if (!currentDirectory.value) {
          const dirPath = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
          currentDirectory.value = dirPath
        }
        const fileName = path.replace(/\\/g, '/').split('/').pop() || path
        const tabId = `tab-${Date.now()}`
        tabs.value.push({ id: tabId, name: fileName, path, isHtml: isHtmlFile(path) })
        tabContents.value[tabId] = content
        activeTabId.value = tabId
        
        setTimeout(() => {
          safeGenerateSnapshot(
            path,
            () => editorRef.value?.getSnapshot() || null,
            pendingOperationsStore
          )
        }, 100)
      }
    } else {
      console.error('读取文件失败:', response.error)
    }
  } catch (error) {
    console.error('读取文件时发生错误:', error)
  }
}

const convertOperationsToTipTap = (operations: DiffOperation[]): DiffOperation[] => {
  return operations
}

const openFileWithDiff = async (filePath: string, _operations: DiffOperation[]) => {
  let existingTab = tabs.value.find(tab => tab.path === filePath)
  
  if (!existingTab) {
    try {
      const response = await window.electronAPI.fileRead(filePath)
      
      if (response.success && response.content !== undefined) {
        if (!currentDirectory.value) {
          const dirPath = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
          currentDirectory.value = dirPath
        }
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath
        const tabId = `tab-${Date.now()}`
        tabs.value.push({ id: tabId, name: fileName, path: filePath, isHtml: false })
        const content = plainTextToHtml(response.content)
        tabContents.value[tabId] = content
        activeTabId.value = tabId
        
        setTimeout(() => {
          safeGenerateSnapshot(
            filePath,
            () => editorRef.value?.getSnapshot() || null,
            pendingOperationsStore
          )
        }, 100)
      } else {
        const fileOps = pendingOperationsStore.getOperationsByFile(filePath)
        const createFileOp = fileOps.find((op: PendingOperation) => op.toolName === 'create_file')
        
        if (createFileOp) {
          if (!currentDirectory.value) {
            const dirPath = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
            currentDirectory.value = dirPath
          }
          const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath
          const tabId = `tab-${Date.now()}`
          tabs.value.push({ id: tabId, name: fileName, path: filePath, isHtml: false })
          
          const createContent = createFileOp.operations[0]?.insertContent || ''
          const content = plainTextToHtml(createContent)
          tabContents.value[tabId] = content
          activeTabId.value = tabId
          
          setTimeout(() => {
            safeGenerateSnapshot(
              filePath,
              () => editorRef.value?.getSnapshot() || null,
              pendingOperationsStore
            )
          }, 100)
        }
      }
    } catch (error) {
      console.error('读取文件失败:', error)
      return
    }
  } else {
    activeTabId.value = existingTab.id
  }
  
  setTimeout(() => {
    restoreDiffPreview(filePath)
  }, 100)
}

const clearDiffPreview = () => {
  if (editorRef.value) {
    editorRef.value.clearDiffPreview()
  }
}

const restoreDiffPreview = async (filePath: string) => {
  const fileOperations = pendingOperationsStore.getOperationsByFile(filePath)
  
  if (fileOperations.length === 0) {
    clearDiffPreview()
    return
  }
  
  const allOperations: DiffOperation[] = []
  const hasCreateFile = fileOperations.some((op: PendingOperation) => op.toolName === 'create_file')
  
  if (hasCreateFile && editorRef.value) {
    const docSize = editorRef.value.getDocSize?.() || 0
    if (docSize > 2) {
      allOperations.push({
        type: 'preview_file',
        from: 1,
        to: docSize - 1
      })
    }
  }
  
  fileOperations.forEach((op: PendingOperation) => {
    const diffOps = op.operations.filter(
      (o) => o.type === 'insert' || o.type === 'delete' || o.type === 'replace'
    ) as DiffOperation[]

    if (op.toolName !== 'create_file') {
      allOperations.push(...diffOps)
    }
  })
  
  if (editorRef.value) {
    const tipTapOperations = convertOperationsToTipTap(allOperations)
    editorRef.value.setDiffPreview(tipTapOperations)
  }
}

const handleTabClick = (tabId: string) => {
  activeTabId.value = tabId
}

// 关闭 tab：脏检查——有未保存修改时先弹确认（切换 tab 不丢内容，见 activeTabId watch 的回写）
const closeConfirmOpen = ref(false)
const pendingCloseTabId = ref<string | null>(null)

const handleTabClose = (tabId: string) => {
  if (writingViewStore.isDirty(tabId)) {
    pendingCloseTabId.value = tabId
    closeConfirmOpen.value = true
    return
  }
  doCloseTab(tabId)
}

const confirmCloseTab = () => {
  closeConfirmOpen.value = false
  if (pendingCloseTabId.value) {
    doCloseTab(pendingCloseTabId.value)
    pendingCloseTabId.value = null
  }
}

const cancelCloseTab = () => {
  closeConfirmOpen.value = false
  pendingCloseTabId.value = null
}

const doCloseTab = (tabId: string) => {
  const index = tabs.value.findIndex(tab => tab.id === tabId)
  if (index === -1) return

  tabs.value.splice(index, 1)
  delete tabContents.value[tabId]
  writingViewStore.clearDirty(tabId)

  if (activeTabId.value === tabId) {
    activeTabId.value = tabs.value.length > 0 ? tabs.value[Math.max(0, index - 1)].id : null
  }
}

const closeTabByPath = (filePath: string) => {
  const tab = tabs.value.find(t => t.path === filePath)
  if (tab) {
    // 文件已从磁盘删除场景直接关闭（不弹脏检查——文件已不存在，修改无从保存）
    doCloseTab(tab.id)
    pendingOperationsStore.clearDocumentSnapshot(filePath)
  }
}

watch(activeTabId, (newTabId, oldTabId) => {
  // 切换 tab 前把当前编辑器内容回写 tabContents（未保存的修改随 tab 保留，脏标记不清）
  if (oldTabId && oldTabId !== newTabId && editorRef.value && tabs.value.some(t => t.id === oldTabId)) {
    tabContents.value[oldTabId] = editorRef.value.getContent()
  }

  if (!newTabId) {
    clearDiffPreview()
    return
  }
  
  const activeTab = tabs.value.find(tab => tab.id === newTabId)
  if (activeTab) {
    setTimeout(() => {
      restoreDiffPreview(activeTab.path)
    }, 50)
  }
})

const currentFileContent = computed(() => {
  if (!activeTabId.value) return ''
  return tabContents.value[activeTabId.value] || ''
})

const currentFilePath = computed(() => {
  if (!activeTabId.value) return ''
  const activeTab = tabs.value.find(tab => tab.id === activeTabId.value)
  return activeTab?.path || ''
})

const hasPendingOperationsForCurrentFile = computed(() => {
  if (!currentFilePath.value) return false
  const pendingOps = pendingOperationsStore.getOperationsByFile(currentFilePath.value)
  return pendingOps.length > 0
})

const handleSave = async () => {
  // 只看（readonly）模式禁保存
  if (props.readonly) return
  if (!activeTabId.value || !editorRef.value) return

  const activeTab = tabs.value.find(tab => tab.id === activeTabId.value)
  if (!activeTab) return

  saveStatus.value = 'saving'
  const htmlContent = editorRef.value.getContent()
  const plainTextContent = htmlToPlainText(htmlContent)
  try {
    const response = await window.electronAPI.fileWrite(activeTab.path, plainTextContent)
    if (response.success) {
      tabContents.value[activeTabId.value] = htmlContent
      writingViewStore.clearDirty(activeTabId.value)
      // 格式保真范围明示：富文本格式（加粗/标题/列表等）经 htmlToPlainText 保存即丢，UI 提示
      formatLossWarning.value = RICH_TEXT_TAG_RE.test(htmlContent)
      if (formatLossWarningTimer) clearTimeout(formatLossWarningTimer)
      if (formatLossWarning.value) {
        formatLossWarningTimer = setTimeout(() => {
          formatLossWarning.value = false
        }, 6000)
      }
      saveStatus.value = 'saved'
      setTimeout(() => {
        saveStatus.value = 'idle'
      }, 1500)
    } else {
      saveStatus.value = 'error'
      setTimeout(() => {
        saveStatus.value = 'idle'
      }, 2000)
    }
  } catch (error) {
    saveStatus.value = 'error'
    setTimeout(() => {
      saveStatus.value = 'idle'
    }, 2000)
  }
}

const handleKeyDown = (e: KeyboardEvent) => {
  // 只看（readonly）模式禁用保存快捷键
  if (props.readonly) return
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    handleSave()
  }
}

const handleSnapshotRequest = async ({
  filePath,
  callback
}: {
  filePath: string
  callback: (snapshot: any) => void
}) => {
  const cachedSnapshot = pendingOperationsStore.getDocumentSnapshot(filePath)
  
  if (cachedSnapshot) {
    callback(cachedSnapshot)
    return
  }
  
  const existingTab = tabs.value.find(tab => tab.path === filePath)
  
  if (existingTab) {
    activeTabId.value = existingTab.id
    
    await new Promise(resolve => setTimeout(resolve, 150))
    
    const snapshot = pendingOperationsStore.getDocumentSnapshot(filePath)
    callback(snapshot || null)
    return
  }
  
  const fileOps = pendingOperationsStore.getOperationsByFile(filePath)
  const createFileOp = fileOps.find((op: PendingOperation) => op.toolName === 'create_file')
  
  if (createFileOp) {
    if (!currentDirectory.value) {
      const dirPath = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
      currentDirectory.value = dirPath
    }
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath
    const tabId = `tab-${Date.now()}`
    tabs.value.push({ id: tabId, name: fileName, path: filePath, isHtml: false })
    
    const createContent = createFileOp.operations[0]?.insertContent || ''
    const content = plainTextToHtml(createContent)
    tabContents.value[tabId] = content
    activeTabId.value = tabId
    
    await new Promise(resolve => setTimeout(resolve, 150))
    
    safeGenerateSnapshot(
      filePath,
      () => editorRef.value?.getSnapshot() || null,
      pendingOperationsStore
    )
    
    await new Promise(resolve => setTimeout(resolve, 100))
    
    const storedSnapshot = pendingOperationsStore.getDocumentSnapshot(filePath)
    callback(storedSnapshot || null)
    return
  }
  
  await handleFileClick(filePath)
  
  await new Promise(resolve => setTimeout(resolve, 150))
  
  const snapshot = pendingOperationsStore.getDocumentSnapshot(filePath)
  callback(snapshot || null)
}

const handleSwitchToFileTab = (filePath: string) => {
  const tab = tabs.value.find(t => t.path === filePath)
  if (tab) {
    activeTabId.value = tab.id
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
  eventBus.on(EVENTS.REQUEST_SNAPSHOT, handleSnapshotRequest)
  eventBus.on(EVENTS.SWITCH_TO_FILE_TAB, handleSwitchToFileTab)

  // 渲染分层重挂恢复：文件树从目录重列；活跃 tab 非脏时内容从真相源（磁盘）重读，脏 tab 保留 store 中未保存内容
  if (currentDirectory.value) {
    void window.electronAPI.fileListDirectory(currentDirectory.value).then((listResponse: { success: boolean; files?: FileItem[] }) => {
      if (listResponse.success && listResponse.files && currentDirectory.value) {
        loadFiles(listResponse.files, currentDirectory.value)
      }
    })
  }
  const activeTab = tabs.value.find(tab => tab.id === activeTabId.value)
  if (activeTab && !writingViewStore.isDirty(activeTab.id)) {
    void reloadFile(activeTab.path)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
  eventBus.off(EVENTS.REQUEST_SNAPSHOT, handleSnapshotRequest)
  eventBus.off(EVENTS.SWITCH_TO_FILE_TAB, handleSwitchToFileTab)
})

watch(currentDirectory, (newDirectory) => {
  writingViewStore.setCurrentDirectory(newDirectory)
})

// 项目=文件夹绑定：会话切换时 Home 把项目 folderPath 写入 store，此处下放到本地目录并重列文件树
// （仅 store 值非空且与本地不同才跟随；清空/未绑定不动，保留手动打开的目录作回退）
watch(() => writingViewStore.currentDirectory, (dir) => {
  if (!dir || dir === currentDirectory.value) return
  void window.electronAPI.fileListDirectory(dir).then((listResponse: { success: boolean; files?: FileItem[] }) => {
    if (listResponse.success && listResponse.files) {
      loadFiles(listResponse.files, dir)
      void window.electronAPI.fileWatchStart?.(dir)
    }
  })
})

const handleContentChange = () => {
  // 脏状态跟踪：编辑器内容变动即标记当前 tab 未保存（关闭 tab 时据此提示）
  if (activeTabId.value) {
    writingViewStore.markDirty(activeTabId.value)
  }
}

watch(
  () => pendingOperationsStore.operations,
  () => {
    if (!activeTabId.value || !editorRef.value) return
    
    const activeTab = tabs.value.find(tab => tab.id === activeTabId.value)
    if (!activeTab) return
    
    const fileOperations = pendingOperationsStore.getOperationsByFile(activeTab.path)
    if (fileOperations.length === 0) {
      editorRef.value.clearDiffPreview()
      return
    }
    
    window.electronAPI.fileRead(activeTab.path).then((response: { success: boolean; content?: string }) => {
      if (response.success && response.content !== undefined && editorRef.value) {
        const allOperations: DiffOperation[] = []
        fileOperations.forEach((op: PendingOperation) => {
          const diffOps = op.operations.filter(
            (o) => o.type === 'insert' || o.type === 'delete' || o.type === 'replace'
          ) as DiffOperation[]
          allOperations.push(...diffOps)
        })
        const tipTapOperations = convertOperationsToTipTap(allOperations)
        editorRef.value!.setDiffPreview(tipTapOperations)
      }
    })
  },
  { deep: true }
)

defineExpose({
  loadFiles,
  getCurrentDirectory: () => currentDirectory.value,
  openFile: handleFileClick,
  openFileWithDiff,
  clearDiffPreview,
  restoreDiffPreview,
  reloadFile,
  closeTabByPath,
  // 退回只看（销毁编辑器）前的脏检查：任一 tab 有未保存修改即提示
  hasUnsavedChanges: () => writingViewStore.dirtyTabIds.length > 0
})
</script>

<style scoped>
.writing-view-layout {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background-color: var(--background-primary);
}

/* 顶部工具栏（编辑器自持，自 Home 菜单行迁入） */
.writing-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--spacing-2);
  padding: var(--spacing-2) var(--spacing-3);
  border-bottom: 1px solid var(--border-color);
  background-color: var(--background-primary);
  min-height: 34px;
}

.writing-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: row;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

/* 打开文件夹按钮样式 */
.open-folder-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-lg);
  background-color: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.open-folder-btn:hover {
  background-color: var(--background-secondary);
  color: var(--primary-color);
}

.open-folder-btn:active {
  transform: scale(0.95);
}

.open-folder-btn svg {
  display: block;
  width: 18px;
  height: 18px;
}

/* 打开文件夹下拉菜单 */
.open-folder-dropdown {
  position: relative;
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background-color: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  min-width: 140px;
  overflow: hidden;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color 0.15s;
}

.dropdown-item:hover {
  background-color: var(--background-hover);
}

.dropdown-item svg {
  flex-shrink: 0;
}

.writing-sidebar {
  position: relative;
  max-width: 400px;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  background-color: var(--background-primary);
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-3) var(--spacing-4);
  border-bottom: 1px solid var(--border-color);
  background-color: var(--background-secondary);
}

.sidebar-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-content {
  flex: 1;
  overflow: auto;
}

/* 侧边栏调整手柄 */
.sidebar-resize-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  background-color: transparent;
  transition: background-color 0.2s;
  z-index: 10;
}

.sidebar-resize-handle:hover {
  background-color: #3b82f6;
}

/* 侧边栏拉出触发区域 */
.sidebar-pull-trigger {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  cursor: col-resize;
  background-color: transparent;
  transition: background-color 0.2s;
  z-index: 10;
}

.sidebar-pull-trigger:hover {
  background-color: rgba(59, 130, 246, 0.3);
}

.writing-main-content {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.writing-placeholder,
.writing-editor-placeholder {
  font-size: 14px;
  color: var(--text-secondary);
}

.writing-editor-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.writing-editor-container .writing-editor-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pending-operations-warning {
  padding: var(--spacing-2) var(--spacing-4);
  background-color: #fef3c7;
  color: #92400e;
  font-size: 13px;
  text-align: center;
  border-top: 1px solid #fcd34d;
}

/* 格式保真范围提示（富文本格式保存即丢） */
.format-loss-warning {
  padding: var(--spacing-2) var(--spacing-4);
  background-color: #fff7ed;
  color: #9a3412;
  font-size: 13px;
  text-align: center;
  border-top: 1px solid #fdba74;
}
</style>
