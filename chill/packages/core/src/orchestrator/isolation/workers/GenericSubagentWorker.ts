/**
 * GenericSubagentWorker - 通用Subagent Worker
 * 在独立子进程中运行，负责执行Subagent任务
 * 步骤7：实现模型服务初始化
 * 
 * 注意：此文件在 Worker 子进程中运行，不能包含 Node.js 内置模块的 import
 * 所有 Node.js 内置模块应使用 require 动态导入
 */

import type { SubagentRequest, SubagentResponse, WorkerConfig, IPCMessage } from '../types'
import { IPCMessageType } from '../types'
import type { ModelService } from '../../../types/models'
import { ModelType } from '../../../types/models'
import { openAIChatHandler } from '../../../services/models/handlers/openAIChatHandler'
import { anthropicChatHandler } from '../../../services/models/handlers/anthropicChatHandler'
import { registerAsyncTaskFamilies } from '../../../services/models/handlers/asyncTask/asyncTaskHandler'
import { getWorkerBuiltInExecutorProxy } from './WorkerBuiltInExecutorProxy'
import { appendLengthCapWarning } from './lengthCapWarning'
import { buildTokenUsage } from './workerTokenUsage'
import { buildSeedMessages, buildConversation } from './conversationTranscript'

// --------------------------
// Worker 状态
// --------------------------
interface WorkerState {
  /** 是否已初始化 */
  initialized: boolean
  /** Subagent 类型 */
  subagentType: string
  /** 环境ID */
  envId: string
  /** Subagent 配置 */
  config: WorkerConfig['subagentConfig']
  /** 模型服务实例 - 步骤7添加 */
  modelService: ModelService | null
}

const state: WorkerState = {
  initialized: false,
  subagentType: '',
  envId: '',
  config: {},
  modelService: null,
}

// --------------------------
// 从环境变量读取配置
// --------------------------
function loadConfigFromEnv(): WorkerConfig | null {
  try {
    const configJson = process.env.WORKER_CONFIG
    if (!configJson) {
      console.error('[Worker] 错误: WORKER_CONFIG 环境变量未设置')
      return null
    }
    return JSON.parse(configJson) as WorkerConfig
  } catch (error) {
    console.error('[Worker] 错误: 解析 WORKER_CONFIG 失败:', error)
    return null
  }
}

// --------------------------
// 初始化 Worker
// --------------------------
function initialize(): boolean {
  if (state.initialized) {
    return true
  }

  const config = loadConfigFromEnv()
  if (!config) {
    return false
  }

  state.subagentType = config.subagentType
  state.envId = config.envId
  state.config = config.subagentConfig
  state.initialized = true

  console.log(`[Worker] 基础初始化完成:`, {
    subagentType: state.subagentType,
    envId: state.envId,
    // apiKey 脱敏：密钥不明文落日志（日志可能随测试记录外发）
    config: state.config ? { ...state.config, apiKey: state.config.apiKey ? '***' : undefined } : state.config,
  })

  return true
}

