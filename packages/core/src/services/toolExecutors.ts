import type { ExecutableTool } from './toolExecutorRegistry'
import { MCPService } from './mcp/mcpService'
import { ASYNC_BUILTIN_TOOLS } from './builtInTools'
import type { BuiltInToolExecutor } from './builtInToolExecutor'
import type { Message } from '../types/models'
import { A2AClient } from './a2aClient'
import type { ExecutableResource, SavedAgent } from '../types/workflow'
import { CozeAgentAdapter } from './coze/CozeAgentAdapter'
import type { ILocalAgentExecutor } from '../interfaces/ILocalAgentExecutor'
import type { ISecureStorage } from '../interfaces/ISecureStorage'

export class MCPTool implements ExecutableTool {
  name: string
  type: string = 'mcp'
  private mcpService: MCPService
  private messages: Message[]

  constructor(name: string, messages: Message[] = []) {
    this.name = name
    this.mcpService = new MCPService()
    this.messages = messages
  }

  async execute(args: Record<string, any>): Promise<any> {
    const toolCall = {
      function: {
        name: this.name,
        arguments: args
      }
    }

    const result = await this.mcpService.executeToolCall(toolCall, this.messages)
    return result
  }
}

export class BuiltInTool implements ExecutableTool {
  name: string
  type: string = 'builtin'
  private toolCallId?: string
  private builtInExecutor: BuiltInToolExecutor

  constructor(name: string, toolCallId: string | undefined, builtInExecutor: BuiltInToolExecutor) {
    this.name = name
    this.toolCallId = toolCallId
    this.builtInExecutor = builtInExecutor
  }

  async execute(args: Record<string, any>): Promise<any> {
    const argsString = JSON.stringify(args)

    const asyncTools = ASYNC_BUILTIN_TOOLS
    const needToolCallId = ['execute_powershell', 'create_file', 'delete_file', 'insert_content', 'replace_content', 'delete_content', 'computer_use']

    if (asyncTools.includes(this.name)) {
      if (needToolCallId.includes(this.name) && !this.toolCallId) {
        throw new Error(`${this.name} 需要提供 toolCallId`)
      }
      const result = await this.builtInExecutor.executeAsync(this.name, argsString, this.toolCallId)
      if (!result.success) {
        let errorMsg = result.error || `${this.name} 执行失败`
        if (result.candidates && result.candidates.length > 0) {
          errorMsg += '\n\n可能的匹配位置：'
          result.candidates.forEach((c, i) => {
            errorMsg += `\n${i + 1}. 位置 ${c.index}: "${c.snippet}"`
            if (c.suggested_context_before) {
              errorMsg += `\n   建议上下文前文: "${c.suggested_context_before}"`
            }
            if (c.suggested_context_after) {
              errorMsg += `\n   建议上下文后文: "${c.suggested_context_after}"`
            }
          })
        }
        throw new Error(errorMsg)
      }
      // 携带媒体块的工具结果（如 capture_screen 截图）需透传 mediaParts 供 TOOL 消息管线识别；缺省时行为逐字节不变
      return result.mediaParts ? { data: result.data, mediaParts: result.mediaParts } : result.data
    }

    const result = this.builtInExecutor.execute(this.name, argsString)

    if (!result.success) {
      let errorMsg = result.error || '内置工具执行失败'
      if (result.candidates && result.candidates.length > 0) {
        errorMsg += '\n\n可能的匹配位置：'
        result.candidates.forEach((c, i) => {
          errorMsg += `\n${i + 1}. 位置 ${c.index}: "${c.snippet}"`
          if (c.suggested_context_before) {
            errorMsg += `\n   建议上下文前文: "${c.suggested_context_before}"`
          }
          if (c.suggested_context_after) {
            errorMsg += `\n   建议上下文后文: "${c.suggested_context_after}"`
          }
        })
      }
      throw new Error(errorMsg)
    }

    return result.data
  }
}

export class RemoteAgentTool implements ExecutableTool {
  name: string
  type: string = 'remote_agent'
  private resource: ExecutableResource
  private adapter: A2AClient | CozeAgentAdapter | null = null
  private secureStorage: ISecureStorage

  constructor(resource: ExecutableResource, secureStorage: ISecureStorage) {
    this.name = `execute_remote_agent_${sanitizeName(resource.name, resource.id)}`
    this.resource = resource
    this.secureStorage = secureStorage

    const config = resource.config as any

    if (config?.type === 'coze') {
      if (!config?.bot_id) {
        throw new Error(`远程 Agent ${resource.name} 未配置 Bot ID`)
      }
      this.adapter = new CozeAgentAdapter({
        bot_id: config.bot_id,
        token: config.token || '',
        baseURL: config.baseURL,
      })
    } else {
      const agentUrl = config?.url || config?.agentUrl
      if (!agentUrl) {
        throw new Error(`远程 Agent ${resource.name} 未配置 URL`)
      }
      this.adapter = new A2AClient({
        url: agentUrl,
        timeout: config?.timeout || 60000,
        retryCount: config?.retryCount || 3,
      })
    }
  }

