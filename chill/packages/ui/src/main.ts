import { AsyncLocalStorage } from 'als-browser'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'

AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage())

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { SecureStorageService, SelectedModelsService, mcpAutoReconnectService, ModelServiceFactory, modelInfoService, providerManager, MCPService, BuiltInToolExecutor, setBuiltInToolExecutor, SubagentExecutor, getTaskExecutor, setExecutor, MCPConfigPersistence, BaseModelService, openAIChatHandler, anthropicChatHandler, registerAsyncTaskFamilies, RemoteExecutorAdapter, memoryStore, improvementProposer, improvementLedger, agentInstructions, knowledgeStore, eventBus, EVENTS, setEnvironmentProbe, setTaskEnvironmentDestroyer, setDelegationQuotaProvider, setTeamBudgetDefaultsProvider, getTeamRuntimeService, buildTeamContextLine, ModelModality, getAskChannel, type ISkillInstaller, type ModelMediaCapabilities, type AskRequestPayload } from '@assistant-ai/core'
import { initSkills, reloadSkills } from './services/skillService'
import { getHostAPI, tryGetHostAPI } from './host/hostApi'
import { initAgentTemplateService } from './services/agentTemplateService'
import { initWorkflowAssetService } from './services/workflowAssetService'
import { initTeamAssetService } from './services/teamAssetService'
import { initSessionBoardService } from './services/sessionBoardService'

/** 委派限额配置值解析：正整数有效，其余（缺失/非数字/非正）返回 undefined 由 core 回退默认 */
function parsePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}
import {
  IPCKeyValueStore,
  ElectronSecureStorage,
  ElectronMCPClient,
  ElectronIPCCodeExecutor,
  TipTapPositionCalculator,
  ElectronPowerShellAdapter
} from '@assistant-ai/ui/adapters'
import { ElectronIPCFileSystemProvider } from './adapters/ElectronIPCFileSystemProvider'
import { managedFlag } from './services/managedFlag'
import { ElectronDesktopController } from './adapters/ElectronDesktopController'
import { ElectronDesktopAuditSink } from './adapters/ElectronDesktopAuditSink'
import { PiniaConfirmationHandler } from './adapters/PiniaConfirmationHandler'
import { usePlanModeStore } from './stores/planModeStore'
import { useGoalModeStore } from './stores/goalModeStore'
import { useContextStatusStore } from './stores/contextStatusStore'
import { compactionVersion } from './composables/useCompact'
import { useHookMessageStore } from './stores/hookMessageStore'
import { getChatEngine, isForActiveSession, setHooksUserConfigPath, subscribeSessionEndRequest, subscribeWorkerMcpHookRequest, subscribeTurnCompletedFlash, setScheduledTasksPath, setBackupsRootDir } from './services/chatEngine'
import { useMCPStore } from './stores/mcpStore'
import { useChatResourceStore } from './stores/chatResourceStore'
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

