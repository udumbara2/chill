<template>
  <div
    v-show="open"
    class="content-dock"
    :class="{ overlay: overlay }"
    :style="{ width: width + 'px' }"
  >
    <div class="dock-container">
      <!-- dock header 框架通用区：类型页签条 + 参与/只看开关（仅 editor 型） + 关闭 -->
      <div class="dock-header">
        <div class="dock-tabs">
          <div
            v-for="tab in tabEntries"
            :key="tab.type"
            class="dock-tab"
            :class="{ active: tab.type === activeType }"
            :title="tab.entry.displayName"
            @click="setActiveType(tab.type)"
          >
            <component :is="tab.entry.icon" class="dock-tab-icon" />
            <span class="dock-tab-name">{{ tab.entry.displayName }}</span>
            <!-- 实例计数 + 聚合 +N -M 徽标（数据源 pendingOperations，由 Home 聚合传入） -->
            <span v-if="badges[tab.type]?.count" class="dock-tab-count">{{ badges[tab.type].count }}</span>
            <span
              v-if="badges[tab.type] && (badges[tab.type].add || badges[tab.type].del)"
              class="dock-tab-diff"
            >+{{ badges[tab.type].add ?? 0 }} -{{ badges[tab.type].del ?? 0 }}</span>
            <button
              class="dock-tab-close"
              title="关闭页签"
              @click.stop="closeTab(tab.type)"
            >×</button>
          </div>
        </div>
        <div class="dock-header-actions">
          <button
            v-if="activeEntry?.display === 'editor'"
            class="dock-intent-toggle"
            :class="{ participating: intent === 'edit' }"
            :title="intent === 'edit'
              ? '退回只看（销毁编辑器，回到轻量视图，内容从真相源重读）'
              : '参与操作（挂载完整编辑器；markdown/纯文本全保真，富文本格式保存后将丢失）'"
            @click="toggleIntent"
          >
            {{ intent === 'edit' ? '只看' : '参与操作' }}
          </button>
          <button class="dock-close" title="关闭视窗" @click="closeDock">×</button>
        </div>
      </div>

      <!-- 视窗内容（意图分层=渲染分层）：
           viewer 型组件与 editor 型轻量视图常驻挂载（v-show 保活，切页签不丢滚动位置）；
           editor 型完整编辑器仅在参与态且页签聚焦时 v-if 挂载，退回只看即销毁（状态从真相源重读） -->
      <div class="dock-body">
        <template v-for="tab in tabEntries" :key="tab.type">
          <component
            :is="tab.entry.editorComponent"
            v-if="isEditorMounted(tab)"
            :ref="(el: any) => setEditorRef(tab.type, el)"
            class="dock-view"
          />
          <component
            :is="viewComponentOf(tab)"
            v-else
            v-show="tab.type === activeType"
            :ref="(el: any) => setEditorRef(tab.type, el)"
            :readonly="tab.entry.display === 'editor' && !tab.entry.viewComponent ? true : undefined"
            class="dock-view"
          />
        </template>
        <!-- 参与操作提示条（仅 editor 型轻量态，悬停内容区浮现；与头部开关同一 intent 状态，双入口之一） -->
        <div
          v-if="activeEntry?.display === 'editor' && intent === 'view'"
          class="dock-participate-tip"
          @click="toggleIntent"
        >只看中 · 点击参与操作</div>
        <div v-if="!activeEntry" class="dock-empty">
          <span>从工作区面板 ◐「工作对象」菜单打开一个类型页签</span>
        </div>
      </div>
    </div>

    <!-- 右缘拖拽手柄（覆盖降级模式下隐藏，不再拖宽） -->
    <div
      v-if="!overlay"
      class="dock-resize-handle"
      :class="{ resizing: isResizing }"
      @mousedown="startResize"
      @dblclick="resetWidth"
    ></div>

    <!-- 退回只看前的未保存确认（退回即销毁编辑器，未保存修改随销毁丢失） -->
    <ConfirmDialog
      :is-open="discardConfirmOpen"
      title="未保存的修改"
      message="退回只看将销毁编辑器，未保存的修改会丢失。仍要退回吗？"
      @confirm="confirmReturnToView"
      @cancel="discardConfirmOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, reactive } from 'vue'
