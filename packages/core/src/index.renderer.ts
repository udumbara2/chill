export * from './types'
export * from './utils/eventBus'
export * from './utils/expressionParser'
export * from './utils/variableResolver'
export * from './utils/textNormalizer'
export * from './utils/workflowEventBus'
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
export * from './services/delegation/taskRegistry'
export * from './services/delegation/delegationPrompt'
export * from './services/approvals'
export * from './services/writeBoundary'
// 生命周期 hooks（阶段 1）：平台无关（执行通道 IHookProcessRunner 由壳层注入），渲染进程可安全导入
export * from './services/hooks'
// ChatEngine 统一对话路径（T2）：引擎本体/上下文组装/媒体处理/委派指南均为平台无关代码，
// 渲染进程可安全导入；Node 侧装配（nodeFactory）含 fs 依赖，仅从 index.ts 导出
export * from './engine'
export * from './services/mediaContentBuilder'
export * from './workflow/shared'
export * from './workflow/TaskListManager'
export * from './workflow/workflowGraphBuilder'
export * from './workflow/workflowExecutor'
// 仅类型导出：SessionRecord 供 UI 会话管理复用（类型编译期擦除，
// 不会把 SessionPersistence 的 node:fs 实现打进渲染进程包）
export type {
  SessionRecord,
  SessionResult,
  LoadSessionResult,
  ListSessionsResult,
  SaveMode,
  SessionWatchCallback
} from './persistence/SessionPersistence'
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
