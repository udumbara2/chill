<template>
  <div class="home-container">
    <!-- 设置区域（全屏覆盖层，淡入淡出；组件常驻挂载保活） -->
    <div
      class="settings-section"
      :class="{ 'settings-visible': isSettingsVisible }"
    >
      <ModelSettings 
        :visible="isSettingsVisible"
        @close-settings="closeSettings"
        @open-workflow="handleOpenWorkflowFromSettings"
        @open-agent-factory="handleOpenAgentFactoryFromSettings"
      />
    </div>

    <!-- 工作区面板（最左列，可拖宽/吸附收起；v-show 保活，内部自持久化宽度与收起状态） -->
    <WorkspacePanel
      ref="workspacePanelRef"
      v-model:visible="workspacePanelVisible"
      :current-session-id="currentConversationId"
      @open-settings="toggleSettingsVisibility"
      @open-work-object="handleOpenWorkObject"
      @new-conversation="createNewConversation"
    />

    <!-- 工作对象视窗（ContentDock：单容器多类型页签，流内段位于工作区面板与聊天区之间；窄窗口降级覆盖模式） -->
    <ContentDock ref="contentDockRef" :overlay="dockOverlay" :badges="dockBadges" :max-width="dockMaxWidth" />

    <!-- CHAT区域整体（常驻，flex:1 占满剩余宽度） -->
    <div ref="chatSectionRef" class="chat-section">
      
      <!-- CHAT区域布局容器 -->
      <div class="chat-layout-container">
        <!-- Subagent 处理过程显示区域（仅在 ORCHESTRATOR 模式显示） -->
        <div class="subagent-drawer-wrapper" v-if="hasSubagentProcessData">
          <SubagentProcessDisplay
            v-if="showSubagentProcess"
            :process-infos="subagentProcessInfos"
            class="subagent-process-panel"
          />
          <!-- 抽屉切换按钮 -->
          <button
            class="subagent-drawer-toggle"
            :class="{ 'drawer-open': isSubagentDrawerOpen }"
            @click="toggleSubagentDrawer"
            :title="isSubagentDrawerOpen ? '隐藏 Subagent 后台任务' : '显示 Subagent 后台任务'"
          >
            <svg v-if="isSubagentDrawerOpen" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/>
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="4" y="4" width="16" height="16" rx="2"/>
              <path d="M8 12h8"/>
              <path d="M12 8v8"/>
            </svg>
          </button>
        </div>
        
        <!-- CHAT右侧内容区域（chat-empty：新建会话/未开聊时输入框组垂直居中） -->
        <div class="chat-right-container" :class="{ 'chat-empty': isChatEmpty }">
          <!-- CHAT区域头部 -->
          <div class="chat-header">
            <!-- 左侧：☰ 工作区面板开关 -->
            <div style="display: flex; align-items: center; gap: var(--spacing-4);">
              <button
                class="workspace-panel-toggle"
                :class="{ 'panel-open': workspacePanelVisible }"
                @click="workspacePanelVisible = !workspacePanelVisible"
                :title="workspacePanelVisible ? '收起工作区面板' : '展开工作区面板'"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="4" y1="6" x2="20" y2="6"></line>
                  <line x1="4" y1="12" x2="20" y2="12"></line>
                  <line x1="4" y1="18" x2="20" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>

          <!-- 首跑引导卡片：零 Key 用户一次性指路（去配置 = ModelSettings 覆盖层；× = 与 CLI 互认的跳过记忆） -->
          <div class="first-run-card" v-if="showFirstRunCard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="first-run-icon">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M12 6v6l4 2"></path>
            </svg>
            <span class="first-run-text">还没有配置任何模型的 API Key——选一个模型并配置 Key 即可开始使用。</span>
            <button class="first-run-action" @click="goConfigureModel">去配置</button>
            <button class="first-run-close" @click="dismissFirstRunCard" title="不再提醒">×</button>
          </div>

          <!-- CHAT区域主体 -->
          <div class="chat-main">
            <!-- 聊天界面 -->
            <ChatArea ref="chatAreaRef" class="chat-area-panel" />
          </div>
          
          <!-- 边界工具栏 -->
      <!-- 边界工具栏（活跃会话的外设状态监控；空会话与任务无关，隐藏） -->
      <div class="boundary-toolbar" v-if="shouldShowBoundaryToolbar && !isChatEmpty">
        <div 
          v-if="toolsList.length > 0"
          class="toolbar-icon" 
          title="MCP Tools"
          @mouseenter="showDropdown('tools', $event)"
          @mouseleave="hideDropdown('tools')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3L6.91 6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
          </svg>
        </div>
        <div 
          v-if="resourcesList.length > 0"
          class="toolbar-icon" 
          title="MCP Resources"
          @mouseenter="showDropdown('resources', $event)"
          @mouseleave="hideDropdown('resources')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <div 
          v-if="promptsList.length > 0"
          class="toolbar-icon" 
          title="MCP Prompts"
          @mouseenter="showDropdown('prompts', $event)"
          @mouseleave="hideDropdown('prompts')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"></path>
          </svg>
        </div>
      </div>

      <!-- Tools下拉列表 -->
      <div 
        v-if="showToolsDropdown" 
        class="mcp-dropdown tools-dropdown" 
        :style="toolsDropdownStyle"
        @mouseenter="cancelHideTimer('tools')"
        @mouseleave="hideDropdown('tools')"
      >
        <div v-if="Object.keys(groupedTools).length === 0" class="dropdown-empty">暂无数据</div>
        <template v-else>
          <div v-for="(tools, serverName) in groupedTools" :key="serverName" class="server-group">
            <div 
              class="server-header" 
              @click="toggleServer(serverName, 'tools')"
              :class="{ 'is-expanded': isServerExpanded(serverName) }"
            >
              <svg class="expand-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
              <span class="server-name">{{ formatServerName(serverName) }}</span>
              <span class="server-count">{{ tools.length }}</span>
            </div>
            <div v-show="isServerExpanded(serverName)" class="server-items">
              <div v-for="tool in tools" :key="tool.function.name" class="dropdown-item">
                <div class="item-name">{{ tool.function.name }}</div>
                <div 
                  v-if="truncateText(tool.function.description, 100).needsTooltip"
                  class="item-description needs-tooltip"
                  @mouseenter="showTooltip($event, tool.function.description, 'tools')"
                  @mouseleave="hideTooltip"
                >{{ truncateText(tool.function.description, 100).text }}</div>
                <div 
                  v-else
                  class="item-description"
                >{{ truncateText(tool.function.description, 100).text }}</div>
              </div>
            </div>
          </div>
        </template>
        <!-- 搜索框 -->
        <div class="dropdown-search">
          <input 
            type="text" 
            v-model="toolsSearch" 
            placeholder="搜索工具..."
            class="search-input"
            @compositionstart="handleCompositionStart($event, 'tools')"
            @compositionupdate="handleCompositionUpdate($event, 'tools')"
            @compositionend="handleCompositionEnd($event, 'tools')"
          />
        </div>
      </div>

      <!-- Resources下拉列表 -->
      <div 
        v-if="showResourcesDropdown" 
        class="mcp-dropdown resources-dropdown" 
        :style="resourcesDropdownStyle"
        @mouseenter="cancelHideTimer('resources')"
        @mouseleave="hideDropdown('resources')"
      >
        <div v-if="Object.keys(groupedResources).length === 0" class="dropdown-empty">暂无数据</div>
        <template v-else>
          <div v-for="(resources, serverName) in groupedResources" :key="serverName" class="server-group">
            <div 
              class="server-header" 
              @click="toggleServer(serverName, 'resources')"
              :class="{ 'is-expanded': isServerExpanded(serverName) }"
            >
              <svg class="expand-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
              <span class="server-name">{{ formatServerName(serverName) }}</span>
              <span class="server-count">{{ resources.length }}</span>
            </div>
            <div v-show="isServerExpanded(serverName)" class="server-items">
              <div 
                v-for="resource in resources" 
                :key="resource.uri" 
                class="dropdown-item"
                @click="handleResourceClick(resource)"
              >
                <div class="item-name">{{ resource.name }}</div>
                <div class="item-uri">{{ resource.uri }}</div>
                <div 
                  v-if="truncateText(resource.description, 100).needsTooltip"
                  class="item-description needs-tooltip"
                  @mouseenter="showTooltip($event, resource.description, 'resources')"
                  @mouseleave="hideTooltip"
                >{{ truncateText(resource.description, 100).text }}</div>
                <div 
                  v-else
                  class="item-description"
                >{{ truncateText(resource.description, 100).text }}</div>
              </div>
            </div>
          </div>
        </template>
        <!-- 搜索框 -->
        <div class="dropdown-search">
          <input 
            type="text" 
            v-model="resourcesSearch" 
            placeholder="搜索资源..."
            class="search-input"
            @compositionstart="handleCompositionStart($event, 'resources')"
            @compositionupdate="handleCompositionUpdate($event, 'resources')"
            @compositionend="handleCompositionEnd($event, 'resources')"
          />
        </div>
      </div>

      <!-- Prompts下拉列表 -->
      <div 
        v-if="showPromptsDropdown" 
        class="mcp-dropdown prompts-dropdown" 
        :style="promptsDropdownStyle"
        @mouseenter="cancelHideTimer('prompts')"
        @mouseleave="hideDropdown('prompts')"
      >
        <div v-if="Object.keys(groupedPrompts).length === 0" class="dropdown-empty">暂无数据</div>
        <template v-else>
          <div v-for="(prompts, serverName) in groupedPrompts" :key="serverName" class="server-group">
            <div 
              class="server-header" 
              @click="toggleServer(serverName, 'prompts')"
              :class="{ 'is-expanded': isServerExpanded(serverName) }"
            >
              <svg class="expand-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
              <span class="server-name">{{ formatServerName(serverName) }}</span>
              <span class="server-count">{{ prompts.length }}</span>
            </div>
            <div v-show="isServerExpanded(serverName)" class="server-items">
              <div v-for="prompt in prompts" :key="prompt.name" class="dropdown-item" @click="handlePromptClick(prompt)">
                <div class="item-name">{{ prompt.name }}</div>
                <div 
                  v-if="truncateText(prompt.description, 100).needsTooltip"
                  class="item-description needs-tooltip"
                  @mouseenter="showTooltip($event, prompt.description, 'prompts')"
                  @mouseleave="hideTooltip"
                >{{ truncateText(prompt.description, 100).text }}</div>
                <div 
                  v-else
                  class="item-description"
                >{{ truncateText(prompt.description, 100).text }}</div>
              </div>
            </div>
          </div>
        </template>
        <!-- 搜索框 -->
        <div class="dropdown-search">
          <input 
            type="text" 
            v-model="promptsSearch" 
            placeholder="搜索提示..."
            class="search-input"
            @compositionstart="handleCompositionStart($event, 'prompts')"
            @compositionupdate="handleCompositionUpdate($event, 'prompts')"
            @compositionend="handleCompositionEnd($event, 'prompts')"
          />
        </div>
      </div>
      
      <!-- 固定任务列表区域 -->
      <div class="fixed-task-list" v-show="taskListStore.hasTasks">
        <TaskListDisplay
          :tasks="taskListStore.tasks"
          :compact="true"
          :default-expanded="false"
        />
      </div>

      <!-- CHAT区域底部 -->
      <div class="chat-footer">
        <InputArea
          @send="handleSendMessage"
          @model-selected="handleModelSelected"
          :is-streaming="isStreaming"
          :has-history="!isChatEmpty"
          @stop="stopStreaming"
          @compacted="handleCompacted"
        />
      </div>
        </div> <!-- 结束 chat-right-container -->
      </div> <!-- 结束 chat-layout-container -->

      <ResourceDetailDialog 
        :visible="showResourceDialog"
        :resource="selectedResource"
        @close="showResourceDialog = false"
      />
    </div>
  </div>

  <!-- 自定义Tooltip -->
  <Teleport to="body">
    <div 
      v-if="tooltipState.visible"
      class="custom-tooltip"
      :style="{ left: tooltipState.x + 'px', top: tooltipState.y + 'px' }"
      @mouseenter="cancelHideTooltip"
      @mouseleave="hideTooltip"
    >
      {{ tooltipState.content }}
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, reactive, watch } from 'vue'
import ChatArea from '../components/ChatArea.vue'
import InputArea from '../components/InputArea.vue'
import WorkspacePanel from '../components/WorkspacePanel.vue'
import ContentDock from '../components/ContentDock.vue'
import ModelSettings from './ModelSettings.vue'
import ResourceDetailDialog from '../components/ResourceDetailDialog.vue'
import TaskListDisplay from '../components/TaskListDisplay.vue'
import SubagentProcessDisplay from '../components/SubagentProcessDisplay.vue'
import { useTaskListStore } from '../stores/taskListStore'
import { modelServiceFactory, MessageRole, eventBus, EVENTS, buildContentParts, INJECTOR_ORDER, parseAgentMentions, parseBareAgentMention, getTemplateManager, SecureStorageService } from '@assistant-ai/core'
import type { ContentPart, Message, ModelInfo, MediaFileDescriptor, VideoStorageProvider, SessionRecord, ContextInjector, ChatEngineInput } from '@assistant-ai/core'
import { useMCPStore } from '../stores/mcpStore'

