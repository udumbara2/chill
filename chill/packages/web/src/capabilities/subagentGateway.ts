/**
 * 子代理执行网关（M4.1/M4.2/M4.4 + M4.5 团队运行面）
 *
 * 装配照桌面主进程同构（electron-main L1322-1394/L1818-1860）：
 * - getForkManager(forkMcpService, builtinForwarder)：Worker fork + 内置工具回弹
 *   （回弹经 WS 推浏览器 be.executeAsync——宿主确认流/autoApply 在渲染层单例）；
 * - SubagentExecutor.setExecutor(StandardSubagentExecutor(...))：task 工具执行端；
 * - SUBAGENT_TOOL_CALL 事件桥：执行过程面板事实流；
 * - Worker MCP hooks 派发经 WS 推渲染层（fail-open 同桌面）。
 * 退出纪律（M4.1）：SIGINT/异常 → destroy 全部在途 Worker 环境（不留孤儿）。
 */
import {
  SubagentExecutor,
  StandardSubagentExecutor,
  getForkManager,
  setWorkerScriptPath,
  getTaskRegistry,
  setWorkerMcpHookDispatcher,
  MCPService,
  BoardStore,
  eventBus,
  EVENTS,
  type WorkerMcpHookCall,
  type WorkerMcpHookOutcome,
} from '@assistant-ai/core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WebSecureStorage } from './secureStorage'

interface PendingCall {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class SubagentGateway {
  private pendingBuiltin = new Map<string, PendingCall>()
  private pendingMcpHook = new Map<string, { resolve: (v: WorkerMcpHookOutcome | null) => void }>()
  private seq = 0
  private executor: SubagentExecutor
  private boardStore: BoardStore
  /** WS 出口：serve.ts 接广播（subagent:builtin-request / worker-mcp-hook:request / subagent-tool-call） */
  onBuiltinRequest: ((payload: { requestId: string; toolName: string; args: string; toolCallId?: string; __origin?: unknown }) => void) | null = null
  onMcpHookRequest: ((payload: { requestId: string; event: 'PreToolUse' | 'PostToolUse'; call: WorkerMcpHookCall }) => void) | null = null
  onToolCallEvent: ((payload: unknown) => void) | null = null

  constructor(secure: WebSecureStorage, userDataPath: string, bundleDir: string) {
    // Worker 脚本路径（bundle 内 workers/ 优先；core dist 回退——桌面同款双候选）
    const workerCandidates = [
      join(bundleDir, 'workers', 'GenericSubagentWorker.js'),
      join(bundleDir, '..', '..', 'core', 'dist', 'orchestrator', 'isolation', 'workers', 'GenericSubagentWorker.js'),
    ]
    for (const p of workerCandidates) {
      if (existsSync(p)) { setWorkerScriptPath(p); break }
    }

    // fork 网关：daemon 侧 MCP 服务 + 内置工具回弹（挂起配对——桌面同款）
    const forkMcpService = new MCPService()
    const builtinForwarder = (toolName: string, args: string, toolCallId?: string) =>
      new Promise<unknown>((resolve, reject) => {
        const requestId = `wsbi-${Date.now()}-${++this.seq}`
        this.pendingBuiltin.set(requestId, { resolve, reject })
        let origin: unknown
        try { origin = JSON.parse(args)?.__origin } catch { /* args 非 JSON 时不带归属 */ }
        this.onBuiltinRequest?.({ requestId, toolName, args, toolCallId, __origin: origin })
      })
    getForkManager(forkMcpService, builtinForwarder as never)

    // Worker MCP hooks 派发：推渲染层过管线（fail-open——无连接/异常 = null = 跳过 hooks）
    setWorkerMcpHookDispatcher((event, call) =>
      new Promise<WorkerMcpHookOutcome | null>((resolve) => {
        const requestId = `wsmh-${Date.now()}-${++this.seq}`
        this.pendingMcpHook.set(requestId, { resolve })
        this.onMcpHookRequest?.({ requestId, event, call })
      }),
    )

    // 执行端：静态注入（渲染层 task 工具请求 → subagent:execute → 此执行器 → fork Worker）
    SubagentExecutor.setExecutor(
      ((template: Record<string, unknown>, taskDescription: string, mergedParams: Record<string, unknown>, startTime: number, tools?: unknown, availableTools?: unknown, apiKey?: string, baseURL?: string, environmentKey?: string, extras?: unknown) =>
        new StandardSubagentExecutor(secure as never, () => getForkManager()).execute(
          template, taskDescription, mergedParams, startTime,
          tools as never, availableTools as never, apiKey, baseURL, environmentKey, extras as never,
        )) as never,
    )
    this.executor = new SubagentExecutor()

    // 事件桥：core eventBus SUBAGENT_TOOL_CALL → WS（执行过程面板事实流；桌面同款转发点）
    eventBus.on(EVENTS.SUBAGENT_TOOL_CALL, (payload: unknown) => {
      this.onToolCallEvent?.(payload)
    })

    // M4.5 团队运行面：BoardStore（构造收 baseDir 字符串——core 同款）
    this.boardStore = new BoardStore(join(userDataPath, 'boards'))
  }

