/**
 * syncReducer.ts — M6 同步落库逻辑（catalog/history/session.event → SyncDb）。
 *
 * 纯逻辑层：不碰网络/信封加解密（那是 session.ts），只把"已解密的协议载荷"应用到副本库。
 * 全部函数以 SyncDb 接口为边界（jest 用内存 fake 替换，不 mock op-sqlite 模块本体）。
 *
 * 收敛底座（与桌面 PROTOCOL-FROZEN 对齐）：幂等（INSERT OR REPLACE / UPSERT）+ 版本号
 * （updatedAt 后写胜出）+ 失效信号（history.invalidated → 清副本重拉）。
 */
import type {
  CatalogStateBody,
  CatalogSessionMeta,
  CatalogProjectMeta,
  HistoryPageBody,
  SessionEventBody,
  SyncMessage,
  BoardStateBody,
  BoardRowWire,
  FeedSubagentBody,
  WorkPlanStateBody,
  WorkPlanItemWire,
} from './envelope';
import type { BoardItemRow, MessageRow, SessionRow, SyncDb } from '../db/syncDb';

// ---------- catalog.state 分片归组 ----------

/** catalog.state 超 45KB 分片（chunk/chunks，同 replyTo 归组）的累积器 */
export class CatalogChunkCollector {
  private groups = new Map<string, { total: number; parts: Map<number, CatalogStateBody> }>();

  /** 喂入一片；集齐返回合并后的完整 body，否则 null。无分片（chunk 缺省）即完整，直接返回 */
  add(replyTo: string | undefined, body: CatalogStateBody): CatalogStateBody | null {
    if (body.chunk === undefined || body.chunks === undefined) return body;
    const key = replyTo ?? '';
    let g = this.groups.get(key);
    if (!g || g.total !== body.chunks) {
      g = { total: body.chunks, parts: new Map() };
      this.groups.set(key, g);
    }
    g.parts.set(body.chunk, body);
    if (g.parts.size < g.total) return null;
    // 集齐：chunk 0 为骨架（projects/deletes/activeSessionId/projectsRev/full），其余只并 sessions
    const base = g.parts.get(0)!;
    const sessions: CatalogSessionMeta[] = [];
    for (let i = 0; i < g.total; i++) sessions.push(...(g.parts.get(i)?.sessions ?? []));
    this.groups.delete(key);
    return { ...base, sessions };
  }

  /** 有界清理（防对端半截分片组永驻内存） */
  prune(maxGroups = 8): void {
    while (this.groups.size > maxGroups) {
      const oldest = this.groups.keys().next().value;
      if (oldest === undefined) break;
      this.groups.delete(oldest);
    }
  }
}

// ---------- catalog.state 应用 ----------

function sessionRowOf(agentId: string, s: CatalogSessionMeta): SessionRow {
  return {
    agentId,
    sessionId: s.id,
    projectId: s.projectId,
    title: s.title,
    titleSource: s.titleSource ?? null,
    workdir: s.workdir ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    preview: s.preview,
  };
}

/**
 * catalog.state 落库（集齐后的完整 body）：
 * - sessions 逐行 UPSERT（updatedAt 后写胜出在 DB 层）；deletes 删除本地行（连带消息副本）；
 * - projects 携带即整表替换（full=true 恒携带[可为空表=桌面无项目]；增量时仅 projectsRev 变化携带）；
 * - full=true：本地该 agent 不在全量清单中的会话行删除（异常残留收敛）；
 * - syncState.projectsRev/catalogSyncedAt 落定（下次 catalog.sync 上报数据源）。
 * 返回 true = 本次 deletes/full 清除命中 lastChatSessionId（入口记忆已清，session.ts 同步内存镜像）。
 */
