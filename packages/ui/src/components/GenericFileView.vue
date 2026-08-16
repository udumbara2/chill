<template>
  <div class="light-view generic-file-view">
    <div v-if="instances.length" class="generic-cards">
      <div v-for="inst in instances" :key="inst.path" class="generic-card">
        <div class="generic-card-main">
          <span class="generic-card-name">{{ inst.name }}</span>
          <span class="generic-card-path" :title="inst.path">{{ inst.path }}</span>
          <span class="generic-card-meta">
            <template v-if="metaOf(inst.path)">{{ metaOf(inst.path) }}</template>
            <template v-else>读取中…</template>
          </span>
        </div>
        <div class="generic-card-side">
          <span v-if="badgeText(inst.path)" class="lv-badge">{{ badgeText(inst.path) }}</span>
          <button class="generic-open-btn" @click="openWithSystem(inst.path)">系统方式打开</button>
        </div>
      </div>
    </div>
    <div v-else class="light-empty">
      <span>暂无文件对象（未注册专属类型的文件型对象落入此兜底视图，可见可审计）</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { usePendingOperationsStore } from '../stores/pendingOperationsStore'
import { useWorkObjectStore } from '../stores/workObjectStore'
import { fileBaseName } from '../utils/workObjectFileType'
import { collectFileOperations, diffCounts, normalizeFilePath } from '../utils/lightDiff'

const pendingStore = usePendingOperationsStore()
const workObjectStore = useWorkObjectStore()

// ==================== 实例列表（兜底：未注册专属类型的文件型对象；实例源=pendingOperations） ====================
const instances = computed(() => workObjectStore.objectsForType('generic'))

// ==================== 文件卡片元信息（无 stat IPC，以 fileRead 的行数/字符数近似大小） ====================
const metaMap = ref<Record<string, string>>({})

const loadMeta = async (path: string) => {
  if (!window.electronAPI?.fileRead) {
    metaMap.value = { ...metaMap.value, [normalizeFilePath(path)]: '' }
    return
  }
  try {
    const response = await window.electronAPI.fileRead(path)
    if (response.success && typeof response.content === 'string') {
      const lines = response.totalLines ?? response.content.split('\n').length
      metaMap.value = { ...metaMap.value, [normalizeFilePath(path)]: `${lines} 行 · ${response.content.length} 字符` }
    } else {
      metaMap.value = { ...metaMap.value, [normalizeFilePath(path)]: '读取失败' }
    }
  } catch {
    metaMap.value = { ...metaMap.value, [normalizeFilePath(path)]: '读取失败' }
  }
}

const metaOf = (path: string) => metaMap.value[normalizeFilePath(path)] ?? ''

watch(instances, (list) => {
  for (const inst of list) {
    if (!(normalizeFilePath(inst.path) in metaMap.value)) void loadMeta(inst.path)
  }
}, { immediate: true, deep: true })

// ==================== 徽标（与 dock 页签同源于 pendingOperations） ====================
const badgeText = (path: string) => {
  const c = diffCounts(collectFileOperations(pendingStore.operations, path))
  return c.add || c.del ? `+${c.add} -${c.del}` : ''
}

// ==================== 系统方式打开（electronAPI.fileOpen → 主进程 shell.openPath） ====================
const openWithSystem = (path: string) => {
  void window.electronAPI?.fileOpen?.(path)
}
</script>

<style scoped>
.light-view {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.generic-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.generic-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: var(--radius-md, 6px);
  background-color: var(--background-primary, #ffffff);
}

.generic-card-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.generic-card-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary, #111827);
}

.generic-card-path {
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.generic-card-meta {
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
}

.generic-card-side {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.generic-open-btn {
  padding: 3px 10px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: var(--radius-md, 6px);
  background-color: var(--background-primary, #ffffff);
  color: var(--text-secondary, #6b7280);
  font-size: 11px;
  cursor: pointer;
}

.generic-open-btn:hover {
  color: var(--primary-color, #3b82f6);
  border-color: var(--primary-color, #3b82f6);
}

.lv-badge {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  background-color: var(--background-tertiary, #f1f5f9);
  color: var(--text-tertiary, #9ca3af);
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.light-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary, #9ca3af);
  font-size: 13px;
  padding: 0 24px;
  text-align: center;
}
</style>