import { getMCPClient } from '@assistant-ai/ui/adapters'
import { promptMode } from '../stores/promptMode'
import type { DiffOperation } from '../extensions/DiffPreviewExtension'
import { usePendingOperationsStore } from '../stores/pendingOperationsStore'
import { useWorkObjectStore } from '../stores/workObjectStore'
import { classifyFileType } from '../utils/workObjectFileType'
import { collectFileOperations, diffCounts, normalizeFilePath } from '../utils/lightDiff'
import { useWritingViewStore } from '../stores/writingViewStore'
import { useProjectStore } from '../stores/projectStore'
import { loadSessionList } from '@assistant-ai/ui/adapters'
import { getChatEngine, syncFrontAgentFromEngine, setEngineWorkDir, setFrontAgent } from '../services/chatEngine'
import { IPCKeyValueStore } from '../adapters/IPCKeyValueStore'

// ChatArea组件引用
const chatAreaRef = ref<InstanceType<typeof ChatArea>>()

// 空会话判定（新建会话/无打开会话/未开聊统一信号 = 消息区无消息；
// expose 代理响应式解包，消息增删即时切换布局）
const isChatEmpty = computed(() => chatAreaRef.value?.hasMessages === false)

// CHAT区域容器引用（下拉列表等绝对定位元素的定位基准）
const chatSectionRef = ref<HTMLElement | null>(null)

// 工作区面板组件引用（读取其实时宽度，用于 dock 窄窗口降级判定）
const workspacePanelRef = ref<InstanceType<typeof WorkspacePanel>>()

// ContentDock 组件引用（工作对象视窗；写作/工作流编辑器经 getActiveEditorRef 透传）
const contentDockRef = ref<InstanceType<typeof ContentDock>>()

// dock 页签徽标（实例计数 + 聚合 +N -M）：
// 实例计数 = 当前会话活跃对象集（迭代 7 会话驱动，workObjectStore）；
// 聚合 +N -M = pendingOperations（与各轻量视图自绘 diff 同源）；
// 文件型对象按扩展名分类（document/code/html），未注册专属类型的落 generic 兜底
const dockBadges = computed(() => {
  const badges: Record<string, { count: number; add: number; del: number }> = {}
  for (const [type, count] of Object.entries(workObjectStore.currentTypeCounts)) {
    badges[type] = { count, add: 0, del: 0 }
  }
  const filesByType: Record<string, Set<string>> = {}
  for (const op of pendingOperationsStore.operations) {
    const path = op.resolvedPath || op.filePath
    const type = classifyFileType(path)
    if (!badges[type]) {
      badges[type] = { count: 0, add: 0, del: 0 }
    }
    if (!filesByType[type]) {
      filesByType[type] = new Set()
    }
    filesByType[type].add(normalizeFilePath(path))
  }
  for (const [type, files] of Object.entries(filesByType)) {
    // 两侧实例计数同源（同批文件的两种观测），取较大者兜底未入会话集的对象
    badges[type].count = Math.max(badges[type].count, files.size)
    for (const path of files) {
      const c = diffCounts(collectFileOperations(pendingOperationsStore.operations, path))
      badges[type].add += c.add
      badges[type].del += c.del
    }
  }
  return badges
})

// 当前选择的模型
const currentModel = ref<ModelInfo | null>(null)

// 当前对话ID（用于标识和更新历史记录；引擎会话状态的展示镜像，经 syncConversationRefs 同步）
const currentConversationId = ref<string | null>(null)

// 流式状态管理
const isStreaming = ref(false)
const abortController = ref<AbortController | null>(null)

// 工作区面板显示状态（聊天 header 左上角 ☰ 开关；宽度与收起状态由 WorkspacePanel 内部持久化）
const workspacePanelVisible = ref(false)

// 设置界面显示状态管理（功能集合7新增）
const isSettingsVisible = ref(false)

// ===== 首跑引导卡片（与 CLI 首跑向导同一事实源：零 Key 检测 + firstRunWizard.dismissed 记忆互认） =====
// 挂载语义：检测在 onMounted 内做，依赖"每次应用启动 Home 重新挂载"（key 是启动时点的事实，
// 别端/CLI 配置后下次启动自然不再出现）；勿移到设置开关 watcher——那是"每次打开设置"，语义不同
const FIRST_RUN_DISMISSED_KEY = 'firstRunWizard.dismissed'
const showFirstRunCard = ref(false)
const firstRunKv = window.electronAPI?.getKeyValue ? new IPCKeyValueStore() : null
/** 去配置：打开既有 ModelSettings 覆盖层（SettingsButton 同款翻转）；仅本次会话隐藏——
 *  配好 Key 后检测本身即不再出现，未配则下次启动卡片再现 */
const goConfigureModel = () => {
  showFirstRunCard.value = false
  isSettingsVisible.value = true
}
/** ×：写入与 CLI 端同名 kv（记忆互认），此后两端都不再提示 */
const dismissFirstRunCard = () => {
  showFirstRunCard.value = false
  firstRunKv?.setItem(FIRST_RUN_DISMISSED_KEY, 'true')
}

// dock 窄窗口降级：窗口可用宽不足以同时容纳 dock 与聊天最小可读宽（~480px）时，dock 转覆盖模式
// 滞回阈值防抖动：可用宽 < 480 进入覆盖，> 560 退出覆盖
const dockOverlay = ref(false)
const CHAT_MIN_READABLE_WIDTH = 480
const DOCK_OVERLAY_EXIT_WIDTH = 560
/** dock 有效最大宽度：窗口 − 面板 − 聊天最小可读宽（拖拽永不会挤压聊天或误触发覆盖模式） */
const dockMaxWidth = ref(Number.MAX_SAFE_INTEGER)

const updateDockOverlay = () => {
  const dock = contentDockRef.value
  const dockWidth = dock?.open ? (dock.width ?? 0) : 0
  const panelWidth = workspacePanelVisible.value ? (workspacePanelRef.value?.width ?? 0) : 0
  dockMaxWidth.value = window.innerWidth - panelWidth - CHAT_MIN_READABLE_WIDTH
  const available = window.innerWidth - dockWidth - panelWidth
  if (dockOverlay.value) {
    dockOverlay.value = available <= DOCK_OVERLAY_EXIT_WIDTH
  } else {
    dockOverlay.value = available < CHAT_MIN_READABLE_WIDTH
  }
}

const handleWindowResize = () => updateDockOverlay()

watch([workspacePanelVisible, () => contentDockRef.value?.open, () => contentDockRef.value?.width], updateDockOverlay)

// MCP Store实例
const mcpStore = useMCPStore()
const writingViewStore = useWritingViewStore()
const projectStore = useProjectStore()

// TaskList Store实例
const taskListStore = useTaskListStore()

// PendingOperations Store实例
const pendingOperationsStore = usePendingOperationsStore()

// 工作对象会话检测 store（迭代 7：TOOL_CALL_STATUS_CHANGED → 按会话活跃对象集，◐/页签徽标数据源）
const workObjectStore = useWorkObjectStore()