export async function applyCatalogState(db: SyncDb, agentId: string, body: CatalogStateBody): Promise<boolean> {
  if (body.full || body.projects.length > 0) {
    const projects: CatalogProjectMeta[] = body.projects;
    await db.replaceProjects(
      agentId,
      projects.map((p) => ({ agentId, projectId: p.id, name: p.name, updatedAt: p.updatedAt })),
    );
  }
  for (const s of body.sessions) {
    await db.upsertSession(sessionRowOf(agentId, s));
  }
  // M6b lastChatSessionId 悬空处理（第一层）：先算"本次消失的 id 全集"再删行——
  // 顺序不可反（删完再读版本 map 就看不见消失行了）
  const removedIds = new Set(body.deletes ?? []);
  if (body.full) {
    const known = await db.getSessionsVersionMap(agentId);
    const incoming = new Set(body.sessions.map((s) => s.id));
    for (const id of Object.keys(known)) {
      if (!incoming.has(id)) removedIds.add(id);
    }
  }
  for (const id of body.deletes ?? []) {
    await db.deleteSession(agentId, id);
  }
  if (body.full) {
    // full 残留清除：removedIds 中 deletes 之外的部分（removedIds ⊇ deletes）
    for (const id of removedIds) {
      if (!body.deletes?.includes(id)) await db.deleteSession(agentId, id);
    }
  }
  const prev = await db.getSyncState(agentId);
  const lastChat = prev?.lastChatSessionId ?? null;
  const clearLastChat = lastChat !== null && removedIds.has(lastChat);
  // 悬空附着清理：附着会话被删 → 置空（与 lastChatSessionId 同款处理，防 attach 幽灵会话的无效流量）
  const attached = prev?.attachedSessionId ?? null;
  const clearAttached = attached !== null && removedIds.has(attached);
  await db.putSyncState({
    agentId,
    attachedSessionId: clearAttached ? null : attached,
    projectsRev: body.projectsRev,
    catalogSyncedAt: new Date().toISOString(),
    expandedProjectsJson: prev?.expandedProjectsJson ?? null,
    lastChatSessionId: clearLastChat ? null : lastChat,
  });
  return clearLastChat;
}

// ---------- history.page 应用 ----------

function messageRowOf(agentId: string, sessionId: string, m: SyncMessage): MessageRow {
  const payload: Record<string, unknown> = {};
  if (m.reasoningContent !== undefined) payload['reasoningContent'] = m.reasoningContent;
  if (m.thinkingDurationMs !== undefined) payload['thinkingDurationMs'] = m.thinkingDurationMs;
  if (m.toolName !== undefined) payload['toolName'] = m.toolName;
  if (m.toolStatus !== undefined) payload['toolStatus'] = m.toolStatus;
  if (m.truncated === true) payload['truncated'] = true;
  return {
    agentId,
    sessionId,
    msgKey: m.msgKey,
    role: m.role,
    ts: m.ts,
    kind: m.kind,
    text: m.text,
    payloadJson: Object.keys(payload).length > 0 ? JSON.stringify(payload) : null,
    // file.* 协议族：refs 落库（重启后历史渲染仍可联查本地登记表——缺此列则误降级占位）
    refsJson: m.refs && m.refs.length > 0 ? JSON.stringify(m.refs) : null,
    // 客户端消息身份（relay 来源用户消息=其 chat.user 信封 id）：overlay 气泡回声确认的匹配键（身份当列，不塞 payloadJson）
    clientId: m.clientId ?? null,
  };
}

/**
 * history.page 落库：消息按 (agentId, sessionId, msgKey) INSERT OR REPLACE 幂等归并
 * （重投/乱序/尾部拉齐重叠页零重复）。notFound = 会话已被桌面删除 → 清本地行与消息副本。
 * 返回落库条数（UI 通知用）。
 */
export async function applyHistoryPage(db: SyncDb, agentId: string, body: HistoryPageBody): Promise<number> {
  if (body.notFound === true) {
    await db.deleteSession(agentId, body.sessionId);
    return 0;
  }
  const rows = body.messages.map((m) => messageRowOf(agentId, body.sessionId, m));
  await db.insertMessages(rows); // 单事务（每页一个事务，背压策略第 7 条）
  return rows.length;
}

// ---------- session.event 应用 ----------

/** applySessionEvent 的副作用描述（网络动作/界面通知归 session.ts 执行，本层只判定） */
export interface SessionEventEffect {
  /** 附着会话被删：session.ts 应脱离附着（syncState 置 null + 回发 attach{null}）并通知 UI 返回列表 */
  detachBecauseDeleted?: string;
  /** 历史失效：副本已清，UI 应重拉该会话 */
  invalidatedSessionId?: string;
  /** attached.changed 对账：桌面通告值（session.ts 与 syncState 意图比对，不符则重 announce） */
  attachedChanged?: string | null;
  /** active.changed：桌面当前会话移动（UI "●当前"徽标） */
  activeChanged?: string | null;
  /** 目录行有变化（UI 刷新会话列表） */
  catalogTouched?: boolean;
}

