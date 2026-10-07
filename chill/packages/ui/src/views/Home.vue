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
        @open-agent-factory="handleOpenAgentFactoryFromSettings"
      />
    </div>

    <!-- 工作区面板（最左列，可拖宽/吸附收起；v-show 保活，内部自持久化宽度与收起状态） -->
    <WorkspacePanel
      ref="workspacePanelRef"
      v-model:visible="workspacePanelVisible"
      :current-session-id="currentConversationId"
      :running-session-ids="runningSessionIds"
      @open-settings="toggleSettingsVisibility"
      @open-work-object="handleOpenWorkObject"
      @new-conversation="createNewConversation"
      @open-session="loadConversationById"
      @session-deleted="handleSessionDeleted"
    />

    <!-- 工作对象视窗（ContentDock：单容器多类型页签，流内段位于工作区面板与聊天区之间；窄窗口降级覆盖模式） -->
    <ContentDock ref="contentDockRef" :overlay="dockOverlay" :badges="dockBadges" :max-width="dockMaxWidth" />

    <!-- CHAT区域整体（常驻，flex:1 占满剩余宽度） -->
    <div ref="chatSectionRef" class="chat-section">
      
      <!-- CHAT区域布局容器 -->
      <div class="chat-layout-container">
        <!-- CHAT右侧内容区域（chat-empty：新建会话/未开聊时输入框组垂直居中） -->
        <div class="chat-right-container" :class="{ 'chat-empty': isChatEmpty }">
          <!-- CHAT区域头部 -->
          <div class="chat-header">
            <!-- 左侧：☰ 工作区面板开关 + 会话归属标题 -->
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
              <!-- 会话归属区：未分组/待落盘 = 项目选择器药丸（可选中/改选）；
                   已归属会话 = 静态"项目名/会话名"。
                   位置随会话状态分流：空会话（未开聊）药丸在输入框左上（chat-footer），
                   开聊/加载后回到 chat-header（此处）——空会话时头部位置悬在整屏左上角、离用户操作区太远 -->
              <ProjectSelector v-if="!isGroupedSession && !isChatEmpty" />
              <span v-else-if="isGroupedSession && sessionContextTitle" class="session-context-title" :title="sessionContextTitle">{{ sessionContextTitle }}</span>
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
      
      <!-- CHAT区域底部 -->
      <div class="chat-footer">
        <!-- 输入框左上药丸行（与输入列同宽左对齐）：任务进度药丸（有任务时）+ "运行"药丸（有运行态时）+ 空会话归属药丸 -->
        <div v-if="taskListStore.hasTasks || runtimePillStore.hasRuntime || (!isGroupedSession && isChatEmpty) || proposalsStore.hasContent()" class="footer-pill-row">
          <TaskListDisplay v-if="taskListStore.hasTasks" />
          <RuntimePill v-if="runtimePillStore.hasRuntime" />
          <ImprovementsPill v-if="proposalsStore.hasContent()" @decide="openSettingsWithTab('improvements')" />
          <ProjectSelector v-if="!isGroupedSession && isChatEmpty" />
        </div>
        <InputArea
          @send="handleSendMessage"
          @model-selected="handleModelSelected"
          :is-streaming="isStreaming"
          :has-history="!isChatEmpty"
          @stop="stopStreaming"
        />
      </div>
        </div> <!-- 结束 chat-right-container -->

        <!-- Agent 执行过程右侧面板(迭代 2;点药丸"过程 ›"滑出;窄窗转 overlay 覆盖模式) -->
        <AgentProcessPanel
          v-if="runtimePillStore.selectedTaskId"
          :overlay="processPanelOverlay"
          @close="runtimePillStore.closeProcessPanel()"
        />
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

  <!-- Agent 编辑器覆盖层（ModeSelector 使用现场入口：新建/编辑单 Agent 模板） -->
  <Teleport to="body">
    <div v-if="agentEditorOpen" class="template-editor-overlay" @click.self="agentEditorOpen = false">
      <div class="template-editor-panel">
        <div class="template-editor-head">
          <button class="settings-btn" @click="agentEditorOpen = false">← 返回</button>
          <span class="template-editor-title">{{ agentEditorMode === 'edit' ? '编辑 Agent' : '新建 Agent' }}</span>
        </div>
        <AgentEditor
          :key="agentEditorKey"
          :mode="agentEditorMode"
          :initial-template="agentEditorTemplate"
          :existing-slugs="agentEditorSlugMap"
          :work-dir="getEngineWorkDir()"
          @save="handleAgentEditorSave"
          @cancel="agentEditorOpen = false"
          @fork="handleAgentEditorFork"
        />
      </div>
    </div>
  </Teleport>

  <!-- 组队编辑器覆盖层(UI 三层显示统一 · 迭代 3;设置资产中心入口,与 AgentEditor 同款) -->
  <Teleport to="body">
    <div v-if="teamEditorOpen" class="template-editor-overlay" @click.self="teamEditorOpen = false">
      <div class="template-editor-panel">
        <div class="template-editor-head">
          <button class="settings-btn" @click="teamEditorOpen = false">← 返回</button>
          <span class="template-editor-title">{{ teamEditorMode === 'edit' ? '编辑团队' : '新建团队' }}</span>
        </div>
        <TeamEditor
          :key="teamEditorKey"
          :mode="teamEditorMode"
          :initial-team="teamEditorTemplate"
          @save="handleTeamEditorSave"
          @cancel="teamEditorOpen = false"
        />
      </div>
    </div>
  </Teleport>

  <!-- 闪念捕获条（Ctrl+I 呼出 · managed 门控：npm 模式不绑定不渲染——入口不存在而非禁用） -->
  <Teleport to="body">
    <div v-if="ideaBarOpen && managedFlag" class="idea-cap-bar">
      <span class="ico">💡</span>
      <input
        ref="ideaBarInputRef"
        v-model="ideaBarText"
        class="ipt"
        placeholder="记个点子…（回车入账，改进提案「闪念」簇）"
        @keydown.enter="submitIdeaBar"
        @keydown.esc="ideaBarOpen = false"
      >
      <span class="kbd">⏎ 入账</span>
      <span class="kbd link" @click="ideaBarOpen = false">Esc 取消</span>
      <span v-if="ideaBarNote" class="note">{{ ideaBarNote }}</span>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, reactive, watch } from 'vue'
