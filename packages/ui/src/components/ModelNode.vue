<template>
  <div class="model-node" :class="[nodeStatusClass, { 'node-collapsed': isCollapsed, 'node-selected': props.selected }]">
    <div class="node-header">
      <div class="node-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
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
          :disabled="!selectedModel || nodeStatus === 'running'"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </button>
      </div>
    </div>
    
    <div class="node-content" v-show="!isCollapsed">
      <div class="node-section model-selection-section">
        <div class="section-label">模型选择</div>
        <ModelSelector 
          dropdown-position="bottom"
          :selected-model="selectedModel"
          @model-selected="handleModelSelected"
        />
      </div>
      
      <div class="node-section">
        <div class="section-label">系统提示词</div>
        <TextInput
          v-model:value="systemPrompt"
          placeholder="输入系统提示词..."
        />
      </div>
      
      <div class="node-section">
        <ParamPanel 
          :selected-model="selectedModel"
          v-model:parameters="parameters"
        />
      </div>
      
      <CollapsiblePanel title="工具选择" :default-expanded="false">
        <template #header-actions>
          <span class="param-count">({{ selectedTools.length }})</span>
        </template>
        <ToolSelector 
          v-model:selected-tools="selectedTools"
        />
      </CollapsiblePanel>

      <CollapsiblePanel title="测试输入" :default-expanded="false">
        <TextInput
          v-model:value="testInput"
          placeholder="输入测试消息..."
        />
      </CollapsiblePanel>

      <CollapsiblePanel title="执行结果" :default-expanded="false" :expanded="contentBlocks.length > 0">
        <template #header-actions>
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
        </template>
        <ResultPanel 
          :content-blocks="contentBlocks"
          :result-type="resultType"
          :is-streaming="nodeStatus === 'running'"
          :reasoning-expanded="reasoningExpanded"
          @toggle-reasoning="toggleReasoning"
        />
      </CollapsiblePanel>
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
    
    <Handle type="target" id="model-target" :position="Position.Left" />
    <Handle type="source" id="model-source" :position="Position.Right" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, inject, type Ref } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import type { NodeProps } from '@vue-flow/core'
import NodeTitle from './NodeTitle.vue'
import TextInput from './TextInput.vue'
import ModelSelector from './ModelSelector.vue'
import ToolSelector from './ToolSelector.vue'
import ParamPanel from './ParamPanel.vue'
import ResultPanel from './ResultPanel.vue'
import ResultModal from './ResultModal.vue'
import CollapsiblePanel from './CollapsiblePanel.vue'
import type { ModelInfo, ToolDefinition, Message, ContentBlock, NamespacedWorkflowEventBus } from '@assistant-ai/core'
import { MessageRole, ContentBlockType, workflowEventBus, WORKFLOW_EVENTS, SelectedModelsService } from '@assistant-ai/core'

// 工作流上下文接口
interface WorkflowContext {
  workflowId: string
  eventBus: NamespacedWorkflowEventBus
}

interface ModelNodeData {
  label?: string
  onExecute?: (nodeId: string, config: any, messages?: Message[]) => Promise<void>
  selectedModel?: ModelInfo | null
  parameters?: Record<string, any>
  selectedTools?: ToolDefinition[]
  systemPrompt?: string
  isCollapsed?: boolean
  // 执行结果（临时存储，用于工作流切换时保留节点状态）
  executionResult?: {
    contentBlocks: any[]
    resultType: 'text' | 'file'
    nodeStatus: 'idle' | 'running' | 'completed' | 'error'
  }
}

const props = defineProps<NodeProps<ModelNodeData>>()

const nodeTitle = ref(props.data.label || '模型节点')
const selectedModel = ref<ModelInfo | null>(null)
const parameters = ref<Record<string, any>>({})
const selectedTools = ref<ToolDefinition[]>([])
const systemPrompt = ref('')
const testInput = ref('')
const nodeStatus = ref<'idle' | 'running' | 'completed' | 'error'>('idle')
const resultContent = ref('')
const resultType = ref<'text' | 'file'>('text')
const contentBlocks = ref<ContentBlock[]>([])
const collapsedContentBlocks = ref<ContentBlock[]>([])
const reasoningExpanded = ref<Record<number, boolean>>({})
const reasoningUserProtected = ref<Record<number, boolean>>({})
const hasExistingReasoning = ref(false)
const isResultModalOpen = ref(false)

// 注入工作流上下文（可能是 computed ref）
const injectedContext = inject<WorkflowContext | Ref<WorkflowContext> | undefined>('workflowContext', undefined)

// 解包 computed ref
const workflowContext = computed<WorkflowContext | undefined>(() => {
  if (!injectedContext) return undefined
  // 如果是 ref（computed），返回 .value
  if ('value' in injectedContext) {
    return (injectedContext as Ref<WorkflowContext>).value
  }
  // 否则直接返回
  return injectedContext as WorkflowContext
})

