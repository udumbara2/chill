/**
 * ChatEngine 类型定义（T2：统一对话路径）
 *
 * 本模块只含类型与接口，平台无关、无 Node 依赖，渲染进程可安全导入。
 * 引擎构造依赖全部经此处的接口注入（可测试性）：模型调用、模型信息、
 * 会话持久化适配器、内置工具执行器、MCP 工具聚合、记忆、AGENTS.md、
 * Skill 注册表、Subagent/可用模型数据源、媒体 provider、eventBus。
 */

import type {
  Message,
  ContentPart,
  ModelInfo,
  ModelResponse,
  StreamCallback,
  ToolDefinition,
} from '../types/models'
import type { SkillMeta } from '../types/skill'
import type { ExecutableResource } from '../types/workflow'
import type { AvailableSubagent, AvailableModel } from '../orchestrator/types'
import type { SubagentTemplate, ToolMetadata } from '../orchestrator/types'
import type { ToolCatalogEntry } from './toolDiscovery'
import type { HookRunner } from '../services/hooks/HookRunner'
import type {
  SessionRecord,
  SessionResult,
  LoadSessionResult,
  SaveMode,
  CompactionCheckpoint,
} from '../persistence/SessionPersistence'

// ==================== 模型调用 ====================

/**
 * 单次模型调用入口。引擎自己运行工具循环（含同轮多 task 并行检测），
 * 因此实现方每次调用只做一次模型请求，不得在内部循环执行工具。
 * Node 侧装配（nodeFactory）经 ModelServiceFactory + BaseModelService.sendSingleMessage 实现。
 */
export interface EngineModelCaller {
  callOnce(params: {
    modelName: string
    messages: Message[]
    tools?: ToolDefinition[]
    streamCallback?: StreamCallback
    abortController?: AbortController
    /** 单次调用的模型参数覆盖（如压缩调用关闭思考模式）；实现方合并到用户参数之后 */
    parameterOverrides?: Record<string, unknown>
  }): Promise<ModelResponse>
}

/** 模型信息门面（数据源为 modelInfoService，注入以便测试替换） */
export interface ModelInfoFacade {
  getModelsWithApiKeys(): Promise<ModelInfo[]>
  getModelInfoByName(name: string): ModelInfo | undefined
}

/** 当前选定模型门面（数据源为 SelectedModelsService） */
export interface SelectedModelsFacade {
  getCurrentModelName(): string | null
  saveCurrentModelName?(name: string): void
}

// ==================== 会话持久化 ====================

/**
 * 引擎侧会话持久化适配器（引擎本体平台无关）：
 * - Node 实现直接复用 persistence/SessionPersistence.ts（该实现 import fs，Node-only）；
 * - UI 渲染进程实现经现有 session:save / session:list IPC 落盘（T5 接线）。
 *
 * 注意：regenerate 删除消息后的落盘依赖 replace 模式（merge 会按消息键复活已删消息），
 * UI 侧 IPC 需要支持透传 mode（T5 处理）。
 */
export interface SessionStoreAdapter {
  save(record: SessionRecord, mode?: SaveMode): Promise<SessionResult>
  load(id: string): Promise<LoadSessionResult>
}

// ==================== 上下文组装依赖 ====================

/** 记忆门面（数据源为 memoryStore 单例） */
export interface MemoryStoreFacade {
  buildIndexInjection(): Promise<string | null>
  buildPendingNotice(): Promise<string | null>
  /** per-agent 空间索引注入（agent 模板声明 memory 字段时；解析与 scoped 读取收在 store 内） */
  buildAgentIndexInjection?(
    scope: 'user' | 'project' | 'local',
    subagentType: string,
    workDir?: string
  ): Promise<string | null>
}

/** AGENTS.md 约束门面（数据源为 agentInstructions 单例） */
export interface AgentInstructionsFacade {
  buildInjection(workDir?: string): Promise<string>
}

/** Skill 注册表面门（数据源为 getSkillRegistry()） */
export interface SkillRegistryFacade {
  getEnabled(): SkillMeta[]
}

/** MCP 聚合工具门面（单例聚合，CLI 现状做法；UI 每次 new MCPService 的做法不采） */
export interface McpToolsFacade {
  getAggregatedOpenAITools(): Promise<ToolDefinition[]>
}

