import type { Message, ToolDefinition } from './models'

export type { ToolDefinition }

/**
 * 模型信息接口
 */
export interface WorkflowModelInfo {
  id: string
  name: string
  provider: string
}

/**
 * onExecute 函数类型
 */
export type OnExecuteFunction = (nodeId: string, config: any, messages?: Message[]) => Promise<void>

/**
 * 开始节点数据
 */
export interface StartNodeData {
  label: string
  textInput?: string
  fileInputs?: string[]
  isCollapsed?: boolean
}

/**
 * 模型节点数据（不含 onExecute 函数）
 * 用于序列化保存
 */
export interface ModelNodeData {
  label: string
  selectedModel?: WorkflowModelInfo | null
  parameters?: Record<string, any>
  selectedTools?: ToolDefinition[]
  systemPrompt?: string
  /** 引用单 Agent 模板 subagent_type(引用态;设置后内联字段无效,节点只读跟随模板) */
  agentTemplate?: string
  /** 权限字段(两层生效):工具黑名单/只读 */
  disallowedTools?: string[]
  readonly?: boolean
  /** 驮具字段(声明即需 Worker 独立上下文执行):记忆/技能/知识库 */
  memory?: string
  skills?: string[]
  knowledge?: string[]
  /** 循环上限(对齐模板 max_iterations) */
  maxIterations?: number
  /** 工具循环最大迭代次数(两层通用防失控上限) */
  maxTurns?: number
  /** 节点任务说明模板:{{prev}} / {{input.<name>}} / {{nodes.<id>}} */
  prompt?: string
  isCollapsed?: boolean
  onExecute?: OnExecuteFunction
  // 执行结果（临时存储，用于工作流切换时保留节点状态）
  executionResult?: {
    contentBlocks: any[]
    resultType: 'text' | 'file'
    nodeStatus: 'idle' | 'running' | 'completed' | 'error'
  }
}

/**
 * 默认节点数据
 */
export interface DefaultNodeData {
  label: string
}

/**
 * 工具节点数据
 * 用于确定性执行预配置的工具
 */
export interface ToolNodeData {
  label: string
  selectedTools: ToolDefinition[]
  toolParams: Record<string, any>
  isCollapsed?: boolean
  onExecute?: OnExecuteFunction
  executionResult?: {
    contentBlocks: any[]
    resultType: 'text' | 'file'
    nodeStatus: 'idle' | 'running' | 'completed' | 'error'
  }
}

/**
 * 代码执行器节点数据
 * 用于执行模型生成的代码
 */
export type SupportedLanguage = 'javascript' | 'python' | 'typescript' | 'shell' | 'powershell'

export interface CodeExecutorNodeData {
  label: string
  isCollapsed?: boolean
  defaultLanguage?: SupportedLanguage
  interactiveMode?: boolean
  onExecute?: OnExecuteFunction
  executionResult?: {
    contentBlocks: any[]
    resultType: 'text' | 'file'
    nodeStatus: 'idle' | 'running' | 'completed' | 'error'
  }
}

/**
 * 节点数据联合类型
 */
export type NodeData = StartNodeData | ModelNodeData | ToolNodeData | CodeExecutorNodeData | DefaultNodeData

/**
 * 工作流节点
 */
export interface WorkflowNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: NodeData
  selected?: boolean
}

// ==================== AGENT 类型定义(A2A 远程,出站客户端用) ====================

/**
 * A2A任务状态枚举
 * 遵循A2A协议v0.3.0规范
 */
export enum A2ATaskState {
  /** 任务已提交 */
  SUBMITTED = 'submitted',
  /** 任务处理中 */
  WORKING = 'working',
  /** 需要用户输入 */
  INPUT_REQUIRED = 'input-required',
  /** 需要授权 */
  AUTH_REQUIRED = 'auth-required',
  /** 任务完成 */
  COMPLETED = 'completed',
  /** 任务已取消（美式拼写） */
  CANCELED = 'canceled',
  /** 任务失败 */
  FAILED = 'failed',
  /** 任务被拒绝 */
  REJECTED = 'rejected',
  /** 未知状态 */
  UNKNOWN = 'unknown'
}

