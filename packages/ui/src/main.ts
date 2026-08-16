import { AsyncLocalStorage } from 'als-browser'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'

AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage())

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { SecureStorageService, SelectedModelsService, mcpAutoReconnectService, ModelServiceFactory, modelInfoService, providerManager, MCPService, BuiltInToolExecutor, setBuiltInToolExecutor, SubagentExecutor, getTaskExecutor, setExecutor, MCPConfigPersistence, BaseModelService, openAIChatHandler, anthropicChatHandler, registerAsyncTaskFamilies, RemoteExecutorAdapter, memoryStore, memoryDistiller, improvementProposer, agentInstructions, knowledgeStore, eventBus, EVENTS, setEnvironmentProbe, setTaskEnvironmentDestroyer, ModelModality, type ISkillInstaller, type ModelMediaCapabilities } from '@assistant-ai/core'
import { initSkills, reloadSkills } from './services/skillService'
import { initAgentTemplateService } from './services/agentTemplateService'
import {
  IPCKeyValueStore,
  ElectronSecureStorage,
  ElectronMCPClient,
  ElectronIPCCodeExecutor,
  TipTapPositionCalculator,
  ElectronPowerShellAdapter
} from '@assistant-ai/ui/adapters'
import { ElectronIPCFileSystemProvider } from './adapters/ElectronIPCFileSystemProvider'
import { ElectronDesktopController } from './adapters/ElectronDesktopController'
import { PiniaConfirmationHandler } from './adapters/PiniaConfirmationHandler'
import { RendererUserInputProvider } from './adapters/RendererUserInputProvider'
import { usePlanModeStore } from './stores/planModeStore'
import { useGoalModeStore } from './stores/goalModeStore'
import { useContextStatusStore } from './stores/contextStatusStore'
import { useHookMessageStore } from './stores/hookMessageStore'
import { setHooksUserConfigPath, subscribeHooksChanged, subscribeSessionEndRequest, subscribeWorkerMcpHookRequest } from './services/chatEngine'
import { ElectronIPCLocalAgentExecutor } from './adapters/ElectronIPCLocalAgentExecutor'
import { useMCPStore } from './stores/mcpStore'
import { useTaskListStore } from './stores/taskListStore'
import { useOrchestratorStore } from './stores/orchestratorStore'
import './styles/global.css'
import './styles/settings.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

const electronSecureStorage = new ElectronSecureStorage()
SecureStorageService.initialize(electronSecureStorage)
SelectedModelsService.setDefaultStore(new IPCKeyValueStore())

MCPService.setDefaultClient(new ElectronMCPClient())

// 环境探测注入（T7：core 不直接探测 window.electronAPI，由宿主经回调告知）
setEnvironmentProbe({
  isElectron: () => typeof window !== 'undefined' && 'electronAPI' in window,
  getMainProcessApi: () => (window as any).electronAPI,
})

setExecutor(new ElectronIPCCodeExecutor())

const mcpStore = useMCPStore()
const mcpStoreGetter = () => ({
  getMCPToolsEnabled: () => mcpStore.getMCPToolsEnabled()
})

const taskListStore = useTaskListStore()
const taskListStoreGetter = () => ({
  hasTasks: () => taskListStore.hasTasks,
  buildTaskStatusSummary: () => taskListStore.buildTaskStatusSummary(),
  buildCompletedTasksSummary: () => taskListStore.buildCompletedTasksSummary()
})
BaseModelService.registerProtocolHandler('openai-chat', openAIChatHandler)
registerAsyncTaskFamilies((p, h) => BaseModelService.registerProtocolHandler(p, h))
    BaseModelService.registerProtocolHandler('anthropic-messages', anthropicChatHandler)
ModelServiceFactory.initialize(electronSecureStorage, mcpStoreGetter, taskListStoreGetter)
modelInfoService.setSecureStorage(electronSecureStorage)

const electronFSProvider = new ElectronIPCFileSystemProvider()
modelInfoService.setFileSystemProvider(electronFSProvider)

// File-based MCP persistence — populated after async init, then injected into services
let mcpFilePersistence: MCPConfigPersistence | null = null
export function getMCPFilePersistence(): MCPConfigPersistence | null {
  return mcpFilePersistence
}

