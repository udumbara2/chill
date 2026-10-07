<template>
  <div class="input-container">
    <!-- 待确认操作栏 -->
    <PendingOperationsBar />

    <!-- 已选图片预览显示 - 移到输入框上方 -->
    <div v-if="selectedImageFiles.length > 0" class="selected-images-container">
      <div v-for="(file, index) in selectedImageFiles" :key="index" class="selected-image-item">
        <img :src="getImagePreviewUrl(file)" class="image-preview-thumbnail" />
        <button class="remove-image-btn" @click="removeSelectedImage(index)" title="移除图片">×</button>
      </div>
    </div>

    <!-- 已选视频文件卡片显示 - 移到输入框上方 -->
    <div v-if="selectedVideoFiles.length > 0" class="selected-videos-container">
      <div v-for="(file, index) in selectedVideoFiles" :key="index" class="selected-video-item">
        <div class="video-file-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </div>
        <div class="video-file-info">
          <span class="video-file-name">{{ file.name }}</span>
          <span class="video-file-size">{{ formatFileSize(file.size) }}</span>
        </div>
        <button class="remove-video-btn" @click="removeSelectedVideo(index)" title="移除视频">×</button>
      </div>
    </div>

    <!-- 已选文件芯片（文件引用管线：任何被拖入的文件必有可见痕迹） -->
    <div v-if="selectedFileRefs.length > 0" class="selected-files-container">
      <div v-for="(item, index) in selectedFileRefs" :key="index" class="selected-file-item">
        <div class="file-chip-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <div class="file-chip-info">
          <span class="file-chip-name">{{ item.ref.name }}</span>
          <span class="file-chip-meta">{{ fileRefKindLabel(item.ref) }} · {{ formatFileSize(item.ref.size) }}<template v-if="!item.ref.path"> · 无路径，仅名字引用</template></span>
        </div>
        <button class="remove-file-btn" @click="removeSelectedFileRef(index)" title="移除文件">×</button>
      </div>
    </div>

    <!-- 目标模式激活时：目标正文 + 进度 + 暂停/退出动作显示在输入框卡片边框外侧上方（一行小字，非独立长条） -->
    <div v-if="goalModeStore.isGoalMode" class="goal-inline" :title="goalModeStore.objective">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="9"/>
        <circle cx="12" cy="12" r="5"/>
        <circle cx="12" cy="12" r="1.5"/>
      </svg>
      <button class="goal-inline-text" title="点击查看目标全文（Markdown 渲染）" @click="goalObjectiveOpen = true">{{ goalModeStore.objective }}</button>
      <span class="goal-inline-status">
        {{ goalModeStore.roundCount }}/{{ goalModeStore.maxRounds }} 轮{{ goalModeStore.status === 'paused' ? ' · 已暂停' : '' }}
      </span>
      <button
        v-if="goalModeStore.status === 'active'"
        class="goal-inline-btn"
        @click="goalModeStore.pauseGoal()"
        title="暂停目标推进"
      >
        暂停
      </button>
      <button v-else class="goal-inline-btn" @click="goalModeStore.resumeGoal()" title="恢复目标推进">恢复</button>
      <button class="goal-inline-btn" @click="goalModeStore.clearGoal()" title="放弃目标并退出目标模式">退出</button>
    <!-- 目标文档正文浮层（Markdown 渲染全文；点遮罩/× 关闭） -->
    <div v-if="goalObjectiveOpen" class="goal-objective-overlay" @click="goalObjectiveOpen = false">
      <div class="goal-objective-panel" @click.stop>
        <div class="goal-objective-head">
          <span class="goal-objective-title">目标与完成判据</span>
          <button class="goal-objective-close" @click="goalObjectiveOpen = false">×</button>
        </div>
        <div class="goal-objective-body">
          <MessageMarkdown :content="goalModeStore.objective" />
        </div>
      </div>
    </div>
    </div>

    <div
      class="input-area"
      :class="{ 'drag-over': isDragOver, 'goal-collecting': goalCollecting }"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <!-- 拖拽提示遮罩 -->
      <div v-if="isDragOver" class="drag-overlay">
        <div class="drag-hint">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span>释放以上传文件</span>
        </div>
      </div>

      <textarea
        ref="textareaRef"
        v-model="message"
        class="input-textarea"
        :placeholder="placeholderText"
        rows="2"
        @keydown="handleKeyDown"
        @input="adjustTextareaHeight"
        @paste="handlePaste"
      ></textarea>

      <div class="input-controls">
        <div class="left-controls">
          <!-- 权限三态选择器（只读 | 边界 | 直写）：居左下，与右下工作流/驱动轴控件分群 -->
          <PermissionModeSelector />
          <!-- 规划/目标模式开关：与权限选择器同族药丸，模式群居左（右下只留动作轴）；
               激活后悬停卡承载状态说明与退出动作（hover card 关闭延时配方同上下文环） -->
          <div class="mode-pill-wrapper">
            <button
              class="mode-pill mode-pill-plan"
              :class="{ active: planModeStore.isPlanMode }"
              @click="planModeStore.setPlanMode(!planModeStore.isPlanMode)"
              :title="planModeStore.isPlanMode ? '退出规划模式（恢复直接执行）' : '进入规划模式（先与助手打磨规划，批准后执行）'"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
              <span>规划</span>
            </button>
            <div v-if="planModeStore.isPlanMode" class="mode-tooltip" @click.stop>
              <div class="mode-tooltip-text">规划模式中：修改性操作已被拦截，打磨规划后由你审阅</div>
              <div class="mode-tooltip-actions">
                <button class="mode-tooltip-btn plan" @click="planModeStore.setPlanMode(false)">退出规划模式</button>
              </div>
            </div>
          </div>
          <!-- 目标模式开关（等价 CLI 的 /goal）：点击后输入框进入目标收集态，Esc/再点取消；激活时再点 = 放弃目标；
               激活后药丸显示轮次，目标全文/进度/暂停/退出动作由输入框上方的目标行承载 -->
          <div class="mode-pill-wrapper">
            <button
              class="mode-pill mode-pill-goal"
              :class="{ active: goalModeStore.isGoalMode || goalCollecting }"
              @click="handleGoalToggle"
              :title="goalModeStore.isGoalMode ? '退出目标模式（放弃当前目标）' : goalCollecting ? '取消目标输入（Esc）' : '进入目标模式（在输入框中设定目标与完成判据，助手自主推进直到达成）'"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="9"/>
                <circle cx="12" cy="12" r="5"/>
                <circle cx="12" cy="12" r="1.5"/>
              </svg>
              <span>{{ goalModeStore.isGoalMode ? `目标 ${goalModeStore.roundCount}/${goalModeStore.maxRounds}` : '目标' }}</span>
            </button>
          </div>
          <!-- 图片选择按钮 - 仅在模型支持图片时显示 -->
          <button
            v-if="supportsImage"
            class="image-upload-btn"
            @click="triggerImageSelect"
            title="选择图片"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
          </button>
          <input
            v-if="supportsImage"
            ref="imageInputRef"
            type="file"
            accept="image/*"
            multiple
            style="display: none"
            @change="handleImageSelect"
          />
          
          <!-- 视频选择按钮 - 仅在模型支持视频时显示 -->
          <button
            v-if="supportsVideo"
            class="video-upload-btn"
            @click="triggerVideoSelect"
            title="选择视频"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </button>
          <input
            v-if="supportsVideo"
            ref="videoInputRef"
            type="file"
            accept="video/*"
            multiple
            style="display: none"
            @change="handleVideoSelect"
          />

          <!-- 文件选择按钮 - 任意类型（文件引用管线） -->
          <button
            class="file-upload-btn"
            @click="triggerFileSelect"
            title="选择文件"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
          <input
            ref="fileInputRef"
            type="file"
            multiple
            style="display: none"
            @change="handleFileSelect"
          />
        </div>
        
        <div class="input-controls-spacer"></div>
        
        <div class="right-controls">
          <ModeSelector @open-settings="handleOpenSettings" @open-agent-editor="handleOpenAgentEditor" />
          <!-- 上下文占用环（悬停出具体数据；无实测时隐藏） -->
          <ContextUsageRing />
          <ModelSelector show-effort-chip @model-selected="handleModelSelected" />
          
          <button
            v-if="!isStreaming"
            class="send-btn"
            :disabled="!message.trim() && selectedImageFiles.length === 0 && selectedVideoFiles.length === 0 && selectedFileRefs.length === 0"
            @click="sendMessage"
            title="发送消息"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 2L11 13"/>
              <path d="M22 2L15 22L11 13L2 9L22 2Z"/>
            </svg>
          </button>
          
          <button 
            v-else
            class="stop-btn"
            @click="handleStop"
            title="停止生成"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Prompts列表组件 - 移出主容器以避免遮挡 -->
    <div class="prompts-container">
      <!-- 加载状态 -->
      <div v-if="isLoading" class="prompts-loading">
        <div class="loading-spinner"></div>
        <span>加载中...</span>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMessage" class="prompts-error">
        <span>{{ errorMessage }}</span>
      </div>


      <PromptsList
        ref="promptsListRef"
        :prompts="filteredPrompts.length > 0 ? filteredPrompts : prompts"
        :show-list="showPromptsList"
        :search-keyword="searchKeyword"
        :target-element="textareaRef"
        @select-prompt="handlePromptSelect"
        @close-list="closePromptsList"
      />

      <!-- "@" agent 提及列表（复用 PromptsList 下拉范式，数据源为渲染进程模板副本） -->
      <PromptsList
        ref="agentListRef"
        :prompts="agentTemplates"
        :show-list="showAgentList"
        :search-keyword="agentKeyword"
        :target-element="textareaRef"
        @select-prompt="handleAgentSelect"
        @close-list="closeAgentList"
      />
    </div>

  </div>

  <!-- Prompt参数输入对话框 -->
  <PromptParameterDialog
    :visible="showPromptParameterDialog"
    :parameters="selectedPrompt?.arguments || []"
    @confirm="handlePromptParameterConfirm"
    @cancel="showPromptParameterDialog = false"
  />

  <!-- 规划模式提问对话框 -->
  <PlanAskDialog />
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, computed, watch } from 'vue'
import { tryGetHostAPI } from '../host/hostApi'
import ModelSelector from './ModelSelector.vue'
import ModeSelector from './ModeSelector.vue'
import PromptsList from './prompts/PromptsList.vue'
import PromptParameterDialog from './PromptParameterDialog.vue'
import PendingOperationsBar from './PendingOperationsBar.vue'
import PlanAskDialog from './PlanAskDialog.vue'
import ContextUsageRing from './ContextUsageRing.vue'
import PermissionModeSelector from './PermissionModeSelector.vue'
import MessageMarkdown from './MessageMarkdown.vue'
import { usePermissionModeStore } from '../stores/permissionModeStore'
import { usePlanModeStore } from '../stores/planModeStore'
import { useGoalModeStore } from '../stores/goalModeStore'
import { useMCPStore } from '../stores/mcpStore'
import { MCPService, getTemplateManager } from '@assistant-ai/core'
import { eventBus, EVENTS } from '@assistant-ai/core'
import { promptMode } from '../stores/promptMode'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import type { ModelInfo } from '@assistant-ai/core'
import { ModelModality } from '@assistant-ai/core'
import { classifyFileRef, decideIntake, renderFileRefLine, renderInlineRef, renderLargeTextRef, type FileRef } from '@assistant-ai/core'
import { SPILL_PREVIEW_CHARS } from '@assistant-ai/core'
import { showCompactToast } from '../composables/useCompact'

