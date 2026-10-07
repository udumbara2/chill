/**
 * UI 侧 ChatEngine 装配与多会话 registry（T5：UI 接入 ChatEngine；迭代 3：单例改 registry）
 *
 * 与 CLI 的 cliChatEngineFactory 同配方，按渲染进程裁剪：
 * - 模型调用：直接用 ModelServiceFactory 接线（无 fs 依赖部分，与 nodeFactory 同法）；
 * - sessionStore：走 IPC（session:save 含 SaveMode / session:load 单文件直读），
 *   落盘实际发生在主进程 SessionPersistence（与 CLI 共享 ~/.chill/sessions/）；
 * - mediaProvider：桥宿主合同 readAttachmentAsBase64（getHostAPI）；
 * - 内置工具执行器：core 单例 builtInToolExecutor（main.ts 已 setBuiltInToolExecutor，
 *   requiresNodeFs 工具经其 nodeToolExecutor 路由到主进程）；
 * - 模板数据源：渲染进程的 getTemplateManager()（经 orchestratorStore.loadTemplates
 *   从主进程 IPC 填充，main.ts 启动时已加载）。
 *
 * 多会话（迭代 3）：SessionRegistry 管引擎生死（open/create/close），壳侧 activeEngine
 * 指向活跃引擎；getChatEngine() 保留=活跃引擎兼容出口（既有调用点语义不变）。
 *
 * 另导出 frontAgent 响应式镜像（ModeSelector 前台选择器绑定用；
 * 引擎状态本身非响应式，会话操作后由 Home.vue 调 syncFrontAgentFromEngine 刷新）。
 */

import { ref } from 'vue'
import {
  ChatEngine,
  SessionRegistry,
  abortAndSealTurn,
  ModelServiceFactory,
  BaseModelService,
  modelInfoService,
  SelectedModelsService,
  MCPService,
  builtInToolExecutor,
  memoryStore,
  knowledgeStore,
  agentInstructions,
  getSkillRegistry,
  getTemplateManager,
  convertTemplateToAvailableSubagent,
  convertModelInfoToAvailableModel,
  HookConfigLoader,
  HookRunner,
  TaskStore,
  SchedulerService,
  createClaimGate,
  resolveScheduledFireTarget,
  type ScheduledTask,
  getWorkerMcpHookDispatcher,
  toSessionSummary,
  normalizePathForCompare,
  BackupStore,
  type WorkerMcpHookCall,
  type ChatEngineDeps,
  type SessionSummary,
} from '@assistant-ai/core'
import { loadSession, saveSession } from '@assistant-ai/ui/adapters'
import { tryGetHostAPI } from '../host/hostApi'
import { IPCKeyValueStore } from '../adapters/IPCKeyValueStore'
import { ElectronIPCFileSystemProvider } from '../adapters/ElectronIPCFileSystemProvider'
import { ElectronIPCHookProcessRunner } from '../adapters/ElectronIPCHookProcessRunner'
import { ElectronIPCHookMtimeProvider } from '../adapters/ElectronIPCHookMtimeProvider'
import { askHookTrust } from '../adapters/RendererHookTrustAsker'
import { rescanProjectTemplates } from './agentTemplateService'
import { reloadWorkflows, syncProjectWorkflowWatchers } from './workflowAssetService'
import { ElectronSecureStorage } from '../adapters/ElectronSecureStorage'
import { useMCPStore } from '../stores/mcpStore'
import { useChatResourceStore } from '../stores/chatResourceStore'
import { useProjectStore } from '../stores/projectStore'
import { useTaskListStore } from '../stores/taskListStore'
import { pushActiveSessionChanged } from './relayService'
import { loadSessionSummaries } from '../adapters/sessionStorage'

// ==================== 多会话 registry（迭代 3） ====================

let registry: SessionRegistry | null = null
/** 活跃引擎（壳视图态；getChatEngine 兼容出口返回它） */
let activeEngine: ChatEngine | null = null
/** 引擎依赖句柄（装配后可微调，如写作目录变化时更新 workDir——出生默认） */
let engineDeps: ChatEngineDeps | null = null
/** 新引擎出生默认 workDir（3.9：setEngineWorkDir 更新；各引擎 deps 取出生快照，后台目录不动） */
let birthWorkDir: string | undefined
/** 引擎诞生钩子（3.4：Home 挂 writingModuleInjector 逐引擎注册） */
let onEngineOpen: ((engine: ChatEngine) => void) | null = null

