/**
 * 工作流图构建器共享模块
 * 供Electron主进程和渲染进程共享使用
 * 使用@langchain/langgraph（Node版本）确保与Electron主进程兼容
 */

import { Annotation, StateGraph, MemorySaver, interrupt, type AnnotationRoot } from '@langchain/langgraph'
import { createWorkflowModelServiceFactory } from '../services/models/workflowModelServiceFactory'
import { SecureStorageService } from '../services/secureStorageService'
import type { ISecureStorage } from '../interfaces/ISecureStorage'
import { EdgeType, type ConditionalEdge, type BranchCondition, type BranchConfig } from '../types/edge'
import { resolveVariables } from '../utils/variableResolver'
import { isInteractiveCode, isInteractiveError, buildPathMap, createMultiBranchRouter, buildAdjacencyList, computeIncomingLoopBranches, classifyEdges, buildMergedEdges, prependSystemPrompt, extractTextContent, getErrorMessage, createWorkflowToolRegistry, buildToolResultMessage, buildToolErrorMessage, buildModelConfig, buildInputMessages, incrementBranchLoopCounts, validateModelConfig, buildAssistantMessage, buildErrorResult, buildCodeExecutionResultMessage, createWorkflowStateAnnotation } from './shared'
import type { AnyStateGraph, AnyCompiledGraph, WorkflowState, WorkflowNodeConfig, WorkflowNodeToolRunner } from './shared'

/**
 * 工作流状态注解定义
 * 字段定义来自 shared.ts 的 createWorkflowStateAnnotation，传入本包的 Annotation 函数
 */
export const StateAnnotation: AnnotationRoot<any> = createWorkflowStateAnnotation(Annotation)

/**
 * 创建MemorySaver实例
 * 用于工作流状态持久化
 */
export function createCheckpointer(): MemorySaver {
  return new MemorySaver()
}

/**
 * Start节点执行器（无UI版本）
 * 将输入text和files转换为messages
 * 注：移除了workflowEventBus.emit调用，保留核心消息处理逻辑
 *
 * @param state - 当前工作流状态
 * @param nodeId - 节点ID
 * @returns 更新后的工作流状态
 */
export function startNodeExecutor(state: WorkflowState, nodeId: string): WorkflowState {
  const { text, files } = state

  const messages = buildInputMessages(text, files)

  // 返回更新后的状态（保留所有原始字段）
  return {
    ...state,
    messages,
    currentNode: nodeId
  }
}

/**
 * Model节点执行器（无UI版本）
 * 调用模型服务处理消息并返回响应
 * 注：移除了workflowEventBus.emit调用，保留模型调用和状态更新逻辑
 * 注：A2A执行使用非流式模式，一次性返回完整结果
 * 注：2.22.3 新增taskId参数，用于获取AbortController实现任务取消
 *
 * @param state - 当前工作流状态
 * @param nodeId - 节点ID
 * @param loopBranches - 循环分支配置
 * @param taskId - 任务ID（可选，用于任务取消）
 * @param taskAbortControllers - 任务AbortController存储（可选）
 * @returns 更新后的工作流状态
 */
