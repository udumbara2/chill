<template>
  <div v-show="visible" class="workspace-panel" :style="{ width: width + 'px' }">
    <div class="panel-content">
      <!-- 上部：常用设置项（管当前生效项；模型选择器仅输入框旁单入口，此处不重复） -->
      <div class="panel-section quick-settings">
        <div class="section-title">常用功能</div>
        <div class="quick-setting-row">
          <button class="new-chat-btn" @click="emit('new-conversation')" title="新建对话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
            <span>新建对话</span>
          </button>
        </div>
      </div>

      <!-- 下部：项目+会话列表 -->
      <div class="panel-section session-list-section">
        <div class="section-header">
          <span class="section-title">项目与会话</span>
          <div class="section-actions">
            <button
              class="section-action-btn"
              @click.stop="startCreateProject"
              title="新建项目"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
            <button
              class="section-action-btn"
              @click.stop="startCreateProjectWithFolder"
              title="选择文件夹新建项目"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                <line x1="12" y1="11" x2="12" y2="17"></line>
                <line x1="9" y1="14" x2="15" y2="14"></line>
              </svg>
            </button>
            <!-- ◐ 工作对象开关（迭代 7 会话驱动）：主体按下直开 dock 定位最近活跃类型（无活跃类型置灰）；
                 ▾ 展开菜单——当前会话活跃类型（带徽标）+ 其余注册类型手动开 -->
            <div class="work-object-menu">
              <button
                class="work-object-toggle"
                :class="{ disabled: !mostRecentWorkObjectType }"
                :disabled="!mostRecentWorkObjectType"
                @click.stop="pressWorkObject"
                :title="mostRecentWorkObjectType
                  ? '打开工作对象视窗（最近活跃类型）'
                  : '当前会话暂无活跃工作对象（▾ 可手动打开类型）'"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
                </svg>
                <!-- ◐ 聚合徽标：会话内有未看更新的类型数 -->
                <span v-if="workObjectUnseenCount" class="work-object-badge">{{ workObjectUnseenCount }}</span>
              </button>
              <button
                class="work-object-caret"
                :class="{ 'menu-open': showWorkObjectMenu }"
                @click.stop="toggleWorkObjectMenu"
                title="工作对象菜单"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <div v-if="showWorkObjectMenu" class="work-object-dropdown">
                <template v-if="activeWorkObjects.length > 0">
                  <div class="work-object-section-title">当前会话</div>
                  <div
                    v-for="summary in activeWorkObjects"
                    :key="summary.type"
                    class="work-object-item"
                    @click="openWorkObject(summary.type)"
                  >
                    <div class="work-object-icon">
                      <component :is="summary.entry.icon" />
                    </div>
                    <span class="work-object-name">{{ summary.entry.displayName }}</span>
                    <span class="work-object-count">{{ summary.count }}</span>
                    <span v-if="summary.unseen" class="work-object-unseen-dot" title="有未看更新"></span>
                  </div>
                  <div class="work-object-section-title">全部类型</div>
                </template>
                <div
                  v-for="viewer in manualWorkObjectViewers"
                  :key="viewer.type"
                  class="work-object-item"
                  @click="openWorkObject(viewer.type)"
                >
                  <div class="work-object-icon">
                    <component :is="viewer.icon" />
                  </div>
                  <span class="work-object-name">{{ viewer.displayName }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 项目列表（未分组 + 各项目；选中即过滤下方会话列表） -->
        <div class="project-list">
          <div
            class="project-item"
            :class="{ active: projectStore.currentProjectId === null }"
            @click="projectStore.selectProject(null)"
          >
            <span class="project-name">未分组</span>
          </div>
          <div
            v-for="project in projectStore.projects"
            :key="project.id"
            class="project-item"
            :class="{ active: projectStore.currentProjectId === project.id }"
            @click="projectStore.selectProject(project.id)"
          >
            <input
              v-if="renamingProjectId === project.id"
              v-model="projectInputValue"
              v-focus
              class="project-input"
              @click.stop
              @keydown.enter="submitRenameProject(project.id)"
              @keydown.esc="cancelProjectInput"
              @blur="cancelProjectInput"
            />
            <template v-else>
              <div class="project-info">
                <span class="project-name">{{ project.name }}</span>
                <span
                  class="project-folder"
                  :class="{ unbound: !project.folderPath, invalid: invalidFolderIds.has(project.id) }"
                  :title="project.folderPath || undefined"
                >{{ folderLabelOf(project) }}</span>
              </div>
              <span class="project-actions">
                <button class="project-action-btn" @click.stop="bindOrRebindFolder(project)" :title="folderActionTitle(project)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                  </svg>
                </button>
                <button v-if="project.folderPath" class="project-action-btn" @click.stop="unbindProjectFolder(project)" title="解绑文件夹">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                    <path d="M5.17 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                    <line x1="2" y1="2" x2="22" y2="22"></line>
                  </svg>
                </button>
                <button class="project-action-btn" @click.stop="startRenameProject(project)" title="重命名">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                </button>
                <button class="project-action-btn danger" @click.stop="confirmDeleteProject(project)" title="删除项目">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3,6 5,6 21,6"></polyline>
                    <path d="M19,6,14,20H10L5,6"></path>
                  </svg>
                </button>
              </span>
            </template>
          </div>
          <div v-if="creatingProject" class="project-item editing">
            <input
              v-model="projectInputValue"
              v-focus
              class="project-input"
              placeholder="项目名称"
              @keydown.enter="submitCreateProject"
              @keydown.esc="cancelProjectInput"
              @blur="cancelProjectInput"
            />
          </div>
        </div>

        <!-- 会话列表（项目内平铺；未分组按日期分组兜底） -->
        <div class="session-list">
          <!-- 未分组写边界状态提示（仅未分组区显示） -->
          <div v-if="projectStore.currentProjectId === null" class="ungrouped-write-hint">
            未分组会话：写文件需逐个批准（无工作目录）
          </div>
          <template v-for="group in sessionGroups" :key="group.label ?? 'flat'">
            <div v-if="group.label" class="session-date-group">{{ group.label }}</div>
            <div
              v-for="session in group.items"
              :key="session.id"
              class="session-item"
              :class="{ active: session.id === currentSessionId }"
            >
              <div class="session-item-content" @click="openSession(session)">
                <div class="session-item-title">
                  <span v-if="session.id === currentSessionId" class="session-active-dot" title="当前会话"></span>
                  <span class="session-title-text">{{ session.title }}</span>
                </div>
                <div class="session-item-meta">
                  <span v-if="projectStore.projectNameOf(session.projectId)" class="session-project-badge">
                    {{ projectStore.projectNameOf(session.projectId) }}
                  </span>
                  <span class="session-time">{{ formatTime(session.updatedAt) }}</span>
                </div>
              </div>
              <div class="session-item-actions">
                <div class="session-move-menu">
                  <button
                    class="session-action-btn"
                    @click.stop="toggleMoveMenu(session.id)"
                    title="移动到项目"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                  </button>
                  <div v-if="moveMenuSessionId === session.id" class="move-dropdown">
                    <div class="move-item" @click.stop="moveSession(session, null)">未分组</div>
                    <div
                      v-for="project in projectStore.projects"
                      :key="project.id"
                      class="move-item"
                      @click.stop="moveSession(session, project.id)"
                    >
                      {{ project.name }}
                    </div>
                  </div>
                </div>
                <button
                  class="session-action-btn danger"
                  @click.stop="confirmDeleteSession(session)"
                  title="删除此对话"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3,6 5,6 21,6"></polyline>
                    <path d="M19,6,14,20H10L5,6"></path>
                  </svg>
                </button>
              </div>
            </div>
          </template>
          <div v-if="sessionGroups.length === 0" class="empty-sessions">暂无会话</div>
        </div>
      </div>

      <!-- 左下角：设置齿轮 -->
      <div class="panel-footer">
        <SettingsButton @open-settings="emit('open-settings')" />
      </div>
    </div>

    <!-- 右缘拖拽手柄：拖宽 / 拖过阈值吸附收起 / 双击复位默认宽 -->
    <div
      class="panel-resize-handle"
      :class="{ 'resizing': isResizing }"
      @mousedown="startResize"
      @dblclick="resetWidth"
    ></div>

    <!-- 删除确认弹窗（会话/项目共用） -->
    <div v-if="deleteConfirm" class="delete-modal" @click="deleteConfirm = null">
      <div class="delete-content" @click.stop>
        <div class="delete-header">
          <h4>确认删除</h4>
        </div>
        <div class="delete-body">
          <template v-if="deleteConfirm.kind === 'session'">
            <p>确定要删除对话 "<strong>{{ deleteConfirm.name }}</strong>" 吗？</p>
            <p class="delete-warning">此操作不可撤销，对话数据将永久消失。</p>
          </template>
          <template v-else>
            <p>确定要删除项目 "<strong>{{ deleteConfirm.name }}</strong>" 吗？</p>
            <p class="delete-warning">项目内会话将归入"未分组"，不会被删除。</p>
          </template>
        </div>
        <div class="delete-footer">
          <button class="cancel-btn" @click="deleteConfirm = null">取消</button>
          <button class="confirm-btn" @click="executeDelete">确认删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import SettingsButton from './SettingsButton.vue'
import { useResizablePanel } from '../composables/useResizablePanel'
import { IPCKeyValueStore } from '../adapters/IPCKeyValueStore'
import { getRegisteredViewers, getViewer, type ViewerEntry } from '../viewerRegistry'
import { useProjectStore } from '../stores/projectStore'
import { useWorkObjectStore, type WorkObjectTypeSummary } from '../stores/workObjectStore'
import { deleteSession } from '@assistant-ai/ui/adapters'
import type { ProjectRecord, SessionRecord } from '@assistant-ai/core'

const props = defineProps<{
  visible: boolean
  /** 当前会话 id（活跃状态指示：列表行高亮 + 圆点） */
  currentSessionId?: string | null
}>()

const emit = defineEmits<{
  'update:visible': [visible: boolean]
  'open-settings': []
  /** 常用功能区「新建对话」 */
  'new-conversation': []
  /** ◐「工作对象」菜单：打开 dock 并切到指定类型页签（类型来自 viewerRegistry） */
  'open-work-object': [type: string]
}>()

// 项目/会话 store（列表、当前项目过滤、归属操作均经此）
const projectStore = useProjectStore()

// ==================== 拖拽调宽（默认 260 / min 200 / max 45% 窗口宽，拖过 100px 吸附收起） ====================
const DEFAULT_WIDTH = 260
const { width, collapsed, isResizing, startResize, resetWidth } = useResizablePanel({
  defaultWidth: DEFAULT_WIDTH,
  minWidth: 200,
  maxWidth: () => Math.floor(window.innerWidth / 3),
  collapseThreshold: 100,
  direction: 'right'
})

// ==================== {collapsed, width} 持久化（IPCKeyValueStore + localStorage 回退） ====================
const STORAGE_KEY = 'workspace-panel-state'
const kvStore = window.electronAPI?.getKeyValue ? new IPCKeyValueStore() : null

const loadPersistedState = (): { width?: number; collapsed?: boolean } => {
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
    const raw = JSON.stringify({ width: width.value, collapsed: collapsed.value })
    if (kvStore) kvStore.setItem(STORAGE_KEY, raw)
    else localStorage.setItem(STORAGE_KEY, raw)
  } catch { /* 持久化失败不影响使用 */ }
}