function ensureRegistry(): SessionRegistry {
  if (!registry) {
    registry = new SessionRegistry({ createEngine: () => createEngine() })
  }
  return registry
}

/** 切换活跃引擎（壳视图态唯一写点）：scheduler 路由跟随 + 中继 active.changed 直推 */
function setActiveEngine(engine: ChatEngine | null): void {
  activeEngine = engine
  bindSchedulerRouting()
  // 3.7：壳切换点直推桥 active.changed（手机"●当前"徽标跟随桌面前台）
  pushActiveSessionChanged(engine?.getSessionState().sessionId ?? null)
}

/** 活跃会话 id（3.1 壳侧 activeSessionId；引擎身份变化（detach 换新 id）自动跟随） */
export function getActiveSessionId(): string | null {
  return activeEngine?.getSessionState().sessionId ?? null
}

/**
 * 运行中会话全集（运行态标志）：薄包 core SessionRegistry.runningSessionIds（判定单源）——
 * 会话列表"运行中"旋转环的数据源；新 Set 整替保 Vue 响应性（调用方以引用变化触发重渲）。
 */
export function getRunningSessionIds(): ReadonlySet<string> {
  return new Set(registry?.runningSessionIds() ?? [])
}

/**
 * 事件归属判定（2.5/4.1 store 侧统一过滤规则）：载荷带 sessionId 时须等于活跃会话，
 * 无归因（缺字段/空串——模型服务层兜底等）按现状放行，与单引擎时代行为一致。
 */
export function isForActiveSession(sessionId: string | null | undefined): boolean {
  return sessionId === undefined || sessionId === null || sessionId === '' || sessionId === getActiveSessionId()
}

/** 当前活跃引擎（不惰性创建；判空用） */
export function getActiveEngineOrNull(): ChatEngine | null {
  return activeEngine
}

/** 会话是否已在 registry（切换/删除语义判定用） */
export function isSessionOpen(sessionId: string): boolean {
  return !!registry?.has(sessionId)
}

/**
 * 打开会话（3.2 语义）：已在 registry → 仅切 active（不动引擎——运行中会话切走后台续跑）；
 * 未加载 → registry.open(id)（新引擎 + loadSession）。返回活跃引擎；记录不存在返回 null。
 */
export async function openSession(sessionId?: string): Promise<ChatEngine | null> {
  const reg = ensureRegistry()
  if (sessionId === undefined) {
    // 新会话（registry.create：立即铸 id、纯内存诞生，落盘时机不变）
    const engine = reg.create()
    setActiveEngine(engine)
    return engine
  }
  const existing = reg.get(sessionId)
  if (existing) {
    setActiveEngine(existing)
    return existing
  }
  // 未加载 → 新引擎 + loadSession（loadSession 按 record.workdir 钉住本会话工作目录）
  const engine = await reg.open(sessionId)
  if (!engine) return null
  setActiveEngine(engine)
  return engine
}

/** 切换到已打开会话（薄出口；未打开返回 false，调用方走 openSession） */
export function switchSession(sessionId: string): boolean {
  const engine = registry?.get(sessionId)
  if (!engine) return false
  setActiveEngine(engine)
  return true
}

/**
 * 关闭会话（3.4 薄出口）：registry.close = abort 在途轮封口 → endSession → dispose。
 * 幂等：未知 id 返回 false。活跃引擎被关时 active 置空（下次 getChatEngine 惰性新建）。
 */
export async function closeSession(sessionId: string): Promise<boolean> {
  const reg = registry
  if (!reg) return false
  const engine = reg.get(sessionId)
  if (engine && engine === activeEngine) {
    setActiveEngine(null)
  }
  if (engine) {
    try {
      engine.unregisterContextInjector('ui-writing-module')
    } catch {
      /* 注入器注销失败不阻断收口 */
    }
  }
  return reg.close(sessionId)
}

