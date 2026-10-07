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
  MessageAttachmentRef,
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
import type { SchedulerService } from '../services/scheduler/SchedulerService'
import type {
  SessionRecord,
  SessionResult,
  LoadSessionResult,
  SaveMode,
  CompactionCheckpoint,
} from '../persistence/SessionPersistence'
import type { SessionScope } from '../services/sessionRegistry/SessionScope'

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
 * - UI 渲染进程实现经 session:save（透传 SaveMode）/ session:load（单文件直读）IPC 落盘（T5 接线）。
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
  /** per-agent 空间索引注入（agent 模板声明 memory 字段时；解析与 scoped 读取收在 store 内） */
  buildAgentIndexInjection?(
    scope: 'user' | 'project' | 'local',
    subagentType: string,
    workDir?: string
  ): Promise<string | null>
}

/** 知识库门面（数据源为 knowledgeStore 单例；renderer 安全边界——门面之外不直读 store） */
export interface KnowledgeStoreFacade {
  /** 全部知识库配置（名称/描述等；agent-knowledge 注入器按模板声明过滤） */
  listKnowledgeBases(): Promise<
    Array<{ name: string; description: string; createdAt: string; embeddingModel: string; embeddingDimensions: number }>
  >
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
  /** 桌面能力开关（getDesktopCapabilityNotice() 注入条件；deps.desktopToolsEnabled 现读，缺省=关） */
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
  /** 文件内容信任边界（第三方数据非指令，常量站立契约；文件引用管线） */
  FILE_CONTENT_TRUST: 12.5,
  /** 桌面能力常设声明（开关开启时注入；低频） */
  DESKTOP_CAPABILITY: 13,
  /** 前台 Agent 角色包装（frontAgent 已设置时注入，会话级） */
  FRONT_AGENT: 14,
  /** 委派指南 prompt 片段（subagent 清单 + 工具清单；渐进激活集稳定后不变） */
  DELEGATION_GUIDE: 15,
  /** 命名工作流索引(run_workflow 按名调用;低频,随工作流增删变化) */
  WORKFLOW_INDEX: 15.5,
  /** 固定团队索引(use_team 按名读取激活;低频,随团队增删变化) */
  TEAM_INDEX: 15.6,
  /** 工具目录索引（渐进发现激活集变化时变，中频） */
  TOOL_CATALOG: 16,
  /** 长期记忆索引（新记忆写入时变，中频） */
  MEMORY_INDEX: 20,
  /** per-agent 记忆索引（共享底在前、私域在后） */
  AGENT_MEMORY: 21,
  /** per-agent 知识库目录（前台 agent 声明 knowledge 字段时；与私域记忆同为会话级稳定段） */
  AGENT_KNOWLEDGE: 22,
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
   * 消息来源（M2 mobile origin 安全档）：'mobile' = 手机经盲中继注入。
   * per-turn 状态（runTurn 结束清空）；本轮工具调用经 __origin 透传到执行层，
   * 修改性工具/execute_powershell 被强制走审批（无视 fullAccess/autoApply）。
   * 不进 Message（不落盘、不动 synthetic 封闭联合）。
   */
  origin?: 'mobile'
  /**
   * 输入侧媒体：宿主经 buildContentParts 构建的完整内容块（含文本块）。
   * 引擎在并入历史前按当前模型能力做输入侧过滤（不支持的媒体替换为占位符文本）。
   */
  contentParts?: ContentPart[]
  /**
   * 附件引用（file.* 协议族）：手机经盲中继上传的附件回填键，随用户消息落盘；
   * SessionSyncService.toSyncMessage 据此在 media 行输出 refs?（手机查本地登记表渲染缩略图/芯片）。
   * 纯元数据（ref=传输 fileId + name/mime），字节消费由 contentParts/引用行承担。
   */
  attachmentRefs?: MessageAttachmentRef[]
  /**
   * 客户端消息身份（可选；仅 relay 来源注入携带，= chat.user 信封 id）：
   * 随用户消息落盘为 Message.clientId，toSyncMessage 输出给手机——overlay 气泡与 DB 行同 id 的匹配键。
   */
  clientId?: string
}

