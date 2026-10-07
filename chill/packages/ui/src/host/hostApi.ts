/**
 * HostAPI —— 宿主合同（共享渲染层拥有）
 *
 * WebUI 规划 M0.1：由 env.d.ts 的 ElectronAPI ambient 声明升格而来，并补齐 preload
 * 全量方法面（原声明缺失：MCP 族 / draft 族 / fileStat / hooks / PowerShell /
 * subagent 回弹对 / sessionEnd / workerMcpHook / teams watch；删除无实现的死声明
 * a2aExecuteTask）。
 *
 * 合同归属（规划 D3"合同归共享层"）：本接口由 packages/ui 定义并拥有，宿主各写一份实现——
 * - 桌面宿主：packages/electron/src/preload.ts（contextBridge 注入 window.electronAPI）
 * - Web 宿主：packages/web 的 ws-host（M1+）
 * 渲染层代码一律经 getHostAPI()/tryGetHostAPI() 取用（M0.2 收敛），不直接触碰
 * window.electronAPI。
 *
 * 红线：Node 侧（daemon 等）仅允许 `import type`（编译期擦除）——
 * 防止渲染层运行时代码被拖进 Node 产物。
 */
import type { CatalogStateBody, WorkerMcpHookCall } from '@assistant-ai/core'

// ---------- 连接态语义（Web 宿主用；桌面宿主恒为 connected，不实现事件） ----------

/** 宿主连接态：WS 断连进入 reconnecting（等待态：静默重试，恢复自动续跑） */
export type HostConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected'

/** 连接状态快照（结构预留给 M1.3 WS 事件帧；含可读原因便于等待态 UI 呈现） */
export interface HostConnectionStatus {
  state: HostConnectionState
  /** 非 connected 时的可读原因（如"daemon 未运行"） */
  reason?: string
}

// ---------- 合同本体 ----------

export interface HostAPI {
  // ========== 安全存储（OS 凭据保管） ==========
  storeApiKey: (provider: string, apiKey: string) => Promise<{ success: boolean; error?: string }>
  getApiKey: (provider: string) => Promise<string | null>
  deleteApiKey: (provider: string) => Promise<boolean>
  getAllProviders: () => Promise<string[]>

  // ========== Key-Value 持久化（同步桥接，宿主侧 FileKeyValueStore） ==========
  getKeyValue: (key: string) => string | null
  setKeyValue: (key: string, value: string) => void
  removeKeyValue: (key: string) => void

  // ========== 会话管理（后端 core SessionPersistence，~/.chill/sessions/，与 CLI 共享） ==========
  /** 元数据列表（SessionSummary[]：id/title/createdAt/updatedAt/projectId/workdir，按 updatedAt 降序） */
  sessionListMeta: () => Promise<{ success: boolean; records?: any[]; error?: string }>
  /** 单会话直读（只读一个文件） */
  sessionLoad: (id: string) => Promise<{ success: boolean; record?: any | null; error?: string }>
  sessionPatchProject: (id: string, projectId: string | null) => Promise<{ success: boolean; error?: string }>
  /** 标题单字段补丁（行内重命名；落 titleSource='manual'，不动 updatedAt） */
  sessionPatchTitle: (id: string, title: string) => Promise<{ success: boolean; error?: string }>
  /** 内容搜索（标题+正文；hits 为 { id, title, updatedAt, matchKind, snippet }） */
  sessionSearch: (query: string) => Promise<{ success: boolean; hits?: any[]; error?: string }>
  sessionSave: (record: any, mode?: 'merge' | 'replace') => Promise<{ success: boolean; error?: string }>
  sessionDelete: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 跨端同步：报告当前会话 id 让宿主重定向 watch；对端变更经 onSessionChanged 推回 */
  sessionWatch: (id: string) => Promise<{ success: boolean; error?: string }>
  sessionLoadIfNewer: (id: string) => Promise<{ success: boolean; record?: any | null; error?: string }>
  /** handoff 三值：'<id>'=CLI /ui 接力该会话；''=接力但 CLI 无落盘会话；null=非 /ui 启动 */
  sessionGetHandoffId: () => Promise<string | null>
  onSessionChanged: (callback: (record: any | null) => void) => void
  /** 窗口重新聚焦推送（注意力边界全量刷新会话列表） */
  onWindowFocused: (callback: () => void) => void

