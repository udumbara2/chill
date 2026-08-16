<template>
  <div class="tool-node" :class="[nodeStatusClass, { 'node-collapsed': isCollapsed, 'node-selected': props.selected }]">
    <div class="node-header">
      <div class="node-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
      </div>
      <NodeTitle 
        :title="nodeTitle" 
        @update:title="handleTitleUpdate"
      />
      <div class="node-header-right">
        <button 
          class="collapse-button" 
          @click="toggleCollapse"
          :title="isCollapsed ? '展开' : '折叠'"
        >
          <svg v-if="!isCollapsed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div class="node-status" :class="statusClass">
          {{ statusText }}
        </div>
        <button 
          v-show="!isCollapsed"
          class="execute-button" 
          @click="handleExecute"
          :disabled="selectedTools.length === 0 || nodeStatus === 'running'"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </button>
      </div>
    </div>
    
    <div class="node-content" v-show="!isCollapsed">
      <div class="tool-params-container">
        <div class="add-tool-section">
          <button 
            class="add-tool-button" 
            @click.stop="toggleAddToolDropdown"
            :class="{ 'open': isAddToolDropdownOpen }"
            title="添加工具"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
          
          <div class="add-tool-dropdown" v-if="isAddToolDropdownOpen" v-click-outside-tool-node="closeAddToolDropdown">
            <div class="dropdown-header">
              <span class="dropdown-title">选择工具</span>
              <button class="close-button" @click="closeAddToolDropdown">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <div class="dropdown-content" @wheel.stop>
              <div v-if="isToolsLoading" class="loading-text">加载中...</div>
              <div v-else-if="availableTools.length === 0" class="empty-text">没有可用工具</div>
              <div v-else class="tool-list-container">
                <label 
                  v-for="tool in availableToolsForSelection" 
                  :key="tool.function.name"
                  class="tool-item"
                >
                  <input 
                    type="checkbox" 
                    :value="tool.function.name"
                    :checked="isToolSelected(tool.function.name)"
                    @change="toggleToolSelection(tool)"
                    class="tool-checkbox"
                  />
                  <div class="tool-info">
                    <div class="tool-name">{{ tool.function.name }}</div>
                    <div class="tool-description">{{ tool.function.description }}</div>
                  </div>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="tool-execution-flow" v-if="selectedTools.length > 0">
          <div v-if="selectedTools.length > 1" class="serial-execution-hint">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>按从上到下的顺序依次执行</span>
          </div>
          <div class="tool-params-list">
            <div 
              v-for="(tool, index) in selectedTools" 
              :key="tool.function.name"
              class="tool-param-item"
            >
              <div class="tool-param-header">
                <span class="tool-param-index">{{ index + 1 }}</span>
                <span class="tool-param-name">{{ tool.function.name }}</span>
                <button 
                  class="remove-tool-button" 
                  @click="removeTool(tool)"
                  title="删除此工具"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
              <ToolParamsForm
                :tool="tool"
                :tool-index="index"
                :selected-tools="selectedTools"
                :state="currentState"
                :upstream-node="upstreamNode"
                v-model="toolParams[tool.function.name]"
              />
            </div>
          </div>
          <div class="tool-result-container">
            <div class="tool-result-header">
              <span class="tool-result-icon">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="4 17 10 11 4 5"/>
                  <line x1="12" y1="19" x2="20" y2="19"/>
                </svg>
              </span>
              <span class="tool-param-name">执行结果</span>
              <div class="result-actions">
                <button 
                  v-if="contentBlocks.length > 0" 
                  class="expand-button" 
                  @click.stop="isResultModalOpen = true"
                  title="扩展查看"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="15 3 21 3 21 9"/>
                    <polyline points="9 21 3 21 3 15"/>
                    <line x1="21" y1="3" x2="14" y2="10"/>
                    <line x1="3" y1="21" x2="10" y2="14"/>
                  </svg>
                </button>
                <button 
                  v-if="contentBlocks.length > 0" 
                  class="clear-button" 
                  @click.stop="handleClear"
                  title="清空结果"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>
            <ResultPanel 
              :content-blocks="contentBlocks"
              :result-type="resultType"
              :is-streaming="nodeStatus === 'running'"
              :reasoning-expanded="reasoningExpanded"
              @toggle-reasoning="toggleReasoning"
            />
          </div>
        </div>
      </div>
    </div>
    
    <div v-if="isCollapsed && collapsedContentBlocks.length > 0" class="collapsed-result">
      <button 
        class="collapsed-expand-button" 
        @click.stop="isResultModalOpen = true"
        title="扩展查看"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 3 21 3 21 9"/>
          <polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/>
          <line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
      </button>
      <button 
        class="collapsed-clear-button" 
        @click.stop="handleCollapsedClear"
        title="清空结果"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <ResultPanel 
        :content-blocks="collapsedContentBlocks"
        :result-type="resultType"
        :is-streaming="nodeStatus === 'running'"
        :reasoning-expanded="reasoningExpanded"
        :max-height="'300px'"
        :is-collapsed-mode="true"
        @toggle-reasoning="toggleReasoning"
      />
    </div>
    
    <ResultModal 
      :is-open="isResultModalOpen"
      :title="`${nodeTitle} - 执行结果`"
      :modal-id="modalId"
      @close="isResultModalOpen = false"
    >
      <ResultPanel 
        :content-blocks="contentBlocks"
        :result-type="resultType"
        :is-streaming="nodeStatus === 'running'"
        :reasoning-expanded="reasoningExpanded"
        :max-height="'388px'"
        @toggle-reasoning="toggleReasoning"
      />
    </ResultModal>
    
    <Handle type="target" id="tool-target" :position="Position.Left" />
    <Handle type="source" id="tool-source" :position="Position.Right" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, inject, type Ref } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import type { NodeProps } from '@vue-flow/core'
