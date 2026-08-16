import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  NodePathProvider,
  FileKeyValueStore,
  BuiltInToolExecutor,
  setBuiltInToolExecutor,
  memoryStore,
  memoryDistiller,
  improvementProposer,
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
  mcpAutoReconnectService,
  getTaskExecutor,
  setExecutor,
  MCPConfigPersistence,
  AgentFileManager,
  setA2ASecureStorage,
  BaseModelService,
  openAIChatHandler,
  anthropicChatHandler,
  registerAsyncTaskFamilies,
  LocalAgentTemplateGenerator,
  CozeTemplateGenerator,
  A2ATemplateGenerator,
  FileSystemTemplateLoader,
  findProjectTemplateDirs,
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
  type HookRunnerDeps,
  type HookTrustApprovalRequest,
  type ModelMediaCapabilities,
  type SavedAgent,
  type RemoteAgentConfig,
  type SubagentTemplate,
} from '@assistant-ai/core'
import { NodeFileSystemProvider } from '../adapters/NodeFileSystemProvider.js'
import { NodeHookProcessRunner } from '../adapters/NodeHookProcessRunner.js'
import { NodeFileMtimeProvider } from '../adapters/NodeFileMtimeProvider.js'
import { CLIConfirmationHandler } from '../adapters/CLIConfirmationHandler.js'
import { NativeDesktopController } from '../adapters/NativeDesktopController.js'
import { LineBasedPositionCalculator } from '../adapters/LineBasedPositionCalculator.js'
import { CliCodeExecutorAdapter } from '../adapters/CliCodeExecutorAdapter.js'
import { CLISecureStorage } from '../security/CLISecureStorage.js'
import { CLIMCPClient } from '../mcp/CLIMCPClient.js'
import { resolvePreviewSessions } from '../commands/CliSessionService.js'
import { CliLocalAgentExecutor } from '../adapters/CliLocalAgentExecutor.js'

export class CliContext {
  pathProvider!: NodePathProvider
  fsProvider!: NodeFileSystemProvider
  confirmationHandler!: CLIConfirmationHandler
  positionCalculator!: LineBasedPositionCalculator
  codeExecutor!: CliCodeExecutorAdapter
  secureStorage!: CLISecureStorage
  keyValueStore!: FileKeyValueStore
  mcpConfigPersistence!: MCPConfigPersistence
  mcpClient!: CLIMCPClient
  mcpService!: MCPService
  builtInExecutor!: BuiltInToolExecutor
  desktopController!: NativeDesktopController
  cliSubagentExecutor!: StandardSubagentExecutor
  subagentExecutor!: SubagentExecutor
  agentFileManager!: AgentFileManager
  localAgentExecutor!: CliLocalAgentExecutor
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

