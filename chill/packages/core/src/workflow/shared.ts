/**
 * 工作流纯逻辑共享模块
 * 不依赖 LangGraph 运行时 API，供渲染进程和主进程共享使用
 */

import type { Message, ContentPart, ToolDefinition, ModelConfig } from '../services/models/types'
import { MessageRole } from '../services/models/types'
import { ConditionType, OperatorType,  EdgeType } from '../types/edge'
import type { BranchCondition, ToolCallCondition, ContentCondition, StateFieldCondition, ExpressionCondition, ConditionalEdge, BranchConfig } from '../types/edge'
import { evaluateExpression } from '../utils/expressionParser'
import { ToolRegistry } from '../services/toolExecutorRegistry'
import { ToolExecutorFactory } from '../services/toolExecutorFactory'
import { modelInfoService } from '../services/models/modelInfoService'
import type { StateGraph, CompiledGraph } from '@langchain/langgraph'

export interface MinimalWorkflowState {
  messages: Message[]
  [key: string]: any
}

export type AnyStateGraph = StateGraph<any, any, any, any, any>
export type AnyCompiledGraph = CompiledGraph<any, any, any, any, any>

export interface WorkflowExecutionResult {
  content: string
  toolCalls?: any[]
  metadata?: Record<string, any>
}

/**
 * 创建工作流状态注解
 * 各端传入自己包的 Annotation 函数，避免 @langchain/langgraph 与 @langchain/langgraph/web 类型不兼容
 * @param AnnotationFn - 当前包版本的 Annotation 函数
 * @returns AnnotationRoot 对象（供 StateGraph 构造使用）
 */
export function createWorkflowStateAnnotation(AnnotationFn: any): any {
  return AnnotationFn.Root({
    messages: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => []
    }),
    modelConfigs: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => ({})
    }),
    selectedToolsMap: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => ({})
    }),
    toolParamsMap: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => ({})
    }),
    toolResultsMap: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => ({})
    }),
    executionResults: AnnotationFn({
      reducer: (x: any, y: any) => x.concat(y),
      default: () => []
    }),
    currentNode: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => ''
    }),
    text: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => undefined
    }),
    files: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => undefined
    }),
    systemPrompts: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => ({})
    }),
    iterationCount: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => 0
    }),
    branchLoopCounts: AnnotationFn({
      reducer: (x: any, y: any) => ({ ...x, ...y }),
      default: () => ({})
    }),
    codeExecutorConfigs: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => ({})
    }),
    // 深绑定 agent 节点的 DSL 配置(节点 id → WorkflowAgentNodeConfig;agentNodeExecutor 数据源)
    agentNodeConfigs: AnnotationFn({
      reducer: (x: any, y: any) => y ?? x,
      default: () => ({})
    }),
    // 各节点最近产出的文本(节点 id → 输出;{{nodes.<id>}} 变量渲染的数据源)
    nodeOutputs: AnnotationFn({
      reducer: (x: any, y: any) => ({ ...x, ...y }),
      default: () => ({})
    })
  })
}

/**
 * 工作流状态接口
 */
export interface WorkflowState {
  messages: Message[]
  modelConfigs: Record<string, Record<string, any>>
  selectedToolsMap: Record<string, ToolDefinition[]>
  toolParamsMap: Record<string, Record<string, any>>
  toolResultsMap: Record<string, any[]>
  executionResults: WorkflowExecutionResult[]
  currentNode: string
  text?: string
  files?: string[]
  systemPrompts: Record<string, string>
  iterationCount: number
  branchLoopCounts: Record<string, number>
  codeExecutorConfigs: Record<string, { interactiveMode?: boolean; language?: string }>
  agentNodeConfigs?: Record<string, any>
  nodeOutputs?: Record<string, string>
}

/**
 * 节点配置接口（基础版）
 * UI 侧可通过交叉类型扩展 label、modelType 等字段
 */
export interface WorkflowNodeConfig {
  id: string
  type: string
  data?: Record<string, any>
}