import NodeTitle from './NodeTitle.vue'
import ToolParamsForm from './ToolParamsForm.vue'
import ResultPanel from './ResultPanel.vue'
import ResultModal from './ResultModal.vue'
import type { ToolDefinition, Message, ContentBlock, NamespacedWorkflowEventBus, ToolNodeData, WorkflowNode } from '@assistant-ai/core'
import { MessageRole, ContentBlockType, workflowEventBus, WORKFLOW_EVENTS, MCPService } from '@assistant-ai/core'
import { useWorkflowStore } from '../stores/workflowStore'

interface WorkflowContext {
  workflowId: string
  eventBus: NamespacedWorkflowEventBus
  getUpstreamNode?: (nodeId: string) => WorkflowNode | null
}

const props = defineProps<NodeProps<ToolNodeData>>()

const workflowStore = useWorkflowStore()

const nodeTitle = ref(props.data.label || '工具节点')
const selectedTools = ref<ToolDefinition[]>([])
const toolParams = ref<Record<string, any>>({})
const nodeStatus = ref<'idle' | 'running' | 'completed' | 'error'>('idle')
const resultType = ref<'text' | 'file'>('text')
const contentBlocks = ref<ContentBlock[]>([])
const collapsedContentBlocks = ref<ContentBlock[]>([])
const reasoningExpanded = ref<Record<number, boolean>>({})
const reasoningUserProtected = ref<Record<number, boolean>>({})
const hasExistingReasoning = ref(false)
const isResultModalOpen = ref(false)
const currentState = ref<any>(null)

const mcpService = new MCPService()
const availableTools = ref<ToolDefinition[]>([])
const isToolsLoading = ref(false)
const isAddToolDropdownOpen = ref(false)

const injectedContext = inject<WorkflowContext | Ref<WorkflowContext> | undefined>('workflowContext', undefined)

const workflowContext = computed<WorkflowContext | undefined>(() => {
  if (!injectedContext) return undefined
  if ('value' in injectedContext) {
    return (injectedContext as Ref<WorkflowContext>).value
  }
  return injectedContext as WorkflowContext
})

const eventBus = computed(() => {
  if (workflowContext.value?.eventBus) {
    return workflowContext.value.eventBus
  }
  return workflowEventBus
})

const upstreamNode = computed<WorkflowNode | null>(() => {
  return workflowContext.value?.getUpstreamNode?.(props.id) || null
})

let currentEventBusInstance: NamespacedWorkflowEventBus | typeof workflowEventBus = eventBus.value
const isCollapsed = ref(props.data.isCollapsed !== undefined ? props.data.isCollapsed : true)
const modalId = computed(() => `result-modal-${props.id}`)

