<template>
  <div
    ref="dropdownRef"
    v-if="showList && filteredPrompts.length > 0"
    class="prompts-dropdown"
    :style="dropdownStyle"
  >

    <!-- Prompts列表 -->
    <div
      v-for="(prompt, index) in displayedPrompts"
      :key="prompt.name"
      class="prompt-item"
      :class="{ selected: selectedPromptIndex === index }"
      @click="selectPrompt(prompt)"
      @mouseenter="selectedPromptIndex = index"
    >
      <div class="prompt-name" v-html="highlightText(getDisplayText(prompt), searchKeyword)"></div>
      <div class="prompt-description" v-html="highlightText(prompt.description || '', searchKeyword)"></div>
      <div class="prompt-server">{{ formatServerName(prompt.serverName) }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
// import { getDisplayName } from '@modelcontextprotocol/sdk/shared/metadataUtils.js'

interface Prompt {
  name: string
  description?: string
  title?: string
  serverName: string
  serverId: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
  annotations?: { title?: string }
}

const props = withDefaults(defineProps<{
  prompts: Prompt[]
  showList: boolean
  searchKeyword?: string
  maxItems?: number
  targetElement?: HTMLTextAreaElement | null
}>(), {
  searchKeyword: '',
  maxItems: 10,
  targetElement: null
})

const emit = defineEmits<{
  (e: 'select-prompt', prompt: Prompt): void
  (e: 'close-list'): void
}>()

// CSS样式接口定义
 type DropdownStyles = Record<string, string | number>

// 状态管理
const selectedPromptIndex = ref(0)
const dropdownPosition = ref<'above' | 'below' | 'extended'>('above')
const dropdownStyle = ref<DropdownStyles>({})
// 下拉列表根元素引用（替代 document.querySelector，避免双实例串扰）
const dropdownRef = ref<HTMLElement | null>(null)

// 计算属性
const filteredPrompts = computed(() => {
  if (!props.searchKeyword) return props.prompts
  
  return props.prompts.filter(prompt => 
    prompt.name.toLowerCase().includes(props.searchKeyword.toLowerCase()) ||
    (prompt.description && prompt.description.toLowerCase().includes(props.searchKeyword.toLowerCase())) ||
    (prompt.title && prompt.title.toLowerCase().includes(props.searchKeyword.toLowerCase()))
  )
})

const displayedPrompts = computed(() => {
  // 移除数量限制，显示所有符合条件的prompts
  // 滚动条机制会处理高度限制
  return filteredPrompts.value
})

// 方法
const highlightText = (text: string, keyword: string) => {
  if (!keyword) return text
  const regex = new RegExp(`(${keyword})`, 'gi')
  return text.replace(regex, '<mark>$1</mark>')
}

// 获取显示文本（不包含服务器信息）
const getDisplayText = (prompt: Prompt) => {
  return prompt.title || prompt.name
}

// 格式化服务器名称（移除 mcp 前缀）
const formatServerName = (name: string): string => {
  if (!name) return ''
  return name.replace(/^mcp[-_]/i, '')
}

const selectPrompt = (prompt: Prompt) => {
  emit('select-prompt', prompt)
}

// 自动滚动到选中的prompt项
const scrollToSelectedItem = () => {
  const dropdownElement = dropdownRef.value
  const selectedElement = dropdownElement?.querySelector('.prompt-item.selected') as HTMLElement
  
  if (dropdownElement && selectedElement) {
    // 使用scrollIntoView确保选中的元素可见
    // behavior: 'smooth' 提供平滑滚动效果
    // block: 'nearest' 确保元素滚动到最近的可视位置
    selectedElement.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest'
    })
  }
}



// 智能定位算法：根据屏幕空间动态决定显示位置
const calculateOptimalPosition = () => {
  // 使用传入的targetElement进行精确定位
  const targetElement = props.targetElement
  
  if (!targetElement) {
    console.warn('PromptsList: targetElement未找到或为null')
  }
  
  if (!targetElement) {
    // ===== DEBUG: 进入fallback模式 =====
    // 如果没有传入targetElement，尝试DOM查询作为后备
    const dropdownElement = dropdownRef.value
    if (!dropdownElement) {
      return
    }
    
    const inputContainer = dropdownElement.closest('.input-area')
    if (!inputContainer) {
      return
    }
    
    const rect = inputContainer.getBoundingClientRect()
    positionDropdown(rect) // 容器模式
    return
  }
  
  // 获取目标元素的边界信息
  const rect = targetElement.getBoundingClientRect()
  positionDropdown(rect) // 元素模式
}

