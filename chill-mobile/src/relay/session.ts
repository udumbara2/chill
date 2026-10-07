/**
 * session.ts — 配对状态机 + 聊天会话（照 chill-relay demo-phone 的协议义务实现）：
 * - redeem 首次发出前先持久化密钥对+token（重启恢复原对续传）
 * - redeem 网络重试 ×5（同一密钥对）；409 → conflict 全屏错误（勿重试）；410 → expired 停止重试
 * - pair.hello 只发一次（helloSent）；confirm 10 分钟未达 → revoke 双信箱自注销（orphan-revoked）
 * - confirm 前只处理 pair.*；未识别 type 丢弃；信封 id 去重；解密+处理成功后才 ACK
 * - WS 断开指数退避重连（服务器信箱对未 ACK 消息自动补投 = 离线留言恢复）
 * - 本地密钥缺失（重装）→ 引导重新扫码（state: 'need-pairing'）
 */
import {
  generateKeyPair,
  keyPairFromSecretKey,
  ecdhShared,
  deriveSecrets,
  tokenHash,
  mailboxIdFromPub,
  pairingMAC,
  encryptEnvelope,
  decryptEnvelope,
  makeEnvelope,
  isTsFresh,
  truncateToBudget,
  DedupeSet,
  KNOWN_TYPES,
  PLAINTEXT_BUDGET_BYTES,
  CAP_FILE_RECV,
  sanitizeFileName,
  type Envelope,
  type CatalogStateBody,
  type HistoryPageBody,
  type SessionEventBody,
  type BoardStateBody,
  type WorkPlanStateBody,
  type FeedSubagentBody,
  type CommandStateSnapshot,
  type CommandCatalogEntry,
  type FileOfferBody,
  type AskTriageCard,
  type AskDecisionEntry,
} from './envelope';
import { PendingOlderTracker } from './pendingOlderTracker';
import { CA_FP } from './ca-bundle';
import { httpJson, sleep, httpBase } from './http';
import { uploadFile, buildAttachments, postWithRetry, defaultSleep } from './fileUploader';
import { publishMedia, receiptWaitStep, STATIC_RECEIPT_TICK_MS } from './mediaPublisher';
import { uploadFileV2, buildStaticV2, V2_THRESHOLD_BYTES } from './mediaPublisherV2';
import { fetchOfferedFile, validateIncomingOffer, FetchHttpError } from './mediaFetcher';
import { reconcileRecvDir } from './recvReconcile';
import { deliverToDownloads } from './deliverFile';
import { resolveBlobUtil, type BlobUtilFs } from './blobUtil';
import { fromByteArray as bytesToB64 } from 'base64-js';
import { MEDIA_CHUNK_BYTES } from './envelope';
import {
  loadPhoneState,
  savePhoneState,
  clearPhoneState,
  loadSeenIds,
  saveSeenIds,
  type PhoneState,
} from './storage';
import {
  CatalogChunkCollector,
  BoardChunkCollector,
  WorkPlanChunkCollector,
  FeedOverlay,
  applyCatalogState,
  applyHistoryPage,
  applySessionEvent,
  applyBoardState,
  applyWorkPlanState,
  nextRunningSet,
  shouldDropForeignChatEvent,
  packCatalogSyncBody,
  packBoardSyncBody,
  packWorkPlanSyncBody,
} from './syncReducer';
import { getSyncDb, type SyncDb, type ReceivedFileRow } from '../db/syncDb';
import { Platform } from 'react-native';

/**
 * 手机自报名（配对时发给中继/桌面的 device 名）：运行时取系统 厂商+型号（如 "HONOR Magic8"），
 * 取不到回退通用名——源码不落任何私人设备数据（公开发布判据）。
 */
function deviceSelfName(): string {
  const c = Platform.constants as { Manufacturer?: string; Model?: string } | undefined;
  const maker = (c?.Manufacturer ?? '').trim();
  const model = (c?.Model ?? '').trim();
  if (maker && model) return maker === model ? model : `${maker} ${model}`;
  return model || maker || 'Android 手机';
}

export interface QrPayload {
  v: number;
  relay: string;
  deskPub: string;
  caFP: string;
  token: string;
  name: string;
}

export type SessionState =
  | 'need-pairing' // 无本地配对状态（或重装丢密钥）→ 引导扫码
  | 'redeeming'
  | 'waiting-confirm'
  | 'paired'
  | 'conflict' // 409：令牌已被使用，可能泄露
  | 'expired' // 410：令牌过期
  | 'orphan-revoked' // confirm 超时已自注销
  | 'error';

export interface ApprovalCardInfo {
  id: string; // toolCallId
  kind: string; // 'write' | 'command'
  summary: string; // 人类可读摘要（卡片标题；resolved 重发整卡时保留）
  preview?: string;
  timeoutAt?: number; // epoch ms（桌面侧死线；倒计时为本地近似显示）
  /** 桌面操作审批标记（信封 additive）：true 时渲染「本次会话放行」第三钮——对齐桌面 CLI [s]/桌面 UI 语义 */
  sessionGrantable?: boolean;
  /** 来源会话归因（信封 additive；null/缺省=无归因全局请示——呈现分流判据：有归因钉来源会话/无归因走全局浮层） */
  sessionId?: string | null;
  settled?: { approved: boolean; by: string }; // 收到 approval.resolved 后落定
  /** 请求到达时刻（epoch ms，信封 env.ts；位置坐标：快照注入钉回请求时刻；首次捕获为准，重推不刷新） */
  requestTs?: number;
  /** 落定时刻（epoch ms；卡片快照 TTL 窗口的数据源） */
  settledAt?: number;
}

/** M4e 通用提问卡（kind='ask' 时携带；与审批卡同构——回答为选项 label 原文或自由文本） */
export interface AskCardInfo {
  id: string;
  question: string; // 问题全文（自带语境与规划预览；resolved 重发整卡时保留）
  options?: { label: string; description: string }[];
  allowFreeText?: boolean;
  hint?: string; // 自由文本输入占位提示
  /** 改进提案点选裁决卡载荷（additive 可选；形状校验有效才渲染 TriageCard，否则落回文本问答卡） */
  card?: AskTriageCard;
  /** 来源会话归因（信封 additive；null/缺省=无归因全局请示——呈现分流判据） */
  sessionId?: string | null;
  settled?: { answer: string; by: string }; // 收到 ask.resolved 后落定
  /** 请求到达时刻（epoch ms，信封 env.ts；位置坐标：快照注入钉回请求时刻；首次捕获为准，重推不刷新） */
  requestTs?: number;
  /** 落定时刻（epoch ms；卡片快照 TTL 窗口的数据源） */
  settledAt?: number;
}

/** 卡片快照的灰卡窗口（对齐 core 落定环 TTL：30min；pending 永不淘汰） */
const SETTLED_CARD_TTL_MS = 30 * 60 * 1000;

/** M4b 工具行可展开详情（kind='status' 时携带；全量永远留桌面，只有摘要/预览上手机） */
export interface ToolDetail {
  name: string;
  status: 'running' | 'pending' | 'success' | 'failed' | 'rejected';
  paramsSummary?: string;
  resultPreview?: string;
}

export interface ChatMessage {
  id: string;
  dir: 'in' | 'out';
  text: string;
  kind: string;
  ts: number;
  streaming?: boolean;
  approval?: ApprovalCardInfo; // kind='approval' 时携带
  ask?: AskCardInfo; // M4e：kind='ask'（提问卡）时携带
  toolDetail?: ToolDetail; // M4b：kind='status'（工具行）时携带，点开展开
  /** file.* 协议族：kind='media' 且 refs 命中时携带（渲染分支见 syncUiLogic）——localUri 空=本机无副本（换机/清数据），图片诚实降级占位、文件芯片永不降级 */
  media?: { items: MediaItem[] };
  /** 统一回声确认退休（kind='notice' 时携带）：该锚点是否有过任何 chat.event 活动（delta/reasoning/tool）——
   *  false=拒绝型 notice（收录前守卫拦截，用户行永不落盘→气泡按信号退休）；
   *  true=中止/失败/拦截回执（用户行已收录→气泡继续等 DB 回声，streaming 节拍卡按信号退休） */
  roundStarted?: boolean;
  /** d→m 文件卡片（kind='fileOffer' 时携带；五态状态机的持久真相源 = syncDb.receivedFiles） */
  fileCard?: FileCardInfo;
  /** 会话归属戳（chat.event 透传/回显盖戳；缺省=无戳旧桌面兼容，UI 层 allowsMessageForSession 放行） */
  sessionId?: string;
}

/** d→m 收件五态（receivedFiles.state 列的合法值） */
export type ReceivedFileState = 'offered' | 'pulling' | 'done' | 'failed' | 'expired';

/** d→m 文件卡片视图载荷（session 事件与 UI 历史合并共用同构对象） */
export interface FileCardInfo {
  fileId: string;
  /** 归属会话（offer.sessionId；孤儿[会话已删]/缺省已在落库前回退为当前查看会话） */
  sessionId: string | null;
  /** sanitizeFileName 清洗后的展示/落盘名（不携路径） */
  name: string;
  mime: string;
  size: number;
  expiresAt: number | null;
  state: ReceivedFileState;
  /** pulling 态进度（明文口径：已认证追加 / 总字节） */
  progress?: { received: number; total: number };
  /** 暂停（取消/清扫复位回 offered）前的最后已知进度——仅内存态，DB 不落（重启退化为普通接收卡） */
  lastProgress?: { received: number; total: number };
  /** failed 态原因（人类可读） */
  error?: string;
  /** done 态 [打开] 用 content URI */
  contentUri?: string;
}

/** receivedFiles 行 → 卡片载荷（session 落库/清扫发事件与 UI 历史合并的同一映射点） */
export function receivedFileRowToCard(row: ReceivedFileRow): FileCardInfo {
  return {
    fileId: row.fileId,
    sessionId: row.sessionId,
    name: row.name,
    mime: row.mime,
    size: row.size,
    expiresAt: row.expiresAt,
    state: (row.state as ReceivedFileState) || 'offered',
    ...(row.error ? { error: row.error } : {}),
    ...(row.contentUri ? { contentUri: row.contentUri } : {}),
  };
}

/**
 * ②B 迟到锚定计算（纯函数；锚定编排=anchorPendingReceivedFiles，门 a 在 UI 钩子侧）。
 * 定义在此而非 syncUiLogic：syncUiLogic 已值依赖本模块（receivedFileRowToCard），
 * 反向 import 会构成运行时循环（Metro 风险）——保持 syncUiLogic → session 单向。
 * 门 b（有效性，同钟系）：floor 非空且 lastMessageTs > floor 才锚（两操作数均桌面钟；
 * floor=null——空会话首卡/存量回填前——不锚，保持现状位）；同毫秒理论边（last==floor）接受不锚。
 * 多卡按 createdAt 递增 +1/+2… 保序；返回本轮可锚定集合（空=本轮无锚定动作）。
 */
export function computeAnchorTs(
  pending: Array<{ fileId: string; createdAt: string; anchorFloorTs: number | null }>,
  lastMessageTs: number,
): Array<{ fileId: string; anchorTs: number }> {
  const eligible = pending
    .filter((p) => p.anchorFloorTs !== null && lastMessageTs > p.anchorFloorTs)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return eligible.map((p, i) => ({ fileId: p.fileId, anchorTs: lastMessageTs + 1 + i }));
}

/** media 行的附件条目（refs 与本地登记表联查的产物） */
export interface MediaItem {
  ref: string;
  name: string;
  mime: string;
  kind: 'image' | 'file';
  localUri: string | null;
}

export type SessionEvent =
  | { type: 'state'; state: SessionState; detail?: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'peer'; name: string }
  | { type: 'connection'; connected: boolean }
  | { type: 'mode'; mode: string } // M5：权限模式落定（mode.state 回流是徽标变化的唯一触发——本地不假落定）
  | { type: 'alarm'; text: string }
  // ---------- M6 会话同步（UI 通知口；类五三屏消费，本期 UI 不消费则安全忽略） ----------
  | { type: 'catalog' } // 目录已更新（catalog.state 落库完成 / session.event 目录行变更）：UI 重读 listSessions 刷新
  | { type: 'history'; sessionId: string; invalidated?: boolean; intent?: 'older' } // 某会话历史页落库：UI 重读该会话消息；invalidated=true=副本失效重写（真相重置，UI 需清已闭合 overlay 卡）；intent='older'=上翻补页应答（UI prepend 保持窗口，不重置到最新）
  | { type: 'attached'; sessionId: string | null } // 附着确认/被动变更（attached.changed 回流；呈现以桌面为准）
  | { type: 'activeSession'; sessionId: string | null } // 桌面当前会话（M6b：仅供信息，UI 徽标不再跟随）
  | { type: 'lastChat'; sessionId: string | null } // M6b：入口记忆变化（"📱正在聊"徽标/默认聊天屏目标的数据源）
  | { type: 'sessionDeleted'; sessionId: string } // 附着会话被桌面删除：UI 返回会话列表并提示
  | { type: 'presence'; online: boolean } // M6c：桌面在线探活（绿点=已连中继且近期有桌面来信；45s 无证据→离线）
  | { type: 'board'; sessionId: string } // M7：board.state 落库完成（或会话删除级联清板）：UI 重读该会话看板行与标量
  | { type: 'workplan'; sessionId: string } // workplan.state 落库完成（或会话删除级联清树）：UI 重读该会话工作计划树
  | { type: 'running' } // 运行态标志：运行中会话集合变化（running.changed/catalog 对账/断连清空）——列表"运行中"转圈的唯一数据源
  | { type: 'feed'; taskId?: string } // V2：feed.subagent 事实落位（latest-wins overlay）：UI 重读该任务工具细节
  // ---------- M8 命令面（cmd.*：占用环/会话 sheet 值的唯一落定来源——本地不假落定） ----------
  | { type: 'cmdState'; state: CommandStateSnapshot; catalog?: CommandCatalogEntry[] } // cmd.state 落定（latest-wins）
  | { type: 'cmdResult'; replyTo: string; ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } // 命令应答（选项/结果/诚实错误；按 replyTo 幂等匹配）
  | { type: 'roundSettled'; sessionId: string } // M6c：附着会话的一轮真正落定（闭合 overlay 锚点的唯一通路：本地镜像轮无 final）
  // ---------- file.* 协议族（附件上传：receipt 是传输状态收敛的唯一落定来源——本地不假落定） ----------
  | { type: 'fileReceipt'; fileId: string; ok: boolean; error?: string }
  // ---------- d→m 文件接收（卡片五态的唯一落定来源=receivedFiles 落库后的事件；本地点击只发意图） ----------
  | { type: 'fileOffer'; card: FileCardInfo } // 新要约落库完成（卡片按归属会话出现）
  | { type: 'fileProgress'; fileId: string; received: number; total: number } // 拉取进度（回调直报，不走原生事件）
  | { type: 'fileState'; fileId: string; state: ReceivedFileState; error?: string; contentUri?: string }
  | { type: 'fileAnchored'; sessionId: string }; // ②B 迟到锚定落库完成（UI 独立 setter 更新活卡 ts；本地事件非协议）

type Listener = (e: SessionEvent) => void;

/** M8 命令回执（cmd.result 的提炼形状；requestCmd 的返回类型） */
export interface CmdResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/** M6c 探活节奏：前台 30s 一拍；连续无应答退避到 2min；45s 无任何桌面来信判离线 */
const PRESENCE_INTERVAL_MS = 30_000;
const PRESENCE_BACKOFF_MS = 120_000;
const PRESENCE_STALE_MS = 45_000;
const REDEEM_RETRIES = 5;

export class RelaySession {
  private listeners = new Set<Listener>();
  private state: PhoneState | null = null;
  private ws: WebSocket | null = null;
  private dedupe = new DedupeSet(4096);
  private seenLoaded = false;

  /** 惰性恢复已见 id；新 id 落盘 */
  private async ensureSeenLoaded(): Promise<void> {
    if (this.seenLoaded) return;
    this.seenLoaded = true;
    try {
      const ids = await loadSeenIds();
      console.log(`[chill-dbg] 恢复已见 id ${ids.length} 条`);
      if (ids.length) this.dedupe = new DedupeSet(4096, ids);
    } catch { /* 恢复失败不影响主流程 */ }
  }

