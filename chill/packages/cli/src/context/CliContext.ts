import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  NodePathProvider,
  FileKeyValueStore,
  setDelegationQuotaProvider,
  setTeamBudgetDefaultsProvider,
  BackupStore,
  BuiltInToolExecutor,
  setBuiltInToolExecutor,
  memoryStore,
  improvementProposer,
  improvementLedger,
  agentInstructions,
  knowledgeStore,
  MCPService,
  SubagentExecutor,
  AttachmentManager,
  createTemplateManager,
  getTemplateManager,
  SecureStorageService,
  SelectedModelsService,
  ModelServiceFactory,
  modelInfoService,
  providerManager,
  runProviderKeyMigration,
  runKeyStorageMigration,
  mcpAutoReconnectService,
  getTaskExecutor,
  setExecutor,
  MCPConfigPersistence,
  BaseModelService,
  openAIChatHandler,
  anthropicChatHandler,
  registerAsyncTaskFamilies,
  CozeTemplateGenerator,
  A2ATemplateGenerator,
  FileSystemTemplateLoader,
  findProjectTemplateDirs,
  migrateLegacyWorkflowAssets,
  WorkflowTemplateService,
  setWorkflowRunProviders,
  findProjectAssetDirs,
  TeamTemplateService,
  setTeamServiceForIndex,
  TeamRuntimeService, startTeamWatchdog,
  setTeamRuntimeService,
  getTeamRuntimeService,
  SessionBoardService,
  setSessionBoardService,
  wireBoardAskBridge,
  BoardStore,
  buildTeamContextLine,
  isBuiltInTool,
  WorkflowRunStore,
  RemoteExecutorAdapter,
  setWorkerScriptPath,
  setTaskResultPersister,
  StandardSubagentExecutor,
  TemplateSubagentForkManager,
  SkillLoader,
  SkillInstaller,
  getSkillRegistry,
  initializeSkillRegistry,
  reloadSkillRegistry,
  getOwnProjectPaths,
  ModelModality,
  HookRunner,
  HookConfigLoader,
  TaskStore,
  SchedulerService,
  createClaimGate,
  setSessionTaskCleaner,
  registerInstance,
  getLiveInstancePids,
  approvalPendingEnter,
  approvalPendingLeave,
  type HookRunnerDeps,
  type HookTrustApprovalRequest,
  type ModelMediaCapabilities,
  type RemoteAgentConfig,
  type SubagentTemplate,
  PairingManager,
} from '@assistant-ai/core'
import { createCliPairingManager } from '../relay/relayClient.js'
import { NodeFileSystemProvider } from '../adapters/NodeFileSystemProvider.js'

/** 委派限额配置值解析：正整数有效，其余（缺失/非数字/非正）返回 undefined 由 core 回退默认 */
function parsePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}
import { NodeHookProcessRunner } from '../adapters/NodeHookProcessRunner.js'
import { NodeFileMtimeProvider } from '../adapters/NodeFileMtimeProvider.js'
import { CLIConfirmationHandler } from '../adapters/CLIConfirmationHandler.js'
import { NativeDesktopController } from '../adapters/NativeDesktopController.js'
import { NodeDesktopAuditSink } from '../adapters/NodeDesktopAuditSink.js'
import { LineBasedPositionCalculator } from '../adapters/LineBasedPositionCalculator.js'
import { CliCodeExecutorAdapter } from '../adapters/CliCodeExecutorAdapter.js'
import { CLISecureStorage } from '../security/CLISecureStorage.js'
import { CLIMCPClient } from '../mcp/CLIMCPClient.js'
import { resolvePreviewSessions } from '../commands/CliSessionService.js'

export class CliContext {
  pathProvider!: NodePathProvider
  fsProvider!: NodeFileSystemProvider
  confirmationHandler!: CLIConfirmationHandler
  positionCalculator!: LineBasedPositionCalculator
  codeExecutor!: CliCodeExecutorAdapter
  secureStorage!: CLISecureStorage
  /** relay 配对管理（M2；createAdapters 装配，/pair 与 RelayClient 共用） */
  pairingManager!: PairingManager
  keyValueStore!: FileKeyValueStore
  mcpConfigPersistence!: MCPConfigPersistence
  mcpClient!: CLIMCPClient
  mcpService!: MCPService
  builtInExecutor!: BuiltInToolExecutor
  /**
   * 文件备份存储（备份与回滚体系）：集中快照库 ~/.chill/backups/，/restore 的数据源；
   * 与 executor 同一实例（setBackupStore 注入，五个文件编辑工具写前快照经它留存）
   */
  backupStore!: BackupStore
  desktopController!: NativeDesktopController
  /** 桌面审计 sink（~/.chill/desktop-audit/ 落盘；/desktop log 经它取今日文件路径） */
  desktopAuditSink!: NodeDesktopAuditSink
  /** 实例注册表（多实例互攻防护）：注销函数与兄弟 PID 推送定时器 */
  private unregisterInstance?: () => void
  private instanceRegistryTimer?: NodeJS.Timeout
  cliSubagentExecutor!: StandardSubagentExecutor
  subagentExecutor!: SubagentExecutor
  skillLoader!: SkillLoader
  skillInstaller!: SkillInstaller
  /** hooks 系统（阶段 1）：用户级 ~/.chill/hooks.json 的加载器与运行器（/hooks 命令与引擎装配共用） */
  hookRunner!: HookRunner
  hookConfigLoader!: HookConfigLoader
  hooksConfigPath!: string
  /**
   * 项目级 hook 信任询问通道（阶段 2）：cli.ts 在显示层（rl/TUI）就位后注入；
   * -p 非交互模式不注入——trustApprover 收不到应答通道时拒绝并警告，core 侧跳过该 hook
   */
  hookTrustAsker?: (req: HookTrustApprovalRequest) => Promise<boolean>