// 消息内容
const message = ref('')
// textarea引用
const textareaRef = ref<HTMLTextAreaElement>()
// 图片文件输入引用
const imageInputRef = ref<HTMLInputElement>()
// 已选择的图片文件（支持多张）
const selectedImageFiles = ref<File[]>([])
// 视频文件输入引用
const videoInputRef = ref<HTMLInputElement>()
// 已选择的视频文件（支持多个）
const selectedVideoFiles = ref<File[]>([])
// 已选文件引用（文件引用管线：非媒体文件一律芯片化，绝不静默丢弃）
const selectedFileRefs = ref<Array<{ ref: FileRef; file: File }>>([])
// 文件选择输入引用
const fileInputRef = ref<HTMLInputElement>()
// 拖拽状态
const isDragOver = ref(false)
// 当前选择的模型
const currentModel = ref<ModelInfo | null>(null)

// 计算属性：当前模型是否支持图片
const supportsImage = computed(() => {
  return currentModel.value?.supportedModalities?.includes(ModelModality.IMAGE) ?? false
})

// 计算属性：当前模型是否支持视频
const supportsVideo = computed(() => {
  return currentModel.value?.supportedModalities?.includes(ModelModality.VIDEO) ?? false
})

// 计算属性：动态生成 placeholder 文本
const placeholderText = computed(() => {
  // 目标收集态优先：输入即目标文本
  if (goalCollecting.value) {
    return '输入目标与完成判据（怎么算完、怎么验证），Enter 确认，Esc 取消'
  }
  // 规划模式下加前缀提示（修改性操作已被 core 拦截）；目标模式已有卡片内嵌目标行，placeholder 不再重复前缀
  const prefix = planModeStore.isPlanMode ? '[规划模式] ' : ''
  const baseText = '输入消息...'
  const capabilities: string[] = []

  if (supportsImage.value) {
    capabilities.push('图片')
  }
  if (supportsVideo.value) {
    capabilities.push('视频')
  }

  if (capabilities.length > 0) {
    return `${prefix}${baseText}（可拖拽或粘贴${capabilities.join('/')}到此处）`
  }

  return `${prefix}${baseText}`
})