const initialized = window.electronAPI.getUserDataPath().then((result: any) => {
  if (result.success && result.path) {
    modelInfoService.setModelsDir(result.path + '/models')
    providerManager.setProvidersDir(result.path + '/models')

    const serverDir = result.path + '/mcp_servers'
    mcpFilePersistence = new MCPConfigPersistence(
      new IPCKeyValueStore(),
      electronSecureStorage,
      electronFSProvider,
      serverDir
    )
    mcpAutoReconnectService.configure(mcpFilePersistence, new ElectronMCPClient())
  }
  providerManager.setFileSystemProvider(electronFSProvider)
  // 硬性顺序：provider Map 先就位，loadAllModels 内部的 migrateKeys 才能经 resolveId 落到稳定 id
  return providerManager.loadProviders().then(() => modelInfoService.loadAllModels())
})

const rendererSubagentExecutor = new SubagentExecutor()
SubagentExecutor.setExecutor(async (template, taskDescription, mergedParams, startTime, tools, availableTools, apiKey, baseURL, environmentKey) => {
  const safeTools = tools ? JSON.parse(JSON.stringify(tools)) : undefined
  const resp: any = await window.electronAPI.subagentExecute({
    template, taskDescription, mergedParams, startTime,
    tools: safeTools, availableTools, apiKey, baseURL,
    // 环境绑定键（toolCall.id）随请求透传：Worker 在主进程以此键登记，cancel_task 按同键销毁
    environmentKey
  })
  if (!resp.success) throw new Error(resp.error)
  return resp.result as any
})
getTaskExecutor(electronSecureStorage, rendererSubagentExecutor, new ElectronIPCLocalAgentExecutor())
getTaskExecutor().setRemoteAdapter(new RemoteExecutorAdapter(electronSecureStorage))

// cancel_task 的跨进程 destroy 通道：渲染进程注册表无本地环境绑定（Worker 在主进程 fork），
// 经 subagent:cancel IPC 让主进程按环境绑定键销毁（core 侧本地绑定存在时不走此通道）
setTaskEnvironmentDestroyer(async (environmentKey) => {
  const resp: any = await (window.electronAPI as any).subagentCancel({ environmentKey })
  return !!resp?.success
})

const uiFsProvider = new ElectronIPCFileSystemProvider()
const uiConfirmationHandler = new PiniaConfirmationHandler()
const uiPositionCalculator = new TipTapPositionCalculator()
const uiCodeExecutor = new ElectronPowerShellAdapter()

const be = new BuiltInToolExecutor(
  uiFsProvider,
  uiConfirmationHandler,
  uiPositionCalculator,
  uiCodeExecutor
)
setBuiltInToolExecutor(be)
// Node-only 工具路由：渲染进程 fs=null，requiresNodeFs 的工具经 IPC 转发到主进程执行
be.setNodeToolExecutor((name, args) => (window as any).electronAPI.executeNodeTool(name, args))

// 桌面能力注入（迭代 4.2，对照 CLI CliContext 装配）：
// IPC 桥控制器 + configStore（desktop_control_enabled 开关门，与 CLI 同一 state.json 键）
// + 视觉能力闭包（现读当前模型 supportedModalities，中途切换安全；信息缺失返回 undefined=不过滤）
be.setDesktopController(new ElectronDesktopController())
be.setConfigStore(new IPCKeyValueStore())
be.setMediaCapabilitiesProvider((): ModelMediaCapabilities | undefined => {
  const modelName = SelectedModelsService.getInstance().getCurrentModelName()
  if (!modelName) return undefined
  const info = modelInfoService.getModelInfoByName(modelName)
  if (!info?.supportedModalities) return undefined
  return {
    supportsImage: info.supportedModalities.includes(ModelModality.IMAGE),
    supportsVideo: info.supportedModalities.includes(ModelModality.VIDEO),
  }
})

