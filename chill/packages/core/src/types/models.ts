export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface TaskItem {
  id: string
  content: string
  status: TaskStatus
  result?: string
  createdAt: Date
  updatedAt: Date
}

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
  TOOL = 'tool'
}

export interface ContentPart {
  type: 'text' | 'image_url' | 'video_url' | 'input_audio'
  text?: string
  image_url?: {
    url: string
  }
  video_url?: {
    url: string
  }
  input_audio?: {
    data: string
    format: 'wav' | 'mp3'
  }
}

export enum ToolCallStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
  REJECTED = 'rejected'
}

export enum ContentBlockType {
  TEXT = 'text',
  REASONING = 'reasoning',
  TOOL_CALL = 'tool_call',
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio'
}

export interface BaseContentBlock {
  id: string
  type: ContentBlockType
  position: number
}

export interface TextBlock extends BaseContentBlock {
  type: ContentBlockType.TEXT
  content: string
}

export interface ReasoningBlock extends BaseContentBlock {
  type: ContentBlockType.REASONING
  content: string
}

export interface ToolCallBlock extends BaseContentBlock {
  type: ContentBlockType.TOOL_CALL
  toolCallId: string
  toolName: string
  displayName?: string
  mcpServerName?: string
  parameters: Record<string, any>
  status: ToolCallStatus
  result?: any
  artifacts?: any[]
  component?: unknown
  tasks?: TaskItem[]
}

export interface ImageBlock extends BaseContentBlock {
  type: ContentBlockType.IMAGE
  url: string
}

export interface VideoBlock extends BaseContentBlock {
  type: ContentBlockType.VIDEO
  url: string
}

