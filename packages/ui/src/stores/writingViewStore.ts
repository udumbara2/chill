import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/** 写作编辑器页签（与 EditorTabs 的 TabItem 结构一致；定义在此避免 store 依赖 .vue  shim 的命名导出） */
interface WritingTabItem {
  id: string
  name: string
  path: string
  isHtml?: boolean
}

export const useWritingViewStore = defineStore('writingView', () => {
  const currentDirectory = ref<string | null>(null)

  // 写作编辑器 tabs 状态（自 WritingView 组件内上提：编辑器随 dock 意图切换销毁/重挂时不丢状态）
  const tabs = ref<WritingTabItem[]>([])
  const activeTabId = ref<string | null>(null)
  const tabContents = ref<Record<string, string>>({})
  // 脏状态跟踪：有未保存修改的 tab id 集合（保存成功或重新载入后清除）
  const dirtyTabIds = ref<string[]>([])

  const markDirty = (tabId: string) => {
    if (tabId && !dirtyTabIds.value.includes(tabId)) {
      dirtyTabIds.value.push(tabId)
    }
  }

  const clearDirty = (tabId: string) => {
    dirtyTabIds.value = dirtyTabIds.value.filter(id => id !== tabId)
  }

  const isDirty = (tabId: string) => dirtyTabIds.value.includes(tabId)

  const setCurrentDirectory = (directory: string | null) => {
    currentDirectory.value = directory
  }

  const getCurrentDirectory = () => {
    return currentDirectory.value
  }

  const directoryName = computed(() => {
    if (!currentDirectory.value) return ''
    const parts = currentDirectory.value.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || currentDirectory.value
  })

  return {
    currentDirectory,
    tabs,
    activeTabId,
    tabContents,
    dirtyTabIds,
    markDirty,
    clearDirty,
    isDirty,
    setCurrentDirectory,
    getCurrentDirectory,
    directoryName
  }
})
