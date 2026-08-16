export type { SupportedLanguage } from '../types/workflow'

export interface ExecutionOptions {
  timeout?: number
  /** 本地模式工作目录：传入时在用户环境执行（代码写临时文件到该目录 + shell:false + 完整 env），
   * 不传走沙箱模式（临时工作区 + 裁剪 env）。execute_code 工具经此暴露本地执行。 */
  cwd?: string
}

export interface ExecutionResult {
  success: boolean
  output?: string
  error?: string
  logs?: string[]
  duration?: number
}

export type OutputCallback = (processId: string, data: string, type: 'stdout' | 'stderr') => void

export type ExitCallback = (processId: string, code: number, reason: string, error?: string) => void
