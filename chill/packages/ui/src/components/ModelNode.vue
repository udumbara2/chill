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
        <span class="execution-badge header-badge" :class="executionTier === 'worker' ? 'tier-worker' : 'tier-shared'" :title="executionTier === 'worker' ? '独立上下文执行(引用模板或挂了技能/知识/记忆)' : '共享上下文循环(轻量模型节点)'">
          {{ executionTier === 'worker' ? '独立上下文' : '共享上下文' }}
        </span>
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
      <!-- Agent 模式:匿名内联 / 引用模板(节点即模板具象化) -->
      <div class="node-section agent-mode-section">
        <div class="section-label">Agent 模式</div>
        <div class="agent-mode-row">
          <select v-model="agentMode" class="agent-mode-select">
            <option value="inline">匿名内联</option>
            <option value="template">引用模板</option>
          </select>
          <select v-if="agentMode === 'template'" v-model="agentTemplateRef" class="agent-template-select" @change="applyTemplateRef">
            <option value="" disabled>选择模板…</option>
            <option v-for="t in availableTemplates" :key="t.subagent_type" :value="t.subagent_type">
              {{ t.name }}(@{{ t.subagent_type }})
            </option>
          </select>
        </div>
        <div v-if="agentMode === 'template' && agentTemplateRef" class="agent-ref-note">
          <span>跟随模板,只读;展开副本后可自由编辑(不影响原模板)</span>
          <button class="agent-action-btn" @click="editReferencedTemplate" title="在 Agent 编辑器中编辑该模板">编辑该模板</button>
          <button class="agent-action-btn" @click="forkTemplateToInline">展开为内联副本</button>
        </div>
        <div v-if="agentMode === 'inline'" class="agent-mode-actions">
          <button v-if="!showSlugInput" class="agent-action-btn" @click="showSlugInput = true" title="把当前节点配置保存为单 Agent 模板">存为模板…</button>
          <div v-else class="slug-input-row">
            <input
              v-model="slugInput"
              type="text"
              class="slug-input"
              placeholder="模板标识(kebab-case)"
              @keyup.enter="confirmSaveAsTemplate"
              @keyup.esc="showSlugInput = false"
            />
            <button class="agent-action-btn" @click="confirmSaveAsTemplate">确定</button>
            <button class="agent-action-btn" @click="showSlugInput = false">取消</button>
          </div>
          <div v-if="slugError" class="slug-error">{{ slugError }}</div>
        </div>
      </div>

      <fieldset :disabled="agentMode === 'template'" class="node-fields-fieldset" :class="{ 'fields-readonly': agentMode === 'template' }">
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

      <!-- 任务说明(上提为主内容;这个节点"干什么") -->
      <div class="node-section">
        <div class="section-label">任务说明</div>
        <div class="section-hint" v-text="'变量：{{prev}}(上游最后一条输出) / {{input.入参名}} / {{nodes.节点id}}；缺省 = 上游输出'"></div>
        <TextInput
          v-model:value="promptTemplate"
          placeholder="缺省 = 上游最后一条输出"
        />
      </div>
      
      <div class="node-section">
        <ParamPanel 
          :selected-model="selectedModel"
          v-model:parameters="parameters"
        />
      </div>
      
      <!-- 更多配置:五个平行分区(工具/技能/知识/记忆/循环上限;声明驮具字段即升级为 Worker 独立上下文执行) -->
      <CollapsiblePanel title="更多配置" :default-expanded="false">
        <div class="more-config">
          <CollapsiblePanel title="工具" :default-expanded="false">
            <template #header-actions>
              <span class="param-count">({{ selectedTools.length }})</span>
            </template>
            <ToolSelector 
              v-model:selected-tools="selectedTools"
            />
            <label class="config-check"><input v-model="readonlyFlag" type="checkbox" /> 只读（禁用修改性工具）</label>
            <div class="section-hint">黑名单（在勾选清单基础上扣除）：</div>
            <div v-for="group in toolGroups" :key="group.category" class="blacklist-group">
              <div class="section-hint">{{ group.category }}</div>
              <label v-for="t in group.names" :key="t" class="config-check">
                <input type="checkbox" :checked="disallowedTools.includes(t)" @change="toggleDisallowed(t)" />
                {{ t }}
              </label>
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel title="技能" :default-expanded="false">
            <template #header-actions>
              <span class="param-count">({{ skills.length }})</span>
            </template>
            <SkillsPicker v-model="skills" />
          </CollapsiblePanel>

          <CollapsiblePanel title="知识" :default-expanded="false">
            <template #header-actions>
              <span class="param-count">({{ knowledge.length }})</span>
            </template>
            <KnowledgePicker v-model="knowledge" />
          </CollapsiblePanel>

          <CollapsiblePanel title="记忆" :default-expanded="false">
            <template #header-actions>
              <span class="param-count">{{ memoryScope || '无' }}</span>
            </template>
            <MemoryScopeSelect v-model="memoryScope" />
          </CollapsiblePanel>

          <CollapsiblePanel title="循环上限" :default-expanded="false">
            <template #header-actions>
              <span class="param-count">{{ maxTurns ?? '不限' }}</span>
            </template>
            <input v-model.number="maxTurns" type="number" min="1" placeholder="不限" class="loop-input" />
            <div class="section-hint">模型干完会自己停，上限只是防失控的保险丝</div>
          </CollapsiblePanel>
        </div>
      </CollapsiblePanel>
      </fieldset>

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
import SkillsPicker from './agentConfig/SkillsPicker.vue'
import KnowledgePicker from './agentConfig/KnowledgePicker.vue'
import MemoryScopeSelect from './agentConfig/MemoryScopeSelect.vue'
import { useToolCatalog } from './agentConfig/toolCatalog'
import type { ModelInfo, ToolDefinition, Message, ContentBlock, NamespacedWorkflowEventBus, SubagentTemplate } from '@assistant-ai/core'
import { MessageRole, ContentBlockType, workflowEventBus, WORKFLOW_EVENTS, SelectedModelsService, getTemplateManager, serializeTemplate, TemplatePriority } from '@assistant-ai/core'
import { saveTemplateFile } from '../services/templateSaver'