import ChatArea from '../components/ChatArea.vue'
import InputArea from '../components/InputArea.vue'
import { getHostAPI, tryGetHostAPI } from '../host/hostApi'
import ProjectSelector from '../components/ProjectSelector.vue'
import WorkspacePanel from '../components/WorkspacePanel.vue'
import ContentDock from '../components/ContentDock.vue'
import ModelSettings from './ModelSettings.vue'
import ResourceDetailDialog from '../components/ResourceDetailDialog.vue'
import TaskListDisplay from '../components/TaskListDisplay.vue'
import RuntimePill from '../components/RuntimePill.vue'
import ImprovementsPill from '../components/ImprovementsPill.vue'
import AgentProcessPanel from '../components/AgentProcessPanel.vue'
import AgentEditor from '../components/agentEditor/AgentEditor.vue'
import { saveTemplateFile, deleteTemplateFile } from '../services/templateSaver'
import { getEngineWorkDir } from '../services/chatEngine'
import { useTaskListStore } from '../stores/taskListStore'
import { useRuntimePillStore } from '../stores/runtimePillStore'
import { useProposalsStore } from '../stores/proposalsStore'
import { usePlanModeStore } from '../stores/planModeStore'
import { managedFlag } from '../services/managedFlag'
import { modelServiceFactory, MessageRole, eventBus, EVENTS, buildContentParts, INJECTOR_ORDER, parseAgentMentions, parseBareAgentMention, getTemplateManager, SecureStorageService, toSessionSummary, abortAndSealTurn } from '@assistant-ai/core'
import type { ContentPart, Message, ModelInfo, MediaFileDescriptor, VideoStorageProvider, SessionRecord, ContextInjector, ChatEngineInput, SubagentTemplate, TeamDefinition } from '@assistant-ai/core'
import TeamEditor from '../components/teamEditor/TeamEditor.vue'
import { initTeamAssetService, listTeamAssets, OPEN_TEAM_EDITOR_EVENT } from '../services/teamAssetService'
import { saveTeamFile, deleteTeamFile } from '../services/teamSaver'
import { useMCPStore } from '../stores/mcpStore'

import { getMCPClient } from '@assistant-ai/ui/adapters'
import { promptMode } from '../stores/promptMode'
import type { DiffOperation } from '../extensions/DiffPreviewExtension'
import { usePendingOperationsStore } from '../stores/pendingOperationsStore'
import { useWorkObjectStore } from '../stores/workObjectStore'
import { classifyFileType } from '../utils/workObjectFileType'
import { UI_EVENTS } from '../utils/toolDisplay'
import { collectFileOperations, diffCounts, normalizeFilePath } from '../utils/lightDiff'
import { useWritingViewStore } from '../stores/writingViewStore'
import { useFileTreeStore } from '../stores/fileTreeStore'
import { useProjectStore } from '../stores/projectStore'
import { useContextStatusStore } from '../stores/contextStatusStore'
import { loadSessionSummaries, loadSession, deleteSession } from '@assistant-ai/ui/adapters'
import { compactionVersion } from '../composables/useCompact'
import { getChatEngine, syncFrontAgentFromEngine, setEngineWorkDir, setFrontAgent, openSession, switchSession, isSessionOpen, closeSession, setOnEngineOpen, getActiveSessionId, isForActiveSession, getRunningSessionIds } from '../services/chatEngine'
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
const firstRunKv = tryGetHostAPI()?.getKeyValue ? new IPCKeyValueStore() : null
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

const handleWindowResize = () => { updateDockOverlay(); updateProcessPanelOverlay() }

watch([workspacePanelVisible, () => contentDockRef.value?.open, () => contentDockRef.value?.width], updateDockOverlay)