export async function applySessionEvent(
  db: SyncDb,
  agentId: string,
  body: SessionEventBody,
  currentAttached: string | null,
): Promise<SessionEventEffect> {
  switch (body.kind) {
    case 'metadata.upsert':
    case 'session.created': {
      if (body.session) {
        await db.upsertSession(sessionRowOf(agentId, body.session));
        return { catalogTouched: true };
      }
      return {};
    }
    case 'title.changed': {
      // 改名不动 updatedAt（桌面 patchTitle 语义），单列更新
      if (typeof body.sessionId === 'string' && typeof body.title === 'string') {
        await db.updateSessionTitle(agentId, body.sessionId, body.title, body.titleSource ?? null);
        return { catalogTouched: true };
      }
      return {};
    }
    case 'session.deleted': {
      if (typeof body.sessionId !== 'string') return {};
      await db.deleteSession(agentId, body.sessionId);
      return {
        catalogTouched: true,
        ...(currentAttached === body.sessionId ? { detachBecauseDeleted: body.sessionId } : {}),
      };
    }
    case 'active.changed':
      return { activeChanged: typeof body.sessionId === 'string' ? body.sessionId : null };
    case 'attached.changed':
      return { attachedChanged: typeof body.sessionId === 'string' ? body.sessionId : null };
    case 'round.settled':
      return {}; // M6c：无 DB 副作用（拉齐触发与 overlay 锚点闭合在 session.ts / ChatScreen 层）
    case 'history.invalidated': {
      if (typeof body.sessionId !== 'string') return {};
      await db.clearMessages(agentId, body.sessionId);
      return { invalidatedSessionId: body.sessionId };
    }
    default:
      return {};
  }
}

// ---------- catalog.sync 组包 ----------

/**
 * catalog.sync 组包：sessions 版本 map 超 45KB 明文预算时按规划退路**退化为空 body 请求全量**
 * （协议登记的双选项之一；m→d 不引第二套分片格式）。返回应上报的 body。
 */
export function packCatalogSyncBody(
  known: { projectsRev: string | null; sessions: Record<string, string> },
  budgetBytes: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sessions: known.sessions,
    ...(known.projectsRev !== null ? { projectsRev: known.projectsRev } : {}),
  };
  if (utf8ByteLen(JSON.stringify(body)) > budgetBytes) {
    return {}; // 退化为全量同步（桌面 diffCatalog 对空 known 回 full=true）
  }
  return body;
}

// ---------- M7 board.state 分片归组 + 应用 ----------

/** board.state 超 45KB 分片（chunk/chunks，同 replyTo 归组）的累积器（仿 CatalogChunkCollector） */
export class BoardChunkCollector {
  private groups = new Map<string, { total: number; parts: Map<number, BoardStateBody> }>();

  /** 喂入一片；集齐返回合并后的完整 body，否则 null。无分片（chunk 缺省）即完整，直接返回 */
  add(replyTo: string | undefined, body: BoardStateBody): BoardStateBody | null {
    if (body.chunk === undefined || body.chunks === undefined) return body;
    const key = replyTo ?? '';
    let g = this.groups.get(key);
    if (!g || g.total !== body.chunks) {
      g = { total: body.chunks, parts: new Map() };
      this.groups.set(key, g);
    }
    g.parts.set(body.chunk, body);
    if (g.parts.size < g.total) return null;
    // 集齐：chunk 0 为骨架（strip/needsYou/windowed/full/rev/sessionId），其余只并 rows
    const base = g.parts.get(0)!;
    const rows: BoardRowWire[] = [];
    for (let i = 0; i < g.total; i++) rows.push(...(g.parts.get(i)?.rows ?? []));
    this.groups.delete(key);
    return { ...base, rows };
  }

  /** 有界清理（防对端半截分片组永驻内存） */
  prune(maxGroups = 8): void {
    while (this.groups.size > maxGroups) {
      const oldest = this.groups.keys().next().value;
      if (oldest === undefined) break;
      this.groups.delete(oldest);
    }
  }
}