/** 引擎诞生钩子（3.4 注入器逐引擎装配；设值时对已有活跃引擎立即补挂） */
export function setOnEngineOpen(cb: ((engine: ChatEngine) => void) | null): void {
  onEngineOpen = cb
  if (cb && activeEngine) cb(activeEngine)
}

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
    { workDir: () => getEngineWorkDir(), kv }
  )
  return new HookRunner({
    loader,
    processRunner: new ElectronIPCHookProcessRunner(() => getEngineWorkDir()),
    kv,
    trustApprover: askHookTrust,
  })
}

// ==================== 定时任务装配（阶段 2：桌面 UI 支持；3.5 共享单实例） ====================
// 与 CLI 的 CliContext 装配同配方，按渲染进程裁剪：
// - TaskStore 立于 ElectronIPCFileSystemProvider（原子写 tmp+rename 经其 renameFile → file:rename IPC；
//   mtime 惰性重载复用 hooks:mtime 通用 fs.stat IPC 通道），清单文件与 CLI 同一份 ~/.chill/scheduled-tasks.json；
// - onFire/活跃上下文由 registry 装配点统一注册（bindSchedulerRouting：路由到活跃引擎）；
// - filePath 为 getter 现读（路径经异步 IPC 后补注入，同 hooksUserConfigPath 先例）；
// - 3.5：多引擎共享**同一** SchedulerService 实例（每 createEngine 各造会双时钟双触发），
//   start/stop 归壳装配点（getSharedScheduler 时 start、退出收口时 stop）——引擎构造/dispose
//   经 shellOwnsScheduler 不触碰启停（否则 close 任一会话即停掉全局定时任务）。

/** 任务清单文件路径（main.ts 经 getUserDataPath 解析后由 setScheduledTasksPath 注入） */
let scheduledTasksPath = ''

/** 注入任务清单文件路径（getUserDataPath 解析完成后调用；下一次 store 读取即生效） */
export function setScheduledTasksPath(userDataPath: string): void {
  scheduledTasksPath = `${userDataPath}/scheduled-tasks.json`
}

/** 共享 SchedulerService 单例（进程级一个时钟；3.5 防双触发） */
let sharedScheduler: SchedulerService | null = null

function getSharedScheduler(): SchedulerService {
  if (!sharedScheduler) {
    const fsProvider = new ElectronIPCFileSystemProvider()
    const store = new TaskStore(
      fsProvider,
      () => scheduledTasksPath,
      new ElectronIPCHookMtimeProvider()
    )
    // M6 跨进程触发抢占闸（与 CLI 的 scheduled-claims 同目录——serve/CLI/UI 三钟互斥）；
    // claimsDir 由任务清单路径推导（userDataPath 下）；路径未注入（异常时序）或宿主缺
    // 独占原语时优雅降级（无闸=乐观判重现状）
    const claimsDir = scheduledTasksPath ? scheduledTasksPath.replace(/scheduled-tasks\.json$/, 'scheduled-claims') : ''
    sharedScheduler = new SchedulerService({
      store,
      getWorkDir: () => getEngineWorkDir(),
      claimGate: claimsDir ? createClaimGate({ fs: fsProvider, claimsDir }) : undefined,
    })
    // 3.5：start 归壳装配点（一次；引擎构造不 start）
    sharedScheduler.start()
  }
  return sharedScheduler
}

/**
 * 3.5：装配点统一注册 onFire/活跃上下文（单槽、确定性，覆盖引擎构造的抢注）。
 * M4 定向路由：onFire 按任务归属定向（core resolveScheduledFireTarget 纯函数）——
 * A 会话的任务到点后台注入 A（用户切回可见），不再「等用户切回 A 才触发」
 * （本文件旧注释「定向路由属 M5」预留的兑现）。盘上数据源=session:list-meta 摘要
 * （SessionSummary 含 workdir，单一构造点）；或phans 经 sharedScheduler.markOrphaned 清账。
 */
function bindSchedulerRouting(): void {
  const scheduler = sharedScheduler
  if (!scheduler) return
  scheduler.setFireMode('directed')
  scheduler.setOnFire((task, coalescedCount) => {
    void routeScheduledFire(task, coalescedCount)
  })
  scheduler.setActiveContext({
    getWorkDir: () => activeEngine?.getWorkDir(),
    getSessionId: () => activeEngine?.getSessionState().sessionId ?? undefined,
  })
}

