/**
 * Subagent 模板类型定义
 * 用于定义 Subagent 模板的结构和参数
 */

/**
 * 模板优先级枚举
 * 数值越小优先级越高，后加载的覆盖先加载的
 */
export enum TemplatePriority {
  PROJECT = 1,  // 项目级模板（最高优先级）
  USER = 2,     // 用户级模板
  BUILTIN = 3,  // 内置模板
  REMOTE = 4,   // 远程模板（最低优先级）
}

/**
 * 模板类型枚举
 * 定义模板的来源类型
 */
export enum TemplateType {
  BUILTIN = 'builtin',           // 内置模板
  CUSTOM = 'custom',             // 自定义模板
  REMOTE_MCP = 'remote-mcp',     // 远程 MCP 模板
  REMOTE_API = 'remote-api',     // 远程 API 模板
}

/**
 * 优先级范围枚举
 * 定义模板的优先级作用范围
 */
export enum PriorityScope {
  PROJECT = 'project',   // 项目级
  USER = 'user',         // 用户级
  BUILTIN = 'builtin',   // 内置级
  REMOTE = 'remote',     // 远程级
}

/**
 * 桥接协议枚举
 * 定义远程模板的通信协议
 */
export enum BridgeProtocol {
  MCP = 'mcp',           // Model Context Protocol
  API = 'api',           // 通用 API
  SSE = 'sse',           // Server-Sent Events
  WS = 'ws',             // WebSocket
  COZE = 'coze',         // Coze 平台
  LOCAL_A2A = 'local-a2a',  // 本地A2A协议
}

/**
 * Subagent 参数定义
 */
export interface SubagentParameter {
  /** 参数名称 */
  name: string
  /** 参数类型 */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  /** 参数描述 */
  description: string
  /** 是否必填 */
  required?: boolean
  /** 默认值 */
  default?: any
}

/**
 * Subagent 参数集合
 */
export interface SubagentParameters {
  [key: string]: SubagentParameter
}

/**
 * 默认参数配置
 * 用于配置 Subagent 的运行参数
 */
export interface DefaultParameters {
  /** 最大迭代次数 */
  max_iterations?: number
  /** Token 预算 */
  token_budget?: number
  /** 超时时间（秒） */
  timeout?: number
  /** 温度参数 */
  temperature?: number
  /** 模型名称（覆盖模板默认模型） */
  model?: string
  /** 最大输出 Token 数（thinking 模型的推理 token 与正文共享配额，默认 thinking 32000 / 其余 4000） */
  maxTokens?: number
}

/**
 * 桥接配置
 * 用于配置远程模板的连接参数
 */
export interface BridgeConfig {
  /** 服务端点 */
  endpoint?: string
  /** 认证类型 */
  auth_type?: 'none' | 'api_key' | 'oauth' | 'basic'
  /** API Key 环境变量名 */
  api_key_env?: string
  /** 超时时间（秒） */
  timeout?: number
  /** 是否加密通信 */
  encryption?: boolean
  /** Agent ID（本地A2A协议使用） */
  agent_id?: string
}

/**
 * Subagent 模板接口
 * 对应设计文档中的模板结构
 */
export interface SubagentTemplate {
  /** 模板名称（显示用） */
  name: string
  /** 模板描述 */
  description?: string
  /** Subagent 类型标识符（唯一） */
  subagent_type: string
  /** 优先级 */
  priority: TemplatePriority
  /** 参数定义 */
  parameters?: SubagentParameters
  /** 系统提示词 */
  system_prompt?: string
  /** 用户提示词模板 */
  user_prompt_template?: string
  /** 模板来源文件路径 */
  sourcePath?: string
  /** 模板版本 */
  version?: string
  /** 作者 */
  author?: string
  /** 标签 */
  tags?: string[]
  /** 模板类型 */
  type?: TemplateType
  /** 优先级范围 */
  priority_scope?: PriorityScope
  /** 是否可覆盖 */
  is_overridable?: boolean
  /** 指定默认模型 */
  model?: string
  /** 授权工具列表 */
  tools?: string[]
  /** per-agent 记忆作用域（Claude Code 式分层；缺省 = 无 per-agent 记忆） */
  memory?: 'user' | 'project' | 'local'
  /** 默认参数配置 */
  default_parameters?: DefaultParameters
  /** 桥接协议（remote 模板使用） */
  bridge_protocol?: BridgeProtocol
  /** 桥接配置（remote 模板使用） */
  bridge_config?: BridgeConfig
}

/**
 * 模板解析结果
 */
export interface TemplateParseResult {
  /** 解析是否成功 */
  success: boolean
  /** 解析后的模板 */
  template?: SubagentTemplate
  /** 错误信息 */
  error?: string
}

/**
 * 模板扫描配置
 */
export interface TemplateScanConfig {
  /** 扫描目录路径 */
  scanPath: string
  /** 是否递归扫描 */
  recursive?: boolean
  /** 文件扩展名过滤 */
  extensions?: string[]
}

/**
 * 模板管理器配置
 */
export interface TemplateManagerConfig {
  /** 自定义模板目录 */
  customTemplatePath?: string
  /** 是否启用缓存 */
  enableCache?: boolean
  /** 缓存过期时间（毫秒） */
  cacheTTL?: number
}

// ============================================================
// Task 工具类型定义
// ============================================================

/**
 * 编排工具名单：不得传入 Subagent（防无限套娃）
 * 单一事实源，三处共用：可见性过滤（delegationTools.filterSubagentTools）、
 * 默认授权名单生成（TaskExecutor）、宿主网关复核（TemplateSubagentForkManager 永不放行）
 */