// 添加响应式状态 - 用于"/"命令功能
const prompts = ref<any[]>([])
const showPromptsList = ref(false)
const promptsListRef = ref<InstanceType<typeof PromptsList>>()
const isLoading = ref(false)
const errorMessage = ref('')

// 添加响应式状态 - 用于"@"agent 提及功能（数据源 = 渲染进程模板副本）
const agentTemplates = ref<any[]>([])
const showAgentList = ref(false)
const agentListRef = ref<InstanceType<typeof PromptsList>>()

// 添加响应式变量 - 用于prompt参数功能
const showPromptParameterDialog = ref(false)
const selectedPrompt = ref<any>(null)

// 1. 搜索关键词提取（支持中英文）
const searchKeyword = computed(() => {
  const match = message.value.match(/\/([^/]*)$/)
  return match ? match[1] : ''
})

// "@" 提及关键词（仅 kebab-case 字符，与 subagent_type 字符集一致，与媒体 @文件.扩展名 不冲突）
const agentKeyword = computed(() => {
  const match = message.value.match(/@([a-z0-9-]*)$/)
  return match ? match[1] : ''
})

// 2. 过滤状态
const filteredPrompts = ref<any[]>([])

// MCP Store实例
const mcpStore = useMCPStore()

// 规划模式 Store实例
const planModeStore = usePlanModeStore()

// 目标模式 Store实例
const goalModeStore = useGoalModeStore()
/** 目标文档正文浮层开关（内嵌行只显单行摘要；点击展开渲染全文） */
const goalObjectiveOpen = ref(false)
const permissionModeStore = usePermissionModeStore()

/** 目标收集态：点目标药丸后输入框变为目标输入（零模态，对齐 CLI /goal 内联语义） */
const goalCollecting = ref(false)

/**
 * 目标模式按钮（等价 CLI 的 /goal）：开启 = 输入框进入目标收集态（Esc/再点取消，发送即设定目标）；
 * 激活时再点 = 放弃目标（与悬停卡退出按钮同义）
 */
const handleGoalToggle = () => {
  if (goalModeStore.isGoalMode) {
    goalModeStore.clearGoal()
    return
  }
  goalCollecting.value = !goalCollecting.value
  if (goalCollecting.value) nextTick(() => textareaRef.value?.focus())
}

// Props
const props = defineProps<{
  isStreaming?: boolean
  /** 会话已有消息（false = 全新空会话：压缩上下文等依赖历史的控件隐藏） */
  hasHistory?: boolean
}>()

// 使用computed来确保响应式更新
const isStreaming = computed(() => props.isStreaming || false)

// 定义事件
const emit = defineEmits<{
  send: [{ text: string; imageFiles?: File[]; videoFiles?: File[] }]
  modelSelected: [model: ModelInfo | null]
  stop: []
}>()

// 处理键盘事件
const handleKeyDown = (event: KeyboardEvent) => {
  // 当agent提及列表显示时，将键盘事件传递给列表组件处理（与prompts列表同一范式）
  if (showAgentList.value && agentListRef.value && agentTemplates.value.length > 0) {
    agentListRef.value.handleKeyDown(event)
    return
  }

  // 当prompts列表显示且有可选的prompt时，将键盘事件传递给PromptsList组件处理
  if (showPromptsList.value && promptsListRef.value && (filteredPrompts.value.length > 0 || prompts.value.length > 0)) {
    promptsListRef.value.handleKeyDown(event)
    return
  }
  
  // 目标收集态：Esc 取消收集（不进目标模式，输入内容保留）
  if (event.key === 'Escape' && goalCollecting.value) {
    goalCollecting.value = false
    return
  }

  // Enter发送消息，Shift+Enter换行（当prompt list不显示时才处理发送）
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
    return
  }
  
  // 检测"@"键触发agent提及列表
  if (event.key === '@') {
    showAgentMentionList()
    return
  }

  // 检测"/"键触发
  if (event.key === '/') {
    // 与agent提及列表互斥，避免两个下拉同时出现
    closeAgentList()
    loadPromptsAndShow()
    return
  }
}

// 触发图片选择
const triggerImageSelect = () => {
  imageInputRef.value?.click()
}

// 触发视频选择
const triggerVideoSelect = () => {
  videoInputRef.value?.click()
}

// 触发文件选择（任意类型）
const triggerFileSelect = () => {
  fileInputRef.value?.click()
}

// 处理文件选择（文件引用管线）
const handleFileSelect = (event: Event) => {
  const target = event.target as HTMLInputElement
  const files = target.files
  if (files && files.length > 0) {
    void collectFileRefs(Array.from(files))
  }
}

// 处理拖拽悬停
const handleDragOver = (event: DragEvent) => {
  event.preventDefault()
  event.stopPropagation()
  isDragOver.value = true
}

// 处理拖拽离开
const handleDragLeave = (event: DragEvent) => {
  event.preventDefault()
  event.stopPropagation()
  // 检查是否真的离开了元素（而不是进入了子元素）
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = event.clientX
  const y = event.clientY
  if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
    isDragOver.value = false
  }
}

// ==================== 文件引用管线（T2）：全类型收编 + 路径获取链 ====================

/** 路径获取链：File.path（Electron 28 有效；≥32 须迁 webUtils.getPathForFile）→ saveAttachment 落盘兜底 → 无路径显式警示 */
const resolveFilePathChain = async (file: File): Promise<string | undefined> => {
  const direct = (file as unknown as { path?: string }).path
  if (direct) return direct
  try {
    const result = await tryGetHostAPI()?.saveAttachment(await file.arrayBuffer(), file.name)
    if (result?.success && result.filePath) return result.filePath
  } catch { /* 兜底失败落入无路径分支 */ }
  return undefined
}

/** 分类标签（芯片显示用；分类 SSOT 在 core classifyFileRef） */
const fileRefKindLabel = (ref: FileRef): string => {
  switch (ref.kind) {
    case 'media': return '媒体'
    case 'text': return '文本'
    case 'document': return ref.ext === '.pdf' ? 'PDF' : '文档'
    case 'archive': return '压缩包'
    default: return (ref.ext === '.7z' || ref.ext === '.rar') ? '压缩包' : '二进制'
  }
}

