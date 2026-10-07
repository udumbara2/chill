/**
 * RelayBridge.ts — relay 桥（M2，Node-free，renderer 安全）。
 *
 * 入向：信箱消息 → 解密（key_m2d / AAD=myBox‖m2d‖v）→ from/to + ts + 去重校验
 *   → pair.hello（pairingMAC 互验 → 壳侧确认 → 回投 pair.confirm）
 *   → chat.user → 入向链（M0.4a：按目标会话分键——串行化本质作用域=单引擎）enqueueExternalMessage → 回复加密投手机信箱。
 *   → approval.response（M4）→ deps.resolveApproval 落定；失效审批回发 cancelled 终态（僵尸卡构造上不可能）。
 *   → M6：session.attach（附着/脱离订阅，请求-确认制回 attached.changed）/ catalog.sync（目录对账应答）
 *   → history.request（游标分页拉历史）/ chat.user 可携带 sessionId（发言即附着+激活，守卫失败诚实回 notice）。
 * 出向：引擎流式 delta 聚合（200ms 或 2KB 窗口）→ chat.event(delta) 投递；
 *   轮次落定 → chat.event(final)；hook deny → chat.event(notice) 回执。
 *   M4：pushApprovalRequest/pushApprovalResolved（审批双通道）、pushReasoning（思维链 kind='reasoning'）；
 *   M4b：pushToolEvent（工具事件 kind='tool'，带 toolCallId/detail）、advanceBeat（节拍前进，先冲刷再自增）；
 *   beat 在生产时捕获随缓冲携带；全部经出向 FIFO（outChain）保序。
 *   M4：resyncPendingApprovals——审批是可操作状态（非纯展示），壳侧传输每次连接成功后调用，
 *   从 ApprovalChannel（真相源）重推挂起审批重建手机视图；并重放近期落定环（请求+落定对）愈合丢失的终态。
 *   d→m 文件发送（file.* 角色无关化）：sendFileToMobile 出向编排（校验单点：路径解析/denylist/存在性/
 *   0字节/≤100MB → caps 门 → fileSender v2 分片 → file.offer）；file.receipt 入向 → 等待器 resolve +
 *   onFileReceipt 通告（无等待器的迟到 receipt 同样通告）；presence.ping body.caps 能力门。
 *   M4e：pushAskRequest/pushAskResolved/resyncPendingAsks（通用提问双通道，与审批同构）；
 *   ask.response 与 approval.response 同走快速路径（防"提问/审批等待自己"死锁）。
 *   M6 附着模型：出向门控从 roundActive 改为"内容所属会话 === attachedSessionId"（手机轮/本地轮统一判断）；
 *   审批/ask/mode 维持不受门控。附着归零与通告（owner 易主/桥重建）见 announceAttachReset。
 *   本地轮镜像：pushStreamChunk（TURN_STREAM_CHUNK 经 wiring 转发）+ pushToolEvent（toolStatus 通道）。
 * ACK 纪律：解密 + 注入成功后才 ACK（at-least-once；失败不 ACK 等重投，去重在注入后标记）。
 * confirm 前收到非 pair 信封：ACK 丢弃 + 计数（防重投风暴，本地不处理）。
 * hello 解密失败/MAC 校验失败：统一 fail-closed 报警（onAlarm），禁止静默重试。
 * 纯逻辑层红线：不 import eventBus / getApprovalChannel 等环境单例——环境感知全部在 engineWiring.ts。
 * 位置红线：本文件在 services/relay/ 红线目录（Node-free/renderer 安全，逐字拷贝纪律）——
 * catalog/history 的真相源读取（fs）全部经 deps 注入，本文件不 import SessionSyncService。
 */
import {
  decryptEnvelope,
  encryptEnvelope,
  makeEnvelope,
  pairingMAC,
  isTsFresh,
  truncateToBudget,
  DedupeSet,
  KNOWN_TYPES,
  PLAINTEXT_BUDGET_BYTES,
  MEDIA_NAME_RE,
  MEDIA_MAX_BYTES,
  MEDIA_CHUNK_BYTES,
  openMediaBlob,
  openMediaChunk,
  mediaChunkRange,
  b64uDecode,
  isB64u,
  FILE_MAX_BYTES,
  FILE_TRANSFER_TTL_MS,
  type Envelope,
  type DerivedSecrets,
  type CatalogSyncBody,
  type CatalogStateBody,
  type CatalogSessionMeta,
  type HistoryPageBody,
  type SessionEventBody,
  type BoardSyncBody,
  type BoardStateBody,
  type BoardRowWire,
  type WorkPlanSyncBody,
  type WorkPlanStateBody,
  type WorkPlanItemWire,
  type FeedSubagentBody,
  type CmdRequestBody,
  type CmdResultBody,
  type CmdStateBody,
  type CommandStateSnapshot,
  type ChatUserAttachment,
  type FileOfferBody,
  type FileReceiptBody,
  CAP_FILE_RECV,
} from './envelope'
import { sendFile, type PutMediaChunk } from './fileSender'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import {
  createFileTransferStore,
  offerFile,
  receiveChunk,
  abortTransfer,
  settleTransfer,
  dropTransfer,
  getSettled,
  sweepTransfers,
  sanitizeFileExtension,
  type FileTransferStore,
} from './fileTransfer'
import { resolveCommand, commandCatalog, validateArgs, type CommandExecutorResult } from '../commands/commandSurface'
import type { RelayTransport, RelayHttp, BoxMessage } from './RelayTransport'
import type { ApprovalRequestPayload, SettledApprovalRecord } from '../approvals'
import type { AskRequestPayload, SettledAskRecord } from '../askChannel'
import type { AskDecisionEntry } from './envelope'
import type { ContentPart, MessageAttachmentRef } from '../../types/models'

/**
 * [relay-dbg] 调试输出开关：默认关闭（避免污染 CLI/TUI 显示），设环境变量
 * CHILL_RELAY_DBG=1 开启。renderer 安全：无 process 环境时恒为关。
 */
const RELAY_DBG = typeof process !== 'undefined' && process.env?.CHILL_RELAY_DBG === '1'
const dbg = (msg: string): void => {
  if (RELAY_DBG) console.log(msg)
}

/** UTF-8 字节数（catalog.state 分片预算判定用；TextEncoder 为平台无关 API，renderer 安全） */
const byteLen = (s: string): number => new TextEncoder().encode(s).length

/** static 媒体拉取超时（防注入实现 TCP 停滞永久挂起；超时不中止底层请求，迟到结果作废） */
const STATIC_FETCH_TIMEOUT_MS = 120_000

// ---------- 投递流控（中继投递流控规划 M1；2026-10-03 事故根治：429 曾被当错误——信封丢弃→手机重问→活锁） ----------

/** 429 背压退避：> 60s 限流窗口半程，任意窗口相位必跨重置（服务器 FixedWindow 拒绝不计费、整窗重置；
 *  fileSender/fileUploader 真机实证同值——指数退避总量不够，固定 35s 才够） */
const RELAY_THROTTLE_MS = 35_000
/** 不可再生信封的 429 重试上限（≈3 分钟；超限丢弃+alarm——持续限流已是异常态，交告警接管） */
const THROTTLE_MAX_RETRIES = 5
/**
 * 可再生信封类型（**=可迟延类，同一谓词两闸共用**——M1.1 发送闸与 M1.2 入队闸，严禁两张表各自维护）：
 * 撞 429 即弃靠再生（rev 推送再生成 / 手机 resync 重问），不吃重试——防快照被困 FIFO 头 5×35s≈175s
 * 头阻塞主流量与探活（M1.2 只管入队点，救不了已在队中的）。
 */
const REGENERABLE_ENVELOPE_TYPES: ReadonlySet<string> = new Set([
  'board.state',
  'workplan.state',
  'catalog.state',
  'history.page',
])

/** 一轮对话的结果（桥侧消费形态：enqueue 的返回） */
export interface EnqueueResult {
  content: string
  deniedReason?: string
  aborted: boolean
}

/**
 * 投递台账条目（M7增量3·决策30/31）：envelope 已持久收录但轮次未落定。
 * 台账是崩溃恢复的唯一事实源——存在即表示"消息在盘上、轮没跑完"，启动扫账续跑、重投命中幂等续跑。
 * file.* 协议族：attachments 为账面记录（恢复真相源是盘上消息——contentParts/attachmentRefs 已随消息落盘）。
 */
export interface PendingRoundEntry {
  envelopeId: string
  sessionId: string
  text: string
  replyTo: string
  createdAt: string
  /** chat.user 携带的附件声明（additive；仅账面留痕，恢复走盘上消息） */
  attachments?: ChatUserAttachment[]
}

/** 媒体直传在途条目（static offer 已 ACK、异步拉取未完；abort/完成即删；TTL 同传输层） */
interface StaticMediaPending {
  /** 密文名（MEDIA_NAME_RE） */
  name: string
  /** 每附件随机密钥 b64u */
  key: string
  /** 明文 sha256 hex（小写；拉取解密后对账） */
  sha256: string
  meta: { name: string; mime: string; size: number }
  offeredAt: number
  /** fmt:2 分片拉取参数（缺省 = v1 整块） */
  fmt2?: { wireSize: number; nonce: string }
}

/** enqueue 输入（file.* 协议族起 input 形态：text + 附件注入产物） */
export interface EnqueueInput {
  text: string
  /**
   * 注入目标会话（M0.1′ 多会话并行规划，additive）：壳侧注册表宿主按 id 直寻引擎，消除
   * active 指针路由竞态。无 id（旧装配/兼容跟随）→ 壳回退绑定/活跃引擎，行为逐位不变。
   */
  sessionId?: string
  /** 媒体内容块（图片/视频；宿主摄入闭包构建） */
  contentParts?: ContentPart[]
  /** 附件引用回填键（随用户消息落盘，toSyncMessage 据此输出 refs） */
  attachmentRefs?: MessageAttachmentRef[]
  /** 客户端消息身份（chat.user 信封 id，随用户消息落盘，toSyncMessage 据此输出 clientId） */
  clientId?: string
}

/**
 * M0.4b：单会话的轮次流聚合状态（delta/reasoning 聚合缓冲 + 节拍/序号计数器）。
 * 分键动机：并发轮次下单份共享状态存在跨链覆写窗口（chat.user 无条件复位 / enqueue
 * 结果路径置位）——分键后一切复位/冲刷/置位只作用于自己会话的格子。
 * beat 在生产时捕获、随缓冲携带（出向 FIFO 惰性执行，执行时现读会贴错节拍）；
 * eventSeq 为轮内单调序号（信道 at-least-once 可乱序，手机按 seq 归位组装）。
 */
interface StreamCell {
  /** 本格的会话身份（F-1：与生俱来——归属戳生产时刻捕获的数据源，绝不从 attached 推定） */
  sessionId: string
  pendingDelta: string
  pendingDeltaBeat: number
  deltaReplyTo: string | undefined
  deltaClosed: boolean
  deltaTimer: ReturnType<typeof setTimeout> | null
  beatIndex: number
  eventSeq: number
  pendingReasoning: string
  pendingReasoningBeat: number
  reasoningTimer: ReturnType<typeof setTimeout> | null
  /** 每节拍思维链累积全文（冲刷不清；关闭快照的数据源） */
  reasoningByBeat: Map<number, string>
  /** 已发快照的节拍（每节至多一次） */
  reasoningSnapSent: Set<number>
}

/** M0.4a：默认链键（配对信封 / 'new' 守卫段 / 无会话兼容路径）。会话 id 为 uuid 形态，无碰撞 */
const CHAIN_DEFAULT = '\u0000default'

export interface RelayBridgeDeps {
  transport: RelayTransport
  http: RelayHttp
  secrets: DerivedSecrets
  /** 桌面信箱（读）与手机信箱（写） */
  myBox: string
  peerBox: string
  deskPub: string
  phonePub: string
  /** 桌面设备名（pair.confirm 载荷用） */
  deviceName: string
  /** pairingMAC 的本地 HMAC key；null 时 hello 无法验（fail-closed 报警） */
  pairingToken: string | null
  /**
   * 懒读配对令牌（跨端配对：/pair 在他端出码时令牌后于他端 bridge 构造才落 secureStorage，
   * hello 到达时现读；返回非 null 时优先于 pairingToken 静态值）
   */
  getPairingToken?: () => Promise<string | null>
  /** 恢复态注入：此前已完成配对则为 true */
  confirmed: boolean
  /** 引擎注入点（壳侧接 ChatEngine.enqueueExternalMessage）。M6 起 onDelta 废弃可选：流式镜像走 TURN_STREAM_CHUNK 被动广播。
   *  M7增量3·决策30：opts.onIngested = 用户消息已持久化、轮次开始前的两段式回调（投递与处理解耦的引擎侧锚点）
   *  file.* 协议族：input 形态（text + contentParts/attachmentRefs——手机附件注入路径） */
  enqueue: (
    input: EnqueueInput,
    opts?: { onDelta?: (delta: string) => void; onIngested?: () => void | Promise<void> },
  ) => Promise<EnqueueResult>
  /**
   * file.* 协议族：重组完成后的落盘（装配层接 AttachmentManager.saveAttachment / UI 走 electronAPI IPC）。
   * 返回桌面侧引用（fileId，年/月/uuid.ext）；未注入 → offer 诚实拒绝（旧装配安全降级，不影响其余功能）。
   */
  saveAttachment?: (bytes: Uint8Array, name: string) => Promise<string>
  /**
   * 媒体直传：按密文名拉取密文（壳侧用自身 relay 配置拼 /static/media/<name> URL——同源天然成立，
   * 绝对 URL 不跨信任边界；core 禁 import Node https）。v2 分片路径带 Range 头（`bytes=a-b`）。
   * 未注入 → static offer 诚实拒绝（旧装配安全降级）。
   */
  fetchMedia?: (name: string, opts?: { range?: string }) => Promise<Uint8Array>
  // ---------- d→m 文件发送（出向）注入点：构造宽容、调用发送时才报错（防御性兜底，旧装配安全降级） ----------
  /**
   * 密文分片 PUT 上传（壳侧实现：HTTPS PUT /media/<name>，Media-Offset/Media-Total 头 +
   * Bearer write_token——write_token 认哈希不认方向，桌面天然持有同一凭据，中继零改动）。
   * 未注入 → sendFileToMobile 诚实报错。
   */
  putMedia?: PutMediaChunk
  /**
   * 文件切片读取（fileSender 在桥里跑；UI 壳的桥在渲染进程，读不了任意路径——经 IPC 主进程执行）。
   * 未注入 → 发送时诚实报错。
   */
  readFileSlice?: (path: string, offset: number, length: number) => Promise<Uint8Array>
  /**
   * 文件 stat：null = 不存在；isFile=false = 非普通文件（目录等）。
   * size/mtimeMs 供 mutated 护栏（发送前与完成后双调比对）。未注入 → 发送时诚实报错。
   */
  statFile?: (path: string) => Promise<{ size: number; mtimeMs: number; isFile: boolean } | null>
  /**
   * 路径解析（denylist 判定基准）：~ 展开为真实用户目录 + 相对路径按会话工作目录解析 +
   * 规范化绝对路径。未注入 → 发送时诚实报错（bytes 直发形态不需要）。
   */
  resolvePath?: (input: string) => Promise<string>
  /** 用户主目录（~/.chill/** denylist 判定基准；缺省时该条 denylist 不生效，其余条目仍生效） */
  homeDir?: string
  /** 文件系统大小写不敏感（Windows denylist 匹配口径；缺省 false） */
  caseInsensitivePaths?: boolean
  /**
   * file.receipt 到达通告（wiring 层转发 eventBus FILE_RECEIPT 事件；壳据此落会话提示）。
   * 无等待器的迟到 receipt 同样触发——桌面重启后等待器随进程消失，但送达事实必须让用户可见。
   */
  onFileReceipt?: (receipt: { fileId: string; ok: boolean; error?: string; name?: string; sessionId?: string }) => void
  /**
   * F-2（迭代 F）：附着变更通告（applyAttachment 全路径触发——attach/发言即附着/兼容收编）。
   * serve 单操作者宿主据此实现 attach 即激活（打开哪个会话=控制哪个会话——控制盲区根治）；
   * UI 宿主不注入（桌面人持有前台，attach 不得动桌面状态——协议冻结 :76 对多操作者宿主仍成立）。
   * additive 可选，未注入零行为变化。
   */
  onSessionAttached?: (sessionId: string | null) => void
  /**
   * file.* 协议族：chat.user attachments 的摄入装配（装配层实现，判据锚定 engine/fileRef.ts）：
   * 媒体 → buildContentParts（图片内联 base64 / 视频 fileId 引用走 mediaProvider 既有链）；
   * 其他类型 → `[附件] name（绝对路径，N bytes）` 引用行文本。未注入 → chat.user 带附件时诚实拒绝。
   */
  resolveAttachments?: (
    settled: Array<{ fileId: string; name: string; mime: string; savedRef: string; size: number }>,
  ) => Promise<{ refText: string; contentParts?: ContentPart[]; attachmentRefs: MessageAttachmentRef[] }>
  /** 壳侧配对确认（显示手机设备名 + 装饰性指纹；返回用户是否批准） */
  onConfirmRequest?: (device: string, fingerprint: string) => Promise<boolean>
  /** fail-closed 报警出口（hello 解密/MAC 失败、from/to 不符等） */
  onAlarm?: (message: string) => void
  /** 去重持久化（防重启后内存去重丢失导致重投重复处理）：壳侧提供文件读写。
   *  M7增量3·决策30：chat.user 的 seen-ids 降级为快速路径缓存（轮次落定时才落盘）；其余 envelope 类型仍到达即落 */
  loadSeenIds?: () => Promise<string[]>
  saveSeenIds?: (ids: string[]) => Promise<void>
  /** 投递台账持久化（M7增量3·决策30/31，崩溃恢复唯一事实源）：壳侧提供文件读写（CLI fs 工厂 / UI IPC） */
  loadPendingRounds?: () => Promise<PendingRoundEntry[]>
  savePendingRounds?: (entries: PendingRoundEntry[]) => Promise<void>
  /** 崩溃恢复续跑（壳侧接 ChatEngine.resumePendingRound）：重跑尾部未回复轮；null = 无可恢复轮 */
  resumeRound?: () => Promise<{ content: string; aborted: boolean } | null>
  /** 会话尾部消息窥视（重投的尾部同文检测用——消息已在盘则不重复注入；null = 会话不存在）。
   *  file.* 协议族：content 加宽为数组形态（ContentPart[]，附件消息）+ attachmentRefs——同文判据此多模态化 */
  peekSessionTail?: (sessionId: string) => Promise<{
    role: string
    content: string | Array<{ type: string; text?: string }>
    attachmentRefs?: MessageAttachmentRef[]
  } | null>
  /**
   * M4 审批回答落定（必填）：装配方转发 ApprovalChannel.resolve(..., 'phone')。
   * 返回 false = 已定落/不存在/进程重启后挂起蒸发 → 桥回发 cancelled 终态给手机。
   * opts.allowSession（additive）：手机「本次会话放行」第三钮——decision 仍为 'approve'
   * （旧桌面对未知 decision 判 reject，故扩展走独立字段不占 decision 词表），桥仅在
   * approve 时透传；落定语义与本地 CLI [s]/桌面 UI 会话放行钮同源（ApprovalResolution.allowSession）。
   */
  resolveApproval: (id: string, decision: 'approve' | 'reject', opts?: { allowSession?: boolean }) => boolean
  /** M4 重连再同步（必填）：装配方转发 ApprovalChannel.listPending()——审批真相源在 core */
  listPendingApprovals: () => ApprovalRequestPayload[]
  /**
   * M4e 提问回答落定（可选）：装配方转发 AskChannel.resolve(..., 'phone')。
   * 返回 false = 已定落/不存在/进程重启后挂起蒸发 → 桥回发 cancelled 终态给手机。
   * decisions = 结构化决策（手机点选卡 additive 回传，桥已做形状校验；缺失=undefined 走文本回退）。
   */
  resolveAsk?: (id: string, answer: string, decisions?: AskDecisionEntry[]) => boolean
  /** M4e 重连再同步（可选）：装配方转发 AskChannel.listPending()——提问真相源在 core */
  listPendingAsks?: () => AskRequestPayload[]
  /**
   * M5 权限模式写入（可选）：装配方校验并转发 builtInToolExecutor.setPermissionMode(mode, 'phone')。
   * 返回 false = 非法值（桥回推当前 mode.state 终态，愈合手机的错误视图）。
   */
  setPermissionMode?: (mode: string, by: string) => boolean
  /** M5 权限模式读取（可选）：resync 补推当前档用——真相源在 core executor */
  getPermissionMode?: () => string
  /** 近期落定环（可选，终态愈合）：装配方转发 ApprovalChannel.listRecentSettled()——resync 重放"请求+落定"对 */
  listRecentSettledApprovals?: () => SettledApprovalRecord[]
  /** 近期落定环（可选，终态愈合）：装配方转发 AskChannel.listRecentSettled() */
  listRecentSettledAsks?: () => SettledAskRecord[]
  /**
   * M6：catalog.sync 应答（wiring 注入：buildCatalog + diffCatalog 组包）。
   * 返回未分片的完整应答体；超 45KB 明文预算的分片（chunk/chunks，同 replyTo 归组）在桥内完成。
   */
  buildCatalogState?: (known: CatalogSyncBody) => Promise<CatalogStateBody>
  /**
   * M7：board.sync 应答 / board.state 出向组包（wiring 注入：SessionBoardService.getProjection 组包 +
   * ask/approval 未决计数）。knownRev=手机已知 rev（对账）；返回未分片完整体，分片在桥内完成。
   */
  buildBoardState?: (sessionId: string, knownRev?: string | number) => Promise<BoardStateBody>
  /**
   * 工作计划树：workplan.sync 应答 / workplan.state 出向组包（wiring 注入：分键清单镜像 + buildWorkPlanTree 投影）。
   * knownRev=手机已知 rev（对账）；返回未分片完整体，分片在桥内完成（骨架照 board.state，本期体量小）。
   */
  buildWorkPlanState?: (sessionId: string, knownRev?: string | number | null) => Promise<WorkPlanStateBody>
  /** M6：history.request 应答（wiring 注入 SessionSyncService.pageHistory 闭包） */
  pageHistory?: (sessionId: string, before: string | undefined, limit: number | undefined) => Promise<HistoryPageBody>
  /**
   * M6 发言即激活：把手机发言目标会话切为桌面当前会话（装配方调引擎 loadSession，沿用既有守卫）。
   * 'busy' = 引擎忙/有后台任务（诚实回 notice，不排队不假装）；'notfound' = 会话不存在。
   */
  ensureActiveSession?: (sessionId: string) => Promise<'ok' | 'busy' | 'notfound'>
  /**
   * M6b 'new' 分支：守卫检查 + 空会话复用/startNewSession（装配方实现，wiring 有现成 makeEnsureNewSession）。
   * 返 'ok' 时契约要求当前会话 id 已诞生（轮前附着需要具体 id）；'busy' = 引擎忙/有后台任务。
   */
  ensureNewSession?: () => Promise<'ok' | 'busy'>
  /** M6：当前引擎活跃会话 id（chat.user 缺省目标判定 + 兼容跟随路径的镜像门控现读） */
  getActiveSessionId?: () => string | null
  /**
   * 运行中会话全集现读（可选，运行态标志）：宿主 registry 现算（core SessionRegistry.runningSessionIds
   * 单源）。两个消费点：pushRunningChanged/pushRunningSnapshot 的 runningAll 随行 + catalog.state
   * 对账快照（后者经 buildCatalogState 闭包同步消费）。未注入 → 两处均省略字段（旧语义）。
   */
  getRunningSessionIds?: () => string[]
  /**
   * M8 命令执行（可选）：装配方委托 commandSurface.executeCommand（deps 注入服务引用——绑定逻辑唯一
   * 事实点在 core commandSurface，双壳不写绑定）。未装配（M1 dormant / 只观测宿主）→ 诚实回 unsupported。
   */
  executeCmd?: (cmd: string, args?: Record<string, unknown>) => Promise<CommandExecutorResult>
  /** M8 命令面状态快照（可选）：装配方委托 commandSurface.buildCommandState（现读 engine+services） */
  getCommandState?: () => CommandStateSnapshot | null
  now?: () => number
  /**
   * 429 背压通告（中继投递流控规划 M1.1/M1.3）：每次撞限流即回调（含重试中的每次尝试）。
   * 壳据此判定"持续 >2min"告警（sustainedMs 由 since 现算；送达成功且退避期满后 since 复位）。
   */
  onDeliveryThrottled?: (info: { at: number; since: number; sustainedMs: number; envelopeType: string; action: 'retry-wait' | 'drop-regenerable' | 'drop-exhausted' }) => void
  /** 退避等待注入（默认 setTimeout；Node-free 红线下的可测拨时钟点，fileSender 同款先例） */
  sleep?: (ms: number) => Promise<void>
}

