import { contextBridge, ipcRenderer } from 'electron'

// API Key安全存储相关API
contextBridge.exposeInMainWorld('electronAPI', {
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
  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionSave: (record: any, mode?: 'merge' | 'replace') => ipcRenderer.invoke('session:save', record, mode),
  sessionDelete: (id: string) => ipcRenderer.invoke('session:delete', id),
  // 会话跨端同步：报告当前会话 id 让主进程重定向 watch；对端变更经 session:changed 推回
  sessionWatch: (id: string) => ipcRenderer.invoke('session:watch', id),
  sessionLoadIfNewer: (id: string) => ipcRenderer.invoke('session:loadIfNewer', id),
  sessionGetHandoffId: () => ipcRenderer.invoke('session:handoff-id'),
  onSessionChanged: (callback: (record: any | null) => void) => {
    ipcRenderer.on('session:changed', (_event, record) => callback(record))
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

  // ========== 工作流持久化相关API ==========
  workflowSave: (workflow: any) => 
    ipcRenderer.invoke('workflow:save', workflow),
  workflowLoad: (id: string) => 
    ipcRenderer.invoke('workflow:load', id),
  workflowList: () => 
    ipcRenderer.invoke('workflow:list'),
  workflowDelete: (id: string) => 
    ipcRenderer.invoke('workflow:delete', id),
  
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
  realpath: (filePath: string) => 
    ipcRenderer.invoke('file:realpath', filePath),
  fileOpen: (filePath: string) => 
    ipcRenderer.invoke('file:open', filePath),
  fileWatchStart: (dirPath: string) => 
    ipcRenderer.invoke('file:watch-start', dirPath),
  fileWatchStop: () => 
    ipcRenderer.invoke('file:watch-stop'),
  onFileChanged: (callback: (data: { eventName: string; filePath: string }) => void) => {
    ipcRenderer.on('file:changed', (_event, data) => callback(data))
  },
  removeFileChangedListener: () => {
    ipcRenderer.removeAllListeners('file:changed')
  },

  // ========== 工作流导出相关API ==========
  workflowExport: (id: string, filePath: string) => 
    ipcRenderer.invoke('workflow:export', { id, filePath }),

  // ========== 工作流导入相关API ==========
  workflowImport: (filePath: string) => 
    ipcRenderer.invoke('workflow:import', { filePath }),

  // ========== AGENT持久化相关API ==========
  agentSave: (agent: any) => 
    ipcRenderer.invoke('agent:save', agent),
  agentLoad: (id: string) => 
    ipcRenderer.invoke('agent:load', id),
  agentList: () => 
    ipcRenderer.invoke('agent:list'),
  agentDelete: (id: string) => 
    ipcRenderer.invoke('agent:delete', id),

  // ========== A2A执行相关API ==========
  a2aExecuteTask: (agent: any, params: any) => 
    ipcRenderer.invoke('a2a:execute-task', { agent, params }),
  a2aExecuteTaskStream: (agent: any, params: any) => 
    ipcRenderer.invoke('a2a:execute-task-stream', { agent, params }),
  onA2AStatusUpdate: (callback: (data: any) => void) => 
    ipcRenderer.on('a2a:status-update', (_, data) => callback(data)),

  // ========== 工作流执行相关API ==========
  workflowExecute: (nodes: any[], edges: any[], input: any, workflowId: string) => 
    ipcRenderer.invoke('workflow:execute', { nodes, edges, input, workflowId }),
  workflowResume: (resumeData: { completed: boolean; output: string; exitCode: number }, workflowId: string) => 
    ipcRenderer.invoke('workflow:resume', { resumeData, workflowId }),
  onWorkflowInterrupt: (callback: (data: { type: string; code: string; language: string }) => void) => 
    ipcRenderer.on('workflow:interrupt', (_, data) => callback(data)),
  onWorkflowEvent: (callback: (data: { type: string; nodeId?: string; data?: any }) => void) => 
    ipcRenderer.on('workflow:event', (_, data) => callback(data)),
  removeWorkflowListeners: () => {
    ipcRenderer.removeAllListeners('workflow:interrupt')
    ipcRenderer.removeAllListeners('workflow:event')
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
  // workDir 变化时通知主进程重挂 hooks.json watch
  hooksSetWorkDir: (dir?: string) =>
    ipcRenderer.invoke('hooks:set-workdir', dir ?? null),
  // 主进程 watch 到 hooks.json 变化时推来，触发 loader 重载（热更新）
  onHooksChanged: (callback: (data: { paths: string[] }) => void) => {
    ipcRenderer.on('hooks:changed', (_event, data) => callback(data))
  },
  // SessionEnd hooks（阶段 4）：主进程 before-quit 推来，渲染进程执行引擎 endSession 后回包
  onSessionEndRequest: (callback: () => void) => {
    ipcRenderer.on('session:end-request', () => callback())
  },
  sessionEndDone: () => ipcRenderer.send('session:end-done'),
  // Worker MCP hooks（阶段 4）：主进程网关在宿主进程内拦到 Worker 的 MCP 调用，但 HookRunner 在渲染进程——
  // 主进程推来派发请求（onWorkerMcpHookRequest），渲染进程经 core 单例 dispatcher 过管线后回包
  onWorkerMcpHookRequest: (callback: (payload: { requestId: string; event: 'PreToolUse' | 'PostToolUse'; call: unknown }) => void) => {
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
})