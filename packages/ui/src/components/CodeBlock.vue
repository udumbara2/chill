<template>
  <div class="code-block-wrapper" :class="{ 'is-streaming': isStreaming }">
    <div class="code-block-header" v-if="language">
      <span class="language-tag">{{ language }}</span>
      <span v-if="isStreaming" class="streaming-indicator">
        <span class="streaming-dot"></span>
        流式输入中
      </span>
      <button
        class="copy-button"
        :class="{ 'copied': isCopied }"
        @click="copyToClipboard"
        :title="isCopied ? '已复制' : '复制代码'"
      >

        <svg v-if="!isCopied" class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        <svg v-else class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M9 12l2 2 4-4"/>
          <circle cx="12" cy="12" r="10"/>
        </svg>
      </button>
    </div>
    <div class="code-block-content">
      <div ref="contentWrapper" class="code-scroll-container">
        <!-- 两相渲染：开放期纯文本插值（真实文本节点，无 HTML 解析）；闭合瞬间一次性 hljs 高亮 -->
        <pre v-if="isStreaming" class="is-plain"><code :class="`language-${language}`">{{ code }}</code></pre>
        <pre v-else><code :class="`language-${language}`" v-html="highlightedCode"></code></pre>
        <div v-if="isStreaming" class="streaming-cursor"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import hljs from 'highlight.js'

interface Props {
  code: string
  language?: string
  isStreaming?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  language: 'text',
  isStreaming: false
})

const contentWrapper = ref<HTMLElement>()
const isCopied = ref(false)

/**
 * 高亮只在闭合相计算一次（开放相跳过——逐 token 的 highlightAuto 是 O(code)/拍，
 * 万行代码流式时会打满主线程；闭合后一次性高亮无感知延迟）。
 */
const highlightedCode = computed(() => {
  if (!props.code) return ''
  if (props.isStreaming) return ''

  try {
    if (props.language && props.language !== 'text') {
      const result = hljs.highlight(props.code, {
        language: props.language,
        ignoreIllegals: true
      })
      return result.value
    } else {
      const result = hljs.highlightAuto(props.code)
      return result.value
    }
  } catch (error) {
    console.warn('代码高亮失败:', error)
    return props.code
  }
})

const copyToClipboard = async () => {
  try {
    await navigator.clipboard.writeText(props.code)
    isCopied.value = true

    // 2秒后重置状态
    setTimeout(() => {
      isCopied.value = false
    }, 2000)
  } catch (error) {
    console.warn('复制失败:', error)
    // 降级处理：使用传统的复制方法
    fallbackCopyToClipboard(props.code)
  }
}

const fallbackCopyToClipboard = (text: string) => {
  const textArea = document.createElement('textarea')
  textArea.value = text
  document.body.appendChild(textArea)
  textArea.select()
  document.execCommand('copy')
  document.body.removeChild(textArea)

  isCopied.value = true
  setTimeout(() => {
    isCopied.value = false
  }, 2000)
}

// 滚动控制逻辑
const isNearBottom = () => {
  if (!contentWrapper.value) return false

  const { scrollHeight, scrollTop, clientHeight } = contentWrapper.value
  const threshold = 50

  return (scrollHeight - scrollTop - clientHeight) <= threshold
}

const scrollToLatest = () => {
  nextTick(() => {
    if (contentWrapper.value && isNearBottom()) {
      // 检查主聊天容器是否也接近底部，只有这样才自动滚动
      const mainChatContainer = document.querySelector('.chat-messages')
      if (mainChatContainer) {
        const { scrollTop, scrollHeight, clientHeight } = mainChatContainer as HTMLElement
        const isMainAtBottom = (scrollHeight - scrollTop - clientHeight) <= 100
        if (isMainAtBottom) {
          contentWrapper.value.scrollTop = contentWrapper.value.scrollHeight
        }
      } else {
        contentWrapper.value.scrollTop = contentWrapper.value.scrollHeight
      }
    }
  })
}

// 监听代码内容变化，实现智能滚动
watch(() => props.code, () => {
  if (props.isStreaming) {
    scrollToLatest()
  }
})

// 组件挂载时检查是否需要滚动
onMounted(() => {
  if (props.isStreaming && props.code) {
    scrollToLatest()
  }
})
</script>

<style scoped>
.code-block-wrapper {
  margin: 1rem 0;
  border-radius: 8px;
  overflow: hidden;
  background: #f8f9fa;
  border: 1px solid #e9ecef;
}

.code-block-header {
  background: #f1f3f4;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #e9ecef;
  position: relative;
}

.language-tag {
  font-size: 0.875rem;
  font-weight: 500;
  color: #495057;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.copy-button {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #6c757d;
  cursor: pointer;
  transition: all 0.2s ease;
  opacity: 1;
}

