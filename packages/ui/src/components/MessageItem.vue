<template>
  <!-- 任务清单落地留痕（todoLanding）、前台人格边界标记（frontSwitch）与桌面能力开关通知（desktopToggle）：提示行样式全量渲染原文（数据层 synthetic 标记） -->
  <div v-if="syntheticKind === 'todoLanding' || syntheticKind === 'frontSwitch' || syntheticKind === 'desktopToggle'" class="synthetic-notice synthetic-landing">{{ message.content }}</div>
  <!-- 目标模式推进消息（goalTick）：折叠为一条系统提示行，全文仍在历史供模型整合（数据层 synthetic 标记） -->
  <div v-else-if="syntheticKind === 'goalTick'" class="synthetic-notice">
    【目标推进】{{ goalTickSummary(message.content) }}
  </div>
  <!-- 合成编排消息（回流轮通知）：折叠为一条系统提示行，不挂用户气泡（数据层 synthetic 标记） -->
  <div v-else-if="syntheticKind" class="synthetic-notice">
    【后台任务完成通知】{{ syntheticTaskCount(message.content) }} 项任务已落地，结果已写回工具消息
  </div>
  <div
    v-else
    :class="['message', message.role === 'user' ? 'user-message' : 'assistant-message']"
    :data-role="message.role"
  >
    <div v-for="block in item.blocks" :key="block.id" class="content-block">
      <!-- 思考内容块 -->
      <div v-if="block.type === 'reasoning'" class="reasoning-container">
        <div class="reasoning-header" @click="toggleReasoning" title="点击展开/折叠思考过程">
          <div class="reasoning-title">
            <svg class="reasoning-icon" :class="{ 'expanded': expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
            <span>思考过程</span>
          </div>
        </div>
        <transition name="reasoning-content">
          <div
            v-show="expanded"
            class="reasoning-content"
            :ref="setReasoningEl"
            @scroll="handleReasoningScroll"
          >
            <MessageMarkdown :content="block.content" :loading="false" :is-streaming="item.live && item.streamActive === true" :reasoning="true" />
          </div>
        </transition>
      </div>

      <!-- 工具调用块 - 使用动态组件渲染 -->
      <component
        v-else-if="block.type === 'tool_call' && block.component"
        :is="block.component"
        :tool-name="block.toolName"
        :display-name="block.displayName"
        :agent-type="isAgentTool(block.toolName || '') ? (block.toolName?.startsWith('execute_local_agent_') ? 'local' : 'remote') : undefined"
        :mcp-server-name="block.mcpServerName"
        :status="block.status"
        :parameters="block.parameters"
        :result="block.result"
        :artifacts="block.artifacts"
        :tasks="block.tasks"
        :show-clear-button="false"
        :tool-call-id="block.toolCallId"
      />
      <!-- 工具调用块 - 兼容旧数据（无 component 字段） -->
      <ToolCallDisplay
        v-else-if="block.type === 'tool_call'"
        :tool-name="block.toolName"
        :mcp-server-name="block.mcpServerName"
        :status="(block.status as 'running' | 'success' | 'failed')"
        :parameters="block.parameters"
        :result="block.result"
      />

      <!-- 文本内容块（live+streamActive 才是流式态：冻结或回填完整消息挂载即定稿，MessageMarkdown 闭合全部开放块） -->
      <MessageMarkdown
        v-else-if="block.type === 'text'"
        :content="block.content"
        :loading="message.role === 'assistant' && !block.content"
        :is-streaming="item.live && item.streamActive === true"
        class="message-content"
        :data-message-role="message.role"
      />

      <!-- 图片内容块 -->
      <div v-else-if="block.type === 'image'" class="image-content-block">
        <img :src="block.url" alt="用户上传的图片" class="message-image" />
      </div>

      <!-- 视频内容块 -->
      <div v-else-if="block.type === 'video'" class="video-content-block">
        <video controls class="message-video" :src="block.url" preload="auto" playsinline>
          您的浏览器不支持视频标签。
        </video>
      </div>

      <!-- 音频内容块 -->
      <div v-else-if="block.type === 'audio'" class="audio-content-block">
        <audio controls class="message-audio" :src="block.url" preload="auto">
          您的浏览器不支持音频标签。
        </audio>
      </div>
    </div>

    <div v-if="item.showTime" class="message-time">
      {{ formatTime(messageTime(message)) }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { Message } from '@assistant-ai/core'
import MessageMarkdown from './MessageMarkdown.vue'
import ToolCallDisplay from './ToolCallDisplay.vue'
import { isAgentTool } from '../toolUIRegistry'
import type { FeedMessageItem } from '../composables/useChatFeed'

/**
 * 单条消息的渲染组件（渲染架构 L3）。
 * 块列表由数据层在 append/首渲染时派生冻结后作为 prop 传入（模板不做派生计算）；
 * 历史项的 prop 引用永不变 → 组件更新被跳过；live 项经响应式追踪按需重渲染。
 * reasoning 展开态为本组件本地状态（随实例生死，免疫窗口化 prepend 的索引位移）。
 */
const props = defineProps<{ item: FeedMessageItem }>()

const message = computed(() => props.item.message)

/** synthetic 标记种类（非 synthetic 消息为 undefined） */
const syntheticKind = computed(() => {
  const m = props.item.message as Message & { synthetic?: string }
  return m.synthetic
})

// ==================== reasoning 展开/折叠（本地状态 + 流式联动） ====================

/** 初始展开：消息带 reasoning 进入（回填历史与流式中首次出现，等价原 addMessage 行为） */
const expanded = ref(!!props.item.message.reasoningContent)
/** 用户手动操作保护：阻止自动折叠覆盖用户意图 */
const userTouched = ref(false)
/** 用户在思考容器内向上滚动时暂停自动跟随 */
const userScrolledUp = ref(false)
/**
 * 思考内容滚动容器（函数 ref 精确捕获元素）。
 * 历史教训：此 div 位于 blocks 的 v-for 内——字符串 ref 在 v-for 中绑定为"元素数组"，
 * 旧实现按元素使用其 scrollTop/scrollHeight 恒为 undefined/NaN，框内跟随自 M3 起一直失效。
 */
let reasoningEl: HTMLElement | null = null
const setReasoningEl = (el: unknown): void => {
  reasoningEl = el instanceof HTMLElement ? el : null
}

const toggleReasoning = () => {
  expanded.value = !expanded.value
  userTouched.value = true
}

/** 思考内容增长时自动滚到底（用户未向上滚动时）；等价原 scrollReasoningContentToBottom 的容器内部分 */
watch(
  () => props.item.message.reasoningContent,
  (nv, ov) => {
    if (nv && !ov) {
      // 首次出现思考内容：自动展开（等价原 addMessage 的 reasoningExpanded 置真）
      if (!userTouched.value) expanded.value = true
    }
    if (nv && expanded.value) {
      nextTick(() => {
        const el = reasoningEl
        if (el && (!userScrolledUp.value || el.scrollHeight - el.scrollTop - el.clientHeight < 50)) {
          el.scrollTop = el.scrollHeight
        }
      })
    }
  }
)

/** 正文开始产出且此前有思考内容：自动折叠（用户手动展开过则保护）；等价原 updateLastMessage 的折叠分支 */
watch(
  () => props.item.message.content,
  (nv) => {
    if (nv && props.item.message.reasoningContent && !userTouched.value) {
      expanded.value = false
    }
  }
)

const handleReasoningScroll = (event: Event) => {
  const el = event.target as HTMLElement
  userScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight >= 50
}

// ==================== 展示辅助 ====================

/** 消息时间戳统一为毫秒（JSON 往返后可能是字符串） */
const messageTime = (m: Message): number => {
  return m.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m.timestamp as unknown as string).getTime()
}

