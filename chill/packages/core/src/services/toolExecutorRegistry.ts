/**
 * 工具执行器注册表
 * 统一管理所有工具执行器，提供统一的工具调用接口
 */

/**
 * 工具执行器接口
 * 所有工具执行器必须实现此接口
 */
export interface ExecutableTool {
  /** 工具名称 */
  name: string
  /** 工具类型 */
  type: string
  /**
   * 执行工具
   * @param args 工具参数
   * @returns 执行结果
   */
  execute(args: Record<string, any>): Promise<any>
}

/**
 * 工具执行结果
 */
export interface ToolExecutionResult {
  success: boolean
  data?: any
  error?: string
}

/**
 * 工具注册表类
 * 使用 Map 存储工具执行器，提供注册和执行方法
 */
export class ToolRegistry {
  private tools: Map<string, ExecutableTool> = new Map()

  /**
   * 注册工具执行器
   * @param tool 工具执行器实例
   */
  register(tool: ExecutableTool): void {
    this.tools.set(tool.name, tool)
  }

  /**
   * 执行工具
   * @param name 工具名称
   * @param args 工具参数
   * @returns 工具执行结果
   */
  async execute(name: string, args: Record<string, any>): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        success: false,
        error: `未找到工具: ${name}`
      }
    }

    try {
      const result = await tool.execute(args)
      return {
        success: true,
        data: result
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '工具执行失败'
      }
    }
  }

  /**
   * 检查工具是否存在
   * @param name 工具名称
   * @returns 是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * 获取所有已注册的工具名称
   * @returns 工具名称列表
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * 清空注册表
   */
  clear(): void {
    this.tools.clear()
  }
}

/**
 * 全局工具注册表单例实例
 */
export const toolRegistry = new ToolRegistry()
