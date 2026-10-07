/**
 * TemplateSubagentForkManager - 模板Subagent Fork管理器
 * 负责创建和管理Subagent的隔离运行环境
 */

import { fork, type ChildProcess } from 'child_process'
import path from 'path'
import os from 'os'
import { existsSync, appendFileSync } from 'node:fs'
import { format } from 'node:util'
import { NodePathProvider } from '../../implementations/NodePathProvider'

/**
 * worker 诊断输出归日志文件（输出归通道约定：诊断/调试输出写 ~/.chill/*.log，
 * 严禁 console 直写——TUI 期间任何 console 输出都会触发整帧擦写/全屏闪烁）。
 * 写失败静默：日志绝不能影响任务执行。
 */
const workerLogPath = path.join(new NodePathProvider().getUserDataPath(), 'worker.log')
function workerLog(level: 'INFO' | 'WARN' | 'ERROR', ...args: unknown[]): void {
  try {
    appendFileSync(workerLogPath, `[${new Date().toISOString()}] [${level}] ${format(...args)}\n`)
  } catch {
    // 静默
  }
}
import type {
  IsolatedEnvironment,
  SubagentRequest,
  SubagentResponse,
  TemplateSubagentManager,
} from './types'
import { IPCMessageType } from './types'
import type { WorkerToolCallRequest } from './types'
import { getWorkerScriptPath } from './workerPaths'
import type { MCPService } from '../../services/mcp/mcpService'
import type { BuiltInToolResult } from '../../services/builtInToolExecutor'
import { ORCHESTRATION_TOOL_NAMES } from '../types'
import { getTaskRegistry } from '../../services/delegation/taskRegistry'
import { ESCALATE_TOOL_NAME } from '../../services/delegation/escalateTool'
import { BOARD_TOOL_NAME } from '../../services/board/boardTool'
import { TEAM_TOOL_NAMES } from '../../services/team/teamBoardTool'
import { getTeamRuntimeService } from '../../services/team/TeamRuntimeService'
import { hasGrant } from '../../services/team/teamPolicy'
import type { ApprovalOrigin } from '../../services/approvals'
import { getWorkerMcpHookDispatcher } from '../../services/hooks/workerMcpHooks'
import { eventBus, EVENTS, type SubagentToolCallPayload } from '../../utils/eventBus'
import { BOARD_RESULT_MAX_CHARS } from '../../services/team/teamRuntimeTypes'

/**
 * 内置工具调用器：宿主进程真实执行器的注入形式
 * （CLI=进程内真实实例直调；electron=渲染进程转发器）
 */
export type BuiltinToolInvoker = (toolName: string, args: string, toolCallId?: string) => Promise<BuiltInToolResult>

/**
 * 解析 tsx/cli 模块路径（兼容 CJS/ESM 双构建）
 * - CJS: 使用全局 require.resolve
 * - ESM: 从当前目录向上遍历 node_modules 查找
 * 不使用 import.meta.url，避免 CJS 编译器在输出中留下 import.meta 导致 SyntaxError
 */
function resolveTsxPath(): string {
  // CJS: require 是全局函数
  if (typeof require !== 'undefined' && typeof require.resolve === 'function') {
    return require.resolve('tsx/cli')
  }

  // ESM: 从项目根目录向上搜索 node_modules/tsx
  let dir = process.env.INIT_CWD || process.cwd()
  const root = path.parse(dir).root
  while (dir !== root) {
    const candidate = path.join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    if (existsSync(candidate)) return candidate
    dir = path.dirname(dir)
  }
  throw new Error('Cannot find tsx/cli in node_modules')
}

/**
 * 模板Subagent Fork管理器
 * 实现TemplateSubagentManager接口
 */
export class TemplateSubagentForkManager implements TemplateSubagentManager {
  private mcpService?: MCPService
  /** 内置工具执行器（宿主注入；Worker 的内置工具请求经本网关转发执行） */
  private builtinExecutor?: BuiltinToolInvoker

  /** 存储所有创建的隔离环境 */
  private environments: Map<string, IsolatedEnvironment> = new Map()

  /** 存储所有子进程 - 步骤1添加 */
  private childProcesses: Map<string, ChildProcess> = new Map()

  /** 存储待处理的请求 - 步骤1添加 */
  private pendingRequests: Map<
    string,
    {
      resolve: (value: SubagentResponse) => void
      reject: (reason: Error) => void
      timeout: NodeJS.Timeout
      envId: string
    }
  > = new Map()

  /** 存储 Worker 就绪状态 - 步骤4添加 */
  private workerReadyStatus: Map<string, boolean> = new Map()

  /** waitForWorkerReady 事件驱动回调注册表（取代轮询） */
  private readyWaiters: Map<string, { resolve: () => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }> = new Map()

  /** 沙箱目录路径注册表（供 cleanupEnvironment 统一访问，取代闭包变量） */
  private sandboxDirs: Map<string, string> = new Map()

