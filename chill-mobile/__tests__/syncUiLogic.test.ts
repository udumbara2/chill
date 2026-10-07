/**
 * syncUiLogic 单测（M6 类五）：会话分区/折叠纯逻辑 + DB 消息行 → 渲染序列映射。
 */
import {
  fileCardPhase,
  UNGROUPED_KEY,
  boardNeedsYouOn,
  boardRowExpandModel,
  boardRowView,
  boardStripView,
  buildEchoSets,
  defaultExpandedKeys,
  emptyEchoSets,
  feedFactFallback,
  feedToolDetailRows,
  formatClaimedDuration,
  groupSessionsIntoSections,
  mergeEchoSets,
  mergeLiveOverlay,
  nextFloatingCardPhases,
  nextManageState,
  parseExpanded,
  EXPAND_SIGNAL_TTL_MS,
  resolveDefaultChatTarget,
  resolveRenameSubmit,
  resolveSwipeRelease,
  retireConfirmedOverlay,
  retireWithSnapshot,
  rowsToChatMessages,
  shouldClaimHorizontal,
  SWIPE_OPEN_THRESHOLD_PX,
  SWIPE_TAP_MAX_PX,
} from '../src/screens/syncUiLogic';
import type { MessageRow, ProjectRow, SessionRow } from '../src/db/syncDb';
import type { ChatMessage } from '../src/relay/session';
import type { BoardRowWire, FeedSubagentBody } from '../src/relay/envelope';

function srow(sessionId: string, updatedAt: string, projectId: string | null = null): SessionRow {
  return {
    agentId: 'a1',
    sessionId,
    projectId,
    title: `标题-${sessionId}`,
    titleSource: null,
    workdir: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt,
    preview: `预览-${sessionId}`,
  };
}

function prow(projectId: string, name: string): ProjectRow {
  return { agentId: 'a1', projectId, name, updatedAt: '2026-09-01T00:00:00.000Z' };
}

// ---------- 分区 ----------

test('分区：项目分区按"分区内最新 updatedAt"降序；未分组伪分区固定最后；分区名取项目名', () => {
  const sections = groupSessionsIntoSections(
    [
      srow('s-p1-new', '2026-09-10T03:00:00.000Z', 'p1'),
      srow('s-p2', '2026-09-10T05:00:00.000Z', 'p2'), // p2 更活跃 → 排前
      srow('s-p1-old', '2026-09-10T01:00:00.000Z', 'p1'),
      srow('s-free', '2026-09-10T09:00:00.000Z', null), // 未分组再新也固定最后
    ],
    [prow('p1', '助手项目'), prow('p2', '域名选型')],
  );
  expect(sections.map((s) => s.key)).toEqual(['p2', 'p1', UNGROUPED_KEY]);
  expect(sections[0]!.title).toBe('域名选型');
  expect(sections[2]!.title).toBe('未分组');
  // 分区内保持输入序（调用方 updatedAt 降序）
  expect(sections[1]!.rows.map((r) => r.sessionId)).toEqual(['s-p1-new', 's-p1-old']);
});

test('分区：空项目（无会话）不产出分区；全部未分组时只有伪分区', () => {
  const sections = groupSessionsIntoSections([srow('s1', '2026-09-10T00:00:00.000Z')], [prow('p1', '空项目')]);
  expect(sections.map((s) => s.key)).toEqual([UNGROUPED_KEY]);
  expect(groupSessionsIntoSections([], [])).toEqual([]);
});

test('默认展开：当前会话所在分区；无当前会话全折叠；expandedProjectsJson 解析容错', () => {
  const sections = groupSessionsIntoSections(
    [srow('s1', '2026-09-10T00:00:00.000Z', 'p1'), srow('s2', '2026-09-10T01:00:00.000Z')],
    [prow('p1', '项目一')],
  );
  expect([...defaultExpandedKeys(sections, 's1')]).toEqual(['p1']);
  expect([...defaultExpandedKeys(sections, 's2')]).toEqual([UNGROUPED_KEY]);
  expect(defaultExpandedKeys(sections, null).size).toBe(0);
  expect(parseExpanded('{"p1":true}')).toEqual({ p1: true });
  expect(parseExpanded('坏 json')).toEqual({});
  expect(parseExpanded(null)).toEqual({});
});

// ---------- 消息行映射 ----------

function mrow(msgKey: string, over: Partial<MessageRow>): MessageRow {
  return {
    agentId: 'a1',
    sessionId: 's1',
    msgKey,
    role: 'user',
    ts: '2026-09-10T00:00:00.000Z',
    kind: 'text',
    text: '',
    payloadJson: null,
    ...over,
  };
}

test('映射：user→out 气泡；assistant→markdown 正文；reasoningContent 拆思考行前置', () => {
  const out = rowsToChatMessages([
    mrow('user:t0', { role: 'user', text: '问' }),
    mrow('assistant:t1', {
      role: 'assistant',
      text: '答',
      payloadJson: JSON.stringify({ reasoningContent: '想了下', thinkingDurationMs: 100 }),
    }),
  ]);
  expect(out.map((m) => m.id)).toEqual(['user:t0', 'assistant:t1#think', 'assistant:t1']);
  expect(out[0]).toMatchObject({ dir: 'out', text: '问' });
  expect(out[1]).toMatchObject({ kind: 'reasoning', text: '想了下', streaming: false });
  expect(out[2]).toMatchObject({ dir: 'in', kind: 'final', text: '答' });
});

