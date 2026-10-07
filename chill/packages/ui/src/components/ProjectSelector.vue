<template>
  <!-- 已归属会话不渲染（头部由 Home 的静态"项目名/会话名"标题承担） -->
  <div v-if="visible" class="project-selector">
    <button
      class="project-trigger"
      @click.stop="toggleDropdown"
      title="会话归属项目：新会话为出生意向（首次落盘生效），未分组会话选择即移入"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg>
      <span class="project-label">{{ currentLabel }}</span>
    </button>

    <div v-if="isOpen" class="project-dropdown">
      <div
        class="project-item"
        :class="{ selected: !selectedPendingId }"
        @click="selectProject(null)"
      >
        <div class="project-item-name">未分组</div>
      </div>
      <div
        v-for="project in projectStore.projects"
        :key="project.id"
        class="project-item"
        :class="{ selected: selectedPendingId === project.id }"
        @click="selectProject(project)"
      >
        <div class="project-item-name">{{ project.name }}</div>
        <div v-if="project.folderPath" class="project-item-hint">{{ project.folderPath }}</div>
      </div>
      <div class="project-divider"></div>
      <!-- 新建项目（侧边栏加号入口的唯一迁移落点）：点击即弹文件夹选窗，选定即以文件夹名建项目并选中，零过渡表单 -->
      <div class="project-item" @click="startCreate">
        <div class="project-item-name">新建项目…</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { useWritingViewStore } from '../stores/writingViewStore'
import { useProjectFolderPicker } from '../composables/useProjectFolderPicker'
import { getActiveSessionId } from '../services/chatEngine'
import type { ProjectRecord } from '@assistant-ai/core'

/**
 * 新建会话项目选择器（chat-header 左上、☰ 旁的药丸）：
 * 项目归属是会话级状态，出生时的归属决策在此显式化——用户明确指定 > workdir 匹配兜底。
 * 两态语义（3.10：sessionId 已预铸 ≠ 已落盘）：会话**未落盘**（isSessionPersisted=false）
 * 选择 = 出生意向（pendingProjects 按会话 id 登记，首次落盘由 chatEngine 保存包装按 record.id
 * 消费）；**已落盘**未分组选择 = 立即 patch（moveSessionToProject 单一写路径）。
 * 选中已绑 folderPath 的项目即把写作目录对齐项目文件夹（目录=边界=归属，与 Home watch 跟随同向）。
 * 已归属会话不渲染（头部改由 Home 的静态"项目名/会话名"标题承担）。
 */
const projectStore = useProjectStore()
const writingViewStore = useWritingViewStore()
const { pickFolder, isDuplicateFolder } = useProjectFolderPicker()

/** 意向登记的会话键：面板 currentSessionId 优先（Home watch 推入），未同步时回退引擎预铸 id */
const resolveSessionId = (): string | null => projectStore.currentSessionId ?? getActiveSessionId()

/** 当前会话的出生意向（两态显示/选中态） */
const selectedPendingId = computed(() => projectStore.pendingProjectOf(resolveSessionId()))

/** 显示条件：当前会话无归属（新会话未落盘，或已落盘未分组）；已归属会话整个组件不渲染 */
const visible = computed(() => {
  const id = projectStore.currentSessionId
  if (!id) return true
  return !projectStore.sessionProjectIdOf(id)
})

/** 药丸文案：出生意向的项目名，无意向即"未分组" */
const currentLabel = computed(() =>
  selectedPendingId.value
    ? projectStore.projectNameOf(selectedPendingId.value) ?? '未分组'
    : '未分组'
)

const isOpen = ref(false)
const toggleDropdown = () => {
  isOpen.value = !isOpen.value
}

/** 两态选择：未落盘存意向 / 已落盘未分组立即移入；选"未分组"仅清意向（已落盘未分组本就无归属，no-op） */
const selectProject = async (project: ProjectRecord | null) => {
  isOpen.value = false
  const sessionId = resolveSessionId()
  if (project === null) {
    if (!projectStore.isSessionPersisted(sessionId)) projectStore.setPendingProject(sessionId, null)
    return
  }
  if (!projectStore.isSessionPersisted(sessionId)) {
    projectStore.setPendingProject(sessionId, project.id)
  } else {
    try {
      await projectStore.moveSessionToProject(sessionId!, project.id)
    } catch (err) {
      console.error('移动会话到项目失败:', err)
      return
    }
  }
  // 目录=边界=归属：选中已绑文件夹的项目即对齐写作目录（选"未分组"不动目录）
  if (project.folderPath) writingViewStore.setCurrentDirectory(project.folderPath)
}

// ==================== 新建项目（文件夹优先，零过渡表单） ====================

/** 点击即弹文件夹选窗：选定后以文件夹名建项目并按两态规则自动选中；取消选窗/重名 = 放弃 */
const startCreate = async () => {
  const folderPath = await pickFolder()
  if (!folderPath || isDuplicateFolder(folderPath)) return
  const name = folderPath.split(/[\\/]/).filter(Boolean).pop() || ''
  if (!name) return
  try {
    const record = await projectStore.createProject(name, folderPath)
    await selectProject(record)
  } catch (err) {
    console.error('新建项目失败:', err)
  }
}

/** 点击组件外部关闭下拉（同 WorkspacePanel handleClickOutside 模式） */
const handleClickOutside = (event: MouseEvent) => {
  if (!(event.target as Element).closest('.project-selector')) {
    isOpen.value = false
  }
}

onMounted(() => {
  // 项目列表可能尚未加载（面板未打开过）：选择器自身兜底拉一次
  if (projectStore.projects.length === 0) void projectStore.loadProjects()
  document.addEventListener('click', handleClickOutside)
})
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.project-selector {
  position: relative;
  display: flex;
  align-items: center;
}

.project-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.project-trigger:hover {
  background: var(--background-secondary);
}

.project-label {
  white-space: nowrap;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-dropdown {
  position: absolute;
  /* 触发器在 chat-header（窗口顶部）：向下展开（向上会伸出窗口外被裁掉——
     本组件从输入框旁迁入头部前的旧方向 bottom 已不适用） */
  top: calc(100% + 6px);
  /* 左锚定：触发器在聊天列左侧，右锚定会让下拉向左伸进侧边栏下方被盖住（同权限选择器实证） */
  left: 0;
  min-width: 240px;
  max-width: 320px;
  background: var(--background-primary, #fff);
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  z-index: 100;
  padding: 4px;
}

.project-item {
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.project-item:hover {
  background: var(--background-secondary);
}

.project-item.selected {
  background: rgba(37, 99, 235, 0.08);
}

.project-item-name {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
}

.project-item-hint {
  margin-top: 1px;
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-color, #e2e8f0);
}
</style>
