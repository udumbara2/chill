/**
 * syncUiLogic.ts — M6 类五 UI 纯逻辑（无 React/无 DB 依赖，jest 可单测）：
 * - groupSessionsIntoSections：会话列表按项目分区（分区排序/未分组伪分区最后/默认展开规则）
 * - rowsToChatMessages：DB 消息行 → ChatMessage 渲染序列（类型映射的手机侧呈现点，
 *   线形 kind 语义唯一事实点在 core SessionSyncService.toSyncMessage / PROTOCOL-FROZEN）
 * - 会话行手势判定（会话管理：滑动删除/长按改标题）：shouldClaimHorizontal 水平接管、
 *   resolveSwipeRelease release 分派、nextManageState 删除两步状态机、resolveRenameSubmit 提交门
 */
import type { MessageRow, ProjectRow, ReceivedFileRow, SessionRow } from '../db/syncDb';
import type { ChatMessage, FileCardInfo, MediaItem, ToolDetail } from '../relay/session';
import { receivedFileRowToCard } from '../relay/session';
import type { AskDecisionEntry, BoardRowWire, BoardStripWire, BoardNeedsYouWire, FeedSubagentBody, WorkPlanItemWire } from '../relay/envelope';

// ---------- 会话列表分区 ----------

export const UNGROUPED_KEY = '__ungrouped__';

export interface SessionSection {
  /** projectId 或 UNGROUPED_KEY */
  key: string;
  title: string;
  rows: SessionRow[];
  /** 分区内最新会话 updatedAt（分区排序依据：最近活跃的项目浮上来） */
  latestUpdatedAt: string;
}

/**
 * 分区：分区内保持输入序（调用方已按 updatedAt 降序）；分区按 latestUpdatedAt 降序，
 * "未分组"伪分区固定最后。projects 的顺序不影响分区排序（排序只看会话活跃度）。
 */
export function groupSessionsIntoSections(sessions: SessionRow[], projects: ProjectRow[]): SessionSection[] {
  const nameOf = new Map(projects.map((p) => [p.projectId, p.name]));
  const byProject = new Map<string, SessionRow[]>();
  const ungrouped: SessionRow[] = [];
  for (const s of sessions) {
    if (s.projectId === null) {
      ungrouped.push(s);
      continue;
    }
    const list = byProject.get(s.projectId) ?? [];
    list.push(s);
    byProject.set(s.projectId, list);
  }
  const sections: SessionSection[] = [...byProject.entries()].map(([key, rows]) => ({
    key,
    title: nameOf.get(key) ?? key,
    rows,
    latestUpdatedAt: rows[0]?.updatedAt ?? '',
  }));
  sections.sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
  if (ungrouped.length > 0) {
    sections.push({
      key: UNGROUPED_KEY,
      title: '未分组',
      rows: ungrouped,
      latestUpdatedAt: ungrouped[0]?.updatedAt ?? '',
    });
  }
  return sections;
}

/** 默认展开集：当前会话所在分区（其余折叠；用户展开状态经 syncState.expandedProjectsJson 覆盖） */
export function defaultExpandedKeys(sections: SessionSection[], activeSessionId: string | null): Set<string> {
  if (activeSessionId === null) return new Set();
  const hit = sections.find((sec) => sec.rows.some((r) => r.sessionId === activeSessionId));
  return hit ? new Set([hit.key]) : new Set();
}

/** expandedProjectsJson 读写（syncState 列；JSON map: sectionKey → true=展开） */
export function parseExpanded(json: string | null): Record<string, boolean> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

// ---------- 消息行 → 渲染序列 ----------

const STATUS_TEXT: Record<string, string> = {
  running: '执行中',
  pending: '等待审批',
  success: '完成',
  failed: '失败',
  rejected: '被拒绝',
};

const TOOL_STATUSES = new Set(['running', 'pending', 'success', 'failed', 'rejected']);

/**
 * DB 行 → ChatMessage 序列（自然时间序）。
 * 类型映射：text=正文（user 蓝气泡 / assistant markdown；reasoningContent 拆出独立思考行前置）；
 * tool=工具行（工具名+状态+结果预览，点开看）；notice=提示行；
 * media=附件行——refs 命中本地登记表 → 缩略图/芯片条目（sentByRef 联查映射，调用方先批量取表）；
 * 无 refs（桌面侧产生的媒体）或图片无本地副本 → 诚实降级占位"请在桌面查看"；文件芯片永不降级。
 * truncated 追加截断标注（与 chat.event final 的现有标注文案一致）。
 */
export function rowsToChatMessages(
  rows: MessageRow[],
  sentByRef?: ReadonlyMap<string, { kind: string; localUri: string }>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    if (row.payloadJson) {
      try {
        const p = JSON.parse(row.payloadJson) as unknown;
        if (p !== null && typeof p === 'object') payload = p as Record<string, unknown>;
      } catch {
        /* 载荷损坏按无载荷渲染 */
      }
    }
    let refs: Array<{ ref: string; name: string; mime: string }> | null = null;
    if (row.refsJson) {
      try {
        const r = JSON.parse(row.refsJson) as unknown;
        if (Array.isArray(r) && r.length > 0) refs = r as Array<{ ref: string; name: string; mime: string }>;
      } catch {
        /* refs 损坏按无 refs 降级 */
      }
    }
    const ts = Date.parse(row.ts) || 0;
    const truncatedNote = payload['truncated'] === true ? '\n（已截断，完整内容请在桌面查看）' : '';

    if (row.kind === 'notice') {
      out.push({ id: row.msgKey, dir: 'in', text: row.text, kind: 'notice', ts });
      continue;
    }
    if (row.kind === 'media') {
      // 两条渲染规则（第一性定案：协议忠实携带语义，渲染器如实显示——零过滤/零字符串匹配）：
      // role=user → 蓝色右气泡（text + 缩略图/芯片）；非 user → 灰色左提示行
      // 旧行（修复前发的）text 可能是占位文案 → 蓝色气泡里如实显示，自然沉底
      if (refs && refs.length > 0) {
        const dir = row.role === 'user' ? ('out' as const) : ('in' as const)
        const items: MediaItem[] = refs.map((r) => {
          const sent = sentByRef?.get(r.ref) ?? null
          return {
            ref: r.ref,
            name: r.name,
            mime: r.mime,
            kind: sent?.kind === 'image' ? ('image' as const) : ('file' as const),
            localUri: sent?.localUri ?? null,
          }
        })
        out.push({ id: row.clientId ?? row.msgKey, dir, text: row.text, kind: 'media', ts, media: { items } })
      } else {
        out.push({ id: row.msgKey, dir: 'in', text: `🖼 ${row.text}`, kind: 'media', ts })
      }
      continue
    }
    if (row.kind === 'tool') {
      const toolName = typeof payload['toolName'] === 'string' ? payload['toolName'] : '';
      const rawStatus = typeof payload['toolStatus'] === 'string' ? payload['toolStatus'] : '';
      const status = (TOOL_STATUSES.has(rawStatus) ? rawStatus : 'failed') as ToolDetail['status'];
      const line = toolName ? `${toolName} ${STATUS_TEXT[status] ?? ''}`.trim() : row.text;
      out.push({
        id: row.msgKey,
        dir: 'in',
        text: line,
        kind: 'status',
        ts,
        toolDetail: {
          name: toolName || '工具',
          status,
          ...(row.text && row.text !== line ? { resultPreview: row.text + truncatedNote } : {}),
        },
      });
      continue;
    }
    // kind === 'text'
    if (typeof payload['reasoningContent'] === 'string' && payload['reasoningContent'].length > 0) {
      out.push({
        id: `${row.msgKey}#think`,
        dir: 'in',
        text: payload['reasoningContent'],
        kind: 'reasoning',
        ts,
        streaming: false,
      });
    }
    if (row.role === 'user') {
      out.push({ id: row.clientId ?? row.msgKey, dir: 'out', text: row.text, kind: 'chat.user', ts });
    } else {
      // 零载荷 assistant 行（空正文/无思考——纯工具调用轮占位）不产出渲染项：
      // 源头（core pageHistory）已过滤，此为双保险（覆盖旧库残留空行——空 MarkdownText 只剩 margin 空壳，制造幻影间距）
      const text = row.text + truncatedNote;
      const hasReasoning = typeof payload['reasoningContent'] === 'string' && (payload['reasoningContent'] as string).length > 0;
      if (text.trim().length === 0 && !hasReasoning) continue;
      out.push({ id: row.msgKey, dir: 'in', text, kind: 'final', ts });
    }
  }
  return out;
}