/** 可用 Subagent 列表数据源（委派指南②；前台 Agent 候选亦取自此处，T3） */
export type SubagentsSource = () => AvailableSubagent[]

/** 可用模型列表数据源（委派指南③，含能力/成本/速度等级） */
export type AvailableModelsSource = () => Promise<AvailableModel[]> | AvailableModel[]

/** SubagentTemplate 解析数据源（T3 前台角色包装需要模板原文；缺省不设 frontAgent 时无包装） */
export type SubagentTemplateSource = (subagentType: string) => SubagentTemplate | undefined

// ==================== 媒体 ====================

/**
 * 媒体 provider：把历史消息中的附件引用（fileId/路径）读为 base64。
 * 由宿主注入——UI 桥 window.electronAPI.readAttachmentAsBase64，CLI 读本地文件。
 * 未注入时视频引用保持原样（不转换为 base64）。
 */
export interface MediaProvider {
  readAsBase64(ref: string): Promise<{ base64: string; mimeType?: string } | null>
}

/** 当前模型的媒体能力（决定能力过滤与占位符替换） */
export interface ModelMediaCapabilities {
  supportsImage: boolean
  supportsVideo: boolean
}

// ==================== 上下文注入器框架 ====================

/**
 * 组装上下文：每轮组装时现取的状态快照。
 * hostContext 供宿主自注册的注入器传递任意数据（CLI 的运行状态、UI 的写作视图状态等）。
 */
export interface AssembleContext {
  /** 规划模式开关（PLAN_MODE_CONTRACT 注入条件） */
  planMode: boolean
  /** 桌面能力开关（DESKTOP_CAPABILITY_NOTICE 注入条件；deps.desktopToolsEnabled 现读，缺省=关） */
  desktopEnabled?: boolean
  /** 目标模式数据（GOAL_MODE_CONTRACT 注入条件与目标/判据/轮次数据源；undefined = 未开启） */
  goalMode?: { objective: string; successCriteria: string; roundCount: number; maxRounds: number }
  /** 前台 Agent（T3 角色包装语义的钩子；T2 只做状态存取与透传） */
  frontAgent?: string
  /** 当前模型名 */
  modelName?: string
  /** 当前模型媒体能力；缺省表示未知——跳过全部媒体变换（不做能力过滤与占位符替换） */
  mediaCapabilities?: ModelMediaCapabilities
  /** AGENTS.md 工作目录 */
  workDir?: string
  /** 本轮工具集中 task 委派工具可用（委派指南注入条件） */
  taskToolAvailable: boolean
  /** 本轮全量工具元信息（委派指南的工具清单 section 数据源；buildToolset 产出） */
  toolMetadata?: ToolMetadata[]
  /** 当轮工具目录（tool-catalog 注入器与委派指南「可分配工具清单」的数据源；buildToolset 产出） */
  toolCatalog?: ToolCatalogEntry[]
  /** 工具渐进发现本轮是否分层生效（tool-catalog 注入器的注入条件；false/缺省 = 全量下发，不注入索引） */
  toolCatalogActive?: boolean
  /** 宿主自定义上下文（壳侧注入器自行解释） */
  hostContext?: Record<string, unknown>
}

/**
 * 条件注入器：每轮组装时按 order 顺序求值，产出一条 system 消息（或 null 跳过）。
 * 公共注入器由 core 提供（createCommonInjectors）；宿主专属注入器（CLI 的
 * selfMd/status/switch/failure、UI 的写作 prompt）由壳侧实现并经 registerInjector 注册（T4/T5）。
 */
export interface ContextInjector {
  /** 注入器标识（去重/卸载用） */
  id: string
  /** 规范顺序（小在前），见 INJECTOR_ORDER；同级按注册先后 */
  order: number
  inject(context: AssembleContext): Promise<Message | null> | Message | null
}

/**
 * 规范顺序常量（R0 缓存对齐重排：按内容变化频率升序——稳定前置、易变尾移）。
 * 原理：注入器内容变化会使其后所有前缀缓存 miss，故变化越频繁越靠后；
 * 每轮必变的内容（goal 轮次计数、本轮 @点名）放公共注入器尾部，
 * 稳定内容（AGENTS.md/skill/写边界规则文本）前置使长前缀跨轮命中。
 * 语义优先级说明：PLAN_MODE_CONTRACT 原置首（"最高优先级"语义），重排后位于中后段——
 * 同一 system 块内的相邻段落位置对约束力影响有限，而非 plan 会话该注入器不产出（无影响）；
 * 若实测 plan 模式约束力退化，回退方案 = 仅将其移回首（其他不动）。
 */