// Subagent 后台任务信息列表（支持多任务并行显示；语义：后台进行中 → 终态，委派不阻塞主对话）
const subagentProcessInfos = ref<Array<{
  taskId: string
  subagentType: string
  description: string
  status: 'idle' | 'running' | 'completed' | 'failed'
  output: string
  result?: any
}>>([])

// Subagent 抽屉显示状态（用户可控制）
const isSubagentDrawerOpen = ref(true)

// 是否有 Subagent 处理过程数据（用于控制抽屉是否可以显示；有事件即显示，不再按模式门控）
const hasSubagentProcessData = computed(() => {
  return subagentProcessInfos.value.length > 0 &&
         subagentProcessInfos.value.some(t => t.status !== 'idle')
})

// 是否显示 Subagent 处理过程区域
const showSubagentProcess = computed(() => {
  return hasSubagentProcessData.value && isSubagentDrawerOpen.value
})

// 切换 Subagent 抽屉显示状态
const toggleSubagentDrawer = () => {
  isSubagentDrawerOpen.value = !isSubagentDrawerOpen.value
}

// ==================== Subagent 委派进度（全局 eventBus 的 SUBAGENT_* 事件驱动） ====================
// 后台语义：started 仅记录为"后台进行中"（委派默认后台执行，不阻塞输入——输入框无委派阻塞逻辑，
// 仅发送按钮在内容为空时禁用）；settled 更新终态与结果，回填轮输出经 onMessagesChanged 自动呈现。

type SubagentTaskEventPayload = {
  taskId: string
  subagentType: string
  description: string
  taskOutput?: { final_output?: string; error_info?: { message?: string } }
}

const handleSubagentStarted = (p: SubagentTaskEventPayload) => {
  // 后台任务受理：登记为进行中即可，主对话可立刻继续
  subagentProcessInfos.value.push({
    taskId: p.taskId,
    subagentType: p.subagentType,
    description: p.description,
    status: 'running',
    output: '',
  })
}

const handleSubagentSettled = (status: 'completed' | 'failed') => (p: SubagentTaskEventPayload) => {
  const task = subagentProcessInfos.value.find((t) => t.taskId === p.taskId)
  if (!task) return
  task.status = status
  task.output = status === 'completed'
    ? (p.taskOutput?.final_output ?? '')
    : (p.taskOutput?.error_info?.message ?? '')
  task.result = p.taskOutput
}
const handleSubagentCompleted = handleSubagentSettled('completed')
const handleSubagentFailed = handleSubagentSettled('failed')

// MCP连接状态管理
const hasConnectedMCPServers = ref(false)

// MCP列表数据
const toolsList = ref<any[]>([])
const resourcesList = ref<any[]>([])
const promptsList = ref<any[]>([])

// 搜索状态
const toolsSearch = ref('')
const resourcesSearch = ref('')
const promptsSearch = ref('')

// 单击/双击定时器
let clickTimer: ReturnType<typeof setTimeout> | null = null

// 按服务器分组的MCP数据（用于树形结构）
const groupedTools = computed(() => groupByServer(filteredTools.value))
const groupedResources = computed(() => groupByServer(filteredResources.value))
const groupedPrompts = computed(() => groupByServer(filteredPrompts.value))

// 筛选后的MCP数据
const filteredTools = computed(() => filterBySearch(toolsList.value, toolsSearch.value))
const filteredResources = computed(() => filterBySearch(resourcesList.value, resourcesSearch.value))
const filteredPrompts = computed(() => filterBySearch(promptsList.value, promptsSearch.value))

// 辅助函数：按搜索关键词筛选
const filterBySearch = (items: any[], keyword: string): any[] => {
  if (!keyword.trim()) return items
  const lowerKeyword = keyword.toLowerCase()
  return items.filter(item => {
    const name = item.function?.name || item.name || ''
    const description = item.function?.description || item.description || ''
    return name.toLowerCase().includes(lowerKeyword) || 
           description.toLowerCase().includes(lowerKeyword)
  })
}

// 辅助函数：按服务器名称分组
const groupByServer = (items: any[]): Record<string, any[]> => {
  const groups: Record<string, any[]> = {}
  items.forEach(item => {
    const serverName = item.serverName || '未知服务器'
    if (!groups[serverName]) {
      groups[serverName] = []
    }
    groups[serverName].push(item)
  })
  return groups
}

// 辅助函数：测量文本宽度
const measureTextWidth = (text: string, font: string = '14px Inter, system-ui, sans-serif'): number => {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return 0
  context.font = font
  return context.measureText(text).width
}

// 辅助函数：截断长文本
const truncateText = (text: string, maxLength: number = 100): { text: string; needsTooltip: boolean } => {
  if (!text) return { text: '', needsTooltip: false }
  const truncated = text.length > maxLength ? text.slice(0, maxLength) + '...' : text
  return { text: truncated, needsTooltip: text.length > maxLength }
}

// 辅助函数：格式化服务器名称（移除 mcp 前缀）
const formatServerName = (name: string): string => {
  if (!name) return ''
  return name.replace(/^mcp[-_]/i, '')
}

// 服务器展开状态
const expandedServers = ref<Set<string>>(new Set())

// 切换服务器展开/折叠状态
const toggleServer = (serverName: string, type: 'tools' | 'resources' | 'prompts') => {
  if (expandedServers.value.has(serverName)) {
    expandedServers.value.delete(serverName)
  } else {
    expandedServers.value.add(serverName)
  }

  const resizeLock = type === 'tools' ? toolsResizeLock :
                     type === 'resources' ? resourcesResizeLock : promptsResizeLock
  resizeLock.value = true

  nextTick(() => {
    const dropdownElement = document.querySelector(`.${type}-dropdown`) as HTMLElement
    if (!dropdownElement) {
      resizeLock.value = false
      return
    }

    dropdownElement.style.height = 'auto'
    const naturalHeight = dropdownElement.scrollHeight
    const computedStyle = window.getComputedStyle(dropdownElement)
    const maxHeight = parseInt(computedStyle.maxHeight) || Math.floor(window.innerHeight * 2 / 3)
    const finalHeight = Math.min(naturalHeight, maxHeight)

    const styleRef = type === 'tools' ? toolsDropdownStyle :
                     type === 'resources' ? resourcesDropdownStyle : promptsDropdownStyle

    styleRef.value = {
      ...styleRef.value,
      height: `${finalHeight}px`,
      overflowY: finalHeight >= naturalHeight ? 'hidden' : 'auto'
    }

    setTimeout(() => {
      resizeLock.value = false
    }, 150)
  })
}

// 获取服务器的展开状态
const isServerExpanded = (serverName: string) => {
  return expandedServers.value.has(serverName)
}

// 辅助函数：调整下拉列表高度（用于搜索后自适应）
const adjustDropdownHeight = (type: 'tools' | 'resources' | 'prompts') => {
  const resizeLock = type === 'tools' ? toolsResizeLock :
                     type === 'resources' ? resourcesResizeLock : promptsResizeLock
  resizeLock.value = true

  nextTick(() => {
    const dropdownElement = document.querySelector(`.${type}-dropdown`) as HTMLElement
    if (!dropdownElement) {
      resizeLock.value = false
      return
    }

    dropdownElement.style.height = 'auto'
    const naturalHeight = dropdownElement.scrollHeight
    const computedStyle = window.getComputedStyle(dropdownElement)
    const maxHeight = parseInt(computedStyle.maxHeight) || Math.floor(window.innerHeight * 2 / 3)
    const finalHeight = Math.min(naturalHeight, maxHeight)

    const styleRef = type === 'tools' ? toolsDropdownStyle :
                     type === 'resources' ? resourcesDropdownStyle : promptsDropdownStyle

    styleRef.value = {
      ...styleRef.value,
      height: `${finalHeight}px`,
      overflowY: finalHeight >= naturalHeight ? 'hidden' : 'auto'
    }

    setTimeout(() => {
      resizeLock.value = false
    }, 150)
  })
}

// 下拉列表显示状态
const showToolsDropdown = ref(false)
const showResourcesDropdown = ref(false)
const showPromptsDropdown = ref(false)

// 下拉列表位置样式
const toolsDropdownStyle = ref<Record<string, string | number>>({})
const resourcesDropdownStyle = ref<Record<string, string | number>>({})
const promptsDropdownStyle = ref<Record<string, string | number>>({})

// 隐藏定时器
const toolsHideTimer = ref<number | null>(null)
const resourcesHideTimer = ref<number | null>(null)
const promptsHideTimer = ref<number | null>(null)

// 资源详情弹窗状态
const showResourceDialog = ref(false)
const selectedResource = ref<any>(null)

// 调整大小锁定状态（防止调整大小时鼠标移出导致下拉框关闭）
const toolsResizeLock = ref(false)
const resourcesResizeLock = ref(false)
const promptsResizeLock = ref(false)

// IME输入状态跟踪（解决中文输入时下拉列表消失问题）
const isComposing = ref<{
  tools: boolean
  resources: boolean
  prompts: boolean
}>({
  tools: false,
  resources: false,
  prompts: false
})

const tooltipState = reactive({
  visible: false,
  content: '',
  x: 0,
  y: 0,
  activeDropdownType: null as 'tools' | 'resources' | 'prompts' | null
})

let tooltipHideTimer: number | null = null

const showTooltip = (event: MouseEvent, content: string, dropdownType: 'tools' | 'resources' | 'prompts' | null = null) => {
  if (tooltipHideTimer) {
    clearTimeout(tooltipHideTimer)
    tooltipHideTimer = null
  }
  
  tooltipState.activeDropdownType = dropdownType
  
  const target = event.target as HTMLElement
  const rect = target.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const tooltipWidth = 400
  const tooltipHeight = 300
  const tooltipPadding = 12

  let x = rect.left
  let y = rect.bottom + 8
  const spaceBelow = viewportHeight - y - tooltipPadding
  const spaceAbove = rect.top - tooltipPadding

  if (x + tooltipWidth > viewportWidth - tooltipPadding) {
    x = viewportWidth - tooltipWidth - tooltipPadding
  }
  if (x < tooltipPadding) {
    x = tooltipPadding
  }

  if (spaceBelow >= tooltipHeight) {
    y = rect.bottom + 8
  } else if (spaceAbove >= tooltipHeight) {
    y = rect.top - tooltipHeight - 8
  } else if (spaceBelow > spaceAbove) {
    y = rect.bottom + 8
  } else {
    y = tooltipPadding
  }

  tooltipState.content = content
  tooltipState.x = x
  tooltipState.y = y
  tooltipState.visible = true
}

