import type { ToolDefinition } from '../types/models'
import type { ISubagentExecutor, SubagentExecuteExtras } from './ISubagentExecutor'

let _executor: ISubagentExecutor['execute'] | null = null

export class SubagentExecutor implements ISubagentExecutor {
  static setExecutor(fn: ISubagentExecutor['execute']): void {
    _executor = fn
  }

  async execute(
    template: Record<string, unknown>,
    taskDescription: string,
    mergedParams: Record<string, unknown>,
    startTime: number,
    tools?: ToolDefinition[],
    availableTools?: string[],
    apiKey?: string,
    baseURL?: string,
    environmentKey?: string,
    extras?: SubagentExecuteExtras
  ): Promise<Record<string, unknown>> {
    if (!_executor) {
      throw new Error('SubagentExecutor: setExecutor() must be called before execute()')
    }
    return _executor(template, taskDescription, mergedParams, startTime, tools, availableTools, apiKey, baseURL, environmentKey, extras)
  }
}
