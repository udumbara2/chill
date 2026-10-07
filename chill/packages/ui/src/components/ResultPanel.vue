<template>
  <div class="result-panel">
    <div class="result-content" :class="{ 'collapsed-mode': isCollapsedMode }" @wheel="handleWheel" ref="resultContentRef">
      <div v-if="contentBlocks.length === 0 && !isStreaming" class="empty-result">
        等待执行...
      </div>
      
      <div v-else class="content-blocks">
        <div 
          v-for="(block, index) in orderedBlocks" 
          :key="block.id"
          class="content-block"
        >
          <div v-if="block.type === 'reasoning'" class="reasoning-container">
            <div class="reasoning-header" @click="toggleReasoning(index)">
              <div class="reasoning-title">
                <svg class="reasoning-icon" :class="{ 'expanded': reasoningExpanded[index] }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
                <span>思考过程</span>
              </div>
            </div>
            <transition name="reasoning-content">
              <div 
                v-show="reasoningExpanded[index]" 
                class="reasoning-content"
                :style="{ maxHeight: reasoningMaxHeight }"
                :ref="el => setReasoningContainerRef(index, el)"
                @scroll="handleReasoningScroll(index, $event)"
              >
                <MessageMarkdown :content="block.content" :loading="false" />
              </div>
            </transition>
          </div>
          
          <div v-else-if="block.type === 'text'" class="text-content">
            <MessageMarkdown :content="block.content" :loading="false" :is-streaming="isStreaming" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import MessageMarkdown from './MessageMarkdown.vue'
import type { ContentBlock } from '@assistant-ai/core'

interface Props {
  contentBlocks?: ContentBlock[]
  resultType?: 'text' | 'file'
  isStreaming?: boolean
  reasoningExpanded?: Record<number, boolean>
  maxHeight?: string
  isCollapsedMode?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  contentBlocks: () => [],
  resultType: 'text',
  isStreaming: false,
  reasoningExpanded: () => ({}),
  maxHeight: '300px',
  isCollapsedMode: false
})

const emit = defineEmits<{
  'toggleReasoning': [index: number]
}>()

const resultContentRef = ref<HTMLElement | null>(null)

const userScrolledUp = ref(false)
const autoScrollEnabled = ref(true)
let scrollTimeout: NodeJS.Timeout | null = null

const reasoningContainers = ref<Map<number, HTMLElement>>(new Map())
const reasoningScrollStates = ref<Map<number, {
  userScrolledUp: boolean
  autoScrollEnabled: boolean
  lastScrollTop: number
}>>(new Map())

const setReasoningContainerRef = (index: number, el: any) => {
  if (el instanceof HTMLElement) {
    reasoningContainers.value.set(index, el)
    if (!reasoningScrollStates.value.has(index)) {
      reasoningScrollStates.value.set(index, {
        userScrolledUp: false,
        autoScrollEnabled: true,
        lastScrollTop: 0
      })
    }
  } else {
    reasoningContainers.value.delete(index)
    reasoningScrollStates.value.delete(index)
  }
}

const orderedBlocks = computed(() => {
  return [...props.contentBlocks].sort((a, b) => a.position - b.position)
})

const reasoningMaxHeight = computed(() => {
  const maxHeightValue = parseInt(props.maxHeight)
  if (isNaN(maxHeightValue)) return '300px'
  return `${Math.floor(maxHeightValue * 2 / 3)}px`
})

const toggleReasoning = (index: number) => {
  emit('toggleReasoning', index)
}

const handleWheel = (event: WheelEvent) => {
  event.stopPropagation()
}

const isNearBottom = (): boolean => {
  if (!resultContentRef.value) return false
  
  const container = resultContentRef.value
  const scrollTop = container.scrollTop
  const scrollHeight = container.scrollHeight
  const clientHeight = container.clientHeight
  const threshold = 100
  
  return (scrollHeight - scrollTop - clientHeight) <= threshold
}

const shouldAutoScroll = (): boolean => {
  return autoScrollEnabled.value && isNearBottom()
}