.copy-button:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #495057;
  transform: translateY(-50%) scale(1.05);
}

.copy-button.copied {
  color: #28a745;
}

.copy-icon,
.check-icon {
  width: 16px;
  height: 16px;
  stroke-width: 2;
}

.code-block-content {
  position: relative;
}

.code-scroll-container {
  /* 限制高度为视窗高度的1/3，与思考内容保持一致 */
  max-height: calc(100vh / 3);
  overflow-y: auto;
  /* 自定义滚动条样式 */
  scrollbar-width: thin;
  scrollbar-color: #c1c1c1 transparent;
}

.code-scroll-container::-webkit-scrollbar {
  width: 6px;
}

.code-scroll-container::-webkit-scrollbar-track {
  background: transparent;
}

.code-scroll-container::-webkit-scrollbar-thumb {
  background-color: #c1c1c1;
  border-radius: 3px;
  transition: background-color 0.2s;
}

.code-scroll-container::-webkit-scrollbar-thumb:hover {
  background-color: #a8a8a8;
}

.code-block-content pre {
  margin: 0;
  padding: 1rem;
  background: transparent;
  overflow-x: auto;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 0.875rem;
  line-height: 1.5;
}

/* 流式纯文本相：与闭合高亮的 One Dark 底色一致，避免闭合瞬间的底色跳变 */
.code-block-content pre.is-plain {
  background: #282c34;
  color: #abb2bf;
}

.code-block-content code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-family: inherit;
}

/* 流式样式 */
.is-streaming {
  border-color: #007acc;
  box-shadow: 0 0 8px rgba(0, 122, 204, 0.3);
}

.streaming-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: #007acc;
  font-weight: 500;
}

.streaming-dot {
  width: 6px;
  height: 6px;
  background: #007acc;
  border-radius: 50%;
  animation: streaming-pulse 1.5s infinite;
}

@keyframes streaming-pulse {
  0%, 100% {
    opacity: 0.3;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}

.streaming-cursor {
  position: absolute;
  bottom: 0.75rem;
  right: 3rem;
  width: 8px;
  height: 1rem;
  background: #007acc;
  animation: cursor-blink 1s infinite;
}

@keyframes cursor-blink {
  0%, 50% {
    opacity: 1;
  }
  51%, 100% {
    opacity: 0;
  }
}

/* 高亮样式覆盖 - One Dark Pro 业界标准配色 */
:deep(.hljs) {
  background: #282c34 !important;
  color: #abb2bf !important;
  padding: 0 !important;
  border-radius: 0 !important;
}

/* One Dark Pro 语法高亮配色方案 */
:deep(.hljs-keyword) { color: #c678dd !important; font-weight: bold; }
:deep(.hljs-string) { color: #98c379 !important; }
:deep(.hljs-number) { color: #d19a66 !important; }
:deep(.hljs-comment) { color: #5c6370 !important; font-style: italic; }
:deep(.hljs-function) { color: #61afef !important; }
:deep(.hljs-variable) { color: #e06c75 !important; }
:deep(.hljs-operator) { color: #56b6c2 !important; }
:deep(.hljs-title) { color: #e06c75 !important; font-weight: bold; }
:deep(.hljs-params) { color: #abb2bf !important; }
:deep(.hljs-literal) { color: #56b6c2 !important; }
:deep(.hljs-type) { color: #e5c07b !important; }
:deep(.hljs-class) { color: #e5c07b !important; }
:deep(.hljs-attribute) { color: #d19a66 !important; }
:deep(.hljs-symbol) { color: #56b6c2 !important; }
:deep(.hljs-bullet) { color: #56b6c2 !important; }
:deep(.hljs-addition) { color: #98c379 !important; background-color: rgba(152, 195, 121, 0.2); }
:deep(.hljs-deletion) { color: #e06c75 !important; background-color: rgba(224, 108, 117, 0.2); }
:deep(.hljs-selector-tag) { color: #e06c75 !important; }
:deep(.hljs-selector-id) { color: #61afef !important; }
:deep(.hljs-selector-class) { color: #e5c07b !important; }
:deep(.hljs-selector-attr) { color: #c678dd !important; }
:deep(.hljs-selector-pseudo) { color: #c678dd !important; }
:deep(.hljs-template-tag) { color: #c678dd !important; }
:deep(.hljs-template-variable) { color: #c678dd !important; }
:deep(.hljs-built_in) { color: #e5c07b !important; }
:deep(.hljs-name) { color: #e06c75 !important; }
:deep(.hljs-tag) { color: #e06c75 !important; }
:deep(.hljs-attr) { color: #61afef !important; }

/* 响应式设计 */
@media (max-width: 768px) {
  .code-block-wrapper {
    margin: 0.5rem 0;
  }

  .code-block-content pre {
    padding: 0.75rem;
    font-size: 0.8rem;
  }
}
</style>