const positionDropdown = (rect: DOMRect) => {
  // 查找聊天区域容器和 textarea 元素
  const chatSection = document.querySelector('.chat-section') as HTMLElement
  const textareaElement = props.targetElement
  
  if (!chatSection || !textareaElement) {
    // 如果找不到聊天区域或输入框元素，使用原来的定位逻辑作为后备
    positionDropdownDefault(rect)
    return
  }
  
  // 获取聊天区域的边界信息
  const chatRect = chatSection.getBoundingClientRect()
  const textareaRect = textareaElement.getBoundingClientRect()
  
  // 计算聊天区域高度的2/3作为最大高度限制
  const chatSectionHeight = chatRect.height
  const maxHeight = Math.floor(chatSectionHeight * 2 / 3)
  
  // 新的定位算法：prompt list在输入框上方，向上延伸
  dropdownPosition.value = 'extended'
  
  // 相对于chat-section容器定位（因为容器有transform）
  const containerLeft = textareaRect.left - chatRect.left
  const containerTop = textareaRect.top - chatRect.top
  
  // 先不显示元素，等计算出位置后再显示
  dropdownStyle.value = {
    position: 'absolute',
    // 调整为输入框左上方位置
    left: `${containerLeft - 20}px`, // 向左偏移20px，让它显示在左上方
    // 初始位置设置为不可见区域，等计算完成后再定位
    top: `-9999px`, // 设置为不可见区域
    // 高度设为0，先不显示，等计算完成后再设置
    height: '0px',
    // 宽度优化：比输入框稍窄，更紧凑
    width: `${Math.max(280, Math.min(350, textareaRect.width - 40))}px`,
    maxWidth: 'none',
    maxHeight: `${maxHeight}px`, // 添加最大高度限制
    zIndex: 10000,
    // 现代化美化效果
    borderRadius: '12px', // 更大的圆角，更现代
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08)' // 多层阴影，更立体
  }
  
  // 使用setTimeout延迟检查，等待DOM更新后计算实际高度
  setTimeout(() => {
    // 查找prompt list元素
    const dropdownElement = dropdownRef.value
    if (dropdownElement) {
      // 获取实际高度（没有限制时的自然高度）
      const naturalHeight = dropdownElement.scrollHeight
      
      // 应用高度限制：如果实际内容超过最大高度，使用最大高度并显示滚动条
      const finalHeight = Math.min(naturalHeight, maxHeight)
      const needsScrollbar = naturalHeight > maxHeight
      
      // 计算组件的最终位置，确保底部紧贴输入框上框线
      const finalTop = containerTop - finalHeight - 8
      
      // 直接定位到最终位置，让列表从输入框上方开始向上延伸
      dropdownStyle.value = {
        ...dropdownStyle.value,
        height: `${finalHeight}px`,
        top: `${finalTop}px`,
        overflowY: needsScrollbar ? 'auto' : 'visible' // 根据需要显示滚动条
      }
    }
  }, 50) // 延迟50ms执行，确保DOM更新完成
}