  private markAndPersist(id: string): boolean {
    const isNew = this.dedupe.mark(id);
    if (isNew) void saveSeenIds(this.dedupe.snapshot()).catch(() => {});
    return isNew;
  }
  /** 撤销去重标记并重存（记账滞后于事实）：处理失败路径专用——不 ACK 等服务器重投可重处理。
   *  回滚必须重存快照：否则磁盘残留该 id，重启后重投仍被去重丢弃（缺陷原地复活）。 */
  private unmarkAndPersist(id: string): void {
    this.dedupe.delete(id);
    void saveSeenIds(this.dedupe.snapshot()).catch(() => {});
  }
  private deskName = '';
  private secrets: ReturnType<typeof deriveSecrets> | null = null;
  private myBox = '';
  private deskBox = '';
  private mac = '';
  private confirmed = false;
  /** M5：最近一次 mode.state 落定的权限模式（null=未同步；真相源在桌面 core） */
  private permissionMode: string | null = null;

  /** M5：当前已同步的权限模式（徽标渲染用；null=未同步） */
  getPermissionMode(): string | null {
    return this.permissionMode;
  }

  // ---------- M8 命令面状态（内存 latest-wins，不落库；重连 cmd.sync 收敛） ----------
  private cmdStateSnap: CommandStateSnapshot | null = null;
  private cmdCatalog: CommandCatalogEntry[] | null = null;

  /** M8：最近一次 cmd.state 落定的命令面状态快照（null=未同步） */
  getCommandState(): CommandStateSnapshot | null {
    return this.cmdStateSnap;
  }

  /** M8：命令目录（cmd.sync 应答携带；null=未同步。渲染容错：未知 presentation/section 折叠为 console-row 或跳过） */
  getCommandCatalog(): CommandCatalogEntry[] | null {
    return this.cmdCatalog;
  }

  private stopped = false;
  private reconnectAttempt = 0;
  /** 已落定的轮次锚点：final 到达后，同锚迟到信封（重投/乱序）一律丢弃 */
  private closedAnchors = new Set<string>();
  /** M4b 节拍表：轮次锚点 → 节拍序号 → 该节拍的缓冲。
   *  内容按 seq 分片存、组装时归位（信道 at-least-once 且重投可乱序——实测信封 1 落到队尾造成旋转文本；
   *  无 seq 的旧端按到达序追加，sort 稳定不扰乱）；thinkClosed=思考区已收敛（开做即收/新拍即收/final 兜底） */
  private beats = new Map<string, Map<number, { thinkParts: { seq?: number; text: string }[]; contentParts: { seq?: number; text: string }[]; thinkClosed: boolean }>>();
  /** 锚点活动登记（delta/reasoning/tool 任一到达即记）：notice 的 roundStarted 判定数据源——
   *  拒绝型 notice（收录前拦截）的锚点必无活动；锚点落定（closeAnchor）时清除 */
  private anchorActivity = new Set<string>();
  /** M4：审批卡片缓存（resolved 到达时合并请求信息重发整卡，原位变灰） */
  private approvalCards = new Map<string, ApprovalCardInfo>();
  /** M4e：提问卡片缓存（resolved 到达时合并请求信息重发整卡，原位变灰） */
  private askCards = new Map<string, AskCardInfo>();

  // ---------- 归因分流的呈现事实源（规划 v5：单一事实源） ----------
  /** 当前查看会话 id 镜像（"查看中"语义：ChatScreen focus 写 / blur 与 unmount clear-if-mine 清；
   *  App 浮层门控与 ChatScreen message 过滤同读这一处——消除 params/effectiveId 平行源） */
  private viewingSessionId: string | null = null;
  private viewingListeners = new Set<(id: string | null) => void>();

  /** 查看会话变化订阅（App 门控重求值用；返回退订函数） */
  onViewingSessionChange(cb: (id: string | null) => void): () => void {
    this.viewingListeners.add(cb);
    return () => this.viewingListeners.delete(cb);
  }

  getViewingSessionId(): string | null {
    return this.viewingSessionId;
  }

  /** 写入（同值幂等——不通知，防无谓重算） */
  setViewingSessionId(id: string | null): void {
    if (this.viewingSessionId === id) return;
    this.viewingSessionId = id;
    for (const cb of this.viewingListeners) cb(id);
  }

  /** 条件化清除（clear-if-mine）：仅当前镜像值===mineId 才置 null。
   *  Chat→Chat push 倒挂（React effects 子先父后：新屏已写、旧屏 blur 后到）时
   *  mine≠当前值不命中不动——终值保持新屏；pop 返回时命中清 null→前屏 focus 重写。 */
  clearViewingSessionIdIfMine(mineId: string): void {
    if (this.viewingSessionId === null || this.viewingSessionId !== mineId) return;
    this.viewingSessionId = null;
    for (const cb of this.viewingListeners) cb(null);
  }

  /** 卡片快照（快照注入与浮层派生的共同数据面）：pending 全量 + 落定 SETTLED_CARD_TTL_MS 内灰卡；
   *  读取时惰性剔除超窗灰卡（对齐 core 落定环纪律——pending 永不淘汰，待答卡不可能被误删） */
  getCardsSnapshot(): { ask: AskCardInfo[]; approval: ApprovalCardInfo[] } {
    const now = Date.now();
    for (const [k, c] of this.askCards) {
      if (c.settledAt !== undefined && now - c.settledAt > SETTLED_CARD_TTL_MS) this.askCards.delete(k);
    }
    for (const [k, c] of this.approvalCards) {
      if (c.settledAt !== undefined && now - c.settledAt > SETTLED_CARD_TTL_MS) this.approvalCards.delete(k);
    }
    return { ask: [...this.askCards.values()], approval: [...this.approvalCards.values()] };
  }

  // ---------- M6 会话同步状态 ----------
  /** 附着意图锚（= syncState.attachedSessionId 的内存镜像；对账规则以其为准） */
  private attachedIntent: string | null = null;
  /** 桌面当前会话（active.changed 落定；M6b 起仅供信息，UI 徽标不跟随） */
  private activeSessionId: string | null = null;
  /** M6b：入口记忆内存镜像（= syncState.lastChatSessionId；"📱正在聊"徽标与默认聊天屏目标的数据源） */
  private lastChatSessionId: string | null = null;
  /** M6b：'new' 发言待收编标记——桥轮前附着后 attached.changed 回流真实 id 时采纳（不发 attach 'new'） */
  private pendingNewChat = false;
  /** 冷启动标记（进程首连）：冷启动有附着记录先 attach{null} 显式脱离；其后为热重连语义 */
  private coldStart = true;
  /** catalog.state 分片归组器（同 replyTo） */
  private catalogCollector = new CatalogChunkCollector();
  /** M7：board.state 分片归组（同 replyTo；仿 catalogCollector） */
  private boardCollector = new BoardChunkCollector();
  /** workplan.state 分片归组（同 replyTo；仿 boardCollector） */
  private workPlanCollector = new WorkPlanChunkCollector();
  /** V2：Worker 事实流 overlay（latest-wins 归并,不落库;会话切换/重配清空） */
  private feedOverlay = new FeedOverlay();
  /** 附着会话尾部拉齐防抖（metadata.upsert 触发；本地镜像轮 final 不经桥推，经此收敛） */
  private tailPullTimer: ReturnType<typeof setTimeout> | null = null;
  /** M6b 修复：附着会话的活轮标记（delta/reasoning/tool 到达=进行中；final/notice=结束）——
   *  活轮期间挂起尾部拉齐（轮中"最新页"是移动目标，拉回的是仍在流式的内容，只会造成 DB 副本与
   *  overlay 双份渲染——新会话首轮重复渲染事故的根因之一），final/notice 一到立即冲刷收敛 */
  private liveRoundSessionId: string | null = null;
  /**
   * 未退休发送气泡停车场（切会话保命，2026-10-05）：ChatScreen 卸载/切换时把 overlay 中
   * dir='out' 气泡存入（组件状态本会随重挂载清零——DB 副本轮中不拉，"overlay 已清+DB 陈旧"
   * 双空=用户消息消失事故根源）；重进时取走注入 overlay，DB 回声退休（clientId=env.id）接管清除。
   * 照 ask/approval 卡快照注入先例（injectCardsSnapshot）。
   */
  private parkedBubbles = new Map<string, ChatMessage[]>();
  /** 运行态标志（volatile，不落库）：桌面宿主当前在跑轮次的会话全集（列表转圈数据源）。
   *  三更新路径：running.changed（增量/runningAll 整替）/ catalog.state.runningSessionIds（重连对账
   *  整替）/ 断连清空（真相未知=诚实不显示）。硬不变量：只碰本集合——禁触 liveRoundSessionId/overlay 记账。 */
  private runningSessions = new Set<string>();
  /** attached.changed 重 announce 环防护：上次重 announce 的意图值（同值不重复发） */
  private lastReannounced: string | null | undefined = undefined;
  /** 各会话历史翻页完成态（history.page done 落定；invalidated 时清除） */
  private historyDoneBySession = new Map<string, boolean>();
  /** 在途上翻请求登记簿（asOlder 请求发出登记，应答 replyTo 配对消费；见 pendingOlderTracker.ts） */
  private pendingOlder = new PendingOlderTracker();

  // ---------- M6c 桌面在线探活（"绿点不骗人"） ----------
  /** 桌面在线：近期收到过任何桌面来信。初始 false = 诚实默认（不连接就灰，不假设绿色） */
  private desktopOnline = false;
  /** 最近一次桌面来信时刻（任何已验证信封都计入——pong 只是空闲期的保活证据） */
  private lastDesktopAliveAt = 0;
  /** 前台探活开关（AppState 驱动）：后台不发 ping——堆积被前台时长严格限住 */
  private presenceActive = false;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 连续无应答计数（≥3 → 退避 30s→2min：桌面没开时信箱零负担） */
  private presenceMisses = 0;

  /** M6 副本库（配对态就绪后才打开——agentId=deskBox 由 deskPub 派生） */
  private db(): SyncDb | null {
    if (!this.state) return null;
    try {
      return getSyncDb();
    } catch {
      return null; // 原生库不可用（如 jest 环境无桩）：同步功能降级，聊天主路径不受影响
    }
  }

  /** M6：当前 Agent id（= 对端 deskPub 指纹 = deskBox，配对时派生） */
  private get agentId(): string {
    return this.deskBox;
  }

  /** M6：附着意图读取（syncState 内存镜像；类五 UI 附着/脱离用） */
  getAttachedSessionId(): string | null {
    return this.attachedIntent;
  }

  /** M6：桌面当前会话（active.changed 落定；null=未知/无） */
  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /** M6：当前 Agent id（= 对端 deskPub 指纹 = deskBox；类五 UI 读副本库用） */
  getAgentId(): string {
    return this.agentId;
  }

  /** M6：该会话历史是否已翻到最早（history.page done 落定；true=桌面无更早消息） */
  isHistoryComplete(sessionId: string): boolean {
    return this.historyDoneBySession.get(sessionId) === true;
  }

  /** M6b：入口记忆读取（点"我的桌面"进哪个会话；null=从未聊过/已被清 → 新会话界面） */
  getLastChatSessionId(): string | null {
    return this.lastChatSessionId;
  }

  /** M6b：入口记忆写入（进入聊天屏/浮层直达/'new' 收编时调用；内存镜像 + syncState 落库 + 事件） */
  async setLastChatSession(sessionId: string | null): Promise<void> {
    if (this.lastChatSessionId === sessionId) return;
    this.lastChatSessionId = sessionId;
    const db = this.db();
    if (db) {
      const prev = await db.getSyncState(this.agentId);
      await db.putSyncState({
        agentId: this.agentId,
        attachedSessionId: prev?.attachedSessionId ?? null,
        projectsRev: prev?.projectsRev ?? null,
        catalogSyncedAt: prev?.catalogSyncedAt ?? null,
        expandedProjectsJson: prev?.expandedProjectsJson ?? null,
        lastChatSessionId: sessionId,
      });
    }
    this.emit({ type: 'lastChat', sessionId });
  }