  // ========== 项目管理（core ProjectPersistence，~/.chill/projects.json） ==========
  projectList: () => Promise<{ success: boolean; records?: any[] | null; error?: string }>
  projectSave: (record: any) => Promise<{ success: boolean; error?: string }>
  projectDelete: (id: string) => Promise<{ success: boolean; error?: string }>

  // ========== Node-only 工具路由（渲染进程无 fs，requiresNodeFs 工具经宿主执行） ==========
  executeNodeTool: (name: string, args: string) => Promise<{ success: boolean; data?: any; error?: string }>

  // ========== 规划模式 ==========
  setPlanMode: (on: boolean) => Promise<{ success: boolean; error?: string }>
  planAskUserResponse: (id: string, answer: string) => Promise<{ success: boolean; error?: string }>
  onPlanAskUserRequest: (callback: (payload: {
    id: string
    question: string
    options?: { label: string; description: string }[]
    allowFreeText?: boolean
  }) => void) => void
  onPlanModeChanged: (callback: (on: boolean) => void) => void

  // ========== 目标模式（goalPersistence 桥） ==========
  setGoalMode: (on: boolean) => Promise<{ success: boolean; error?: string }>
  goalSave: (state: any) => Promise<{ success: boolean; error?: string }>
  goalArchive: (state: any) => Promise<{ success: boolean; error?: string }>
  goalClear: () => Promise<{ success: boolean; error?: string }>

  // ========== MCP 服务（连接由宿主进程持有——stdio 需 spawn；渲染进程零传输逻辑） ==========
  mcpGetConnectionStatus: () => Promise<any>
  mcpConnectWithId: (config: any, connectionId?: string) => Promise<any>
  mcpDisconnectWithId: (connectionId: string) => Promise<any>
  mcpListConnections: () => Promise<any>
  /** Web 专属（可选）：fs 只读闸查询/联动（家目录降级；desktop 无此闸，不实现） */
  fsGetGate?: () => Promise<{ enforced: boolean; downgraded: boolean }>
  fsSetGate?: (enforced: boolean) => Promise<{ success: boolean; enforced: boolean }>
  mcpListToolsWithId: (connectionId?: string) => Promise<any>
  mcpListResourcesWithId: (connectionId?: string) => Promise<any>
  mcpReadResourceWithId: (uri: string, connectionId?: string) => Promise<any>
  mcpGetPromptWithId: (name: string, args?: { [key: string]: string }, connectionId?: string) => Promise<any>
  mcpListPromptsWithId: (connectionId?: string) => Promise<any>
  mcpCallToolWithId: (toolName: string, args?: Record<string, any>, connectionId?: string) => Promise<any>
  /** 兼容回退（无 WithId 后缀旧名） */
  mcpReadResource: (uri: string, connectionId?: string) => Promise<any>
  mcpGetPrompt: (name: string, args?: { [key: string]: string }, connectionId?: string) => Promise<any>
  onMCPStatusUpdate: (callback: (data: {
    connectionId: string
    status: 'connecting' | 'connected' | 'disconnected'
    serverName?: string
    timestamp: number
  }) => void) => void

  // ========== 草稿存取 ==========
  draftSave: (draft: any) => Promise<any>
  draftLoad: () => Promise<any>
  draftExists: () => Promise<any>
  draftClear: () => Promise<any>

  // ========== 原生对话框（Web 宿主双轨替代：daemon 侧选择器 + 浏览器选择器，M3.6） ==========
  showSaveDialog: (options: any) => Promise<any>
  showOpenDialog: (options: any) => Promise<any>