// 恢复持久化状态（宽度越界时收敛到合法区间）
// 无持久化记录（首次运行）默认收起——纯聊天为默认态，☰ 为重开入口；
// 用户一旦展开过，collapsed=false 落盘后刷新即恢复展开
const persisted = loadPersistedState()
if (typeof persisted.width === 'number' && persisted.width >= 200) {
  width.value = persisted.width
}
collapsed.value = persisted.collapsed !== false

// collapsed 与父级 visible 双向同步（☰ 开关 ↔ 拖拽吸附收起）；
// 面板展开时刷新项目/会话列表（覆盖 CLI 侧新增的会话）
watch(() => props.visible, (v) => {
  collapsed.value = !v
  if (v) {
    reloadProjects()
    void projectStore.loadSessions()
  }
})
watch(collapsed, (c) => {
  if (c === props.visible) emit('update:visible', !c)
})
// 持久化时机：kv:set 为 sendSync 同步落盘，拖拽 mousemove 逐帧写入会卡顿，
// 故仅在非拖拽状态变化（收起/展开/双击复位）与拖拽结束时写入
watch([width, collapsed], () => {
  if (!isResizing.value) persistState()
})
watch(isResizing, (resizing) => {
  if (!resizing) persistState()
})

onMounted(() => {
  // 刷新后恢复收起状态：持久化为展开而父级初始 false 时，通知父级打开
  if (!collapsed.value && !props.visible) {
    emit('update:visible', true)
  }
  reloadProjects()
  void projectStore.loadSessions()
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

// ==================== ◐ 工作对象开关（迭代 7 会话驱动） ====================
const showWorkObjectMenu = ref(false)

const workObjectStore = useWorkObjectStore()

// 列出注册表中可进视窗的类型（none 型为后台模式，不进菜单/视窗）
const workObjectViewers = computed(() => getRegisteredViewers().filter(v => v.display !== 'none'))

/** 当前会话活跃类型（带徽标，最近活跃降序；过滤已注销/none 型） */
const activeWorkObjects = computed(() =>
  workObjectStore.currentSummaries
    .map(s => ({ ...s, entry: getViewer(s.type) }))
    .filter((x): x is WorkObjectTypeSummary & { entry: ViewerEntry } => !!x.entry && x.entry.display !== 'none')
)

/** ◐ 主体按下定位的最近活跃类型（无则置灰） */
const mostRecentWorkObjectType = computed(() => activeWorkObjects.value[0]?.type ?? null)

/** ◐ 聚合徽标：会话内有未看更新的类型数 */
const workObjectUnseenCount = computed(() => workObjectStore.currentUnseenCount)

/** 菜单「全部类型」区：其余注册类型（活跃类型已在「当前会话」区列出，不重复） */
const manualWorkObjectViewers = computed(() => {
  const activeTypes = new Set(activeWorkObjects.value.map(s => s.type))
  return workObjectViewers.value.filter(v => !activeTypes.has(v.type))
})

/** ◐ 主体：直开 dock 定位最近活跃类型（与菜单项同一 emit，行为一致） */
const pressWorkObject = () => {
  if (!mostRecentWorkObjectType.value) return
  emit('open-work-object', mostRecentWorkObjectType.value)
}

const toggleWorkObjectMenu = () => {
  showWorkObjectMenu.value = !showWorkObjectMenu.value
}

const openWorkObject = (type: string) => {
  showWorkObjectMenu.value = false
  emit('open-work-object', type)
}

const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as Element
  if (!target.closest('.work-object-menu')) {
    showWorkObjectMenu.value = false
  }
  if (!target.closest('.session-move-menu')) {
    moveMenuSessionId.value = null
  }
}

// ==================== 项目列表（新建/重命名/删除/选中过滤） ====================

/** 输入框自动聚焦（v-focus 局部指令） */
const vFocus = { mounted: (el: HTMLElement) => el.focus() }

const creatingProject = ref(false)
const renamingProjectId = ref<string | null>(null)
const projectInputValue = ref('')
/** 新建项目待绑定文件夹（「选择文件夹新建项目」流程预选，提交时随项目落盘） */
const pendingFolderPath = ref<string | null>(null)

const startCreateProject = () => {
  creatingProject.value = true
  pendingFolderPath.value = null
  projectInputValue.value = ''
}

const startRenameProject = (project: ProjectRecord) => {
  renamingProjectId.value = project.id
  projectInputValue.value = project.name
}

const cancelProjectInput = () => {
  creatingProject.value = false
  renamingProjectId.value = null
  projectInputValue.value = ''
  pendingFolderPath.value = null
}

const submitCreateProject = async () => {
  const name = projectInputValue.value.trim()
  if (!name) {
    cancelProjectInput()
    return
  }
  try {
    await projectStore.createProject(name, pendingFolderPath.value ?? undefined)
  } catch (err) {
    console.error('新建项目失败:', err)
  }
  cancelProjectInput()
}

const submitRenameProject = async (id: string) => {
  const name = projectInputValue.value.trim()
  if (name) {
    try {
      await projectStore.renameProject(id, name)
    } catch (err) {
      console.error('重命名项目失败:', err)
    }
  }
  cancelProjectInput()
}

// ==================== 项目文件夹绑定（迭代 2） ====================

/** 绑定路径失效的项目 id 集合（渲染时异步判定；集合整体替换以触发响应） */
const invalidFolderIds = ref<Set<string>>(new Set())

/**
 * 加载项目并刷新绑定路径有效性。
 * 有效性判定经主进程 file:get-path-type（存在且为目录，与 core validateDirectory 同语义）——
 * 渲染进程无真实 fs（vite polyfill 为空 shim，core validateDirectory 的 realpath 判定在本进程不可执行），
 * 规范化比较则直接用 core 共享 normalizePathForCompare（纯 path 逻辑，渲染进程可用）。
 */
const reloadProjects = () => {
  void projectStore.loadProjects().then(refreshFolderValidity)
}

const refreshFolderValidity = async () => {
  const api = window.electronAPI
  const invalid = new Set<string>()
  if (api?.getPathType) {
    for (const p of projectStore.projects) {
      if (!p.folderPath) continue
      const res = await api.getPathType(p.folderPath)
      if (!res?.success || res.type !== 'directory') invalid.add(p.id)
    }
  }
  invalidFolderIds.value = invalid
}

const markFolderValid = (projectId: string) => {
  if (!invalidFolderIds.value.has(projectId)) return
  const next = new Set(invalidFolderIds.value)
  next.delete(projectId)
  invalidFolderIds.value = next
}

const folderLabelOf = (project: ProjectRecord): string => {
  if (!project.folderPath) return '未绑定文件夹'
  if (invalidFolderIds.value.has(project.id)) return '路径失效'
  return project.folderPath
}

const folderActionTitle = (project: ProjectRecord): string => {
  if (!project.folderPath) return '绑定文件夹'
  return invalidFolderIds.value.has(project.id) ? '更新路径（原路径失效）' : '更换文件夹'
}

/** 系统对话框选目录 + 主进程侧存在/目录判定（零新增 IPC，复用 dialog:showOpenDialog / file:get-path-type） */
const pickFolder = async (): Promise<string | null> => {
  const api = window.electronAPI
  if (!api?.showOpenDialog || !api?.getPathType) return null
  const dialog = await api.showOpenDialog({ properties: ['openDirectory'] })
  const folderPath: string | undefined = dialog?.success ? dialog.result?.filePaths?.[0] : undefined
  if (!folderPath) return null // 取消或失败
  const check = await api.getPathType(folderPath)
  if (!check?.success || check.type !== 'directory') {
    alert(`所选路径不可用：${check?.error || '不是有效目录'}`)
    return null
  }
  return folderPath
}

/** 重复绑定检查：命中则告知已绑定项目名并阻止 */
const isDuplicateFolder = (folderPath: string, excludeProjectId?: string): boolean => {
  const holder = projectStore.projectBoundToFolder(folderPath, excludeProjectId)
  if (holder) {
    alert(`该文件夹已被项目「${holder.name}」绑定`)
    return true
  }
  return false
}

/** 绑定 / 更换 / 路径失效后更新（同一入口：重选文件夹，projectId 与数据不变） */
const bindOrRebindFolder = async (project: ProjectRecord) => {
  const folderPath = await pickFolder()
  if (!folderPath || isDuplicateFolder(folderPath, project.id)) return
  try {
    await projectStore.bindFolder(project.id, folderPath)
    markFolderValid(project.id)
  } catch (err) {
    console.error('绑定文件夹失败:', err)
  }
}

const unbindProjectFolder = async (project: ProjectRecord) => {
  try {
    await projectStore.unbindFolder(project.id)
    markFolderValid(project.id)
  } catch (err) {
    console.error('解绑文件夹失败:', err)
  }
}

/** 选择文件夹新建项目：项目名默认取文件夹名（可改），Open Folder 式零表单 */
const startCreateProjectWithFolder = async () => {
  const folderPath = await pickFolder()
  if (!folderPath || isDuplicateFolder(folderPath)) return
  pendingFolderPath.value = folderPath
  creatingProject.value = true
  projectInputValue.value = folderPath.split(/[\\/]/).filter(Boolean).pop() || ''
}

// ==================== 会话列表（加载/移动到项目/删除） ====================

/** 选中项目 → 平铺；未分组 → 日期分组兜底（今天/昨天/7 天内/更早） */
const sessionGroups = computed(() => {
  const list = projectStore.visibleSessions
  if (projectStore.currentProjectId !== null) {
    return [{ label: null as string | null, items: list }]
  }
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 24 * 60 * 60 * 1000
  const buckets: { label: string; items: SessionRecord[] }[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '7 天内', items: [] },
    { label: '更早', items: [] }
  ]
  for (const s of list) {
    const t = new Date(s.updatedAt).getTime()
    if (t >= startOfToday) buckets[0].items.push(s)
    else if (t >= startOfToday - dayMs) buckets[1].items.push(s)
    else if (t >= startOfToday - 6 * dayMs) buckets[2].items.push(s)
    else buckets[3].items.push(s)
  }
  return buckets.filter(b => b.items.length > 0)
})