const statusClass = computed(() => `status-${nodeStatus.value}`)

const nodeStatusClass = computed(() => `node-${nodeStatus.value}`)

const statusText = computed(() => {
  const statusMap: Record<string, string> = {
    idle: '就绪',
    running: '运行中',
    completed: '完成',
    error: '错误'
  }
  return statusMap[nodeStatus.value] || '未知'
})

const availableToolsForSelection = computed(() => {
  return availableTools.value
})

const isToolSelected = (toolName: string): boolean => {
  return selectedTools.value.some(t => t.function.name === toolName)
}

const loadAvailableTools = async () => {
  isToolsLoading.value = true
  try {
    availableTools.value = await mcpService.getAggregatedOpenAITools()
  } catch (error) {
    console.error('Failed to load tools:', error)
    availableTools.value = []
  } finally {
    isToolsLoading.value = false
  }
}

const toggleAddToolDropdown = () => {
  if (!isAddToolDropdownOpen.value) {
    loadAvailableTools()
  }
  isAddToolDropdownOpen.value = !isAddToolDropdownOpen.value
}

const closeAddToolDropdown = () => {
  isAddToolDropdownOpen.value = false
}

const toggleToolSelection = (tool: ToolDefinition) => {
  const toolName = tool.function.name
  if (isToolSelected(toolName)) {
    selectedTools.value = selectedTools.value.filter(t => t.function.name !== toolName)
    delete toolParams.value[toolName]
  } else {
    selectedTools.value = [...selectedTools.value, tool]
  }
}

const removeTool = (tool: ToolDefinition) => {
  selectedTools.value = selectedTools.value.filter(t => t.function.name !== tool.function.name)
  delete toolParams.value[tool.function.name]
}

const handleTitleUpdate = (newTitle: string) => {
  nodeTitle.value = newTitle
  props.data.label = newTitle
}

const handleExecute = async () => {
  if (selectedTools.value.length === 0) return

  nodeStatus.value = 'running'
  resultType.value = 'text'
  contentBlocks.value = []
  collapsedContentBlocks.value = []
  reasoningExpanded.value = {}
  reasoningUserProtected.value = {}
  hasExistingReasoning.value = false

  const config = {
    selectedTools: selectedTools.value,
    toolParams: toolParams.value
  }

  const messages: Message[] = []

  try {
    if (props.data?.onExecute) {
      await props.data.onExecute(props.id, config, messages)
      nodeStatus.value = 'completed'
    }
  } catch (error) {
    console.error('Execution error:', error)
    nodeStatus.value = 'error'
  }
}

const handleStreamChunk = (data: { nodeId: string, chunk: any }) => {
  if (data.nodeId === props.id) {
    const reasoningIndex = 0
    
    if (data.chunk.reasoningContent) {
      const blocks = [...contentBlocks.value]
      const reasoningBlock = blocks.find(b => b.type === ContentBlockType.REASONING)
      if (reasoningBlock) {
        reasoningBlock.content += data.chunk.reasoningContent
      } else {
        blocks.push({
          id: `reasoning-${Date.now()}`,
          type: ContentBlockType.REASONING,
          position: 0,
          content: data.chunk.reasoningContent
        })
        reasoningExpanded.value[reasoningIndex] = true
        hasExistingReasoning.value = true
      }
      contentBlocks.value = blocks
    } else {
      if (hasExistingReasoning.value) {
        if (!reasoningUserProtected.value[reasoningIndex]) {
          reasoningExpanded.value[reasoningIndex] = false
        }
        hasExistingReasoning.value = false
      }
    }
    
    if (data.chunk.content) {
      const blocks = [...contentBlocks.value]
      const textBlock = blocks.find(b => b.type === ContentBlockType.TEXT)
      if (textBlock) {
        textBlock.content += data.chunk.content
      } else {
        blocks.push({
          id: `text-${Date.now()}`,
          type: ContentBlockType.TEXT,
          position: 1,
          content: data.chunk.content
        })
      }
      contentBlocks.value = blocks
    }
  }
}