export async function modelNodeExecutor(
  state: WorkflowState,
  nodeId: string,
  loopBranches: Array<{ branchId: string; maxIterations?: number }> = [],
  taskId?: string,
  taskAbortControllers?: Map<string, AbortController>,
  toolRunner?: WorkflowNodeToolRunner
): Promise<WorkflowState> {
  const { messages, modelConfigs, selectedToolsMap, systemPrompts, branchLoopCounts } = state

  const modelConfig = modelConfigs[nodeId]
  const selectedTools = selectedToolsMap[nodeId] || []

  // 更新循环分支计数器
  const updatedBranchCounts = incrementBranchLoopCounts(branchLoopCounts, loopBranches)

  // [修复 401] run_workflow 后台执行链路的模型节点此前未注入 secureStorage，apiKey 恒为空导致
  // 节点调用 LLM 时 401。此前该修复被 window 门限住只在渲染进程生效——CLI 同样初始化门面
  // (CliContext SecureStorageService.initialize),定时任务/后台工作流在 CLI 跑时仍然 401。
  // 去掉 window 门:门面已初始化的壳(CLI/UI/主进程)都能取 key;未初始化场景经 try-catch
  // 兜底为空 key(维持旧行为,key 经 customConfig.apiKey 显式传入)。
  const secureStorage: ISecureStorage | undefined = {
        storeApiKey: (provider: string, key: string) => SecureStorageService.storeApiKey(provider, key),
        getApiKey: async (provider: string) => {
          try { return await SecureStorageService.getApiKey(provider) } catch { return null }
        },
        hasApiKey: async (provider: string) => {
          try { return await SecureStorageService.hasApiKey(provider) } catch { return false }
        },
        deleteApiKey: (provider: string) => SecureStorageService.deleteApiKey(provider),
        getAllProviders: async () => {
          try { return await SecureStorageService.getAllProviders() } catch { return [] as string[] }
        },
      }
  const factory = createWorkflowModelServiceFactory(undefined, secureStorage)

  const modelInfo = validateModelConfig(modelConfig, nodeId)

  // 构建模型配置（A2A执行使用非流式模式）
  const customConfig = buildModelConfig(modelConfig, false)

  const systemPrompt = systemPrompts[nodeId] || ''
  let finalMessages = prependSystemPrompt([...messages], systemPrompt)

  // 获取AbortController（如果提供了taskId和taskAbortControllers）
  const abortController = taskId && taskAbortControllers
    ? taskAbortControllers.get(taskId)
    : undefined

  // 创建工具注册表并注册选中的工具(runner 存在时经统一决策管线)
  const registry = createWorkflowToolRegistry(selectedTools, toolRunner)

  // 调用模型服务（非流式），传递AbortController支持取消
  const response = await factory.sendMessage(
    modelInfo.type,
    finalMessages,
    selectedTools,
    registry,  // 传递工具注册表
    undefined,  // 非流式，无回调
    customConfig,
    abortController,  // 2.22.3 传递AbortController
    modelInfo.name
  )

  const responseContent = response.content || ''

  const assistantMessage = buildAssistantMessage(responseContent)

  // 合并消息
  const resultMessages = [...messages, assistantMessage]

  // 返回更新后的状态
  return {
    ...state,
    messages: resultMessages,
    currentNode: nodeId,
    iterationCount: (state.iterationCount || 0) + 1,
    branchLoopCounts: updatedBranchCounts
  }
}

/**
 * Tool节点执行器（无UI版本）
 * 执行工具并返回结果
 * 注：移除了workflowEventBus.emit调用，保留工具执行和状态更新逻辑
 *
 * @param state - 当前工作流状态
 * @param nodeId - 节点ID
 * @returns 更新后的工作流状态
 */
export async function toolNodeExecutor(
  state: WorkflowState,
  nodeId: string,
  toolRunner?: WorkflowNodeToolRunner
): Promise<WorkflowState> {
  const { messages, selectedToolsMap, toolParamsMap, toolResultsMap } = state

  const selectedTools = selectedToolsMap[nodeId] || []
  const toolParams = toolParamsMap[nodeId] || {}
  const toolResults = toolResultsMap[nodeId] || []

  const registry = createWorkflowToolRegistry(selectedTools, toolRunner)

  const resultMessages = [...messages]
  const newToolResults: any[] = [...toolResults]

  for (const tool of selectedTools) {
    const toolName = tool.function.name
    const rawParams = toolParams[toolName] || {}
    
    const resolvedParams = resolveVariables(rawParams, newToolResults, state)

    try {
      const result = await registry.execute(toolName, resolvedParams)
      
      newToolResults.push(result)

      const toolMessage = buildToolResultMessage(toolName, result)
      resultMessages.push(toolMessage)
    } catch (error) {
      console.error(`工具执行失败: ${toolName}`, error)
      
      const errorResult = buildErrorResult(error)
      newToolResults.push(errorResult)
      
      const errorMessage = buildToolErrorMessage(toolName, error)
      resultMessages.push(errorMessage)
    }
  }

  const result = {
    ...state,
    messages: resultMessages,
    toolResultsMap: {
      ...toolResultsMap,
      [nodeId]: newToolResults
    },
    currentNode: nodeId
  }

  return result
}


/**
 * 代码执行节点执行器
 * 执行上游节点生成的代码
 * 注：移除了workflowEventBus.emit调用，保留代码执行和状态更新逻辑
 *
 * @param state - 当前工作流状态
 * @param nodeId - 节点ID
 * @returns 更新后的工作流状态
 */