// --------------------------
// 步骤7：初始化模型服务
// --------------------------
async function initializeModelService(request: SubagentRequest): Promise<boolean> {
  try {
    // 步骤7-1：从请求中读取配置
    const modelName = request.subagentConfig.model
    const temperature = request.subagentConfig.temperature
    const maxTokens = request.subagentConfig.maxTokens
    const apiKey = request.subagentConfig.apiKey
    const baseURL = request.subagentConfig.baseURL

    console.log(`[Worker] 步骤7：初始化模型服务:`, {
      model: modelName,
      temperature,
      maxTokens,
      hasApiKey: !!apiKey,
      baseURL,
    })

    // 步骤7-2：从 subagentConfig 读取注入的 modelType 和 adapterConfig
    const modelType = (request.subagentConfig.modelType as ModelType) || ModelType.GLM
    const injectedAdapterConfig = request.subagentConfig.adapterConfig

    // 步骤7-3：动态导入 BaseModelService 并注册协议处理器 + builtInToolExecutor stub
    const [{ BaseModelService }, { modelInfoService }, { setBuiltInToolExecutor }] = await Promise.all([
      import('../../../services/models/baseModelService'),
      import('../../../services/models/modelInfoService'),
      import('../../../services/builtInToolExecutor'),
    ])

    BaseModelService.registerProtocolHandler('openai-chat', openAIChatHandler)
    registerAsyncTaskFamilies((p, h) => BaseModelService.registerProtocolHandler(p, h))
    BaseModelService.registerProtocolHandler('anthropic-messages', anthropicChatHandler)
    // 注入 IPC 代理执行器：Worker 内内置工具调用全部转发宿主真实实例执行
    // （继承宿主确认流/autoApply/规划门语义；授权名单在 handleRequest 内随请求刷新）
    setBuiltInToolExecutor(getWorkerBuiltInExecutorProxy() as any)

    // 步骤7-4：创建模型配置
    if (!baseURL) {
      throw new Error(`No baseURL provided for Worker model: ${modelName}. adapterConfig.baseURL must be injected via subagentConfig.`)
    }
    // 思考控制三键（宿主按用户参数注入；映射 snake → ModelConfig 驼峰，未注入不写键）
    const savedThinking = request.subagentConfig as { thinking?: boolean; reasoning_effort?: string; enable_thinking?: boolean }
    const modelConfig = {
      // 请求字段只装上游事实（V6）：apiModelId 优先，旧注入回退 defaultModel，绝不回退本地注册名
      model: request.subagentConfig.apiModelId || injectedAdapterConfig?.defaultModel || '',
      apiKey: apiKey || '',
      baseURL,
      temperature: temperature ?? 0.6,
      maxTokens: maxTokens ?? 4000,
      ...(savedThinking.thinking !== undefined && { thinking: savedThinking.thinking }),
      ...(savedThinking.reasoning_effort !== undefined && { reasoningEffort: savedThinking.reasoning_effort }),
      ...(savedThinking.enable_thinking !== undefined && { enableThinking: savedThinking.enable_thinking }),
    }

    // 步骤7-5：创建 MCPService 实例
    const { MCPService } = await import('../../../services/mcp/mcpService')
    const mcpService = new MCPService()

    // 步骤7-6：创建 BaseModelService 并通过 adapterConfig 路由
    const adapterConfig = injectedAdapterConfig ?? modelInfoService.getModelInfoByName(modelName ?? '')?.adapterConfig
    state.modelService = new BaseModelService(modelConfig, modelType, mcpService, 'chat') as unknown as ModelService
    if (adapterConfig) {
      (state.modelService as any).setAdapterConfig(adapterConfig)
    }

    console.log(`[Worker] 步骤7：模型服务初始化完成:`, {
      modelType,
      modelName,
    })

    return true
  } catch (error) {
    console.error(`[Worker] 步骤7：模型服务初始化失败:`, error)
    return false
  }
}

// --------------------------
// 步骤8：构建消息数组
// --------------------------
function buildMessages(request: SubagentRequest): any[] {
  // resume 种子续聊：以原对话 transcript（已含 system）为起点，仅追加新追问——
  // 不重复加 system、不渲染 userPromptTemplate（纯逻辑见 conversationTranscript.ts）
  if (request.priorMessages && request.priorMessages.length > 0) {
    return buildSeedMessages(request.priorMessages, request.userMessage)
  }

  const messages: any[] = []

  // 添加系统提示词（如果存在）
  if (request.systemPrompt) {
    messages.push({
      role: 'system',
      content: request.systemPrompt,
      timestamp: new Date(),
    })
  }

  // 构建用户提示词
  let userContent = request.userMessage

  // 如果配置了用户提示词模板，则使用模板渲染
  if (request.subagentConfig.userPromptTemplate) {
    userContent = request.subagentConfig.userPromptTemplate.replace(
      /\{\{task\}\}/g,
      request.userMessage
    )
  }

  messages.push({
    role: 'user',
    content: userContent,
    timestamp: new Date(),
  })

  return messages
}