// 执行过程面板窄窗降级(同款滞回先例):可用宽不足以同时容纳面板(400px)与聊天最小可读宽时转覆盖模式
const processPanelOverlay = ref(false)
const PROCESS_PANEL_WIDTH = 400
const updateProcessPanelOverlay = () => {
  if (!runtimePillStore.selectedTaskId) {
    processPanelOverlay.value = false
    return
  }
  const dock = contentDockRef.value
  const dockWidth = dock?.open ? (dock.width ?? 0) : 0
  const panelWidth = workspacePanelVisible.value ? (workspacePanelRef.value?.width ?? 0) : 0
  const available = window.innerWidth - dockWidth - panelWidth - PROCESS_PANEL_WIDTH
  if (processPanelOverlay.value) {
    processPanelOverlay.value = available <= DOCK_OVERLAY_EXIT_WIDTH
  } else {
    processPanelOverlay.value = available < CHAT_MIN_READABLE_WIDTH
  }
}

// "运行"药丸 store（运行态唯一观测点；进程任务列表与 SUBAGENT_* 订阅已迁入 store，
// 取消能力(executeCancelTask/cancelAllRunningTasks)平移至 RuntimePill 组件，两步确认保留）
// [tdz-fix] 声明上移到 L563 的 watch 之前：watch 创建时 getter 立即求值，
// 原声明位置（mcpStore 等之后）晚于求值点 → TDZ ReferenceError（Web/新构建桌面均触发）
const runtimePillStore = useRuntimePillStore()

watch([workspacePanelVisible, () => contentDockRef.value?.open, () => contentDockRef.value?.width, () => runtimePillStore.selectedTaskId], updateProcessPanelOverlay)

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

// 改进提案账本（决策闭环迭代 3）：药丸观测 + 设置面板管理；ask 挂起未聚焦时闪烁提醒（flashFrame 复用）
const proposalsStore = useProposalsStore()
const planModeStoreForAsk = usePlanModeStore()
watch(
  () => planModeStoreForAsk.askVisible,
  (visible) => {
    if (visible && document.hidden) void tryGetHostAPI()?.notifyTurnCompleted?.()
  },
)
void proposalsStore.refresh()

// 闪念捕获条（Ctrl+I · 迭代 1）：managed 门控（npm 模式不绑定）；输入框聚焦时不抢按键
const ideaBarOpen = ref(false)
const ideaBarText = ref('')
const ideaBarNote = ref('')
const ideaBarInputRef = ref<HTMLInputElement | null>(null)
const submitIdeaBar = async () => {
  const text = ideaBarText.value.trim()
  if (!text) return
  const r = await proposalsStore.capture(text, 'GUI Ctrl+I')
  ideaBarText.value = ''
  if (!r.ok) {
    ideaBarNote.value = `✗ ${r.error ?? '写入失败'}`
  } else if (r.duplicated) {
    ideaBarNote.value = '⚠ 10 秒内已记录过相同点子'
  } else {
    ideaBarNote.value = `✓ 已记入「闪念」簇${r.truncated ? '（超长已截断）' : ''} · 待确认 ${proposalsStore.digest?.pending ?? ''} 条`
    setTimeout(() => { ideaBarOpen.value = false; ideaBarNote.value = '' }, 1200)
  }
}
const onIdeaKeydown = (e: KeyboardEvent) => {
  if (e.ctrlKey && (e.key === 'i' || e.key === 'I')) {
    if (!managedFlag.value) return // npm 模式：快捷键静默无效（入口不存在）
    const t = e.target as HTMLElement | null
    if (t && ['INPUT', 'TEXTAREA'].includes(t.tagName)) return // 正在输入框打字时不抢
    e.preventDefault()
    ideaBarOpen.value = !ideaBarOpen.value
    ideaBarNote.value = ''
    if (ideaBarOpen.value) nextTick(() => ideaBarInputRef.value?.focus())
  } else if (e.key === 'Escape' && ideaBarOpen.value) {
    ideaBarOpen.value = false
  }
}
onMounted(() => document.addEventListener('keydown', onIdeaKeydown))
onUnmounted(() => document.removeEventListener('keydown', onIdeaKeydown))

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

// 停止流式请求（引擎 abort：中断轮封口留痕——已完成步骤保留、被中断调用补标记，视图经 refillViewFromEngine 对齐）
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

// ==================== Agent 编辑器覆盖层（ModeSelector 使用现场入口） ====================

const agentEditorOpen = ref(false)
const agentEditorMode = ref<'create' | 'edit'>('create')
const agentEditorTemplate = ref<SubagentTemplate | undefined>(undefined)
const agentEditorKey = ref(0)

/** 覆盖提示数据源：slug → 级别文案（内置/个人/项目） */
const agentEditorSlugMap = computed(() => {
  const map: Record<string, string> = {}
  try {
    for (const t of getTemplateManager().getAllTemplates()) {
      const type = (t.type as string | undefined) ?? 'builtin'
      if (type !== 'builtin' && type !== 'custom') continue
      map[t.subagent_type] = type === 'builtin' ? '内置级' : t.priority_scope === 'project' ? '项目级' : '个人级'
    }
  } catch { /* 模板管理器未就绪时无提示 */ }
  return map
})