// 工作流上下文接口
interface WorkflowContext {
  workflowId: string
  eventBus: NamespacedWorkflowEventBus
  /** 编辑指定单 Agent 模板(跳 Agent 编辑器;WorkflowView 提供) */
  onEditTemplate?: (subagentType: string) => void
}

interface ModelNodeData {
  label?: string
  onExecute?: (nodeId: string, config: any, messages?: Message[]) => Promise<void>
  selectedModel?: ModelInfo | null
  parameters?: Record<string, any>
  selectedTools?: ToolDefinition[]
  systemPrompt?: string
  agentTemplate?: string
  disallowedTools?: string[]
  readonly?: boolean
  memory?: string
  skills?: string[]
  knowledge?: string[]
  maxIterations?: number
  maxTurns?: number
  prompt?: string
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

// ---------- Agent 模式(匿名内联 / 引用模板)与更多配置 ----------

const agentMode = ref<'inline' | 'template'>(props.data.agentTemplate ? 'template' : 'inline')
const agentTemplateRef = ref(props.data.agentTemplate ?? '')
// 更多配置(数组形态;与 AgentEditor 共享 picker 同一数据源,不再有逗号文本框)
const disallowedTools = ref<string[]>([...(props.data.disallowedTools ?? [])])
const readonlyFlag = ref(props.data.readonly === true)
const memoryScope = ref(props.data.memory ?? '')
const skills = ref<string[]>([...(props.data.skills ?? [])])
const knowledge = ref<string[]>([...(props.data.knowledge ?? [])])
const maxTurns = ref<number | undefined>(props.data.maxTurns ?? props.data.maxIterations)
const promptTemplate = ref(props.data.prompt ?? '')

const availableTemplates = computed<SubagentTemplate[]>(() => {
  try {
    return getTemplateManager().getAllTemplates().filter((t) => {
      const type = (t.type as string | undefined) ?? 'builtin'
      return type === 'builtin' || type === 'custom'
    })
  } catch {
    return []
  }
})

/** 执行层判定:引用模板或声明驮具字段 → Worker 独立上下文;否则共享循环 */
const executionTier = computed<'worker' | 'shared'>(() => {
  if (agentMode.value === 'template' && agentTemplateRef.value) return 'worker'
  if (memoryScope.value) return 'worker'
  if (skills.value.length > 0) return 'worker'
  if (knowledge.value.length > 0) return 'worker'
  return 'shared'
})

/** 黑名单勾选(数据源与 AgentEditor 工具区同一目录) */
const { toolGroups } = useToolCatalog()
function toggleDisallowed(name: string): void {
  const i = disallowedTools.value.indexOf(name)
  if (i >= 0) disallowedTools.value.splice(i, 1)
  else disallowedTools.value.push(name)
}

const parseList = (text: string): string[] =>
  text.split(',').map((s) => s.trim()).filter((s) => s.length > 0)

/** 选择引用模板:只写 agentTemplate,字段跟随模板(只读) */
const applyTemplateRef = () => {
  props.data.agentTemplate = agentTemplateRef.value || undefined
}

/** 编辑该模板:经 workflowContext 跳 Agent 编辑器(模板是真相源,配置只在模板里改) */
const editReferencedTemplate = () => {
  if (agentTemplateRef.value) workflowContext.value?.onEditTemplate?.(agentTemplateRef.value)
}

/** 展开为内联副本(fork):模板字段当时全量拷贝为内联,此后与模板无同步 */
const forkTemplateToInline = () => {
  const t = availableTemplates.value.find((x) => x.subagent_type === agentTemplateRef.value)
  if (!t) return
  systemPrompt.value = t.system_prompt ?? ''
  props.data.systemPrompt = systemPrompt.value
  selectedTools.value = (t.tools ?? []).map(
    (name) => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {}, required: [] } } }) as ToolDefinition,
  )
  disallowedTools.value = [...(t.disallowed_tools ?? [])]
  readonlyFlag.value = t.readonly === true
  memoryScope.value = t.memory ?? ''
  skills.value = [...(t.skills ?? [])]
  knowledge.value = [...(t.knowledge ?? [])]
  agentMode.value = 'inline'
  agentTemplateRef.value = ''
  props.data.agentTemplate = undefined
}