// 获取当前工作流的事件总线（优先使用注入的，回退到全局）
const eventBus = computed(() => {
  if (workflowContext.value?.eventBus) {
    return workflowContext.value.eventBus
  }
  // 如果没有注入上下文，使用全局事件总线（兼容旧代码）
  return workflowEventBus
})

// 保存当前事件总线实例引用，用于正确注销监听器
let currentEventBusInstance: NamespacedWorkflowEventBus | typeof workflowEventBus = eventBus.value
// 从 props.data 初始化折叠状态，如果没有则默认为折叠
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

const handleTitleUpdate = (newTitle: string) => {
  nodeTitle.value = newTitle
  props.data.label = newTitle
}

const handleModelSelected = (model: ModelInfo | null) => {
  selectedModel.value = model
}

const handleExecute = async () => {
  if (!selectedModel.value) return

  nodeStatus.value = 'running'
  resultContent.value = ''
  resultType.value = 'text'
  contentBlocks.value = []
  collapsedContentBlocks.value = []
  reasoningExpanded.value = {}
  reasoningUserProtected.value = {}
  hasExistingReasoning.value = false

  const config = {
    modelType: selectedModel.value.type,
    modelName: selectedModel.value.name,
    systemPrompt: systemPrompt.value,
    parameters: parameters.value,
    selectedTools: selectedTools.value
  }

  const messages: Message[] = []
  if (testInput.value.trim()) {
    messages.push({
      role: MessageRole.USER,
      content: testInput.value,
      timestamp: new Date()
    })
  } else {
    alert('请输入测试消息')
    nodeStatus.value = 'idle'
    return
  }

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
  resultContent.value = ''
  resultType.value = 'text'
  contentBlocks.value = []
  collapsedContentBlocks.value = []
  reasoningExpanded.value = {}
  reasoningUserProtected.value = {}
  hasExistingReasoning.value = false
  nodeStatus.value = 'idle'
  // 清空保存的执行结果
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
  // 同步到 props.data 以保留状态
  props.data.isCollapsed = isCollapsed.value
}

onMounted(() => {
  // 从 props.data 初始化数据
  initializeFromProps()

  // 保存当前事件总线实例
  currentEventBusInstance = eventBus.value

  currentEventBusInstance.on(WORKFLOW_EVENTS.STREAM_CHUNK, handleStreamChunk)
  currentEventBusInstance.on(WORKFLOW_EVENTS.STREAM_ERROR, handleStreamError)
  currentEventBusInstance.on(WORKFLOW_EVENTS.STREAM_COMPLETE, handleStreamComplete)
  currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
  currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
})

// 从 props.data 初始化数据的函数
const initializeFromProps = () => {
  nodeTitle.value = props.data.label || '模型节点'
  systemPrompt.value = props.data.systemPrompt || ''
  selectedTools.value = props.data.selectedTools || []
  parameters.value = props.data.parameters || {}
  isCollapsed.value = props.data.isCollapsed !== undefined ? props.data.isCollapsed : true

  // 恢复执行结果（如果存在），否则清空状态
  if (props.data.executionResult) {
    nodeStatus.value = props.data.executionResult.nodeStatus
    resultType.value = props.data.executionResult.resultType
    contentBlocks.value = props.data.executionResult.contentBlocks || []
    collapsedContentBlocks.value = props.data.executionResult.contentBlocks || []
  } else {
    // 没有执行结果，清空状态以避免显示其他工作流的内容
    nodeStatus.value = 'idle'
    resultType.value = 'text'
    resultContent.value = ''
    contentBlocks.value = []
    collapsedContentBlocks.value = []
    reasoningExpanded.value = {}
    reasoningUserProtected.value = {}
    hasExistingReasoning.value = false
  }

  // 处理模型选择
  // 优先使用 props.data.selectedModel，如果存在则直接使用
  // 只有当 props.data 中确实没有模型信息时，才使用默认模型
  if (props.data.selectedModel && props.data.selectedModel.name) {
    // 使用已有的模型信息（从文件加载的）
    selectedModel.value = props.data.selectedModel
  } else {
    // 只有在没有模型信息时，才自动选择默认模型
    const selectedModelsService = SelectedModelsService.getInstance()
    const availableModels = selectedModelsService.getSelectedModels()
    if (availableModels.length > 0) {
      selectedModel.value = availableModels[0]
      // 同步到 props.data
      props.data.selectedModel = availableModels[0]
    } else {
      selectedModel.value = null
    }
  }
}

// 监听 props.data 变化，当切换工作流时恢复状态
watch(() => props.data, (newData, oldData) => {
  // 如果 data 对象引用变化（切换工作流），从 props.data 恢复状态
  if (newData !== oldData) {
    initializeFromProps()
    // 注意：执行状态现在从 props.data.executionResult 恢复，不再重置
  }
}, { immediate: true, deep: true })

onUnmounted(() => {
  // 使用保存的事件总线实例注销监听器
  currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_CHUNK, handleStreamChunk)
  currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_ERROR, handleStreamError)
  currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_COMPLETE, handleStreamComplete)
  currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
  currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
})