/** 出向聚合窗口：200ms 或 2KB（以字符数近似，见 PROTOCOL-FROZEN 大小边界注） */
const DELTA_FLUSH_MS = 200
const DELTA_FLUSH_CHARS = 2048

/**
 * 快速路径类型集（同步解密+校验命中即处理，不进串行入向链）：
 * approval.response/ask.response/mode.set/chat.sync 不碰引擎（防"回答排在被自己阻塞的轮次后"死锁）；
 * M6 的 session.attach/catalog.sync/history.request 同样不碰引擎（附着订阅/目录对账/历史分页只读
 * 文件真相源），排在被审批楔死的链后会导致附着确认与目录/历史应答被无关轮次阻塞。
 */
const FAST_PATH_TYPES = new Set([
  'approval.response',
  'ask.response',
  'chat.sync',
  'mode.set',
  'session.attach',
  'catalog.sync',
  'history.request',
  'presence.ping',
  // M7：board.sync 同理不碰引擎（看板是内存+快照读），走快速路径防被无关轮次楔死
  'board.sync',
  // 工作计划树：workplan.sync 同理（镜像是内存读），走快速路径
  'workplan.sync',
  // M8：cmd.* 全走快速路径——handler 本身不碰引擎（cmd.request 是分流器：fast 命令就地执行，
  // serial 命令入串行链排队=轮末生效的诚实语义；排在被运行轮占据的链后也不影响 turn.stop 跳队）
  'cmd.request',
  'cmd.sync',
  // file.* 协议族：offer/chunk/abort 只碰内存重组缓冲（不碰引擎）——排在被引擎轮楔死的链后
  // 会把附件传输卡在轮次后面（手机 receipt 超时误判失败）；幂等由 (fileId,seq) 承担，无需信封级去重
  'file.offer',
  'file.chunk',
  'file.abort',
  // file.receipt（m→d 回执，d→m 发送的终局真相）：只碰内存等待器——不碰引擎，走快速路径
  'file.receipt',
])

/** M4：审批请求的人类可读摘要（手机卡片标题） */
function approvalSummary(payload: ApprovalRequestPayload): string {
  if (payload.kind === 'write') return `写入 ${payload.path ?? '(未知路径)'}`
  const cmd = payload.command ?? '(未知命令)'
  return payload.purpose ? `执行命令: ${cmd}\n目的: ${payload.purpose}` : `执行命令: ${cmd}`
}

/**
 * 尾部同文判据（M7增量3 重投/恢复的"消息已在盘"检测；file.* 协议族起多模态）：
 * - 纯文本消息 → content 字符串等值且无附件引用；
 * - 附件消息（content 为 ContentPart[]）→ text 部分拼接等值（=合并文本：用户文本+引用行）
 *   且 attachmentRefs 逐项同序相等（双方产自同一 attachments 声明）。
 * 纯文本比对对数组 content 永不命中——附件消息在"落盘后台账写前"崩溃窗口的重投会双写，故必做多模态。
 */
function tailMatchesMessage(
  tail: { role: string; content: string | Array<{ type: string; text?: string }>; attachmentRefs?: MessageAttachmentRef[] } | null | undefined,
  text: string,
  attachmentRefs?: MessageAttachmentRef[],
): boolean {
  if (!tail || tail.role !== 'user') return false
  if (Array.isArray(tail.content)) {
    const tailText = tail.content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join(' ')
    const tailRefs = tail.attachmentRefs ?? []
    const refs = attachmentRefs ?? []
    if (tailRefs.length !== refs.length) return false
    for (let i = 0; i < refs.length; i++) {
      if (tailRefs[i]!.ref !== refs[i]!.ref || tailRefs[i]!.name !== refs[i]!.name) return false
    }
    return tailText === text
  }
  return typeof tail.content === 'string' && tail.content === text && !(attachmentRefs?.length)
}

/** chat.user body.attachments 解析（≤5 项；畸形一律拒绝——fail-closed 不建幽灵附件） */
function parseChatUserAttachments(body: Record<string, unknown>): ChatUserAttachment[] | null {
  const raw = body['attachments']
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5) return null
  const out: ChatUserAttachment[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const a = item as Record<string, unknown>
    if (typeof a['fileId'] !== 'string' || !a['fileId'] || typeof a['name'] !== 'string' || !a['name'] || typeof a['mime'] !== 'string') {
      return null
    }
    out.push({ fileId: a['fileId'], name: a['name'], mime: a['mime'] })
  }
  return out
}

/**
 * ask.response 的结构化决策形状校验（additive 可选字段；动作词表=账本词汇 confirm/close/skip，
 * clusterId/title 至少其一）。任一条目畸形整体丢弃（undefined）→ 开庭收口走文本回退，不放行半坏数据。
 */
function parseAskDecisions(raw: unknown): AskDecisionEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: AskDecisionEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined
    const e = item as Record<string, unknown>
    const action = e['action']
    if (action !== 'confirm' && action !== 'close' && action !== 'skip') return undefined
    const entry: AskDecisionEntry = { action }
    if (typeof e['clusterId'] === 'string' && e['clusterId']) entry.clusterId = e['clusterId']
    if (typeof e['title'] === 'string' && e['title']) entry.title = e['title']
    if (entry.clusterId === undefined && entry.title === undefined) return undefined
    out.push(entry)
  }
  return out.length > 0 ? out : undefined
}

export class RelayBridge {
  private deps: RelayBridgeDeps
  private dedupe = new DedupeSet(4096)
  private seenLoaded = false
  /** file.* 协议族：重组缓冲 + 完成态注册表（幂等由 (fileId,seq) 与 settled 键承担，不进信封去重） */
  private fileStore: FileTransferStore = createFileTransferStore()
  /** 媒体直传在途登记（static offer 已 ACK、拉取未完；abort/完成即删） */
  private pendingStaticMedia = new Map<string, StaticMediaPending>()

  /** 惰性恢复已见 id（首次使用前）；新 id 落盘防抖 */
  private async ensureSeenLoaded(): Promise<void> {
    if (this.seenLoaded) return
    this.seenLoaded = true
    try {
      const ids = await this.deps.loadSeenIds?.()
      if (ids?.length) this.dedupe = new DedupeSet(4096, ids)
    } catch {
      /* 恢复失败不影响主流程 */
    }
  }

  private markAndPersist(id: string): boolean {
    const isNew = this.dedupe.mark(id)
    if (isNew) void this.persistSeen()
    return isNew
  }

  private async persistSeen(): Promise<void> {
    if (!this.deps.saveSeenIds) return
    try {
      await this.deps.saveSeenIds(this.dedupe.snapshot())
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }

  // ---------- M7增量3·决策30/31：投递台账（崩溃恢复唯一事实源） ----------

  private pendingRounds: PendingRoundEntry[] | null = null

  private async ensureLedgerLoaded(): Promise<void> {
    if (this.pendingRounds !== null) return
    this.pendingRounds = []
    try {
      const entries = await this.deps.loadPendingRounds?.()
      if (Array.isArray(entries)) {
        this.pendingRounds = entries.filter((e) => e && typeof e.envelopeId === 'string' && typeof e.text === 'string')
      }
    } catch {
      /* 恢复失败按空账处理（重投路径的尾部同文检测兜底） */
    }
  }

  /** 记账（幂等：同 envelopeId 只记一次）。落盘失败上抛——调用方据此不 ACK（安全不对称） */
  private async addLedgerEntry(entry: PendingRoundEntry): Promise<void> {
    await this.ensureLedgerLoaded()
    const list = this.pendingRounds ?? []
    if (list.some((e) => e.envelopeId === entry.envelopeId)) return
    list.push(entry)
    await this.persistLedgerSnapshot(list)
  }

  /**
   * 台账落盘串行链（M0.4a 钉子③根治）：分键并发轮次的清账可交错触发 savePendingRounds，
   * 保存乱序完成会复活已清条目（自愈兜底虽有——尾部已演进→清账收敛——但窗口可消除）。
   * 快照按调用逻辑序保序执行：每次快照含此前全部清除，末次落盘即完整状态（确定性终态）。
   */
  private ledgerSaveChain: Promise<void> = Promise.resolve()
  private persistLedgerSnapshot(entries: PendingRoundEntry[]): Promise<void> {
    if (!this.deps.savePendingRounds) return Promise.resolve()
    const run = (): Promise<void> => this.deps.savePendingRounds!(entries)
    this.ledgerSaveChain = this.ledgerSaveChain.then(run, run) // 失败不堵后续（清账失败已有报警+自愈）
    return this.ledgerSaveChain
  }

  /** 清账：轮次落定（成功/失败/恢复完成）后移除。清除失败只报警（重启扫账幂等收敛） */
  private async removeLedgerEntry(envelopeId: string): Promise<void> {
    const list = this.pendingRounds
    if (!list || !list.some((e) => e.envelopeId === envelopeId)) return
    this.pendingRounds = list.filter((e) => e.envelopeId !== envelopeId)
    try {
      await this.persistLedgerSnapshot(this.pendingRounds)
    } catch (err) {
      this.alarm(`投递台账清除失败（重启扫账会幂等收敛）：${String(err)}`)
    }
  }

  /**
   * 已收录消息的恢复路径（启动扫账 / 重投命中台账）：激活目标会话 →
   * 尾部仍是未回复的原 text → 续跑轮（不重复 append）→ final 回执；
   * 尾部已回复/已演进 → 仅清账（轮其实已落定，幂等收敛）。
   */
  private async resumeIngestedMessage(entry: PendingRoundEntry, pushFinal: boolean): Promise<void> {
    const sid = entry.sessionId
    if (sid && sid !== (this.deps.getActiveSessionId?.() ?? null)) {
      const r = this.deps.ensureActiveSession ? await this.deps.ensureActiveSession(sid) : 'notfound'
      if (r !== 'ok') {
        await this.removeLedgerEntry(entry.envelopeId)
        this.alarm(`恢复轮次无法激活会话 ${sid}（${r}），已清账（消息仍在盘上可见）`)
        this.markRecoveredEnvelope(entry.envelopeId)
        return
      }
    }
    const tail = sid ? ((await this.deps.peekSessionTail?.(sid)) ?? null) : null
    // file.*：台账 text 为合并文本（用户文本+引用行）；attachments → refs 映射后走多模态同文判据
    const entryRefs: MessageAttachmentRef[] | undefined = entry.attachments?.map((a) => ({ ref: a.fileId, name: a.name, mime: a.mime }))
    if (tailMatchesMessage(tail, entry.text, entryRefs)) {
      // 轮未跑完 → 续跑（恢复轮允许一次性激活目标会话，随后落定）
      const result = this.deps.resumeRound ? await this.deps.resumeRound() : null
      await this.removeLedgerEntry(entry.envelopeId)
      if (pushFinal && result) {
        // 0.4b：恢复轮的终态落在该会话自己的格子上；F-1：戳=台账会话（生产时刻捕获）
        const cell = this.cellFor(sid || (this.deps.getActiveSessionId?.() ?? ''))
        cell.deltaClosed = true
        const finalBeat = cell.beatIndex
        await this.queueOut(() =>
          this.sendEvent(result.aborted ? 'notice' : 'final', result.content || '（无文本回复）', entry.replyTo, {
            beat: finalBeat,
            sessionStamp: cell.sessionId,
          }),
        )
      }
      this.markRecoveredEnvelope(entry.envelopeId)
      return
    }
    // 尾部已回复/已演进（崩在清账前或已人工处理）→ 清账收敛
    await this.removeLedgerEntry(entry.envelopeId)
    this.markRecoveredEnvelope(entry.envelopeId)
  }

  /** 恢复完成的 envelope 永久视为已见：后续任何重投（含重启后）静默 ACK，不重复注入 */
  private markRecoveredEnvelope(envelopeId: string): void {
    if (this.dedupe.mark(envelopeId)) void this.persistSeen()
  }

  /** 启动扫账：逐条恢复未落定轮（串行；失败逐条报警不中断） */
  private async resumeStartupPendingRounds(): Promise<void> {
    await this.ensureLedgerLoaded()
    const entries = [...(this.pendingRounds ?? [])]
    for (const entry of entries) {
      try {
        dbg(`[relay-dbg] 启动恢复未落定轮 envelope=${entry.envelopeId}`)
        await this.resumeIngestedMessage(entry, false)
      } catch (err) {
        this.alarm(`启动恢复轮次失败（envelope=${entry.envelopeId}）：${String(err)}`)
      }
    }
  }
  /**
   * 入向串行链按目标会话分键（M0.4a 多会话并行规划）：串行化的本质作用域 = 单引擎
   * （sendMessage running-throw，排队不放引擎），不是进程——chat.user 入目标会话链，
   * 跨会话消息并行互不楔。DEFAULT 键承载配对信封与 'new' 守卫段（目标会话在守卫后才诞生）。
   * 空链条目在落定后回收（防长驻进程无界增长；回收竞态由 next 引用同一性判定兜底）。
   */
  private chains = new Map<string, Promise<unknown>>()
  /** 出向投递链（delta/final/notice 全部经此 FIFO——handleMessage 自身跑在入向 chain 上，
   *  若 delta 直接挂入向 chain 会排在整个 handleMessage（含 final）之后，造成 final 先于 delta 到达手机） */
  private outChain: Promise<unknown> = Promise.resolve()
  private confirmed: boolean
  private droppedPreConfirm = 0
  private now: () => number
  /** M6：附着会话（手机声明"我在看会话 X"；null=未附着）。出向门控 = 内容所属会话 === attachedSessionId */
  private attachedSessionId: string | null = null
  /** M6 兼容路径：旧端 chat.user 不带 sessionId 时，本轮镜像跟随桌面当前会话（轮次落定后收编为正式附着） */
  private followActiveSession = false
  /** M6 owner 易主/桥重建：附着归零通告每实例至多一次（重连不重复，防与手机重 announce 对打） */
  private attachResetAnnounced = false

  // ---------- M0.4b：轮次流聚合状态按会话分键（并发轮次互不覆写） ----------
  // 单份共享时代两处跨链覆写窗口：chat.user 无条件复位 / enqueue 结果路径的 flush+置位可被
  // 他会话轮次落定触发（B 流式中 A 落定 → B 的 deltaReplyTo 被打回 undefined，后续 delta 失锚）。
  // 分键后一切复位/冲刷/置位只作用于自己会话的状态格；格子由闲置回收（pruneSessionRuntime）清理。
  private streamCells = new Map<string, StreamCell>()

  private cellFor(sessionId: string): StreamCell {
    let cell = this.streamCells.get(sessionId)
    if (!cell) {
      cell = {
        sessionId,
        pendingDelta: '',
        pendingDeltaBeat: 0,
        deltaReplyTo: undefined,
        deltaClosed: false,
        deltaTimer: null,
        beatIndex: 0,
        eventSeq: 0,
        pendingReasoning: '',
        pendingReasoningBeat: 0,
        reasoningTimer: null,
        reasoningByBeat: new Map<number, string>(),
        reasoningSnapSent: new Set<number>(),
      }
      this.streamCells.set(sessionId, cell)
    }
    return cell
  }

  /** M0.4a：work 挂到指定键的链尾（每键独立串行）；链条目在落定后回收（引用同一性判定防竞态误删） */
  private enqueueChain(key: string, work: () => Promise<void>): Promise<unknown> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(work).catch((err) => this.alarm(`处理信箱消息异常: ${String(err)}`))
    this.chains.set(key, next)
    void Promise.resolve(next).finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    return next
  }

