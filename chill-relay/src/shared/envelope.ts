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
  /** kind=tool：工具名 + 状态（text 为 ≤1000 字符结果预览） */
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
  | 'round.settled';

/**
 * session.event（d→m）：目录/元数据增量 + 附着确认 + 历史失效信号。
 * 一律不携带正文——正文只有两个通道：history.page（按需拉）与 chat.event（附着会话实时流）。
 */
export interface SessionEventBody {
  kind: SessionEventKind;
  /** session.deleted / active.changed / attached.changed / history.invalidated / title.changed 的目标会话 */
  sessionId?: string | null;
  /** metadata.upsert / session.created 的元数据行 */
  session?: CatalogSessionMeta;
  /** title.changed 的新标题 */
  title?: string;
  titleSource?: 'default' | 'auto' | 'manual';
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

/** file.offer（m→d）：传输发起与预检（单文件帽/并发帽/扩展名白名单——拒绝即回 receipt{ok:false}） */
export interface FileOfferBody {
  fileId: string;
  name: string;
  mime: string;
  /** 总字节数（≤ FILE_MAX_BYTES） */
  size: number;
  /** 整文件 sha256 hex（重组完成后整体校验） */
  sha256: string;
  /** 分块总数（seq 从 0 起；每块 ≤ FILE_CHUNK_BYTES 二进制） */
  chunks: number;
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

/** file.receipt（d→m）：重组完成（sha256 校验通过、已落盘）或拒绝的诚实回执 */
export interface FileReceiptBody {
  fileId: string;
  ok: boolean;
  /** 拒绝原因（超限/校验失败/未装配等，人类可读） */
  error?: string;
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
