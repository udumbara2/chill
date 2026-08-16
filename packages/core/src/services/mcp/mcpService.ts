import { ToolsService } from './toolsService';
import { ConfigService } from './configService';
import { MessageRole } from '../../types/models';
import type { ToolDefinition, Message } from '../../types/models';
import type { IMCPClient } from '../../interfaces/IMCPClient';

function createNullMCPClient(): IMCPClient {
  return {
    connectWithId: async () => ({ success: false, error: 'MCP client not initialized' }),
    disconnectWithId: async () => ({ success: false, error: 'MCP client not initialized' }),
    listTools: async () => ({ success: true, tools: [] }),
    listResources: async () => ({ success: true, resources: [] }),
    listPrompts: async () => ({ success: true, prompts: [] }),
    callTool: async () => ({ success: false, error: 'MCP client not initialized' }),
    readResource: async () => ({ success: false, error: 'MCP client not initialized' }),
    getPrompt: async () => ({ success: false, error: 'MCP client not initialized' }),
    getConnectionStatus: async () => ({ success: true, status: 'disconnected' as const, isConnected: false }),
    listConnections: async () => ({ success: true, connections: [] }),
    getActiveConnectionId: async () => undefined,
    isConnected: () => false,
    getStatus: () => 'disconnected' as const,
    reset: () => {}
  }
}

/**
 * MCP服务Facade
 * 封装现有的MCP相关服务，提供统一的接口
 */
export class MCPService {
  private static _defaultClient: IMCPClient | null = null;

  static setDefaultClient(client: IMCPClient): void {
    MCPService._defaultClient = client;
  }

  private mcpClient: IMCPClient;
  private toolsService: ToolsService;
  private configService: ConfigService;
  private mcpStoreGetter?: () => { getMCPToolsEnabled: () => boolean };

  // 聚合工具缓存属性
  private cachedAggregatedTools: ToolDefinition[] = [];
  private cachedAggregatedResources: any[] = [];
  private cachedAggregatedPrompts: any[] = [];
  private lastAggregationTime: number = 0;
  private readonly AGGREGATION_CACHE_MS = 30000;

  constructor(client?: IMCPClient) {
    const resolved = client ?? MCPService._defaultClient ?? createNullMCPClient();
    this.mcpClient = resolved;
    this.toolsService = new ToolsService(this.mcpClient);
    this.configService = new ConfigService();
  }

  /**
   * 设置MCP Store获取器函数
   * @param mcpStoreGetter MCP Store获取器函数
   */
  setMCPStoreGetter(mcpStoreGetter: () => { getMCPToolsEnabled: () => boolean }): void {
    this.mcpStoreGetter = mcpStoreGetter;
  }

  /**
   * 获取当前设置的MCP Store获取器函数
   */
  getMCPStoreGetter(): (() => { getMCPToolsEnabled: () => boolean }) | undefined {
    return this.mcpStoreGetter;
  }

  /**
   * 清除聚合缓存，强制下次获取时重新聚合
   */
  clearAggregationCache(): void {
    this.cachedAggregatedTools = [];
    this.cachedAggregatedResources = [];
    this.cachedAggregatedPrompts = [];
    this.lastAggregationTime = 0;
  }

