<template>
  <div class="mode-selector">
    <div
      class="mode-selector-trigger"
      @click="toggleDropdown"
      :title="currentFrontLabel"
    >
      <div class="mode-selector-icon">
        <component :is="currentFrontIcon" />
      </div>
    </div>

    <div v-if="isDropdownOpen" class="mode-dropdown" :class="{ 'dropdown-bottom': dropdownPosition === 'bottom' }">
      <div class="mode-list">
        <!-- 裸模型（默认前台） -->
        <div
          class="mode-item"
          :class="{ 'selected': frontAgentRef === undefined }"
          @click="selectFront(undefined)"
        >
          <div class="mode-icon">
            <component :is="ChatIcon" />
          </div>
          <div class="mode-info">
            <div class="mode-name">裸模型</div>
            <div class="mode-hint">默认前台</div>
          </div>
        </div>
        <!-- 本地 Agent 模板（远程模板只能被 task 委派，不可选为前台） -->
        <div
          v-for="candidate in candidates"
          :key="candidate.type"
          class="mode-item"
          :class="{ 'selected': frontAgentRef === candidate.type }"
          @click="selectFront(candidate.type)"
        >
          <div class="mode-icon">
            <component :is="AgentIcon" />
          </div>
          <div class="mode-info">
            <div class="mode-name">{{ candidate.name }}</div>
            <div class="mode-hint">{{ candidate.type }}</div>
          </div>
          <button
            class="mode-settings-btn"
            @click.stop="openAgentSettings($event, candidate.type)"
            title="编辑该 Agent"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12A3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5a3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97c0-.33-.03-.65-.07-.97l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.08-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.32-.07.64-.07.97c0 .33.03.65.07.97l-2.11 1.63c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.39 1.06.73 1.69.98l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.25 1.17-.59 1.69-.98l2.49 1c.22.08.49 0 .61-.22l2-3.46c.13-.22.07-.49-.12-.64l-2.11-1.63Z"/>
            </svg>
          </button>
        </div>
        <div v-if="candidates.length === 0" class="mode-empty">
          暂无可选 Agent
          <button class="mode-new-agent-btn" @click.stop="openAgentEditor">+ 新建 Agent</button>
        </div>
      </div>
      <!-- 新建 Agent（使用现场入口：选了没有合适的，原地可建） -->
      <div v-if="candidates.length > 0" class="mode-new-agent-row">
        <button class="mode-new-agent-btn" @click.stop="openAgentEditor">+ 新建 Agent</button>
      </div>
      <!-- MCP 工具开关（内嵌下拉底部，原位） -->
      <div class="mcp-toggle-container">
        <MCPToolsToggle />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, h } from 'vue'
import type { AvailableSubagent } from '@assistant-ai/core'
import { getChatEngine, frontAgentRef, setFrontAgent } from '../services/chatEngine'
import MCPToolsToggle from './MCPToolsToggle.vue'

interface Props {
  /** 下拉展开方向：InputArea 底部入口向上展开（默认）；工作区面板顶部入口向下展开 */
  dropdownPosition?: 'top' | 'bottom'
}

withDefaults(defineProps<Props>(), {
  dropdownPosition: 'top'
})

const isDropdownOpen = ref(false)
const candidates = ref<AvailableSubagent[]>([])

// 定义emit事件
const emit = defineEmits<{
  'open-settings': [tab: string]
  /** 打开 Agent 编辑器：空载荷=新建；带 slug=编辑该模板（使用现场入口，管理也在现场） */
  'open-agent-editor': [payload?: { slug?: string }]
}>()

const ChatIcon = () => h('svg', {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2
}, [
  h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' })
])

const AgentIcon = () => h('svg', {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2
}, [
  h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }),
  h('circle', { cx: 9, cy: 10, r: 1.8, fill: 'currentColor', stroke: 'none' }),
  h('circle', { cx: 15, cy: 10, r: 1.8, fill: 'currentColor', stroke: 'none' })
])

/** 当前前台显示名（裸模型 / 模板名 · 生效模型(+来源标注)；数据源自引擎单一事实源） */
const currentFrontLabel = computed(() => {
  if (!frontAgentRef.value) return '裸模型'
  const display = getChatEngine().getFrontAgentDisplay()
  if (!display) return frontAgentRef.value
  const modelText = display.model
    ? ` · ${display.model}${display.modelSource === 'template' ? '（模板指定）' : ''}`
    : ''
  return `${display.name}${modelText}`
})