  /**
   * 定时任务（阶段 1）：任务清单持久化（~/.chill/scheduled-tasks.json）与调度服务。
   * /schedule 命令与引擎装配（deps.scheduler）共用同一实例；onFire 由引擎接线接管
   */
  taskStore!: TaskStore
  scheduler!: SchedulerService
  scheduledTasksPath!: string

  /** 模板加载器（内置目录构造，自定义目录经 loadTemplatesFromDirectory 逐个扫描） */
  private templateLoader!: FileSystemTemplateLoader
  /** 命名工作流加载层(M5;run_workflow 工具与 /workflows 列表的数据源) */
  public workflowTemplateService!: WorkflowTemplateService
  /** 固定团队加载层(M1;use_team 工具与团队索引的数据源) */
  public teamTemplateService!: TeamTemplateService
  /** 工作流运行记录存储(M6 断点续跑) */
  public workflowRunStore!: WorkflowRunStore
  /** 工作流节点工具执行器(统一决策管线入口;run_workflow 与 CLI /workflow run 共用) */
  public workflowToolRunner = async (
    toolName: string,
    params: Record<string, any>,
    meta: { runId: string },
  ): Promise<{ success: boolean; data?: any; error?: string }> => {
    if (isBuiltInTool(toolName)) {
      // 统一决策管线(Worker 咽喉同款 __origin 注入):审批/hooks/门全过,归属标记为工作流运行
      const argsWithOrigin = {
        ...params,
        __origin: { source: 'subagent' as const, subagentType: 'workflow', taskId: meta.runId },
      }
      const result = await this.builtInExecutor.executeAsync(toolName, JSON.stringify(argsWithOrigin), meta.runId)
      return { success: result.success, data: result.data, error: result.error }
    }
    // MCP 工具:经 MCP 服务直调(与 Worker 网关 mcp 分支同通道)
    const result = await this.mcpService.executeToolCall({ function: { name: toolName, arguments: params } }, [])
    return { success: true, data: result }
  }
  /** 用户级自定义模板目录（~/.chill/agents/templates/），初始化时确保存在 */
  private userTemplatesDir!: string

  private builtinTemplatesDir: string
  private builtinSkillsDir: string
  private workDir: string
  /** npm 模式（无源码环境）：self-iterate 技能需从注册表移除（/skill reload 等外部编排也需读取） */
  isNpmMode = false
  constructor(workDir: string) {
    this.workDir = workDir
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)

    // 模板目录候选（esbuild bundle 后 dist/cli.js 单文件，__dirname=dist；
    // 兼容旧 tsc 布局（dist/context 下）与 monorepo 源码兜底）
    this.builtinTemplatesDir = this.resolveFirstExisting([
      join(__dirname, 'templates/builtin'),
      join(__dirname, '../templates/builtin'),
      join(__dirname, '../..', 'packages/core/src/orchestrator/templates/builtin'),
      join(__dirname, '../../../..', 'packages/core/src/orchestrator/templates/builtin'),
    ], join(__dirname, 'templates/builtin'))