// 环境探测注入（T7：core 不直接探测宿主注入，由宿主经回调告知）
setEnvironmentProbe({
  isElectron: () => typeof window !== 'undefined' && 'electronAPI' in window,
  getMainProcessApi: () => tryGetHostAPI(),
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
// 团队状态上下文注入(迭代 1):Lead 主会话每轮头部 SYSTEM 一行团队状态;Worker/workflow 不经此装配,天然不注入
ModelServiceFactory.initialize(electronSecureStorage, mcpStoreGetter, taskListStoreGetter, () =>
  buildTeamContextLine(getTeamRuntimeService()?.getActiveTeam()),
)
modelInfoService.setSecureStorage(electronSecureStorage)

const electronFSProvider = new ElectronIPCFileSystemProvider()
modelInfoService.setFileSystemProvider(electronFSProvider)

// File-based MCP persistence — populated after async init, then injected into services
let mcpFilePersistence: MCPConfigPersistence | null = null
export function getMCPFilePersistence(): MCPConfigPersistence | null {
  return mcpFilePersistence
}

const initialized = getHostAPI().getUserDataPath().then((result: any) => {
  if (result.success && result.path) {
    modelInfoService.setModelsDir(result.path + '/models')
    modelInfoService.setKeyValueStore(new IPCKeyValueStore())
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
SubagentExecutor.setExecutor(async (template, taskDescription, mergedParams, startTime, tools, availableTools, apiKey, baseURL, environmentKey, extras) => {
  const safeTools = tools ? JSON.parse(JSON.stringify(tools)) : undefined
  const resp: any = await getHostAPI().subagentExecute({
    template, taskDescription, mergedParams, startTime,
    tools: safeTools, availableTools, apiKey, baseURL,
    // 环境绑定键（toolCall.id）随请求透传：Worker 在主进程以此键登记，cancel_task 按同键销毁
    environmentKey,
    // 下行附加信息（成功标准/评审标记/resume 种子）随载荷透传主进程 executor
    extras
  })
  if (!resp.success) throw new Error(resp.error)
  return resp.result as any
})
getTaskExecutor(electronSecureStorage, rendererSubagentExecutor)
getTaskExecutor().setRemoteAdapter(new RemoteExecutorAdapter(electronSecureStorage))

// cancel_task 的跨进程 destroy 通道：渲染进程注册表无本地环境绑定（Worker 在主进程 fork），
// 经 subagent:cancel IPC 让主进程按环境绑定键销毁（core 侧本地绑定存在时不走此通道）
setTaskEnvironmentDestroyer(async (environmentKey) => {
  const resp: any = await getHostAPI().subagentCancel({ environmentKey })
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
be.setNodeToolExecutor((name, args) => getHostAPI().executeNodeTool(name, args))

// 桌面能力注入（迭代 4.2，对照 CLI CliContext 装配）：
// IPC 桥控制器 + configStore（desktop_control_enabled 开关门，与 CLI 同一 state.json 键）
// + 视觉能力闭包（现读当前模型 supportedModalities，中途切换安全；信息缺失返回 undefined=不过滤）
be.setDesktopController(new ElectronDesktopController())
// 桌面审计 sink 注入：条目经 desktop:audit 单工 IPC 由主进程落盘
be.setDesktopAuditSink(new ElectronDesktopAuditSink())
be.setConfigStore(new IPCKeyValueStore())
// 委派资源限额（P1.6）：provider 注入，与 CLI 同一份 state.json 经 IPC 读同一对键
// （UI 设置页 AGENT tab「委派限额」写同一对键；未设置/非法值由 core 回退默认 6/200）
{
  const quotaKv = new IPCKeyValueStore()
  setDelegationQuotaProvider(() => ({
    maxConcurrent: parsePositiveInt(quotaKv.getItem('delegation_max_concurrent')),
    maxCumulative: parsePositiveInt(quotaKv.getItem('delegation_max_cumulative')),
  }))
  // 团队默认预算(迭代 3):与 CLI 同一份 state.json 经 IPC 读同三键;未设置=不限
  setTeamBudgetDefaultsProvider(() => ({
    maxMembers: parsePositiveInt(quotaKv.getItem('team_budget_max_members')),
    maxTokens: parsePositiveInt(quotaKv.getItem('team_budget_max_tokens')),
    maxDepth: parsePositiveInt(quotaKv.getItem('team_budget_max_depth')),
  }))
}
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
;tryGetHostAPI()?.onSubagentBuiltinRequest?.(async ({ requestId, toolName, args, toolCallId, __origin }: { requestId: string; toolName: string; args: string; toolCallId?: string; __origin?: unknown }) => {
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
    tryGetHostAPI()?.subagentBuiltinResponse?.({ requestId, result })
  } catch (error: any) {
    tryGetHostAPI()?.subagentBuiltinResponse?.({ requestId, error: error?.message || String(error) })
  }
})

// 规划模式接线：core 事件 → store 展示同步；主进程 IPC 双向同步。
// 状态完整性双红线（进程拆分下模式状态存三份：渲染引擎/显示 store/主进程 executor，必须全同步）：
// ① PLAN_MODE_ENTERED（模型 enter_plan_mode 在渲染侧执行、事件只达渲染总线）→ 补同步主进程 executor 的拦截门；
// ② plan:mode-changed（submit_plan 批准在主进程执行、事件只达主进程总线）→ 回传状态源引擎
//    （engine.setPlanMode 幂等且不回发 IPC，无回环；显示经引擎补发的 PLAN_APPROVED 事件跟随，
//    applyExternal 作显示兜底）。缺①则模型进的规划模式拦不住主进程写工具；缺②则批准后引擎
//    planMode 卡 true——渲染侧修改工具仍被拦、目标模式推进被 maybeContinueGoal 的 planMode 检查挂起。
const planModeStore = usePlanModeStore()
eventBus.on(EVENTS.PLAN_MODE_ENTERED, (payload: { sessionId?: string }) => {
  // 4.1：store 侧按 active 过滤（后台会话的 plan 翻转不写前台面板）
  if (!isForActiveSession(payload?.sessionId)) return
  planModeStore.applyExternal(true)
  ;tryGetHostAPI()?.setPlanMode?.(true)
})
eventBus.on(EVENTS.PLAN_APPROVED, (payload: { sessionId?: string }) => {
  if (!isForActiveSession(payload?.sessionId)) return
  planModeStore.applyExternal(false)
})
// ask 通道（M4e 契约，照 CLI cli.ts:449 同款装配）：AskChannel 是 userInputProvider 唯一入口，
// 本地呈现（PlanAskDialog）与手机提问卡（relayService 的 wireAskChannel → ask.request 信封）都从
// ASK_REQUESTED 事件点亮，先答先落（AskChannel.resolve 唯一落定口）——旧 RendererUserInputProvider
// 只通本地弹窗不发事件，UI 壳持租约时手机永远收不到任何提问。
be.setUserInputProvider(getAskChannel())
let currentAskId: string | null = null
eventBus.on(EVENTS.ASK_REQUESTED, (payload: AskRequestPayload) => {
  currentAskId = payload.id
  planModeStore.openAsk(payload.question, payload.options, payload.allowFreeText).then((answer) => {
    if (currentAskId !== payload.id) return // 已被更新的 ask 顶掉（openAsk 兑现空串）或已被收摊
    currentAskId = null
    getAskChannel().resolve(payload.id, answer, 'local') // 迟到（手机先答）返 false，回答自然作废
  })
})
eventBus.on(EVENTS.ASK_SETTLED, (settled: { id: string }) => {
  // 手机/他面先答：收摊本地弹窗（兑现空串→上面 then 的 id 守卫拦住，不会伪造落定）
  if (settled.id === currentAskId) {
    currentAskId = null
    planModeStore.resolveAsk('')
  }
})
;tryGetHostAPI()?.onPlanModeChanged?.((on: boolean) => {
  getChatEngine().setPlanMode(on)
  planModeStore.applyExternal(on)
})
;// 主进程 executor 的 ask（submit_plan 等经 plan:ask-user-request IPC 到达）改经渲染端 AskChannel
// 中转：本地弹窗与手机提问卡同屏点亮，任一作答即回填主进程挂起 Promise
tryGetHostAPI()?.onPlanAskUserRequest?.(({ id, question, options, allowFreeText }: any) => {
  getAskChannel().ask(question, options, allowFreeText).then((answer) => {
    getHostAPI().planAskUserResponse(id, answer)
  })
})

// 目标模式接线（对照规划模式）：core 事件 → store 展示同步（状态源归引擎，syncFromEngine 只读不回调）；
// goal 的 ask（熔断请示 / propose_goal 确认）复用上面的 AskChannel 呈现面——
// 引擎经 getUserInputProvider 现读 executor 上的 AskChannel，无需单独对话框。
// 轮次计数无独立事件：goalTick 每轮产生 assistant 消息，借 ASSISTANT_MESSAGE_CREATED 现读刷新。
const goalModeStore = useGoalModeStore()
// 4.1：GOAL_* 同规则过滤（后台会话的目标事件不驱动前台面板；syncFromEngine 本就读活跃引擎状态）
const onGoalEvent = (payload: { sessionId?: string }) => {
  if (!isForActiveSession(payload?.sessionId)) return
  goalModeStore.syncFromEngine()
}
eventBus.on(EVENTS.GOAL_STARTED, onGoalEvent)
eventBus.on(EVENTS.GOAL_ACHIEVED, onGoalEvent)
eventBus.on(EVENTS.GOAL_PAUSED, onGoalEvent)
eventBus.on(EVENTS.GOAL_RESUMED, onGoalEvent)
eventBus.on(EVENTS.GOAL_CLEARED, onGoalEvent)
eventBus.on(EVENTS.GOAL_BUDGET_EXHAUSTED, onGoalEvent)
eventBus.on(EVENTS.ASSISTANT_MESSAGE_CREATED, (payload: { sessionId?: string }) => {
  if (!isForActiveSession(payload?.sessionId)) return
  if (goalModeStore.isGoalMode) goalModeStore.syncFromEngine()
})

// 上下文余量接线（对照 goalMode）：轮产出 assistant 消息时 lastUsage 已更新，现读刷新展示；
// 自动压缩完成后 lastUsage 重置 → 余量条隐藏（下一轮实测回填再出现）。状态源归引擎，不回调。
const contextStatusStore = useContextStatusStore()
eventBus.on(EVENTS.ASSISTANT_MESSAGE_CREATED, () => contextStatusStore.syncFromEngine())
// 自动压缩/溢出恢复产生 checkpoint 后，同时刷新占用环（syncFromEngine）与压缩分割线（compactionVersion 漏斗）
eventBus.on(EVENTS.CONTEXT_AUTO_COMPACTED, () => {
  contextStatusStore.syncFromEngine()
  compactionVersion.value++
})
eventBus.on(EVENTS.CONTEXT_OVERFLOW_RECOVERED, () => {
  contextStatusStore.syncFromEngine()
  compactionVersion.value++
})

// MCP 连接状态变化 → 刷新工具资源目录（chatResourceStore 是懒加载带缓存——
// 首次 loadResources 时 MCP auto-reconnect 可能尚未完成，工具不在缓存里；
// 此事件由 core mcpAutoReconnectService.initialize 在重连完成后发出。
// 修复影响桌面 + Web 双端：Web 因 boot 时序更长而更明显）
eventBus.on(EVENTS.MCP_CONNECTION_CHANGED, () => {
  void useChatResourceStore().loadResources()
})

// 生命周期 hooks 接线（阶段 3：桌面 UI 支持，显示分离——core 只抛事件，此处渲染）：
// HOOK_MESSAGE（hook 警告/拦截理由/systemMessage）→ 消息卡片 store（ChatArea 渲染）；
// hooks 配置生效 = 派发时惰性重载单通道（core HookRunner.dispatch → loader.checkReload，无 watcher）
const hookMessageStore = useHookMessageStore()
eventBus.on(EVENTS.HOOK_MESSAGE, (payload: { event?: string; messages?: string[] }) => {
  if (!Array.isArray(payload?.messages)) return
  hookMessageStore.push(payload.event, payload.messages)
})
// SessionEnd hooks（阶段 4）：主进程 before-quit 通知 → 引擎 endSession → 回包放行退出
subscribeSessionEndRequest()
// Worker MCP hooks（阶段 4）：主进程网关 → 渲染进程 core 单例 dispatcher 过管线 → 回包
subscribeWorkerMcpHookRequest()
// 回合完成窗口提醒：引擎 running 真→假跳变（任意来源回合落定）→ 主进程按聚焦态闪烁任务栏
subscribeTurnCompletedFlash()

// Mount after async init completes — switch to file-based persistence first
initialized.then(() => {
  if (mcpFilePersistence) {
    be.setMCPDependencies(mcpFilePersistence, new ElectronMCPClient())
  }
  // Initialize skill management（与 CLI 同一编排入口 core.initializeSkillRegistry）
  getHostAPI().getUserDataPath().then((r: any) => {
    if (r.success && r.path) {
      const pathProvider = { getUserDataPath: () => r.path, getUserHomePath: () => r.path }
      // 生命周期 hooks（阶段 3）：用户级 hooks.json 路径注入引擎装配的 loader（getter 现读，下一次派发即生效）
      setHooksUserConfigPath(r.path)
      // 定时任务（阶段 2）：任务清单路径注入引擎装配的 TaskStore（getter 现读，与 hooks 同一注入模式）
      setScheduledTasksPath(r.path)
      // 备份与回滚体系：备份库根目录注入引擎装配的 BackupStore（getter 现读，同一注入模式）
      setBackupsRootDir(r.path)
      // 长期记忆存储初始化（与 CLI 共用 memoryStore；UI 侧经 IPC fsProvider 读写）
      memoryStore.init(uiFsProvider, pathProvider)
            improvementProposer.init(uiFsProvider, pathProvider)
      // 改进提案账本唯一读写入口（决策闭环迭代 3：药丸/设置面板/manage_improvements 共用）
      improvementLedger.init(uiFsProvider, pathProvider)
      // AGENTS.md 用户约束初始化（与 CLI 共用 agentInstructions；UI 侧经 IPC fsProvider 读写）
      agentInstructions.init(uiFsProvider, pathProvider)
      // 知识库存储初始化（与 CLI 共用 knowledgeStore；UI 侧经 IPC fsProvider 读写）
      knowledgeStore.init(uiFsProvider, pathProvider)
      // 记忆蒸馏：启动时认领最新未蒸馏会话，后台提炼候选记忆进待确认区（静默失败）
            getHostAPI().skillGetBuiltinDir().then((bd: any) => {
        // npm 模式过滤：非 managed 布局（无源码环境）移除 self-iterate，规则与 CLI 同源
        const filterSelfIterate = bd?.managed === false
        // managed 旗标（闪念捕获门控消费点）：安装事实经 IPC 落定，npm 模式下捕获入口不渲染
        managedFlag.value = bd?.managed !== false
        // 改进提议：仅 managed 布局下启动时认领最新未分析会话（静默失败）
        if (bd?.managed !== false) {
          improvementProposer.proposeFromLatestSession().catch(() => {})
        }
        initSkills(pathProvider, bd?.path || undefined, filterSelfIterate).then((errors) => {
          // SkillInstaller 运行在主进程（需要 Node.js API），通过 IPC 调用
          const skillInstallerAdapter: ISkillInstaller = {
            installSkill: async (source, subPath) => {
              const result = await getHostAPI().skillInstall(source, subPath)
              if (result.success) {
                await reloadSkills()
              }
              return result
            },
            uninstallSkill: async (name) => {
              const result = await getHostAPI().skillUninstall(name)
              if (result.success) {
                await reloadSkills()
              }
              return result
            },
            updateSkill: async (name) => {
              const result = await getHostAPI().skillUpdate(name)
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
  // 命名工作流资产服务(M2/M5):启动即装配(run_workflow 的 getService/toolRunner 提供者在此注册),
  // 不等用户首次打开工作流标签页
  initWorkflowAssetService().catch((err) => console.warn('【工作流】资产服务初始化失败:', err))
  initTeamAssetService().catch((err) => console.warn('【团队】资产服务初始化失败:', err))
  // 会话级共享看板(V1.5 装配,与 CLI CliContext 同语义):快照经 board:* IPC 落主进程 ~/.chill/boards
  initSessionBoardService()
  const orchestratorStore = useOrchestratorStore()
  orchestratorStore.loadTemplates().then(() => {
    orchestratorStore.setupAgentsWatcher()
    orchestratorStore.setupTemplatesListener()
  }).catch((err) => console.warn('【Orchestrator】模板加载失败:', err))
  // relay 配置完成即自启（M2a：已配对设备存在时经主进程租约启动；他端在线则静默让位）
  import('./services/relayService').then(({ getPairingManager, startRelay }) => {
    void getPairingManager()
      .getRelayConfig()
      .then(async (config) => {
        if (!config) return
        const devices = await getPairingManager().listDevices()
        if (devices.length > 0) await startRelay().catch(() => {})
      })
      .catch(() => {})
  })
  app.mount('#app')
}).catch(err => {
  console.error('加载模型失败:', err)
  void mcpAutoReconnectService.initialize()
  app.mount('#app')
})