/** M4：定向路由执行（决策=core 纯函数；本函数只做快照采集与执行——与 serve 的 serveSessions 同构薄层） */
async function routeScheduledFire(task: ScheduledTask, coalescedCount: number): Promise<void> {
  const scheduler = sharedScheduler
  if (!scheduler) return
  const registry = ensureRegistry()
  const activeId = activeEngine?.getSessionState().sessionId ?? null
  const engines = registry
    .list()
    .reduce<Array<{ sessionId: string; workDir: string; isActive?: boolean; lastActiveAt?: number }>>((acc, id) => {
      const engine = registry.get(id)
      if (engine) {
        acc.push({ sessionId: id, workDir: engine.getWorkDir(), isActive: id === activeId })
      }
      return acc
    }, [])
  // 盘上快照：list-meta 摘要一次取（存在性 + workDir 最近会话共用；失败=空表→project 兜底 newSession）
  let summaries: SessionSummary[] = []
  try {
    summaries = await loadSessionSummaries()
  } catch {
    /* 主进程 IPC 不可达：按空处理（project 任务走 newSession 兜底、session 任务在册即达） */
  }
  const norm = (d: string) => d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const decision = resolveScheduledFireTarget(task, {
    engines,
    sessionExists: (id) => summaries.some((s) => s.id === id),
    latestSessionInDir: (dir) => summaries.find((s) => s.workdir && norm(s.workdir) === norm(dir))?.id,
  })

  if (decision.kind === 'engine') {
    const engine = registry.get(decision.sessionId)
    if (engine) {
      engine.enqueueScheduledFire(task, coalescedCount)
      return
    }
  }
  if (decision.kind === 'engine' || decision.kind === 'load') {
    const sessionId = decision.sessionId
    const engine = await registry.open(sessionId).catch(() => null)
    if (engine) {
      engine.enqueueScheduledFire(task, coalescedCount)
      return
    }
    await scheduler.markOrphaned(task.id)
    console.warn(`[sched] 定时任务 ${task.id} 归属会话 ${sessionId} 装载失败——转 orphaned`)
    return
  }
  if (decision.kind === 'newSession') {
    // project 任务无人值守兜底：新建承接会话钉住任务 workDir（标题交首轮自动标题机制）
    const engine = registry.create()
    if (decision.workDir) engine.setWorkDir(decision.workDir)
    engine.startNewSession()
    engine.enqueueScheduledFire(task, coalescedCount)
    console.info(`[sched] 定时任务 ${task.id} 新建承接会话（workDir=${decision.workDir || '（空）'}）`)
    return
  }
  await scheduler.markOrphaned(task.id)
  console.warn(`[sched] 定时任务 ${task.id} ${decision.reason}——转 orphaned`)
}

// ==================== 文件备份存储装配（备份与回滚体系：UI 壳侧注入） ====================
// 与 CLI 的 CliContext 装配同配方，按渲染进程裁剪：
// - fs 走 ElectronIPCFileSystemProvider（file:* IPC 落主进程；备份库与 CLI 同一份 userData/backups，天然跨端共享）；
// - rootDir 为 getter 现读（userDataPath 经异步 IPC 后补注入，同 hooksUserConfigPath 先例），store 每次读写求值，无需重建；
// - context 接 executor 的 getBackupAttributionContext 现读（hookContextProvider 同数据源：
//   sessionId + ChatEngine 维护的当前轮 turnId；taskId 由 core 采集层经 __origin 归因）；
// - 装配时经 core setBackupStore 注入点挂进 executor 咽喉（五调用点写前快照即委托此 store）。

/** 备份库根目录（main.ts 经 getUserDataPath 解析后由 setBackupsRootDir 注入） */
let backupsRootDir = ''
/** UI 侧 BackupStore 单例（恢复中心对话框的数据源 + executor 采集层委托目标） */
let backupStore: BackupStore | null = null

/** 注入备份库根目录（getUserDataPath 解析完成后调用；getter 现读，下一次读写即生效） */
export function setBackupsRootDir(userDataPath: string): void {
  backupsRootDir = `${userDataPath}/backups`
}