    this.builtinSkillsDir = this.resolveFirstExisting([
      join(__dirname, 'skills/builtin'),
      join(__dirname, '../skills/builtin'),
      join(__dirname, '../..', 'packages/core/src/skills/builtin'),
      join(__dirname, '../../../..', 'packages/core/src/skills/builtin'),
    ], join(__dirname, 'skills/builtin'))
  }

  /** 返回首个存在的候选路径；都不存在时返回 fallback（后续读取失败会按空目录降级） */
  private resolveFirstExisting(candidates: string[], fallback: string): string {
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return fallback
  }

  async createAdapters(): Promise<void> {
    BaseModelService.registerProtocolHandler('openai-chat', openAIChatHandler)
    registerAsyncTaskFamilies((p, h) => BaseModelService.registerProtocolHandler(p, h))
    BaseModelService.registerProtocolHandler('anthropic-messages', anthropicChatHandler)

    const pathProvider = new NodePathProvider()
    this.pathProvider = pathProvider
    AttachmentManager.initialize(pathProvider)

    // 委派结果兜底（core adoptTaskResult 的宿主注入）：超 400KB 的 subagent 报告全文落盘。
    // 文件名带时间戳前缀——toolCallId 跨会话可能重复；非法文件名字符防御性替换
    setTaskResultPersister((toolCallId, text) => {
      const dir = join(pathProvider.getUserDataPath(), 'task-results')
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, `${Date.now()}-${toolCallId.replace(/[\\/:*?"<>|]/g, '_')}.md`)
      writeFileSync(filePath, text, 'utf8')
      return filePath
    })

    const fsProvider = new NodeFileSystemProvider(this.workDir)
    this.fsProvider = fsProvider
    memoryStore.init(fsProvider, pathProvider)
        improvementProposer.init(fsProvider, pathProvider)
    // 改进提案账本唯一读写入口（决策闭环：/improve、账本行、manage_improvements 共用）
    improvementLedger.init(fsProvider, pathProvider)
    agentInstructions.init(fsProvider, pathProvider)
    // 知识库存储初始化（~/.chill/knowledge/；与 memoryStore 同一注入模式）
    knowledgeStore.init(fsProvider, pathProvider)

    const confirmationHandler = new CLIConfirmationHandler()
    this.confirmationHandler = confirmationHandler

    const positionCalculator = new LineBasedPositionCalculator()
    this.positionCalculator = positionCalculator

    const codeExecutor = new CliCodeExecutorAdapter()
    this.codeExecutor = codeExecutor

    const secureStorage = new CLISecureStorage()
    this.secureStorage = secureStorage

    // relay 配对管理（M2）：设备密钥对/配对记录/QR 与轮询状态机（core 纯逻辑，Node 存储适配在此注入）
    this.pairingManager = createCliPairingManager({
      secureStorage,
      userDataPath: pathProvider.getUserDataPath(),
    })

    const keyValueStore = new FileKeyValueStore(join(pathProvider.getUserDataPath(), 'state.json'))
    this.keyValueStore = keyValueStore

    // hooks 系统装配（阶段 1：用户级 ~/.chill/hooks.json 单层级；阶段 2：项目级 .agents/hooks.json + 哈希信任）：
    // loader 立于 fsProvider 之上（仿 FileSystemTemplateLoader），mtime 惰性重载靠 Node fs.stat；
    // 执行通道为本地 child_process spawn（UI 侧另由 electron 主进程 IPC 实现同一 IHookProcessRunner）；
    // 启用/禁用状态由 HookRunner 存 state.json KV（键 hooks.disabled，仿 skills.disabled 先例）；
    // trustApprover（阶段 2 契约）：core 检测到项目级新/变更 hook 时回调——有应答通道（交互模式，
    // cli.ts 注入 hookTrustAsker）则转交询问 UI；无通道（-p 非交互/显示层未就位）拒绝，
    // 跳过与警告由 core 统一处理（HOOK_MESSAGE 事件 + 触发记录 skipped-untrusted）
    this.hooksConfigPath = join(pathProvider.getUserDataPath(), 'hooks.json')
    this.hookConfigLoader = new HookConfigLoader(fsProvider, this.hooksConfigPath, new NodeFileMtimeProvider(), {
      // 项目级 .agents/hooks.json 从 workDir 向上递归发现；kv 供信任记录（hooks.trusted）读写
      workDir: this.workDir,
      kv: keyValueStore,
    })
    const trustApprover = async (req: HookTrustApprovalRequest): Promise<boolean> => {
      // 无应答通道（-p 非交互/显示层未就位）：拒绝，警告由 core 统一抛出（HOOK_MESSAGE → stderr）
      if (!this.hookTrustAsker) return false
      // 审批挂起聚合（自审批防护：hook 信任询问期间对 chill 窗口的点击/键入被原生层拦截）
      approvalPendingEnter()
      try {
        return await this.hookTrustAsker(req)
      } catch (err) {
        // 询问通道异常按不信任处理（安全默认），不阻断会话流程
        console.warn('【hooks】信任询问异常，按不信任处理:', err)
        return false
      } finally {
        approvalPendingLeave()
      }
    }
    const hookRunnerDeps: HookRunnerDeps = {
      loader: this.hookConfigLoader,
      processRunner: new NodeHookProcessRunner(),
      kv: keyValueStore,
      trustApprover,
    }
    this.hookRunner = new HookRunner(hookRunnerDeps)

    // 定时任务装配（阶段 1）：TaskStore 走 fsProvider（原子写 tmp+rename 经 NodeFileSystemProvider.renameFile，
    // 与 core IFileSystemProvider.renameFile 契约一致）+ NodeFileMtimeProvider 惰性重载；
    // onFire 缺省无操作——触发回调/活跃上下文 getter/时钟循环由引擎接线经 setOnFire/setActiveContext/start
    // 接管（deps.scheduler 注入同一实例）；getWorkDir 此处注入作 project scope 匹配的兜底数据源
    this.scheduledTasksPath = join(pathProvider.getUserDataPath(), 'scheduled-tasks.json')
    this.taskStore = new TaskStore(fsProvider, this.scheduledTasksPath, new NodeFileMtimeProvider())
    // M6 跨进程触发抢占闸：claim 目录由 createFileExclusive 内建（dirname 缺失即 mkdirSync
    // recursive）；createFileExclusive 由 NodeFileSystemProvider 提供（O_EXCL）——
    // 未实现该原语的宿主在 createClaimGate 内优雅降级（无闸=乐观判重现状）
    const scheduledClaimsDir = join(pathProvider.getUserDataPath(), 'scheduled-claims')
    this.scheduler = new SchedulerService({
      store: this.taskStore,
      getWorkDir: () => this.workDir,
      claimGate: createClaimGate({ fs: fsProvider, claimsDir: scheduledClaimsDir }),
    })
    // M5 会话删除清账（进程级单槽，照看板归档先例）：CLI/UI/手机三路删除均汇聚
    // SessionPersistence.delete（CliSessionService 持有），此处注入 ctx.scheduler 的清账通道
    setSessionTaskCleaner(async (sessionId) => {
      await this.scheduler.markSessionDeleted(sessionId)
    })

    const mcpConfigPersistence = new MCPConfigPersistence(keyValueStore, secureStorage, fsProvider, join(pathProvider.getUserDataPath(), 'mcp_servers'))
    this.mcpConfigPersistence = mcpConfigPersistence

    const mcpClient = new CLIMCPClient()
    this.mcpClient = mcpClient
    const mcpService = new MCPService(mcpClient)
    this.mcpService = mcpService

    // npm 模式（无源码环境）下 projectPath 为 null，sourceRootOverride 回退为 undefined 走默认推断
    const projectPath = getOwnProjectPaths().projectPath
    const builtInExecutor = new BuiltInToolExecutor(fsProvider, confirmationHandler, positionCalculator, codeExecutor, projectPath ?? undefined)
    this.builtInExecutor = builtInExecutor
    this.builtInExecutor.setMCPDependencies(this.mcpConfigPersistence, this.mcpClient)
    this.builtInExecutor.setConfigStore(this.keyValueStore)
    // 委派资源限额（P1.6）：provider 注入，从 configStore 读 delegation_max_concurrent /
    // delegation_max_cumulative（/limits 命令写同一对键；未设置/非法值由 core 回退默认 6/200）
    setDelegationQuotaProvider(() => ({
      maxConcurrent: parsePositiveInt(this.keyValueStore.getItem('delegation_max_concurrent')),
      maxCumulative: parsePositiveInt(this.keyValueStore.getItem('delegation_max_cumulative')),
    }))
    // 团队默认预算(原子化协作迭代 3):provider 注入,读 team_budget_max_members /
    // team_budget_max_tokens / team_budget_max_depth(未设置=不限;/limits 与 UI 设置页同键)
    setTeamBudgetDefaultsProvider(() => ({
      maxMembers: parsePositiveInt(this.keyValueStore.getItem('team_budget_max_members')),
      maxTokens: parsePositiveInt(this.keyValueStore.getItem('team_budget_max_tokens')),
      maxDepth: parsePositiveInt(this.keyValueStore.getItem('team_budget_max_depth')),
    }))
    // search_sessions 检索目录跟随实际生效的持久化目录（体验窗口 .preview-sessions；
    // 与 CliSessionService 同一解析单一事实源，修正"存 A 搜 B"错位）
    this.builtInExecutor.setSessionsDirOverride(resolvePreviewSessions().sessionsDir ?? null)

    // 文件备份存储（备份与回滚体系）：集中快照库根 = ~/.chill/backups（与 sessions/models 同一数据根，
    // CLI/UI 两端天然共享）；归因上下文经 executor 公开的 getBackupAttributionContext() 现读——
    // 引擎注册的闭包在写入发生时刻返回当前 sessionId/turnId（闭包未注册时退化为空 sessionId，
    // core 侧只写 per-file 快照、不写会话索引，文件级恢复仍可用）
    this.backupStore = new BackupStore({
      fs: fsProvider,
      rootDir: () => join(pathProvider.getUserDataPath(), 'backups'),
      context: () => builtInExecutor.getBackupAttributionContext(),
    })
    builtInExecutor.setBackupStore(this.backupStore)

    // 桌面能力注入（迭代 1.7/1.8）：原生模块懒加载适配器 + 视觉能力闭包（现读当前模型，中途切换安全；
    // 模型信息缺失返回 undefined 表示未知，core 侧不做视觉过滤）。
    // shadowDir 注入（~/.chill/native-shadow/）→ Windows 下 .node 经影子加载，不锁安装树/workcopy
    this.desktopController = new NativeDesktopController(join(pathProvider.getUserDataPath(), 'native-shadow'))
    this.builtInExecutor.setDesktopController(this.desktopController)
    // 桌面审计留痕注入（~/.chill/desktop-audit/；开关 configStore 键 desktop_audit，默认 on）
    this.desktopAuditSink = new NodeDesktopAuditSink(pathProvider)
    this.builtInExecutor.setDesktopAuditSink(this.desktopAuditSink)
    // 实例注册表（多实例互攻防护）：登记本实例 + 周期性把兄弟实例根 PID 推给原生保护集
    // （CLI+UI 同时运行时，彼此的窗口互为宿主禁区——AGENTS.md 用户角度 3 的桌面安全对应面）
    this.unregisterInstance = registerInstance(pathProvider.getUserDataPath(), 'cli')
    const pushSiblingPids = () => {
      void this.desktopController.setProtectedExtraPids(getLiveInstancePids(pathProvider.getUserDataPath())).catch(() => { /* 防护增强失败不阻断主流程 */ })
    }
    pushSiblingPids()
    this.instanceRegistryTimer = setInterval(pushSiblingPids, 30_000)
    this.instanceRegistryTimer.unref()
    process.once('exit', () => this.unregisterInstance?.())
    this.builtInExecutor.setMediaCapabilitiesProvider((): ModelMediaCapabilities | undefined => {
      const modelName = SelectedModelsService.getInstance().getCurrentModelName()
      if (!modelName) return undefined
      const info = modelInfoService.getModelInfoByName(modelName)
      if (!info?.supportedModalities) return undefined
      return {
        supportsImage: info.supportedModalities.includes(ModelModality.IMAGE),
        supportsVideo: info.supportedModalities.includes(ModelModality.VIDEO),
      }
    })

    const cliSubagentExecutor = new StandardSubagentExecutor(secureStorage, () => new TemplateSubagentForkManager(mcpService, (n, a, id) => builtInExecutor.executeAsync(n, a, id)))
    this.cliSubagentExecutor = cliSubagentExecutor

    const templateLoader = new FileSystemTemplateLoader(fsProvider, this.builtinTemplatesDir)
    this.templateLoader = templateLoader
    createTemplateManager(templateLoader)
    await getTemplateManager().initialize()

    // 用户级模板目录（~/.chill/agents/templates/）目前无人创建，先 mkdir 再扫描/挂 watcher，
    // 否则 fs.watch 会抛 ENOENT；项目级 .agents/agents/ 不主动创建（不污染用户项目）
    this.userTemplatesDir = join(pathProvider.getUserDataPath(), 'agents/templates')
    if (!existsSync(this.userTemplatesDir)) {
      mkdirSync(this.userTemplatesDir, { recursive: true })
    }
    // 初始扫描自定义模板：用户级 + 项目各级目录（近→远、同名 subagent_type 先到先得）
    await this.rescanCustomTemplates()

    // 旧资产一次性迁移(M3):SavedWorkflow + 多节点 SavedAgent → YAML 命名工作流
    // 须在下方 agents/local 模板扫描之前执行(迁移成功的源文件已删,不再注册 local-* 模板)
    try {
      const workflowsDir = join(pathProvider.getUserDataPath(), 'workflows')
      if (!existsSync(workflowsDir)) {
        mkdirSync(workflowsDir, { recursive: true })
      }
      const migrationReport = await migrateLegacyWorkflowAssets(fsProvider, {
        legacyWorkflowsDir: workflowsDir,
        legacyAgentsDir: join(pathProvider.getUserDataPath(), 'agents', 'local'),
        targetDir: workflowsDir,
        templatesDir: join(pathProvider.getUserDataPath(), 'agents', 'templates'),
      })
      if (migrationReport.migrated.length > 0) {
        console.log(`【工作流迁移】成功 ${migrationReport.migrated.length} 项:`, migrationReport.migrated)
      }
      for (const err of migrationReport.errors) {
        console.warn('【工作流迁移】', err)
      }
    } catch (err) {
      console.warn('【工作流迁移】执行失败(不影响启动):', err)
    }

    // 命名工作流(M5):加载层装配 + run_workflow 提供者注入 + 目录监听
    this.workflowTemplateService = new WorkflowTemplateService(
      fsProvider,
      join(pathProvider.getUserDataPath(), 'workflows'),
    )
    await this.workflowTemplateService.initialize(this.workDir)
    // 运行记录存储(M6 断点续跑;tmp+rename 原子写)
    const workflowRunsDir = join(pathProvider.getUserDataPath(), 'workflow-runs')
    if (!existsSync(workflowRunsDir)) {
      mkdirSync(workflowRunsDir, { recursive: true })
    }
    this.workflowRunStore = new WorkflowRunStore(fsProvider, workflowRunsDir)
    for (const err of this.workflowTemplateService.getErrors()) {
      console.warn('【工作流】', err)
    }
    setWorkflowRunProviders({
      getService: () => this.workflowTemplateService,
      toolRunner: this.workflowToolRunner,
      getRunStore: () => this.workflowRunStore,
    })
    await this.startWorkflowsWatcher()

    // 固定团队(M1):加载层装配 + use_team/团队索引单例注入 + 目录监听
    const userTeamsDir = join(pathProvider.getUserDataPath(), 'teams')
    if (!existsSync(userTeamsDir)) {
      mkdirSync(userTeamsDir, { recursive: true })
    }
    this.teamTemplateService = new TeamTemplateService(fsProvider, userTeamsDir)
    await this.teamTemplateService.initialize(this.workDir)
    for (const err of this.teamTemplateService.getErrors()) {
      console.warn('【团队】', err)
    }
    setTeamServiceForIndex(this.teamTemplateService)
    await this.startTeamsWatcher(userTeamsDir)

    // 团队运行时(迭代 1:花名册+共享看板;进程内单例,无 watcher——运行时非资产)
    const teamRunsDir = join(pathProvider.getUserDataPath(), 'team-runs')
    if (!existsSync(teamRunsDir)) {
      mkdirSync(teamRunsDir, { recursive: true })
    }
    setTeamRuntimeService(new TeamRuntimeService(fsProvider, teamRunsDir))
    startTeamWatchdog() // 团队探测器(迭代 4:停滞/冲突/预算异常 → 解冻唤醒 lead)

    // 会话级共享看板(V1.5:boardId=sessionId;内存为真相 + ~/.chill/boards 落盘快照;settle 桥/板工具经单例取用)
    setSessionBoardService(new SessionBoardService(new BoardStore(join(pathProvider.getUserDataPath(), 'boards'))))
    wireBoardAskBridge() // V3.2 ask↔条目联动(挂起→blocked / 落定·跳过→unblock / 死亡→ask 失效)

    // 初始化Skill注册表（统一编排；npm 模式过滤 self-iterate 规则在 core 单点维护）
    this.isNpmMode = projectPath === null
    const { skillLoader, errors } = await initializeSkillRegistry({
      fsProvider,
      pathProvider,
      workDir: this.workDir,
      builtinSkillsDir: this.builtinSkillsDir,
      persistence: keyValueStore,
      filterSelfIterate: this.isNpmMode,
    })
    this.skillLoader = skillLoader
    this.skillInstaller = new SkillInstaller(fsProvider, pathProvider, skillLoader, getSkillRegistry())
    builtInExecutor.setSkillInstaller(this.skillInstaller)
    for (const err of errors) {
      console.warn('【Skill】', err)
    }

    // 设置 Worker 脚本路径（CLI 环境无 Electron resourcesPath）
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const workerPathCandidates = [
      // esbuild bundle 布局（npm 包与 monorepo dev 一致）：dist/workers/ 自包含 worker
      join(__dirname, 'workers/GenericSubagentWorker.js'),
      // 旧 tsc 布局兜底（dist/context 下）
      join(__dirname, '../workers/GenericSubagentWorker.js'),
      // 更早的非自包含布局兜底（依赖 core dist 树 / node_modules）
      join(__dirname, '../../../core/dist/orchestrator/isolation/workers/GenericSubagentWorker.js'),
      join(__dirname, '../../node_modules/@assistant-ai/core/dist/orchestrator/isolation/workers/GenericSubagentWorker.js'),
    ]
    for (const candidate of workerPathCandidates) {
      if (existsSync(candidate)) {
        setWorkerScriptPath(candidate)
        break
      }
    }

    // 扫描 agents/remote/*.json → Coze/A2A generateTemplateObject() → resetRemoteTemplates()
    //（本地 SavedAgent 资产已随旧体系退役删除：启动时一次性迁移为 YAML 工作流/单 Agent 模板，
    //  迁移后的源文件已删，agents/local 不再扫描）
    const agentsDir = join(pathProvider.getUserDataPath(), 'agents')
    const allTemplates: SubagentTemplate[] = []

    try {
      const cozeGenerator = new CozeTemplateGenerator()
      const a2aGenerator = new A2ATemplateGenerator()
      const remoteDir = join(agentsDir, 'remote')
      const remoteEntries = existsSync(remoteDir) ? readdirSync(remoteDir) : []
      for (const file of remoteEntries) {
        if (!file.endsWith('.json')) continue
        const content = readFileSync(join(remoteDir, file), 'utf-8')
        const config = JSON.parse(content) as RemoteAgentConfig
        const template = config.type === 'coze'
          ? await cozeGenerator.generateTemplateObject(config)
          : await a2aGenerator.generateTemplateObject(config)
        allTemplates.push(template)
      }
    } catch (err) {
      console.warn('【CliContext】读取远程 Agent 模板失败:', err)
    }

    // 2. 整体替换 remoteTemplates
    getTemplateManager().resetRemoteTemplates(allTemplates)

    const subagentExecutor = new SubagentExecutor()
    this.subagentExecutor = subagentExecutor
  }

  registerAll(): void {
    SecureStorageService.initialize(this.secureStorage)
    MCPService.setDefaultClient(this.mcpClient)
    SelectedModelsService.setDefaultStore(this.keyValueStore)
    setBuiltInToolExecutor(this.builtInExecutor)
    SubagentExecutor.setExecutor((...args) => this.cliSubagentExecutor.execute(...args))
    // 团队状态上下文注入(迭代 1):Lead 主会话每轮头部 SYSTEM 一行团队状态;Worker/workflow 不经此装配,天然不注入
    ModelServiceFactory.initialize(this.secureStorage, undefined, undefined, () =>
      buildTeamContextLine(getTeamRuntimeService()?.getActiveTeam()),
    )
    modelInfoService.setSecureStorage(this.secureStorage)
    modelInfoService.setFileSystemProvider(this.fsProvider)
    modelInfoService.setModelsDir(join(this.pathProvider.getUserDataPath(), 'models'))
    modelInfoService.setKeyValueStore(this.keyValueStore)
    providerManager.setFileSystemProvider(this.fsProvider)
    providerManager.setProvidersDir(join(this.pathProvider.getUserDataPath(), 'models'))
    mcpAutoReconnectService.configure(this.mcpConfigPersistence, this.mcpClient)
    getTaskExecutor(this.secureStorage, this.subagentExecutor)
    getTaskExecutor().setRemoteAdapter(new RemoteExecutorAdapter(this.secureStorage))
    setExecutor(this.codeExecutor)
    mcpAutoReconnectService.initialize()
  }

  async init(): Promise<this> {
    await this.createAdapters()
    this.registerAll()
    // 硬性顺序：provider Map 先就位（含种子合并与旧格式兼容）；
    // 备份先于一切改名（版本回滚是一等旅程）；key 文件命名迁移先于 loadAllModels——否则其内部
    // migrateKeys 会把更旧的 ModelType key 抢在显示名 key 前面迁到同一 id（显示名 key 是较新约定，必须赢）；
    // 存储键编码改名与 key 归位在 loadAllModels 之后（须先完成两级旧名归一）
    await providerManager.loadProviders()
    ;(this.secureStorage as { backupKeysDir?: () => { name: string; created: boolean } | null }).backupKeysDir?.()
    await runProviderKeyMigration(this.secureStorage)
    await modelInfoService.loadAllModels()
    await runKeyStorageMigration(this.secureStorage)

    // 如果还没有注册的模型，启动 Initialize New Model 流程
    const models = modelInfoService.getAllModelInfos()
    if (models.length === 0) {
      console.log('【CliContext】未检测到已注册的 AI 模型，启动初始化流程...')
      // TODO: 集成 readline 创建一个简单的 CLI 配置流程
    }

    // 确保 providers 子目录存在
    const providersDir = join(this.pathProvider.getUserDataPath(), 'models')
    try {
      if (!existsSync(providersDir)) {
        // 通过 providerManager 的文件系统提供者创建
        const fs = (providerManager as any).getFileSystemProvider?.()
        if (fs) {
          fs.mkdir(providersDir, { recursive: true })
        }
      }
    } catch (err) {
      console.warn('【CliContext】创建 providers 目录失败:', err)
    }

    // 监听个人级skills目录变更，自动热重载
    this.startSkillsWatcher()

    // 监听自定义模板目录（用户级 + 已存在的项目各级）变更，自动热重载
    await this.startTemplatesWatcher()

    // 监听模型配置目录变更，自动热重载（外部修改模型 JSON 后无需重启）
    this.startModelsWatcher()

    return this
  }

  /** 监听模型配置目录变更，自动热重载（外部修改模型 JSON 后无需重启） */
  private startModelsWatcher(): void {
    if (!this.fsProvider.watch) return
    const modelsDir = join(this.pathProvider.getUserDataPath(), 'models')
    // 目录不存在时先创建，否则 fs.watch 会抛 ENOENT
    if (!existsSync(modelsDir)) {
      mkdirSync(modelsDir, { recursive: true })
    }
    let reloadTimer: NodeJS.Timeout | null = null

    this.fsProvider.watch(modelsDir, (_event, filename) => {
      if (!filename || !filename.endsWith('.json')) return
      // 防抖：500ms内的变更合并为一次重载
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(async () => {
        try {
          await modelInfoService.reloadFromDisk()
        } catch (err) {
          console.warn('【Model】自动重载失败:', err)
        }
      }, 500)
    })
  }

  /** 监听个人级skills目录变更，自动热重载 */
  private startSkillsWatcher(): void {    if (!this.fsProvider.watch) return
    const skillsDir = join(this.pathProvider.getUserDataPath(), 'skills')
    // 目录不存在时先创建，否则 fs.watch 会抛 ENOENT
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true })
    }
    let reloadTimer: NodeJS.Timeout | null = null

    this.fsProvider.watch(skillsDir, (_event, filename) => {
      if (!filename || !filename.endsWith('.md')) return
      // 防抖：500ms内的变更合并为一次重载
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(async () => {
        try {
          const { skills, errors } = await reloadSkillRegistry(this.skillLoader, { filterSelfIterate: this.isNpmMode })
          console.log(`【Skill】自动重载完成，${skills.length} 个技能`)
          for (const err of errors) {
            console.warn('【Skill】', err)
          }
        } catch (err) {
          console.warn('【Skill】自动重载失败:', err)
        }
      }, 500)
    })
  }

  /** 重扫自定义模板：用户级目录 + 项目各级 .agents/agents/（近→远遍历，同名 subagent_type 先到先得），整体替换进模板管理器 */
  private async rescanCustomTemplates(): Promise<void> {
    // 解析/读取失败明细逐文件收集，扫完合并打印一条警告（此前静默丢弃，写错的模板无人察觉）;
    // 归一化警告(空数组按未声明处理等)同样收集打印
    const loadErrors: string[] = []
    const loadWarnings: string[] = []
    const loadInfos: string[] = []
    const collectErrors = (errs: string[], warns: string[] = [], infos: string[] = []) => {
      loadErrors.push(...errs)
      loadWarnings.push(...warns)
      loadInfos.push(...infos)
    }
    const userTemplates = await this.templateLoader.loadTemplatesFromDirectory(this.userTemplatesDir, collectErrors)
    const projectDirs = await findProjectTemplateDirs(this.fsProvider, this.workDir)
    const seen = new Set<string>()
    const projectTemplates: SubagentTemplate[] = []
    for (const dir of projectDirs) {
      for (const template of await this.templateLoader.loadTemplatesFromDirectory(dir, collectErrors)) {
        if (seen.has(template.subagent_type)) continue
        seen.add(template.subagent_type)
        projectTemplates.push(template)
      }
    }
    getTemplateManager().setCustomTemplates(userTemplates, projectTemplates)
    if (loadErrors.length > 0) {
      console.warn(`【Agent模板】${loadErrors.length} 个模板加载失败:\n${loadErrors.map((e) => `  - ${e}`).join('\n')}`)
    }
    if (loadWarnings.length > 0) {
      console.warn(`【Agent模板】${loadWarnings.length} 条警告:\n${loadWarnings.map((w) => `  - ${w}`).join('\n')}`)
    }
    // 卫生通知(无损归一化)仅日志,不构成警告
    if (loadInfos.length > 0) {
      console.log(`【Agent模板】${loadInfos.length} 条提示:\n${loadInfos.map((i) => `  - ${i}`).join('\n')}`)
    }
  }

  /** 监听自定义模板目录（用户级 + 已存在的项目各级）变更，500ms 防抖后重扫 */
  private async startTemplatesWatcher(): Promise<void> {    if (!this.fsProvider.watch) return
    // 目录不存在时先创建，否则 fs.watch 会抛 ENOENT（初始化时已创建，此处照抄范式再确保一次）
    if (!existsSync(this.userTemplatesDir)) {
      mkdirSync(this.userTemplatesDir, { recursive: true })
    }
    // 项目级只监听启动时已存在的各级目录，不主动创建；运行中新建的 .agents/agents/ 目录重启后生效
    const projectDirs = await findProjectTemplateDirs(this.fsProvider, this.workDir)
    let reloadTimer: NodeJS.Timeout | null = null

    const onChanged = (_event: string, filename: string) => {
      if (!filename || !filename.endsWith('.md')) return
      // 防抖：500ms内的变更合并为一次重扫
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(async () => {
        try {
          await this.rescanCustomTemplates()
        } catch (err) {
          console.warn('【Agent模板】自动重载失败:', err)
        }
      }, 500)
    }

    for (const dir of [this.userTemplatesDir, ...projectDirs]) {
      try {
        this.fsProvider.watch(dir, onChanged)
      } catch (err) {
        // 单个目录监听失败(如枚举后被删除)不拖垮启动,仅告警
        console.warn(`【Agent模板】监听目录失败,已跳过: ${dir}`, err)
      }
    }
  }

  /** 监听工作流目录(用户级 + 项目各级 .agents/workflows/)变更,500ms 防抖后重扫(与模板 watcher 同范式) */
  private async startWorkflowsWatcher(): Promise<void> {
    if (!this.fsProvider.watch) return
    if (!this.workflowTemplateService) return
    const userWorkflowsDir = join(this.pathProvider.getUserDataPath(), 'workflows')
    if (!existsSync(userWorkflowsDir)) {
      mkdirSync(userWorkflowsDir, { recursive: true })
    }
    const projectDirs = await findProjectAssetDirs(this.fsProvider, this.workDir, ['.agents', 'workflows'])
    let reloadTimer: NodeJS.Timeout | null = null

    const onChanged = (_event: string, filename: string) => {
      if (!filename || !filename.endsWith('.yaml')) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(async () => {
        try {
          await this.workflowTemplateService.reload(this.workDir)
          for (const err of this.workflowTemplateService.getErrors()) {
            console.warn('【工作流】', err)
          }
        } catch (err) {
          console.warn('【工作流】自动重载失败:', err)
        }
      }, 500)
    }

    for (const dir of [userWorkflowsDir, ...projectDirs]) {
      try {
        this.fsProvider.watch(dir, onChanged)
      } catch (err) {
        console.warn(`【工作流】监听目录失败,已跳过: ${dir}`, err)
      }
    }
  }

  /** 监听团队目录(用户级 + 项目各级 .agents/teams/)变更,500ms 防抖后重扫(与工作流 watcher 同范式) */
  private async startTeamsWatcher(userTeamsDir: string): Promise<void> {
    if (!this.fsProvider.watch) return
    if (!this.teamTemplateService) return
    const projectDirs = await findProjectAssetDirs(this.fsProvider, this.workDir, ['.agents', 'teams'])
    let reloadTimer: NodeJS.Timeout | null = null

    const onChanged = (_event: string, filename: string) => {
      if (!filename || !filename.endsWith('.yaml')) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(async () => {
        try {
          await this.teamTemplateService.reload(this.workDir)
          for (const err of this.teamTemplateService.getErrors()) {
            console.warn('【团队】', err)
          }
        } catch (err) {
          console.warn('【团队】自动重载失败:', err)
        }
      }, 500)
    }

    for (const dir of [userTeamsDir, ...projectDirs]) {
      try {
        this.fsProvider.watch(dir, onChanged)
      } catch (err) {
        console.warn(`【团队】监听目录失败,已跳过: ${dir}`, err)
      }
    }
  }
}
