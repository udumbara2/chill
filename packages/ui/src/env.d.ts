/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string
  // 更多环境变量...
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Electron API 类型声明
interface ElectronAPI {
  // API Key 安全存储相关API
  storeApiKey: (provider: string, apiKey: string) => Promise<{ success: boolean; error?: string }>
  getApiKey: (provider: string) => Promise<string | null>
  deleteApiKey: (provider: string) => Promise<boolean>
  getAllProviders: () => Promise<string[]>

  // Key-Value 持久化（同步 IPC，桥接至 FileKeyValueStore）
  getKeyValue: (key: string) => string | null
  setKeyValue: (key: string, value: string) => void
  removeKeyValue: (key: string) => void
  // 桌面能力（单通道多路复用，主进程 DesktopMainController 分发 IDesktopController 各方法）
  desktopCall: (method: string, args: unknown[]) => Promise<any>
  // 移除 IPC 监听器
  removeAllListeners: (channel: string) => void

  agentSave: (agent: any) => Promise<any>
  agentLoad: (id: string) => Promise<any>
  agentList: () => Promise<any>
  agentDelete: (id: string) => Promise<any>
  workflowSave: (workflow: any) => Promise<any>
  workflowLoad: (id: string) => Promise<any>
  workflowList: () => Promise<any>
  workflowDelete: (id: string) => Promise<any>
  draftSave: (draft: any) => Promise<any>
  draftLoad: () => Promise<any>
  draftExists: () => Promise<{ success: boolean; exists: boolean }>
  draftClear: () => Promise<void>
  workflowExport: (id: string, filePath: string) => Promise<any>
  workflowImport: (filePath: string) => Promise<any>
  showSaveDialog: (options: any) => Promise<any>
  showOpenDialog: (options: any) => Promise<any>
  // 文件浏览相关API
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
    success: boolean; 
    content?: string; 
    totalLines?: number;
    startLine?: number;
    endLine?: number;
    encoding?: string;
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
  realpath: (filePath: string) => Promise<{ success: boolean; path?: string; error?: string }>
  fileOpen: (filePath: string) => Promise<{ success: boolean; error?: string }>
  fileWatchStart: (dirPath: string) => Promise<{ success: boolean; error?: string }>
  fileWatchStop: () => Promise<{ success: boolean; error?: string }>
  onFileChanged: (callback: (data: { eventName: string; filePath: string }) => void) => void
  removeFileChangedListener: () => void
  // 附件管理相关API
  saveAttachment: (buffer: ArrayBuffer, fileName: string) => Promise<{ success: boolean; fileId?: string; error?: string }>
  deleteAttachment: (fileId: string) => Promise<{ success: boolean; error?: string }>
  readAttachmentAsBase64: (fileId: string) => Promise<{ success: boolean; base64?: string; error?: string }>

  // 获取用户数据目录
  getUserDataPath: () => Promise<{ success: boolean; path?: string; error?: string }>

  // 会话管理API（后端为 core SessionPersistence，~/.chill/sessions/，与 CLI 共享）
  sessionList: () => Promise<{ success: boolean; records?: any[]; error?: string }>
  sessionSave: (record: any, mode?: 'merge' | 'replace') => Promise<{ success: boolean; error?: string }>
  sessionDelete: (id: string) => Promise<{ success: boolean; error?: string }>
  // 会话跨端同步：watch 重定向 / 发送前锚定 / CLI /ui handoff / 对端变更推送（record 为 null 表示文件被删）
  sessionWatch: (id: string) => Promise<{ success: boolean; error?: string }>
  sessionLoadIfNewer: (id: string) => Promise<{ success: boolean; record?: any | null; error?: string }>
  // handoff 三值：'<id>'=CLI /ui 接力该会话；''=接力但 CLI 无落盘会话（全新空会话）；null=非 /ui 启动
  sessionGetHandoffId: () => Promise<string | null>
  onSessionChanged: (callback: (record: any | null) => void) => void
  // 项目管理API（后端为 core ProjectPersistence，~/.chill/projects.json）
  projectList: () => Promise<{ success: boolean; records?: any[] | null; error?: string }>
  projectSave: (record: any) => Promise<{ success: boolean; error?: string }>
  projectDelete: (id: string) => Promise<{ success: boolean; error?: string }>
  // Node-only 工具路由：渲染进程无 fs，经主进程执行
  executeNodeTool: (name: string, args: string) => Promise<{ success: boolean; data?: any; error?: string }>
  // 规划模式：开关同步主进程 executor；submit_plan/ask_user 提问经 onPlanAskUserRequest 推来，作答经 planAskUserResponse 回传
  setPlanMode: (on: boolean) => Promise<{ success: boolean; error?: string }>
  planAskUserResponse: (id: string, answer: string) => Promise<{ success: boolean; error?: string }>
  onPlanAskUserRequest: (callback: (payload: { id: string; question: string; options?: { label: string; description: string }[]; allowFreeText?: boolean }) => void) => void
  onPlanModeChanged: (callback: (on: boolean) => void) => void
  // 目标模式：开关同步主进程 executor（read_goal 门）；目标文档落盘桥到主进程 goalPersistence
  setGoalMode: (on: boolean) => Promise<{ success: boolean; error?: string }>
  goalSave: (state: any) => Promise<{ success: boolean; error?: string }>
  goalArchive: (state: any) => Promise<{ success: boolean; error?: string }>
  goalClear: () => Promise<{ success: boolean; error?: string }>

  // Orchestrator 远程配置 + 模板管理API（新增）
  orchestratorReadRemoteConfigs: () => Promise<{
    success: boolean
    configs?: any[]
    error?: string
  }>
  orchestratorWriteRemoteConfig: (key: string, config: any) => Promise<{
    success: boolean
    error?: string
  }>
  orchestratorDeleteRemoteConfig: (key: string) => Promise<{
    success: boolean
    error?: string
  }>
  orchestratorGetAllTemplates: () => Promise<{
    success: boolean
    templates?: any[]
    error?: string
  }>
  orchestratorNotifyAgentsChanged: (agents: any[]) => Promise<{
    success: boolean
    error?: string
  }>
  onTemplatesReloaded: (callback: (data: { remoteTemplates: any[]; allTemplates: any[] }) => void) => void
  // A2A 执行相关API
  a2aExecuteTask: (agent: any, params: any) => Promise<{
    success: boolean
    result?: any
    error?: string
  }>
  // Skill 安装管理相关API
  skillInstall: (source: string, subPath?: string) => Promise<{ success: boolean; skillName?: string; error?: string }>
  skillUninstall: (name: string) => Promise<{ success: boolean; error?: string }>
  skillUpdate: (name: string) => Promise<{ success: boolean; error?: string }>
  skillGetBuiltinDir: () => Promise<{ success: boolean; path?: string | null; managed?: boolean; error?: string }>

  // Subagent 执行相关API
  subagentExecute: (request: any) => Promise<{
    success: boolean
    result?: any
    error?: string
  }>
  // 取消后台任务（cancel_task 跨进程 destroy 通道）
  subagentCancel: (request: { environmentKey: string }) => Promise<{
    success: boolean
    error?: string
  }>
  // JavaScript 代码执行相关API（沙箱隔离）
  executeJSCode: (code: string, options?: { timeout?: number; memoryLimit?: number }, language?: string) => Promise<{
    success: boolean
    output?: string
    error?: string
    logs?: string[]
    duration?: number
  }>

  // 交互式代码执行相关API
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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
