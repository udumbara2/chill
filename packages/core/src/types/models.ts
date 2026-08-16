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
   * 严禁当普通用户消息渲染（AGENTS.md「合成消息标记」约定）。
   */
  synthetic?: 'settledNotice' | 'todoLanding' | 'frontSwitch' | 'goalTick' | 'desktopToggle'
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
  extraBodyParams?: Record<string, any>
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
}

export interface ModelAdapterConfig {
  protocol: string
  baseURL: string
  defaultModel: string
  defaultMaxTokens?: number
  defaultTemperature?: number
  headers?: Record<string, string>
  extraBodyParams?: Record<string, any>
  extraConfig?: Record<string, any>
  /** 硬约束：最后应用、强制覆盖（如 kimi-k3 的 temperature 只能为 1，用户 /config 也压不过） */
  fixedParams?: Record<string, any>
  /** 硬约束：从请求体中剔除这些参数（模型不支持的参数） */
  unsupportedParams?: string[]
}

export interface ModelInfo {
  type: ModelType
  name: string
  displayName: string
  provider: string
  builtIn: boolean
  description?: string

  adapterConfig?: ModelAdapterConfig

  supportedModalities: ModelModality[]

  apiURL: string
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