const formatTime = (ms: number): string => {
  return new Date(ms).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 合成编排消息的条目数（'- [' 行计数；synthetic 消息 content 恒为 string） */
const syntheticTaskCount = (content: Message['content']): number => {
  const text = typeof content === 'string' ? content : ''
  return (text.match(/^- \[/gm) || []).length
}

/** goalTick 推进消息的折叠摘要（首行去掉轮次前缀，保留其余文本） */
const goalTickSummary = (content: Message['content']): string => {
  const text = typeof content === 'string' ? content : ''
  const firstLine = text.split('\n')[0] ?? ''
  return firstLine.replace(/^【[^】]*】/, '').trim() || '目标未达成，自动续跑'
}
</script>

<style scoped>
.message {
  display: flex;
  flex-direction: column;
  max-width: 100%;
  animation: fadeIn var(--transition-normal);
}

.user-message {
  /* 不声明 align-self：与模型输出共用 .chat-messages 的居中限宽列（768px）。
     列内右对齐由 align-items 实现 */
  align-items: flex-end;
  /* 右缘对齐：模型文字受 .message-content 水平内边距（--spacing-4）内缩，
     用户气泡同步内缩相同距离，两者最右侧重合 */
  padding-right: var(--spacing-4);
}

.assistant-message {
  max-width: 100%;
}

.message-content {
  padding: var(--spacing-3) var(--spacing-4);
  border-radius: var(--radius-lg);
  word-wrap: break-word;
  line-height: 1.5;
  width: fit-content;
  max-width: 100%;
}

.user-message .message-content {
  background-color: var(--primary-color);
  color: white;
  border-bottom-right-radius: var(--radius-sm);
}

/* 用户消息的文本选择样式 - 使用深色选择高亮以在蓝色背景上可见 */
.user-message .message-content ::selection {
  background-color: rgba(0, 0, 0, 0.4);
  color: white;
}

.assistant-message .message-content {
  background: none;
  color: var(--text-primary);
  border-radius: 0;
  width: 100%;
}

/* 思考内容样式 */
.reasoning-container {
  margin-bottom: var(--spacing-1);
  margin-left: var(--spacing-4);
  border-radius: var(--radius-md);
  overflow: hidden;
  /* 让容器宽度自适应内容，不要拉伸整个宽度 */
  width: fit-content;
  /* 缩进内扣：margin-left 之外宽度按包含块全额计会使 margin-box 溢出 16px，
     触发 .chat-messages（overflow-y:auto → overflow-x 计算值 auto）的无意义横向滚动条 */
  max-width: calc(100% - var(--spacing-4));
  /* 高度限制为chat界面高度的1/3 */
  max-height: calc(100vh / 3);
  display: flex;
  flex-direction: column;
  /* 确保容器宽度不会因为隐藏的transition内容而扩展 */
  position: relative;
}

/* 工具调用块样式 - 与思考内容左侧对齐（max-width 同步内扣缩进量，防 16px 横向溢出） */
.content-block > .tool-call-display,
.content-block > .file-reader-display,
.content-block > .file-operation-display,
.content-block > .content-insert-display,
.content-block > .content-replace-display,
.content-block > .content-delete-display,
.content-block > .task-list-display,
.content-block > .task-tool-display,
.content-block > .agent-tool-display,
.content-block > .powershell-command-display {
  margin-left: var(--spacing-4);
  max-width: calc(100% - var(--spacing-4));
}

.reasoning-header {
  display: inline-flex;  /* 改为inline-flex，限制宽度适应内容 */
  align-items: center;
  padding: var(--spacing-2) var(--spacing-3);
  cursor: pointer;
  user-select: none;
  /* 固定标题位置，不随内容滚动 */
  flex-shrink: 0;
  background: transparent;
  border-bottom: none;
  /* 明确设置宽度适应内容 */
  width: fit-content;
  max-width: 100%;
}

.reasoning-title {
  display: flex;
  align-items: center;
  color: #9ca3af;
  font-weight: 500;
  font-size: var(--font-size-sm);
}

.reasoning-icon {
  width: 16px;
  height: 16px;
  margin-right: var(--spacing-2);
  transition: transform var(--transition-fast);
  color: var(--primary-color);
}

.reasoning-icon.expanded {
  transform: rotate(90deg);
}

/* 独立滚动的内容区域（标题固定） */
.reasoning-content {
  overflow-y: auto;
  flex: 1;
  /* 保持滚动条隐藏 */
  -ms-overflow-style: none;
  scrollbar-width: none;

  padding: var(--spacing-3);
  padding-left: var(--spacing-4);
  color: #9ca3af;
  font-size: var(--font-size-sm);
  line-height: 1.5;
  white-space: normal;
  border-left: 2px solid rgba(59, 130, 246, 0.15);
  margin-left: var(--spacing-2);
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.03) 0%, rgba(59, 130, 246, 0.01) 100%);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
}