/** 获取 BackupStore 单例（首次调用时装配并注入 executor；恢复中心对话框与引擎装配共用） */
export function getBackupStore(): BackupStore {
  if (!backupStore) {
    backupStore = new BackupStore({
      fs: new ElectronIPCFileSystemProvider(),
      rootDir: () => backupsRootDir,
      // 归因上下文接 executor 现读（hookContextProvider 同数据源，含 ChatEngine 维护的 turnId）
      context: () => builtInToolExecutor.getBackupAttributionContext(),
    })
    // core setBackupStore 注入点：executor 咽喉五调用点写前快照委托此 store
    builtInToolExecutor.setBackupStore(backupStore)
  }
  return backupStore
}

/** 读取快照内容（恢复中心 diff 预览用）：直调 core BackupStore.readSnapshot 公共通道；
 *  读取失败返回 null，预览降级 */
export async function readBackupSnapshotContent(originalPath: string, file: string | null): Promise<string | null> {
  if (!file || !backupsRootDir) return null
  try {
    return await getBackupStore().readSnapshot(originalPath, file)
  } catch {
    return null
  }
}

/** 主进程 before-quit 推来的 session:end-request → 遍历 registry 全部引擎**并行** abort 在途轮
 *  （封口+落盘留痕；各自 2s 预算并行执行 ⇒ 总窗≈2s，发现 #9：不再逐引擎串行 N×2s 拖死退出，
 *  超时由 .finally 放行退出）→ 各引擎 endSession（SessionEnd hooks，core 共享 1.5s 预算、幂等）
 *  → 共享 scheduler stop（3.5：启停归壳）→ 回包 session:end-done；防御性判存，异常也须回包放行退出 */
export function subscribeSessionEndRequest(): void {
  ;tryGetHostAPI()?.onSessionEndRequest?.(() => {
    const done = (): void => tryGetHostAPI()?.sessionEndDone?.()
    void (async () => {
      const engines = registry ? registry.list().map((id) => registry!.get(id)).filter((e): e is ChatEngine => !!e) : []
      // 并行封口（发现 #9：总窗 2s 级，超时放行退出——收尾尽力而为，不拖死 quit）
      await Promise.all(engines.map((e) => abortAndSealTurn(e, 2000)))
      await Promise.all(engines.map((e) => e.endSession()))
      sharedScheduler?.stop()
    })()
      .catch((err) => console.warn('[hooks] SessionEnd 执行失败:', err))
      .finally(done)
  })
}

/** 主进程 Worker MCP 网关推来的 hook 派发请求（阶段 4）：渲染进程 core 单例 dispatcher
 *  即 ChatEngine 构造时注册的完整派发闭包（含 ask 升级审批/systemMessage 发射/additionalContext），
 *  直接复用、零重复逻辑；未注册（引擎未装配）时回 outcome=null=跳过 hooks（与未接线行为一致） */
export function subscribeWorkerMcpHookRequest(): void {
  ;tryGetHostAPI()?.onWorkerMcpHookRequest?.(async ({ requestId, event, call }: { requestId: string; event: 'PreToolUse' | 'PostToolUse'; call: WorkerMcpHookCall }) => {
    try {
      const dispatcher = getWorkerMcpHookDispatcher()
      const outcome = dispatcher ? await dispatcher(event, call) : null
      tryGetHostAPI()?.workerMcpHookResponse?.({ requestId, outcome })
    } catch (err: any) {
      tryGetHostAPI()?.workerMcpHookResponse?.({ requestId, error: err?.message || String(err) })
    }
  })
}

// ==================== 回合完成窗口提醒（任务栏闪烁） ====================

/** 助手回合落定 → 通知主进程按需闪烁任务栏（用户最小化/切走窗口时知道回答完了）。
 *  触发信号取活跃引擎 running 的真→假跳变：sendMessage/regenerate/resumeGoal/定时任务触发轮
 *  都经 runTurn 的 finally 复位 running，一轮 poll 全覆盖（core 无"回合完成"事件——
 *  eventBus 的 ASSISTANT_MESSAGE_CREATED 是工具循环中"新子响应开始"语义，不能当完成信号）。
 *  每次落定都通知，是否闪烁由主进程按窗口聚焦态判定（保持渲染侧简单）；
 *  引擎未装配（activeEngine 为 null）时视为未运行，不强制创建引擎 */
