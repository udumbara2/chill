import {
  ChatEngine,
  ModelServiceFactory,
  BaseModelService,
  modelInfoService,
  SelectedModelsService,
  memoryStore,
  agentInstructions,
  getSkillRegistry,
  getTemplateManager,
  convertTemplateToAvailableSubagent,
  convertModelInfoToAvailableModel,
  buildLocalAgentResources,
  AttachmentManager,
  TaskListManager,
  saveCurrentGoal,
  archiveCurrentGoal,
  clearCurrentGoal,
  type ChatEngineDeps,
  type SessionStoreAdapter,
} from '@assistant-ai/core'
import type { CliContext } from '../context/CliContext.js'

/**
 * CLI 侧 ChatEngine 装配（T4）：与 core 的 createNodeChatEngine（engine/nodeFactory.ts）同配方，
 * 两点差异：
 * ① sessionStore 由调用方注入——必须与 CliSessionService 共享同一 SessionPersistence 实例
 *   （CLI↔UI 会话同步的 watch 回声过滤/loadIfNewer 锚定依赖同一 lastWrittenMtime 基线，
 *   两个实例会导致引擎自身落盘被误判为对端变更）；
 * ② mediaProvider 接 CLI 本地附件（AttachmentManager fileId→base64）。
 */
export function createCliChatEngine(ctx: CliContext, sessionStore: SessionStoreAdapter): ChatEngine {
  // 目标推进消息的任务清单摘要数据源：事件驱动的轻量只读镜像（与 todoTracker 并列监听，互不影响；
  // 引擎生命周期内常驻，随进程退出回收）
  const taskListManager = new TaskListManager()
  taskListManager.setupEventListeners()
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
    localAgentResources: async () => {
      try {
        const result = await ctx.agentFileManager.listAgents()
        if (!result.success || !result.agents) return []
        return buildLocalAgentResources(result.agents)
      } catch {
        return []
      }
    },
    localAgentExecutor: ctx.localAgentExecutor,
    secureStorage: ctx.secureStorage,
    // 桌面工具开关（1.9 Layer 1 注册过滤）：现读 configStore，/desktop on|off 即时生效（缺省 false=关）
    desktopToolsEnabled: () => ctx.keyValueStore.getItem('desktop_control_enabled') === 'true',
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
  return new ChatEngine(deps)
}
