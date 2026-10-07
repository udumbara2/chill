/**
 * 命令与代码执行网关（M3.2）
 *
 * core 的 CodeExecutor/executePowerShell 直调（CLI 同款零适配）。
 * 交互式回调是 per-call 形参（ProcessInfo 持有）——此处传入广播回调，
 * 输出/退出事件经 serve.ts 的 WS ev 帧推浏览器（onOutput/onExit 订阅）。
 * 审批归属浏览器引擎层（ElectronPowerShellAdapter 在浏览器侧过确认门后才发请求），
 * daemon 只执行已放行的命令——与桌面主进程相同分工。
 */
import { CodeExecutor, executePowerShell } from '@assistant-ai/core'

export class CodeExecGateway {
  private executor = new CodeExecutor()
  private listeners = new Set<(n: string, d: unknown) => void>()

  onEvent(cb: (n: string, d: unknown) => void): void {
    this.listeners.add(cb)
  }

  private emit(n: string, d: unknown): void {
    for (const cb of this.listeners) { try { cb(n, d) } catch { /* 不扩散 */ } }
  }

  executeJs(code: string, options: unknown, language?: string): Promise<unknown> {
    return this.executor.executeChildProcess((language ?? 'javascript') as never, code, options as never)
  }

  startInteractive(code: string, language?: string, options?: { timeout?: number }): Promise<unknown> {
    void options
    return this.executor.executeInteractive((language ?? 'javascript') as never, code, {
      onOutput: (processId, data, type) => this.emit('code:output', { processId, data, type }),
      onExit: (processId, code2, reason, error) => this.emit('code:exit', { processId, code: code2, reason, error }),
    })
  }

  sendInput(processId: string, input: string): Promise<unknown> {
    return this.executor.sendInput(processId, input)
  }

  terminate(processId: string): Promise<unknown> {
    return this.executor.terminateProcess(processId)
  }

  powerShell(command: string, options: unknown): Promise<unknown> {
    return executePowerShell(command, options as never)
  }
}
