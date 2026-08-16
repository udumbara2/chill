<template>
  <div class="light-view html-light-view">
    <!-- 实例列表（AI 待确认改动涉及的网页文件；>1 个实例时显示） -->
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
        <button class="light-mode-btn" @click="showSource = !showSource">{{ showSource ? '预览' : '源码' }}</button>
      </div>

      <!-- 预览模式：Electron webview 渲染本地 file://（主进程已开 webviewTag；guest 进程隔离） -->
      <template v-if="!showSource">
        <WebviewEl v-if="fileUrl" :key="`${currentPath}:${refreshTick}`" :src="fileUrl" class="html-webview" />
        <div v-else class="light-empty">
          <span>{{ currentPath ? 'webview 仅在 Electron 环境可用' : '暂无网页对象（AI 生成网页后在此显示）' }}</span>
        </div>
      </template>
      <!-- 源码模式：只读高亮（html 走 xml 语法） -->
      <div v-else class="html-source code-scroll">
        <pre v-if="highlighted"><code class="language-xml" v-html="highlighted"></code></pre>
        <div v-else class="light-empty"><span>文件为空或读取失败</span></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, defineComponent, h } from 'vue'
import hljs from 'highlight.js'
import { usePendingOperationsStore } from '../stores/pendingOperationsStore'
import { useWorkObjectStore } from '../stores/workObjectStore'
import { fileBaseName } from '../utils/workObjectFileType'
import { collectFileOperations, diffCounts, normalizeFilePath } from '../utils/lightDiff'

// webview 是 Electron 自定义元素：经 h() 原生渲染（模板直写会被 Vue 当组件解析而渲染失败）
const WebviewEl = defineComponent({
  name: 'WebviewEl',
  props: { src: { type: String, required: true } },
  setup(props) {
    return () =>
      h('webview', {
        src: props.src,
        class: 'html-webview-el',
        // guest 侧最小权限：保持上下文隔离，禁 node
        webpreferences: 'contextIsolation=yes,nodeIntegration=no'
      })
  }
})

const pendingStore = usePendingOperationsStore()

// ==================== 实例列表与当前文件（实例源=workObjectStore 会话活跃对象，唯一事实源） ====================
const workObjectStore = useWorkObjectStore()
const currentPath = ref('')
const content = ref('')
const showSource = ref(false)
const refreshTick = ref(0)

const instances = computed(() => workObjectStore.objectsForType('html'))

const currentName = computed(() => (currentPath.value ? fileBaseName(currentPath.value) : ''))

const selectInstance = (path: string) => {
  currentPath.value = path
}

watch(instances, (list) => {
  if (currentPath.value && list.some(i => normalizeFilePath(i.path) === normalizeFilePath(currentPath.value))) return
  currentPath.value = list[list.length - 1]?.path || ''
}, { immediate: true, deep: true })

// 本地文件 → file:// URL（渲染进程为 http 源，iframe 装 file:// 受源策略限制，故用 webview）
const fileUrl = computed(() => {
  if (!currentPath.value || !window.electronAPI) return ''
  return encodeURI('file:///' + currentPath.value.replace(/\\/g, '/'))
})

// ==================== 文件即真相源 + 节流刷新 ====================
const readFile = async (path: string) => {
  if (!window.electronAPI?.fileRead) return
  try {
    const response = await window.electronAPI.fileRead(path)
    if (response.success && typeof response.content === 'string') {
      if (normalizeFilePath(path) === normalizeFilePath(currentPath.value)) {
        content.value = response.content
      }
    }
  } catch { /* 读取失败保留旧内容 */ }
}

let throttleTimer: ReturnType<typeof setTimeout> | null = null
const scheduleReload = () => {
  if (!currentPath.value || throttleTimer) return
  throttleTimer = setTimeout(() => {
    throttleTimer = null
    void readFile(currentPath.value)
    refreshTick.value++ // webview 经 key 变更重载，预览跟随磁盘
  }, 400)
}

watch(currentPath, (path) => {
  content.value = ''
  if (path) void readFile(path)
})
// 对象活跃即刷新：与徽标共用同一检测事件源（workObjectStore.lastActiveAt 推进即 AI 写入落盘），
// 预览经节流重读磁盘真相源
const currentObjectActiveAt = computed(() => {
  if (!currentPath.value) return 0
  const cur = workObjectStore.objectsForType('html').find(
    i => normalizeFilePath(i.path) === normalizeFilePath(currentPath.value)
  )
  return cur?.lastActiveAt ?? 0
})
watch(currentObjectActiveAt, (ts) => { if (ts) scheduleReload() })
watch(() => pendingStore.operations.length, scheduleReload)

onMounted(() => {
  if (currentPath.value) void readFile(currentPath.value)
})
onUnmounted(() => {
  if (throttleTimer) clearTimeout(throttleTimer)
})

const highlighted = computed(() => {
  if (!content.value) return ''
  try {
    return hljs.highlight(content.value, { language: 'xml', ignoreIllegals: true }).value
  } catch {
    return content.value
  }
})

// ==================== diff 徽标（复用 pendingOperations；预览内容为渲染态，diff 在源码模式核对） ====================
const fileOps = computed(() => (currentPath.value ? collectFileOperations(pendingStore.operations, currentPath.value) : []))
const counts = computed(() => diffCounts(fileOps.value))

const badgeText = (path: string) => {
  const c = diffCounts(collectFileOperations(pendingStore.operations, path))
  return c.add || c.del ? `+${c.add} -${c.del}` : ''
}

defineExpose({
  reloadFile: (path: string) => {
    if (normalizeFilePath(path) === normalizeFilePath(currentPath.value)) scheduleReload()
  }
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

.light-mode-btn {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 2px 10px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: var(--radius-md, 6px);
  background-color: var(--background-primary, #ffffff);
  color: var(--text-secondary, #6b7280);
  font-size: 11px;
  cursor: pointer;
}

.light-mode-btn:hover {
  color: var(--primary-color, #3b82f6);
  border-color: var(--primary-color, #3b82f6);
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

.html-webview,
.html-webview-el {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  border: none;
  background-color: var(--background-primary, #ffffff);
}

.code-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.html-source pre {
  margin: 0;
  padding: 12px 16px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.html-source code {
  background: transparent;
  font-family: inherit;
}

.light-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary, #9ca3af);
  font-size: 13px;
}

/* 源码模式高亮：保守色表，跟随 UI 主题变量 */
.html-source :deep(.hljs-tag),
.html-source :deep(.hljs-name) {
  color: var(--primary-color, #3b82f6);
}

.html-source :deep(.hljs-string) {
  color: var(--success-color, #16a34a);
}

.html-source :deep(.hljs-comment) {
  color: var(--text-tertiary, #9ca3af);
  font-style: italic;
}
</style>
