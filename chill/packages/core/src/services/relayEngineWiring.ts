/**
 * relayEngineWiring.ts — relay 桥的环境装配（M4）：唯一接触环境单例的装配模块。
 *
 * 职责：把"引擎流/事件总线/审批通道"这些环境感知接到 RelayBridge 的纯逻辑接口上。
 * 本模块必须与引擎同进程（直调 engine.enqueueExternalMessage，此约束天然锁定同址；
 * ApprovalChannel/eventBus 单例也恰好活在引擎进程）。CLI 单进程与将来 UI 壳（引擎
 * 所在进程，无论主/渲染）、M6 daemon 壳都用它。
 * 位置纪律：故意不放进 services/relay/——该目录红线是全部 Node-free/renderer 安全
 * （index.renderer.ts 按文件引用）；本模块接触环境单例，放在目录外、只进 index.ts
 * （Node 主入口），不进 index.renderer.ts。
 * ChatEngine 只用 import type（只调实例方法、无运行时依赖）。
 * M6：会话同步装配——TURN_STREAM_CHUNK 被动流转发、history.invalidated、active.changed、
 * 目录元数据监听（fs.watch + diffCatalogMeta → session.event）、catalog/history 闭包组包。
 */
import * as fs from 'fs'
import type { ChatEngine } from '../engine/ChatEngine'
import { eventBus, EVENTS } from '../utils/eventBus'
import { getApprovalChannel } from './approvals'
import { getAskChannel, type AskRequestPayload, type SettledAskRecord } from './askChannel'
import type { AskDecisionEntry } from './relay/envelope'
import { ToolCallStatus } from '../types/models'
import type { ApprovalRequestPayload, SettledApprovalRecord } from './approvals'
import type { ProjectRecord } from '../persistence/ProjectPersistence'
import type { SessionRecord } from '../persistence/SessionPersistence'
import type { RelayBridge, EnqueueResult, RelayBridgeDeps, EnqueueInput } from './relay/RelayBridge'
import type { PutMediaChunk } from './relay/fileSender'
import type { CatalogSessionMeta, CatalogSyncBody, CatalogStateBody, BoardStateBody, BoardRowWire, FeedSubagentBody, WorkPlanStateBody } from './relay/envelope'
import type { TaskListCreatedEvent, TaskStatusUpdatedEvent, TaskDeletedEvent, TaskAddedEvent } from '../workflow/TaskListManager'
import { buildWorkPlanTree, retiredBatchGroupKeys } from './workplan/workPlanTree'
import {
  acceptTaskEventSource,
  decideWorkPlanSync,
  mirrorTaskAdded,
  mirrorTaskDeleted,
  mirrorTaskListCreated,
  mirrorTaskStatusUpdated,
  type WorkPlanMirror,
} from './workplan/workPlanMirror'
import { getWorkPlanMirrorStore } from './workplan/workPlanMirrorStore'
import { buildCatalog, diffCatalog, diffCatalogMeta, pageHistory } from './SessionSyncService'
import { MEDIA_EXTENSIONS } from '../engine/mediaMention'
import type { ContentPart, MessageAttachmentRef, TaskItem } from '../types/models'
import { getTeamRuntimeService } from './team/TeamRuntimeService'
import { getSessionBoardService } from './board/SessionBoardService'
import type { BoardItem } from './board/boardTypes'
import { buildCommandState, executeCommand, type CommandExecutorResult, type CommandSessionsPort } from './commands/commandSurface'
import { memoryStore } from './memory/memoryStore'
import type { DesktopControlDeps, DesktopControlStore } from './desktopControl'
import { SelectedModelsService } from './selectedModelsService'
import { ModelInfoService } from './models/modelInfoService'
import { adoptSnapshotRev, nextSnapshotRev } from './snapshotRev'
import type { BoardRow } from './board/boardProjection'
import type { SubagentToolCallPayload } from '../utils/eventBus'

/**
 * 引擎流 → 桥的 enqueue 装配（壳侧 relayClient 构造处一行接入）。
 * M6：流式镜像改由引擎被动广播（TURN_STREAM_CHUNK → wireTurnStream → pushStreamChunk）统一供给
 * （手机轮/本地轮同一门控，不经 per-turn streamCallback 双源直推）；本闭包只交付轮次终态。
 * M7增量3·决策30：opts.onIngested 透传给引擎两段式回调（用户消息持久化后、轮次开始前）——
 * 桥据此写台账 + ACK（投递与处理解耦）。
 */
export function createEngineEnqueue(
  engine: ChatEngine,
): (input: EnqueueInput, opts?: { onDelta?: (delta: string) => void; onIngested?: () => void | Promise<void> }) => Promise<EnqueueResult> {
  // 单引擎装配（交互 CLI 旧装配）：有 id 也回退绑定引擎——其 ensureActiveSession 已把
  // 唯一引擎切到目标会话（M0.1′ additive 契约：旧装配忽略 sessionId，行为逐位不变）
  return createEngineEnqueueBy(() => engine)
}

/**
 * M0.1′：按 sessionId 直寻引擎的 enqueue 工厂（多会话 registry 宿主用——serve 装配经
 * resolve 从注册表现取目标引擎）。resolve 收到 input.sessionId（可能 undefined）：
 * 无 id / 解析不到 → 回退 fallback（调用方闭包决定，通常=活跃引擎）。
 * 消除 active 指针路由竞态：两条会话链并发时 ensureActive 切换与 enqueue 读值不再有因果依赖。
 */
export function createEngineEnqueueBy(
  resolve: (sessionId: string | undefined) => ChatEngine,
): (input: EnqueueInput, opts?: { onDelta?: (delta: string) => void; onIngested?: () => void | Promise<void> }) => Promise<EnqueueResult> {
  return async (input, opts) => {
    const engine = resolve(input.sessionId)
    const result = await engine.enqueueExternalMessage(
      { text: input.text, origin: 'mobile', ...(input.contentParts ? { contentParts: input.contentParts } : {}), ...(input.attachmentRefs ? { attachmentRefs: input.attachmentRefs } : {}), ...(input.clientId ? { clientId: input.clientId } : {}) },
      opts?.onIngested ? { onIngested: opts.onIngested } : {},
    )
    return {
      content: result.content,
      aborted: result.aborted,
      ...(result.deniedReason !== undefined ? { deniedReason: result.deniedReason } : {}),
    }
  }
}

/**
 * file.* 协议族的桥 deps 工厂（双壳一行接入；判据锚定 engine/mediaMention 的 MEDIA_EXTENSIONS
 * 单一事实表——严禁按 mime 另造分类）：
 * - saveAttachment：重组完成后的落盘（CLI=AttachmentManager 直调；UI=electronAPI IPC）
 * - resolveAttachments：chat.user attachments 的摄入装配——
 *   图片 → base64 内联 contentPart（readAsBase64 注入）；视频 → fileId 引用 contentPart
 *   （发送时经 mediaProvider 现读现转，与 CLI cliVideoStorage 同构、不二次落盘）；
 *   其他 → `[附件] name（绝对路径，N bytes）` 引用行（模型按需 read_file，绝对路径由注入闭包派生）。
 * 媒体块前不带文本块——文本块由桥在合并文本后统一前置（buildContentParts 同序）。
 */