/** 切换会话：复用 load-conversation 事件链（Home 侧接收与引擎护栏不变） */
const openSession = (session: SessionRecord) => {
  window.dispatchEvent(new CustomEvent('load-conversation', { detail: session }))
}

const moveMenuSessionId = ref<string | null>(null)

const toggleMoveMenu = (sessionId: string) => {
  moveMenuSessionId.value = moveMenuSessionId.value === sessionId ? null : sessionId
}

const moveSession = async (session: SessionRecord, targetProjectId: string | null) => {
  moveMenuSessionId.value = null
  try {
    await projectStore.moveSessionToProject(session.id, targetProjectId)
    // 项目=文件夹绑定：移入已绑定文件夹的项目时明示写边界变化（与绑定校验提示同用 alert 轻提示）
    if (targetProjectId) {
      const target = projectStore.projects.find(p => p.id === targetProjectId)
      if (target?.folderPath) {
        alert(`已移动到项目「${target.name}」：工作目录将切换为新项目文件夹`)
      }
    }
  } catch (err) {
    console.error('移动会话失败:', err)
  }
}

// 删除（会话/项目共用确认弹窗）
const deleteConfirm = ref<{ kind: 'session' | 'project'; id: string; name: string } | null>(null)

const confirmDeleteSession = (session: SessionRecord) => {
  deleteConfirm.value = { kind: 'session', id: session.id, name: session.title }
}

