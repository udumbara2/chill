import type { IHookProcessRunner, HookProcessResult } from '@assistant-ai/core'
import { getHostAPI } from '../host/hostApi'

/**
 * UI 渲染进程侧 hook 执行通道（core IHookProcessRunner 的 IPC 实现）：
 * 渲染进程无 child_process，经 hooks:run IPC 桥到 electron 主进程执行
 * （仿 nodeToolExecutor 注入先例：core 定义接口，壳层注入实现）。
 * 语义与 CLI 的 NodeHookProcessRunner 完全一致（主进程侧同语义移植，见
 * packages/electron/src/main/HookProcessRunner.ts）。
 *
 * cwd 经 getCwd 闭包现读（引擎会话 workDir，写作视图切换目录时随动），
 * 主进程注入 CHILL_PROJECT_DIR / CLAUDE_PROJECT_DIR 生态兼容别名。
 */
export class ElectronIPCHookProcessRunner implements IHookProcessRunner {
  private getCwd: () => string | undefined

  constructor(getCwd: () => string | undefined) {
    this.getCwd = getCwd
  }

  async run(command: string, inputJson: string, timeoutMs: number): Promise<HookProcessResult> {
    try {
      const result = await getHostAPI().hooksRun({
        command,
        inputJson,
        timeoutMs,
        cwd: this.getCwd(),
      })
      // IPC 载荷防御性校验：字段缺失按"进程未能正常退出"处理（core 走 fail-open/failClosed 语义）
      if (!result || typeof result !== 'object') {
        return { exitCode: null, stdout: '', stderr: 'hooks:run 返回非法', timedOut: false }
      }
      return {
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        timedOut: result.timedOut === true,
      }
    } catch (error) {
      return {
        exitCode: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      }
    }
  }
}