const hideTooltip = () => {
  tooltipHideTimer = window.setTimeout(() => {
    tooltipState.visible = false
    tooltipState.activeDropdownType = null
    tooltipHideTimer = null
  }, 100)
}

const cancelHideTooltip = () => {
  if (tooltipHideTimer) {
    clearTimeout(tooltipHideTimer)
    tooltipHideTimer = null
  }
  tooltipState.visible = true
  if (tooltipState.activeDropdownType) {
    cancelHideTimer(tooltipState.activeDropdownType)
  }
}

// 点击资源项（打开详情弹窗）
const handleResourceClick = (resource: any) => {
  selectedResource.value = resource
  showResourceDialog.value = true
}

// 处理从聊天界面prompt图标下拉列表点击选择prompt（支持单击/双击区分）
const handlePromptClick = (prompt: any) => {
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
    showPromptsDropdown.value = false
    promptMode.isDirectSend = true
    eventBus.emit(EVENTS.PROMPT_SEND_FROM_DROPDOWN, prompt)
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null
      showPromptsDropdown.value = false
      promptMode.isDirectSend = false
      eventBus.emit(EVENTS.PROMPT_SELECT_FROM_DROPDOWN, prompt)
    }, 250)
  }
}

// 检查MCP连接状态
const checkMCPConnections = async () => {
  try {
    const mcpClient = getMCPClient()
    const connectionsResponse = await mcpClient.listConnections()
    if (connectionsResponse.success && connectionsResponse.connections) {
      const connectedConnections = connectionsResponse.connections.filter(
        (conn: any) => conn.status === 'connected' || conn.connected === true
      )
      hasConnectedMCPServers.value = connectedConnections.length > 0
    } else {
      hasConnectedMCPServers.value = false
    }
  } catch (error) {
    console.error('检查MCP连接状态失败:', error)
    hasConnectedMCPServers.value = false
  }
}

// 加载MCP数据（使用mcpService的聚合方法获取所有服务器的数据）
const loadMCPData = async () => {
  try {
    const mcpService = modelServiceFactory['mcpService']
    
    if (!mcpService) {
      return
    }
    
    mcpService.clearAggregationCache()
    
    const tools = await mcpService.getOpenAITools()
    toolsList.value = tools || []
    
    const resources = await mcpService.getOpenAIResources()
    resourcesList.value = resources || []
    
    const prompts = await mcpService.getOpenAIPrompts()
    promptsList.value = prompts || []
    
  } catch (error) {
    console.error('加载MCP数据失败:', error)
  }
}

// 计算下拉列表位置
const calculateDropdownPosition = (targetElement: HTMLElement, styleRef: any, dropdownElement: HTMLElement, type: 'tools' | 'resources' | 'prompts') => {
  const chatSection = chatSectionRef.value
  if (!chatSection || !targetElement || !dropdownElement) return

  const targetRect = targetElement.getBoundingClientRect()
  const chatRect = chatSection.getBoundingClientRect()

  const containerLeft = targetRect.left - chatRect.left
  const containerTop = targetRect.top - chatRect.top
  const chatSectionHeight = chatRect.height
  const maxHeight = Math.floor(chatSectionHeight * 2 / 3)

  const groupedData = type === 'tools' ? groupedTools.value :
                      type === 'resources' ? groupedResources.value : groupedPrompts.value
  const serverNames = Object.keys(groupedData)
  const longestServerName = serverNames.reduce((longest, name) => name.length > longest.length ? name : longest, '')
  const serverNameWidth = measureTextWidth(longestServerName)
  const dropdownWidth = Math.max(140, Math.min(400, Math.ceil(serverNameWidth + 60)))

  const containerWidth = chatRect.width
  const rawLeft = containerLeft - 20
  const finalLeft = rawLeft + dropdownWidth > containerWidth
    ? containerWidth - dropdownWidth
    : rawLeft

  styleRef.value = {
    position: 'absolute',
    left: `${finalLeft}px`,
    top: `-9999px`,
    height: '0px',
    width: `${dropdownWidth}px`,
    maxWidth: 'none',
    maxHeight: `${maxHeight}px`,
    zIndex: 10000,
    borderRadius: '12px',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08)'
  }

  const updateDropdownHeight = () => {
    const naturalHeight = dropdownElement.scrollHeight
    const finalHeight = Math.min(naturalHeight, maxHeight)
    const finalTop = containerTop - finalHeight - 8

    styleRef.value = {
      ...styleRef.value,
      height: `${finalHeight}px`,
      top: `${finalTop}px`,
      overflowY: 'auto'
    }
  }

  const observer = new ResizeObserver(() => {
    updateDropdownHeight()
  })

  observer.observe(dropdownElement)
}

// 显示/隐藏下拉列表
const showDropdown = (type: 'tools' | 'resources' | 'prompts', event: MouseEvent) => {
  const target = event.currentTarget as HTMLElement
  
  if (type === 'tools') {
    if (toolsHideTimer.value) {
      clearTimeout(toolsHideTimer.value)
      toolsHideTimer.value = null
    }
    showToolsDropdown.value = true
    nextTick(() => {
      const dropdownElement = document.querySelector('.tools-dropdown') as HTMLElement
      calculateDropdownPosition(target, toolsDropdownStyle, dropdownElement, 'tools')
    })
  } else if (type === 'resources') {
    if (resourcesHideTimer.value) {
      clearTimeout(resourcesHideTimer.value)
      resourcesHideTimer.value = null
    }
    showResourcesDropdown.value = true
    nextTick(() => {
      const dropdownElement = document.querySelector('.resources-dropdown') as HTMLElement
      calculateDropdownPosition(target, resourcesDropdownStyle, dropdownElement, 'resources')
    })
  } else if (type === 'prompts') {
    if (promptsHideTimer.value) {
      clearTimeout(promptsHideTimer.value)
      promptsHideTimer.value = null
    }
    showPromptsDropdown.value = true
    nextTick(() => {
      const dropdownElement = document.querySelector('.prompts-dropdown') as HTMLElement
      calculateDropdownPosition(target, promptsDropdownStyle, dropdownElement, 'prompts')
    })
  }
}

const hideDropdown = (type: 'tools' | 'resources' | 'prompts') => {
  if (isComposing.value[type]) return

  const resizeLock = type === 'tools' ? toolsResizeLock :
                     type === 'resources' ? resourcesResizeLock : promptsResizeLock

  if (resizeLock.value) return

  if (type === 'tools') {
    toolsHideTimer.value = window.setTimeout(() => {
      showToolsDropdown.value = false
    }, 100)
  } else if (type === 'resources') {
    resourcesHideTimer.value = window.setTimeout(() => {
      showResourcesDropdown.value = false
    }, 100)
  } else if (type === 'prompts') {
    promptsHideTimer.value = window.setTimeout(() => {
      showPromptsDropdown.value = false
    }, 100)
  }
}

const cancelHideTimer = (type: 'tools' | 'resources' | 'prompts') => {
  if (type === 'tools' && toolsHideTimer.value) {
    clearTimeout(toolsHideTimer.value)
    toolsHideTimer.value = null
  } else if (type === 'resources' && resourcesHideTimer.value) {
    clearTimeout(resourcesHideTimer.value)
    resourcesHideTimer.value = null
  } else if (type === 'prompts' && promptsHideTimer.value) {
    clearTimeout(promptsHideTimer.value)
    promptsHideTimer.value = null
  }
}

const handleCompositionStart = (_event: CompositionEvent, type: 'tools' | 'resources' | 'prompts') => {
  isComposing.value[type] = true
  cancelHideTimer(type)
}

const handleCompositionUpdate = (_event: CompositionEvent, _type: 'tools' | 'resources' | 'prompts') => {
  
}

const handleCompositionEnd = (_event: CompositionEvent, type: 'tools' | 'resources' | 'prompts') => {
  isComposing.value[type] = false
}

// 边界工具栏显示条件：MCP服务器按钮显示且打开，且至少有一个列表有内容
const shouldShowBoundaryToolbar = computed(() => {
  return hasConnectedMCPServers.value && 
         mcpStore.isMCPToolsEnabled &&
         (toolsList.value.length > 0 || 
          resourcesList.value.length > 0 || 
          promptsList.value.length > 0)
})

// 处理模型选择
const handleModelSelected = (model: ModelInfo | null) => {
  currentModel.value = model
}

// 停止流式请求（引擎 abort：中断后本轮完整回滚，视图经 refillViewFromEngine 对齐）
const stopStreaming = () => {
  if (abortController.value) {
    // 非 chat 模型路径（handleNonChatModel）仍用本地 AbortController
    abortController.value.abort()
    abortController.value = null
  }
  getChatEngine().abort()
  isStreaming.value = false
}

// 切换设置界面显示/隐藏（功能集合7）
const toggleSettingsVisibility = () => {
  isSettingsVisible.value = !isSettingsVisible.value
}

// 关闭设置界面（close-settings 纯关闭语义，不做 toggle）
const closeSettings = () => {
  isSettingsVisible.value = false
}

// 打开设置界面并指定Tab
const openSettingsWithTab = (tab: string) => {
  // 先打开设置界面
  isSettingsVisible.value = true
  // 通过eventBus通知ModelSettings切换到指定Tab
  eventBus.emit(EVENTS.SWITCH_SETTINGS_TAB, tab)
}

// ◐「工作对象」菜单：打开 dock 并切到指定类型页签
const handleOpenWorkObject = (type: string) => {
  contentDockRef.value?.openDock(type)
}

// 从设置界面打开工作流：落到 dock 的 workflow 页签（单容器槽位，互斥逻辑已消弭）
const handleOpenWorkflowFromSettings = (workflowId: string) => {
  const dock = contentDockRef.value
  if (!dock) return
  dock.openDock('workflow')
  // 打开指定工作流（等异步组件挂载完成后经 dock 透传到编辑器）
  if (workflowId) {
    void dock.waitActiveEditor().then((editor: any) => {
      editor?.openWorkflow?.(workflowId)
    })
  }
}

