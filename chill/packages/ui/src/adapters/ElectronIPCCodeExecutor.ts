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
import { getHostAPI } from '../host/hostApi'

export class ElectronIPCCodeExecutor implements ICodeExecutor {
  async executeChildProcess(language: SupportedLanguage, code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
    try {
      const result = await getHostAPI().executeJSCode(code, {
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
    const host = getHostAPI()
    host.removeInteractiveListeners()

    host.onOutput((data: { processId: string; data: string; type: 'stdout' | 'stderr' }) => {
      callbacks.onOutput(data.processId, data.data, data.type)
    })

    host.onExit((data: { processId: string; code: number; reason: string; error?: string }) => {
      callbacks.onExit(data.processId, data.code, data.reason, data.error)
    })

    try {
      const result = await host.startInteractiveExecution(code, language)
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
      await getHostAPI().sendInput(processId, input)
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
      await getHostAPI().terminateProcess(processId)
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
      return await getHostAPI().executePowerShell(command, options)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
