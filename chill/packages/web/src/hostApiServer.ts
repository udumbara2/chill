/**
 * HostAPI 服务端分发表（M1.3/M1.5）
 *
 * 方法名 = preload 的既有 IPC 通道名（翻译成本最低）。M1 实装面：
 * app 信息 / kv / 安全存储 / 会话+项目 / 只读 fs（~/.chill 白名单）/ skill 内置目录。
 * 其余方法如实返回 not-implemented 并标注所属里程碑——不伪装成功。
 */
import type { KvGateway } from './capabilities/kvGateway'
import type { WebSecureStorage } from './capabilities/secureStorage'
import type { FsGateway } from './capabilities/fsGateway'
import type { SessionsGateway } from './capabilities/sessionsGateway'
import { RemoteConfigsGateway } from './capabilities/remoteConfigsGateway'
import { rewriteModelJsonBaseURLs } from './capabilities/modelProxy'
import type { NodeToolsGateway } from './capabilities/nodeToolsGateway'
import type { CodeExecGateway } from './capabilities/codeExecGateway'
import type { McpGateway } from './capabilities/mcpGateway'
import type { WatchGateway } from './capabilities/watchGateway'
import type { AssetsGateway } from './capabilities/assetsGateway'
import type { DialogsGateway } from './capabilities/dialogsGateway'
import type { NodeHookProcessRunner } from '@assistant-ai/core'
import type { SubagentGateway } from './capabilities/subagentGateway'
import { join } from 'node:path'

export type Handler = (...args: unknown[]) => unknown | Promise<unknown>

export interface DispatchDeps {
  userDataPath: string
  kv: KvGateway
  secure: WebSecureStorage
  fs: FsGateway
  sessions: SessionsGateway
  remoteConfigs: RemoteConfigsGateway
  /** daemon 监听端口现读（模型代理 baseURL 改写的绝对地址需要） */
  getPort: () => number
  nodeTools: NodeToolsGateway
  codeExec: CodeExecGateway
  mcp: McpGateway
  watchBridge: WatchGateway
  assets: AssetsGateway
  dialogs: DialogsGateway
  hooksRunner: NodeHookProcessRunner
  subagents: SubagentGateway
  /** skill 内置目录探测（serve.ts 注入：bundle 内 dist/skills/builtin 或源码树） */
  skillBuiltinDir: () => { success: boolean; path?: string | null; managed?: boolean; error?: string }
  /** fs 只读闸（家目录降级）：UI 权限选择器联动的查询/开关；set 仅在 downgraded 时实际生效 */
  fsGate: { downgraded: boolean; enforced: () => boolean; set: (v: boolean) => void }
}

/** not-implemented 占位：如实标注所属里程碑 */
function ni(milestone: string): Handler {
  return () => {
    throw new Error(`该方法在 ${milestone} 里程碑启用（当前 M1 只读浏览）`)
  }
}

