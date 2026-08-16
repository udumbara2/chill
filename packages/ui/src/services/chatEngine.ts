/**
 * UI 侧 ChatEngine 装配与单例（T5：UI 接入 ChatEngine）
 *
 * 与 CLI 的 cliChatEngineFactory 同配方，按渲染进程裁剪：
 * - 模型调用：直接用 ModelServiceFactory 接线（无 fs 依赖部分，与 nodeFactory 同法）；
 * - sessionStore：走 IPC（session:save 含 SaveMode / session:list 查找），
 *   落盘实际发生在主进程 SessionPersistence（与 CLI 共享 ~/.chill/sessions/）；
 * - mediaProvider：桥 window.electronAPI.readAttachmentAsBase64；
 * - 内置工具执行器：core 单例 builtInToolExecutor（main.ts 已 setBuiltInToolExecutor，
 *   requiresNodeFs 工具经其 nodeToolExecutor 路由到主进程）；
 * - 模板数据源：渲染进程的 getTemplateManager()（经 orchestratorStore.loadTemplates
 *   从主进程 IPC 填充，main.ts 启动时已加载）。
 *
 * 另导出 frontAgent 响应式镜像（ModeSelector 前台选择器绑定用；
 * 引擎状态本身非响应式，会话操作后由 Home.vue 调 syncFrontAgentFromEngine 刷新）。
 */

import { ref } from 'vue'
import {
  ChatEngine,
  ModelServiceFactory,
  BaseModelService,
  modelInfoService,
  SelectedModelsService,
  MCPService,
  builtInToolExecutor,
  memoryStore,
  agentInstructions,
  getSkillRegistry,
  getTemplateManager,
  convertTemplateToAvailableSubagent,
  convertModelInfoToAvailableModel,
  HookConfigLoader,
  HookRunner,
  getWorkerMcpHookDispatcher,
  type WorkerMcpHookCall,
  type ChatEngineDeps,
} from '@assistant-ai/core'
import { loadSession, saveSession } from '@assistant-ai/ui/adapters'
import { IPCKeyValueStore } from '../adapters/IPCKeyValueStore'
import { ElectronIPCFileSystemProvider } from '../adapters/ElectronIPCFileSystemProvider'
import { ElectronIPCHookProcessRunner } from '../adapters/ElectronIPCHookProcessRunner'
import { ElectronIPCHookMtimeProvider } from '../adapters/ElectronIPCHookMtimeProvider'
import { askHookTrust } from '../adapters/RendererHookTrustAsker'
import { rescanProjectTemplates } from './agentTemplateService'
import { ElectronIPCLocalAgentExecutor } from '../adapters/ElectronIPCLocalAgentExecutor'
import { ElectronSecureStorage } from '../adapters/ElectronSecureStorage'
import { useMCPStore } from '../stores/mcpStore'
import { useChatResourceStore } from '../stores/chatResourceStore'
import { useProjectStore } from '../stores/projectStore'
import { useWritingViewStore } from '../stores/writingViewStore'
import { useTaskListStore } from '../stores/taskListStore'

let engine: ChatEngine | null = null
/** 引擎依赖句柄（装配后可微调，如写作目录变化时更新 workDir） */
let engineDeps: ChatEngineDeps | null = null

// ==================== 生命周期 hooks 装配（阶段 3：桌面 UI 支持） ====================
// 与 CLI 的 CliContext 装配同配方，按渲染进程裁剪：
// - loader 立于 ElectronIPCFileSystemProvider（IPC fs 桥）之上，mtime 经 hooks:mtime IPC 探测；
// - 执行通道经 hooks:run IPC 到主进程 child_process（渲染进程无 child_process）；
// - 启用/禁用与信任记录存 state.json KV（IPCKeyValueStore，与 CLI 同一文件、同一批键）；
// - trustApprover 复用 PlanAskDialog 提问通道（RendererHookTrustAsker）；
// - userConfigPath 与 workDir 均为 getter 现读（路径经异步 IPC 后补注入、workDir 随写作目录变化），
//   loader 每次扫描求值，无需重建引擎。

