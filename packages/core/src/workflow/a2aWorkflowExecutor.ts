/**
 * A2A工作流执行器模块
 * 整合图构建、编译、执行逻辑
 * 注：仅整合2.4-2.8的函数，不新增业务逻辑
 * 注：供Electron主进程的A2A HTTP服务器调用
 */

import type { ISecureStorage } from '../interfaces/ISecureStorage'

let _secureStorage: ISecureStorage | null = null
export function setA2ASecureStorage(s: ISecureStorage): void {
  _secureStorage = s
}

export * from './reExports'

export { A2ATaskState } from '../types/workflow'

import { extractTextContent, getErrorMessage, createStateStore } from './shared'
import { executeWorkflow, streamWorkflow, compileWorkflow } from './workflowGraphBuilder'
import type { WorkflowState, AnyCompiledGraph } from './shared'

import type { SavedAgent } from '../types/workflow'

import type { ToolDefinition } from '../services/models/types'

async function getApiKeyFromSecureStorage(provider: string): Promise<string> {
  try {
    const key = await _secureStorage!.getApiKey(provider)
    return key || ''
  } catch (error) {
    console.error(`Failed to get API key for ${provider}:`, error)
    return ''
  }
}

export async function extractConfigsFromAgent(agent: SavedAgent): Promise<{
  modelConfigs: Record<string, Record<string, any>>
  systemPrompts: Record<string, string>
  selectedToolsMap: Record<string, ToolDefinition[]>
  toolParamsMap: Record<string, Record<string, any>>
}> {
  const modelConfigs: Record<string, Record<string, any>> = {}
  const systemPrompts: Record<string, string> = {}
  const selectedToolsMap: Record<string, ToolDefinition[]> = {}
  const toolParamsMap: Record<string, Record<string, any>> = {}

  for (const node of agent.nodes) {
    if (node.type === 'model' && node.data) {
      const data = node.data as any

      if (data.selectedModel) {
        const modelType = data.selectedModel.type

        const apiKey = await getApiKeyFromSecureStorage(modelType)

        modelConfigs[node.id] = {
          model: data.selectedModel.name,
          modelType: modelType,
          apiKey: apiKey,
          ...data.parameters
        }
      }

      systemPrompts[node.id] = data.systemPrompt || ''

      selectedToolsMap[node.id] = data.selectedTools || []
    }

    if (node.type === 'tool' && node.data) {
      const data = node.data as any

      selectedToolsMap[node.id] = data.selectedTools || []

      toolParamsMap[node.id] = data.toolParams || {}
    }
  }

  return { modelConfigs, systemPrompts, selectedToolsMap, toolParamsMap }
}

export interface TaskExecutionState {
  taskId: string
  sessionId: string
  state: string
  createdAt: number
  updatedAt: number
  result?: A2AWorkflowTaskResponse
  error?: string
  abortController?: AbortController
}

const taskStateStore = createStateStore<TaskExecutionState>({ state: 'submitted' as const })

const taskAbortControllers = new Map<string, AbortController>()

export function clearAllAbortControllers(): void {
  taskAbortControllers.forEach((abortController, taskId) => {
    try {
      abortController.abort()
    } catch (error) {
      console.error(`Failed to abort task ${taskId}:`, error)
    }
  })
  taskAbortControllers.clear()
  console.log('All AbortControllers cleared')
}

export function getTaskState(taskId: string): TaskExecutionState | undefined {
  return taskStateStore.get(taskId)
}

export function updateTaskState(taskId: string, state: Partial<TaskExecutionState>): void {
  taskStateStore.update(taskId, state)
}

export function createTaskState(taskId: string, sessionId: string): TaskExecutionState {
  return taskStateStore.create(taskId, { taskId, sessionId } as Partial<TaskExecutionState>)
}