export const INJECTOR_ORDER = {
  /** AGENTS.md 用户约束（文件内容，最稳定） */
  AGENTS_MD: 10,
  /** skill 元数据（激活集，会话级稳定） */
  SKILL_METADATA: 11,
  /** 写边界（规则文本稳定；边界集合随 /add-dir 变化，低频） */
  WRITE_BOUNDARY: 12,
  /** 桌面能力常设声明（开关开启时注入；低频） */
  DESKTOP_CAPABILITY: 13,
  /** 前台 Agent 角色包装（frontAgent 已设置时注入，会话级） */
  FRONT_AGENT: 14,
  /** 委派指南 prompt 片段（subagent 清单 + 工具清单；渐进激活集稳定后不变） */
  DELEGATION_GUIDE: 15,
  /** 工具目录索引（渐进发现激活集变化时变，中频） */
  TOOL_CATALOG: 16,
  /** 长期记忆索引（新记忆写入时变，中频） */
  MEMORY_INDEX: 20,
  /** per-agent 记忆索引（共享底在前、私域在后） */
  AGENT_MEMORY: 21,
  /** 待确认记忆提示（出现/消失动态变化） */
  MEMORY_PENDING: 22,
  /** 规划模式行为契约（规划文本更新时变；非 plan 会话不产出） */
  PLAN_MODE_CONTRACT: 30,
  /** 目标模式行为契约（roundCount 每轮 +1，公共注入器中最易变） */
  GOAL_MODE_CONTRACT: 31,
  /** 显式点名 agent 的委派指令（本轮 @提及，每轮可能不同） */
  EXPLICIT_AGENT: 32,
  /** 宿主注册注入器的默认位置（公共注入器之后；cli status/hook-context 等最易变段） */
  HOST_DEFAULT: 100,
} as const

// ==================== 引擎输入输出 ====================

/** recall_archived_context 工具参数（时间段对应主题索引的 HH:MM / MM-DD HH:MM 格式） */
export interface RecallArchivedContextParams {
  /** 起始时间（HH:MM 或 MM-DD HH:MM，本地时区，含边界） */
  from?: string
  /** 结束时间（同 from 格式，含边界） */
  to?: string
  /** 关键词过滤（命中时连带前后各 1 条消息，保住问答对上下文） */
  keyword?: string
  /** 返回总量字符上限（默认 4000；超限时从最新往前保留） */
  maxChars?: number
}

/** sendMessage 输入 */
export interface ChatEngineInput {
  /** 用户文本 */
  text: string
  /**
   * 显式点名的 agent（subagent_type，@提及解析产物）：
   * 本轮经 explicit-agent 注入器向模型下达"必须委派给该 agent"的指令；
   * per-turn 状态（runTurn 结束清空）。
   */
  explicitAgent?: string
  /**
   * 输入侧媒体：宿主经 buildContentParts 构建的完整内容块（含文本块）。
   * 引擎在并入历史前按当前模型能力做输入侧过滤（不支持的媒体替换为占位符文本）。
   */
  contentParts?: ContentPart[]
}

/** sendMessage / regenerate 回调 */
export interface ChatEngineCallbacks {
  /** 流式透传（CLI 增量打印的唯一数据源，eventBus 无 chunk 事件） */
  streamCallback?: StreamCallback
}

/** 一轮对话的结果 */
export interface ChatEngineTurnResult {
  /** 本轮新增并入权威历史的全部消息（assistant 工具调用消息 + TOOL 消息 + 末轮 assistant 消息；不含用户消息） */
  producedMessages: Message[]
  /** 末轮 assistant 文本（abort 时为空串） */
  content: string
  /** 本轮是否被 abort() 中断（中断后历史已完整回滚到本轮之前） */
  aborted: boolean
}

/**
 * 目标模式状态（一等状态，唯一事实源在 ChatEngine；随会话生命周期，不跨会话持久化）。
 * roundCount 每发出一个 goalTick 推进消息 +1；noProgressCount 记录连续无进展轮数（熔断依据）。
 */