export async function codeExecutorNode(
  state: WorkflowState,
  nodeId: string
): Promise<WorkflowState> {
  const { messages, codeExecutorConfigs } = state

  const resultMessages = [...messages]
  let executionResult: { success: boolean; output?: string; error?: string } = {
    success: false,
    error: '没有上游输出'
  }

  if (messages.length > 0) {
    const lastMessage = messages[messages.length - 1]
    const codeContent = extractTextContent(lastMessage.content)

    if (codeContent) {
      const nodeConfig = codeExecutorConfigs?.[nodeId]
      const userInteractiveMode = nodeConfig?.interactiveMode ?? false
      // run_code 节点的 language 参数(YAML params.language)贯通进沙箱;缺省沿用沙箱默认
      const nodeLanguage = nodeConfig?.language
      const detectedInteractive = isInteractiveCode(codeContent)
      const effectiveInteractive = userInteractiveMode || detectedInteractive

      if (effectiveInteractive) {
        const result = interrupt({ type: 'executing', code: codeContent, language: nodeLanguage ?? 'python', autoDetected: !userInteractiveMode })
        executionResult = {
          success: result?.completed ?? false,
          output: result?.output || '',
          error: result?.exitCode !== 0 ? `Exit code: ${result?.exitCode}` : undefined
        }
      } else {
        const { executeInSandbox } = await import('../services/codeExecutor')
        executionResult = await executeInSandbox(codeContent, {
          timeout: 10000,
          memoryLimit: 128,
          defaultLanguage: nodeLanguage as 'javascript' | 'python' | undefined
        })
        if (!executionResult.success && executionResult.error && isInteractiveError(executionResult.error)) {
          executionResult = {
            ...executionResult,
            error: `${executionResult.error}\n\n该代码需要用户交互（如 input()），请开启交互模式后重试`
          }
        }
      }
    }
  }

  const resultMessage = buildCodeExecutionResultMessage(executionResult)
  resultMessages.push(resultMessage)

  const result = {
    ...state,
    messages: resultMessages,
    currentNode: nodeId
  }

  return result
}

/**
 * 普通边配置接口
 */
export interface DefaultEdgeConfig {
  source: string
  target: string
  type?: EdgeType
}

/**
 * 编译工作流图
 * 根据节点和边配置构建并编译 LangGraph 状态图
 *
 * @param nodes - 节点配置数组
 * @param edges - 边配置数组（包含普通边和条件边）
 * @param options - 可选配置
 * @param options.nodeHandlers - 自定义节点处理函数（不传则使用默认的 core 执行器）
 * @param options.checkpointer - 自定义 checkpointer（不传则创建新的 MemorySaver）
 * @returns 编译后的图实例和checkpointer
 */
export function compileWorkflow(
  nodes: WorkflowNodeConfig[],
  edges: (DefaultEdgeConfig | ConditionalEdge)[],
  options?: {
    nodeHandlers?: Record<string, Function>
    checkpointer?: any
  }
): { graph: AnyCompiledGraph; checkpointer: any } {
  // 创建状态图实例
  const graph = new StateGraph(StateAnnotation)

  // 定义节点类型与处理函数的映射关系
  const nodeTypeHandlers: Record<string, any> = options?.nodeHandlers ?? {
    start: startNodeExecutor,
    model: modelNodeExecutor,
    tool: toolNodeExecutor,
    code: codeExecutorNode
  }

  // 记录起始节点ID
  let startNodeId: string | null = null

  // 按源节点分组处理条件边
  const { conditionalEdgesBySource, defaultEdges: rawDefaultEdges } = classifyEdges(edges)
  const defaultEdges: DefaultEdgeConfig[] = rawDefaultEdges

  // 合并条件边
  const mergedEdges = buildMergedEdges(conditionalEdgesBySource)

  // 构建邻接表并检测循环
  const adjacencyList = buildAdjacencyList(defaultEdges, mergedEdges)
  const incomingLoopBranches = computeIncomingLoopBranches(adjacencyList, mergedEdges)

  // 添加节点到状态图
  nodes.forEach((node) => {
    const handler = nodeTypeHandlers[node.type]
    if (handler) {
      const loopBranches = incomingLoopBranches.get(node.id) || []
      const nodeHandler = (state: WorkflowState) => handler(state, node.id, loopBranches)
      graph.addNode(node.id, nodeHandler)
      if (node.type === 'start' && !startNodeId) {
        startNodeId = node.id
      }
    }
  })

  // 添加普通边
  defaultEdges.forEach(({ source, target }) => {
    graph.addEdge(source as any, target as any)
  })

  // 添加条件边
  mergedEdges.forEach((edge) => {
    addConditionalEdgeToGraph(graph, edge)
  })

  // 设置入口点
  if (startNodeId) {
    graph.setEntryPoint(startNodeId as '__start__')
  }

  // 编译（使用传入的 checkpointer 或创建新的）
  const checkpointer = options?.checkpointer ?? createCheckpointer()
  const compiledGraph = graph.compile({ checkpointer }) as unknown as AnyCompiledGraph

  return { graph: compiledGraph, checkpointer }
}