// 从设置界面打开Agent工厂：落到 dock 的 workflow 页签（不加载特定工作流）
const handleOpenAgentFactoryFromSettings = () => {
  contentDockRef.value?.openDock('workflow')
}

watch(isStreaming, (newValue, oldValue) => {
  if (oldValue === true && newValue === false) {
    // 流式期间收到的对端会话变更，流结束后补回填（仍是当前会话才采纳）
    if (pendingSessionRefill) {
      const record = pendingSessionRefill
      pendingSessionRefill = null
      if (record.id === currentConversationId.value) {
        void (async () => {
          try {
            await getChatEngine().loadSession(record.id)
            refillFromRecord(record)
            syncConversationRefs()
          } catch (err) {
            // 自动回填被会话护栏（后台任务进行中）等阻止：跳过本次，不打扰用户
            console.warn('会话回填失败:', err)
          }
        })()
      }
    }
  }
})

// 写作目录变化：AGENTS.md 工作目录同步到引擎（引擎每轮组装现读 deps.workDir）
watch(() => writingViewStore.currentDirectory, (dir) => {
  setEngineWorkDir(dir ?? undefined)
}, { immediate: true })

watch([toolsSearch, resourcesSearch, promptsSearch], ([newToolsSearch, newResourcesSearch, newPromptsSearch]) => {
  nextTick(() => {
    // 工具搜索：自动展开有结果的服务器
    if (newToolsSearch) {
      adjustDropdownHeight('tools')
      Object.keys(groupedTools.value).forEach(serverName => {
        expandedServers.value.add(serverName)
      })
    }
    // 资源搜索：自动展开有结果的服务器
    if (newResourcesSearch) {
      adjustDropdownHeight('resources')
      Object.keys(groupedResources.value).forEach(serverName => {
        expandedServers.value.add(serverName)
      })
    }
    // 提示搜索：自动展开有结果的服务器
    if (newPromptsSearch) {
      adjustDropdownHeight('prompts')
      Object.keys(groupedPrompts.value).forEach(serverName => {
        expandedServers.value.add(serverName)
      })
    }
  })
})

// 组件挂载时恢复状态
onMounted(() => {
  // 注意：不再直接设置currentModel，让ModelSelector组件处理自动选择
  // 历史的模型选择状态由ModelSelector组件通过handleModelSelected事件来同步

  // 首跑引导检测：未跳过（kv 与 CLI 端互认）且零 Key（SecureStorage 经 main.ts 的
  // ElectronSecureStorage IPC 适配器落到同一 ~/.chill/keys）→ 显示引导卡片
  void (async () => {
    try {
      if (firstRunKv?.getItem(FIRST_RUN_DISMISSED_KEY) === 'true') return
      const providers = await SecureStorageService.getAllProviders()
      if (providers.length === 0) showFirstRunCard.value = true
    } catch { /* 检测失败不显示 */ }
  })()

  // 添加历史对话加载事件监听器
  window.addEventListener('load-conversation', handleLoadConversation as EventListener)
  // 添加对话删除事件监听器
  window.addEventListener('conversation-deleted', handleConversationDeleted as EventListener)
  
  // 初始化MCP工具状态
  mcpStore.initMCPToolsState()
  
  // 检查MCP连接状态
  checkMCPConnections()
  
  // 监听MCP连接状态变化事件
  eventBus.on(EVENTS.MCP_CONNECTION_CHANGED, checkMCPConnections)
  
  // 加载MCP数据
  loadMCPData()
  
  // 监听MCP连接变化，重新加载数据
  eventBus.on(EVENTS.MCP_CONNECTION_CHANGED, loadMCPData)

  // 监听文件变化（dock 内写作编辑器可见时同步刷新文件树；轻量视图无文件树，跳过）
  window.electronAPI.onFileChanged(async () => {
    const editor = contentDockRef.value?.isTypeActive('document')
      ? contentDockRef.value?.getActiveEditorRef()
      : null
    if (editor?.getCurrentDirectory) {
      const dirPath = editor.getCurrentDirectory() || ''
      const listResponse = await window.electronAPI.fileListDirectory(dirPath)
      if (listResponse.success && listResponse.files) {
        editor.loadFiles(listResponse.files, dirPath)
      }
    }
  })
  
  // 监听打开设置事件
  eventBus.on(EVENTS.OPEN_SETTINGS, openSettingsWithTab)

  // 监听编辑器同步打开文件事件
  eventBus.on(EVENTS.EDITOR_SYNC_OPEN_FILE, handleEditorSyncOpenFile)

  // 监听差异预览事件
  eventBus.on(EVENTS.TOOL_CALL_STATUS_CHANGED, handleToolCallStatusChanged)

  // 监听差异预览清理事件
  eventBus.on(EVENTS.DIFF_PREVIEW_CLEAR, handleDiffPreviewClear)

  // 监听 Subagent 委派进度事件（驱动委派抽屉）
  eventBus.on(EVENTS.SUBAGENT_TASK_STARTED, handleSubagentStarted)
  eventBus.on(EVENTS.SUBAGENT_TASK_COMPLETED, handleSubagentCompleted)
  eventBus.on(EVENTS.SUBAGENT_TASK_FAILED, handleSubagentFailed)

  // dock 窄窗口降级：窗口尺寸变化时重判覆盖模式
  window.addEventListener('resize', handleWindowResize)
  nextTick(updateDockOverlay)

  // 注册 UI 专属注入器（写作模块工具使用规范；注入条件在注入器内部判定）
  getChatEngine().registerContextInjector(writingModuleInjector)

  // 会话机制：CLI/UI 共享 ~/.chill/sessions 一套会话记录。
  // 跨端同步：对端（CLI）写入当前会话时自动回填消息区（自身写入已被过滤，不自闪）
  window.electronAPI?.onSessionChanged?.(handleSessionChanged)

  // 启动恢复（handoff 三值契约）：'<id>'=CLI /ui 接力该会话（未命中保持空会话）；
  // ''=接力但 CLI 尚无落盘会话 → 全新空会话（不回退历史最新）；null=直接启动 → 恢复"updatedAt 最新者"；
  // 无历史会话时保持全新引擎会话（首次落盘由引擎生成 id）
  void (async () => {
    try {
      const handoffId = window.electronAPI?.sessionGetHandoffId
        ? await window.electronAPI.sessionGetHandoffId().catch(() => null)
        : null
      if (handoffId === '') return
      const records = await loadSessionList()
      if (records.length === 0) return
      const target = handoffId ? records.find(r => r.id === handoffId) : records[0]
      if (target) loadHistoryConversation(target)
    } catch (err) {
      console.warn('启动时加载会话列表失败:', err)
    }
  })()
})

// 处理编辑器同步打开文件事件（经 dock 转发：参与态→WritingView.reloadFile，轻量态→DocumentLightView 节流重读）
const handleEditorSyncOpenFile = ({ filePath }: { filePath: string }) => {
  const dock = contentDockRef.value
  if (dock?.isTypeActive('document')) {
    dock.getActiveEditorRef()?.reloadFile(filePath)
  }
}

// 处理工具调用状态变化事件（diff 预览双路路由：参与态→编辑器既有 openFileWithDiff；
// 轻量态→DocumentLightView.openFileWithDiff 仅打开文件，diff 标注由其消费 pendingOperations 自绘，两态同名接口故此处无需分支）
const handleToolCallStatusChanged = (data: { 
  toolCallStatus: string
  diffPreview?: { 
    filePath: string
    operations: DiffOperation[] 
  }
}) => {
  const dock = contentDockRef.value
  if (data.toolCallStatus === 'pending' && data.diffPreview && dock?.isTypeActive('document')) {
    dock.getActiveEditorRef()?.openFileWithDiff(data.diffPreview.filePath, data.diffPreview.operations)
  }
}

// 处理差异预览清理事件（轻量态由 pendingOperationsStore 清空驱动自动消退，接口兼容空实现）
const handleDiffPreviewClear = () => {
  const dock = contentDockRef.value
  if (dock?.isTypeActive('document')) {
    dock.getActiveEditorRef()?.clearDiffPreview()
  }
}

// 组件卸载时清理事件监听
onUnmounted(() => {
  // 取消正在进行的流式请求（引擎每轮结束已落盘，无需卸载时再保存）
  stopStreaming()

  window.removeEventListener('load-conversation', handleLoadConversation as EventListener)
  window.removeEventListener('conversation-deleted', handleConversationDeleted as EventListener)
  eventBus.off(EVENTS.MCP_CONNECTION_CHANGED, checkMCPConnections)
  eventBus.off(EVENTS.MCP_CONNECTION_CHANGED, loadMCPData)
  eventBus.off(EVENTS.OPEN_SETTINGS, openSettingsWithTab)
  eventBus.off(EVENTS.EDITOR_SYNC_OPEN_FILE, handleEditorSyncOpenFile)
  eventBus.off(EVENTS.TOOL_CALL_STATUS_CHANGED, handleToolCallStatusChanged)
  eventBus.off(EVENTS.DIFF_PREVIEW_CLEAR, handleDiffPreviewClear)
  eventBus.off(EVENTS.SUBAGENT_TASK_STARTED, handleSubagentStarted)
  eventBus.off(EVENTS.SUBAGENT_TASK_COMPLETED, handleSubagentCompleted)
  eventBus.off(EVENTS.SUBAGENT_TASK_FAILED, handleSubagentFailed)
  window.removeEventListener('resize', handleWindowResize)
  getChatEngine().unregisterContextInjector(writingModuleInjector.id)
  
  // 清理定时器
  if (toolsHideTimer.value) clearTimeout(toolsHideTimer.value)
  if (resourcesHideTimer.value) clearTimeout(resourcesHideTimer.value)
  if (promptsHideTimer.value) clearTimeout(promptsHideTimer.value)

  // 清理文件监听
  window.electronAPI.removeFileChangedListener()
  window.electronAPI.fileWatchStop()
  // 清理会话跨端同步监听
  window.electronAPI?.removeAllListeners?.('session:changed')
})