export interface GoalState {
  /** 目标描述（用户 /goal 原文） */
  objective: string
  /** 完成判据（怎么算完、怎么验证；未单独给出时与 objective 同文） */
  successCriteria: string
  /** 运行状态（active 推进中 / paused 暂停：/goal pause 或熔断请示后等待用户决策） */
  status: 'active' | 'paused'
  /** 已推进轮数（goalTick 计数） */
  roundCount: number
  /** 连续无实质进展轮数（评估 progress=false 或轮次异常计入；达到 3 触发熔断） */
  noProgressCount: number
  /** 轮次硬顶（默认 20） */
  maxRounds: number
  /** 设定时间（ISO 串） */
  createdAt: string
}

/** 会话状态查询结果 */
export interface ChatEngineSessionState {
  sessionId: string | null
  title: string
  titleSource: 'default' | 'auto' | 'manual'
  planMode: boolean
  /** 目标模式摘要（壳侧提示符/状态栏数据源；undefined = 未开启） */
  goalMode?: { active: boolean; objective: string; roundCount: number; maxRounds: number }
  frontAgent?: string
  isRunning: boolean
  messageCount: number
  /** 压缩 checkpoint 数组（壳侧渲染「已压缩」标记条的数据源；未压缩过为空数组） */
  compactions: CompactionCheckpoint[]
}

// ==================== 引擎依赖 ====================

/** eventBus 最小形状（默认注入全局单例；测试可替换） */
export interface EventBusLike {
  on(event: string, callback: (...args: any[]) => void): void
  off(event: string, callback: (...args: any[]) => void): void
  emit(event: string, ...args: any[]): void
}

/**
 * ChatEngine 构造依赖（全部注入）。
 * builtInToolExecutor 实际类型为 services/builtInToolExecutor 的 BuiltInToolExecutor
 * （此处用结构化子集声明，避免引擎对具体类的硬依赖；装配处直接传真实实例）。
 */