/** 用户级 hooks.json 路径（main.ts 经 getUserDataPath 解析后由 setHooksUserConfigPath 注入） */
let hooksUserConfigPath = ''
/** 引擎单例持有的 loader（hooks:changed 热更新推送的重载入口） */
let hookLoader: HookConfigLoader | null = null

/** 注入用户级 hooks.json 路径（getUserDataPath 解析完成后调用；下一次事件派发即生效） */
export function setHooksUserConfigPath(userDataPath: string): void {
  hooksUserConfigPath = `${userDataPath}/hooks.json`
}

/** 装配 HookConfigLoader + HookRunner（deps.hookRunner；引擎构造时透传到 executor 咽喉与上下文注入器） */
function createHookRunner(): HookRunner {
  const kv = new IPCKeyValueStore()
  const loader = new HookConfigLoader(
    new ElectronIPCFileSystemProvider(),
    () => hooksUserConfigPath,
    new ElectronIPCHookMtimeProvider(),
    { workDir: () => engineDeps?.workDir, kv }
  )
  hookLoader = loader
  return new HookRunner({
    loader,
    processRunner: new ElectronIPCHookProcessRunner(() => engineDeps?.workDir),
    kv,
    trustApprover: askHookTrust,
  })
}

/** 主进程 watch 到 hooks.json 变化（hooks:changed 推送）→ loader 重载（热更新，改配置免重启） */
export function subscribeHooksChanged(): void {
  ;(window.electronAPI as any)?.onHooksChanged?.(() => {
    hookLoader?.checkReload().catch((err) => console.warn('[hooks] 热重载失败:', err))
  })
}

/** 主进程 before-quit 推来的 session:end-request → 引擎 endSession（SessionEnd hooks，core 共享 1.5s
 *  预算、幂等）→ 回包 session:end-done；防御性判存（core 未落位零行为），异常也须回包放行退出 */
export function subscribeSessionEndRequest(): void {
  ;(window.electronAPI as any)?.onSessionEndRequest?.(() => {
    const done = (): void => (window.electronAPI as any)?.sessionEndDone?.()
    const e = engine as unknown as { endSession?: () => Promise<void> } | null
    if (e && typeof e.endSession === 'function') {
      e.endSession().catch((err) => console.warn('[hooks] SessionEnd 执行失败:', err)).finally(done)
    } else {
      done()
    }
  })
}

/** 主进程 Worker MCP 网关推来的 hook 派发请求（阶段 4）：渲染进程 core 单例 dispatcher
 *  即 ChatEngine 构造时注册的完整派发闭包（含 ask 升级审批/systemMessage 发射/additionalContext），
 *  直接复用、零重复逻辑；未注册（引擎未装配）时回 outcome=null=跳过 hooks（与未接线行为一致） */
export function subscribeWorkerMcpHookRequest(): void {
  ;(window.electronAPI as any)?.onWorkerMcpHookRequest?.(async ({ requestId, event, call }: { requestId: string; event: 'PreToolUse' | 'PostToolUse'; call: WorkerMcpHookCall }) => {
    try {
      const dispatcher = getWorkerMcpHookDispatcher()
      const outcome = dispatcher ? await dispatcher(event, call) : null
      ;(window.electronAPI as any)?.workerMcpHookResponse?.({ requestId, outcome })
    } catch (err: any) {
      ;(window.electronAPI as any)?.workerMcpHookResponse?.({ requestId, error: err?.message || String(err) })
    }
  })
}