  async execute(args: Record<string, any>): Promise<any> {
    try {
      if (this.adapter instanceof CozeAgentAdapter) {
        const config = this.resource.config as any

        const token = await this.secureStorage.getApiKey('coze')
        if (!token && !config?.token) {
          throw new Error('Coze Token 未配置')
        }

        const effectiveToken = token || config.token

        const cozeAdapter = new CozeAgentAdapter({
          bot_id: config.bot_id,
          token: effectiveToken,
          baseURL: config.baseURL,
        })

        const message = args.message || args.input || JSON.stringify(args)
        const result = await cozeAdapter.chat(message)
        return { content: result.content || result, artifacts: [] }
      } else if (this.adapter instanceof A2AClient) {
        const request = {
          sessionId: args.sessionId || `session_${Date.now()}`,
          message: {
            role: 'user' as const,
            parts: [
              {
                type: 'text' as const,
                text: args.message || args.input || JSON.stringify(args),
              },
            ],
          },
          streaming: false,
        }

        const response = await this.adapter.sendTask(request)

        if (response.message?.parts && response.message.parts.length > 0) {
          const textParts = response.message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
          return { content: textParts, artifacts: response.artifacts || [] }
        }

        return { content: '远程 Agent 执行完成，但没有返回内容', artifacts: response.artifacts || [] }
      } else {
        throw new Error('未知的 Agent 适配器类型')
      }
    } catch (error) {
      console.error('RemoteAgentTool execute error:', error)
      throw new Error(
        `Agent 执行失败: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

function sanitizeName(name: string, id?: string): string {
  let sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  
  if (!sanitized) {
    if (id) {
      sanitized = 'agent_' + id.slice(-8)
    } else {
      sanitized = 'agent_' + Math.random().toString(36).substring(2, 10)
    }
  }
  
  return sanitized
}

export class LocalAgentTool implements ExecutableTool {
  name: string
  type: string = 'local_agent'
  private resource: ExecutableResource
  private localExecutor: ILocalAgentExecutor

  constructor(resource: ExecutableResource, localExecutor: ILocalAgentExecutor) {
    this.name = `execute_local_agent_${sanitizeName(resource.name, resource.id)}`
    this.resource = resource
    this.localExecutor = localExecutor
  }

  async execute(args: Record<string, any>): Promise<any> {
    const config = this.resource.config as any
    const agentId = config?.agentId || config?.id
    if (!agentId) {
      throw new Error(`本地 Agent ${this.name} 未配置 agentId`)
    }

    console.log('【LocalAgentTool】正在加载 Agent:', agentId)
    const loadResult = await this.localExecutor.agentLoad(agentId)
    if (!loadResult.success || !loadResult.agent) {
      throw new Error(`加载 Agent ${agentId} 失败: ${loadResult.error || '未知错误'}`)
    }

    const savedAgent: SavedAgent = loadResult.agent
    console.log('【LocalAgentTool】Agent 加载成功:', savedAgent.metadata.name)

    const agent = {
      metadata: {
        id: savedAgent.metadata.id,
        name: savedAgent.metadata.name,
        description: savedAgent.metadata.description,
        version: savedAgent.metadata.version
      },
      nodes: savedAgent.nodes,
      edges: savedAgent.edges
    }

    const params = {
      id: args.taskId || `task_${Date.now()}`,
      sessionId: args.sessionId || `session_${Date.now()}`,
      message: {
        role: 'user' as const,
        parts: [
          {
            type: 'text' as const,
            text: args.message || args.input || JSON.stringify(args)
          }
        ]
      }
    }

    const result = await this.localExecutor.a2aExecuteTask(agent, params)

    console.log('【LocalAgentTool】执行结果:', JSON.stringify(result, null, 2))

    if (!result.success) {
      throw new Error(result.error || '本地 Agent 执行失败')
    }

    const response = result.result
    console.log('【LocalAgentTool】response结构:', JSON.stringify(response, null, 2))
    console.log('【LocalAgentTool】response.status:', response?.status)
    console.log('【LocalAgentTool】response.artifacts:', response?.artifacts)
    console.log('【LocalAgentTool】response.artifacts?.length:', response?.artifacts?.length)
    console.log('【LocalAgentTool】response.message:', response?.message)
    console.log('【LocalAgentTool】response完整键:', Object.keys(response || {}))
    
    if (response?.status?.state === 'completed' && response.artifacts && response.artifacts.length > 0) {
      console.log('【LocalAgentTool】进入 artifacts 处理分支')
      const texts: string[] = []
      for (const artifact of response.artifacts) {
        console.log('【LocalAgentTool】处理 artifact:', artifact)
        if (artifact.parts && Array.isArray(artifact.parts)) {
          for (const part of artifact.parts) {
            console.log('【LocalAgentTool】处理 part:', part)
            if (part.type === 'text' && part.text) {
              texts.push(part.text)
              console.log('【LocalAgentTool】添加文本:', part.text)
            }
          }
        }
      }
      console.log('【LocalAgentTool】提取的 texts:', texts)
      if (texts.length > 0) {
        const content = texts.join('\n')
        console.log('【LocalAgentTool】返回 content:', content)
        return { content, artifacts: response.artifacts }
      }
    }
    
    if (response?.message?.parts && response.message.parts.length > 0) {
      console.log('【LocalAgentTool】进入 message.parts 处理分支')
      const textParts = response.message.parts
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('\n')
      if (textParts) {
        console.log('【LocalAgentTool】返回 textParts:', textParts)
        console.log('【LocalAgentTool】注意：此分支不返回 artifacts')
        return { content: textParts, artifacts: [] }
      }
    }

    console.log('【LocalAgentTool】没有提取到内容，返回默认消息')
    return { content: '本地 Agent 执行完成，但没有返回内容', artifacts: [] }
  }
}