// Subagent Worker 内置工具执行端：主进程 fork 的 Worker 经 IPC 转发内置工具请求至此，
// 由渲染进程真实实例执行（圈外写/命令经通用审批通道在 UI 可见可批、fs 桥接主进程），结果回包
;(window.electronAPI as any)?.onSubagentBuiltinRequest?.(async ({ requestId, toolName, args, toolCallId, __origin }: { requestId: string; toolName: string; args: string; toolCallId?: string; __origin?: unknown }) => {
  try {
    // __origin（Worker 归属）随载荷同名字段到达；args 字符串本就携带（网关注入），
    // 此处防御性补齐——防 IPC 链任一环节剥离后 executor 读不到归属
    let finalArgs = args
    if (__origin) {
      try {
        const parsed = JSON.parse(args)
        if (!parsed.__origin) finalArgs = JSON.stringify({ ...parsed, __origin })
      } catch {
        // args 非 JSON 时原样转发
      }
    }
    const result = await be.executeAsync(toolName, finalArgs, toolCallId)
    ;(window.electronAPI as any)?.subagentBuiltinResponse?.({ requestId, result })
  } catch (error: any) {
    ;(window.electronAPI as any)?.subagentBuiltinResponse?.({ requestId, error: error?.message || String(error) })
  }
})

// 规划模式接线：core 事件 → store 展示同步（状态源归引擎，此处不回调 setPlanMode 防回环）；
// ask 提问 → 渲染进程对话框；主进程 IPC 双向同步
const planModeStore = usePlanModeStore()
eventBus.on(EVENTS.PLAN_MODE_ENTERED, () => planModeStore.applyExternal(true))
eventBus.on(EVENTS.PLAN_APPROVED, () => planModeStore.applyExternal(false))
be.setUserInputProvider(new RendererUserInputProvider())
;(window.electronAPI as any)?.onPlanModeChanged?.((on: boolean) => planModeStore.applyExternal(on))
;(window.electronAPI as any)?.onPlanAskUserRequest?.(({ id, question, options, allowFreeText }: any) => {
  planModeStore.openAsk(question, options, allowFreeText).then(answer => {
    ;(window.electronAPI as any)?.planAskUserResponse?.(id, answer)
  })
})

// 目标模式接线（对照规划模式）：core 事件 → store 展示同步（状态源归引擎，syncFromEngine 只读不回调）；
// goal 的 ask（熔断请示 / propose_goal 确认）复用上面的 PlanAskDialog 通道——
// 引擎经 getUserInputProvider 现读 executor 上的 RendererUserInputProvider，无需单独对话框。
// 轮次计数无独立事件：goalTick 每轮产生 assistant 消息，借 ASSISTANT_MESSAGE_CREATED 现读刷新。
const goalModeStore = useGoalModeStore()
eventBus.on(EVENTS.GOAL_STARTED, () => goalModeStore.syncFromEngine())
eventBus.on(EVENTS.GOAL_ACHIEVED, () => goalModeStore.syncFromEngine())
eventBus.on(EVENTS.GOAL_PAUSED, () => goalModeStore.syncFromEngine())
eventBus.on(EVENTS.GOAL_RESUMED, () => goalModeStore.syncFromEngine())
eventBus.on(EVENTS.GOAL_CLEARED, () => goalModeStore.syncFromEngine())
eventBus.on(EVENTS.GOAL_BUDGET_EXHAUSTED, () => goalModeStore.syncFromEngine())
eventBus.on(EVENTS.ASSISTANT_MESSAGE_CREATED, () => {
  if (goalModeStore.isGoalMode) goalModeStore.syncFromEngine()
})

// 上下文余量接线（对照 goalMode）：轮产出 assistant 消息时 lastUsage 已更新，现读刷新展示；
// 自动压缩完成后 lastUsage 重置 → 余量条隐藏（下一轮实测回填再出现）。状态源归引擎，不回调。
const contextStatusStore = useContextStatusStore()
eventBus.on(EVENTS.ASSISTANT_MESSAGE_CREATED, () => contextStatusStore.syncFromEngine())
eventBus.on(EVENTS.CONTEXT_AUTO_COMPACTED, () => contextStatusStore.syncFromEngine())
eventBus.on(EVENTS.CONTEXT_OVERFLOW_RECOVERED, () => contextStatusStore.syncFromEngine())

// 生命周期 hooks 接线（阶段 3：桌面 UI 支持，显示分离——core 只抛事件，此处渲染）：
// ① HOOK_MESSAGE（hook 警告/拦截理由/systemMessage）→ 消息卡片 store（ChatArea 渲染）；
// ② hooks:changed（主进程 watch 推送）→ loader 重载（热更新，改配置免重启）
const hookMessageStore = useHookMessageStore()
eventBus.on(EVENTS.HOOK_MESSAGE, (payload: { event?: string; messages?: string[] }) => {
  if (!Array.isArray(payload?.messages)) return
  hookMessageStore.push(payload.event, payload.messages)
})
subscribeHooksChanged()
// SessionEnd hooks（阶段 4）：主进程 before-quit 通知 → 引擎 endSession → 回包放行退出
subscribeSessionEndRequest()
// Worker MCP hooks（阶段 4）：主进程网关 → 渲染进程 core 单例 dispatcher 过管线 → 回包
subscribeWorkerMcpHookRequest()