const handleClear = () => {
  resultType.value = 'text'
  contentBlocks.value = []
  collapsedContentBlocks.value = []
  reasoningExpanded.value = {}
  reasoningUserProtected.value = {}
  hasExistingReasoning.value = false
  nodeStatus.value = 'idle'
  props.data.executionResult = undefined
}

const handleCollapsedClear = () => {
  collapsedContentBlocks.value = []
}

const toggleReasoning = (index: number) => {
  reasoningExpanded.value[index] = !reasoningExpanded.value[index]
  reasoningUserProtected.value[index] = true
}

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
  props.data.isCollapsed = isCollapsed.value
}

const initializeFromProps = () => {
  nodeTitle.value = props.data.label || '工具节点'
  selectedTools.value = props.data.selectedTools || []
  toolParams.value = props.data.toolParams || {}
  isCollapsed.value = props.data.isCollapsed !== undefined ? props.data.isCollapsed : true

  if (props.data.executionResult) {
    nodeStatus.value = props.data.executionResult.nodeStatus
    resultType.value = props.data.executionResult.resultType
    contentBlocks.value = props.data.executionResult.contentBlocks || []
    collapsedContentBlocks.value = props.data.executionResult.contentBlocks || []
  } else {
    nodeStatus.value = 'idle'
    resultType.value = 'text'
    contentBlocks.value = []
    collapsedContentBlocks.value = []
    reasoningExpanded.value = {}
    reasoningUserProtected.value = {}
    hasExistingReasoning.value = false
  }
}

onMounted(async () => {
  initializeFromProps()

  currentEventBusInstance = eventBus.value

  currentEventBusInstance.on(WORKFLOW_EVENTS.STREAM_CHUNK, handleStreamChunk)
  currentEventBusInstance.on(WORKFLOW_EVENTS.STREAM_ERROR, handleStreamError)
  currentEventBusInstance.on(WORKFLOW_EVENTS.STREAM_COMPLETE, handleStreamComplete)
  currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
  currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
  
  try {
    currentState.value = await workflowStore.getCurrentState()
  } catch (error) {
    console.warn('Failed to get current state:', error)
  }
})

watch(() => props.data, (newData, oldData) => {
  if (newData !== oldData) {
    initializeFromProps()
  }
}, { immediate: true, deep: true })

onUnmounted(() => {
  currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_CHUNK, handleStreamChunk)
  currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_ERROR, handleStreamError)
  currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_COMPLETE, handleStreamComplete)
  currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
  currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
})

watch(() => workflowContext.value?.workflowId, (newWorkflowId, oldWorkflowId) => {
  if (newWorkflowId && newWorkflowId !== oldWorkflowId) {
    currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_CHUNK, handleStreamChunk)
    currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_ERROR, handleStreamError)
    currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_COMPLETE, handleStreamComplete)
    currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
    currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)

    currentEventBusInstance = eventBus.value

    currentEventBusInstance.on(WORKFLOW_EVENTS.STREAM_CHUNK, handleStreamChunk)
    currentEventBusInstance.on(WORKFLOW_EVENTS.STREAM_ERROR, handleStreamError)
    currentEventBusInstance.on(WORKFLOW_EVENTS.STREAM_COMPLETE, handleStreamComplete)
    currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
    currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
  }
})

const handleStreamError = (data: { nodeId: string, error: any }) => {
  if (data.nodeId === props.id) {
    nodeStatus.value = 'error'
    const blocks = [...contentBlocks.value]
    blocks.push({
      id: `error-${Date.now()}`,
      type: ContentBlockType.TEXT,
      position: blocks.length,
      content: `执行错误: ${data.error instanceof Error ? data.error.message : '未知错误'}`
    })
    contentBlocks.value = blocks
  }
}

const handleStreamComplete = (data: { nodeId: string, finalContent: string }) => {
  if (data.nodeId === props.id) {
    nodeStatus.value = 'completed'
  }
}

const handleNodeStarted = (data: { nodeId: string }) => {
  if (data.nodeId === props.id) {
    nodeStatus.value = 'running'
    resultType.value = 'text'
    contentBlocks.value = []
    collapsedContentBlocks.value = []
    reasoningExpanded.value = {}
    reasoningUserProtected.value = {}
    hasExistingReasoning.value = false
  }
}