  /** 模板加载器（内置目录构造，自定义目录经 loadTemplatesFromDirectory 逐个扫描） */
  private templateLoader!: FileSystemTemplateLoader
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
    memoryDistiller.init(fsProvider, pathProvider)
    improvementProposer.init(fsProvider, pathProvider)
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
      try {
        return await this.hookTrustAsker(req)
      } catch (err) {
        // 询问通道异常按不信任处理（安全默认），不阻断会话流程
        console.warn('【hooks】信任询问异常，按不信任处理:', err)
        return false
      }
    }
    const hookRunnerDeps: HookRunnerDeps = {
      loader: this.hookConfigLoader,
      processRunner: new NodeHookProcessRunner(),
      kv: keyValueStore,
      trustApprover,
    }
    this.hookRunner = new HookRunner(hookRunnerDeps)

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
    // search_sessions 检索目录跟随实际生效的持久化目录（体验窗口 .preview-sessions；
    // 与 CliSessionService 同一解析单一事实源，修正"存 A 搜 B"错位）
    this.builtInExecutor.setSessionsDirOverride(resolvePreviewSessions().sessionsDir ?? null)

    // 桌面能力注入（迭代 1.7/1.8）：原生模块懒加载适配器 + 视觉能力闭包（现读当前模型，中途切换安全；
    // 模型信息缺失返回 undefined 表示未知，core 侧不做视觉过滤）
    this.desktopController = new NativeDesktopController()
    this.builtInExecutor.setDesktopController(this.desktopController)
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

    // 扫描 agents/local/*.json + agents/remote/*.json → generateTemplateObject() → resetRemoteTemplates()
    const agentsDir = join(pathProvider.getUserDataPath(), 'agents')
    const allTemplates: SubagentTemplate[] = []

    // 1. 扫描 agents/local/*.json → LocalAgentTemplateGenerator.generateTemplateObject()
    try {
      const localGenerator = new LocalAgentTemplateGenerator()
      const localDir = join(agentsDir, 'local')
      const localEntries = existsSync(localDir) ? readdirSync(localDir) : []
      for (const file of localEntries) {
        if (!file.endsWith('.json')) continue
        const content = readFileSync(join(localDir, file), 'utf-8')
        const agent = JSON.parse(content) as SavedAgent
        const template = localGenerator.generateTemplateObject(agent)
        allTemplates.push(template)
      }
    } catch (err) {
      console.warn('【CliContext】读取本地 Agent 模板失败:', err)
    }

    // 2. 扫描 agents/remote/*.json → Coze/A2A generateTemplateObject()
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

    // 3. 整体替换 remoteTemplates
    getTemplateManager().resetRemoteTemplates(allTemplates)

    const subagentExecutor = new SubagentExecutor()
    this.subagentExecutor = subagentExecutor

    // AgentFileManager 与 Electron 使用相同的 dataDir（~/.chill），确保 UI 保存的 agent 可被 CLI 读取
    this.agentFileManager = new AgentFileManager(pathProvider)
    this.localAgentExecutor = new CliLocalAgentExecutor(this.agentFileManager)
  }

  registerAll(): void {
    SecureStorageService.initialize(this.secureStorage)
    MCPService.setDefaultClient(this.mcpClient)
    SelectedModelsService.setDefaultStore(this.keyValueStore)
    setBuiltInToolExecutor(this.builtInExecutor)
    SubagentExecutor.setExecutor((...args) => this.cliSubagentExecutor.execute(...args))
    ModelServiceFactory.initialize(this.secureStorage)
    modelInfoService.setSecureStorage(this.secureStorage)
    modelInfoService.setFileSystemProvider(this.fsProvider)
    modelInfoService.setModelsDir(join(this.pathProvider.getUserDataPath(), 'models'))
    providerManager.setFileSystemProvider(this.fsProvider)
    providerManager.setProvidersDir(join(this.pathProvider.getUserDataPath(), 'models'))
    mcpAutoReconnectService.configure(this.mcpConfigPersistence, this.mcpClient)
    getTaskExecutor(this.secureStorage, this.subagentExecutor, this.localAgentExecutor)
    getTaskExecutor().setRemoteAdapter(new RemoteExecutorAdapter(this.secureStorage))
    setA2ASecureStorage(this.secureStorage)
    setExecutor(this.codeExecutor)
    mcpAutoReconnectService.initialize()
  }

  async init(): Promise<this> {
    await this.createAdapters()
    this.registerAll()
    // 硬性顺序：provider Map 先就位（含种子合并与旧格式兼容）；
    // key 文件命名迁移先于 loadAllModels——否则其内部 migrateKeys 会把更旧的 ModelType key
    // 抢在显示名 key 前面迁到同一 id（显示名 key 是较新约定，必须赢）
    await providerManager.loadProviders()
    await runProviderKeyMigration(this.secureStorage)
    await modelInfoService.loadAllModels()

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
    // 解析/读取失败明细逐文件收集，扫完合并打印一条警告（此前静默丢弃，写错的模板无人察觉）
    const loadErrors: string[] = []
    const collectErrors = (errs: string[]) => loadErrors.push(...errs)
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
  }

  /** 监听自定义模板目录（用户级 + 已存在的项目各级）变更，500ms 防抖后重扫 */
  private async startTemplatesWatcher(): Promise<void> {
    if (!this.fsProvider.watch) return
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
}