// ---------- d→m 收件卡：receivedFiles 行 → 文件卡片消息 ----------

/** d→m 收件行 → ChatMessage（kind='fileOffer'；id 钉死 file-<fileId>——overlay 同 id 原位替换收敛，
 *  DB 基底重载时由本映射无缝接管；与审批卡同族范式）。ts 取 anchorTs ?? createdAt
 *  （②B 迟到锚定：未锚定期=要约到达时刻（现状位）；锚定后=归属轮末条+n（桌面钟，统一坐标系治双时钟混排）） */
export function receivedFileToMessage(row: ReceivedFileRow): ChatMessage {
  return {
    id: `file-${row.fileId}`,
    dir: 'in',
    text: '',
    kind: 'fileOffer',
    ts: row.anchorTs ?? (Date.parse(row.createdAt) || 0),
    fileCard: receivedFileRowToCard(row),
  };
}

/**
 * ②B 迟到锚定计算（纯函数；锚定编排=RelaySession.anchorPendingReceivedFiles，双条件门 a 在 UI 钩子侧）。
 * 门 b（有效性，同钟系）：floor 非空且 lastMessageTs > floor 才锚（两操作数均桌面钟；floor=null 的卡
 * ——空会话首卡/存量回填前——不锚，保持现状位）；同毫秒理论边（last==floor）接受不锚。
 * 多卡按 createdAt 递增 +1/+2… 保序。返回本轮可锚定集合（空=本轮无锚定动作）。
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

// ---------- d→m 收件卡：相位推导（过程显示的唯一事实点——推导，不发信号） ----------

/**
 * 文件卡相位：全部从既有状态推导，零新增事件通道。
 * 依据：最后一片落定后 fileProgress 必发 received==total，而 state 要到 done 才离开
 * pulling——「100% 后的校验+定稿+交付窗口」即可推导（pulling ∧ received==total）。
 * 过期本地判并入本函数且优先级最高（offered+lastProgress+已过期 → 灰显过期，非暂停条）。
 */
export type FileCardPhase =
  | { kind: 'offered' }
  | { kind: 'paused'; received: number; total: number; pct: number } // 取消/清扫复位：断点可见
  | { kind: 'preparing' } // pulling 无 progress：断点定位+首片网络
  | { kind: 'downloading'; received: number; total: number; pct: number }
  | { kind: 'verifying' } // received==total：sha256 对账+定稿+MediaStore 交付窗口
  | { kind: 'done' }
  | { kind: 'failed'; error?: string }
  | { kind: 'expired' };

export function fileCardPhase(card: FileCardInfo, now: number): FileCardPhase {
  if (card.state === 'expired' || (card.state === 'offered' && card.expiresAt !== null && now > card.expiresAt)) {
    return { kind: 'expired' };
  }
  switch (card.state) {
    case 'offered': {
      const lp = card.lastProgress;
      if (lp && lp.total > 0 && lp.received > 0) {
        return { kind: 'paused', received: lp.received, total: lp.total, pct: Math.min(100, Math.round((lp.received / lp.total) * 100)) };
      }
      return { kind: 'offered' };
    }
    case 'pulling': {
      const p = card.progress;
      if (!p || p.total <= 0) return { kind: 'preparing' };
      if (p.received >= p.total) return { kind: 'verifying' };
      return { kind: 'downloading', received: p.received, total: p.total, pct: Math.min(100, Math.round((p.received / p.total) * 100)) };
    }
    case 'done':
      return { kind: 'done' };
    case 'failed':
      return card.error !== undefined ? { kind: 'failed', error: card.error } : { kind: 'failed' };
  }
}


// ---------- M6b：默认聊天屏路由决策 ----------

/**
 * 点"我的桌面"直达聊天屏的目标决策：
 * 入口记忆（lastChatSessionId）存在且仍在目录中 → 该会话；否则 → 'new'（新会话界面，发言即建）。
 * 悬空校验是 lastChat 双层防护的第二层（第一层=catalog deletes 命中即清，syncReducer）。
 */
export function resolveDefaultChatTarget(
  lastChatSessionId: string | null,
  knownSessionIds: ReadonlySet<string>,
): string {
  return lastChatSessionId !== null && knownSessionIds.has(lastChatSessionId) ? lastChatSessionId : 'new';
}


// ---------- M6b 修复：DB 基底 + 实时 overlay 按时间序归并 ----------

/**
 * 双源归并（修复"审批/提问卡永远沉底"）：块追加 `[...db, ...overlay]` 会让 overlay 里的卡片
 * 永远排在 DB 基底之后——卡片到达后新落库的消息反而出现在它上方，卡片位置被推到视觉最底。
 * 归并按 ts 升序（稳定排序：同 ts 保持 DB 行在前——DB 行本身已 ts 升序，overlay 多为"当下"），
 * 卡片钉在到达时刻的位置，后续消息在其下方追加（M5 单列表行为的复原）。
 */
export function mergeLiveOverlay(dbMessages: ChatMessage[], overlay: ChatMessage[]): ChatMessage[] {
  if (overlay.length === 0) return dbMessages;
  // 同 id 去重（一般消息 DB 优先）：clientId 统一后气泡两源同 key，叠加窗口期不双份（退休 pass 同触发，此为兜底）。
  // 文件卡特例（活卡优先，2026-10-06）：fileOffer 卡是事件驱动的活真相（fileOffer/fileProgress/fileState 三事件
  // 唯一落定来源，session.ts:250 纪律），DB 行只是 reloadDb 时刻的底座快照——若仍 DB 优先，拉取耗时期间尾拉触发的
  // reloadDb 会把旧态快照卡（offered/pulling）装进基底，此后 fileState(done) 只更新活卡，按钮永远停在旧态
  // （真机实测"接收成功仍显示接收，切回会话才变打开"）。故 kind='fileOffer' 的同 id 冲突反转方向：
  // DB 快照卡让位给 overlay 活卡；一般消息方向不变（DB=落定真相，overlay=过渡）。
  const liveFileIds = new Set(overlay.filter((m) => m.kind === 'fileOffer').map((m) => m.id));
  const keptDb = liveFileIds.size > 0 ? dbMessages.filter((m) => !liveFileIds.has(m.id)) : dbMessages;
  const dbIds = new Set(keptDb.map((m) => m.id));
  return [...keptDb, ...overlay.filter((m) => !dbIds.has(m.id))].sort((a, b) => a.ts - b.ts);
}

/**
 * 发送气泡停车场挑选（切会话保命，2026-10-05）：只挑 dir='out' 的未退休气泡
 * （overlay 里存留的本来就是未退休项——退休即移除）。流式卡/工具行/落定卡不停车：
 * 它们要么随重挂载由 live 流重建，要么落定后经 DB 收敛。'new' 模式不停车（收编换 id，键不稳）。
 */