// 监听 workflowId 变化，当切换工作流时重新初始化
watch(() => workflowContext.value?.workflowId, (newWorkflowId, oldWorkflowId) => {
  if (newWorkflowId && newWorkflowId !== oldWorkflowId) {
    // 使用保存的旧事件总线实例注销监听器
    currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_CHUNK, handleStreamChunk)
    currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_ERROR, handleStreamError)
    currentEventBusInstance.off(WORKFLOW_EVENTS.STREAM_COMPLETE, handleStreamComplete)
    currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
    currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)

    // 更新当前事件总线实例引用（因为 eventBus computed 可能已经改变）
    currentEventBusInstance = eventBus.value

    // 在新的事件总线实例上注册监听器
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
    resultContent.value = `执行错误: ${data.error instanceof Error ? data.error.message : '未知错误'}`
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
    resultContent.value = ''
    resultType.value = 'text'
    contentBlocks.value = []
    collapsedContentBlocks.value = []
    reasoningExpanded.value = {}
    reasoningUserProtected.value = {}
    hasExistingReasoning.value = false
  }
}

const handleNodeCompleted = (data: { nodeId: string }) => {
  if (data.nodeId === props.id) {
    nodeStatus.value = 'completed'
  }
}

watch([selectedModel, parameters, selectedTools, systemPrompt], () => {
  props.data.selectedModel = selectedModel.value
  props.data.parameters = parameters.value
  props.data.selectedTools = selectedTools.value
  props.data.systemPrompt = systemPrompt.value
}, { deep: true })

watch(contentBlocks, (newBlocks) => {
  collapsedContentBlocks.value = JSON.parse(JSON.stringify(newBlocks))
}, { deep: true })

// 监听执行状态和结果变化，保存到 props.data.executionResult
watch([nodeStatus, contentBlocks, resultType], () => {
  // 只保存 completed 或 error 状态的结果
  if (nodeStatus.value === 'completed' || nodeStatus.value === 'error') {
    props.data.executionResult = {
      nodeStatus: nodeStatus.value,
      resultType: resultType.value,
      contentBlocks: JSON.parse(JSON.stringify(contentBlocks.value))
    }
  }
}, { deep: true })

defineExpose({
  selectedModel,
  parameters,
  selectedTools,
  systemPrompt
})
</script>

<style scoped>
.model-node {
  width: 280px;
  background-color: var(--background-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.model-node.node-selected {
  border-color: #8b5cf6;
  box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.2);
}

.model-node.node-collapsed {
  width: auto;
  min-width: 120px;
  max-width: 300px;
  position: relative;
}

.node-running {
  border-color: #3b82f6;
  animation: pulse-border 2s ease-in-out infinite;
}

.node-completed {
  border-color: #10b981;
}

.node-error {
  border-color: #ef4444;
}

@keyframes pulse-border {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0);
  }
}

.node-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background-color: var(--background-secondary, #f9fafb);
  border-bottom: 1px solid var(--border-color-light, #f3f4f6);
  position: relative;
}

.node-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background-color: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
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
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  padding: 0;
}

.collapse-button:hover {
  background-color: rgba(107, 114, 128, 0.1);
  color: var(--text-primary, #111827);
}

.collapse-button svg {
  flex-shrink: 0;
}

.node-status {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.status-idle {
  background-color: rgba(107, 114, 128, 0.1);
  color: #6b7280;
}

.status-running {
  background-color: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.status-completed {
  background-color: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.status-error {
  background-color: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.node-content {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.node-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.model-selection-section {
  flex-direction: row;
  align-items: center;
}

.model-selection-section .section-label {
  flex-shrink: 0;
}

.section-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary, #6b7280);
}

.execute-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background-color: #3b82f6;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.execute-button:hover:not(:disabled) {
  background-color: #2563eb;
  transform: scale(1.05);
}

.execute-button:active:not(:disabled) {
  transform: scale(0.95);
}

.execute-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.execute-button:disabled {
  background-color: #9ca3af;
  cursor: not-allowed;
  opacity: 0.7;
}

.execute-button svg {
  flex-shrink: 0;
}

.clear-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  padding: 0;
}

.clear-button:hover {
  background-color: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.clear-button svg {
  flex-shrink: 0;
}

.expand-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  padding: 0;
}

.expand-button:hover {
  background-color: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.expand-button svg {
  flex-shrink: 0;
}

.collapsed-result {
  margin-top: 6px;
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  z-index: 1;
  background-color: rgba(249, 250, 251, 0.98);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  border-radius: 8px;
}

.collapsed-clear-button {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  padding: 0;
  z-index: 10;
}

.collapsed-clear-button:hover {
  background-color: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.collapsed-clear-button svg {
  flex-shrink: 0;
}

.collapsed-expand-button {
  position: absolute;
  top: 4px;
  right: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  padding: 0;
  z-index: 10;
}

.collapsed-expand-button:hover {
  background-color: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.collapsed-expand-button svg {
  flex-shrink: 0;
}
</style>
