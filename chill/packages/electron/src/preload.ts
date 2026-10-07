import { contextBridge, ipcRenderer } from 'electron'
// 宿主合同（M0.3）：形状由共享渲染层的 HostAPI 约束——缺员/签名漂移在此处编译期报错；
// import type 编译期擦除，esbuild 打包零运行时依赖（红线：渲染层代码不进主进程产物）。
import type { HostAPI } from '@assistant-ai/ui/host'

// API Key安全存储相关API
const api: HostAPI = {
  // API Key 安全存储相关API
  storeApiKey: (provider: string, apiKey: string) => 
    ipcRenderer.invoke('store-api-key', provider, apiKey),
  getApiKey: (provider: string) => 
    ipcRenderer.invoke('get-api-key', provider),
  deleteApiKey: (provider: string) => 
    ipcRenderer.invoke('delete-api-key', provider),
  getAllProviders: () => 
    ipcRenderer.invoke('get-all-providers'),

  // Key-Value 持久化（同步 IPC）
  getKeyValue: (key: string) => ipcRenderer.sendSync('kv:get', key),
  setKeyValue: (key: string, value: string) => ipcRenderer.sendSync('kv:set', key, value),
  removeKeyValue: (key: string) => ipcRenderer.sendSync('kv:remove', key),

  // ========== 会话管理API ==========
  // 会话元数据列表（SessionSummary[]，走 sessionIndex 对账，无变化零 parse）
  sessionListMeta: () => ipcRenderer.invoke('session:list-meta'),
  // 单会话直读（只读一个文件，替代全量 list+find）
  sessionLoad: (id: string) => ipcRenderer.invoke('session:load', id),
  // 项目归属单字段补丁：projectId 传 null 清除归属
  sessionPatchProject: (id: string, projectId: string | null) => ipcRenderer.invoke('session:patch-project', id, projectId),
  // 会话标题单字段补丁（行内重命名；落 titleSource='manual'，不动 updatedAt）
  sessionPatchTitle: (id: string, title: string) => ipcRenderer.invoke('session:patch-title', id, title),
  // 会话内容搜索（侧边栏搜索框）：命中标题或正文，返回结构化 hits
  sessionSearch: (query: string) => ipcRenderer.invoke('session:search', query),
  sessionSave: (record: any, mode?: 'merge' | 'replace') => ipcRenderer.invoke('session:save', record, mode),
  sessionDelete: (id: string) => ipcRenderer.invoke('session:delete', id),
  // 会话跨端同步：报告当前会话 id 让主进程重定向 watch；对端变更经 session:changed 推回
  sessionWatch: (id: string) => ipcRenderer.invoke('session:watch', id),
  sessionLoadIfNewer: (id: string) => ipcRenderer.invoke('session:loadIfNewer', id),
  sessionGetHandoffId: () => ipcRenderer.invoke('session:handoff-id'),
  onSessionChanged: (callback: (record: any | null) => void) => {
    ipcRenderer.on('session:changed', (_event, record) => callback(record))
  },
  // 窗口重新聚焦推送（UI 在用户注意力边界全量刷新会话列表，覆盖对端对非当前会话的改动）
  onWindowFocused: (callback: () => void) => {
    ipcRenderer.on('window:focused', () => callback())
  },

  // ========== 项目管理API ==========
  projectList: () => ipcRenderer.invoke('project:list'),
  projectSave: (record: any) => ipcRenderer.invoke('project:save', record),
  projectDelete: (id: string) => ipcRenderer.invoke('project:delete', id),
  // Node-only 工具路由：渲染进程无 fs，经主进程执行
  executeNodeTool: (name: string, args: string) => ipcRenderer.invoke('builtin:execute-node-tool', name, args),

  // ========== 规划模式 ==========
  // 开关同步到主进程 executor；submit_plan/ask_user 的提问经 onPlanAskUserRequest 推来，作答经 planAskUserResponse 回传
  setPlanMode: (on: boolean) => ipcRenderer.invoke('plan:set-mode', on),
  planAskUserResponse: (id: string, answer: string) => ipcRenderer.invoke('plan:ask-user-response', id, answer),
  onPlanAskUserRequest: (callback: (payload: { id: string; question: string; options?: { label: string; description: string }[]; allowFreeText?: boolean }) => void) => {
    ipcRenderer.on('plan:ask-user-request', (_event, payload) => callback(payload))
  },
  onPlanModeChanged: (callback: (on: boolean) => void) => {
    ipcRenderer.on('plan:mode-changed', (_event, on) => callback(on))
  },

  // ========== 目标模式 ==========
  // 开关同步主进程 executor（read_goal 门）；目标文档落盘桥到主进程 goalPersistence（渲染进程引擎的 goalStore）
  setGoalMode: (on: boolean) => ipcRenderer.invoke('goal:set-mode', on),
  goalSave: (state: any) => ipcRenderer.invoke('goal:save', state),
  goalArchive: (state: any) => ipcRenderer.invoke('goal:archive', state),
  goalClear: () => ipcRenderer.invoke('goal:clear'),

  // ========== MCP服务相关API ==========
  mcpGetConnectionStatus: () => 
    ipcRenderer.invoke('mcp-connection-status'),

  // ========== 新增支持连接ID的接口 ==========
  // 支持连接ID的连接
  mcpConnectWithId: (config: any, connectionId?: string) => 
    ipcRenderer.invoke('mcp-connect-id', config, connectionId),
  
  // 断开指定连接
  mcpDisconnectWithId: (connectionId: string) => 
    ipcRenderer.invoke('mcp-disconnect-id', connectionId),
  
  // 获取所有连接列表
  mcpListConnections: () => 
    ipcRenderer.invoke('mcp-list-connections'),
  
  // 获取指定连接的工具列表
  mcpListToolsWithId: (connectionId?: string) => 
    ipcRenderer.invoke('mcp-list-tools', connectionId),
  
  // 获取指定连接的资源列表
  mcpListResourcesWithId: (connectionId?: string) => 
    ipcRenderer.invoke('mcp-list-resources', connectionId),
  
  // 读取指定连接的资源内容
  mcpReadResourceWithId: (uri: string, connectionId?: string) => 
    ipcRenderer.invoke('mcp-read-resource', uri, connectionId),
  
  // 获取指定连接的提示词内容
  mcpGetPromptWithId: (name: string, args?: { [key: string]: string }, connectionId?: string) => 
    ipcRenderer.invoke('mcp-get-prompt', name, args, connectionId),
  
  // 获取指定连接的提示词列表
  mcpListPromptsWithId: (connectionId?: string) => 
    ipcRenderer.invoke('mcp-list-prompts', connectionId),
  
  // 工具调用相关接口
  mcpCallToolWithId: (toolName: string, args?: Record<string, any>, connectionId?: string) => 
    ipcRenderer.invoke('mcpCallToolWithId', toolName, args, connectionId),
  
  // 回退API定义（编译后可能没有WithId后缀）
  mcpReadResource: (uri: string, connectionId?: string) => 
    ipcRenderer.invoke('mcp-read-resource', uri, connectionId),
  mcpGetPrompt: (name: string, args?: { [key: string]: string }, connectionId?: string) => 
    ipcRenderer.invoke('mcp-get-prompt', name, args, connectionId),

  // ========== MCP状态监听相关API ==========
  // 监听MCP状态更新事件
  onMCPStatusUpdate: (callback: (data: {
    connectionId: string
    status: 'connecting' | 'connected' | 'disconnected'
    serverName?: string
    timestamp: number
  }) => void) => ipcRenderer.on('mcp-status-update', (_, data) => callback(data)),
  
  // 移除所有监听器
  removeAllListeners: (channel: string) => 
    ipcRenderer.removeAllListeners(channel),

  // ========== 草稿相关API ==========
  draftSave: (draft: any) => 
    ipcRenderer.invoke('draft:save', draft),
  draftLoad: () => 
    ipcRenderer.invoke('draft:load'),
  draftExists: () => 
    ipcRenderer.invoke('draft:exists'),
  draftClear: () => 
    ipcRenderer.invoke('draft:clear'),

  // ========== 对话框相关API ==========
  showSaveDialog: (options: any) => 
    ipcRenderer.invoke('dialog:showSaveDialog', options),
  showOpenDialog: (options: any) => 
    ipcRenderer.invoke('dialog:showOpenDialog', options),

  // ========== 文件浏览相关API ==========
  fileListDirectory: (dirPath: string, options?: { includeHidden?: boolean }) => 
    ipcRenderer.invoke('file:list-directory', dirPath, options),
  fileRead: (filePath: string, options?: { limit?: number; offset?: number }) => 
    ipcRenderer.invoke('file:read', filePath, options),
  fileReadBase64: (filePath: string) => 
    ipcRenderer.invoke('file:read-base64', filePath),
  fileWrite: (filePath: string, content: string, encoding?: string) => 
    ipcRenderer.invoke('file:write', filePath, content, encoding),
  fileDelete: (filePath: string) => 
    ipcRenderer.invoke('file:delete', filePath),
  fileRename: (oldPath: string, newPath: string) => 
    ipcRenderer.invoke('file:rename', oldPath, newPath),
  fileCreate: (filePath: string, content?: string) => 
    ipcRenderer.invoke('file:create', filePath, content),
  fileMkdir: (dirPath: string) => 
    ipcRenderer.invoke('file:mkdir', dirPath),
  fileExists: (filePath: string) => 
    ipcRenderer.invoke('file:exists', filePath),
  getPathType: (filePath: string) => 
    ipcRenderer.invoke('file:get-path-type', filePath),
  fileStat: (filePath: string) =>
    ipcRenderer.invoke('file:stat', filePath),
  fileCreateExclusive: (filePath: string, content: string) =>
    ipcRenderer.invoke('file:create-exclusive', filePath, content),
  realpath: (filePath: string) => 
    ipcRenderer.invoke('file:realpath', filePath),
  fileOpen: (filePath: string) => 
    ipcRenderer.invoke('file:open', filePath),
  fileWatchSet: (paths: string[]) => 
    ipcRenderer.invoke('file:watch-set', paths),
  fileWatchStop: () => 
    ipcRenderer.invoke('file:watch-stop'),
  onFileChanged: (callback: (data: { eventName: string; filePath: string }) => void) => {
    ipcRenderer.on('file:changed', (_event, data) => callback(data))
  },
  removeFileChangedListener: () => {
    ipcRenderer.removeAllListeners('file:changed')
  },

  // ========== 附件管理相关API ==========
  saveAttachment: (buffer: ArrayBuffer, fileName: string) => 
    ipcRenderer.invoke('attachment:save', buffer, fileName),
  deleteAttachment: (fileId: string) => 
    ipcRenderer.invoke('attachment:delete', fileId),
  readAttachmentAsBase64: (fileId: string) => 
    ipcRenderer.invoke('attachment:read-as-base64', fileId),

  // 获取用户数据目录
  getUserDataPath: () =>
    ipcRenderer.invoke('app:get-user-data-path'),
  // 本实例主进程 PID(团队运行态 hostPid 注入源;渲染进程 process 是 polyfill 无 pid)
  getMainPid: () =>
    ipcRenderer.invoke('app:main-pid'),

  // ========== 窗口提醒API（助手回合完成 → 主进程按窗口聚焦态决定是否任务栏闪烁） ==========
  notifyTurnCompleted: () =>
    ipcRenderer.invoke('window:notify-turn-completed'),

  // ========== Orchestrator 远程配置 + 模板管理API（新增） ==========
  // 读取远程配置
  orchestratorReadRemoteConfigs: () => 
    ipcRenderer.invoke('orchestrator:read-remote-configs'),
  // 写入远程配置
  orchestratorWriteRemoteConfig: (key: string, config: any) => 
    ipcRenderer.invoke('orchestrator:write-remote-config', key, config),
  // 删除远程配置
  orchestratorDeleteRemoteConfig: (key: string) => 
    ipcRenderer.invoke('orchestrator:delete-remote-config', key),
  // 获取所有模板
  orchestratorGetAllTemplates: () => 
    ipcRenderer.invoke('orchestrator:get-all-templates'),
  // 通知 Agent 变更
  orchestratorNotifyAgentsChanged: (agents: any[]) => 
    ipcRenderer.invoke('orchestrator:notify-agents-changed', agents),
  // 监听模板重载推送
  onTemplatesReloaded: (callback: (data: { remoteTemplates: any[]; allTemplates: any[] }) => void): void => {
    ipcRenderer.on('orchestrator:templates-reloaded', (_, data) => callback(data))
  },
  // 监听命名工作流目录变更推送(M2 热生效)
  onWorkflowsChanged: (callback: () => void): void => {
    ipcRenderer.on('workflows:changed', () => callback())
  },
  // 登记需要监听的工作流目录(用户级 + 项目级)
  watchWorkflowDirs: (dirs: string[]) =>
    ipcRenderer.invoke('workflows:watch-dirs', dirs),
  // 监听固定团队目录变更推送(热生效)
  onTeamsChanged: (callback: () => void): void => {
    ipcRenderer.on('teams:changed', () => callback())
  },
  // 登记需要监听的团队目录(用户级 + 项目级)
  watchTeamDirs: (dirs: string[]) =>
    ipcRenderer.invoke('teams:watch-dirs', dirs),
  // 监听跨进程团队运行快照目录变更推送(UI 三层显示统一 · 迭代 2 快照区)
  onTeamRunsChanged: (callback: () => void): void => {
    ipcRenderer.on('team-runs:changed', () => callback())
  },
  // 查询存活兄弟实例 PID(快照区存活探测;主进程 instanceRegistry)
  getLiveInstancePids: () =>
    ipcRenderer.invoke('instances:live-pids'),
  // 执行过程面板:Worker 工具调用事件推送(委派执行/网关在主进程,事件经此桥到达渲染进程)
  onSubagentToolCall: (callback: (payload: any) => void): void => {
    ipcRenderer.on('subagent-tool-call', (_, payload) => callback(payload))
  },

  // ========== Subagent 执行相关API ==========
  subagentExecute: (request: any) =>
    ipcRenderer.invoke('subagent:execute', request),
  // 取消后台任务（cancel_task 跨进程 destroy 通道）：主进程按环境绑定键销毁 Worker 环境
  subagentCancel: (request: { environmentKey: string }) =>
    ipcRenderer.invoke('subagent:cancel', request),

  // Subagent Worker 内置工具转发：主进程推来执行请求（onSubagentBuiltinRequest），
  // 渲染进程经 core 单例 executeAsync 执行（真实确认流/fs 桥）后 subagentBuiltinResponse 回包
  onSubagentBuiltinRequest: (callback: (payload: { requestId: string; toolName: string; args: string; toolCallId?: string }) => void) => {
    ipcRenderer.on('subagent:builtin-request', (_event, payload) => callback(payload))
  },
  subagentBuiltinResponse: (payload: { requestId: string; result?: any; error?: string }) =>
    ipcRenderer.invoke('subagent:builtin-response', payload),

  // ========== Skill 安装管理相关API ==========
  skillInstall: (source: string, subPath?: string) =>
    ipcRenderer.invoke('skill:install', source, subPath),
  skillUninstall: (name: string) =>
    ipcRenderer.invoke('skill:uninstall', name),
  skillUpdate: (name: string) =>
    ipcRenderer.invoke('skill:update', name),
  skillGetBuiltinDir: () =>
    ipcRenderer.invoke('skill:builtin-dir'),

  // ========== PowerShell 执行相关API ==========
  executePowerShell: (command: string, options?: { workingDirectory?: string; timeout?: number }) => 
    ipcRenderer.invoke('powershell:execute', { command, options }),

  // ========== 桌面能力API（迭代 4.1：单通道多路复用，napi 实现在主进程 DesktopMainController） ==========
  desktopCall: (method: string, args: unknown[]) =>
    ipcRenderer.invoke('desktop:call', { method, args }),
  // 桌面审计（单工 send：只投递条目给主进程落盘，不等回包）
  desktopAudit: (entry: unknown, imageDataUri?: string) =>
    ipcRenderer.send('desktop:audit', entry, imageDataUri),

  // ========== JavaScript 代码执行相关API（沙箱隔离） ==========
  executeJSCode: (code: string, options?: { timeout?: number; memoryLimit?: number; cwd?: string }, language?: string) => 
    ipcRenderer.invoke('code:execute-js', { code, options, language }),

  // ========== 生命周期 hooks（阶段 3：桌面 UI 支持） ==========
  // hook 命令经主进程 child_process 执行（渲染进程无 child_process）；
  // cwd 随调用传入（引擎会话 workDir），注入 CHILL_PROJECT_DIR/CLAUDE_PROJECT_DIR 别名
  hooksRun: (payload: { command: string; inputJson: string; timeoutMs: number; cwd?: string }) =>
    ipcRenderer.invoke('hooks:run', payload),
  // hooks.json 的 mtime 探测（core HookConfigLoader 惰性重载依赖；渲染进程 fs 是空 shim）
  hooksMtime: (filePath: string) =>
    ipcRenderer.invoke('hooks:mtime', filePath),
  // 会话看板快照存取（core SessionBoardStore 的 IPC 桥；主进程 fs 落盘 ~/.chill/boards）
  boardLoad: (boardId: string) =>
    ipcRenderer.invoke('board:load', boardId),
  boardSave: (state: unknown) =>
    ipcRenderer.invoke('board:save', state),
  boardExists: (boardId: string) =>
    ipcRenderer.invoke('board:exists', boardId),
  boardArchive: (boardId: string, reason: string) =>
    ipcRenderer.invoke('board:archive', boardId, reason),
  // SessionEnd hooks（阶段 4）：主进程 before-quit 推来，渲染进程执行引擎 endSession 后回包
  onSessionEndRequest: (callback: () => void) => {
    ipcRenderer.on('session:end-request', () => callback())
  },
  sessionEndDone: () => ipcRenderer.send('session:end-done'),
  // Worker MCP hooks（阶段 4）：主进程网关在宿主进程内拦到 Worker 的 MCP 调用，但 HookRunner 在渲染进程——
  // 主进程推来派发请求（onWorkerMcpHookRequest），渲染进程经 core 单例 dispatcher 过管线后回包
  onWorkerMcpHookRequest: (callback: (payload: { requestId: string; event: 'PreToolUse' | 'PostToolUse'; call: any }) => void) => {
    ipcRenderer.on('worker-mcp-hook:request', (_event, payload) => callback(payload))
  },
  workerMcpHookResponse: (payload: { requestId: string; outcome?: unknown; error?: string }) =>
    ipcRenderer.invoke('worker-mcp-hook:response', payload),

  // ========== 交互式代码执行相关API ==========
  startInteractiveExecution: (code: string, language?: string, options?: { timeout?: number }) => 
    ipcRenderer.invoke('code:start-interactive', { code, language, options }),
  
  sendInput: (processId: string, input: string) => 
    ipcRenderer.invoke('code:input', { processId, input }),
  
  terminateProcess: (processId: string) => 
    ipcRenderer.invoke('code:terminate', { processId }),
  
  onOutput: (callback: (data: { processId: string; data: string; type: 'stdout' | 'stderr' }) => void) => {
    ipcRenderer.on('code:output', (_, data) => callback(data))
  },
  
  onExit: (callback: (data: { processId: string; code: number; reason: string; error?: string }) => void) => {
    ipcRenderer.on('code:exit', (_, data) => callback(data))
  },
  
  removeInteractiveListeners: () => {
    ipcRenderer.removeAllListeners('code:output')
    ipcRenderer.removeAllListeners('code:exit')
  },

  // ========== relay（M2a：传输驻主进程，解密/bridge 在本进程） ==========
  relayStart: () => ipcRenderer.invoke('relay:start'),
  relayStop: () => ipcRenderer.invoke('relay:stop'),
  relayStatus: () => ipcRenderer.invoke('relay:status'),
  relayHttpRequest: (opts: { method: string; relayUrl: string; path: string; token?: string; body?: unknown; caPath?: string }) =>
    ipcRenderer.invoke('relay:http-request', opts),
  relayHttpGetBinary: (opts: { relayUrl: string; path: string; caPath?: string; range?: string }) =>
    ipcRenderer.invoke('relay:http-get-binary', opts),
  // d→m 文件发送（密文分片上传 + 读侧切片/stat/路径解析——渲染进程无 tls/任意路径读能力，主进程执行）
  relayHttpPutBinary: (opts: { relayUrl: string; path: string; caPath?: string; token: string; offset: number; total: number; base64: string }) =>
    ipcRenderer.invoke('relay:http-put-binary', opts),
  relayReadFileSlice: (opts: { path: string; offset: number; length: number }) =>
    ipcRenderer.invoke('relay:read-file-slice', opts),
  relayStatFile: (opts: { path: string }) =>
    ipcRenderer.invoke('relay:stat-file', opts),
  relayResolvePath: (opts: { input: string; workdir?: string }) =>
    ipcRenderer.invoke('relay:resolve-path', opts),
  relayCaFP: (caPath: string) => ipcRenderer.invoke('relay:ca-fp', { caPath }),
  relayTransportConnect: (opts: { relayUrl: string; mailboxId: string; readToken: string; caPath?: string }) =>
    ipcRenderer.invoke('relay:transport-connect', opts),
  relayTransportClose: () => ipcRenderer.invoke('relay:transport-close'),
  onRelayTransportMessage: (callback: (msg: { id: number; blob: string }) => void) => {
    ipcRenderer.on('relay:transport-message', (_event, msg) => callback(msg))
  },
  onRelayTransportClosed: (callback: (payload: { code: number }) => void) => {
    ipcRenderer.on('relay:transport-closed', (_event, payload) => callback(payload))
  },
  onRelayTransportError: (callback: (payload: { message: string }) => void) => {
    ipcRenderer.on('relay:transport-error', (_event, payload) => callback(payload))
  },
  onRelayLeaseLost: (callback: () => void) => {
    ipcRenderer.on('relay:lease-lost', () => callback())
  },
  // M6 会话同步（渲染端无 fs）：catalog 组包回主进程（buildCatalogStateBody 同一函数）；
  // 目录监听在主进程 wireSessionCatalogWatch，事件经此转发渲染端投当前桥
  relayCatalogState: (opts: { known: unknown; activeSessionId: string | null }) =>
    ipcRenderer.invoke('relay:catalog-state', opts),
  onRelaySessionEvent: (callback: (payload: unknown) => void) => {
    ipcRenderer.on('relay:session-event', (_event, payload) => callback(payload))
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)