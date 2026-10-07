import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Message, ModelConfig, ToolDefinition, StreamCallback, ModelType, NamespacedWorkflowEventBus, ISecureStorage, AnyStateGraph, AnyCompiledGraph, WorkflowState, WorkflowNodeConfig as BaseWorkflowNodeConfig } from '@assistant-ai/core'
import { createWorkflowModelServiceFactory, workflowEventBus, WORKFLOW_EVENTS, compileWorkflow, SecureStorageService, prependSystemPrompt, createToolRegistry, buildModelConfig, incrementBranchLoopCounts, validateModelConfig, buildAssistantMessage, startNodeExecutor, toolNodeExecutor, codeExecutorNode as coreCodeExecutorNode } from '@assistant-ai/core'
import { MemorySaver, Command, GraphInterrupt } from '@langchain/langgraph/web'

const secureStorageAdapter: ISecureStorage = {
  storeApiKey: (provider, key) => SecureStorageService.storeApiKey(provider, key),
  getApiKey: (provider) => SecureStorageService.getApiKey(provider),
  hasApiKey: (provider) => SecureStorageService.hasApiKey(provider),
  deleteApiKey: (provider) => SecureStorageService.deleteApiKey(provider),
  getAllProviders: () => SecureStorageService.getAllProviders(),
}

interface WorkflowNodeConfig extends BaseWorkflowNodeConfig {
  label: string
  modelType?: ModelType
  modelName?: string
  systemPrompt?: string
  parameters?: Partial<ModelConfig>
  selectedTools?: ToolDefinition[]
}


export function startNode(state: WorkflowState, nodeId: string): WorkflowState {
  workflowEventBus.emit(WORKFLOW_EVENTS.NODE_STARTED, { nodeId })
  const result = startNodeExecutor(state, nodeId)
  workflowEventBus.emit(WORKFLOW_EVENTS.NODE_COMPLETED, { nodeId, result, values: result })
  return result
}

async function modelNode(
  state: WorkflowState, 
  nodeId: string, 
  loopBranches: Array<{ branchId: string; maxIterations?: number }> = []
): Promise<WorkflowState> {
  const { messages, modelConfigs, selectedToolsMap, systemPrompts, branchLoopCounts } = state
  
  const modelConfig = modelConfigs[nodeId]
  const selectedTools = selectedToolsMap[nodeId] || []

  // 更新指向当前节点的循环分支计数器
  const updatedBranchCounts = incrementBranchLoopCounts(branchLoopCounts, loopBranches)
  for (const loopBranch of loopBranches) {
    // 检测循环开始：第一次计数时触发循环开始事件
    if (updatedBranchCounts[loopBranch.branchId] === 1) {
      workflowEventBus.emit(WORKFLOW_EVENTS.LOOP_STARTED, {
        branchId: loopBranch.branchId,
        nodeId: nodeId,
        maxIterations: loopBranch.maxIterations
      })
    }

    // 触发迭代更新事件（每次计数器更新都触发，用于实时显示迭代次数）
    workflowEventBus.emit(WORKFLOW_EVENTS.LOOP_ITERATION_UPDATED, {
      branchId: loopBranch.branchId,
      nodeId: nodeId,
      currentIteration: updatedBranchCounts[loopBranch.branchId],
      maxIterations: loopBranch.maxIterations
    })
  }
  
  const factory = createWorkflowModelServiceFactory(undefined, secureStorageAdapter)
  
  const modelInfo = validateModelConfig(modelConfig, nodeId)

  let responseContent = ''

  const customConfig = buildModelConfig(modelConfig, modelConfig.stream)

  const systemPrompt = systemPrompts[nodeId] || ''
  let finalMessages = prependSystemPrompt([...messages], systemPrompt)

  workflowEventBus.emit(WORKFLOW_EVENTS.NODE_STARTED, {
    nodeId
  })

  // 创建工具注册表并注册选中的工具
  const registry = createToolRegistry(selectedTools)

  const isStream = modelConfig.stream !== false;
  if (isStream) {
    const onChunk: StreamCallback = (chunk) => {
      if (chunk.content) {
        responseContent += chunk.content
      }
      
      if (chunk.content || chunk.reasoningContent) {
        workflowEventBus.emit(WORKFLOW_EVENTS.STREAM_CHUNK, {
          nodeId,
          chunk: {
            content: chunk.content || '',
            reasoningContent: chunk.reasoningContent || '',
            toolCalls: chunk.toolCalls,
            isStreamComplete: false
          }
        })
      }
    }
    
    await factory.sendMessage(
      modelInfo.type,
      finalMessages,
      selectedTools,
      registry,  // 传递工具注册表
      onChunk,
      customConfig,
      undefined,
      modelInfo.name
    )
  } else {
    const response = await factory.sendMessage(
      modelInfo.type,
      finalMessages,
      selectedTools,
      registry,  // 传递工具注册表
      undefined,
      customConfig,
      undefined,
      modelInfo.name
    )
    
    responseContent = response.content || '';
    
    workflowEventBus.emit(WORKFLOW_EVENTS.STREAM_CHUNK, {
      nodeId,
      chunk: {
        content: response.content || '',
        reasoningContent: response.reasoningContent || '',
        toolCalls: response.toolCalls,
        isStreamComplete: true
      }
    })
  }

  const assistantMessage = buildAssistantMessage(responseContent)

  const resultMessages = [...messages, assistantMessage]

  workflowEventBus.emit(WORKFLOW_EVENTS.STREAM_COMPLETE, {
    nodeId,
    finalContent: responseContent
  })

  const result = {
    ...state,
    messages: resultMessages,
    currentNode: nodeId,
    iterationCount: (state.iterationCount || 0) + 1,
    branchLoopCounts: updatedBranchCounts
  }

  workflowEventBus.emit(WORKFLOW_EVENTS.NODE_COMPLETED, {
    nodeId,
    result: result,
    values: result
  })

  return result
}