import { useResizablePanel } from '../composables/useResizablePanel'
import { IPCKeyValueStore } from '../adapters/IPCKeyValueStore'
import { getViewer, type ViewerEntry } from '../viewerRegistry'
import ConfirmDialog from './ConfirmDialog.vue'

const props = withDefaults(defineProps<{
  /** 窗口过窄时的降级覆盖模式（聊天保持最小可读宽 ~480px）：dock 改为覆盖在聊天区之上 */
  overlay?: boolean
  /** 各类型页签徽标（实例计数来自会话活跃对象集，聚合 +N -M 来自 pendingOperations；由 Home 整合传入） */
  badges?: Record<string, { count?: number; add?: number; del?: number }>
  /** dock 有效最大宽度（窗口 − 面板 − 聊天最小可读宽），由 Home 计算传入；拖拽与恢复持久化均受此钳制 */
  maxWidth?: number
}>(), {
  overlay: false,
  badges: () => ({}),
  maxWidth: Number.MAX_SAFE_INTEGER
})

// ==================== dock 状态（{open, tabs, activeType, width, intent}） ====================
const open = ref(false)
/** 手动打开的类型页签（◐ 菜单/设置跳转等显式入口；持久化，跨会话保留——显式用户意图） */
const manualTabs = ref<string[]>([])
/** 会话驱动的活跃类型（迭代 7：workObjectStore 经 setSessionTypes 推入，按最近活跃降序；运行态，不持久化） */
const sessionTypes = ref<Array<{ type: string; lastActiveAt: number }>>([])
/** 手动关闭的会话页签（type → 关闭时刻）：关页签 ≠ 删对象，该类型有新活跃（lastActiveAt 更新）自动回来 */
const hiddenSessionTabs = reactive<Record<string, number>>({})

/** 可见会话页签（过滤被手动关闭且尚无新活跃的类型） */
const sessionTabs = computed(() =>
  sessionTypes.value
    .filter(s => hiddenSessionTabs[s.type] === undefined || hiddenSessionTabs[s.type] < s.lastActiveAt)
    .map(s => s.type)
)

/** 页签集 = 会话活跃类型（前，按最近活跃降序）∪ 手动页签（后，去重） */
const tabs = computed(() => {
  const out = [...sessionTabs.value]
  for (const t of manualTabs.value) {
    if (!out.includes(t)) out.push(t)
  }
  return out
})

const activeType = ref<string | null>(null)
/** 用户实时意图：view=只看（editor 型只读打开）/ edit=参与操作；viewer 型无此开关 */
const intent = ref<'view' | 'edit'>('view')

// ==================== 宽度拖拽（复用 useResizablePanel；手柄在右缘，向右拖变宽） ====================
// 有效最大宽度：min(60% 窗口宽, Home 传入的 maxWidth)——保证聊天永远保有最小可读宽，拖拽不会触发覆盖降级
const dockMax = () => Math.max(360, Math.min(Math.floor(window.innerWidth * 0.6), props.maxWidth))
const { width, isResizing, startResize, resetWidth } = useResizablePanel({
  defaultWidth: 520,
  minWidth: 360,
  maxWidth: dockMax,
  direction: 'right'
})

// 窗口收窄导致上限下降时，实时把当前宽度钳回范围内（而不是等覆盖降级兜底）
watch(() => props.maxWidth, () => {
  const cap = dockMax()
  if (width.value > cap) width.value = cap
})