// --------------------------
// 步骤8：创建 Subagent 专属的 ToolRegistry
// --------------------------
async function createSubagentToolRegistry(
  toolDefinitions: any[] | undefined,
  authorizedTools: string[] | undefined,
  teamMember?: boolean
): Promise<{ registry: any | undefined; filteredToolDefinitions: any[]; mismatchError?: string }> {
  const [{ ToolRegistry }, { WorkerMCPool, WorkerBuiltInTool }, { isBuiltInTool }] = await Promise.all([
    import('../../../services/toolExecutorRegistry'),
    import('./WorkerToolExecutors'),
    import('../../../services/builtInTools')
  ])

  const registry = new ToolRegistry()
  const filteredToolDefinitions: any[] = []

  // escalate_to_lead 固定注册(Worker 上报 Lead 的通道;不占 authorizedTools 名额,
  // 零工具 Worker 也可用——执行器与定义同步注入:只注册执行器不注入定义,模型根本看不见这个工具)
  const { escalateToolDefinition, ESCALATE_TOOL_NAME } = await import('../../../services/delegation/escalateTool')
  registry.register(new WorkerBuiltInTool(ESCALATE_TOOL_NAME))
  filteredToolDefinitions.push(escalateToolDefinition)

  // board 固定注册(会话共享看板工位契约;escalate 同款:不占 authorizedTools 名额,零工具 Worker 也可用,
  // 网关白名单豁免。动作收窄在执行层——Lead 专属动作 Worker 一律拒,见 boardTool 授权矩阵)
  const { boardToolDefinition, BOARD_TOOL_NAME } = await import('../../../services/board/boardTool')
  registry.register(new WorkerBuiltInTool(BOARD_TOOL_NAME))
  filteredToolDefinitions.push(boardToolDefinition)

  // 团队成员固定注入 team_board/team_status/send_message/team_policy(共享看板+平级消息+快照只读;与 escalate 同款:
  // 执行器+定义同步注入,不占 authorizedTools 名额。此标记只管可见性——成员资格的安全判定在宿主网关;
  // team_policy 的 update 权限在执行层按 __origin 判定,成员只读)
  if (teamMember) {
    const { teamBoardToolDefinition, teamStatusToolDefinition } = await import('../../../services/team/teamBoardTool')
    const { sendMessageToolDefinition } = await import('../../../services/team/teamMessageTool')
    const { teamPolicyToolDefinition } = await import('../../../services/team/teamPolicyTool')
    for (const def of [teamBoardToolDefinition, teamStatusToolDefinition, sendMessageToolDefinition, teamPolicyToolDefinition]) {
      registry.register(new WorkerBuiltInTool(def.function.name))
      filteredToolDefinitions.push(def)
    }
  }

  if (!toolDefinitions || toolDefinitions.length === 0) {
    return { registry, filteredToolDefinitions }
  }

  // 授权注册数(mismatch 校验只算授权工具,不含 escalate 固定注册)
  let authorizedCount = 0
  // 只注册被授权的工具
  for (const toolDef of toolDefinitions) {
    const toolName = toolDef.function?.name
    if (!toolName) {
      continue
    }

    // 二次校验：确保工具在授权列表中(已定义即复核——空名单 = 零工具,不再是"未指定=全量")
    if (authorizedTools !== undefined && !authorizedTools.includes(toolName)) {
      continue
    }

    // 将授权的工具定义添加到过滤后的列表
    filteredToolDefinitions.push(toolDef)
    authorizedCount += 1

    // 根据工具类型创建对应的执行器
    // 在 Worker 中使用专用的工具执行器
    if (isBuiltInTool(toolName)) {
      registry.register(new WorkerBuiltInTool(toolName))
    } else {
      registry.register(new WorkerMCPool(toolName))
    }
  }

  // 授权名单与工具定义全不匹配：不静默放大权限，返回明确错误让主模型修正分配
  // (typo 主校验在上游 executor;此处为双保险——授权名单已定义即复核,空名单=零工具)
  if (authorizedCount === 0) {
    const mismatchError =
      `授权工具与可用工具定义全不匹配：授权名单 ${JSON.stringify(authorizedTools)}；` +
      `可用工具 ${toolDefinitions.map(t => t.function?.name).join(', ')}。` +
      `请修正 available_tools(名称须精确照抄委派指南的可用工具清单;["none"] = 显式零工具;不指定 = 跟随模板默认)。`
    console.error(`[Worker] ${mismatchError}`)
    return { registry: undefined, filteredToolDefinitions: [], mismatchError }
  }

  console.log(`[Worker] 工具过滤完成: 原始 ${toolDefinitions.length} 个 → 授权 ${authorizedCount} 个(+escalate 固定注册)`)

  // 定义去重(固定注入与授权名单重复声明时,防模型端 400 Tool names must be unique;
  // 注册表侧 Map.set 天然覆盖,无需处理)
  const { dedupeToolDefsByName } = await import('./toolDefDedupe')
  return { registry, filteredToolDefinitions: dedupeToolDefsByName(filteredToolDefinitions) }
}