/**
 * 会话归属过滤（串场根治 UI 侧）：无归属（undefined/字段缺省）放行（旧桌面兜底，与 943 防线的
 * null 放行语义显式对齐）；归属=本屏 effectiveId 放行；其余丢弃——与 ask/approval 归因分流同构。
 */
export function allowsMessageForSession(m: ChatMessage, sid: string): boolean {
  return m.sessionId === undefined || m.sessionId === sid;
}

export function pickParkableBubbles(overlay: ChatMessage[]): ChatMessage[] {
  return overlay.filter((m) => m.dir === 'out');
}


// ---------- M7：共享看板行 → 行视图（零判定渲染：行序/行态/徽章/needsYou/strip 全来自协议投影） ----------

/** 行状态点形态（动效稿语义：doing=蓝闪 / todo=琥珀空心[待认领·需拍板] / dead=玫瑰实心[待裁决] / done=✓ / cancel=灰） */
export type BoardDotKind = 'doing' | 'todo' | 'dead' | 'done' | 'cancel';

/** 徽章配色（动效稿：explore 靛蓝 / coder 青绿 / 待认领·需拍板 琥珀 / 待裁决 玫瑰 / 已取消·已交付 绿灰） */
export type BoardBadgeColor = 'indigo' | 'teal' | 'amber' | 'rose' | 'muted';

export interface BoardRowView {
  itemId: string;
  title: string;
  dotKind: BoardDotKind;
  /** 工位徽章/行态徽章（文本=协议 assignee 或 label，禁自拟）；无徽章为 null */
  badge: { text: string; color: BoardBadgeColor } | null;
  /** 右侧：进行中=计时（claimedAt 走字）；已交付=「已交付」；已取消=协议 label；其余无 */
  right: { text: string; mono: boolean } | null;
  /** 第二行进展（纯文本直渲染） */
  note: string | null;
  clipped: boolean;
}

const DOT_BY_STATUS: Record<string, BoardDotKind> = {
  pending: 'todo',
  in_progress: 'doing',
  blocked: 'todo', // 待认领/需拍板同琥珀空心（动效稿注记）
  completed: 'done',
  cancelled: 'cancel',
  failed: 'dead',
};

/** 协议行 → 行视图（纯函数；label/顺序/claimedAt/detail 直用，展示拼装仅限计时格式与徽章配色） */
export function boardRowView(row: BoardRowWire, now: number): BoardRowView {
  const dotKind = DOT_BY_STATUS[row.status] ?? 'todo';
  // 徽章文本：信号态（待认领/需拍板/待裁决）用协议 label；有主行用工位名；终态绿灰
  let badge: BoardRowView['badge'] = null;
  if (row.status === 'pending' || row.status === 'blocked' || row.status === 'failed') {
    badge = { text: row.label, color: row.status === 'failed' ? 'rose' : 'amber' };
  } else if (row.assignee) {
    const color: BoardBadgeColor =
      row.status === 'completed' || row.status === 'cancelled'
        ? 'muted'
        : row.assignee.startsWith('coder')
          ? 'teal'
          : 'indigo';
    badge = { text: row.assignee, color };
  }
  // 右侧：进行中走计时；已交付/已取消显终态词
  let right: BoardRowView['right'] = null;
  if (row.status === 'in_progress' && typeof row.claimedAt === 'number') {
    right = { text: formatClaimedDuration(row.claimedAt, now), mono: true };
  } else if (row.status === 'completed') {
    right = { text: '已交付', mono: false };
  } else if (row.status === 'cancelled') {
    right = { text: row.label, mono: false };
  }
  return {
    itemId: row.itemId,
    title: row.title,
    dotKind,
    badge,
    right,
    note: row.progressText ?? null,
    clipped: row.clipped === true,
  };
}

