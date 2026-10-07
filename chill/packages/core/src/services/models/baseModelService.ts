import { ModelType, MessageRole, ToolCallStatus, type Message, type ModelConfig, type ModelResponse, type StreamCallback, type ToolDefinition, type ModelService, type ContentPart } from '../../types/models';
import type { ModelAdapterConfig } from '../../types/models';
import { MCPService } from '../mcp/mcpService';
import { eventBus, EVENTS } from '../../utils/eventBus';
import { isBuiltInTool, ASYNC_BUILTIN_TOOLS } from '../builtInTools';
import { builtInToolExecutor } from '../builtInToolExecutor';
import { capToolResult } from '../toolResultGuard';
import type { ToolRegistry } from '../toolExecutorRegistry';
import type { ProtocolHandler } from './protocolHandler';
import { approxTokensForRound } from './approxTokens';
import { clampModelConfig } from './outputBudget';

/**
 * 基础模型服务抽象类
 * 提供通用的模型服务功能
 */
export class BaseModelService implements ModelService {
  /** 模型配置信息 */
  protected config: ModelConfig;
  /** 模型类型标识 */
  protected modelType: ModelType;
  /** MCP服务实例 */
  protected mcpService: MCPService;
  /** 模块标识：'chat' 或 'workflow' */
  protected module: 'chat' | 'workflow';
  /** 模型适配器配置（协议路由使用） */
  public adapterConfig?: ModelAdapterConfig;
  /** 模型窗口上限（工厂在创建与缓存命中时回填；callModelAPI 出口钳制的分母。窗口准入 SSOT=outputBudget.ts） */
  public maxContextTokens?: number;
  /** 协议处理器静态注册表 */
  static protocolHandlers: Record<string, ProtocolHandler> = {};
  /** TaskList Store获取器 */
  protected taskListStoreGetter?: () => { 
    hasTasks: () => boolean; 
    buildTaskStatusSummary: () => string; 
    buildCompletedTasksSummary: () => string 
  };
  /** 团队状态上下文获取器(团队状态注入;未装配=不注入——Worker/workflow 无人装配,prompt 零变化) */
  protected teamContextGetter?: () => string | null;

  constructor(config: ModelConfig, modelType: ModelType, mcpService: MCPService, module: 'chat' | 'workflow' = 'chat') {
    this.config = config;
    this.modelType = modelType;
    this.mcpService = mcpService;
    this.module = module;
  }

  /**
   * 设置适配器配置
   */
  setAdapterConfig(config: ModelAdapterConfig): void {
    this.adapterConfig = config;
  }

  /**
   * 注册协议处理器
   */
  static registerProtocolHandler(protocol: string, handler: ProtocolHandler): void {
    BaseModelService.protocolHandlers[protocol] = handler;
  }

  setTaskListStoreGetter(getter: () => { 
    hasTasks: () => boolean; 
    buildTaskStatusSummary: () => string; 
    buildCompletedTasksSummary: () => string 
  }): void {
    this.taskListStoreGetter = getter;
  }

  /** 装配团队状态上下文获取器(双壳各传一次;返回 null/空串 = 本轮不注入) */
  setTeamContextGetter(getter: () => string | null): void {
    this.teamContextGetter = getter;
  }