/**
 * A2A Agent Card 技能定义
 */
export interface AgentSkill {
  id: string
  name: string
  description?: string
}

/**
 * A2A Agent Card 能力定义
 */
export interface AgentCapabilities {
  streaming?: boolean
  pushNotifications?: boolean
  stateTransitionHistory?: boolean
}

/**
 * A2A Agent Card 结构
 */
export interface AgentCard {
  name: string
  description?: string
  version: string
  capabilities: AgentCapabilities
  skills: AgentSkill[]
}

// ==================== CHAT模块资源类型定义（迭代2新增） ====================

/**
 * 可执行资源类型
 */
export type ExecutableResourceType = 'tool' | 'remote_agent'

/**
 * 可执行资源接口（统一资源抽象）
 * 用于CHAT模块统一表示Tool、LocalAgent、RemoteAgent
 */
export interface ExecutableResource {
  /** 资源唯一标识 */
  id: string
  /** 资源名称 */
  name: string
  /** 资源描述 */
  description: string
  /** 资源类型 */
  type: ExecutableResourceType
  /** 资源能力标签 */
  capabilities?: string[]
  /** 资源配置（根据类型不同而变化） */
  config: RemoteAgentConfig | ToolConfig
  /** 是否启用 */
  enabled: boolean
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/**
 * 远程Agent配置
 */
export interface RemoteAgentConfig {
  /** 类型标识 */
  type: 'remote_agent' | 'coze'
  /** Agent名称（用于显示） */
  name?: string
  /** Agent描述（说明Agent的功能和用途） */
  description?: string
  /** A2A服务URL（A2A类型必填） */
  url?: string
  /** Agent Card信息（可选，可自动获取） */
  agentCard?: AgentCard
  /** 认证信息（可选） */
  auth?: {
    type: 'none' | 'api_key' | 'oauth'
    apiKey?: string
  }
  /** Coze Bot ID（Coze类型必填） */
  bot_id?: string
  /** Coze Token（Coze类型必填） */
  token?: string
  /** Coze API基础URL（可选，默认https://api.coze.cn） */
  baseURL?: string
}

/**
 * 类型保护函数：判断是否为Coze配置
 */
export function isCozeConfig(config: RemoteAgentConfig): config is RemoteAgentConfig & { type: 'coze'; bot_id: string; token: string } {
  return config.type === 'coze'
}

/**
 * 工具配置（MCP工具）
 */
export interface ToolConfig {
  /** 类型标识 */
  type: 'tool'
  /** MCP服务器名称 */
  serverName: string
  /** 工具定义 */
  toolDefinition: ToolDefinition
}

/**
 * 资源执行状态
 */
export interface ResourceExecutionState {
  /** 执行ID */
  executionId: string
  /** 资源ID */
  resourceId: string
  /** 资源名称 */
  resourceName: string
  /** 资源类型 */
  resourceType: ExecutableResourceType
  /** 执行状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  /** 输入参数 */
  input?: Record<string, any>
  /** 输出结果 */
  output?: any
  /** 错误信息 */
  error?: string
  /** 开始时间 */
  startTime?: number
  /** 结束时间 */
  endTime?: number
}

/**
 * Subagent 模板类型家族（TemplatePriority/TemplateType/PriorityScope/BridgeProtocol/
 * SubagentParameter(s)/DefaultParameters/BridgeConfig/SubagentTemplate）——
 * 单一事实源在 orchestrator/types.ts（T7 消除双定义），此处 re-export 保持既有 import 兼容。
 */
export {
  TemplatePriority,
  TemplateType,
  PriorityScope,
  BridgeProtocol,
} from '../orchestrator/types'
export type {
  SubagentParameter,
  SubagentParameters,
  DefaultParameters,
  BridgeConfig,
  SubagentTemplate,
} from '../orchestrator/types'
