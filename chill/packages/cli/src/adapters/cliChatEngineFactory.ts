import {
  ChatEngine,
  ModelServiceFactory,
  BaseModelService,
  modelInfoService,
  SelectedModelsService,
  memoryStore,
  knowledgeStore,
  agentInstructions,
  getSkillRegistry,
  getTemplateManager,
  convertTemplateToAvailableSubagent,
  convertModelInfoToAvailableModel,
  AttachmentManager,
  TaskListManager,
  eventBus,
  EVENTS,
  saveCurrentGoal,
  archiveCurrentGoal,
  clearCurrentGoal,
  type ChatEngineDeps,
  type SessionStoreAdapter,
  type ExecutableResource,
  type RemoteAgentConfig,
  type TaskListCreatedEvent,
  DESKTOP_CONTROL_ENABLED_KEY,

  type TaskStatusUpdatedEvent,
  type TaskDeletedEvent,
  type TaskAddedEvent,
} from '@assistant-ai/core'
import { join } from 'path'
import type { CliContext } from '../context/CliContext.js'
import type { SchedulerService } from '@assistant-ai/core'

/** 引擎级 scheduler 装配选项（M3：D7「serve 不注入」语义退役——钟归宿主、创建归属归现场） */
export interface CliEngineSchedulerOptions {
  /** 显式 scheduler 实例（缺省=ctx.scheduler；传 null=完全不注入——serve 形态的退位 chatService 引擎） */
  scheduler?: SchedulerService | null
  /** 启停归壳（true=引擎构造不 start、dispose 不 stop——serve 形态：装配点统一接管启停） */
  ownsScheduler?: boolean
}

/**
 * CLI 侧 ChatEngine 装配（T4）：与 core 的 createNodeChatEngine（engine/nodeFactory.ts）同配方，
 * 两点差异：
 * ① sessionStore 由调用方注入——必须与 CliSessionService 共享同一 SessionPersistence 实例
 *   （CLI↔UI 会话同步的 watch 回声过滤/loadIfNewer 锚定依赖同一 lastWrittenMtime 基线，
 *   两个实例会导致引擎自身落盘被误判为对端变更）；
 * ② mediaProvider 接 CLI 本地附件（AttachmentManager fileId→base64）。
 */
export function createCliChatEngine(
  ctx: CliContext,
  sessionStore: SessionStoreAdapter,
  opts?: CliEngineSchedulerOptions
): ChatEngine {
  return createCliChatEngineWithOptions(ctx, sessionStore, opts)
}

/**
 * serve 多会话装配（M3 定向路由，D7「停钟」语义退役）：注入共享 scheduler——引擎 scope 的
 * getSchedulerContext 返回本引擎本地 workDir/sessionId（创建归属如实）+ ownsScheduler
 * （启停归 serveSessions 装配点）。引擎 ctor 的 onFire/setActiveContext 单槽抢注由
 * serveSessions 在每次引擎构造后统一重绑覆盖（重绑纪律，UI bindSchedulerRouting 同款先例）。
 */
export function createCliChatEngineForServe(
  ctx: CliContext,
  sessionStore: SessionStoreAdapter,
  scheduler: SchedulerService | null
): ChatEngine {
  return createCliChatEngineWithOptions(ctx, sessionStore, { scheduler, ownsScheduler: true })
}