  /** subagent:execute（渲染层 task 工具 → 此处 → StandardSubagentExecutor → fork Worker） */
  execute(request: Record<string, unknown>): Promise<unknown> {
    return this.executor.execute(
      request.template as never,
      request.taskDescription as string,
      request.mergedParams as never,
      request.startTime as number,
      request.tools as never,
      request.availableTools as never,
      request.apiKey as string | undefined,
      request.baseURL as string | undefined,
      request.environmentKey as string | undefined,
      request.extras as never,
    )
  }

  /** subagent:cancel（按 environmentKey 找回注册表环境并销毁） */
  async cancel(environmentKey: string): Promise<unknown> {
    const environment = getTaskRegistry().getEnvironment(environmentKey)
    if (!environment) return { success: false, error: '未找到对应的后台任务环境（可能已结束）' }
    await environment.destroy()
    getTaskRegistry().unbindEnvironment(environmentKey)
    return { success: true }
  }

  /** subagent:builtin-response（浏览器执行完内置工具回包） */
  resolveBuiltin(requestId: string, result?: unknown, error?: string): unknown {
    const pending = this.pendingBuiltin.get(requestId)
    if (!pending) return { success: false, error: `未找到挂起的请求: ${requestId}` }
    this.pendingBuiltin.delete(requestId)
    if (error) pending.reject(new Error(error))
    else pending.resolve(result)
    return { success: true }
  }

  /** worker-mcp-hook:response（渲染层过完 hooks 管线回包） */
  resolveMcpHook(requestId: string, outcome?: WorkerMcpHookOutcome | null, error?: string): unknown {
    const pending = this.pendingMcpHook.get(requestId)
    if (!pending) return { success: false, error: `未找到挂起的请求: ${requestId}` }
    this.pendingMcpHook.delete(requestId)
    if (error) console.warn('[hooks] Worker MCP hook 派发失败:', error)
    pending.resolve(error ? null : (outcome ?? null))
    return { success: true }
  }

  // ---------- M4.5 团队运行面（board:* 通道；~/.chill/boards 与桌面共享） ----------
  boardLoad(boardId: string): Promise<unknown> {
    return this.boardStore.load(boardId)
  }
  boardSave(state: unknown): Promise<void> {
    return this.boardStore.save(state as never)
  }
  boardExists(boardId: string): Promise<boolean> {
    return this.boardStore.exists(boardId)
  }
  boardArchive(boardId: string, reason: string): Promise<unknown> {
    return this.boardStore.archiveBoard(boardId, reason)
  }

  /** 退出纪律：销毁全部在途 Worker 环境（SIGINT/异常退出口调用；不留孤儿进程） */
  async destroyAllWorkers(): Promise<void> {
    try {
      const registry = getTaskRegistry()
      // 注册表按 environmentKey 登记（environmentKey 注入路径）；列举经内部 API 形态探测
      const registryAny = registry as unknown as { environments?: Map<string, { destroy: () => Promise<void> }> }
      const envs = registryAny.environments
      if (envs instanceof Map) {
        for (const [key, env] of [...envs]) {
          await env.destroy?.().catch(() => { /* 尽力而为 */ })
          try { registry.unbindEnvironment(key) } catch { /* */ }
        }
      }
    } catch {
      /* 注册表形态不符：无 Worker 可清 */
    }
    // 挂起的回弹请求全部收口（浏览器侧 await 不再悬挂）
    for (const [, p] of this.pendingBuiltin) p.reject(new Error('daemon 退出'))
    this.pendingBuiltin.clear()
    for (const [, p] of this.pendingMcpHook) p.resolve(null)
    this.pendingMcpHook.clear()
  }
}