export function subscribeTurnCompletedFlash(): void {
  let wasRunning = false
  setInterval(() => {
    const running = activeEngine?.getSessionState().isRunning ?? false
    if (wasRunning && !running) {
      void tryGetHostAPI()?.notifyTurnCompleted?.()
    }
    wasRunning = running
  }, 1000)
}

function createEngine(): ChatEngine {
  const mcpStore = useMCPStore()
  const chatResourceStore = useChatResourceStore()
  /** 本引擎自引用（hasOtherActiveGoal 自排除用；构造后赋值——闭包调用时机晚于赋值） */
  let self: ChatEngine | null = null

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
        // 归属注入（projectId 非引擎状态，引擎重建的 record 不带它），优先级：
        // 1) 已归属会话按列表中的现有归属保留（不被回写覆盖）；
        // 2) 新会话出生意向 pendingProjects[record.id]（3.10：按会话 id 登记/消费——多会话
        //    各归各，双新会话先后落盘归属不串）——消费前校验项目仍存在（选择后被并发删除
        //    则视为无意向，落回规则 3）；显式意图优先于推断；
        // 3) workdir 规则兜底——record.workdir（buildRecord 已预填引擎本地 workDir，
        //    3.10「当前写作目录」全局回退退役）匹配已绑定 folderPath 的项目
        //    （与 groupSessionsByWorkdir 事后归组同一规则，出生即应用：目录在哪、写边界
        //    在哪、归属就在哪）；无匹配 = 未分组。
        const projectStore = useProjectStore()
        let pendingConsumed = false
        if (record.projectId === undefined) {
          await projectStore.ensureSessionsLoaded()
          const existing = projectStore.sessionProjectIdOf(record.id)
          if (existing) {
            record.projectId = existing
          } else {
            const pending = projectStore.pendingProjectOf(record.id)
            if (pending && projectStore.projects.some(p => p.id === pending)) {
              record.projectId = pending
              pendingConsumed = true
            } else if (record.workdir) {
              const target = normalizePathForCompare(record.workdir)
              const hit = projectStore.projects.find(
                p => !!p.folderPath && normalizePathForCompare(p.folderPath) === target
              )
              if (hit) record.projectId = hit.id
            }
          }
        }
        // workdir 注入（「项目=文件夹」归组字段；与写边界同一套解析——会话归属项目的
        // folderPath 优先，未绑定回退引擎 workDir）：缺失才补，merge 防护保留盘上旧值
        if (record.workdir === undefined) {
          const boundFolder = record.projectId
            ? projectStore.projects.find(p => p.id === record.projectId)?.folderPath
            : undefined
          if (boundFolder) record.workdir = boundFolder
        }
        const result = await saveSession(record, mode)
        // 如实透传保存结果（不再恒报 success）；成功则同步面板列表条目保新
        // （toSessionSummary 6 字段提取，不再整条 record 深拷贝入缓存）；
        // 出生意向已随首次落盘兑现则清空（意向只属当次新会话）
        if (result.success) {
          projectStore.upsertSessionSummary(toSessionSummary(record))
          if (pendingConsumed) projectStore.setPendingProject(record.id, null)
        }
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
    // agent 资源（仅远程 Agent；本地工作流 Agent 体系已退役，本地 agent 走模板/YAML 工作流）
    agentResources: async () => {
      try {
        if (chatResourceStore.enabledResources.length === 0) {
          await chatResourceStore.loadResources()
        }
        return chatResourceStore.enabledResources.filter(
          (r) => r.type === 'remote_agent'
        )
      } catch {
        return []
      }
    },
    secureStorage: new ElectronSecureStorage(),
    mediaProvider: {
      readAsBase64: async (ref) => {
        try {
          const result = await tryGetHostAPI()?.readAttachmentAsBase64?.(ref)
          if (result?.success && result.base64) return { base64: result.base64 }
          return null
        } catch {
          return null
        }
      },
    },
    // AGENTS.md 工作目录：写作视图打开目录时经 setEngineWorkDir 更新（每轮组装现读）
    workDir: birthWorkDir,
    // ---- 目标模式（对照 CLI 的 cliChatEngineFactory 装配） ----
    // 目标文档落盘：渲染进程无 fs，经 goal:* IPC 桥到主进程 goalPersistence（fire-and-forget，
    // 引擎侧本就 try/catch 容错；异常在此吞掉防未处理 rejection）
    goalStore: {
      save: (state) => {
        void (tryGetHostAPI()?.goalSave?.(JSON.parse(JSON.stringify(state)))?.catch?.(() => {}))
      },
      archive: (state) => {
        void (tryGetHostAPI()?.goalArchive?.(JSON.parse(JSON.stringify(state)))?.catch?.(() => {}))
      },
      clear: () => {
        void (tryGetHostAPI()?.goalClear?.()?.catch?.(() => {}))
      },
    },
    // 1.6 跨引擎 goal 互斥：另有会话在目标模式（含暂停——current-goal.md 进程级单文件）
    // 即拒绝开启；无其他会话目标时恒 false（单会话行为逐位不变）
    hasOtherActiveGoal: () => {
      const reg = registry
      if (!reg) return false
      for (const id of reg.list()) {
        const e = reg.get(id)
        if (e && e !== self && e.getSessionState().goalMode) return true
      }
      return false
    },
    // 熔断请示/propose_goal 的用户应答通道：现读渲染进程 executor 上的 AskChannel
    // （main.ts 已 setUserInputProvider(getAskChannel())；ask 经 PlanAskDialog 与手机提问卡双面呈现）
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
    // 定时任务（阶段 2）：共享单实例（3.5 防双触发）+ shellOwnsScheduler（启停归壳）
    scheduler: getSharedScheduler(),
    shellOwnsScheduler: true,
  }

  engineDeps = deps
  // 备份采集注入：executor 五调用点写前快照委托此 store（rootDir getter 现读，路径后补注入天然生效）
  getBackupStore()
  const engine = new ChatEngine(deps)
  self = engine
  // 1.7/3.9：钉住出生 workDir 快照（不随后续全局目录漂移——后台会话目录不动）
  engine.setWorkDir(birthWorkDir)
  // 3.5：装配点统一注册 scheduler 路由（引擎构造的抢注被此覆盖——单槽、确定性指向活跃引擎）
  bindSchedulerRouting()
  // 3.4：注入器逐引擎装配（Home 经 setOnEngineOpen 挂入 writingModuleInjector 定义）
  onEngineOpen?.(engine)
  return engine
}