  // ========== 文件系统（宿主进程 fs；Web 宿主限 ~/.chill 与会话工作目录白名单） ==========
  fileListDirectory: (dirPath: string, options?: { includeHidden?: boolean }) => Promise<{
    success: boolean
    files?: Array<{
      id: string
      name: string
      path: string
      type: 'file' | 'directory'
      parentId: string | null
    }>
    error?: string
  }>
  fileRead: (filePath: string, options?: { limit?: number; offset?: number }) => Promise<{
    success: boolean
    content?: string
    totalLines?: number
    startLine?: number
    endLine?: number
    encoding?: string
    error?: string
  }>
  fileWrite: (filePath: string, content: string, encoding?: string) => Promise<{ success: boolean; error?: string }>
  fileReadBase64: (filePath: string) => Promise<{ success: boolean; base64?: string; error?: string }>
  fileDelete: (filePath: string) => Promise<{ success: boolean; error?: string }>
  fileRename: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>
  fileCreate: (filePath: string, content?: string) => Promise<{ success: boolean; error?: string }>
  fileMkdir: (dirPath: string) => Promise<{ success: boolean; error?: string }>
  fileExists: (filePath: string) => Promise<{ success: boolean; exists?: boolean; error?: string }>
  getPathType: (filePath: string) => Promise<{ success: boolean; type?: 'file' | 'directory' | 'not_found'; error?: string }>
  /** 元数据（mtimeMs+size：快照时效对账判据，positioning 约定） */
  fileStat: (filePath: string) => Promise<{ success: boolean; mtimeMs?: number; size?: number; error?: string }>
  /** 独占创建（O_EXCL；M6 定时任务触发 claim）。可选：Web 宿主未实现（web daemon 侧时钟不经渲染层） */
  fileCreateExclusive?: (filePath: string, content: string) => Promise<{ success: boolean; created?: boolean; error?: string }>
  realpath: (filePath: string) => Promise<{ success: boolean; path?: string; error?: string }>
  fileOpen: (filePath: string) => Promise<{ success: boolean; error?: string }>
  fileWatchSet: (paths: string[]) => Promise<{ success: boolean; error?: string }>
  fileWatchStop: () => Promise<{ success: boolean; error?: string }>
  onFileChanged: (callback: (data: { eventName: string; filePath: string }) => void) => void
  removeFileChangedListener: () => void

  // ========== 附件管理（Web 无 File.path 的替代通道：宿主落盘回填路径，M3.6） ==========
  saveAttachment: (buffer: ArrayBuffer, fileName: string) => Promise<{ success: boolean; fileId?: string; filePath?: string; error?: string }>
  deleteAttachment: (fileId: string) => Promise<{ success: boolean; error?: string }>
  readAttachmentAsBase64: (fileId: string) => Promise<{ success: boolean; base64?: string; error?: string }>

  // ========== 应用信息 ==========
  getUserDataPath: () => Promise<{ success: boolean; path?: string; error?: string }>
  /** 本实例宿主进程 PID（团队运行态 hostPid 注入源；渲染进程 process 是 polyfill 无 pid） */
  getMainPid: () => Promise<{ success: boolean; pid?: number; error?: string }>

  // ========== 会话看板快照（core SessionBoardStore 桥；宿主 fs 落盘 ~/.chill/boards） ==========
  boardLoad: (boardId: string) => Promise<unknown>
  boardSave: (state: unknown) => Promise<void>
  boardExists: (boardId: string) => Promise<boolean>
  boardArchive: (boardId: string, reason: string) => Promise<unknown>

  // ========== 窗口提醒（回合完成 → 宿主按聚焦态决定提醒方式；Web 宿主=Notification） ==========
  notifyTurnCompleted: () => Promise<void>

  // ========== Orchestrator 远程配置 + 模板管理 ==========
  orchestratorReadRemoteConfigs: () => Promise<{ success: boolean; configs?: any[]; error?: string }>
  orchestratorWriteRemoteConfig: (key: string, config: any) => Promise<{ success: boolean; error?: string }>
  orchestratorDeleteRemoteConfig: (key: string) => Promise<{ success: boolean; error?: string }>
  orchestratorGetAllTemplates: () => Promise<{ success: boolean; templates?: any[]; error?: string }>
  orchestratorNotifyAgentsChanged: (agents: any[]) => Promise<{ success: boolean; error?: string }>
  onTemplatesReloaded: (callback: (data: { remoteTemplates: any[]; allTemplates: any[] }) => void) => void