export function isInteractiveCode(code: string): boolean {
  const lines = code.split('\n')
  const codeLines = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')
  })
  const codeWithoutComments = codeLines.join('\n')
  const patterns = [
    /\binput\s*\(/,
    /\braw_input\s*\(/,
    /\bsys\.stdin/,
    /\breadline\b/,
    /\bprompt\s*\(/,
    /\bprocess\.stdin/,
    /\bread\s+/,
  ]
  return patterns.some(pattern => pattern.test(codeWithoutComments))
}

export function isInteractiveError(error: string): boolean {
  const patterns = [
    /EOFError/i,
    /EOF when reading/i,
    /stdin/i,
  ]
  return patterns.some(pattern => pattern.test(error))
}

export function evaluateToolCallCondition(state: MinimalWorkflowState, _condition: ToolCallCondition): boolean {
  if (!state.messages || state.messages.length === 0) {
    return false
  }

  const lastMessage = state.messages[state.messages.length - 1]

  if (lastMessage.toolCalls && lastMessage.toolCalls.length > 0) {
    return true
  }

  return false
}

export function buildPathMap(
  branches: BranchConfig[],
  fallbackNodeId: string
): Record<string, string> {
  const pathMap: Record<string, string> = {}
  for (const branch of branches) {
    pathMap[branch.id] = branch.targetNodeId
  }
  pathMap['fallback'] = fallbackNodeId || '__end__'
  pathMap['error'] = '__end__'
  return pathMap
}

export function evaluateContentCondition(state: MinimalWorkflowState, condition: ContentCondition): boolean {
  const messages = state.messages
  if (!messages || messages.length === 0) {
    return false
  }

  const lastMessage = messages[messages.length - 1]
  const rawContent = lastMessage?.content || ''
  const content = extractTextContent(rawContent)

  switch (condition.operator) {
    case 'equals':
      return content === condition.value
    case 'not_equals':
      return content !== condition.value
    case 'contains':
      return content.includes(condition.value)
    case 'not_contains':
      return !content.includes(condition.value)
    case 'starts_with':
      return content.startsWith(condition.value)
    case 'ends_with':
      return content.endsWith(condition.value)
    case 'regex':
      try {
        const regex = new RegExp(condition.value)
        return regex.test(content)
      } catch (e) {
        console.error('Invalid regex pattern:', condition.value)
        return false
      }
    default:
      return false
  }
}

export function evaluateStateFieldCondition(state: MinimalWorkflowState, condition: StateFieldCondition): boolean {
  const fieldValue = (state as any)[condition.field]

  if (fieldValue === undefined || fieldValue === null) {
    return false
  }

  switch (condition.operator) {
    case OperatorType.EQ:
      return fieldValue === condition.value
    case OperatorType.NE:
      return fieldValue !== condition.value
    case OperatorType.GT:
      const numFieldValueGT = Number(fieldValue)
      const numConditionValueGT = Number(condition.value)
      if (isNaN(numFieldValueGT) || isNaN(numConditionValueGT)) {
        return false
      }
      return numFieldValueGT > numConditionValueGT
    case OperatorType.LT:
      const numFieldValueLT = Number(fieldValue)
      const numConditionValueLT = Number(condition.value)
      if (isNaN(numFieldValueLT) || isNaN(numConditionValueLT)) {
        return false
      }
      return numFieldValueLT < numConditionValueLT
    case OperatorType.GTE:
      const numFieldValueGTE = Number(fieldValue)
      const numConditionValueGTE = Number(condition.value)
      if (isNaN(numFieldValueGTE) || isNaN(numConditionValueGTE)) {
        return false
      }
      return numFieldValueGTE >= numConditionValueGTE
    case OperatorType.LTE:
      const numFieldValueLTE = Number(fieldValue)
      const numConditionValueLTE = Number(condition.value)
      if (isNaN(numFieldValueLTE) || isNaN(numConditionValueLTE)) {
        return false
      }
      return numFieldValueLTE <= numConditionValueLTE
    case OperatorType.CONTAINS:
      const strFieldValue = String(fieldValue)
      const strConditionValue = String(condition.value)
      return strFieldValue.includes(strConditionValue)
    case OperatorType.NOT_CONTAINS:
      const strFieldValueNot = String(fieldValue)
      const strConditionValueNot = String(condition.value)
      return !strFieldValueNot.includes(strConditionValueNot)
    default:
      return false
  }
}

export function evaluateExpressionCondition(state: MinimalWorkflowState, condition: ExpressionCondition): boolean {
  try {
    const result = evaluateExpression(condition.expression, state)
    return result
  } catch (error) {
    console.error('Error evaluating expression:', error)
    return false
  }
}

export function evaluateBranchCondition(state: MinimalWorkflowState, condition: BranchCondition): boolean {
  switch (condition.type) {
    case ConditionType.TOOL_CALL:
      return evaluateToolCallCondition(state, condition as ToolCallCondition)
    case ConditionType.CONTENT:
      return evaluateContentCondition(state, condition as ContentCondition)
    case ConditionType.STATE_FIELD:
      return evaluateStateFieldCondition(state, condition as StateFieldCondition)
    case ConditionType.EXPRESSION:
      return evaluateExpressionCondition(state, condition as ExpressionCondition)
    default:
      console.warn('Unknown condition type:', (condition as any).type)
      return false
  }
}

/**
 * 合并多条条件边为一条多分支边
 * 用于支持同一源节点的多条条件边并行
 * 
 * @param edges - 同一源节点的多条条件边
 * @returns 合并后的单条条件边，包含所有分支
 */
export function mergeConditionalEdges(edges: ConditionalEdge[]): ConditionalEdge {
  const allBranches: BranchConfig[] = []
  const seenTargetNodes = new Set<string>()
  let fallbackNodeId: string | undefined

  edges.forEach((edge, index) => {
    if (edge.data.branches && Array.isArray(edge.data.branches)) {
      edge.data.branches.forEach((branch) => {
        if (seenTargetNodes.has(branch.targetNodeId)) {
          return
        }
        seenTargetNodes.add(branch.targetNodeId)
        allBranches.push({
          ...branch,
          priority: allBranches.length
        })
      })
      if (edge.data.fallbackNodeId) {
        fallbackNodeId = edge.data.fallbackNodeId
      }
    } else if (edge.data.condition) {
      allBranches.push({
        id: `merged_branch_${index}`,
        label: `分支 ${index + 1}`,
        condition: edge.data.condition as BranchCondition,
        targetNodeId: edge.target,
        priority: allBranches.length
      })
      if ((edge.data.condition as any).fallback) {
        fallbackNodeId = (edge.data.condition as any).fallback
      }
    }
  })

  return {
    id: `merged_${edges[0].source}`,
    source: edges[0].source,
    target: edges[0].target,
    type: 'conditional' as ConditionalEdge['type'],
    data: {
      branches: allBranches,
      fallbackNodeId: fallbackNodeId || '__end__'
    }
  }
}

export function canReachFromStart(
  adjacencyList: Map<string, string[]>,
  startNodeId: string,
  targetNodeId: string,
  visited = new Set<string>()
): boolean {
  if (startNodeId === targetNodeId) return true
  if (visited.has(startNodeId)) return false

  visited.add(startNodeId)
  const neighbors = adjacencyList.get(startNodeId) || []
  for (const neighbor of neighbors) {
    if (canReachFromStart(adjacencyList, neighbor, targetNodeId, visited)) {
      return true
    }
  }
  return false
}

export function buildAdjacencyList(
  defaultEdges: Array<{ source: string; target: string }>,
  mergedEdges: ConditionalEdge[]
): Map<string, string[]> {
  const adjacencyList = new Map<string, string[]>()

  defaultEdges.forEach(({ source, target }) => {
    const existing = adjacencyList.get(source) || []
    if (!existing.includes(target)) {
      existing.push(target)
    }
    adjacencyList.set(source, existing)
  })

  mergedEdges.forEach((edge) => {
    if (edge.data?.branches) {
      edge.data.branches.forEach((branch: BranchConfig) => {
        const existing = adjacencyList.get(edge.source) || []
        if (!existing.includes(branch.targetNodeId)) {
          existing.push(branch.targetNodeId)
        }
        adjacencyList.set(edge.source, existing)
      })
    }
  })

  return adjacencyList
}

export function computeIncomingLoopBranches(
  adjacencyList: Map<string, string[]>,
  mergedEdges: ConditionalEdge[]
): Map<string, Array<{ branchId: string; maxIterations?: number }>> {
  const incomingLoopBranches = new Map<string, Array<{ branchId: string; maxIterations?: number }>>()

  mergedEdges.forEach((edge) => {
    if (edge.data?.branches) {
      edge.data.branches.forEach((branch: BranchConfig) => {
        const isSelfLoop = branch.targetNodeId === edge.source
        const isBackEdge = canReachFromStart(adjacencyList, branch.targetNodeId, edge.source)
        const isLoop = isSelfLoop || isBackEdge

        if (isLoop && branch.maxIterations) {
          const existing = incomingLoopBranches.get(branch.targetNodeId) || []
          existing.push({ branchId: branch.id, maxIterations: branch.maxIterations })
          incomingLoopBranches.set(branch.targetNodeId, existing)
        }
      })
    }
  })

  return incomingLoopBranches
}

export function classifyEdges(
  edges: Array<{ source: string; target: string; type?: string; data?: any }>
): {
  conditionalEdgesBySource: Map<string, ConditionalEdge[]>
  defaultEdges: Array<{ source: string; target: string }>
} {
  const conditionalEdgesBySource = new Map<string, ConditionalEdge[]>()
  const defaultEdges: Array<{ source: string; target: string }> = []

  edges.forEach((edge) => {
    if (edge.source && edge.target) {
      if (edge.type === EdgeType.CONDITIONAL) {
        const existing = conditionalEdgesBySource.get(edge.source) || []
        existing.push(edge as ConditionalEdge)
        conditionalEdgesBySource.set(edge.source, existing)
      } else {
        defaultEdges.push({ source: edge.source, target: edge.target })
      }
    }
  })

  return { conditionalEdgesBySource, defaultEdges }
}

export function buildMergedEdges(
  conditionalEdgesBySource: Map<string, ConditionalEdge[]>
): ConditionalEdge[] {
  const mergedEdges: ConditionalEdge[] = []
  conditionalEdgesBySource.forEach((edges) => {
    if (edges.length === 1) {
      mergedEdges.push(edges[0])
    } else {
      mergedEdges.push(mergeConditionalEdges(edges))
    }
  })
  return mergedEdges
}

export function prependSystemPrompt(messages: Message[], systemPrompt: string): Message[] {
  if (!systemPrompt || !systemPrompt.trim()) return messages
  const systemMessage: Message = {
    role: MessageRole.SYSTEM,
    content: systemPrompt,
    timestamp: new Date()
  }
  return [systemMessage, ...messages]
}

export function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part: ContentPart) => part.type === 'text' && part.text)
      .map((part: ContentPart) => part.text)
      .join('')
  }
  return ''
}