  /** 分片按 seq 归位组装（无 seq 分片保持到达序；sort 稳定，Infinity 键不扰乱既有顺序） */
  private static assembleParts(parts: { seq?: number; text: string }[]): string {
    return parts
      .slice()
      .sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity))
      .map((p) => p.text)
      .join('');
  }

  /** 节拍缓冲存取（不存在则建） */
  private beatBuf(anchor: string, beat: number): { thinkParts: { seq?: number; text: string }[]; contentParts: { seq?: number; text: string }[]; thinkClosed: boolean } {
    let m = this.beats.get(anchor);
    if (!m) {
      m = new Map();
      this.beats.set(anchor, m);
    }
    let b = m.get(beat);
    if (!b) {
      b = { thinkParts: [], contentParts: [], thinkClosed: false };
      m.set(beat, b);
    }
    return b;
  }

  /** 锚点落定（final）：closedAnchors 有界登记 + 释放节拍缓冲（块已 emit，缓冲无存在必要） */
  private closeAnchor(anchor: string): void {
    this.closedAnchors.add(anchor);
    this.anchorActivity.delete(anchor);
    if (this.closedAnchors.size > 512) {
      const oldest = this.closedAnchors.values().next().value;
      if (oldest !== undefined) {
        this.closedAnchors.delete(oldest);
        this.beats.delete(oldest);
        this.anchorActivity.delete(oldest);
      }
    }
  }

  // ---------- 本地镜像轮合成锚（2026-10-07 · 规划 v2 T2）----------
  // 桌面本地轮（回流/定时/goalTick/桌面输入）按协议无 replyTo 锚（PROTOCOL-FROZEN:54「手机据此归位」），
  // 此前手机端按「桌面恒定带锚」的错误假设一律丢弃——本地轮实时流在手机上只剩工具痕迹。
  // 合成轮次锚赋予本地轮与手机轮同等的聚合路径；UI 收口零改动（roundSettled 闭锚 + 回声退休天然接管）。
  /** 每会话合成锚状态：实例计数（跨轮不复用，防 UI 同 id 替换跨轮覆盖）+ 活锚 + 当前轮见过的最大节拍 + 开门信号 */
  private mirrorAnchors = new Map<string, { seq: number; active: string | null; seenBeat: number; openSignal: boolean }>();

  /**
   * 无锚流式 chunk 的轮次归属判定（本地镜像轮专用；手机轮恒有锚不经此）：
   * - 活锚 + 开门信号（TURN_STARTED→running.changed(true)，每轮必发且无镜像门控）= 新一轮开始
   *   （settle 丢失时亦收敛，两轮不拼同一张卡；同轮节拍推进与新轮在 beat 轴上不可区分，
   *   活锚期间换轮只能靠开门信号）：关旧开新；
   * - 活锚 + 无开门 = 同轮继续，复用（乱序重投由聚合层 seq 归位与长者胜覆盖愈合）；
   * - 无活锚 + 开门 ∨ beat > 见过最大节拍 = 开新锚（前者覆盖桌面 cell 复位（beat 归零）——开门是
   *   唯一可辨信号；后者兜底开门丢失时的接续递增场景）；
   * - 其余（无活锚、无开门、beat ≤ 见过最大节拍）= 已关轮迟到重投，丢弃（保守：内容经尾拉/DB REPLACE 收敛不丢）。
   * 依赖声明：判据依赖桌面 beat 在 cell 未复位期间���调递增（现状行为，协议未承诺）——若失效退化
   * 为现状体验（丢实时不丢内容）；升级路径=桌面 additive turnSeq（规划方案 D）。
   */
  private resolveMirrorAnchor(sessionId: string | null, beat: number): string | null {
    if (sessionId === null) return null;
    let st = this.mirrorAnchors.get(sessionId);
    if (!st) {
      st = { seq: 0, active: null, seenBeat: -1, openSignal: false };
      this.mirrorAnchors.set(sessionId, st);
    }
    if (st.active !== null) {
      if (st.openSignal) this.closeMirrorAnchor(sessionId);
      else {
        st.seenBeat = Math.max(st.seenBeat, beat);
        return st.active;
      }
    }
    if (st.openSignal || beat > st.seenBeat) {
      st.seq += 1;
      st.active = `mirror-${sessionId}-${st.seq}`;
      st.openSignal = false;
      st.seenBeat = beat;
      return st.active;
    }
    return null;
  }

  /** 关闭该会话活合成锚（round.settled / attach 切换 / 新轮开门三处）：登记 closedAnchors + 同步释放节拍缓冲（对齐 final 路径纪律） */
  private closeMirrorAnchor(sessionId: string): void {
    const st = this.mirrorAnchors.get(sessionId);
    if (!st || st.active === null) return;
    this.closeAnchor(st.active);
    this.beats.delete(st.active);
    st.active = null;
    st.openSignal = false;
  }

  /** TURN_STARTED 开门信号登记（running.changed 增量形态 running=true；整替快照不置——那是恢复态非轮始时刻） */
  private markMirrorOpen(sessionId: string): void {
    const st = this.mirrorAnchors.get(sessionId);
    if (st) st.openSignal = true;
    else this.mirrorAnchors.set(sessionId, { seq: 0, active: null, seenBeat: -1, openSignal: true });
  }

  /** 新节拍出现 = 旧节拍未闭合思考区立即收口（不等 final——长任务里"只想的节拍"不用等到最后） */
  private closeEarlierBeats(anchor: string, beat: number, envTs: number, sessionStamp: string | null): void {
    const m = this.beats.get(anchor);
    if (!m) return;
    for (const [bIdx, b] of m) {
      if (bIdx < beat && !b.thinkClosed && b.thinkParts.length > 0) {
        b.thinkClosed = true;
        this.emit({
          type: 'message',
          message: { id: `think-${anchor}-${bIdx}`, dir: 'in', text: RelaySession.assembleParts(b.thinkParts), kind: 'reasoning', ts: envTs, streaming: false, ...(sessionStamp !== null ? { sessionId: sessionStamp } : {}) },
        });
      }
    }
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: SessionEvent): void {
    for (const fn of this.listeners) fn(e);
  }
  private setState(state: SessionState, detail?: string): void {
    this.emit({ type: 'state', state, ...(detail !== undefined ? { detail } : {}) });
  }

  /** 启动：有配对状态则恢复会话，无则 need-pairing */
  async start(): Promise<void> {
    const saved = await loadPhoneState();
    if (!saved) {
      this.setState('need-pairing');
      return;
    }
    this.state = saved;
    this.confirmed = saved.confirmed;
    this.setupCrypto();
    this.deskName = saved.deskName ?? '';
    if (this.confirmed) await this.initSyncState(); // M6：副本库 + 附着意图恢复
    this.setState(this.confirmed ? 'paired' : 'waiting-confirm');
    this.connectWs();
    if (!this.confirmed) this.armConfirmTimeout();
  }

  /** M6：副本库初始化 + 附着意图/入口记忆恢复进内存镜像（agents 行在 pair.confirm 时 upsert） */
  private async initSyncState(): Promise<void> {
    const db = this.db();
    if (!db) return;
    const st = await db.getSyncState(this.agentId);
    this.attachedIntent = st?.attachedSessionId ?? null;
    this.lastChatSessionId = st?.lastChatSessionId ?? null;
  }

  private setupCrypto(): void {
    const s = this.state!;
    const kp = keyPairFromSecretKey(s.secretKey);
    s.publicKey = kp.publicKey; // 防御性校正
    this.secrets = deriveSecrets(ecdhShared(s.secretKey, s.deskPub));
    this.myBox = mailboxIdFromPub(s.publicKey);
    this.deskBox = mailboxIdFromPub(s.deskPub);
    this.mac = pairingMAC(s.token, s.deskPub, s.publicKey);
  }

  /** 扫码配对入口（qrJson 为 QR 内容文本；caFP 不符即拒） */
  async pair(qrJson: string): Promise<void> {
    let qr: QrPayload;
    try {
      qr = JSON.parse(qrJson) as QrPayload;
    } catch {
      this.setState('error', '二维码内容不是合法 JSON');
      return;
    }
    if (qr.caFP && qr.caFP !== CA_FP) {
      this.setState('error', 'caFP 与本 App 内置 CA 不符，可能是伪造中继，中止配对');
      return;
    }
    this.deskName = qr.name;
    this.emit({ type: 'peer', name: qr.name });

    // 恢复或新建密钥对；redeem 发出前必须先持久化
    const saved = await loadPhoneState();
    if (!saved || saved.token !== qr.token) {
      const kp = generateKeyPair();
      this.state = {
        secretKey: kp.secretKey,
        publicKey: kp.publicKey,
        token: qr.token,
        deskPub: qr.deskPub,
        relay: qr.relay,
        name: deviceSelfName(),
        deskName: qr.name, // M6：agents 表 name 字段数据源（QR 的桌面设备名）
        confirmed: false,
        helloSent: false,
      };
      await savePhoneState(this.state);
    } else {
      this.state = saved;
      this.state.deskName = qr.name; // 重配对刷新桌面名
      await savePhoneState(this.state);
    }
    this.setupCrypto();
    await this.redeem();
  }

  private async redeem(): Promise<void> {
    const s = this.state!;
    this.setState('redeeming');
    const body = {
      phonePub: s.publicKey,
      deskPub: s.deskPub,
      device: s.name,
      writeHash: tokenHash(this.secrets!.writeToken),
      readHash: tokenHash(this.secrets!.readToken),
      revokeHash: tokenHash(this.secrets!.revokeToken),
    };
    for (let attempt = 1; attempt <= REDEEM_RETRIES; attempt++) {
      let r;
      try {
        r = await httpJson('POST', s.relay, '/pair/redeem', { token: s.token, body });
      } catch {
        await sleep(2000); // 网络错误：同一持久化密钥对续传
        continue;
      }
      if (r.status === 200) {
        await this.afterRedeem();
        return;
      }
      if (r.status === 409) {
        this.setState('conflict');
        return;
      }
      if (r.status === 410) {
        this.setState('expired');
        return;
      }
      this.setState('error', `redeem 失败: HTTP ${r.status}`);
      return;
    }
    this.setState('error', 'redeem 多次网络失败（密钥对已保留，重开 App 可续传）');
  }

  private async afterRedeem(): Promise<void> {
    const s = this.state!;
    // pair.hello 只发一次（含 pairingMAC）
    if (!s.helloSent) {
      const hello = makeEnvelope('pair.hello', this.myBox, this.deskBox, {
        device: s.name,
        mac: this.mac,
      });
      const wire = encryptEnvelope(this.secrets!.keyM2D, this.deskBox, 'm2d', hello);
      if (!wire) {
        this.setState('error', 'hello 超预算');
        return;
      }
      const r = await httpJson('POST', s.relay, `/box/${this.deskBox}`, {
        token: this.secrets!.writeToken,
        body: { blob: wire },
      });
      if (r.status !== 201) {
        this.setState('error', `hello 投递失败: HTTP ${r.status}`);
        return;
      }
      s.helloSent = true;
      await savePhoneState(s);
    }
    this.setState('waiting-confirm');
    this.connectWs();
    this.armConfirmTimeout();
  }

  /** confirm 10 分钟超时 → revoke 双信箱自注销（孤儿信箱双保险之手机侧） */
  private armConfirmTimeout(): void {
    void (async () => {
      await sleep(CONFIRM_TIMEOUT_MS);
      if (this.confirmed || this.stopped || !this.state) return;
      const s = this.state;
      await httpJson('DELETE', s.relay, `/box/${this.deskBox}`, { token: this.secrets!.revokeToken }).catch(() => {});
      await httpJson('DELETE', s.relay, `/box/${this.myBox}`, { token: this.secrets!.revokeToken }).catch(() => {});
      this.setState('orphan-revoked');
    })();
  }

  // ---------- WS 读信箱（断线指数退避重连；未 ACK 消息服务器自动补投） ----------

  private connectWs(): void {
    if (this.stopped || !this.state) return;
    // 防重连竞态双连：已有连接在握/在建时不再起新连接——
    // 否则两条 WS 在服务器侧"单活跃读者"规则下互踢（4000），表现为永远"重连中"
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const s = this.state;
    const ws = new WebSocket(`${s.relay.replace(/\/$/, '')}/box/${this.myBox}`, undefined, {
      headers: { authorization: `Bearer ${this.secrets!.readToken}` },
    });
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.emit({ type: 'connection', connected: true });
      // M4e 订阅信号（chat.sync）：手机侧连接建立即通知桌面重推未决审批/提问——
      // 手机重启/重连这一端没有既有信号触发桌面 resync（实测：卡已 ACK 信箱不重投，桌面未断连不 resync）
      void this.sendSyncPing();
      // M6：附着对账 + 目录对账 + 附着会话尾部拉齐（冷/热路径见方法注）
      void this.onConnectedSync();
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { id: number; blob: string };
        if (typeof m.id === 'number' && typeof m.blob === 'string') void this.handleBoxMessage(m);
      } catch {
        /* 畸形帧忽略 */
      }
    };
    ws.onclose = () => {
      this.emit({ type: 'connection', connected: false });
      // 运行态标志：断连=真相未知，清空转圈（诚实不显示；重连 catalog 对账恢复）
      this.applyRunning({ runningAll: [] });
      this.markDesktopOffline(); // M6c：WS 断 = 立刻判离线（对端证据链已断，不等 45s 超时）
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt++);
      setTimeout(() => this.connectWs(), delay);
    };
    ws.onerror = () => {
      /* 细节走 onclose 重连 */
    };
  }

  private async handleBoxMessage(m: { id: number; blob: string }): Promise<void> {
    const dec = decryptEnvelope(this.secrets!.keyD2M, this.myBox, 'd2m', m.blob);
    if (!dec.ok) {
      console.log(`[chill-dbg] box#${m.id} 解密失败，不 ACK`);
      this.emit({ type: 'alarm', text: '信封解密/AAD 校验失败，fail-closed 不 ACK' });
      return;
    }
    const env = dec.envelope;
    console.log(
      `[chill-dbg] box#${m.id} env.id=${env.id} type=${env.type} kind=${String(env.body['kind'] ?? '')} replyTo=${String(env.replyTo ?? '∅')} ts=${env.ts}`,
    );
    if (env.from !== this.deskBox || env.to !== this.myBox) return; // 对端不符丢弃
    if (!isTsFresh(env.ts)) return;
    if (!KNOWN_TYPES.has(env.type)) {
      await this.ack(m.id); // 未识别 type 丢弃（ACK 防重投）
      return;
    }
    // M6c：任何已验证的桌面来信 = "在线"证据（pong 与全部真实流量同权；绿点不骗人的数据源）
    this.markDesktopAlive();
    if (env.type === 'presence.pong') {
      await this.ack(m.id); // 证据已记账，ACK 收口
      return;
    }
    // file.* 协议族：桌面回执（receipt 门控的唤醒源；发事件供 UI 收敛传输状态）
    if (env.type === 'file.receipt') {
      const fileId = typeof env.body['fileId'] === 'string' ? env.body['fileId'] : '';
      const ok = env.body['ok'] === true;
      const error = typeof env.body['error'] === 'string' ? env.body['error'] : undefined;
      await this.ack(m.id);
      if (fileId) {
        this.resolveFileReceipt(fileId, ok, error);
        this.emit({ type: 'fileReceipt', fileId, ok, ...(error !== undefined ? { error } : {}) });
      }
      return;
    }
    if (env.type === 'pair.confirm') {
      if (env.body['mac'] !== this.mac) {
        this.emit({ type: 'alarm', text: 'pair.confirm MAC 校验失败，fail-closed' });
        return;
      }
      this.confirmed = true;
      if (this.state) {
        this.state.confirmed = true;
        await savePhoneState(this.state);
      }
      // M6：配对落定 = agents 表填充时机（agentId=deskPub 指纹，name 取 QR 的桌面设备名）
      const db = this.db();
      if (db && this.state) {
        await db.upsertAgent({
          agentId: this.agentId,
          name: this.state.deskName ?? this.deskName ?? '',
          deskPub: this.state.deskPub,
          addedAt: new Date().toISOString(),
        });
        await this.initSyncState();
      }
      await this.ack(m.id);
      this.setState('paired');
      // 首次配对落定即补跑连接同步序列：WS onopen 先于 confirm 到达（onopen 时 confirmed=false 会跳过），
      // 不在此补跑则首次配对后 catalog/附着对账要等下一次重连才发生（实测击穿）
      void this.sendSyncPing();
      void this.onConnectedSync();
      return;
    }
    if (!this.confirmed) return; // confirm 前只处理 pair.*（chat 本地不排队——发送侧本就未开放）
    if (env.type === 'approval.request' || env.type === 'approval.resolved') {
      await this.ensureSeenLoaded();
      if (!this.markAndPersist(env.id)) {
        await this.ack(m.id); // 重投去重
        return;
      }
      try {
        this.handleApprovalEnvelope(env);
        await this.ack(m.id);
      } catch (err) {
        // 记账滞后于事实：处理失败回滚去重标记，不 ACK 等重投可重处理（emit 不隔离监听器异常，同步分支同样可能抛）
        console.log(`[chill-dbg] approval 处理异常回滚标记: ${String(err)}`);
        this.unmarkAndPersist(env.id);
      }
      return;
    }
    // M5 权限模式广播：标量真相 latest-wins（去重后更新状态并发事件，徽标据此落定）
    if (env.type === 'mode.state') {
      await this.ensureSeenLoaded();
      if (!this.markAndPersist(env.id)) {
        await this.ack(m.id);
        return;
      }
      try {
        const mode = typeof env.body['mode'] === 'string' ? env.body['mode'] : '';
        if (mode) {
          this.permissionMode = mode;
          this.emit({ type: 'mode', mode });
        }
        await this.ack(m.id);
      } catch (err) {
        console.log(`[chill-dbg] mode.state 处理异常回滚标记: ${String(err)}`);
        this.unmarkAndPersist(env.id);
      }
      return;
    }
    // M8 命令面信封：state=标量真相 latest-wins（占用环/会话 sheet 值的唯一落定来源）；result=命令应答（replyTo 匹配）
    if (env.type === 'cmd.state' || env.type === 'cmd.result') {
      await this.ensureSeenLoaded();
      if (!this.markAndPersist(env.id)) {
        await this.ack(m.id); // 重投去重
        return;
      }
      try {
        if (env.type === 'cmd.state') {
          const body = env.body as Partial<{ state: CommandStateSnapshot; catalog: CommandCatalogEntry[] }>;
          if (body.state && typeof body.state === 'object') {
            this.cmdStateSnap = body.state;
            if (Array.isArray(body.catalog)) this.cmdCatalog = body.catalog;
            this.emit({
              type: 'cmdState',
              state: body.state,
              ...(Array.isArray(body.catalog) ? { catalog: body.catalog } : {}),
            });
          }
        } else {
          const body = env.body as Partial<{
            replyTo: string
            ok: boolean
            data: Record<string, unknown>
            error: { code: string; message: string }
          }>;
          if (typeof body.replyTo === 'string' && body.replyTo) {
            this.emit({
              type: 'cmdResult',
              replyTo: body.replyTo,
              ok: body.ok === true,
              ...(body.data && typeof body.data === 'object' ? { data: body.data } : {}),
              ...(body.error && typeof body.error === 'object' ? { error: body.error as { code: string; message: string } } : {}),
            });
          }
        }
        await this.ack(m.id);
      } catch (err) {
        console.log(`[chill-dbg] cmd 处理异常回滚标记: ${String(err)}`);
        this.unmarkAndPersist(env.id);
      }
      return;
    }
    if (env.type === 'ask.request' || env.type === 'ask.resolved') {
      await this.ensureSeenLoaded();
      if (!this.markAndPersist(env.id)) {
        await this.ack(m.id); // 重投去重
        return;
      }
      try {
        this.handleAskEnvelope(env);
        await this.ack(m.id);
      } catch (err) {
        console.log(`[chill-dbg] ask 处理异常回滚标记: ${String(err)}`);
        this.unmarkAndPersist(env.id);
      }
      return;
    }
    // d→m file.offer：桌面发文件到手机（拉取即同意——落库建卡即 ACK，用户点[接收]才拉字节）
    if (env.type === 'file.offer') {
      await this.ensureSeenLoaded();
      if (!this.markAndPersist(env.id)) {
        await this.ack(m.id); // 重投去重（落库本身幂等）
        return;
      }
      try {
        await this.handleIncomingFileOffer(env);
      } catch (err) {
        console.log(`[chill-dbg] file.offer 落库异常: ${String(err)}`);
        // 记账滞后于事实：回滚去重标记，不 ACK → 服务器重投可重处理（幂等兜底）
        this.unmarkAndPersist(env.id);
        return;
      }
      await this.ack(m.id);
      return;
    }
    // ---------- M6/M7 会话同步/看板/事实流信封（落库幂等；去重标记后处理，处理成功才 ACK） ----------
    if (env.type === 'catalog.state' || env.type === 'history.page' || env.type === 'session.event' || env.type === 'board.state' || env.type === 'workplan.state' || env.type === 'feed.subagent') {
      await this.ensureSeenLoaded();
      if (!this.markAndPersist(env.id)) {
        await this.ack(m.id); // 重投去重（落库本身幂等，去重只是省一次写）
        return;
      }
      try {
        if (env.type === 'catalog.state') await this.handleCatalogState(env);
        else if (env.type === 'history.page') await this.handleHistoryPage(env);
        else if (env.type === 'board.state') await this.handleBoardState(env);
        else if (env.type === 'workplan.state') await this.handleWorkPlanState(env);
        else if (env.type === 'feed.subagent') await this.handleFeedSubagent(env);
        else await this.handleSessionEvent(env);
      } catch (err) {
        console.log(`[chill-dbg] ${env.type} 落库异常: ${String(err)}`);
        // 记账滞后于事实：回滚去重标记，不 ACK → 服务器重投可重处理（幂等应用兜底）
        this.unmarkAndPersist(env.id);
        return;
      }
      await this.ack(m.id);
      return;
    }
    if (env.type !== 'chat.event') {
      await this.ack(m.id);
      return;
    }
    await this.ensureSeenLoaded();
    if (!this.markAndPersist(env.id)) {
      console.log(`[chill-dbg] env.id=${env.id} 去重命中（重复投递），ACK 后丢弃`);
      await this.ack(m.id);
      return;
    }
    try {
      await this.processChatEvent(env, m.id);
    } catch (err) {
      // 记账滞后于事实：chat.event 处理失败回滚去重标记，不 ACK 等重投可重处理
      console.log(`[chill-dbg] chat.event 处理异常回滚标记: ${String(err)}`);
      this.unmarkAndPersist(env.id);
    }
  }

  /** chat.event 主链处理（归属防线 + kind 分支 + 落定 ack）；分派层 try 包裹，失败回滚去重标记等重投。
   *  早退 ack 分支（归属防线丢弃/无锚 toolCallId/closedAnchors 迟到丢弃）属有意丢弃=正常已处理路径，不触发回滚。 */
  private async processChatEvent(env: Envelope, boxMsgId: number): Promise<void> {
    // 多会话并行串台根治（2026-10-05）：归属戳≠附着意图 = attach 冲刷/FIFO 在途/429 积压窗口的
    // 他会展流（F-1 在桌面修了"盖对章"，此处修"错章照渲染"——两半合拢闭环）。丢弃不渲染不记账；
    // 内容不丢：该会话落定尾拉/重进 entry pull 经 DB 收敛。旧桌面无戳（null）放行。
    const chunkSessionId = typeof env.body['sessionId'] === 'string' ? env.body['sessionId'] : null;
    if (shouldDropForeignChatEvent(chunkSessionId, this.attachedIntent)) {
      console.log(`[chill-dbg] chat.event 他会展流丢弃：归属 ${chunkSessionId} ≠ 附着 ${this.attachedIntent}（env.id=${env.id}）`);
      await this.ack(boxMsgId);
      return;
    }
    const kind = String(env.body['kind'] ?? 'final');
    const text = String(env.body['text'] ?? '');
    const truncated = env.body['truncated'] === true;
    // M6b 修复：活轮记账（只记附着会话）——delta/reasoning/tool=轮进行中（挂起尾部拉齐）；
    // final/notice=轮结束（冲刷挂起的拉齐：此刻拉"最新页"是收敛而非制造重复）
    if (chunkSessionId !== null && chunkSessionId === this.attachedIntent) {
      if (kind === 'final' || kind === 'notice') {
        this.liveRoundSessionId = null; // 手机轮的落定信号（本地镜像轮走 round.settled）
      } else {
        this.liveRoundSessionId = chunkSessionId;
      }
    }
    if (kind === 'tool') {
      // M4b 工具行：toolCallId 为块锚（running→success→…演化与重投天然收敛）；落定锚点后迟到丢弃
      const toolCallId = typeof env.body['toolCallId'] === 'string' ? env.body['toolCallId'] : '';
      if (!toolCallId) {
        await this.ack(boxMsgId); // 无锚块不产出
        return;
      }
      if (typeof env.replyTo === 'string' && this.closedAnchors.has(env.replyTo)) {
        await this.ack(boxMsgId);
        return;
      }
      // 工具开始 = 想完开做：当前节拍思考区立即收口（思考文本在模型发出工具调用那一刻已停止生长，
      // 不必等工具完成/下一节拍开始——与"首个正文 delta 收敛"对称）
      if (typeof env.replyTo === 'string') {
        const beat = typeof env.body['beat'] === 'number' ? env.body['beat'] : 0;
        const b = this.beats.get(env.replyTo)?.get(beat);
        if (b && !b.thinkClosed && b.thinkParts.length > 0) {
          b.thinkClosed = true;
          this.emit({
            type: 'message',
            message: { id: `think-${env.replyTo}-${beat}`, dir: 'in', text: RelaySession.assembleParts(b.thinkParts), kind: 'reasoning', ts: env.ts, streaming: false, ...(chunkSessionId !== null ? { sessionId: chunkSessionId } : {}) },
          });
        }
      }
      if (typeof env.replyTo === 'string') this.anchorActivity.add(env.replyTo);
      this.emit({        type: 'message',
        message: {
          id: `tool-${toolCallId}`,
          dir: 'in',
          text,
          kind: 'status',
          ts: env.ts,
          ...(chunkSessionId !== null ? { sessionId: chunkSessionId } : {}),
          ...(env.body['detail'] !== undefined && typeof env.body['detail'] === 'object'
            ? { toolDetail: env.body['detail'] as ToolDetail }
            : {}),
        },
      });
    } else if (kind === 'reasoning') {
      // M4b 思考区：按（锚点， 节拍）聚合生长，全文追加永不丢（展开读全部）
      // 本地镜像轮（无锚 + sessionId 戳）：经合成轮次锚归位渲染（PROTOCOL-FROZEN:54「手机据此归位」）
      const beat = typeof env.body['beat'] === 'number' ? env.body['beat'] : 0;
      const anchor = typeof env.replyTo === 'string' ? env.replyTo : this.resolveMirrorAnchor(chunkSessionId, beat);
      if (anchor === null || this.closedAnchors.has(anchor)) {
        await this.ack(boxMsgId);
        return;
      }
      this.closeEarlierBeats(anchor, beat, env.ts, chunkSessionId);
      const b = this.beatBuf(anchor, beat);
      this.anchorActivity.add(anchor);
      if (env.body['closed'] === true) {
        // M4f 关闭快照（该节拍思考全文）：长者胜整体覆盖——丢分片成洞/迟到/半截全部愈合
        // （截断的快照不得缩短现存文本：单生产者只增串，更长才是更全的真相）
        const cur = RelaySession.assembleParts(b.thinkParts);
        if (text.length >= cur.length) b.thinkParts = [{ text }];
        b.thinkClosed = true;
      } else {
        const seq = typeof env.body['seq'] === 'number' ? env.body['seq'] : undefined;
        b.thinkParts.push({ ...(seq !== undefined ? { seq } : {}), text });
      }
      const thinkText = RelaySession.assembleParts(b.thinkParts);
      this.emit({
        type: 'message',
        message: {
          id: `think-${anchor}-${beat}`,
          dir: 'in',
          text: thinkText,
          kind: 'reasoning',
          ts: env.ts,
          ...(chunkSessionId !== null ? { sessionId: chunkSessionId } : {}),
          streaming: !b.thinkClosed, // 已收敛的思考区不因迟到 reasoning 重新展开（全文仍追加归位）
        },
      });
    } else if (kind === 'delta') {
      // M4b 流式正文：按（锚点， 节拍）归并。本地镜像轮（无锚 + sessionId 戳）经合成轮次锚归位渲染——
      // 「桌面恒定带锚」为错误假设（本地轮恒无锚），原丢弃路径即本提案根因
      const beat = typeof env.body['beat'] === 'number' ? env.body['beat'] : 0;
      const anchor = typeof env.replyTo === 'string' ? env.replyTo : this.resolveMirrorAnchor(chunkSessionId, beat);
      if (anchor === null || this.closedAnchors.has(anchor)) {
        await this.ack(boxMsgId);
        return;
      }
      this.closeEarlierBeats(anchor, beat, env.ts, chunkSessionId);
      const b = this.beatBuf(anchor, beat);
      this.anchorActivity.add(anchor);
      const seq = typeof env.body['seq'] === 'number' ? env.body['seq'] : undefined;
      b.contentParts.push({ ...(seq !== undefined ? { seq } : {}), text });
      // 本节拍首个正文 delta 到达 = 思考区收敛（想完→开答的接力）
      if (!b.thinkClosed && b.thinkParts.length > 0) {
        b.thinkClosed = true;
        this.emit({
          type: 'message',
          message: { id: `think-${anchor}-${beat}`, dir: 'in', text: RelaySession.assembleParts(b.thinkParts), kind: 'reasoning', ts: env.ts, streaming: false, ...(chunkSessionId !== null ? { sessionId: chunkSessionId } : {}) },
        });
      }
      this.emit({
        type: 'message',
        message: { id: `stream-${anchor}-${beat}`, dir: 'in', text: RelaySession.assembleParts(b.contentParts), kind: 'delta', ts: env.ts, streaming: true, ...(chunkSessionId !== null ? { sessionId: chunkSessionId } : {}) },
      });
    } else {
      // final/notice：按（锚点， beat）落定正文块；beat 漂移（级联空节拍跳号）容错落定最高现存 beat
      const anchor = typeof env.replyTo === 'string' ? env.replyTo : null;
      const beat = typeof env.body['beat'] === 'number' ? env.body['beat'] : 0;
      // roundStarted 必须在 closeAnchor 前取（落定即清活动登记）：notice 的拒绝/中止分类信号
      const roundStarted = anchor !== null && this.anchorActivity.has(anchor);
      let replaceId = env.id;
      if (anchor) {
        const m = this.beats.get(anchor);
        let settleBeat = beat;
        if (m && !m.has(beat) && m.size > 0) settleBeat = Math.max(...m.keys());
        replaceId = `stream-${anchor}-${settleBeat}`;
        this.closeAnchor(anchor);
        // 该锚点所有未闭合思考区一并收敛（final 兜底）
        if (m) {
          for (const [bIdx, b] of m) {
            if (!b.thinkClosed && b.thinkParts.length > 0) {
              b.thinkClosed = true;
              this.emit({
                type: 'message',
                message: { id: `think-${anchor}-${bIdx}`, dir: 'in', text: RelaySession.assembleParts(b.thinkParts), kind: 'reasoning', ts: env.ts, streaming: false, ...(chunkSessionId !== null ? { sessionId: chunkSessionId } : {}) },
              });
            }
          }
        }
        this.beats.delete(anchor);
      }
      this.emit({
        type: 'message',
        message: {
          id: replaceId,
          dir: 'in',
          text: truncated ? `${text}\n（已截断，完整内容请在桌面查看）` : text,
          kind,
          ts: env.ts,
          ...(chunkSessionId !== null ? { sessionId: chunkSessionId } : {}),
          ...(kind === 'notice' ? { roundStarted } : {}),
        },
      });
    }
    await this.ack(boxMsgId); // 解密+处理成功后才 ACK
  }

  private async ack(id: number): Promise<void> {
    if (!this.state) return;
    await httpJson('POST', this.state.relay, `/box/${this.myBox}/ack`, {
      token: this.secrets!.readToken,
      body: { id },
    }).catch(() => {
      /* ACK 失败 → 服务器重投，去重兜底 */
    });
  }

  /**
   * M4 审批信封：request 建卡 / resolved 同 id 替换原位变灰（复用 App 层同 id 替换收敛）。
   * resolved 用缓存的请求信息重发整卡（替换语义会丢 summary，否则灰卡只剩结论没有问题描述）。
   */
  private handleApprovalEnvelope(env: Envelope): void {
    const approvalId = typeof env.body['id'] === 'string' ? env.body['id'] : '';
    if (!approvalId) return;
    if (env.type === 'approval.request') {
      const info: ApprovalCardInfo = {
        id: approvalId,
        kind: String(env.body['kind'] ?? 'write'),
        summary: String(env.body['summary'] ?? ''),
        ...(typeof env.body['preview'] === 'string' ? { preview: env.body['preview'] } : {}),
        ...(typeof env.body['timeoutAt'] === 'number' ? { timeoutAt: env.body['timeoutAt'] } : {}),
        // 桌面操作审批标记（additive；对齐桌面侧 pushApprovalRequest 透传）
        ...(env.body['sessionGrantable'] === true ? { sessionGrantable: true } : {}),
        // 归因 additive 透传读取（无归因不带字段——旧桌面兼容）
        ...(typeof env.body['sessionId'] === 'string' ? { sessionId: env.body['sessionId'] } : { sessionId: null }),
        // 位置坐标三段兑底（与 ask 同构：钉首次 → originalTs → env.ts）
        requestTs: this.approvalCards.get(approvalId)?.requestTs ?? (typeof env.body['originalTs'] === 'number' ? env.body['originalTs'] : undefined) ?? env.ts,
      };
      this.approvalCards.set(approvalId, info);
    } else {
      const prev = this.approvalCards.get(approvalId);
      const info: ApprovalCardInfo = {
        id: approvalId,
        kind: prev?.kind ?? '',
        summary: prev?.summary ?? '',
        ...(prev?.preview !== undefined ? { preview: prev.preview } : {}),
        ...(prev?.timeoutAt !== undefined ? { timeoutAt: prev.timeoutAt } : {}),
        ...(prev?.sessionGrantable !== undefined ? { sessionGrantable: prev.sessionGrantable } : {}),
        ...(prev?.sessionId !== undefined ? { sessionId: prev.sessionId } : { sessionId: null }),
        settled: { approved: env.body['approved'] === true, by: String(env.body['by'] ?? '') },
        settledAt: Date.now(),
        ...(prev?.requestTs !== undefined ? { requestTs: prev.requestTs } : {}),
      };
      this.approvalCards.set(approvalId, info);
    }
    const card = this.approvalCards.get(approvalId)!;
    this.emit({
      type: 'message',
      message: {
        id: `approval-${approvalId}`,
        dir: 'in',
        text: '',
        kind: 'approval',
        ts: env.ts,
        approval: card,
      },
    });
  }

  /**
   * M5 权限模式变更请求（仅配对完成后可用）。投递失败/超时抛错——
   * 徽标变化的唯一触发是 mode.state 回流，本地点击绝不假装落定。
   */
  async sendModeSet(mode: string): Promise<void> {
    if (!this.confirmed || !this.state || !this.secrets) return;
    const env = makeEnvelope('mode.set', this.myBox, this.deskBox, { mode });
    const wire = encryptEnvelope(this.secrets.keyM2D, this.deskBox, 'm2d', env);
    if (!wire) throw new Error('消息超线上字节上限');
    const r = await Promise.race([
      httpJson('POST', this.state.relay, `/box/${this.deskBox}`, {
        token: this.secrets.writeToken,
        body: { blob: wire },
      }),
      sleep(10_000).then(() => {
        throw new Error('投递超时（10s）');
      }),
    ]);
    if (r.status !== 201) throw new Error(`投递失败 HTTP ${r.status}`);
  }

  /**
   * M8 命令请求（M2 起使用）。投递失败/超时抛错——落定唯一来源是 cmd.result / cmd.state 回流，
   * 本地绝不假装执行成功（不假落定）。
   */
  async sendCmdRequest(id: string, cmd: string, args?: Record<string, unknown>): Promise<void> {
    if (!this.confirmed || !this.state || !this.secrets) return;
    const env = makeEnvelope('cmd.request', this.myBox, this.deskBox, { id, cmd, ...(args ? { args } : {}) });
    const wire = encryptEnvelope(this.secrets.keyM2D, this.deskBox, 'm2d', env);
    if (!wire) throw new Error('消息超线上字节上限');
    const r = await Promise.race([
      httpJson('POST', this.state.relay, `/box/${this.deskBox}`, {
        token: this.secrets.writeToken,
        body: { blob: wire },
      }),
      sleep(10_000).then(() => {
        throw new Error('投递超时（10s）');
      }),
    ]);
    if (r.status !== 201) throw new Error(`投递失败 HTTP ${r.status}`);
  }

  /**
   * M8 命令请求-回执一次往返（裁决卡翻页等需要回执数据的命令用；sendCmdRequest 只确认投递不拿回执）：
   * 先挂一次性 replyTo 匹配的 cmdResult 监听再投递（防快回执漏接），12s 超时（大于投递超时 10s——
   * 投递失败先抛）。投递失败/超时 reject；回执到达按原样 resolve（ok/error 由调用方判）。
   */
  async requestCmd(id: string, cmd: string, args?: Record<string, unknown>): Promise<CmdResult> {
    // 对象持有退订函数（直接 let 会被 TS 流分析在闭包外窄化为 null—— executor 同步执行但 CFA 不可见）
    const sub: { off: (() => void) | null } = { off: null };
    const wait = new Promise<CmdResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.off?.();
        reject(new Error('命令回执超时（12s）'));
      }, 12_000);
      sub.off = this.on((e) => {
        if (e.type === 'cmdResult' && e.replyTo === id) {
          clearTimeout(timer);
          sub.off?.();
          resolve({
            ok: e.ok,
            ...(e.data !== undefined ? { data: e.data } : {}),
            ...(e.error !== undefined ? { error: e.error } : {}),
          });
        }
      });
    });
    try {
      await this.sendCmdRequest(id, cmd, args);
    } catch (err) {
      sub.off?.();
      throw err;
    }
    return wait;
  }

  /**
   * 卡片变灰的唯一触发是 approval.resolved 信封，本地点击绝不假装落定。
   * 10s 超时：无超时的挂起 POST 会把卡片永远楔在"提交中…"（实测发生过）。
   * decision='session'（桌面操作审批的「本次会话放行」第三钮）：线上形态为
   * decision:'approve' + additive allowSession:true——与 CLI [s]/桌面 UI 落定同一语义；
   * 不发明 decision 新值（旧桌面对未知 decision 判 reject）。
   */
  async sendApprovalResponse(id: string, decision: 'approve' | 'reject' | 'session'): Promise<void> {
    if (!this.confirmed || !this.state || !this.secrets) return;
    const body =
      decision === 'session'
        ? { id, decision: 'approve' as const, allowSession: true }
        : { id, decision };
    const env = makeEnvelope('approval.response', this.myBox, this.deskBox, body);
    const wire = encryptEnvelope(this.secrets.keyM2D, this.deskBox, 'm2d', env);
    if (!wire) throw new Error('消息超线上字节上限');
    const r = await Promise.race([
      httpJson('POST', this.state.relay, `/box/${this.deskBox}`, {
        token: this.secrets.writeToken,
        body: { blob: wire },
      }),
      sleep(10_000).then(() => {
        throw new Error('投递超时（10s）');
      }),
    ]);
    if (r.status !== 201) throw new Error(`投递失败 HTTP ${r.status}`);
  }

  /**
   * M4e 提问信封：request 建卡 / resolved 同 id 替换原位变灰（镜像审批信封处理）。
   * resolved 用缓存的请求信息重发整卡（否则灰卡只剩结论没有问题描述）。
   */
  private handleAskEnvelope(env: Envelope): void {
    const askId = typeof env.body['id'] === 'string' ? env.body['id'] : '';
    if (!askId) return;
    if (env.type === 'ask.request') {
      const rawOptions = Array.isArray(env.body['options']) ? (env.body['options'] as { label?: unknown; description?: unknown }[]) : undefined;
      const info: AskCardInfo = {
        id: askId,
        question: String(env.body['question'] ?? ''),
        ...(rawOptions
          ? {
              options: rawOptions
                .filter((o) => typeof o?.label === 'string')
                .map((o) => ({ label: String(o.label), description: typeof o.description === 'string' ? o.description : '' })),
            }
          : {}),
        ...(env.body['allowFreeText'] === true ? { allowFreeText: true } : {}),
        ...(typeof env.body['hint'] === 'string' ? { hint: env.body['hint'] } : {}),
        // 裁决卡载荷原样透传（形状校验在渲染层 validateTriageCard，失败落回文本卡）
        ...(env.body['card'] !== null && typeof env.body['card'] === 'object' ? { card: env.body['card'] as AskTriageCard } : {}),
        // 归因 additive 透传读取（无归因不带字段——旧桌面兼容）
        ...(typeof env.body['sessionId'] === 'string' ? { sessionId: env.body['sessionId'] } : { sessionId: null }),
        // 位置坐标三段兑底：缓存钉首次（重推不刷新）→ 新桌面 originalTs（重放钉回原始提问时刻）→ 旧桌面 env.ts
        requestTs: this.askCards.get(askId)?.requestTs ?? (typeof env.body['originalTs'] === 'number' ? env.body['originalTs'] : undefined) ?? env.ts,
      };
      this.askCards.set(askId, info);
    } else {
      const prev = this.askCards.get(askId);
      const info: AskCardInfo = {
        id: askId,
        question: prev?.question ?? '',
        ...(prev?.options !== undefined ? { options: prev.options } : {}),
        ...(prev?.allowFreeText !== undefined ? { allowFreeText: prev.allowFreeText } : {}),
        ...(prev?.hint !== undefined ? { hint: prev.hint } : {}),
        ...(prev?.card !== undefined ? { card: prev.card } : {}),
        ...(prev?.sessionId !== undefined ? { sessionId: prev.sessionId } : { sessionId: null }),
        settled: { answer: String(env.body['answer'] ?? ''), by: String(env.body['by'] ?? '') },
        settledAt: Date.now(),
        ...(prev?.requestTs !== undefined ? { requestTs: prev.requestTs } : {}),
      };
      this.askCards.set(askId, info);
    }
    const card = this.askCards.get(askId)!;
    this.emit({
      type: 'message',
      message: {
        id: `ask-${askId}`,
        dir: 'in',
        text: '',
        kind: 'ask',
        ts: env.ts,
        ask: card,
      },
    });
  }

  /**
   * M4e 提问回答（仅配对完成后可用）。选项作答发 label 原文、自由文本原样、跳过发 "跳过"
   * （对齐桌面调用方归一化语义）。投递失败/超时抛错——卡片恢复可点由 UI 提示重试：
   * 卡片变灰的唯一触发是 ask.resolved 信封，本地点击绝不假装落定。10s 超时同审批。
   * decisions（可选）：裁决卡结构化决策（双通道之结构化路；answer 始终附带编译文本，
   * 旧桌面不认识该字段时安全忽略、走文本解析回退）。
   */
  async sendAskResponse(id: string, answer: string, decisions?: AskDecisionEntry[]): Promise<void> {
    if (!this.confirmed || !this.state || !this.secrets) return;
    const env = makeEnvelope('ask.response', this.myBox, this.deskBox, {
      id,
      answer,
      ...(decisions && decisions.length > 0 ? { decisions } : {}),
    });
    const wire = encryptEnvelope(this.secrets.keyM2D, this.deskBox, 'm2d', env);
    if (!wire) throw new Error('消息超线上字节上限');
    const r = await Promise.race([
      httpJson('POST', this.state.relay, `/box/${this.deskBox}`, {
        token: this.secrets.writeToken,
        body: { blob: wire },
      }),
      sleep(10_000).then(() => {
        throw new Error('投递超时（10s）');
      }),
    ]);
    if (r.status !== 201) throw new Error(`投递失败 HTTP ${r.status}`);
  }

  /**
   * M4e 订阅信号（chat.sync，空 body）：连接建立后发送，桌面收到即重推未决审批/提问（含 resyncBoard 板对账）。
   * 公开：e2e 线束需按需发"重连语义"信号（断线重连板对账场景;无断线/重连的公开口,这是该信号的唯一发送点）。
   * fire-and-forget：失败不重试（下一次重连自然再发）；未配对确认时不发（桌面反正会丢弃）。
   */
  async sendSyncPing(): Promise<void> {
    if (!this.confirmed || !this.state || !this.secrets) return;
    const env = makeEnvelope('chat.sync', this.myBox, this.deskBox, {});
    const wire = encryptEnvelope(this.secrets.keyM2D, this.deskBox, 'm2d', env);
    if (!wire) return;
    await httpJson('POST', this.state.relay, `/box/${this.deskBox}`, {
      token: this.secrets.writeToken,
      body: { blob: wire },
    }).catch(() => {
      /* 失败无碍：下一次重连再发 */
    });
  }

  // ---------- M6 会话同步：连接同步序列 / 附着 / 目录 / 历史 ----------

  /** M6 同步信道投递（fire-and-forget：失败等下一触发点重发；对账/分页全部幂等，丢信由重连对账愈合）。
   *  返回信封 id（应答 replyTo 配对键）；未投递早退返回 undefined。 */
  private async postEnvelopeFireForget(type: string, body: Record<string, unknown>, replyTo?: string): Promise<string | undefined> {
    if (!this.confirmed || !this.state || !this.secrets) return;
    const env = makeEnvelope(type, this.myBox, this.deskBox, body, replyTo);
    const wire = encryptEnvelope(this.secrets.keyM2D, this.deskBox, 'm2d', env);
    if (!wire) return;
    await httpJson('POST', this.state.relay, `/box/${this.deskBox}`, {
      token: this.secrets.writeToken,
      body: { blob: wire },
    }).catch(() => {
      /* 失败无碍：重连对账自愈 */
    });
    return env.id;
  }

  /**
   * M6 连接同步序列（附着对账三路径一条规则，意图锚 = syncState.attachedSessionId）：
   * ①冷启动（进程首连）：有附着记录 → 先 attach{null} 显式脱离（进程死亡无信使；
   *   桌面侧附着已随桥重建/owner 易主归零，手机不残留"我以为还附着"的假认知）；
   * ②热重连（WS 断线重连）：按 syncState 重 announce（非空附 X、空附 null）；
   * 然后发 catalog.sync 目录对账；附着会话做一次尾部拉齐（history.request 最新页，msgKey 幂等归并）。
   */
  private async onConnectedSync(): Promise<void> {
    if (!this.confirmed) return;
    const db = this.db();
    if (!db) return;
    if (this.coldStart) {
      this.coldStart = false;
      if (this.attachedIntent !== null) {
        await this.setAttachedIntent(null);
        await this.sendAttach(null);
      }
    } else {
      await this.sendAttach(this.attachedIntent);
    }
    await this.sendCatalogSync();
    // M8：连接建立后请求命令目录+全量状态（桌面回 cmd.state 附 catalog；占用环/会话 sheet 收敛）
    await this.postEnvelopeFireForget('cmd.sync', {});
    if (this.attachedIntent !== null) {
      this.scheduleTailPull(this.attachedIntent);
      // M7：连接建立后补拉附着会话看板（带已知 rev 对账）
      await this.sendBoardSync(this.attachedIntent);
      // workplan：重连 resync 补拉附着会话工作计划树（带已知 rev 对账）
      await this.sendWorkPlanSync(this.attachedIntent);
    }
    // M6c：重连后恢复探活节奏（前台且在等）
    if (this.presenceActive) this.schedulePresencePing(0);
    // d→m 收件清扫（启动/重连）：offered 过期→expired+丢断点；pulling→复位 offered（断点保留）
    void this.sweepReceivedFiles();
  }

  /** 附着意图更新：内存镜像 + syncState 落库（对账锚；attached.changed 回流确认仅呈现层消费） */
  private async setAttachedIntent(sessionId: string | null): Promise<void> {
    if (this.attachedIntent !== sessionId && this.attachedIntent !== null) {
      this.closeMirrorAnchor(this.attachedIntent); // 切换/脱离附着：旧会话悬挂活合成锚收口（重附后新轮由判据开新锚）
    }
    this.attachedIntent = sessionId;
    const db = this.db();
    if (!db) return;
    const prev = await db.getSyncState(this.agentId);
    await db.putSyncState({
      agentId: this.agentId,
      attachedSessionId: sessionId,
      projectsRev: prev?.projectsRev ?? null,
      catalogSyncedAt: prev?.catalogSyncedAt ?? null,
      expandedProjectsJson: prev?.expandedProjectsJson ?? null,
      lastChatSessionId: prev?.lastChatSessionId ?? null,
    });
  }

  /** M6 附着/脱离订阅（类五 UI：进入会话 attach(X)、离开 attach(null)）。请求-确认制：确认=attached.changed 回流 */
  async sendAttach(sessionId: string | null): Promise<void> {
    await this.setAttachedIntent(sessionId);
    await this.postEnvelopeFireForget('session.attach', { sessionId });
    // M7：attach 后发 board.sync 拉板（带已知 rev 对账；照 catalog.sync 先例——附着即关心该会话看板）
    if (sessionId !== null) await this.sendBoardSync(sessionId);
    // workplan：attach 后发 workplan.sync 拉树（带已知 rev 对账；照 board.sync 先例）
    if (sessionId !== null) await this.sendWorkPlanSync(sessionId);
  }

  /** M7 看板对账上报：带已知 rev（boardMeta）触发对账；无已知=请求全量（照 catalog.sync 先例） */
  async sendBoardSync(sessionId: string): Promise<void> {
    const db = this.db();
    if (!db) return;
    const meta = await db.getBoardMeta(this.agentId, sessionId);
    await this.postEnvelopeFireForget('board.sync', packBoardSyncBody(sessionId, meta?.rev ?? null));
  }

  /** 工作计划树对账上报：带已知 rev（workPlanMeta）触发对账；无已知=请求全量（照 board.sync 先例） */
  async sendWorkPlanSync(sessionId: string): Promise<void> {
    const db = this.db();
    if (!db) return;
    const meta = await db.getWorkPlanMeta(this.agentId, sessionId);
    await this.postEnvelopeFireForget('workplan.sync', packWorkPlanSyncBody(sessionId, meta?.rev ?? null));
  }

  /** M6 目录对账上报：已知 sessions 版本 map + projectsRev；超 45KB 明文预算退化为空 body 请求全量（协议登记的退路） */
  private async sendCatalogSync(): Promise<void> {
    const db = this.db();
    if (!db) return;
    const prev = await db.getSyncState(this.agentId);
    const sessions = await db.getSessionsVersionMap(this.agentId);
    // 预算留 2KB 信封外壳余量（v/type/id/ts/from/to/replyTo 等包装字节也在明文预算内）
    const body = packCatalogSyncBody({ projectsRev: prev?.projectsRev ?? null, sessions }, PLAINTEXT_BUDGET_BYTES - 2048);
    await this.postEnvelopeFireForget('catalog.sync', body);
  }

  /** M6 历史按需拉（类五 UI：进入会话拉最新页、上翻传 before=已持有最早 msgKey）。
   *  无 before=最新页拉取 → 标记连续性链起点（页预算豁口的自动补拉，见 handleHistoryPage）。
   *  opts.asOlder=true：上翻补页请求——登记信封 id，应答 replyTo 配对后 'history' 事件携带 intent='older' */
  async sendHistoryRequest(sessionId: string, before?: string, limit?: number, opts?: { asOlder?: boolean }): Promise<void> {
    if (before === undefined) this.tailChain.set(sessionId, 0);
    const envId = await this.postEnvelopeFireForget('history.request', {
      sessionId,
      ...(before !== undefined ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    // 上翻意图登记：未投递早退（envId=undefined）不登记——无请求则无应答；死 id 由 tracker 容量 FIFO 兜底
    if (opts?.asOlder && envId) this.pendingOlder.add(envId);
  }

  /** 尾部拉齐连续性链（session → 已链次数）：最新页与既有副本零重叠=页预算豁口（长轮 >20 条/32KB 时
   *  用户行/早期节拍行被截进豁口，loadOlder 的"全库最早键"游标永远够不到）→ before=本页最早键链式补拉，
   *  直到与副本重叠（幂等 REPLACE 天然对齐）或 done；封顶 5 链防失控 */
  private tailChain = new Map<string, number>();

  /** 附着会话尾部拉齐（800ms trailing 防抖；M6c 起只由 round.settled 触发——轮真正落定才拉，
   *  轮中"最新页"是移动目标，拉回正在流式的内容会造成 DB 副本与 overlay 双份渲染，用户实测击穿）。
   *  防抖窗口内若新轮已开始（goal tick 等紧接的下一轮）→ 顺延到下一次落定，绝不落在活轮中间。
   *  force=轮已落定的欠账拉：settle 即该轮已结束，活轮记账被迟到冲刷重新点亮不算新活轮（实测：
   *  尾批迟到 delta 把唯一一次尾拉永久跳过——总结/占位改写双双丢失），此刻必须拉。 */
  private scheduleTailPull(sessionId: string, force = false): void {
    if (this.tailPullTimer) clearTimeout(this.tailPullTimer);
    this.tailPullTimer = setTimeout(() => {
      this.tailPullTimer = null;
      if (!force && this.liveRoundSessionId === sessionId && sessionId === this.attachedIntent) {
        return; // 活轮中：等 round.settled 再拉（此刻拉=双份渲染）
      }
      void this.sendHistoryRequest(sessionId);
    }, 800);
  }

  // ---------- M6c 桌面在线探活 ----------

  /** 桌面在线查询（绿点数据源：connected && isDesktopOnline()） */
  isDesktopOnline(): boolean {
    return this.desktopOnline;
  }

  /** 任何已验证的桌面来信 = 在线证据（pong/chat.event/session.event…全部计入） */
  private markDesktopAlive(): void {
    this.lastDesktopAliveAt = Date.now();
    if (this.presenceMisses !== 0) this.presenceMisses = 0; // 有应答即退出退避（下一拍恢复常规节奏）
    if (!this.desktopOnline) {
      this.desktopOnline = true;
      this.emit({ type: 'presence', online: true });
    }
  }

  /** 判离线并止血：WS 断开/停止/复位时调用（离线通知是双端状态，不能等下一拍超时才发） */
  private markDesktopOffline(): void {
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (this.desktopOnline) {
      this.desktopOnline = false;
      this.emit({ type: 'presence', online: false });
    }
  }

  /** 前台/后台切换（AppState 驱动）：后台停探活——不发 ping、不判离线（用户没在看，省电且信箱零堆积） */
  setPresenceActive(active: boolean): void {
    this.presenceActive = active;
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (active && this.confirmed && !this.stopped) this.schedulePresencePing(0); // 回前台立即探一次
  }

  private schedulePresencePing(delayMs: number): void {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      void this.presenceTick();
    }, delayMs);
  }

  /** 一拍：判超时离线 → 发 ping → 记 miss → 排下一拍（连续 miss 退避，有应答恢复常规节奏） */
  private async presenceTick(): Promise<void> {
    if (!this.presenceActive || this.stopped || !this.confirmed) return;
    if (Date.now() - this.lastDesktopAliveAt > PRESENCE_STALE_MS && this.desktopOnline) {
      this.desktopOnline = false;
      this.emit({ type: 'presence', online: false });
    }
    try {
      // caps 能力自报（additive）：桌面据此做 d→m 文件发送前置门（无 file-recv = 版本过旧，诚实报错而非盲发）
      await this.postEnvelopeFireForget('presence.ping', { caps: [CAP_FILE_RECV] });
    } catch {
      this.presenceMisses++;
    }
    if (Date.now() - this.lastDesktopAliveAt > PRESENCE_STALE_MS) this.presenceMisses++;
    else this.presenceMisses = 0;
    this.schedulePresencePing(this.presenceMisses >= 3 ? PRESENCE_BACKOFF_MS : PRESENCE_INTERVAL_MS);
  }

  /** catalog.state 落库（分片归组集齐才应用；应用后通知 UI 刷新目录与当前徽标） */
  private async handleCatalogState(env: Envelope): Promise<void> {
    const db = this.db();
    if (!db) return;
    const body = env.body as unknown as CatalogStateBody;
    const complete = this.catalogCollector.add(env.replyTo, body);
    this.catalogCollector.prune();
    if (!complete) return;
    const lastChatCleared = await applyCatalogState(db, this.agentId, complete);
    this.activeSessionId = complete.activeSessionId;
    // 运行态标志：重连对账整替（旧宿主/旧进程的转圈残留在此收敛；注入方未带字段=不动现状）
    if (Array.isArray(complete.runningSessionIds)) this.applyRunning({ runningAll: complete.runningSessionIds });
    // catalog deletes 级联：被删会话的转圈必收（session.deleted 事件的同规则补口）
    if (Array.isArray(complete.deletes)) {
      for (const id of complete.deletes) this.applyRunning({ sessionId: id, running: false });
      for (const id of complete.deletes) this.mirrorAnchors.delete(id); // 会话删除级联：合成锚状态随行清理
    }
    if (lastChatCleared) {
      // 入口记忆悬空清除（catalog deletes 命中）：内存镜像同步 + 通知 UI（下次点"我的桌面"落新会话界面）
      this.lastChatSessionId = null;
      this.emit({ type: 'lastChat', sessionId: null });
    }
    this.emit({ type: 'catalog' });
    this.emit({ type: 'activeSession', sessionId: complete.activeSessionId });
  }

  /** history.page 落库（msgKey 幂等归并；notFound=会话已删 → 清本地副本；连续性链见 tailChain） */
  private async handleHistoryPage(env: Envelope): Promise<void> {
    const db = this.db();
    if (!db) return;
    const body = env.body as unknown as HistoryPageBody;
    if (typeof body.sessionId !== 'string' || !Array.isArray(body.messages)) return;
    // 连续性链：落库前先算本页与既有副本的重叠（overlap=0 且未 done=豁口存在）
    const chain = this.tailChain.get(body.sessionId);
    let overlap = 0;
    if (chain !== undefined && body.messages.length > 0) {
      overlap = await db.countMessagesByKeys(this.agentId, body.sessionId, body.messages.map((m) => m.msgKey));
    }
    await applyHistoryPage(db, this.agentId, body);
    if (body.done === true) this.historyDoneBySession.set(body.sessionId, true);
    if (chain !== undefined) {
      if (body.done === true || overlap > 0 || body.messages.length === 0) {
        this.tailChain.delete(body.sessionId); // 对齐（或到头/空页）→ 链止
      } else if (chain < 5) {
        // 豁口未合：before=本页最早键继续向前补拉（下一页落库时经同一判据决定是否再链）
        this.tailChain.set(body.sessionId, chain + 1);
        void this.sendHistoryRequest(body.sessionId, body.messages[0]!.msgKey);
      } else {
        this.tailChain.delete(body.sessionId);
        console.warn(`[relay] 尾部拉齐连续性链超 5 链仍未重叠（${body.sessionId}），止链防失控`);
      }
    }
    // 意图配对：replyTo 命中在途上翻登记 → intent='older'（UI prepend 保持窗口不重置）；
    // 未登记（尾部拉齐/tailChain 链式补拉/迟到重投）→ 无 intent=刷新语义（保守降级为现状行为）
    const olderHit = env.replyTo != null && this.pendingOlder.consume(env.replyTo);
    this.emit({ type: 'history', sessionId: body.sessionId, ...(olderHit ? { intent: 'older' as const } : {}) });
  }

  /**
   * M7 board.state 落库（分片归组集齐才应用；rev LWW 旧 rev 丢弃在 applyBoardState）。
   * 应用后通知 UI 重读该会话看板（进度长条/详情卡数据源）。
   */
  private async handleBoardState(env: Envelope): Promise<void> {
    const db = this.db();
    if (!db) return;
    const body = env.body as unknown as BoardStateBody;
    if (typeof body.sessionId !== 'string') return;
    const complete = this.boardCollector.add(env.replyTo, body);
    this.boardCollector.prune();
    if (!complete) return;
    const applied = await applyBoardState(db, this.agentId, complete);
    if (applied) this.emit({ type: 'board', sessionId: complete.sessionId });
  }

  /**
   * workplan.state 落库（分片归组集齐才应用；rev LWW 旧 rev 丢弃在 applyWorkPlanState）。
   * 应用后通知 UI 重读该会话工作计划树（进度长条/详情卡数据源）。
   */
  private async handleWorkPlanState(env: Envelope): Promise<void> {
    const db = this.db();
    if (!db) return;
    const body = env.body as unknown as WorkPlanStateBody;
    if (typeof body.sessionId !== 'string') return;
    const complete = this.workPlanCollector.add(env.replyTo, body);
    this.workPlanCollector.prune();
    if (!complete) return;
    const applied = await applyWorkPlanState(db, this.agentId, complete);
    if (applied) this.emit({ type: 'workplan', sessionId: complete.sessionId });
  }

  /**
   * V2 feed.subagent 落位（latest-wins overlay,不落库）：按 toolCallId 归并 running→终态,
   * 乱序旧帧丢弃；落位后通知 UI 重读该任务工具细节（点行展开/进展兜底数据源）。
   */
  private async handleFeedSubagent(env: Envelope): Promise<void> {
    const body = env.body as unknown as FeedSubagentBody;
    if (!body || typeof body.toolCallId !== 'string') return;
    const landed = this.feedOverlay.apply(body);
    this.feedOverlay.prune();
    if (landed) this.emit({ type: 'feed', ...(body.taskId !== undefined ? { taskId: body.taskId } : {}) });
  }

  /** V2 事实读取（点行明细/进展兜底的数据源;最新在前） */
  getFeedFacts(taskId: string, limit = 10): FeedSubagentBody[] {
    return this.feedOverlay.listByTask(taskId, limit);
  }

  // ---------- 运行态标志（volatile 集合唯一写口；会话列表"运行中"转圈数据源） ----------

  /** 运行中会话全集（只读；SessionListScreen 经 runningTick 变化时读取） */
  getRunningSessions(): ReadonlySet<string> {
    return this.runningSessions;
  }

  // ---------- 发送气泡停车场（切会话保命；见字段注释） ----------

  /** 存入未退休发送气泡（ChatScreen 卸载/切换时；空集清键幂等） */
  parkOutBubbles(sessionId: string, msgs: ChatMessage[]): void {
    if (msgs.length === 0) {
      this.parkedBubbles.delete(sessionId);
      return;
    }
    this.parkedBubbles.set(sessionId, msgs);
  }

  /** 取走该会话的停车气泡（取走即清键——注入后由 DB 回声退休接管清除） */
  takeParkedBubbles(sessionId: string): ChatMessage[] {
    const parked = this.parkedBubbles.get(sessionId);
    if (!parked) return [];
    this.parkedBubbles.delete(sessionId);
    return parked;
  }

  /** 集合更新编排：判定在 syncReducer.nextRunningSet 纯函数（无变化返回 null → 不 emit，防周期重申抖动） */
  private applyRunning(input: { sessionId?: string; running?: boolean; runningAll?: string[] }): void {
    const next = nextRunningSet(this.runningSessions, input);
    if (!next) return;
    this.runningSessions = next;
    this.emit({ type: 'running' });
  }

  /** session.event 分派：目录行变更落库 / 附着对账 / 历史失效清副本重拉 / 附着会话被删自动脱离 */
  private async handleSessionEvent(env: Envelope): Promise<void> {
    const body = env.body as unknown as SessionEventBody;
    // 运行态标志（置于 db 守卫之前——volatile 更新不依赖 DB 可用性）：runningAll 在场=整替
    //（纯快照形态 sessionId 省略也走此路），否则按 running 增删；判定/防抖在 nextRunningSet。
    if (body.kind === 'running.changed') {
      this.applyRunning(body);
      // TURN_STARTED 开门信号（增量形态 running=true）：本地镜像轮新轮辨析依据（见 resolveMirrorAnchor）
      if (body.running === true && typeof body.sessionId === 'string') this.markMirrorOpen(body.sessionId);
    }
    const db = this.db();
    if (!db) return;
    const effect = await applySessionEvent(db, this.agentId, body, this.attachedIntent);
    if (effect.catalogTouched) this.emit({ type: 'catalog' });
    if (effect.activeChanged !== undefined) {
      this.activeSessionId = effect.activeChanged;
      this.emit({ type: 'activeSession', sessionId: effect.activeChanged });
    }
    if (effect.invalidatedSessionId !== undefined) {
      // 副本已清：附着中则立即重拉；通知 UI 该会话历史已失效（重读 DB + 清已闭合 overlay 卡——真相重写后回声永远达不到）
      this.historyDoneBySession.delete(effect.invalidatedSessionId);
      this.emit({ type: 'history', sessionId: effect.invalidatedSessionId, invalidated: true });
      if (this.attachedIntent === effect.invalidatedSessionId) this.scheduleTailPull(effect.invalidatedSessionId);
    }
    if (effect.detachBecauseDeleted !== undefined) {
      // 附着会话被桌面删除：自动脱离（双端认知一致）+ 通知 UI 返回会话列表并提示
      await this.setAttachedIntent(null);
      await this.postEnvelopeFireForget('session.attach', { sessionId: null });
      this.emit({ type: 'attached', sessionId: null });
      this.emit({ type: 'sessionDeleted', sessionId: effect.detachBecauseDeleted });
    }
    // M6b：session.deleted 命中入口记忆 → 清（与 catalog deletes 第一层同规则；事件路径单列）
    if (body.kind === 'session.deleted' && typeof body.sessionId === 'string' && body.sessionId === this.lastChatSessionId) {
      await this.setLastChatSession(null);
    }
    // M7：会话删除级联清板（db.deleteSession 已清 boardItems/boardMeta）→ 通知 UI 收掉看板视图
    if (body.kind === 'session.deleted' && typeof body.sessionId === 'string') {
      this.applyRunning({ sessionId: body.sessionId, running: false }); // 运行态级联：会话已删，转圈必收
      this.emit({ type: 'board', sessionId: body.sessionId });
      // v7：deleteSession 连带清 workPlanMeta → 通知 UI 收掉工作计划树视图
      this.emit({ type: 'workplan', sessionId: body.sessionId });
    }
    if (effect.attachedChanged !== undefined) {
      await this.reconcileAttachment(effect.attachedChanged);
    }
    // M6c：轮真正落定（引擎 TURN_SETTLED → 桥 round.settled）才做尾部拉齐——轮中"最新页"是移动目标，
    // 拉回正在流式的内容 = DB 副本与 overlay 双份渲染（用户实测击穿）；不再由 metadata.upsert 触发。
    // 本地镜像轮无 final：此信号同时是手机侧闭合该轮 overlay 锚点的唯一通路（UI 事件 roundSettled）。
    if (body.kind === 'round.settled' && typeof body.sessionId === 'string') {
      // 活合成锚收口先于附着条件（悬挂治根：settle 到达即关；桌面侧本就只发附着会话的 settle）
      this.closeMirrorAnchor(body.sessionId);
      if (body.sessionId === this.attachedIntent) {
        this.liveRoundSessionId = null;
        this.scheduleTailPull(body.sessionId, true); // settle=欠账拉：迟到冲刷点亮的活轮不拦（见 scheduleTailPull）
        this.emit({ type: 'roundSettled', sessionId: body.sessionId });
      }
    }
  }

  /**
   * attached.changed 对账（规划第三节三路径一条规则）：
   * 呈现以桌面为准（立即 emit 消"同步中"）；意图锚 = syncState（attachedIntent）——
   * 桌面通告与意图不符时按意图重 announce（owner 易主归零后的恢复路径）；
   * 环防护：同一意图值只重 announce 一次（桌面确认意图值即收敛，不乒乓）。
   * M6b：'new' 发言待收编（pendingNewChat）时，桌面轮前附着回流的非 null 值直接采纳为意图
   * + 记入口记忆（新会话 id 此刻才真正存在）；null 值不收编（等轮前附着确认）。
   */
  private async reconcileAttachment(desktopValue: string | null): Promise<void> {
    if (this.pendingNewChat && desktopValue !== null) {
      this.pendingNewChat = false;
      await this.setAttachedIntent(desktopValue);
      await this.setLastChatSession(desktopValue); // 新会话发言收编 = 入口记忆落定（"正在聊"就是它）
      this.lastReannounced = undefined;
      this.emit({ type: 'attached', sessionId: desktopValue });
      return;
    }
    this.emit({ type: 'attached', sessionId: desktopValue });
    if (desktopValue === this.attachedIntent) {
      this.lastReannounced = undefined; // 收敛：意图已确认
      return;
    }
    if (this.lastReannounced === this.attachedIntent) return;
    this.lastReannounced = this.attachedIntent;
    await this.postEnvelopeFireForget('session.attach', { sessionId: this.attachedIntent });
  }

  /** 发送 chat.user（仅配对完成后可用；M6：可携带 sessionId = 发言目标会话——发言即附着；
   *  file.*：attachments = 已完成传输（receipt ok）的附件声明；mediaItems = 回显用显示信息（含 localUri） */
  async sendChat(
    text: string,
    sessionId?: string,
    attachments?: Array<Record<string, string>>,
    mediaItems?: Array<{ ref: string; name: string; mime: string; kind: 'image' | 'file'; localUri: string | null }>,
  ): Promise<void> {
    return this.sendChatInternal(text, sessionId, attachments, mediaItems);
  }

  /**
   * file.* 单附件预传输（媒体直传优先）：发布密文 → static offer → receipt（presence 门控等待）。
   * v2 分片路径（大文件）：`localPath` 提供且 size > V2_THRESHOLD → 确定性 nonce 分片上传（断点续传）。
   * v1 整包路径（小文件）：bytes 在内存 → 单次 PUT（秒级快路）。
   * 回退网：发布失败 → 当场回退信箱分片；receipt 在线超时 → 换道分片；离线不回退（等待桌面）。
   */
  async uploadAttachment(
    f: { fileId: string; name: string; mime: string; bytes: Uint8Array; size?: number; localPath?: string },
    onProgress?: (pct: number) => void,
    onStage?: (stage: 'waiting-desktop' | 'hashing' | 'uploading') => void,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.confirmed || !this.state || !this.secrets) return { ok: false, error: '未配对或未连接' };
    const post = this.makeEnvelopePost();

    // ---------- v2 分片路径（大文件：>5MB 且有 localPath）----------
    // size 归一：显式 size（托盘大文件——bytes 空占位不进内存）优先，缺省从 bytes 推导（e2e/脚本字节形态）
    const size = f.size ?? f.bytes.length;
    if (f.localPath && size > V2_THRESHOLD_BYTES) {
      return this.uploadAttachmentV2Path({ ...f, size }, post, onProgress, onStage);
    }

    // ---------- v1 整包路径（小文件 ≤5MB） ----------
    const pub = await publishMedia({
      bytes: f.bytes,
      put: (name, wire, onPut) => this.putMedia(name, wire, onPut),
      onProgress,
    });
    if (pub.ok) {
      const offerR = await postWithRetry(
        {
          type: 'file.offer',
          body: {
            fileId: f.fileId,
            name: f.name,
            mime: f.mime,
            size: pub.size,
            sha256: pub.sha256,
            chunks: 0,
            static: { name: pub.name, key: pub.key },
          },
        },
        post,
        defaultSleep,
        5,
      );
      if (offerR === 'ok') {
        const r = await this.waitStaticReceipt(f.fileId, onStage as (stage: 'waiting-desktop') => void);
        if (r.kind === 'ok') return { ok: true };
        if (r.kind === 'terminal') return { ok: false, error: r.error };
        // 'fallback' → 换道分片
      }
    } else if (pub.reason === 'too-large') {
      return { ok: false, error: '超过 5MB 上限' };
    }
    // ---------- 信箱分片回退路径（保底） ----------
    return this.uploadViaMailboxChunks(f, post, onProgress);
  }

  /** 信箱分片回退路径（≤5MB 保底；v1/v2 发布失败或旧桌面换道均落到此） */
  private async uploadViaMailboxChunks(
    f: { fileId: string; name: string; mime: string; bytes: Uint8Array },
    post: (env: { type: string; body: Record<string, unknown> }) => Promise<number>,
    onProgress?: (pct: number) => void,
  ): Promise<{ ok: boolean; error?: string }> {
    const outcome = await uploadFile({
      fileId: f.fileId,
      name: f.name,
      mime: f.mime,
      bytes: f.bytes,
      post,
      onProgress,
    });
    if (outcome !== 'ok') {
      return { ok: false, error: outcome === 'too-large' ? '超过 5MB 上限' : `传输失败（${outcome}）` };
    }
    const receipt = await this.waitFileReceipt(f.fileId, 60_000);
    if (!receipt) return { ok: false, error: '桌面长时间未确认（可能版本过旧）' };
    return receipt;
  }

  /** v2 分片上传路径（大文件：流式哈希 → 逐片确定性加密+PUT@offset → offer → receipt） */
  private async uploadAttachmentV2Path(
    f: { fileId: string; name: string; mime: string; bytes: Uint8Array; size: number; localPath: string },
    post: (env: { type: string; body: Record<string, unknown> }) => Promise<number>,
    onProgress?: (pct: number) => void,
    onStage?: (stage: 'waiting-desktop' | 'hashing' | 'uploading') => void,
  ): Promise<{ ok: boolean; error?: string }> {
    const r = await uploadFileV2({
      path: f.localPath,
      putChunk: (name, offset, total, wire) => this.putChunkXHR(name, offset, total, wire),
      readSlice: (path, start, len) => this.readSliceFs(path, start, len),
      getFileSize: async () => f.size, // 归一后真相源：托盘=选择时 stat / 字节形态调用=bytes.length
      onProgress,
      onStage: onStage as (stage: 'hashing' | 'uploading') => void,
    });
    if (!r.ok) {
      if (r.reason === 'too-large') return { ok: false, error: '超过 100MB 上限' };
      if (r.reason === 'cancelled') return { ok: false, error: '已取消' };
      // v2 失败不回退信箱（大文件信箱装不下）——诚实报错
      return { ok: false, error: `大文件传输失败：${r.detail ?? r.reason}` };
    }
    // offer（fmt:2 + wireSize + nonce）
    const offerR = await postWithRetry(
      {
        type: 'file.offer',
        body: {
          fileId: f.fileId,
          name: f.name,
          mime: f.mime,
          size: r.size,
          sha256: r.sha256,
          chunks: 0,
          static: buildStaticV2({ name: r.name, key: r.key, nonce: r.nonce, wireSize: r.wireSize }),
        },
      },
      post,
      defaultSleep,
      5,
    );
    if (offerR === 'ok') {
      const receipt = await this.waitStaticReceipt(f.fileId, onStage as (stage: 'waiting-desktop') => void);
      if (receipt.kind === 'ok') return { ok: true };
      if (receipt.kind === 'terminal') return { ok: false, error: receipt.error };
      // 'fallback'（旧桌面）→ v2 大文件无法回退信箱（>5MB 信箱装不下）→ 诚实报错
      return { ok: false, error: '桌面版本过旧，不支持大文件接收。请更新桌面 chill。' };
    }
    return { ok: false, error: 'offer 投递失败' };
  }

  /** v2 分片 PUT（XHR + Media-Offset/Media-Total 头；409 → {conflict}；网络失败 → 0） */
  private putChunkXHR(
    name: string,
    offset: number,
    total: number,
    wire: Uint8Array,
  ): Promise<number | { conflict: number }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: number | { conflict: number }): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `${httpBase(this.state!.relay)}/media/${name}`);
        xhr.setRequestHeader('authorization', `Bearer ${this.secrets!.writeToken}`);
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.setRequestHeader('media-offset', String(offset));
        xhr.setRequestHeader('media-total', String(total));
        xhr.timeout = 60_000; // 单片 512KB@慢上行最坏 ~5s；60s 富余
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== 4) return;
          if (xhr.status === 201) {
            // 检查是否有 409 conflict 信息（服务端 409 也可能带 JSON body）
            try {
              const body = JSON.parse(xhr.responseText);
              if (body && typeof body.current === 'number') {
                done({ conflict: body.current });
                return;
              }
            } catch { /* 无 body 或非 JSON */ }
            done(201);
          } else if (xhr.status === 409) {
            try {
              const body = JSON.parse(xhr.responseText);
              done({ conflict: body.current ?? 0 });
            } catch {
              done({ conflict: 0 });
            }
          } else {
            done(xhr.status || 0);
          }
        };
        xhr.onerror = () => done(0);
        xhr.ontimeout = () => done(0);
        xhr.send(wire);
      } catch {
        done(0);
      }
    });
  }

  /** v2 文件切片读（blob-util readStream 起止偏移；RN 走真实模块，e2e/Node 注入 fake，均无则 fallback） */
  private async readSliceFs(path: string, start: number, length: number): Promise<Uint8Array> {
    const blobUtil = resolveBlobUtil();
    if (!blobUtil) {
      return this.e2eReadSlice(path, start, length);
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const stream = blobUtil.fs.readStream(path, 'base64', start, start + length - 1);
      const chunks: string[] = [];
      stream.onData((d) => chunks.push(d));
      stream.onEnd(() => {
        // base64 → Uint8Array（RN 安全：不用 atob/Buffer）
        const b64 = chunks.join('');
        const lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
        const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4));
        let p = 0;
        for (let i = 0; i < clean.length; i += 4) {
          const a = lookup.indexOf(clean[i] ?? 'A');
          const b = lookup.indexOf(clean[i + 1] ?? 'A');
          const c = lookup.indexOf(clean[i + 2] ?? 'A');
          const d = lookup.indexOf(clean[i + 3] ?? 'A');
          const tri = (a << 18) | (b << 12) | (c << 6) | d;
          if (p < bytes.length) bytes[p++] = (tri >> 16) & 0xff;
          if (p < bytes.length) bytes[p++] = (tri >> 8) & 0xff;
          if (p < bytes.length) bytes[p++] = tri & 0xff;
        }
        resolve(bytes);
      });
      stream.onError((e) => reject(e));
      stream.open();
    });
  }

  /** e2e/Node 环境的 readSlice fallback（直接从 bytes 切） */
  private e2eReadSlice(_path: string, _start: number, _length: number): Promise<Uint8Array> {
    // e2e harness 注入 bytes 时走这里；真实设备走 blob-util
    // 临时实现：后续由 e2e harness 覆写此方法或传入 bytes 引用
    return Promise.resolve(new Uint8Array(0));
  }

  /** 加密信封投递闭包（static offer 与分片路径共用——单一投递事实点） */
  private makeEnvelopePost(): (env: { type: string; body: Record<string, unknown> }) => Promise<number> {
    return async (env) => {
      const wire = encryptEnvelope(this.secrets!.keyM2D, this.deskBox, 'm2d', makeEnvelope(env.type, this.myBox, this.deskBox, env.body));
      if (!wire) return 400;
      const r = await httpJson('POST', this.state!.relay, `/box/${this.deskBox}`, {
        token: this.secrets!.writeToken,
        body: { blob: wire },
      });
      return r.status;
    };
  }

  /** 媒体密文直传（XHR——RN fetch 无上传进度；TLS 走全局 OkHttp 证书固定，真机实证项）。失败返 0 → 回退 */
  private putMedia(name: string, wire: Uint8Array, onProgress?: (pct: number) => void): Promise<number> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (s: number): void => {
        if (!settled) {
          settled = true;
          resolve(s);
        }
      };
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `${httpBase(this.state!.relay)}/media/${name}`);
        xhr.setRequestHeader('authorization', `Bearer ${this.secrets!.writeToken}`);
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.timeout = 300_000; // 5MB@慢上行最坏 ~5 分钟
        if (onProgress && xhr.upload) {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && e.total > 0) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
          };
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) done(xhr.status || 0);
        };
        xhr.onerror = () => done(0);
        xhr.ontimeout = () => done(0);
        xhr.send(wire);
      } catch {
        done(0); // XHR 构造异常 → 网络类失败 → 回退
      }
    });
  }

  /**
   * static receipt 等待（presence 门控）：
   * - ok:true receipt → ok；ok:false receipt → fallback（桌面活着但拒收 static=旧桌面 → 换道分片）
   * - 离线不回退（等待桌面——否则媒体灌回信箱，复活旧病）；在线累计满窗无回执 → fallback（旧桌面）
   * - 总时长到顶 → terminal（诚实失败；媒体在服务器 48h，可重试）
   */
  private async waitStaticReceipt(
    fileId: string,
    onStage?: (stage: 'waiting-desktop') => void,
  ): Promise<{ kind: 'ok' } | { kind: 'fallback' } | { kind: 'terminal'; error: string }> {
    let onlineAccumMs = 0;
    const start = Date.now();
    let waitingAnnounced = false;
    for (;;) {
      const online = this.isDesktopOnline();
      if (online) onlineAccumMs += STATIC_RECEIPT_TICK_MS;
      else {
        onlineAccumMs = 0;
        if (!waitingAnnounced) {
          waitingAnnounced = true;
          onStage?.('waiting-desktop');
        }
      }
      const decision = receiptWaitStep(online, onlineAccumMs, Date.now() - start);
      if (decision === 'fallback') return { kind: 'fallback' };
      if (decision === 'timeout-error') {
        return { kind: 'terminal', error: '桌面长时间未上线（媒体已在服务器保留 48 小时，稍后可重试）' };
      }
      const r = await this.waitFileReceipt(fileId, STATIC_RECEIPT_TICK_MS);
      if (r) return r.ok ? { kind: 'ok' } : { kind: 'fallback' };
    }
  }

  /**
   * file.* 协议族：带附件发言（receipt 门控——全部 receipt ok 才发 chat.user）。
   * 便捷编排（e2e/脚本用）：逐文件 uploadAttachment → 全部 ok → chat.user{attachments}。
   * 托盘 UX 用分解 API（uploadAttachment + sendChat(…, attachments)）。
   * 本地登记（字节拷私有目录 + sentAttachments 落库）是调用方职责——本方法只管协议编排。
   */
  async sendWithAttachments(
    text: string,
    files: Array<{ fileId: string; name: string; mime: string; bytes: Uint8Array; size?: number }>,
    sessionId?: string,
  ): Promise<void> {
    for (const f of files) {
      const r = await this.uploadAttachment(f);
      if (!r.ok) throw new Error(`「${f.name}」未送达：${r.error ?? '未知原因'}`);
    }
    await this.sendChatInternal(text, sessionId, buildAttachments(files));
  }

  /** file.receipt 等待器（分发层 resolve；超时返 null） */
  private fileReceiptWaiters = new Map<string, Array<(r: { ok: boolean; error?: string }) => void>>();

  /** 早到 receipt 暂存（竞态修复：桌面回执在 waitFileReceipt 注册前到达——先存后取，真机实测教训） */
  private earlyReceipts = new Map<string, { ok: boolean; error?: string }>();

  private waitFileReceipt(fileId: string, timeoutMs: number): Promise<{ ok: boolean; error?: string } | null> {
    // 先查暂存：receipt 已到（uploadFile 期间桌面就回了）→ 立即返回，不进等待
    const early = this.earlyReceipts.get(fileId);
    if (early) {
      this.earlyReceipts.delete(fileId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const cbs = this.fileReceiptWaiters.get(fileId) ?? [];
        const idx = cbs.indexOf(cb);
        if (idx >= 0) cbs.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      const cb = (r: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        resolve(r);
      };
      const list = this.fileReceiptWaiters.get(fileId) ?? [];
      list.push(cb);
      this.fileReceiptWaiters.set(fileId, list);
    });
  }

  private resolveFileReceipt(fileId: string, ok: boolean, error?: string): void {
    const cbs = this.fileReceiptWaiters.get(fileId);
    if (!cbs || cbs.length === 0) {
      // 无等待者 = receipt 早到（uploadFile 还没返回、waitFileReceipt 还没注册）→ 暂存
      this.earlyReceipts.set(fileId, { ok, ...(error !== undefined ? { error } : {}) });
      return;
    }
    this.fileReceiptWaiters.delete(fileId);
    for (const cb of cbs) cb({ ok, ...(error !== undefined ? { error } : {}) });
  }

  // ---------- d→m 文件接收（桌面发文件到手机：要约落库建卡 → 点[接收]断点续拉 → 交付 → receipt） ----------

  /** 在途拉取登记（同一 fileId 任何时刻至多一条拉取在跑——幂等闸门的进程内半） */
  private activePulls = new Set<string>();
  /** 取消登记（拉取循环片边界检查；取消 = 中止拉取保留断点，不是扔掉已拉字节） */
  private cancelledPulls = new Set<string>();

  /** d→m file.offer 入向处理：形状校验 → 归属会话解析 → receivedFiles 落库 → emit 建卡 */
  private async handleIncomingFileOffer(env: Envelope): Promise<void> {
    const offer = env.body as unknown as FileOfferBody;
    const v = validateIncomingOffer(offer);
    if (!v.ok) {
      // 形状不合法：诚实回执（桌面据此提示"待接收"以外的失败），不落库不建卡
      console.log(`[chill-dbg] file.offer 形状不合法：${v.detail}`);
      await this.postEnvelopeFireForget('file.receipt', { fileId: String(offer?.fileId ?? ''), ok: false, error: 'corrupt' });
      this.emit({ type: 'alarm', text: `收到不合法的文件要约（${v.detail}），已拒收` });
      return;
    }
    const db = this.db();
    if (!db) throw new Error('file.offer 落库不可用'); // 失败走回滚路径（分派层 catch → 回滚标记 + 不 ACK 等重投）
    // 归属不可变：offer.sessionId 原值即归属（协议 d→m 必带——卡片长在产生它的那轮对话里，不串场）。
    // 会话目录暂缺 ≠ 归属无效：保留原值等同步（catalog/history 到达后自然显示）；
    // 无归属（协议外异常）落 null——精确匹配下不显示，48h 过期清扫兜底，不再回退附着会话
    const target: string | null = typeof offer.sessionId === 'string' && offer.sessionId ? offer.sessionId : null;
    const existing = await db.getReceivedFile(offer.fileId);
    if (!existing) {
      const nowIso = new Date().toISOString();
      // ②B：锚定基线快照（桌面钟）——落库时该会话 DB 末条消息 ts；空会话/无归属 null（不参与门，保持现状位）
      const floor = target !== null ? await db.getSessionLastMessageTs(target) : null;
      await db.putReceivedFile({
        fileId: offer.fileId,
        sessionId: target,
        name: sanitizeFileName(offer.name),
        mime: typeof offer.mime === 'string' && offer.mime ? offer.mime : 'application/octet-stream',
        size: offer.size,
        sha256: offer.sha256.toLowerCase(),
        staticJson: JSON.stringify(offer.static),
        expiresAt: typeof offer.expiresAt === 'number' ? offer.expiresAt : null,
        state: 'offered',
        stagingPath: null,
        contentUri: null,
        error: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        anchorFloorTs: floor,
        anchorTs: null,
      });
    }
    const row = await db.getReceivedFile(offer.fileId);
    if (row) this.emit({ type: 'fileOffer', card: receivedFileRowToCard(row) });
  }

  /**
   * ②B 迟到锚定：UI reloadDb 完成钩子调用（门 a=无进行中轮在 UI 侧 busy 同源判定后调用；
   * 门 a 保证 DB 尾部=归属轮真末条）。编排收敛在此（receivedFiles 单一写入者纪律）：
   * 扫描 anchorTs IS NULL（显式谓词，已锚卡永不重扫）→ 会话末条 ts（DB 直查，非组件渲染窗口）
   * → computeAnchorTs 纯函数（门 b 同钟系有效性 + 递增保序）→ 批量 UPDATE → emit fileAnchored。
   * 幂等：门 b 不过留待下一钩子；空会话/无末条不锚；重投 existing 闸门不动锚定列。
   */
  async anchorPendingReceivedFiles(sessionId: string): Promise<void> {
    const db = this.db();
    if (!db) return;
    const pending = await db.listUnanchoredReceivedFiles(sessionId);
    if (pending.length === 0) return;
    const lastTs = await db.getSessionLastMessageTs(sessionId);
    if (lastTs === null) return; // 空会话：floor=null 的卡本就不满足门 b，此处防御一致性直接返回
    const updates = computeAnchorTs(
      pending.map((p) => ({ fileId: p.fileId, createdAt: p.createdAt, anchorFloorTs: p.anchorFloorTs })),
      lastTs,
    );
    if (updates.length === 0) return;
    await db.updateReceivedFileAnchors(updates);
    this.emit({ type: 'fileAnchored', sessionId });
  }

  /**
   * d→m [接收]/[重试]：幂等闸门（仅 offered/failed 可发起，pulling 重复点击/交错重试一律忽略）
   * → 状态推进落库+emit → mediaFetcher 断点续拉 → 交付（MediaStore Downloads/chill/）→ receipt。
   * receipt 是送达的唯一真相源：成功 ok:true / 失败 ok:false+error（expired/corrupt/io/aborted）。
   */
  async receiveFile(fileId: string): Promise<void> {
    const db = this.db();
    if (!db || !this.confirmed || !this.state || !this.secrets) return;
    const row = await db.getReceivedFile(fileId);
    if (!row) return;
    if (row.state !== 'offered' && row.state !== 'failed') return; // 幂等闸门
    if (this.activePulls.has(fileId)) return;
    // 过期本地判（不消耗一次必然 410 的网络请求）：置 expired + 丢弃断点 + 清密钥列（阅后即焚）+ 回执
    if (row.expiresAt !== null && Date.now() > row.expiresAt) {
      await this.recvTempDiscard(fileId);
      await db.updateReceivedFileState(fileId, 'expired');
      await db.clearReceivedFileSecret(fileId);
      this.emit({ type: 'fileState', fileId, state: 'expired' });
      await this.postEnvelopeFireForget('file.receipt', { fileId, ok: false, error: 'expired' });
      return;
    }
    let staticPtr: FileOfferBody['static'];
    try {
      staticPtr = JSON.parse(row.staticJson) as FileOfferBody['static'];
    } catch {
      await db.updateReceivedFileState(fileId, 'failed', { error: '要约指针损坏，无法拉取' });
      this.emit({ type: 'fileState', fileId, state: 'failed', error: '要约指针损坏，无法拉取' });
      return;
    }
    this.activePulls.add(fileId);
    this.cancelledPulls.delete(fileId);
    try {
      await db.updateReceivedFileState(fileId, 'pulling');
      this.emit({ type: 'fileState', fileId, state: 'pulling' });
      const offer: FileOfferBody = {
        fileId: row.fileId,
        name: row.name,
        mime: row.mime,
        size: row.size,
        sha256: row.sha256,
        chunks: 0,
        ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
        static: staticPtr,
      };
      const outcome = await fetchOfferedFile({
        offer,
        urlFor: (name) => `${httpBase(this.state!.relay)}/static/media/${name}`,
        getRange: (url, start, end) => this.getRangeStatic(url, start, end),
        appendTemp: (id, bytes) => this.recvTempAppend(id, bytes),
        tempSize: (id) => this.recvTempSize(id),
        hashTemp: (id) => this.recvTempHash(id),
        finalizeTemp: (id) => this.recvTempFinalize(id),
        discardTemp: (id) => this.recvTempDiscard(id),
        onProgress: (received, total) => this.emit({ type: 'fileProgress', fileId, received, total }),
        isCancelled: () => this.cancelledPulls.has(fileId),
      });
      if (!outcome.ok) {
        if (outcome.error === 'aborted') {
          // 取消 = 停下来不是扔掉：回 offered，断点保留，再点[接收]从断点续拉
          await db.updateReceivedFileState(fileId, 'offered');
          this.emit({ type: 'fileState', fileId, state: 'offered' });
          await this.postEnvelopeFireForget('file.receipt', { fileId, ok: false, error: 'aborted' });
          return;
        }
        const state: ReceivedFileState = outcome.error === 'expired' ? 'expired' : 'failed';
        await db.updateReceivedFileState(fileId, state, { error: outcome.detail ?? outcome.error });
        if (state === 'expired') await db.clearReceivedFileSecret(fileId); // 阅后即焚（failed 保留 staticJson 供重试）
        this.emit({ type: 'fileState', fileId, state, ...(outcome.detail !== undefined ? { error: outcome.detail } : {}) });
        await this.postEnvelopeFireForget('file.receipt', { fileId, ok: false, error: outcome.error });
        return;
      }
      // 交付（MediaStore Downloads/chill/）→ 清理暂存明文 → done + receipt ok
      const delivery = await deliverToDownloads(outcome.stagingPath, outcome.safeName, row.mime);
      await this.recvDiscardPath(outcome.stagingPath); // 交付后清理暂存明文（成败都删——失败重试走重新拉取）
      if (!delivery.ok) {
        await db.updateReceivedFileState(fileId, 'failed', { error: delivery.detail });
        this.emit({ type: 'fileState', fileId, state: 'failed', error: delivery.detail });
        await this.postEnvelopeFireForget('file.receipt', { fileId, ok: false, error: 'io' });
        return;
      }
      // 阅后即焚：密钥材料栈帧随返回释放 + DB 密钥列清空（done 卡 [打开] 只靠 contentUri）
      await db.updateReceivedFileState(fileId, 'done', { contentUri: delivery.contentUri });
      await db.clearReceivedFileSecret(fileId);
      this.emit({ type: 'fileState', fileId, state: 'done', contentUri: delivery.contentUri });
      await this.postEnvelopeFireForget('file.receipt', { fileId, ok: true });
    } finally {
      this.activePulls.delete(fileId);
      this.cancelledPulls.delete(fileId);
    }
  }

  /** d→m [取消]：登记取消标记，拉取循环在下一片边界收口（断点保留，回到 offered 可续） */
  cancelReceiveFile(fileId: string): void {
    if (this.activePulls.has(fileId)) this.cancelledPulls.add(fileId);
  }

  /**
   * d→m 启动/重连清扫：offered 且 expiresAt 已过期 → expired + 丢弃 .part（诚实显示+清场，不发 receipt）；
   * pulling → 复位 offered（进程已死拉取中断，.part 断点保留，用户再点[接收]即从断点续拉）。
   */
  private async sweepReceivedFiles(): Promise<void> {
    const db = this.db();
    if (!db) return;
    let rows: ReceivedFileRow[];
    try {
      rows = await db.listPendingReceivedFiles();
    } catch {
      return;
    }
    const now = Date.now();
    for (const r of rows) {
      if (r.state === 'pulling') {
        await db.updateReceivedFileState(r.fileId, 'offered');
        this.emit({ type: 'fileState', fileId: r.fileId, state: 'offered' });
      } else if (r.state === 'offered' && r.expiresAt !== null && now > r.expiresAt) {
        await this.recvTempDiscard(r.fileId);
        await db.updateReceivedFileState(r.fileId, 'expired');
        await db.clearReceivedFileSecret(r.fileId); // 阅后即焚：过期清场连密钥列一并清
        this.emit({ type: 'fileState', fileId: r.fileId, state: 'expired' });
      }
    }
    // 暂存目录对账（v8+，级联消亡的 FS 侧收口）：chill-recv/ 全目录对照非终态行 fileId，
    // 无主文件（行已随会话级联删 / 终态行残留 / 历史存量孤儿）删除——FS↔DB 状态式收敛，
    // 一处闭合所有删行路径。fail-closed：读库失败什么都不删；blobUtil 不可用/
    // 目录不存在（真机 ENOENT）/列举失败 → 跳过整块（不劣于现状）
    try {
      const known = new Set(await db.listReceivedFileIds());
      const fs = this.recvFs();
      if (!fs) return;
      const dir = `${fs.fs.dirs.DocumentDir}/chill-recv`;
      let entries: string[];
      try {
        entries = await fs.fs.ls(dir);
      } catch {
        return; // 目录不存在/列举失败：跳过对账（不劣于现状）
      }
      for (const basename of reconcileRecvDir(entries, known, this.activePulls)) {
        // 删除路径自拼接（谓词输出恒 basename 契约）——与 ls 返回形态彻底无关；
        // 单个失败不中断，下轮 sweep 幂等重试
        await fs.fs.unlink(`${dir}/${basename}`).catch(() => {});
      }
    } catch {
      /* 读库失败 fail-closed：什么都不删 */
    }
  }

  /** d→m 分片拉取（GET /static/media/<name> + Range；静态通道公开读——不可猜名即读取凭据，TLS 走全局证书固定） */
  private async getRangeStatic(url: string, start: number, end: number): Promise<Uint8Array> {
    const res = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
    if (res.status !== 206 && res.status !== 200) throw new FetchHttpError(res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---------- d→m 拉取暂存（.part=已认证明文断点；blob-util 经 blobUtil.ts 三级链获取——e2e 注入优先，真机惰性 require 真实模块兜底） ----------

  private recvFs(): { fs: BlobUtilFs } | null {
    return resolveBlobUtil();
  }

  private recvTempPath(fileId: string): string {
    const fs = this.recvFs();
    return `${fs!.fs.dirs.DocumentDir}/chill-recv/${fileId}.part`;
  }

  private async recvTempAppend(fileId: string, bytes: Uint8Array): Promise<void> {
    const fs = this.recvFs();
    if (!fs) throw new Error('无本地存储能力');
    const dir = `${fs.fs.dirs.DocumentDir}/chill-recv`;
    if (!(await fs.fs.isDir(dir))) await fs.fs.mkdir(dir);
    await fs.fs.appendFile(this.recvTempPath(fileId), bytesToB64(bytes), 'base64');
  }

  private async recvTempSize(fileId: string): Promise<number> {
    const fs = this.recvFs();
    if (!fs) return 0;
    try {
      const st = await fs.fs.stat(this.recvTempPath(fileId));
      return Number(st.size);
    } catch {
      return 0; // 无暂存 = 0（从头拉）
    }
  }

  private async recvTempHash(fileId: string): Promise<string> {
    const fs = this.recvFs();
    if (!fs) throw new Error('无本地存储能力');
    return fs.fs.hash(this.recvTempPath(fileId), 'sha256');
  }

  /** 定稿：.part → 去后缀的暂存明文路径（交付层读取源；交付后由 recvDiscardPath 清理） */
  private async recvTempFinalize(fileId: string): Promise<string> {
    const fs = this.recvFs();
    if (!fs) throw new Error('无本地存储能力');
    const part = this.recvTempPath(fileId);
    const staging = part.replace(/\.part$/, '');
    await fs.fs.mv(part, staging);
    return staging;
  }

  /** 丢弃该 fileId 的全部暂存（双删：.part 断点 + staging 明文——任一存在即清；
   * 过期/取消/损坏清场的完整语义；不存在则静默，幂等） */
  private async recvTempDiscard(fileId: string): Promise<void> {
    const fs = this.recvFs();
    if (!fs) return;
    const part = this.recvTempPath(fileId);
    await fs.fs.unlink(part).catch(() => {});
    await fs.fs.unlink(part.replace(/\.part$/, '')).catch(() => {});
  }

  private async recvDiscardPath(path: string): Promise<void> {
    const fs = this.recvFs();
    if (!fs) return;
    await fs.fs.unlink(path).catch(() => {});
  }

  private async sendChatInternal(
    text: string,
    sessionId?: string,
    attachments?: Array<Record<string, string>>,
    mediaItems?: Array<{ ref: string; name: string; mime: string; kind: 'image' | 'file'; localUri: string | null }>,
  ): Promise<void> {
    if (!this.confirmed || !this.state || !this.secrets) return;
    const { text: t, truncated } = truncateToBudget(text);
    const env = makeEnvelope('chat.user', this.myBox, this.deskBox, {
      text: t,
      ...(truncated ? { truncated: true } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    const wire = encryptEnvelope(this.secrets.keyM2D, this.deskBox, 'm2d', env);
    if (!wire) throw new Error('消息超线上字节上限');
    const r = await httpJson('POST', this.state.relay, `/box/${this.deskBox}`, {
      token: this.secrets.writeToken,
      body: { blob: wire },
    });
    if (r.status !== 201) throw new Error(`投递失败 HTTP ${r.status}`);
    if (sessionId === 'new') {
      this.pendingNewChat = true;
    } else if (sessionId !== undefined && sessionId !== this.attachedIntent) {
      await this.setAttachedIntent(sessionId);
    }
    // 回显：有附件时 kind='media' 携带显示信息（缩略图/芯片）——id=env.id=轮锚点，
    // 落定后被锚点清除、由历史行无缝接管（用户发出什么就立刻看到什么）
    this.emit({
      type: 'message',
      message: {
        id: env.id,
        dir: 'out',
        text,
        kind: mediaItems?.length ? 'media' : 'chat.user',
        ts: env.ts,
        // 归属盖戳（串场根治回显侧）：显式目标优先；收编窗口内（pendingNewChat=true、attach 未回流）
        // 戳 'new'（自屏放行、栈下他屏丢弃，兼堵自屏丢显）；无附着退化为无戳放行（旧桌面/冷启动兜底）
        sessionId: sessionId ?? (this.pendingNewChat ? 'new' : this.attachedIntent) ?? undefined,
        ...(mediaItems?.length ? { media: { items: mediaItems } } : {}),
      },
    });
  }

  /** 重新配对：revoke 对向信箱 + 清本地状态（手机丢失止血/换机引导）+ M6 清空 sqlite 全部副本（数据生命周期闭环） */
  async resetPairing(): Promise<void> {
    if (this.state && this.secrets) {
      const s = this.state;
      await httpJson('DELETE', s.relay, `/box/${this.deskBox}`, { token: this.secrets.revokeToken }).catch(() => {});
    }
    await clearPhoneState();
    // M6：副本库整库清空（agents/projects/sessions/messages/syncState）——不留旧桌面数据（泄露面+混淆源）
    const db = this.db();
    if (db) await db.wipeAll().catch(() => {});
    this.attachedIntent = null;
    this.activeSessionId = null;
    this.lastChatSessionId = null;
    this.mirrorAnchors.clear();
    this.parkedBubbles.clear(); // 重配对数据生命周期闭环：停车场随副本库一并清空
    this.pendingNewChat = false;
    this.coldStart = true;
    this.lastReannounced = undefined;
    this.liveRoundSessionId = null;
    this.presenceActive = false;
    this.presenceMisses = 0;
    this.lastDesktopAliveAt = 0;
    this.markDesktopOffline(); // 清探活定时器 + 若曾在线则发离线通知
    this.catalogCollector = new CatalogChunkCollector();
    this.boardCollector = new BoardChunkCollector();
    this.workPlanCollector = new WorkPlanChunkCollector();
    this.feedOverlay = new FeedOverlay();
    if (this.tailPullTimer) {
      clearTimeout(this.tailPullTimer);
      this.tailPullTimer = null;
    }
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setState('need-pairing');
  }

  getDeskName(): string {
    return this.deskName || '我的桌面';
  }

  isPaired(): boolean {
    return this.confirmed;
  }
}