function createEngine(): ChatEngine {
  const mcpStore = useMCPStore()
  const chatResourceStore = useChatResourceStore()

  // MCP 来源：单例聚合（默认 client 已在 main.ts 设为 ElectronMCPClient）
  const mcpService = new MCPService()
  mcpService.setMCPStoreGetter(() => ({
    getMCPToolsEnabled: () => mcpStore.getMCPToolsEnabled(),
  }))

  const deps: ChatEngineDeps = {
    builtInToolExecutor,
    mcpService,
    sessionStore: {
      save: async (record, mode) => {
        // 归属注入（projectId 非引擎状态，引擎重建的 record 不带它）：
        // 新会话首次落盘归当前选中项目；已归属会话按列表中的现有归属保留
        // （"移动到项目"后不被当前选中项目回写覆盖）；未选项目归"未分组"
        const projectStore = useProjectStore()
        if (record.projectId === undefined) {
          await projectStore.ensureSessionsLoaded()
          const existing = projectStore.sessionProjectIdOf(record.id)
          if (existing) record.projectId = existing
          else if (projectStore.currentProjectId) record.projectId = projectStore.currentProjectId
        }
        // workdir 注入（「项目=文件夹」归组字段；与写边界同一套解析——会话归属项目的
        // folderPath 优先，未绑定回退写作编辑器目录）：缺失才补，merge 防护保留盘上旧值
        if (record.workdir === undefined) {
          const boundFolder = record.projectId
            ? projectStore.projects.find(p => p.id === record.projectId)?.folderPath
            : undefined
          const dir = boundFolder || useWritingViewStore().getCurrentDirectory()
          if (dir) record.workdir = dir
        }
        const result = await saveSession(record, mode)
        // 如实透传保存结果（不再恒报 success）；成功则同步面板列表条目保新
        if (result.success) projectStore.upsertSession(record)
        return result
      },
      load: (id) => loadSession(id),
    },
    modelCaller: {
      callOnce: async ({ modelName, messages, tools, streamCallback, abortController, parameterOverrides }) => {
        const info = modelInfoService.getModelInfoByName(modelName)
        if (!info) {
          throw new Error(`模型未注册: ${modelName}`)
        }
        // 用户模型参数与 ModelServiceFactory.sendChatMessage 同来源，确保与现状同一套调用路径；
        // parameterOverrides（如压缩调用关思考）最后合并，覆盖用户参数（与 core nodeFactory 同法）
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
    // agent 资源（本地工作流 Agent / 远程 Agent）：与旧 prepareAllResources 同一数据源
    localAgentResources: async () => {
      try {
        if (chatResourceStore.enabledResources.length === 0) {
          await chatResourceStore.loadResources()
        }
        return chatResourceStore.enabledResources.filter(
          (r) => r.type === 'local_agent' || r.type === 'remote_agent'
        )
      } catch {
        return []
      }
    },
    localAgentExecutor: new ElectronIPCLocalAgentExecutor(),
    secureStorage: new ElectronSecureStorage(),
    mediaProvider: {
      readAsBase64: async (ref) => {
        try {
          const result = await (window as any).electronAPI?.readAttachmentAsBase64?.(ref)
          if (result?.success && result.base64) return { base64: result.base64 }
          return null
        } catch {
          return null
        }
      },
    },
    // AGENTS.md 工作目录：写作视图打开目录时经 setEngineWorkDir 更新（每轮组装现读）
    workDir: undefined,
    // ---- 目标模式（对照 CLI 的 cliChatEngineFactory 装配） ----
    // 目标文档落盘：渲染进程无 fs，经 goal:* IPC 桥到主进程 goalPersistence（fire-and-forget，
    // 引擎侧本就 try/catch 容错；异常在此吞掉防未处理 rejection）
    goalStore: {
      save: (state) => {
        void ((window.electronAPI as any)?.goalSave?.(JSON.parse(JSON.stringify(state)))?.catch?.(() => {}))
      },
      archive: (state) => {
        void ((window.electronAPI as any)?.goalArchive?.(JSON.parse(JSON.stringify(state)))?.catch?.(() => {}))
      },
      clear: () => {
        void ((window.electronAPI as any)?.goalClear?.()?.catch?.(() => {}))
      },
    },
    // 熔断请示/propose_goal 的用户应答通道：现读渲染进程 executor 上的 RendererUserInputProvider
    // （main.ts 已 setUserInputProvider；ask 经 PlanAskDialog 呈现）
    getUserInputProvider: () => builtInToolExecutor.getUserInputProvider(),
    // 评估器模型：现读 kvStore 的 defaultEvaluatorModel（ModelSettings 下拉经 kv:set 写入）
    getEvaluatorModelName: () => new IPCKeyValueStore().getItem('defaultEvaluatorModel') ?? undefined,
    // 工具渐进发现开关：现读 kvStore 键 progressive_tools，opt-out（读不到/'true'=开，'false'=关），
    // 与 CLI /tools mode 同一 state.json 键（ModelSettings checkbox 经 kv:set 写入）
    progressiveToolsEnabled: () => new IPCKeyValueStore().getItem('progressive_tools') !== 'false',
    // R2 自动压缩开关/阈值：与 CLI 同一 state.json 键 auto_compact（opt-out）/ compact_threshold（0-1，非法回退 core 默认 0.8）
    autoCompactEnabled: () => new IPCKeyValueStore().getItem('auto_compact') !== 'false',
    autoCompactThreshold: () => Number(new IPCKeyValueStore().getItem('compact_threshold')) || 0,
    // 桌面能力开关：现读 kvStore 键 desktop_control_enabled，opt-in（读不到/'false'=关），
    // 与 CLI /desktop 同一 state.json 键（ModelSettings 开关经 kv:set 写入）
    desktopToolsEnabled: () => new IPCKeyValueStore().getItem('desktop_control_enabled') === 'true',
    // goalTick 推进消息的任务清单摘要（与 ModelServiceFactory 的 taskListStoreGetter 同一数据源）
    getTaskStatusSummary: () => useTaskListStore().buildTaskStatusSummary(),
    // 生命周期 hooks（阶段 3）：loader/执行通道/信任询问的装配见本文件头部 hooks 装配段
    hookRunner: createHookRunner(),
  }

  engineDeps = deps
  return new ChatEngine(deps)
}

/** 获取引擎单例（首次调用时装配；调用时点在 main.ts 核心初始化之后） */
export function getChatEngine(): ChatEngine {
  if (!engine) {
    engine = createEngine()
  }
  return engine
}

/** 写作视图目录变化时更新 AGENTS.md 工作目录（引擎每轮组装现读 deps.workDir），并重扫项目级 Agent 模板 */
export function setEngineWorkDir(dir: string | undefined): void {
  if (!engineDeps) {
    getChatEngine()
  }
  engineDeps!.workDir = dir || undefined
  // workDir 变更 → 重扫项目各级 .agents/agents/ 并回写渲染进程 manager 副本；workDir 未设置时项目级清空
  rescanProjectTemplates(engineDeps!.workDir).catch((err) =>
    console.warn('[chatEngine] 项目级模板重扫失败:', err)
  )
  // hooks：项目级目录链由 loader 的 workDir getter 现读（无需重建）；主进程 watch 需显式重挂
  ;(window.electronAPI as any)?.hooksSetWorkDir?.(engineDeps!.workDir)
}

// ==================== frontAgent 响应式镜像 ====================

/** 当前前台（引擎状态的响应式镜像；会话操作后由 Home.vue 调 syncFrontAgentFromEngine 刷新） */
export const frontAgentRef = ref<string | undefined>(undefined)

/** 设置前台（写引擎 + 刷新镜像；随 SessionRecord.frontAgent 持久化） */
export function setFrontAgent(type?: string): void {
  getChatEngine().setFrontAgent(type)
  frontAgentRef.value = type || undefined
}

/** 从引擎状态刷新前台镜像（loadSession/startNewSession/detachSession 后调用） */
export function syncFrontAgentFromEngine(): void {
  frontAgentRef.value = getChatEngine().getFrontAgent()
}