export interface ChatEngineDeps {
  // ---- 模型 ----
  modelCaller: EngineModelCaller
  modelInfo: ModelInfoFacade
  selectedModels: SelectedModelsFacade
  // ---- 持久化 ----
  sessionStore: SessionStoreAdapter
  // ---- 工具执行 ----
  /** 内置工具统一执行入口（plan 模式拦截门所在；真实类型 BuiltInToolExecutor） */
  builtInToolExecutor: {
    execute(toolName: string, args: string): { success: boolean; data?: any; error?: string; candidates?: any[] }
    executeAsync(toolName: string, args: string, toolCallId?: string): Promise<{ success: boolean; data?: any; error?: string; candidates?: any[]; mediaParts?: ContentPart[] }>
    setPlanMode(on: boolean): void
    getAutoApply(): boolean
    getNonInteractiveMode(): 'readonly' | 'auto' | null
    applyAutoApplyBatch(): Promise<Map<string, { success: boolean; data?: any; error?: string }>>
    /** recall_archived_context 工具的取数回调（引擎构造时注册；可选，缺省时工具返回不可用提示） */
    setArchivedContextProvider?(provider: (params: RecallArchivedContextParams) => string): void
    /** 目标模式开关同步（goal 五工具的【仅目标模式】门；引擎 applyGoalState 时调用） */
    setGoalMode?(on: boolean): void
    /** request_goal_review 的评估回调（引擎构造时注册；缺省时工具返回不可用提示） */
    setGoalReviewProvider?(provider: () => Promise<{ achieved: boolean; message: string }>): void
    /** report_goal_blocked 的熔断请示回调（引擎构造时注册；缺省时工具返回不可用提示） */
    setGoalBlockedHandler?(handler: (reason: string) => Promise<string>): void
    /** search_tools 工具的检索回调（引擎构造时注册；可选，缺省时工具返回不可用提示） */
    setSearchToolsProvider?(provider: ((params: { query?: string; limit?: number; category?: string }) => string) | null): void
    /** hooks 运行器透传（引擎构造时注册；Worker 咽喉的 hooks 判定依赖它；缺省时 Worker 咽喉零开销短路） */
    setHookRunner?(runner: HookRunner | null): void
    /** hook 派发的会话上下文闭包（引擎构造时注册；Worker 咽喉 dispatch 的 sessionId/cwd 数据源） */
    setHookContextProvider?(provider: () => { sessionId: string; cwd: string }): void
  }
  mcpService: McpToolsFacade
  /** 本地 Agent（UI 保存的工作流 Agent）→ 可执行资源列表（agent 资源工具来源；缺省不加载） */
  localAgentResources?: () => Promise<ExecutableResource[]>
  /** agent 资源执行器（local_agent 资源必需；缺省时跳过 agent 资源注册） */
  localAgentExecutor?: import('../interfaces/ILocalAgentExecutor').ILocalAgentExecutor
  /** 远程 agent 资源执行所需（缺省时跳过 remote_agent 资源注册） */
  secureStorage?: import('../interfaces/ISecureStorage').ISecureStorage
  // ---- 上下文组装 ----
  memoryStore?: MemoryStoreFacade
  agentInstructions?: AgentInstructionsFacade
  skillRegistry?: SkillRegistryFacade
  /** 可用 Subagent 列表数据源（委派指南②；缺省不注入委派指南） */
  getSubagents?: SubagentsSource
  /** 可用模型列表数据源（委派指南③，含能力/成本/速度等级；缺省委派指南不含模型列表） */
  getAvailableModels?: AvailableModelsSource
  /** SubagentTemplate 解析数据源（T3 前台角色包装；缺省不设 frontAgent 时无包装） */
  getSubagentTemplate?: SubagentTemplateSource
  /** AGENTS.md 工作目录（缺省不注入 AGENTS.md） */
  workDir?: string
  // ---- 媒体 ----
  mediaProvider?: MediaProvider
  // ---- 事件 ----
  /** 默认全局 eventBus 单例 */
  eventBus?: EventBusLike
  /**
   * hooks 运行器（生命周期 hooks；可选）。注入后引擎接线全部挂载点：
   * SessionStart/UserPromptSubmit/PreToolUse/PostToolUse（主会话）在引擎侧，
   * Worker 来源的 PreToolUse/PostToolUse 与 PermissionRequest 减码槽在 executor 咽喉
   * （引擎构造时经 setHookRunner/setHookContextProvider 透传）；
   * 阶段 4：Stop（回合结束决策点）/SessionEnd（endSession）/PreCompact/PostCompact 在引擎侧，
   * Notification/GoalTransition 经 eventBus 映射表（notificationBridge），
   * PreDelegation/PostDelegation 经 delegationTools 派发器，Worker MCP 经 workerMcpHooks 派发器。
   */
  hookRunner?: HookRunner | null
  // ---- 行为参数 ----
  /** 工具循环最大迭代次数（缺省不限，与现状一致） */
  maxToolIterations?: number
  /** 桌面工具（capture_screen/computer_use）功能开关（opt-in：回调缺省或返回 false 时
   *  buildToolset 从工具集滤除，模型不可见；壳层注入闭包现读 configStore，开关即时生效） */
  desktopToolsEnabled?: () => boolean
  /** 工具渐进发现开关（opt-out：回调缺省或返回 true 时启用——未接线宿主自动获得默认开；
   *  壳层注入闭包现读 configStore 键 progressive_tools，引擎每轮现算，开关即时生效；off = 全量下发现状） */
  progressiveToolsEnabled?: () => boolean
  /** 自动压缩总开关（opt-out：回调缺省或返回 true 时启用；壳层闭包现读 configStore 键 auto_compact） */
  autoCompactEnabled?: () => boolean
  /** 自动压缩触发阈值（0-1；回调缺省或返回非法值时用 core 默认 0.8；壳层闭包现读键 compact_threshold） */
  autoCompactThreshold?: () => number
  /** 目标模式评估器模型名（壳层闭包现读 kvStore 的 defaultEvaluatorModel；缺省/未注册时回退当前会话模型） */
  getEvaluatorModelName?: () => string | undefined
  /** 任务清单状态摘要（goalTick 推进消息的进度事实数据源；缺省时推进消息不含清单段） */
  getTaskStatusSummary?: () => string
  /** 目标文档落盘适配器（Node 侧接 services/goalPersistence；缺省不落盘不归档，目标仅存内存） */
  goalStore?: {
    save(state: GoalState): void
    archive(state: GoalState): void
    clear(): void
  }
  /** 用户应答通道现读闭包（熔断请示/propose_goal 用；缺省、返回 null 或非交互模式时，
   *  熔断退回"发事件 + clearGoal"的迭代 1 行为） */
  getUserInputProvider?: () => {
    ask(
      question: string,
      options?: { label: string; description?: string }[],
      allowFreeText?: boolean,
      freeTextHint?: string
    ): Promise<string>
  } | null
}
