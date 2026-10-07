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
import { ElectronIPCCodeExecutor } from './ElectronIPCCodeExecutor'

export class ElectronPowerShellAdapter implements ICodeExecutor {
  private delegate = new ElectronIPCCodeExecutor()

  async executeChildProcess(language: SupportedLanguage, code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
    return this.delegate.executeChildProcess(language, code, options)
  }

  async executeInteractive(language: SupportedLanguage, code: string, callbacks: InteractiveCallbacks): Promise<InteractiveResult> {
    return this.delegate.executeInteractive(language, code, callbacks)
  }

  async sendInput(processId: string, input: string): Promise<ProcessOperationResult> {
    return this.delegate.sendInput(processId, input)
  }

  async terminateProcess(processId: string): Promise<ProcessOperationResult> {
    return this.delegate.terminateProcess(processId)
  }

  async executePowerShell(command: string, options?: PowerShellOptions): Promise<PowerShellResult> {
    return this.delegate.executePowerShell(command, options)
  }
}