const handleNodeCompleted = (data: { nodeId: string; result?: any; values?: any }) => {
  if (data.nodeId === props.id) {
    nodeStatus.value = 'completed'
    
    if (data.result && data.result.messages) {
      const messages = data.result.messages
      const toolMessages = messages.filter((msg: any) => msg.role === 'tool')
      
      if (toolMessages.length > 0) {
        const blocks: ContentBlock[] = []
        toolMessages.forEach((msg: any, index: number) => {
          blocks.push({
            id: `tool-result-${index}`,
            type: ContentBlockType.TEXT,
            position: index,
            content: msg.content || '(无返回内容)'
          })
        })
        contentBlocks.value = blocks
      }
    }
  }
}

watch([selectedTools, toolParams], () => {
  props.data.selectedTools = selectedTools.value
  props.data.toolParams = toolParams.value
}, { deep: true })

watch(contentBlocks, (newBlocks) => {
  collapsedContentBlocks.value = JSON.parse(JSON.stringify(newBlocks))
}, { deep: true })

watch([nodeStatus, contentBlocks, resultType], () => {
  if (nodeStatus.value === 'completed' || nodeStatus.value === 'error') {
    props.data.executionResult = {
      nodeStatus: nodeStatus.value,
      resultType: resultType.value,
      contentBlocks: JSON.parse(JSON.stringify(contentBlocks.value))
    }
  }
}, { deep: true })

defineExpose({
  selectedTools,
  toolParams
})

const vClickOutsideToolNode = {
  mounted(el: HTMLElement, binding: any) {
    const clickOutsideHandler = (event: MouseEvent) => {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value()
      }
    }
    ;(el as any)._clickOutsideToolNode = clickOutsideHandler
    document.addEventListener('click', clickOutsideHandler)
  },
  unmounted(el: HTMLElement) {
    const handler = (el as any)._clickOutsideToolNode
    if (handler) {
      document.removeEventListener('click', handler)
    }
  }
}
</script>

<style scoped>
.tool-node {
  width: 280px;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.tool-node.node-selected {
  border-color: #8b5cf6;
  box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.2);
}

.tool-node.node-collapsed {
  width: auto;
  min-width: 120px;
  max-width: 300px;
  position: relative;
}

.node-running {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.node-completed {
  border-color: #10b981;
}

.node-error {
  border-color: #ef4444;
}

.node-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  gap: 8px;
}

.node-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, #6b7280);
}

.node-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.collapse-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-secondary, #6b7280);
  border-radius: 4px;
}