export function makeFileTransferBridgeDeps(deps: {
  saveAttachment: (bytes: Uint8Array, name: string) => Promise<string>
  readAsBase64: (savedRef: string) => Promise<string>
  /** 同步（CLI 直调）或异步（UI 经 getUserDataPath 派生）皆可 */
  getAbsolutePath: (savedRef: string) => string | Promise<string>
  /** 媒体直传：按密文名拉取密文（壳用自身 relay 配置拼 /static/media/ URL；v2 带 Range 头） */
  fetchMedia: (name: string, opts?: { range?: string }) => Promise<Uint8Array>
  // ---------- d→m 出向文件发送（可选注入；构造宽容、调用发送时才报错——防御性兜底） ----------
  /** 密文分片 PUT 上传（壳侧 HTTPS PUT /media/<name> + Bearer write_token，复用 fetchMedia 的证书固定/鉴权基建） */
  putMedia?: PutMediaChunk
  /** 文件切片读取（CLI=Node fs；UI=IPC 主进程——渲染进程无任意路径读能力） */
  readFileSlice?: (path: string, offset: number, length: number) => Promise<Uint8Array>
  /** 文件 stat（null=不存在；mutated 护栏数据源） */
  statFile?: (path: string) => Promise<{ size: number; mtimeMs: number; isFile: boolean } | null>
  /** 路径解析（~ 展开 + 相对路径按会话工作目录解析 + 规范化绝对路径——denylist 判定基准） */
  resolvePath?: (input: string) => Promise<string>
  /** 用户主目录（~/.chill/** denylist 判定基准） */
  homeDir?: string
  /** 文件系统大小写不敏感（Windows denylist 匹配口径） */
  caseInsensitivePaths?: boolean
}): Pick<
  RelayBridgeDeps,
  | 'saveAttachment'
  | 'resolveAttachments'
  | 'fetchMedia'
  | 'putMedia'
  | 'readFileSlice'
  | 'statFile'
  | 'resolvePath'
  | 'homeDir'
  | 'caseInsensitivePaths'
  | 'onFileReceipt'
> {
  const formatBytes = (n: number): string =>
    n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
  return {
    saveAttachment: deps.saveAttachment,
    fetchMedia: deps.fetchMedia,
    // d→m 出向注入透传（缺省 undefined——桥层发送时诚实报错，不炸装配）
    ...(deps.putMedia !== undefined ? { putMedia: deps.putMedia } : {}),
    ...(deps.readFileSlice !== undefined ? { readFileSlice: deps.readFileSlice } : {}),
    ...(deps.statFile !== undefined ? { statFile: deps.statFile } : {}),
    ...(deps.resolvePath !== undefined ? { resolvePath: deps.resolvePath } : {}),
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(deps.caseInsensitivePaths !== undefined ? { caseInsensitivePaths: deps.caseInsensitivePaths } : {}),
    // receipt 到达通告 → FILE_RECEIPT 事件（壳订阅落会话提示；桥守纯逻辑红线不 import eventBus，发射点在此）
    onFileReceipt: (receipt) => {
      eventBus.emit(EVENTS.FILE_RECEIPT, receipt)
    },
    resolveAttachments: async (settled) => {
      const contentParts: ContentPart[] = []
      const refLines: string[] = []
      const attachmentRefs: MessageAttachmentRef[] = settled.map((s) => ({ ref: s.fileId, name: s.name, mime: s.mime }))
      for (const s of settled) {
        const dot = s.name.lastIndexOf('.')
        const ext = dot >= 0 ? s.name.slice(dot).toLowerCase() : ''
        const media = MEDIA_EXTENSIONS[ext]
        if (media?.kind === 'image') {
          const base64 = await deps.readAsBase64(s.savedRef)
          contentParts.push({ type: 'image_url', image_url: { url: `data:${media.mime};base64,${base64}` } })
        } else if (media?.kind === 'video') {
          contentParts.push({ type: 'video_url', video_url: { url: s.savedRef } })
        } else {
          refLines.push(`[附件] ${s.name}（${await deps.getAbsolutePath(s.savedRef)}，${formatBytes(s.size)}）`)
        }
      }
      return {
        refText: refLines.join('\n'),
        ...(contentParts.length > 0 ? { contentParts } : {}),
        attachmentRefs,
      }
    },
  }
}

/**
 * M7增量3·决策31：崩溃恢复 deps 组包（壳侧 relayClient/relayService 一行接入）：
 * resumeRound = 引擎重跑尾部未回复轮（结果供桥补发 final）；peekSessionTail = 盘上会话尾部
 * 窥视（重投的尾部同文检测——消息已在盘则不重复注入）。getEngine 惰性注入（UI 多会话
 * registry 每次现取 active 引擎；CLI 单引擎同构）。
 */
export function makeRecoveryBridgeDeps(deps: {
  getEngine: () => ChatEngine
  loadSession: (sessionId: string) => Promise<SessionRecord | null>
}): Pick<RelayBridgeDeps, 'resumeRound' | 'peekSessionTail'> {
  return {
    resumeRound: async () => {
      const result = await deps.getEngine().resumePendingRound()
      return result === null ? null : { content: result.content, aborted: result.aborted }
    },
    peekSessionTail: async (sessionId) => {
      const record = await deps.loadSession(sessionId)
      const last = record?.messages?.[record.messages.length - 1]
      if (!last) return null
      // file.*：content 透传数组形态（ContentPart[]——附件消息）+ attachmentRefs，供桥的多模态同文判据
      return {
        role: String(last.role),
        content:
          typeof last.content === 'string'
            ? last.content
            : Array.isArray(last.content)
              ? (last.content as Array<{ type: string; text?: string }>)
              : '',
        ...(last.attachmentRefs?.length ? { attachmentRefs: last.attachmentRefs } : {}),
      }
    },
  }
}

/** 审批通道 → 桥（手机成为与本地提示符平级的审批呈现通道）。返回退订函数（bridge stop 时调用） */
export function wireApprovalChannel(bridge: RelayBridge): () => void {
  const onRequested = (payload: ApprovalRequestPayload) => bridge.pushApprovalRequest(payload)
  const onSettled = (settled: { toolCallId: string; approved: boolean; by: string }) =>
    bridge.pushApprovalResolved(settled)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, onRequested)
  eventBus.on(EVENTS.APPROVAL_SETTLED, onSettled)
  return () => {
    eventBus.off(EVENTS.APPROVAL_REQUESTED, onRequested)
    eventBus.off(EVENTS.APPROVAL_SETTLED, onSettled)
  }
}

/** deps.resolveApproval 的实现：手机回答 → ApprovalChannel 落定（by='phone'）。
 *  opts.allowSession（additive，手机「本次会话放行」第三钮）→ resolution.allowSession——
 *  与本地 CLI [s]、桌面 UI 会话放行钮落定同一字段，executor 侧 desktopSessionAllowed 零改动。 */
export function makeResolveApproval(): (
  id: string,
  decision: 'approve' | 'reject',
  opts?: { allowSession?: boolean },
) => boolean {
  return (id, decision, opts) =>
    getApprovalChannel().resolve(
      id,
      decision === 'approve'
        ? { approved: true, ...(opts?.allowSession === true ? { allowSession: true } : {}) }
        : { approved: false, reason: '手机端拒绝' },
      'phone',
    )
}

/** deps.listPendingApprovals 的实现：审批真相源（重连再同步用） */
export function makeListPendingApprovals(): () => ApprovalRequestPayload[] {
  return () => getApprovalChannel().listPending()
}

/** deps.listRecentSettledApprovals 的实现：近期落定环（终态愈合重放用） */
export function makeListRecentSettledApprovals(): () => SettledApprovalRecord[] {
  return () => getApprovalChannel().listRecentSettled()
}

/** 权限模式 → 桥（M5）：executor 事件（唯一变更通告口）→ 广播手机徽标落定。返回退订函数 */
export function wirePermissionMode(bridge: RelayBridge): () => void {
  const fn = (data: { mode: string }) => bridge.pushModeState(data.mode)
  eventBus.on(EVENTS.PERMISSION_MODE_CHANGED, fn)
  return () => eventBus.off(EVENTS.PERMISSION_MODE_CHANGED, fn)
}

