import {
  executeA2ATask,
  executeA2ATaskSync,
  executeA2ATaskStream,
  getTaskState,
  cancelTask,
  type TaskStatusUpdateEvent
} from '@assistant-ai/core'
import type { IA2AExecutor, SavedAgent } from '@assistant-ai/core'

export class LocalA2AExecutor implements IA2AExecutor {
  async executeTask(
    agent: Record<string, unknown>,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const result = await executeA2ATask(agent as unknown as SavedAgent, params as any)
    return result as unknown as Record<string, unknown>
  }

  async executeTaskSync(
    agent: Record<string, unknown>,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const result = await executeA2ATaskSync(agent as unknown as SavedAgent, params as any)
    return result as unknown as Record<string, unknown>
  }

  async executeTaskStream(
    agent: Record<string, unknown>,
    params: Record<string, unknown>,
    onStatusUpdate: (event: Record<string, unknown>) => void
  ): Promise<Record<string, unknown>> {
    const result = await executeA2ATaskStream(
      agent as unknown as SavedAgent,
      params as any,
      (event: TaskStatusUpdateEvent) => {
        onStatusUpdate(event as unknown as Record<string, unknown>)
      }
    )
    return result as unknown as Record<string, unknown>
  }

  cancelTask(taskId: string): { success: boolean; task?: Record<string, unknown>; error?: { code: number; message: string } } {
    const result = cancelTask(taskId)
    return {
      success: result.success,
      task: result.task as unknown as Record<string, unknown> | undefined,
      error: result.error
    }
  }

  getTaskState(taskId: string): Record<string, unknown> | undefined {
    const state = getTaskState(taskId)
    return state as unknown as Record<string, unknown> | undefined
  }
}