  /**
   * 0.4b 边缘愈合：把 from 键的格子整体迁移到 to 键（缺省目标轮次的会话 id 在收录时诞生）。
   * to 已有内容（先到 chunk 建了格）则不迁移——以真实流内容为准，仅补锚：
   */
  private migrateStreamCell(from: string, to: string): void {
    const src = this.streamCells.get(from)
    if (!src) return
    const dst = this.streamCells.get(to)
    if (!dst) {
      // F-1：格子的会话身份随迁移改写——后续冲刷按新 id 盖章
      src.sessionId = to
      this.streamCells.set(to, src)
      this.streamCells.delete(from)
      return
    }
    if (dst.deltaReplyTo === undefined) dst.deltaReplyTo = src.deltaReplyTo
    this.streamCells.delete(from)
  }

  /**
   * 会话运行时回收（M2.1 闲置回收调用）：清入向链条目 + 轮次流聚合格。
   * 在途链任务自然跑完（回收条件本身保证无在途轮/任务）；同名新会话活动会重建格子。
   */
  pruneSessionRuntime(sessionId: string): void {
    this.chains.delete(sessionId)
    const cell = this.streamCells.get(sessionId)
    if (cell) {
      if (cell.deltaTimer) clearTimeout(cell.deltaTimer)
      if (cell.reasoningTimer) clearTimeout(cell.reasoningTimer)
      this.streamCells.delete(sessionId)
    }
  }
  /** M4/M4e：已推送过终态的审批/提问 id（有界）：迟到/重试的回答落空时，已落定过的不再回发 cancelled——
   *  防"批准已落定后，重试的第二个 response 触发 cancelled 覆盖真实终态" */
  private resolvedPushed = new Set<string>()

  private markResolvedPushed(id: string): void {
    this.resolvedPushed.add(id)
    if (this.resolvedPushed.size > 512) {
      const oldest = this.resolvedPushed.values().next().value
      if (oldest !== undefined) this.resolvedPushed.delete(oldest)
    }
  }

  constructor(deps: RelayBridgeDeps) {
    this.deps = deps
    this.confirmed = deps.confirmed
    this.now = deps.now ?? (() => Date.now())
  }

  // ---------- 投递流控状态（中继投递流控规划 M1.1/M1.2） ----------
  /** 节流态终点（epoch ms）：期内可迟延类延迟入队（M1.2 入队闸）；仅随时间自然过期，不因单次成功清除 */
  private throttledUntil = 0
  /** 本轮流控起点（首发 429 时刻）：送达成功且退避期满后复位——壳据 sustainedMs 判定持续告警 */
  private throttleSince: number | null = null
  /** 延迟入队登记（M1.2）：key 命中同键旧项先移除=rev/latest-wins 折叠；key=null 不折叠（history 页保序） */
  private deferredSends: Array<{ key: string | null; run: () => void }> = []
  private deferredFlushScheduled = false
  private stoppedFlag = false
  private sleepCancels = new Set<() => void>()

  /** 停止：取消全部在途退避等待与冲刷定时（serve 优雅自退/壳停用时防 35s 挂住——对照换版接续约定退出口纪律） */
  stop(): void {
    this.stoppedFlag = true
    for (const cancel of this.sleepCancels) cancel()
    this.sleepCancels.clear()
  }