.collapse-button:hover {
  background-color: var(--background-hover, #f3f4f6);
}

.node-status {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.status-idle {
  background-color: var(--background-secondary, #f3f4f6);
  color: var(--text-secondary, #6b7280);
}

.status-running {
  background-color: #dbeafe;
  color: #3b82f6;
}

.status-completed {
  background-color: #d1fae5;
  color: #10b981;
}

.status-error {
  background-color: #fee2e2;
  color: #ef4444;
}

.execute-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background-color: #8b5cf6;
  color: white;
  cursor: pointer;
  border-radius: 4px;
}

.execute-button:hover:not(:disabled) {
  background-color: #7c3aed;
}

.execute-button:disabled {
  background-color: var(--background-secondary, #f3f4f6);
  color: var(--text-tertiary, #9ca3af);
  cursor: not-allowed;
}

.node-content {
  padding: 10px;
}

.node-section {
  margin-bottom: 8px;
}

.section-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary, #9ca3af);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tool-params-container {
  min-height: 40px;
}

.add-tool-section {
  position: relative;
  margin-bottom: 8px;
  display: flex;
  justify-content: center;
}

.add-tool-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background-color: transparent;
  color: var(--text-tertiary, #9ca3af);
  border: 1px solid var(--border-color-light, #e5e7eb);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.add-tool-button:hover {
  background-color: rgba(59, 130, 246, 0.04);
  color: var(--primary-color, #3b82f6);
  border-color: rgba(59, 130, 246, 0.3);
}

.add-tool-button.open {
  background-color: rgba(59, 130, 246, 0.06);
  border-color: rgba(59, 130, 246, 0.3);
  color: var(--primary-color, #3b82f6);
}

.add-tool-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  min-width: 280px;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color-light, #e5e7eb);
  border-radius: 8px;
  box-shadow: 
    0 4px 6px -1px rgba(0, 0, 0, 0.05),
    0 10px 15px -3px rgba(0, 0, 0, 0.08);
  z-index: 1000;
  max-height: 320px;
  display: flex;
  flex-direction: column;
}

.empty-text,
.loading-text {
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
  padding: 12px;
  text-align: center;
}

.dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color-light, #f3f4f6);
}

.dropdown-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary, #111827);
}

.close-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: none;
  border: none;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.close-button:hover {
  background-color: var(--background-secondary, #f9fafb);
  color: var(--text-primary, #111827);
}

.dropdown-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.dropdown-content::-webkit-scrollbar {
  width: 6px;
  background: transparent;
}

.dropdown-content::-webkit-scrollbar-track {
  background: var(--background-secondary, #f9fafb);
  border-radius: 3px;
}

.dropdown-content::-webkit-scrollbar-thumb {
  background: rgba(203, 213, 225, 0.6);
  border-radius: 3px;
}

.tool-list-container {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 5px;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.tool-item:hover {
  background-color: rgba(59, 130, 246, 0.04);
}

.tool-checkbox {
  margin-top: 2px;
  cursor: pointer;
}

.tool-info {
  flex: 1;
  min-width: 0;
}

.tool-info .tool-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary, #111827);
  margin-bottom: 1px;
}

.tool-description {
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tool-params-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: relative;
}

.tool-params-list::before {
  content: '';
  position: absolute;
  left: 9px;
  top: 18px;
  bottom: 0;
  width: 1.5px;
  background: linear-gradient(to bottom, 
    var(--primary-color, #3b82f6) 0%, 
    rgba(59, 130, 246, 0.15) 100%
  );
  border-radius: 1px;
  z-index: 0;
}

.tool-execution-flow {
  display: flex;
  flex-direction: column;
  position: relative;
}

.tool-param-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 26px;
  position: relative;
}

.tool-param-header {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  padding: 4px 0;
}

.remove-tool-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  background: none;
  border: none;
  color: var(--text-tertiary, #d1d5db);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s ease;
  margin-left: auto;
  opacity: 0;
}

.tool-param-header:hover .remove-tool-button {
  opacity: 1;
}

.remove-tool-button:hover {
  background-color: rgba(239, 68, 68, 0.08);
  color: #ef4444;
}

.tool-param-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  background: linear-gradient(135deg, var(--primary-color, #3b82f6) 0%, #60a5fa 100%);
  color: white;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
  position: absolute;
  left: -26px;
  z-index: 1;
  box-shadow: 0 0 0 2.5px var(--bg-primary, #ffffff);
}

.tool-param-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary, #111827);
}

.tool-result-container {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 26px;
  position: relative;
}

.tool-result-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  background: linear-gradient(135deg, #10b981 0%, #34d399 100%);
  color: white;
  border-radius: 5px;
  flex-shrink: 0;
  position: absolute;
  left: -26px;
  z-index: 1;
  box-shadow: 0 0 0 2.5px var(--bg-primary, #ffffff);
}

.tool-result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  padding: 4px 0;
}

.result-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 3px;
}

.serial-execution-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.04) 0%, rgba(139, 92, 246, 0.04) 100%);
  border: 1px solid rgba(59, 130, 246, 0.08);
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
}

.serial-execution-hint svg {
  flex-shrink: 0;
  color: var(--primary-color, #3b82f6);
  opacity: 0.7;
}

.collapsed-result {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color, #e5e7eb);
  position: relative;
}

.collapsed-expand-button,
.collapsed-clear-button {
  position: absolute;
  top: 8px;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-secondary, #6b7280);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.collapsed-expand-button {
  right: 36px;
}

.collapsed-clear-button {
  right: 8px;
}

.collapsed-expand-button:hover,
.collapsed-clear-button:hover {
  background-color: var(--background-hover, #f3f4f6);
}

.expand-button,
.clear-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-secondary, #6b7280);
  border-radius: 4px;
}

.expand-button:hover,
.clear-button:hover {
  background-color: var(--background-hover, #f3f4f6);
}
</style>