export interface AudioBlock extends BaseContentBlock {
  type: ContentBlockType.AUDIO
  url: string
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ImageBlock | VideoBlock | AudioBlock

/**
 * 附件引用（file.* 协议族）：手机经盲中继上传的附件回填键。
 * 随用户消息落盘（可选字段，JSON 持久化整对象存活）；桌面 SessionSyncService 据此回填 refs 给手机渲染。
 */
export interface MessageAttachmentRef {
  /** 手机侧传输 fileId（file.offer/chunk/receipt 与 chat.user attachments 的闭环键） */
  ref: string
  name: string
  mime: string
}

export interface Message {
  role: MessageRole
  content: string | ContentPart[]
  timestamp: Date
  reasoningContent?: string
  /** 思考时长（ms）：首个→末个 reasoning delta 实测；仅流式路径有，非流式与旧会话无此字段 */
  thinkingDurationMs?: number
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolCallStatus?: ToolCallStatus
  mcpServerName?: string
  toolParameters?: Record<string, any>
  toolResult?: string
  toolCallStatuses?: Record<string, ToolCallStatus>
  toolCallResults?: Record<string, {
    mcpServerName?: string
    parameters?: Record<string, any>
    result?: any
    artifacts?: any[]
  }>
  contentBlocks?: ContentBlock[]
  /**
   * 附件引用回填键（file.* 协议族；可选，手机来源消息携带）：
   * toSyncMessage 命中 media 分支时据此输出 refs?（手机查本地登记表渲染缩略图/芯片）。
   */
  attachmentRefs?: MessageAttachmentRef[]
  /**
   * 客户端消息身份（可选；仅 relay 来源用户消息携带，= 其 chat.user 信封 id）：
   * 随消息落盘，toSyncMessage 据此输出 clientId?——手机 overlay 气泡与 DB 行同 id，回声确认退休的匹配键。
   */
  clientId?: string
  isSubResponse?: boolean
  /**
   * 内部编排合成消息标记（数据层显示标记，API 转换器不携带标记字段、消息内容照常进模型上下文）：
   * - 'settledNotice'：后台任务回流轮通知（ChatEngine 构造）——内容对模型必需、对用户冗余，
   *   显示层折叠为一条摘要提示行；
   * - 'todoLanding'：任务清单落地留痕（CLI 侧 todoTracker 经 ChatEngine.appendSyntheticMessage 追加）——
   *   用户侧最终态记录，显示层以提示行样式全量渲染原文（可回溯）；
   * - 'frontSwitch'：前台人格边界标记（setFrontAgent 切换时追加）——告知后续模型"此前回复出自另一
   *   角色"（agent 切换 = 指令集变更；模型切换不标——指令集未变），单行提示，兼作切换轨迹记录。
   * - 'goalTick'：目标模式推进消息（ChatEngine.maybeContinueGoal 构造）——携带评估理由与轮次预算的
   *   自动续跑指令，显示层折叠为一条摘要提示行（同 settledNotice 待遇）。
   * - 'desktopToggle'：桌面能力开关切换通知（/desktop on|off 时由壳注入）——告知模型
   *   capture_screen/computer_use 的可用性变化，显示层按提示行渲染原文（同 frontSwitch 待遇）。
   * - 'scheduledTask'：定时任务触发消息（ChatEngine.drainScheduledTasks 构造）——[定时任务 <id>] 信封
   *   + 任务 prompt + 合并补跑标注，显示层折叠为一条摘要提示行（同 goalTick 待遇）。
   * - 'backupRestore'：备份恢复留痕（壳侧 /restore 或 UI 恢复中心完成后经
   *   ChatEngine.appendSyntheticMessage 追加）——告知模型"用户把 N 个文件恢复到了某轮/某任务
   *   之前的状态 + 文件清单"（否则历史里 AI"我改了这些文件"的陈述会让模型基于错误认知继续），
   *   显示层以提示行样式全量渲染原文（同 frontSwitch 待遇）。
   * - 'fileReceipt'：d→m 文件发送的手机回执落会话（FILE_RECEIPT 事件由壳订阅追加）——
   *   告知模型与用户"手机已接收《name》/失败原因"（mobile_send_file 承诺"送达后我会在会话里
   *   告诉你"的兑现通道），显示层以提示行样式全量渲染原文（同 desktopToggle 待遇）。
   * 严禁当普通用户消息渲染（AGENTS.md「合成消息标记」约定）。
   */
  synthetic?: 'settledNotice' | 'todoLanding' | 'frontSwitch' | 'goalTick' | 'desktopToggle' | 'scheduledTask' | 'backupRestore' | 'roundFailure' | 'fileReceipt'
}

export interface ToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

export interface ToolDefinition {
  type: string
  function: {
    name: string
    description: string
    parameters: {
      type: string
      properties: Record<string, any>
      required: string[]
    }
  }
}

export enum ModelType {
  GLM = 'glm',
  DEEPSEEK = 'deepseek',
  KIMI_K2 = 'kimi-k2',
  CUSTOM = 'custom'
}

export interface ModelConfig {
  apiKey: string
  baseURL: string
  model: string
  temperature?: number
  maxTokens?: number
  topP?: number
  stream?: boolean
  thinking?: boolean
  reasoningEffort?: string
  /** Qwen 系布尔思考开关（enable_thinking） */
  enableThinking?: boolean
}

export type StreamCallback = (chunk: StreamResponse) => void

export interface StreamResponse {
  content?: string
  reasoningContent?: string
  toolCalls?: ToolCall[]
  toolCallStatus?: ToolCallStatus
  mcpServerName?: string
  toolParameters?: Record<string, any>
  toolResult?: string
  output?: ModelOutput
  isStreamComplete: boolean
}

export type ModelOutput =
  | { type: 'text'; content: string }
  | { type: 'image'; url: string; revisedPrompt?: string }
  | { type: 'video'; url: string; duration?: number }
  | { type: 'audio'; url: string }
  | { type: 'mixed'; parts: ModelOutput[] }

export interface ModelResponse {
  content: string
  /** 工具调用类响应的成败标记（可选；编排消费方判定用，如工作流节点的 MCP 分支） */
  success?: boolean
  reasoningContent?: string
  /** 思考时长（ms）：首个→末个 reasoning delta 实测；仅流式路径打点，非流式缺省 */
  thinkingDurationMs?: number
  toolCalls?: ToolCall[]
  output?: ModelOutput
  /**
   * 本轮工具循环产生的中间消息（assistant 工具调用消息[含 reasoningContent] + TOOL 结果消息），
   * 供调用方并入会话历史；不含末轮最终 assistant 消息（由调用方用本响应自行构造）。
   * 仅 sendChatMessage（对话+工具循环模式）会返回该字段。
   */
  producedMessages?: Message[]
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    /** prompt 侧缓存命中 token（协议报告了才有：OpenAI prompt_tokens_details.cached_tokens /
     *  Anthropic cache_read_input_tokens / DeepSeek prompt_cache_hit_tokens）；压力计量与缓存命中 A/B 的数据源 */
    cacheReadTokens?: number
    /** prompt 侧缓存写入/未命中 token（Anthropic cache_creation_input_tokens / DeepSeek prompt_cache_miss_tokens；
     *  语义随 provider 而异，仅观测用，不参与压力判定） */
    cacheWriteTokens?: number
  }
  /**
   * 任务累计消耗（计量中间件）：sendChatMessage 逐轮聚合（每轮都重发完整上下文，消耗大头在前 N-1 轮，
   * 末轮 usage 只是上下文占用，量纲不同故分离）；任一轮无 usage 回报时按字符估值（approxTokensForRound）
   * 并置 estimated:true（单向，实测+估值混合也标估值）。消费方=团队账本→预算闸/watchdog/展示；
   * 绝不进 contextPressure/TUI/空输出截断等末轮语义判定。sendAsyncMessage 不计量（无 chat token 语义）。
   */
  cumulativeUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    /** 任一轮为估值（服务商未回报 usage）时置真 */
    estimated?: boolean
  }
  iterations?: number
}