// 创建新对话（引擎 startNewSession：清空权威历史与记录状态，下次落盘生成新 id）
const createNewConversation = () => {
  if (!chatAreaRef.value) return

  // 会话护栏：有后台任务进行中时引擎抛错阻止新建（防结果回流到错误会话），以消息区提示告知用户
  try {
    getChatEngine().startNewSession()
  } catch (error) {
    chatAreaRef.value.addMessage({
      role: MessageRole.ASSISTANT,
      content: `无法新建对话：${error instanceof Error ? error.message : '未知错误'}`,
      timestamp: new Date()
    })
    return
  }
  syncConversationRefs()

  // 清空当前对话
  chatAreaRef.value.clearMessages()

  // 清空任务列表
  taskListStore.clearTasks()

  // 清空待确认操作
  pendingOperationsStore.clearAll()

  // 重置 Subagent 处理过程信息列表（功能5c）
  subagentProcessInfos.value = []
}

/** 从引擎会话状态同步展示用 ref（id；标题等状态的权威值在引擎） */
const syncConversationRefs = () => {
  const state = getChatEngine().getSessionState()
  currentConversationId.value = state.sessionId
  syncFrontAgentFromEngine()
}

/** 视图对齐引擎权威历史（abort/异常回滚后调用；清空后按引擎历史重填） */
const refillViewFromEngine = () => {
  if (!chatAreaRef.value) return
  chatAreaRef.value.clearMessages()
  for (const message of getChatEngine().getHistory()) {
    chatAreaRef.value.addMessage(message)
  }
}

// 压缩完成（InputArea 按钮触发）：压缩不产生新消息，显式带动「已压缩」标记条刷新
const handleCompacted = () => {
  chatAreaRef.value?.refreshCompactions()
}

// 加载历史对话
/**
 * 回填会话记录到消息区/任务/标题展示（loadHistoryConversation 与跨端同步回填共用）。
 * 只动展示层：权威历史由引擎 loadSession 持有，此处按同一份记录渲染视图。
 */
const refillFromRecord = (record: SessionRecord) => {
  if (!chatAreaRef.value) return

  // 清空当前对话与任务列表
  chatAreaRef.value.clearMessages()
  taskListStore.clearTasks()

  const messagesToLoad = record.messages || []

  // 添加消息到聊天区域
  messagesToLoad.forEach((message: any) => {
    const formattedMessage = {
      role: message.role,
      content: message.content || '',
      timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
      reasoningContent: message.reasoningContent,
      contentBlocks: message.contentBlocks,
      toolCalls: message.toolCalls,
      toolCallStatuses: message.toolCallStatuses,
      toolCallResults: message.toolCallResults,
      mcpServerName: message.mcpServerName,
      toolCallId: message.toolCallId
    }
    chatAreaRef.value!.addMessage(formattedMessage)
  })

  // 恢复任务列表
  if (record.tasks && record.tasks.length > 0) {
    taskListStore.setTasks(record.tasks)
  }
}

const loadHistoryConversation = (conversation: SessionRecord) => {
  if (!chatAreaRef.value) return

  void (async () => {
    try {
      // 权威历史进引擎（记录即真相，视图按同一记录渲染）
      await getChatEngine().loadSession(conversation.id)
      refillFromRecord(conversation)
      syncConversationRefs()
    } catch (error) {
      // 含会话护栏（有后台任务进行中）抛错：以消息区提示告知用户，不切换会话
      console.error('加载历史对话失败:', error)
      chatAreaRef.value?.addMessage({
        role: MessageRole.ASSISTANT,
        content: `无法切换会话：${error instanceof Error ? error.message : '未知错误'}`,
        timestamp: new Date()
      })
    }
  })()
}

// ========== 会话跨端同步（CLI ↔ UI 共享 ~/.chill/sessions 一套记录） ==========

/** isStreaming 中收到对端变更时暂存的待回填记录（流结束后补做） */
let pendingSessionRefill: SessionRecord | null = null

// 当前会话 id 确立/变化时（启动恢复、createNewConversation、loadHistoryConversation 均经此）
// 通知主进程重定向 watch——同一时刻只 watch 当前会话
watch(currentConversationId, (id) => {
  if (id && window.electronAPI?.sessionWatch) {
    window.electronAPI.sessionWatch(id).catch((err: unknown) => console.warn('会话 watch 重定向失败:', err))
  }
  // 迭代 7：◐/页签跟随会话切换（事件自带 sessionId，此归属仅兜底残缺载荷）
  workObjectStore.setCurrentSession(id)
  // 项目=文件夹绑定：当前会话 id 推入 projectStore（写边界项目解析的前提接线）；
  // 会话归属项目已绑定文件夹时写作编辑器文件树跟随，未绑定不动（保留手动打开的目录作回退）
  projectStore.setCurrentSessionId(id)
  if (id) {
    void (async () => {
      await projectStore.ensureSessionsLoaded()
      if (projectStore.projects.length === 0) await projectStore.loadProjects()
      const projectId = projectStore.sessionProjectIdOf(id)
      const folderPath = projectId
        ? projectStore.projects.find(p => p.id === projectId)?.folderPath
        : undefined
      if (folderPath) writingViewStore.setCurrentDirectory(folderPath)
    })()
  }
})

// 会话活跃类型 → dock 页签集（切换会话页签集跟随换成新会话活跃类型；dock 已开时新类型自动进页签条）
watch(() => workObjectStore.currentSummaries, (summaries) => {
  contentDockRef.value?.setSessionTypes(
    summaries.map(s => ({ type: s.type, lastActiveAt: s.lastActiveAt }))
  )
})

// dock 打开且页签聚焦某类型即视为已看（◐ 聚合徽标 = 有未看更新的类型数）
watch([() => contentDockRef.value?.open, () => contentDockRef.value?.activeType], ([isOpen, type]) => {
  if (isOpen && typeof type === 'string') {
    workObjectStore.markTypeSeen(type)
  }
})

// 对端（CLI）写入当前会话：回填展示；流式中置脏延后，流结束后补做
const handleSessionChanged = (record: SessionRecord | null) => {
  // 会话文件被对端删除：提示一句，不崩溃、不重建空记录——引擎 detachSession 保留历史，
  // 继续聊天将作为新记录落盘（不用同 id 复活刚删的记录）
  if (record === null) {
    getChatEngine().detachSession()
    syncConversationRefs()
    chatAreaRef.value?.addMessage({
      role: MessageRole.ASSISTANT,
      content: '（当前会话已被另一端删除，后续聊天将作为新会话保存）',
      timestamp: new Date()
    })
    return
  }
  if (record.id !== currentConversationId.value) return
  if (isStreaming.value) {
    pendingSessionRefill = record
    return
  }
  void (async () => {
    try {
      await getChatEngine().loadSession(record.id)
      refillFromRecord(record)
      syncConversationRefs()
    } catch (err) {
      // 自动回填被会话护栏（后台任务进行中）等阻止：跳过本次，不打扰用户
      console.warn('会话回填失败:', err)
    }
  })()
}

// 处理加载历史对话事件
const handleLoadConversation = (event: CustomEvent) => {
  loadHistoryConversation(event.detail)
}

// 删除历史对话事件（删除已在工作区面板执行一次，此处不再重复删——只保留 detach 语义）
const handleConversationDeleted = (event: CustomEvent) => {
  // 删除的是当前对话：引擎 detachSession（保留历史）——既不复活已删记录，也让继续聊天能作为新记录保存
  if (event.detail?.id && event.detail.id === currentConversationId.value) {
    getChatEngine().detachSession()
    syncConversationRefs()
  }
}

// 视频存储提供者：通过 Electron IPC 保存视频附件
const videoStorageProvider: VideoStorageProvider = {
  save: async (name: string, bytes: Uint8Array): Promise<string> => {
    if (window.electronAPI?.saveAttachment) {
      return await window.electronAPI.saveAttachment(bytes.buffer as ArrayBuffer, name)
    }
    return ''
  }
}

// 视频文件大小限制 (30MB)
const MAX_VIDEO_SIZE = 30 * 1024 * 1024

// ==================== UI 专属注入器：写作模块工具使用规范 ====================

/**
 * 写作模块 prompt（迁移自旧 optimizeMessagesForLLM 的注入段，注入条件不变：
 * 写作视图可见且已打开目录）。经引擎条件注入器框架注册，CLI 进程从不加载。
 */
const writingModuleInjector: ContextInjector = {
  id: 'ui-writing-module',
  order: INJECTOR_ORDER.HOST_DEFAULT,
  inject: () => {
    // 注入条件不变：写作视图可见（dock 打开且聚焦 document 页签）且已打开目录
    if (!contentDockRef.value?.isTypeActive('document') || !writingViewStore.currentDirectory) return null
    const prompt = `## 写作模块工具使用规范

当前工作目录：${writingViewStore.currentDirectory}

当用户在写作模块中工作时，你可以使用以下工具来修改文档内容。为了确保精确定位，请遵循以下规范：

### 工具调用强制约束

当你调用 insert_content/replace_content/delete_content 工具时，必须同时提供以下参数：

1. **content/old_content**：完整的目标文本片段
2. **context_before**：目标文本之前的 20-30 个字符（必须足够唯一，不要太短）
3. **context_after**：目标文本之后的 20-30 个字符

### 示例

✅ 正确：
\`\`\`json
{
  "old_content": "小星十六岁那年，村里通了电，却也带来了光污染。",
  "context_before": "每个晴朗的夜晚，小星都会爬上屋顶，",
  "context_after": "星空不再如从前那般清晰，但小星没有放弃。"
}
\`\`\`

❌ 错误（缺少前后文锁）：
\`\`\`json
{
  "old_content": "小星十六岁那年，村里通了电，却也带来了光污染。"
}
\`\`\`

### 错误反馈处理规则

如果工具返回匹配失败，并提供了 candidates 候选位置列表：
1. 请仔细阅读每个候选位置的 snippet，找到你真正想操作的那一个
2. 直接使用该候选位置的 suggested_context_before 和 suggested_context_after 重新调用工具
3. 不要盲目重试，必须使用提供的建议上下文`
    return { role: MessageRole.SYSTEM, content: prompt, timestamp: new Date() }
  },
}