/** 计时展示拼装（claimedAt→now 的 mm:ss；协议字段只读） */
export function formatClaimedDuration(claimedAt: number, now: number): string {
  const v = Math.max(0, Math.floor((now - claimedAt) / 1000));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

export interface BoardStripView {
  /** 长条是否出现（收到该会话 board.state 且板非空；会话无板/板空不显示） */
  visible: boolean;
  /** settled=变绿 */
  done: boolean;
  /** running=「子任务执行中 · countText」；settled=「✓ settleText」 */
  text: string;
}

/** strip → 进度长条视图（直渲染映射：countText/settleText/needsYou 全用协议字段） */
export function boardStripView(strip: BoardStripWire | null, rowCount: number): BoardStripView {
  if (!strip || rowCount <= 0) return { visible: false, done: false, text: '' };
  const done = strip.status === 'settled';
  return {
    visible: true,
    done,
    text: done ? `✓ ${strip.settleText ?? strip.countText}` : `子任务执行中 · ${strip.countText}`,
  };
}

/** 要你信号点（strip.needsYou / needsYou.needed 皆协议字段，不自算） */
export function boardNeedsYouOn(strip: BoardStripWire | null, needsYou: BoardNeedsYouWire | null): boolean {
  return strip?.needsYou === true || needsYou?.needed === true;
}

// ---------- 长条收摊（演示稿 3·收摊 / 3·复现规则的唯一判定点；纯函数，时序可测） ----------

/** settled 展示期：满 6 秒自动收摊（演示稿「settled 后 6 秒自动淡出」） */
export const PILL_SETTLED_DISMISS_MS = 6000;

/** 展示=show / 不展示=hidden / 该收摊=auto-dismiss / 该复现=reappear（复现即展示，下轮收敛为 show） */
export type PillPresence = 'show' | 'hidden' | 'auto-dismiss' | 'reappear';

/**
 * 活跃签名（行态摘要）：复现边沿的比较基。进行中行数=协议 status==='in_progress' 直比
 *（零自算，同 boardRowView 先例）；要你=协议 needsYou 字段（boardNeedsYouOn）。
 */
export interface PillActivitySig {
  doing: number;
  needsYou: boolean;
}

/** 行态摘要提取（纯函数；rows 只读 status 协议字段） */
export function pillActivitySig(
  strip: BoardStripWire | null,
  needsYou: BoardNeedsYouWire | null,
  rows: Array<{ status: string }>,
): PillActivitySig {
  return {
    doing: rows.filter((r) => r.status === 'in_progress').length,
    needsYou: boardNeedsYouOn(strip, needsYou),
  };
}

/** 复现边沿：相对基线「出现」进行中（计数增加）或「出现」要你（false→true）；纯终态变化恒 false */
export function pillActivityGrew(sig: PillActivitySig, base: PillActivitySig | null): boolean {
  const b = base ?? { doing: 0, needsYou: false }; // null=从未亮过（基线全零——规则 4 由此成立）
  return sig.doing > b.doing || (sig.needsYou && !b.needsYou);
}

/**
 * 长条收摊/复现判定（纯函数零自算——settled/needsYou/行态全协议字段）。
 * 收摊标记由调用方按会话持有（进程内 per-session、不落库；**初值 dismissed=true**=从未亮过
 * 不显示——规则 4「重启 App：settled 且无要你直接不显示」由此自动成立）。
 * - 'show'：展示中（settled 未满 6s 也在内）；settledSince 起算/取消由调用方按 status 维护
 * - 'auto-dismiss'：settled 满 6s → 调用方置 dismissed=true、清 settledSince 并快照 sinceSig
 * - 'reappear'：收摊后**出现**（边沿）进行中/要你 → 调用方置 dismissed=false、清 settledSince、快照 sinceSig
 * - 'hidden'：无内容 / 收摊后无新活跃边沿（纯终态变化——又 completed/cancelled、rev 前进——一律不弹）
 */
export function pillPresence(input: {
  strip: BoardStripWire | null;
  needsYou: BoardNeedsYouWire | null;
  rowCount: number;
  dismissed: boolean;
  /** 展示期中 settled 的起算时刻（epoch ms）；null=非 settled 展示期（含 running 取消计时后） */
  settledSince: number | null;
  now: number;
  /** 当前活跃签名（pillActivitySig 提取） */
  sig: PillActivitySig;
  /** 收摊/初始基线签名（null=从未亮过=基线全零） */
  sinceSig: PillActivitySig | null;
}): PillPresence {
  const view = boardStripView(input.strip, input.rowCount);
  if (!view.visible) return 'hidden';
  if (input.dismissed) return pillActivityGrew(input.sig, input.sinceSig) ? 'reappear' : 'hidden';
  if (input.strip!.status === 'settled') {
    if (input.settledSince === null) return 'show';
    return input.now - input.settledSince >= PILL_SETTLED_DISMISS_MS ? 'auto-dismiss' : 'show';
  }
  return 'show';
}


// ---------- 工作计划树（workplan.state → 长条/sheet 视图模型；迭代 2 双源树：清单项 + 看板行） ----------
//
// 六条不变量落地：① 进度报顶层（x/y 只数顶层项）活动报叶子（焦点=DFS 首个目标态叶子——
// core 投影会把"有 in_progress 子项"的父项也派生为 in_progress，故焦点必须跳过有子父项取真叶子）；
// ② 没人在跑不装跑（无 in_progress 不出 spinner）；③ needsYou 唯一中断、失败红字不中断；
// ⑤ 拼不出的关系不表达（无链不猜父子——children 随行渲染不重组）；⑥ 手机零判定渲染（形态判定全在本文件）。
// 双源识别（零协议新增字段）：看板源项恒带 actor（认领成员名或'待认领'），清单项恒无 actor——
// "子任务/任务"前缀与"待认领"相位都以此为键（core workPlanTree.ts 的产出纪律）。

/** 长条活动文案语义截断（numberOfLines 之外的字符级兜底） */
const WORKPLAN_FOCUS_MAX = 20;

function truncateFocus(text: string): string {
  return text.length > WORKPLAN_FOCUS_MAX ? `${text.slice(0, WORKPLAN_FOCUS_MAX)}…` : text;
}

/** DFS 收集（先父后子）：needsYou 递归扫描的统一走序（顶层序=协议 items 序，不自排） */
function walkWorkPlan(
  items: WorkPlanItemWire[],
  visit: (item: WorkPlanItemWire, path: WorkPlanItemWire[]) => boolean,
): { item: WorkPlanItemWire; path: WorkPlanItemWire[] } | null {
  for (const item of items) {
    const hit = walkOne(item, []);
    if (hit) return hit;
  }
  return null;

  function walkOne(node: WorkPlanItemWire, trail: WorkPlanItemWire[]): { item: WorkPlanItemWire; path: WorkPlanItemWire[] } | null {
    const path = [...trail, node];
    if (visit(node, path)) return { item: node, path };
    for (const c of node.children ?? []) {
      const hit = walkOne(c, path);
      if (hit) return hit;
    }
    return null;
  }
}

/**
 * 焦点查找（不变量 ① 活动报叶子）：第一遍只认叶子（无 children 的匹配项）——
 * core 派生的 in_progress 父项不抢焦点；无叶子匹配时第二遍兜底任意匹配（防御，正常不会出现）。
 */
function findWorkPlanFocus(
  items: WorkPlanItemWire[],
  pred: (item: WorkPlanItemWire) => boolean,
): { item: WorkPlanItemWire; path: WorkPlanItemWire[] } | null {
  return (
    walkWorkPlan(items, (it) => pred(it) && (it.children ?? []).length === 0) ??
    walkWorkPlan(items, (it) => pred(it))
  );
}

/** 焦点文案模型：祖先面包屑（可空串）+ 叶子 + actor（长条四形态共用拼装） */
interface WorkPlanFocus {
  /** 祖先链（' › ' 连接；无父项=空串） */
  crumb: string;
  leaf: string;
  actor: string | null;
}

function workPlanFocusOf(hit: { item: WorkPlanItemWire; path: WorkPlanItemWire[] }): WorkPlanFocus {
  const ancestors = hit.path.slice(0, -1).map((p) => truncateFocus(p.content));
  return {
    crumb: ancestors.join(' › '),
    leaf: truncateFocus(hit.item.content),
    actor: hit.item.actor ?? null,
  };
}

const actorSuffix = (f: WorkPlanFocus): string => (f.actor ? `（${f.actor}）` : '');

/** 任意项 needsYou（递归；唯一中断信号的判定源） */
function workPlanAnyNeedsYou(items: WorkPlanItemWire[]): boolean {
  return walkWorkPlan(items, (it) => it.needsYou === true) !== null;
}

/**
 * 计数前缀（象限判定）：树顶层全部来自看板（无清单项——每项都带 actor）→ '子任务'（象限 1 口径沿用）；
 * 否则 '任务'（象限 2/3）。
 */
export function workPlanCountPrefix(items: WorkPlanItemWire[]): '子任务' | '任务' {
  return items.length > 0 && items.every((it) => it.actor !== undefined) ? '子任务' : '任务';
}

export interface WorkPlanStripView {
  /** 长条是否出现（树非空；空树不渲染） */
  visible: boolean;
  /** 全完成=变绿收摊（pillDone 样式；收摊状态机复用 pillPresence——settled 即此态） */
  done: boolean;
  /** 失败警示（红字；警示非中断） */
  failed: boolean;
  /** 有进行中项=spinner 转圈；无 in_progress 一律静态图标（不变量 ②） */
  spinning: boolean;
  /** 要你信号（琥珀点压顶） */
  needsYou: boolean;
  /** 待认领灰调（场景 4：无人在跑、只有待认领看板行——静态灰点 + 灰调文案） */
  muted: boolean;
  /** 长条主文案（形态之一） */
  text: string;
}

/**
 * 长条形态判定（优先级：needsYou 压顶 > 运行中 > 失败警示 > 待认领/下一项 > 全完成）：
 * - 有 in_progress：`任务 x/y · 父项 › 正在做：{焦点叶子（成员）}`（spinner；无父项无面包屑段）
 * - 无 in_progress 有 failed：`任务 x/y · 父项 ›「{failed 叶子}」失败`（红字警示）
 * - 无 in_progress/failed 有 pending：看板待认领行 → `{前缀} x/y · N 条等待认领`（灰调）；
 *   清单待办 → `任务 x/y · 下一项：{首个 pending 叶子}`（静态）
 * - 全 completed/cancelled：`✓ x/y · 子任务全部完成 | 工作计划全部完成`（绿底）
 * - 空树：visible=false
 */
export function workPlanStripView(items: WorkPlanItemWire[]): WorkPlanStripView {
  const hidden: WorkPlanStripView = { visible: false, done: false, failed: false, spinning: false, needsYou: false, muted: false, text: '' };
  if (items.length === 0) return hidden;
  const total = items.length; // 进度报顶层（不变量 ①）
  const doneCount = items.filter((it) => it.status === 'completed').length;
  const prefix = workPlanCountPrefix(items);
  const count = `${prefix} ${doneCount}/${total}`;
  const needsYouHit = walkWorkPlan(items, (it) => it.needsYou === true);
  if (needsYouHit) {
    const f = workPlanFocusOf(needsYouHit);
    const crumb = f.crumb ? `${f.crumb} › ` : '';
    return { visible: true, done: false, failed: false, spinning: false, needsYou: true, muted: false, text: `要你做决定 · ${crumb}${f.leaf}${actorSuffix(f)}` };
  }
  const doing = findWorkPlanFocus(items, (it) => it.status === 'in_progress');
  if (doing) {
    const f = workPlanFocusOf(doing);
    const crumb = f.crumb ? `${f.crumb} › ` : '';
    return { visible: true, done: false, failed: false, spinning: true, needsYou: false, muted: false, text: `${count} · ${crumb}正在做：${f.leaf}${actorSuffix(f)}` };
  }
  const failed = findWorkPlanFocus(items, (it) => it.status === 'failed');
  if (failed) {
    const f = workPlanFocusOf(failed);
    const crumb = f.crumb ? `${f.crumb} › ` : '';
    return { visible: true, done: false, failed: true, spinning: false, needsYou: false, muted: false, text: `${count} · ${crumb}「${f.leaf}」失败` };
  }
  const next = findWorkPlanFocus(items, (it) => it.status === 'pending');
  if (next) {
    if (next.item.actor === '待认领') {
      // 场景 4：看板行全待认领——灰调「N 条等待认领」（不冒充清单下一项）
      let unclaimed = 0;
      walkWorkPlan(items, (it) => {
        if (it.status === 'pending' && it.actor === '待认领') unclaimed += 1;
        return false;
      });
      return { visible: true, done: false, failed: false, spinning: false, needsYou: false, muted: true, text: `${count} · ${unclaimed} 条等待认领` };
    }
    const f = workPlanFocusOf(next);
    const crumb = f.crumb ? `${f.crumb} › ` : '';
    return { visible: true, done: false, failed: false, spinning: false, needsYou: false, muted: false, text: `${count} · ${crumb}下一项：${f.leaf}${actorSuffix(f)}` };
  }
  return {
    visible: true, done: true, failed: false, spinning: false, needsYou: false, muted: false,
    text: `✓ ${doneCount}/${total} · ${prefix === '子任务' ? '子任务全部完成' : '工作计划全部完成'}`,
  };
}

/**
 * 长条显隐（1.4 临时共存规则已随迭代 2 树合并退役——树是唯一数据源，WorkPlanPanel 是唯一面板）：
 * 树非空即候选可见（收摊状态机在组件侧叠加 pillPresence 判定）。
 */
export function workPlanStripVisible(items: WorkPlanItemWire[]): boolean {
  return workPlanStripView(items).visible;
}

/** sheet 头元信息（标题右侧「x/y 已完成」；计数报顶层，与长条同源） */
export interface WorkPlanSheetMeta {
  total: number;
  doneCount: number;
}

export function workPlanSheetMeta(items: WorkPlanItemWire[]): WorkPlanSheetMeta {
  return { total: items.length, doneCount: items.filter((it) => it.status === 'completed').length };
}

/** sheet 行视图（状态点映射：in_progress=doing 蓝脉冲 / pending=todo 琥珀空心 / completed=done ✓ / failed=dead 玫瑰 / cancelled=cancel 灰） */
export interface WorkPlanRowView {
  id: string;
  content: string;
  dotKind: BoardDotKind;
  /** completed=删除线+灰（绿 ✓） */
  done: boolean;
  /** cancelled=灰点+灰删除线 */
  cancelled: boolean;
  /** 行级要你（琥珀标记 + note 琥珀警示——唯一中断信号的行内形态） */
  needsYou: boolean;
  /** 进展/结果小注（非终态=wire.note[受阻原因等]；终态=result ?? note；feed 实况兜底在组件侧叠加） */
  note: string | null;
  noteFailed: boolean;
  /** actor 徽章（五色映射沿用 boardRowView 先例；'待认领'=muted 灰芯片；needsYou=amber） */
  badge: { text: string; color: BoardBadgeColor } | null;
  /** 嵌套子行（children 随行渲染：有链看板行嵌在父项卡片内部） */
  children: WorkPlanRowView[];
}

/** 协议项 → 行视图（children 递归随行；展示拼装仅限徽章配色与小注取舍） */
export function workPlanRowView(item: WorkPlanItemWire): WorkPlanRowView {
  const dotKind: BoardDotKind =
    item.status === 'in_progress'
      ? 'doing'
      : item.status === 'completed'
        ? 'done'
        : item.status === 'failed'
          ? 'dead'
          : item.status === 'cancelled'
            ? 'cancel'
            : 'todo';
  const done = item.status === 'completed';
  const cancelled = item.status === 'cancelled';
  const terminal = done || cancelled || item.status === 'failed';
  const pick = (s: string | undefined): string | null => (typeof s === 'string' && s.length > 0 ? s : null);
  // 终态小注=结果摘要（完成/失败留痕）优先，wire.note（自动结项标注/受阻原因）兜底；非终态=wire.note
  const note = terminal ? (pick(item.result) ?? pick(item.note)) : pick(item.note);
  const needsYou = item.needsYou === true;
  return {
    id: item.id,
    content: item.content,
    dotKind,
    done,
    cancelled,
    needsYou,
    note,
    noteFailed: item.status === 'failed',
    badge: item.actor
      ? {
          text: item.actor,
          color:
            item.actor === '待认领' || done || cancelled
              ? 'muted'
              : needsYou
                ? 'amber'
                : item.actor.startsWith('coder')
                  ? 'teal'
                  : 'indigo',
        }
      : null,
    children: (item.children ?? []).map(workPlanRowView),
  };
}


// ---------- V2：feed 事实拼装 + 点行分态明细展开模型（纯渲染,零判定） ----------

/** 工具事实状态词（直用枚举映射,非判定） */
const FEED_STATUS_TEXT: Record<string, string> = {
  running: '执行中',
  success: '完成',
  failed: '失败',
};

/** 事实行（工具细节展开的一条;running 脉冲态由视图层表现） */
export interface FeedFactRow {
  toolCallId: string;
  /** 「工具名 · 状态 · 耗时」纯拼装 */
  text: string;
  running: boolean;
}

/** feed 事实 → 工具细节行（最新在前,默认最近 3 次;拼装非判定。running 无耗时——协议线形 terminal 才带 durationMs） */
export function feedToolDetailRows(facts: FeedSubagentBody[], limit = 3): FeedFactRow[] {
  return facts.slice(0, limit).map((f) => {
    const dur = f.status !== 'running' && typeof f.durationMs === 'number' ? ` · ${(f.durationMs / 1000).toFixed(1)}s` : '';
    return {
      toolCallId: f.toolCallId,
      text: `${f.toolName} · ${FEED_STATUS_TEXT[f.status] ?? f.status}${dur}`,
      running: f.status === 'running',
    };
  });
}

/**
 * 进展行事实兜底（决策 8 双源完整生效）：progressText 空缺时降级显示最近一次工具事实
 * （`read_file · 0.4s` 式,纯拼装非判定);有 progressText 则不动。
 */
export function feedFactFallback(progressText: string | null, facts: FeedSubagentBody[]): string | null {
  if (progressText !== null && progressText.length > 0) return progressText;
  const rows = feedToolDetailRows(facts, 1);
  return rows.length > 0 ? rows[0]!.text : null;
}

/** 五态展开内容模型（数据全部随行 detail 下发 + feed overlay;渲染层零判定） */
export type RowExpandKind = 'tools' | 'result' | 'history' | 'blocked' | 'cancel' | 'none';

export interface RowExpandModel {
  kind: RowExpandKind;
  /** 标题行（工具细节/查看完整结果/记录明细/受阻原因/撤单说明） */
  title: string | null;
  /** 纯文本正文（result 全文/受阻原因/撤单说明） */
  text: string | null;
  /** 明细行（历史/工具事实;纯文本） */
  lines: string[];
  /** 工具事实行（kind='tools';running 脉冲标记） */
  facts: FeedFactRow[];
}

/** 留痕行用词（同投影:system=失败记录,人工=退回记录） */
function historyLineOf(by: string, reason: string): string {
  return by === 'system' ? `失败记录：${reason}` : `退回记录：${by}：${reason}`;
}

/**
 * 点行展开模型（五态定稿语义）:
 * 进行中→工具细节(feed 最近 3 次)/完成→查看完整结果(detail.result 全文)/
 * 失败·退回→记录明细(releaseHistory 逐条,用词同投影)/需拍板→受阻原因(blockedReason)/
 * 取消→撤单说明(留痕 reason)。纯函数,展开可见性不依赖任何动画态。
 */
export function boardRowExpandModel(
  row: {
    status: string;
    progressText?: string | null;
    detail?: {
      blockedReason?: string;
      result?: string;
      releaseHistory?: { by: string; reason: string; suggestedTo?: string; at: number }[];
    } | null;
  },
  facts: FeedSubagentBody[],
): RowExpandModel {
  const d = row.detail ?? {};
  switch (row.status) {
    case 'in_progress':
      return {
        kind: 'tools',
        title: '工具细节',
        text: null,
        lines: [],
        facts: feedToolDetailRows(facts, 3),
      };
    case 'completed':
      return { kind: 'result', title: '查看完整结果', text: d.result ?? null, lines: [], facts: [] };
    case 'failed':
    case 'pending': {
      // 失败/退回行:记录明细(留痕逐条,失败记录/退回记录用词同投影)
      const hist = d.releaseHistory ?? [];
      if (hist.length === 0) return { kind: 'none', title: null, text: null, lines: [], facts: [] };
      return {
        kind: 'history',
        title: '记录明细',
        text: null,
        lines: hist.map((h) => historyLineOf(h.by, h.reason)),
        facts: [],
      };
    }
    case 'blocked':
      return { kind: 'blocked', title: '受阻原因', text: d.blockedReason ?? null, lines: [], facts: [] };
    case 'cancelled': {
      const hist = d.releaseHistory ?? [];
      const last = hist.length > 0 ? hist[hist.length - 1] : undefined;
      return { kind: 'cancel', title: '撤单说明', text: last?.reason ?? null, lines: [], facts: [] };
    }
    default:
      return { kind: 'none', title: null, text: null, lines: [], facts: [] };
  }
}


// ---------- 统一回声确认退休（overlay ↔ DB 双源接管的唯一判定 SSOT） ----------
//
// 退休不变量：有 DB 对应物的 overlay 项，只有在 DB 窗口中确认其对应物存在时才允许退休；
// 没有 DB 对应物的（守卫拒绝的气泡 / abort 半截节拍），按信号退休（没什么可等的）。
// 匹配键按类分派（每类用它拥有的最强键）：工具行=toolCallId（msgKey）；用户气泡=clientId（新端）
// ∨ 内容+时间下界（全版本兜底；media 气泡按附件 ref）；节拍卡=内容回声（相等 ∨ truncated 前缀）；
// think 卡=内容回声 ∨ 同节拍 stream 卡退休随行；notice 卡=内容回声（roundFailure 回流行），
// 无回声保留（守卫/deny/中断提示用户该看到）。回声匹配一律消耗式：一份 DB 回声至多接管一张卡。

/** overlay 流式卡的锚点形态：stream-{anchor}-{beat} / think-{anchor}-{beat}（与 session.ts 的 id 构造对齐） */
export const ANCHORED_STREAM = /^(?:stream|think)-(.+)-(\d+)$/;

/** legacy 用户气泡回声的时间下界容忍（两设备时钟偏移）：桌面收录 ts 恒晚于手机发送（网络延迟为正），下界排除"同文旧行"误判 */
export const LEGACY_ECHO_SKEW_MS = 10 * 60 * 1000;

/** DB 窗口回声集（消耗式匹配：计数存储，一份回声至多接管一张 overlay 卡，按 ts 顺序消耗） */
export interface EchoSets {
  /** clientId → 计数（relay 来源用户消息的精确匹配键；旧端/旧库无此字段时为空，走兼容路径） */
  dbIds: Map<string, number>;
  /** 无 clientId 的 user 行（兼容路径）：文本 + ts + 附件 ref 清单（media 气泡按 ref 匹配——行 text 是占位符） */
  dbUserLegacy: Array<{ text: string; ts: number; refs: string[] }>;
  /** 工具行 msgKey（tool:{toolCallId}）→ 计数 */
  dbToolKeys: Map<string, number>;
  /** assistant 正文全文 + reasoningContent 全文 → 计数（think 卡回声同池） */
  dbContentTexts: Map<string, number>;
  /** truncated 行 text（= overlay 全文的前缀）→ 计数 */
  dbTruncatedPrefixes: Map<string, number>;
}

export function emptyEchoSets(): EchoSets {
  return { dbIds: new Map(), dbUserLegacy: [], dbToolKeys: new Map(), dbContentTexts: new Map(), dbTruncatedPrefixes: new Map() };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** 消耗一份计数回声；有货则消耗并返回 true */
function consume(map: Map<string, number>, key: string): boolean {
  const n = map.get(key) ?? 0;
  if (n <= 0) return false;
  if (n === 1) map.delete(key); else map.set(key, n - 1);
  return true;
}

/** 前缀消耗：truncated 行 text 是 overlay 全文的前缀（单条超 32KB 截断），相等视作命中 */
function consumePrefix(map: Map<string, number>, text: string): boolean {
  for (const [prefix, n] of map) {
    if (n > 0 && prefix.length > 0 && text.startsWith(prefix)) {
      if (n === 1) map.delete(prefix); else map.set(prefix, n - 1);
      return true;
    }
  }
  return false;
}

function parsePayload(row: MessageRow): Record<string, unknown> {
  if (!row.payloadJson) return {};
  try {
    const p = JSON.parse(row.payloadJson) as unknown;
    return p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 从原始 MessageRow 构建回声集（不用映射后的 ChatMessage——截断标注/拼接会破坏相等匹配） */
export function buildEchoSets(rows: MessageRow[]): EchoSets {
  const sets = emptyEchoSets();
  for (const row of rows) {
    if (row.clientId) bump(sets.dbIds, row.clientId);
    if (row.role === 'user' && !row.clientId) {
      let refs: string[] = [];
      if (row.refsJson) {
        try {
          const r = JSON.parse(row.refsJson) as unknown;
          if (Array.isArray(r)) refs = r.map((x) => String((x as { ref?: unknown })?.ref ?? '')).filter(Boolean);
        } catch {
          /* refs 损坏按无 refs */
        }
      }
      sets.dbUserLegacy.push({ text: row.text, ts: Date.parse(row.ts) || 0, refs });
    }
    if (row.kind === 'tool') bump(sets.dbToolKeys, row.msgKey);
    if (row.role === 'assistant') {
      const payload = parsePayload(row);
      if (row.text.trim().length > 0) {
        if (payload['truncated'] === true) bump(sets.dbTruncatedPrefixes, row.text);
        else bump(sets.dbContentTexts, row.text);
      }
      const rc = payload['reasoningContent'];
      if (typeof rc === 'string' && rc.length > 0) bump(sets.dbContentTexts, rc);
    }
  }
  return sets;
}

/**
 * 回声集三种构建形态（铁律：EchoSets 是消耗式计数结构，计数必须与一个真实存在的行集一一对应）：
 * ① reloadDb 整组重建（echoesRef = buildEchoSets(最新页)，与渲染窗口同源）；
 * ② loadOlder 并集累积（本函数；页不相交游标保证——每次查的是更早的不相交页，计数相加不虚）；
 * ③ retireOnly 整组替换（悬空退休用：分页回读快照一次构建整组赋值，窗口外尾页并入——见 retireWithSnapshot）。
 * 禁止对"滑动最新页"做本函数的累积（前缀重叠 → 同一行重复 bump → 计数虚高 → 固定文案卡误退休）。
 */
export function mergeEchoSets(a: EchoSets, b: EchoSets): EchoSets {
  const out: EchoSets = {
    dbIds: new Map(a.dbIds),
    dbUserLegacy: [...a.dbUserLegacy, ...b.dbUserLegacy],
    dbToolKeys: new Map(a.dbToolKeys),
    dbContentTexts: new Map(a.dbContentTexts),
    dbTruncatedPrefixes: new Map(a.dbTruncatedPrefixes),
  };
  for (const [k, n] of b.dbIds) out.dbIds.set(k, (out.dbIds.get(k) ?? 0) + n);
  for (const [k, n] of b.dbToolKeys) out.dbToolKeys.set(k, (out.dbToolKeys.get(k) ?? 0) + n);
  for (const [k, n] of b.dbContentTexts) out.dbContentTexts.set(k, (out.dbContentTexts.get(k) ?? 0) + n);
  for (const [k, n] of b.dbTruncatedPrefixes) out.dbTruncatedPrefixes.set(k, (out.dbTruncatedPrefixes.get(k) ?? 0) + n);
  return out;
}

/** 各锚点现存最高节拍（abort/失败半截节拍=最高节拍，其卡永不落盘、按信号退休） */
function highestBeats(overlay: ChatMessage[]): Map<string, number> {
  const max = new Map<string, number>();
  for (const m of overlay) {
    const t = ANCHORED_STREAM.exec(m.id);
    if (t) max.set(t[1]!, Math.max(max.get(t[1]!) ?? -1, Number(t[2])));
  }
  return max;
}

/** legacy 用户气泡回声（无 clientId 的全版本兜底）：消耗式；media 气泡按附件 ref，文本气泡按全文+时间下界 */
function consumeLegacyUserEcho(echoes: EchoSets, m: ChatMessage): boolean {
  const mediaRefs = m.media?.items.map((i) => i.ref).filter(Boolean) ?? [];
  const idx = echoes.dbUserLegacy.findIndex((e) => {
    if (e.ts < m.ts - LEGACY_ECHO_SKEW_MS) return false;
    if (mediaRefs.length > 0) return mediaRefs.some((r) => e.refs.includes(r));
    return e.text === m.text;
  });
  if (idx < 0) return false;
  echoes.dbUserLegacy.splice(idx, 1);
  return true;
}

/**
 * 统一回声确认退休（退休规则总表的唯一实现；判定所需信号全部自给——notice 卡自带 roundStarted 标记）：
 * - approval/ask/alarm：保留（交互卡不归此机制）
 * - status 工具行：toolCallId 回声（现状规则的收纳）
 * - out 气泡：拒绝型 notice（roundStarted=false，收录未发生）→ 立即退休（误判代价=DB 行到达自愈）；
 *   否则 clientId 精确回声 ∨ legacy 内容回声
 * - reasoning（think 卡）：内容回声 ∨ 同节拍 stream 卡退休随行 ∨ 失败/中止轮的最高节拍（半截永不落盘）
 * - notice 卡：内容回声（roundFailure 回流行）否则保留（守卫/deny/中断提示）
 * - stream/final 卡：内容回声（相等 ∨ truncated 前缀）∨ 失败/中止轮的最高节拍
 * 触发点：reloadDb/loadOlder（echoes 变）与 overlay 合帧 flush（signals 变——拒绝路径无任何 history 事件）。
 */
export function retireConfirmedOverlay(overlay: ChatMessage[], echoes: EchoSets): ChatMessage[] {
  if (overlay.length === 0) return overlay;
  const rejectedAnchors = new Set<string>();
  const failedAnchors = new Set<string>();
  for (const m of overlay) {
    if (m.kind !== 'notice' || m.dir !== 'in') continue;
    const t = ANCHORED_STREAM.exec(m.id);
    if (!t) continue;
    // roundStarted 未携带（异常兜底）按有活动处理——保守方向：气泡继续等回声，不误清
    if (m.roundStarted === false) rejectedAnchors.add(t[1]!);
    else failedAnchors.add(t[1]!);
  }
  const maxBeat = highestBeats(overlay);
  const retiredBeatKeys = new Set<string>();
  const keep = new Set<ChatMessage>();
  const work = [...overlay].sort((a, b) => a.ts - b.ts);
  const thinkCards: ChatMessage[] = [];
  // 第一遍：非 think 卡（stream 卡先行退休并登记节拍——think 卡 ts 天然先于同节拍 stream 卡，单遍拿不到随行依据）
  // 提问/审批卡已按归因分流（v5）不再特判保留：id=ask-*/approval-* 不匹配锚正则，落下方无锚保留分支
  for (const m of work) {
    if (m.kind === 'status') {
      if (!consume(echoes.dbToolKeys, `tool:${m.id.slice(5)}`)) keep.add(m);
      continue;
    }
    if (m.dir === 'out') {
      if (rejectedAnchors.has(m.id)) continue;
      if (consume(echoes.dbIds, m.id)) continue;
      if (!consumeLegacyUserEcho(echoes, m)) keep.add(m);
      continue;
    }
    const t = ANCHORED_STREAM.exec(m.id);
    if (!t) {
      keep.add(m);
      continue;
    }
    const anchor = t[1]!;
    const beat = Number(t[2]);
    const isPartialTail = failedAnchors.has(anchor) && maxBeat.get(anchor) === beat;
    if (m.kind === 'reasoning') {
      thinkCards.push(m);
      continue;
    }
    if (m.kind === 'notice') {
      if (consume(echoes.dbContentTexts, m.text)) continue;
      keep.add(m);
      continue;
    }
    // stream/final 卡
    if (consume(echoes.dbContentTexts, m.text) || consumePrefix(echoes.dbTruncatedPrefixes, m.text)) {
      retiredBeatKeys.add(`${anchor}|${beat}`);
      continue;
    }
    if (isPartialTail) continue;
    keep.add(m);
  }
  // 第二遍：think 卡（内容回声 ∨ 同节拍 stream 卡退休随行 ∨ 失败/中止轮最高节拍）
  for (const m of thinkCards) {
    const t = ANCHORED_STREAM.exec(m.id)!;
    const anchor = t[1]!;
    const beat = Number(t[2]);
    if (consume(echoes.dbContentTexts, m.text)) continue;
    if (retiredBeatKeys.has(`${anchor}|${beat}`)) continue;
    if (failedAnchors.has(anchor) && maxBeat.get(anchor) === beat) continue;
    keep.add(m);
  }
  return overlay.filter((m) => keep.has(m));
}

/**
 * 快照退休（按钮卡停止修复 v3 · retireOnly 的可测核心）：给定一份"本次回读的不相交行集"（分页游标
 * 保证页不重叠），一次构建回声并整组执行退休。retired = overlay 长度实际减少（渲染收口 flag 的判据；
 * 不以回声消耗为准——consume 成功但卡保留的情况存在，如 think 卡首遍不退休）。同页两次到达 = 各自
 * 独立快照（幂等），计数恒与行 1:1——这是"整组替换纪律"的行为级验证点（见 mergeEchoSets 注释③）。
 */
export function retireWithSnapshot(overlay: ChatMessage[], rows: MessageRow[]): { next: ChatMessage[]; retired: boolean } {
  const echoes = buildEchoSets(rows);
  const next = retireConfirmedOverlay(overlay, echoes);
  return { next, retired: next.length < overlay.length };
}

// ---------- 会话行手势判定（会话管理：滑动删除/长按改标题——判定纯函数，组件只接线） ----------

/** tap 上限：release 时双轴累计位移都在此内 = 点按（进会话/收回展开） */
export const SWIPE_TAP_MAX_PX = 8;
/** 滑开阈值：|dx| 达到即吸附展开删除按钮（左右滑同效——按钮固定停靠行尾） */
export const SWIPE_OPEN_THRESHOLD_PX = 40;

/**
 * 水平接管判定（PanResponder onStart 接管后，move 期逐帧裁决）：
 * 水平位移明显占优（>1.5 倍垂直）且超过 tap 上限才由行手势接管；垂直占优时
 * onPanResponderTerminationRequest 放手给 ScrollView（列表滚动不受损）。
 */
export function shouldClaimHorizontal(dx: number, dy: number): boolean {
  return Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > SWIPE_TAP_MAX_PX;
}

export type SwipeRelease = 'tap' | 'open' | 'close' | 'snap';

/**
 * release 分派：双轴都在 tap 上限内 = tap（closed=tap 进会话，open=tap 收回）；
 * closed 且 |dx| 过阈值 = open（左右滑同效）；open 且向右回滑过阈值 = close（收回删除按钮）；
 * 其余 = snap（回吸附位：closed 回 0，open 保持展开）。
 */
export function resolveSwipeRelease(dx: number, dy: number, currentlyOpen: boolean): SwipeRelease {
  if (Math.abs(dx) < SWIPE_TAP_MAX_PX && Math.abs(dy) < SWIPE_TAP_MAX_PX) return 'tap';
  if (!currentlyOpen && Math.abs(dx) >= SWIPE_OPEN_THRESHOLD_PX) return 'open';
  if (currentlyOpen && dx >= SWIPE_OPEN_THRESHOLD_PX) return 'close';
  return 'snap';
}

/** 删除两步状态机：closed→open（滑开）→confirming（点删除）→submitting（点确认）→closed（落定/失败） */
export type SessionRowManageState = 'closed' | 'open' | 'confirming' | 'submitting';
export type ManageEvent =
  | 'swipeOpen' // 滑开吸附
  | 'tapDelete' // 点「删除」（一步）
  | 'tapConfirm' // 点「确认删除」（二步，提交）
  | 'dismiss' // 点他行/滚动/收回
  | 'settled' // 桌面执行落定（cmd.result ok 或回流命中）
  | 'failed'; // 投递失败/桌面拒绝/超时兜底

export function nextManageState(s: SessionRowManageState, e: ManageEvent): SessionRowManageState {
  switch (s) {
    case 'closed':
      return e === 'swipeOpen' ? 'open' : 'closed';
    case 'open':
      if (e === 'tapDelete') return 'confirming';
      if (e === 'dismiss') return 'closed';
      return 'open';
    case 'confirming':
      if (e === 'tapConfirm') return 'submitting';
      if (e === 'dismiss') return 'closed';
      return 'confirming';
    case 'submitting':
      // submitting 不接受 dismiss（执行中不可误触），落定/失败才回 closed
      if (e === 'settled' || e === 'failed') return 'closed';
      return 'submitting';
  }
}

export type RenameSubmit = 'submit' | 'invalid' | 'unchanged';

/** 重命名提交门：空/纯空白=不可提交（✓置灰）；trim 后与原标题相同=静默退出编辑态（不发请求） */
export function resolveRenameSubmit(draft: string, currentTitle: string): RenameSubmit {
  const t = draft.trim();
  if (!t) return 'invalid';
  if (t === currentTitle) return 'unchanged';
  return 'submit';
}

/** 重命名标题上限（与桌面 patchTitle 校验同口径：trim 后 ≤100 字符） */
export const RENAME_TITLE_MAX_CHARS = 100;

// ---------- 浮层手风琴：裁决卡二态 + 召唤展开信号（2026-10-04 归因分流配套） ----------
//
// 呈现跟着身份走：进程级旁路裁决卡（无归因 ask + card 载荷）是唯一超体量的卡，获得二态——
// 到达一律隐匿（首达/冷启动重放/重连重推不打扰），展开唯一来源=本机召唤回执信号；
// 其余卡（审批/普通提问）天然紧凑可操作。
// 展开信号=召唤回执（cmd improve issued/reannounced）的本地事实——信封同形区分不了
// "自己刚召唤"与"重连重推"，只有手机知道自己发过 cmd；凭它展开，重推不重新打扰。

/** 裁决卡二态：expanded=全文（唯一来源=召唤回执信号）；parked=隐匿（到达的缺省形态） */
export type FloatingCardPhase = 'expanded' | 'parked';

/** 召唤展开信号有效期：期内裁决卡到达即强制展开；过期弃置（防误展开迟到的模型开庭卡） */
export const EXPAND_SIGNAL_TTL_MS = 30_000;

/**
 * 浮层裁决卡阶段推进（纯函数；快照重算的唯一判定点）：
 * - 到达一律隐匿：新到场（不在 prev）→ parked——冷启动重放/重连重推/首达都不打扰，
 *   展开唯一来源=本机召唤回执信号（"只有用户想看时他自然会去按"）
 * - 已在场 → 保持既有阶段（跨快照不丢）
 * - 展开信号新鲜且有卡在场 → 强制 expanded 并消费（signalLive=false，调用方清信号）
 * - 信号新鲜但暂无卡 → signalLive=true（武装中，等卡到达）
 * - 信号过期 → 弃置（不影响既有阶段）
 * 离场（落定）的 id 不进产物——阶段表随卡集收缩。
 */
export function nextFloatingCardPhases(input: {
  courtCardIds: string[];
  prev: Record<string, FloatingCardPhase>;
  expandSignalAt: number | null;
  now: number;
}): { phases: Record<string, FloatingCardPhase>; signalLive: boolean } {
  const phases: Record<string, FloatingCardPhase> = {};
  for (const id of input.courtCardIds) phases[id] = input.prev[id] ?? 'parked';
  const fresh = input.expandSignalAt !== null && input.now - input.expandSignalAt <= EXPAND_SIGNAL_TTL_MS;
  let signalLive = false;
  if (fresh) {
    if (input.courtCardIds.length > 0) {
      for (const id of input.courtCardIds) phases[id] = 'expanded';
    } else {
      signalLive = true;
    }
  }
  return { phases, signalLive };
}

/** improve.page 翻页命令客户端（RelaySession.requestCmd 的结构形状；浮层/时间线共用） */
export interface CourtPageCmdClient {
  requestCmd(id: string, cmd: string, args?: Record<string, unknown>): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { message: string } }>;
}

/**
 * 裁决卡原地翻页（improve.page cmd 一次往返）：App 浮层卡与 ChatScreen 时间线卡共用的
 * 唯一拼装点（单一事实点，防两处漂移）。triage-page- 前缀不进 App 的 improve- toast 路由——
 * 卡内自管错误行。
 */
export function turnCourtPage(
  session: CourtPageCmdClient,
  dir: 'next' | 'prev',
  decisions: AskDecisionEntry[],
): Promise<import('./TriageCard').PageTurnResult> {
  return session
    .requestCmd(`triage-page-${Date.now()}`, 'improve.page', { dir, decisions })
    .then((r) => ({
      ok: r.ok,
      ...(r.data ? { card: r.data['card'] } : {}),
      ...(r.error ? { error: r.error.message } : {}),
    }))
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
}

// ---------- 上翻分页滚动（视口跳变修复） ----------

/** 游标 CAS 判定（上翻 prepend 推进权）：查询基准 base 与当前游标一致 → 允许推进（true）；
 *  查询期间被并发通路推进（older 应答 reloadDb(true) / loadOlder / 整组替换重置）→ 让位（false）。
 *  同基准同参数查询结果相同，保留其一零丢失；DB 存货永在，让位只跳过内存 prepend。 */
export const cursorAllowsPrepend = (cursor: string | null | undefined, base: string | undefined): boolean =>
  (cursor ?? undefined) === base;