/** 打开编辑器：空载荷=新建；带 slug=编辑该模板（内置只读由组件内另存为承接） */
const openAgentEditorOverlay = (payload?: { slug?: string }) => {
  if (payload?.slug) {
    const t = getTemplateManager().getTemplateByType(payload.slug)
    if (t) {
      agentEditorTemplate.value = t
      agentEditorMode.value = 'edit'
    } else {
      agentEditorTemplate.value = undefined
      agentEditorMode.value = 'create'
    }
  } else {
    agentEditorTemplate.value = undefined
    agentEditorMode.value = 'create'
  }
  agentEditorKey.value++
  agentEditorOpen.value = true
}

const handleAgentEditorSave = async (payload: { slug: string; storage: 'user' | 'project'; content: string; renameFrom?: string }) => {
  await saveTemplateFile(payload)
  if (payload.renameFrom) {
    const old = agentEditorTemplate.value
    if (old?.sourcePath) {
      const level = ((old.type as string | undefined) ?? 'builtin') === 'builtin' ? 'user' : (old.priority_scope === 'project' ? 'project' : 'user')
      await deleteTemplateFile(old.sourcePath, level)
    }
  }
  agentEditorOpen.value = false
}

/** 内置只读 → 另存为：新建模式预填（标识默认同名，语义 = 覆盖内置） */
const handleAgentEditorFork = () => {
  if (!agentEditorTemplate.value) return
  agentEditorMode.value = 'create'
  agentEditorKey.value++
}

// ==================== 组队编辑器覆盖层(UI 三层显示统一 · 迭代 3;自 WorkflowView 迁入,保存链路随迁) ====================

const teamEditorOpen = ref(false)
const teamEditorMode = ref<'create' | 'edit'>('create')
const teamEditorTemplate = ref<TeamDefinition | undefined>(undefined)
const teamEditorKey = ref(0)

/** 打开组队编辑器:空载荷=新建;带 slug=编辑该团队(OPEN_TEAM_EDITOR_EVENT,仿 OPEN_AGENT_EDITOR) */
const openTeamEditorOverlay = async (payload?: { slug?: string }) => {
  await initTeamAssetService().catch(() => {}) // 幂等;资产服务未就绪时兜底
  if (payload?.slug) {
    const t = listTeamAssets().find((x) => x.name === payload.slug)
    teamEditorTemplate.value = t
    teamEditorMode.value = t ? 'edit' : 'create'
  } else {
    teamEditorTemplate.value = undefined
    teamEditorMode.value = 'create'
  }
  teamEditorKey.value++
  teamEditorOpen.value = true
}

/** 团队保存(自 WorkflowView 原样迁移:保存 + rename 时删旧文件;失败保持编辑器打开可重试) */
const handleTeamEditorSave = async (payload: { slug: string; storage: 'user' | 'project'; content: string; renameFrom?: string }): Promise<void> => {
  try {
    await saveTeamFile(payload)
    if (payload.renameFrom && teamEditorTemplate.value?.sourcePath) {
      await deleteTeamFile(teamEditorTemplate.value.sourcePath)
    }
    teamEditorOpen.value = false
  } catch (error) {
    console.warn('团队保存失败:', error)
  }
}