function boardItemRowOf(agentId: string, sessionId: string, row: BoardRowWire, sortOrder: number): BoardItemRow {
  const d = row.detail ?? {};
  const detail: Record<string, unknown> = {};
  if (d.blockedReason !== undefined) detail['blockedReason'] = d.blockedReason;
  if (d.result !== undefined) detail['result'] = d.result;
  if (d.resultTruncated !== undefined) detail['resultTruncated'] = d.resultTruncated;
  if (d.releaseHistory !== undefined) detail['releaseHistory'] = d.releaseHistory;
  if (d.failCount !== undefined) detail['failCount'] = d.failCount;
  if (d.claimedByTaskId !== undefined) detail['claimedByTaskId'] = d.claimedByTaskId;
  return {
    agentId,
    sessionId,
    itemId: row.itemId,
    title: row.title,
    assignee: row.assignee ?? null,
    status: row.status,
    label: row.label,
    progressText: row.progressText ?? null,
    claimedAt: row.claimedAt ?? null,
    clipped: row.clipped === true ? 1 : 0,
    detailJson: Object.keys(detail).length > 0 ? JSON.stringify(detail) : null,
    sortOrder,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * board.state 落库（集齐后的完整 body）：
 * - rev LWW：旧 rev 丢弃（Number 比较防字符串序陷阱；等 rev 幂等重放=无损接受）；
 * - full=true 整表替换 + 残留清除（仿 applyCatalogState）；full=false 仅 upsert 行；
 * - 标量（strip/needsYou/windowed）落 boardMeta——进度长条/要你信号的显示源。
 * 返回 true=本次已应用；false=旧 rev 被丢弃。
 */
export async function applyBoardState(db: SyncDb, agentId: string, body: BoardStateBody): Promise<boolean> {
  const incoming = Number(body.rev);
  const prev = await db.getBoardMeta(agentId, body.sessionId);
  if (prev !== null && Number.isFinite(incoming)) {
    const known = Number(prev.rev);
    if (Number.isFinite(known) && incoming < known) return false; // 旧 rev 丢弃（LWW）
  }
  const rows = body.rows.map((r, i) => boardItemRowOf(agentId, body.sessionId, r, i));
  if (body.full) await db.replaceBoardItems(agentId, body.sessionId, rows);
  else await db.upsertBoardItems(rows);
  await db.putBoardMeta({
    agentId,
    sessionId: body.sessionId,
    rev: body.rev,
    stripJson: JSON.stringify(body.strip),
    needsYouJson: JSON.stringify(body.needsYou),
    windowed: body.windowed === true ? 1 : 0,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

/**
 * board.sync 组包：带已知 rev 触发对账（照 catalog.sync 先例）；无已知 rev=请求全量。
 */
export function packBoardSyncBody(sessionId: string, knownRev: string | null): Record<string, unknown> {
  return {
    sessionId,
    ...(knownRev !== null ? { rev: knownRev } : {}),
  };
}

// ---------- workplan.state 分片归组 + 应用（照 board.state 先例逐行平移） ----------

/** workplan.state 超 45KB 分片（chunk/chunks，同 replyTo 归组）的累积器（仿 BoardChunkCollector） */
export class WorkPlanChunkCollector {
  private groups = new Map<string, { total: number; parts: Map<number, WorkPlanStateBody> }>();

  /** 喂入一片；集齐返回合并后的完整 body，否则 null。无分片（chunk 缺省）即完整，直接返回 */
  add(replyTo: string | undefined, body: WorkPlanStateBody): WorkPlanStateBody | null {
    if (body.chunk === undefined || body.chunks === undefined) return body;
    const key = replyTo ?? '';
    let g = this.groups.get(key);
    if (!g || g.total !== body.chunks) {
      g = { total: body.chunks, parts: new Map() };
      this.groups.set(key, g);
    }
    g.parts.set(body.chunk, body);
    if (g.parts.size < g.total) return null;
    // 集齐：chunk 0 为骨架（sessionId/rev/full），其余只并 items
    const base = g.parts.get(0)!;
    const items: WorkPlanItemWire[] = [];
    for (let i = 0; i < g.total; i++) items.push(...(g.parts.get(i)?.items ?? []));
    this.groups.delete(key);
    return { ...base, items };
  }

  /** 有界清理（防对端半截分片组永驻内存） */
  prune(maxGroups = 8): void {
    while (this.groups.size > maxGroups) {
      const oldest = this.groups.keys().next().value;
      if (oldest === undefined) break;
      this.groups.delete(oldest);
    }
  }
}

/**
 * workplan.state 落库（集齐后的完整 body）：
 * - rev LWW：旧 rev 丢弃（Number 比较防字符串序陷阱；等 rev 幂等重放=无损接受）——照 applyBoardState 先例；
 * - full=true：整树 JSON 替换（items 为完整树，children 嵌套随行——零判定渲染的数据源）；
 * - full=false：纯对账确认（items 空），树不动、仅 rev 前进（读旧 treeJson 保留）。
 * 返回 true=本次已应用；false=旧 rev 被丢弃。
 */
export async function applyWorkPlanState(db: SyncDb, agentId: string, body: WorkPlanStateBody): Promise<boolean> {
  const incoming = Number(body.rev);
  const prev = await db.getWorkPlanMeta(agentId, body.sessionId);
  if (prev !== null && Number.isFinite(incoming)) {
    const known = Number(prev.rev);
    if (Number.isFinite(known) && incoming < known) return false; // 旧 rev 丢弃（LWW）
  }
  await db.setWorkPlanMeta({
    agentId,
    sessionId: body.sessionId,
    rev: body.rev,
    treeJson: body.full ? JSON.stringify(body.items ?? []) : (prev?.treeJson ?? '[]'),
    updatedAt: new Date().toISOString(),
  });
  return true;
}

/**
 * workplan.sync 组包：带已知 rev 触发对账（照 board.sync 先例）；无已知 rev=请求全量。
 */
export function packWorkPlanSyncBody(sessionId: string, knownRev: string | null): Record<string, unknown> {
  return {
    sessionId,
    ...(knownRev !== null ? { rev: knownRev } : {}),
  };
}

/** UTF-8 字节数（tsconfig 无 DOM lib，不用 TextEncoder 类型；Hermes 运行时有但该类型声明缺失） */
function utf8ByteLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // 代理对
      i++;
    } else n += 3;
  }
  return n;
}

// ---------- V2 feed.subagent overlay（latest-wins 归并,不落库） ----------

/**
 * Worker 事实流 overlay（照 DB 基底+overlay 双源范式的 overlay 半边）：
 * 按 toolCallId 归并的 status 流 running→success|failed，latest-wins（at 比较，乱序旧帧丢弃、
 * 同 at 后写胜出）。不落库——事实是过程态（会话切换/超时可清），真相在 board.state 行与 history.page。
 */
export class FeedOverlay {
  private byCall = new Map<string, FeedSubagentBody>();

  /** 喂入一条事实；返回是否落位（旧帧丢弃=false） */
  apply(body: FeedSubagentBody): boolean {
    if (!body || typeof body.toolCallId !== 'string' || body.toolCallId.length === 0) return false;
    const prev = this.byCall.get(body.toolCallId);
    if (prev && prev.at > body.at) return false; // 乱序旧帧丢弃
    this.byCall.set(body.toolCallId, body);
    return true;
  }

  /** 某任务（=看板行 claimedByTaskId）的事实，最新在前 */
  listByTask(taskId: string, limit = 10): FeedSubagentBody[] {
    return [...this.byCall.values()]
      .filter((b) => b.taskId === taskId)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  /** 有界清理（防长会话洪峰撑爆内存;按 at 保新弃旧） */
  prune(maxEntries = 60): void {
    if (this.byCall.size <= maxEntries) return;
    const sorted = [...this.byCall.entries()].sort((a, b) => b[1].at - a[1].at);
    this.byCall = new Map(sorted.slice(0, maxEntries));
  }

  clear(): void {
    this.byCall.clear();
  }

  size(): number {
    return this.byCall.size;
  }
}

// ---------- 运行态标志（volatile 集合纯判定；session.ts 只做编排与 emit） ----------

/**
 * 运行中会话集合的下一步（running.changed / catalog.state.runningSessionIds / 断连清空共用）：
 * - runningAll 在场 → 整替（纯快照形态 sessionId 省略也走此路；快照优先于增量）；
 * - 否则 sessionId+running 成对 → 单会话增删；
 * - 集合无实际变化 / 输入不完整 → 返回 null（调用方不 emit——桌面 5min 周期重申不得引发无谓重渲）。
 */
export function nextRunningSet(
  prev: ReadonlySet<string>,
  input: { sessionId?: string | null; running?: boolean; runningAll?: string[] },
): ReadonlySet<string> | null {
  if (Array.isArray(input.runningAll)) {
    if (input.runningAll.length === prev.size && input.runningAll.every((id) => prev.has(id))) return null;
    return new Set(input.runningAll);
  }
  if (typeof input.sessionId === 'string' && input.sessionId.length > 0 && typeof input.running === 'boolean') {
    if (prev.has(input.sessionId) === input.running) return null;
    const next = new Set(prev);
    if (input.running) next.add(input.sessionId);
    else next.delete(input.sessionId);
    return next;
  }
  return null;
}

/**
 * 串台过滤（2026-10-05 多会话并行根治）：chat.event 归属戳 ≠ 附着意图 → 丢弃。
 * 只在两者都非空时判异（旧桌面无戳=null 放行；未附着=null 放行——无渲染面）。
 * 到达窗口=attach 切换冲刷/FIFO 在途/429 积压迟达（桥镜像门控的合法洞）——这些帧照渲染=串台。
 * 丢弃不丢内容：该会话落定尾拉/重进 entry pull 经 DB 收敛。
 */
export function shouldDropForeignChatEvent(chunkSessionId: string | null, attachedIntent: string | null): boolean {
  return chunkSessionId !== null && attachedIntent !== null && chunkSessionId !== attachedIntent;
}
