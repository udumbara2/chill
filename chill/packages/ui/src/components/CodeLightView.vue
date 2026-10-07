<template>
  <div class="light-view code-light-view">
    <!-- 实例列表（AI 待确认改动涉及的代码文件；>1 个实例时显示） -->
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
        <button
          v-if="fileOps.length"
          class="light-mode-btn"
          @click="showDiff = !showDiff"
        >{{ showDiff ? '源码' : '改动' }}</button>
      </div>

      <!-- 改动模式：行级 diff（基准=操作快照/当前内容，预览=施加操作后全文） -->
      <div v-if="showDiff && diffRows" class="code-diff code-scroll">
        <pre><div
          v-for="(row, i) in diffRows"
          :key="i"
          class="code-diff-row"
          :class="`is-${row.type}`"
        ><span class="code-diff-sign">{{ row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ' }}</span>{{ row.text || ' ' }}</div></pre>
      </div>
      <!-- 源码模式：只读语法高亮（保守色表，跟随 UI 主题变量） -->
      <div v-else class="code-source code-scroll">
        <pre v-if="highlighted"><code :class="`language-${language}`" v-html="highlighted"></code></pre>
        <div v-else class="light-empty">
          <span>{{ currentPath ? '文件为空或读取失败' : '暂无代码对象（AI 改动代码文件后在此显示）' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import hljs from 'highlight.js'
import { tryGetHostAPI, getHostAPI } from '../host/hostApi'
import { usePendingOperationsStore } from '../stores/pendingOperationsStore'
import { useWorkObjectStore } from '../stores/workObjectStore'
import { fileBaseName } from '../utils/workObjectFileType'
import {
  collectFileOperations,
  diffCounts,
  diffBaseText,
  applyOperations,
  lineDiffRows,
  normalizeFilePath
} from '../utils/lightDiff'

const pendingStore = usePendingOperationsStore()
const workObjectStore = useWorkObjectStore()

// ==================== 实例列表与当前文件（实例源=pendingOperations 涉及的代码文件；会话检测迭代后由活跃对象集驱动） ====================
const currentPath = ref('')
const content = ref('')
const showDiff = ref(false)

const instances = computed(() => workObjectStore.objectsForType('code'))

const currentName = computed(() => (currentPath.value ? fileBaseName(currentPath.value) : ''))

const selectInstance = (path: string) => {
  currentPath.value = path
}

watch(instances, (list) => {
  if (currentPath.value && list.some(i => normalizeFilePath(i.path) === normalizeFilePath(currentPath.value))) return
  currentPath.value = list[list.length - 1]?.path || ''
}, { immediate: true, deep: true })

// ==================== 文件即真相源 + 节流刷新 ====================
const readFile = async (path: string) => {
  if (!tryGetHostAPI()?.fileRead) return
  try {
    const response = await getHostAPI().fileRead(path)
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
  }, 400)
}

watch(currentPath, (path) => {
  content.value = ''
  showDiff.value = false
  if (path) void readFile(path)
})
// 对象活跃即刷新：与徽标共用同一检测事件源（workObjectStore.lastActiveAt 推进即 AI 写入落盘）
const currentObjectActiveAt = computed(() => {
  if (!currentPath.value) return 0
  const cur = workObjectStore.objectsForType('code').find(
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

// ==================== 语法高亮（hljs 仓内既有依赖；扩展名 → 语言映射） ====================
const LANG_BY_EXT: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', vue: 'xml',
  py: 'python', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', xml: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  sh: 'bash', bash: 'bash', bat: 'dos', ps1: 'powershell', sql: 'sql', ini: 'ini', conf: 'ini'
}

const language = computed(() => {
  const name = currentName.value
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return LANG_BY_EXT[ext] || 'plaintext'
})

const highlighted = computed(() => {
  if (!content.value) return ''
  try {
    return hljs.highlight(content.value, { language: language.value, ignoreIllegals: true }).value
  } catch {
    return hljs.highlightAuto(content.value).value
  }
})

// ==================== diff 预览（复用 pendingOperations，与 dock 页签徽标同源） ====================
const fileOps = computed(() => (currentPath.value ? collectFileOperations(pendingStore.operations, currentPath.value) : []))
const counts = computed(() => diffCounts(fileOps.value))

const diffRows = computed(() => {
  if (!fileOps.value.length) return null
  const base = diffBaseText(fileOps.value, content.value)
  return lineDiffRows(base, applyOperations(base, fileOps.value))
})

const badgeText = (path: string) => {
  const c = diffCounts(collectFileOperations(pendingStore.operations, path))
  return c.add || c.del ? `+${c.add} -${c.del}` : ''
}

// 供 dock 路由兼容（viewer 型无参与态，Home 的 diff 链路只路由 document 型；保留空实现防御）
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

.code-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.code-source pre,
.code-diff pre {
  margin: 0;
  padding: 12px 16px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.code-source code {
  background: transparent;
  font-family: inherit;
}

.code-diff-row {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary, #6b7280);
}

.code-diff-sign {
  display: inline-block;
  width: 16px;
  color: var(--text-tertiary, #9ca3af);
  user-select: none;
}

.code-diff-row.is-add {
  background-color: rgba(34, 197, 94, 0.12);
  color: var(--text-primary, #111827);
}

.code-diff-row.is-del {
  background-color: rgba(239, 68, 68, 0.10);
  color: var(--text-tertiary, #9ca3af);
  text-decoration: line-through;
}

.light-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary, #9ca3af);
  font-size: 13px;
}

/* 语法高亮 GUI 形态约定：跟随 UI 主题变量（var 兜底仅作缺省），保守色表——不染 punctuation/operator/attr */
.code-source :deep(.hljs-keyword),
.code-source :deep(.hljs-selector-tag),
.code-source :deep(.hljs-meta) {
  color: var(--primary-color, #3b82f6);
}

.code-source :deep(.hljs-string),
.code-source :deep(.hljs-regexp),
.code-source :deep(.hljs-addition) {
  color: var(--success-color, #16a34a);
}

.code-source :deep(.hljs-number),
.code-source :deep(.hljs-literal) {
  color: var(--warning-color, #d97706);
}

.code-source :deep(.hljs-comment),
.code-source :deep(.hljs-quote) {
  color: var(--text-tertiary, #9ca3af);
  font-style: italic;
}

.code-source :deep(.hljs-title),
.code-source :deep(.hljs-title.function_),
.code-source :deep(.hljs-section) {
  color: var(--info-color, #0284c7);
}

.code-source :deep(.hljs-type),
.code-source :deep(.hljs-built_in),
.code-source :deep(.hljs-title.class_) {
  color: var(--text-primary, #111827);
  font-weight: 600;
}

.code-source :deep(.hljs-deletion) {
  color: var(--danger-color, #dc2626);
}
</style>