/** 非媒体文件进芯片列表（media 仍走图片/视频字节通道） */
const collectFileRefs = async (files: File[]) => {
  for (const file of files) {
    const path = await resolveFilePathChain(file)
    const ref = classifyFileRef({ name: file.name, path, size: file.size })
    selectedFileRefs.value.push({ ref, file })
  }
}

/** 入口分发：图片/视频按能力进字节通道（现状），其余一律进文件引用芯片——绝不静默丢弃 */
const routeIncomingFiles = (files: File[]) => {
  for (const file of files) {
    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/')
    if ((isImage && supportsImage.value) || (isVideo && supportsVideo.value)) {
      if (isImage) selectedImageFiles.value.push(file)
      else selectedVideoFiles.value.push(file)
    } else {
      void collectFileRefs([file])
    }
  }
}

/** 发送时按 decideIntake 渲染引用块（内联/大文本预览/引用行），固定拼在正文尾部 */
const buildFileRefPayload = async (): Promise<string> => {
  const blocks: string[] = []
  for (const item of selectedFileRefs.value) {
    const ref = item.ref
    try {
      if (decideIntake(ref) === 'inline') {
        blocks.push(renderInlineRef(ref, await item.file.text()))
      } else if (ref.kind === 'text') {
        // 大文本：范围读头尾（SPILL_PREVIEW_CHARS 窗口），禁止整读
        const W = SPILL_PREVIEW_CHARS
        const head = await item.file.slice(0, W).text()
        const tail = await item.file.slice(Math.max(0, ref.size - W)).text()
        blocks.push(renderLargeTextRef(ref, head, tail))
      } else {
        blocks.push(renderFileRefLine(ref))
      }
    } catch {
      blocks.push(renderFileRefLine(ref) + '\n（读取失败，仅按路径引用）')
    }
  }
  return blocks.join('\n\n')
}

// 处理文件放置（文件引用管线：任何被拖入的文件必有可见痕迹，绝不静默丢弃）
const handleDrop = (event: DragEvent) => {
  event.preventDefault()
  event.stopPropagation()
  isDragOver.value = false

  const files = event.dataTransfer?.files
  if (files && files.length > 0) {
    routeIncomingFiles(Array.from(files))
  }
}
// 处理粘贴事件（文件引用管线：文件一律收编，媒体走字节通道、其余进芯片）
const handlePaste = (event: ClipboardEvent) => {
  const items = event.clipboardData?.items
  if (!items) return

  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length > 0) {
    routeIncomingFiles(files)
    event.preventDefault()
  }
}
// 获取图片预览URL
const getImagePreviewUrl = (file: File): string => {
  return URL.createObjectURL(file)
}

// 处理图片选择（支持多张）
const handleImageSelect = (event: Event) => {
  const target = event.target as HTMLInputElement
  const files = target.files
  if (files && files.length > 0) {
    // 将新选择的图片添加到数组中
    selectedImageFiles.value.push(...Array.from(files))
  }
}

// 处理视频选择（支持多个）
const handleVideoSelect = (event: Event) => {
  const target = event.target as HTMLInputElement
  const files = target.files
  if (files && files.length > 0) {
    // 将新选择的视频添加到数组中
    selectedVideoFiles.value.push(...Array.from(files))
  }
}

// 格式化文件大小
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 移除已选择的图片
const removeSelectedImage = (index: number) => {
  // 释放预览URL
  const file = selectedImageFiles.value[index]
  if (file) {
    URL.revokeObjectURL(getImagePreviewUrl(file))
  }
  selectedImageFiles.value.splice(index, 1)
  // 如果所有图片都被移除，重置input
  if (selectedImageFiles.value.length === 0 && imageInputRef.value) {
    imageInputRef.value.value = ''
  }
}

// 移除已选择的视频
const removeSelectedVideo = (index: number) => {
  selectedVideoFiles.value.splice(index, 1)
  // 如果所有视频都被移除，重置input
  if (selectedVideoFiles.value.length === 0 && videoInputRef.value) {
    videoInputRef.value.value = ''
  }
}

// 移除已选择的文件引用
const removeSelectedFileRef = (index: number) => {
  selectedFileRefs.value.splice(index, 1)
  if (selectedFileRefs.value.length === 0 && fileInputRef.value) {
    fileInputRef.value.value = ''
  }
}

// 发送消息（文件引用管线：非媒体文件渲染为引用块固定拼在正文尾部；契约不变——emit 仍是 {text, imageFiles, videoFiles}）
const sendMessage = async () => {
  const trimmedMessage = message.value.trim()

  // 目标收集态：输入即目标文本——设定目标后落入下方正常发送流程，目标文本同时作为首轮消息
  // （目标即开工指令：提交即执行，无"设定后再发一条"的死步骤；对齐 CLI /goal <文本> 行为）
  if (goalCollecting.value) {
    goalCollecting.value = false
    if (!trimmedMessage && selectedFileRefs.value.length === 0) return
    if (trimmedMessage) goalModeStore.setGoal(trimmedMessage)
    // 边界档 + 目标模式 = 自主推进遇越界写入会停滞等批；提示而不强制耦合（toast 通道在 useCompact，由上下文环渲染）
    if (permissionModeStore.mode === 'boundary') {
      showCompactToast('当前为边界模式：自主推进中如遇越界写入将暂停等待批准；无人值守建议切换到 ⚡ 直写', 'info')
    }
  }

  // 允许只发送图片、视频、文件、文字或任意组合
  if (!trimmedMessage && selectedImageFiles.value.length === 0 && selectedVideoFiles.value.length === 0 && selectedFileRefs.value.length === 0) return

  // 文件引用块（内联/预览/引用行）固定拼在正文尾部
  const refPayload = await buildFileRefPayload()
  const text = [trimmedMessage, refPayload].filter(Boolean).join('\n\n')

  // 触发发送事件，传递对象格式（契约不变）
  emit('send', {
    text,
    imageFiles: selectedImageFiles.value.length > 0 ? [...selectedImageFiles.value] : undefined,
    videoFiles: selectedVideoFiles.value.length > 0 ? [...selectedVideoFiles.value] : undefined
  })

  // 清空输入框、图片、视频与文件引用
  message.value = ''
  // 释放所有图片预览URL
  selectedImageFiles.value.forEach(file => {
    URL.revokeObjectURL(getImagePreviewUrl(file))
  })
  selectedImageFiles.value = []
  selectedVideoFiles.value = []
  selectedFileRefs.value = []
  if (imageInputRef.value) {
    imageInputRef.value.value = ''
  }
  if (videoInputRef.value) {
    videoInputRef.value.value = ''
  }
  if (fileInputRef.value) {
    fileInputRef.value.value = ''
  }
  
  // 重置输入框高度为基础高度
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = '60px' // 重置为基础高度
    }
  })
}
// 处理停止
const handleStop = () => {
  emit('stop')
}