test('file.*：media 行带 refs → 登记表联查出缩略图/芯片条目；图片无副本 localUri=null；无 refs 照旧占位', () => {
  const sentByRef = new Map<string, { kind: string; localUri: string }>([
    ['f1', { kind: 'image', localUri: 'file:///app/att/f1.jpg' }],
    ['f2', { kind: 'file', localUri: 'file:///app/att/f2.pdf' }],
    // f3：图片但登记表缺失（换机/清数据）→ localUri null（渲染层降级占位）
  ]);
  const out = rowsToChatMessages(
    [
      mrow('user:m1', {
        kind: 'media',
        text: '请在桌面查看',
        refsJson: JSON.stringify([
          { ref: 'f1', name: 'photo.jpg', mime: 'image/jpeg' },
          { ref: 'f2', name: 'report.pdf', mime: 'application/pdf' },
          { ref: 'f3', name: 'old.png', mime: 'image/png' },
        ]),
      }),
      mrow('user:m2', { kind: 'media', text: '请在桌面查看' }),
    ],
    sentByRef,
  );
  expect(out[0]!.media).toBeTruthy();
  expect(out[0]!.media!.items).toEqual([
    { ref: 'f1', name: 'photo.jpg', mime: 'image/jpeg', kind: 'image', localUri: 'file:///app/att/f1.jpg' },
    { ref: 'f2', name: 'report.pdf', mime: 'application/pdf', kind: 'file', localUri: 'file:///app/att/f2.pdf' },
    { ref: 'f3', name: 'old.png', mime: 'image/png', kind: 'file', localUri: null },
  ]);
  // 无 refs（桌面侧媒体）：占位行照旧（media payload 缺失）
  expect(out[1]).toMatchObject({ kind: 'media', text: '🖼 请在桌面查看' });
  expect(out[1]!.media).toBeUndefined();
});

test('映射：tool→工具行（名+状态+结果预览）；notice→提示行；media→占位；truncated→截断标注', () => {
  const out = rowsToChatMessages([
    mrow('tool:call-1', {
      role: 'tool',
      kind: 'tool',
      text: '结果预览文本',
      payloadJson: JSON.stringify({ toolName: 'read_file', toolStatus: 'success' }),
    }),
    mrow('user:t2', { kind: 'notice', text: '[定时任务] 已触发' }),
    mrow('user:t3', { kind: 'media', text: '请在桌面查看' }),
    mrow('assistant:t4', { role: 'assistant', text: '半截', payloadJson: JSON.stringify({ truncated: true }) }),
  ]);
  expect(out[0]!.kind).toBe('status');
  expect(out[0]!.text).toBe('read_file 完成');
  expect(out[0]!.toolDetail).toMatchObject({ name: 'read_file', status: 'success', resultPreview: '结果预览文本' });
  expect(out[1]).toMatchObject({ kind: 'notice', text: '[定时任务] 已触发' });
  expect(out[2]).toMatchObject({ kind: 'media', text: '🖼 请在桌面查看' });
  expect(out[3]!.text).toContain('已截断');
});

test('映射：payloadJson 损坏按无载荷渲染（不炸）；tool 无名字段退化为原文行', () => {
  const out = rowsToChatMessages([
    mrow('assistant:t0', { role: 'assistant', text: '正文', payloadJson: '{坏' }),
    mrow('tool:call-x', { role: 'tool', kind: 'tool', text: '原始结果', payloadJson: '{}' }),
  ]);
  expect(out[0]).toMatchObject({ kind: 'final', text: '正文' });
  expect(out[1]).toMatchObject({ kind: 'status', text: '原始结果' });
});


// ---------- M6b：默认聊天屏路由决策 ----------

test('M6b 路由决策：入口记忆有效 → 该会话；null/悬空 → new（新会话界面）', () => {
  const known = new Set(['s1', 's2']);
  expect(resolveDefaultChatTarget('s1', known)).toBe('s1');
  expect(resolveDefaultChatTarget(null, known)).toBe('new'); // 从未聊过
  expect(resolveDefaultChatTarget('s-deleted', known)).toBe('new'); // 悬空（桌面已删）
  expect(resolveDefaultChatTarget('s1', new Set())).toBe('new'); // 目录空（吊销重配后）
});


// ---------- M6b 修复：双源归并（卡片钉位不沉底） ----------

function msg(id: string, ts: number, kind = 'final'): ChatMessage {
  return { id, dir: 'in', text: id, kind, ts };
}

test('mergeLiveOverlay：审批卡按 ts 钉在到达时刻位置——后续落库消息排在它下方（不沉底）', () => {
  const T0 = 1000;
  // DB 基底：三条历史（t0/t2/t4，含卡片到达后尾部拉齐落库的新消息 t4）
  const db = [msg('user:t0', T0), msg('assistant:t2', T0 + 2000), msg('assistant:t4', T0 + 4000)];
  // overlay：卡片在 t1 到达（介于 t0 与 t2 之间）+ 当前活轮的流式卡 t5
  const overlay = [msg('approval-tc1', T0 + 1000, 'approval'), msg('stream-anchor-0', T0 + 5000, 'delta')];
  const merged = mergeLiveOverlay(db, overlay);
  expect(merged.map((m) => m.id)).toEqual([
    'user:t0',
    'approval-tc1', // 钉在 t1 位置（t0 之后、t2 之前）
    'assistant:t2',
    'assistant:t4',
    'stream-anchor-0', // 活轮流式卡在最后
  ]);
});

test('mergeLiveOverlay：空 overlay 原样返回（零开销直通）；同 ts 稳定序 DB 行在前', () => {
  const db = [msg('a', 100), msg('b', 200)];
  expect(mergeLiveOverlay(db, [])).toBe(db);
  const merged = mergeLiveOverlay([msg('a', 100)], [msg('card', 100)]);
  expect(merged.map((m) => m.id)).toEqual(['a', 'card']); // 同 ts：DB 行在前（concat 序 + 稳定排序）
});