export function cancelTask(taskId: string): { success: boolean; task?: A2AWorkflowTaskResponse; error?: { code: number; message: string } } {
  const taskState = getTaskState(taskId)

  if (!taskState) {
    return {
      success: false,
      error: {
        code: -32000,
        message: `Task not found: ${taskId}`
      }
    }
  }

  if (taskState.state === 'completed') {
    return {
      success: false,
      error: {
        code: -32000,
        message: 'Task not cancelable: task is already completed'
      }
    }
  }

  if (taskState.state === 'canceled') {
    return {
      success: false,
      error: {
        code: -32000,
        message: 'Task not cancelable: task is already canceled'
      }
    }
  }

  const abortController = taskAbortControllers.get(taskId)
  if (abortController) {
    abortController.abort()
    taskAbortControllers.delete(taskId)
  }

  updateTaskState(taskId, { state: 'canceled' })

  const task: A2AWorkflowTaskResponse = {
    id: taskState.taskId,
    sessionId: taskState.sessionId,
    status: {
      state: 'canceled'
    }
  }

  if (taskState.result) {
    task.status = taskState.result.status
    task.artifacts = taskState.result.artifacts
    task.history = taskState.result.history
  }

  return {
    success: true,
    task
  }
}

export interface A2AMessagePart {
  type: 'text' | 'file' | 'data'
  text?: string
  file?: {
    name?: string
    mimeType?: string
    bytes?: string
    uri?: string
  }
  data?: any
}

export interface A2AMessage {
  role: 'user' | 'agent'
  parts: A2AMessagePart[]
}

export interface A2ATaskParams {
  id: string
  sessionId?: string
  message: A2AMessage
}

export interface TaskStatusUpdateEvent {
  id: string
  status: {
    state: string
    message?: A2AMessage
  }
  final: boolean
}

export interface TaskArtifactUpdateEvent {
  id: string
  artifact: A2AArtifact
  final: boolean
}

export function convertA2AToWorkflowInput(params: A2ATaskParams): Partial<WorkflowState> {
  const { message } = params

  let text = ''
  const files: string[] = []

  for (const part of message.parts) {
    if (part.type === 'text' && part.text) {
      text += part.text
    } else if (part.type === 'file' && part.file) {
      if (part.file.uri) {
        files.push(part.file.uri)
      } else if (part.file.name) {
        files.push(part.file.name)
      }
    }
  }

  const input: Partial<WorkflowState> = {
    text: text.trim() || undefined,
    files: files.length > 0 ? files : undefined,
    messages: []
  }

  return input
}

export interface A2AArtifact {
  parts: A2AMessagePart[]
  metadata?: Record<string, any>
}

export interface A2ATaskStatus {
  state: string
  message?: A2AMessage
}

export interface A2AWorkflowTaskResponse {
  id: string
  sessionId: string
  status: A2ATaskStatus
  artifacts?: A2AArtifact[]
  history?: A2AMessage[]
}

export function convertWorkflowOutputToA2A(
  taskId: string,
  sessionId: string,
  state: WorkflowState
): A2AWorkflowTaskResponse {
  const messages = state.messages || []
  const lastAssistantMessage = [...messages].reverse().find(
    (msg) => msg.role === 'assistant'
  )

  const rawContent = lastAssistantMessage?.content || ''
  const responseText = extractTextContent(rawContent)

  const response: A2AWorkflowTaskResponse = {
    id: taskId,
    sessionId: sessionId,
    status: {
      state: 'completed'
    },
    artifacts: [
      {
        parts: [
          {
            type: 'text',
            text: responseText
          }
        ]
      }
    ]
  }

  return response
}

function completeTaskState(taskId: string, result: A2AWorkflowTaskResponse): void {
  updateTaskState(taskId, { state: 'completed', result })
}

function failTaskState(taskId: string, errorMessage: string): void {
  updateTaskState(taskId, { state: 'failed', error: errorMessage })
}

async function prepareA2AExecution(agent: SavedAgent, params: A2ATaskParams): Promise<{
  graph: AnyCompiledGraph
  workflowInput: Partial<WorkflowState>
}> {
  const { modelConfigs, systemPrompts, selectedToolsMap, toolParamsMap } = await extractConfigsFromAgent(agent)

  const workflowInput: Partial<WorkflowState> = {
    ...convertA2AToWorkflowInput(params),
    modelConfigs,
    systemPrompts,
    selectedToolsMap,
    toolParamsMap
  }

  const { graph } = compileWorkflow(agent.nodes as any, agent.edges as any)
  return { graph, workflowInput }
}