/** 获取活跃引擎（惰性装配首会话；41 处既有调用点语义不变） */
export function getChatEngine(): ChatEngine {
  if (activeEngine) return activeEngine
  const engine = ensureRegistry().create()
  setActiveEngine(engine)
  return engine
}

/** 写作视图目录变化时更新 AGENTS.md 工作目录（引擎每轮组装现读 deps.workDir），并重扫项目级 Agent 模板。
 *  3.9：只作用活跃引擎（getChatEngine().setWorkDir 钉住）+ deps.workDir 留作出生默认——
 *  后台引擎已各自钉住出生快照/record.workdir，不随全局目录漂移 */
export function setEngineWorkDir(dir: string | undefined): void {

  if (!engineDeps) {
    getChatEngine()
  }
  // 3.9：出生默认 + 只作用活跃引擎（后台引擎已钉住出生快照/record.workdir，不随全局目录漂移）
  birthWorkDir = dir || undefined
  engineDeps!.workDir = birthWorkDir
  getChatEngine().setWorkDir(birthWorkDir)
  // workDir 变更 → 重扫项目各级 .agents/agents/ 并回写渲染进程 manager 副本；workDir 未设置时项目级清空
  rescanProjectTemplates(getEngineWorkDir()).catch((err) =>
    console.warn('[chatEngine] 项目级模板重扫失败:', err)
  )
  // workDir 变更 → 工作流资产同步重扫 + 项目级目录监听登记(与模板同节奏)
  reloadWorkflows()
    .then(() => syncProjectWorkflowWatchers())
    .catch((err) => console.warn('[chatEngine] 工作流重扫失败:', err))
  // hooks：项目级目录链由 loader 的 workDir getter 现读、配置经派发时惰性重载生效（单通道，无需任何联动）
}

/** 现读引擎当前工作目录（Agent 编辑器"项目共享"落点与 rescan 触发用）；活跃引擎优先，未装配回退出生默认 */
export function getEngineWorkDir(): string | undefined {
  return activeEngine?.getWorkDir() || birthWorkDir
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