// 默认定位算法（作为后备）
const positionDropdownDefault = (rect: DOMRect) => {
  const viewportHeight = window.innerHeight
  
  // 计算相对于目标元素的可用空间
  const spaceBelow = viewportHeight - rect.bottom
  const spaceAbove = rect.top
  
  // 预估的prompt list高度
  const estimatedDropdownHeight = 350
  
  // 决策逻辑：优先下方显示，避免遮挡
  const shouldShowBelow = spaceBelow >= estimatedDropdownHeight && spaceBelow > spaceAbove
  const shouldShowAbove = spaceBelow < estimatedDropdownHeight && spaceAbove > 350
  
  if (shouldShowBelow) {
    // 显示在下方
    dropdownPosition.value = 'below'
    dropdownStyle.value = {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.bottom + 8}px`,
      width: `${rect.width}px`,
      maxWidth: 'none',
      zIndex: 10000
    }
  } else if (shouldShowAbove) {
    // 显示在上方
    dropdownPosition.value = 'above'
    dropdownStyle.value = {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top - 350 - 8}px`, // 预估高度 + 边距
      width: `${rect.width}px`,
      maxWidth: 'none',
      zIndex: 10000
    }
  } else {
    // 默认显示在上方（保持原有行为）
    dropdownPosition.value = 'above'
    dropdownStyle.value = {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top - 350 - 8}px`,
      width: `${rect.width}px`,
      maxWidth: 'none',
      zIndex: 10000
    }
  }
}

const handleKeyDown = (event: KeyboardEvent) => {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      if (selectedPromptIndex.value < displayedPrompts.value.length - 1) {
        selectedPromptIndex.value++
        // 自动滚动到新选中的项
        scrollToSelectedItem()
      }
      break
    case 'ArrowUp':
      event.preventDefault()
      if (selectedPromptIndex.value > 0) {
        selectedPromptIndex.value--
        // 自动滚动到新选中的项
        scrollToSelectedItem()
      }
      break
    case 'Enter':
      event.preventDefault()
      if (selectedPromptIndex.value >= 0 && selectedPromptIndex.value < displayedPrompts.value.length) {
        selectPrompt(displayedPrompts.value[selectedPromptIndex.value])
      }
      break
    case 'Escape':
      event.preventDefault()
      emit('close-list')
      break
    case 'Tab':
      event.preventDefault()
      // 保持焦点在textarea上，防止Tab键转移焦点
      // 让textarea重新获得焦点，确保上下键继续工作
      nextTick(() => {
        const textareaElement = document.querySelector('.input-area textarea') as HTMLTextAreaElement
        if (textareaElement) {
          textareaElement.focus()
        }
      })
      break
  }
}

// 监听props变化，重置选择状态
watch(() => props.searchKeyword, () => {
  selectedPromptIndex.value = 0
  // 重置选择时不需要滚动
})

// 监听selectedPromptIndex变化，自动滚动到选中项
watch(selectedPromptIndex, () => {
  // 使用nextTick确保DOM更新后再滚动
  nextTick(() => {
    scrollToSelectedItem()
  })
})

// 监听列表显示状态，重新计算位置
watch(() => props.showList, async (newShowList) => {
  if (newShowList) {
    // 使用nextTick确保DOM已经渲染
    await nextTick()
    
    // 先隐藏元素，避免闪烁
    dropdownStyle.value = {
      ...dropdownStyle.value,
      opacity: '0',
      visibility: 'hidden',
      pointerEvents: 'none' // 防止交互
    }
    
    // 等待下一帧渲染，确保隐藏状态生效
    requestAnimationFrame(() => {
      // 再进行定位计算
      calculateOptimalPosition()
      
      // 在下一帧显示元素
      requestAnimationFrame(() => {
        dropdownStyle.value = {
          ...dropdownStyle.value,
          opacity: '1',
          visibility: 'visible',
          pointerEvents: 'auto' // 恢复交互
        }
      })
    })
  } else {
    // 隐藏时设置为不可见状态
    dropdownStyle.value = {
      ...dropdownStyle.value,
      opacity: '0',
      visibility: 'hidden',
      pointerEvents: 'none' // 防止交互
    }
  }
})

// 监听targetElement变化，重新计算位置
watch(() => props.targetElement, async (newTargetElement) => {
  if (props.showList && newTargetElement) {
    await nextTick()
    calculateOptimalPosition()
  }
})

// 监听筛选结果变化，重新计算高度（修复空白问题）
watch(() => filteredPrompts.value.length, async () => {
  if (props.showList) {
    await nextTick()
    // 延迟计算高度，等待DOM更新
    setTimeout(() => {
      calculateOptimalPosition()
    }, 10)
  }
})

// 组件挂载时计算位置
onMounted(() => {
  if (props.showList) {
    calculateOptimalPosition()
  }
})

// 监听窗口大小变化，重新计算位置
const handleResize = () => {
  if (props.showList) {
    calculateOptimalPosition()
  }
}

onMounted(() => {
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
})

defineExpose({
  handleKeyDown
})
</script>

<style scoped>
/* 复用McpConfig.vue中的样式，确保UI一致性 */
.prompts-dropdown {
  position: absolute; /* 使用绝对定位，让JavaScript控制位置 */
  background: rgba(255, 255, 255, 0.25); /* 更强的透明效果，可以透过看到背景 */
  backdrop-filter: blur(4px); /* 减少毛玻璃效果，保持内容可读 */
  -webkit-backdrop-filter: blur(4px); /* Safari兼容 */
  border: 1px solid rgba(255, 255, 255, 0.25); /* 更透明的边框 */
  border-radius: 12px; /* 与JavaScript保持一致 */
  overflow-y: auto; /* 默认显示滚动条，防止内容溢出 */
  z-index: 10000; /* 提高层级，确保在最上层 */
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08); /* 增强阴影效果 */
  /* 动态高度控制，JavaScript会设置具体的高度值与最大高度（不超过聊天区域高度的2/3） */
  height: auto;
}

/* Prompts列表 - 优化样式，更简约紧凑 */
.prompt-item {
  padding: 8px 12px; /* 减少内边距，更紧凑 */
  cursor: pointer;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08); /* 使用更透明的边框 */
  /* 简单的过渡效果，避免复杂动画 */
  transition: background-color 0.15s ease;
}

.prompt-item:last-child {
  border-bottom: none;
}

.prompt-item:hover {
  background-color: rgba(255, 255, 255, 0.4); /* 在透明背景下更明显的悬停效果 */
}

/* 统一选中状态样式，现代化设计 */
.prompt-item.selected {
  background: linear-gradient(135deg, var(--vscode-accent-color, #007acc), #0ea5e9); /* 渐变选中背景 */
  color: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); /* 微妙的阴影效果 */
  border-left: 3px solid rgba(255, 255, 255, 0.8); /* 白色左边框，更突出 */
  padding-left: 13px; /* 减少左边距以保持总宽度一致 */
}

/* 确保键盘导航时有清晰的视觉反馈 */
.prompt-item:focus {
  outline: none;
  box-shadow: 0 0 0 2px var(--vscode-focusBorder, #007fd4);
}

/* 添加平滑过渡效果 */
.prompt-item {
  transition: all 0.15s ease;
}

.prompt-name {
  font-weight: 500; /* 减少字重，更简约 */
  font-size: 13px; /* 稍小一点的字体 */
  color: var(--vscode-foreground, #1f2937); /* 更深的颜色，提高在透明背景上的可读性 */
  margin-bottom: 2px; /* 减少间距，更紧凑 */
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.7); /* 添加白色阴影，帮助在透明背景上可读 */
}

/* 选中状态下提示名称的颜色 */
.prompt-item.selected .prompt-name {
  color: #ffffff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); /* 微妙的文字阴影 */
}

.prompt-description {
  font-size: 12px; /* 稍小一点的字体 */
  color: var(--vscode-descriptionForeground, #4b5563); /* 使用更深的描述颜色，提高在透明背景上的可读性 */
  margin-bottom: 2px; /* 减少间距，更紧凑 */
  line-height: 1.3; /* 稍微紧凑的行高 */
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.7); /* 添加白色阴影，帮助在透明背景上可读 */
}

/* 选中状态下描述文字的颜色 */
.prompt-item.selected .prompt-description {
  color: rgba(255, 255, 255, 0.9);
}

.prompt-server {
  font-size: 11px; /* 更小的字体，更简约 */
  color: var(--vscode-charts-blue, #3b82f6);
  font-weight: 500;
}

/* 选中状态下服务器名称的颜色 */
.prompt-item.selected .prompt-server {
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); /* 微妙的文字阴影 */
}

/* 高亮匹配文本 - 复用McpConfig.vue中的样式 */
:deep(mark) {
  background-color: var(--vscode-textBlockQuote-background, #f3f4f6);
  color: var(--vscode-textBlockQuote-border, #d1d5db);
  border-radius: 2px;
  padding: 0 2px;
  font-weight: 600;
}

/* 简单的动画效果，避免复杂动画 */
@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 滚动条样式 */
.prompts-dropdown::-webkit-scrollbar {
  width: 6px;
}

.prompts-dropdown::-webkit-scrollbar-track {
  background: var(--vscode-editor-background);
}

.prompts-dropdown::-webkit-scrollbar-thumb {
  background-color: var(--vscode-scrollbarSlider-background);
  border-radius: 3px;
}

.prompts-dropdown::-webkit-scrollbar-thumb:hover {
  background-color: var(--vscode-scrollbarSlider-hoverBackground, #c5c5c5);
}

/* 响应式设计 - 直接实现，避免复杂媒体查询 */
@media (max-width: 768px) {
  .prompts-dropdown {
    border-radius: 6px;
    /* 移除max-height，让JavaScript控制高度 */
  }
  
  .prompt-item {
    padding: 10px 12px;
  }
  
  .prompt-description {
    font-size: 12px;
  }
}
</style>