// ---------- ②A（2026-10-06）：文件卡活卡优先——事件驱动活真相胜过 DB 底座快照 ----------

function fileMsg(id: string, ts: number, state: string): ChatMessage {
  return { id, dir: 'in', text: '', kind: 'fileOffer', ts, fileCard: { fileId: id.slice(5), sessionId: 's1', name: 'a.bin', mime: '', size: 1, state } as never };
}

test('mergeLiveOverlay：文件卡同 id 活卡胜出（DB 旧态快照让位）——治"接收成功仍显示接收，重载才变打开"', () => {
  const db = [msg('user:t0', 1000), fileMsg('file-f1', 1500, 'offered'), msg('assistant:t2', 2000)];
  // reloadDb 装入 offered 快照后，fileState(done) 只更新了 overlay 活卡（含 contentUri）
  const overlay = [fileMsg('file-f1', 1500, 'done')];
  const merged = mergeLiveOverlay(db, overlay);
  const cards = merged.filter((m) => m.id === 'file-f1');
  expect(cards.length).toBe(1); // 不双份
  expect((cards[0]!.fileCard as { state: string }).state).toBe('done'); // 活卡（新态）胜出，非 DB 快照 offered
});

test('mergeLiveOverlay：一般消息同 id 仍 DB 优先（防回归——活卡特例不外溢）', () => {
  const db = [msg('client-x', 1000, 'final')];
  const overlay = [msg('client-x', 1000, 'delta')];
  const merged = mergeLiveOverlay(db, overlay);
  expect(merged.filter((m) => m.id === 'client-x').length).toBe(1);
  expect(merged[0]!.kind).toBe('final'); // DB 版胜出
});

test('mergeLiveOverlay：overlay 无活卡时 DB 文件卡正常渲染（切会话回来 DB 接管）', () => {
  const db = [fileMsg('file-f1', 1500, 'done')];
  const overlay = [msg('stream-anchor-0', 5000, 'delta')];
  const merged = mergeLiveOverlay(db, overlay);
  expect(merged.filter((m) => m.id === 'file-f1').length).toBe(1);
  expect((merged.find((m) => m.id === 'file-f1')!.fileCard as { state: string }).state).toBe('done');
});

// ---------- M7：看板行/strip/needsYou 映射（零判定渲染） ----------
// ---------- M7：看板行/strip/needsYou 映射（零判定渲染） ----------

function wireRow(over: Partial<BoardRowWire> = {}): BoardRowWire {
  return {
    itemId: 'b1',
    title: '任务一',
    assignee: 'explore·A',
    status: 'in_progress',
    label: '进行中',
    progressText: '推进中',
    claimedAt: 1_000,
    detail: {},
    ...over,
  };
}

test('M7 行映射：状态点六态直用（待认领/需拍板同琥珀空心、待裁决玫瑰、已交付✓、已取消灰）', () => {
  const now = Date.now();
  const dot = (status: BoardRowWire['status'], over: Partial<BoardRowWire> = {}) =>
    boardRowView(wireRow({ status, ...over }), now).dotKind;
  expect(dot('pending')).toBe('todo');
  expect(dot('blocked')).toBe('todo');
  expect(dot('failed')).toBe('dead');
  expect(dot('in_progress')).toBe('doing');
  expect(dot('completed')).toBe('done');
  expect(dot('cancelled')).toBe('cancel');
});

test('M7 徽章：信号态用协议 label（琥珀/玫瑰）；有主行用工位名（explore 靛蓝/coder 青绿）；终态绿灰', () => {
  const now = Date.now();
  const v1 = boardRowView(wireRow({ status: 'pending', assignee: null, label: '待认领' }), now);
  expect(v1.badge).toEqual({ text: '待认领', color: 'amber' });
  const v2 = boardRowView(wireRow({ status: 'blocked', assignee: 'explore·A', label: '需拍板' }), now);
  expect(v2.badge).toEqual({ text: '需拍板', color: 'amber' });
  const v3 = boardRowView(wireRow({ status: 'failed', assignee: 'explore·A', label: '待裁决' }), now);
  expect(v3.badge).toEqual({ text: '待裁决', color: 'rose' });
  const v4 = boardRowView(wireRow({ assignee: 'explore·A' }), now);
  expect(v4.badge).toEqual({ text: 'explore·A', color: 'indigo' });
  const v5 = boardRowView(wireRow({ assignee: 'coder·C' }), now);
  expect(v5.badge).toEqual({ text: 'coder·C', color: 'teal' });
  const v6 = boardRowView(wireRow({ status: 'completed', assignee: 'explore·A', label: '已交付' }), now);
  expect(v6.badge).toEqual({ text: 'explore·A', color: 'muted' });
  // 无主无信号态（防御）：无徽章
  expect(boardRowView(wireRow({ status: 'in_progress', assignee: null }), now).badge).toBeNull();
});

test('M7 右侧：进行中计时走字（claimedAt→mm:ss 展示拼装）；已交付/已取消显终态词', () => {
  const now = 1_000 + 65_000;
  const v1 = boardRowView(wireRow({ claimedAt: 1_000 }), now);
  expect(v1.right).toEqual({ text: '01:05', mono: true });
  // 负时长钳 0（迟到/乱序帧不显示负数）
  expect(boardRowView(wireRow({ claimedAt: now + 5_000 }), now).right).toEqual({ text: '00:00', mono: true });
  const v2 = boardRowView(wireRow({ status: 'completed', label: '已交付' }), now);
  expect(v2.right).toEqual({ text: '已交付', mono: false });
  const v3 = boardRowView(wireRow({ status: 'cancelled', assignee: null, label: '已取消' }), now);
  expect(v3.right).toEqual({ text: '已取消', mono: false });
  // 待认领/需拍板/待裁决无右侧（徽章已在说话）
  expect(boardRowView(wireRow({ status: 'pending', assignee: null }), now).right).toBeNull();
  expect(boardRowView(wireRow({ status: 'failed' }), now).right).toBeNull();
});