// 发送消息（T5：发送路径收敛为单一 ChatEngine 调用，模式 switch 已取消）
const handleSendMessage = async ({ text, imageFiles, videoFiles }: { text: string; imageFiles?: File[]; videoFiles?: File[] }) => {
  if (!chatAreaRef.value || (!text.trim() && (!imageFiles || imageFiles.length === 0) && (!videoFiles || videoFiles.length === 0))) return

  // 发送前锚定（唯一定点）：对端（CLI）若在磁盘上有更新，先采纳再发送——内存只是视图，真相在盘上
  if (currentConversationId.value && window.electronAPI?.sessionLoadIfNewer) {
    try {
      const anchorResult = await window.electronAPI.sessionLoadIfNewer(currentConversationId.value)
      if (anchorResult?.success && anchorResult.record) {
        await getChatEngine().loadSession(anchorResult.record.id)
        refillFromRecord(anchorResult.record as SessionRecord)
      }
    } catch { /* 锚定失败不阻塞发送 */ }
  }

  // 检查视频文件大小
  if (videoFiles && videoFiles.length > 0) {
    const oversizedVideos = videoFiles.filter(file => file.size > MAX_VIDEO_SIZE)
    if (oversizedVideos.length > 0) {
      const names = oversizedVideos.map(f => f.name).join(', ')
      chatAreaRef.value.addMessage({
        role: MessageRole.ASSISTANT,
        content: `视频文件过大（超过30MB）：${names}。请压缩视频或使用文件上传功能。`,
        timestamp: new Date()
      })
      return
    }
  }

  // 获取模型 capabilities
  const modelName = currentModel.value?.name || ''
  const capabilities = modelServiceFactory.getModelCapabilities(modelName)

  // 非 chat 模型走简化路径
  if (!capabilities.chat) {
    await handleNonChatModel(text, imageFiles, videoFiles)
    return
  }

  await handleChatWithEngine(text, imageFiles, videoFiles)
}

/**
 * 统一对话路径（ChatEngine）：视图（chatArea）负责渲染，引擎持有权威历史、
 * 上下文组装、工具循环（含 task 委派）、持久化与自动标题。
 * TOOL_MESSAGE_CREATED / ASSISTANT_MESSAGE_CREATED 事件由 ChatArea 自行消费（与现状一致）。
 */
const handleChatWithEngine = async (message: string, imageFiles?: File[], videoFiles?: File[]) => {
  if (!chatAreaRef.value) return

  try {
    // 解析 @agent 显式点名（清单 = 渲染进程模板副本全量；不精确匹配按普通文本）
    const availableAgentTypes = new Set(getTemplateManager().getAllTemplates().map(t => t.subagent_type))

    // 裸提及（只喊名字不带任务、无附件）= 切换前台直聊：不发起模型轮；
    // 带任务内容 = 委派（下方 explicitAgent 路径）
    const hasMedia = (imageFiles?.length ?? 0) > 0 || (videoFiles?.length ?? 0) > 0
    const bareAgent = hasMedia ? undefined : parseBareAgentMention(message, availableAgentTypes)
    if (bareAgent) {
      const candidate = getChatEngine().getFrontAgentCandidates().find((c) => c.type === bareAgent)
      if (!candidate) {
        // 远程模板无本地连续对话能力（与 CLI handleFront 同语义指引）
        chatAreaRef.value.addMessage({
          role: MessageRole.ASSISTANT,
          content: `「${bareAgent}」仅支持委派（远程模板不能作为前台），请带任务内容使用，如：@${bareAgent} 帮我……`,
          timestamp: new Date()
        })
        return
      }
      setFrontAgent(bareAgent)
      const display = getChatEngine().getFrontAgentDisplay()
      const modelText = display?.model
        ? `（模型: ${display.model}${display.modelSource === 'template' ? '（模板指定）' : ''}）`
        : ''
      chatAreaRef.value.addMessage({
        role: MessageRole.ASSISTANT,
        content: `已切换到「${candidate.name}」前台直聊${modelText}，之后的对话将直接由它应答；恢复裸模型可在左下角前台选择器切换`,
        timestamp: new Date()
      })
      return
    }

    const { explicitAgent } = parseAgentMentions(message, availableAgentTypes)

    // 构建引擎输入（输入侧媒体能力过滤由引擎负责；视图始终渲染原始内容）
    let input: ChatEngineInput
    let userViewContent: string | ContentPart[] = message
    if ((imageFiles && imageFiles.length > 0) || (videoFiles && videoFiles.length > 0)) {
      const imageDescs: MediaFileDescriptor[] = (imageFiles || []).map(f => ({ name: f.name, mimeType: f.type, getBytes: async () => new Uint8Array(await f.arrayBuffer()) }))
      const videoDescs: MediaFileDescriptor[] = (videoFiles || []).map(f => ({ name: f.name, mimeType: f.type, getBytes: async () => new Uint8Array(await f.arrayBuffer()) }))
      const contentParts = await buildContentParts(message, imageDescs, videoDescs, videoStorageProvider)
      input = { text: message, contentParts }
      userViewContent = contentParts
    } else {
      input = { text: message }
    }

    // 点名结果透传引擎
    if (explicitAgent) input.explicitAgent = explicitAgent

    // 视图：用户消息 + assistant 占位（流式渲染目标）
    chatAreaRef.value.addMessage({
      role: MessageRole.USER,
      content: userViewContent,
      timestamp: new Date()
    })
    chatAreaRef.value.addMessage({
      role: MessageRole.ASSISTANT,
      content: '',
      timestamp: new Date(),
      isSubResponse: true
    })

    isStreaming.value = true

    const result = await getChatEngine().sendMessage(input, {
      streamCallback: (chunk) => {
        if (chunk.content || chunk.reasoningContent || chunk.toolCalls) {
          chatAreaRef.value?.updateLastMessage(
            chunk.content || '',
            chunk.reasoningContent || '',
            chunk.toolCalls
          )
        }
      },
    })

    if (result.aborted) {
      // 中断：引擎已完整回滚本轮历史，视图对齐引擎（移除本轮渲染的半截内容）
      refillViewFromEngine()
    }
    syncConversationRefs()
  } catch (error) {
    console.error('发送消息失败:', error)
    chatAreaRef.value.addMessage({
      role: MessageRole.ASSISTANT,
      content: `发送消息失败: ${error instanceof Error ? error.message : '未知错误'}`,
      timestamp: new Date()
    })
    // 异常时引擎同样回滚了本轮，视图对齐
    refillViewFromEngine()
  } finally {
    isStreaming.value = false
    chatAreaRef.value?.markConversationComplete()
  }
}

/**
 * 非 chat 模型发送路径
 * 不构建对话历史、不添加占位消息、不调用 saveCurrentConversation
 * 流式回调走 output 路径
 */
const handleNonChatModel = async (prompt: string, imageFiles?: File[], videoFiles?: File[]) => {
  const capabilities = modelServiceFactory.getModelCapabilities(currentModel.value?.name || '')
  const isAsync = !!capabilities.asyncTask

  try {
    isStreaming.value = true

    // 异步任务：提交前添加占位消息显示进度
    if (isAsync) {
      chatAreaRef.value?.addMessage({
        role: MessageRole.ASSISTANT,
        content: '任务已提交，正在处理...',
        timestamp: new Date()
      })
    }

    const messages: Message[] = [
      { role: MessageRole.USER, content: prompt, timestamp: new Date() }
    ]

    const response = await modelServiceFactory.sendChatMessage(
      currentModel.value?.name,
      messages,
      {
        streamCallback: (chunk) => {
          if (isAsync) {
            // 异步任务：以文本形式展示轮询进度
            if (chunk.content) {
              chatAreaRef.value?.updateLastMessage(chunk.content, '', [])
            }
            if (chunk.output) {
              chatAreaRef.value?.updateLastOutput(chunk.output)
            }
            if (chunk.isStreamComplete) {
              // 最终不再更新，等 response 处理
            }
          } else if (chunk.output) {
            chatAreaRef.value?.updateLastOutput(chunk.output)
          } else if (chunk.content) {
            chatAreaRef.value?.updateLastMessage(chunk.content, chunk.reasoningContent, chunk.toolCalls)
          }
        },
        abortController: abortController.value,
      }
    )

    // 异步任务：清除占位消息，展示最终结果
    if (isAsync) {
      if (response.output) {
        // 清除占位文本，用 output 替换
        chatAreaRef.value?.updateLastMessage('', '', [])
        chatAreaRef.value?.updateLastOutput(response.output)
      } else if (response.content) {
        chatAreaRef.value?.updateLastMessage(response.content, '', [])
      }
    } else if (response.output) {
      chatAreaRef.value?.updateLastOutput(response.output)
    }
  } catch (error: any) {
    if (isAsync) {
      chatAreaRef.value?.updateLastMessage(
        `异步任务失败: ${error instanceof Error ? error.message : '未知错误'}`,
        '',
        []
      )
    } else if (error?.message !== 'Request aborted') {
      console.error('非chat模型处理失败:', error)
      chatAreaRef.value?.addMessage({
        role: MessageRole.ASSISTANT,
        content: `处理失败: ${error instanceof Error ? error.message : '未知错误'}`,
        timestamp: new Date()
      })
    }
  } finally {
    isStreaming.value = false
    abortController.value = null
  }
}

</script>

<style scoped>
.home-container {
  display: flex;
  flex-direction: row; /* 横向 flex 流式骨架：工作对象视窗（ContentDock）+ 聊天区 flex:1 */
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

/* CHAT区域整体容器（常驻，占满剩余宽度） */
.chat-section {
  position: relative; /* 作为 MCP 下拉列表等绝对定位元素的包含块（不再有 transform，fixed 后代相对 viewport 定位） */
  flex: 1 1 auto;
  min-width: 0;
  background-color: #faf9f6; /* 护眼暖白色 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* CHAT区域头部 */
.chat-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-2) var(--spacing-3);
  background-color: #faf9f6; /* 与下方区域保持一致的护眼暖白色 */
  min-height: 34px;
}

/* 首跑引导卡片：零 Key 用户一次性指路（横幅形态，随 header 之下不占聊天主体） */
.first-run-card {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--spacing-3);
  padding: var(--spacing-2) var(--spacing-3);
  background-color: #fdf6e9;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: 13px;
}

.first-run-icon {
  flex: 0 0 auto;
  color: #c99742;
}