  // ========== 资产 watch（可选成员：宿主未接线时缺省，调用侧可选链） ==========
  /** 工作流资产热重载（宿主 fs.watch → 通知重扫） */
  onWorkflowsChanged?: (cb: () => void) => void
  watchWorkflowDirs?: (dirs: string[]) => Promise<unknown>
  /** 固定团队资产热重载 */
  onTeamsChanged?: (cb: () => void) => void
  watchTeamDirs?: (dirs: string[]) => Promise<unknown>

  // ========== 跨进程团队运行快照（team-runs 目录变更 + 存活实例探测） ==========
  onTeamRunsChanged: (callback: () => void) => void
  getLiveInstancePids: () => Promise<{ success: boolean; pids?: number[]; error?: string }>
  /** 执行过程面板：Worker 工具调用事件推送（事实流，SUBAGENT_TOOL_CALL 同源） */
  onSubagentToolCall: (callback: (payload: any) => void) => void

  // ========== Subagent 执行（Worker fork 在宿主进程） ==========
  subagentExecute: (request: any) => Promise<{ success: boolean; result?: any; error?: string }>
  /** 取消后台任务：宿主按环境绑定键销毁 Worker 环境 */
  subagentCancel: (request: { environmentKey: string }) => Promise<{ success: boolean; error?: string }>
  /** Worker 内置工具转发：宿主推来执行请求，渲染进程执行（真实确认流/fs 桥）后回包 */
  onSubagentBuiltinRequest: (callback: (payload: {
    requestId: string
    toolName: string
    args: string
    toolCallId?: string
    __origin?: unknown
  }) => void) => void
  subagentBuiltinResponse: (payload: { requestId: string; result?: any; error?: string }) => Promise<void>

  // ========== Skill 安装 ==========
  skillInstall: (source: string, subPath?: string) => Promise<{ success: boolean; skillName?: string; error?: string }>
  skillUninstall: (name: string) => Promise<{ success: boolean; error?: string }>
  skillUpdate: (name: string) => Promise<{ success: boolean; error?: string }>
  skillGetBuiltinDir: () => Promise<{ success: boolean; path?: string | null; managed?: boolean; error?: string }>

  // ========== 命令与代码执行（宿主进程执行；审批归属渲染进程） ==========
  executePowerShell: (command: string, options?: { workingDirectory?: string; timeout?: number }) => Promise<any>
  executeJSCode: (code: string, options?: { timeout?: number; memoryLimit?: number; cwd?: string }, language?: string) => Promise<{
    success: boolean
    output?: string
    error?: string
    logs?: string[]
    duration?: number
  }>
  startInteractiveExecution: (code: string, language?: string, options?: { timeout?: number }) => Promise<{
    success: boolean
    processId?: string
    error?: string
  }>
  sendInput: (processId: string, input: string) => Promise<void>
  terminateProcess: (processId: string) => Promise<void>
  onOutput: (callback: (data: { processId: string; data: string; type: 'stdout' | 'stderr' }) => void) => void
  onExit: (callback: (data: { processId: string; code: number; reason: string; error?: string }) => void) => void
  removeInteractiveListeners: () => void

  // ========== 生命周期 hooks（IHookProcessRunner 宿主通道） ==========
  /** hook 命令经宿主 child_process 执行；cwd 随调用传入，注入 CHILL_PROJECT_DIR 别名 */
  hooksRun: (payload: { command: string; inputJson: string; timeoutMs: number; cwd?: string }) => Promise<any>
  /** hooks.json mtime 探测（HookConfigLoader 惰性重载依赖） */
  hooksMtime: (filePath: string) => Promise<any>

  // ========== SessionEnd hooks（宿主 before-quit → 渲染进程引擎 endSession → 回包） ==========
  onSessionEndRequest: (callback: () => void) => void
  sessionEndDone: () => void

  // ========== Worker MCP hooks（宿主网关拦到调用，HookRunner 管线在渲染进程） ==========
  onWorkerMcpHookRequest: (callback: (payload: { requestId: string; event: 'PreToolUse' | 'PostToolUse'; call: WorkerMcpHookCall }) => void) => void
  workerMcpHookResponse: (payload: { requestId: string; outcome?: unknown; error?: string }) => Promise<void>

