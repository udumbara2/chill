<template>
  <Teleport to="body">
    <div v-if="isOpen" class="backup-restore-overlay" @click="handleClose">
      <div class="backup-restore-container" @click.stop>
        <div class="backup-restore-header">
          <h3 class="backup-restore-title">恢复中心</h3>
          <button class="backup-restore-close" @click="handleClose">×</button>
        </div>

        <div class="backup-restore-tabs">
          <button
            class="backup-tab"
            :class="{ active: activeTab === 'file' }"
            :disabled="!filePath"
            @click="activeTab = 'file'"
          >按文件</button>
          <button
            class="backup-tab"
            :class="{ active: activeTab === 'turn' }"
            @click="switchToTurnTab"
          >按轮次</button>
        </div>

        <!-- ==================== 按文件 ==================== -->
        <div v-if="activeTab === 'file'" class="backup-restore-body">
          <div class="backup-list-pane">
            <div class="backup-pane-title">{{ fileName }}</div>
            <div v-if="fileEntriesLoading" class="backup-empty">加载中…</div>
            <div v-else-if="fileEntries.length === 0" class="backup-empty">该文件暂无备份快照</div>
            <div
              v-for="entry in fileEntries"
              :key="entry.ts"
              class="backup-list-item"
              :class="{ active: selectedEntry?.ts === entry.ts }"
              @click="selectEntry(entry)"
            >
              <div class="backup-item-time">{{ formatTs(entry.ts) }}</div>
              <div class="backup-item-meta">
                <span class="backup-item-tool">{{ entry.toolName }}</span>
                <span v-if="entry.source === 'worker'" class="backup-item-badge">后台任务</span>
                <span v-if="!entry.existed" class="backup-item-badge warn">创建前</span>
              </div>
            </div>
          </div>
          <div class="backup-preview-pane">
            <template v-if="selectedEntry">
              <div v-if="!selectedEntry.existed" class="backup-notice warn">
                该快照记录于文件创建之前（当时文件不存在）——恢复 = 文件移入回收站
              </div>
              <div class="backup-pane-title">恢复后变化预览（<span class="sign-del">- 当前行将移除</span> / <span class="sign-add">+ 快照行将恢复</span>）</div>
              <div v-if="previewLoading" class="backup-empty">加载中…</div>
              <div v-else-if="previewError" class="backup-notice warn">{{ previewError }}</div>
              <div v-else-if="previewRows === null" class="backup-empty">文件过大，无法生成行级预览</div>
              <div v-else-if="previewRows.length === 0" class="backup-empty">快照与当前内容一致</div>
              <div v-else class="backup-diff">
                <div
                  v-for="(row, i) in previewRows"
                  :key="i"
                  class="backup-diff-row"
                  :class="{ 'is-add': row.type === 'add', 'is-del': row.type === 'del' }"
                ><span class="backup-diff-sign">{{ row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ' }}</span>{{ row.text }}</div>
              </div>
              <div class="backup-confirm-bar">
                <template v-if="!confirmingFile">
                  <button class="backup-btn primary" :disabled="restoring" @click="confirmingFile = true">
                    恢复到此版本
                  </button>
                </template>
                <template v-else>
                  <span v-if="fileDirtyNames.length" class="backup-notice warn inline">
                    {{ fileDirtyNames.join('、') }} 有未保存修改，恢复将一并丢弃
                  </span>
                  <span v-else class="backup-confirm-text">确认覆盖当前文件？（恢复前会自动留存现状快照）</span>
                  <button class="backup-btn" :disabled="restoring" @click="confirmingFile = false">取消</button>
                  <button class="backup-btn danger" :disabled="restoring" @click="executeFileRestore">
                    {{ restoring ? '恢复中…' : '确认恢复' }}
                  </button>
                </template>
              </div>
            </template>
            <div v-else class="backup-empty">选择左侧的版本查看差异预览</div>
          </div>
        </div>

        <!-- ==================== 按轮次 ==================== -->
        <div v-else class="backup-restore-body">
          <div class="backup-list-pane">
            <div class="backup-pane-title">本会话最近轮次</div>
            <div v-if="!sessionId" class="backup-empty">当前无会话</div>
            <div v-else-if="turnGroupsLoading" class="backup-empty">加载中…</div>
            <div v-else-if="turnGroups.length === 0" class="backup-empty">本会话暂无写入轮次记录</div>
            <div
              v-for="group in turnGroups"
              :key="groupKey(group)"
              class="backup-list-item"
              :class="{ active: selectedGroup && groupKey(selectedGroup) === groupKey(group) }"
              @click="selectGroup(group)"
            >
              <div class="backup-item-time">{{ formatTs(groupTs(group)) }}</div>
              <div class="backup-item-meta">
                <span class="backup-item-tool">{{ group.files.length }} 个文件</span>
                <span v-if="group.taskId" class="backup-item-badge">后台任务</span>
              </div>
              <div class="backup-item-tools">{{ group.toolNames.join('、') }}</div>
            </div>
          </div>
          <div class="backup-preview-pane">
            <template v-if="selectedGroup">
              <div class="backup-pane-title">该轮写入的文件（恢复 = 各文件回到写前状态）</div>
              <div v-if="turnFilesLoading" class="backup-empty">加载中…</div>
              <div v-else class="backup-turn-files">
                <div v-for="tf in turnFiles" :key="tf.path" class="backup-turn-file">
                  <div class="backup-turn-file-head" @click="toggleTurnFilePreview(tf)">
                    <span class="backup-turn-file-name">{{ tf.path }}</span>
                    <span v-if="tf.entryMissing" class="backup-item-badge warn">无对应快照</span>
                    <span v-else-if="tf.entry && !tf.entry.existed" class="backup-item-badge warn">创建前（恢复=移入回收站）</span>
                    <span class="backup-turn-file-toggle">{{ tf.expanded ? '收起' : '预览' }}</span>
                  </div>
                  <div v-if="tf.expanded" class="backup-turn-file-preview">
                    <div v-if="tf.previewLoading" class="backup-empty">加载中…</div>
                    <div v-else-if="tf.previewError" class="backup-notice warn">{{ tf.previewError }}</div>
                    <div v-else-if="tf.rows === null" class="backup-empty">文件过大，无法生成行级预览</div>
                    <div v-else-if="tf.rows.length === 0" class="backup-empty">快照与当前内容一致</div>
                    <div v-else class="backup-diff">
                      <div
                        v-for="(row, i) in tf.rows"
                        :key="i"
                        class="backup-diff-row"
                        :class="{ 'is-add': row.type === 'add', 'is-del': row.type === 'del' }"
                      ><span class="backup-diff-sign">{{ row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ' }}</span>{{ row.text }}</div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="backup-confirm-bar">
                <template v-if="!confirmingTurn">
                  <button class="backup-btn primary" :disabled="restoring" @click="confirmingTurn = true">
                    恢复整个轮次
                  </button>
                </template>
                <template v-else>
                  <span v-if="turnDirtyNames.length" class="backup-notice warn inline">
                    {{ turnDirtyNames.join('、') }} 有未保存修改，恢复将一并丢弃
                  </span>
                  <span v-else class="backup-confirm-text">确认恢复该轮全部 {{ selectedGroup.files.length }} 个文件？（各文件恢复前会自动留存现状快照）</span>
                  <button class="backup-btn" :disabled="restoring" @click="confirmingTurn = false">取消</button>
                  <button class="backup-btn danger" :disabled="restoring" @click="executeTurnRestore">
                    {{ restoring ? '恢复中…' : '确认恢复' }}
                  </button>
                </template>
              </div>
            </template>
            <div v-else class="backup-empty">选择左侧的轮次查看文件清单</div>
          </div>
        </div>

        <!-- 轮次级恢复结果 -->
        <div v-if="turnResult" class="backup-result">
          <div class="backup-pane-title">恢复结果</div>
          <div v-if="turnResult.restored.length" class="backup-result-ok">
            已恢复 {{ turnResult.restored.length }} 个文件：{{ turnResult.restored.join('、') }}
          </div>
          <div v-if="turnResult.errors.length" class="backup-notice warn">
            {{ turnResult.errors.length }} 个恢复失败：{{ turnResult.errors.join('；') }}
          </div>
        </div>

        <div v-if="statusMessage" class="backup-status" :class="{ error: statusIsError }">
          {{ statusMessage }}
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { getBackupStore, getChatEngine, readBackupSnapshotContent } from '../services/chatEngine'
import { useWritingViewStore } from '../stores/writingViewStore'
import { lineDiffRows, normalizeFilePath, type DiffLineRow } from '../utils/lightDiff'
import { getHostAPI } from '../host/hostApi'
import type { BackupEntry, TurnGroup } from '@assistant-ai/core'

interface TurnFilePreview {
  path: string
  entry: BackupEntry | null
  entryMissing: boolean
  expanded: boolean
  previewLoading: boolean
  previewLoaded: boolean
  previewError: string
  rows: DiffLineRow[] | null
}

const props = withDefaults(defineProps<{
  isOpen?: boolean
  /** 「按文件」视图的目标文件（文件树右键入口带入） */
  filePath?: string
}>(), {
  isOpen: false,
  filePath: ''
})

const emit = defineEmits<{
  close: []
  /** 恢复执行完成（paths = 实际恢复成功的文件；父侧负责 reloadFile/文件树失效/快照缓存失效） */
  restored: [payload: { paths: string[] }]
}>()

const writingViewStore = useWritingViewStore()

const activeTab = ref<'file' | 'turn'>('file')
const restoring = ref(false)
const statusMessage = ref('')
const statusIsError = ref(false)

// ---------- 按文件 ----------
const fileEntries = ref<BackupEntry[]>([])
const fileEntriesLoading = ref(false)
const selectedEntry = ref<BackupEntry | null>(null)
const previewRows = ref<DiffLineRow[] | null>([])
const previewLoading = ref(false)
const previewError = ref('')
const confirmingFile = ref(false)

// ---------- 按轮次 ----------
const turnGroups = ref<TurnGroup[]>([])
const turnGroupsLoading = ref(false)
const selectedGroup = ref<TurnGroup | null>(null)
const turnFiles = ref<TurnFilePreview[]>([])
const turnFilesLoading = ref(false)
const confirmingTurn = ref(false)
const turnResult = ref<{ restored: string[]; errors: string[] } | null>(null)

const sessionId = computed(() => getChatEngine().getSessionState().sessionId ?? '')

const fileName = computed(() => props.filePath.replace(/\\/g, '/').split('/').pop() || props.filePath)

/** 脏 tab 检测：目标路径在写作编辑器中有未保存修改的 tab 名清单（恢复确认前明示） */
const dirtyNamesOf = (paths: string[]): string[] => {
  const names: string[] = []
  for (const p of paths) {
    const tab = writingViewStore.tabs.find(t => normalizeFilePath(t.path) === normalizeFilePath(p))
    if (tab && writingViewStore.isDirty(tab.id)) names.push(tab.name)
  }
  return names
}

const fileDirtyNames = computed(() => (props.filePath ? dirtyNamesOf([props.filePath]) : []))
const turnDirtyNames = computed(() => (selectedGroup.value ? dirtyNamesOf(selectedGroup.value.files) : []))

const groupTs = (g: TurnGroup): string => g.lastTs
const groupKey = (g: TurnGroup): string => g.key

const formatTs = (ts: string): string => {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(ts)
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`
  const d = new Date(ts)
  return isNaN(d.getTime()) ? ts : d.toLocaleString()
}

/** 经宿主合同现读文本内容（渲染进程无 fs）；失败返回 null */
const readText = async (path: string): Promise<string | null> => {
  try {
    const resp = await getHostAPI().fileRead(path)
    return resp?.success && typeof resp.content === 'string' ? resp.content : null
  } catch {
    return null
  }
}

/** 行级预览：快照（恢复目标）vs 当前文件内容；del=当前将移除的行，add=快照将恢复的行 */
const buildPreviewRows = async (
  targetPath: string,
  entry: BackupEntry
): Promise<{ rows: DiffLineRow[] | null; error: string }> => {
  const current = await readText(targetPath)
  if (current === null) return { rows: null, error: '当前文件读取失败，无法生成预览' }
  // existed:false = 创建前标记快照（无内容）——恢复即移除文件，全部当前行都是 del
  if (!entry.existed) return { rows: lineDiffRows(current, '') ?? [], error: '' }
  const snapshot = await readBackupSnapshotContent(targetPath, entry.file)
  if (snapshot === null) return { rows: null, error: '快照内容读取失败，无法预览（仍可恢复）' }
  return { rows: lineDiffRows(current, snapshot), error: '' }
}

// ==================== 按文件 ====================

const loadFileEntries = async () => {
  if (!props.filePath) return
  fileEntriesLoading.value = true
  selectedEntry.value = null
  confirmingFile.value = false
  try {
    fileEntries.value = await getBackupStore().list(props.filePath)
  } catch (err: any) {
    fileEntries.value = []
    setStatus(err?.message || '备份列表读取失败', true)
  } finally {
    fileEntriesLoading.value = false
  }
}

const selectEntry = async (entry: BackupEntry) => {
  selectedEntry.value = entry
  confirmingFile.value = false
  previewLoading.value = true
  previewError.value = ''
  try {
    const { rows, error } = await buildPreviewRows(props.filePath, entry)
    previewRows.value = rows
    previewError.value = error
  } finally {
    previewLoading.value = false
  }
}

const executeFileRestore = async () => {
  if (!selectedEntry.value || restoring.value) return
  restoring.value = true
  try {
    // 返回 { restored, warning?, error? }（warning = 恢复成功但现状快照未留存——兜底失守必须可见）
    const result = await getBackupStore().restore(props.filePath, selectedEntry.value.ts)
    const ok = result.restored
    if (ok) {
      setStatus(
        `已恢复到 ${formatTs(selectedEntry.value.ts)} 的版本` +
          (result?.warning ? `（警告：${result.warning}）` : '（恢复前的现状已另存快照）'),
        !!result?.warning
      )
      // 回滚后模型感知对齐（设计 §D / core synthetic 约定）：告知模型文件已回滚，防基于错误认知继续操作
      getChatEngine().appendSyntheticMessage(
        `用户通过恢复中心把文件 ${props.filePath} 恢复到了 ${formatTs(selectedEntry.value.ts)} 的备份版本（该文件此后的改动可能已被撤销）`,
        'backupRestore'
      )
      emit('restored', { paths: [props.filePath] })
      confirmingFile.value = false
      // 恢复本身又拍了一份现状快照 → 列表重取
      await loadFileEntries()
    } else {
      setStatus(result?.error || '恢复失败', true)
    }
  } catch (err: any) {
    setStatus(err?.message || '恢复失败', true)
  } finally {
    restoring.value = false
  }
}

// ==================== 按轮次 ====================

const loadTurnGroups = async () => {
  if (!sessionId.value) return
  turnGroupsLoading.value = true
  selectedGroup.value = null
  confirmingTurn.value = false
  turnResult.value = null
  try {
    turnGroups.value = await getBackupStore().listTurns(sessionId.value, 10)
  } catch (err: any) {
    turnGroups.value = []
    setStatus(err?.message || '轮次列表读取失败', true)
  } finally {
    turnGroupsLoading.value = false
  }
}

const switchToTurnTab = () => {
  activeTab.value = 'turn'
  void loadTurnGroups()
}

const selectGroup = async (group: TurnGroup) => {
  selectedGroup.value = group
  confirmingTurn.value = false
  turnResult.value = null
  turnFilesLoading.value = true
  try {
    // 逐文件定位该轮对应的快照条目（归因字段精确匹配；预览点击展开时才读内容）
    const list = await Promise.all(
      group.files.map(async (path): Promise<TurnFilePreview> => {
        let entry: BackupEntry | null = null
        try {
          const entries = await getBackupStore().list(path)
          entry = entries.find(e =>
            (group.taskId && e.taskId === group.taskId) ||
            (group.turnId && e.turnId === group.turnId)
          ) ?? null
        } catch {
          entry = null
        }
        return {
          path,
          entry,
          entryMissing: !entry,
          expanded: false,
          previewLoading: false,
          previewLoaded: false,
          previewError: '',
          rows: []
        }
      })
    )
    turnFiles.value = list
  } finally {
    turnFilesLoading.value = false
  }
}

const toggleTurnFilePreview = async (tf: TurnFilePreview) => {
  tf.expanded = !tf.expanded
  if (!tf.expanded || tf.previewLoading || tf.previewLoaded) return
  if (!tf.entry) {
    tf.previewError = '未找到该轮对应的快照'
    tf.previewLoaded = true
    return
  }
  tf.previewLoading = true
  try {
    const { rows, error } = await buildPreviewRows(tf.path, tf.entry)
    tf.rows = rows
    tf.previewError = error
  } finally {
    tf.previewLoading = false
    tf.previewLoaded = true
  }
}

const executeTurnRestore = async () => {
  if (!selectedGroup.value || !sessionId.value || restoring.value) return
  restoring.value = true
  try {
    const group = selectedGroup.value
    // 任务组按 taskId 恢复（独立恢复单位）；轮次组按 turnId（taskId 缺省即排除任务委派的写）
    const result = await getBackupStore().restoreTurn(sessionId.value, group.turnId ?? '', group.taskId)
    const restored = result?.restored ?? []
    const errors = result?.errors ?? []
    turnResult.value = { restored, errors }
    confirmingTurn.value = false
    if (restored.length > 0) {
      // 回滚后模型感知对齐（设计 §D）：合成留痕消息告知模型文件已回滚，防基于错误认知继续操作
      getChatEngine().appendSyntheticMessage(
        `用户通过恢复中心把 ${restored.length} 个文件回滚到该轮写入之前的状态：${restored.join('、')}` +
          (errors.length ? `；另有 ${errors.length} 个恢复失败` : ''),
        'backupRestore'
      )
      emit('restored', { paths: restored })
    }
    if (errors.length > 0) {
      setStatus(`${errors.length} 个文件恢复失败，详见上方结果`, true)
    }
  } catch (err: any) {
    setStatus(err?.message || '轮次恢复失败', true)
  } finally {
    restoring.value = false
  }
}

// ==================== 通用 ====================

const setStatus = (msg: string, isError: boolean) => {
  statusMessage.value = msg
  statusIsError.value = isError
}

const handleClose = () => {
  if (restoring.value) return
  emit('close')
}

watch(
  () => [props.isOpen, props.filePath] as const,
  ([open]) => {
    if (!open) return
    activeTab.value = props.filePath ? 'file' : 'turn'
    statusMessage.value = ''
    turnResult.value = null
    if (props.filePath) {
      void loadFileEntries()
    } else {
      void loadTurnGroups()
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.backup-restore-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.backup-restore-container {
  background-color: var(--background-primary, #ffffff);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  width: 760px;
  max-width: 92vw;
  height: 560px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
}

.backup-restore-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.backup-restore-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #111827);
}

.backup-restore-close {
  border: none;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  color: var(--text-secondary, #6b7280);
}

.backup-restore-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}

.backup-tab {
  border: none;
  background: transparent;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-secondary, #6b7280);
  border-bottom: 2px solid transparent;
}

.backup-tab.active {
  color: var(--primary-color, #3b82f6);
  border-bottom-color: var(--primary-color, #3b82f6);
  font-weight: 500;
}

.backup-tab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.backup-restore-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: 12px;
}

.backup-list-pane {
  flex: 0 0 240px;
  overflow-y: auto;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  padding: 8px;
}

.backup-preview-pane {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  padding: 8px;
}

.backup-pane-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #6b7280);
  margin-bottom: 8px;
}

.backup-list-item {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  margin-bottom: 4px;
}

.backup-list-item:hover {
  background-color: var(--background-secondary, #f3f4f6);
}

.backup-list-item.active {
  background-color: var(--background-secondary, #f3f4f6);
  outline: 1px solid var(--primary-color, #3b82f6);
}

.backup-item-time {
  font-size: 13px;
  color: var(--text-primary, #111827);
}

.backup-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.backup-item-tool {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}

.backup-item-tools {
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backup-item-badge {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  background-color: var(--background-tertiary, #e5e7eb);
  color: var(--text-secondary, #6b7280);
}

.backup-item-badge.warn {
  background-color: rgba(245, 158, 11, 0.15);
  color: #b45309;
}

.backup-empty {
  padding: 16px 8px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary, #9ca3af);
}

.backup-notice {
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  margin-bottom: 8px;
}

.backup-notice.warn {
  background-color: rgba(245, 158, 11, 0.12);
  color: #b45309;
}

.backup-notice.inline {
  margin-bottom: 0;
  padding: 4px 6px;
}

.sign-del { color: #dc2626; }
.sign-add { color: #16a34a; }

.backup-diff {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.backup-diff-row {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary, #6b7280);
}

.backup-diff-row.is-add {
  background-color: rgba(34, 197, 94, 0.12);
  color: var(--text-primary, #111827);
}

.backup-diff-row.is-del {
  background-color: rgba(239, 68, 68, 0.10);
  color: var(--text-tertiary, #9ca3af);
  text-decoration: line-through;
}

.backup-diff-sign {
  display: inline-block;
  width: 16px;
  color: var(--text-tertiary, #9ca3af);
  user-select: none;
}

.backup-turn-files {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.backup-turn-file {
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  margin-bottom: 6px;
  padding: 6px 8px;
}

.backup-turn-file-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.backup-turn-file-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--text-primary, #111827);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.backup-turn-file-toggle {
  font-size: 12px;
  color: var(--primary-color, #3b82f6);
  flex-shrink: 0;
}

.backup-turn-file-preview {
  margin-top: 6px;
  max-height: 220px;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.backup-confirm-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.backup-confirm-text {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  margin-right: auto;
}

.backup-btn {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  border: none;
  background-color: var(--background-secondary, #f3f4f6);
  color: var(--text-primary, #111827);
}

.backup-btn.primary {
  background-color: var(--primary-color, #3b82f6);
  color: #ffffff;
}

.backup-btn.danger {
  background-color: #ef4444;
  color: #ffffff;
}

.backup-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.backup-result {
  flex: 0 0 auto;
  margin-top: 8px;
  border-top: 1px solid var(--border-color, #e5e7eb);
  padding-top: 8px;
  max-height: 120px;
  overflow-y: auto;
}

.backup-result-ok {
  font-size: 12px;
  color: var(--success-color, #16a34a);
}

.backup-status {
  flex: 0 0 auto;
  margin-top: 8px;
  font-size: 12px;
  color: var(--success-color, #16a34a);
}

.backup-status.error {
  color: #dc2626;
}
</style>