/** sendMessage / regenerate 回调 */
export interface ChatEngineCallbacks {
  /** 流式透传（CLI 增量打印的唯一数据源，eventBus 无 chunk 事件） */
  streamCallback?: StreamCallback
  /**
   * 两段式回调（M7增量3·决策30·投递与处理解耦）：用户消息已持久化、轮次即将开始时触发。
   * 触发前引擎补一次 merge 落盘（仅本回调在场时）——回调方（RelayBridge）据此写
   * pending-rounds 台账并 ACK；此后轮次无论成败，投递侧不再撤销。deny/running-throw 不触发。
   */
  onIngested?: () => void | Promise<void>
}

/** 一轮对话的结果 */
export interface ChatEngineTurnResult {
  /** 本轮新增并入权威历史的全部消息（assistant 工具调用消息 + TOOL 消息 + 末轮 assistant 消息；不含用户消息） */
  producedMessages: Message[]
  /** 末轮 assistant 文本（abort 时为空串） */
  content: string
  /** 本轮是否被 abort() 中断（中断轮已封口落盘：已完成步骤保留，缺失结果的 toolCall 补中断标记） */
  aborted: boolean
  /** UserPromptSubmit hook deny 的拦截原因（仅 deny 轮填充；外部注入方据此回执"消息被拦截"，不石沉大海） */
  deniedReason?: string
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
  /** UI 任务清单（无损往返载荷；引擎本身不产生，undefined = 本会话无清单）——只增字段 */
  tasks?: unknown[]
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
    /** hook 派发的会话上下文闭包（引擎构造时注册；Worker 咽喉 dispatch 的 sessionId/cwd 与备份归因的 turnId 数据源） */
    setHookContextProvider?(provider: () => { sessionId: string; cwd: string; turnId?: string }): void
    /**
     * SessionScope 注册/注销（1.4 多会话归因）：引擎构造注册、dispose 对称注销。
     * executor 一切按调用归属（__origin.handle）经 scope 现读解析；无归因回退既有单槽。
     */
    registerSessionScope?(handle: string, scope: SessionScope): void
    unregisterSessionScope?(handle: string): void
    /**
     * 定时任务三件套的取数通道（引擎构造时注册；缺省时工具返回"未装配"提示）。
     * 现读闭包：scheduler 实例、当前 workDir、ensureSessionId（scope=session 创建前提——
     * 首轮无 id 的既有坑，强制生成）、activeScheduledTaskId（定时回合自取消免审批的判定数据源）
     */
    setSchedulerProvider?(provider: () => {
      scheduler: SchedulerService | null
      workDir: string
      ensureSessionId(): string
      activeScheduledTaskId: string | null
    }): void
  }
  mcpService: McpToolsFacade
  /** agent 资源（远程 A2A/Coze）→ 可执行资源列表（execute_remote_agent_* 工具来源；缺省不加载） */
  agentResources?: () => Promise<ExecutableResource[]>
  /** 远程 agent 资源执行所需（缺省时跳过 remote_agent 资源注册） */
  secureStorage?: import('../interfaces/ISecureStorage').ISecureStorage
  // ---- 上下文组装 ----
  memoryStore?: MemoryStoreFacade
  /** 知识库门面（agent-knowledge 注入器数据源；可选——缺省时注入器跳过、降级为无目录不崩） */
  knowledgeStore?: KnowledgeStoreFacade
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
  /**
   * 定时任务调度服务（可选）。注入后引擎接线：onFire → 合成 user 消息触发轮
   * （synthetic:'scheduledTask'，复用回流轮/goalTick 骨架，忙时排队等下一自然触发点）；
   * 构造时 start()、dispose 时 stop()；loadSession/startNewSession 后逾期检测 collapse-to-latest
   * 补跑；三件套工具的取数通道经 setSchedulerProvider 透传给 executor。
   */
  scheduler?: SchedulerService | null
  /**
   * 共享 scheduler 生命周期归属（3.5）：true 时引擎构造/dispose 不调用 scheduler.start()/stop()
   * （启停归壳装配点——多引擎共享单实例时，任意引擎 dispose 不得停掉全局时钟、任意引擎
   * 构造不得重复 start）。缺省 false=现行为（CLI 单引擎零变化）。
   */
  shellOwnsScheduler?: boolean
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
  /**
   * 跨引擎 goal 互斥钩子（1.6）：另有会话已在目标模式时返回 true，开启点（/goal 与
   * propose_goal 受理）守卫拒绝——current-goal.md 是进程级单文件，双会话同开=交错写。
   * 缺省恒 false（CLI 单引擎零变化）；UI 多会话装配注入"查其余引擎 goalState"实现。
   */
  hasOtherActiveGoal?: () => boolean
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