.reasoning-content::-webkit-scrollbar {
  display: none;
}

/* 思考内容展开/折叠动画 */
.reasoning-content-enter-active,
.reasoning-content-leave-active {
  transition: max-height var(--transition-normal) ease-in-out;
  overflow: hidden;
  /* 明确设置transition区域的最大宽度，防止影响容器宽度 */
  width: 100%;
  box-sizing: border-box;
}

.reasoning-content-enter-from,
.reasoning-content-leave-to {
  max-height: 0;
}

.reasoning-content-enter-to,
.reasoning-content-leave-from {
  max-height: 500px;
}

.message-time {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  margin-top: var(--spacing-1);
  padding: 0 var(--spacing-2);
}

.user-message .message-time {
  align-self: flex-end;
  text-align: right;
}

.assistant-message .message-time {
  align-self: flex-start;
}

/* 合成提示行（消息形态）：ChatArea 中 hook 通知共用同款样式 */
.synthetic-notice {
  margin-left: var(--spacing-4);
  /* 缩进内扣（width:100% 来自 .chat-messages > *，不扣会使 margin-box 溢出 16px） */
  max-width: calc(100% - var(--spacing-4));
  padding: var(--spacing-1) var(--spacing-3);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  opacity: 0.75;
  user-select: none;
}

/* 任务清单落地留痕：同款弱化样式，但全量原文（保留换行）且可选中复制（可回溯） */
.synthetic-landing {
  white-space: pre-wrap;
  user-select: text;
}

/* 图片内容块样式 */
.image-content-block {
  margin: var(--spacing-2) 0;
  border-radius: var(--radius-lg);
  overflow: hidden;
  max-width: 100%;
}

.message-image {
  max-width: 100%;
  max-height: 400px;
  object-fit: contain;
  border-radius: var(--radius-lg);
  display: block;
}

/* 视频内容块样式 */
.video-content-block {
  margin: var(--spacing-2) 0;
  border-radius: var(--radius-lg);
  overflow: hidden;
  max-width: 100%;
}

.message-video {
  max-width: 100%;
  max-height: 400px;
  border-radius: var(--radius-lg);
  display: block;
  background-color: #000;
}

/* 响应式调整 */
@media (max-width: 768px) {
  .message {
    max-width: 90%;
  }

  .assistant-message {
    max-width: none;
  }
}

@media (max-width: 480px) {
  .message {
    max-width: 95%;
  }

  .assistant-message {
    max-width: none;
  }

  .message-content {
    padding: var(--spacing-2) var(--spacing-3);
  }

  /* 与 .message-content 缩小后的水平内边距同步，保持右缘对齐 */
  .user-message {
    padding-right: var(--spacing-3);
  }
}
</style>
