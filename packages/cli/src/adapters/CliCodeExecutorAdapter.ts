import { CodeExecutor, executePowerShell } from '@assistant-ai/core'
import type {
  ICodeExecutor,
  SupportedLanguage,
  ExecutionOptions,
  ExecutionResult,
  InteractiveCallbacks,
  InteractiveResult,
  ProcessOperationResult,
  PowerShellOptions,
  PowerShellResult
} from '@assistant-ai/core'

export class CliCodeExecutorAdapter implements ICodeExecutor {
  private codeExecutor: CodeExecutor

  constructor() {
    this.codeExecutor = new CodeExecutor()
  }

  async executeChildProcess(language: SupportedLanguage, code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
    return this.codeExecutor.executeChildProcess(language, code, options)
  }

  async executeInteractive(language: SupportedLanguage, code: string, callbacks: InteractiveCallbacks): Promise<InteractiveResult> {
    return this.codeExecutor.executeInteractive(language, code, callbacks)
  }

  async sendInput(processId: string, input: string): Promise<ProcessOperationResult> {
    return this.codeExecutor.sendInput(processId, input)
  }

  async terminateProcess(processId: string): Promise<ProcessOperationResult> {
    return this.codeExecutor.terminateProcess(processId)
  }

  async executePowerShell(command: string, options?: PowerShellOptions): Promise<PowerShellResult> {
    return executePowerShell(command, options)
  }
}