// 处理模型选择
const handleModelSelected = (model: ModelInfo | null) => {
  currentModel.value = model
  emit('modelSelected', model)
}

// 处理打开设置
const handleOpenSettings = (tab: string) => {
  eventBus.emit(EVENTS.OPEN_SETTINGS, tab)
}

// 打开 Agent 编辑器（ModeSelector 使用现场入口 → eventBus → Home 挂载覆盖层）
const handleOpenAgentEditor = (payload?: { slug?: string }) => {
  eventBus.emit(EVENTS.OPEN_AGENT_EDITOR, payload)
}

// 调整textarea高度
const adjustTextareaHeight = () => {
  if (!textareaRef.value) return
  
  // 基础高度：两行（空态从容，随内容自动增长）
  const baseHeight = 48
  const maxHeight = 360 // 最大高度约15行
  
  // 如果没有内容，设置为基础高度
  if (!message.value.trim()) {
    textareaRef.value.style.height = `${baseHeight}px`
    return
  }
  
  // 重置高度以获取正确的scrollHeight
  textareaRef.value.style.height = 'auto'
  
  // 设置新高度，但限制最大高度
  const scrollHeight = textareaRef.value.scrollHeight
  const newHeight = Math.min(scrollHeight, maxHeight)
  
  // 确保至少有基础高度
  const finalHeight = Math.max(newHeight, baseHeight)
  textareaRef.value.style.height = `${finalHeight}px`
}

// 加载并显示prompts列表
const loadPromptsAndShow = async () => {
  if (isLoading.value) return
  
  // 检查MCP工具开关状态
  const mcpStore = useMCPStore()
  if (!mcpStore?.getMCPToolsEnabled()) {
    return
  }
  
  isLoading.value = true
  errorMessage.value = ''
  
  try {
    // 使用官方SDK的getAllPrompts方法
    const promptsData = await new MCPService().getAllPrompts()
    
    // 转换数据格式以适配PromptsList组件
    prompts.value = promptsData.map(prompt => {
      // 提取干净的服务器名称，去掉ID部分
      const cleanServerName = prompt.serverName 
        ? prompt.serverName.replace(/-\d+$/, '') // 去掉末尾的数字ID部分
        : 'Unknown Server'
      
      return {
        name: prompt.name,
        description: prompt.description || '',
        title: prompt.title || prompt.name,
        serverName: cleanServerName, // 使用干净的服务器名称
        serverId: prompt.serverId || 'unknown',
        annotations: prompt.annotations,
        arguments: prompt.arguments // 修复：添加参数信息以支持参数检测
      }
    })
    
    showPromptsList.value = true
    
    // 聚焦到textarea以确保键盘事件正确处理
    nextTick(() => {
      if (textareaRef.value) {
        textareaRef.value.focus()
      }
    })
  } catch (error) {
    console.error('加载prompts失败:', error)
    
    // 根据错误类型提供友好的错误信息
    if (error instanceof McpError) {
      switch (error.code) {
        case -32601: // Method not found
          errorMessage.value = '当前服务器不支持prompts功能'
          break
        case -32603: // Internal error
          errorMessage.value = '服务器内部错误，请稍后重试'
          break
        default:
          errorMessage.value = `加载失败: ${error.message}`
      }
    } else {
      errorMessage.value = '加载prompts列表失败，请检查网络连接'
    }
    
    // 3秒后自动清除错误信息
    setTimeout(() => {
      errorMessage.value = ''
    }, 3000)
  } finally {
    isLoading.value = false
  }
}

// 处理prompt选择
const handlePromptSelect = async (prompt: any) => {
  try {
    // 【官方SDK内置】检查prompt是否需要参数
    const needsArgs = prompt.arguments && prompt.arguments.length > 0
    
    if (needsArgs) {
      // 【新增】显示参数输入对话框
      showPromptParameterDialog.value = true
      selectedPrompt.value = prompt
      return
    }
    
    // 【保持】无参数prompt使用现有逻辑 - 零改动
    const promptContent = await new MCPService().getPrompt(prompt.name, undefined, prompt.serverId)
    
    // 【保持】现有内容处理逻辑完全不变
    let finalContent = ''
    
    if (promptContent?.success && Array.isArray(promptContent.prompt)) {
      const messages = promptContent.prompt
      for (const msg of messages) {
        if (msg.role === 'user' && msg.content && msg.content.text) {
          finalContent += msg.content.text
        }
      }
    } else if (promptContent?.content) {
      finalContent = promptContent.content
    } else if (typeof promptContent === 'string') {
      finalContent = promptContent
    }
    
    // 【保持】现有智能插入逻辑完全不变
    if (finalContent.trim()) {
      const lastSlashIndex = message.value.lastIndexOf('/')
      if (lastSlashIndex !== -1) {
        const prefix = message.value.substring(0, lastSlashIndex)
        message.value = prefix + finalContent
      } else {
        message.value = finalContent
      }
      
      // 调整textarea高度
      nextTick(() => {
        adjustTextareaHeight()
      })
    }
    
    // 无参数prompt：检查是否需要直接发送
    if (promptMode.isDirectSend) {
      sendMessage()
      promptMode.isDirectSend = false
      return
    }
    
  } catch (error) {
    console.error('获取prompt内容失败:', error)
    // 【保持】现有错误处理机制不变
  }
  
  // 【保持】现有关闭和聚焦逻辑不变
  closePromptsList()
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.focus()
      textareaRef.value.setSelectionRange(message.value.length, message.value.length)
    }
  })
}

// 关闭prompts列表
const closePromptsList = () => {
  showPromptsList.value = false
  errorMessage.value = ''
}

// 显示"@"agent 提及列表（模板现取渲染进程副本全量：内置/个人/项目/远程）
const showAgentMentionList = () => {
  // 与 prompts 列表互斥，避免两个下拉同时出现
  closePromptsList()
  agentTemplates.value = getTemplateManager().getAllTemplates().map(t => ({
    name: t.subagent_type,            // 选中后插入的点名标识（@<subagent_type>）
    title: t.subagent_type,           // 列表主显示文本
    description: t.description || '',
    serverName: t.name || '',         // 第三行展示模板显示名
    serverId: ''
  }))
  // 无任何可用模板时不弹出
  if (agentTemplates.value.length === 0) return
  showAgentList.value = true

  // 聚焦到textarea以确保键盘事件正确处理
  nextTick(() => {
    textareaRef.value?.focus()
  })
}

