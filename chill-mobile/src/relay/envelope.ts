// 本文件由 scripts/sync-envelope.mjs 从 chill core 拷贝生成，禁止手改（单源在 core/src/services/relay/envelope.ts）
/**
 * chill-relay 信封层（E2E 加密内载荷）——平台无关纯逻辑。
 *
 * 红线（PROTOCOL-FROZEN.md 冻结项，改此文件 = 协议 bump）：
 * - 纯 import 风格；禁止引入 node:* 与 Buffer（renderer/RN 安全）。
 * - 套件：X25519 → HKDF-SHA256(salt="chill-relay-v1") → 分方向钥/派生令牌；
 *   XSalsa20-Poly1305（nacl.secretbox）；编码一律 base64url；mailboxId 用 hex。
 *
 * 实现说明：tweetnacl 的 secretbox 无独立 AAD 形参，AAD = mailboxId‖direction‖v
 * 以明文首行形式嵌入认证明文（Poly1305 对整段明文做认证，绑定强度等价，
 * AAD 篡改必然解密/校验失败）。线格式：base64url(nonce‖ciphertext)。
 */
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import { bytesToHex } from '@noble/hashes/utils';

// 注意 tweetnacl-util 的命名反直觉：decodeUTF8 = string→bytes，encodeUTF8 = bytes→string
const { encodeBase64, decodeBase64 } = util;
const utf8ToBytes = util.decodeUTF8;
const bytesToUtf8 = util.encodeUTF8;

// ---------- 冻结常量（见 PROTOCOL-FROZEN.md） ----------
export const HKDF_SALT = 'chill-relay-v1';
export const ENVELOPE_VERSION = 1;
/** 信封明文预算（字节），对应 64KB 线上字节边界 */
export const PLAINTEXT_BUDGET_BYTES = 45 * 1024;
/** 单条消息线上字节上限（base64url 后） */
export const MAX_WIRE_BYTES = 64 * 1024;
// ---------- 文件传输常量（file.* 协议族；双端同值，envelope.ts 单源经 sync-envelope 同步手机） ----------
/** 单块二进制载荷上限（base64url 膨胀 4/3 + 信封开销 ≈ 43KB，留 45KB 预算余量） */
export const FILE_CHUNK_BYTES = 32 * 1024;
/** 单文件上限（双端 offer 预检同值拒绝；统一帽，无类型特判） */
export const FILE_MAX_BYTES = 5 * 1024 * 1024;
/** 桌面并发未完成传输总量帽（防塞内存） */
export const FILE_MAX_PENDING_BYTES = 20 * 1024 * 1024;
/** 未完成传输缓冲 TTL（超时丢弃，手机重发全量 chunk 幂等收敛） */
export const FILE_TRANSFER_TTL_MS = 10 * 60 * 1000;
/** 完成态元数据保留时长（防 chat.user 排在长引擎轮后、已完成映射过期导致误拒） */
export const FILE_SETTLED_TTL_MS = 30 * 60 * 1000;
/** ts 粗筛窗口：偏离本地时钟 ±5 分钟丢弃 */
export const TS_SKEW_MS = 5 * 60 * 1000;
export const MAILBOX_ID_LEN = 32; // sha256hex 前 32 字符

export type Direction = 'd2m' | 'm2d';

export interface KeyPairB64 {
  publicKey: string; // base64url
  secretKey: string; // base64url
}

/** 五个派生物：两个方向加密钥 + 三个 Bearer 令牌（服务器只存哈希） */
export interface DerivedSecrets {
  keyD2M: Uint8Array; // 桌面→手机
  keyM2D: Uint8Array; // 手机→桌面
  writeToken: string; // base64url
  readToken: string; // base64url
  revokeToken: string; // base64url
}

export interface Envelope {
  v: number;
  type: string;
  id: string;
  ts: number;
  from: string;
  to: string;
  replyTo?: string;
  body: Record<string, unknown>;
}

// ---------- base64url ----------
export function b64uEncode(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('invalid base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  return decodeBase64(b64 + '='.repeat(pad));
}

export function isB64u(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s);
}

// ---------- 密钥协商与派生 ----------
export function generateKeyPair(): KeyPairB64 {
  const kp = nacl.box.keyPair();
  return { publicKey: b64uEncode(kp.publicKey), secretKey: b64uEncode(kp.secretKey) };
}

export function keyPairFromSecretKey(secretKeyB64u: string): KeyPairB64 {
  const kp = nacl.box.keyPair.fromSecretKey(b64uDecode(secretKeyB64u));
  return { publicKey: b64uEncode(kp.publicKey), secretKey: secretKeyB64u };
}

/** X25519 ECDH → 32B shared_secret */
export function ecdhShared(mySecretKeyB64u: string, peerPublicKeyB64u: string): Uint8Array {
  return nacl.box.before(b64uDecode(peerPublicKeyB64u), b64uDecode(mySecretKeyB64u));
}

function hkdfLabel(shared: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, shared, utf8ToBytes(HKDF_SALT), utf8ToBytes(info), 32);
}

export function deriveSecrets(shared: Uint8Array): DerivedSecrets {
  return {
    keyD2M: hkdfLabel(shared, 'd2m'),
    keyM2D: hkdfLabel(shared, 'm2d'),
    writeToken: b64uEncode(hkdfLabel(shared, 'write')),
    readToken: b64uEncode(hkdfLabel(shared, 'read')),
    revokeToken: b64uEncode(hkdfLabel(shared, 'revoke')),
  };
}

/** 服务器侧凭据：sha256hex(token 的 utf8 字节) */
export function tokenHash(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token)));
}

/** mailboxId = SHA-256(设备 X25519 公钥) hex 前 32 字符 */
export function mailboxIdFromPub(publicKeyB64u: string): string {
  return bytesToHex(sha256(b64uDecode(publicKeyB64u))).slice(0, MAILBOX_ID_LEN);
}

/**
 * 密钥确认（唯一信任锚）：pairingMAC = HMAC-SHA256(key=token 的 utf8 字节,
 * msg = deskPub 原始 32B ‖ phonePub 原始 32B)，输出 base64url。
 */