export function createStateStore<T extends { createdAt: number; updatedAt: number }>(
  createDefaults: Partial<T>
) {
  const store = new Map<string, T>()

  return {
    get(id: string): T | undefined {
      return store.get(id)
    },
    update(id: string, partial: Partial<T>): void {
      const existing = store.get(id)
      if (existing) {
        store.set(id, { ...existing, ...partial, updatedAt: Date.now() } as T)
      }
    },
    create(id: string, extra: Partial<T>): T {
      const now = Date.now()
      const state = { ...createDefaults, ...extra, createdAt: now, updatedAt: now } as T
      store.set(id, state)
      return state
    },
    remove(id: string): void {
      store.delete(id)
    }
  }
}

export function createMultiBranchRouter(
  branches: BranchConfig[],
  _fallbackNodeId: string
): (state: MinimalWorkflowState) => string {
  return (state: MinimalWorkflowState): string => {
    try {
      const sortedBranches = [...branches].sort((a, b) => (b.priority || 0) - (a.priority || 0))

      for (const branch of sortedBranches) {
        try {
          if (branch.maxIterations && branch.maxIterations > 0) {
            const branchCounts = state.branchLoopCounts || {}
            const currentCount = branchCounts[branch.id] || 0

            if (currentCount >= branch.maxIterations) {
              continue
            }
          }

          if (evaluateBranchCondition(state, branch.condition)) {
            return branch.id
          }
        } catch (error) {
          console.error(`Error evaluating branch ${branch.id}:`, error)
        }
      }

      return 'fallback'
    } catch (error) {
      console.error('Error in multi-branch router:', error)
      return 'error'
    }
  }
}

