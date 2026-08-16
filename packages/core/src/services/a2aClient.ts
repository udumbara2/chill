import type { AgentCard, A2ATaskState } from '../types/workflow'

/**
 * A2A任务请求参数
 */
export interface A2ATaskRequest {
  /** 任务ID（可选，不传则自动生成） */
  id?: string
  /** 会话ID */
  sessionId: string
  /** 用户消息 */
  message: {
    role: 'user'
    parts: Array<{
      type: 'text'
      text: string
    }>
  }
  /** 是否使用流式响应 */
  streaming?: boolean
  /** 任务元数据 */
  metadata?: Record<string, any>
}

/**
 * A2A任务响应
 */
export interface A2ATaskResponse {
  /** 任务ID */
  id: string
  /** 会话ID */
  sessionId: string
  /** 任务状态 */
  status: {
    state: A2ATaskState
    message?: string
  }
  /** 响应消息（非流式时返回） */
  message?: {
    role: 'agent'
    parts: Array<{
      type: 'text'
      text: string
    }>
  }
  /** 任务产物 */
  artifacts?: Array<{
    parts: Array<{
      type: 'text' | 'file'
      text?: string
      file?: {
        name: string
        mimeType?: string
        bytes?: string
        uri?: string
      }
    }>
  }>
  /** 任务元数据 */
  metadata?: Record<string, any>
  /** 错误信息 */
  error?: {
    code: number
    message: string
  }
}

/**
 * A2A流式响应事件
 */
export interface A2AStreamEvent {
  /** 事件类型 */
  type: 'status' | 'message' | 'error'
  /** 任务ID */
  taskId: string
  /** 状态更新 */
  status?: {
    state: A2ATaskState
    message?: string
  }
  /** 消息片段 */
  message?: {
    role: 'agent'
    parts: Array<{
      type: 'text'
      text: string
    }>
  }
  /** 错误信息 */
  error?: {
    code: number
    message: string
  }
}

/**
 * A2A客户端配置
 */
export interface A2AClientConfig {
  /** A2A服务URL */
  url: string
  /** 请求超时时间（毫秒） */
  timeout?: number
  /** 重试次数 */
  retryCount?: number
  /** 重试间隔（毫秒） */
  retryDelay?: number
  /** 认证信息 */
  auth?: {
    type: 'none' | 'api_key' | 'oauth'
    apiKey?: string
  }
}

/**
 * A2A客户端服务
 * 用于调用远程A2A Agent
 */
export class A2AClient {
  private config: A2AClientConfig
  private abortController: AbortController | null = null

  constructor(config: A2AClientConfig) {
    this.config = {
      timeout: 60000, // 默认60秒超时
      retryCount: 3,  // 默认重试3次
      retryDelay: 1000, // 默认重试间隔1秒
      ...config
    }
  }

  /**
   * 获取Agent Card
   * 用于获取远程Agent的能力信息
   */
  async getAgentCard(): Promise<AgentCard | null> {
    try {
      const response = await fetch(`${this.config.url}/.well-known/agent.json`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`Failed to get agent card: ${response.status} ${response.statusText}`)
      }

      return await response.json() as AgentCard
    } catch (error) {
      console.error('获取Agent Card失败:', error)
      return null
    }
  }

  /**
   * 发送任务请求（非流式）
   * @param request 任务请求
   */
  async sendTask(request: A2ATaskRequest): Promise<A2ATaskResponse> {
    const retryCount = this.config.retryCount || 3
    let lastError: Error | null = null

    for (let attempt = 0; attempt < retryCount; attempt++) {
      try {
        return await this.doSendTask(request)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < retryCount - 1) {
          const delay = (this.config.retryDelay || 1000) * Math.pow(2, attempt)
          await this.sleep(delay)
        }
      }
    }

    throw lastError || new Error('发送任务请求失败')
  }

  /**
   * 发送任务请求（流式）
   * @param request 任务请求
   * @param onEvent 流式事件回调
   */
  async sendTaskStream(
    request: A2ATaskRequest,
    onEvent: (event: A2AStreamEvent) => void
  ): Promise<void> {
    const retryCount = this.config.retryCount || 3
    let lastError: Error | null = null

    for (let attempt = 0; attempt < retryCount; attempt++) {
      try {
        await this.doSendTaskStream(request, onEvent)
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < retryCount - 1) {
          const delay = (this.config.retryDelay || 1000) * Math.pow(2, attempt)
          await this.sleep(delay)
        }
      }
    }

    throw lastError || new Error('发送流式任务请求失败')
  }

  /**
   * 取消当前请求
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  /**
   * 执行实际的任务发送（非流式）
   */
  private async doSendTask(request: A2ATaskRequest): Promise<A2ATaskResponse> {
    this.abortController = new AbortController()
    const timeout = this.config.timeout || 60000

    const timeoutId = setTimeout(() => {
      this.abortController?.abort()
    }, timeout)

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }

      // 添加认证头
      if (this.config.auth?.type === 'api_key' && this.config.auth.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.auth.apiKey}`
      }

      const response = await fetch(`${this.config.url}/tasks/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: this.abortController.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      return await response.json() as A2ATaskResponse
    } catch (error) {
      clearTimeout(timeoutId)
      
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('请求超时或被取消')
        }
      }
      throw error
    } finally {
      this.abortController = null
    }
  }

  /**
   * 执行实际的任务发送（流式）
   */
  private async doSendTaskStream(
    request: A2ATaskRequest,
    onEvent: (event: A2AStreamEvent) => void
  ): Promise<void> {
    this.abortController = new AbortController()
    const timeout = this.config.timeout || 60000

    const timeoutId = setTimeout(() => {
      this.abortController?.abort()
    }, timeout)

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      }

      // 添加认证头
      if (this.config.auth?.type === 'api_key' && this.config.auth.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.auth.apiKey}`
      }

      const response = await fetch(`${this.config.url}/tasks/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, streaming: true }),
        signal: this.abortController.signal
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('无法获取响应流')
      }

      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          
          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            this.parseSSELine(line.trim(), request.sessionId, onEvent)
          }
        }

        // 处理剩余数据
        if (buffer) {
          this.parseSSELine(buffer.trim(), request.sessionId, onEvent)
        }
      } finally {
        reader.releaseLock()
        clearTimeout(timeoutId)
      }
    } catch (error) {
      clearTimeout(timeoutId)
      
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          // 发送取消事件
          onEvent({
            type: 'error',
            taskId: request.id || '',
            error: {
              code: -32000,
              message: '请求超时或被取消'
            }
          })
          return
        }
      }
      throw error
    } finally {
      this.abortController = null
    }
  }

  /**
   * 解析SSE行
   */
  private parseSSELine(
    line: string,
    taskId: string,
    onEvent: (event: A2AStreamEvent) => void
  ): void {
    if (!line.startsWith('data: ')) {
      return
    }

    const data = line.slice(6) // 移除 'data: ' 前缀
    
    if (data === '[DONE]') {
      return
    }

    try {
      const event = JSON.parse(data)
      
      // 转换为标准事件格式
      const streamEvent: A2AStreamEvent = {
        type: event.type || 'message',
        taskId: event.taskId || taskId,
        status: event.status,
        message: event.message,
        error: event.error
      }

      onEvent(streamEvent)
    } catch (error) {
      console.error('解析SSE事件失败:', error, '原始数据:', data)
    }
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

/**
 * 创建A2A客户端实例
 * @param config 客户端配置
 */
export function createA2AClient(config: A2AClientConfig): A2AClient {
  return new A2AClient(config)
}