.first-run-text {
  flex: 1 1 auto;
  min-width: 0;
}

.first-run-action {
  flex: 0 0 auto;
  padding: 4px 14px;
  border: 1px solid #c99742;
  border-radius: 6px;
  background-color: #c99742;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.first-run-action:hover {
  background-color: #b3852f;
  border-color: #b3852f;
}

.first-run-close {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  border-radius: 4px;
}

.first-run-close:hover {
  background-color: rgba(0, 0, 0, 0.06);
}


/* CHAT区域布局容器 */
.chat-layout-container {
  flex: 1 1 auto;
  overflow: hidden;
  display: flex;
  flex-direction: row;
}

/* CHAT右侧内容区域 */
.chat-right-container {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

/* CHAT区域主体 */
.chat-main {
  flex: 1 1 auto;
  overflow: hidden;
  padding: 0;
  display: flex;
  flex-direction: row;
}

/* Subagent 抽屉容器 */
.subagent-drawer-wrapper {
  display: flex;
  flex-direction: row;
  height: 100%;
  position: relative;
}

/* Subagent 处理过程显示区域 */
.subagent-process-panel {
  flex: 0 0 auto;
  width: 213px;
  min-width: 187px;
  max-width: 267px;
  height: 100%;
  border-right: 1px solid var(--border-color);
  background: linear-gradient(180deg, #faf9f6 0%, #f5f4f0 100%);
  overflow: hidden;
  transition: width 0.3s ease;
}

/* 抽屉切换按钮 */
.subagent-drawer-toggle {
  position: absolute;
  left: 100%;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 48px;
  background: linear-gradient(180deg, #faf9f6 0%, #f5f4f0 100%);
  border: 1px solid var(--border-color);
  border-left: none;
  border-radius: 0 6px 6px 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: all 0.2s ease;
  z-index: 10;
  box-shadow: 2px 0 4px rgba(0, 0, 0, 0.05);
}

.subagent-drawer-toggle:hover {
  background: linear-gradient(180deg, #f5f4f0 0%, #ebe9e4 100%);
  color: var(--text-primary);
  box-shadow: 2px 0 6px rgba(0, 0, 0, 0.1);
}

.subagent-drawer-toggle.drawer-open {
  left: 100%;
}

.subagent-drawer-toggle:not(.drawer-open) {
  left: 0;
  border-left: 1px solid var(--border-color);
  border-radius: 0 6px 6px 0;
  box-shadow: 2px 0 4px rgba(0, 0, 0, 0.1);
}

/* 聊天界面面板 */
.chat-area-panel {
  flex: 1 1 auto;
  height: 100%;
  overflow: hidden;
  min-width: 0; /* 允许 flex item 收缩 */
}

/* 边界工具栏 */
.boundary-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: var(--spacing-3);
  padding: var(--spacing-2) var(--spacing-3);
}

.toolbar-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: var(--radius-md);
  background-color: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.toolbar-icon:hover {
  background-color: var(--background-secondary);
  color: var(--primary-color);
}

.toolbar-icon svg {
  display: block;
  width: 18px;
  height: 18px;
}

/* 固定任务列表区域 */
.fixed-task-list {
  flex: 0 0 auto;
  padding: var(--spacing-2) var(--spacing-3);
  padding-bottom: 0;
  background-color: #fdfdfb;
  border-top: 1px solid var(--border-color);
  max-height: 200px;
  overflow-y: auto;
}

/* CHAT区域底部 - 减少留白，让输入框向四周扩展 */
.chat-footer {
  flex: 0 0 auto;
  padding: var(--spacing-2) var(--spacing-3);
  border-top: 1px solid var(--border-color);
  background-color: #fdfdfb; /* 护眼暖白色 */
  display: flex;
  flex-direction: column;
  align-items: center; /* 输入框列居中，与消息列同宽 */
}

/* 输入框与消息列同宽（~768px 居中） */
/* InputArea 为多根组件，父级 scopeId 落不到其根上，须用 :deep 穿透 */
.chat-footer :deep(.input-container) {
  width: 100%;
  max-width: 768px;
}

/* 空会话（新建/未开聊）：输入框单独垂直居中——
   消息区隐藏，上/下自动边距平分剩余空间；无分割线无底色的纯净悬浮；
   开聊后（hasMessages=true）类移除，自动回到"消息流 + 底部输入"常规布局 */
.chat-right-container.chat-empty .chat-main {
  display: none;
}

.chat-right-container.chat-empty .chat-footer {
  margin-top: auto;
  margin-bottom: auto;
  border-top: none;
  background-color: transparent;
}

/* ☰ 工作区面板开关 */
.workspace-panel-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-md);
  background-color: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.workspace-panel-toggle:hover {
  background-color: var(--background-secondary);
  color: var(--primary-color);
}

.workspace-panel-toggle.panel-open {
  color: var(--primary-color);
  background-color: var(--background-secondary);
}

.workspace-panel-toggle:active {
  transform: scale(0.95);
}

.workspace-panel-toggle svg {
  display: block;
}

/* 设置区域容器（全屏覆盖层，淡入淡出；低于全局对话框层 10000+） */
.settings-section {
  position: fixed;
  inset: 0;
  background-color: #ffffff; /* 纯白色背景 */
  box-shadow: var(--shadow-lg);
  opacity: 0;
  visibility: hidden;
  transition: opacity var(--transition-normal), visibility var(--transition-normal);
  z-index: 2000; /* 页面布局层最高，确保设置区域盖住聊天/面板内容 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 设置区域显示状态 */
.settings-section.settings-visible {
  opacity: 1;
  visibility: visible;
}

/* 响应式布局 */
@media (max-width: 768px) {
  .chat-header {
    padding: var(--spacing-3) var(--spacing-4);
  }

  .chat-main {
    padding: var(--spacing-3) var(--spacing-4);
  }

  .chat-footer {
    padding: var(--spacing-2) var(--spacing-3);
  }
}

@media (max-width: 480px) {
  .chat-header {
    padding: var(--spacing-2) var(--spacing-3);
  }

  .chat-main {
    padding: var(--spacing-2) var(--spacing-3);
  }

  .chat-footer {
    padding: var(--spacing-2) var(--spacing-3);
  }
}

/* MCP下拉列表样式 */
.mcp-dropdown {
  position: absolute;
  background: rgba(255, 255, 255, 0.25);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 12px;
  overflow-y: auto;
  z-index: 10000;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08);
}

.dropdown-empty {
  padding: 12px;
  text-align: center;
  color: var(--vscode-descriptionForeground, #4b5563);
  font-size: 13px;
}

.dropdown-item {
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  transition: background-color 0.15s ease;
}

.dropdown-item:last-child {
  border-bottom: none;
}

.dropdown-item:hover {
  background-color: rgba(255, 255, 255, 0.4);
}

.item-name {
  font-weight: 500;
  font-size: 13px;
  color: var(--vscode-foreground, #1f2937);
  margin-bottom: 2px;
}

.item-description {
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #4b5563);
  margin-bottom: 2px;
  line-height: 1.3;
}

.item-description.needs-tooltip {
  cursor: help;
}

.item-uri {
  font-size: 11px;
  color: var(--vscode-charts-blue, #3b82f6);
  font-weight: 500;
  margin-bottom: 2px;
}

/* 滚动条样式 */
.mcp-dropdown::-webkit-scrollbar {
  width: 6px;
}

.mcp-dropdown::-webkit-scrollbar-track {
  background: var(--vscode-editor-background);
}

.mcp-dropdown::-webkit-scrollbar-thumb {
  background-color: var(--vscode-scrollbarSlider-background);
  border-radius: 3px;
}

.mcp-dropdown::-webkit-scrollbar-thumb:hover {
  background-color: var(--vscode-scrollbarSlider-hoverBackground, #c5c5c5);
}

/* 自定义Tooltip样式 */
.custom-tooltip {
  position: fixed;
  z-index: 9999;
  max-width: 400px;
  max-height: 300px;
  padding: 8px 12px;
  background-color: var(--vscode-tooltip-background, #252526);
  color: var(--vscode-tooltip-foreground, #cccccc);
  border: 1px solid var(--vscode-tooltip-border, #454545);
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.4;
  word-wrap: break-word;
  white-space: pre-wrap;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  pointer-events: auto;
  overflow-y: auto;
}

.custom-tooltip::-webkit-scrollbar {
  width: 6px;
}

.custom-tooltip::-webkit-scrollbar-track {
  background: var(--vscode-editor-background, #1e1e1e);
}

.custom-tooltip::-webkit-scrollbar-thumb {
  background-color: var(--vscode-scrollbarSlider-background, #424242);
  border-radius: 3px;
}

.custom-tooltip::-webkit-scrollbar-thumb:hover {
  background-color: var(--vscode-scrollbarSlider-hoverBackground, #555555);
}

/* 搜索框样式 */
.dropdown-search {
  position: sticky;
  bottom: 0;
  padding: 8px 12px;
  background: inherit;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(4px);
}

.search-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 6px;
  font-size: 13px;
  background: rgba(255, 255, 255, 0.5);
  color: var(--vscode-foreground, #1f2937);
  outline: none;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.search-input::placeholder {
  color: var(--vscode-descriptionForeground, #9ca3af);
}

.search-input:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
  background: rgba(255, 255, 255, 0.8);
}

/* 服务器分组样式 - 树形结构 */
.server-group {
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.server-group:last-child {
  border-bottom: none;
}

.server-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  user-select: none;
}

.server-header:hover {
  background-color: rgba(255, 255, 255, 0.5);
}

.server-header .expand-icon {
  margin-right: 8px;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.server-header.is-expanded .expand-icon {
  transform: rotate(90deg);
}

.server-header .server-name {
  font-weight: 600;
  font-size: 12px;
  color: var(--vscode-foreground, #1f2937);
  flex: 1;
}

.server-header .server-count {
  font-size: 10px;
  color: var(--vscode-descriptionForeground, #6b7280);
  background-color: rgba(0, 0, 0, 0.06);
  padding: 2px 6px;
  border-radius: 10px;
  margin-left: 8px;
}

.server-items {
  border-top: 1px solid rgba(0, 0, 0, 0.04);
}

.server-items .dropdown-item {
  padding-left: 28px;
}
</style>