// ==================== 持久化（IPCKeyValueStore + localStorage 回退，同 WorkspacePanel 机制） ====================
const STORAGE_KEY = 'content-dock-state'
const kvStore = window.electronAPI?.getKeyValue ? new IPCKeyValueStore() : null

interface DockPersistedState {
  open?: boolean
  tabs?: string[]
  activeType?: string | null
  width?: number
  intent?: 'view' | 'edit'
}

const loadPersistedState = (): DockPersistedState => {
  try {
    const raw = kvStore
      ? kvStore.getItem(STORAGE_KEY)
      : localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const persistState = () => {
  try {
    const raw = JSON.stringify({
      open: open.value,
      // 仅持久化手动页签；会话驱动页签为运行态（重启后由对象活跃重新驱动，不复活过期页签）
      tabs: manualTabs.value,
      activeType: activeType.value,
      width: width.value,
      intent: intent.value
    } satisfies DockPersistedState)
    if (kvStore) kvStore.setItem(STORAGE_KEY, raw)
    else localStorage.setItem(STORAGE_KEY, raw)
  } catch { /* 持久化失败不影响使用 */ }
}

// 恢复持久化状态（过滤掉已注销/none 型页签；activeType 越界时回落到最后一个页签）
const persisted = loadPersistedState()
if (Array.isArray(persisted.tabs)) {
  manualTabs.value = persisted.tabs.filter(t => {
    const entry = getViewer(t)
    return !!entry && entry.display !== 'none'
  })
}
if (typeof persisted.width === 'number' && persisted.width >= 360) {
  // 恢复时同样受有效最大宽度钳制（防过期/异常持久化值挤压聊天区）
  width.value = Math.min(persisted.width, dockMax())
}
if (persisted.intent === 'edit') {
  intent.value = 'edit'
}
if (persisted.activeType && tabs.value.includes(persisted.activeType)) {
  activeType.value = persisted.activeType
} else {
  activeType.value = tabs.value[tabs.value.length - 1] ?? null
}
open.value = persisted.open === true && tabs.value.length > 0

// 持久化时机：kv:set 为 sendSync 同步落盘，拖拽 mousemove 逐帧写入会卡顿，
// 故仅在非拖拽状态变化与拖拽结束时写入（同 WorkspacePanel）
// 注：watch manualTabs 而非 tabs——tabs 含会话驱动页签（运行态），其变化不应触发落盘
watch([open, activeType, intent, manualTabs], () => {
  if (!isResizing.value) persistState()
}, { deep: true })
watch(width, () => {
  if (!isResizing.value) persistState()
})
watch(isResizing, (resizing) => {
  if (!resizing) persistState()
})

// ==================== 页签与组件渲染 ====================
const tabEntries = computed(() =>
  tabs.value
    .map(type => ({ type, entry: getViewer(type) }))
    .filter((x): x is { type: string; entry: ViewerEntry } => !!x.entry && x.entry.display !== 'none')
)

const activeEntry = computed(() => (activeType.value ? getViewer(activeType.value) : undefined))

// ==================== 渲染分层（意图分层=渲染分层） ====================
/** 完整编辑器仅在参与态且页签聚焦时挂载（v-if）；退回只看/切页签即销毁，状态经 store/真相源保留 */
const isEditorMounted = (tab: { type: string; entry: ViewerEntry }) =>
  tab.entry.display === 'editor' &&
  !!tab.entry.editorComponent &&
  intent.value === 'edit' &&
  tab.type === activeType.value

/** 轻量渲染态组件：editor 型取 viewComponent（缺失时回退编辑器只读形态），viewer 型取 component */
const viewComponentOf = (tab: { type: string; entry: ViewerEntry }) =>
  tab.entry.display === 'editor'
    ? (tab.entry.viewComponent ?? tab.entry.editorComponent)
    : tab.entry.component

// 各类型组件实例引用（v-for 函数 ref 维护；页签关闭时 Vue 自动以 null 回调清除）
const editorRefs: Record<string, any> = {}

const setEditorRef = (type: string, el: any) => {
  if (el) editorRefs[type] = el
  else delete editorRefs[type]
}

// ==================== 对外行为 ====================
/** 打开 dock；传入类型时聚焦之（不在页签集则按显式入口加入手动页签；none 型不进视窗） */
const openDock = (type?: string) => {
  if (type) {
    const entry = getViewer(type)
    if (!entry || entry.display === 'none') return
    if (!tabs.value.includes(type)) {
      manualTabs.value.push(type)
    }
    // 显式打开一个曾被关闭的会话页签：解除隐藏（同"新活跃自动回来"语义）
    delete hiddenSessionTabs[type]
    activeType.value = type
  }
  open.value = true
}

const closeDock = () => {
  open.value = false
}

/** 会话活跃类型同步（迭代 7：workObjectStore 摘要推入；跟随会话切换，dock 已开时新类型自动进页签条） */
const setSessionTypes = (summaries: Array<{ type: string; lastActiveAt: number }>) => {
  sessionTypes.value = summaries.filter(s => {
    const entry = getViewer(s.type)
    return !!entry && entry.display !== 'none'
  })
  // 聚焦类型随会话切换失效时回落（优先最近活跃的会话类型，其次手动页签）
  if (activeType.value && !tabs.value.includes(activeType.value)) {
    activeType.value = tabs.value[tabs.value.length - 1] ?? null
  }
  // 新会话无任何页签时收起 dock（勿停留空视窗）
  if (open.value && tabs.value.length === 0) {
    open.value = false
  }
}

/** 关闭页签 ≠ 删对象：手动页签直接移除；会话页签仅隐藏（该类型有新活跃自动回来）；全部关闭后 dock 一并收起 */
const closeTab = (type: string) => {
  if (!tabs.value.includes(type)) return
  if (sessionTabs.value.includes(type)) {
    hiddenSessionTabs[type] = Date.now()
  } else {
    const index = manualTabs.value.indexOf(type)
    if (index !== -1) manualTabs.value.splice(index, 1)
  }
  if (activeType.value === type) {
    activeType.value = tabs.value[tabs.value.length - 1] ?? null
  }
  if (tabs.value.length === 0) {
    open.value = false
  }
}

const setActiveType = (type: string) => {
  if (tabs.value.includes(type)) {
    activeType.value = type
  }
}

/** 参与/只看开关：切 intent 即切渲染态——参与=从真相源重读挂载完整编辑器；退回=脏检查后销毁编辑器回轻量视图 */
const toggleIntent = () => {
  if (intent.value === 'edit') {
    // 退回即销毁编辑器：有未保存修改时先确认（脏状态在 writingViewStore，由编辑器暴露查询）
    const editor = activeType.value ? editorRefs[activeType.value] : undefined
    if (editor?.hasUnsavedChanges?.()) {
      discardConfirmOpen.value = true
      return
    }
  }
  intent.value = intent.value === 'edit' ? 'view' : 'edit'
}

const discardConfirmOpen = ref(false)
const confirmReturnToView = () => {
  discardConfirmOpen.value = false
  intent.value = 'view'
}

const isTypeActive = (type: string) => open.value && activeType.value === type

/** 当前聚焦类型的编辑器/视图组件实例（Home 的编排经此转发到 dock 内当前编辑器） */
const getActiveEditorRef = () => (activeType.value ? editorRefs[activeType.value] : undefined)

/** 等待当前页签组件挂载完成（defineAsyncComponent 首次加载需拉取 chunk） */
const waitActiveEditor = async (): Promise<any> => {
  for (let i = 0; i < 100; i++) {
    const editor = getActiveEditorRef()
    if (editor) return editor
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return null
}

defineExpose({
  open,
  activeType,
  intent,
  width,
  openDock,
  closeDock,
  setActiveType,
  setSessionTypes,
  closeTab,
  isTypeActive,
  getActiveEditorRef,
  waitActiveEditor
})
</script>

<style scoped>
/* 工作对象视窗：表面色与工作区面板（--background-tertiary）/聊天区（#faf9f6）逐级区分 */
.content-dock {
  flex: 0 0 auto;
  height: 100%;
  position: relative; /* 覆盖模式外的流内段定位基准（内部绝对定位元素） */
  display: flex;
  flex-direction: row;
  min-width: 0;
  background-color: var(--background-primary, #ffffff);
  border-right: 1px solid var(--border-color, #e5e7eb);
}

/* 窄窗口降级：覆盖在聊天区之上（聊天区保持最小可读宽，不再被挤压） */
.content-dock.overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1500; /* 低于设置覆盖层（2000），高于页面布局层 */
  border-right: none;
  border-left: 1px solid var(--border-color, #e5e7eb);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
}

.dock-container {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.dock-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-2, 8px);
  min-height: 34px;
  padding: 0 var(--spacing-2, 8px);
  background-color: var(--background-tertiary, #f1f5f9);
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}

.dock-tabs {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
}

.dock-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-md, 6px);
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s ease;
}

.dock-tab:hover {
  background-color: var(--background-secondary, #f8fafc);
}

.dock-tab.active {
  background-color: var(--background-secondary, #f8fafc);
  color: var(--primary-color, #3b82f6);
  font-weight: 500;
}

.dock-tab-icon {
  flex: 0 0 auto;
  display: block;
}

.dock-tab-count {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  background-color: var(--background-primary, #ffffff);
  color: var(--text-tertiary, #9ca3af);
}

/* 聚合 +N -M 徽标（与轻量视图/编辑器 diff 预览同源于 pendingOperations） */
.dock-tab-diff {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  background-color: var(--background-primary, #ffffff);
  color: var(--text-tertiary, #9ca3af);
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.dock-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: var(--radius-md, 6px);
  background-color: transparent;
  color: var(--text-tertiary, #9ca3af);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s ease;
}

.dock-tab-close:hover {
  background-color: var(--background-tertiary, #f1f5f9);
  color: var(--text-primary, #111827);
}

.dock-header-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

.dock-intent-toggle {
  padding: 3px 10px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: var(--radius-md, 6px);
  background-color: var(--background-primary, #ffffff);
  color: var(--text-secondary, #6b7280);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.dock-intent-toggle:hover {
  color: var(--primary-color, #3b82f6);
  border-color: var(--primary-color, #3b82f6);
}

.dock-intent-toggle.participating {
  background-color: var(--primary-color, #3b82f6);
  border-color: var(--primary-color, #3b82f6);
  color: #ffffff;
}

.dock-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-md, 6px);
  background-color: transparent;
  color: var(--text-secondary, #6b7280);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s ease;
}

.dock-close:hover {
  background-color: var(--background-secondary, #f8fafc);
  color: var(--text-primary, #111827);
}

.dock-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative; /* 参与提示条的定位基准 */
}

/* 参与操作提示条：悬停内容区浮现（Google Docs 查看模式铅笔/Office「启用编辑」同款惯例） */
.dock-participate-tip {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color, #e5e7eb);
  background-color: var(--background-primary, #ffffff);
  color: var(--text-secondary, #6b7280);
  font-size: 12px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.dock-body:hover .dock-participate-tip {
  opacity: 1;
  pointer-events: auto;
}

.dock-participate-tip:hover {
  color: var(--primary-color, #3b82f6);
  border-color: var(--primary-color, #3b82f6);
}

.dock-view {
  flex: 1 1 auto;
  min-height: 0;
}

.dock-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-tertiary, #9ca3af);
}

/* 右缘拖拽手柄 */
.dock-resize-handle {
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

.dock-resize-handle:hover,
.dock-resize-handle.resizing {
  background-color: var(--primary-color, #3b82f6);
}
</style>