const confirmDeleteProject = (project: ProjectRecord) => {
  deleteConfirm.value = { kind: 'project', id: project.id, name: project.name }
}

const executeDelete = async () => {
  const target = deleteConfirm.value
  if (!target) return
  deleteConfirm.value = null
  try {
    if (target.kind === 'session') {
      // 单次删除：仅此处删一次；conversation-deleted 事件只携带 detach 语义（Home 不再重复删）
      const session = projectStore.sessions.find(s => s.id === target.id)
      const result = await deleteSession(target.id)
      if (!result.success) throw new Error(result.error || '删除会话失败')
      projectStore.removeSession(target.id)
      window.dispatchEvent(new CustomEvent('conversation-deleted', { detail: session ?? { id: target.id } }))
    } else {
      // 删项目边界：store 内逐个清会话 projectId（不删会话），当前项目被删时归位"未分组"
      await projectStore.removeProject(target.id)
    }
  } catch (err) {
    console.error('删除失败:', err)
  }
}

/** 相对时间（会话列表通用格式约定） */
const formatTime = (timestamp: string): string => {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) {
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    })
  } else if (days === 1) {
    return '昨天'
  } else if (days < 7) {
    return `${days}天前`
  } else {
    return date.toLocaleDateString('zh-CN')
  }
}