test('M7 进展行纯文本边界：progressText 原样直渲染（不解析、不承载样式），第二行终态隐藏', () => {
  const now = Date.now();
  const v = boardRowView(wireRow({ progressText: '**加粗** <b>标签</b> [链接](x)' }), now);
  expect(v.note).toBe('**加粗** <b>标签</b> [链接](x)'); // 原样字符串，解析发生在别处（本函数零转换）
  expect(boardRowView(wireRow({ progressText: null }), now).note).toBeNull();
  // done/cancel 由视图层隐藏（映射仍保留原文供 detail 用）
  expect(boardRowView(wireRow({ status: 'completed', progressText: '旧进展' }), now).note).toBe('旧进展');
});

test('M7 strip 映射：running=「子任务执行中 · countText」/ settled=「✓ settleText」；无板/板空不显示', () => {
  expect(boardStripView({ status: 'running', countText: '1/3', needsYou: true }, 3)).toEqual({
    visible: true,
    done: false,
    text: '子任务执行中 · 1/3',
  });
  expect(boardStripView({ status: 'settled', countText: '3/3', settleText: '3 个子任务完成', needsYou: false }, 3)).toEqual({
    visible: true,
    done: true,
    text: '✓ 3 个子任务完成',
  });
  expect(boardStripView({ status: 'settled', countText: '2/3', settleText: '结清 · 2 完成 1 归档', needsYou: false }, 3).text).toBe(
    '✓ 结清 · 2 完成 1 归档',
  );
  // 会话无板（strip 空）/板空（0 行）= 不显示长条
  expect(boardStripView(null, 3).visible).toBe(false);
  expect(boardStripView({ status: 'running', countText: '0/0', needsYou: false }, 0).visible).toBe(false);
});

test('M7 要你信号：strip.needsYou / needsYou.needed 皆协议字段直读，不自算', () => {
  expect(boardNeedsYouOn({ status: 'running', countText: '0/1', needsYou: true }, { needed: false, count: 0 })).toBe(true);
  expect(boardNeedsYouOn({ status: 'running', countText: '0/1', needsYou: false }, { needed: true, count: 2 })).toBe(true);
  expect(boardNeedsYouOn({ status: 'running', countText: '0/1', needsYou: false }, { needed: false, count: 0 })).toBe(false);
  expect(boardNeedsYouOn(null, null)).toBe(false);
});

// ---------- V2：feed 事实拼装 + 五态展开模型 ----------

function fact(over: Partial<FeedSubagentBody> = {}): FeedSubagentBody {
  return { toolCallId: 'tc-f1', toolName: 'read_file', kind: 'builtin', argsSummary: 'a', status: 'success', at: 1, taskId: 'tc-task', durationMs: 400, ...over };
}

test('V2 事实兜底拼装：progressText 空缺时降级最近工具事实（read_file · 0.4s 式,纯拼装）', () => {
  expect(feedFactFallback('有进展', [fact()])).toBe('有进展'); // 有 note 不动
  expect(feedFactFallback(null, [fact()])).toBe('read_file · 完成 · 0.4s');
  expect(feedFactFallback('', [fact({ toolName: 'web_search', status: 'running' })])).toBe('web_search · 执行中');
  expect(feedFactFallback(null, [])).toBeNull(); // 无事实无 note → null（壳不显示第二行）
});

test('V2 工具细节行：最近 3 次 + running 脉冲标记 + 耗时拼装', () => {
  const facts = [
    fact({ toolCallId: 'c', at: 3, toolName: 'grep', status: 'failed', durationMs: 120 }),
    fact({ toolCallId: 'b', at: 2, toolName: 'web_search', status: 'running' }),
    fact({ toolCallId: 'a', at: 1, toolName: 'read_file', status: 'success', durationMs: 400 }),
    fact({ toolCallId: 'z', at: 0, toolName: 'old', status: 'success' }),
  ];
  const rows = feedToolDetailRows(facts, 3);
  expect(rows.map((r) => r.toolCallId)).toEqual(['c', 'b', 'a']); // 最新在前,截 3 条
  expect(rows[0]!.text).toBe('grep · 失败 · 0.1s');
  expect(rows[1]!.text).toBe('web_search · 执行中');
  expect(rows[1]!.running).toBe(true);
  expect(rows[2]!.running).toBe(false);
});