  /**
   * 获取所有已连接MCP服务器的工具并聚合
   * @returns 聚合后的OpenAI格式工具定义列表
   */
  async getAggregatedOpenAITools(): Promise<ToolDefinition[]> {
    try {
      const now = Date.now();
      const cacheAge = now - this.lastAggregationTime;
      
      if (cacheAge < this.AGGREGATION_CACHE_MS && this.cachedAggregatedTools.length > 0) {
        return this.cachedAggregatedTools;
      }

      const connectionsResponse = await this.mcpClient.listConnections();
      
      if (!connectionsResponse.success) {
        return [];
      }
      
      if (!connectionsResponse.connections) {
        return [];
      }
      
      const connectedConnections = connectionsResponse.connections.filter(
        (conn: any) => {
          const isConnected = conn.status === 'connected' || conn.connected === true;
          return isConnected;
        }
      );
      
      if (connectedConnections.length === 0) {
        return [];
      }

      const allTools: ToolDefinition[] = [];

      for (const connection of connectedConnections) {
        try {
          const connId = connection.connectionId || connection.id
          const toolsResponse = await this.mcpClient.listTools(connId);

          if (toolsResponse.success && toolsResponse.tools) {
            for (const tool of toolsResponse.tools) {
              const resolvedServerName = connection.name || (connection as any).serverName || connection.connectionId;

              const openAITool: any = {
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description || tool.name,
                  parameters: tool.inputSchema || { type: "object", properties: {} }
                },
                serverName: resolvedServerName.replace(/^mcp-/, '')
              };
              allTools.push(openAITool);
            }
          }
        } catch (error) {
          console.warn('获取MCP工具失败:', error);
        }
      }
      
      this.cachedAggregatedTools = allTools;
      this.lastAggregationTime = now;
      
      return allTools;
      
    } catch (error) {
      return [];
    }
  }

  /**
   * 获取MCP工具并转换为OpenAI格式的工具定义
   * @returns OpenAI格式的工具定义列表
   */
  async getOpenAITools(): Promise<ToolDefinition[]> {
    const mcpStore = this.mcpStoreGetter?.();
    
    if (!mcpStore?.getMCPToolsEnabled()) {
      return [];
    }

    try {
      return await this.getAggregatedOpenAITools();
    } catch (error) {
      throw new Error(`获取工具列表失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 获取活跃的MCP连接ID
   * @returns 活跃连接ID，如果找不到则返回undefined
   */
  async getActiveConnectionId(): Promise<string | undefined> {
    try {
      return await this.mcpClient.getActiveConnectionId();
    } catch (error) {
      return undefined;
    }
  }



  /**
   * 获取MCP客户端实例
   * @returns MCP客户端实例
   */
  getMCPClient(): IMCPClient {
    return this.mcpClient;
  }

  /**
   * 获取工具服务实例
   * @returns ToolsService实例
   */
  getToolsService(): ToolsService {
    return this.toolsService;
  }

  /**
   * 获取配置服务实例
   * @returns ConfigService实例
   */
  getConfigService(): ConfigService {
    return this.configService;
  }



  /**
   * 统一的错误处理方法
   * @param operation 操作名称
   * @param error 原始错误
   * @param context 错误上下文信息
   * @returns 格式化的错误对象
   */
  private createError(operation: string, error: any, context: { [key: string]: any } = {}): Error {
    let errorMessage: string
    let errorCode: string | undefined

    if (error instanceof Error) {
      errorMessage = error.message
      // 提取可能的错误代码
      if (error.message.includes('-32601') || error.message.includes('Method not found')) {
        errorCode = 'METHOD_NOT_FOUND'
      } else if (error.message.includes('连接') || error.message.includes('connection')) {
        errorCode = 'CONNECTION_ERROR'
      } else if (error.message.includes('参数') || error.message.includes('parameter')) {
        errorCode = 'INVALID_PARAMETER'
      }
    } else {
      errorMessage = `${operation}时发生未知错误: ${String(error)}`
      errorCode = 'UNKNOWN_ERROR'
    }

    // 构建详细错误信息
    const contextInfo = Object.keys(context).length > 0 
      ? ` | 上下文: ${JSON.stringify(context)}`
      : ''
    
    const detailedMessage = `${operation}失败: ${errorMessage}${contextInfo}`

    // 创建包含详细信息的错误对象
    const enhancedError = new Error(detailedMessage) as any
    enhancedError.code = errorCode
    enhancedError.originalError = error
    enhancedError.context = context
    enhancedError.timestamp = new Date().toISOString()

    return enhancedError
  }

  /**
   * 读取MCP资源内容
   * @param uri 资源URI
   * @param connectionId 连接ID（可选）
   * @param retryCount 重试次数（可选，默认0）
   * @returns 资源内容
   */
  async readResource(uri: string, connectionId?: string, retryCount: number = 0): Promise<any> {
    const maxRetries = Math.min(Math.max(retryCount, 0), 3) // 限制最大重试次数为3次
    const context = { uri, connectionId, retryAttempt: 0 }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        context.retryAttempt = attempt

        // 如果没有指定连接ID，获取活跃连接ID
        let actualConnectionId = connectionId
        if (!actualConnectionId) {
          actualConnectionId = await this.getActiveConnectionId()
          if (!actualConnectionId) {
            throw this.createError('读取资源', '没有可用的活跃连接', context)
          }
        }

        context.connectionId = actualConnectionId

        // 调用MCP客户端的readResource方法
        const result = await this.mcpClient.readResource({ uri }, actualConnectionId)
        
        // 规范化返回结果，将 content 转换为 contents 以符合预期接口
        if (result && result.content) {
          return {
            contents: result.content
          }
        }
        
        return result

      } catch (error) {
        const isLastAttempt = attempt === maxRetries
        const isRetryableError = this.isRetryableError(error)

        if (isLastAttempt || !isRetryableError) {
          const enhancedError = this.createError('读取资源', error, {
            ...context,
            retryAttempt: attempt,
            isRetryable: isRetryableError,
            maxRetries
          })
          
          throw enhancedError
        }

        if (isRetryableError && attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000
          await this.delay(delayMs)
        }
      }
    }
  }

  /**
   * 判断错误是否可重试
   * @param error 错误对象
   * @returns 是否可重试
   */
  private isRetryableError(error: any): boolean {
    // 网络错误、超时错误等可以重试
    const retryableErrorMessages = [
      'network',
      'timeout',
      'ETIMEDOUT',
      'ECONNRESET',
      'connection',
      '连接',
      '超时',
      '网络'
    ]

    if (error instanceof Error) {
      const message = error.message.toLowerCase()
      return retryableErrorMessages.some(keyword => message.includes(keyword))
    }

    // 如果不是Error对象，假设不可重试
    return false
  }

  /**
   * 延迟函数
   * @param ms 延迟毫秒数
   * @returns Promise
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * 获取MCP提示词内容
   * @param name 提示词名称
   * @param args 提示词参数（可选）
   * @param connectionId 连接ID（可选）
   * @param retryCount 重试次数（可选，默认0）
   * @returns 提示词内容
   */
  async getPrompt(name: string, args?: { [key: string]: string }, connectionId?: string, retryCount: number = 0): Promise<any> {
    const maxRetries = Math.min(Math.max(retryCount, 0), 3) // 限制最大重试次数为3次
    const context = { name, args, connectionId, retryAttempt: 0 }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        context.retryAttempt = attempt

        // 如果没有指定连接ID，获取活跃连接ID
        let actualConnectionId = connectionId
        if (!actualConnectionId) {
          actualConnectionId = await this.getActiveConnectionId()
          if (!actualConnectionId) {
            throw this.createError('获取提示词', '没有可用的活跃连接', context)
          }
        }

        context.connectionId = actualConnectionId

        // 调用MCP客户端的getPrompt方法
        const argumentsObj = args ? args : {};
        const result = await this.mcpClient.getPrompt({ name, arguments: argumentsObj }, actualConnectionId)
        
        return result

      } catch (error) {
        const isLastAttempt = attempt === maxRetries
        const isRetryableError = this.isRetryableError(error)

        if (isLastAttempt || !isRetryableError) {
          const enhancedError = this.createError('获取提示词', error, {
            ...context,
            retryAttempt: attempt,
            isRetryable: isRetryableError,
            maxRetries
          })
          
          throw enhancedError
        }

        if (isRetryableError && attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000
          await this.delay(delayMs)
        }
      }
    }
  }

  /**
   * 获取所有已连接MCP服务器的资源并聚合
   * @returns 聚合后的OpenAI格式资源列表
   */
  async getAggregatedOpenAIResources(): Promise<any[]> {
    try {
      // 检查缓存
      const now = Date.now();
      if (now - this.lastAggregationTime < this.AGGREGATION_CACHE_MS && this.cachedAggregatedResources.length > 0) {
        return this.cachedAggregatedResources;
      }
      
      // 获取所有连接
      const connectionsResponse = await this.mcpClient.listConnections();
      if (!connectionsResponse.success || !connectionsResponse.connections) {
        return [];
      }

      // 筛选已连接服务器
      const connectedConnections = connectionsResponse.connections.filter(
        (conn: any) => conn.status === 'connected' || conn.connected === true
      );

      const allResources: any[] = [];

      for (const connection of connectedConnections) {
        try {
          const resourcesResponse = await this.mcpClient.listResources(connection.connectionId);
          
          if (resourcesResponse.success && resourcesResponse.resources) {
            for (const resource of resourcesResponse.resources) {
              const enhancedResource = {
                ...resource,
                name: resource.name || resource.uri,
                description: resource.description || resource.name || resource.uri || '',
                serverName: connection.name || connection.connectionId,
                serverId: connection.connectionId
              };
              allResources.push(enhancedResource);
            }
          }
        } catch (error) {
        }
      }
      
      this.cachedAggregatedResources = allResources;
      this.lastAggregationTime = now;
      
      return allResources;
      
    } catch (error) {
      return [];
    }
  }

  /**
   * 获取MCP资源并转换为OpenAI格式的资源列表
   * @returns OpenAI格式的资源列表
   */
  async getOpenAIResources(): Promise<any[]> {
    const mcpStore = this.mcpStoreGetter?.();
    
    if (!mcpStore?.getMCPToolsEnabled()) {
      return [];
    }

    try {
      return await this.getAggregatedOpenAIResources();
    } catch (error) {
      throw new Error(`获取资源列表失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 获取所有已连接MCP服务器的提示词并聚合
   * @returns 聚合后的OpenAI格式提示词列表
   */
  async getAggregatedOpenAIPrompts(): Promise<any[]> {
    try {
      // 检查缓存
      const now = Date.now();
      if (now - this.lastAggregationTime < this.AGGREGATION_CACHE_MS && this.cachedAggregatedPrompts.length > 0) {
        return this.cachedAggregatedPrompts;
      }
      
      // 获取所有连接
      const connectionsResponse = await this.mcpClient.listConnections();
      if (!connectionsResponse.success || !connectionsResponse.connections) {
        return [];
      }

      // 筛选已连接服务器
      const connectedConnections = connectionsResponse.connections.filter(
        (conn: any) => conn.status === 'connected' || conn.connected === true
      );

      const allPrompts: any[] = [];

      // 聚合所有服务器提示词
      for (const connection of connectedConnections) {
        try {
          const promptsResponse = await this.mcpClient.listPrompts(connection.connectionId);
          
          if (promptsResponse.success && promptsResponse.prompts) {
            for (const prompt of promptsResponse.prompts) {
              const enhancedPrompt = {
                ...prompt,
                name: prompt.name,
                description: prompt.description || prompt.name || '',
                serverName: connection.name || connection.connectionId,
                serverId: connection.connectionId
              };
              
              allPrompts.push(enhancedPrompt);
            }
          }
        } catch (error) {
        }
      }
      
      this.cachedAggregatedPrompts = allPrompts;
      this.lastAggregationTime = now;
      
      return allPrompts;
      
    } catch (error) {
      return [];
    }
  }

  /**
   * 获取所有提示词（用于"/"命令功能）
   * @returns 所有提示词列表
   */
  async getAllPrompts(): Promise<any[]> {
    try {
      return await this.getAggregatedOpenAIPrompts();
    } catch (error) {
      throw new Error(`获取提示词列表失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 清理聚合提示词缓存
   * 用于在服务器连接状态变化时强制重新聚合提示词列表
   */
  clearAggregatedPromptsCache(): void {
    this.cachedAggregatedPrompts = [];
    this.lastAggregationTime = 0;
  }

  /**
   * 获取MCP提示词并转换为OpenAI格式的提示词列表
   * @returns OpenAI格式的提示词列表
   */
  async getOpenAIPrompts(): Promise<any[]> {
    const mcpStore = this.mcpStoreGetter?.();
    
    if (!mcpStore?.getMCPToolsEnabled()) {
      return [];
    }

    try {
      return await this.getAggregatedOpenAIPrompts();
    } catch (error) {
      throw new Error(`获取提示词列表失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 构建MCP上下文信息
   * @param resources 资源列表
   * @param prompts 提示词列表
   * @returns 格式化的上下文信息
   */
  buildMCPContextInfo(resources: any[], prompts: any[]): string | null {
    const contextParts = [];
    
    if (resources.length > 0) {
      contextParts.push(`可用资源 (${resources.length}个):`);
      resources.forEach((resource, index) => {
        contextParts.push(`  ${index + 1}. ${resource.name || resource.uri}: ${resource.description || '无描述'}`);
      });
    }
    
    if (prompts.length > 0) {
      contextParts.push(`可用提示词模板 (${prompts.length}个):`);
      prompts.forEach((prompt, index) => {
        contextParts.push(`  ${index + 1}. ${prompt.name}: ${prompt.description || '无描述'}`);
      });
    }
    
    return contextParts.length > 0 ? contextParts.join('\n') : null;
  }

  /**
   * 统一的MCP工具自动检测和处理方法
   * @param messages 消息列表
   * @param tools 可选的工具定义列表
   * @returns 处理后的消息和工具
   */
  async detectAndProcessMCPTools(
    messages: Message[],
    tools?: ToolDefinition[]
  ): Promise<{
    processedMessages: Message[],
    processedTools: ToolDefinition[]
  }> {
    let processedMessages = [...messages];
    let processedTools = tools;

    // 自动工具检测入口 - 开始检查是否需要自动获取MCP工具
    if (!tools || (Array.isArray(tools) && tools.length === 0)) {
      const mcpStoreGetter = this.getMCPStoreGetter();
      const mcpStore = mcpStoreGetter?.();
      
      if (mcpStore?.getMCPToolsEnabled()) {
        try {
          processedTools = await this.getOpenAITools();
          
          const resources = await this.getOpenAIResources();
          
          const prompts = await this.getOpenAIPrompts();
          
          // 将资源和提示词信息添加到系统消息中（仅在对话开始时）
          if (resources.length > 0 || prompts.length > 0) {
            const contextInfo = this.buildMCPContextInfo(resources, prompts);
            
            if (contextInfo) {
              const systemMessage: Message = {
                role: MessageRole.SYSTEM,
                content: contextInfo,
                timestamp: new Date()
              };
              
              const hasToolCalls = messages.some(msg => msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0);
              const hasToolResponses = messages.some(msg => msg.role === 'tool');
              
              if (hasToolCalls || hasToolResponses) {
              } else {
                processedMessages = [
                  ...messages.slice(0, -1),
                  systemMessage,
                  messages[messages.length - 1]
                ];
              }
            }
          }
        } catch (error) {
          processedTools = [];
        }
      }
    }
    
    return {
      processedMessages,
      processedTools: processedTools || []
    };
  }

  /**
   * 转换消息格式为OpenAI格式（包含工具调用支持）
   * @param messages 消息列表
   * @returns OpenAI格式的消息列表
   */
  convertMessagesToOpenAIFormatWithToolSupport(messages: Message[]): any[] {
    // 过滤掉空的assistant消息，但保留包含工具调用的消息
    const validMessages = messages.filter(msg => {
      // 保留所有非assistant角色的消息
      if (msg.role !== 'assistant') {
        return true;
      }
      // 对于assistant消息，必须有内容或包含工具调用
      const hasContent = msg.content && (
        (typeof msg.content === 'string' && msg.content.trim().length > 0) ||
        (Array.isArray(msg.content) && msg.content.length > 0)
      );
      const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
      
      if (hasContent || hasToolCalls) {
        return true;
      }
      
      return false;
    });

    const result = validMessages.map(msg => {
      // 处理多模态content（数组格式）
      let content: any = msg.content || '';
      if (Array.isArray(msg.content)) {
        // 多模态格式，保持数组
        content = msg.content;
      }
      
      const openaiMessage: any = {
        role: msg.role,
        content: content,
      };
      
      // 回传 reasoning_content 字段（DeepSeek 思考模式必需品）
      if (msg.reasoningContent != null) {
        openaiMessage.reasoning_content = msg.reasoningContent;
      }
      
      // 如果是工具调用消息
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        openaiMessage.tool_calls = msg.toolCalls;
      }
      
      // 如果是工具响应消息
      if (msg.toolCallId) {
        openaiMessage.tool_call_id = msg.toolCallId;
      }
      
      return openaiMessage;
    });
    
    return result;
  }

  /**
   * 处理流式响应中的工具调用
   * @param delta 流式响应增量数据
   * @param currentToolCalls 当前工具调用列表
   * @returns 更新后的工具调用列表
   */
  processStreamToolCalls(delta: any, currentToolCalls: any[]): any[] {
    const toolCalls = currentToolCalls;

    if (delta.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index;
        if (index !== undefined && index < toolCalls.length) {
          toolCalls[index] = {
            ...toolCalls[index],
            ...toolCall,
            function: {
              ...toolCalls[index].function,
              ...toolCall.function,
              arguments: (toolCalls[index].function?.arguments || '') + (toolCall.function?.arguments || '')
            }
          }
        } else {
          toolCalls.push({ ...toolCall });
        }
      }
    }

    return toolCalls;
  }

  /**
   * 执行工具调用（统一工具调用处理方法）
   * @param toolCall 工具调用对象
   * @param messages 消息列表
   * @returns 模型响应
   */
  async executeToolCall(
    toolCall: any,
    messages: Message[]
  ): Promise<import('../../types/models').ModelResponse> {
    try {
      const functionName = toolCall.function?.name;
      if (!functionName) {
        throw new Error('工具调用中缺少函数名称');
      }

      // 解析工具参数
      let functionArgs: Record<string, any> = {};
      if (toolCall.function?.arguments) {
        try {
          const argsString = typeof toolCall.function.arguments === 'string' 
            ? toolCall.function.arguments 
            : JSON.stringify(toolCall.function.arguments);
          functionArgs = JSON.parse(argsString);
        } catch (error) {
          functionArgs = {};
        }
      }

      // 获取MCP服务器名称
      let mcpServerName = undefined;
      try {
        const connectionsResponse = await this.mcpClient.listConnections();
        if (connectionsResponse.success && connectionsResponse.connections) {
          for (const connection of connectionsResponse.connections) {
            if (connection.status === 'connected' || connection.connected === true) {
              try {
                const toolsResponse = await this.mcpClient.listTools(connection.connectionId);
                if (toolsResponse.success && toolsResponse.tools) {
                  const toolNames = toolsResponse.tools.map((tool: any) => tool.name);
                  if (toolNames.includes(functionName)) {
                    // 去掉 mcp- 前缀用于显示
                    const rawServerName = connection.name || (connection as any).serverName || connection.connectionId;
                    mcpServerName = rawServerName.replace(/^mcp-/, '');
                    break;
                  }
                }
              } catch (error) {
              }
            }
          }
        }
      } catch (error) {
      }

      // 使用ToolsService调用实际工具
      const toolResult = await this.toolsService.callTool(functionName, functionArgs);

      // 构建包含工具调用结果的消息列表（供后续使用）
      void [
        ...messages,
        {
          role: MessageRole.ASSISTANT,
          content: '',
          toolCalls: [toolCall],
          timestamp: new Date(),
        },
        {
          role: MessageRole.TOOL,
          content: this.formatToolResult(toolResult),
          toolCallId: toolCall.id,
          timestamp: new Date(),
        }
      ];

      // 返回工具执行结果，包含MCP服务器名称
      const result = {
        content: this.formatToolResult(toolResult),
        toolCalls: [],
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        },
        mcpServerName: mcpServerName
      };
      
      return result as any;
    } catch (error) {
      // 构建错误消息列表（供后续使用）
      void [
        ...messages,
        {
          role: MessageRole.ASSISTANT,
          content: '',
          toolCalls: [toolCall],
          timestamp: new Date(),
        },
        {
          role: MessageRole.TOOL,
          content: `工具调用失败: ${error instanceof Error ? error.message : '未知错误'}`,
          toolCallId: toolCall.id,
          timestamp: new Date(),
        }
      ];

      // 返回错误响应
      return {
        content: `工具调用失败: ${error instanceof Error ? error.message : '未知错误'}`,
        toolCalls: [],
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        }
      };
    }
  }

  /**
   * 格式化工具执行结果为文本内容
   * @param toolResult 工具执行结果
   * @returns 格式化的文本内容
   */
  private formatToolResult(toolResult: any): string {
    try {
      // 如果结果是对象，转换为JSON字符串
      if (toolResult && typeof toolResult === 'object') {
        return JSON.stringify(toolResult, null, 2);
      }
      
      // 如果结果是字符串，直接返回
      if (typeof toolResult === 'string') {
        return toolResult;
      }
      
      // 其他类型转换为字符串
      return String(toolResult);
    } catch (error) {
      return String(toolResult);
    }
  }
}