// ◐「工作对象」菜单：打开 dock 并切到指定类型页签
const handleOpenWorkObject = (type: string) => {
  contentDockRef.value?.openDock(type)
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

  // 监听文件变化（dock 内写作编辑器可见时同步刷新文件树；轻量视图无文件树，跳过）。
  // 懒加载刷新链：watch 集合制（根+已展开目录，各 depth 0）下事件即某被 watch 目录的直接子项——
  // 仅结构性事件（add/addDir/unlink/unlinkDir）失效重取对应层；'change' 内容变更不影响树结构，不处理
  getHostAPI().onFileChanged((data: { eventName: string; filePath: string }) => {
    const editor = contentDockRef.value?.isTypeActive('document')
      ? contentDockRef.value?.getActiveEditorRef()
      : null
    if (!editor?.getCurrentDirectory) return
    if (!['add', 'addDir', 'unlink', 'unlinkDir'].includes(data.eventName)) return
    const fileTreeStore = useFileTreeStore()
    const parentDir = data.filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    void fileTreeStore.invalidate(parentDir)
    // 目录删除：连带死路径级联清理（子树层缓存/展开状态/watch 集合）
    if (data.eventName === 'unlinkDir') {
      fileTreeStore.prunePath(data.filePath)
    }
  })
  
  // 监听打开设置事件
  eventBus.on(EVENTS.OPEN_SETTINGS, openSettingsWithTab)

  // 监听打开 Agent 编辑器事件（ModeSelector 使用现场入口：新建/编辑模板）
  eventBus.on(EVENTS.OPEN_AGENT_EDITOR, openAgentEditorOverlay)

  // 监听打开组队编辑器事件(设置资产中心入口:UI 壳内事件,仿 OPEN_AGENT_EDITOR)
  eventBus.on(OPEN_TEAM_EDITOR_EVENT, openTeamEditorOverlay)

  // 监听编辑器同步打开文件事件
  eventBus.on(EVENTS.EDITOR_SYNC_OPEN_FILE, handleEditorSyncOpenFile)

  // 监听差异预览事件
  eventBus.on(EVENTS.TOOL_CALL_STATUS_CHANGED, handleToolCallStatusChanged)

  // 监听差异预览清理事件
  eventBus.on(EVENTS.DIFF_PREVIEW_CLEAR, handleDiffPreviewClear)

  // 监听工具行文件对象点击事件（工具调用显示约定：ToolLineDisplay 经 UI 事件寻址 dock，零直接耦合）
  eventBus.on(UI_EVENTS.OPEN_FILE_IN_DOCK, handleOpenFileInDock)

  // "运行"药丸：团队服务装配晚于 store 创建时兜底绑定（幂等；SUBAGENT_* 订阅在 store 内建立）
  runtimePillStore.bindTeam()

  // dock 窄窗口降级：窗口尺寸变化时重判覆盖模式
  window.addEventListener('resize', handleWindowResize)
  nextTick(updateDockOverlay)

  // 注册 UI 专属注入器（3.4：逐引擎装配——setOnEngineOpen 挂工厂，openSession/create 出生即注册；
  // 注入条件在注入器内部判定；closeSession 出口按 id 注销）
  setOnEngineOpen((engine) => engine.registerContextInjector(writingModuleInjector))

  // 会话机制：CLI/UI 共享 ~/.chill/sessions 一套会话记录。
  // 跨端同步：对端（CLI）写入当前会话时自动回填消息区（自身写入已被过滤，不自闪）
  tryGetHostAPI()?.onSessionChanged?.(handleSessionChanged)
  // 注意力边界刷新：窗口重新聚焦时全量保新会话列表（对端改动非当前会话无 watch 事件，
  // 面板展开刷新之外的另一闭合点；无变化时走索引零 parse，廉价）
  tryGetHostAPI()?.onWindowFocused?.(() => {
    void projectStore.loadSessions()
  })

  // 启动恢复（handoff 三值契约）：'<id>'=CLI /ui 接力该会话（未命中保持空会话）；
  // ''=接力但 CLI 尚无落盘会话 → 全新空会话（不回退历史最新）；null=直接启动 → 恢复"updatedAt 最新者"；
  // 无历史会话时保持全新引擎会话（首次落盘由引擎生成 id）
  void (async () => {
    try {
      const handoffId = tryGetHostAPI()?.sessionGetHandoffId
        ? await getHostAPI().sessionGetHandoffId().catch(() => null)
        : null
      if (handoffId === '') return
      const records = await loadSessionSummaries()
      if (records.length === 0) return
      const target = handoffId ? records.find(r => r.id === handoffId) : records[0]
      if (target) loadConversationById(target.id)
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

// 工具行文件对象点击 → dock 打开该文件（openDock('document') 复用工作对象菜单同款路径；
// 不在 tabs/pending 中的文件由 DocumentLightView 自行补充进列表）
const handleOpenFileInDock = ({ path }: { path: string }) => {
  const dock = contentDockRef.value
  if (!dock || !path) return
  dock.openDock('document')
  void dock.waitActiveEditor().then((editor: any) => {
    editor?.openFileWithDiff?.(path, [])
  })
}

// 组件卸载时清理事件监听
onUnmounted(() => {
  // 取消正在进行的流式请求（引擎每轮结束已落盘，无需卸载时再保存）
  stopStreaming()

  eventBus.off(EVENTS.MCP_CONNECTION_CHANGED, checkMCPConnections)
  eventBus.off(EVENTS.MCP_CONNECTION_CHANGED, loadMCPData)
  eventBus.off(EVENTS.OPEN_SETTINGS, openSettingsWithTab)
  eventBus.off(EVENTS.OPEN_AGENT_EDITOR, openAgentEditorOverlay)
  eventBus.off(OPEN_TEAM_EDITOR_EVENT, openTeamEditorOverlay)
  eventBus.off(EVENTS.EDITOR_SYNC_OPEN_FILE, handleEditorSyncOpenFile)
  eventBus.off(EVENTS.TOOL_CALL_STATUS_CHANGED, handleToolCallStatusChanged)
  eventBus.off(EVENTS.DIFF_PREVIEW_CLEAR, handleDiffPreviewClear)
  eventBus.off(UI_EVENTS.OPEN_FILE_IN_DOCK, handleOpenFileInDock)
  window.removeEventListener('resize', handleWindowResize)
  // 3.4：注入器工厂解除（引擎本体随 registry.close/退出收口，这里只摘工厂钩子）
  setOnEngineOpen(null)
  eventBus.off(EVENTS.TURN_STREAM_CHUNK, onActiveStreamChunk)
  eventBus.off(EVENTS.TURN_SETTLED, onActiveTurnSettled)
  
  // 清理定时器
  if (toolsHideTimer.value) clearTimeout(toolsHideTimer.value)
  if (resourcesHideTimer.value) clearTimeout(resourcesHideTimer.value)
  if (promptsHideTimer.value) clearTimeout(promptsHideTimer.value)

  // 清理文件监听
  getHostAPI().removeFileChangedListener()
  getHostAPI().fileWatchStop()
  // 清理会话跨端同步监听
  tryGetHostAPI()?.removeAllListeners?.('session:changed')
  tryGetHostAPI()?.removeAllListeners?.('window:focused')
})

// 创建新对话（3.3：registry.open() 新会话 + 切 active + 空视图——旧会话引擎留 registry 后台续跑）
const createNewConversation = () => {
  if (!chatAreaRef.value) return

  void (async () => {
  // 3.3：registry 新会话（registry.create 同步铸 id），无旧引擎 startNewSession 护栏——不打扰运行中的会话
  try {
    await openSession()
    // 上下文占用环同步：lastUsage 已重置 → 环隐藏（状态源归引擎，此处仅现读转发）
    useContextStatusStore().syncFromEngine()
  } catch (error) {
    chatAreaRef.value.addMessage({
      role: MessageRole.ASSISTANT,
      content: `无法新建对话：${error instanceof Error ? error.message : '未知错误'}`,
      timestamp: new Date()
    })
    return
  }
  syncConversationRefs()

  // 3.10：出生意向按会话 id 登记/消费（意向 map 以会话 id 为键——新 id 天然无残留，旧全局单值"新建即清"退役）
  // projectStore.setPendingProject(null) 退役：连续新建不再互扰

  // 清空当前对话
  chatAreaRef.value.clearMessages()

  // 清空任务列表
  taskListStore.setTasks((getChatEngine().getSessionState().tasks as never) ?? [])

  // 清空待确认操作
  pendingOperationsStore.clearAll()

  // 3.3：runtimePill 不再清（委派跨会话视图——后台委派结果仍要可见，"新建即清"语义退役）
  useContextStatusStore().syncFromEngine()
  })()
}

/** 从引擎会话状态同步展示用 ref（id；标题等状态的权威值在引擎） */
const syncConversationRefs = () => {
  const state = getChatEngine().getSessionState()
  currentConversationId.value = state.sessionId
  syncFrontAgentFromEngine()
}

/** 当前会话是否已归属（持久化归属，不含出生意向 pending） */
const isGroupedSession = computed(() => {
  const id = projectStore.currentSessionId
  return !!id && !!projectStore.sessionProjectIdOf(id)
})

/** 会话归属标题（chat-header 左上，仅已归属会话显示）："项目名/会话名"，
 *  自动标题生成/会话切换经响应式自动跟随；未分组/待落盘由 ProjectSelector 药丸承担 */
const sessionContextTitle = computed(() => {
  if (!isGroupedSession.value) return null
  const projectId = projectStore.sessionProjectIdOf(projectStore.currentSessionId!)
  const projectName = projectId ? projectStore.projectNameOf(projectId) : null
  if (!projectName) return null
  const sid = projectStore.currentSessionId
  const sessionTitle = sid
    ? projectStore.sessions.find(s => s.id === sid)?.title
    : null
  return `${projectName}/${sessionTitle || '新对话'}`
})

/** 视图对齐引擎权威历史（abort/异常回滚后调用；清空后按引擎历史重填） */
const refillViewFromEngine = () => {
  if (!chatAreaRef.value) return
  chatAreaRef.value.clearMessages()
  for (const message of getChatEngine().getHistory()) {
    chatAreaRef.value.addMessage(message)
  }
}
// —— 引擎发起轮（后台任务回流/定时触发/手机来信）的 UI 呈现 ——
// 4.2：回调式接线退役——流式/合成 user 行/落定全部由 useChatFeed 的被动事件源消费
// （TURN_STREAM_CHUNK + TOOL_*/ASSISTANT_*/USER_MESSAGE_CREATED + TURN_SETTLED，按 active 过滤），
// setExternalOutputHandler 特例块与防抖重填一并删除；切会话/换绑视图统一走 rebindViewToActive。
/**
 * 换绑视图到活跃引擎（3.2/3.3/3.4 切换语义统一出口）：
 * 消息区按引擎权威历史重填 + taskList 从活跃引擎 tasks 重填 + 展示 ref 同步。
 */
const rebindViewToActive = () => {
  refillViewFromEngine()
  taskListStore.setTasks((getChatEngine().getSessionState().tasks as never) ?? [])
  useContextStatusStore().syncFromEngine()
  syncConversationRefs()
}

// 压缩完成（useCompact 的 compactionVersion 自增驱动）：压缩不产生新消息，显式带动「已压缩」标记条刷新
watch(compactionVersion, () => {
  chatAreaRef.value?.refreshCompactions()
})

// 加载历史对话
/**
 * 回填会话记录到消息区/任务/标题展示（loadConversationById 与跨端同步回填共用）。
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

/**
 * 按 id 加载会话（面板点击/搜索结果/启动恢复统一入口）：
 * 3.2：目标已在 registry → 仅切 active + 视图重填（**不**对运行中引擎调 loadSession——后台续跑）；
 * 未加载 → adapter 直读（幽灵自清判定）→ registry.open(id) → 切 active + 重填。
 */
const loadConversationById = (id: string) => {
  if (!chatAreaRef.value) return

  void (async () => {
    // 已在 registry：仅换绑视图（引擎不动——运行中会话切走后台续跑，切回无缝）
    if (isSessionOpen(id)) {
      switchSession(id)
      rebindViewToActive()
      return
    }
    const result = await loadSession(id)
    // 幽灵条目自清：文件已被对端删除（success 但 record 为 null）→ 列表顺手移除该条目，
    // 不切换会话；IO 类失败（!success）不删（可能是临时故障，误删条目反而丢显示）
    if (result.success && !result.record) {
      projectStore.removeSession(id)
      chatAreaRef.value?.addMessage({
        role: MessageRole.ASSISTANT,
        content: '该会话已被删除（可能由另一端操作），已从列表移除',
        timestamp: new Date()
      })
      return
    }
    if (!result.success || !result.record) {
      chatAreaRef.value?.addMessage({
        role: MessageRole.ASSISTANT,
        content: `读取会话记录失败：${result.error || '会话记录不存在'}`,
        timestamp: new Date()
      })
      return
    }
    const record = result.record
    // 未加载 → registry.open(id)（新引擎 + loadSession 到该引擎）→ 切 active
    const engine = await openSession(id)
    if (!engine) {
      chatAreaRef.value?.addMessage({
        role: MessageRole.ASSISTANT,
        content: '会话记录不存在',
        timestamp: new Date()
      })
      return
    }
    // 上下文占用环同步：恢复记录的 lastUsage 进展示态（启动恢复/点击切换同走此路径）
    useContextStatusStore().syncFromEngine()
    refillFromRecord(record)
    syncConversationRefs()
  })()
}

// ========== 会话跨端同步（CLI ↔ UI 共享 ~/.chill/sessions 一套记录） ==========

/** isStreaming 中收到对端变更时暂存的待回填记录（流结束后补做） */
let pendingSessionRefill: SessionRecord | null = null

// 4.3：isStreaming 跟随活跃会话——chunk 到达置真 / TURN_SETTLED 落定置假（按 active 过滤）；
// 切换会话时由 rebindViewToActive 现读引擎 isRunning
const onActiveStreamChunk = (payload: { sessionId?: string }) => {
  if (isForActiveSession(payload?.sessionId)) isStreaming.value = true
}
const onActiveTurnSettled = (payload: { sessionId?: string }) => {
  if (isForActiveSession(payload?.sessionId)) isStreaming.value = false
}
eventBus.on(EVENTS.TURN_STREAM_CHUNK, onActiveStreamChunk)
eventBus.on(EVENTS.TURN_SETTLED, onActiveTurnSettled)

// ========== 运行态标志（会话列表"运行中"旋转环） ==========
// STARTED 入集 / SETTLED 出集（事件自带 sessionId 归因——多引擎含后台会话全覆盖）；
// 订阅先于初值扫描（消除挂载竞态窗口）；Set 整替保响应性。
const runningSessionIds = ref<ReadonlySet<string>>(new Set())
const applyRunningDelta = (sessionId: string | null | undefined, running: boolean): void => {
  if (!sessionId) return
  const next = new Set(runningSessionIds.value)
  if (running) next.add(sessionId)
  else next.delete(sessionId)
  runningSessionIds.value = next
}
eventBus.on(EVENTS.TURN_STARTED, (p: { sessionId?: string }) => applyRunningDelta(p?.sessionId, true))
eventBus.on(EVENTS.TURN_SETTLED, (p: { sessionId?: string }) => applyRunningDelta(p?.sessionId, false))
runningSessionIds.value = getRunningSessionIds()

// 当前会话 id 确立/变化时（启动恢复、createNewConversation、loadConversationById 均经此）
// 通知主进程重定向 watch——同一时刻只 watch 当前会话
watch(currentConversationId, (id) => {
  const host = tryGetHostAPI()
  if (id && host?.sessionWatch) {
    host.sessionWatch(id).catch((err: unknown) => console.warn('会话 watch 重定向失败:', err))
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
      // 懒采纳：无归属且有 workdir 的会话被打开时自动归属/创建项目（项目与工作目录约定 2）
      await projectStore.adoptSessionByWorkdir(id)
      // 3.9：目录联动改读活跃引擎归属——异步间隙可能已切走，只对仍活跃的会话生效（后台引擎目录不动）
      if (getActiveSessionId() !== id) return
      const projectId = projectStore.sessionProjectIdOf(id)
      const folderPath = projectId
        ? projectStore.projects.find(p => p.id === projectId)?.folderPath
        : undefined
      // 绑定项目 folderPath 优先；无项目绑定回退该会话自己的 workDir（record.workdir 钉住值）
      const dir = folderPath || getEngineWorkDir() || undefined
      if (dir) writingViewStore.setCurrentDirectory(dir)
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
  // 会话文件被对端删除：提示一句，不崩溃、不重建空记录——引擎收尾同 handleSessionDeleted
  //（detach 保留历史换新 id / 运行中 close 封口），继续聊天将作为新记录落盘；列表条目同步移除
  if (record === null) {
    const deletedId = currentConversationId.value
    void retireDeletedSession(deletedId)
    if (deletedId) projectStore.removeSession(deletedId)
    chatAreaRef.value?.addMessage({
      role: MessageRole.ASSISTANT,
      content: '（当前会话已被另一端删除，后续聊天将作为新会话保存）',
      timestamp: new Date()
    })
    return
  }
  // 对端变更（标题等）顺手保新列表元数据（record 已在手，零额外 IO）
  projectStore.upsertSessionSummary(toSessionSummary(record))
  if (record.id !== currentConversationId.value) return
  // 3.4：只对活跃且**非 running** 引擎 reload（运行中 reload 会抛护栏/打断在途轮——置脏延后补做）
  if (isStreaming.value || getChatEngine().getSessionState().isRunning) {
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

// 会话删除（WorkspacePanel emit；删除本体已在面板执行一次——此处只做引擎收尾）
const handleSessionDeleted = (id: string) => {
  void retireDeletedSession(id)
}

/**
 * 删除/对端删除会话的引擎收尾（3.4 + 发现 #14）：
 * - 当前对话：先封口（运行中 abort 封口——detach 运行中抛错）→ detach 保留历史换新 id
 *   （继续聊天作为新记录保存，不复活已删记录）；
 * - 后台/无法 detach：registry.close(id) 收口（abort 封口 → endSession → dispose）；
 * - 封口的 seal 落盘会写回已删记录文件 → 补删一次清残留（幂等；UX 级删除仍只在 WorkspacePanel 一处）。
 */
const retireDeletedSession = async (id: string | null) => {
  if (!id) return
  const isCurrent = id === currentConversationId.value
  if (isCurrent) {
    await abortAndSealTurn(getChatEngine())
    try {
      getChatEngine().detachSession()
    } catch {
      // 封口后仍不可 detach（后台任务在途等）→ 交由 close 收口
      await closeSession(id)
    }
    syncConversationRefs()
  } else {
    // 3.4：registry.close(id) 收口后台引擎（删除进行中会话 = 封口，不产生孤儿占位）
    await closeSession(id)
  }
  // 封口落盘残留清理（见上）；失败不打扰
  void deleteSession(id).catch(() => undefined)
}

// 视频存储提供者：经宿主合同保存视频附件
const videoStorageProvider: VideoStorageProvider = {
  save: async (name: string, bytes: Uint8Array): Promise<string> => {
    const host = tryGetHostAPI()
    if (host?.saveAttachment) {
      return await host.saveAttachment(bytes.buffer as ArrayBuffer, name)
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
  const anchorHost = tryGetHostAPI()
  if (currentConversationId.value && anchorHost?.sessionLoadIfNewer) {
    try {
      const anchorResult = await anchorHost.sessionLoadIfNewer(currentConversationId.value)
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

    // 4.2：不再传 streamCallback——流式渲染走 feed 被动事件源（TURN_STREAM_CHUNK 按 active 过滤）
    const result = await getChatEngine().sendMessage(input)

    if (result.aborted) {
      // 中断：引擎已封口本轮历史（已完成步骤与中断标记保留），视图对齐引擎（移除未落史的半截渲染）
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
    // 4.3：isStreaming 跟随活跃会话（本 send 落定后现读活跃引擎状态；后台会话的在途轮不受此影响）
    isStreaming.value = getChatEngine().getSessionState().isRunning
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

/* 输入框左上药丸行：任务进度药丸 + 空会话归属药丸共用（与输入列同宽左对齐） */
.footer-pill-row {
  width: 100%;
  max-width: 768px;
  margin-bottom: var(--spacing-2);
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-2);
}

/* 闪念捕获条（Ctrl+I 呼出 · Teleport 到 body 的固定底条） */
.idea-cap-bar {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 28px;
  z-index: 3000;
  display: flex;
  align-items: center;
  gap: 10px;
  background: #fff;
  border: 1px solid #4a7aa8;
  border-radius: 10px;
  padding: 9px 14px;
  box-shadow: 0 -4px 24px rgba(30, 60, 100, 0.22);
  min-width: 380px;
  max-width: 640px;
}
.idea-cap-bar .ico { flex: none; }
.idea-cap-bar .ipt {
  flex: 1;
  border: none;
  outline: none;
  font-size: 13px;
  color: #2b3240;
  background: transparent;
}
.idea-cap-bar .kbd { flex: none; font-size: 11px; color: #9aa2ae; }
.idea-cap-bar .kbd.link { cursor: pointer; }
.idea-cap-bar .kbd.link:hover { color: #4a7aa8; }
.idea-cap-bar .note { flex: none; font-size: 11.5px; color: #3d8f5f; }

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

/* 会话归属标题（chat-header 左上，☰ 旁）：项目名/会话名 */
.session-context-title {
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
  max-width: 360px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
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

/* Agent 编辑器覆盖层（ModeSelector 使用现场入口；与 WorkflowView 同款） */
/* z-index 3000:高于设置覆盖层(.settings-section 2000)——设置资产中心点卡片时编辑器直接开在设置上方 */
.template-editor-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
}

.template-editor-panel {
  background: var(--background-primary, #fff);
  border-radius: 10px;
  padding: 1.25rem;
  max-width: 780px;
  width: 92vw;
  max-height: 88vh;
  overflow-y: auto;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
}

.template-editor-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.template-editor-title {
  font-size: 0.9375rem;
  font-weight: 600;
  color: #1f2937;
}
</style>