export function createToolRegistry(selectedTools: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of selectedTools) {
    try {
      const executor = ToolExecutorFactory.createByName(tool.function.name, 'mcp')
      registry.register(executor)
    } catch (error) {
      console.warn(`注册工具失败: ${tool.function.name}`, error)
    }
  }
  return registry
}

/**
 * 工作流节点工具执行器(run_workflow 壳层注入的统一决策管线入口)
 */
export type WorkflowNodeToolRunner = (
  toolName: string,
  params: Record<string, any>,
) => Promise<{ success: boolean; data?: any; error?: string }>

/**
 * 带 runner 的工具注册表:runner 存在时节点工具调用全部经它(统一管线/审批),
 * 缺省回退 createToolRegistry 现状通道(画布草稿试跑不变)
 */
export function createWorkflowToolRegistry(
  selectedTools: ToolDefinition[],
  runner?: WorkflowNodeToolRunner,
): ToolRegistry {
  if (!runner) return createToolRegistry(selectedTools)
  const registry = new ToolRegistry()
  for (const tool of selectedTools) {
    const name = tool.function.name
    registry.register({
      name,
      type: 'workflow',
      execute: async (args: Record<string, any>) => {
        const result = await runner(name, args)
        if (!result.success) throw new Error(result.error ?? `工具 ${name} 执行失败`)
        return result.data
      },
    })
  }
  return registry
}