test('V2 五态展开内容映射（纯渲染零判定）', () => {
  const hist = [
    { by: 'system', reason: '交付失败(第 1 次),条目自动回流认领池', at: 1 },
    { by: 'w1', reason: '需要专门领域知识', at: 2 },
  ];
  // 进行中 → 工具细节（feed 最近 3 次）
  const doing = boardRowExpandModel({ status: 'in_progress' }, [fact()]);
  expect(doing.kind).toBe('tools');
  expect(doing.title).toBe('工具细节');
  expect(doing.facts.length).toBe(1);
  // 完成 → 查看完整结果（detail.result 全文）
  const done = boardRowExpandModel({ status: 'completed', detail: { result: '全文结果' } }, []);
  expect(done).toMatchObject({ kind: 'result', title: '查看完整结果', text: '全文结果' });
  // 失败 → 记录明细（用词同投影:system=失败记录/人工=退回记录）
  const failed = boardRowExpandModel({ status: 'failed', detail: { releaseHistory: hist } }, []);
  expect(failed.kind).toBe('history');
  expect(failed.lines).toEqual(['失败记录：交付失败(第 1 次),条目自动回流认领池', '退回记录：w1：需要专门领域知识']);
  // 退回行（pending 带留痕）同记录明细
  const returned = boardRowExpandModel({ status: 'pending', detail: { releaseHistory: [hist[1]!] } }, []);
  expect(returned.kind).toBe('history');
  expect(returned.lines).toEqual(['退回记录：w1：需要专门领域知识']);
  // 需拍板 → 受阻原因
  const blocked = boardRowExpandModel({ status: 'blocked', detail: { blockedReason: '缺 API key' } }, []);
  expect(blocked).toMatchObject({ kind: 'blocked', title: '受阻原因', text: '缺 API key' });
  // 取消 → 撤单说明（留痕 reason）
  const cancelled = boardRowExpandModel({ status: 'cancelled', detail: { releaseHistory: [{ by: 'lead', reason: '用户撤单', at: 3 }] } }, []);
  expect(cancelled).toMatchObject({ kind: 'cancel', title: '撤单说明', text: '用户撤单' });
  // 空历史/未知态 → none
  expect(boardRowExpandModel({ status: 'pending' }, []).kind).toBe('none');
});

// ---------- 统一回声确认退休 ----------

function omsg(id: string, over: Partial<ChatMessage>): ChatMessage {
  return { id, dir: 'in', text: '', kind: 'delta', ts: 1000, ...over };
}