// 暴露实时宽度（Home 用于 dock 窄窗口降级判定）
defineExpose({ width })
</script>

<style scoped>
/* 工作区面板：表面色与聊天区（#faf9f6）/内容面板（#ffffff）逐级区分 */
.workspace-panel {
  flex: 0 0 auto;
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: row;
  background-color: var(--background-tertiary, #f1f5f9);
  border-right: 1px solid var(--border-color, #e5e7eb);
}

.panel-content {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.panel-section {
  flex: 0 0 auto;
  padding: var(--spacing-3, 12px);
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #6b7280);
}

/* 常用设置项 */
.quick-settings {
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2, 8px);
}

.quick-setting-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-2, 8px);
  min-height: 24px;
}

/* 新建对话按钮（常用功能区首行） */
.new-chat-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.new-chat-btn:hover {
  background: var(--background-secondary);
  color: var(--primary-color);
}

.quick-setting-label {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
}

/* 项目+会话列表区（项目列表固定，会话列表内部滚动） */
.session-list-section {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.section-action-btn {
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
  cursor: pointer;
  transition: all var(--transition-fast, 0.15s ease);
}

.section-action-btn:hover {
  background-color: var(--background-secondary, #f8fafc);
  color: var(--primary-color, #3b82f6);
}

/* 项目列表 */
.project-list {
  flex: 0 0 auto;
  margin-top: var(--spacing-2, 8px);
  padding-bottom: var(--spacing-2, 8px);
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}

.project-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 5px 8px;
  border-radius: var(--radius-md, 6px);
  font-size: 13px;
  color: var(--text-primary, #111827);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.project-item:hover {
  background-color: var(--background-secondary, #f8fafc);
}

.project-item.active {
  background-color: var(--background-secondary, #f8fafc);
  color: var(--primary-color, #3b82f6);
  font-weight: 500;
}

.project-item.editing {
  cursor: default;
}

.project-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 项目名+绑定路径双行容器 */
.project-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.project-info .project-name {
  flex: 0 0 auto;
}

/* 绑定路径行：截断显示，title 挂全路径 */
.project-folder {
  display: block;
  margin-top: 1px;
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-folder.unbound {
  font-style: italic;
  opacity: 0.8;
}

.project-folder.invalid {
  color: var(--error-color, #ef4444);
}

.project-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid var(--primary-color, #3b82f6);
  border-radius: var(--radius-md, 6px);
  font-size: 13px;
  color: var(--text-primary, #111827);
  background-color: var(--background-primary, #ffffff);
  outline: none;
}

.project-actions {
  flex: 0 0 auto;
  display: none;
  align-items: center;
  gap: 2px;
}

.project-item:hover .project-actions {
  display: flex;
}

.project-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-md, 6px);
  background-color: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  transition: all 0.15s ease;
}

.project-action-btn:hover {
  background-color: var(--background-tertiary, #f1f5f9);
  color: var(--primary-color, #3b82f6);
}

.project-action-btn.danger:hover {
  color: var(--error-color, #ef4444);
}

/* 会话列表 */
.session-list {
  flex: 1 1 auto;
  min-height: 0;
  margin-top: var(--spacing-2, 8px);
  overflow-y: auto;
}

.session-date-group {
  padding: 6px 8px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary, #9ca3af);
}

/* 未分组写边界状态提示 */
.ungrouped-write-hint {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
}

.session-item {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--radius-md, 6px);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.session-item:hover {
  background-color: var(--background-secondary, #f8fafc);
}

.session-item.active {
  background-color: var(--background-secondary, #f8fafc);
}

.session-item-content {
  flex: 1 1 auto;
  min-width: 0;
}

.session-item-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary, #111827);
}

.session-item.active .session-item-title {
  color: var(--primary-color, #3b82f6);
  font-weight: 500;
}

.session-active-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--primary-color, #3b82f6);
}

.session-title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
}

.session-project-badge {
  flex: 0 0 auto;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 6px;
  border-radius: 999px;
  background-color: var(--background-tertiary, #f1f5f9);
  color: var(--text-secondary, #6b7280);
}

.session-item-actions {
  flex: 0 0 auto;
  display: none;
  align-items: center;
  gap: 2px;
}

.session-item:hover .session-item-actions {
  display: flex;
}

.session-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-md, 6px);
  background-color: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  transition: all 0.15s ease;
}

.session-action-btn:hover {
  background-color: var(--background-tertiary, #f1f5f9);
  color: var(--primary-color, #3b82f6);
}

.session-action-btn.danger:hover {
  color: var(--error-color, #ef4444);
}

/* 「移动到项目」下拉 */
.session-move-menu {
  position: relative;
}

.move-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 100;
  min-width: 120px;
  margin-top: 4px;
  padding: 4px 0;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

.move-item {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-primary, #111827);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background-color 0.15s ease;
}

.move-item:hover {
  background-color: var(--background-secondary, #f8fafc);
}

.empty-sessions {
  padding: var(--spacing-4, 16px) var(--spacing-3, 12px);
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
  text-align: center;
}

/* 删除确认弹窗（会话/项目共用） */
.delete-modal {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.delete-content {
  background-color: var(--background-primary, #ffffff);
  border-radius: var(--radius-xl, 12px);
  box-shadow: var(--shadow-xl, 0 20px 25px -5px rgba(0, 0, 0, 0.1));
  width: 90%;
  max-width: 400px;
  overflow: hidden;
}

.delete-header {
  padding: var(--spacing-6, 24px);
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  text-align: center;
}

.delete-header h4 {
  margin: 0;
  font-size: var(--font-size-lg, 18px);
  font-weight: 600;
  color: var(--text-primary, #111827);
}

.delete-body {
  padding: var(--spacing-6, 24px);
  text-align: center;
}

.delete-body p {
  margin: 0 0 var(--spacing-3, 12px) 0;
  color: var(--text-primary, #111827);
  font-size: var(--font-size-sm, 14px);
  line-height: 1.5;
}

.delete-warning {
  color: var(--error-color, #ef4444) !important;
  font-size: var(--font-size-xs, 12px) !important;
  margin-bottom: 0 !important;
}

.delete-footer {
  padding: var(--spacing-6, 24px);
  display: flex;
  gap: var(--spacing-3, 12px);
  justify-content: center;
}

.cancel-btn, .confirm-btn {
  padding: var(--spacing-3, 12px) var(--spacing-6, 24px);
  border: none;
  border-radius: var(--radius-lg, 8px);
  font-size: var(--font-size-sm, 14px);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast, 0.15s ease);
  min-width: 80px;
}

.cancel-btn {
  background-color: var(--background-secondary, #f8fafc);
  color: var(--text-primary, #111827);
}

.cancel-btn:hover {
  background-color: var(--border-color, #e5e7eb);
}

.confirm-btn {
  background-color: var(--error-color, #ef4444);
  color: white;
}

.confirm-btn:hover {
  opacity: 0.9;
}

/* 「工作对象」开关（◐ 主体 + ▾ 菜单并排） */
.work-object-menu {
  position: relative;
  display: flex;
  align-items: center;
}

.work-object-toggle {
  position: relative; /* 聚合徽标的定位基准 */
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
  cursor: pointer;
  transition: all var(--transition-fast, 0.15s ease);
}

.work-object-toggle:hover {
  background-color: var(--background-secondary, #f8fafc);
  color: var(--primary-color, #3b82f6);
}

/* ◐ 主体置灰（当前会话无活跃类型；▾ 菜单仍可展开手动选择） */
.work-object-toggle.disabled,
.work-object-toggle:disabled {
  opacity: 0.4;
  cursor: default;
}

.work-object-toggle.disabled:hover,
.work-object-toggle:disabled:hover {
  background-color: transparent;
  color: var(--text-secondary, #6b7280);
}

/* ◐ 聚合徽标（会话内未看更新的类型数） */
.work-object-badge {
  position: absolute;
  top: -4px;
  right: -6px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background-color: var(--primary-color, #3b82f6);
  color: #ffffff;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
  pointer-events: none;
}

.work-object-caret {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-md, 6px);
  background-color: transparent;
  color: var(--text-tertiary, #9ca3af);
  cursor: pointer;
  transition: all var(--transition-fast, 0.15s ease);
}

.work-object-caret:hover,
.work-object-caret.menu-open {
  background-color: var(--background-secondary, #f8fafc);
  color: var(--primary-color, #3b82f6);
}

.work-object-section-title {
  padding: 6px 12px 2px;
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
}

.work-object-name {
  flex: 1 1 auto;
  min-width: 0;
}

/* 菜单内实例计数徽标 */
.work-object-count {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  background-color: var(--background-tertiary, #f1f5f9);
  color: var(--text-tertiary, #9ca3af);
}

/* 菜单内未看更新圆点 */
.work-object-unseen-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--primary-color, #3b82f6);
}

.work-object-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 100;
  width: 140px;
  margin-top: 4px;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  overflow: hidden;
  padding: 4px 0;
}

.work-object-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-primary, #111827);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.work-object-item:hover {
  background-color: var(--background-secondary, #f8fafc);
}

.work-object-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--text-secondary, #6b7280);
}

/* 左下角：设置齿轮 */
.panel-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding: var(--spacing-2, 8px) var(--spacing-3, 12px);
  border-top: 1px solid var(--border-color, #e5e7eb);
}

/* 右缘拖拽手柄 */
.panel-resize-handle {
  flex: 0 0 auto;
  width: 4px;
  height: 100%;
  cursor: col-resize;
  transition: background-color 0.15s ease;
}

.panel-resize-handle:hover,
.panel-resize-handle.resizing {
  background-color: var(--primary-color, #3b82f6);
}
</style>