  /** 退避等待（默认 setTimeout；deps.sleep 可测拨时钟）。stop() 即拒——不挂退出口 */
  private throttleSleep(ms: number): Promise<void> {
    if (this.stoppedFlag) return Promise.reject(new Error('bridge 已停止'))
    const base =
      this.deps.sleep?.(ms) ??
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      })
    return new Promise<void>((resolve, reject) => {
      const cancel = (): void => reject(new Error('bridge 已停止'))
      this.sleepCancels.add(cancel)
      base.then(
        () => {
          this.sleepCancels.delete(cancel)
          resolve()
        },
        (err) => {
          this.sleepCancels.delete(cancel)
          reject(err)
        },
      )
    })
  }

  /**
   * M1.2 可迟延类入队闸：未退避→立即执行；退避中→登记延迟（同键折叠=latest-wins；null 键保序追加），
   * 到 throttledUntil 一次性冲刷（冲刷的 run 各自回 queueOut/boardSendChain，保序由既有链保证；
   * 冲刷时点若退避已被队头重试延长则顺延）。
   */
  private deferOrSend(key: string | null, run: () => void): void {
    const nowMs = this.now()
    if (this.stoppedFlag) return
    if (nowMs >= this.throttledUntil) {
      run()
      return
    }
    if (key !== null) {
      const idx = this.deferredSends.findIndex((e) => e.key === key)
      if (idx >= 0) this.deferredSends.splice(idx, 1)
    }
    this.deferredSends.push({ key, run })
    this.scheduleDeferredFlush(this.throttledUntil - nowMs)
  }

  private scheduleDeferredFlush(delayMs: number): void {
    if (this.deferredFlushScheduled) return
    this.deferredFlushScheduled = true
    void this.throttleSleep(Math.max(0, delayMs)).then(
      () => {
        this.deferredFlushScheduled = false
        const nowMs = this.now()
        if (nowMs < this.throttledUntil) {
          // 退避被队头重试延长（重试又撞墙）——顺延到新终点
          if (this.deferredSends.length > 0) this.scheduleDeferredFlush(this.throttledUntil - nowMs)
          return
        }
        const entries = this.deferredSends
        this.deferredSends = []
        for (const entry of entries) entry.run()
      },
      () => {
        this.deferredFlushScheduled = false // stopped：遗留项随进程湮灭
      },
    )
  }

  /** 接线传输事件（connect 由壳侧/租约仲裁负责） */
  start(): void {
    this.deps.transport.onMessage((msg) => {
      // 快速路径（同步判定）：approval.response/ask.response 不进串行链——它们不碰引擎，绝不能排在
      // 被审批/提问阻塞的轮次后面（否则"审批/提问等待自己"死锁，只能靠 5 分钟超时打破——实测复现）
      if (this.tryFastPath(msg)) return
      // M0.4a：链键 = 注入目标会话（入链时一次解析——钉子①：链键与 enqueue 目标同值，
      // 防链选择与注入目标间活跃漂移错配）。'new'/配对/解密失败落默认链。
      const route = this.resolveInboundRoute(msg)
      void this.enqueueChain(route.chainKey, () => this.handleMessage(msg, route))
    })
    // M7增量3·决策31：启动扫账——上一进程崩溃时未落定的收录消息在此续跑（永不沉默）
    void this.resumeStartupPendingRounds()
  }

  /**
   * M0.4a 入向路由解析（入链前一次解密取目标；handleMessage 内会再解密一次——
   * secretbox 开销可忽略，链式路径既有先例）。只有 chat.user 需要会话链：
   * - 显式 sessionId（≠'new'）→ 该会话链，resolvedTarget 同值（无需 seen 就绪——
   *   seen 只是快速路径去重前置，与链键无关；启动窗口内的消息不得退化为全局串行）；
   * - 缺省（旧手机）→ 现读活跃一次（钉子①：与 enqueue 目标同值）；
   * - 'new' → 默认链（守卫段建会话后，注入段转投新会话链）；
   * - 其余类型（配对/未确认/解密失败）→ 默认链（不碰引擎或发生在 confirmed 之前）。
   */
  private resolveInboundRoute(msg: BoxMessage): { chainKey: string; resolvedTarget?: string } {
    if (!this.confirmed) return { chainKey: CHAIN_DEFAULT }
    const { secrets, myBox, peerBox } = this.deps
    const dec = decryptEnvelope(secrets.keyM2D, myBox, 'm2d', msg.blob)
    if (!dec.ok) return { chainKey: CHAIN_DEFAULT }
    const env = dec.envelope
    if (env.type !== 'chat.user') return { chainKey: CHAIN_DEFAULT }
    if (env.from !== peerBox || env.to !== myBox) return { chainKey: CHAIN_DEFAULT }
    const raw = typeof env.body['sessionId'] === 'string' ? env.body['sessionId'] : undefined
    if (raw !== undefined && raw !== 'new') return { chainKey: raw, resolvedTarget: raw }
    if (raw === 'new') return { chainKey: CHAIN_DEFAULT }
    const active = this.deps.getActiveSessionId?.() ?? null
    return active !== null ? { chainKey: active, resolvedTarget: active } : { chainKey: CHAIN_DEFAULT }
  }

  /**
   * approval.response / ask.response / chat.sync 快速路径：同步解密+校验全部命中则立即处理并返回 true。
   * 去重表未就绪/未配对确认/校验不过时回退链式路径（保序优先）。
   * 链式消息会在 handleMessage 里再解密一次（secretbox 开销可忽略，换取路由简单）。
   * M4e：ask.response 同路——提问挂起时轮次阻塞在链上，回答若排队进链则"提问等待自己"死锁（与审批同款）。
   * chat.sync 同路——它不碰引擎、只是幂等重推；若排在被提问/审批楔死的链后，手机重启后提问卡回不来，
   * 而解锁需要回答、回答需要卡片——循环死锁（实测击穿：挂起提问 + App 重启 → chat.sync 与 chat.user 全部排队）。
   */
  private tryFastPath(msg: BoxMessage): boolean {
    if (!this.seenLoaded || !this.confirmed) return false
    const { secrets, myBox, peerBox } = this.deps
    const dec = decryptEnvelope(secrets.keyM2D, myBox, 'm2d', msg.blob)
    if (!dec.ok) return false
    const env = dec.envelope
    if (!FAST_PATH_TYPES.has(env.type)) return false
    if (env.from !== peerBox || env.to !== myBox || !isTsFresh(env.ts, this.now)) return false
    dbg(`[relay-dbg] box#${msg.id} env.id=${env.id} type=${env.type}（快速路径）`)
    const work =
      env.type === 'approval.response'
        ? this.handleApprovalResponse(env, msg.id)
        : env.type === 'ask.response'
          ? this.handleAskResponse(env, msg.id)
          : env.type === 'mode.set'
            ? this.handleModeSet(env, msg.id)
            : env.type === 'session.attach'
              ? this.handleSessionAttach(env, msg.id)
              : env.type === 'catalog.sync'
                ? this.handleCatalogSync(env, msg.id)
                : env.type === 'history.request'
                  ? this.handleHistoryRequest(env, msg.id)
                  : env.type === 'board.sync'
                    ? this.handleBoardSync(env, msg.id)
                    : env.type === 'workplan.sync'
                      ? this.handleWorkPlanSync(env, msg.id)
                      : env.type === 'cmd.request'
                      ? this.handleCmdRequest(env, msg.id)
                      : env.type === 'cmd.sync'
                        ? this.handleCmdSync(env, msg.id)
                        : env.type === 'file.offer'
                          ? this.handleFileOffer(env, msg.id)
                          : env.type === 'file.chunk'
                            ? this.handleFileChunk(env, msg.id)
                            : env.type === 'file.abort'
                              ? this.handleFileAbort(env, msg.id)
                              : env.type === 'file.receipt'
                                ? this.handleFileReceipt(env, msg.id)
                                : env.type === 'presence.ping'
                                  ? this.handlePresencePing(env, msg.id)
                                  : this.handleSyncPing(env, msg.id)
    void work.catch((err) => this.alarm(`快速路径处理异常: ${String(err)}`))
    return true
  }

  isConfirmed(): boolean {
    return this.confirmed
  }

  getDroppedPreConfirm(): number {
    return this.droppedPreConfirm
  }

  private alarm(message: string): void {
    this.deps.onAlarm?.(message)
  }

  // ---------- 入向 ----------

  /** 入向路由上下文（M0.4a：入链时一次解析——resolvedTarget 为钉子①的一次解析值） */
  private async handleMessage(msg: BoxMessage, route?: { chainKey: string; resolvedTarget?: string }): Promise<void> {
    await this.ensureSeenLoaded()
    const { secrets, myBox, peerBox } = this.deps
    const dec = decryptEnvelope(secrets.keyM2D, myBox, 'm2d', msg.blob)
    if (!dec.ok) {
      this.alarm(`信封解密/AAD 校验失败（msg id=${msg.id}），fail-closed 不 ACK`)
      return
    }
    const env = dec.envelope
    dbg(`[relay-dbg] box#${msg.id} env.id=${env.id} type=${env.type}`)
    if (env.from !== peerBox || env.to !== myBox) {
      this.alarm(`from/to 与预期对端不符（from=${env.from}），丢弃并告警`)
      return
    }
    if (!isTsFresh(env.ts, this.now)) {
      this.alarm(`ts 偏离 ±5min，丢弃（id=${env.id}）`)
      return
    }
    if (!KNOWN_TYPES.has(env.type)) {
      await this.ack(msg.id) // 未识别 type 一律丢弃并忽略（ACK 防重投）
      return
    }

    if (env.type === 'pair.hello') {
      await this.handleHello(env, msg.id)
      return
    }
    if (env.type === 'pair.confirm') {
      await this.ack(msg.id) // 桌面侧不消费 confirm（那是手机侧的终态），直接 ACK 丢弃
      return
    }
    if (!this.confirmed) {
      // confirm 前收到非 pair 信封：ACK 丢弃 + 计数
      this.droppedPreConfirm++
      await this.ack(msg.id)
      return
    }
    if (env.type === 'approval.response') {
      await this.handleApprovalResponse(env, msg.id)
      return
    }
    if (env.type === 'ask.response') {
      await this.handleAskResponse(env, msg.id)
      return
    }
    if (env.type === 'chat.sync') {
      await this.handleSyncPing(env, msg.id)
      return
    }
    if (env.type === 'mode.set') {
      await this.handleModeSet(env, msg.id)
      return
    }
    if (env.type === 'cmd.request') {
      await this.handleCmdRequest(env, msg.id)
      return
    }
    if (env.type === 'cmd.sync') {
      await this.handleCmdSync(env, msg.id)
      return
    }
    // M6：附着订阅 / 目录对账 / 历史分页（不碰引擎；链式兜底路径——通常经快速路径处理）
    if (env.type === 'session.attach') {
      await this.handleSessionAttach(env, msg.id)
      return
    }
    if (env.type === 'catalog.sync') {
      await this.handleCatalogSync(env, msg.id)
      return
    }
    if (env.type === 'history.request') {
      await this.handleHistoryRequest(env, msg.id)
      return
    }
    if (env.type === 'board.sync') {
      await this.handleBoardSync(env, msg.id)
      return
    }
    if (env.type === 'workplan.sync') {
      await this.handleWorkPlanSync(env, msg.id)
      return
    }
    if (env.type === 'presence.ping') {
      await this.handlePresencePing(env, msg.id)
      return
    }
    // file.* 链式兜底路径（通常经快速路径处理；seen-ids 未就绪的首信封会落到这里——handler 幂等无害）
    if (env.type === 'file.offer') {
      await this.handleFileOffer(env, msg.id)
      return
    }
    if (env.type === 'file.chunk') {
      await this.handleFileChunk(env, msg.id)
      return
    }
    if (env.type === 'file.abort') {
      await this.handleFileAbort(env, msg.id)
      return
    }
    if (env.type === 'file.receipt') {
      await this.handleFileReceipt(env, msg.id)
      return
    }
    if (env.type !== 'chat.user') {
      await this.ack(msg.id)
      return
    }

    // 到达去重（M7增量3·决策30：seen-ids 是"落定集合"快速路径 + 内存标记挡轮次中的并发重投）
    if (this.dedupe.has(env.id)) {
      dbg(`[relay-dbg] env.id=${env.id} 去重命中（重复投递），ACK 丢弃`)
      await this.ack(msg.id)
      return
    }
    // 台账命中 = 消息已持久收录但轮未落定（崩溃窗口的重投）→ ACK + 幂等续跑，不重复注入
    await this.ensureLedgerLoaded()
    const ledgerHit = (this.pendingRounds ?? []).find((p) => p.envelopeId === env.id)
    if (ledgerHit) {
      dbg(`[relay-dbg] env.id=${env.id} 台账命中（收录后未落定），ACK + 续跑`)
      await this.ack(msg.id)
      await this.resumeIngestedMessage(ledgerHit, true)
      return
    }
    this.dedupe.mark(env.id) // 仅内存标记；chat.user 的 seen-ids 落盘挪到轮次落定（settle）
    const text = typeof env.body['text'] === 'string' ? env.body['text'] : ''
    const replyTo = env.id

    // M6 发言即附着+激活：body.sessionId = 发言目标会话（缺省=桌面当前会话，旧端兼容）
    const rawTarget = typeof env.body['sessionId'] === 'string' ? env.body['sessionId'] : undefined
    let targetSessionId: string | undefined = rawTarget === 'new' ? undefined : rawTarget
    // 钉子①（M0.4a）：缺省目标在入链时已一次解析（route.resolvedTarget）——链键与 enqueue
    // 目标同值，防链选择与注入目标间活跃漂移错配。只钉路由不钉附着：兼容路径维持
    // 「跟随当前会话镜像 + 轮末收编」（M6 语义），显式目标才轮前附着。
    const explicitTarget = rawTarget !== undefined && rawTarget !== 'new'
    if (rawTarget === undefined && route?.resolvedTarget !== undefined) targetSessionId = route.resolvedTarget
    if (rawTarget === 'new') {
      // M6b 'new' 分支时序（钉死）：守卫检查（ensureNewSession 内含空会话复用/startNewSession）
      // → 轮前切附着到新会话 → 注入。轮前附着是硬要求——否则出向门控会把第一轮流式挡掉
      //（"轮末收编"仅适用无 sessionId 的兼容路径）。守卫失败 → 诚实 notice，不注入
      const r = this.deps.ensureNewSession ? await this.deps.ensureNewSession() : 'busy'
      if (r !== 'ok') {
        await this.queueOut(() =>
          this.sendEvent('notice', '桌面正忙，无法新建会话', replyTo, { beat: this.beatOf(), sessionStamp: this.mirrorKey() || undefined }),
        )
        await this.ack(msg.id)
        return
      }
      const born = this.deps.getActiveSessionId?.() ?? undefined
      if (born === undefined) {
        // ensureNewSession 装配契约：返 ok 时当前会话 id 必须已诞生；缺失 = 装配错误，诚实报警
        this.alarm("'new' 分支 ensureNewSession 成功但无当前会话 id（装配契约破坏）")
        await this.ack(msg.id)
        return
      }
      // M0.4a：'new' 的守卫段（建会话）跑在默认链；注入段转投新会话链——与后续以真实 id
      // 到达的同会话消息同链串行（sendMessage running-throw 的排队语义按引擎成立）
      void this.enqueueChain(born, () => this.processChatUserRound(env, msg, text, replyTo, born, true))
      return
    }
    await this.processChatUserRound(env, msg, text, replyTo, targetSessionId, explicitTarget)
  }

  /** 守卫失败类 notice 的节拍取值（目标会话当前格——与单份共享时代行为对齐：上一轮遗留 beat） */
  private beatOf(target?: string): number {
    return this.cellFor(target ?? this.deps.getActiveSessionId?.() ?? '').beatIndex
  }

  /**
   * chat.user 的守卫后主体（M0.4a 自 handleMessage 拆出，运行在目标会话的入向链上）：
   * 活跃切换守卫 → 附件解析 → 附着切换（explicitTarget 才轮前附着；兼容路径跟随+轮末收编）
   * → 轮次格复位（0.4b 分键）→ 尾部同文检测 → enqueue（含台账两段式）→ final/notice 回执。
   * 'new' 经链转投抵达；显式/缺省解析目标随链键。
   */
  private async processChatUserRound(
    env: Envelope,
    msg: BoxMessage,
    text: string,
    replyTo: string,
    targetSessionId: string | undefined,
    explicitTarget: boolean,
  ): Promise<void> {
    const streamKey = targetSessionId ?? this.deps.getActiveSessionId?.() ?? ''
    if (targetSessionId !== undefined && targetSessionId !== (this.deps.getActiveSessionId?.() ?? null)) {
      const r = this.deps.ensureActiveSession ? await this.deps.ensureActiveSession(targetSessionId) : 'notfound'
      if (r !== 'ok') {
        // 守卫拒绝（引擎忙/有后台任务/会话不存在）：诚实回 notice，不注入、不假消息
        //（回答已消费不可重试：已标记 + ACK——重投只会再撞一次守卫）
        await this.queueOut(() =>
          this.sendEvent('notice', r === 'busy' ? '桌面正忙，无法切换会话' : '该会话不存在或已被桌面删除', replyTo, { beat: this.beatOf(targetSessionId), sessionStamp: streamKey || undefined }),
        )
        await this.ack(msg.id)
        return
      }
    }
    // file.* 协议族：附件解析（guard 段——缺失/未装配/畸形一律守卫拒绝类：notice + ACK，不进注入路径）
    const attachments = parseChatUserAttachments(env.body)
    let refText = ''
    let contentParts: ContentPart[] | undefined
    let attachmentRefs: MessageAttachmentRef[] | undefined
    if (attachments === null) {
      await this.queueOut(() =>
        this.sendEvent('notice', '附件声明非法（≤5 个，须为已完成传输）', replyTo, { beat: this.beatOf(targetSessionId), sessionStamp: streamKey || undefined }),
      )
      await this.ack(msg.id)
      return
    }
    if (attachments.length > 0) {
      if (!this.deps.resolveAttachments) {
        await this.queueOut(() =>
          this.sendEvent('notice', '桌面未装配文件接收能力，请升级桌面端', replyTo, { beat: this.beatOf(targetSessionId), sessionStamp: streamKey || undefined }),
        )
        await this.ack(msg.id)
        return
      }
      sweepTransfers(this.fileStore, this.now())
      const settledList = []
      for (const a of attachments) {
        const s = getSettled(this.fileStore, a.fileId)
        if (!s) {
          await this.queueOut(() =>
            this.sendEvent('notice', '附件未到齐或已失效（30 分钟内完成才可发送），请重新上传', replyTo, { beat: this.beatOf(targetSessionId), sessionStamp: streamKey || undefined }),
          )
          await this.ack(msg.id)
          return
        }
        settledList.push(s)
      }
      const resolved = await this.deps.resolveAttachments(settledList)
      refText = resolved.refText
      // 文本块前置（buildContentParts 同序：text 在前、媒体块随后）——buildUserMessage 以 contentParts 为完整内容
      contentParts = resolved.contentParts
      attachmentRefs = resolved.attachmentRefs
    }
    const mergedText = refText ? `${text}\n\n${refText}` : text
    if (contentParts?.length && mergedText.trim()) {
      contentParts = [{ type: 'text', text: mergedText }, ...contentParts]
    }
    if (explicitTarget && targetSessionId !== undefined) {
      // 发言即附着（显式目标）：附着先切到目标会话（变更才确认；同会话重发言不重复确认）
      this.followActiveSession = false
      this.applyAttachment(targetSessionId, false)
    } else if (targetSessionId === undefined) {
      // 旧端缺省发言且入链时无活跃：跟随桌面当前会话镜像（轮次落定后在 finally 收编为正式附着）
      this.followActiveSession = true
    } else {
      // 钉子①解析的缺省目标：路由已钉（链键=enqueue 目标），附着语义维持兼容路径
      //（跟随镜像 + 轮末收编）——不改 M6 行为
      this.followActiveSession = true
    }

    dbg(`[relay-dbg] chat.user env.id=${env.id} 注入引擎: ${JSON.stringify(text.slice(0, 50))}`)
    // 0.4b：轮次格复位只作用于目标会话的格子（并发轮次互不覆写）
    const cell = this.cellFor(streamKey)
    cell.deltaReplyTo = replyTo // delta 与 final 同锚：手机端才能把 final 替换流式卡而非追加
    cell.deltaClosed = false
    cell.beatIndex = 0 // M4b：新一轮，节拍归零
    cell.reasoningByBeat.clear() // M4f：新一轮，节拍累积与快照记录归零
    cell.reasoningSnapSent.clear()
    cell.eventSeq = 0 // M4b：新一轮，流式序号归零
    // M7增量3·决策30：重投的尾部同文检测（收录后、台账写前崩溃的极小窗口）——消息已在盘：
    // 不重复 append，补台账 + ACK 后走恢复路径续跑。file.*：判据多模态（合并文本 + attachmentRefs）
    if (targetSessionId !== undefined) {
      const tail = (await this.deps.peekSessionTail?.(targetSessionId)) ?? null
      if (tailMatchesMessage(tail, mergedText, attachmentRefs)) {
        dbg(`[relay-dbg] env.id=${env.id} 尾部同文命中（消息已在盘），走恢复路径`)
        const entry: PendingRoundEntry = {
          envelopeId: env.id,
          sessionId: targetSessionId,
          text: mergedText,
          replyTo,
          createdAt: new Date().toISOString(),
          ...(attachments.length > 0 ? { attachments } : {}),
        }
        try {
          await this.addLedgerEntry(entry)
          await this.ack(msg.id)
        } catch (ledgerErr) {
          this.alarm(`投递台账写入失败（不 ACK，下次重投收敛）：${String(ledgerErr)}`)
          return
        }
        await this.resumeIngestedMessage(entry, true)
        return
      }
    }
    let ingested = false
    try {
      // M6：流式镜像由引擎被动广播（TURN_STREAM_CHUNK → wiring → pushStreamChunk）统一供给，
      // onDelta 不再直推（防与广播双源重复）；final 仍由本路径按 enqueue 结果落定。
      // M7增量3·决策30：onIngested = 用户消息已持久化、轮次开始前 → 写台账 + ACK（投递与处理解耦：
      // 此后轮次无论成败，去重标记永不撤销；台账写失败则不 ACK——安全不对称，宁可重投不无台账 ACK）
      const result = await this.deps.enqueue(
        {
          text: mergedText,
          // M0.1′：注入目标会话随输入直传（壳侧注册表宿主按 id 直寻引擎；旧装配忽略回退）
          sessionId: targetSessionId ?? this.deps.getActiveSessionId?.() ?? undefined,
          ...(contentParts ? { contentParts } : {}),
          ...(attachmentRefs ? { attachmentRefs } : {}),
          clientId: env.id,
        },
        {
          onIngested: async () => {
            ingested = true // 引擎契约：回调触发 = 用户消息已在盘上
            // 0.4b 边缘愈合：缺省目标轮次的会话 id 此刻才诞生——'' 格迁移到真实 id 格，
            // 后续 chunk（带真实 id）命中同格（迁移先于首个 chunk：流在收录后才开始）
            if (streamKey === '') {
              const realId = this.deps.getActiveSessionId?.()
              if (realId) this.migrateStreamCell('', realId)
            }
            try {
              await this.addLedgerEntry({
                envelopeId: env.id,
                sessionId: targetSessionId ?? this.deps.getActiveSessionId?.() ?? '',
                text: mergedText,
                replyTo,
                createdAt: new Date().toISOString(),
                ...(attachments.length > 0 ? { attachments } : {}),
              })
              await this.ack(msg.id)
            } catch (ledgerErr) {
              this.alarm(`投递台账写入失败（不 ACK，重投时经尾部同文检测收敛）：${String(ledgerErr)}`)
            }
          },
        },
      )
      if (ingested) {
        // 轮次落定：清账 + envelope 落 seen-ids（去重自此成为持久快速路径）
        await this.removeLedgerEntry(env.id)
        void this.persistSeen()
      } else {
        // deny：未收录即消费（不写台账不落 seen；内存标记挡住并发重投）
        await this.ack(msg.id)
      }
      // 0.4b：落定冲刷只作用于本会话的格子（B 流式中 A 落定不再打掉 B 的锚）
      await this.flushDeltaNow(cell) // 先冲刷聚合 delta，再发 final（保序）
      await this.flushReasoningNow(cell) // 思维链同锚保序（随轮次落定冲刷）
      await this.pushReasoningSnapshotNow(cell, cell.beatIndex) // M4f：末节拍思考关闭全文快照（保序在 final 前）
      const finalBeat = cell.beatIndex // final/notice 在调用时刻捕获（轮次收尾产生，即当前 beat）
      if (result.deniedReason !== undefined) {
        await this.queueOut(() => this.sendEvent('notice', `消息被拦截：${result.deniedReason}`, replyTo, { beat: finalBeat, sessionStamp: cell.sessionId }))
      } else {
        await this.queueOut(() => this.sendEvent('final', result.content || '（无文本回复）', replyTo, { beat: finalBeat, sessionStamp: cell.sessionId }))
      }
      cell.deltaClosed = true // 终态已发，后续迟到 delta 一律丢弃
    } catch (err) {
      if (!ingested) {
        // pre-persist 失败（引擎 throw / 消息持久化失败）：什么都没落盘 → 撤内存标记 + 不 ACK 等重投（at-least-once）
        this.dedupe.delete(env.id)
        this.alarm(`手机消息注入引擎失败（msg id=${msg.id} 未 ACK 将重投）: ${String(err)}`)
      } else {
        // 收录后轮次失败：roundFailure 留痕已由引擎入史 → 清账 + 落 seen + 手机失败回执（永不沉默）
        await this.removeLedgerEntry(env.id)
        void this.persistSeen()
        this.alarm(`手机消息轮次失败（已收录，回执失败通知）：${String(err)}`)
        await this.queueOut(() =>
          this.sendEvent('notice', `本轮处理失败：${err instanceof Error ? err.message : String(err)}`, replyTo, { beat: cell.beatIndex, sessionStamp: cell.sessionId }),
        )
        cell.deltaClosed = true
      }
    } finally {
      // M6 兼容路径收编：跟随当前会话的轮次落定后，附着正式落到该会话并确认（手机对账以桌面为准）
      if (this.followActiveSession) {
        this.followActiveSession = false
        const settled = this.deps.getActiveSessionId?.() ?? null
        if (settled !== null) this.applyAttachment(settled, false)
      }
    }
  }

  // ---------- M6 入向：附着订阅 / 目录对账 / 历史分页 ----------

  /**
   * 附着变更（session.attach = 订阅，不动桌面状态）。请求-确认制：每次请求都回
   * attached.changed（含附着未变的重 announce——手机未收到确认前显示"同步中"，不假落定）。
   * 切换附着前冲刷**离开会话**的滞留聚合格（0.4b 分键语义——防上一附着会话的内容串到新会话锚下；
   * 新附着会话自己的格子若有滞留继续按自身 timer/settle 冲刷，不受影响）。
   */
  private applyAttachment(target: string | null, alwaysConfirm: boolean): void {
    const changed = this.attachedSessionId !== target
    if (changed) {
      const leaving = this.attachedSessionId
      if (leaving !== null) {
        this.flushDelta(this.cellFor(leaving))
        this.flushReasoning(this.cellFor(leaving))
      }
      this.attachedSessionId = target
      // F-2：附着变更通告（serve 单操作者宿主接成 attach 即激活；发言路径幂等无害）
      this.deps.onSessionAttached?.(target)
    }
    if (changed || alwaysConfirm) {
      this.pushSessionEvent({ kind: 'attached.changed', sessionId: this.attachedSessionId })
    }
  }

  private async handleSessionAttach(env: Envelope, msgId: number): Promise<void> {
    const sid = env.body['sessionId']
    this.applyAttachment(typeof sid === 'string' ? sid : null, true)
    await this.ack(msgId)
  }

  /** catalog.sync 应答（不主动推：等手机上报已知版本后按 diff 应答——空/异常全量，常态增量） */
  private async handleCatalogSync(env: Envelope, msgId: number): Promise<void> {
    await this.ack(msgId)
    if (!this.deps.buildCatalogState) return
    try {
      const known = (typeof env.body === 'object' && env.body !== null ? env.body : {}) as CatalogSyncBody
      const state = await this.deps.buildCatalogState(known)
      await this.sendCatalogState(state, env.id)
    } catch (err) {
      this.alarm(`catalog.sync 应答失败（手机将在下次重连重试）: ${String(err)}`)
    }
  }

  /** history.request 应答：游标分页（页 ≤ min(20条,~32KB)，单页必在 45KB 明文预算内，无需分片） */
  private async handleHistoryRequest(env: Envelope, msgId: number): Promise<void> {
    const sessionId = typeof env.body['sessionId'] === 'string' ? env.body['sessionId'] : ''
    const before = typeof env.body['before'] === 'string' ? env.body['before'] : undefined
    const limit = typeof env.body['limit'] === 'number' ? env.body['limit'] : undefined
    if (sessionId && this.deps.pageHistory) {
      try {
        const page = await this.deps.pageHistory(sessionId, before, limit)
        // M1.2 入队闸：退避期延迟入队（history 页不折叠——分页保序；撞 429 走 M1.1 可再生即弃，手机重问兜底）。
        // ACK 先行（请求已收录）——应答投递是 d→m 方向，自有重试/重问语义。
        this.deferOrSend(null, () => {
          void this.queueOut(() =>
            this.sendEnvelope(
              makeEnvelope('history.page', this.deps.myBox, this.deps.peerBox, page as unknown as Record<string, unknown>, env.id, this.now),
            ),
          ).catch((err) => this.alarm(`history.request 应答失败（sessionId=${sessionId}）: ${String(err)}`))
        })
      } catch (err) {
        this.alarm(`history.request 应答失败（sessionId=${sessionId}）: ${String(err)}`)
      }
    }
    await this.ack(msgId)
  }

  /**
   * catalog.state 发送入口（M1.2 入队闸）：退避期延迟（键 'catalog'——同键折叠=最新目录组获胜，rev 对账天然收敛）；
   * 组内任一分片撞 429 即弃（M1.1 可再生）→ 异常中断分片循环=**整组作废**（防缺片半组悬挂到下次重连），
   * 手机下次 resync 整组重取。单封 ≤ 45KB 明文预算直接发；超预算按 sessions 贪心分包
   *（chunk 0 携带 projects/deletes/activeSessionId/projectsRev/full，其余 chunk 仅 sessions 切片；
   *  同 replyTo 归组；经出向 FIFO 串行——下一封等上一封往返完成，信箱不瞬时堆积）。
   */
  private sendCatalogState(state: CatalogStateBody, replyTo?: string): void {
    this.deferOrSend('catalog', () => {
      void this.sendCatalogStateNow(state, replyTo).catch((err) =>
        this.alarm(`catalog.state 投递失败（手机将在下次重连重试）: ${String(err)}`),
      )
    })
  }

  private async sendCatalogStateNow(state: CatalogStateBody, replyTo?: string): Promise<void> {
    const body = state as unknown as Record<string, unknown>
    if (byteLen(JSON.stringify(body)) <= PLAINTEXT_BUDGET_BYTES) {
      await this.queueOut(() =>
        this.sendEnvelope(makeEnvelope('catalog.state', this.deps.myBox, this.deps.peerBox, body, replyTo, this.now)),
      )
      return
    }
    // 分包基准开销：无 sessions 的 chunk 0 骨架 + 信封外壳余量
    const skeleton = { ...state, sessions: [] as CatalogSessionMeta[] }
    const baseBytes = byteLen(JSON.stringify(skeleton)) + 1024
    const chunks: CatalogSessionMeta[][] = []
    let current: CatalogSessionMeta[] = []
    let currentBytes = baseBytes
    for (const s of state.sessions) {
      const entryBytes = byteLen(JSON.stringify(s)) + 1
      if (current.length > 0 && currentBytes + entryBytes > PLAINTEXT_BUDGET_BYTES) {
        chunks.push(current)
        current = []
        currentBytes = 512 // 后续 chunk 骨架（仅 sessions + chunk/chunks 等标量）
      }
      current.push(s)
      currentBytes += entryBytes
    }
    if (current.length > 0 || chunks.length === 0) chunks.push(current)
    const total = chunks.length
    for (let i = 0; i < total; i++) {
      const chunkBody: CatalogStateBody =
        i === 0
          ? { ...state, sessions: chunks[0]!, chunk: 0, chunks: total }
          : {
              projects: [],
              sessions: chunks[i]!,
              activeSessionId: state.activeSessionId,
              projectsRev: state.projectsRev,
              full: state.full,
              chunk: i,
              chunks: total,
            }
      await this.queueOut(() =>
        this.sendEnvelope(
          makeEnvelope('catalog.state', this.deps.myBox, this.deps.peerBox, chunkBody as unknown as Record<string, unknown>, replyTo, this.now),
        ),
      )
    }
  }

  // ---------- M6 出向：session.event（目录/元数据增量 + 附着确认 + 历史失效；一律不携带正文） ----------

  /**
   * M7 入向：board.sync 应答（不碰引擎，走快速路径）。
   * rev 对账：手机 rev 落后/未知 → buildBoardState 回 full=true 全量；已一致 → full=false 纯确认。
   */
  private async handleBoardSync(env: Envelope, msgId: number): Promise<void> {
    await this.ack(msgId)
    if (!this.deps.buildBoardState) return
    const body = (typeof env.body === 'object' && env.body !== null ? env.body : {}) as unknown as BoardSyncBody
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (!sessionId) return
    const knownRev = typeof body.rev === 'string' || typeof body.rev === 'number' ? body.rev : undefined
    this.queueBoardState(() => this.deps.buildBoardState!(sessionId, knownRev), env.id, `board.sync 应答失败（sessionId=${sessionId}）`)
  }

  /**
   * board.state 组包+发送的串行入口（build 与分片发送整体排队：保序 + 分片不与后续推送交错）。
   * 实际投递仍经 sendBoardState → queueOut FIFO——本链只串"组包→入队"序列，不包 queueOut（防自等死锁）。
   * M1.2 入队闸：退避期延迟入链（键 'board'——rev 快照折叠为最新一份，latest-wins 本就是 board 语义）。
   */
  private queueBoardState(build: () => Promise<BoardStateBody>, replyTo?: string, errLabel = 'board.state 投递失败'): void {
    this.deferOrSend('board', () => {
      this.boardSendChain = this.boardSendChain
        .then(async () => {
          const state = await build()
          await this.sendBoardState(state, replyTo)
        })
        .catch((err) => this.alarm(`${errLabel}: ${String(err)}`))
    })
  }

  /**
   * board.state 发送：单封 ≤ 45KB 明文预算直接发；超预算按 rows 贪心分包
   *（chunk 0 携带 strip/needsYou/windowed/full/rev/sessionId 与首批 rows，其余 chunk 仅 rows 切片；
   *  同 replyTo 归组；经出向 FIFO 串行——抄 catalog.state 分片先例）。
   */
  private async sendBoardState(state: BoardStateBody, replyTo?: string): Promise<void> {
    const body = state as unknown as Record<string, unknown>
    if (byteLen(JSON.stringify(body)) <= PLAINTEXT_BUDGET_BYTES) {
      await this.queueOut(() =>
        this.sendEnvelope(makeEnvelope('board.state', this.deps.myBox, this.deps.peerBox, body, replyTo, this.now)),
      )
      return
    }
    // 分包基准开销：无 rows 的 chunk 0 骨架 + 信封外壳余量
    const skeleton = { ...state, rows: [] as BoardRowWire[] }
    const baseBytes = byteLen(JSON.stringify(skeleton)) + 1024
    const chunks: BoardRowWire[][] = []
    let current: BoardRowWire[] = []
    let currentBytes = baseBytes
    for (const row of state.rows) {
      const entryBytes = byteLen(JSON.stringify(row)) + 1
      if (current.length > 0 && currentBytes + entryBytes > PLAINTEXT_BUDGET_BYTES) {
        chunks.push(current)
        current = []
        currentBytes = 512 // 后续 chunk 骨架（仅 rows + chunk/chunks 等标量）
      }
      current.push(row)
      currentBytes += entryBytes
    }
    if (current.length > 0 || chunks.length === 0) chunks.push(current)
    const total = chunks.length
    for (let i = 0; i < total; i++) {
      const chunkBody: BoardStateBody =
        i === 0
          ? { ...state, rows: chunks[0]!, chunk: 0, chunks: total }
          : {
              sessionId: state.sessionId,
              rev: state.rev,
              rows: chunks[i]!,
              strip: state.strip,
              needsYou: state.needsYou,
              windowed: state.windowed,
              full: state.full,
              chunk: i,
              chunks: total,
            }
      await this.queueOut(() =>
        this.sendEnvelope(
          makeEnvelope('board.state', this.deps.myBox, this.deps.peerBox, chunkBody as unknown as Record<string, unknown>, replyTo, this.now),
        ),
      )
    }
  }

  /**
   * M7 出向：看板变更即推（confirmed 门控；boardSendChain 串行保序）。
   * 附着门控（决策 15）：只推附着会话的板——手机声明"我在看会话 X"才关心 X 的看板，非附着会话不推。
   */
  pushBoardState(sessionId: string): void {
    if (!this.confirmed || !sessionId) return
    if (!this.isMirrorSession(sessionId)) {
      return
    }
    if (!this.deps.buildBoardState) return
    this.queueBoardState(() => this.deps.buildBoardState!(sessionId))
  }

  /** M7 重连再同步：看板是快照真相，补推附着会话当前板即收敛（latest-wins，无需历史） */
  resyncBoard(): void {
    if (!this.confirmed) return
    const sid =
      this.attachedSessionId ?? (this.followActiveSession ? (this.deps.getActiveSessionId?.() ?? null) : null)
    if (!sid) return
    this.pushBoardState(sid)
  }

  // ---------- 工作计划树出向（workplan.state；照 board.state 逐行先例——串行链/分片骨架/附着门控/resync） ----------

  /**
   * workplan.sync 应答（不碰引擎，走快速路径）。
   * rev 对账：手机 rev 落后/未知/缺省 → buildWorkPlanState 回 full=true 全量树；已一致 → full=false 纯确认。
   */
  private async handleWorkPlanSync(env: Envelope, msgId: number): Promise<void> {
    await this.ack(msgId)
    if (!this.deps.buildWorkPlanState) return
    const body = (typeof env.body === 'object' && env.body !== null ? env.body : {}) as unknown as WorkPlanSyncBody
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (!sessionId) return
    const knownRev = typeof body.rev === 'string' || typeof body.rev === 'number' ? body.rev : body.rev === null ? null : undefined
    this.queueWorkPlanState(() => this.deps.buildWorkPlanState!(sessionId, knownRev), env.id, `workplan.sync 应答失败（sessionId=${sessionId}）`)
  }

  /** workplan.state 组包+发送的串行入口（语义同 queueBoardState：只串"组包→入队"序列，不包 queueOut 防自等死锁；
   *  M1.2 入队闸：退避期延迟入链，键 'workplan'——rev 快照折叠为最新一份） */
  private queueWorkPlanState(build: () => Promise<WorkPlanStateBody>, replyTo?: string, errLabel = 'workplan.state 投递失败'): void {
    this.deferOrSend('workplan', () => {
      this.workPlanSendChain = this.workPlanSendChain
        .then(async () => {
          const state = await build()
          await this.sendWorkPlanState(state, replyTo)
        })
        .catch((err) => this.alarm(`${errLabel}: ${String(err)}`))
    })
  }

  /**
   * workplan.state 发送：单封 ≤ 45KB 明文预算直接发；超预算按 items 贪心分包（骨架照 sendBoardState——
   * 本期清单体量小基本不会触发，骨架就位防退化；chunk 0 携带全标量与首批 items，其余 chunk 仅 items 切片）。
   */
  private async sendWorkPlanState(state: WorkPlanStateBody, replyTo?: string): Promise<void> {
    const body = state as unknown as Record<string, unknown>
    if (byteLen(JSON.stringify(body)) <= PLAINTEXT_BUDGET_BYTES) {
      await this.queueOut(() =>
        this.sendEnvelope(makeEnvelope('workplan.state', this.deps.myBox, this.deps.peerBox, body, replyTo, this.now)),
      )
      return
    }
    const skeleton = { ...state, items: [] as WorkPlanItemWire[] }
    const baseBytes = byteLen(JSON.stringify(skeleton)) + 1024
    const chunks: WorkPlanItemWire[][] = []
    let current: WorkPlanItemWire[] = []
    let currentBytes = baseBytes
    for (const item of state.items) {
      const entryBytes = byteLen(JSON.stringify(item)) + 1
      if (current.length > 0 && currentBytes + entryBytes > PLAINTEXT_BUDGET_BYTES) {
        chunks.push(current)
        current = []
        currentBytes = 512
      }
      current.push(item)
      currentBytes += entryBytes
    }
    if (current.length > 0 || chunks.length === 0) chunks.push(current)
    const total = chunks.length
    for (let i = 0; i < total; i++) {
      const chunkBody: WorkPlanStateBody =
        i === 0
          ? { ...state, items: chunks[0]!, chunk: 0, chunks: total }
          : { sessionId: state.sessionId, rev: state.rev, full: state.full, items: chunks[i]!, chunk: i, chunks: total }
      await this.queueOut(() =>
        this.sendEnvelope(
          makeEnvelope('workplan.state', this.deps.myBox, this.deps.peerBox, chunkBody as unknown as Record<string, unknown>, replyTo, this.now),
        ),
      )
    }
  }

  /**
   * 工作计划树变更即推（confirmed 门控；workPlanSendChain 串行保序）。
   * 附着门控（同 board 决策 15）：只推手机附着会话的工作计划树，非附着会话不推。
   */
  pushWorkPlanState(sessionId: string): void {
    if (!this.confirmed || !sessionId) return
    if (!this.isMirrorSession(sessionId)) {
      return
    }
    if (!this.deps.buildWorkPlanState) return
    this.queueWorkPlanState(() => this.deps.buildWorkPlanState!(sessionId))
  }

  /** 重连再同步（照 resyncBoard 先例）：工作计划树是快照真相，补推附着会话当前树即收敛（latest-wins，无需历史） */
  resyncWorkPlan(): void {
    if (!this.confirmed) return
    const sid =
      this.attachedSessionId ?? (this.followActiveSession ? (this.deps.getActiveSessionId?.() ?? null) : null)
    if (!sid) return
    this.pushWorkPlanState(sid)
  }

  // ---------- M6 出向：session.event（目录/元数据增量 + 附着确认 + 历史失效；一律不携带正文） ----------

  /** session.event 推送（confirmed 门控；queueOut FIFO 保序） */
  pushSessionEvent(body: SessionEventBody): void {
    if (!this.confirmed) return
    this.queueOut(() =>
      this.sendEnvelope(makeEnvelope('session.event', this.deps.myBox, this.deps.peerBox, body as unknown as Record<string, unknown>)),
    ).catch((err) => this.alarm(`session.event(${body.kind}) 投递失败: ${String(err)}`))
  }

  /**
   * M6c 轮次落定通告（引擎 TURN_SETTLED → 本方法）：附着会话的轮真正结束时推 round.settled——
   * 手机据此做且仅在此刻做尾部拉齐（轮中的"最新页"是移动目标，拉回正在流式的内容只会造成
   * DB 副本与 overlay 双份渲染——用户实测击穿）；本地镜像轮无 final，此信号同时是该轮在手机侧
   * 收口（锚点闭合）的唯一通路。非附着会话不发（手机不关心）。
   * 推 settle 前先冲刷聚合 delta/思维链（对齐 final 路径的保序）：尾批经 200ms 定时冲刷几乎总在
   * TURN_SETTLED 之后才出栈，迟到 delta 会把手机侧活轮记账重新点亮、把那一次唯一的尾拉永久跳过
   * （实测：总结/占位改写双双到不了手机）。冲刷失败不得吞掉 settle——它是尾拉的唯一触发。
   */
  /**
   * M6 镜像轮次落定出向：门控后冲刷**该会话**的聚合格再推 round.settled。
   * 0.4b：冲刷作用于事件归属会话自己的格子（并发轮次下他会的落定不再触碰本会话缓冲）。
   */
  async pushRoundSettled(sessionId: string): Promise<void> {
    if (!this.confirmed || sessionId.length === 0) return
    if (!this.isMirrorSession(sessionId)) return
    const cell = this.cellFor(sessionId)
    await this.flushDeltaNow(cell).catch(() => {})
    await this.flushReasoningNow(cell).catch(() => {})
    this.pushSessionEvent({ kind: 'round.settled', sessionId })
  }

  /**
   * 运行态转换推送（运行态标志，2026-10-04）：引擎 TURN_STARTED/TURN_SETTLED → 本方法。
   * **不做镜像门控**——与 pushRoundSettled 的关键差异：后台会话的运行态正是本功能的意义所在
   * （round.settled 的附着语义管尾拉，本方法管列表观察，互不干扰）。
   * runningAll 全量快照随行（生产时刻现取——与 F-1 归属戳同纪律）：任一转换到达手机即全量自愈，
   * 根治"最后一帧丢失→转圈不灭"的逐会话独立残余风险。空 sessionId 防御性 no-op（同 settle 先例）。
   */
  pushRunningChanged(sessionId: string, running: boolean): void {
    if (!this.confirmed || sessionId.length === 0) return
    const runningAll = this.deps.getRunningSessionIds?.()
    this.pushSessionEvent({
      kind: 'running.changed',
      sessionId,
      running,
      ...(runningAll ? { runningAll } : {}),
    })
  }

  /**
   * 运行态纯快照推送（仅 runningAll，无单会话增量）：宿主 5min 周期重申用——
   * 根治"连接中最后一帧丢失且此后无任何转换"的无限期残留错态（持续 429 风暴实测场景）。
   * 手机侧 runningAll 在场即整替，集合无变化不触发 UI 事件。
   */
  pushRunningSnapshot(): void {
    if (!this.confirmed) return
    const runningAll = this.deps.getRunningSessionIds?.()
    if (!runningAll) return
    this.pushSessionEvent({ kind: 'running.changed', runningAll })
  }

  /**
   * owner 易主/桥重建通告：附着归零并推 attached.changed(null)——每实例至多一次
   *（手机对账规则：收到与本地认知不符的 attached.changed 以桌面为准并按 syncState 重 announce；
   *  重连不重复推，防与手机热重连的重 announce 对打）。壳侧在传输每次连接成功后调用。
   */
  announceAttachReset(): void {
    if (this.attachResetAnnounced || !this.confirmed) return
    this.attachResetAnnounced = true
    this.attachedSessionId = null
    this.followActiveSession = false
    this.pushSessionEvent({ kind: 'attached.changed', sessionId: null })
  }

  /** M6 附着状态读取（测试/wiring 观测用） */
  getAttachedSessionId(): string | null {
    return this.attachedSessionId
  }

  /**
   * M4 入向：手机审批回答 → deps.resolveApproval 落定。
   * 回答已消费不可重试（与 chat.user 的注入失败重投不同）：到达即标记 + 总是 ACK。
   * resolve 返 false（已定落/不存在/进程重启后挂起蒸发）→ 回发 cancelled 终态：
   * 用户点了失效审批必须得到"该审批已失效"反馈，僵尸审批卡构造上不可能。
   */
  private async handleApprovalResponse(env: Envelope, msgId: number): Promise<void> {
    if (this.dedupe.has(env.id)) {
      await this.ack(msgId)
      return
    }
    this.markAndPersist(env.id)
    const id = typeof env.body['id'] === 'string' ? env.body['id'] : ''
    const decision = env.body['decision'] === 'approve' ? ('approve' as const) : ('reject' as const)
    // allowSession additive 透传（手机「本次会话放行」）：仅 approve 时有效——拒绝附带放行无意义，门掉
    const allowSession = decision === 'approve' && env.body['allowSession'] === true
    const ok = id.length > 0 && this.deps.resolveApproval(id, decision, allowSession ? { allowSession: true } : undefined)
    if (!ok && id.length > 0 && !this.resolvedPushed.has(id)) {
      this.markResolvedPushed(id)
      this.queueOut(() => this.sendApprovalResolvedEnvelope(id, false, 'cancelled')).catch((err) =>
        this.alarm(`approval.resolved(cancelled) 投递失败: ${String(err)}`),
      )
    }
    await this.ack(msgId)
  }

  /**
   * M4e 订阅信号（chat.sync，手机连接建立后发）：ACK + 未决审批/提问从真相源重推。
   * 幂等（重推即收敛），无需去重；不碰引擎——可走快速路径（见 tryFastPath 注）。
   */
  private async handleSyncPing(_env: Envelope, msgId: number): Promise<void> {
    await this.ack(msgId)
    this.resyncPendingApprovals()
    this.resyncPendingAsks()
    this.resyncModeState()
    this.resyncBoard()
    this.resyncWorkPlan() // 工作计划树：同点补推附着会话树快照（latest-wins 收敛）
    this.resyncCommandState() // M8：同点补推命令面状态（手机只发 chat.sync 的旧路径也收敛）
  }

  /**
   * M5 入向：手机权限模式请求 → deps.setPermissionMode（装配方校验+写真相源）。
   * 写成功后由 executor 事件 → wirePermissionMode → pushModeState 回流落定（手机徽标的唯一落定触发）。
   * 非法值/无装配（返 false）→ 回推当前 mode.state 终态：手机的错误视图经此愈合，绝不沉默。
   */
  private async handleModeSet(env: Envelope, msgId: number): Promise<void> {
    if (this.dedupe.has(env.id)) {
      await this.ack(msgId)
      return
    }
    this.markAndPersist(env.id)
    const mode = typeof env.body['mode'] === 'string' ? env.body['mode'] : ''
    const ok = this.deps.setPermissionMode?.(mode, 'phone') ?? false
    if (!ok) this.resyncModeState() // fail-closed：回推当前真相，手机徽标收敛
    await this.ack(msgId)
  }

  /**
   * M6c 入向：桌面在线探活应答（手机前台周期 presence.ping → 立即回 presence.pong）。
   * 手机侧"收到任何桌面来信 = 在线"——pong 的职责是空闲期的保活证据；本方法不碰引擎、走快速路径。
   * additive caps：读取 body.caps 存入 lastPeerCaps（内存态即可——离线手机信箱暂存 offer，
   * 无需持久 caps；未见过 caps 时诚实报错），d→m 文件发送的能力门数据源。
   */
  private async handlePresencePing(env: Envelope, msgId: number): Promise<void> {
    if (this.dedupe.has(env.id)) {
      await this.ack(msgId)
      return
    }
    this.markAndPersist(env.id)
    const caps = env.body['caps']
    this.lastPeerCaps = new Set(Array.isArray(caps) ? caps.filter((c): c is string => typeof c === 'string') : [])
    await this.ack(msgId)
    this.queueOut(() => this.sendEnvelope(makeEnvelope('presence.pong', this.deps.myBox, this.deps.peerBox, {}))).catch((err) =>
      this.alarm(`presence.pong 投递失败: ${String(err)}`),
    )
  }

  /** 最近一次 presence.ping 上报的手机能力集（null = 本桥实例从未见过手机 ping） */
  private lastPeerCaps: Set<string> | null = null

  /** d→m 文件发送能力门：手机声明过 file-recv 能力才放行（能力未知 → 诚实报错而非盲发） */
  peerCanRecvFile(): boolean {
    return this.lastPeerCaps?.has(CAP_FILE_RECV) ?? false
  }

  /** M5 出向：权限模式广播（confirmed 门控；queueOut FIFO 保序） */
  pushModeState(mode: string): void {    if (!this.confirmed) return
    this.queueOut(() => this.sendEnvelope(makeEnvelope('mode.state', this.deps.myBox, this.deps.peerBox, { mode }))).catch((err) =>
      this.alarm(`mode.state 投递失败: ${String(err)}`),
    )
  }

  /** M5 重连再同步：权限模式是标量真相，补推当前档即收敛（latest-wins，无需历史） */
  resyncModeState(): void {
    if (!this.confirmed) return
    const mode = this.deps.getPermissionMode?.()
    if (mode) this.pushModeState(mode)
  }

  // ==================== M8 命令面（cmd.*） ====================

  /**
   * M8 入向：cmd.sync（手机连接/重连建立后请求目录+全量状态）。不碰引擎——快速路径。
   * 幂等（重发即重推 latest-wins）；应答 = cmd.state 全量（携带 catalog）。
   */
  private async handleCmdSync(_env: Envelope, msgId: number): Promise<void> {
    if (this.dedupe.has(_env.id)) {
      await this.ack(msgId)
      return
    }
    this.markAndPersist(_env.id)
    await this.ack(msgId)
    this.pushCommandState(true)
  }

  /**
   * M8 入向：cmd.request 分流器（handler 本身不碰引擎——快速路径的本质要求）。
   * 按注册表 channel 分发：fast（turn.stop/model.list/front.list）就地执行；
   * serial（改会话状态者）入串行链排队——排在运行轮后 = 轮末生效的诚实语义。
   * 每请求必回 cmd.result（成功 data / 诚实 error）；执行后 pushCommandState（三保底之一）。
   */
  private async handleCmdRequest(env: Envelope, msgId: number): Promise<void> {
    if (this.dedupe.has(env.id)) {
      await this.ack(msgId)
      return
    }
    this.markAndPersist(env.id)
    const body = env.body as Partial<CmdRequestBody>
    const reqId = typeof body.id === 'string' ? body.id : ''
    const cmd = typeof body.cmd === 'string' ? body.cmd : ''
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : undefined
    await this.ack(msgId)
    const spec = resolveCommand(cmd)
    if (!spec) {
      await this.sendCmdResult(reqId, { ok: false, error: { code: 'unsupported', message: `未知命令：${cmd}` } })
      return
    }
    // args 预检短路（纯函数，与 commandSurface.executeCommand 同一事实点）：无效命令不排队不触达执行器
    const issue = validateArgs(spec, args)
    if (issue) {
      await this.sendCmdResult(reqId, { ok: false, error: issue })
      return
    }
    if (spec.channel === 'fast') {
      const r = await this.runCmd(cmd, args)
      await this.sendCmdResult(reqId, r)
      this.pushCommandState()
      return
    }
    // serial：入**活跃会话**的链（M0.4a 钉子②——排在被运行轮占据的链后 = 轮末生效的诚实语义，
    // 且与该会话的消息天然互斥）；出队时活跃已漂移则转投新目标链（活跃语义与轮末生效两全）。
    // 结果与状态经出向链回流。
    const step = (): void => {
      const target = this.deps.getActiveSessionId?.() ?? ''
      void this.enqueueChain(target || CHAIN_DEFAULT, async () => {
        const now = this.deps.getActiveSessionId?.() ?? ''
        if ((target || CHAIN_DEFAULT) !== (now || CHAIN_DEFAULT)) {
          step() // 排队期间活跃漂移 → 转投新目标链（有界：仅活跃变更时发生）
          return
        }
        const r = await this.runCmd(cmd, args)
        await this.sendCmdResult(reqId, r)
        this.pushCommandState()
      })
    }
    step()
  }

  /** 命令执行（未装配 executeCmd = M1 dormant/只观测宿主 → 诚实 unsupported） */
  private async runCmd(cmd: string, args?: Record<string, unknown>): Promise<CommandExecutorResult> {
    if (!this.deps.executeCmd) return { ok: false, error: { code: 'unsupported', message: '命令通道未装配' } }
    return this.deps.executeCmd(cmd, args)
  }

  /** M8 出向：命令应答（queueOut FIFO 保序；无 replyTo 锚不应答——防孤儿信封） */
  private async sendCmdResult(replyTo: string, r: CommandExecutorResult): Promise<void> {
    if (!this.confirmed || !replyTo) return
    const body: CmdResultBody = r.ok
      ? { replyTo, ok: true, ...(r.data ? { data: r.data } : {}) }
      : { replyTo, ok: false, error: r.error }
    this.queueOut(() =>
      this.sendEnvelope(makeEnvelope('cmd.result', this.deps.myBox, this.deps.peerBox, body as unknown as Record<string, unknown>, replyTo)),
    ).catch((err) => this.alarm(`cmd.result 投递失败: ${String(err)}`))
  }

  /**
   * M8 出向：命令面状态广播（confirmed 门控；latest-wins；不套 M6 附着会话门控——
   * 与 mode.state 同为全局信封，描述桌面活动会话）。withCatalog=true 附目录（cmd.sync 应答）。
   * 手机落定唯一来源（不假落定）。
   */
  pushCommandState(withCatalog = false): void {
    if (!this.confirmed) return
    const state = this.deps.getCommandState?.()
    if (!state) return
    const body: CmdStateBody = withCatalog ? { state, catalog: commandCatalog() } : { state }
    this.queueOut(() =>
      this.sendEnvelope(makeEnvelope('cmd.state', this.deps.myBox, this.deps.peerBox, body as unknown as Record<string, unknown>)),
    ).catch((err) => this.alarm(`cmd.state 投递失败: ${String(err)}`))
  }

  /** M8 重连再同步：状态快照 + 目录（latest-wins 收敛，无需历史） */
  resyncCommandState(): void {
    this.pushCommandState(true)
  }

  /**
   * M4e 入向：手机提问回答 → deps.resolveAsk 落定（与审批回答同构）。
   * 回答已消费不可重试：到达即标记 + 总是 ACK。
   * resolve 返 false（已定落/不存在/进程重启后挂起蒸发）→ 回发 cancelled 终态：
   * 用户点了失效提问必须得到"该提问已失效"反馈，僵尸提问卡构造上不可能。
   */
  private async handleAskResponse(env: Envelope, msgId: number): Promise<void> {
    if (this.dedupe.has(env.id)) {
      await this.ack(msgId)
      return
    }
    this.markAndPersist(env.id)
    const id = typeof env.body['id'] === 'string' ? env.body['id'] : ''
    const answer = typeof env.body['answer'] === 'string' ? env.body['answer'] : ''
    const decisions = parseAskDecisions(env.body['decisions'])
    const ok = id.length > 0 && (this.deps.resolveAsk?.(id, answer, decisions) ?? false)
    if (!ok && id.length > 0 && !this.resolvedPushed.has(id)) {
      this.markResolvedPushed(id)
      this.queueOut(() => this.sendAskResolvedEnvelope(id, answer, 'cancelled')).catch((err) =>
        this.alarm(`ask.resolved(cancelled) 投递失败: ${String(err)}`),
      )
    }
    await this.ack(msgId)
  }

  private async handleHello(env: Envelope, msgId: number): Promise<void> {
    const { deskPub, phonePub, deviceName } = this.deps
    // 懒读优先（跨端配对场景）；无令牌则 fail-closed
    const pairingToken = (await this.deps.getPairingToken?.().catch(() => null)) ?? this.deps.pairingToken
    const device = typeof env.body['device'] === 'string' ? env.body['device'] : this.deps.peerBox
    const fingerprint = typeof env.body['fingerprint'] === 'string' ? env.body['fingerprint'] : ''
    if (!pairingToken || env.body['mac'] !== pairingMAC(pairingToken, deskPub, phonePub)) {
      this.alarm('pair.hello MAC 校验失败，fail-closed 报警（可能 MITM/伪造），禁止静默重试')
      return
    }
    if (this.dedupe.has(env.id)) {
      await this.ack(msgId)
      return
    }
    const approved = this.deps.onConfirmRequest ? await this.deps.onConfirmRequest(device, fingerprint) : false
    if (!approved) {
      // 用户未批准：ACK 丢弃防重投循环，confirmed 保持 false（后续 chat 一律丢弃+计数）
      this.markAndPersist(env.id)
      await this.ack(msgId)
      this.alarm('用户未批准配对确认，本端保持未配对态')
      return
    }
    const confirm = makeEnvelope('pair.confirm', this.deps.myBox, this.deps.peerBox, {
      device: deviceName,
      mac: pairingMAC(pairingToken!, deskPub, phonePub),
    })
    await this.sendEnvelope(confirm)
    this.markAndPersist(env.id)
    await this.ack(msgId)
    this.confirmed = true
    this.resyncPendingApprovals() // M4：确认时刻已有挂起审批则补推（confirmed 前不推，推了手机也丢弃）
    this.resyncModeState() // M5：同点补推当前权限模式档（手机徽标配对即收敛）
    this.resyncCommandState() // M8：同点补推命令面状态（占用环/会话 sheet 配对即收敛）
  }

  // ---------- M4 出向：审批双通道 + 轮次状态 + 思维链（全部经出向 FIFO 保序） ----------

  /** 审批请求推送（confirmed 门控）；构造 summary + preview 截断，timeoutAt 源头透传；
   *  origin.sessionId 归因 additive 透传（手机端按来源会话分流呈现——“徽标与过滤备料”的手机侧接通） */
  pushApprovalRequest(payload: ApprovalRequestPayload): void {
    if (!this.confirmed) return
    const body: Record<string, unknown> = {
      id: payload.toolCallId,
      kind: payload.kind,
      summary: approvalSummary(payload),
    }
    const preview = payload.diffPreview?.slice(0, 1000)
    if (preview) body['preview'] = preview
    if (payload.timeoutAt !== undefined) body['timeoutAt'] = payload.timeoutAt
    // 桌面操作审批标记（additive）：手机据此渲染「本次会话放行」第三钮（对齐 CLI [s]/桌面 UI 语义）
    if (payload.sessionGrantable === true) body['sessionGrantable'] = true
    // 位置真相 additive 携带（与 ask 同构；三路径统一经此函数）
    if (payload.requestedAt !== undefined) body['originalTs'] = payload.requestedAt
    if (payload.origin?.sessionId) body['sessionId'] = payload.origin.sessionId
    this.queueOut(async () => {
      await this.sendEnvelope(makeEnvelope('approval.request', this.deps.myBox, this.deps.peerBox, body))
    }).catch((err) => this.alarm(`approval.request 投递失败: ${String(err)}`))
  }

  /** 审批落定通告（手机卡片置灰的唯一触发）；记录已推送终态的 id（防迟到 response 的 cancelled 覆盖） */
  pushApprovalResolved(settled: { toolCallId: string; approved: boolean; by: string }): void {
    if (!this.confirmed) return
    this.markResolvedPushed(settled.toolCallId)
    this.queueOut(() => this.sendApprovalResolvedEnvelope(settled.toolCallId, settled.approved, settled.by)).catch((err) =>
      this.alarm(`approval.resolved 投递失败: ${String(err)}`),
    )
  }

  // ---------- M4e 出向：提问双通道（与审批同构；不经附着门控——goal 熔断等请示可发生在桌面轮次） ----------

  /** 提问请求推送（confirmed 门控，不经附着门控——与审批同理，请示可发生在任何轮次归属）。
   *  question 经 truncateToBudget 有界化：超预算的提问（如大清单）从"信封超限被静默丢弃、
   *  手机永远收不到"变为"必达但截断+标注"（对齐 sendEvent/summarizeResult 的既有截断文案）。 */
  pushAskRequest(payload: AskRequestPayload): void {
    if (!this.confirmed) return
    const { text: bounded, truncated } = truncateToBudget(payload.question)
    // 截断发生在 45KB 明文边界：再砍 ≥96 字符（≥96 字节）给标注留位，防标注把信封重新顶爆线上预算
    const question = truncated ? bounded.slice(0, Math.max(0, bounded.length - 96)) + '\n（已截断，完整内容请在桌面查看）' : bounded
    const body: Record<string, unknown> = {
      id: payload.id,
      question,
      ...(payload.options !== undefined ? { options: payload.options } : {}),
      ...(payload.allowFreeText !== undefined ? { allowFreeText: payload.allowFreeText } : {}),
      ...(payload.hint !== undefined ? { hint: payload.hint } : {}),
      // 点选裁决卡 additive 透传（budget 防护在构造侧 buildTriageCard；truncateToBudget 只收口 question）
      ...(payload.card !== undefined ? { card: payload.card } : {}),
      // 来源会话归因 additive 透传（手机端按归因分流呈现：有归因→来源会话时间线，无归因→全局浮层）
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      // 位置真相 additive 携带（requestedAt 折进 payload 单一事实源；首发/pending 重推/落定环重放三路径统一）
      ...(payload.requestedAt !== undefined ? { originalTs: payload.requestedAt } : {}),
    }
    this.queueOut(async () => {
      await this.sendEnvelope(makeEnvelope('ask.request', this.deps.myBox, this.deps.peerBox, body))
    }).catch((err) => this.alarm(`ask.request 投递失败: ${String(err)}`))
  }

  /** 提问落定通告（手机提问卡置灰的唯一触发）；记录已推送终态的 id（防迟到 response 的 cancelled 覆盖） */
  pushAskResolved(settled: { id: string; answer: string; by: string }): void {
    if (!this.confirmed) return
    this.markResolvedPushed(settled.id)
    this.queueOut(() => this.sendAskResolvedEnvelope(settled.id, settled.answer, settled.by)).catch((err) =>
      this.alarm(`ask.resolved 投递失败: ${String(err)}`),
    )
  }

  /**
   * 重连再同步（提问是可操作状态，不是纯展示）：壳侧传输每次连接成功后调用。
   * 权威状态在 AskChannel（listPending），手机卡片只是视图——重推收敛（同 id → 同卡片）。
   * 终态愈合：随后对近期落定环逐条重放"请求+落定"对（与审批同构，同 id 幂等）。
   */
  resyncPendingAsks(): void {
    if (!this.confirmed) return
    for (const p of this.deps.listPendingAsks?.() ?? []) this.pushAskRequest(p)
    for (const s of this.deps.listRecentSettledAsks?.() ?? []) {
      this.pushAskRequest(s.payload)
      this.pushAskResolved({ id: s.payload.id, answer: s.answer, by: s.by })
    }
  }

  private sendAskResolvedEnvelope(id: string, answer: string, by: string): Promise<void> {
    return this.sendEnvelope(makeEnvelope('ask.resolved', this.deps.myBox, this.deps.peerBox, { id, answer, by }))
  }

  /**
   * 重连再同步（审批是可操作状态，不是纯展示）：壳侧传输每次连接成功后调用。
   * 权威状态在 core（ApprovalChannel.listPending），手机卡片只是视图——重推收敛（同 toolCallId → 同卡片 id）。
   * 终态愈合：随后对近期落定环逐条重放"请求+落定"对（queueOut FIFO 保序，手机先建卡再置灰；
   * 同 id 幂等替换，重复重放无害）——approval.resolved 一旦丢信（租约切换/桥重建/手机离线），
   * 手机僵尸卡经此收敛到真相。
   */
  resyncPendingApprovals(): void {
    if (!this.confirmed) return
    for (const p of this.deps.listPendingApprovals()) this.pushApprovalRequest(p)
    for (const s of this.deps.listRecentSettledApprovals?.() ?? []) {
      this.pushApprovalRequest(s.payload)
      this.pushApprovalResolved({ toolCallId: s.payload.toolCallId, approved: s.approved, by: s.by })
    }
  }

  /**
   * M6b 节拍前进（ASSISTANT_MESSAGE_CREATED → wiring 调用）：先冲刷两个聚合缓冲
   * （及时性——缓冲内容带生产时捕获的旧节拍出队），再自增。M0.3：按事件归属会话门控
   * （isMirrorSession）——多引擎同跑时，非附着会话的子响应不再把附着视图跳一拍
   * （修复前只判"有没有人在看"，后台会话每个子响应都会误进拍）。
   * 无参调用（测试/兼容）＝附着会话（未附着且无跟随轮时 no-op——与单份共享时代语义一致）。
   */
  advanceBeat(sessionId?: string | null): void {
    let key: string | null
    if (sessionId !== undefined) {
      if (!this.isMirrorSession(sessionId)) return
      key = sessionId ?? ''
    } else {
      if (this.attachedSessionId !== null) key = this.attachedSessionId
      else if (this.followActiveSession) key = this.deps.getActiveSessionId?.() ?? ''
      else return
    }
    const cell = this.cellFor(key)
    this.flushDelta(cell)
    this.flushReasoning(cell)
    this.pushReasoningSnapshot(cell, cell.beatIndex) // M4f：旧节拍思考关闭快照（此后不再生长——新思考归新节拍）
    cell.beatIndex++
  }

  /**
   * M6 镜像门控（手机轮与本地轮统一一个判断）：内容所属会话 === 附着会话；
   * 兼容路径（旧端 chat.user 无 sessionId）跟随桌面当前会话现读。
   */
  private isMirrorSession(sessionId: string | null | undefined): boolean {
    if (this.attachedSessionId !== null) return sessionId === this.attachedSessionId
    if (!this.followActiveSession) return false
    return sessionId === (this.deps.getActiveSessionId?.() ?? null)
  }

  /**
   * M6 被动流入口（引擎 TURN_STREAM_CHUNK 经 wiring 转发）：附着门控后按 kind 进**该会话**的
   * 聚合格（0.4b）。kind=tool 拒收——工具事件走既有 toolStatus 通道（pushToolEvent），不双源。
   */
  pushStreamChunk(chunk: { sessionId: string; kind: 'delta' | 'reasoning' | 'tool'; text: string }): void {
    if (!this.confirmed || chunk.kind === 'tool' || !this.isMirrorSession(chunk.sessionId)) return
    const cell = this.cellFor(chunk.sessionId)
    if (cell.deltaClosed) {
      // 上一轮已落定（final 已发）：本地镜像新一轮开始——复位轮次锚点/节拍/序号（无 replyTo 锚；
      // 手机轮的锚由 processChatUserRound 复位置入，此处仅本地轮镜像自愈）
      cell.deltaClosed = false
      cell.deltaReplyTo = undefined
      cell.beatIndex = 0
      cell.eventSeq = 0
      cell.reasoningByBeat.clear()
      cell.reasoningSnapSent.clear()
    }
    if (chunk.kind === 'delta') this.pushDelta(cell, chunk.text)
    else this.pushReasoning(cell, chunk.text)
  }

  /** M4b 工具事件（kind='tool'）：附着会话出向；toolCallId 为块锚（演化/重投收敛于它）；M6：携带会话归属参数 */
  pushToolEvent(sessionId: string | null | undefined, text: string, toolCallId: string, detail?: Record<string, unknown>): void {
    if (!this.confirmed || !this.isMirrorSession(sessionId)) return
    const cell = this.cellFor(sessionId ?? '')
    const beat = cell.beatIndex // 生产时捕获
    const replyTo = cell.deltaReplyTo
    // F-1：戳=事件归属会话（本就收到参数）——不从 attached 推定
    this.queueOut(() =>
      this.sendEvent('tool', text, replyTo, {
        beat,
        toolCallId,
        ...(detail ? { detail } : {}),
        ...(sessionId ? { sessionStamp: sessionId } : {}),
      }),
    ).catch((err) => this.alarm(`tool 事件投递失败: ${String(err)}`))
  }

  /**
   * M7 subagent 事实流出向（feed.subagent）：附着门控（决策 15：只推附着会话的 Worker 进展）+ queueOut 保序。
   * 载荷=按 toolCallId 归并的 status 流（running→success|failed）；归并/防刷屏在 wiring 合并窗口，桥只管门控与投递。
   */
  pushFeedSubagent(sessionId: string | null | undefined, body: FeedSubagentBody): void {
    if (!this.confirmed || !this.isMirrorSession(sessionId)) return
    this.queueOut(() =>
      this.sendEnvelope(makeEnvelope('feed.subagent', this.deps.myBox, this.deps.peerBox, body as unknown as Record<string, unknown>)),
    ).catch((err) => this.alarm(`feed.subagent 投递失败: ${String(err)}`))
  }

  /** 镜像会话键（便捷形态/无参节拍的统一解析：附着会话；未附着且跟随轮 → 活跃会话；否则 ''） */
  private mirrorKey(): string {
    if (this.attachedSessionId !== null) return this.attachedSessionId
    if (this.followActiveSession) return this.deps.getActiveSessionId?.() ?? ''
    return ''
  }

  /** 思维链（kind='reasoning'）：附着会话出向；200ms/2KB 聚合；beat 生产时捕获。
   *  便捷形态（测试用）：无格参数 → 镜像会话的格（与 advanceBeat 无参解析同源） */
  pushReasoning(text: string): void
  pushReasoning(cell: StreamCell, text: string): void
  pushReasoning(a: string | StreamCell, b?: string): void {
    if (!this.confirmed) return
    const cell = typeof a === 'string' ? this.cellFor(this.mirrorKey()) : a
    const text = typeof a === 'string' ? a : (b as string)
    this.pushReasoningCell(cell, text)
  }

  private pushReasoningCell(cell: StreamCell, text: string): void {
    if (cell.pendingReasoning.length === 0) cell.pendingReasoningBeat = cell.beatIndex
    cell.pendingReasoning += text
    // M4f：累积全文同步记账（生产时捕获的节拍）；advanceBeat 先冲刷再自增，缓冲永不跨节拍
    cell.reasoningByBeat.set(cell.pendingReasoningBeat, (cell.reasoningByBeat.get(cell.pendingReasoningBeat) ?? '') + text)
    if (cell.pendingReasoning.length >= DELTA_FLUSH_CHARS) {
      this.flushReasoning(cell)
      return
    }
    if (!cell.reasoningTimer) {
      cell.reasoningTimer = setTimeout(() => {
        cell.reasoningTimer = null
        this.flushReasoning(cell)
      }, DELTA_FLUSH_MS)
      if (typeof cell.reasoningTimer.unref === 'function') cell.reasoningTimer.unref()
    }
  }

  /**
   * M4f：节拍思考关闭快照。思考块没有"final 全文"兜底（正文块有），丢分片即成永久洞
   * （实测：首分片丢失，手机思考开头残缺）。节拍关闭时（advanceBeat/轮次收尾）补发该节拍
   * 全文 + closed:true；手机端长者胜整体覆盖——洞/迟到/半截全部愈合。每节拍至多一次。
   */
  private pushReasoningSnapshot(cell: StreamCell, beat: number): void {
    const full = cell.reasoningByBeat.get(beat)
    if (!full || cell.reasoningSnapSent.has(beat)) return
    cell.reasoningSnapSent.add(beat)
    const replyTo = cell.deltaReplyTo
    this.queueOut(() => this.sendEvent('reasoning', full, replyTo, { beat, closed: true, sessionStamp: cell.sessionId })).catch((err) =>
      this.alarm(`reasoning 快照投递失败: ${String(err)}`),
    )
  }

  /** 轮次落定路径的关闭快照：await 本任务即隐含此前出向任务完成，保序在 final 之前 */
  private async pushReasoningSnapshotNow(cell: StreamCell, beat: number): Promise<void> {
    const full = cell.reasoningByBeat.get(beat)
    if (!full || cell.reasoningSnapSent.has(beat)) return
    cell.reasoningSnapSent.add(beat)
    await this.queueOut(() => this.sendEvent('reasoning', full, cell.deltaReplyTo, { beat, closed: true, sessionStamp: cell.sessionId }))
  }

  /** 冲刷聚合思维链（定时器/超窗路径：经出向 FIFO，fire-and-forget） */
  private flushReasoning(cell: StreamCell): void {
    if (cell.reasoningTimer) {
      clearTimeout(cell.reasoningTimer)
      cell.reasoningTimer = null
    }
    if (cell.pendingReasoning.length === 0) return
    const text = cell.pendingReasoning
    const beat = cell.pendingReasoningBeat
    cell.pendingReasoning = ''
    const replyTo = cell.deltaReplyTo
    const seq = cell.eventSeq++
    this.queueOut(() => this.sendEvent('reasoning', text, replyTo, { beat, seq, sessionStamp: cell.sessionId })).catch((err) => this.alarm(`reasoning 投递失败: ${String(err)}`))
  }

  /** 冲刷聚合思维链（轮次落定路径：await 本任务即隐含此前出向任务完成，保序在 final 之前） */
  private async flushReasoningNow(cell: StreamCell): Promise<void> {
    if (cell.reasoningTimer) {
      clearTimeout(cell.reasoningTimer)
      cell.reasoningTimer = null
    }
    if (cell.pendingReasoning.length === 0) return
    const text = cell.pendingReasoning
    const beat = cell.pendingReasoningBeat
    cell.pendingReasoning = ''
    const seq = cell.eventSeq++
    await this.queueOut(() => this.sendEvent('reasoning', text, cell.deltaReplyTo, { beat, seq, sessionStamp: cell.sessionId }))
  }

  private sendApprovalResolvedEnvelope(id: string, approved: boolean, by: string): Promise<void> {
    return this.sendEnvelope(
      makeEnvelope('approval.resolved', this.deps.myBox, this.deps.peerBox, { id, approved, by }),
    )
  }

  // ---------- 出向（delta 聚合 200ms/2KB） ----------

  /** 引擎流式 delta：便捷形态（测试用）——无格参数 → 镜像会话的格；规范入口经 pushStreamChunk 门控 */
  pushDelta(delta: string): void
  pushDelta(cell: StreamCell, delta: string): void
  pushDelta(a: string | StreamCell, b?: string): void {
    const cell = typeof a === 'string' ? this.cellFor(this.mirrorKey()) : a
    const delta = typeof a === 'string' ? a : (b as string)
    this.pushDeltaCell(cell, delta)
  }

  private pushDeltaCell(cell: StreamCell, delta: string): void {
    if (cell.deltaClosed) return // 轮次已落定（final 已发）后，迟到的 delta 一律丢弃，防 final 后又冒流式卡
    if (cell.pendingDelta.length === 0) cell.pendingDeltaBeat = cell.beatIndex
    cell.pendingDelta += delta
    if (cell.pendingDelta.length >= DELTA_FLUSH_CHARS) {
      this.flushDelta(cell)
      return
    }
    if (!cell.deltaTimer) {
      cell.deltaTimer = setTimeout(() => {
        cell.deltaTimer = null
        this.flushDelta(cell)
      }, DELTA_FLUSH_MS)
    }
  }

  /** 冲刷聚合 delta（定时器/超窗路径：经出向 FIFO 保序，fire-and-forget） */
  private flushDelta(cell: StreamCell): void {
    if (cell.deltaTimer) {
      clearTimeout(cell.deltaTimer)
      cell.deltaTimer = null
    }
    if (cell.pendingDelta.length === 0) return
    const text = cell.pendingDelta
    const beat = cell.pendingDeltaBeat
    cell.pendingDelta = ''
    const replyTo = cell.deltaReplyTo
    const seq = cell.eventSeq++
    this.queueOut(() => this.sendEvent('delta', text, replyTo, { beat, seq, sessionStamp: cell.sessionId })).catch((err) => this.alarm(`delta 投递失败: ${String(err)}`))
  }

  /** 冲刷聚合 delta（轮次落定路径：await 本任务即隐含此前全部出向任务完成，保证 final 在 delta 之后投递） */
  private async flushDeltaNow(cell: StreamCell): Promise<void> {
    if (cell.deltaTimer) {
      clearTimeout(cell.deltaTimer)
      cell.deltaTimer = null
    }
    if (cell.pendingDelta.length === 0) return
    const text = cell.pendingDelta
    const beat = cell.pendingDeltaBeat
    cell.pendingDelta = ''
    const seq = cell.eventSeq++
    await this.queueOut(() => this.sendEvent('delta', text, cell.deltaReplyTo, { beat, seq, sessionStamp: cell.sessionId }))
  }

  /** 出向 FIFO：所有 chat.event 投递排队经过，返回该任务自身的完成 promise */
  private queueOut(fn: () => Promise<void>): Promise<void> {
    const p = this.outChain.then(fn)
    this.outChain = p.catch(() => { /* 单个投递失败不堵后续 */ })
    return p
  }

  /** M7 board.state 组包→发送的串行链（保序 + 分片不与后续推送交错） */
  private boardSendChain: Promise<void> = Promise.resolve()
  /** 工作计划树出向串行链（同 boardSendChain 语义，独立链条互不楔死） */
  private workPlanSendChain: Promise<void> = Promise.resolve()

  private async sendEvent(
    kind: string,
    text: string,
    replyTo?: string,
    extra?: {
      beat?: number
      seq?: number
      toolCallId?: string
      detail?: Record<string, unknown>
      closed?: boolean
      /**
       * F-1（迭代 F）：归属戳生产时刻捕获——调用方传内容所属会话，**缺省才**回退执行时刻的
       * attachedSessionId（legacy 无格路径）。429 重试占链最长 175s，出向队列积压期间附着可变——
       * 惰性盖章会把 A 的内容盖成 B 的章（生产实测串台根因）；戳与 beat 同纪律（PROTOCOL-FROZEN
       * :54「生产时捕获」）。
       */
      sessionStamp?: string
    },
  ): Promise<void> {
    const { text: t, truncated } = truncateToBudget(text)
    const stamp = extra?.sessionStamp ?? this.attachedSessionId
    const env = makeEnvelope(
      'chat.event',
      this.deps.myBox,
      this.deps.peerBox,
      {
        kind,
        text: t,
        // M6：会话归属戳（additive，旧端忽略）——镜像轮（本地轮）无 replyTo 锚，手机据此归位到附着会话。
        // F-1：优先生产时刻捕获的显式戳（sessionStamp）
        ...(stamp !== null && stamp !== undefined ? { sessionId: stamp } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(extra?.beat !== undefined ? { beat: extra.beat } : {}),
        ...(extra?.seq !== undefined ? { seq: extra.seq } : {}),
        ...(extra?.toolCallId !== undefined ? { toolCallId: extra.toolCallId } : {}),
        ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
        ...(extra?.closed === true ? { closed: true } : {}),
      },
      replyTo,
      this.now,
    )
    dbg(`[relay-dbg] 出向 chat.event env.id=${env.id} kind=${kind} replyTo=${replyTo ?? '∅'} len=${t.length}${extra?.beat !== undefined ? ` beat=${extra.beat}` : ''}`)
    await this.sendEnvelope(env)
  }

  private async sendEnvelope(env: Envelope): Promise<void> {
    const wire = encryptEnvelope(this.deps.secrets.keyD2M, this.deps.peerBox, 'd2m', env)
    if (!wire) throw new Error('消息超线上字节上限')
    // M1.1（中继投递流控规划）：429=背压不是错误——置节流态（M1.2 入队闸据此避让），按可再生性分治：
    // 可再生即弃（rev 再生/手机 resync 兜底，防被困 FIFO 头 175s 头阻塞）；不可再生等窗重试本封
    // （35s>窗口半程必跨重置；≤5 次≈3 分钟，超限丢弃+alarm）。重试发生在信封自身 send 内不回队尾（保序红线）。
    for (let attempt = 0; ; attempt++) {
      const r = await this.deps.http.request('POST', `/box/${this.deps.peerBox}`, {
        token: this.deps.secrets.writeToken,
        body: { blob: wire },
      })
      if (r.status === 201) {
        if (this.throttleSince !== null && this.now() >= this.throttledUntil) this.throttleSince = null
        return
      }
      if (r.status !== 429) throw new Error(`投递失败 HTTP ${r.status}`)
      const nowMs = this.now()
      this.throttledUntil = Math.max(this.throttledUntil, nowMs + RELAY_THROTTLE_MS)
      if (this.throttleSince === null) this.throttleSince = nowMs
      const regenerable = REGENERABLE_ENVELOPE_TYPES.has(env.type)
      const action = regenerable ? 'drop-regenerable' : attempt >= THROTTLE_MAX_RETRIES ? 'drop-exhausted' : 'retry-wait'
      this.deps.onDeliveryThrottled?.({ at: nowMs, since: this.throttleSince, sustainedMs: nowMs - this.throttleSince, envelopeType: env.type, action })
      if (action === 'drop-regenerable') {
        throw new Error('投递被限流（429）——可再生信封已弃，等 rev 再生/手机 resync 重取')
      }
      if (action === 'drop-exhausted') {
        throw new Error('投递被限流（429）重试超限，已丢弃')
      }
      await this.throttleSleep(RELAY_THROTTLE_MS)
    }
  }

  // ---------- file.* 协议族：入向传输处理（快速路径；幂等在传输层，无需信封去重） ----------

  /** file.receipt 出向（经出向 FIFO 保序；receipt 丢失由手机重发 offer 触发幂等重发） */
  private async sendFileReceipt(body: FileReceiptBody): Promise<void> {
    const env = makeEnvelope('file.receipt', this.deps.myBox, this.deps.peerBox, body as unknown as Record<string, unknown>, undefined, this.now)
    dbg(`[relay-dbg] 出向 file.receipt env.id=${env.id} fileId=${body.fileId} ok=${body.ok}`)
    await this.sendEnvelope(env)
  }

  /** file.offer：预检（帽/参数）→ 受理或拒绝；已完成 fileId 幂等重发 receipt */
  private async handleFileOffer(env: Envelope, msgId: number): Promise<void> {
    const body = env.body as unknown as FileOfferBody
    sweepTransfers(this.fileStore, this.now())
    // 媒体直传在途 TTL 清扫（与传输层同款超时语义）
    for (const [id, e] of this.pendingStaticMedia) {
      if (this.now() - e.offeredAt > FILE_TRANSFER_TTL_MS) this.pendingStaticMedia.delete(id)
    }
    if (!this.deps.saveAttachment) {
      // 旧装配安全降级：未装配落盘能力的宿主诚实拒绝（不影响其余功能）
      await this.ack(msgId)
      await this.queueOut(() => this.sendFileReceipt({ fileId: String(body?.fileId ?? ''), ok: false, error: '桌面未装配文件接收能力' }))
      return
    }
    // 媒体直传分支：static 指针（密文在中继静态通道，无 chunk 跟随）
    const st = body?.static
    if (st !== undefined) {
      await this.handleStaticOffer(body, st, msgId)
      return
    }
    const r = offerFile(this.fileStore, body, this.now())
    await this.ack(msgId)
    if (!r.ok) {
      await this.queueOut(() => this.sendFileReceipt({ fileId: body.fileId, ok: false, error: r.error }))
      return
    }
    if (r.duplicate && r.settled) {
      // receipt 丢失后手机重试的重复 offer：幂等重发 receipt，不重复落盘
      await this.queueOut(() => this.sendFileReceipt({ fileId: r.settled.fileId, ok: true }))
    }
    // 新 offer / 未完成重复 offer：静默受理（chunk 续传）
  }

  /**
   * 媒体直传 offer（static 指针）：形状校验 → 登记 pending → 立即 ACK → 异步拉取。
   * 严禁 inline await 拉取（5MB@190KB/s≈26s 会阻塞信箱排空——后续信封全部排队，设计定案）。
   * 崩溃窗口（ACK 后 receipt 前宕机）：手机收不到 receipt 走 offer 重发自愈——不是 bug，勿"修"。
   */
  private async handleStaticOffer(
    body: FileOfferBody,
    st: NonNullable<FileOfferBody['static']>,
    msgId: number,
  ): Promise<void> {
    const fileId = String(body?.fileId ?? '')
    const isV2 = st.fmt === 2
    const maxBytes = isV2 ? MEDIA_MAX_BYTES : FILE_MAX_BYTES
    const shapeOk =
      fileId.length > 0 &&
      typeof st.name === 'string' &&
      MEDIA_NAME_RE.test(st.name) &&
      typeof st.key === 'string' &&
      isB64u(st.key) &&
      typeof body.size === 'number' &&
      Number.isInteger(body.size) &&
      body.size > 0 &&
      body.size <= maxBytes &&
      typeof body.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(body.sha256) &&
      // v2 附加校验：wireSize + nonce 必带且合法
      (!isV2 ||
        (typeof st.wireSize === 'number' &&
          Number.isInteger(st.wireSize) &&
          st.wireSize >= body.size + 24 + 40 && // 至少单片密文（含 nonce+MAC）
          st.wireSize <= maxBytes * 2 && // 密文膨胀上界 ≈ 明文 × (1+64/512K) ≈ 1.0001
          typeof st.nonce === 'string' &&
          isB64u(st.nonce)))
    if (!shapeOk) {
      await this.ack(msgId)
      await this.queueOut(() => this.sendFileReceipt({ fileId, ok: false, error: 'static offer 参数不合法' }))
      return
    }
    if (!this.deps.fetchMedia) {
      await this.ack(msgId)
      await this.queueOut(() => this.sendFileReceipt({ fileId, ok: false, error: '桌面未装配媒体拉取能力' }))
      return
    }
    // 已完成幂等（receipt 丢失后手机重发 offer 的正常形态——同 chunk 路径语义）
    const settled = getSettled(this.fileStore, fileId)
    if (settled) {
      await this.ack(msgId)
      await this.queueOut(() => this.sendFileReceipt({ fileId: settled.fileId, ok: true }))
      return
    }
    const first = !this.pendingStaticMedia.has(fileId)
    if (first) {
      this.pendingStaticMedia.set(fileId, {
        name: st.name,
        key: st.key,
        sha256: body.sha256.toLowerCase(),
        meta: { name: body.name, mime: body.mime, size: body.size },
        offeredAt: this.now(),
        ...(isV2 ? { fmt2: { wireSize: st.wireSize!, nonce: st.nonce! } } : {}),
      })
    }
    await this.ack(msgId)
    if (first) void this.fetchStaticMedia(fileId).catch((e) => dbg(`[relay-dbg] static media 拉取异常: ${String(e)}`)) // 在途去重：重复 offer 不重启拉取
  }

  /** 异步拉取 → AEAD 验真解密 → 明文 sha256 对账 → 落盘 → settled（同形注册表，下游解析零改动）→ receipt。
   *  v2 分片路径：逐片 Range 拉取+验真+解密 → 渐进拼装 → sha256 对账（与上传对称——早发现损坏）。 */
  private async fetchStaticMedia(fileId: string): Promise<void> {
    const entry = this.pendingStaticMedia.get(fileId)
    if (!entry) return
    let outcome: { ok: true; savedRef: string } | { ok: false; error: string }
    try {
      const plain = entry.fmt2
        ? await this.fetchMediaV2Chunked(fileId, entry)
        : await this.fetchMediaV1Whole(fileId, entry)
      if (!this.pendingStaticMedia.has(fileId)) return // 已被 abort 丢弃（迟到结果作废）
      if (bytesToHex(sha256(plain)) !== entry.sha256) throw new Error('媒体校验失败（sha256 不符）')
      const ext = sanitizeFileExtension(entry.meta.name)
      const stem = entry.meta.name.replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|]/g, '_')
      const safeName = ext ? `${stem}.${ext}` : stem
      const savedRef = await this.deps.saveAttachment!(plain, safeName)
      outcome = { ok: true, savedRef }
    } catch (err) {
      outcome = { ok: false, error: `媒体直传失败：${err instanceof Error ? err.message : String(err)}` }
    }
    this.pendingStaticMedia.delete(fileId)
    try {
      if (outcome.ok) {
        settleTransfer(this.fileStore, fileId, outcome.savedRef, entry.meta, this.now())
        await this.queueOut(() => this.sendFileReceipt({ fileId, ok: true }))
      } else {
        await this.queueOut(() => this.sendFileReceipt({ fileId, ok: false, error: outcome.error }))
      }
    } catch (e) {
      // receipt 发送失败（连接断等）：settled 已在注册表 / 手机重发 offer 幂等补发——自愈，不重试
      dbg(`[relay-dbg] static media receipt 发送失败: ${String(e)}`)
    }
  }

  /** v1 整块拉取+解密（fmt 缺省或 1——≤5MB 小文件快路） */
  private async fetchMediaV1Whole(_fileId: string, entry: StaticMediaPending): Promise<Uint8Array> {
    const wire = await this.withFetchTimeout(this.deps.fetchMedia!(entry.name))
    const plain = openMediaBlob(wire, entry.key)
    if (!plain) throw new Error('媒体解密失败（v1 整块）')
    return plain
  }

  /** v2 分片拉取+逐片验真+渐进拼装（fmt:2——大文件对称分片循环；单片退避 ×3 再报败） */
  private async fetchMediaV2Chunked(_fileId: string, entry: StaticMediaPending): Promise<Uint8Array> {
    const { nonce } = entry.fmt2!
    const fileNonce = b64uDecode(nonce)
    const totalPlain = entry.meta.size
    const chunks = Math.ceil(totalPlain / MEDIA_CHUNK_BYTES)
    const plain = new Uint8Array(totalPlain)
    let plainOff = 0
    for (let i = 0; i < chunks; i++) {
      const { start, end } = mediaChunkRange(totalPlain, i)
      const range = `bytes=${start}-${end}`
      // 单片退避 ×3 再报败（瞬时网络抖动不触发整文件重传）
      let wireChunk: Uint8Array | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          wireChunk = await this.withFetchTimeout(
            this.deps.fetchMedia!(entry.name, { range }),
            STATIC_FETCH_TIMEOUT_MS,
          )
          break
        } catch (err) {
          if (attempt === 2) throw new Error(`分片 ${i} 拉取失败（3 次重试耗尽）：${err instanceof Error ? err.message : String(err)}`)
          dbg(`[relay-dbg] v2 分片 ${i}/${chunks} 拉取重试 #${attempt + 1}: ${String(err)}`)
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        }
      }
      if (!wireChunk) throw new Error(`分片 ${i} 拉取失败`)
      if (!this.pendingStaticMedia.has(_fileId)) throw new Error('已取消') // abort 丢弃
      // 双验：嵌入 nonce 与派生一致 + MAC 验真（位置错位立即检出）
      const chunkPlain = openMediaChunk(wireChunk, entry.key, fileNonce, i)
      if (!chunkPlain) throw new Error(`分片 ${i} 解密失败（位置错位或密文损坏）`)
      plain.set(chunkPlain, plainOff)
      plainOff += chunkPlain.length
    }
    if (plainOff !== totalPlain) throw new Error(`分片拼装长度不符（${plainOff} ≠ ${totalPlain}）`)
    return plain
  }

  /** 拉取超时护栏（超时不中止底层请求——注入实现未必支持 abort；迟到结果经 pending 缺席作废） */
  private withFetchTimeout<T>(p: Promise<T>, ms: number = STATIC_FETCH_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('媒体拉取超时')), ms)
      if (typeof t.unref === 'function') t.unref()
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  }

  /** file.chunk：幂等收块 → 齐块校验落盘 → receipt（ACK 恒发：分块本身无需重投语义） */
  private async handleFileChunk(env: Envelope, msgId: number): Promise<void> {
    const body = env.body as unknown as { fileId: string; seq: number; data: string }
    const r = receiveChunk(this.fileStore, body.fileId, body.seq, body.data, this.now())
    if (r.kind === 'unknown' || r.kind === 'dup' || r.kind === 'stored') {
      await this.ack(msgId)
      return
    }
    if (r.kind === 'corrupt') {
      await this.ack(msgId)
      await this.queueOut(() => this.sendFileReceipt({ fileId: body.fileId, ok: false, error: r.error }))
      return
    }
    // complete：恰好一次落盘（saveAttachment 失败 → receipt ok:false，手机可全量重发重试）
    try {
      const ext = sanitizeFileExtension(r.transfer.name)
      const stem = r.transfer.name.replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|]/g, '_')
      const safeName = ext ? `${stem}.${ext}` : stem
      const savedRef = await this.deps.saveAttachment!(r.bytes, safeName)
      const settled = settleTransfer(
        this.fileStore,
        r.transfer.fileId,
        savedRef,
        { name: r.transfer.name, mime: r.transfer.mime, size: r.transfer.size },
        this.now(),
      )
      await this.ack(msgId)
      await this.queueOut(() => this.sendFileReceipt({ fileId: settled.fileId, ok: true }))
    } catch (err) {
      dropTransfer(this.fileStore, r.transfer.fileId)
      await this.ack(msgId)
      await this.queueOut(() =>
        this.sendFileReceipt({ fileId: r.transfer.fileId, ok: false, error: `桌面落盘失败：${err instanceof Error ? err.message : String(err)}` }),
      )
    }
  }

  /** file.abort：丢弃未完成缓冲（已完成的不动——迟到的 abort 不回收已落盘事实） */
  private async handleFileAbort(env: Envelope, msgId: number): Promise<void> {
    abortTransfer(this.fileStore, String(env.body['fileId'] ?? ''))
    // 媒体直传在途作废（迟到拉取结果经 pending 缺席丢弃）
    this.pendingStaticMedia.delete(String(env.body['fileId'] ?? ''))
    await this.ack(msgId)
  }

  // ---------- d→m 出向文件发送（桌面→手机；file.* 协议升格为角色无关的桌面侧一半） ----------

  /** 已发出的 offer 登记（receipt 到达时回填 name/sessionId 供 notice 文案；有界防内存生长） */
  private sentFiles = new Map<string, { name: string; sessionId?: string }>()

  private markSentFile(fileId: string, meta: { name: string; sessionId?: string }): void {
    this.sentFiles.set(fileId, meta)
    if (this.sentFiles.size > 256) {
      const oldest = this.sentFiles.keys().next().value
      if (oldest !== undefined) this.sentFiles.delete(oldest)
    }
  }

  /** file.receipt 等待器（镜像手机 session.ts 模式：分发层 resolve；超时返 null——不当作失败） */
  private fileReceiptWaiters = new Map<string, Array<(r: { ok: boolean; error?: string }) => void>>()

  /** 早到 receipt 暂存（竞态：手机回执在 waitFileReceipt 注册前到达——先存后取，真机实测教训同款） */
  private earlyReceipts = new Map<string, { ok: boolean; error?: string }>()

  /**
   * 等待手机回执（调用方异步挂——手机可能数小时后才点收，阻塞等待违背物理）。
   * 超时 resolve null = "待接收"（诚实表述，不谎报失败也不谎报送达）。
   */
  waitFileReceipt(fileId: string, timeoutMs: number): Promise<{ ok: boolean; error?: string } | null> {
    const early = this.earlyReceipts.get(fileId)
    if (early) {
      this.earlyReceipts.delete(fileId)
      return Promise.resolve(early)
    }
    return new Promise((resolve) => {
      const cb = (r: { ok: boolean; error?: string }) => {
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        const cbs = this.fileReceiptWaiters.get(fileId) ?? []
        const idx = cbs.indexOf(cb)
        if (idx >= 0) cbs.splice(idx, 1)
        resolve(null)
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      const list = this.fileReceiptWaiters.get(fileId) ?? []
      list.push(cb)
      this.fileReceiptWaiters.set(fileId, list)
    })
  }

  private resolveFileReceipt(fileId: string, ok: boolean, error?: string): void {
    const cbs = this.fileReceiptWaiters.get(fileId)
    if (!cbs || cbs.length === 0) {
      // 无等待者 = receipt 早到 → 暂存（下一次 waitFileReceipt 立取）
      this.earlyReceipts.set(fileId, { ok, ...(error !== undefined ? { error } : {}) })
      return
    }
    this.fileReceiptWaiters.delete(fileId)
    for (const cb of cbs) cb({ ok, ...(error !== undefined ? { error } : {}) })
  }

  /**
   * 入向 file.receipt（手机对 d→m 发送的终局回执）：重投由既有 env.id 去重层吸收；
   * resolve 等待器 + onFileReceipt 通告（无等待器的迟到 receipt 同样通告——送达事实须让用户可见）。
   */
  private async handleFileReceipt(env: Envelope, msgId: number): Promise<void> {
    if (this.dedupe.has(env.id)) {
      await this.ack(msgId)
      return
    }
    this.markAndPersist(env.id)
    await this.ack(msgId)
    const fileId = typeof env.body['fileId'] === 'string' ? env.body['fileId'] : ''
    if (!fileId) return
    const ok = env.body['ok'] === true
    const error = typeof env.body['error'] === 'string' ? env.body['error'] : undefined
    this.resolveFileReceipt(fileId, ok, error)
    const sent = this.sentFiles.get(fileId)
    this.deps.onFileReceipt?.({
      fileId,
      ok,
      ...(error !== undefined ? { error } : {}),
      ...(sent?.name !== undefined ? { name: sent.name } : {}),
      ...(sent?.sessionId !== undefined ? { sessionId: sent.sessionId } : {}),
    })
  }

  /**
   * 敏感路径 denylist（校验单点的硬闸——密钥类文件没有任何合法理由外发，注入诱导的代价为零成本拒绝）。
   * 匹配口径：调用前 resolvePath 已展开 ~ 并规范化绝对路径；Windows 下大小写不敏感（deps.caseInsensitivePaths）。
   * 命中返回拒绝文案，未命中返回 null。
   */
  private checkSendPathDenied(absPath: string): string | null {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
    const fold = (s: string): string => (this.deps.caseInsensitivePaths ? s.toLowerCase() : s)
    const p = fold(norm(absPath))
    const base = p.slice(p.lastIndexOf('/') + 1)
    const home = this.deps.homeDir ? fold(norm(this.deps.homeDir)) : null
    if (home && (p === `${home}/.chill` || p.startsWith(`${home}/.chill/`))) {
      return '该文件位于 ~/.chill/ 目录（密钥/配对材料），不允许外发'
    }
    if (/\.(pem|key)$/.test(base)) return '密钥类文件（*.pem/*.key）不允许外发'
    if (base.startsWith('.env')) return '环境凭据文件（.env*）不允许外发'
    return null
  }

  /**
   * d→m 出向编排：把桌面文件加密发送到已配对手机（手机端用户点[接收]才拉字节，拉取即同意）。
   * 一切校验单点在此（CLI /send 与 agent 工具两个入口共享，谁也不许绕）：
   * 路径解析（~/相对路径→规范化绝对路径）→ 敏感路径 denylist → 存在/是文件/0 字节拒绝/≤100MB →
   * caps 门（两种病因两种话）→ fileSender（v2 分片，onProgress 透传）→ file.offer 经出向 FIFO 发出。
   * 返回 { fileId, expiresAt }；receipt 等待由调用方异步挂 waitFileReceipt（不阻塞——手机可能数小时后才点收）。
   */
  async sendFileToMobile(input: {
    /** 文件路径（与 bytes 二选一） */
    path?: string
    /** 字节直发（与 path 二选一；无路径可判 denylist——调用方自负来源清白，name 必填） */
    bytes?: Uint8Array
    name?: string
    mime?: string
    /** 发出方当前会话 id（卡片长在产生它的那轮对话里） */
    sessionId?: string
    onProgress?: (sentBytes: number, totalBytes: number) => void
  }): Promise<{ fileId: string; expiresAt: number }> {
    if (!this.confirmed) throw new Error('中继未配对，无法发送文件')
    const sizeCapMsg = `文件超过上限 ${Math.floor(MEDIA_MAX_BYTES / 1024 / 1024)}MB`
    let name = input.name
    let readSlice: (offset: number, length: number) => Promise<Uint8Array>
    let statBound: () => Promise<{ size: number; mtimeMs: number }>
    if (input.bytes !== undefined) {
      const bytes = input.bytes
      if (!name) throw new Error('bytes 直发必须提供文件名')
      if (bytes.length === 0) throw new Error('空文件不发送（0 字节）')
      if (bytes.length > MEDIA_MAX_BYTES) throw new Error(sizeCapMsg)
      readSlice = async (offset, length) => bytes.subarray(offset, offset + length)
      statBound = async () => ({ size: bytes.length, mtimeMs: 0 }) // 内存字节无 mutated 竞态
    } else {
      if (!input.path) throw new Error('缺少文件路径')
      if (!this.deps.resolvePath || !this.deps.statFile || !this.deps.readFileSlice) {
        throw new Error('当前环境未装配文件发送能力（路径解析/读取）')
      }
      const abs = await this.deps.resolvePath(input.path)
      const denied = this.checkSendPathDenied(abs)
      if (denied) throw new Error(denied)
      const st = await this.deps.statFile(abs)
      if (!st) throw new Error(`文件不存在：${abs}`)
      if (!st.isFile) throw new Error(`不是普通文件（不支持目录等）：${abs}`)
      if (st.size === 0) throw new Error('空文件不发送（0 字节）')
      if (st.size > MEDIA_MAX_BYTES) throw new Error(sizeCapMsg)
      name = name ?? abs.split(/[\\/]/).pop()!
      readSlice = (offset, length) => this.deps.readFileSlice!(abs, offset, length)
      statBound = async () => {
        const cur = await this.deps.statFile!(abs)
        if (!cur) throw new Error('文件在发送过程中被删除')
        return { size: cur.size, mtimeMs: cur.mtimeMs }
      }
    }
    if (!this.deps.putMedia) throw new Error('当前环境未装配文件上传能力')
    // caps 门（两种病因两种话：见过 ping 但无 file-recv = 版本过旧；从未见过 ping = 尚未上线）
    if (this.lastPeerCaps === null) throw new Error('手机尚未上线，请先在手机上打开 chill')
    if (!this.peerCanRecvFile()) throw new Error('手机端版本过旧，请更新 APP 后再发送文件')
    const outcome = await sendFile({
      name,
      ...(input.mime !== undefined ? { mime: input.mime } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      readSlice,
      statFile: statBound,
      putChunk: this.deps.putMedia,
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
      now: this.now,
    })
    if (!outcome.ok) {
      const msg =
        outcome.reason === 'cancelled'
          ? '已取消'
          : outcome.reason === 'file-mutated'
            ? '文件在发送过程中被修改，请重新发送'
            : outcome.reason === 'upload-failed' || outcome.reason === 'conflict-unresolved'
              ? `上传失败：${outcome.detail ?? ''}`
              : outcome.reason === 'empty'
                ? '空文件不发送（0 字节）'
                : outcome.reason === 'too-large'
                  ? sizeCapMsg
                  : `文件读取失败：${outcome.detail ?? ''}`
      throw new Error(msg)
    }
    const offer = outcome.offer
    this.markSentFile(offer.fileId, {
      name: offer.name,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    })
    dbg(`[relay-dbg] 出向 file.offer fileId=${offer.fileId} name=${offer.name} size=${offer.size}`)
    await this.queueOut(() =>
      this.sendEnvelope(
        makeEnvelope('file.offer', this.deps.myBox, this.deps.peerBox, offer as unknown as Record<string, unknown>, undefined, this.now),
      ),
    )
    return { fileId: offer.fileId, expiresAt: offer.expiresAt! }
  }

  private async ack(id: number): Promise<void> {
    const r = await this.deps.http.request('POST', `/box/${this.deps.myBox}/ack`, {
      token: this.deps.secrets.readToken,
      body: { id },
    })
    if (r.status !== 204) this.alarm(`ACK 失败（id=${id}）HTTP ${r.status}，消息将重投`)
  }
}