// --------------------------
// 处理请求
// 步骤8：实现工具执行和结果返回
// --------------------------
async function handleRequest(request: SubagentRequest): Promise<SubagentResponse> {
  console.log(`[Worker] 处理请求:`, {
    taskId: request.taskId,
    subagentType: request.subagentType,
  })

  // 每个请求刷新代理的授权名单（宿主网关复核依据；兼容环境复用场景）
  getWorkerBuiltInExecutorProxy().setAuthorizedTools(request.authorizedTools)

  // 步骤7：初始化模型服务（如果尚未初始化）
  if (!state.modelService) {
    const initialized = await initializeModelService(request)
    if (!initialized) {
      return {
        success: false,
        error: '模型服务初始化失败',
      }
    }
  }

  try {
    // 步骤8-1：构建消息数组
    const messages = buildMessages(request)
    console.log(`[Worker] 步骤8：构建消息数组，共 ${messages.length} 条消息`)

    // 步骤8-2：创建 ToolRegistry 并获取过滤后的工具定义
    const { registry, filteredToolDefinitions, mismatchError } = await createSubagentToolRegistry(
      request.toolDefinitions,
      request.authorizedTools,
      request.teamMember
    )
    // 授权名单与工具定义全不匹配：返回明确错误（不静默放大权限），主模型可见并修正分配
    if (mismatchError) {
      return {
        success: false,
        error: mismatchError,
      }
    }
    console.log(`[Worker] 步骤8：创建 ToolRegistry，注册工具数:`, registry ? '有' : '无')

    // 步骤8-3：执行模型调用
    // 关键修复：使用过滤后的工具定义，而不是所有工具
    // 这样模型只能看到被授权的工具
    console.log(`[Worker] 步骤8：调用模型服务 sendMessage`)
    const response = await state.modelService!.sendMessage(
      messages,
      filteredToolDefinitions,  // ← 使用过滤后的工具定义
      registry,
      undefined, // streamCallback
      undefined  // abortController
    )

    console.log(`[Worker] 步骤8：模型调用完成`, {
      content: response.content,
      contentLength: response.content?.length,
      hasToolCalls: !!response.toolCalls && response.toolCalls.length > 0,
      toolCallCount: response.toolCalls?.length || 0,
      toolCalls: response.toolCalls,
      iterations: response.iterations,
      usage: response.usage,
      fullResponse: JSON.stringify(response, null, 2),
    })

    // 步骤8-4：封装并返回结果
    // 空输出截断检测：content 为空且 completionTokens 顶到 maxTokens 上限——
    // 典型成因是 thinking 模型的推理 token 耗尽配额；按失败返回明确原因（不误报成功）
    const maxTokens = request.subagentConfig.maxTokens ?? 4000
    const completionTokens = response.usage?.completionTokens ?? 0
    if (!response.content && completionTokens >= maxTokens) {
      return {
        success: false,
        error:
          `Subagent 输出为空：模型输出配额（maxTokens=${maxTokens}）已被耗尽（completionTokens=${completionTokens}）。` +
          `thinking 模型的推理 token 与正文共享配额。请增大 maxTokens（task 的 override_parameters.max_tokens）或简化任务后重试。`,
      }
    }

    // 非空但顶到配额：报告被 length cap 剪断——不判失败（部分内容仍有用），
    // 但必须让调用方知道（静默截断 = 结果保真链断裂），由调用方决定是否调大配额重派
    if (response.content) {
      response.content = appendLengthCapWarning(response.content, completionTokens, maxTokens)
    }

    // 完整对话 transcript（resume_task 的种子）：请求消息（含 system）+ 工具循环增量
    // + 最终 assistant 消息（producedMessages 不含末轮，由本响应补上）
    const conversation = buildConversation(messages, response)

    // 注意:tokenUsage 走 buildTokenUsage(累计量纲 cumulativeUsage 优先,缺失回退末轮 usage,estimated 透传);
    // 空输出截断检测在上文,继续用末轮 usage 的 completionTokens,不吃累计量纲
    return {
      success: true,
      output: response.content,
      conversation,
      iterations: response.iterations || 1,
      tokenUsage: buildTokenUsage(response),
    }
  } catch (error) {
    console.error(`[Worker] 步骤8：模型调用失败:`, error)

    // 检查是否是迭代次数超限错误
    if (error instanceof Error && error.message.includes('超出最大迭代次数')) {
      return {
        success: false,
        error: `执行轮次超过限制 (${request.subagentConfig.maxIterations || '未设置'})，任务被终止以防止无限循环`,
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : '模型调用失败',
    }
  }
}

// --------------------------
// 发送响应到主进程
// --------------------------
function sendResponse(messageId: string, response: SubagentResponse): void {
  const message: IPCMessage = {
    type: IPCMessageType.RESPONSE,
    id: messageId,
    payload: response,
  }

  if (process.send) {
    process.send(message)
  } else {
    console.error('[Worker] 错误: process.send 不可用')
  }
}

// --------------------------
// 发送错误到主进程
// --------------------------
function sendError(messageId: string, error: string): void {
  const message: IPCMessage = {
    type: IPCMessageType.ERROR,
    id: messageId,
    payload: { error },
  }

  if (process.send) {
    process.send(message)
  } else {
    console.error('[Worker] 错误: process.send 不可用')
  }
}

// --------------------------
// 监听主进程消息
// --------------------------
function setupMessageHandlers(): void {
  
  process.on('message', async (message: IPCMessage) => {
    console.log(`[Worker] 收到消息:`, message.type, message.id)

    switch (message.type) {
      case IPCMessageType.REQUEST:
        try {
          if (!state.initialized) {
            if (!initialize()) {
              sendError(message.id, 'Worker 初始化失败')
              return
            }
          }

          const request = message.payload as SubagentRequest

          const response = await handleRequest(request)
          sendResponse(message.id, response)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : '未知错误'
          console.error('[Worker] 处理请求失败:', errorMessage)
          sendError(message.id, errorMessage)
        }
        break

      case IPCMessageType.TOOL_RESULT:
        // 步骤8将实现工具调用结果处理
        console.log('[Worker] 收到工具调用结果:', message.payload)
        break

      case IPCMessageType.TOOL_CALL_RESPONSE:
        break

      default:
        console.warn(`[Worker] 未知消息类型: ${message.type}`)
    }
  })

  // 处理进程错误
  process.on('uncaughtException', (error) => {
    console.error('[Worker] 未捕获的异常:', error)
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[Worker] 未处理的Promise拒绝:', reason)
    process.exit(1)
  })

  // 处理进程退出
  process.on('exit', (code) => {
    console.log(`[Worker] 进程退出，代码: ${code}`)
  })

  // 处理SIGTERM信号
  process.on('SIGTERM', () => {
    console.log('[Worker] 收到SIGTERM信号，准备退出')
    process.exit(0)
  })
}

// --------------------------
// Worker入口
// --------------------------
function main(): void {
  console.log('[Worker] Worker进程启动')

  // 初始化
  if (!initialize()) {
    console.error('[Worker] 初始化失败，退出')
    process.exit(1)
  }

  // 设置消息处理器
  setupMessageHandlers()

  // 通知主进程Worker已就绪
  if (process.send) {
    process.send({
      type: 'ready',
      payload: {
        envId: state.envId,
        subagentType: state.subagentType,
      },
    })
  } else {
    console.error('[Worker] process.send 不可用!')
  }

  console.log('[Worker] Worker已就绪，等待消息')

  // 保持进程运行，防止事件循环为空导致自动退出
  // 使用 setInterval 创建一个空的定时器，确保进程持续运行
  const keepAliveInterval = setInterval(() => {
    // 空操作，仅用于保持进程活跃
  }, 10000) // 每10秒执行一次

  // 监听进程退出信号，清理定时器
  process.on('exit', () => {
    clearInterval(keepAliveInterval)
  })
}

// 启动Worker
main()