/**
 * 命令面状态 → 桥（M8）：三保底之二/三——轮末全量推（TURN_SETTLED）与 ctx 更新点
 * （ASSISTANT_MESSAGE_CREATED=每轮 API 实测回报、CONTEXT_AUTO_COMPACTED=自动压缩后估值空窗）。
 * 保底一（命令执行后必推）在桥 handleCmdRequest 内。事件是增强：桌面侧发起的变更经此即时可见，
 * 缺失事件名的变更由轮末/cmd.sync resync 收敛（D10 三保底，不为发事件改引擎）。返回退订函数。
 */
export function wireCommandState(bridge: RelayBridge): () => void {
  const push = () => bridge.pushCommandState()
  eventBus.on(EVENTS.TURN_SETTLED, push)
  eventBus.on(EVENTS.ASSISTANT_MESSAGE_CREATED, push)
  eventBus.on(EVENTS.CONTEXT_AUTO_COMPACTED, push)
  // M4：goal/plan 事件点（桌面侧 /goal、/plan、模型 enter_plan_mode 即时可见；
  // cmd 驱动的变更另有保底一，这里只补桌面侧发起的变更）
  eventBus.on(EVENTS.GOAL_STARTED, push)
  eventBus.on(EVENTS.GOAL_PAUSED, push)
  eventBus.on(EVENTS.GOAL_RESUMED, push)
  eventBus.on(EVENTS.GOAL_CLEARED, push)
  eventBus.on(EVENTS.GOAL_ACHIEVED, push)
  eventBus.on(EVENTS.GOAL_UPDATED, push)
  eventBus.on(EVENTS.GOAL_BUDGET_EXHAUSTED, push)
  eventBus.on(EVENTS.PLAN_MODE_ENTERED, push)
  // 宿主级开关（desktop.set/autoswitch.set：本地 /desktop、/auto-switch 与手机遥控经共享核心 emit 同一事件）
  eventBus.on(EVENTS.DESKTOP_CONTROL_TOGGLED, push)
  eventBus.on(EVENTS.AUTOSWITCH_TOGGLED, push)
  return () => {
    eventBus.off(EVENTS.TURN_SETTLED, push)
    eventBus.off(EVENTS.ASSISTANT_MESSAGE_CREATED, push)
    eventBus.off(EVENTS.CONTEXT_AUTO_COMPACTED, push)
    eventBus.off(EVENTS.GOAL_STARTED, push)
    eventBus.off(EVENTS.GOAL_PAUSED, push)
    eventBus.off(EVENTS.GOAL_RESUMED, push)
    eventBus.off(EVENTS.GOAL_CLEARED, push)
    eventBus.off(EVENTS.GOAL_ACHIEVED, push)
    eventBus.off(EVENTS.GOAL_UPDATED, push)
    eventBus.off(EVENTS.GOAL_BUDGET_EXHAUSTED, push)
    eventBus.off(EVENTS.PLAN_MODE_ENTERED, push)
    eventBus.off(EVENTS.DESKTOP_CONTROL_TOGGLED, push)
    eventBus.off(EVENTS.AUTOSWITCH_TOGGLED, push)
  }
}

/**
 * deps.getCommandState 的实现（M8）：buildCommandState 单一实现（services/commands），
 * 现读引擎与模型服务单例；装配/读取异常返 null（桥不推，手机保持旧态等 resync——fail-closed）。
 * executeCmd（命令执行装配）M2 起；M1 只观测（dormant）。
 */
export function makeGetCommandState(getEngine: () => ChatEngine, hostFlags?: Pick<DesktopControlStore, 'getItem'>): () => import('./relay/envelope').CommandStateSnapshot | null {
  return () => {
    try {
      return buildCommandState({ engine: getEngine(), models: SelectedModelsService.getInstance(), ...(hostFlags ? { hostFlags } : {}), memory: memoryStore })
    } catch {
      return null
    }
  }
}

/**
 * deps.executeCmd 的实现（M2 起装配，激活命令执行）：委托 commandSurface.executeCommand
 * （绑定逻辑唯一事实点在 core commandSurface——双壳只注入服务引用，不写绑定）。
 * sessions = 会话持久化端口（session.delete/session.rename 执行面）：CLI 直连 SessionPersistence，
 * UI 经 host API IPC + 注册表收口适配；缺省时对应命令诚实回 unsupported。
 */
export function makeExecuteCommand(getEngine: () => ChatEngine, sessions?: CommandSessionsPort, desktopControl?: DesktopControlDeps): (cmd: string, args?: Record<string, unknown>) => Promise<CommandExecutorResult> {
  return (cmd, args) =>
    executeCommand(
      {
        engine: getEngine(),
        models: SelectedModelsService.getInstance(),
        modelInfo: ModelInfoService.getInstance(),
        sessions,
        // M4：目标首轮 kick（设定即开工——照 CLI /goal 的 chat(arg) 语义；执行器 fire-and-forget）
        startGoalRound: (objective) => Promise.resolve(getEngine().enqueueExternalMessage({ text: objective, origin: 'mobile' })).then(() => undefined),
        // 宿主级开关执行面（desktop.set/autoswitch.set；CLI 壳经 ctx 组装，UI 壳暂不装配→两命令诚实 unsupported）
        ...(desktopControl ? { desktopControl } : {}),
        // 记忆库执行面（memory.list/show/delete/seen；memoryStore 单例直注——单写者无并发风险）
        memoryStore,
      },
      cmd,
      args,
    )
}

/**
 * 节拍边界 → 桥（M4b）：ASSISTANT_MESSAGE_CREATED 恰在工具执行完后、下一节拍 chunk 前发出。
 * M0.3：事件归属 sessionId 透传（桥内按 isMirrorSession 门控）——多引擎同跑时非附着会话的
 * 子响应不再把附着视图跳一拍（修复前桥只判"有没有人在看"）。
 * 返回退订函数。
 */
export function wireBeatBoundary(bridge: RelayBridge): () => void {
  const fn = (payload: { sessionId?: string }): void => bridge.advanceBeat(payload?.sessionId)
  eventBus.on(EVENTS.ASSISTANT_MESSAGE_CREATED, fn)
  return () => eventBus.off(EVENTS.ASSISTANT_MESSAGE_CREATED, fn)
}

// ---------- M4e：问人原语桥接（AskChannel 常驻唯一入口 + 桥呈现面） ----------

/**
 * 提问通道装配（M4e）：
 * - 桥呈现面（每 attach 一次，随 wiringUnsubscribers 退订）：ASK_REQUESTED → pushAskRequest；
 *   ASK_SETTLED → pushAskResolved（手机卡片置灰的唯一触发）。
 * AskChannel 是常驻唯一提问入口（壳启动即 setUserInputProvider(getAskChannel())，与 ApprovalChannel
 * 的常驻总线对齐）；壳呈现面由各壳自行订阅 ASK_REQUESTED/ASK_SETTLED 呈现与收摊（CLI 壳在
 * cli.ts/tuiShell.ts），不经本模块——呈现是壳的本职，core 只供给事件与通道。
 * 返回桥呈现面的退订函数。
 */
export function wireAskChannel(bridge: RelayBridge): () => void {
  const onRequested = (payload: AskRequestPayload) => bridge.pushAskRequest(payload)
  const onSettled = (settled: { id: string; answer: string; by: string }) => bridge.pushAskResolved(settled)
  eventBus.on(EVENTS.ASK_REQUESTED, onRequested)
  eventBus.on(EVENTS.ASK_SETTLED, onSettled)
  return () => {
    eventBus.off(EVENTS.ASK_REQUESTED, onRequested)
    eventBus.off(EVENTS.ASK_SETTLED, onSettled)
  }
}

