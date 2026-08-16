export const IPC_CHANNELS = {
  // ========== A2A 工作流执行相关通道 ==========
  A2A_EXECUTE_TASK: 'a2a:execute-task',

  A2A_EXECUTE_TASK_STREAM: 'a2a:execute-task-stream',

  // ========== 安全存储相关通道 ==========
  STORE_API_KEY: 'store-api-key',
  GET_API_KEY: 'get-api-key',
  DELETE_API_KEY: 'delete-api-key',
  GET_ALL_PROVIDERS: 'get-all-providers',

  // ========== MCP 服务相关通道 ==========
  MCP_CONNECTION_STATUS: 'mcp-connection-status',
  MCP_CONNECT_ID: 'mcp-connect-id',
  MCP_DISCONNECT_ID: 'mcp-disconnect-id',
  MCP_LIST_CONNECTIONS: 'mcp-list-connections',
  MCP_LIST_TOOLS: 'mcp-list-tools',
  MCP_LIST_RESOURCES: 'mcp-list-resources',
  MCP_READ_RESOURCE: 'mcp-read-resource',
  MCP_GET_PROMPT: 'mcp-get-prompt',
  MCP_LIST_PROMPTS: 'mcp-list-prompts',
  MCP_CALL_TOOL_WITH_ID: 'mcpCallToolWithId',

  // ========== MCP 状态监听通道 ==========
  MCP_STATUS_UPDATE: 'mcp-status-update',

  // ========== 工作流持久化相关通道 ==========
  WORKFLOW_SAVE: 'workflow:save',
  WORKFLOW_LOAD: 'workflow:load',
  WORKFLOW_LIST: 'workflow:list',
  WORKFLOW_DELETE: 'workflow:delete',

  // ========== 草稿相关通道 ==========
  DRAFT_SAVE: 'draft:save',
  DRAFT_LOAD: 'draft:load',
  DRAFT_EXISTS: 'draft:exists',
  DRAFT_CLEAR: 'draft:clear',

  // ========== 对话框相关通道 ==========
  DIALOG_SHOW_SAVE: 'dialog:showSaveDialog',
  DIALOG_SHOW_OPEN: 'dialog:showOpenDialog',

  // ========== 文件浏览相关通道 ==========
  FILE_LIST_DIRECTORY: 'file:list-directory',

  // ========== 工作流导入导出通道 ==========
  WORKFLOW_EXPORT: 'workflow:export',
  WORKFLOW_IMPORT: 'workflow:import',

  // ========== 工作流执行相关通道 ==========
  WORKFLOW_EXECUTE: 'workflow:execute',
  WORKFLOW_RESUME: 'workflow:resume',
  WORKFLOW_INTERRUPT: 'workflow:interrupt',
  WORKFLOW_EVENT: 'workflow:event',

  // ========== Agent 持久化相关通道 ==========
  AGENT_SAVE: 'agent:save',
  AGENT_LOAD: 'agent:load',
  AGENT_LIST: 'agent:list',
  AGENT_DELETE: 'agent:delete',

  // ========== Orchestrator 远程配置 + 模板管理通道（新增） ==========
  ORCHESTRATOR_READ_REMOTE_CONFIGS: 'orchestrator:read-remote-configs',
  ORCHESTRATOR_WRITE_REMOTE_CONFIG: 'orchestrator:write-remote-config',
  ORCHESTRATOR_DELETE_REMOTE_CONFIG: 'orchestrator:delete-remote-config',
  ORCHESTRATOR_GET_ALL_TEMPLATES: 'orchestrator:get-all-templates',
  ORCHESTRATOR_NOTIFY_AGENTS_CHANGED: 'orchestrator:notify-agents-changed',
  ORCHESTRATOR_TEMPLATES_RELOADED: 'orchestrator:templates-reloaded',

  // ========== Subagent 执行相关通道 ==========
  SUBAGENT_EXECUTE: 'subagent:execute',
  // 取消后台任务：渲染进程 cancel_task 经此通道让主进程销毁对应 Worker 环境
  SUBAGENT_CANCEL: 'subagent:cancel',

  // Subagent Worker 内置工具转发（主进程 → 渲染进程执行 → 回包；挂起配对同 plan:ask-user 模式）
  SUBAGENT_BUILTIN_REQUEST: 'subagent:builtin-request',
  SUBAGENT_BUILTIN_RESPONSE: 'subagent:builtin-response',

  // ========== Skill 安装管理通道 ==========
  SKILL_INSTALL: 'skill:install',
  SKILL_UNINSTALL: 'skill:uninstall',
  SKILL_UPDATE: 'skill:update',

  // ========== PowerShell 执行相关通道 ==========
  POWERSHELL_EXECUTE: 'powershell:execute',

  // ========== 桌面能力通道（单通道多路复用：payload { method, args } 分发 IDesktopController 各方法） ==========
  DESKTOP_CALL: 'desktop:call',

  // ========== 代码执行相关通道 ==========
  CODE_EXECUTE_JS: 'code:execute-js',
  CODE_START_INTERACTIVE: 'code:start-interactive',
  CODE_INPUT: 'code:input',
  CODE_OUTPUT: 'code:output',
  CODE_TERMINATE: 'code:terminate',
  CODE_EXIT: 'code:exit',
  // ========== 生命周期 hooks 通道（阶段 3：UI 渲染进程经主进程执行/探测/watch） ==========
  HOOKS_RUN: 'hooks:run',
  HOOKS_MTIME: 'hooks:mtime',
  HOOKS_SET_WORKDIR: 'hooks:set-workdir',
  HOOKS_CHANGED: 'hooks:changed',

  // ========== SessionEnd hooks（阶段 4）：before-quit 主进程 → 渲染进程引擎 endSession ==========
  SESSION_END_REQUEST: 'session:end-request',
  SESSION_END_DONE: 'session:end-done',

  // ========== Worker MCP hooks（阶段 4）：主进程网关 → 渲染进程引擎 hook 派发（挂起配对同 subagent:builtin-request） ==========
  WORKER_MCP_HOOK_REQUEST: 'worker-mcp-hook:request',
  WORKER_MCP_HOOK_RESPONSE: 'worker-mcp-hook:response',
} as const

export type IPCChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]
