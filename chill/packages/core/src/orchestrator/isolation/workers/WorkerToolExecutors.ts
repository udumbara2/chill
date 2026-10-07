/**
 * WorkerToolExecutors - Worker 进程中的工具执行器
 * 
 * 为 Worker 进程提供专用的工具执行器实现：
 * - WorkerMCPool：通过 IPC 向主进程发送 MCP 工具调用请求
 * - WorkerBuiltInTool：在 Worker 进程内执行内置工具
 */

import type { ExecutableTool } from '../../../services/toolExecutorRegistry'
import { getWorkerMCPClient } from './WorkerMCPClient'
import { builtInToolExecutor } from '../../../services/builtInToolExecutor'

/**
 * Worker 中的 MCP 工具执行器
 * 通过 IPC 向主进程发送工具调用请求
 */
export class WorkerMCPool implements ExecutableTool {
  name: string
  type: string = 'mcp'

  /**
   * 创建 Worker MCP 工具执行器
   * @param name 工具名称
   */
  constructor(name: string) {
    this.name = name
  }

  /**
   * 执行 MCP 工具
   * 通过 IPC 向主进程发送工具调用请求
   * @param args 工具参数
   * @returns 工具执行结果（字符串格式，与 mcpService.executeToolCall 保持一致）
   */
  async execute(args: Record<string, any>): Promise<any> {
    console.log(`[WorkerMCPool] 执行 MCP 工具: ${this.name}`, { args })

    // 获取 Worker MCP 客户端
    const mcpClient = getWorkerMCPClient()

    // 调用工具
    const result = await mcpClient.callTool(this.name, args)

    console.log(`[WorkerMCPool] MCP 工具执行完成: ${this.name}`, { result })

    // 格式化结果为字符串，与 mcpService.executeToolCall 保持一致
    // baseModelService.ts 期望 toolResult.content 是字符串
    const formattedContent = this.formatToolResult(result)

    return {
      content: formattedContent,
      // 保留原始结果供需要时使用
      rawResult: result
    }
  }

  /**
   * 格式化工具执行结果为文本内容
   * 与 mcpService.formatToolResult 保持一致
   * @param toolResult 工具执行结果
   * @returns 格式化的文本内容
   */
  private formatToolResult(toolResult: any): string {
    try {
      // 如果结果是对象，转换为JSON字符串
      if (toolResult && typeof toolResult === 'object') {
        return JSON.stringify(toolResult, null, 2)
      }

      // 如果结果是字符串，直接返回
      if (typeof toolResult === 'string') {
        return toolResult
      }

      // 其他类型转换为字符串
      return String(toolResult)
    } catch (error) {
      console.error('[WorkerMCPool] 格式化工具结果失败:', error)
      return String(toolResult)
    }
  }
}

/**
 * Worker 中的内置工具执行器
 * 在 Worker 进程内直接执行内置工具
 */
export class WorkerBuiltInTool implements ExecutableTool {
  name: string
  type: string = 'builtin'

  /**
   * 创建 Worker 内置工具执行器
   * @param name 工具名称
   */
  constructor(name: string) {
    this.name = name
  }

  /**
   * 执行内置工具
   * 在 Worker 进程内直接执行
   * @param args 工具参数
   * @returns 工具执行结果
   */
  async execute(args: Record<string, any>): Promise<any> {
    console.log(`[WorkerBuiltInTool] 执行内置工具: ${this.name}`, { args })

    // 将参数转换为 JSON 字符串
    const argsString = JSON.stringify(args)

    // 调用内置工具执行器
    const result = await builtInToolExecutor.execute(this.name, argsString)

    console.log(`[WorkerBuiltInTool] 内置工具执行完成: ${this.name}`)

    return result
  }
}