  /**
   * 发送消息（路由方法）
   * 根据 handler capabilities 路由到对应的子方法
   */
  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    registry?: ToolRegistry,
    streamCallback?: StreamCallback,
    abortController?: AbortController,
    maxIterations?: number
  ): Promise<ModelResponse> {
    const capabilities = this.getCapabilities()

    if (capabilities.asyncTask) {
      return this.sendAsyncMessage(messages, tools, streamCallback, abortController)
    }

    if (capabilities.chat && capabilities.toolCalling) {
      return this.sendChatMessage(messages, tools, registry, streamCallback, abortController, maxIterations)
    }

    return this.sendSingleMessage(messages, tools, streamCallback, abortController)
  }

  /**
   * 对话+工具循环模式
   * 支持多轮对话、工具调用和自动循环
   */
  async sendChatMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    registry?: ToolRegistry,
    streamCallback?: StreamCallback,
    abortController?: AbortController,
    maxIterations?: number,
    /** 2.4 事件归因（只增可选）：调用链上拿得到 sessionId 就穿，拿不到不传=载荷不带字段（兜底现状） */
    attribution?: { sessionId?: string }
  ): Promise<ModelResponse> {
    try {
      const conversationMessages = [...messages];
      // 工具循环产生的增量消息（assistant 工具调用消息 + TOOL 结果消息），随返回值带出供调用方并入历史
      const producedMessages: Message[] = [];
      let finalResponse: ModelResponse | null = null;
      const toolNameToServerMap: Map<string, string> = new Map();
      let iteration = 0;
      // 计量中间件:逐轮聚合累计消耗(与末轮 usage 量纲分离;任一轮估值则整体标 estimated)
      let cumPromptTokens = 0;
      let cumCompletionTokens = 0;
      let cumEstimated = false;
      
      do {
        iteration++;

        if (maxIterations && iteration > maxIterations) {
          throw new Error(`超出最大迭代次数限制: ${maxIterations}`);
        }

        const { processedMessages, processedTools } = await this.processMessageForRequest(
          conversationMessages, 
          tools, 
          streamCallback, 
          abortController
        );
        
        if (processedTools) {
          for (const tool of processedTools) {
            if ((tool as any).serverName) {
              toolNameToServerMap.set(tool.function.name, (tool as any).serverName);
            }
          }
        }

        const response = await this.callModelAPI(processedMessages, processedTools, streamCallback, abortController);

        // 逐轮聚合:有 usage 累加实测;缺失/全 0 按完整计费载荷字符估值(approxTokensForRound)并标 estimated
        if (response.usage && (response.usage.promptTokens > 0 || response.usage.completionTokens > 0 || response.usage.totalTokens > 0)) {
          cumPromptTokens += response.usage.promptTokens;
          cumCompletionTokens += response.usage.completionTokens;
        } else {
          const approx = approxTokensForRound(processedMessages, response);
          cumPromptTokens += approx.promptTokens;
          cumCompletionTokens += approx.completionTokens;
          cumEstimated = true;
        }
        
        if (response.toolCalls && response.toolCalls.length > 0) {
          // T6：编排工具 handoff 旧路径已随旧调度器删除退役，全部工具调用一律走普通执行路径。
          // assistant 工具调用消息入队（去重：同一批 toolCalls 已在最近一条实质 assistant 消息中则跳过）
          {
            let lastSubstantiveAssistant: Message | undefined
            for (let i = conversationMessages.length - 1; i >= 0; i--) {
              const m = conversationMessages[i]
              if (m.role === MessageRole.ASSISTANT && !(m as any).isSubResponse) {
                lastSubstantiveAssistant = m
                break
              }
            }

            const alreadyHasToolCalls = lastSubstantiveAssistant?.toolCalls
              && lastSubstantiveAssistant.toolCalls.length === response.toolCalls.length
              && lastSubstantiveAssistant.toolCalls.every((tc, idx) => tc.id === response.toolCalls![idx].id)

            if (!alreadyHasToolCalls) {
              const assistantMessageWithToolCalls: Message = {
                role: MessageRole.ASSISTANT,
                content: response.content || '',
                reasoningContent: response.reasoningContent || '',
                toolCalls: response.toolCalls,
                timestamp: new Date(),
              };
              conversationMessages.push(assistantMessageWithToolCalls);
              producedMessages.push(assistantMessageWithToolCalls);
            }
          }
          
          for (const toolCall of response.toolCalls) {
            const toolArgs = toolCall.function?.arguments;
            let toolParameters: Record<string, any> = {};
            
            try {
              toolParameters = toolArgs ? JSON.parse(toolArgs) : {};
            } catch (e) {
              console.warn('解析工具参数失败:', e);
            }
            
            const runningServerName = toolNameToServerMap.get(toolCall.function.name);

            // P1（状态发射权归真相源）：受理即 running——是否进入审批门由执行器（executePowerShellAsync 等）
            // 的真实判定决定并在进门时发射 pending，调用方不再预判（原 needPrePending 特判已删）。
            eventBus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, { ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
              module: this.module,
              toolCallStatus: ToolCallStatus.RUNNING,
              mcpServerName: runningServerName,
              toolParameters: toolParameters,
              toolResult: undefined,
              toolCallId: toolCall.id,
              toolCall: toolCall
            });
          }
          
          const toolCallResults: Array<{tool: Message}> = [];
          
          for (const toolCall of response.toolCalls) {
            const toolName = toolCall.function.name;

            try {
              let toolResult: any;
              
              if (registry) {
                const asyncTools = ASYNC_BUILTIN_TOOLS
                if (asyncTools.includes(toolName)) {
                  const result = await builtInToolExecutor.executeAsync(
                    toolName, 
                    toolCall.function.arguments || '{}',
                    toolCall.id
                  );
                  if (result.success) {
                    // 携带媒体块的工具结果（如 capture_screen 截图）需透传 mediaParts；缺省时行为逐字节不变
                    toolResult = result.mediaParts ? { data: result.data, mediaParts: result.mediaParts } : result.data;
                  } else {
                    throw new Error(result.error || `${toolName} 执行失败`);
                  }
                } else {
                  const args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
                  const result = await registry.execute(toolName, args);
                  if (result.success) {
                    toolResult = result.data;
                  } else {
                    throw new Error(result.error || 'Tool execution failed');
                  }
                }
              } else {
                const isBuiltin = isBuiltInTool(toolName);
                
                if (isBuiltin) {
                  const asyncTools = ASYNC_BUILTIN_TOOLS
                  if (asyncTools.includes(toolName)) {
                    const result = await builtInToolExecutor.executeAsync(
                      toolName,
                      toolCall.function.arguments || '{}',
                      toolCall.id
                    );
                    if (result.success) {
                      // 携带媒体块的工具结果（如 capture_screen 截图）需透传 mediaParts；缺省时行为逐字节不变
                      toolResult = result.mediaParts ? { data: result.data, mediaParts: result.mediaParts } : result.data;
                    } else {
                      throw new Error(result.error || `${toolName} 执行失败`);
                    }
                  } else {
                    const result = builtInToolExecutor.execute(toolName, toolCall.function.arguments || '{}');
                    if (result.success) {
                      toolResult = result.data;
                    } else {
                      throw new Error(result.error || 'Built-in tool execution failed');
                    }
                  }
                } else {
                  toolResult = await this.mcpService.executeToolCall(toolCall, conversationMessages);
                }
              }
              
              const toolArgs = toolCall.function?.arguments;
              let toolParameters: Record<string, any> = {};
              
              try {
                toolParameters = toolArgs ? JSON.parse(toolArgs) : {};
              } catch (e) {
                console.warn('解析工具参数失败:', e);
              }
              
              let mcpServerName = undefined;
              if (typeof toolResult === 'object' && toolResult !== null && 'mcpServerName' in toolResult) {
                mcpServerName = (toolResult as any).mcpServerName;
              }
              
              // 携带媒体块的工具结果（capture_screen 截图）：mediaParts 提取后事件载荷只带文本摘要
              //（避免 MB 级 base64 在事件总线/IPC 里流动），TOOL 消息 content 构造为 ContentPart[]
              const toolMediaParts: ContentPart[] | undefined =
                (typeof toolResult === 'object' && toolResult !== null && Array.isArray(toolResult.mediaParts))
                  ? toolResult.mediaParts
                  : undefined;

              eventBus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, { ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
                module: this.module,
                toolCallStatus: ToolCallStatus.SUCCESS,
                mcpServerName: mcpServerName,
                toolParameters: toolParameters,
                toolResult: toolMediaParts
                  ? (typeof toolResult.data === 'object' && toolResult.data !== null ? toolResult.data : { content: String(toolResult.data) })
                  : (typeof toolResult === 'object' ? toolResult : { content: String(toolResult) }),
                toolCallId: toolCall.id,
                toolCall: toolCall
              });
              
              // 事件载荷用完整对象（壳侧显示不受闸门影响）；入史对象套大小闸门
              // （capToolResult 纯函数，小结果引用直通零开销；mediaParts 数组分支不 cap）
              const rawToolMessage: Message = {
                role: MessageRole.TOOL,
                content: toolMediaParts
                  ? [
                      { type: 'text', text: typeof toolResult.data === 'string' ? toolResult.data : JSON.stringify(toolResult.data) } as ContentPart,
                      ...toolMediaParts,
                    ]
                  : (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)),
                toolCallId: toolCall.id,
                toolCallStatus: ToolCallStatus.SUCCESS,
                timestamp: new Date(),
              };
              const toolMessage: Message = {
                ...rawToolMessage,
                content: typeof rawToolMessage.content === 'string' ? capToolResult(rawToolMessage.content) : rawToolMessage.content
              };

              toolCallResults.push({tool: toolMessage});
              
              eventBus.emit(EVENTS.TOOL_MESSAGE_CREATED, { ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
                module: this.module,
                message: rawToolMessage
              });
            } catch (toolError) {
              console.error('❌ BaseModelService: 工具调用失败:', toolError);
              
              const toolArgs = toolCall.function?.arguments;
              let toolParameters: Record<string, any> = {};
              
              try {
                toolParameters = toolArgs ? JSON.parse(toolArgs) : {};
              } catch (e) {
                console.warn('解析工具参数失败:', e);
              }
              
              eventBus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, { ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
                module: this.module,
                toolCallStatus: ToolCallStatus.FAILED,
                mcpServerName: undefined,
                toolParameters: toolParameters,
                toolResult: toolError instanceof Error ? toolError.message : '未知错误',
                toolCallId: toolCall.id,
                toolCall: toolCall
              });
              
              const errorMessage = toolError instanceof Error ? toolError.message : '未知错误';
              const toolMessage: Message = {
                role: MessageRole.TOOL,
                content: capToolResult(`工具调用失败: ${errorMessage}`),
                toolCallId: toolCall.id,
                toolCallStatus: ToolCallStatus.FAILED,
                timestamp: new Date(),
              };
              
              toolCallResults.push({tool: toolMessage});
              
              eventBus.emit(EVENTS.TOOL_MESSAGE_CREATED, { ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
                module: this.module,
                message: toolMessage
              });
            }
          }

          // 批量冲刷:autoApply 或非交互 auto 档(chill -p --auto)下,insert/replace/delete_content 的批量操作在此落盘
          if (builtInToolExecutor.getAutoApply() || builtInToolExecutor.getNonInteractiveMode() === 'auto') {
            const batchResults = await builtInToolExecutor.applyAutoApplyBatch()
            for (const result of toolCallResults) {
              if (!result.tool.toolCallId) continue
              const batchResult = batchResults.get(result.tool.toolCallId)
              if (batchResult) {
                if (batchResult.success && batchResult.data) {
                  result.tool.content = batchResult.data.content
                } else {
                  result.tool.content = `操作失败: ${batchResult.error || '未知错误'}`
                }
              }
            }
          }
          
          if (toolCallResults.length > 0) {
            for (const result of toolCallResults) {
              conversationMessages.push(result.tool);
              producedMessages.push(result.tool);
            }
            
            const newAssistantMessage: Message = {
              role: MessageRole.ASSISTANT,
              content: '',
              timestamp: new Date(),
              isSubResponse: true,
            };
            eventBus.emit(EVENTS.ASSISTANT_MESSAGE_CREATED, { ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
              module: this.module,
              message: newAssistantMessage
            });
          } else {
            finalResponse = {
              content: `工具调用失败: 所有工具调用均未成功执行`,
              toolCalls: [],
              usage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0
              }
            };
          }
        } else {
          finalResponse = response;
          break;
        }
      } while (!abortController?.signal.aborted);
      
      if (!finalResponse) {
        throw new Error('未能获取到最终响应，可能请求被中断');
      }

      finalResponse.iterations = iteration;
      finalResponse.producedMessages = producedMessages;
      finalResponse.cumulativeUsage = {
        promptTokens: cumPromptTokens,
        completionTokens: cumCompletionTokens,
        totalTokens: cumPromptTokens + cumCompletionTokens,
        ...(cumEstimated ? { estimated: true } : {}),
      };

      return finalResponse;
    } catch (error: any) {
      if (error?.message !== 'Request aborted' && error?.name !== 'AbortError') {
        console.error(`Error in ${this.modelType} model service:`, error);
      }
      throw error;
    }
  }

  /**
   * 单次调用模式
   * 无对话历史、无工具循环，一次 API 调用直接返回
   */
  async sendSingleMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    streamCallback?: StreamCallback,
    abortController?: AbortController
  ): Promise<ModelResponse> {
    const { processedMessages, processedTools } = await this.processMessageForRequest(
      messages, tools, streamCallback, abortController
    );
    const response = await this.callModelAPI(processedMessages, processedTools, streamCallback, abortController);
    // 单轮 = 本轮:有 usage 用实测,缺失/全 0 估值并标 estimated(与 sendChatMessage 聚合同口径)
    if (response.usage && (response.usage.promptTokens > 0 || response.usage.completionTokens > 0 || response.usage.totalTokens > 0)) {
      response.cumulativeUsage = {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.promptTokens + response.usage.completionTokens,
      };
    } else {
      response.cumulativeUsage = { ...approxTokensForRound(processedMessages, response), estimated: true };
    }
    return response;
  }

  /**
   * 异步任务模式
   * submit → poll 异步流程，轮询期间通过 streamCallback 报告进度
   */
  async sendAsyncMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    streamCallback?: StreamCallback,
    abortController?: AbortController
  ): Promise<ModelResponse> {
    const protocol = this.adapterConfig?.protocol ?? 'openai-chat';
    const handler = BaseModelService.protocolHandlers[protocol];
    if (!handler || !handler.submitTask || !handler.pollTask) {
      throw new Error(`Protocol ${protocol} does not support async tasks`);
    }

    const { processedMessages, processedTools } = await this.processMessageForRequest(
      messages, tools, streamCallback, abortController
    );

    const context = {
      mcpService: this.mcpService,
      config: this.config,
      adapterConfig: this.adapterConfig || { protocol: 'openai-chat', baseURL: '', defaultModel: '', defaultMaxTokens: 4000, defaultTemperature: 0.7 }
    };

    const { taskId } = await handler.submitTask(
      processedMessages, processedTools || [], this.config, context, streamCallback, abortController
    );

    // 轮询直到完成
    while (!abortController?.signal.aborted) {
      const pollResult = await handler.pollTask(taskId, context, streamCallback, abortController);

      if (streamCallback) {
        streamCallback({
          isStreamComplete: pollResult.status === 'completed' || pollResult.status === 'failed',
          output: pollResult.result?.output,
          content: pollResult.result?.content,
        });
      }

      if (pollResult.status === 'completed') {
        return pollResult.result || { content: '' };
      }
      if (pollResult.status === 'failed') {
        return pollResult.result || { content: '异步任务执行失败' };
      }

      // pending: 等待后重试
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return { content: '任务被中断' };
  }

  /**
   * 获取当前协议的 capabilities
   */
  protected getCapabilities(): ProtocolHandler['capabilities'] {
    const protocol = this.adapterConfig?.protocol ?? 'openai-chat';
    const handler = BaseModelService.protocolHandlers[protocol];
    if (!handler) {
      // 回退默认值
      return { chat: true, toolCalling: true, streaming: true, outputModalities: ['text'] };
    }
    return handler.capabilities;
  }

  /**
   * 处理消息，注入任务上下文并检测MCP工具
   * 消息转换交由各 handler 自行处理
   * @param messages 消息列表
   * @param tools 可选的工具定义列表
   * @returns 处理后的消息和工具
   */
  protected async processMessageForRequest(
    messages: Message[],
    tools?: ToolDefinition[],
    _streamCallback?: StreamCallback,
    _abortController?: AbortController
  ): Promise<{processedMessages: Message[], processedTools: ToolDefinition[] | undefined}> {
    try {
      let processedMessages = [...messages];
      let processedTools = tools;

      // 使用MCPService进行统一的MCP工具自动检测和处理
      const mcpResult = await this.mcpService.detectAndProcessMCPTools(messages, tools);
      processedMessages = mcpResult.processedMessages;
      processedTools = mcpResult.processedTools;
      
      // 团队状态注入(每轮现取,永远新鲜;getter 未装配=不注入)
      const teamLine = this.teamContextGetter?.() || null

      // 头部 SYSTEM 上下文(任务状态 + 团队行;最多一条消息,不新增条数)
      let headerParts: string[] | null = null

      // 注入任务上下文（如果有任务）
      if (this.taskListStoreGetter) {
        const taskListStore = this.taskListStoreGetter();
        if (taskListStore.hasTasks()) {
          const statusSummary = taskListStore.buildTaskStatusSummary();
          const completedSummary = taskListStore.buildCompletedTasksSummary();
          
          const contextParts: string[] = ['你正在执行一个多步骤任务，以下是当前任务状态：'];
          if (statusSummary) {
            contextParts.push(statusSummary);
          }
          if (completedSummary) {
            contextParts.push(completedSummary);
          }
          contextParts.push('你可以使用 update_task_status 更新任务状态、修改任务名称，使用 delete_task 删除不需要的任务，使用 add_task 添加新任务。');
          contextParts.push('可以多次调用这些工具批量操作多个任务。');
          contextParts.push('【重要】如果在执行任务过程中，你发现信息不足、需要用户确认或有多个选择需要用户决策时，请暂停执行并直接向用户提问。不要猜测用户意图，等待用户提供必要信息后再继续执行任务。');
          contextParts.push('请根据任务状态继续执行下一步操作。');
          headerParts = contextParts;
        }
      }

      // 团队行:有任务上下文时作为追加段落,无任务时单独构成该消息(均不新增消息条数)
      if (teamLine) {
        if (headerParts) headerParts.push(teamLine)
        else headerParts = [teamLine]
      }

      if (headerParts) {
        const headerMessage: Message = {
          role: MessageRole.SYSTEM,
          content: headerParts.join('\n\n'),
          timestamp: new Date()
        };
        // 在消息列表开头插入头部上下文
        processedMessages = [headerMessage, ...processedMessages];
      }
      
      // 消息转换交由各 handler 自行处理（通过 context.mcpService.convertMessagesToOpenAIFormatWithToolSupport）

      return { processedMessages, processedTools };
    } catch (error) {
      console.error(`Error in ${this.modelType} model service processing:`, error);
      throw error;
    }
  }

  /**
   * 调用模型API（协议路由）
   * 根据 adapterConfig.protocol 查找对应的 ProtocolHandler 并执行
   * 子类可 override 此方法实现自定义逻辑
   */
  protected async callModelAPI(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    streamCallback?: StreamCallback,
    abortController?: AbortController
  ): Promise<ModelResponse> {
    const protocol = this.adapterConfig?.protocol ?? 'openai-chat';
    const handler = BaseModelService.protocolHandlers[protocol];
    if (!handler) {
      throw new Error(`No protocol handler registered for protocol: ${protocol}`);
    }
    // 窗口准入钳制（outputBudget SSOT）：prompt估算+申报预算>窗口时收窄 max_tokens，请求恒合法。
    // 未触发时返回原 config 对象（引用恒等 → 线缆字节不变）；估算含头部 SYSTEM 与全部载荷。
    const effectiveConfig = clampModelConfig(this.config, this.maxContextTokens, messages, tools || []);
    return handler.call(
      messages,
      tools || [],
      effectiveConfig,
      { mcpService: this.mcpService, config: effectiveConfig, adapterConfig: this.adapterConfig || { protocol: 'openai-chat', baseURL: '', defaultModel: '', defaultMaxTokens: 4000, defaultTemperature: 0.7 } },
      streamCallback,
      abortController
    );
  }

  /**
   * 获取模型类型
   */
  getModelType(): ModelType {
    return this.modelType;
  }

  /**
   * 获取模型配置
   */
  getConfig(): ModelConfig {
    return { ...this.config };
  }
}