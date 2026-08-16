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

declare const window: Window & {
  electronAPI: any
}

export class ElectronIPCCodeExecutor implements ICodeExecutor {
  async executeChildProcess(language: SupportedLanguage, code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
    try {
      const result = await window.electronAPI.executeJSCode(code, {
        timeout: options?.timeout,
        cwd: options?.cwd
      }, language)
      return result
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async executeInteractive(language: SupportedLanguage, code: string, callbacks: InteractiveCallbacks): Promise<InteractiveResult> {
    window.electronAPI.removeInteractiveListeners()

    window.electronAPI.onOutput((data: { processId: string; data: string; type: 'stdout' | 'stderr' }) => {
      callbacks.onOutput(data.processId, data.data, data.type)
    })

    window.electronAPI.onExit((data: { processId: string; code: number; reason: string; error?: string }) => {
      callbacks.onExit(data.processId, data.code, data.reason, data.error)
    })

    try {
      const result = await window.electronAPI.startInteractiveExecution(code, language)
      return result
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async sendInput(processId: string, input: string): Promise<ProcessOperationResult> {
    try {
      await window.electronAPI.sendInput(processId, input)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async terminateProcess(processId: string): Promise<ProcessOperationResult> {
    try {
      await window.electronAPI.terminateProcess(processId)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async executePowerShell(command: string, options?: PowerShellOptions): Promise<PowerShellResult> {
    try {
      return await window.electronAPI.executePowerShell(command, options)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