/** 存为模板:当前节点配置 → 模板文件,节点自动转为引用态(标识经应用内联输入收集,不用 window.prompt(Electron 渲染层不可靠);标识非法行内报错(不用 window.alert) */
const showSlugInput = ref(false)
const slugInput = ref('')
const slugError = ref('')

const confirmSaveAsTemplate = async () => {
  const slug = slugInput.value.trim()
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    slugError.value = '标识只能包含小写字母、数字和连字符'
    return
  }
  slugError.value = ''
  const template: SubagentTemplate = {
    name: nodeTitle.value,
    description: '',
    subagent_type: slug,
    system_prompt: systemPrompt.value,
    priority: TemplatePriority.USER,
    parameters: {},
    ...(selectedModel.value?.name ? { model: selectedModel.value.name } : {}),
    ...(selectedTools.value.length > 0 ? { tools: selectedTools.value.map((t) => t.function?.name ?? '').filter(Boolean) } : {}),
    ...(disallowedTools.value.length > 0 ? { disallowed_tools: [...disallowedTools.value] } : {}),
    ...(readonlyFlag.value ? { readonly: true } : {}),
    ...(memoryScope.value ? { memory: memoryScope.value as 'user' | 'project' | 'local' } : {}),
    ...(skills.value.length > 0 ? { skills: [...skills.value] } : {}),
    ...(knowledge.value.length > 0 ? { knowledge: [...knowledge.value] } : {}),
  }
  await saveTemplateFile({ slug, storage: 'user', content: serializeTemplate(template) })
  showSlugInput.value = false
  slugInput.value = ''
  slugError.value = ''
  agentTemplateRef.value = slug
  agentMode.value = 'template'
  props.data.agentTemplate = slug
}

