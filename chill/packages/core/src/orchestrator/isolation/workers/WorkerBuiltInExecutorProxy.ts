/**
 * WorkerBuiltInExecutorProxy - Worker 进程内的内置工具执行代理
 *
 * 门面与 BuiltInToolExecutor 在 Worker 语境下被调用的方法子集一致
 * （executeAsync / execute / getAutoApply / getNonInteractiveMode），
 * 全部经 IPC 转发到宿主进程真实实例执行——继承宿主确认流 / autoApply / 规划门语义。
 * Worker 是不可信环境：本代理不执行任何实际操作，只做转发。
 *
 * 服务范围说明：仅覆盖 Worker 内两个调用点
 * （baseModelService 工具循环的 executeAsync 与批量冲刷门的 getAutoApply/getNonInteractiveMode、
 * WorkerBuiltInTool 的 execute）；BuiltInToolExecutor 的其他方法不存在于本门面，
 * 未来新增调用点需同步扩展。
 *
 * 注意：execute 返回 Promise（真实实例为同步签名）——Worker 内唯一调用方
 * WorkerBuiltInTool 以 await 调用，兼容；整体经 as unknown as BuiltInToolExecutor 注入单例。
 */

import type { BuiltInToolResult } from '../../../services/builtInToolExecutor'
import { getWorkerMCPClient } from './WorkerMCPClient'

export class WorkerBuiltInExecutorProxy {
  private authorizedTools: string[] | undefined

  /** 随每个 SubagentRequest 刷新授权名单（宿主网关复核依据；已定义即复核——空名单 = 零工具） */
  setAuthorizedTools(tools?: string[]): void {
    this.authorizedTools = tools ? [...tools] : undefined
  }

  getAutoApply(): boolean {
    // Worker 本地无批量冲刷（真实批量在宿主实例）；false 使 baseModelService 跳过冲刷门
    return false
  }

  getNonInteractiveMode(): null {
    return null
  }

  async executeAsync(toolName: string, args: string, toolCallId?: string): Promise<BuiltInToolResult> {
    let parsedArgs: Record<string, any>
    try {
      parsedArgs = args ? JSON.parse(args) : {}
    } catch {
      return { success: false, error: 'Invalid JSON arguments' }
    }

    try {
      const result = await getWorkerMCPClient().callTool(toolName, parsedArgs, undefined, {
        kind: 'builtin',
        toolCallId,
        authorizedTools: this.authorizedTools,
      })
      return this.normalizeResult(result)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 同步签名兼容：实际返回 Promise（WorkerBuiltInTool 以 await 调用） */
  execute(toolName: string, args: string): Promise<BuiltInToolResult> {
    return this.executeAsync(toolName, args)
  }

  /** 宿主返回的 BuiltInToolResult 原样透传；异常形态兜底包装 */
  private normalizeResult(result: any): BuiltInToolResult {
    if (result && typeof result === 'object' && 'success' in result) {
      return result as BuiltInToolResult
    }
    return { success: true, data: result }
  }
}

/** 单例（Worker 进程级；授权名单随请求刷新） */
let instance: WorkerBuiltInExecutorProxy | null = null

export function getWorkerBuiltInExecutorProxy(): WorkerBuiltInExecutorProxy {
  if (!instance) {
    instance = new WorkerBuiltInExecutorProxy()
  }
  return instance
}