export async function toolNode(
  state: WorkflowState, 
  nodeId: string
): Promise<WorkflowState> {
  workflowEventBus.emit(WORKFLOW_EVENTS.NODE_STARTED, { nodeId })
  const result = await toolNodeExecutor(state, nodeId)
  workflowEventBus.emit(WORKFLOW_EVENTS.NODE_COMPLETED, { nodeId, result, values: result })
  return result
}

async function codeExecutorNode(
  state: WorkflowState,
  nodeId: string
): Promise<WorkflowState> {
  workflowEventBus.emit(WORKFLOW_EVENTS.NODE_STARTED, { nodeId })
  const result = await coreCodeExecutorNode(state, nodeId)
  workflowEventBus.emit(WORKFLOW_EVENTS.NODE_COMPLETED, { nodeId, result, values: result })
  return result
}

/**
 * 单个工作流的状态结构
 * 用于Map<workflowId, WorkflowInstanceState>存储
 */
interface WorkflowInstanceState {
  workflow: AnyStateGraph | null
  compiledGraph: AnyCompiledGraph | null
  executionState: WorkflowState | null
  isExecuting: boolean
  error: string | null
  currentThreadId: string | null
  checkpointer: MemorySaver
  nodes: any[]
  edges: any[]
  executionRecords: any[] // 执行历史记录（临时存储，用于工作流切换时保留调试状态）
  savedConfig: { configurable: { thread_id: string } } | null
}

/**
 * 创建新的工作流实例状态
 */
function createWorkflowInstanceState(): WorkflowInstanceState {
  return {
    workflow: null,
    compiledGraph: null,
    executionState: null,
    isExecuting: false,
    error: null,
    currentThreadId: null,
    checkpointer: new MemorySaver(),
    nodes: [],
    edges: [],
    executionRecords: [],
    savedConfig: null
  }
}