const T0 = Date.parse('2026-09-10T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

test('退休：clientId 精确回声——气泡退休；无回声（页预算截断）→ 保留', () => {
  const echoes = buildEchoSets([mrow('user:t1', { role: 'user', text: '问', clientId: 'env-1' })]);
  const overlay = [omsg('env-1', { dir: 'out', kind: 'chat.user', text: '问', ts: T0 }), omsg('env-2', { dir: 'out', kind: 'chat.user', text: '长轮', ts: T0 + 1 })];
  const out = retireConfirmedOverlay(overlay, echoes);
  expect(out.map((m) => m.id)).toEqual(['env-2']); // env-1 回声命中退休；env-2 无回声保留（核心回归：长轮截断不消失）
});

test('退休：legacy 兼容路径——文本+时间下界；同文旧行被下界排除', () => {
  // 旧行（ts 早于气泡 1 小时）与气泡同文 → 不作回声
  const echoes = buildEchoSets([mrow('user:t0', { role: 'user', text: '好的', ts: iso(T0 - 3600_000) })]);
  const bubble = omsg('env-3', { dir: 'out', kind: 'chat.user', text: '好的', ts: T0 });
  expect(retireConfirmedOverlay([bubble], echoes)).toHaveLength(1);
  // 新行（ts 晚于气泡=桌面收录）→ 回声命中退休
  const echoes2 = buildEchoSets([mrow('user:t9', { role: 'user', text: '好的', ts: iso(T0 + 2000) })]);
  expect(retireConfirmedOverlay([bubble], echoes2)).toHaveLength(0);
});

test('退休：media 气泡 legacy 按附件 ref 匹配（行 text 是占位符，文本匹配必败）', () => {
  const echoes = buildEchoSets([
    mrow('user:t1', { role: 'user', kind: 'media', text: '[媒体]', ts: iso(T0 + 1000), refsJson: JSON.stringify([{ ref: 'f1', name: 'a.jpg', mime: 'image/jpeg' }]) }),
  ]);
  const bubble = omsg('env-4', { dir: 'out', kind: 'media', text: '看图', ts: T0, media: { items: [{ ref: 'f1', name: 'a.jpg', mime: 'image/jpeg', kind: 'image', localUri: null }] } });
  expect(retireConfirmedOverlay([bubble], echoes)).toHaveLength(0);
});

test('退休：stream 卡内容回声（相等）；truncated 前缀命中；无回声保留', () => {
  const echoes = buildEchoSets([
    mrow('assistant:t1', { role: 'assistant', text: '完整回答' }),
    mrow('assistant:t2', { role: 'assistant', text: '被截断的前半', payloadJson: JSON.stringify({ truncated: true }) }),
  ]);
  const overlay = [
    omsg('stream-a-0', { text: '完整回答' }),
    omsg('stream-a-1', { text: '被截断的前半还有更多' }),
    omsg('stream-a-2', { text: '没进窗口的节拍' }),
  ];
  const out = retireConfirmedOverlay(overlay, echoes);
  expect(out.map((m) => m.id)).toEqual(['stream-a-2']);
});

test('退休：think 卡——reasoningContent 内容回声；同节拍 stream 卡退休随行', () => {
  const echoes = buildEchoSets([
    mrow('assistant:t1', { role: 'assistant', text: '答', payloadJson: JSON.stringify({ reasoningContent: '想了下' }) }),
    mrow('assistant:t2', { role: 'assistant', text: '第二拍正文' }),
  ]);
  const overlay = [
    omsg('think-a-0', { kind: 'reasoning', text: '想了下' }),
    omsg('think-b-0', { kind: 'reasoning', text: '第二拍思考（无独立回声）' }),
    omsg('stream-b-0', { text: '第二拍正文' }),
  ];
  const out = retireConfirmedOverlay(overlay, echoes);
  expect(out).toHaveLength(0); // think-a 内容回声；stream-b 回声退休 → think-b 随行
});

test('退休：拒绝型 notice（roundStarted=false）→ 气泡立即退休，notice 保留；中止 notice（true）→ 仅最高节拍卡退休、气泡继续等回声', () => {
  // 拒绝：零活动
  const rej = retireConfirmedOverlay(
    [
      omsg('env-5', { dir: 'out', kind: 'chat.user', text: '新会话', ts: T0 }),
      omsg('stream-env-5-0', { kind: 'notice', text: '新建被守卫拒绝', ts: T0 + 1, roundStarted: false }),
    ],
    emptyEchoSets(),
  );
  expect(rej.map((m) => m.id)).toEqual(['stream-env-5-0']); // 气泡退（无收录无回声可等）；提示保留
  // 中止：两节拍 + 中止 notice → 最高节拍（半截）退，已完成节拍与气泡等回声
  const ab = retireConfirmedOverlay(
    [
      omsg('env-6', { dir: 'out', kind: 'chat.user', text: '干活', ts: T0 }),
      omsg('stream-env-6-0', { text: '第一拍（已落盘）', ts: T0 + 1 }),
      omsg('stream-env-6-1', { text: '第二拍半截', ts: T0 + 2 }),
      omsg('stream-env-6-1', { kind: 'notice', text: '已中断', ts: T0 + 3, roundStarted: true }),
    ],
    emptyEchoSets(),
  );
  expect(ab.map((m) => `${m.kind}:${m.text}`)).toEqual(['chat.user:干活', 'delta:第一拍（已落盘）', 'notice:已中断']);
});

test('退休：status 工具行 toolCallId 核对（现状规则收纳）；approval 卡保留', () => {
  const echoes = buildEchoSets([mrow('tool:c1', { role: 'tool', kind: 'tool', text: '结果' })]);
  const overlay = [
    omsg('tool-c1', { kind: 'status', text: 'read_file 完成' }),
    omsg('tool-c2', { kind: 'status', text: 'write 执行中' }),
    omsg('ap-1', { kind: 'approval', text: '审批' }),
  ];
  const out = retireConfirmedOverlay(overlay, echoes);
  expect(out.map((m) => m.id)).toEqual(['tool-c2', 'ap-1']);
});

test('退休：消耗式匹配——两条同文节拍共享一份回声时只退一张（页预算截断边）', () => {
  const echoes = buildEchoSets([mrow('assistant:t1', { role: 'assistant', text: '同文' })]);
  const overlay = [omsg('stream-a-0', { text: '同文', ts: T0 }), omsg('stream-a-1', { text: '同文', ts: T0 + 1 })];
  const out = retireConfirmedOverlay(overlay, echoes);
  expect(out).toHaveLength(1); // 一份回声只接管一张（按 ts 序消耗），另一张继续显示
  expect(out[0]!.id).toBe('stream-a-1');
});

test('退休：notice 卡 roundFailure 回流行内容回声接管；无回声的守卫提示保留', () => {
  const echoes = buildEchoSets([mrow('assistant:t9', { role: 'assistant', kind: 'notice', text: '轮次失败：超时' })]);
  const overlay = [
    omsg('stream-a-0', { kind: 'notice', text: '轮次失败：超时' }),
    omsg('stream-b-0', { kind: 'notice', text: '新建被守卫拒绝', roundStarted: false }),
  ];
  const out = retireConfirmedOverlay(overlay, echoes);
  expect(out.map((m) => m.text)).toEqual(['新建被守卫拒绝']);
});

test('回声集：buildEchoSets 解析 payloadJson（reasoningContent/truncated）；mergeEchoSets 并集计数', () => {
  const a = buildEchoSets([mrow('assistant:t1', { role: 'assistant', text: '答', payloadJson: JSON.stringify({ reasoningContent: '想' }) })]);
  expect(a.dbContentTexts.get('答')).toBe(1);
  expect(a.dbContentTexts.get('想')).toBe(1);
  const b = buildEchoSets([
    mrow('assistant:t2', { role: 'assistant', text: '答', payloadJson: JSON.stringify({ truncated: true }) }),
  ]);
  expect(b.dbTruncatedPrefixes.get('答')).toBe(1);
  expect(b.dbContentTexts.get('答')).toBeUndefined(); // truncated 行进前缀池而非等值池
  const merged = mergeEchoSets(a, b);
  expect(merged.dbContentTexts.get('答')).toBe(1);
  expect(merged.dbTruncatedPrefixes.get('答')).toBe(1);
  expect(merged.dbContentTexts.get('想')).toBe(1);
});

// ---------- 快照退休（按钮卡停止修复 v3：retireWithSnapshot——整组替换纪律的行为级验证） ----------

test('快照退休：同一行集两次到达（整组替换语义）——第二次零重复退休、幂等', () => {
  const rows = [
    mrow('assistant:t1', { role: 'assistant', text: '答一' }),
    mrow('assistant:t2', { role: 'assistant', text: '答二' }),
  ];
  const overlay = [omsg('stream-a-0', { text: '答一' }), omsg('stream-a-1', { text: '答二' })];
  const r1 = retireWithSnapshot(overlay, rows);
  expect(r1.retired).toBe(true);
  expect(r1.next).toHaveLength(0);
  // 第二次同 rows 到达 = 新快照替换旧快照：对已退休 overlay 无动作（幂等），不产生计数虚高误退休
  const r2 = retireWithSnapshot(r1.next, rows);
  expect(r2.retired).toBe(false);
  expect(r2.next).toHaveLength(0);
});

test('快照退休：固定文案同文两卡 + 一条 DB 行 → 只退休一张（计数与行 1:1，同文卡不误退休）', () => {
  const rows = [mrow('assistant:t1', { role: 'assistant', kind: 'notice', text: '轮次失败：超时' })];
  const overlay = [
    omsg('stream-a-0', { kind: 'notice', text: '轮次失败：超时', ts: T0 }),
    omsg('stream-b-0', { kind: 'notice', text: '轮次失败：超时', ts: T0 + 1 }),
  ];
  const r = retireWithSnapshot(overlay, rows);
  expect(r.retired).toBe(true);
  expect(r.next.map((m) => m.id)).toEqual(['stream-b-0']);
});

test('快照退休：对照验证——对同一页 mergeEchoSets 累积会虚计，快照替换恒 1:1（铁律的行为证据）', () => {
  const page = [mrow('assistant:t1', { role: 'assistant', text: '同文' })];
  // 错误形态（对滑动最新页二次 merge 累积）：计数 2 → 两张同文卡都被退休（内容闪失）——禁令的根因
  const wrongMerged = mergeEchoSets(buildEchoSets(page), buildEchoSets(page));
  expect(wrongMerged.dbContentTexts.get('同文')).toBe(2);
  // 正确形态（整组替换/独立快照）：两次到达各自独立 1:1 → 第二张卡保留
  const overlay = [omsg('stream-a-0', { text: '同文', ts: T0 }), omsg('stream-a-1', { text: '同文', ts: T0 + 1 })];
  const r = retireWithSnapshot(overlay, page);
  expect(r.next).toHaveLength(1);
  expect(r.next[0]!.id).toBe('stream-a-1');
});

test('快照退休：长轮多页拼接行集——全轮一次快照，前段节拍卡同样退休（单页截断残口不复发）', () => {
  const rows: MessageRow[] = [];
  const overlay: ChatMessage[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push(mrow(`assistant:p${i}`, { role: 'assistant', text: `第${i}拍正文` }));
    overlay.push(omsg(`stream-long-${i}`, { text: `第${i}拍正文`, ts: T0 + i }));
  }
  const r = retireWithSnapshot(overlay, rows);
  expect(r.retired).toBe(true);
  expect(r.next).toHaveLength(0);
});

test('快照退休：无回声（overlay 卡无 DB 对应物）→ retired=false（渲染收口 flag 不误置）', () => {
  const rows = [mrow('assistant:t1', { role: 'assistant', text: '别的轮次' })];
  const overlay = [omsg('stream-a-0', { text: '顽固不匹配卡' })];
  const r = retireWithSnapshot(overlay, rows);
  expect(r.retired).toBe(false);
  expect(r.next).toHaveLength(1);
});

test('映射（双保险）：零载荷 assistant 行（空正文/无思考）不产出渲染项；user 行 id 优先 clientId', () => {
  const out = rowsToChatMessages([
    mrow('assistant:t0', { role: 'assistant', text: '' }),
    mrow('assistant:t1', { role: 'assistant', text: '', payloadJson: JSON.stringify({ reasoningContent: '有思考' }) }),
    mrow('user:t2', { role: 'user', text: '问', clientId: 'env-9' }),
  ]);
  expect(out.map((m) => m.id)).toEqual(['assistant:t1#think', 'assistant:t1', 'env-9']);
});

// ---------- 会话行手势判定（会话管理） ----------

test('水平接管：水平明显占优且过 tap 上限才接管；垂直占优/微小位移不接管', () => {
  expect(shouldClaimHorizontal(20, 4)).toBe(true); // 水平占优
  expect(shouldClaimHorizontal(-20, 4)).toBe(true); // 右滑同效
  expect(shouldClaimHorizontal(12, 10)).toBe(false); // 1.2x 不足 1.5x
  expect(shouldClaimHorizontal(6, 2)).toBe(false); // 未过 tap 上限
  expect(shouldClaimHorizontal(3, 15)).toBe(false); // 垂直占优留给滚动
});

test('release 分派：双轴微动=tap；closed 过阈值=open（左右滑同效）；open 右滑过阈值=close；其余=snap', () => {
  expect(resolveSwipeRelease(3, 5, false)).toBe('tap');
  expect(resolveSwipeRelease(SWIPE_TAP_MAX_PX - 1, 0, true)).toBe('tap'); // open 态 tap=收回
  expect(resolveSwipeRelease(SWIPE_OPEN_THRESHOLD_PX, 0, false)).toBe('open');
  expect(resolveSwipeRelease(-SWIPE_OPEN_THRESHOLD_PX - 10, 4, false)).toBe('open'); // 右滑也开
  expect(resolveSwipeRelease(SWIPE_OPEN_THRESHOLD_PX, 2, true)).toBe('close'); // 展开态右滑收回
  expect(resolveSwipeRelease(20, 2, false)).toBe('snap'); // 未过阈值弹回
  expect(resolveSwipeRelease(-60, 2, true)).toBe('snap'); // 展开态继续左滑保持
  expect(resolveSwipeRelease(20, 2, true)).toBe('snap'); // 展开态右滑未过阈值保持
});

test('删除两步状态机：closed→open→confirming→submitting→closed；submitting 不吃 dismiss', () => {
  expect(nextManageState('closed', 'swipeOpen')).toBe('open');
  expect(nextManageState('closed', 'tapDelete')).toBe('closed'); // 未滑开不可删
  expect(nextManageState('open', 'tapDelete')).toBe('confirming');
  expect(nextManageState('open', 'dismiss')).toBe('closed');
  expect(nextManageState('confirming', 'tapConfirm')).toBe('submitting');
  expect(nextManageState('confirming', 'dismiss')).toBe('closed');
  expect(nextManageState('confirming', 'tapDelete')).toBe('confirming'); // 重复点不推进
  expect(nextManageState('submitting', 'dismiss')).toBe('submitting'); // 执行中不可误触
  expect(nextManageState('submitting', 'settled')).toBe('closed');
  expect(nextManageState('submitting', 'failed')).toBe('closed');
});

test('重命名提交门：空白=invalid；trim 后同原标题=unchanged；其余=submit', () => {
  expect(resolveRenameSubmit('', '旧')).toBe('invalid');
  expect(resolveRenameSubmit('   ', '旧')).toBe('invalid');
  expect(resolveRenameSubmit('  旧  ', '旧')).toBe('unchanged');
  expect(resolveRenameSubmit('新标题', '旧')).toBe('submit');
});

// ---------- fileCardPhase：d→m 文件卡相位推导（推导，不发信号） ----------

describe('fileCardPhase', () => {
  const base = { fileId: 'f1', sessionId: 's1', name: 'a.pptx', mime: 'application/x', size: 1000, expiresAt: null };
  const NOW = 1_000_000;

  test('offered 无 lastProgress → offered', () => {
    expect(fileCardPhase({ ...base, state: 'offered' }, NOW)).toEqual({ kind: 'offered' });
  });

  test('offered + lastProgress → paused（断点可见）', () => {
    expect(fileCardPhase({ ...base, state: 'offered', lastProgress: { received: 320, total: 1000 } }, NOW)).toEqual({
      kind: 'paused', received: 320, total: 1000, pct: 32,
    });
  });

  test('过期优先级最高：offered+lastProgress 但 expiresAt 已过 → expired（非暂停条）', () => {
    expect(
      fileCardPhase({ ...base, state: 'offered', expiresAt: NOW - 1, lastProgress: { received: 320, total: 1000 } }, NOW),
    ).toEqual({ kind: 'expired' });
    expect(fileCardPhase({ ...base, state: 'expired' }, NOW)).toEqual({ kind: 'expired' });
  });

  test('pulling 无 progress → preparing（准备中）', () => {
    expect(fileCardPhase({ ...base, state: 'pulling' }, NOW)).toEqual({ kind: 'preparing' });
  });

  test('pulling received<total → downloading（确定进度）', () => {
    expect(fileCardPhase({ ...base, state: 'pulling', progress: { received: 500, total: 1000 } }, NOW)).toEqual({
      kind: 'downloading', received: 500, total: 1000, pct: 50,
    });
  });

  test('pulling received==total → verifying（校验落盘窗口：推导而非事件）', () => {
    expect(fileCardPhase({ ...base, state: 'pulling', progress: { received: 1000, total: 1000 } }, NOW)).toEqual({
      kind: 'verifying',
    });
  });

  test('done / failed（error 透传与缺省）', () => {
    expect(fileCardPhase({ ...base, state: 'done' }, NOW)).toEqual({ kind: 'done' });
    expect(fileCardPhase({ ...base, state: 'failed', error: '网络中断' }, NOW)).toEqual({ kind: 'failed', error: '网络中断' });
    expect(fileCardPhase({ ...base, state: 'failed' }, NOW)).toEqual({ kind: 'failed' });
  });
});

// ---------- 浮层手风琴：裁决卡二态 + 召唤展开信号（2026-10-04） ----------

describe('nextFloatingCardPhases 裁决卡二态', () => {
  const NOW = 1_000_000;

  test('到达一律隐匿：新到场（不在 prev）→ parked（冷启动重放/重连重推/首达都不打扰）', () => {
    const r = nextFloatingCardPhases({ courtCardIds: ['ask-1'], prev: {}, expandSignalAt: null, now: NOW });
    expect(r.phases).toEqual({ 'ask-1': 'parked' });
    expect(r.signalLive).toBe(false);
  });

  test('召唤是展开的唯一来源：parked 卡 + 新鲜信号 → expanded（信号消费，signalLive=false）', () => {
    const r = nextFloatingCardPhases({
      courtCardIds: ['ask-1'],
      prev: { 'ask-1': 'parked' },
      expandSignalAt: NOW - 1000,
      now: NOW,
    });
    expect(r.phases).toEqual({ 'ask-1': 'expanded' });
    expect(r.signalLive).toBe(false);
  });

  test('无信号的快照重算不掀开 parked 卡（收起状态跨重算保持）', () => {
    const r = nextFloatingCardPhases({
      courtCardIds: ['ask-1'],
      prev: { 'ask-1': 'parked' },
      expandSignalAt: null,
      now: NOW,
    });
    expect(r.phases).toEqual({ 'ask-1': 'parked' });
  });

  test('信号武装：信号新鲜但暂无裁决卡 → signalLive=true（等卡到达）', () => {
    const r = nextFloatingCardPhases({ courtCardIds: [], prev: {}, expandSignalAt: NOW - 1000, now: NOW });
    expect(r.phases).toEqual({});
    expect(r.signalLive).toBe(true);
  });

  test('信号过期弃置：不影响既有阶段、不再武装', () => {
    const r = nextFloatingCardPhases({
      courtCardIds: ['ask-1'],
      prev: { 'ask-1': 'parked' },
      expandSignalAt: NOW - EXPAND_SIGNAL_TTL_MS - 1,
      now: NOW,
    });
    expect(r.phases).toEqual({ 'ask-1': 'parked' });
    expect(r.signalLive).toBe(false);
  });

  test('落定离场：卡集收缩后阶段表不再保留其条目', () => {
    const r = nextFloatingCardPhases({
      courtCardIds: [],
      prev: { 'ask-gone': 'expanded' },
      expandSignalAt: null,
      now: NOW,
    });
    expect(r.phases).toEqual({});
  });
});
