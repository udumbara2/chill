export * from './types'
export * from './utils/eventBus'
export * from './utils/expressionParser'
export * from './utils/variableResolver'
export * from './utils/workflowEventBus'
export * from './utils/killChord'
export * from './interfaces'
export { parseSkillMd } from './skills/SkillParser'
export type { SkillParseResult } from './skills/SkillParser'
export { SkillLoader } from './skills/SkillLoader'
export type { SkillLoadResult } from './skills/SkillLoader'
export { SkillRegistry, getSkillRegistry, resetSkillRegistry } from './skills/SkillRegistry'
export { buildSkillSystemMessage } from './skills/skillPromptBuilder'
export type { InstallMeta } from './skills/installTypes'
export { readInstallMeta, writeInstallMeta } from './skills/installMeta'
export type { UninstallResult, UpdateResult, ExportResult, InstallResult } from './skills/SkillInstaller'
export * from './orchestrator/managers/SubagentTemplateManager'
export * from './orchestrator/managers/templateToAvailableSubagent'
// 角色与能力分离（T3）：前台/子任务双场景角色包装与前台候选过滤，纯逻辑无 node 依赖
export * from './orchestrator/rolePrompt'
export * from './orchestrator/remote/RemoteAgentRegistrar'
// 项目级模板扫描（T5）：渲染进程经 IPC fsProvider 读项目目录；'path' 由 vite nodePolyfills 提供，
// FileSystemTemplateLoader 本体只依赖注入的 IFileSystemProvider + gray-matter（浏览器可用）
export * from './orchestrator/FileSystemTemplateLoader'
export * from './orchestrator/loaders/projectTemplateDirs'
export * from './orchestrator/parsers/TemplateParser'
export * from './orchestrator/parsers/templateSerializer'
// 委派共享类型（T6 自旧调度类型文件迁移；旧调度路径已删除）
export {
  SubtaskStatus,
  type AvailableSubagent,
  type AvailableModel,
  type ToolMetadata,
} from './orchestrator/types'
export * from './orchestrator/executor/TaskExecutor'
export * from './orchestrator/executor/RemoteExecutorAdapter'
export * from './execution/ISubagentExecutor'
export * from './execution/SubagentExecutor'
export * from './services/mcp'
export * from './services/builtInTools'
export * from './services/toolExecutorRegistry'
export * from './services/builtInToolExecutor'
export * from './services/toolExecutors'
export * from './services/toolExecutorFactory'
export * from './services/resourceToolAdapter'
export * from './services/a2aClient'
export * from './services/coze/CozeAgentAdapter'
export * from './services/selectedModelsService'
export * from './services/memory'
export * from './services/knowledge'
export * from './services/improvementProposer'
export * from './services/improvementLedger'
export * from './services/ImprovementProposalManager'
export * from './services/agentInstructions'
export * from './services/secureStorageService'
export * from './services/models'
export * from './services/codeExecutor'
export * from './services/mcpAutoReconnect'
// 会话标题工具（纯逻辑无 node 依赖，渲染进程可用）
export * from './services/sessionTitleService'
// task 委派工具（T1）：执行依赖 TaskExecutor 注入的适配器（渲染进程经 IPC 路由），无需 requiresNodeFs；
// delegationPrompt 为纯格式化逻辑
export * from './services/delegation/delegationTools'
export * from './services/delegation/resolveCancelTarget'
export * from './services/delegation/quota'
export * from './services/team/teamPolicy'
export * from './services/team/teamWatchdog'
export * from './services/delegation/taskRegistry'
export * from './services/delegation/workflowRunTool'
export * from './services/delegation/delegationPrompt'
export * from './services/approvals'
export * from './services/askChannel'
// 多会话基座（迭代 1）：SessionRegistry 纯容器 + SessionScope 归因上下文（Node-free，双入口可导出）
export * from './services/sessionRegistry'
export * from './services/approvalPresentation'
export * from './services/writeBoundary'
export * from './services/backupStore'
// 生命周期 hooks（阶段 1）：平台无关（执行通道 IHookProcessRunner 由壳层注入），渲染进程可安全导入
export * from './services/hooks'
// 定时任务（阶段 1）：平台无关（TaskStore 走 IFileSystemProvider 抽象），渲染进程可安全导入
export * from './services/scheduler'
// ChatEngine 统一对话路径（T2）：引擎本体/上下文组装/媒体处理/委派指南均为平台无关代码，
// 渲染进程可安全导入；Node 侧装配（nodeFactory）含 fs 依赖，仅从 index.ts 导出
export * from './engine'
export * from './services/mediaContentBuilder'
// 文件引用管线（T2 渲染端采集/预览）：SPILL_PREVIEW_CHARS 等预算常量（fs 仅 shim 探测，同 writeBoundary 先例）
export * from './services/toolResultGuard'
// relay 模块（红线：services/relay/** Node-free）——渲染端 relayService（M2a）需要；relay.lock 租约不进渲染端
export * from './services/relay/envelope'
export * from './services/relay/PairingManager'
export * from './services/relay/RelayBridge'
export * from './services/relay/RelayTransport'
// M4/M6/M7 装配面放宽（UI relayService 全量 wiring 需要）：装配函数只触 eventBus / ApprovalChannel /
// AskChannel / builtInToolExecutor / 桥方法（均已入本 barrel 或经 shim 兜底），渲染端可安全 import；
// 触 fs 的组包（buildCatalogStateBody 内 buildCatalog）与 fs.watch（wireSessionCatalogWatch）仍仅
// Node 主入口——UI 的 buildCatalogState 经 electron IPC 回主进程调同一函数，目录监听在主进程装配。
export {
  makeResolveApproval,
  makeListPendingApprovals,
  makeListRecentSettledApprovals,
  makeResolveAsk,
  makeListPendingAsks,
  makeListRecentSettledAsks,
  makeBoardSyncBridgeDeps,
  makeSessionSyncBridgeDeps,
  makeRecoveryBridgeDeps,
  makeFileTransferBridgeDeps,
  makeGetCommandState,
  makeExecuteCommand,
  wireCommandState,
  wireApprovalChannel,
  wireToolStatus,
  wireBeatBoundary,
  wireAskChannel,
  wirePermissionMode,
  wireTurnStream,
  wireHistoryInvalidated,
  wireTurnSettled,
  wireBoard,
  wireWorkPlan,
  makeWorkPlanSyncBridgeDeps,
  wireFeedSubagent,
} from './services/relayEngineWiring'
// M7 看板服务（UI sessionBoardService 装配用：ElectronIPCBoardStore 注入 + ask 联动接线）；
// 仅触 boardStore 接口/AskChannel/eventBus——boardStore 的 fs 经 shim 兜底（调用面在主进程 IPC）
export { SessionBoardService, getSessionBoardService, setSessionBoardService } from './services/board/SessionBoardService'
export { wireBoardAskBridge } from './services/board/boardAskBridge'
export type { BoardItemStatus, BoardState } from './services/board/boardTypes'
export type { SessionBoardStore } from './services/board/boardStore'
export type { SessionSearchHit } from './services/sessionSearch'
export type { SubagentTemplate } from './orchestrator/types'
export type { WorkerMcpHookCall } from './services/hooks/workerMcpHooks'
export type {
  ICodeExecutor,
  InteractiveCallbacks,
  InteractiveResult,
  ProcessOperationResult,
} from './execution/ICodeExecutor'
export type { ExecutionOptions, ExecutionResult } from './execution/types'
export type { PowerShellOptions, PowerShellResult } from './execution/PowerShellExecutor'
export * from './workflow/shared'
export * from './workflow/TaskListManager'
export * from './workflow/workflowGraphBuilder'
export * from './workflow/agentNodeExecutor'
export * from './workflow/workflowExecutor'
// 命名工作流 DSL + 加载层(M1):平台无关代码,UI 画布双向同构/侧栏列表直接使用
export * from './workflow/dsl/types'
export * from './workflow/dsl/workflowParser'
export * from './workflow/dsl/workflowSerializer'
export * from './services/assets/assetDirectory'
export * from './services/workflow/WorkflowTemplateService'
export * from './services/workflow/workflowRunStore'
// 固定团队(M1):DSL + 加载层 + use_team 工具(全部 Node-free)
export * from './team/types'
export * from './team/teamSerializer'
export * from './services/team/TeamTemplateService'
export * from './services/team/useTeamTool'
export * from './services/team/TeamRuntimeService'
export * from './services/team/teamRuntimeTypes'
// 运行态统一投影与账本格式化(UI 三层显示统一 · "运行"药丸;纯函数 Node-free)
export * from './services/team/teamLedgerFormat'
export * from './services/team/runtimeProjection'
export * from './services/team/teamContextLine'
export * from './services/delegation/steerTaskTool'
export * from './services/delegation/escalateTool'
// 仅类型导出：SessionRecord 供 UI 会话管理复用（类型编译期擦除，
// 不会把 SessionPersistence 的 node:fs 实现打进渲染进程包）
export type {
  SessionRecord,
  SessionResult,
  LoadSessionResult,
  ListSessionsResult,
  SessionSummary,
  SaveMode,
  SessionWatchCallback
} from './persistence/SessionPersistence'
// toSessionSummary 是 7 字段提取的纯逻辑函数（模块顶层无 fs 调用），可安全值导出；
// 渲染进程只会调它本身，SessionPersistence 类本体不被实例化（node:fs 为 vite 空 shim）。
// TITLE_SOURCE_PRIORITY 是模块级纯常量（manual > auto > default 的唯一定义），
// UI 列表 upsert 守卫与磁盘 mergeRecord 共用，防语义漂移双源——同模块同先例值导出。
export { toSessionSummary, TITLE_SOURCE_PRIORITY } from './persistence/SessionPersistence'
// 仅类型导出：ProjectRecord 供 UI 项目管理复用（同 SessionPersistence 先例，node:fs 实现不进渲染包）
export type {
  ProjectRecord,
  ProjectResult,
  ListProjectsResult,
  ProjectWatchCallback
} from './persistence/ProjectPersistence'
// Skill 注册表统一编排（装载/重载/过滤规则单点维护；SkillLoader 本体为纯逻辑，不引 node:fs）
export { initializeSkillRegistry, reloadSkillRegistry } from './skills/skillRegistryInitializer'
export type { InitializeSkillRegistryOptions, InitializedSkillRegistry } from './skills/skillRegistryInitializer'
// relay 模块（M2）：红线——services/relay/** 必须保持 Node-free（禁 node:*/Buffer，renderer/RN 安全），按文件导出不用目录 barrel
export * from './services/relay/envelope'
export * from './services/relay/PairingManager'
export * from './services/relay/RelayBridge'
export * from './services/relay/RelayTransport'
export * from './services/relay/relayLock'
// 工作计划树：投影 SSOT 与镜像纯逻辑（纯函数、Node-free）
export * from './services/workplan/workPlanTree'
export * from './services/workplan/workPlanMirror'
// 统一文本匹配引擎（replace/insert/delete_content 共用，Node-free，双壳同一套匹配语义）
export * from './services/positioning/textMatcher'