export function createDispatch(deps: DispatchDeps): Map<string, Handler> {
  const d = new Map<string, Handler>()

  // ---------- app 信息 ----------
  d.set('app:get-user-data-path', () => ({ success: true, path: deps.userDataPath }))
  d.set('app:main-pid', () => ({ success: true, pid: process.pid }))

  // ---------- KV（同步语义经快照+广播实现，见 kvGateway） ----------
  d.set('kv:get', (key) => deps.kv.getItem(String(key)))
  d.set('kv:set', (key, value) => { deps.kv.setItem(String(key), String(value)); return null })
  d.set('kv:remove', (key) => { deps.kv.removeItem(String(key)); return null })

  // ---------- 安全存储 ----------
  d.set('store-api-key', (provider, apiKey) => deps.secure.storeApiKey(String(provider), String(apiKey)))
  d.set('get-api-key', (provider) => deps.secure.getApiKey(String(provider)))
  d.set('delete-api-key', (provider) => deps.secure.deleteApiKey(String(provider)))
  d.set('get-all-providers', () => deps.secure.getAllProviders())

  // ---------- 会话 + 项目 ----------
  d.set('session:list-meta', () => deps.sessions.listMeta())
  d.set('session:load', (id) => deps.sessions.load(String(id)))
  d.set('session:save', (record, mode) => deps.sessions.save(record as never, mode as never))
  d.set('session:patch-project', (id, projectId) => deps.sessions.patchProject(String(id), projectId as string | null))
  d.set('session:patch-title', (id, title) => deps.sessions.patchTitle(String(id), String(title)))
  d.set('session:search', (query) => deps.sessions.search(String(query ?? '')))
  d.set('session:delete', (id) => deps.sessions.delete(String(id)))
  // session:watch 由 serve.ts 直接拦截（会话租约换向），不经此表
  d.set('session:loadIfNewer', (id) => deps.sessions.loadIfNewer(String(id)))
  d.set('session:handoff-id', () => null) // /ui handoff 是 CLI 专属接力语义，web 恒无
  d.set('project:list', () => deps.sessions.projectList())
  d.set('project:save', (record) => deps.sessions.projectSave(record))
  d.set('project:delete', (id) => deps.sessions.projectDelete(String(id)))

  // ---------- fs（M1 只读白名单） ----------
  d.set('file:list-directory', (p, options) => deps.fs.listDirectory(String(p), options as never))
  d.set('file:read', async (p, options) => {
    const result = await deps.fs.readFile(String(p), options as never)
    // M2.1 baseURL 单点改写：models 目录下的模型 JSON（adapterConfig.baseURL/apiURL）
    // → 代理前缀。桌面不经此表（electron-main 无此步），web 渲染层零改动拿到代理地址。
    const record = result as Record<string, unknown>
    if (result.success && typeof record.content === 'string') {
      const norm = String(p).replace(/\\/g, '/').toLowerCase()
      const modelsPrefix = join(deps.userDataPath, 'models').replace(/\\/g, '/').toLowerCase()
      if (norm.startsWith(modelsPrefix + '/') && norm.endsWith('.json')) {
        record.content = rewriteModelJsonBaseURLs(record.content, deps.getPort())
      }
    }
    return result
  })
  d.set('file:read-base64', (p) => deps.fs.readFileBase64(String(p)))
  d.set('file:exists', (p) => deps.fs.exists(String(p)))
  d.set('file:get-path-type', (p) => deps.fs.getPathType(String(p)))
  d.set('file:stat', (p) => deps.fs.statFile(String(p)))
  d.set('file:realpath', (p) => deps.fs.realpath(String(p)))

  // ---------- skill 内置目录（启动期 boot 面） ----------
  d.set('skill:builtin-dir', () => deps.skillBuiltinDir())

  // ---------- M1 明示 stub（boot 面订阅类：客户端本地注册表承接，无需服务端） ----------
  // onXxx 订阅族完全在 ws-host 客户端实现，无对应服务端方法——不在此注册。

  // ---------- M3 实装面 ----------
  // 文件写族（M3.4：白名单含 userData + serve 启动目录；备份在渲染层引擎 BackupStore）
  d.set('file:write', (p, c, e) => deps.fs.writeFile(String(p), String(c), e as string | undefined))
  d.set('file:delete', (p) => deps.fs.deleteFile(String(p)))
  d.set('file:rename', (a, b) => deps.fs.renameFile(String(a), String(b)))
  d.set('file:create', (p, c) => deps.fs.createFile(String(p), c as string | undefined))
  d.set('file:mkdir', (p) => deps.fs.mkdir(String(p)))
  // fs 只读闸（家目录降级）：UI 权限选择器联动——查询当前态 / 会话级抬落闸
  d.set('fs:get-gate', () => ({ enforced: deps.fsGate.enforced(), downgraded: deps.fsGate.downgraded }))
  d.set('fs:set-gate', (enforced) => {
    deps.fsGate.set(enforced === true)
    return { success: true, enforced: deps.fsGate.enforced() }
  })
  d.set('file:open', ni('M3.6（系统打开：Windows shell 等价物排期）'))
  // watch 桥（M3.8）
  d.set('file:watch-set', (paths) => { deps.watchBridge.setFileWatchSet(paths as string[]); return { success: true } })
  d.set('file:watch-stop', () => { deps.watchBridge.stopFileWatch(); return { success: true } })
  // 附件（M3.6）
  d.set('attachment:save', (buf, name) => deps.dialogs.saveAttachment(buf as ArrayBuffer, String(name)))
  d.set('attachment:delete', (id) => deps.dialogs.deleteAttachment(String(id)))
  d.set('attachment:read-as-base64', (id) => deps.dialogs.readAttachmentAsBase64(String(id)))
  // 对话框（M3.6：PowerShell Forms 原生选择器）
  d.set('dialog:showSaveDialog', () => deps.dialogs.showSaveDialog())
  d.set('dialog:showOpenDialog', (o) => deps.dialogs.showOpenDialog(o as never))
  // hooks（M3.7：NodeHookProcessRunner 下沉 core 后共用；cwd 取 serve 启动目录）
  d.set('hooks:run', (payload) => {
    const p = payload as { command: string; inputJson: string; timeoutMs: number; cwd?: string }
    return deps.hooksRunner.run(p.command, p.inputJson, p.timeoutMs)
  })
  d.set('hooks:mtime', async (filePath) => {
    try {
      const stat = await import('node:fs').then((m) => m.promises.stat(String(filePath)))
      return stat.mtimeMs
    } catch {
      return null
    }
  })
  // skill（M3.9）
  d.set('skill:install', (s, p) => deps.assets.skillInstall(String(s), p as string | undefined))
  d.set('skill:uninstall', (n) => deps.assets.skillUninstall(String(n)))
  d.set('skill:update', (n) => deps.assets.skillUpdate(String(n)))
  // goal（M3.9）
  d.set('goal:save', (state) => deps.assets.goalSave(state))
  d.set('goal:archive', (state) => deps.assets.goalArchive(state))
  d.set('goal:clear', () => deps.assets.goalClear())
  d.set('goal:set-mode', (on) => { deps.nodeTools.setGoalMode(!!on); return { success: true } })
  // plan 族（M3.1：Node-only 工具执行器 + ask-back）
  d.set('plan:set-mode', (on) => { deps.nodeTools.setPlanMode(!!on); return { success: true } })
  d.set('plan:ask-user-response', (id, answer) => ({ success: deps.nodeTools.resolveAsk(String(id), String(answer)) }))
  d.set('builtin:execute-node-tool', (name, args) => deps.nodeTools.executeTool(String(name), String(args)))
  // 命令与代码执行（M3.2）
  d.set('powershell:execute', (command, options) => deps.codeExec.powerShell(String(command), options))
  d.set('code:execute-js', (code, options, language) => deps.codeExec.executeJs(String(code), options, language as string | undefined))
  d.set('code:start-interactive', (code, language, options) => deps.codeExec.startInteractive(String(code), language as string | undefined, options as never))
  d.set('code:input', (id, input) => deps.codeExec.sendInput(String(id), String(input)))
  d.set('code:terminate', (id) => deps.codeExec.terminate(String(id)))
  // MCP 全族（M3.5：stdio spawn 在本进程；状态经 mcp-status-update 广播）
  // MCP 连接状态：isClientConnected() 期望 {success, isConnected} 形状（桌面 ElectronMCPService
  // 的 getActiveConnections 同语义）——daemon 侧聚合为单值
  d.set('mcp-connection-status', async () => {
    const conns = await deps.mcp.getStatus() as Array<{ status: string }>
    const anyConnected = conns.some((c) => c.status === 'connected')
    return { success: true, isConnected: anyConnected, status: anyConnected ? 'connected' : 'disconnected' }
  })
  d.set('mcp-connect-id', (config, id) => deps.mcp.connect(config, id as string | undefined))
  d.set('mcp-disconnect-id', (id) => deps.mcp.disconnect(String(id)))
  // MCP 连接列表：MCPConnectionManager 返回裸数组，mcpService.getOpenAITools() 期望
  // {success, connections} 形状（桌面 ElectronMCPService 同款包装）——此处包一层对齐
  d.set('mcp-list-connections', async () => {
    const conns = await deps.mcp.listConnections() as Array<{ connectionId: string; name?: string; transportType: string; status: string }>
    return { success: true, connections: conns }
  })
  d.set('mcp-list-tools', (id) => deps.mcp.listTools(id as string | undefined))
  d.set('mcp-list-resources', (id) => deps.mcp.listResources(id as string | undefined))
  d.set('mcp-read-resource', (uri, id) => deps.mcp.readResource(String(uri), id as string | undefined))
  d.set('mcp-get-prompt', (name, args, id) => deps.mcp.getPrompt(String(name), args, id as string | undefined))
  d.set('mcp-list-prompts', (id) => deps.mcp.listPrompts(id as string | undefined))
  d.set('mcpCallToolWithId', (name, args, id) => deps.mcp.callTool(String(name), args as Record<string, unknown> | undefined, id as string | undefined))
  // draft（M3.9）
  d.set('draft:save', (draft) => deps.assets.saveDraft(draft))
  d.set('draft:load', () => deps.assets.loadDraft())
  d.set('draft:exists', () => deps.assets.existsDraft())
  d.set('draft:clear', () => deps.assets.clearDraft())
  // ---------- Orchestrator 远程配置 + 模板管理 ----------
  // 远程配置三件套 = 真实现（~/.chill/agents/remote/*.json，白名单内朴素 fs；
  // Web 端远程 Agent 配置真实持久化、与桌面互通）
  d.set('orchestrator:read-remote-configs', () => deps.remoteConfigs.list())
  d.set('orchestrator:write-remote-config', (key, config) => deps.remoteConfigs.save(String(key), config))
  d.set('orchestrator:delete-remote-config', (key) => deps.remoteConfigs.remove(String(key)))
  // boot 期会调用的模板聚合通道：模板本体经渲染层 FileSystemTemplateLoader 走 FS 白名单
  // 加载（agentTemplateService），本通道在桌面是主进程便利层——M1 给优雅空列表
  // （boot 不因 ni 崩断），M3.9 按需实装真实聚合。
  d.set('orchestrator:get-all-templates', () => ({ success: true, templates: [] }))
  // agents 变化通知：受理为成功（数据面经 write-remote-config 已真实落盘）；
  // 模板再生成（RemoteAgentRegistrar）属编排态，归 M4——未接线的部分如实留待 M4。
  d.set('orchestrator:notify-agents-changed', () => ({ success: true }))
  d.set('board:load', (id) => deps.subagents.boardLoad(String(id)))
  d.set('board:save', (state) => deps.subagents.boardSave(state))
  d.set('board:exists', (id) => deps.subagents.boardExists(String(id)))
  d.set('board:archive', (id, reason) => deps.subagents.boardArchive(String(id), String(reason)))
  // M4：子代理执行 / 回弹 / 实例探活
  d.set('subagent:execute', (request) => {
    const r = request as Record<string, unknown>
    return deps.subagents.execute(r).then(
      (result) => ({ success: true, result }),
      (error: unknown) => ({ success: false, error: error instanceof Error ? error.message : 'Subagent 任务执行失败' }),
    )
  })
  d.set('subagent:cancel', (request) => {
    const key = (request as { environmentKey?: string })?.environmentKey
    if (!key) return { success: false, error: '缺少 environmentKey 参数' }
    return deps.subagents.cancel(String(key))
  })
  d.set('subagent:builtin-response', (payload) => {
    const p = payload as { requestId: string; result?: unknown; error?: string }
    return deps.subagents.resolveBuiltin(p.requestId, p.result, p.error)
  })
  d.set('worker-mcp-hook:response', (payload) => {
    const p = payload as { requestId: string; outcome?: unknown; error?: string }
    return deps.subagents.resolveMcpHook(p.requestId, p.outcome as never, p.error)
  })
  d.set('instances:live-pids', async () => {
    const { getLiveInstancePids } = await import('@assistant-ai/core')
    return { success: true, pids: getLiveInstancePids(deps.userDataPath) }
  })
  d.set('workflows:watch-dirs', (dirs) => { deps.watchBridge.watchAssetDirs('workflows', dirs as string[]); return { success: true } })
  d.set('teams:watch-dirs', (dirs) => { deps.watchBridge.watchAssetDirs('teams', dirs as string[]); return { success: true } })
  d.set('window:notify-turn-completed', () => ({ ok: true })) // web 无任务栏闪烁；M5.2 换 Notification

  return d
}