export const useWorkflowStore = defineStore('workflow', () => {
  // 使用Map存储多个工作流的状态，key为workflowId
  const workflows = new Map<string, WorkflowInstanceState>()

  // 全局执行状态（用于UI显示侧边栏"执行中"提示）
  const isExecuting = ref(false)

  // 将 computed 属性改为函数，接收 workflowId 参数
  function hasWorkflow(workflowId: string = 'default'): boolean {
    const state = workflows.get(workflowId)
    return state?.workflow !== null && state?.workflow !== undefined
  }

  function isReady(workflowId: string = 'default'): boolean {
    const state = workflows.get(workflowId)
    return state?.compiledGraph !== null && state?.compiledGraph !== undefined
  }

  /**
   * 创建工作流
   * @param graph - 状态图实例
   * @param workflowId - 工作流唯一标识（用于隔离）
   */
  function createWorkflow(graph: AnyStateGraph, workflowId: string) {
    // 获取或创建工作流实例状态
    let state = workflows.get(workflowId)
    if (!state) {
      state = createWorkflowInstanceState()
      workflows.set(workflowId, state)
    }

    // 更新状态
    state.workflow = graph
    state.compiledGraph = graph.compile({ checkpointer: state.checkpointer }) as unknown as AnyCompiledGraph
  }

  /**
   * 创建带有起始节点的工作流
   * 根据提供的节点和边配置构建状态图，并编译成可执行的工作流
   * 
   * @param nodes - 节点配置数组，包含节点的类型、ID等信息
   * @param edges - 边配置数组，定义节点之间的连接关系
   * @param workflowId - 工作流唯一标识（用于隔离）
   */
  function createWorkflowWithStartNode(nodes: any[] = [], edges: any[] = [], workflowId: string = 'default') {
    let state = workflows.get(workflowId)
    if (!state) {
      state = createWorkflowInstanceState()
      workflows.set(workflowId, state)
    }

    const { graph } = compileWorkflow(nodes, edges, {
      nodeHandlers: { start: startNode, model: modelNode, tool: toolNode, code: codeExecutorNode },
      checkpointer: state.checkpointer
    })

    state.compiledGraph = graph
  }

  async function streamWorkflow(
    input: Partial<WorkflowState>,
    onChunk?: StreamCallback,
    workflowId: string = 'default',
    namespacedEventBus?: NamespacedWorkflowEventBus
  ): Promise<void> {
    // 从Map获取工作流状态
    let state = workflows.get(workflowId)
    if (!state) {
      state = createWorkflowInstanceState()
      workflows.set(workflowId, state)
    }

    if (!state.compiledGraph) {
      throw new Error('Workflow not compiled. Please create workflow first.')
    }

    // 生成与workflowId绑定的threadId
    const threadId = `thread_${workflowId}_${Date.now()}`
    state.currentThreadId = threadId

    const config = { configurable: { thread_id: threadId } }

    state.isExecuting = true
    state.error = null

    isExecuting.value = true

    let isInterrupted = false

    // 使用命名空间 eventBus 或全局 eventBus
    const eventBus = namespacedEventBus || workflowEventBus

    // 如果使用了命名空间 eventBus，设置全局事件转发
    let unsubscribeForwarder: (() => void) | null = null
    if (namespacedEventBus) {
      unsubscribeForwarder = workflowEventBus.forwardTo(namespacedEventBus)
    }

    eventBus.emit(WORKFLOW_EVENTS.STREAM_START, {})

    try {
      console.log('=== DEBUG HITL === streamWorkflow: 准备调用 compiledGraph.stream')
      const stream = await state.compiledGraph.stream(input, config)
      console.log('=== DEBUG HITL === streamWorkflow: stream 创建成功，开始迭代')
      let chunkCount = 0
      for await (const chunk of stream as AsyncIterable<any>) {
        chunkCount++
        console.log('=== DEBUG HITL === streamWorkflow: chunk #' + chunkCount, chunk)
        
        if (chunk.__interrupt__) {
          console.log('=== DEBUG HITL === streamWorkflow: 检测到 __interrupt__ chunk')
          state.savedConfig = config
          const interruptData = chunk.__interrupt__[0]?.value
          console.log('=== DEBUG HITL === streamWorkflow: interruptData=', interruptData)
          if (interruptData) {
            console.log('=== DEBUG HITL === streamWorkflow: 准备发送 INTERRUPT 事件')
            eventBus.emit(WORKFLOW_EVENTS.INTERRUPT, interruptData)
          }
          isInterrupted = true
          break
        }
        
        const modelChunk = chunk.model || chunk
        if (onChunk) {
          onChunk({
            content: typeof modelChunk === 'string' ? modelChunk : (modelChunk.content || ''),
            reasoningContent: modelChunk.reasoningContent,
            toolCalls: modelChunk.toolCalls,
            isStreamComplete: modelChunk.isStreamComplete || false
          })
        }
      }
      console.log('=== DEBUG HITL === streamWorkflow: stream 迭代完成，共 ' + chunkCount + ' 个 chunk')
    } catch (e) {
      console.log('=== DEBUG HITL === streamWorkflow catch: e=', e, 'e instanceof GraphInterrupt=', e instanceof GraphInterrupt)
      console.log('=== DEBUG HITL === streamWorkflow catch: e.constructor.name=', (e as any)?.constructor?.name)
      if (e instanceof GraphInterrupt) {
        console.log('=== DEBUG HITL === streamWorkflow: 捕获到 GraphInterrupt')
        state.savedConfig = config
        const interruptData = (e as any).interrupts?.[0]?.value
        console.log('=== DEBUG HITL === streamWorkflow: interruptData=', interruptData)
        if (interruptData) {
          console.log('=== DEBUG HITL === streamWorkflow: 准备发送 INTERRUPT 事件')
          eventBus.emit(WORKFLOW_EVENTS.INTERRUPT, interruptData)
        }
        isInterrupted = true
      } else {
        console.log('=== DEBUG HITL === streamWorkflow: 非 GraphInterrupt 错误')
        const errorMessage = e instanceof Error ? e.message : 'Unknown error'
        state.error = errorMessage
        throw e
      }
    } finally {
      if (!isInterrupted) {
        state.isExecuting = false
        isExecuting.value = false
        eventBus.emit(WORKFLOW_EVENTS.STREAM_COMPLETE, {})
        // 清理事件转发
        if (unsubscribeForwarder) {
          unsubscribeForwarder()
        }
        // 工作流执行完成，清理所有循环高亮
        clearLoopHighlights()
      }
    }
  }

  async function resumeWorkflow(
    userInput: any,
    workflowId: string = 'default'
  ): Promise<void> {
    console.log('=== DEBUG HITL === resumeWorkflow 被调用: userInput=', userInput, 'workflowId=', workflowId)
    const state = workflows.get(workflowId)
    if (!state || !state.compiledGraph || !state.savedConfig) {
      throw new Error('Workflow not interrupted or not found.')
    }

    const eventBus = workflowEventBus

    try {
      console.log('=== DEBUG HITL === resumeWorkflow: 准备调用 compiledGraph.invoke')
      await state.compiledGraph.invoke(
        new Command({ resume: userInput }),
        state.savedConfig
      )
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error'
      state.error = errorMessage
      throw e
    } finally {
      state.isExecuting = false
      isExecuting.value = false
      state.savedConfig = null
      eventBus.emit(WORKFLOW_EVENTS.STREAM_COMPLETE, {})
      clearLoopHighlights()
    }
  }

  function updateNodeConfig(config: Partial<WorkflowNodeConfig>, workflowId: string = 'default') {
    // 从Map获取工作流状态
    const state = workflows.get(workflowId)
    if (state?.executionState) {
      state.executionState.modelConfigs = {
        ...state.executionState.modelConfigs,
        ...config.parameters
      } as Record<string, Record<string, any>>
    }
  }

  async function executeNode(
    nodeConfig: WorkflowNodeConfig,
    messages: Message[],
    onChunk: StreamCallback,
    workflowId: string = 'default'
  ): Promise<void> {
    // 从Map获取工作流状态
    let state = workflows.get(workflowId)
    if (!state) {
      state = createWorkflowInstanceState()
      workflows.set(workflowId, state)
    }

    const factory = createWorkflowModelServiceFactory(undefined, secureStorageAdapter)
    
    if (!nodeConfig.modelType) {
      throw new Error('Node model type is not configured')
    }

    try {
      let finalMessages = prependSystemPrompt([...messages], nodeConfig.systemPrompt || '')

      // 创建工具注册表并注册选中的工具
      const registry = createToolRegistry(nodeConfig.selectedTools || [])

      const isStream = nodeConfig.parameters?.stream !== false
      const customConfig: Partial<ModelConfig> = {
        ...(nodeConfig.parameters || {}),
        apiKey: nodeConfig.parameters?.apiKey
      }
      if (isStream) {
        await factory.sendMessage(
          nodeConfig.modelType,
          finalMessages,
          nodeConfig.selectedTools,
          registry,
          onChunk,
          customConfig,
          undefined,
          nodeConfig.modelName
        )
      } else {
        const response = await factory.sendMessage(
          nodeConfig.modelType,
          finalMessages,
          nodeConfig.selectedTools,
          registry,
          undefined,
          customConfig,
          undefined,
          nodeConfig.modelName
        )
        
        if (onChunk) {
          onChunk({
            content: response.content || '',
            reasoningContent: response.reasoningContent || '',
            toolCalls: response.toolCalls,
            isStreamComplete: true
          })
        }
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error'
      state.error = errorMessage
      throw e
    }
  }

  async function getExecutionHistory(workflowId: string = 'default'): Promise<any[]> {
    // 从Map获取工作流状态
    const state = workflows.get(workflowId)
    if (!state?.compiledGraph || !state?.currentThreadId) {
      return []
    }

    const config = { configurable: { thread_id: state.currentThreadId } }
    const history = await state.compiledGraph.getStateHistory(config)
    
    const result: any[] = []
    for await (const item of history) {
      result.push(item)
    }
    
    return result
  }

  async function getCurrentState(workflowId: string = 'default'): Promise<WorkflowState | null> {
    // 从Map获取工作流状态
    const state = workflows.get(workflowId)
    if (!state?.compiledGraph || !state?.currentThreadId) {
      return null
    }

    const config = { configurable: { thread_id: state.currentThreadId } }
    const currentState = await state.compiledGraph.getState(config)
    
    return currentState.values as WorkflowState
  }

  /**
   * 检查工作流是否已完成
   * 使用 LangGraph 官方推荐的 next 字段判断
   * @param workflowId - 工作流唯一标识
   * @returns true 如果工作流已完成，否则返回 false
   */
  async function isWorkflowComplete(workflowId: string = 'default'): Promise<boolean> {
    const state = workflows.get(workflowId)
    if (!state?.compiledGraph || !state?.currentThreadId) {
      return false
    }

    const config = { configurable: { thread_id: state.currentThreadId } }
    const snapshot = await state.compiledGraph.getState(config)
    
    // LangGraph 官方推荐：next 为空元组表示工作流已完成
    return snapshot.next.length === 0
  }

  function resetWorkflow(workflowId: string = 'default') {
    // 从Map获取工作流状态
    const state = workflows.get(workflowId)
    if (state) {
      state.workflow = null
      state.compiledGraph = null
      state.executionState = null
      state.isExecuting = false
      state.error = null
      state.currentThreadId = null
    }
    isExecuting.value = false
  }

  /**
   * 清理工作流
   * 从Map中完全删除指定workflowId的状态，释放内存
   * @param workflowId - 工作流唯一标识
   */
  function cleanupWorkflow(workflowId: string = 'default') {
    // 从Map中删除工作流状态
    workflows.delete(workflowId)

    isExecuting.value = false
  }

  /**
   * 保存工作流的节点和边数据
   * @param workflowId - 工作流唯一标识
   * @param nodes - 节点数据
   * @param edges - 边数据
   */
  function saveWorkflowData(workflowId: string, nodes: any[], edges: any[]) {
    let state = workflows.get(workflowId)
    if (!state) {
      state = createWorkflowInstanceState()
      workflows.set(workflowId, state)
    }
    state.nodes = JSON.parse(JSON.stringify(nodes))
    state.edges = JSON.parse(JSON.stringify(edges))
  }

  /**
   * 获取工作流的节点和边数据
   * @param workflowId - 工作流唯一标识
   * @returns 节点和边数据
   */
  function getWorkflowData(workflowId: string): { nodes: any[]; edges: any[] } {
    const state = workflows.get(workflowId)
    if (state) {
      return {
        nodes: JSON.parse(JSON.stringify(state.nodes)),
        edges: JSON.parse(JSON.stringify(state.edges))
      }
    }
    return { nodes: [], edges: [] }
  }

  /**
   * 保存工作流的执行记录（临时存储，用于工作流切换时保留调试状态）
   * @param workflowId - 工作流唯一标识
   * @param records - 执行记录数组
   */
  function saveExecutionRecords(workflowId: string, records: any[]) {
    let state = workflows.get(workflowId)
    if (!state) {
      state = createWorkflowInstanceState()
      workflows.set(workflowId, state)
    }
    state.executionRecords = JSON.parse(JSON.stringify(records))
  }

  /**
   * 获取工作流的执行记录（临时存储）
   * @param workflowId - 工作流唯一标识
   * @returns 执行记录数组
   */
  function getExecutionRecords(workflowId: string): any[] {
    const state = workflows.get(workflowId)
    if (state) {
      return JSON.parse(JSON.stringify(state.executionRecords || []))
    }
    return []
  }

  /**
   * 清理所有循环高亮状态
   * 在工作流执行结束或重置时调用
   */
  function clearLoopHighlights() {
    workflowEventBus.emit(WORKFLOW_EVENTS.LOOP_COMPLETED, {
      branchId: '*',
      nodeId: '*'
    })
  }

  return {
    isExecuting,
    hasWorkflow,
    isReady,
    createWorkflow,
    createWorkflowWithStartNode,
    streamWorkflow,
    resumeWorkflow,
    updateNodeConfig,
    executeNode,
    getExecutionHistory,
    getCurrentState,
    isWorkflowComplete,
    resetWorkflow,
    cleanupWorkflow,
    saveWorkflowData,
    getWorkflowData,
    saveExecutionRecords,
    getExecutionRecords
  }
})
