/**
 * ws-host —— HostAPI 的 WebSocket 客户端实现（WebUI 规划 M1.4）
 *
 * 桥的形态与 preload 对称：preload 把 HostAPI 翻译成 IPC，本模块把 HostAPI 翻译成
 * WS 三帧（req/res/ev，见 packages/web/src/wsChannel.ts）。方法名 = 既有 IPC 通道名。
 *
 * 关键设计：
 * - kv 同步语义：连接即收 kv:snapshot 建本地缓存；getKeyValue 同步读缓存；
 *   set/remove 写穿缓存 + 异步上送（kv:changed 事件维持多标签一致）——语义对齐
 *   preload 的 sendSync（读己之写立即可见）。
 * - 订阅（onXxx）完全是本地注册表：订阅方法不过线，事件经 ev 帧广播分发。
 * - 连接态：ready promise（open + 快照到达）供 webEntry 把关；断连经
 *   onConnectionChanged 通知（M4.3 重连语义的挂点）。
 */
import type { HostAPI, HostConnectionState } from './hostApi'


export interface WsHost {
  api: HostAPI
  /** 连接就绪（open + kv 快照到达）后 resolve；连接失败 reject */
  ready: Promise<void>
  /** 当前连接态（连接屏/重连覆盖层消费） */
  getState(): HostConnectionState
  /** 连接态变化订阅（webEntry 接重连覆盖层；M4.3 扩展为 resync） */
  onConnectionChanged(cb: (s: HostConnectionState, reason?: string) => void): void
  close(): void
}

/**
 * 创建 ws-host。连接参数优先取入参（node 契约测试注入），缺省从 location 提取：
 * - token：?token=（chill web 打印的 URL 自带）
 * - daemon 地址：?ws=host:port（缺省与页面同源——生产形态同源最常见）
 */
