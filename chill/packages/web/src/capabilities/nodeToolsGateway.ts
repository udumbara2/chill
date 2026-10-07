/**
 * Node-only 工具执行网关（M3.1/M3.3）
 *
 * 照桌面主进程先例（electron-main L1388-1413）：requiresNodeFs 的六个工具
 * （search_sessions/search_content/write_plan/read_plan/submit_plan/trigger_guardian）
 * 不用 confirm/position/code 依赖——no-op stubs + NodeFileSystemProvider。
 * plan/goal 模式开关同步本执行器（read_goal/submit_plan 是 Node-only 门，两端一致）。
 * ask_user 挂起提问经 ask-back 推浏览器（plan:ask-user-request 事件），作答回
 * plan:ask-user-response 兑现——与桌面同款挂起配对。
 */
import {
  BuiltInToolExecutor,
  NodeFileSystemProvider,
  type IConfirmationHandler,
  type IPositionCalculator,
  type ICodeExecutor,
} from '@assistant-ai/core'
const noopConfirmationHandler: IConfirmationHandler = {
  addPendingOperation: () => {},
  getPendingOperations: () => [],
  getDocumentSnapshot: () => null,
  setDocumentSnapshot: () => {},
  clearAll: () => {},
}
const noopPositionCalculator: IPositionCalculator = {
  getSnapshot: async () => null,
  calculateInsertPosition: () => ({ success: false, error: 'noop' }),
  calculatePosition: async () => ({ success: false, error: 'noop' }),
}
const noopCodeExecutor: ICodeExecutor = {
  executeChildProcess: async () => ({ success: false, error: 'noop' }),
  executeInteractive: async () => ({ success: false, error: 'noop' }),
  sendInput: async () => ({ success: false, error: 'noop' }),
  terminateProcess: async () => ({ success: false, error: 'noop' }),
  executePowerShell: async () => ({ success: false, error: 'noop' }),
}

export class NodeToolsGateway {
  readonly executor: BuiltInToolExecutor
  private pendingAsks = new Map<string, (answer: string) => void>()
  private askSeq = 0
  /** ask-back 出口：serve.ts 接 WS 事件广播（plan:ask-user-request） */
  onAsk: ((payload: { id: string; question: string; options?: { label: string; description: string }[]; allowFreeText?: boolean }) => void) | null = null

  constructor() {
    this.executor = new BuiltInToolExecutor(
      new NodeFileSystemProvider(),
      noopConfirmationHandler,
      noopPositionCalculator,
      noopCodeExecutor,
    )
    this.executor.setUserInputProvider({
      ask: (question, options, allowFreeText) =>
        new Promise<string>((resolve) => {
          const id = `web-ask-${Date.now()}-${++this.askSeq}`
          this.pendingAsks.set(id, resolve)
          this.onAsk?.({ id, question, options: options as never, allowFreeText })
        }),
    })
  }

  executeTool(name: string, args: string): Promise<unknown> {
    return this.executor.executeAsync(name, args)
  }

  setPlanMode(on: boolean): void {
    this.executor.setPlanMode(on)
  }

  setGoalMode(on: boolean): void {
    this.executor.setGoalMode(on)
  }

  /** 浏览器作答兑现挂起的提问 */
  resolveAsk(id: string, answer: string): boolean {
    const fn = this.pendingAsks.get(id)
    if (!fn) return false
    this.pendingAsks.delete(id)
    fn(answer)
    return true
  }
}
