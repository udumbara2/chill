/**
 * 工作流执行器模块
 * 整合图构建、编译、执行逻辑
 * 注：供Electron主进程的IPC Handler调用
 */

export * from './reExports'

import { createCheckpointer } from './reExports'
import { createStateStore } from './shared'
import type { AnyCompiledGraph } from './shared'

export interface WorkflowExecutionState {
  workflowId: string
  threadId: string
  state: 'pending' | 'running' | 'interrupted' | 'completed' | 'failed'
  createdAt: number
  updatedAt: number
  graph?: AnyCompiledGraph
  checkpointer?: ReturnType<typeof createCheckpointer>
  savedConfig?: { configurable: { thread_id: string } }
  error?: string
}

const workflowStateStore = createStateStore<WorkflowExecutionState>({ state: 'pending' as const })

export function getWorkflowState(workflowId: string): WorkflowExecutionState | undefined {
  return workflowStateStore.get(workflowId)
}

export function updateWorkflowState(workflowId: string, state: Partial<WorkflowExecutionState>): void {
  workflowStateStore.update(workflowId, state)
}

export function createWorkflowState(workflowId: string, threadId: string): WorkflowExecutionState {
  return workflowStateStore.create(workflowId, { workflowId, threadId } as Partial<WorkflowExecutionState>)
}

export function clearWorkflowState(workflowId: string): void {
  workflowStateStore.remove(workflowId)
}