export async function executeA2ATask(
  agent: SavedAgent,
  params: A2ATaskParams
): Promise<A2AWorkflowTaskResponse> {
  const { id: taskId, sessionId = taskId } = params

  createTaskState(taskId, sessionId)

  const abortController = new AbortController()
  taskAbortControllers.set(taskId, abortController)

  updateTaskState(taskId, { abortController })

  ;(async () => {
    try {
      updateTaskState(taskId, { state: 'working' })

      const { graph, workflowInput } = await prepareA2AExecution(agent, params)

      const finalState = await executeWorkflow(graph, workflowInput, sessionId)

      const response = convertWorkflowOutputToA2A(taskId, sessionId, finalState)

      completeTaskState(taskId, response)
    } catch (error) {
      console.error(`Task ${taskId} execution failed:`, error)
      failTaskState(taskId, getErrorMessage(error))
    } finally {
      taskAbortControllers.delete(taskId)
    }
  })()

  return {
    id: taskId,
    sessionId: sessionId,
    status: {
      state: 'submitted'
    }
  }
}

export async function executeA2ATaskSync(
  agent: SavedAgent,
  params: A2ATaskParams
): Promise<A2AWorkflowTaskResponse> {
  const { id: taskId, sessionId = taskId } = params

  createTaskState(taskId, sessionId)

  const abortController = new AbortController()
  taskAbortControllers.set(taskId, abortController)

  updateTaskState(taskId, { abortController, state: 'working' })

  try {
    const { graph, workflowInput } = await prepareA2AExecution(agent, params)

    const finalState = await executeWorkflow(graph, workflowInput, sessionId)

    const response = convertWorkflowOutputToA2A(taskId, sessionId, finalState)

    completeTaskState(taskId, response)

    return response
  } catch (error) {
    console.error(`Task ${taskId} execution failed:`, error)
    failTaskState(taskId, getErrorMessage(error))
    throw error
  } finally {
    taskAbortControllers.delete(taskId)
  }
}

export async function executeA2ATaskStream(
  agent: SavedAgent,
  params: A2ATaskParams,
  onStatusUpdate: (event: TaskStatusUpdateEvent) => void,
  _onArtifactUpdate?: (event: TaskArtifactUpdateEvent) => void
): Promise<A2AWorkflowTaskResponse> {
  const { id: taskId, sessionId = taskId } = params

  createTaskState(taskId, sessionId)

  try {
    updateTaskState(taskId, { state: 'working' })

    onStatusUpdate({
      id: taskId,
      status: {
        state: 'working'
      },
      final: false
    })

    const { graph, workflowInput } = await prepareA2AExecution(agent, params)

    const stateUpdates: WorkflowState[] = []
    for await (const state of streamWorkflow(graph, workflowInput, sessionId)) {
      stateUpdates.push(state)

      onStatusUpdate({
        id: taskId,
        status: {
          state: 'working'
        },
        final: false
      })
    }

    const finalState = stateUpdates[stateUpdates.length - 1]

    const response = convertWorkflowOutputToA2A(taskId, sessionId, finalState)

    completeTaskState(taskId, response)

    onStatusUpdate({
      id: taskId,
      status: response.status,
      final: true
    })

    return response
  } catch (error) {
    console.error(`Task ${taskId} stream execution failed:`, error)

    const msg = getErrorMessage(error)
    failTaskState(taskId, msg)

    onStatusUpdate({
      id: taskId,
      status: {
        state: 'failed',
        message: {
          role: 'agent',
          parts: [{ type: 'text', text: msg }]
        }
      },
      final: true
    })

    return {
      id: taskId,
      sessionId: sessionId,
      status: {
        state: 'failed',
        message: {
          role: 'agent',
          parts: [{ type: 'text', text: msg }]
        }
      }
    }
  }
}