/** deps.resolveAsk 的实现：手机回答 → AskChannel 落定（by='phone'；decisions=点选卡结构化回传透传） */
export function makeResolveAsk(): (id: string, answer: string, decisions?: AskDecisionEntry[]) => boolean {
  return (id, answer, decisions) => getAskChannel().resolve(id, answer, 'phone', decisions)
}

/** deps.listPendingAsks 的实现：提问真相源（重连再同步用） */
export function makeListPendingAsks(): () => AskRequestPayload[] {
  return () => getAskChannel().listPending()
}

/** deps.listRecentSettledAsks 的实现：近期落定环（终态愈合重放用） */
export function makeListRecentSettledAsks(): () => SettledAskRecord[] {
  return () => getAskChannel().listRecentSettled()
}

/** 工具参数摘要（≤1000 字符）：优先关键字段（路径/命令/查询），兜底键名列表 */
function summarizeParams(params: Record<string, unknown> | undefined): string | undefined {
  if (!params || typeof params !== 'object') return undefined
  const keys = Object.keys(params)
  if (keys.length === 0) return undefined
  const PRIORITY = ['path', 'file_path', 'filePath', 'command', 'cmd', 'pattern', 'query', 'url', 'content', 'text']
  for (const k of PRIORITY) {
    const v = params[k]
    if (typeof v === 'string' && v.length > 0) return v.length > 1000 ? `${v.slice(0, 1000)}…` : v
  }
  return `参数: ${keys.join(', ')}`
}

/** 工具结果预览（≤4000 字符，超限标注桌面查看） */
function summarizeResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined
  let text = ''
  if (typeof result === 'string') text = result
  else if (typeof result === 'object' && typeof (result as Record<string, unknown>)['content'] === 'string')
    text = (result as Record<string, unknown>)['content'] as string
  else text = JSON.stringify(result)
  if (!text) return undefined
  return text.length > 4000 ? `${text.slice(0, 4000)}\n（已截断，完整内容请在桌面查看）` : text
}

/** 工具调用状态 → 桥（M4b：结构化 detail + toolCallId 锚；M6：载荷 sessionId 透传，桥内附着门控）。返回退订函数 */
export function wireToolStatus(bridge: RelayBridge): () => void {
  const fn = (data: {
    sessionId?: string | null
    toolCallStatus?: ToolCallStatus
    toolCall?: { function?: { name?: string } }
    toolCallId?: string
    toolParameters?: Record<string, unknown>
    toolResult?: unknown
  }) => {
    const name = data.toolCall?.function?.name
    const toolCallId = data.toolCallId
    if (!name || !toolCallId) return // fail-safe：无锚不产出
    const sessionId = data.sessionId ?? null
    const status = data.toolCallStatus
    const paramsSummary = summarizeParams(data.toolParameters)
    const detail: Record<string, unknown> = {
      name,
      status:
        status === ToolCallStatus.RUNNING
          ? 'running'
          : status === ToolCallStatus.PENDING
            ? 'pending'
            : status === ToolCallStatus.SUCCESS
              ? 'success'
              : status === ToolCallStatus.REJECTED
                ? 'rejected'
                : 'failed',
      ...(paramsSummary !== undefined ? { paramsSummary } : {}),
    }
    if (status === ToolCallStatus.RUNNING) {
      bridge.pushToolEvent(sessionId, `调用工具 ${name}…`, toolCallId, detail)
    } else if (status === ToolCallStatus.PENDING) {
      // PENDING = 命令族工具在人工审批门前（execute_powershell / execute_code；发射主体=执行器进门时）：
      // 思考此刻已停止生长，必须出块让手机端收敛思考区（否则要���工具完成才收口——实测观察到的错位）
      bridge.pushToolEvent(sessionId, `${name} 等待审批`, toolCallId, detail)
    } else if (status === ToolCallStatus.SUCCESS || status === ToolCallStatus.FAILED) {
      const resultPreview = summarizeResult(data.toolResult)
      bridge.pushToolEvent(sessionId, `${name} ${status === ToolCallStatus.SUCCESS ? '完成' : '失败'}`, toolCallId, {
        ...detail,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
      })
    } else if (status === ToolCallStatus.REJECTED) {
      bridge.pushToolEvent(sessionId, `${name} 被拒绝`, toolCallId, detail) // 审批被拒必须在时间线留痕（审计链不断裂）
    }
  }
  eventBus.on(EVENTS.TOOL_CALL_STATUS_CHANGED, fn)
  return () => eventBus.off(EVENTS.TOOL_CALL_STATUS_CHANGED, fn)
}

// ---------- M6：会话同步装配（附着模型 + 被动流 + 目录/元数据 + 历史失效） ----------

/** M6 被动流 → 桥：引擎 TURN_STREAM_CHUNK 广播（任何轮次）转发 pushStreamChunk（桥内附着门控）。返回退订函数 */
export function wireTurnStream(bridge: RelayBridge): () => void {
  const fn = (chunk: { sessionId: string; kind: 'delta' | 'reasoning' | 'tool'; text: string }) =>
    bridge.pushStreamChunk(chunk)
  eventBus.on(EVENTS.TURN_STREAM_CHUNK, fn)
  return () => eventBus.off(EVENTS.TURN_STREAM_CHUNK, fn)
}

/** M6c 轮次落定 → 桥：引擎 TURN_SETTLED（runTurn finally，成功/中断/异常全覆盖）→ round.settled。
 *  手机的尾部拉齐只在此刻发生（轮中拉取=移动目标，造成 DB 副本与 overlay 双份渲染）。返回退订函数 */
export function wireTurnSettled(bridge: RelayBridge): () => void {
  const fn = (p: { sessionId: string }) => {
    void bridge.pushRoundSettled(p.sessionId) // 内部先冲刷聚合缓冲再推 settle（保序），失败不反噬事件总线
  }
  eventBus.on(EVENTS.TURN_SETTLED, fn)
  return () => eventBus.off(EVENTS.TURN_SETTLED, fn)
}

/** 运行态周期重申间隔：连接中残留错态的自愈上界（后续转换/周期重申/重连对账三重收敛之一） */
export const RUNNING_REASSERT_MS = 5 * 60 * 1000

/**
 * 运行态转换 → 桥（运行态标志，2026-10-04）：引擎 TURN_STARTED/TURN_SETTLED（与 running 状态翻转
 * 构造性配对，见 ChatEngine runTurn 两 mutation 点守卫注释）→ running.changed 推送。桥内不做镜像
 * 门控——后台会话的运行态正是本功能的意义（与 wireTurnSettled 的附着语义互不干扰，双订阅并存）。
 * 附 5min 周期纯快照重申（pushRunningSnapshot 自带 confirmed/未注入 no-op）：根治"连接中最后一帧
 * 丢失且此后无任何转换"的无限期残留错态（持续 429 风暴实测场景）。interval unref + 随退订清理
 * （wireSessionCatalogWatch debounce/unref 先例）。返回退订函数。
 */