// Mount after async init completes — switch to file-based persistence first
initialized.then(() => {
  if (mcpFilePersistence) {
    be.setMCPDependencies(mcpFilePersistence, new ElectronMCPClient())
  }
  // Initialize skill management（与 CLI 同一编排入口 core.initializeSkillRegistry）
  window.electronAPI.getUserDataPath().then((r: any) => {
    if (r.success && r.path) {
      const pathProvider = { getUserDataPath: () => r.path, getUserHomePath: () => r.path }
      // 生命周期 hooks（阶段 3）：用户级 hooks.json 路径注入引擎装配的 loader（getter 现读，下一次派发即生效）
      setHooksUserConfigPath(r.path)
      // 长期记忆存储初始化（与 CLI 共用 memoryStore；UI 侧经 IPC fsProvider 读写）
      memoryStore.init(uiFsProvider, pathProvider)
      memoryDistiller.init(uiFsProvider, pathProvider)
      improvementProposer.init(uiFsProvider, pathProvider)
      // AGENTS.md 用户约束初始化（与 CLI 共用 agentInstructions；UI 侧经 IPC fsProvider 读写）
      agentInstructions.init(uiFsProvider, pathProvider)
      // 知识库存储初始化（与 CLI 共用 knowledgeStore；UI 侧经 IPC fsProvider 读写）
      knowledgeStore.init(uiFsProvider, pathProvider)
      // 记忆蒸馏：启动时认领最新未蒸馏会话，后台提炼候选记忆进待确认区（静默失败）
      memoryDistiller.distillLatestSessionIfNeeded().catch(() => {})
      window.electronAPI.skillGetBuiltinDir().then((bd: any) => {
        // npm 模式过滤：非 managed 布局（无源码环境）移除 self-iterate，规则与 CLI 同源
        const filterSelfIterate = bd?.managed === false
        // 改进提议：仅 managed 布局下启动时认领最新未分析会话（静默失败）
        if (bd?.managed !== false) {
          improvementProposer.proposeFromLatestSession().catch(() => {})
        }
        initSkills(pathProvider, bd?.path || undefined, filterSelfIterate).then((errors) => {
          // SkillInstaller 运行在主进程（需要 Node.js API），通过 IPC 调用
          const skillInstallerAdapter: ISkillInstaller = {
            installSkill: async (source, subPath) => {
              const result = await window.electronAPI.skillInstall(source, subPath)
              if (result.success) {
                await reloadSkills()
              }
              return result
            },
            uninstallSkill: async (name) => {
              const result = await window.electronAPI.skillUninstall(name)
              if (result.success) {
                await reloadSkills()
              }
              return result
            },
            updateSkill: async (name) => {
              const result = await window.electronAPI.skillUpdate(name)
              if (result.success) {
                await reloadSkills()
              }
              return result
            },
          }
          be.setSkillInstaller(skillInstallerAdapter)
          for (const err of errors) {
            console.warn('【Skill】', err)
          }
        })
      })
    }
  })
  mcpAutoReconnectService.initialize()
  // 模板加载（渲染进程 TemplateManager 经 IPC 从主进程填充；
  // ChatEngine 委派指南/前台候选的数据源，启动即加载而非等首次委派）
  // agentTemplateService 持有项目级模板缓存与合并回写逻辑（workDir 变更时经 setEngineWorkDir 重扫）
  initAgentTemplateService()
  const orchestratorStore = useOrchestratorStore()
  orchestratorStore.loadTemplates().then(() => {
    orchestratorStore.setupAgentsWatcher()
    orchestratorStore.setupTemplatesListener()
  }).catch((err) => console.warn('【Orchestrator】模板加载失败:', err))
  app.mount('#app')
}).catch(err => {
  console.error('加载模型失败:', err)
  mcpAutoReconnectService.initialize()
  app.mount('#app')
})