  // ========== 桌面能力（单通道多路复用：宿主 DesktopMainController 分发） ==========
  desktopCall: (method: string, args: unknown[]) => Promise<any>
  /** 桌面审计（单工 send：只投递条目，不等回包） */
  desktopAudit: (entry: unknown, imageDataUri?: string) => void

  // ========== 通用监听器管理 ==========
  removeAllListeners: (channel: string) => void

  // ========== relay（传输驻宿主进程，解密/bridge 在渲染进程；Web 首版禁用态） ==========
  relayStart: () => Promise<'started' | 'held-by-other'>
  relayStop: () => Promise<{ ok: boolean }>
  relayStatus: () => Promise<{ running: boolean; holder: string | null; connected: boolean }>
  relayHttpRequest: (opts: {
    method: string
    relayUrl: string
    path: string
    token?: string
    body?: unknown
    caPath?: string
  }) => Promise<{ status: number; json: unknown }>
  /** 媒体直传：二进制 GET（宿主执行，base64 回传） */
  relayHttpGetBinary: (opts: { relayUrl: string; path: string; caPath?: string; range?: string }) => Promise<{ status: number; base64: string | null }>
  /** d→m 文件发送：二进制 PUT（密文分片上传；宿主执行，409 的 current 随 json 回传） */
  relayHttpPutBinary: (opts: { relayUrl: string; path: string; caPath?: string; token: string; offset: number; total: number; base64: string }) => Promise<{ status: number; json: unknown }>
  /** d→m 文件发送读侧：文件切片读（宿主 fs 执行；base64 回传） */
  relayReadFileSlice: (opts: { path: string; offset: number; length: number }) => Promise<{ success: boolean; base64?: string; error?: string }>
  /** d→m 文件发送读侧：文件 stat（null = 不存在；isFile 供"不支持目录"判定） */
  relayStatFile: (opts: { path: string }) => Promise<{ size: number; mtimeMs: number; isFile: boolean } | null>
  /** d→m 文件发送读侧：路径解析（~ 展开 + 相对路径按会话工作目录解析 + 规范化绝对路径；顺带回报 homeDir 与大小写敏感性——桥层 denylist 判定基准） */
  relayResolvePath: (opts: { input: string; workdir?: string }) => Promise<{ path: string; homeDir: string; caseInsensitive: boolean }>
  relayCaFP: (caPath: string) => Promise<{ caFP: string }>
  relayTransportConnect: (opts: {
    relayUrl: string
    mailboxId: string
    readToken: string
    caPath?: string
  }) => Promise<{ ok: boolean }>
  relayTransportClose: () => Promise<{ ok: boolean }>
  onRelayTransportMessage: (callback: (msg: { id: number; blob: string }) => void) => void
  onRelayTransportClosed: (callback: (payload: { code: number }) => void) => void
  onRelayTransportError: (callback: (payload: { message: string }) => void) => void
  onRelayLeaseLost: (callback: () => void) => void
  /** catalog 组包（渲染端无 fs：buildCatalogStateBody 在宿主跑） */
  relayCatalogState: (opts: { known: unknown; activeSessionId: string | null }) => Promise<CatalogStateBody>
  /** 目录元数据监听事件转发 */
  onRelaySessionEvent: (callback: (payload: unknown) => void) => void
}

// ---------- 访问器（M0.2 收敛的统一取用点） ----------

/**
 * 取宿主实现，可能缺省（非宿主环境，如纯浏览器 dev 的回退场景）。
 * 语义对齐既有 `window.electronAPI?.` 可选链调用点。
 */
export function tryGetHostAPI(): HostAPI | undefined {
  return window.electronAPI
}

/**
 * 取宿主实现，要求在场。语义对齐既有 `window.electronAPI.` 直接调用点：
 * 缺席时抛可读错误（此前为裸 TypeError）。
 */
export function getHostAPI(): HostAPI {
  const api = window.electronAPI
  if (!api) {
    throw new Error('[host] HostAPI 未注入（桌面=preload / Web=ws-host）')
  }
  return api
}