export const ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  'task',
  'cancel_task',
  'query_task_status',
  'batch_task',
  // search_tools 对 Subagent 无意义：Worker 是一次性 tools 快照，无中途追加通道（维持全量过滤快照现状）
  'search_tools',
]

/**
 * Task 工具输入参数
 * 对应模板示例中的 task 工具输入结构
 */
export interface TaskToolInput {
  /** 任务唯一标识符 */
  task_id: string
  /** Subagent 类型标识符（对应模板中的 subagent_type） */
  subagent_type: string
  /** 任务描述 */
  task_description: string
  /** 任务可量化的成功标准，用于评估Subagent执行结果是否达标 */
  success_criteria?: string
  /** 分配给 Subagent 的工具名称列表 */
  available_tools?: string[]
  /** 可覆盖参数（可选） */
  override_parameters?: {
    /** 覆盖最大迭代次数 */
    max_iterations?: number
    /** 覆盖 Token 预算 */
    token_budget?: number
    /** 覆盖超时时间（秒） */
    timeout?: number
    /** 覆盖温度参数 */
    temperature?: number
    /** 覆盖模型 */
    model?: string
    /** 覆盖最大输出 Token 数 */
    max_tokens?: number
    /** 其他自定义参数 */
    [key: string]: any
  }
}

/**
 * Task 工具执行状态
 */
export enum TaskExecutionStatus {
  PENDING = 'pending',       // 待执行
  RUNNING = 'running',       // 执行中
  COMPLETED = 'completed',   // 已完成
  FAILED = 'failed',         // 执行失败
  TIMEOUT = 'timeout',       // 执行超时
}

/**
 * Task 工具输出结果
 * 对应模板示例中的 task 工具输出结构
 */
export interface TaskToolOutput {
  /** 执行状态 */
  status: TaskExecutionStatus
  /** 最终输出结果 */
  final_output: string
  /** 资源使用情况 */
  resource_usage?: {
    /** 使用的 Token 数量 */
    tokens_used?: number
    /** 执行耗时（毫秒） */
    execution_time?: number
    /** 迭代次数 */
    iterations?: number
  }
  /** 错误信息（执行失败时） */
  error_info?: {
    /** 错误代码 */
    code?: string
    /** 错误描述 */
    message: string
    /** 详细错误信息 */
    details?: string
  }
}

/**
 * Task 工具函数类型
 * 定义 Task 工具的执行函数签名
 */
export type TaskTool = (input: TaskToolInput) => Promise<TaskToolOutput>

// ============================================================
// 委派共享类型（T6：自旧调度类型文件迁移，保持导出兼容；
// 只迁移有外部使用者的类型，旧调度器专属类型随删除清理）
// ============================================================

/**
 * 子任务状态枚举
 */
export enum SubtaskStatus {
  PENDING = 'pending',       // 待执行
  RUNNING = 'running',       // 执行中
  COMPLETED = 'completed',   // 已完成
  FAILED = 'failed',         // 失败
  CANCELLED = 'cancelled',   // 已取消
}

/**
 * 可用 Subagent 信息接口
 * 用于委派指南/前台候选等场景描述可调度的 Subagent 列表
 */
export interface AvailableSubagent {
  /** Subagent 类型标识符 */
  type: string
  /** Subagent 名称 */
  name: string
  /** Subagent 描述 */
  description: string
  /** Subagent 能力列表 */
  capabilities: string[]
  /** 适用场景 */
  applicableScenarios: string[]
  /** 参数定义 */
  parameters?: Record<string, any>
  /** 模板类型: builtin/custom/remote-mcp/remote-api */
  templateType?: 'builtin' | 'custom' | 'remote-mcp' | 'remote-api'
  /** 优先级级别 (1-4, 数字越小优先级越高) */
  priorityLevel?: number
  /** 优先级范围: project/user/builtin/remote */
  priorityScope?: string
  /** 使用的模型 */
  model?: string
  /** 可用工具列表 */
  tools?: string[]
  /** 默认参数 */
  defaultParameters?: {
    maxIterations?: number
    tokenBudget?: number
    timeout?: number
    temperature?: number
  }
  /** 远程桥接协议 (仅 remote 类型) */
  bridgeProtocol?: string
  /** 远程桥接配置 (仅 remote 类型) */
  bridgeConfig?: Record<string, any>
  /** 是否可覆盖 */
  isOverridable?: boolean
}

/**
 * 可用模型信息接口
 * 委派指南的模型列表注入用（含能力/成本/速度等级，指导按任务性质选模型）
 */
export interface AvailableModel {
  /** 模型名称 */
  name: string
  /** 模型提供商 */
  provider: string
  /** 模型描述 */
  description?: string
  /** 核心能力描述 */
  capabilities: string[]
  /** Token 消耗级别（low/medium/high） */
  tokenConsumptionLevel: 'low' | 'medium' | 'high'
  /** 响应速度级别（fast/medium/slow） */
  responseSpeedLevel: 'fast' | 'medium' | 'slow'
  /** 支持的功能/工具 */
  supportedFeatures: string[]
  /** 适配场景 */
  applicableScenarios: string[]
}

/**
 * 工具元信息
 * 用于委派时了解有哪些工具可以给 Subagent 分配
 * 不包含调用定义，仅包含描述信息
 */
export interface ToolMetadata {
  /** 工具名称 */
  name: string
  /** 工具描述 */
  description: string
  /** 能力标签 */
  capability_tags?: string[]
  /** 资源消耗强度 */
  resource_intensity?: 'low' | 'medium' | 'high'
  /** 适配场景 */
  applicable_scenarios?: string[]
}