  /** 环境关闭原因登记（pending reject 时给出具体死因——超时/异常退出/主动销毁，
   * 让 Lead 能据原因调整委派策略，而不是只看到"环境已清理"） */
  private closeReasons: Map<string, string> = new Map()

  /** 任务硬超时计时器（自管理，取代 fork timeout 选项——超时必须先登记死因再杀进程） */
  private hardTimeouts: Map<string, NodeJS.Timeout> = new Map()

  constructor(mcpService?: MCPService, builtinExecutor?: BuiltinToolInvoker) {
    this.mcpService = mcpService
    this.builtinExecutor = builtinExecutor
  }

  /** 后注入更新（getForkManager 单例"首个调用者定参"场景的补注入通道） */
  setDependencies(mcpService?: MCPService, builtinExecutor?: BuiltinToolInvoker): void {
    if (mcpService) this.mcpService = mcpService
    if (builtinExecutor) this.builtinExecutor = builtinExecutor
  }

  /**
   * 统一环境资源清理（所有销毁路径的唯一出口）
   * 幂等：Map.delete 安全、kill 死进程安全、rm force 安全——多处调用无并发风险。
   * destroy 的优雅终止（SIGTERM → 等 exit）不经过这里；本方法的 kill 仅作为
   * exit handler / error handler / 就绪失败等路径的兜底。
   */
  private async cleanupEnvironment(envId: string): Promise<void> {
    // 1. kill 子进程（如果还活着）
    const child = this.childProcesses.get(envId)
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* 已死或不可 kill */ }
    }

    // 2. 清理 pendingRequests（reject 全部该 envId 的请求；带死因——Lead 据此调整委派策略）
    const closeReason = this.closeReasons.get(envId)
    const pendingIds: string[] = []
    this.pendingRequests.forEach((req, requestId) => {
      if (req.envId === envId) pendingIds.push(requestId)
    })
    pendingIds.forEach((requestId) => {
      const pending = this.pendingRequests.get(requestId)
      if (pending) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(
          closeReason
            ? `${closeReason}（env: ${envId}）`
            : `环境已清理: ${envId}`
        ))
        this.pendingRequests.delete(requestId)
      }
    })

    // 3. 清理 readyWaiters(带死因——与 pending reject 同款,别让调用方只看到"环境已清理")
    const waiter = this.readyWaiters.get(envId)
    if (waiter) {
      clearTimeout(waiter.timeout)
      const closeReason = this.closeReasons.get(envId)
      waiter.reject(new Error(
        closeReason
          ? `${closeReason}（就绪等待中断, env: ${envId}）`
          : `环境已清理（就绪等待中断）: ${envId}`,
      ))
      this.readyWaiters.delete(envId)
    }

    // 4. 删映射
    const hardTimeout = this.hardTimeouts.get(envId)
    if (hardTimeout) clearTimeout(hardTimeout)
    this.hardTimeouts.delete(envId)
    this.closeReasons.delete(envId)
    this.childProcesses.delete(envId)
    this.environments.delete(envId)
    this.workerReadyStatus.delete(envId)
    this.readyWaiters.delete(envId)

    // 5. 删沙箱目录
    const sandboxDir = this.sandboxDirs.get(envId)
    this.sandboxDirs.delete(envId)
    if (sandboxDir) {
      try {
        const fs = await import('fs/promises')
        await fs.rm(sandboxDir, { recursive: true, force: true })
      } catch (error) {
        workerLog('WARN', `[cleanupEnvironment] 清理沙箱目录失败: ${error}`)
      }
    }

    workerLog('INFO', `[cleanupEnvironment] 环境清理完成: ${envId}`)
  }

  /**
   * 创建隔离环境
   * @param subagentType - Subagent类型
   * @param subagentConfig - Subagent配置
   * @returns 隔离环境实例
   */
  async createEnvironment(
    subagentType: string,
    subagentConfig: any
  ): Promise<IsolatedEnvironment> {
    // 生成唯一环境ID
    const envId = `${subagentType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // --------------------------
    // 沙箱目录：使用 os.tmpdir()
    // --------------------------
    const sandboxDir = path.join(os.tmpdir(), 'subagent-sandboxes', envId)
    
    // 确保沙箱目录存在（异步创建，但不阻塞）
    const fs = await import('fs/promises')
    await fs.mkdir(sandboxDir, { recursive: true })

    // 登记沙箱路径（fork 前写入，确保就绪失败时 cleanupEnvironment 能拿到路径）
    this.sandboxDirs.set(envId, sandboxDir)

    // --------------------------
    // 环境变量白名单
    // 仅保留必要的环境变量
    // --------------------------
    const allowedEnvVars = ['PATH', 'NODE_ENV', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
    const filteredEnv: Record<string, string | undefined> = {}
    for (const key of allowedEnvVars) {
      if (process.env[key]) {
        filteredEnv[key] = process.env[key]
      }
    }
    // 设置沙箱目录为临时目录
    filteredEnv.TEMP = sandboxDir
    filteredEnv.TMP = sandboxDir

    // 设置 Worker 配置（包含 subagentConfig）
    const workerConfig = {
      subagentType,
      envId,
      subagentConfig: subagentConfig || {},
    }
    filteredEnv.WORKER_CONFIG = JSON.stringify(workerConfig)

    // --------------------------
    // 步骤2：创建子进程
    // 使用 fork 创建 Worker 进程
    // --------------------------
    const workerScriptPath = getWorkerScriptPath()
    
    // 检查是否需要使用 tsx 运行 TypeScript 文件
    const isTypeScript = workerScriptPath.endsWith('.ts')
    let child: ChildProcess
    
    // 任务硬超时时长：模板 timeout（秒）贯通，缺省 600s。
    // 不用 fork 的 timeout 选项（它杀进程不留死因，pending 只能收到"环境已清理"）——
    // 自管理计时器：先登记死因（供 Lead 调整策略：增大 timeout/缩小任务/换更快模型），再 SIGTERM
    const taskTimeoutMs = (((subagentConfig?.timeout as number | undefined) ?? 600) * 1000)

    if (isTypeScript) {
      // 【修复】使用 fork 而不是 spawn，以确保 process.send 可用
      // 通过 execPath 指定使用 tsx 来执行 TypeScript
      workerLog('INFO',`[TemplateSubagentForkManager] 使用 tsx 执行 TypeScript Worker (fork): ${workerScriptPath}`)
      
      // 获取 tsx 的完整路径，避免 npx 的 ESM 问题
      // 使用 'tsx/cli' 导出路径，而不是直接访问 dist/cli.mjs
      const tsxPath = resolveTsxPath()
      workerLog('INFO',`[TemplateSubagentForkManager] tsx 路径: ${tsxPath}`)
      
      // 【关键修复】Windows 上不能直接执行 .mjs 文件，需要用 node 加载
      // 使用 node 执行 tsx，tsx 再执行 Worker 脚本
      child = fork(tsxPath, [workerScriptPath], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: filteredEnv,
        cwd: sandboxDir,
      })
      
      // 【调试代码】捕获 Worker 输出
      child.stdout?.on('data', (data) => {
        workerLog('INFO',`[Worker ${envId} stdout]: ${data.toString().trim()}`)
      })
      child.stderr?.on('data', (data) => {
        workerLog('ERROR',`[Worker ${envId} stderr]: ${data.toString().trim()}`)
      })
    } else {
      // 直接执行 JavaScript 文件
      child = fork(workerScriptPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: filteredEnv,
        cwd: sandboxDir,
      })
      // 捕获 Worker 输出，便于排查问题
      child.stdout?.on('data', (data) => {
        workerLog('INFO',`[Worker ${envId} stdout]: ${data.toString().trim()}`)
      })
      child.stderr?.on('data', (data) => {
        workerLog('ERROR',`[Worker ${envId} stderr]: ${data.toString().trim()}`)
      })
    }

    // 任务硬超时（自管理）：登记死因后 SIGTERM——exit handler → cleanupEnvironment 统一清理，
    // pending 请求将带着这条原因 reject（而不是笼统的"环境已清理"）
    this.hardTimeouts.set(envId, setTimeout(() => {
      const seconds = taskTimeoutMs / 1000
      this.closeReasons.set(envId,
        `任务执行超时（硬上限 ${seconds}s，模板的 timeout 配置项可调整）：Subagent 在限定时间内未完成，系统已终止。` +
        `可增大该模板 timeout、缩小/拆分任务、或改用更快的模型后重试`)
      try { child.kill('SIGTERM') } catch { /* 已退出 */ }
    }, taskTimeoutMs))

    // 存储子进程
    this.childProcesses.set(envId, child)
    workerLog('INFO',`[TemplateSubagentForkManager] 创建子进程: ${envId}, PID: ${child.pid}`)

    // 步骤3：设置 IPC 通信
    this.setupWorkerIPC(child, envId)

    // 等待 Worker 就绪（事件驱动）；失败时清理孤儿进程后原样抛出
    workerLog('INFO',`[TemplateSubagentForkManager] 等待 Worker 就绪: ${envId}`)
    await this.waitForWorkerReady(envId).catch(async (err) => {
      await this.cleanupEnvironment(envId)
      throw err
    })
    workerLog('INFO',`[TemplateSubagentForkManager] Worker 已就绪: ${envId}`)

    // --------------------------
    // 封装隔离环境
    // --------------------------
    const environment: IsolatedEnvironment = {
      id: envId,

      /**
       * 发送请求到隔离环境
       * 步骤8：调用 sendRequestToWorker 实际发送请求到 Worker 进程
       */
      sendRequest: async (request: SubagentRequest): Promise<SubagentResponse> => {
        workerLog('INFO',`[TemplateSubagentForkManager] 发送请求到 Worker [${envId}]:`, {
          subagentType,
          taskId: request.taskId,
        })

        // 步骤8：调用 sendRequestToWorker 发送实际请求
        return this.sendRequestToWorker(envId, request)
      },

      /**
       * 销毁隔离环境
       * 优雅终止（SIGTERM → 等 5s exit → SIGKILL）后调用 cleanupEnvironment 统一清理
       */
      destroy: async (): Promise<void> => {
        workerLog('INFO',`[TemplateSubagentForkManager] 销毁环境: ${envId}`)

        // 登记死因（不覆盖已有死因——硬超时已登记的优先）：pending 请求将带此原因 reject
        if (!this.closeReasons.has(envId)) {
          this.closeReasons.set(envId, '任务已终止：环境被主动销毁（任务完成、cancel_task 取消或会话结束）')
        }

        // 优雅终止子进程
        const child = this.childProcesses.get(envId)
        if (child) {
          // 已退出的进程直接跳过等待
          if (child.exitCode !== null || child.signalCode !== null) {
            workerLog('INFO',`[TemplateSubagentForkManager] 子进程已退出，跳过等待 [${envId}]`)
          } else {
            workerLog('INFO',`[TemplateSubagentForkManager] 终止子进程 [${envId}], PID: ${child.pid}`)

            child.kill('SIGTERM')

            await new Promise<void>((resolve) => {
              const timeout = setTimeout(() => {
                workerLog('WARN',`[TemplateSubagentForkManager] 子进程未在5秒内退出，强制终止 [${envId}]`)
                child.kill('SIGKILL')
                resolve()
              }, 5000)

              child.on('exit', () => {
                clearTimeout(timeout)
                workerLog('INFO',`[TemplateSubagentForkManager] 子进程已退出 [${envId}]`)
                resolve()
              })
            })
          }
        }

        // 统一清理（子进程映射、pendingRequests、沙箱目录、全部 Map）
        await this.cleanupEnvironment(envId)
      },
    }

    // 存储环境实例
    this.environments.set(envId, environment)

    return environment
  }

  /**
   * 销毁所有隔离环境
   * 应用退出时调用
   */
  async destroyAllEnvironments(): Promise<void> {
    workerLog('INFO',`[TemplateSubagentForkManager] 销毁所有环境，共 ${this.environments.size} 个`)
    
    const destroyPromises = Array.from(this.environments.values()).map((env) =>
      env.destroy().catch((error) => {
        workerLog('ERROR',`[TemplateSubagentForkManager] 销毁环境失败: ${env.id}`, error)
      })
    )

    await Promise.allSettled(destroyPromises)
    this.environments.clear()
  }

  /**
   * 获取所有活动的隔离环境
   * @returns 隔离环境列表
   */
  getEnvironments(): IsolatedEnvironment[] {
    return Array.from(this.environments.values())
  }

  /**
   * 获取指定ID的隔离环境
   * @param envId - 环境ID
   * @returns 隔离环境实例或undefined
   */
  getEnvironment(envId: string): IsolatedEnvironment | undefined {
    return this.environments.get(envId)
  }

  /**
   * 【修复】等待 Worker 就绪
   * 监听 Worker 发送的 ready 消息
   * @param envId - 环境ID
   * @returns Promise 在 Worker 就绪时 resolve
   */
  private async waitForWorkerReady(envId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 检查持久标志（防 ready 先于 waiter 注册的竞态）
      if (this.workerReadyStatus.get(envId)) {
        resolve()
        return
      }

      // 事件驱动：注册回调，由 IPC handler 收到 ready 消息时直接 resolve
      const timeout = setTimeout(() => {
        this.readyWaiters.delete(envId)
        reject(new Error(`等待 Worker 就绪超时 (10s): ${envId}`))
      }, 10000)

      this.readyWaiters.set(envId, { resolve, reject, timeout })
    })
  }

  /**
   * 步骤7：发送请求到 Worker
   * @param envId - 环境ID
   * @param request - Subagent 请求
   * @returns Subagent 响应
   */
  private async sendRequestToWorker(
    envId: string,
    request: SubagentRequest
  ): Promise<SubagentResponse> {
    return new Promise((resolve, reject) => {
      // 获取子进程
      const child = this.childProcesses.get(envId)
      if (!child) {
        reject(new Error(`未找到子进程: ${envId}`))
        return
      }

      // 生成请求ID
      const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

      // 请求超时（与 fork 硬超时一致：模板 timeout 贯通，缺省 600s）
      const taskTimeoutMs = (((request.subagentConfig?.timeout as number | undefined) ?? 600) * 1000)
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`请求超时 (${taskTimeoutMs / 1000}s): ${requestId}`))
      }, taskTimeoutMs)

      // 存储 pending request
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        envId,
      })

      // 发送请求到 Worker
      const ipcMessage = {
        type: IPCMessageType.REQUEST,
        id: requestId,
        payload: request,
      }

      child.send(ipcMessage, (error) => {
        if (error) {
          clearTimeout(timeout)
          this.pendingRequests.delete(requestId)
          reject(new Error(`发送请求失败: ${error.message}`))
        } else {
          workerLog('INFO',`[TemplateSubagentForkManager] 请求已发送 [${requestId}]`)
        }
      })
    })
  }

  /**
   * 步骤3：设置 Worker IPC 通信
   * 监听子进程消息
   * @param child - 子进程实例
   * @param envId - 环境ID
   */
  private setupWorkerIPC(child: ChildProcess, envId: string): void {
    // 监听消息
    child.on('message', (message: any) => {
      workerLog('INFO',`[TemplateSubagentForkManager] 收到消息 [${envId}]:`, message)

      // 步骤4：处理 ready 消息
      if (message.type === 'ready') {
        const { envId: workerEnvId, subagentType } = message.payload
        this.workerReadyStatus.set(workerEnvId, true)
        workerLog('INFO',`[TemplateSubagentForkManager] Worker 就绪 [${workerEnvId}]: ${subagentType}`)

        // 事件驱动：直接 resolve 等待中的 waiter（取代轮询）
        const waiter = this.readyWaiters.get(workerEnvId)
        if (waiter) {
          clearTimeout(waiter.timeout)
          this.readyWaiters.delete(workerEnvId)
          waiter.resolve()
        }
        return
      }

      // 步骤5：处理 RESPONSE 消息
      if (message.type === IPCMessageType.RESPONSE) {
        const { id: requestId, payload } = message
        const pendingRequest = this.pendingRequests.get(requestId)
        if (pendingRequest) {
          // 清除超时定时器
          clearTimeout(pendingRequest.timeout)
          // 从 pendingRequests 中移除
          this.pendingRequests.delete(requestId)
          // resolve 响应
          pendingRequest.resolve(payload as SubagentResponse)
          workerLog('INFO',`[TemplateSubagentForkManager] 响应已处理 [${requestId}]`)
        } else {
          workerLog('WARN',`[TemplateSubagentForkManager] 未找到 pending request [${requestId}]`)
        }
        return
      }

      // 步骤6：处理 ERROR 消息
      if (message.type === IPCMessageType.ERROR) {
        const { id: requestId, payload } = message
        const pendingRequest = this.pendingRequests.get(requestId)
        if (pendingRequest) {
          // 清除超时定时器
          clearTimeout(pendingRequest.timeout)
          // 从 pendingRequests 中移除
          this.pendingRequests.delete(requestId)
          // reject 错误
          const errorMessage = payload?.error || 'Unknown error from worker'
          pendingRequest.reject(new Error(errorMessage))
          workerLog('INFO',`[TemplateSubagentForkManager] 错误已处理 [${requestId}]: ${errorMessage}`)
        } else {
          workerLog('WARN',`[TemplateSubagentForkManager] 未找到 pending request for error [${requestId}]`)
        }
        return
      }

      // 处理工具调用请求（Worker 请求主进程调用 MCP 工具）；envId 随传供归属推导（__origin 注入）
      if (message.type === IPCMessageType.TOOL_CALL_REQUEST) {
        this.handleToolCallRequest(child, message, envId).catch((error) => {
          workerLog('ERROR',`[TemplateSubagentForkManager] 处理工具调用请求失败 [${envId}]:`, error)
        })
        return
      }

      // 未知消息类型
      workerLog('WARN',`[TemplateSubagentForkManager] 未知消息类型 [${envId}]:`, message.type)
    })

    // 步骤14：监听子进程错误——统一清理
    child.on('error', (error) => {
      workerLog('ERROR',`[TemplateSubagentForkManager] 子进程错误 [${envId}]:`, error)
      if (!this.closeReasons.has(envId)) {
        this.closeReasons.set(envId, `Worker 进程错误：${error.message}。可重试委派；反复出现请检查 ~/.chill/worker.log`)
      }
      this.cleanupEnvironment(envId).catch(e => workerLog('ERROR', `[exit-handler] cleanupEnvironment 失败 [${envId}]:`, e))
    })

    // 步骤15：监听子进程退出——正常/异常统一清理映射（幂等，与 destroy 安全并发）
    child.on('exit', (code, signal) => {
      if (code !== 0 || signal !== null) {
        workerLog('WARN',`[TemplateSubagentForkManager] 子进程非正常退出 [${envId}]: code=${code}, signal=${signal}`)
        // 登记死因（不覆盖已有死因——硬超时/主动销毁已登记的优先）
        if (!this.closeReasons.has(envId)) {
          this.closeReasons.set(envId,
            `Worker 进程异常退出（code=${code}, signal=${signal}）：Subagent 运行环境崩溃。` +
            `可重试委派；反复出现请检查 ~/.chill/worker.log 中该 env 的 stderr 输出`)
        }
      } else {
        workerLog('INFO',`[TemplateSubagentForkManager] 子进程正常退出 [${envId}]`)
      }
      // 正常退出也调 cleanupEnvironment（幂等二级保险，确保即使 destroy 漏调也不泄漏）
      this.cleanupEnvironment(envId).catch(e => workerLog('ERROR', `[exit-handler] cleanupEnvironment 失败 [${envId}]:`, e))
    })

    workerLog('INFO',`[TemplateSubagentForkManager] IPC 监听已设置: ${envId}`)
  }

  /**
   * Worker 归属推导（审批 __origin 注入用）：
   * taskId 经注册表环境绑定反查（绑定键 = toolCall.id，与 cancel_task 的 rejectApprovalsForTask 同键）；
   * subagentType 优先取注册表条目，兜底从 envId 前缀解析（`${subagentType}-${Date.now()}-${rand}`）。
   * 查不到绑定（未走 StandardSubagentExecutor 上抛的环境）时 taskId 缺省，仅标 source/subagentType。
   */
  private resolveOrigin(envId: string): ApprovalOrigin {
    const registry = getTaskRegistry()
    const taskId = registry.getEnvironmentKeyByEnvId(envId)
    const entry = taskId ? registry.getByToolCallId(taskId) : undefined
    const prefixMatch = /^(.+)-\d{13,}-[a-z0-9]{9}$/.exec(envId)
    // agent 记忆目录随归属注入（委派时经 bindEnvironment 一次解析登记，Worker 不可伪造）；
    // 按需携带：未声明 memory 的任务不带此键（保持 __origin 形状稳定）
    const memoryDir = taskId ? registry.getEnvironmentMemoryDir(taskId) : undefined
    // agent 知识库绑定名单同理（声明 knowledge 才携带；知识库工具硬边界的复核依据）
    const knowledgeBases = taskId ? registry.getEnvironmentKnowledgeBases(taskId) : undefined
    return {
      source: 'subagent',
      subagentType: entry?.subagentType ?? prefixMatch?.[1],
      taskId,
      ...(memoryDir ? { memoryDir } : {}),
      ...(knowledgeBases ? { knowledgeBases } : {}),
    }
  }

  /**
   * 处理 Worker 发送的工具调用请求（宿主网关）
   * 统一授权复核（编排工具永不放行 + authorizedTools 名单复核）后按 kind 分流：
   * builtin → 宿主注入的真实内置工具执行器（继承宿主确认/autoApply 语义）；mcp → 宿主 MCP 服务
   * @param envId - 来源 Worker 环境 id（归属推导用，由 setupWorkerIPC 闭包传入）
   */
    /**
   * TOOL_CALL_RESPONSE 统一发送点:steer 中途指示随响应捎带(不新增 IPC 通道)。
   * 该 envId 绑定条目的 steerQueue 全部出队并入 payload.steerNote;
   * Worker 两执行代理把它以"[来自 Lead 的中途指示]"前缀并入工具结果。
   */
  private respondToolCall(child: ChildProcess, requestId: string, envId: string, payload: Record<string, unknown>): void {
    const notes = getTaskRegistry().drainSteerByEnvId(envId)
    child.send({
      type: IPCMessageType.TOOL_CALL_RESPONSE,
      id: requestId,
      payload: notes.length > 0 ? { ...payload, steerNote: notes.join('\n') } : payload,
    })
    // 观测(执行过程面板):统一响应点旁听,按 payload.success 发 success/failed——
    // 编排/团队门/名单拒绝与执行成败全分支均经此点,一处覆盖;旁听不改任何响应内容与时序
    const ctx = this.toolCallContexts.get(requestId)
    if (ctx) {
      this.toolCallContexts.delete(requestId) // 响应后即删键(防长期运行下 Map 泄漏)
      this.emitToolCallEvent(envId, {
        toolCallId: ctx.toolCallId,
        toolName: ctx.toolName,
        kind: ctx.kind,
        argsSummary: ctx.argsSummary,
        status: payload.success === true ? 'success' : 'failed',
        resultSummary: this.summarizeToolCallField(payload.success === true ? payload.result : payload.error),
        durationMs: Date.now() - ctx.at,
        at: Date.now(),
      })
    }
  }

  /** 工具调用观测(执行过程面板):入口登记的起始时间与请求上下文(requestId 键),响应发射后随即删键 */
  private toolCallContexts = new Map<string, { at: number; toolCallId: string; toolName: string; kind: string; argsSummary: string }>()

  /** 载荷截断:4KB/字段(BOARD_RESULT_MAX_CHARS 先例——防 MB 级巨型载荷[TUI RangeError 史],不是防可读性) */
  private summarizeToolCallField(value: unknown): string {
    let text: string
    if (value === undefined || value === null) text = ''
    else if (typeof value === 'string') text = value
    else {
      try {
        text = JSON.stringify(value) ?? ''
      } catch {
        text = String(value)
      }
    }
    return text.length > BOARD_RESULT_MAX_CHARS ? `${text.slice(0, BOARD_RESULT_MAX_CHARS)}…(已截断)` : text
  }

  /** 观测发射(旁听):try/catch 包裹——观测绝不能影响网关;归属经 resolveOrigin(envId) 计算 */
  private emitToolCallEvent(envId: string, payload: Omit<SubagentToolCallPayload, 'taskId' | 'subagentType'>): void {
    try {
      const origin = this.resolveOrigin(envId)
      eventBus.emit(EVENTS.SUBAGENT_TOOL_CALL, {
        ...payload,
        ...(origin.taskId ? { taskId: origin.taskId } : {}),
        ...(origin.subagentType ? { subagentType: origin.subagentType } : {}),
      } satisfies SubagentToolCallPayload)
    } catch {
      // 静默:观测失败不影响网关
    }
  }

private async handleToolCallRequest(child: ChildProcess, message: any, envId: string): Promise<void> {
    const { id: requestId, payload } = message
    const request = (payload ?? {}) as WorkerToolCallRequest
    const { toolName, args, connectionId } = request
    const kind = request.kind ?? 'mcp'

    workerLog('INFO',`[TemplateSubagentForkManager] 收到工具调用请求 [${requestId}]: ${toolName} (kind=${kind})`)

    // 观测(执行过程面板):入口发 running,起始时间与上下文存 Map(响应时取出算 durationMs 并随即删键)
    const argsSummary = this.summarizeToolCallField(args ?? {})
    this.toolCallContexts.set(requestId, {
      at: Date.now(),
      toolCallId: request.toolCallId ?? requestId,
      toolName,
      kind,
      argsSummary,
    })
    this.emitToolCallEvent(envId, {
      toolCallId: request.toolCallId ?? requestId,
      toolName,
      kind,
      argsSummary,
      status: 'running',
      at: Date.now(),
    })

    // 网关复核①：编排工具原则上永不放行（防无限套娃的执行层强制）；
    // 迭代 3 豁免:团队成员经授权快照获得编排工具(如 task 拉新)时按快照放行——判定与拉新门同一 SSOT
    // (teamPolicy.hasGrant,含 派生名→词干→模板 回退链);team_policy 是团队元工具(成员只读,执行层按 __origin 强制),成员一律放行。
    // 成员身份由网关 envId 反查 taskId 再问 roster(resolveOrigin 同通道),Worker 无法伪造
    if (ORCHESTRATION_TOOL_NAMES.includes(toolName)) {
      const originTaskId = this.resolveOrigin(envId).taskId
      const svc = getTeamRuntimeService()
      const memberName = svc?.getMemberNameByTaskId(originTaskId)
      const callerAgent = memberName
        ? svc?.getActiveTeam()?.roster.find((e) => e.name === memberName)?.agent
        : undefined
      const exempt =
        memberName !== undefined &&
        (toolName === 'team_policy' || hasGrant(svc?.getSnapshot(), memberName, toolName, callerAgent))
      if (!exempt) {
        this.respondToolCall(child, requestId, envId, {
          success: false,
          error: `工具 "${toolName}" 为编排工具，Subagent 不可调用（防止嵌套委派）。请直接完成任务或报告无法完成。`,
        })
        return
      }
    }

    // 团队工具成员资格门(独立于下方 authorizedTools 名单分支——不设限路径同样强制):
    // 成员资格不经 Worker 传参,由网关 envId 反查 taskId 再问 roster(resolveOrigin 同通道),Worker 无法伪造;
    // 在册成员放行并跳过名单复核(与 escalate_to_lead 豁免并列,对称语义)
    const isTeamTool = TEAM_TOOL_NAMES.includes(toolName)
    if (isTeamTool) {
      const originTaskId = this.resolveOrigin(envId).taskId
      if (!getTeamRuntimeService()?.isMemberTask(originTaskId)) {
        this.respondToolCall(child, requestId, envId, {
          success: false,
          error: `工具 "${toolName}" 仅团队成员可用（当前任务不在活动团队花名册内；团队成员由 Lead 经 task/batch_task 派活产生）`,
        })
        return
      }
    }

    // 网关复核②：授权名单复核（Worker 内任何路径都无法绕过本网关触达真实执行）
    // 已定义即复核：空名单 = 零工具（不再是"未指定=全量"——统一收敛语义,见 toolPolicy.ts 头部注释）;
    // escalate_to_lead、board 与团队工具(已过上方成员资格门)白名单豁免(不占授权名额,与编排黑名单对称)
    if (request.authorizedTools !== undefined && !request.authorizedTools.includes(toolName) && toolName !== ESCALATE_TOOL_NAME && toolName !== BOARD_TOOL_NAME && !isTeamTool) {
      const scopeText = request.authorizedTools.length > 0
        ? `授权名单：${request.authorizedTools.join(', ')}`
        : '本任务未授权任何工具'
      this.respondToolCall(child, requestId, envId, {
          success: false,
          error: `工具 "${toolName}" 不在本任务的授权工具名单内，已被拒绝。${scopeText}`,
        })
      return
    }

    try {
      if (kind === 'builtin') {
        // 内置工具：转发宿主真实执行器（CLI=进程内实例；electron=渲染进程转发器）
        if (!this.builtinExecutor) {
          throw new Error('宿主未注入内置工具执行器（builtinExecutor），无法执行 Subagent 的内置工具调用')
        }
        // 归属注入：args 保留字段 __origin 随调用透传给宿主 executor（审批载荷归属由此读取）。
        // 以网关注入为准（展开在后，覆盖 Worker 自带同名字段，防伪造归属）；
        // 协议向后兼容：无 __origin 时宿主按 {source:'main'} 缺省。
        // mcp 分支不注入（MCP 写在进程外，路径边界管不到，见计划豁免清单）
        const argsWithOrigin = { ...(args ?? {}), __origin: this.resolveOrigin(envId) }
        const result = await this.builtinExecutor(toolName, JSON.stringify(argsWithOrigin), request.toolCallId)

        workerLog('INFO',`[TemplateSubagentForkManager] 内置工具执行完成 [${requestId}]: ${toolName}`)

        this.respondToolCall(child, requestId, envId, {
            success: true,
            result,
          })
        return
      }

      const mcpService = this.mcpService

      if (!mcpService) {
        throw new Error('MCP 服务未初始化')
      }

      // Worker MCP hooks（阶段 4）：Worker 的 MCP 调用必经本网关（咽喉在宿主进程内），
      // 在此过 PreToolUse/PostToolUse——与主会话挂点（executeOneToolCall）来源互斥、无双触发。
      // 来源标记：origin 仅随 hook 载荷透传，不进工具入参——args 原样发往外部 MCP server，
      // 注入 __origin 保留字段会污染协议（builtin 分支的 __origin 由宿主 executor 消费，MCP 无此消费者）。
      // 未注册派发通道（如 electron 主进程尚未接线）时跳过 hooks，行为与此前一致。
      const hookDispatcher = getWorkerMcpHookDispatcher()
      const origin = this.resolveOrigin(envId)
      let effectiveArgs = args
      const hookNotes: string[] = []
      if (hookDispatcher) {
        const pre = await hookDispatcher('PreToolUse', {
          toolName,
          toolInput: args,
          toolCallId: request.toolCallId,
          origin,
        })
        if (pre) {
          hookNotes.push(...pre.notes)
          if (pre.deny !== undefined) {
            this.respondToolCall(child, requestId, envId, { success: false, error: pre.deny })
            return
          }
          if (pre.updatedInput) effectiveArgs = pre.updatedInput
        }
      }

      // 使用主进程的 MCP 服务调用工具
      const result = await mcpService.getToolsService().callTool(toolName, effectiveArgs, connectionId)

      let finalResult: unknown = result
      if (hookDispatcher) {
        const post = await hookDispatcher('PostToolUse', {
          toolName,
          toolInput: effectiveArgs,
          toolResponse: result,
          toolCallId: request.toolCallId,
          origin,
        })
        if (post) {
          hookNotes.push(...post.notes)
          if (post.updatedResponse !== undefined) finalResult = post.updatedResponse
        }
      }
      // hook 附加上下文拼入结果文本回传 Worker（Worker 模型的唯一回传通道；
      // 仅字符串/含字符串 content 的形态追加，其余形态不动结构）
      if (hookNotes.length > 0) {
        const appendix = `\n\n【hook 附加上下文】\n${hookNotes.join('\n')}`
        if (typeof finalResult === 'string') {
          finalResult = finalResult + appendix
        } else if (finalResult && typeof finalResult === 'object' && typeof (finalResult as any).content === 'string') {
          finalResult = { ...(finalResult as Record<string, unknown>), content: (finalResult as any).content + appendix }
        }
      }

      workerLog('INFO',`[TemplateSubagentForkManager] 工具调用成功 [${requestId}]: ${toolName}`, result)

      // 发送成功响应给 Worker
      this.respondToolCall(child, requestId, envId, {
          success: true,
          result: finalResult,
        })
    } catch (error) {
      workerLog('ERROR',`[TemplateSubagentForkManager] 工具调用失败 [${requestId}]: ${toolName}`, error)

      // 发送失败响应给 Worker
      this.respondToolCall(child, requestId, envId, {
          success: false,
          error: error instanceof Error ? error.message : '工具调用失败',
        })
    }
  }
}

/**
 * 全局TemplateSubagentForkManager实例
 */
let globalForkManager: TemplateSubagentForkManager | null = null

/**
 * 获取全局TemplateSubagentForkManager实例
 * 首个调用者定参创建；后续带参调用经 setDependencies 补注入（装配顺序不确定时保证依赖就位）
 * @returns TemplateSubagentForkManager实例
 */
export function getForkManager(mcpService?: MCPService, builtinExecutor?: BuiltinToolInvoker): TemplateSubagentForkManager {
  if (!globalForkManager) {
    globalForkManager = new TemplateSubagentForkManager(mcpService, builtinExecutor)
  } else {
    globalForkManager.setDependencies(mcpService, builtinExecutor)
  }
  return globalForkManager
}

/**
 * 重置全局TemplateSubagentForkManager实例
 * 主要用于测试
 */
export function resetForkManager(): void {
  globalForkManager = null
}