function createCliChatEngineWithOptions(
  ctx: CliContext,
  sessionStore: SessionStoreAdapter,
  opts?: CliEngineSchedulerOptions,
): ChatEngine {
  // 目标推进消息的任务清单摘要数据源：事件驱动的轻量只读镜像（与 todoTracker 并列监听，互不影响；
  // 引擎生命周期内常驻，随进程退出回收）。
  // 工作计划树迭代 0：不走 manager.setupEventListeners（无过滤直订），改为来源过滤后转发——
  // 黑名单制拒 'subagent'（Worker 写入整表覆盖会污染主清单；与 taskListStore 同规则）；
  // undefined/'main'/'mobile'（手机发起轮次的主引擎调用）照收
  const taskListManager = new TaskListManager()
  const acceptSource = (source?: string): boolean => source !== 'subagent'
  eventBus.on(EVENTS.TASK_LIST_CREATED, (e: TaskListCreatedEvent) => {
    if (acceptSource(e.source)) taskListManager.setTasks(e.tasks)
  })
  eventBus.on(EVENTS.TASK_STATUS_UPDATED, (e: TaskStatusUpdatedEvent) => {
    if (acceptSource(e.source)) taskListManager.updateTaskStatus(e.taskId, e.status, e.content, e.result)
  })
  eventBus.on(EVENTS.TASK_DELETED, (e: TaskDeletedEvent) => {
    if (acceptSource(e.source)) taskListManager.setTasks(taskListManager.tasks.filter((t) => t.id !== e.taskId))
  })
  eventBus.on(EVENTS.TASK_ADDED, (e: TaskAddedEvent) => {
    if (acceptSource(e.source)) taskListManager.addTask(e.task)
  })
  const deps: ChatEngineDeps = {
    workDir: process.cwd(),
    builtInToolExecutor: ctx.builtInExecutor,
    mcpService: ctx.mcpService,
    sessionStore,
    // 单次模型调用（引擎自跑工具循环）：与 nodeFactory 的 modelCaller 相同接法——
    // 用户模型参数与 ModelServiceFactory.sendChatMessage 同来源；
    // parameterOverrides（如压缩调用关思考）最后合并，覆盖用户参数
    modelCaller: {
      callOnce: async ({ modelName, messages, tools, streamCallback, abortController, parameterOverrides }) => {
        const info = modelInfoService.getModelInfoByName(modelName)
        if (!info) {
          throw new Error(`模型未注册: ${modelName}`)
        }
        const userParams = {
          ...(SelectedModelsService.getInstance().getModelParameters(modelName) || {}),
          ...parameterOverrides,
        }
        const service = await ModelServiceFactory.getInstance().createModelService(
          info.type,
          userParams,
          modelName
        )
        return (service as BaseModelService).sendSingleMessage(
          messages,
          tools,
          streamCallback,
          abortController
        )
      },
    },
    modelInfo: modelInfoService,
    selectedModels: SelectedModelsService.getInstance(),
    memoryStore,
    knowledgeStore,
    agentInstructions,
    skillRegistry: getSkillRegistry(),
    getSubagents: () => {
      try {
        return getTemplateManager()
          .getAllTemplates()
          .map((t) => convertTemplateToAvailableSubagent(t))
      } catch {
        return []
      }
    },
    getSubagentTemplate: (subagentType) => {
      try {
        return getTemplateManager().getTemplateByType(subagentType)
      } catch {
        return undefined
      }
    },
    getAvailableModels: async () => {
      try {
        const infos = await modelInfoService.getModelsWithApiKeys()
        return infos.map((info) => convertModelInfoToAvailableModel(info))
      } catch {
        return []
      }
    },
    // agent 资源（仅远程 A2A/Coze，execute_remote_agent_* 工具来源）：
    // 现读 ~/.chill/agents/remote/*.json（本地 SavedAgent 资产已退役删除；每轮现读即热生效）
    agentResources: async () => {
      try {
        const remoteDir = join(ctx.pathProvider.getUserDataPath(), 'agents', 'remote')
        const listResult = await ctx.fsProvider.listDirectory(remoteDir)
        if (!listResult.success || !listResult.data) return []
        const files = (listResult.data.files || []) as Array<{ name: string; type: string }>
        const resources: ExecutableResource[] = []
        for (const f of files) {
          if (!f.name.endsWith('.json')) continue
          const readResult = await ctx.fsProvider.readFile(`${remoteDir}/${f.name}`)
          if (!readResult.success || !readResult.data) continue
          const config = JSON.parse(readResult.data.content) as RemoteAgentConfig
          const id = f.name.replace(/\.json$/, '')
          resources.push({
            id,
            name: config.name ?? id,
            description: config.description ?? '',
            type: 'remote_agent',
            config,
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        }
        return resources
      } catch {
        return []
      }
    },
    secureStorage: ctx.secureStorage,
    // 桌面工具开关（1.9 Layer 1 注册过滤）：现读 configStore，/desktop on|off 即时生效（缺省 false=关）
    desktopToolsEnabled: () => ctx.keyValueStore.getItem(DESKTOP_CONTROL_ENABLED_KEY) === 'true',
    // 工具渐进发现开关：现读 configStore 键 progressive_tools，opt-out（读不到/'true'=开，'false'=关），
    // /tools mode on|off 即时生效（与 desktop 的 opt-in 相反，未配置默认开）
    progressiveToolsEnabled: () => ctx.keyValueStore.getItem('progressive_tools') !== 'false',
    // R2 自动压缩开关/阈值：现读键 auto_compact（opt-out，未配置默认开）/ compact_threshold（0-1，非法回退 core 默认 0.8）
    autoCompactEnabled: () => ctx.keyValueStore.getItem('auto_compact') !== 'false',
    autoCompactThreshold: () => Number(ctx.keyValueStore.getItem('compact_threshold')) || 0,
    // 目标模式评估器模型：现读 kvStore defaultEvaluatorModel（缺省/未注册时引擎回退当前会话模型）
    getEvaluatorModelName: () => ctx.keyValueStore.getItem('defaultEvaluatorModel') ?? undefined,
    // goalTick 推进消息的任务清单摘要（只读镜像现取；无任务时返回空串，推进消息不含清单段）
    getTaskStatusSummary: () => taskListManager.buildTaskStatusSummary(),
    // 目标文档落盘（~/.chill/goals/；core 的 goalPersistence，对照 plans 模式）
    goalStore: {
      save: (state) => saveCurrentGoal(state),
      archive: (state) => { archiveCurrentGoal(state) },
      clear: () => clearCurrentGoal(),
    },
    // 熔断请示的用户应答通道：现读 executor 上的 provider（-p 非交互时引擎侧自行退回"发事件+清除"）
    getUserInputProvider: () => ctx.builtInExecutor.getUserInputProvider(),
    mediaProvider: {
      readAsBase64: async (ref) => {
        try {
          return { base64: await AttachmentManager.readAsBase64(ref) }
        } catch {
          return null
        }
      },
    },
  }
  // 生命周期 hooks（阶段 1）：HookRunner 在 CliContext 装配（loader/processRunner/kv 同源）
  deps.hookRunner = ctx.hookRunner ?? null
  // 定时任务（M3 定向路由）：
  // - 交互 CLI（缺省）：scheduler=ctx.scheduler + 引擎 ctor 自动 start（现状逐位不变）；
  // - serve serve 引擎：注入共享实例 + ownsScheduler（启停归 serveSessions 装配点，
  //   引擎只接线 scope 归属——创建如实）；
  // - serve 退位 chatService 引擎：显式传 null（ctor 零接线，不抢注共享单槽）
  deps.scheduler = opts?.scheduler !== undefined ? opts.scheduler : (ctx.scheduler ?? null)
  deps.shellOwnsScheduler = opts?.ownsScheduler === true
  return new ChatEngine(deps)
}
