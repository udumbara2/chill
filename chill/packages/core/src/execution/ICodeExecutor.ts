import type { SupportedLanguage, ExecutionOptions, ExecutionResult, OutputCallback, ExitCallback } from './types'
import type { PowerShellOptions, PowerShellResult } from './PowerShellExecutor'

export interface InteractiveCallbacks {
  onOutput: OutputCallback
  onExit: ExitCallback
}

export interface InteractiveResult {
  success: boolean
  processId?: string
  error?: string
}

export interface ProcessOperationResult {
  success: boolean
  error?: string
}

export interface ICodeExecutor {
  executeChildProcess(language: SupportedLanguage, code: string, options?: ExecutionOptions): Promise<ExecutionResult>
  executeInteractive(language: SupportedLanguage, code: string, callbacks: InteractiveCallbacks): Promise<InteractiveResult>
  sendInput(processId: string, input: string): Promise<ProcessOperationResult>
  terminateProcess(processId: string): Promise<ProcessOperationResult>
  executePowerShell(command: string, options?: PowerShellOptions): Promise<PowerShellResult>
}