// 更多配置 → props.data 同步(序列化进 YAML 的数据源;循环上限单一出口 maxTurns)
watch([disallowedTools, readonlyFlag, memoryScope, skills, knowledge, maxTurns, promptTemplate], () => {
  props.data.disallowedTools = [...disallowedTools.value]
  props.data.readonly = readonlyFlag.value || undefined
  props.data.memory = memoryScope.value || undefined
  props.data.skills = [...skills.value]
  props.data.knowledge = [...knowledge.value]
  props.data.maxIterations = undefined
  props.data.maxTurns = maxTurns.value || undefined
  props.data.prompt = promptTemplate.value || undefined
}, { deep: true })
watch(agentMode, () => {
  if (agentMode.value === 'inline') props.data.agentTemplate = undefined
  else props.data.agentTemplate = agentTemplateRef.value || undefined
})

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

  // 更多配置字段恢复(既有缺口:此前切换工作流时这些字段不回填)
  disallowedTools.value = [...(props.data.disallowedTools ?? [])]
  readonlyFlag.value = props.data.readonly === true
  memoryScope.value = props.data.memory ?? ''
  skills.value = [...(props.data.skills ?? [])]
  knowledge.value = [...(props.data.knowledge ?? [])]
  maxTurns.value = props.data.maxTurns ?? props.data.maxIterations
  promptTemplate.value = props.data.prompt ?? ''

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

/* Agent 模式(匿名内联/引用模板)与更多配置 */
.agent-mode-section {
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  padding-bottom: 8px;
}

.agent-mode-row {
  display: flex;
  gap: 6px;
}

.agent-mode-select,
.agent-template-select {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  font-size: 12px;
  border: 1px solid var(--border-color, #d1d5db);
  border-radius: 6px;
  background: var(--background-primary, #fff);
  color: var(--text-primary, #111827);
}

.agent-ref-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
}

.agent-mode-actions {
  margin-top: 6px;
}

.agent-action-btn {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border-color, #d1d5db);
  border-radius: 6px;
  background: var(--background-secondary, #f3f4f6);
  color: var(--text-primary, #111827);
  cursor: pointer;
  white-space: nowrap;
}

.agent-action-btn:hover {
  background: var(--background-tertiary, #e5e7eb);
}

.node-fields-fieldset {
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}

.fields-readonly {
  opacity: 0.55;
}

.execution-badge {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 9999px;
  white-space: nowrap;
}

.header-badge {
  align-self: center;
}

.tier-worker {
  background: rgba(139, 92, 246, 0.12);
  color: #8b5cf6;
}

.tier-shared {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.more-config {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-hint {
  font-size: 11px;
  color: var(--text-secondary, #9ca3af);
}

.config-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-primary, #374151);
  margin-right: 10px;
}

.blacklist-group {
  margin-top: 4px;
}

.loop-input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-primary, #1f2937);
  background: var(--background-primary, #fff);
}

.loop-input:focus {
  outline: none;
  border-color: #8b5cf6;
}

.config-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.config-row label {
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
}

.config-row input[type='text'],
.config-row input[type='number'],
.config-row select {
  padding: 4px 6px;
  font-size: 12px;
  border: 1px solid var(--border-color, #d1d5db);
  border-radius: 6px;
  background: var(--background-primary, #fff);
  color: var(--text-primary, #111827);
}

.config-inline label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-primary, #111827);
}

.config-inline-2 {
  display: flex;
  gap: 8px;
}

.config-inline-2 > div {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.slug-input-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.slug-input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  font-size: 12px;
  border: 1px solid var(--border-color, #d1d5db);
  border-radius: 6px;
}

.slug-error {
  margin-top: 4px;
  font-size: 11px;
  color: #dc2626;
}
</style>