// 处理agent选择：插入 @<subagent_type>（替换"@"后未打完的片段）
const handleAgentSelect = (agent: any) => {
  const lastAtIndex = message.value.lastIndexOf('@')
  const insertText = `@${agent.name} `
  if (lastAtIndex !== -1) {
    message.value = message.value.substring(0, lastAtIndex) + insertText
  } else {
    message.value += insertText
  }

  closeAgentList()
  // 调整textarea高度并恢复焦点/光标（与prompt选择同一范式）
  nextTick(() => {
    adjustTextareaHeight()
    if (textareaRef.value) {
      textareaRef.value.focus()
      textareaRef.value.setSelectionRange(message.value.length, message.value.length)
    }
  })
}

// 关闭agent提及列表
const closeAgentList = () => {
  showAgentList.value = false
}

// 参数对话框确认后的处理
const handlePromptParameterConfirm = async (paramArguments: Record<string, string>) => {
  try {
    if (!selectedPrompt.value) return
    
    // 【官方SDK原生支持】直接传递参数
    const promptContent = await new MCPService().getPrompt(
      selectedPrompt.value.name, 
      paramArguments, 
      selectedPrompt.value.serverId
    )
    
    // 【保持】现有内容处理逻辑
    let finalContent = ''
    
    if (promptContent?.success && Array.isArray(promptContent.prompt)) {
      const messages = promptContent.prompt
      for (const msg of messages) {
        if (msg.role === 'user' && msg.content && msg.content.text) {
          finalContent += msg.content.text
        }
      }
    } else if (promptContent?.content) {
      finalContent = promptContent.content
    } else if (typeof promptContent === 'string') {
      finalContent = promptContent
    }
    
    // 智能插入到输入框
    if (finalContent.trim()) {
      const lastSlashIndex = message.value.lastIndexOf('/')
      if (lastSlashIndex !== -1) {
        const prefix = message.value.substring(0, lastSlashIndex)
        message.value = prefix + finalContent
      } else {
        message.value = finalContent
      }
      
      // 调整textarea高度
      nextTick(() => {
        adjustTextareaHeight()
      })
    }
    
    // 双击模式：直接发送
    if (promptMode.isDirectSend) {
      sendMessage()
      promptMode.isDirectSend = false
    }
    
  } catch (error) {
    console.error('获取prompt内容失败:', error)
  } finally {
    // 【统一】关闭对话框和列表
    showPromptParameterDialog.value = false
    selectedPrompt.value = null
    closePromptsList()
    
    // 如果是直接发送模式，不需要聚焦到textarea
    if (!promptMode.isDirectSend) {
      nextTick(() => {
        if (textareaRef.value) {
          textareaRef.value.focus()
          textareaRef.value.setSelectionRange(message.value.length, message.value.length)
        }
      })
    }
  }
}



// 处理MCP提示词变化事件
const handleMCPPromptsChanged = async () => {
  // 只有当prompt list当前是打开状态时，才重新加载数据
  if (showPromptsList.value) {
    await loadPromptsAndShow()
  }
}

// 处理从聊天界面prompt图标下拉列表选择prompt的事件
const handlePromptFromDropdown = async (prompt: any) => {
  // 调用现有的handlePromptSelect方法处理prompt
  await handlePromptSelect(prompt)
}

// 处理从聊天界面prompt图标下拉列表双击直接发送prompt的事件
const handlePromptSendFromDropdown = async (prompt: any) => {
  // 设置直接发送模式
  promptMode.isDirectSend = true
  
  // 调用现有的handlePromptSelect方法处理prompt
  await handlePromptSelect(prompt)
}

// 处理插入文本事件
const handleInsertText = (text: string) => {
  if (textareaRef.value) {
    const start = textareaRef.value.selectionStart
    const end = textareaRef.value.selectionEnd
    const currentValue = message.value
    
    message.value = currentValue.substring(0, start) + text + currentValue.substring(end)
    
    nextTick(() => {
      textareaRef.value?.focus()
      const newCursorPos = start + text.length
      textareaRef.value?.setSelectionRange(newCursorPos, newCursorPos)
      adjustTextareaHeight()
    })
  }
}

// 组件挂载时调整高度
onMounted(() => {
  // 初始化MCP工具状态
  mcpStore.initMCPToolsState()
  adjustTextareaHeight()
  
  // 监听MCP提示词变化事件
  eventBus.on(EVENTS.MCP_PROMPTS_CHANGED, handleMCPPromptsChanged)
  
  // 监听从聊天界面prompt图标下拉列表选择prompt的事件
  eventBus.on(EVENTS.PROMPT_SELECT_FROM_DROPDOWN, handlePromptFromDropdown)
  
  // 监听从聊天界面prompt图标下拉列表直接发送prompt的事件
  eventBus.on(EVENTS.PROMPT_SEND_FROM_DROPDOWN, handlePromptSendFromDropdown)
  
  // 监听插入文本事件（从resource等组件触发）
  eventBus.on(EVENTS.INSERT_TEXT, handleInsertText)
  
  // 4. 监听搜索关键词变化
  watch(searchKeyword, (newKeyword) => {
    // 如果关键词为空，清除过滤结果
    if (!newKeyword) {
      filteredPrompts.value = []
      return
    }
    
    // 如果有prompts数据，进行过滤
    if (prompts.value.length > 0) {
      // 客户端过滤prompts
      filteredPrompts.value = prompts.value.filter(prompt => 
        prompt.name.toLowerCase().includes(newKeyword.toLowerCase()) ||
        (prompt.description && prompt.description.toLowerCase().includes(newKeyword.toLowerCase())) ||
        (prompt.title && prompt.title.toLowerCase().includes(newKeyword.toLowerCase()))
      )
    }
  }, { immediate: true })
  
  // 监听输入框内容变化，自动关闭prompt list（当删除触发斜杠时）
  watch(message, (newMessage) => {
    // 只有当prompt list显示时，才检查是否需要自动关闭
    if (showPromptsList.value) {
      // 检查新内容中是否还有最后一个"/"（触发prompt list的斜杠）
      const match = newMessage.match(/\/([^/]*)$/)
      
      // 如果没有找到最后一个"/"了，自动关闭prompt list
      if (!match) {
        closePromptsList()
      }
    }
  })

  // 监听输入框内容变化，自动关闭agent提及列表（删除触发"@"或不再以@片段结尾时）
  watch(message, (newMessage) => {
    if (showAgentList.value && !newMessage.match(/@([a-z0-9-]*)$/)) {
      closeAgentList()
    }
  })
  
  // 监听MCP开关状态变化，自动关闭prompt list
  watch(() => mcpStore.isMCPToolsEnabled, (newValue) => {
    if (!newValue && showPromptsList.value) {
      closePromptsList()
    }
  })

  // 监听模型变化，自动清除不支持的媒体文件
  watch(currentModel, (newModel, oldModel) => {
    // 如果模型没有变化，不处理
    if (!newModel && !oldModel) return
    if (newModel?.name === oldModel?.name) return

    // 检查新模型是否支持图片
    const newSupportsImage = newModel?.supportedModalities?.includes(ModelModality.IMAGE) ?? false
    const newSupportsVideo = newModel?.supportedModalities?.includes(ModelModality.VIDEO) ?? false

    // 如果新模型不支持图片，清除已上传的图片
    if (!newSupportsImage && selectedImageFiles.value.length > 0) {
      // 释放所有图片的预览URL
      selectedImageFiles.value.forEach(file => {
        URL.revokeObjectURL(getImagePreviewUrl(file))
      })
      selectedImageFiles.value = []
      // 重置input
      if (imageInputRef.value) {
        imageInputRef.value.value = ''
      }
    }

    // 如果新模型不支持视频，清除已上传的视频
    if (!newSupportsVideo && selectedVideoFiles.value.length > 0) {
      selectedVideoFiles.value = []
      // 重置input
      if (videoInputRef.value) {
        videoInputRef.value.value = ''
      }
    }
  })
})

