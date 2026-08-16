/**
 * WorkerMCPClient - Worker 进程中的 MCP 客户端
 * 
 * 这个客户端不直接连接 MCP 服务器，而是通过 IPC 向主进程发送工具调用请求，
 * 由主进程的 McpClientManager 执行实际的工具调用，然后将结果返回给 Worker。
 * 
 * 这是为了解决 Worker 进程中无法直接访问 window.electronAPI 的问题。
 */

import { IPCMessageType } from '../types'
import type { WorkerToolCallRequest } from '../types'

/** callTool 扩展选项 */
export interface WorkerCallToolOptions {
  /** 工具类别（默认 'mcp'；'builtin' 为内置工具转发宿主真实执行器） */
  kind?: 'builtin' | 'mcp'
  /** 内置工具调用的 toolCallId（宿主确认流以其为键） */
  toolCallId?: string
  /** Subagent 授权工具名单（宿主网关复核依据） */
  authorizedTools?: string[]
}

/**
 * 工具调用响应
 */
interface ToolCallResponse {
  success: boolean
  result?: any
  error?: string
}

/**
 * 待处理的工具调用请求
 * timeout 为 null 表示不设超时（builtin 通道：宿主确认等待时长不可控）
 */
interface PendingToolCall {
  resolve: (value: any) => void
  reject: (reason: Error) => void
  timeout: NodeJS.Timeout | null
}

/**
 * Worker MCP 客户端
 * 通过 IPC 与主进程通信，间接调用 MCP 工具
 */
export class WorkerMCPClient {
  private pendingToolCalls: Map<string, PendingToolCall> = new Map()
  private requestTimeout: number = 30000 // 30秒超时

  constructor() {
    // 监听来自主进程的响应
    this.setupMessageListener()
  }

  /**
   * 设置消息监听器
   * 监听主进程返回的工具调用结果
   */
  private setupMessageListener(): void {
    if (typeof process === 'undefined' || !process.on) {
      console.error('[WorkerMCPClient] 不在 Worker 进程中，无法设置消息监听器')
      return
    }

    process.on('message', (message: any) => {
      if (message.type !== IPCMessageType.TOOL_CALL_RESPONSE) {
        return
      }

      const { id, payload } = message
      const pendingCall = this.pendingToolCalls.get(id)

      if (!pendingCall) {
        console.warn(`[WorkerMCPClient] 未找到待处理的工具调用: ${id}`)
        return
      }

      // 清除超时定时器
      if (pendingCall.timeout) {
        clearTimeout(pendingCall.timeout)
      }
      this.pendingToolCalls.delete(id)

      // 处理响应
      const response = payload as ToolCallResponse
      if (response.success) {
        console.log(`[WorkerMCPClient] 工具调用成功: ${id}`)
        pendingCall.resolve(response.result)
      } else {
        console.error(`[WorkerMCPClient] 工具调用失败: ${id}`, response.error)
        pendingCall.reject(new Error(response.error || '工具调用失败'))
      }
    })

    console.log('[WorkerMCPClient] 消息监听器已设置')
  }

  /**
   * 调用 MCP 工具
   * 通过 IPC 向主进程发送工具调用请求
   * @param toolName 工具名称
   * @param args 工具参数
   * @param connectionId 可选的连接ID
   * @returns 工具调用结果
   */
  async callTool(
    toolName: string,
    args?: Record<string, any>,
    connectionId?: string,
    options?: WorkerCallToolOptions
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // 生成请求ID
      const requestId = `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

      const kind = options?.kind ?? 'mcp'

      // builtin 通道不设超时：宿主确认等待（用户操作）时长不可控，
      // 放弃等待由 worker destroy / 宿主拒绝响应兜底；mcp 通道维持 30s
      const timeout = kind === 'builtin'
        ? null
        : setTimeout(() => {
            this.pendingToolCalls.delete(requestId)
            reject(new Error(`工具调用超时 (${this.requestTimeout}ms): ${toolName}`))
          }, this.requestTimeout)

      // 存储待处理的请求
      this.pendingToolCalls.set(requestId, {
        resolve,
        reject,
        timeout,
      })

      // 发送工具调用请求到主进程
      const request: WorkerToolCallRequest = {
        kind,
        toolName,
        args: args || {},
        connectionId,
        toolCallId: options?.toolCallId,
        authorizedTools: options?.authorizedTools,
      }

      console.log(`[WorkerMCPClient] 发送工具调用请求: ${toolName}`, {
        requestId,
        hasArgs: !!args && Object.keys(args).length > 0,
        connectionId,
      })

      if (typeof process === 'undefined' || !process.send) {
        if (timeout) clearTimeout(timeout)
        this.pendingToolCalls.delete(requestId)
        reject(new Error('不在 Worker 进程中，无法发送 IPC 消息'))
        return
      }

      try {
        process.send!({
          type: IPCMessageType.TOOL_CALL_REQUEST,
          id: requestId,
          payload: request,
        })
      } catch (error) {
        if (timeout) clearTimeout(timeout)
        this.pendingToolCalls.delete(requestId)
        reject(new Error(`发送工具调用请求失败: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
    })
  }

  /**
   * 获取活跃连接ID
   * 在 Worker 中无法直接获取，返回 undefined，让主进程决定
   */
  async getActiveConnectionId(): Promise<string | undefined> {
    // Worker 中无法直接获取活跃连接ID，返回 undefined
    // 主进程会根据工具名称自动选择合适的连接
    return undefined
  }

  /**
   * 列出所有连接
   * 在 Worker 中不支持此操作
   */
  async listConnections(): Promise<{ success: boolean; connections?: any[]; error?: string }> {
    return {
      success: false,
      error: 'Worker 中不支持列出连接',
    }
  }

  /**
   * 列出工具
   * 在 Worker 中不支持此操作
   */
  async listTools(_connectionId?: string): Promise<{ success: boolean; tools?: any[]; error?: string }> {
    return {
      success: false,
      error: 'Worker 中不支持列出工具',
    }
  }

  /**
   * 检查客户端是否已连接
   * 在 Worker 中始终返回 true，因为通过 IPC 通信
   */
  async isConnected(): Promise<boolean> {
    return true
  }
}

/**
 * WorkerMCPClient 单例实例
 */
let workerMCPClientInstance: WorkerMCPClient | null = null

/**
 * 获取 WorkerMCPClient 单例
 * @returns WorkerMCPClient 实例
 */
export function getWorkerMCPClient(): WorkerMCPClient {
  if (!workerMCPClientInstance) {
    workerMCPClientInstance = new WorkerMCPClient()
  }
  return workerMCPClientInstance
}

/**
 * 重置 WorkerMCPClient 实例
 * 用于测试或重置连接
 */
export function resetWorkerMCPClient(): WorkerMCPClient {
  workerMCPClientInstance = new WorkerMCPClient()
  return workerMCPClientInstance
}