export function buildToolResultMessage(
  toolName: string,
  result: { success: boolean; data?: any; error?: string }
): Message {
  return {
    role: MessageRole.USER,
    content: `[工具 ${toolName} 执行结果]\n${result.success ? JSON.stringify(result.data) : (result.error || '')}`,
    timestamp: new Date()
  }
}

export function getErrorMessage(error: unknown, fallback?: string): string {
  return error instanceof Error ? error.message : (fallback ?? String(error))
}

export function buildToolErrorMessage(toolName: string, error: unknown): Message {
  return {
    role: MessageRole.USER,
    content: `[工具 ${toolName} 执行失败]\n${getErrorMessage(error)}`,
    timestamp: new Date()
  }
}

export function buildModelConfig(
  modelConfig: Record<string, any>,
  stream: boolean
): Partial<ModelConfig> {
  return {
    model: modelConfig.model,
    temperature: modelConfig.temperature,
    maxTokens: modelConfig.maxTokens ?? modelConfig.max_tokens,
    topP: modelConfig.topP ?? modelConfig.top_p,
    stream,
    thinking: modelConfig.thinking,
    reasoningEffort: modelConfig.reasoningEffort ?? modelConfig.reasoning_effort,
    enableThinking: modelConfig.enableThinking ?? modelConfig.enable_thinking,
    apiKey: modelConfig.apiKey
  }
}

export function buildInputMessages(text?: string, files?: string[]): Message[] {
  const messages: Message[] = []

  if (text && text.trim()) {
    messages.push({
      role: MessageRole.USER,
      content: text,
      timestamp: new Date()
    })
  }

  if (files && files.length > 0) {
    files.forEach((file) => {
      messages.push({
        role: MessageRole.USER,
        content: `文件路径: ${file}`,
        timestamp: new Date()
      })
    })
  }

  return messages
}

export function incrementBranchLoopCounts(
  branchLoopCounts: Record<string, number>,
  loopBranches: Array<{ branchId: string; maxIterations?: number }>
): Record<string, number> {
  const updated = { ...branchLoopCounts }
  for (const loopBranch of loopBranches) {
    const currentCount = updated[loopBranch.branchId] || 0
    updated[loopBranch.branchId] = currentCount + 1
  }
  return updated
}

export function validateModelConfig(modelConfig: Record<string, any> | undefined, nodeId: string) {
  if (!modelConfig) {
    throw new Error(`Model configuration not found for node ${nodeId}`)
  }
  if (!modelConfig.model) {
    throw new Error(`Model type is not configured for node ${nodeId}`)
  }
  const modelInfo = modelInfoService.getModelInfoByName(modelConfig.model)
  if (!modelInfo) {
    throw new Error(`Model not found: ${modelConfig.model}`)
  }
  return modelInfo
}

export function buildAssistantMessage(responseContent: string): Message {
  return {
    role: MessageRole.ASSISTANT,
    content: responseContent,
    timestamp: new Date()
  }
}

export function buildErrorResult(error: unknown): { success: false; error: string } {
  return {
    success: false,
    error: getErrorMessage(error)
  }
}

export function buildCodeExecutionResultMessage(
  executionResult: { success: boolean; output?: string; error?: string }
): Message {
  return {
    role: MessageRole.USER,
    content: executionResult.success
      ? `[代码执行结果]\n${executionResult.output || '(无输出)'}`
      : `[代码执行失败]\n${executionResult.error || '未知错误'}`,
    timestamp: new Date()
  }
}