// 组件卸载时清理
onUnmounted(() => {
  // 移除事件监听
  eventBus.off(EVENTS.MCP_PROMPTS_CHANGED, handleMCPPromptsChanged)
  eventBus.off(EVENTS.PROMPT_SELECT_FROM_DROPDOWN, handlePromptFromDropdown)
  eventBus.off(EVENTS.PROMPT_SEND_FROM_DROPDOWN, handlePromptSendFromDropdown)
  eventBus.off(EVENTS.INSERT_TEXT, handleInsertText)

  // 清理压缩提示计时器
  if (compactToastTimer) clearTimeout(compactToastTimer)
})
</script>

<style scoped>
.input-area {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background-color: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.input-area:focus-within {
  border-color: var(--accent-color);
}

/* 目标收集态：卡片绿色描边（优先级高于聚焦蓝），与目标药丸同色系 */
.input-area.goal-collecting,
.input-area.goal-collecting:focus-within {
  border-color: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.12);
}

/* 目标内嵌行（输入框卡片边框外侧上方，替代原独立长条）：无底色无边框，目标图标 + 全文省略 + 轮次状态 */
.goal-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
  margin-bottom: 4px;
  font-size: 12px;
  color: #16a34a;
}

.goal-inline-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 目标正文（按钮形态：点击展开 markdown 渲染全文）：重置 UA 按钮样式 */
button.goal-inline-text {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

/* 目标文档正文浮层（Markdown 渲染全文；内嵌行保持单行摘要，全文在此阅读） */
.goal-objective-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 11000;
}

.goal-objective-panel {
  width: min(720px, 92%);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}

.goal-objective-head {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #efece6;
}

.goal-objective-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
}

.goal-objective-close {
  margin-left: auto;
  border: none;
  background: transparent;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  color: #6b7280;
}

.goal-objective-body {
  padding: 16px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.7;
  color: #1f2937;
}

.goal-inline-status {
  flex-shrink: 0;
  color: var(--text-tertiary, #9ca3af);
}

/* 目标行内动作按钮（暂停/恢复/退出）：与药丸同族的小号描边按钮 */
.goal-inline-btn {
  flex-shrink: 0;
  padding: 1px 8px;
  border: 1px solid rgba(34, 197, 94, 0.4);
  border-radius: 5px;
  background: transparent;
  color: #16a34a;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.goal-inline-btn:hover {
  background: rgba(34, 197, 94, 0.08);
}

.input-textarea {
  background: transparent;
  border: none;
  outline: none;
  /* 全局 textarea 规则（global.css）带 border-radius 与聚焦光环，此处全部屏蔽——框只属于卡片 */
  border-radius: 0;
  box-shadow: none;
  resize: none;
  font-family: var(--font-family);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  line-height: 1.5;
  padding: 2px 0;
  min-height: 48px;
  max-height: 360px;
  overflow-y: auto;
}

.input-textarea::placeholder {
  color: var(--text-tertiary);
}

.input-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.input-controls-spacer {
  flex: 1;
}

.left-controls {
  display: flex;
  align-items: center;
  gap: 2px;
}

.right-controls {
  display: flex;
  align-items: center;
  gap: 2px;
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: #3b82f6;
  border: none;
  border-radius: 8px;
  color: #fff;
  cursor: pointer;
  transition: background 0.2s ease;
}

/* 规划模式切换按钮：与发送按钮同尺寸，开启时高亮（等价 CLI 的 /plan） */
/* 规划/目标模式药丸：与 PermissionModeSelector 同族（尺寸/边框/字号一致），开启态着色（规划蓝、目标绿） */
.mode-pill {
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

.mode-pill:hover {
  background: var(--background-secondary);
}

.mode-pill span {
  white-space: nowrap;
}

.mode-pill-plan.active {
  border-color: #3b82f6;
  color: #2563eb;
  background: rgba(59, 130, 246, 0.12);
}

.mode-pill-goal.active {
  border-color: #22c55e;
  color: #16a34a;
  background: rgba(34, 197, 94, 0.12);
}

/* 模式药丸悬停卡（规划/目标共用结构，配色按模式分）：承载状态说明与动作（替代原 PlanModeBar/GoalModeBar 长条）；
   visibility 过渡延迟 300ms 才隐藏（hover card 关闭延时配方，同上下文环），鼠标移向卡片不消失 */
.mode-pill-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.mode-tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  width: 320px;
  padding: 8px 12px;
  background: var(--background-primary, #fff);
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  z-index: 100;
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.15s ease, visibility 0s linear 0.3s;
}

.mode-pill-wrapper:hover .mode-tooltip {
  visibility: visible;
  opacity: 1;
  transition: opacity 0.15s ease, visibility 0s;
}

.mode-tooltip-text {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
  word-break: break-word;
}

.mode-tooltip-actions {
  margin-top: 8px;
  display: flex;
  gap: 6px;
}

.mode-tooltip-btn {
  padding: 3px 10px;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 5px;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-tooltip-btn.plan {
  color: #2563eb;
}

.mode-tooltip-btn.plan:hover {
  background: rgba(59, 130, 246, 0.08);
}

.send-btn:hover:not(:disabled) {
  background: #2563eb;
}

.send-btn:disabled {
  background: transparent;
  color: var(--text-tertiary, #9ca3af);
  cursor: not-allowed;
}

.stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: #374151;
  border: none;
  border-radius: 8px;
  color: white;
  cursor: pointer;
  transition: background 0.2s ease;
}

.stop-btn:hover {
  background: #1f2937;
}

/* 图片上传按钮样式 */
.image-upload-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--vscode-foreground, #374151);
  cursor: pointer;
  transition: all 0.2s ease;
}

.image-upload-btn:hover {
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

/* 视频上传按钮样式 */
.video-upload-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--vscode-foreground, #374151);
  cursor: pointer;
  transition: all 0.2s ease;
}

.video-upload-btn:hover {
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.remove-image-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--vscode-foreground, #6b7280);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition: all 0.2s ease;
}

.remove-image-btn:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

/* 滚动条样式 */
.input-textarea::-webkit-scrollbar {
  width: 4px;
}

.input-textarea::-webkit-scrollbar-track {
  background: transparent;
}

.input-textarea::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.2);
  border-radius: 2px;
}