/**
 * 添加条件边到图
 * 支持新版多分支格式（branches 数组）和旧版单条件格式（向后兼容，转换为 BranchConfig 处理）
 * @param graph - 状态图实例
 * @param edge - 条件边配置
 */
export function addConditionalEdgeToGraph(graph: AnyStateGraph, edge: ConditionalEdge): void {
  let router: any
  let mapping: Record<string, string>

  if (edge.data.branches && Array.isArray(edge.data.branches) && edge.data.branches.length > 0) {
    const fallbackNodeId = edge.data.fallbackNodeId || '__end__'
    router = createMultiBranchRouter(edge.data.branches, fallbackNodeId)
    mapping = buildPathMap(edge.data.branches, fallbackNodeId)
  } else if (edge.data.condition) {
    const condition = edge.data.condition
    const fallbackNodeId = condition.fallback || '__end__'

    const legacyBranch: BranchConfig = {
      id: 'legacy_branch',
      label: '条件分支',
      condition: condition as BranchCondition,
      targetNodeId: edge.target,
      priority: 0
    }

    router = createMultiBranchRouter([legacyBranch], fallbackNodeId)
    mapping = buildPathMap([legacyBranch], fallbackNodeId)
  } else {
    throw new Error('Edge must have either branches (new format) or condition (legacy format)')
  }

  graph.addConditionalEdges(edge.source as any, router, mapping)
}

/**
 * 执行工作流
 * 使用graph.invoke一次性返回完整结果
 * 注：与UI使用的streamWorkflow不同，A2A执行使用invoke模式
 * 注：使用sessionId作为thread_id构造config对象
 *
 * @param graph - 编译后的工作流图
 * @param input - 工作流输入状态
 * @param sessionId - 会话ID，用作thread_id
 * @returns 执行完成后的工作流状态
 */
export async function executeWorkflow(
  graph: AnyCompiledGraph,
  input: Partial<WorkflowState>,
  sessionId: string
): Promise<WorkflowState> {
  // 使用sessionId作为thread_id构造config
  const config = { configurable: { thread_id: sessionId } }

  try {
    // 使用invoke一次性返回完整结果（非流式）
    const result = await graph.invoke(input, config)
    return result as WorkflowState
  } catch (error) {
    const errorMessage = getErrorMessage(error, 'Unknown error')
    throw new Error(`Workflow execution failed: ${errorMessage}`)
  }
}

/**
 * 流式执行工作流
 * 使用graph.stream返回状态更新流
 * 注：适用于A2A SSE流式响应场景
 * 注：使用sessionId作为thread_id构造config对象
 *
 * @param graph - 编译后的工作流图
 * @param input - 工作流输入状态
 * @param sessionId - 会话ID，用作thread_id
 * @yields 工作流状态更新
 */
export async function* streamWorkflow(
  graph: AnyCompiledGraph,
  input: Partial<WorkflowState>,
  sessionId: string
): AsyncGenerator<WorkflowState, void, unknown> {
  // 使用sessionId作为thread_id构造config
  const config = { configurable: { thread_id: sessionId } }

  try {
    // 使用stream返回状态更新流
    const stream = await graph.stream(input, { ...config, streamMode: 'updates' as const })

    for await (const update of stream) {
      // 每个update是一个Partial<WorkflowState>
      yield update as unknown as WorkflowState
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error, 'Unknown error')
    throw new Error(`Workflow stream failed: ${errorMessage}`)
  }
}
