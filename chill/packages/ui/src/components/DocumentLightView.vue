<template>
  <div class="light-view doc-light-view">
    <!-- 实例列表（类型级：打开的文档 + AI 待确认改动涉及的文档；>1 个实例时显示） -->
    <div v-if="instances.length > 1" class="light-instance-list">
      <div
        v-for="inst in instances"
        :key="inst.path"
        class="light-instance-item"
        :class="{ active: inst.path === currentPath }"
        :title="inst.path"
        @click="selectInstance(inst.path)"
      >
        <span class="light-instance-name">{{ inst.name }}</span>
        <span v-if="badgeText(inst.path)" class="lv-badge">{{ badgeText(inst.path) }}</span>
      </div>
    </div>

    <div class="light-content">
      <div v-if="currentPath" class="light-header">
        <span class="light-path" :title="currentPath">{{ currentName }}</span>
        <span v-if="counts.add || counts.del" class="lv-badge">+{{ counts.add }} -{{ counts.del }}</span>
      </div>
      <!-- 聊天区同款 markdown 渲染；有待确认操作时在渲染源上内联标注增删（自绘 diff，不依赖 TipTap） -->
      <div class="doc-light-markdown">
        <MessageMarkdown v-if="renderSource" :content="renderSource" />
        <div v-else class="light-empty">
          <span>{{ currentPath ? '文件为空或读取失败' : '暂无文档对象（AI 写文档或参与态打开文件后在此显示）' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { tryGetHostAPI, getHostAPI } from '../host/hostApi'
import MessageMarkdown from './MessageMarkdown.vue'
import { usePendingOperationsStore } from '../stores/pendingOperationsStore'
import { useWorkObjectStore } from '../stores/workObjectStore'
import { useWritingViewStore } from '../stores/writingViewStore'
import { fileBaseName } from '../utils/workObjectFileType'
import {
  collectFileOperations,
  diffCounts,
  diffBaseText,
  buildAnnotatedSource,
  normalizeFilePath
} from '../utils/lightDiff'

const pendingStore = usePendingOperationsStore()
const workObjectStore = useWorkObjectStore()
const writingStore = useWritingViewStore()
const { tabs, activeTabId } = storeToRefs(writingStore)

// ==================== 实例列表与当前文件 ====================
/** dock 路由经 openFileWithDiff 打开、但不在 tabs/pending 中的文件补充进列表 */
const extraPaths = ref<string[]>([])
const currentPath = ref<string>('')
const content = ref('')

/** 实例 = 会话活跃文档对象（workObjectStore，唯一事实源）∪ 写作 tabs ∪ 路由补充 */
const instances = computed(() => {
  const seen = new Set<string>()
  const list: { path: string; name: string }[] = []
  const push = (path: string) => {
    const key = normalizeFilePath(path)
    if (!path || seen.has(key)) return
    seen.add(key)
    list.push({ path, name: fileBaseName(path) })
  }
  for (const obj of workObjectStore.objectsForType('document')) push(obj.path)
  for (const tab of tabs.value) push(tab.path)
  for (const path of extraPaths.value) push(path)
  return list
})

const currentName = computed(() => (currentPath.value ? fileBaseName(currentPath.value) : ''))

const selectInstance = (path: string) => {
  currentPath.value = path
}

// 默认定位：写作活跃 tab → 最近待确认文档 → 首个实例
watch(
  instances,
  (list) => {
    if (currentPath.value && list.some(i => normalizeFilePath(i.path) === normalizeFilePath(currentPath.value))) return
    const activeTab = tabs.value.find(t => t.id === activeTabId.value)
    currentPath.value = activeTab?.path || list[list.length - 1]?.path || ''
  },
  { immediate: true, deep: true }
)

// ==================== 文件即真相源 + 节流刷新 ====================
const readFile = async (path: string) => {
  if (!tryGetHostAPI()?.fileRead) return
  try {
    const response = await getHostAPI().fileRead(path)
    if (response.success && typeof response.content === 'string') {
      // 读回期间实例已切换则丢弃（防串扰）
      if (normalizeFilePath(path) === normalizeFilePath(currentPath.value)) {
        content.value = response.content
      }
    }
  } catch { /* 读取失败保留旧内容 */ }
}

// AI 流式写入时节流刷新（400ms 尾沿；写入洪流期间最多每 400ms 一次 fileRead + markdown 重渲染）
let throttleTimer: ReturnType<typeof setTimeout> | null = null
const scheduleReload = () => {
  if (!currentPath.value || throttleTimer) return
  throttleTimer = setTimeout(() => {
    throttleTimer = null
    void readFile(currentPath.value)
  }, 400)
}

watch(currentPath, (path) => {
  content.value = ''
  if (path) void readFile(path)
})

// 对象活跃即刷新：与徽标共用同一检测事件源（workObjectStore.lastActiveAt 推进即 AI 写入落盘）
const currentObjectActiveAt = computed(() => {
  if (!currentPath.value) return 0
  const cur = workObjectStore.objectsForType('document').find(
    i => normalizeFilePath(i.path) === normalizeFilePath(currentPath.value)
  )
  return cur?.lastActiveAt ?? 0
})
watch(currentObjectActiveAt, (ts) => { if (ts) scheduleReload() })

// 待确认操作流式到达/确认清理 → 触发节流重读（文件即真相源，磁盘内容与操作流同步推进）
watch(() => pendingStore.operations.length, scheduleReload)

onMounted(() => {
  if (currentPath.value) void readFile(currentPath.value)
})

onUnmounted(() => {
  if (throttleTimer) clearTimeout(throttleTimer)
})

// ==================== 自绘 diff（消费 pendingOperations，与编辑器侧 diff 预览同源） ====================
const fileOps = computed(() => (currentPath.value ? collectFileOperations(pendingStore.operations, currentPath.value) : []))
const counts = computed(() => diffCounts(fileOps.value))

const renderSource = computed(() => {
  if (!content.value && !fileOps.value.length) return ''
  if (!fileOps.value.length) return content.value
  return buildAnnotatedSource(diffBaseText(fileOps.value, content.value), fileOps.value)
})

const badgeText = (path: string) => {
  const c = diffCounts(collectFileOperations(pendingStore.operations, path))
  return c.add || c.del ? `+${c.add} -${c.del}` : ''
}

// ==================== dock 双路路由接口（与 WritingView 同名方法，Home 编排经 dock 透传时无需分路） ====================
/** EDITOR_SYNC_OPEN_FILE → 命中当前文件时节流重读 */
const reloadFile = (path: string) => {
  if (normalizeFilePath(path) === normalizeFilePath(currentPath.value)) scheduleReload()
}

/** TOOL_CALL_STATUS_CHANGED(pending+diffPreview) → 打开该文件（diff 标注由 store 响应式驱动，无需命令式施加） */
const openFileWithDiff = (filePath: string) => {
  if (!instances.value.some(i => normalizeFilePath(i.path) === normalizeFilePath(filePath))) {
    extraPaths.value.push(filePath)
  }
  currentPath.value = filePath
}

/** DIFF_PREVIEW 清理由 pendingOperationsStore 确认/拒绝流程驱动（store 清空即自动消退），此处仅需接口兼容 */
const clearDiffPreview = () => {}

defineExpose({
  reloadFile,
  openFileWithDiff,
  clearDiffPreview
})
</script>

<style scoped>
.light-view {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

/* 实例列表（类型级全集的角色由编辑器侧 FileTree 承担；轻量态仅列打开/活跃实例） */
.light-instance-list {
  flex: 0 0 160px;
  overflow-y: auto;
  border-right: 1px solid var(--border-color, #e5e7eb);
  background-color: var(--background-tertiary, #f1f5f9);
  padding: 4px;
}

.light-instance-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--radius-md, 6px);
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
}

.light-instance-item:hover {
  background-color: var(--background-secondary, #f8fafc);
}

.light-instance-item.active {
  background-color: var(--background-secondary, #f8fafc);
  color: var(--primary-color, #3b82f6);
  font-weight: 500;
}

.light-instance-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.light-content {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.light-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}

.light-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lv-badge {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  background-color: var(--background-tertiary, #f1f5f9);
  color: var(--text-tertiary, #9ca3af);
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.doc-light-markdown {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
  font-size: 13px;
}

.light-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary, #9ca3af);
  font-size: 13px;
}
</style>

<!-- 自绘 diff 标注色（渲染在 MessageMarkdown 内部 DOM 上，须非 scoped 才能命中） -->
<style>
.lv-diff-add {
  background-color: rgba(34, 197, 94, 0.15);
  border-bottom: 2px solid rgba(34, 197, 94, 0.5);
  border-radius: 2px;
}

.lv-diff-del {
  background-color: rgba(239, 68, 68, 0.12);
  text-decoration: line-through;
  color: var(--text-tertiary, #9ca3af);
  border-radius: 2px;
}
</style>