const scrollToBottom = () => {
  nextTick(() => {
    if (resultContentRef.value && shouldAutoScroll()) {
      resultContentRef.value.scrollTop = resultContentRef.value.scrollHeight
      
      if (userScrolledUp.value) {
        userScrolledUp.value = false
        autoScrollEnabled.value = true
      }
    }
  })
}

const handleScroll = () => {
  if (!resultContentRef.value) return
  
  const isNearBottomVal = isNearBottom()
  
  userScrolledUp.value = !isNearBottomVal
  
  if (scrollTimeout) {
    clearTimeout(scrollTimeout)
  }
  
  scrollTimeout = setTimeout(() => {
    if (isNearBottomVal) {
      autoScrollEnabled.value = true
    }
  }, 1000)
}

const scrollReasoningContentToBottom = (index: number) => {
  nextTick(() => {
    const reasoningContainer = reasoningContainers.value.get(index)
    const state = reasoningScrollStates.value.get(index)
    const mainContainer = resultContentRef.value
    
    if (!reasoningContainer || !state || !mainContainer) return
    
    if (!state.userScrolledUp || isReasoningNearBottom(reasoningContainer)) {
      reasoningContainer.scrollTop = reasoningContainer.scrollHeight
    }
    
    if (shouldAutoScroll()) {
      mainContainer.scrollTop = mainContainer.scrollHeight
    }
  })
}

const handleReasoningScroll = (index: number, event: Event) => {
  const container = event.target as HTMLElement
  const state = reasoningScrollStates.value.get(index)
  
  if (!state || !container) return
  
  const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50
  
  state.userScrolledUp = !isNearBottom
  state.lastScrollTop = container.scrollTop
  
  if (isNearBottom) {
    state.autoScrollEnabled = true
  }
}

const isReasoningNearBottom = (container: HTMLElement): boolean => {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 50
}

onMounted(() => {
  if (resultContentRef.value) {
    resultContentRef.value.addEventListener('scroll', handleScroll, { passive: true })
  }
})

onUnmounted(() => {
  if (resultContentRef.value) {
    resultContentRef.value.removeEventListener('scroll', handleScroll)
  }
  if (scrollTimeout) {
    clearTimeout(scrollTimeout)
  }
})

watch(() => props.contentBlocks, (newBlocks) => {
  const reasoningIndex = newBlocks.findIndex(b => b.type === 'reasoning')
  if (reasoningIndex !== -1) {
    scrollReasoningContentToBottom(reasoningIndex)
  } else {
    scrollToBottom()
  }
}, { deep: true })

watch(() => props.isStreaming, (isStreaming) => {
  if (isStreaming) {
    scrollToBottom()
  }
})
</script>

<style scoped>
.result-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.result-content {
  flex: 0 1 auto;
  overflow-y: auto;
  max-height: v-bind(maxHeight);
  padding: 8px;
  background-color: var(--background-secondary, #f9fafb);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  min-height: 80px;
}

.result-content.collapsed-mode {
  border: none;
  background-color: transparent;
  border-radius: 0;
  min-height: auto;
}

.empty-result {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary, #6b7280);
  font-size: 13px;
}

.text-result {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary, #111827);
}

.file-result {
  display: flex;
  align-items: center;
  gap: 8px;
}

.file-path {
  font-family: 'Courier New', monospace;
  font-size: 12px;
  color: var(--text-primary, #111827);
  word-break: break-all;
}

.content-blocks {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.content-block {
  display: flex;
  flex-direction: column;
}

.reasoning-container {
  overflow: hidden;
}

.reasoning-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s;
}

.reasoning-header:hover {
  background-color: var(--border-color, #e5e7eb);
  border-radius: 6px;
}

.reasoning-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary, #6b7280);
}

.reasoning-icon {
  width: 14px;
  height: 14px;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.reasoning-icon.expanded {
  transform: rotate(90deg);
}

.reasoning-content {
  padding: 12px;
  overflow-y: auto;
}

.reasoning-content-enter-active,
.reasoning-content-leave-active {
  transition: all 0.3s ease;
  opacity: 1;
}

.reasoning-content-enter-from,
.reasoning-content-leave-to {
  max-height: 0;
  opacity: 0;
}

.text-content {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary, #111827);
}
</style>