export function pairingMAC(token: string, deskPubB64u: string, phonePubB64u: string): string {
  const desk = b64uDecode(deskPubB64u);
  const phone = b64uDecode(phonePubB64u);
  const msg = new Uint8Array(desk.length + phone.length);
  msg.set(desk, 0);
  msg.set(phone, desk.length);
  return b64uEncode(hmac(sha256, utf8ToBytes(token), msg));
}

// ---------- AAD 与加解密 ----------
export function aadFor(mailboxId: string, direction: Direction, v: number = ENVELOPE_VERSION): string {
  return `${mailboxId}|${direction}|${v}`;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * 加密信封：AAD 首行嵌入明文 → secretbox → base64url(nonce‖ciphertext)。
 * 返回 null 表示超线上字节上限（调用方应先 truncateToBudget）。
 */
export function encryptEnvelope(
  key: Uint8Array,
  mailboxId: string,
  direction: Direction,
  env: Envelope,
): string | null {
  const aad = aadFor(mailboxId, direction, env.v);
  const plain = utf8ToBytes(aad + '\n' + JSON.stringify(env));
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(plain, nonce, key);
  const wire = b64uEncode(concatBytes(nonce, ct));
  if (wire.length > MAX_WIRE_BYTES) return null;
  return wire;
}

export type DecryptResult = { ok: true; envelope: Envelope } | { ok: false };

/** 解密信封：任一环节失败（格式/MAC/AAD/JSON）统一返回 {ok:false}，fail-closed。 */
export function decryptEnvelope(
  key: Uint8Array,
  mailboxId: string,
  direction: Direction,
  wire: string,
): DecryptResult {
  try {
    if (wire.length > MAX_WIRE_BYTES || !isB64u(wire)) return { ok: false };
    const raw = b64uDecode(wire);
    const nLen = nacl.secretbox.nonceLength;
    if (raw.length <= nLen + nacl.secretbox.overheadLength) return { ok: false };
    const nonce = raw.slice(0, nLen);
    const ct = raw.slice(nLen);
    const plain = nacl.secretbox.open(ct, nonce, key);
    if (!plain) return { ok: false };
    const text = bytesToUtf8(plain);
    const nl = text.indexOf('\n');
    if (nl < 0) return { ok: false };
    if (text.slice(0, nl) !== aadFor(mailboxId, direction)) return { ok: false };
    const env = JSON.parse(text.slice(nl + 1)) as Envelope;
    if (!isEnvelopeShape(env)) return { ok: false };
    return { ok: true, envelope: env };
  } catch {
    return { ok: false };
  }
}

// ---------- 信封构造与校验 ----------
export function randomUuid(): string {
  const b = nacl.randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const KNOWN_TYPES = new Set([
  'pair.hello',
  'pair.confirm',
  'chat.user',
  'chat.event',
  // M4 审批信封（PROTOCOL-FROZEN 二期预留命名空间，v=1 加法扩展）
  'approval.request',
  'approval.response',
  'approval.resolved',
  // M4e 通用提问信封（问人原语桥接，v=1 加法扩展）
  'ask.request',
  'ask.response',
  'ask.resolved',
  // M4e 订阅信号：手机每次连接建立后发送（空 body）→ 桌面重推未决审批/提问
  // （手机侧重启/重连这一端没有任何既有信号触发桌面 resync——实测击穿：卡已 ACK 信箱不重投，
  //  桌面连接未断不 resync，未决卡片在手机重启后消失）
  'chat.sync',
  // M5 权限模式信封（单真相源同步，v=1 加法扩展）：mode.set=手机请求变更；mode.state=桌面广播当前档
  'mode.set',
  'mode.state',
  // M6 会话同步信封（双端会话同步：目录对账 + 历史按需拉 + 附着订阅，v=1 加法扩展）
  'catalog.sync',
  'catalog.state',
  'history.request',
  'history.page',
  'session.attach',
  'session.event',
  // M6c 在线探活（手机前台周期 ping → 桌面立即 pong；任何桌面来信即"在线"证据。
  // 不采用"桌面周期心跳"：手机离线时心跳会堆满信箱（7 天 ≈ 40 万条，撑爆配额），
  // 反向按需探活的堆积被"手机前台时长"严格限住）
  'presence.ping',
  'presence.pong',
  // M7 共享看板同步信封（快照同步，无增量事件通道；v=1 加法扩展）
  'board.sync',
  'board.state',
  // 工作计划树同步信封（workplan.*：主会话任务清单镜像的快照同步；与 board.* 同族——
  // 快照同步无增量事件通道、300ms 防抖、附着门控、rev 单调对账、45KB 分片骨架、重连 resync 补推；
  // 树形状从第一天即终态[children 预留嵌套]，迭代 0 只含清单项平铺；additive v=1 加法扩展）
  'workplan.sync',
  'workplan.state',
  // M7 subagent 事实流（启用预留 feed.*：Worker 工具调用事实按 toolCallId 归并的 status 流；
  // 手机侧 latest-wins overlay，不落库——事实是过程态，真相在 board.state 行与 history）
  'feed.subagent',
  // M8 命令面信封（cmd.*：命令=core 能力[注册表数据驱动，未来命令零协议改动]，呈现=壳本地；
  // additive v=1 不变，旧端安全丢弃——未识别 type 一律丢弃并忽略）
  'cmd.sync',
  'cmd.request',
  'cmd.result',
  'cmd.state',
  // 文件传输信封（file.*：手机→桌面附件分块传输，端到端加密走既有信箱通道；
  // additive v=1 不变，旧端安全丢弃。传输类型无关——name/mime 只是元数据，
  // "文件如何被模型消费"完全在桌面既有摄入管线，协议只搬字节）
  'file.offer',
  'file.chunk',
  'file.abort',
  'file.receipt',
]);

// ---------- M6 会话同步信封 body 类型（v=1 加法扩展；语义与字段表见 PROTOCOL-FROZEN.md） ----------
// 注意：本文件经 sync-envelope.mjs 逐字拷贝进手机侧，必须保持自包含——
// 以下类型为协议线形的唯一事实点，core SessionSyncService 的产出类型经 import type 对齐本文件，不双源。

/** catalog.state 的项目条目（形状与 core ProjectRecord 结构一致；自包含定义保本文件零外部引用） */
export interface CatalogProjectMeta {
  id: string;
  name: string;
  /** ISO 时间串 */
  createdAt: string;
  /** ISO 时间串 */
  updatedAt: string;
  order: number;
  archived?: boolean;
  folderPath?: string;
}

/**
 * 目录会话元数据条目（catalog.state.sessions 与 session.event 的 metadata.upsert/session.created 共用）。
 * projectId 归一化规则（双端同一规则两个执行点）：指向不存在/已删除项目时按未分组呈现——
 * 桌面 buildCatalog 输出即归一化为 null；手机对 projectId 不在已知项目集合的会话同样按未分组渲染。
 */
export interface CatalogSessionMeta {
  id: string;
  title: string;
  titleSource?: 'default' | 'auto' | 'manual';
  projectId: string | null;
  workdir?: string;
  /** ISO 时间串 */
  createdAt: string;
  /** ISO 时间串 */
  updatedAt: string;
  /** 首条 user 消息纯文本（空白归一）前 100 字 */
  preview: string;
}

/** catalog.sync（m→d）：手机连上/重连时上报已知版本，触发对账；为空/异常 → 桌面回全量 */
export interface CatalogSyncBody {
  /** 手机最近一期 catalog.state 的 projectsRev */
  projectsRev?: string;
  /** { [sessionId]: updatedAt }——手机最近一期 catalog.state 里各会话的 updatedAt */
  sessions?: Record<string, string>;
}

/**
 * catalog.state（d→m）：full=true 全量，其后仅增量（sessions=upserts、deletes=消失会话 id 清单；
 * projects 仅在 projectsRev 变化时携带全量整表，手机整表替换）。
 */
export interface CatalogStateBody {
  projects: CatalogProjectMeta[];
  sessions: CatalogSessionMeta[];
  deletes?: string[];
  activeSessionId: string | null;
  /** 桌面当前项目集合修订号：手机存储并随下次 catalog.sync 上报 */
  projectsRev: string;
  full: boolean;
  /** 超 45KB 明文预算分片（同 replyTo 归组）：chunk 从 0 起，chunks 为总数 */
  chunk?: number;
  chunks?: number;
  /**
   * 运行中会话全集快照（易变态，与 activeSessionId 同类——重连对账的自愈载体；分片时随 chunk 0 搭车）。
   * 缺省 = 宿主未装配 getRunningSessionIds（旧语义，手机侧保持现状不动）。
   */
  runningSessionIds?: string[];
}

/** history.request（m→d）：拉某会话历史，游标分页（倒序向过去翻，before=已持有的最早 msgKey） */
export interface HistoryRequestBody {
  sessionId: string;
  before?: string;
  limit?: number;
}

/** 传输形态消息（history.page 的 messages 条目；手机渲染据 kind 前进） */
export interface SyncMessage {
  /** 消息身份键（= SessionPersistence.messageKey；手机幂等主键的一部分） */
  msgKey: string;
  role: string;
  /** text=正文 / tool=工具行精简载荷 / notice=synthetic 合成消息提示行 / media=图/视频/音频占位"请在桌面查看" */
  kind: 'text' | 'tool' | 'notice' | 'media';
  /** ISO 时间串 */
  ts: string;
  text: string;
  reasoningContent?: string;
  thinkingDurationMs?: number;
  /** kind=tool：工具名 + 状态（text 为 ≤4000 字符结果预览） */
  toolName?: string;
  toolStatus?: string;
  /** 单条超预算被截断（手机标注"请在桌面查看"） */
  truncated?: boolean;
  /**
   * kind=media 的附件引用回填（additive）：ref=手机传输 fileId + 名称/mime 元数据。
   * 手机侧据此查本地登记表渲染——图片命中→缩略图持久显示、文件/视频→芯片（元数据即够，永不降级）；
   * 未命中（换机重配对/清数据）→ 图片诚实降级占位行。无 refs 的 media 行（桌面侧产生的媒体）照旧占位。
   */
  refs?: Array<{ ref: string; name: string; mime: string }>;
  /** 客户端消息身份（additive；仅 relay 来源用户消息携带，= 其 chat.user 信封 id）：手机 overlay 气泡与 DB 行同 id 的回声匹配键；旧端忽略 */
  clientId?: string;
}

/**
 * history.page（d→m）：页大小=min(20 条, ~32KB)；页内按时间升序；
 * before 锚点找不到（被压缩/再生抹掉）回退最新一页，手机按 msgKey 幂等归并。
 */
export interface HistoryPageBody {
  sessionId: string;
  messages: SyncMessage[];
  /** 还有更早消息时 = 本页最早一条的 msgKey（下一页 history.request 的 before） */
  nextBefore?: string;
  done: boolean;
  /** 会话不存在（已被删除） */
  notFound?: boolean;
}

/** session.attach（m→d）：附着/脱离订阅；请求-确认制（确认=session.event attached.changed），未确认前不假落定 */
export interface SessionAttachBody {
  sessionId: string | null;
}

export type SessionEventKind =
  | 'metadata.upsert'
  | 'title.changed'
  | 'session.created'
  | 'session.deleted'
  | 'active.changed'
  | 'attached.changed'
  | 'history.invalidated'
  | 'round.settled'
  | 'running.changed';

/**
 * session.event（d→m）：目录/元数据增量 + 附着确认 + 历史失效信号。
 * 一律不携带正文——正文只有两个通道：history.page（按需拉）与 chat.event（附着会话实时流）。
 */
export interface SessionEventBody {
  kind: SessionEventKind;
  /** session.deleted / active.changed / attached.changed / history.invalidated / title.changed / running.changed 的目标会话 */
  sessionId?: string | null;
  /** metadata.upsert / session.created 的元数据行 */
  session?: CatalogSessionMeta;
  /** title.changed 的新标题 */
  title?: string;
  titleSource?: 'default' | 'auto' | 'manual';
  /** running.changed：该会话轮次启动(true)/落定(false)——后台会话也在内（本 kind 是镜像门控的唯一例外） */
  running?: boolean;
  /**
   * running.changed：全量快照随行（发送侧应用增量后的完整运行集合）。在场 → 手机整替集合（sessionId
   * 省略 + 仅本字段 = 纯快照形态，5min 周期重申用）；缺省 → 按 running 增量。任一转换到达即全量自愈，
   * 根治"最后一帧丢失→转圈不灭"的逐会话独立残余风险。
   */
  runningAll?: string[];
}

// ---------- M7 共享看板同步信封 body 类型（v=1 加法扩展；语义与字段表见 PROTOCOL-FROZEN.md） ----------

/** board.sync（m→d）：拉某会话的看板快照；rev=手机已知 revision（对账触发），空/缺省=全量 */
export interface BoardSyncBody {
  sessionId: string;
  rev?: string | number;
}

/**
 * board.state 投影行的传输形态（= boardProjection.rows 的线形子集；detail 只带分态关键字段）。
 * status 六态：pending/in_progress/blocked/completed/cancelled/failed（label 为徽章文案，随行下发=core 算好壳零判定）。
 */
export interface BoardRowWire {
  itemId: string;
  title: string;
  assignee: string | null;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled' | 'failed';
  /** 行态徽章文案：待认领/需拍板/待裁决/进行中/已交付/已取消 */
  label: string;
  progressText: string | null;
  /** "认领 N 分钟"计时基线（缺省=不显示时长） */
  claimedAt?: number;
  /** 限窗裁剪标记（要你行永不裁剪） */
  clipped?: boolean;
  detail: {
    /** blocked 时=受阻原因 */
    blockedReason?: string;
    /** result 全文（超 4KB 已截断并明示） */
    result?: string;
    resultTruncated?: boolean;
    releaseHistory?: { by: string; reason: string; suggestedTo?: string; at: number }[];
    failCount?: number;
    /** 认领任务绑定键（= feed.subagent.taskId，行↔feed 归属键；只增） */
    claimedByTaskId?: string;
  };
}

/** board.state 折叠条（焦点批次行集的视图模型） */
export interface BoardStripWire {
  status: 'running' | 'settled';
  /** running 计数=终态/总行（如 "2/5"） */
  countText: string;
  /** settled 文案：无归档「N 个子任务完成」/有归档「结清 · N 完成 M 归档」 */
  settleText?: string;
  needsYou: boolean;
}

/** board.state 要你信号（待认领∪需拍板∪待裁决∪pendingAskCount∪pendingApprovalCount 全板） */
export interface BoardNeedsYouWire {
  needed: boolean;
  count: number;
}

/**
 * board.state（d→m）：投影随 state 下发（core 算好壳零判定）；rev=桌面当前板 revision（字符串，手机单调收敛 latest-wins）。
 * full=true 全量（rows 为完整行集，手机整表替换）；full=false 纯对账确认（rows 空，标量照带供徽标收敛）。
 * 超 45KB 明文预算分片（同 replyTo 归组）：chunk 0 携带标量与首批 rows，其余 chunk 仅 rows 切片。
 */
export interface BoardStateBody {
  sessionId: string;
  rev: string;
  rows: BoardRowWire[];
  strip: BoardStripWire;
  needsYou: BoardNeedsYouWire;
  windowed: boolean;
  full: boolean;
  /** 超 45KB 明文预算分片（同 replyTo 归组）：chunk 从 0 起，chunks 为总数 */
  chunk?: number;
  chunks?: number;
}

// ---------- 工作计划树同步信封 body 类型（v=1 加法扩展；语义与字段表见 PROTOCOL-FROZEN.md） ----------

/** workplan.sync（m→d）：拉某会话的工作计划树快照；rev=手机已知 revision（对账触发），空/缺省=全量 */
export interface WorkPlanSyncBody {
  sessionId: string;
  rev?: string | null;
}

/**
 * workplan.state 的树项传输形态（顶层项列表即树，children 嵌套）。
 * status 五态：pending/in_progress/completed/failed 与 core TaskStatus 对齐；'cancelled'=看板行已取消
 *（灰点；additive 增列，旧端按未知态安全降级——迭代 2 看板行并入引入）。看板行六态映射：
 * pending→pending、in_progress→in_progress、completed→completed、blocked/failed→failed（行级 needsYou 标记区分相位）、cancelled→cancelled。
 * result=完成/失败的结果摘要；
 * actor=执行者名（缺省=主 Agent；看板行=认领成员名，未认领='待认领'；徽章五色映射不上协议——沿用手机侧既有映射）；
 * needsYou=等你拍板（唯一中断信号；行级标记，树级语义由手机端递归扫）；
 * note=父项"自动结项"派生标注/看板行受阻原因等；
 * children=树嵌套（看板行 parentTaskId 命中清单项 → 嵌为该项子项；无链/断链 → 根层并列）。
 */
export interface WorkPlanItemWire {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  actor?: string;
  needsYou?: boolean;
  note?: string;
  children?: WorkPlanItemWire[];
}

/**
 * workplan.state（d→m）：投影随 state 下发（core 算好壳零判定）；rev=桌面当前树 revision
 *（字符串单调自增，core 重启归零——手机对账不上自动回全量，无脏态残留；手机单调收敛 latest-wins）。
 * full=true 全量（items 为完整树，手机整树替换）；full=false 纯对账确认（items 空）。
 * 超 45KB 明文预算分片（同 replyTo 归组）：chunk 从 0 起，chunks 为总数（分片骨架照 board.state，本期体量小）。
 */
export interface WorkPlanStateBody {
  sessionId: string;
  rev: string;
  full: boolean;
  items: WorkPlanItemWire[];
  /** 超 45KB 明文预算分片（同 replyTo 归组）：chunk 从 0 起，chunks 为总数 */
  chunk?: number;
  chunks?: number;
}

/**
 * feed.subagent（d→m）：Worker 工具调用事实（对齐 core eventBus SubagentToolCallPayload 线形）。
 * 按 toolCallId 归并的 status 流（running→success|failed），手机侧 latest-wins overlay 不落库。
 * argsSummary/resultSummary 为发射点已截断的 ≤4KB 摘要；at=事实时刻（epoch ms，归并比较键）。
 */
export interface FeedSubagentBody {
  /** 父任务 toolCall.id（= 看板行 claimedByTaskId，行↔feed 归属键） */
  taskId?: string;
  subagentType?: string;
  /** Worker 侧工具调用 id（归并主键） */
  toolCallId: string;
  toolName: string;
  /** 工具族（builtin/mcp…） */
  kind: string;
  /** 参数摘要（≤4KB，发射点截断） */
  argsSummary: string;
  status: 'running' | 'success' | 'failed';
  /** 结果摘要（≤4KB，发射点截断；running 无） */
  resultSummary?: string;
  durationMs?: number;
  at: number;
}

// ---------- M8 命令面信封 body 类型（v=1 加法扩展；语义与字段表见 PROTOCOL-FROZEN.md） ----------
// 注意：本文件经 sync-envelope.mjs 逐字拷贝进手机侧，必须保持自包含——
// 命令面线形（请求/应答/状态/目录）为协议唯一事实点，core CommandSurfaceService 经 import type 对齐本文件，不双源。

/** cmd.request（m→d）body：命令请求。channel 由桌面注册表决定（fast 就地 / serial 入串行链） */
export interface CmdRequestBody {
  /** 请求 id（cmd.result.replyTo 的锚） */
  id: string;
  /** 命令 id（注册表条目 id；未知命令 fail-closed 回 error） */
  cmd: string;
  /** 命令参数（结构化 JSON，经注册表 args 校验；永不插值进对话文本） */
  args?: Record<string, unknown>;
}

/** cmd.result（d→m）body：命令应答（成功 data 或诚实 error；手机按 replyTo 匹配幂等渲染） */
export interface CmdResultBody {
  replyTo: string;
  ok: boolean;
  data?: Record<string, unknown>;
  /** 机器可读错误码（unsupported|invalid_args|guard|internal；message 人类可读） */
  error?: { code: string; message: string };
}

/** cmd.state（d→m）body：命令面状态快照（latest-wins；手机落定唯一来源——不假落定）。
 *  catalog 仅在 cmd.sync 应答携带（连接/重连时）；日常推送只带 state。 */
export interface CmdStateBody {
  state: CommandStateSnapshot;
  /** 命令目录（低频；旧端对未知 presentation/section 折叠为 console-row 或跳过——数据前向兼容） */
  catalog?: CommandCatalogEntry[];
}

/**
 * 命令面状态快照：桌面活动会话的运行态标量集。
 * 多会话消歧：命令与状态一律作用于桌面活动会话（遥控语义，与 chat.user 的附着路由正交）；
 * sessionId 供手机诚实提示（附着≠活动时不本地遮蔽）。
 * 宿主级标量例外（v=1 加法扩展）：desktop/autoswitch 不随会话变（整台桌面一个值），
 * 缺省 = 桌面端未装配读口/未知，严格区别于已关 false（旧桌面端不下发、旧手机端忽略——前向兼容）。
 */
export interface CommandStateSnapshot {
  sessionId: string | null;
  running: boolean;
  plan: boolean;
  model: { name: string; effort?: string } | null;
  /** 前台 Agent 模板类型；null = 裸模型 */
  front: string | null;
  goal: { status: string; objective: string; round: number; maxRounds: number } | null;
  /** 上下文占用（口径 = engine getContextStatus：lastUsage 实测 → 压缩 checkpoint 估值回退；null = 无数据整体隐藏） */
  ctx: { used: number; max?: number; approx?: boolean } | null;
  /** 宿主级开关：桌面能力（截屏+键鼠注入放行；与 CLI /desktop 同键 desktop_control_enabled） */
  desktop?: boolean;
  /** 宿主级开关：自迭代后自动版本切换（与 CLI /auto-switch 同键 autoSwitchAfterIteration） */
  autoswitch?: boolean;
  /** 记忆库未巡检“新记忆”数（v=1 加法：memoryStore newCount 缓存现算；缺省=读口未装配/未知。打开记忆面板即归零） */
  memoryNewCount?: number;
}

/** 命令目录条目（core CommandSurfaceService 注册表的线形子集——壳渲染所需的纯数据） */
export interface CommandCatalogEntry {
  id: string;
  title: string;
  section: 'answer' | 'advance' | 'maintain';
  presentation: 'console-row' | 'picker' | 'input-morph' | 'strip' | 'badge';
  risk: 'instant' | 'confirm' | 'input';
  channel: 'fast' | 'serial';
  /** picker 型命令的惰性选项源命令 id（打开时 cmd.request 拉取） */
  options?: { lazy: string };
}

// ---------- 文件传输信封 body 类型（file.* 协议族；v=1 加法扩展，语义见 PROTOCOL-FROZEN.md） ----------
// 注意：本文件经 sync-envelope.mjs 逐字拷贝进手机侧，必须保持自包含——
// 以下线形为协议唯一事实点，core fileTransfer/RelayBridge 与手机 fileUploader/session 经 import type 对齐，不双源。

/** chat.user body 的附件条目（additive 可选字段 attachments?: ChatUserAttachment[]；≤5 个） */
export interface ChatUserAttachment {
  /** 手机生成的传输关联键（uuid v4；file.offer/file.chunk/file.receipt 与 attachments 同键闭环） */
  fileId: string;
  /** 原始文件名（仅元数据；桌面落盘用 uuid 命名，扩展名经白名单清洗） */
  name: string;
  mime: string;
}

/**
 * file.offer（发件方→收件方，方向无关）：传输发起与预检。
 * m→d = 手机附件上传（单文件帽/并发帽/扩展名白名单——拒绝即回 receipt{ok:false}）；
 * d→m = 桌面发文件到手机（一律 v2 分片语义：密文经中继静态通道，本信封只携指针+密钥——
 * 手机端用户点[接收]才开始拉字节，拉取即同意，无 accept/reject 协议消息）。
 */
export interface FileOfferBody {
  fileId: string;
  name: string;
  mime: string;
  /** 总字节数（v1 ≤ FILE_MAX_BYTES / v2 ≤ MEDIA_MAX_BYTES——fmt 判别） */
  size: number;
  /** 整文件 sha256 hex（重组/解密后整体校验） */
  sha256: string;
  /** 分块总数（seq 从 0 起；每块 ≤ FILE_CHUNK_BYTES 二进制）。static 路径无分块——恒 0 */
  chunks: number;
  /**
   * 要约过期时刻（epoch ms，additive 可选；d→m 必带 = PUT 完成时刻 + 48h，与中继成品 TTL 对齐）。
   * 过期判定收件端本地可判（诚实显示"已过期"），不靠网络探测。
   */
  expiresAt?: number;
  /**
   * 发出方当前会话 id（additive 可选；d→m 必带——文件卡片长在产生它的那轮对话里，
   * 收件端按会话归属渲染，不串场）。
   */
  sessionId?: string;
  /**
   * 媒体直传（可选；存在即 static 路径，无 chunk 跟随）：密文已在中继静态通道 media/<name>.bin，
   * 本指针只携每附件随机密钥。size/sha256 复用上方字段（明文口径）。
   */
  static?: {
    /** 密文名（MEDIA_NAME_RE；桌面用自身 relay 配置拼 /static/media/<name>——绝对 URL 不跨信任边界） */
    name: string;
    /** 每附件随机 32B 密钥（b64u；sealMediaBlob/sealMediaChunk 产出；本信封本身 E2E 加密护送） */
    key: string;
    /**
     * 格式版本（缺省 = v1 整块 secretbox；2 = 分片确定性 nonce——续传正确性原语）。
     * fmt:2 钉死 MEDIA_CHUNK_BYTES 512KB——改尺寸必升 fmt。
     */
    fmt?: number;
    /** 密文总字节数（fmt:2 必带——桌面分片拉取的 Content-Range 上界） */
    wireSize?: number;
    /** 分片随机前缀 16B（b64u；fmt:2 必带——确定性 nonce 派生的第二因子） */
    nonce?: string;
  };
}

/** file.chunk（m→d）：分块数据（base64url；按 (fileId,seq) 幂等，at-least-once 容忍重复/乱序到达） */
export interface FileChunkBody {
  fileId: string;
  seq: number;
  data: string;
}

/** file.abort（m→d）：用户取消/超时（桌面丢弃缓冲；fire-and-forget） */
export interface FileAbortBody {
  fileId: string;
  reason?: string;
}

/** file.receipt（收件方→发件方，方向无关）：传输终局的诚实回执——送达的唯一真相源。
 * m→d 原有语义：重组完成（sha256 校验通过、已落盘）或拒绝；d→m 新语义：手机拉取+解密+落盘完成。
 * error 枚举语义（d→m 方向）：expired=要约已过期 / corrupt=解密或 sha256 对账失败 /
 * io=落盘失败（含存储不足）/ aborted=用户取消拉取；m→d 方向维持自由文本（旧端兼容）。
 */
export interface FileReceiptBody {
  fileId: string;
  ok: boolean;
  /** 失败原因（d→m 用上注枚举；m→d 自由文本，人类可读） */
  error?: string;
}

// ---------- presence 能力协商（additive v=1 不变，旧端安全忽略——两端 handler 对未知字段零读取） ----------

/**
 * presence.ping（m→d）body：原为空对象；additive 可选 caps = 手机端能力清单。
 * 桌面据此做能力门（如 d→m 文件发送前置校验 file-recv），能力未知时诚实报错而非盲发。
 */
export interface PresencePingBody {
  caps?: string[];
}

/** 能力常量：手机端支持接收桌面发来的文件（file.offer d→m + 静态通道拉取） */
export const CAP_FILE_RECV = 'file-recv';

// ---------- ask.* 点选裁决卡（改进提案开庭；additive 可选字段 ×2，v=1 不变，旧端安全忽略） ----------
// 注意：本文件经 sync-envelope.mjs 逐字拷贝进手机侧，必须保持自包含——
// 以下线形为协议唯一事实点，core ImprovementProposalManager/askChannel 与手机侧经 import type 对齐，不双源。

/**
 * ask.response 的可选 decisions 数组元素（结构化决策回传，与 answer 文本双通道并行）：
 * 动作词表对齐账本/工具既有词汇（confirm/close/skip——y/s/del 只是 parseDecisionInput 的文本表层）。
 * 簇级=clusterId（整簇展开由桌面按开庭快照做，快照才是 title 的事实源，手机不背 title 清单）；
 * 单条=title（账本待确认区条目标题，匹配键）。两者至少其一，畸形整体丢弃→文本回退。
 */
export interface AskDecisionEntry {
  action: 'confirm' | 'close' | 'skip';
  /** 簇级裁决寻址键（= AskTriageCard.clusters[].id；'__ungrouped__' = 未分组簇哨兵） */
  clusterId?: string;
  /** 单条裁决寻址键（= 开庭快照 pending 条目标题，精确匹配；未命中幂等丢弃） */
  title?: string;
}

/**
 * ask.request / approval.request 的可选 sessionId 字段（来源会话归因，v=1 加法扩展）。
 * 数据源：AskChannel.askAttribution / ApprovalOrigin（“事件载荷归因数据源”）——发起会话 id。
 * 语义（手机端归因分流呈现）：有归因 → 卡片钉在来源会话时间线（精确匹配）；无归因（开庭、
 * 无归因熔断等全局请示）→ 只走全局浮层不进任何会话。旧手机端忽略新字段=现状行为，additive 安全。
 */

/**
 * ask.request 的可选 card 字段（改进提案点选裁决卡载荷；digest 自含，手机不解析 question 文本）。
 * 预算防护全在构造侧：card 序列化字节 + question 实际字节合计 ≤ PLAINTEXT_BUDGET_BYTES，
 * 超预算不带 card（整体降级为纯文本 ask）；手机侧缺字段/形状校验失败落回 QuestionCard。
 * entries/batch 为 additive 预留（迭代 1 不填、迭代 2 只填数据，协议形状不再变）。
 */
export interface AskTriageCard {
  /** 账本摘要一行（开庭时刻快照，手机直接渲染） */
  digest: string;
  clusters: Array<{
    /** 簇寻址键：C 编号或组名全称；未分组簇 = 固定哨兵 '__ungrouped__'（组名无编号可寻址） */
    id: string;
    /** 组名全称 */
    name: string;
    count: number;
    /** 近窗口新增条数 */
    recent: number;
    /** 主难度（占比最高者；无难度字段时缺省） */
    difficulty?: '低' | '中' | '高';
    /** 簇内最新条目日期（yyyy-MM-dd；无日期字段时空串） */
    latest: string;
    /** additive 预留（迭代 2 起填数据）：簇内逐条展开条目；n=开庭快照 pending 下标+1，title=决策匹配键；
     *  decided=本庭已落账标注（原地翻页回翻已决页只读渲染；命中开庭 session 的 decidedByTitle 即标注） */
    entries?: Array<{ n: number; title: string; reason?: string; difficulty?: string; benefit?: string; source?: string; decided?: 'confirm' | 'close' | 'skip' }>;
  }>;
  /** additive 预留（迭代 2 起填数据）：分页游标——offset/total 为簇下标口径（旧端只认这两个字段不受影响）；
   *  pageIndex/pageCount=布局前置后的页索引/总页数（"第 x/y 批"恒定分母，新增 additive 可选） */
  batch?: { offset: number; total: number; pageIndex?: number; pageCount?: number };
  /** 能力声明（additive）：本卡支持单卡原地翻页（improve.page cmd 通道）。旧手机不认识安全忽略，
   *  走既有"发送文本「下一批」"路径；新手机见 inplace+batch 渲染卡内翻页行 */
  inplace?: boolean;
}

/**
 * 文件名清洗（双端共享单源；additive export，零线格式影响）：
 * 剥离控制字符与路径分隔符（路径穿越防御——MediaStore DISPLAY_NAME / 落盘名均不携路径），
 * 扩展名白名单规则与 fileTransfer.sanitizeFileExtension 同值（^[A-Za-z0-9]{1,10}$，
 * 本文件须自包含——经 sync-envelope 逐字拷入手机侧，不可 import 同目录模块），空名兜底 'file'。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\x00-\x1f\x7f]/g, '').trim();
  const dot = cleaned.lastIndexOf('.');
  const rawExt = dot > 0 && dot < cleaned.length - 1 ? cleaned.slice(dot + 1).toLowerCase() : '';
  const ext = /^[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
  const stemRaw = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const stem = stemRaw.replace(/[\\/:*?"<>|]/g, '_').trim();
  const out = ext ? `${stem}.${ext}` : stem;
  return out.length > 0 ? out : 'file';
}

// ---------- 媒体直传（static 通道）：每附件随机密钥的载荷原语与名形 ----------
// 密文整块走中继静态通道（不可猜名即读取凭据），密钥随本 E2E 加密信封护送——relay 全程只见密文。
// 行业同构：WhatsApp/Signal/微信均为「客户端加密上传 blob + 消息传指针+密钥」。

/** 媒体密文名形（与 relay 侧 MEDIA 名形成对维护：<32hex>.bin，128-bit 熵） */
export const MEDIA_NAME_RE = /^[0-9a-f]{32}\.bin$/;

/** v2 策略帽（分片确定性 nonce 路径的单文件上限；通道物理帽在 relay——relay 只守通道） */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/**
 * v2 分片明文片大小（fmt:2 钉死——改尺寸必升 fmt）。
 * 512KB ≈ 200KB/s 管道 2.5s/片——续传粒度/往返开销/内存的平衡点。
 */
export const MEDIA_CHUNK_BYTES = 512 * 1024;

/** 加密媒体 blob（v1 整块）：随机 32B 密钥 secretbox；返回 { wire: nonce‖ct, keyB64u }（密钥随 offer 下发） */
export function sealMediaBlob(plain: Uint8Array): { wire: Uint8Array; keyB64u: string } {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(plain, nonce, key);
  const wire = new Uint8Array(nonce.length + ct.length);
  wire.set(nonce);
  wire.set(ct, nonce.length);
  return { wire, keyB64u: b64uEncode(key) };
}

/** 解密媒体 blob（v1 整块；配对 sealMediaBlob；任何失败返回 null——fail-closed） */
export function openMediaBlob(wire: Uint8Array, keyB64u: string): Uint8Array | null {
  try {
    const key = b64uDecode(keyB64u);
    if (key.length !== nacl.secretbox.keyLength) return null;
    const nLen = nacl.secretbox.nonceLength;
    if (wire.length <= nLen + nacl.secretbox.overheadLength) return null;
    const plain = nacl.secretbox.open(wire.subarray(nLen), wire.subarray(0, nLen), key);
    return plain ?? null;
  } catch {
    return null;
  }
}

// ---------- v2 分片确定性 nonce 原语（大文件续传正确性的基石） ----------
// nonce = fileNonce[16B 随机] ‖ uint64be(i)：同一 (file,key) 的第 i 片密文逐字节恒等——
// 中断重加密=原密文 → relay offset 追加模型成立；重放旧片=字节相同=等价于没动（同一性质两面）。
// 片位置纯算术：第 i 片密文起点 = i×(MEDIA_CHUNK_BYTES+40)；末片 = 余量+40。

/** 生成 v2 分片参数（fileNonce 16B 随机 + 密钥 32B）——一次生成全程复用 */
export function newMediaFileKeys(): { fileNonce: Uint8Array; keyB64u: string } {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const fileNonce = nacl.randomBytes(16);
  return { fileNonce, keyB64u: b64uEncode(key) };
}

/** v2 第 i 片 nonce：fileNonce(16B) ‖ uint64be(i)——共 24B（secretbox.nonceLength）。
 *  手写大端 8 字节（setUint64 为 ES2023 / Node 21+ API——core 必须 renderer 安全，不依赖） */
export function mediaChunkNonce(fileNonce: Uint8Array, i: number): Uint8Array {
  const nonce = new Uint8Array(24);
  nonce.set(fileNonce.subarray(0, 16));
  // uint64 big-endian：从最高位字节起逐位右移 56/48/…/0
  let v = BigInt(i);
  for (let b = 7; b >= 0; b--) {
    nonce[16 + b] = Number(v & 0xffn);
    v >>= 8n;
  }
  return nonce;
}

/** v2 加密第 i 片：secretbox(plainChunk, mediaChunkNonce(fileNonce,i), key)——确定性，续传安全 */
export function sealMediaChunk(
  plainChunk: Uint8Array,
  keyB64u: string,
  fileNonce: Uint8Array,
  i: number,
): Uint8Array {
  const key = b64uDecode(keyB64u);
  const ct = nacl.secretbox(plainChunk, mediaChunkNonce(fileNonce, i), key);
  const wire = new Uint8Array(24 + ct.length);
  wire.set(mediaChunkNonce(fileNonce, i));
  wire.set(ct, 24);
  return wire;
}

/** v2 解密第 i 片（配对 sealMediaChunk；双验——嵌入 nonce 必须与派生 nonce 一致 + MAC 验真；fail-closed 返 null） */
export function openMediaChunk(
  wireChunk: Uint8Array,
  keyB64u: string,
  fileNonce: Uint8Array,
  i: number,
): Uint8Array | null {
  try {
    const key = b64uDecode(keyB64u);
    if (key.length !== nacl.secretbox.keyLength) return null;
    if (wireChunk.length <= 24 + nacl.secretbox.overheadLength) return null;
    // 位置验真：嵌入 nonce 必须与 (fileNonce, i) 的确定性派生一致——错位/重排在此检出
    const expected = mediaChunkNonce(fileNonce, i);
    for (let b = 0; b < 24; b++) {
      if (wireChunk[b] !== expected[b]) return null;
    }
    const plain = nacl.secretbox.open(wireChunk.subarray(24), wireChunk.subarray(0, 24), key);
    return plain ?? null;
  } catch {
    return null;
  }
}

/** v2 密文总长（明文 totalPlain → 分片数 → 每片 nonce24+ct(plain+16MAC)） */
export function mediaWireSize(totalPlain: number): number {
  const chunks = Math.ceil(totalPlain / MEDIA_CHUNK_BYTES);
  const last = totalPlain - (chunks - 1) * MEDIA_CHUNK_BYTES;
  return (chunks - 1) * (24 + MEDIA_CHUNK_BYTES + 16) + (24 + last + 16);
}

/** v2 第 i 片在密文流中的字节区间 [start, end]（桌面 Range 拉取的算术基础） */
export function mediaChunkRange(totalPlain: number, i: number): { start: number; end: number } {
  const start = i * (24 + MEDIA_CHUNK_BYTES + 16);
  const plainLen = Math.min(MEDIA_CHUNK_BYTES, totalPlain - i * MEDIA_CHUNK_BYTES);
  const end = start + 24 + plainLen + 16 - 1;
  return { start, end };
}

export function makeEnvelope(
  type: string,
  from: string,
  to: string,
  body: Record<string, unknown>,
  replyTo?: string,
  now: () => number = Date.now,
): Envelope {
  const env: Envelope = { v: ENVELOPE_VERSION, type, id: randomUuid(), ts: now(), from, to, body };
  if (replyTo !== undefined) env.replyTo = replyTo;
  return env;
}

export function isEnvelopeShape(x: unknown): x is Envelope {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    e['v'] === ENVELOPE_VERSION &&
    typeof e['type'] === 'string' &&
    typeof e['id'] === 'string' &&
    typeof e['ts'] === 'number' &&
    typeof e['from'] === 'string' &&
    typeof e['to'] === 'string' &&
    typeof e['body'] === 'object' &&
    e['body'] !== null
  );
}

/**
 * ts 粗筛（v1.2 修正为单向）：只拒"来自未来"的时间戳（超过本地时钟 +5min，疑似伪造/时钟异常）。
 * 不拒过去时间戳——信箱离线留言本就"迟到"（桌面关机半天后开机拉取是正常路径），
 * 重放防护由持久化信封 id 去重承担，不靠 ts 下界。
 */
export function isTsFresh(ts: number, now: () => number = Date.now): boolean {
  return ts <= now() + TS_SKEW_MS;
}

/**
 * 明文预算截断 helper：保证 text 的 UTF-8 字节数 ≤ PLAINTEXT_BUDGET_BYTES。
 * 截断时调用方应置 body.truncated = true 并标注"请在桌面查看"。
 */
export function truncateToBudget(text: string): { text: string; truncated: boolean } {
  const bytes = utf8ToBytes(text);
  if (bytes.length <= PLAINTEXT_BUDGET_BYTES) return { text, truncated: false };
  // 按字节切，回退到合法 UTF-8 边界
  let end = PLAINTEXT_BUDGET_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytesToUtf8(bytes.slice(0, end)), truncated: true };
}

// ---------- 去重 LRU（留持久化注入点） ----------
/**
 * 已见信封 id 集合（有界 LRU，双端各一份）。
 * 持久化注入点：构造时传入 snapshot() 的历史值恢复；外部可随时调 snapshot() 落盘。
 */
export class DedupeSet {
  private order: string[] = [];
  private set = new Set<string>();
  private maxSize: number;

  constructor(maxSize: number = 4096, restored?: Iterable<string>) {
    this.maxSize = maxSize;
    if (restored) for (const id of restored) this.add(id);
  }

  /** @returns true = 新 id（未见过）；false = 重复 */
  mark(id: string): boolean {
    if (this.set.has(id)) return false;
    this.add(id);
    return true;
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  private add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.order.push(id);
    while (this.order.length > this.maxSize) {
      const evicted = this.order.shift()!;
      this.set.delete(evicted);
    }
  }

  /** 持久化快照（最旧在前） */
  snapshot(): string[] {
    return [...this.order];
  }

  /** 撤销标记（注入失败时让重投可重试；与 mark 的到达即标记配合） */
  delete(id: string): void {
    if (!this.set.delete(id)) return;
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
  }
}
