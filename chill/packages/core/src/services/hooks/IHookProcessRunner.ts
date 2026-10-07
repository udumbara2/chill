/**
 * hook 执行通道接口：core 只定义接口，不 import child_process。
 * - CLI：Node child_process 本地 spawn
 * - 桌面 UI：IPC 到 electron 主进程执行（渲染进程无 child_process）
 * 两端实现同一契约：把 inputJson 写到子进程 stdin，收集 stdout/stderr 与退出码，超时即终止。
 */
export interface HookProcessResult {
  /** 退出码；null = 进程未能正常退出（spawn 失败 / 被信号杀死等） */
  exitCode: number | null
  stdout: string
  stderr: string
  /** true = 超时被终止（exitCode 此时无意义） */
  timedOut: boolean
}

export interface IHookProcessRunner {
  /**
   * 执行一条 hook 命令
   * @param command shell 命令串（实现方负责按平台选择 shell）
   * @param inputJson 写入 stdin 的 JSON 字符串
   * @param timeoutMs 超时（毫秒），超时必须终止进程并置 timedOut
   */
  run(command: string, inputJson: string, timeoutMs: number): Promise<HookProcessResult>
}