export function wireRunningTransitions(
  bridge: Pick<RelayBridge, 'pushRunningChanged' | 'pushRunningSnapshot'>,
  opts: { reassertMs?: number } = {},
): () => void {
  const onStarted = (p: { sessionId?: string }) => {
    if (typeof p?.sessionId === 'string' && p.sessionId) bridge.pushRunningChanged(p.sessionId, true)
  }
  const onSettled = (p: { sessionId?: string }) => {
    if (typeof p?.sessionId === 'string' && p.sessionId) bridge.pushRunningChanged(p.sessionId, false)
  }
  eventBus.on(EVENTS.TURN_STARTED, onStarted)
  eventBus.on(EVENTS.TURN_SETTLED, onSettled)
  const timer = setInterval(() => bridge.pushRunningSnapshot(), opts.reassertMs ?? RUNNING_REASSERT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return () => {
    eventBus.off(EVENTS.TURN_STARTED, onStarted)
    eventBus.off(EVENTS.TURN_SETTLED, onSettled)
    clearInterval(timer)
  }
}

/** M6 历史失效 → 桥：非追加式历史变更（regenerate 截断重建）→ history.invalidated。返回退订函数 */
export function wireHistoryInvalidated(bridge: RelayBridge): () => void {
  const fn = (data: { sessionId?: string }) => {
    if (typeof data?.sessionId === 'string' && data.sessionId) {
      bridge.pushSessionEvent({ kind: 'history.invalidated', sessionId: data.sessionId })
    }
  }
  eventBus.on(EVENTS.HISTORY_INVALIDATED, fn)
  return () => eventBus.off(EVENTS.HISTORY_INVALIDATED, fn)
}

/**
 * M6 当前会话 → 桥：引擎会话身份订阅（1.3 订阅列表——与 registry 重键等多订阅方并存，
 * 不再占用单槽；active.changed 推手机，"●当前"徽标移动）。
 * 兼容双形态：有 subscribeActiveSessionChanged 走订阅列表；否则回退 onActiveSessionChanged
 * 单槽（恢复旧值式退订，防多实例/重启后回调悬挂）——行为与旧装配逐位不变。
 */
export function wireActiveSession(bridge: RelayBridge, engine: ChatEngine): () => void {
  const e = engine as ChatEngine & {
    subscribeActiveSessionChanged?: (cb: (sessionId: string | null) => void) => () => void
    onActiveSessionChanged?: ((sessionId: string | null) => void) | null
  }
  const push = (sessionId: string | null): void => bridge.pushSessionEvent({ kind: 'active.changed', sessionId })
  if (typeof e.subscribeActiveSessionChanged === 'function') {
    return e.subscribeActiveSessionChanged(push)
  }
  const prev = e.onActiveSessionChanged
  e.onActiveSessionChanged = push
  return () => {
    e.onActiveSessionChanged = prev
  }
}

/**
 * M6 目录元数据监听 → 桥：fs.watch 会话目录（debounce 节流）→ buildCatalog 现读快照
 * → diffCatalogMeta 出增量 → session.event（session.created/session.deleted/title.changed/metadata.upsert）。
 * 真相源是文件——CLI 命令/UI 进程/第二实例的写入全部经此覆盖（onMessagesChanged 只覆盖本引擎当前会话，
 * 漏非当前会话的 rename/delete 与跨进程变更）。初始扫描静默建基线（既有会话不爆 created 洪水）。
 * 返回退订函数。bridge 参数放宽为 Pick（本函数只触 pushSessionEvent）——
 * electron 主进程可直接以「webContents.send 转发」鸭子接入（渲染端无 fs，fs.watch 只能在主进程跑）。
 */
export function wireSessionCatalogWatch(
  bridge: Pick<RelayBridge, 'pushSessionEvent'>,
  deps: {
    sessionsDir: string
    listProjects: () => Promise<ProjectRecord[]>
    /** debounce 节流窗口（默认 500ms；测试可传小值） */
    debounceMs?: number
  },
): () => void {
  const debounceMs = deps.debounceMs ?? 500
  let prev = new Map<string, CatalogSessionMeta>()
  let primed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: fs.FSWatcher | null = null
  let stopped = false
  let scanning: Promise<void> = Promise.resolve()

  const scan = (): Promise<void> => {
    // 串行扫描（防 watch 事件风暴下并发扫描交错写 prev）
    scanning = scanning.then(async () => {
      if (stopped) return
      try {
        const catalog = await buildCatalog({
          sessionsDir: deps.sessionsDir,
          listProjects: deps.listProjects,
        })
        const next = new Map(catalog.sessions.map((s) => [s.id, s]))
        if (primed) {
          const diff = diffCatalogMeta(prev, catalog.sessions)
          for (const s of diff.created) bridge.pushSessionEvent({ kind: 'session.created', session: s })
          for (const id of diff.deleted) bridge.pushSessionEvent({ kind: 'session.deleted', sessionId: id })
          for (const s of diff.titleChanged) {
            bridge.pushSessionEvent({ kind: 'title.changed', sessionId: s.id, title: s.title, ...(s.titleSource !== undefined ? { titleSource: s.titleSource } : {}) })
          }
          for (const s of diff.upserted) bridge.pushSessionEvent({ kind: 'metadata.upsert', session: s })
        }
        prev = next
        primed = true
      } catch {
        /* 扫描失败等下一次变更触发（catalog.sync 按需拉不受影响） */
      }
    })
    return scanning
  }

  // 初始基线（静默）
  void scan()
  try {
    watcher = fs.watch(deps.sessionsDir, () => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void scan()
      }, debounceMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    watcher.on('error', () => { /* 目录被删等异常：监听失效不抛出，catalog.sync 按需拉仍可用 */ })
  } catch {
    watcher = null // 目录不存在（全新安装）：首次建会话后无监听——等 bridge 重建；按需拉不受影响
  }
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}

/**
 * M6 发言即激活的实现：手机发言目标会话 → 引擎 loadSession（沿用既有守卫：
 * 引擎忙/有后台任务 throw → 'busy'；记录不存在返 false → 'notfound'）。
 */
export function makeEnsureActiveSession(engine: ChatEngine): (sessionId: string) => Promise<'ok' | 'busy' | 'notfound'> {
  return async (sessionId) => {
    try {
      const ok = await engine.loadSession(sessionId)
      return ok ? 'ok' : 'notfound'
    } catch {
      return 'busy'
    }
  }
}

/**
 * M6b 'new' 分支的实现（桥 chat.user sessionId='new' 时调用）：
 * 守卫（startNewSession 在引擎忙/有后台任务时 throw → 'busy'，沿用既有护栏，不新造）→
 * 引擎当前会话为空（无历史）则复用、否则 startNewSession → ensureSessionId 落 id
 * （返 'ok' 时当前会话 id 必然已诞生——桥轮前附着契约）。
 * 空会话复用不产生多余会话；startNewSession 不落盘（惰性建会话：发言才有记录）。
 */
export function makeEnsureNewSession(engine: ChatEngine): () => Promise<'ok' | 'busy'> {
  return async () => {
    try {
      if (engine.getHistory().length > 0) engine.startNewSession()
      engine.ensureSessionId() // 空会话复用/新会话：id 轮前诞生（纯内存，不落盘）
      return 'ok'
    } catch {
      return 'busy'
    }
  }
}

/**
 * M6 会话同步桥 deps 组包（壳侧 relayClient 一行接入）：
 * catalog.sync 应答 = buildCatalog（activeSessionId 现取引擎）+ diffCatalog（known → full/增量）；
 * history.request 应答 = pageHistory（loadSession 闭包读真相源）。
 */
/**
 * catalog 组包唯一事实点（buildCatalog + diffCatalog → CatalogStateBody）：
 * makeSessionSyncBridgeDeps 的 buildCatalogState 闭包与 electron 主进程 IPC 共用同一函数——
 * 渲染端无 fs（fs 为空 shim），UI 壳的 buildCatalogState 经 IPC 回主进程调本函数，逻辑不双源。
 */
export async function buildCatalogStateBody(
  deps: {
    sessionsDir: string
    listProjects: () => Promise<ProjectRecord[]>
    getActiveSessionId: () => string | null
    /** 运行态标志（可选）：运行中会话全集现读——在场写入 runningSessionIds（重连对账自愈载体） */
    getRunningSessionIds?: () => string[]
  },
  known: CatalogSyncBody,
): Promise<CatalogStateBody> {
  const catalog = await buildCatalog({
    sessionsDir: deps.sessionsDir,
    listProjects: deps.listProjects,
    activeSessionId: deps.getActiveSessionId(),
  })
  const runningSessionIds = deps.getRunningSessionIds?.()
  const diff = diffCatalog(known, catalog)
  return {
    projects: diff.upserts.projects,
    sessions: diff.upserts.sessions,
    deletes: diff.deletes.sessions,
    activeSessionId: diff.activeSessionId,
    projectsRev: catalog.projectsRev,
    full: diff.full,
    ...(runningSessionIds ? { runningSessionIds } : {}),
  }
}

export function makeSessionSyncBridgeDeps(deps: {
  sessionsDir: string
  listProjects: () => Promise<ProjectRecord[]>
  loadSession: (sessionId: string) => Promise<SessionRecord | null>
  getActiveSessionId: () => string | null
  ensureActiveSession: (sessionId: string) => Promise<'ok' | 'busy' | 'notfound'>
  /** M6b：'new' 分支（makeEnsureNewSession 装配） */
  ensureNewSession?: () => Promise<'ok' | 'busy'>
  /** 运行态标志（可选）：透传两处——桥级 dep（pushRunningChanged/Snapshot 的 runningAll）+ catalog 闭包 */
  getRunningSessionIds?: () => string[]
}): Pick<
  RelayBridgeDeps,
  'buildCatalogState' | 'pageHistory' | 'getActiveSessionId' | 'ensureActiveSession' | 'ensureNewSession' | 'getRunningSessionIds'
> {
  return {
    buildCatalogState: (known: CatalogSyncBody): Promise<CatalogStateBody> =>
      buildCatalogStateBody(
        {
          sessionsDir: deps.sessionsDir,
          listProjects: deps.listProjects,
          getActiveSessionId: deps.getActiveSessionId,
          ...(deps.getRunningSessionIds ? { getRunningSessionIds: deps.getRunningSessionIds } : {}),
        },
        known,
      ),
    pageHistory: (sessionId, before, limit) =>
      pageHistory({ loadSession: deps.loadSession }, sessionId, before, limit),
    getActiveSessionId: deps.getActiveSessionId,
    ensureActiveSession: deps.ensureActiveSession,
    ...(deps.ensureNewSession !== undefined ? { ensureNewSession: deps.ensureNewSession } : {}),
    ...(deps.getRunningSessionIds !== undefined ? { getRunningSessionIds: deps.getRunningSessionIds } : {}),
  }
}

// ---------- M7：共享看板桥接（BOARD_CHANGED → 防抖合并 → board.state；board.sync 组包） ----------

/** 投影行 → 线形（detail 只带分态关键字段；undefined 键不占线宽） */
function toBoardRowWire(row: BoardRow): BoardRowWire {
  const d = row.detail
  return {
    itemId: row.itemId,
    title: row.title,
    assignee: row.assignee,
    status: row.status,
    label: row.label,
    progressText: row.progressText,
    ...(row.claimedAt !== undefined ? { claimedAt: row.claimedAt } : {}),
    ...(row.clipped !== undefined ? { clipped: row.clipped } : {}),
    detail: {
      ...(d.blockedReason !== undefined ? { blockedReason: d.blockedReason } : {}),
      ...(d.result !== undefined ? { result: d.result } : {}),
      ...(d.resultTruncated !== undefined ? { resultTruncated: d.resultTruncated } : {}),
      ...(d.releaseHistory !== undefined ? { releaseHistory: d.releaseHistory } : {}),
      ...(d.failCount !== undefined ? { failCount: d.failCount } : {}),
      ...(d.claimedByTaskId !== undefined ? { claimedByTaskId: d.claimedByTaskId } : {}),
    },
  }
}

/**
 * M7 board.sync / board.state 的 deps 组包（壳侧 relayClient/relayService 一行接入）：
 * SessionBoardService.getProjection 组包投影（core 算好壳零判定）+ ask/approval 未决计数
 * （AskChannel/ApprovalChannel 现状 pending，供 needsYou）。rev 对账：手机 rev 落后/未知 → full=true 全量；
 * 已一致 → full=false 纯确认（rows 空，标量照带供徽标收敛）。未装配看板服务=诚实空态（full=false）。
 */
export function makeBoardSyncBridgeDeps(): Pick<RelayBridgeDeps, 'buildBoardState'> {
  return {
    buildBoardState: async (sessionId: string, knownRev?: string | number): Promise<BoardStateBody> => {
      const svc = getSessionBoardService()
      if (!svc) {
        return {
          sessionId,
          rev: '0',
          rows: [],
          strip: { status: 'settled', countText: '0/0', settleText: '0 个子任务完成', needsYou: false },
          needsYou: { needed: false, count: 0 },
          windowed: false,
          full: false,
        }
      }
      // 显示并集（M7 增量 1）：并入该会话活动团队的板行（TeamRunState.sessionId 匹配；旧数据无归属=不并入）
      const teamSvc = getTeamRuntimeService()
      const activeTeam = teamSvc?.getActiveTeam()
      const teamItems =
        activeTeam && activeTeam.sessionId === sessionId ? (teamSvc!.boardList()?.items ?? []) : []
      let rev = await svc.getRevision(sessionId)
      const known = knownRev === undefined ? Number.NaN : Number(knownRev)
      // 对账采纳（rev 纪律）：手机存量高于本端（跨纪元/跨进程丢更新）→ 抬升后再答——应答必过手机 LWW，
      // 否则该会话看板在手机侧永久冻结（2026-10-07 事故的接收端表现）
      if (Number.isFinite(known) && known > rev) {
        rev = await svc.touchRevisionAtLeast(sessionId, known)
      }
      // 含团队板行时一律 full=true：团队板是独立 CAS，无单调合并 rev 可用（手机 rev 为数值 LWW）；载荷小、正确优先
      const upToDate = teamItems.length === 0 && Number.isFinite(known) && known === rev
      const projection = await svc.getProjection(
        sessionId,
        {
          pendingAskCount: getAskChannel().listPending().length,
          pendingApprovalCount: getApprovalChannel().listPending().length,
          now: Date.now(),
        },
        teamItems,
      )
      return {
        sessionId,
        rev: String(rev),
        rows: upToDate ? [] : projection.rows.map(toBoardRowWire),
        strip: {
          status: projection.strip.status,
          countText: projection.strip.countText,
          ...(projection.strip.settleText !== undefined ? { settleText: projection.strip.settleText } : {}),
          needsYou: projection.strip.needsYou,
        },
        needsYou: projection.needsYou,
        windowed: projection.windowed,
        full: !upToDate,
      }
    },
  }
}

/**
 * M7 看板变更订阅 → 桥（防抖 ~300ms 合并：窗口内多次 BOARD_CHANGED 只推一次）：
 * 看板 mutation 频发（spawn 即挂+认领、settle 结项/回流成串），逐条推会把手机信箱打爆——
 * 合并窗口内同会话多次变更取最终态推一次（快照同步 latest-wins，合并天然无损）。
 * 返回退订函数。
 */
export function wireBoard(bridge: RelayBridge, opts?: { debounceMs?: number }): () => void {
  const debounceMs = opts?.debounceMs ?? 300
  let timer: ReturnType<typeof setTimeout> | null = null
  const pendingSessions = new Set<string>()
  const listener = (payload: { sessionId?: string }): void => {
    const sid = payload?.sessionId
    if (!sid) return
    pendingSessions.add(sid)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const sids = [...pendingSessions]
      pendingSessions.clear()
      for (const s of sids) bridge.pushBoardState(s)
    }, debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  eventBus.on(EVENTS.BOARD_CHANGED, listener)
  // 团队板变更同窗订阅（M7 增量 1）：团队板行并入手机显示——两容器变更走同一防抖/推送路径
  eventBus.on(EVENTS.TEAM_BOARD_CHANGED, listener)
  return () => {
    if (timer) clearTimeout(timer)
    eventBus.off(EVENTS.BOARD_CHANGED, listener)
    eventBus.off(EVENTS.TEAM_BOARD_CHANGED, listener)
  }
}

/**
 * M7 subagent 事实流订阅 → 桥（固定窗口聚合 ~1s 防刷屏）：
 * Worker 工具调用事实（SUBAGENT_TOOL_CALL，fork 网关两发射点 running/success|failed）在窗口内
 * 按 toolCallId 归并（latest-wins：同 id 取 at 最新一条，running→success 同窗只推终态）；
 * 窗口从首条起算、到点整批推送（延迟上界=窗口长，连续洪峰不积压——trailing debounce 会饿死）。
 * 会话归属经看板工位索引反查（taskId→sessionId，spawn 时登记）；桥内附着门控只推附着会话。
 * extraSubscribe：UI 主进程→渲染转发桥的补喂源（fork 在主进程，渲染 eventBus 收不到原生发射；
 * 退订后残余监听以 stopped 标记短路——preload 通道无 off 语义）。
 * 返回退订函数。
 */
export function wireFeedSubagent(
  bridge: RelayBridge,
  opts?: {
    /** 合并窗口（缺省 1000ms；测试传小值） */
    windowMs?: number
    /** 附加事件源（与 eventBus 订阅并联；返回退订） */
    extraSubscribe?: (fn: (p: SubagentToolCallPayload) => void) => () => void
  },
): () => void {
  const windowMs = opts?.windowMs ?? 1000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 窗口内按 toolCallId 归并（Map 保首见序；at 升序比较防乱序旧帧覆盖） */
  const pending = new Map<string, SubagentToolCallPayload>()

  const flush = (): void => {
    timer = null
    const batch = [...pending.values()]
    pending.clear()
    for (const p of batch) {
      const sessionId = (p.taskId ? getSessionBoardService()?.sessionIdOfTask(p.taskId) : undefined) ?? null
      const body: FeedSubagentBody = {
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        kind: p.kind,
        argsSummary: p.argsSummary,
        status: p.status,
        at: p.at,
        ...(p.taskId !== undefined ? { taskId: p.taskId } : {}),
        ...(p.subagentType !== undefined ? { subagentType: p.subagentType } : {}),
        ...(p.resultSummary !== undefined ? { resultSummary: p.resultSummary } : {}),
        ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
      }
      bridge.pushFeedSubagent(sessionId, body)
    }
  }

  const onEvent = (p: SubagentToolCallPayload): void => {
    if (stopped || !p?.toolCallId) return // fail-safe：无锚不产出
    const prev = pending.get(p.toolCallId)
    if (prev && prev.at > p.at) return // 乱序旧帧丢弃（latest-wins）
    pending.set(p.toolCallId, p)
    if (!timer) {
      // 固定窗口：首条起算，到点整批出（不做 trailing 重置——连续洪峰下会无限延后）
      timer = setTimeout(flush, windowMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  eventBus.on(EVENTS.SUBAGENT_TOOL_CALL, onEvent)
  const offExtra = opts?.extraSubscribe?.(onEvent)
  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending.clear()
    eventBus.off(EVENTS.SUBAGENT_TOOL_CALL, onEvent)
    offExtra?.()
  }
}

// ---------- 工作计划树桥接（TASK_* → 分键镜像 → 防抖合并 → workplan.state；workplan.sync 组包） ----------

/**
 * 主会话清单镜像（按事件 sessionId 分键；装配即常驻）——sync 应答只认它：
 * 不用 ChatEngine.tasks 持久化载体作种子（open 时读入、运行期不更新，会推陈旧数据），
 * 也不用壳 getter 作种子（绑定前台会话，多会话错位）。空镜像=诚实空态（见 decideWorkPlanSync 全量回退）。
 */
const workPlanMirror: WorkPlanMirror = new Map()
/** 每会话 rev 计数（投影双源[清单镜像+看板行]任一变更自增，单计数器；时间基单调——跨重启不回退，
 * 见 wireWorkPlan 内 bump 注释；手机对账 rev 不一致自动回全量，无脏态残留） */
const workPlanRevs = new Map<string, number>()

/** 测试专用：清空镜像与 rev（生产永不调用——照 resetSessionBoardService 先例） */
export function resetWorkPlanWiringStateForTest(): void {
  workPlanMirror.clear()
  workPlanRevs.clear()
}

/**
 * workplan.sync / workplan.state 的 deps 组包（壳侧 relayClient/relayService 一行接入，照 makeBoardSyncBridgeDeps 先例）：
 * 组包=镜像现读 + 看板行直读（会话轻量板 ∪ 归属该会话的活动团队板——照 makeBoardSyncBridgeDeps 并板先例）
 * + buildWorkPlanTree v2 投影（core 算好壳零判定）。rev 对账：手机 rev 一致 → full=false 纯确认
 * （items 空）；落后/未知/缺省 → full=true 全量树。镜像空（relay 中途启动）=诚实空态全量空树，绝不错误显示。
 */
/** 工作计划树双源取数（buildWorkPlanState 组包唯一取数口径；v4：定格再排已退役，单一消费） */
async function collectWorkPlanSources(sessionId: string): Promise<{ mirrorTasks: TaskItem[]; boardItems: BoardItem[] }> {
  // 看板行双源直读（核心状态，不经 wire 形态）：会话轻量板 + 归属该会话的活动团队板（旧数据无归属=不并入）
  const boardSvc = getSessionBoardService()
  const sessionItems = boardSvc ? (await boardSvc.readBoard(sessionId)).items : []
  const teamSvc = getTeamRuntimeService()
  const activeTeam = teamSvc?.getActiveTeam()
  const teamItems =
    activeTeam && activeTeam.sessionId === sessionId ? (teamSvc!.boardList()?.items ?? []) : []
  return { mirrorTasks: workPlanMirror.get(sessionId) ?? [], boardItems: [...sessionItems, ...teamItems] }
}

export function makeWorkPlanSyncBridgeDeps(): Pick<RelayBridgeDeps, 'buildWorkPlanState'> {
  return {
    buildWorkPlanState: async (sessionId: string, knownRev?: string | number | null): Promise<WorkPlanStateBody> => {
      let rev = workPlanRevs.get(sessionId) ?? 0
      // 对账采纳（rev 纪律）：手机存量高于本端（跨纪元/丢更新）→ 抬升+落盘后再答——应答必过手机 LWW。
      // 采纳即持久化（mirror store 落盘）：serve 重启不丢采纳值，一次到位。
      const known = knownRev === undefined || knownRev === null ? Number.NaN : Number(knownRev)
      if (Number.isFinite(known) && known > rev) {
        rev = adoptSnapshotRev(known)
        workPlanRevs.set(sessionId, rev)
        console.log(`[workplan] rev 对账采纳 sid=${sessionId} →${rev}`)
        await getWorkPlanMirrorStore().save(workPlanMirror, workPlanRevs) // 采纳即落盘(内部自吞错);重启不丢采纳值
      }
      const upToDate = decideWorkPlanSync(rev, knownRev) === 'ack'
      const sources = await collectWorkPlanSources(sessionId)
      return {
        sessionId,
        rev: String(rev),
        full: !upToDate,
        items: upToDate ? [] : buildWorkPlanTree(sources),
      }
    },
  }
}

/**
 * 工作计划树变更订阅 → 桥（防抖 ~300ms trailing 合并照 wireBoard 逐行先例）：
 * 四个 TASK_* 事件按 source 过滤（黑名单制：拒 'subagent' worker 写入，undefined/'main'/'mobile' 照收）写入分键镜像；
 * BOARD_CHANGED/TEAM_BOARD_CHANGED 同窗订阅（迭代 2，照 wireBoard 双事件先例）——看板行是投影第二数据源，
 * 与清单变更共用同一单调 rev（单计数器覆盖双源）与同一防抖推送路径；
 * 窗口内同会话多次变更取最终态推一次（快照同步 latest-wins，合并天然无损）；附着门控在桥内。
 * 缺归因事件（sessionId 缺省）归引擎当前活动会话（opts.getActiveSessionId；与 callSessionId 兜底语义对齐）。
 * 返回退订函数。
 */
export function wireWorkPlan(
  bridge: RelayBridge,
  opts?: { debounceMs?: number; getActiveSessionId?: () => string | null },
): () => void {
  const debounceMs = opts?.debounceMs ?? 300
  // 装配即恢复（持久化快照 → 内存镜像/rev——根治 serve 重启双丢：重启后系统状态对手机不可区分）。
  // 只填空键、rev 取 max：恢复途中到达的事件已写入的新态不被旧快照覆盖；load 内部全降级不抛（双保险 catch）。
  // （v4：定格再排补排已随定时器面板退役——已结清批不再因时间退场，无补排需求；
  //  恢复后的树由手机 workplan.sync 拉路径与后续事件推送按需重算）
  void getWorkPlanMirrorStore()
    .load()
    .then(async ({ tasks, revs }) => {
      for (const [sid, list] of tasks) {
        if (!workPlanMirror.has(sid)) workPlanMirror.set(sid, list)
      }
      for (const [sid, rev] of revs) {
        workPlanRevs.set(sid, Math.max(rev, workPlanRevs.get(sid) ?? 0))
      }
      // v4.1 启动清扫：历史累积的让位批僵尸行物理删除（板与树生命周期对齐；删行触发 bump 推干净板——
      // 附着门控内只推手机附着的会话；无手机附着时下一轮 bump 兜底）
      for (const sid of tasks.keys()) await sweepRetiredBoardRows(sid)
    })
    .catch(() => {
      /* 恢复失败=空镜像现状 */
    })
  let timer: ReturnType<typeof setTimeout> | null = null
  const pendingSessions = new Set<string>()
  const sessionKey = (sid: string | undefined): string | undefined => sid ?? opts?.getActiveSessionId?.() ?? undefined
  const bump = (sid: string): void => {
    // snapshotRev SSOT（M4 收口，原内联实现换用单一事实点）：时间基单调（跨重启永不回退）——
    // 旧纯内存计数重启归零 → 推送的全量新树 rev 小于手机落库旧值 → 被手机 LWW 拒收 →
    // 脏态永久残留（2026-10-04 实测踩坑：serve 重启后手机工作计划永远显示旧树）。
    // max(Date.now(), prev+1)：同毫秒多 bump 严格递增；时间基 rev（毫秒级 13 位）天然大于
    // 任何旧计数纪元的值——手机端 LWW 直接放行，旧端零改动兼容
    const prevRev = workPlanRevs.get(sid) ?? 0
    workPlanRevs.set(sid, nextSnapshotRev(prevRev))
    pendingSessions.add(sid)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const sids = [...pendingSessions]
      pendingSessions.clear()
      void (async () => {
        for (const s of sids) {
          await sweepRetiredBoardRows(s) // 让位即删行（板与树生命周期对齐；删行触发的新 bump 防抖收敛，下一轮推干净板）
          bridge.pushWorkPlanState(s)
        }
        // 落盘快照与推送同窗：推送什么落什么（合并窗口内多次 bump 一次 IO；写失败静默=内存态现状）
        void getWorkPlanMirrorStore().save(workPlanMirror, workPlanRevs)
      })()
    }, debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  /**
   * 让位批物理清扫（v4.1：板行生命周期与树投影对齐——board.state 是全量快照推送，板行只增不减会让
   * 推送量线性膨胀直至打爆中继限流【2026-10-06 实测：35 行/249KB 的板一单任务推送 ≈500-750KB > 512KB/min】）。
   * 判定唯一事实点=retiredBatchGroupKeys（与投影同口径）；留痕不丢（交付物全文在 task.detail 通道与会话流）。
   * 幂等收敛：删行触发 BOARD_CHANGED → bump → 下一轮 sweep 无可删 → 推干净板。
   */
  const sweepRetiredBoardRows = async (sid: string): Promise<void> => {
    try {
      const svc = getSessionBoardService()
      if (!svc) return
      const board = await svc.readBoard(sid)
      if (board.items.length === 0) return
      const retired = retiredBatchGroupKeys({ mirrorTasks: workPlanMirror.get(sid) ?? [], boardItems: board.items })
      if (retired.size === 0) return
      for (const it of board.items) {
        const key = it.batchId ?? `__solo__:${it.id}`
        if (!retired.has(key)) continue
        try {
          await svc.remove(sid, it.id, { role: 'lead' })
        } catch {
          /* 行已被并发操作改动/移除：本轮跳过，下一轮 sweep 重算 */
        }
      }
    } catch {
      /* 读板失败=本轮不清扫；推送照常（投影层仍会让位不显示） */
    }
  }
  const onCreated = (e: TaskListCreatedEvent): void => {
    if (!acceptTaskEventSource(e.source)) return
    const sid = sessionKey(e.sessionId)
    if (!sid) return
    mirrorTaskListCreated(workPlanMirror, sid, e.tasks)
    bump(sid)
  }
  const onStatus = (e: TaskStatusUpdatedEvent): void => {
    if (!acceptTaskEventSource(e.source)) return
    const sid = sessionKey(e.sessionId)
    if (!sid) return
    if (mirrorTaskStatusUpdated(workPlanMirror, sid, e.taskId, e.status, e.content, e.result)) bump(sid)
  }
  const onDeleted = (e: TaskDeletedEvent): void => {
    if (!acceptTaskEventSource(e.source)) return
    const sid = sessionKey(e.sessionId)
    if (!sid) return
    if (mirrorTaskDeleted(workPlanMirror, sid, e.taskId)) bump(sid)
  }
  const onAdded = (e: TaskAddedEvent): void => {
    if (!acceptTaskEventSource(e.source)) return
    const sid = sessionKey(e.sessionId)
    if (!sid) return
    if (mirrorTaskAdded(workPlanMirror, sid, e.task)) bump(sid)
  }
  // 看板双事件同窗订阅（照 wireBoard 先例）：投影第二数据源变更——镜像不动，rev 照涨照推
  const onBoardChanged = (payload: { sessionId?: string }): void => {
    const sid = sessionKey(payload?.sessionId)
    if (!sid) return
    bump(sid)
  }
  eventBus.on(EVENTS.TASK_LIST_CREATED, onCreated)
  eventBus.on(EVENTS.TASK_STATUS_UPDATED, onStatus)
  eventBus.on(EVENTS.TASK_DELETED, onDeleted)
  eventBus.on(EVENTS.TASK_ADDED, onAdded)
  eventBus.on(EVENTS.BOARD_CHANGED, onBoardChanged)
  eventBus.on(EVENTS.TEAM_BOARD_CHANGED, onBoardChanged)
  return () => {
    if (timer) clearTimeout(timer)
    eventBus.off(EVENTS.TASK_LIST_CREATED, onCreated)
    eventBus.off(EVENTS.TASK_STATUS_UPDATED, onStatus)
    eventBus.off(EVENTS.TASK_DELETED, onDeleted)
    eventBus.off(EVENTS.TASK_ADDED, onAdded)
    eventBus.off(EVENTS.BOARD_CHANGED, onBoardChanged)
    eventBus.off(EVENTS.TEAM_BOARD_CHANGED, onBoardChanged)
  }
}