const currentFrontIcon = computed(() => (frontAgentRef.value ? AgentIcon : ChatIcon))

// 打开该模板的 Agent 编辑器（使用现场管理：齿轮不再跳设置页）
const openAgentSettings = (event: Event, slug?: string) => {
  event.stopPropagation()
  emit('open-agent-editor', slug ? { slug } : undefined)
  isDropdownOpen.value = false
}

// 新建 Agent（下拉底部入口 / 空态入口）：打开编辑器
const openAgentEditor = (event: Event) => {
  event.stopPropagation()
  emit('open-agent-editor')
  isDropdownOpen.value = false
}

const toggleDropdown = () => {
  if (!isDropdownOpen.value) {
    // 打开时刷新候选列表（模板可能经 Agent 工厂增删）
    candidates.value = getChatEngine().getFrontAgentCandidates()
  }
  isDropdownOpen.value = !isDropdownOpen.value
}

/** 选择前台（随 SessionRecord.frontAgent 持久化，跨端续聊一致） */
const selectFront = (type?: string) => {
  setFrontAgent(type)
  isDropdownOpen.value = false
}

const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as Element
  if (!target.closest('.mode-selector')) {
    isDropdownOpen.value = false
  }
}

onMounted(() => {
  candidates.value = getChatEngine().getFrontAgentCandidates()
  // 旧 CHAT/AGENT/ORCHESTRATOR/Auto 模式键已退役（模式即配置：前台选择取代之），顺手清理
  try { localStorage.removeItem('chat-mode') } catch { /* ignore */ }
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.mode-selector {
  position: relative;
  display: inline-block;
}

.mode-selector-trigger {
  display: flex;
  align-items: center;
  height: 24px;
  padding: 0px 0px 0px 4px;
  background-color: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
}

.mode-selector-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-secondary, #6b7280);
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.1) 0%, rgba(147, 197, 253, 0.1) 100%);
  border-radius: 6px;
  transition: all 0.2s ease;
}

.mode-selector-trigger:hover .mode-selector-icon {
  color: #3b82f6;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(147, 197, 253, 0.2) 100%);
  transform: scale(1.08);
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.25);
}

.mode-selector-trigger:active .mode-selector-icon {
  transform: scale(0.95);
}

.mode-selector-trigger:hover {
  color: var(--text-primary, #111827);
  background-color: var(--background-secondary, #f9fafb);
}

.mode-dropdown {
  position: absolute;
  bottom: 100%;
  right: 0;
  z-index: 100;
  width: 200px;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  margin-bottom: 4px;
  overflow: hidden;
}

.mode-dropdown.dropdown-bottom {
  bottom: auto;
  top: 100%;
  right: auto;
  left: 0;
  margin-bottom: 0;
  margin-top: 4px;
}

.mode-list {
  padding: 4px 0;
  max-height: 320px;
  overflow-y: auto;
}

.mode-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background-color 0.2s;
  border-bottom: 1px solid var(--border-color-light, #f3f4f6);
}

.mode-item:last-child {
  border-bottom: none;
}

.mode-item:hover {
  background-color: var(--background-secondary, #f9fafb);
}

.mode-item.selected {
  background-color: rgba(59, 130, 246, 0.1);
  border-left: 3px solid #3b82f6;
}

.mode-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--text-secondary, #6b7280);
}

.mode-item.selected .mode-icon {
  color: #3b82f6;
}

.mode-info {
  flex: 1;
  min-width: 0;
}

.mode-name {
  font-weight: 500;
  color: var(--text-primary, #111827);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mode-hint {
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mode-empty {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
}

/* MCP 工具开关容器（内嵌下拉底部） */
.mcp-toggle-container {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color, #e5e7eb);
}

.mode-settings-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  margin-left: 8px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary, #6b7280);
  transition: all 0.2s;
}

.mode-settings-btn:hover {
  background-color: var(--background-secondary, #f3f4f6);
  color: var(--text-primary, #111827);
}

.mode-item:hover .mode-settings-btn {
  color: var(--text-primary, #111827);
}

/* 新建 Agent 入口（下拉底部 / 空态） */
.mode-new-agent-row {
  padding: 4px 8px 6px;
  border-top: 1px solid var(--border-color, #e5e7eb);
}

.mode-new-agent-btn {
  width: 100%;
  text-align: left;
  font-size: 0.8125rem;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #8b5cf6;
  cursor: pointer;
  transition: background 0.15s;
}

.mode-new-agent-btn:hover {
  background: rgba(139, 92, 246, 0.08);
}
</style>