export interface ModelService {
  sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    registry?: any,
    streamCallback?: StreamCallback,
    abortController?: AbortController
  ): Promise<ModelResponse>

  getModelType(): ModelType

  getConfig(): ModelConfig

  /** 模型窗口上限（工厂在创建与缓存命中时回填；callModelAPI 出口钳制的分母。SSOT=outputBudget.ts） */
  maxContextTokens?: number

  setMCPStoreGetter?(mcpStoreGetter: () => { getMCPToolsEnabled: () => boolean }): void
}

export enum ModelModality {
  TEXT = 'text',
  IMAGE = 'image',
  AUDIO = 'audio',
  VIDEO = 'video',
  FUNCTION_CALLING = 'function_calling',
  JSON_MODE = 'json_mode',
  THINKING_MODE = 'thinking_mode',
  REASONING_MODE = 'reasoning_mode',
  CONTEXT_CONTINUATION = 'context_continuation',
  FIM_COMPLETION = 'fim_completion'
}

export enum ParameterType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  ARRAY = 'array',
  OBJECT = 'object'
}

export interface ModelParameter {
  name: string
  type: ParameterType
  description: string
  required: boolean
  defaultValue?: any
  forProvider?: ModelType[]
  /** 枚举取值（如 reasoning_effort 的 low/high/max）；**按强度升序声明——首档即最低档**，压缩降档取首档 */
  enumValues?: string[]
}

export interface ModelAdapterConfig {
  protocol: string
  baseURL: string
  defaultModel: string
  defaultMaxTokens?: number
  defaultTemperature?: number
  headers?: Record<string, string>
  extraBodyParams?: Record<string, any>
  /** 硬约束：最后应用、强制覆盖（如 kimi-k3 的 temperature 只能为 1，用户 /config 也压不过） */
  fixedParams?: Record<string, any>
  /** 硬约束：从请求体中剔除这些参数（模型不支持的参数） */
  unsupportedParams?: string[]
}

/** 能力元数据来源标记：probed=端点探测 / catalog=厂商目录 / declared=用户声明或保守缺省 */
export type CapabilitySource = 'probed' | 'catalog' | 'declared'

/** 能力字段级来源标记（字段带来源标记，UI 可逐项标注「探测/目录/声明」） */
export interface CapabilitySourceMarks {
  supportedModalities?: CapabilitySource
  maxContextTokens?: CapabilitySource
  maxOutputTokens?: CapabilitySource
  supportsThinking?: CapabilitySource
  supportsStreaming?: CapabilitySource
  supportsTools?: CapabilitySource
}

export interface ModelInfo {
  type: ModelType
  /** 本地注册名（卡文件名与 state.json 外键）；新写入经派生消歧链生成或校验安全字符集，永不进请求字段 */
  name: string
  displayName: string
  provider: string
  builtIn: boolean
  /**
   * 上游真实模型 ID（API 请求体 model 字段的唯一来源，V6）。
   * 旧卡可缺省（读取回退 adapterConfig.defaultModel，见 resolveApiModelId）；新写入强制。
   * 本地注册名（name）不得写入本字段——假名源头消灭。
   */
  apiModelId?: string
  /**
   * 显式凭证域绑定（AuthRealm 逻辑 ID，如 `xiaomi#token-plan-cn.xiaomimimo.com/v1`）。
   * 创建时缺省由 resolveKeySlotId 派生并写入固化；modify_model 改 base_url（换绑）时同步重派生/清除
   * （防显式字段优先于派生而陈旧）。缺省时 resolveCredentialId 回退派生（旧卡兼容）。
   */
  credentialRealm?: string
  /** 能力字段级来源标记（probed/catalog/declared）；旧卡可缺省（视为未标注） */
  capabilitySources?: CapabilitySourceMarks
  /**
   * 出厂卡退役标记（退役两阶段的阶段一，仅出厂种子卡可携带）：
   * 仍注册进内存视图、可被显式指定使用；但"自动/默认"路径（自动选模型兜底、
   * 首跑向导）跳过它。启动时若仍被 state.json 选中键引用，物化移交用户
   * （见 ModelInfoService.materializeDeprecatedSelectedModels）；
   * 下一版本（阶段二）从出厂种子真正移除。
   */
  deprecated?: boolean
  description?: string

  adapterConfig?: ModelAdapterConfig

  supportedModalities: ModelModality[]

  availableModels: string[]

  supportedParameters: ModelParameter[]

  maxOutputTokens?: number
  maxContextTokens?: number

  supportsStreaming: boolean
  supportsTools: boolean
  supportsThinking: boolean

  version?: string
  documentation?: string
}

/**
 * 模型及其 API Key 配置状态
 */
export interface ModelWithApiKeyStatus {
  model: ModelInfo
  hasApiKey: boolean
}