.input-textarea::-webkit-scrollbar-thumb:hover {
  background-color: rgba(0, 0, 0, 0.35);
}

/* 响应式调整 - 减少留白 */
@media (max-width: 768px) {
  .input-area {
    padding: 6px;
    gap: 6px;
  }
  
  .input-textarea {
    font-size: var(--font-size-sm, 14px);
  }
}

@media (max-width: 480px) {
  .input-area {
    padding: 4px;
    gap: 4px;
  }
  
  .input-controls {
    gap: 6px;
  }
}

/* Prompts相关样式 - 移除position: relative避免影响fixed定位 */

.prompts-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  background-color: var(--vscode-editor-background, #ffffff);
  border: 1px solid var(--vscode-input-border, #e5e7eb);
  border-radius: 8px;
  color: var(--vscode-foreground, #374151);
  font-size: var(--font-size-sm);
  margin-bottom: 8px;
  animation: slideUp 0.2s ease-out;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color);
  border-top: 2px solid var(--accent-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* 上浮进入动画（scoped 样式内自定义，prompts-error/compact-toast 共用） */
@keyframes slideUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 错误消息样式 - 直接实现，避免复杂样式 */
.prompts-error {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background-color: var(--vscode-inputValidation-errorBackground, #fef2f2);
  color: var(--vscode-inputValidation-errorForeground, #991b1b);
  border: 1px solid var(--vscode-inputValidation-errorBorder, #fca5a5);
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 14px;
  margin-bottom: 8px;
  z-index: 1001;
  animation: slideUp 0.2s ease-out;
  display: flex;
  align-items: center;
  gap: 8px;
}

.prompts-error::before {
  content: "⚠️";
  font-size: 16px;
}

/* 多张图片预览容器 */
.selected-images-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px;
  background-color: rgba(59, 130, 246, 0.05);
  border-radius: 8px;
  margin-bottom: 8px;
  max-height: 120px;
  overflow-y: auto;
}

/* 单个图片预览项 */
.selected-image-item {
  position: relative;
  width: 80px;
  height: 80px;
  border-radius: 6px;
  overflow: hidden;
  border: 2px solid var(--vscode-input-border, #e5e7eb);
  transition: all 0.2s ease;
}

.selected-image-item:hover {
  border-color: #3b82f6;
}

/* 缩略图 */
.image-preview-thumbnail {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 移除按钮（在缩略图上） */
.selected-image-item .remove-image-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  border-radius: 50%;
  color: white;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.selected-image-item .remove-image-btn:hover {
  background: rgba(239, 68, 68, 0.9);
}

/* 已选视频文件容器 */
.selected-videos-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  background-color: rgba(139, 92, 246, 0.05);
  border-radius: 8px;
  margin-bottom: 8px;
  max-height: 150px;
  overflow-y: auto;
}

/* 单个视频文件项 */
.selected-video-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background-color: var(--vscode-editor-background, #ffffff);
  border: 1px solid var(--vscode-input-border, #e5e7eb);
  border-radius: 6px;
  transition: all 0.2s ease;
}

.selected-video-item:hover {
  border-color: #8b5cf6;
  box-shadow: 0 2px 4px rgba(139, 92, 246, 0.1);
}

/* 视频文件图标 */
.video-file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #8b5cf6 0%, #a78bfa 100%);
  border-radius: 8px;
  color: white;
  flex-shrink: 0;
}

/* 视频文件信息 */
.video-file-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.video-file-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground, #374151);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-file-size {
  font-size: 11px;
  color: var(--vscode-foreground, #6b7280);
  margin-top: 2px;
}

/* 移除视频按钮 */
.remove-video-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--vscode-foreground, #6b7280);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.remove-video-btn:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

/* 拖拽状态样式 */
.input-area.drag-over {
  border-color: #3b82f6;
  background-color: rgba(59, 130, 246, 0.05);
}

/* 拖拽遮罩层 */
.drag-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(59, 130, 246, 0.15);
  border: 2px dashed #3b82f6;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: none;
}

/* 拖拽提示 */
.drag-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: #3b82f6;
  font-size: 16px;
  font-weight: 500;
}

.drag-hint svg {
  animation: bounce 1s infinite;
}

@keyframes bounce {
  0%, 100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-10px);
  }
}

/* 确保input-area是相对定位，以便遮罩层正确定位 */
.input-area {
  position: relative;
}

/* 已选文件芯片（文件引用管线） */
.selected-files-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background-color: rgba(16, 163, 74, 0.05);
  border-radius: 8px;
  margin-bottom: 8px;
  max-height: 150px;
  overflow-y: auto;
}

.selected-file-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  background-color: var(--vscode-editor-background, #ffffff);
  border: 1px solid var(--vscode-input-border, #e5e7eb);
  border-radius: 6px;
  transition: all 0.2s ease;
}

.selected-file-item:hover {
  border-color: #16a34a;
  box-shadow: 0 2px 4px rgba(34, 197, 94, 0.1);
}

.file-chip-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: linear-gradient(135deg, #16a34a 0%, #4ade80 100%);
  border-radius: 6px;
  color: white;
  flex-shrink: 0;
}

.file-chip-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.file-chip-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground, #374151);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-chip-meta {
  font-size: 11px;
  color: var(--vscode-foreground, #6b7280);
  margin-top: 2px;
}

.file-upload-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--vscode-foreground, #374151);
  cursor: pointer;
  transition: all 0.2s ease;
}

.file-upload-btn:hover {
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.remove-file-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--vscode-foreground, #6b7280);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.remove-file-btn:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

</style>