export function createWsHost(from?: { token?: string; wsTarget?: string }): WsHost {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
  const token = from?.token ?? params.get('token') ?? ''
  const wsTarget = from?.wsTarget ?? params.get('ws') ?? (typeof location !== 'undefined' ? location.host : '')
  if (!token || !wsTarget) {
    throw new Error('缺少连接参数：请使用 chill web 打印的完整地址（含 token）打开本页')
  }

  let state: HostConnectionState = 'connecting'
  const stateListeners = new Set<(s: HostConnectionState, reason?: string) => void>()
  function setState(s: HostConnectionState, reason?: string): void {
    state = s
    for (const cb of stateListeners) { try { cb(s, reason) } catch { /* 监听器异常不扩散 */ } }
  }

  // ---------- kv 本地缓存（同步语义的数据源） ----------
  const kvCache = new Map<string, string>()
  let snapshotArrived: () => void
  const snapshotPromise = new Promise<void>((r) => { snapshotArrived = r })

  // ---------- 请求/响应配对 ----------
  const ws = new WebSocket(`ws://${wsTarget}/?token=${encodeURIComponent(token)}`)
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let seq = 0

  // ---------- 事件注册表（订阅不过线） ----------
  const listeners = new Map<string, Set<(d: unknown) => void>>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 各事件载荷形状由 HostAPI 成员签名约束，此处收 any 回调
  function subscribe(frameName: string, cb: (d: any) => void): void {
    let set = listeners.get(frameName)
    if (!set) { set = new Set(); listeners.set(frameName, set) }
    set.add(cb)
  }
  function unsubscribeAll(frameName: string): void {
    listeners.delete(frameName)
  }

  ws.addEventListener('message', (ev: MessageEvent) => {
    let f: { t: string; id?: string; m?: string; ok?: boolean; r?: unknown; e?: string; n?: string; d?: unknown }
    try {
      f = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (f.t === 'res' && f.id && pending.has(f.id)) {
      const { resolve, reject } = pending.get(f.id)!
      pending.delete(f.id)
      if (f.ok) resolve(f.r)
      else reject(new Error(f.e ?? '未知错误'))
      return
    }
    if (f.t === 'ev') {
      if (f.n === 'kv:snapshot') {
        kvCache.clear()
        const snap = (f.d ?? {}) as Record<string, string>
        for (const [k, v] of Object.entries(snap)) kvCache.set(k, v)
        snapshotArrived()
        return
      }
      if (f.n === 'kv:changed') {
        const { key, value } = (f.d ?? {}) as { key: string; value: string | null }
        if (value === null) kvCache.delete(key)
        else kvCache.set(key, value)
        return
      }
      const set = listeners.get(f.n ?? '')
      if (set) for (const cb of set) { try { cb(f.d) } catch { /* 回调异常不扩散 */ } }
    }
  })

  function call(channel: string, ...args: unknown[]): Promise<any> {
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`宿主连接未就绪（${state}）：${channel}`))
    }
    const id = `c${seq++}`
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ t: 'req', id, m: channel, a: args }))
    })
  }

  ws.addEventListener('open', () => setState('connected'))
  ws.addEventListener('close', () => {
    setState('disconnected', '与 daemon 的连接已断开')
    for (const [, p] of pending) p.reject(new Error('宿主连接已断开'))
    pending.clear()
  })
  ws.addEventListener('error', () => {
    if (state === 'connecting') setState('disconnected', '无法连接 daemon（serve 是否在运行？）')
  })

  // ---------- HostAPI 组装（invoke 族逐方法显式接线，类型全检查） ----------
  const api: HostAPI = {
    storeApiKey: (p, k) => call('store-api-key', p, k),
    getApiKey: (p) => call('get-api-key', p),
    deleteApiKey: (p) => call('delete-api-key', p),
    getAllProviders: () => call('get-all-providers'),

    // kv：同步读缓存 / 写穿 + 异步上送
    getKeyValue: (key) => kvCache.get(key) ?? null,
    setKeyValue: (key, value) => {
      kvCache.set(key, value)
      void call('kv:set', key, value).catch(() => { /* 写失败静默：重连后由快照对账 */ })
    },
    removeKeyValue: (key) => {
      kvCache.delete(key)
      void call('kv:remove', key).catch(() => { /* 同上 */ })
    },

    sessionListMeta: () => call('session:list-meta'),
    sessionLoad: (id) => call('session:load', id),
    sessionPatchProject: (id, pid) => call('session:patch-project', id, pid),
    sessionPatchTitle: (id, t) => call('session:patch-title', id, t),
    sessionSearch: (q) => call('session:search', q),
    sessionSave: (r, mode) => call('session:save', r, mode),
    sessionDelete: (id) => call('session:delete', id),
    sessionWatch: (id) => call('session:watch', id),
    sessionLoadIfNewer: (id) => call('session:loadIfNewer', id),
    sessionGetHandoffId: () => call('session:handoff-id'),
    onSessionChanged: (cb) => subscribe('session:changed', cb as never),
    onWindowFocused: (cb) => subscribe('window:focused', cb),

    projectList: () => call('project:list'),
    projectSave: (r) => call('project:save', r),
    projectDelete: (id) => call('project:delete', id),

    executeNodeTool: (n, a) => call('builtin:execute-node-tool', n, a),

    setPlanMode: (on) => call('plan:set-mode', on),
    planAskUserResponse: (id, a) => call('plan:ask-user-response', id, a),
    onPlanAskUserRequest: (cb) => subscribe('plan:ask-user-request', cb),
    onPlanModeChanged: (cb) => subscribe('plan:mode-changed', cb),

    setGoalMode: (on) => call('goal:set-mode', on),
    goalSave: (s) => call('goal:save', s),
    goalArchive: (s) => call('goal:archive', s),
    goalClear: () => call('goal:clear'),

    mcpGetConnectionStatus: () => call('mcp-connection-status'),
    mcpConnectWithId: (c, id) => call('mcp-connect-id', c, id),
    mcpDisconnectWithId: (id) => call('mcp-disconnect-id', id),
    mcpListConnections: () => call('mcp-list-connections'),
    fsGetGate: () => call('fs:get-gate'),
    fsSetGate: (enforced: boolean) => call('fs:set-gate', enforced),
    mcpListToolsWithId: (id) => call('mcp-list-tools', id),
    mcpListResourcesWithId: (id) => call('mcp-list-resources', id),
    mcpReadResourceWithId: (uri, id) => call('mcp-read-resource', uri, id),
    mcpGetPromptWithId: (n, a, id) => call('mcp-get-prompt', n, a, id),
    mcpListPromptsWithId: (id) => call('mcp-list-prompts', id),
    mcpCallToolWithId: (n, a, id) => call('mcpCallToolWithId', n, a, id),
    mcpReadResource: (uri, id) => call('mcp-read-resource', uri, id),
    mcpGetPrompt: (n, a, id) => call('mcp-get-prompt', n, a, id),
    onMCPStatusUpdate: (cb) => subscribe('mcp-status-update', cb),

    draftSave: (d) => call('draft:save', d),
    draftLoad: () => call('draft:load'),
    draftExists: () => call('draft:exists'),
    draftClear: () => call('draft:clear'),

    showSaveDialog: (o) => call('dialog:showSaveDialog', o),
    showOpenDialog: (o) => call('dialog:showOpenDialog', o),

    fileListDirectory: (p, o) => call('file:list-directory', p, o),
    fileRead: (p, o) => call('file:read', p, o),
    fileReadBase64: (p) => call('file:read-base64', p),
    fileWrite: (p, c, e) => call('file:write', p, c, e),
    fileDelete: (p) => call('file:delete', p),
    fileRename: (a, b) => call('file:rename', a, b),
    fileCreate: (p, c) => call('file:create', p, c),
    fileMkdir: (p) => call('file:mkdir', p),
    fileExists: (p) => call('file:exists', p),
    getPathType: (p) => call('file:get-path-type', p),
    fileStat: (p) => call('file:stat', p),
    realpath: (p) => call('file:realpath', p),
    fileOpen: (p) => call('file:open', p),
    fileWatchSet: (ps) => call('file:watch-set', ps),
    fileWatchStop: () => call('file:watch-stop'),
    onFileChanged: (cb) => subscribe('file:changed', cb),
    removeFileChangedListener: () => unsubscribeAll('file:changed'),

    saveAttachment: (b, n) => call('attachment:save', b, n),
    deleteAttachment: (id) => call('attachment:delete', id),
    readAttachmentAsBase64: (id) => call('attachment:read-as-base64', id),

    getUserDataPath: () => call('app:get-user-data-path'),
    getMainPid: () => call('app:main-pid'),

    boardLoad: (id) => call('board:load', id),
    boardSave: (s) => call('board:save', s),
    boardExists: (id) => call('board:exists', id),
    boardArchive: (id, r) => call('board:archive', id, r),

    notifyTurnCompleted: () => call('window:notify-turn-completed'),

    orchestratorReadRemoteConfigs: () => call('orchestrator:read-remote-configs'),
    orchestratorWriteRemoteConfig: (k, c) => call('orchestrator:write-remote-config', k, c),
    orchestratorDeleteRemoteConfig: (k) => call('orchestrator:delete-remote-config', k),
    orchestratorGetAllTemplates: () => call('orchestrator:get-all-templates'),
    orchestratorNotifyAgentsChanged: (a) => call('orchestrator:notify-agents-changed', a),
    onTemplatesReloaded: (cb) => subscribe('orchestrator:templates-reloaded', cb),

    // 可选 watch 族：M3.8 watch 事件桥已落地——补齐成员（daemon 侧 fs.watch → ev 帧广播）
    onWorkflowsChanged: (cb) => subscribe('workflows:changed', cb),
    watchWorkflowDirs: (dirs) => call('workflows:watch-dirs', dirs),
    onTeamsChanged: (cb) => subscribe('teams:changed', cb),
    watchTeamDirs: (dirs) => call('teams:watch-dirs', dirs),

    onTeamRunsChanged: (cb) => subscribe('team-runs:changed', cb),
    getLiveInstancePids: () => call('instances:live-pids'),
    onSubagentToolCall: (cb) => subscribe('subagent-tool-call', cb),

    subagentExecute: (r) => call('subagent:execute', r),
    subagentCancel: (r) => call('subagent:cancel', r),
    onSubagentBuiltinRequest: (cb) => subscribe('subagent:builtin-request', cb),
    subagentBuiltinResponse: (p) => call('subagent:builtin-response', p),

    skillInstall: (s, p) => call('skill:install', s, p),
    skillUninstall: (n) => call('skill:uninstall', n),
    skillUpdate: (n) => call('skill:update', n),
    skillGetBuiltinDir: () => call('skill:builtin-dir'),

    executePowerShell: (c, o) => call('powershell:execute', c, o),
    executeJSCode: (c, o, l) => call('code:execute-js', c, o, l),
    startInteractiveExecution: (c, l, o) => call('code:start-interactive', c, l, o),
    sendInput: (id, i) => call('code:input', id, i),
    terminateProcess: (id) => call('code:terminate', id),
    onOutput: (cb) => subscribe('code:output', cb),
    onExit: (cb) => subscribe('code:exit', cb),
    removeInteractiveListeners: () => { unsubscribeAll('code:output'); unsubscribeAll('code:exit') },

    hooksRun: (p) => call('hooks:run', p),
    hooksMtime: (p) => call('hooks:mtime', p),

    onSessionEndRequest: (cb) => subscribe('session:end-request', cb),
    sessionEndDone: () => { void call('session:end-done').catch(() => { /* 无人应答即忽略 */ }) },

    onWorkerMcpHookRequest: (cb) => subscribe('worker-mcp-hook:request', cb),
    workerMcpHookResponse: (p) => call('worker-mcp-hook:response', p),

    desktopCall: (m, a) => call('desktop:call', m, a),
    desktopAudit: () => { /* M1 无桌面能力：审计单工投递省略（M5 后按需接） */ },

    removeAllListeners: (channel) => unsubscribeAll(channel),

    relayStart: () => call('relay:start'),
    relayStop: () => call('relay:stop'),
    relayStatus: () => call('relay:status'),
    relayHttpRequest: (o) => call('relay:http-request', o),
    relayHttpGetBinary: (o) => call('relay:http-get-binary', o),
    relayHttpPutBinary: (o) => call('relay:http-put-binary', o),
    relayReadFileSlice: (o) => call('relay:read-file-slice', o),
    relayStatFile: (o) => call('relay:stat-file', o),
    relayResolvePath: (o) => call('relay:resolve-path', o),
    relayCaFP: (p) => call('relay:ca-fp', p),
    relayTransportConnect: (o) => call('relay:transport-connect', o),
    relayTransportClose: () => call('relay:transport-close'),
    onRelayTransportMessage: (cb) => subscribe('relay:transport-message', cb),
    onRelayTransportClosed: (cb) => subscribe('relay:transport-closed', cb as never),
    onRelayTransportError: (cb) => subscribe('relay:transport-error', cb as never),
    onRelayLeaseLost: (cb) => subscribe('relay:lease-lost', cb),
    relayCatalogState: (o) => call('relay:catalog-state', o),
    onRelaySessionEvent: (cb) => subscribe('relay:session-event', cb),
  }

  const ready = (async () => {
    if (ws.readyState === WebSocket.OPEN) {
      setState('connected')
    } else {
      await new Promise<void>((r, rej) => {
        ws.addEventListener('open', () => r(), { once: true })
        ws.addEventListener('error', () => rej(new Error('无法连接 daemon——请确认 chill web 正在运行')), { once: true })
      })
    }
    await snapshotPromise
  })()

  return {
    api,
    ready,
    getState: () => state,
    onConnectionChanged: (cb) => stateListeners.add(cb),
    close: () => ws.close(),
  }
}
