export interface IA2AExecutor {
  executeTask(agent: Record<string, unknown>, params: Record<string, unknown>): Promise<Record<string, unknown>>
  executeTaskSync(agent: Record<string, unknown>, params: Record<string, unknown>): Promise<Record<string, unknown>>
  executeTaskStream(
    agent: Record<string, unknown>,
    params: Record<string, unknown>,
    onStatusUpdate: (event: Record<string, unknown>) => void
  ): Promise<Record<string, unknown>>
  cancelTask(taskId: string): { success: boolean; task?: Record<string, unknown>; error?: { code: number; message: string } }
  getTaskState(taskId: string): Record<string, unknown> | undefined
}
