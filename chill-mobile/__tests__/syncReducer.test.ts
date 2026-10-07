/**
 * syncReducer 单测（M6 类四）：catalog/history/session.event 落库逻辑。
 * SyncDb 边界用内存 fake（语义对齐 syncDb 实现：INSERT OR REPLACE 幂等 + updatedAt 后写胜出 + 悬空归一化）；
 * SQL 正确性由真机构建（类四第 0 步）与类五 e2e 线束兜底。
 */
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
  packCatalogSyncBody,
  packBoardSyncBody,
  packWorkPlanSyncBody,
} from '../src/relay/syncReducer';
import { applySyncDbMigrations } from '../src/db/syncDb';
import type {
  AgentRow,
  BoardItemRow,
  BoardMetaRow,
  MessageRow,
  ProjectRow,
  ReceivedFileRow,
  SentAttachmentRow,
  SessionRow,
  SyncDb,
  SyncStateRow,
  WorkPlanMetaRow,
} from '../src/db/syncDb';
import type { CatalogSessionMeta, CatalogStateBody, SessionEventBody, BoardStateBody, BoardRowWire, WorkPlanStateBody } from '../src/relay/envelope';

/** 内存 fake：实现 SyncDb 全接口（语义与 op-sqlite 实现对齐，含 LWW 与悬空归一化） */
function fakeDb() {
  const agents: AgentRow[] = [];
  const projects = new Map<string, ProjectRow>(); // key = agentId|projectId
  const sessions = new Map<string, SessionRow>(); // key = agentId|sessionId
  const messages = new Map<string, MessageRow>(); // key = agentId|sessionId|msgKey
  const syncStates = new Map<string, SyncStateRow>();
  const boardItems = new Map<string, BoardItemRow>(); // key = agentId|sessionId|itemId
  const boardMeta = new Map<string, BoardMetaRow>(); // key = agentId|sessionId
  const workPlanMeta = new Map<string, WorkPlanMetaRow>(); // v7：key = agentId|sessionId
  const sentAttachments = new Map<string, SentAttachmentRow>(); // v4：file.* 登记表
  const receivedFiles = new Map<string, ReceivedFileRow>(); // v5：d→m 收件登记
  const k2 = (a: string, b: string) => `${a}|${b}`;

  const db: SyncDb = {
    upsertAgent: async (a) => {
      const i = agents.findIndex((x) => x.agentId === a.agentId);
      if (i >= 0) agents[i] = a;
      else agents.push(a);
    },
    replaceProjects: async (agentId, rows) => {
      for (const k of [...projects.keys()]) if (k.startsWith(`${agentId}|`)) projects.delete(k);
      for (const p of rows) projects.set(k2(p.agentId, p.projectId), p);
    },
    upsertSession: async (s) => {
      const k = k2(s.agentId, s.sessionId);
      const cur = sessions.get(k);
      // LWW：updatedAt 后写胜出（对齐 syncDb 的 UPSERT WHERE 守护）
      if (cur && cur.updatedAt > s.updatedAt) return;
      sessions.set(k, s);
    },
    updateSessionTitle: async (agentId, sessionId, title, titleSource) => {
      const cur = sessions.get(k2(agentId, sessionId));
      if (cur) sessions.set(k2(agentId, sessionId), { ...cur, title, titleSource });
    },
    deleteSession: async (agentId, sessionId) => {
      sessions.delete(k2(agentId, sessionId));
      for (const k of [...messages.keys()]) if (k.startsWith(`${agentId}|${sessionId}|`)) messages.delete(k);
      // M7 级联清板（语义与 OpSyncDb.deleteSession 对齐）
      for (const k of [...boardItems.keys()]) if (k.startsWith(`${agentId}|${sessionId}|`)) boardItems.delete(k);
      boardMeta.delete(k2(agentId, sessionId));
      // v7 级联清工作计划树（同上对齐）
      workPlanMeta.delete(k2(agentId, sessionId));
      // v8+ 级联清收件登记（同上对齐：卡片=消息，随会话内容级联消亡）
      for (const [k, r] of [...receivedFiles.entries()]) if (r.sessionId === sessionId) receivedFiles.delete(k);
    },
    getSessionsVersionMap: async (agentId) => {
      const map: Record<string, string> = {};
      for (const s of sessions.values()) if (s.agentId === agentId) map[s.sessionId] = s.updatedAt;
      return map;
    },
    listSessions: async (agentId) => {
      return [...sessions.values()]
        .filter((s) => s.agentId === agentId)
        .map((s) => ({
          ...s,
          // 悬空归一化（双端同一规则的手机侧执行点）
          projectId: s.projectId !== null && projects.has(k2(agentId, s.projectId)) ? s.projectId : null,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    insertMessages: async (rows) => {
      for (const m of rows) messages.set(`${m.agentId}|${m.sessionId}|${m.msgKey}`, m);
    },
    countMessagesByKeys: async (agentId, sessionId, keys) =>
      keys.filter((k) => messages.has(`${agentId}|${sessionId}|${k}`)).length,
    listMessages: async (agentId, sessionId, before, limit = 50) => {
      let rows = [...messages.values()]
        .filter((m) => m.agentId === agentId && m.sessionId === sessionId)
        .sort((a, b) => (a.ts === b.ts ? a.msgKey.localeCompare(b.msgKey) : a.ts.localeCompare(b.ts)));
      if (before !== undefined) {
        const i = rows.findIndex((r) => r.msgKey === before);
        rows = i >= 0 ? rows.slice(0, i) : [];
      }
      return rows.slice(-limit);
    },
    listProjects: async (agentId) => [...projects.values()].filter((p) => p.agentId === agentId),
    clearMessages: async (agentId, sessionId) => {
      for (const k of [...messages.keys()]) if (k.startsWith(`${agentId}|${sessionId}|`)) messages.delete(k);
    },
    getSyncState: async (agentId) => syncStates.get(agentId) ?? null,
    putSyncState: async (st) => {
      syncStates.set(st.agentId, st);
    },
    upsertBoardItems: async (rows) => {
      for (const r of rows) boardItems.set(`${r.agentId}|${r.sessionId}|${r.itemId}`, r);
    },
    replaceBoardItems: async (agentId, sessionId, rows) => {
      for (const k of [...boardItems.keys()]) if (k.startsWith(`${agentId}|${sessionId}|`)) boardItems.delete(k);
      for (const r of rows) boardItems.set(`${r.agentId}|${r.sessionId}|${r.itemId}`, r);
    },
    listBoardItems: async (agentId, sessionId) =>
      [...boardItems.values()]
        .filter((r) => r.agentId === agentId && r.sessionId === sessionId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    clearBoardItems: async (agentId, sessionId) => {
      for (const k of [...boardItems.keys()]) if (k.startsWith(`${agentId}|${sessionId}|`)) boardItems.delete(k);
    },
    getBoardMeta: async (agentId, sessionId) => boardMeta.get(k2(agentId, sessionId)) ?? null,
    putBoardMeta: async (m) => {
      boardMeta.set(k2(m.agentId, m.sessionId), m);
    },
    // v7：工作计划树副本（内存 fake）
    getWorkPlanMeta: async (agentId, sessionId) => workPlanMeta.get(k2(agentId, sessionId)) ?? null,
    setWorkPlanMeta: async (m) => {
      workPlanMeta.set(k2(m.agentId, m.sessionId), m);
    },
    wipeAll: async () => {
      agents.length = 0;
      projects.clear();
      sessions.clear();
      messages.clear();
      syncStates.clear();
      boardItems.clear();
      boardMeta.clear();
      workPlanMeta.clear();
      sentAttachments.clear();
      receivedFiles.clear();
    },
    // v4：file.* 登记表（内存 fake）
    putSentAttachment: async (row) => {
      sentAttachments.set(row.fileId, row);
    },
    getSentAttachment: async (fileId) => sentAttachments.get(fileId) ?? null,
    getSentAttachments: async (fileIds) => fileIds.map((id) => sentAttachments.get(id)).filter((x): x is SentAttachmentRow => x !== undefined),
    // v5：d→m 收件登记（内存 fake；语义与 OpSyncDb 对齐——精确匹配归属/状态跃迁显式交代附属列）
    putReceivedFile: async (row) => {
      receivedFiles.set(row.fileId, row);
    },
    getReceivedFile: async (fileId) => receivedFiles.get(fileId) ?? null,
    updateReceivedFileState: async (fileId, state, extra) => {
      const cur = receivedFiles.get(fileId);
      if (!cur) return;
      receivedFiles.set(fileId, {
        ...cur,
        state,
        stagingPath: extra?.stagingPath ?? null,
        contentUri: extra?.contentUri ?? null,
        error: extra?.error ?? null,
        updatedAt: new Date().toISOString(),
      });
    },
    listReceivedFilesForSession: async (sessionId) =>
      [...receivedFiles.values()]
        .filter((r) => r.sessionId === sessionId) // 精确匹配（语义与 OpSyncDb 对齐——孤儿回退已退役）
        .sort((a, b) => (a.createdAt === b.createdAt ? a.fileId.localeCompare(b.fileId) : a.createdAt.localeCompare(b.createdAt))),
    listPendingReceivedFiles: async () =>
      [...receivedFiles.values()].filter((r) => r.state === 'offered' || r.state === 'pulling'),
    // ②B（v9）：迟到锚定支撑（内存 fake 同语义）
    listUnanchoredReceivedFiles: async (sid: string) =>
      [...receivedFiles.values()].filter((r) => r.sessionId === sid && r.anchorTs === null),
    updateReceivedFileAnchors: async (entries: Array<{ fileId: string; anchorTs: number }>) => {
      for (const e of entries) {
        const cur = receivedFiles.get(e.fileId);
        if (cur) receivedFiles.set(e.fileId, { ...cur, anchorTs: e.anchorTs });
      }
    },
    getSessionLastMessageTs: async (sid: string) => {
      const rows = [...messages.values()].filter((m) => m.sessionId === sid);
      if (rows.length === 0) return null;
      const ts = Math.max(...rows.map((m) => Date.parse(m.ts)));
      return Number.isFinite(ts) ? ts : null;
    },
    listReceivedFileIds: async () =>
      [...receivedFiles.values()]
        .filter((r) => r.state === 'offered' || r.state === 'pulling' || r.state === 'failed') // 非终态行（判主收窄——同 OpSyncDb）
        .map((r) => r.fileId),
    // 阅后即焚（内存 fake 同语义：staticJson 置空串，行保留）
    clearReceivedFileSecret: async (fileId) => {
      const cur = receivedFiles.get(fileId);
      if (cur) receivedFiles.set(fileId, { ...cur, staticJson: '', updatedAt: new Date().toISOString() });
    },
    hasSession: async (agentId, sessionId) => sessions.has(k2(agentId, sessionId)),
    close: () => {},
  };
  return { db, agents, projects, sessions, messages, syncStates, boardItems, boardMeta, workPlanMeta, receivedFiles };
}

const AGENT = 'desk-fingerprint-abc';

function meta(id: string, updatedAt: string, over: Partial<CatalogSessionMeta> = {}): CatalogSessionMeta {
  return {
    id,
    title: `标题${id}`,
    projectId: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt,
    preview: `预览${id}`,
    ...over,
  };
}

function catalogBody(over: Partial<CatalogStateBody>): CatalogStateBody {
  return {
    projects: [],
    sessions: [],
    activeSessionId: null,
    projectsRev: 'rev-1',
    full: false,
    ...over,
  };
}

// ---------- catalog.state 落库 ----------

test('catalog 全量：落库 + 残留行清除 + projectsRev 落定', async () => {
  const { db, sessions, syncStates } = fakeDb();
  // 预置残留行（桌面已不存在的会话）
  await db.upsertSession({ agentId: AGENT, sessionId: 's-stale', projectId: null, title: '残留', titleSource: null, workdir: null, createdAt: '', updatedAt: '2026-09-09T00:00:00.000Z', preview: '' });
  await applyCatalogState(
    db,
    AGENT,
    catalogBody({
      full: true,
      sessions: [meta('s1', '2026-09-10T00:01:00.000Z'), meta('s2', '2026-09-10T00:02:00.000Z', { projectId: 'p1' })],
      projects: [{ id: 'p1', name: '项目一', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', order: 1 }],
      projectsRev: 'rev-2',
    }),
  );
  expect([...sessions.keys()].sort()).toEqual([`${AGENT}|s1`, `${AGENT}|s2`]);
  expect((await db.listSessions(AGENT)).find((s) => s.sessionId === 's2')?.projectId).toBe('p1');
  expect(syncStates.get(AGENT)?.projectsRev).toBe('rev-2');
  expect(syncStates.get(AGENT)?.catalogSyncedAt).toBeTruthy();
});

test('catalog 增量：upsert LWW + deletes 删行（连带消息副本）；projects 未携带不动', async () => {
  const { db, messages, projects } = fakeDb();
  await applyCatalogState(db, AGENT, catalogBody({
    full: true,
    sessions: [meta('s1', '2026-09-10T00:01:00.000Z'), meta('s2', '2026-09-10T00:02:00.000Z')],
    projects: [{ id: 'p1', name: '项目一', createdAt: '', updatedAt: '', order: 1 }],
  }));
  await db.insertMessages([{ agentId: AGENT, sessionId: 's2', msgKey: 'user:t0', role: 'user', ts: '2026-09-10T00:00:00.000Z', kind: 'text', text: 'x', payloadJson: null }]);

  await applyCatalogState(db, AGENT, catalogBody({
    full: false,
    sessions: [
      meta('s1', '2026-09-10T00:03:00.000Z', { preview: '新预览' }), // 更新
      meta('s2', '2026-09-09T00:00:00.000Z', { title: '旧标题覆盖?' }), // 过旧（LWW 拒绝）
      meta('s3', '2026-09-10T00:04:00.000Z'), // 新增
    ],
    deletes: ['s2'],
  }));
  const list = await db.listSessions(AGENT);
  expect(list.map((s) => s.sessionId).sort()).toEqual(['s1', 's3']);
  expect(list.find((s) => s.sessionId === 's1')?.preview).toBe('新预览');
  expect(messages.size).toBe(0); // s2 删除连带消息副本清除
  expect([...projects.keys()]).toEqual([`${AGENT}|p1`]); // projects 未携带（空数组+非 full）→ 项目表不动
});

test('catalog LWW：乱序到达的旧版本行不覆盖新版本', async () => {
  const { db } = fakeDb();
  await applyCatalogState(db, AGENT, catalogBody({ full: true, sessions: [meta('s1', '2026-09-10T00:05:00.000Z', { title: '新版' })] }));
  await applyCatalogState(db, AGENT, catalogBody({ full: false, sessions: [meta('s1', '2026-09-10T00:01:00.000Z', { title: '旧版' })] }));
  const list = await db.listSessions(AGENT);
  expect(list[0]?.title).toBe('新版');
});

test('catalog 悬空归一化：项目被删后，旧 projectId 按未分组呈现（双端同一规则的手机侧执行点）', async () => {
  const { db } = fakeDb();
  await applyCatalogState(db, AGENT, catalogBody({
    full: true,
    sessions: [meta('s1', '2026-09-10T00:01:00.000Z', { projectId: 'p1' })],
    projects: [{ id: 'p1', name: '项目一', createdAt: '', updatedAt: '', order: 1 }],
    projectsRev: 'rev-1',
  }));
  expect((await db.listSessions(AGENT))[0]?.projectId).toBe('p1');
  // 桌面删项目：UI 先逐个清会话 projectId（不动 updatedAt，diff 看不见行变化），
  // 收敛 = projectsRev 变化触发项目整表重发 + 手机渲染侧归一化（projectId 不在已知项目集合 → null）。
  // 此处验证归一化规则本体：项目表被整表替换为空后，旧 projectId 归未分组
  await db.replaceProjects(AGENT, []);
  expect((await db.listSessions(AGENT))[0]?.projectId).toBeNull();
});

// ---------- catalog.state 分片归组 ----------

test('chunk 归组：乱序分片集齐后合并（chunk0 骨架 + sessions 按序拼接）；半截不应用', () => {
  const c = new CatalogChunkCollector();
  const full = catalogBody({ full: true, sessions: [meta('s1', 't'), meta('s2', 't'), meta('s3', 't')] });
  const chunk0: CatalogStateBody = { ...full, sessions: [full.sessions[0]!], chunk: 0, chunks: 3 };
  const chunk1: CatalogStateBody = { ...catalogBody({ projectsRev: 'rev-1' }), sessions: [full.sessions[1]!], chunk: 1, chunks: 3 };
  const chunk2: CatalogStateBody = { ...catalogBody({ projectsRev: 'rev-1' }), sessions: [full.sessions[2]!], chunk: 2, chunks: 3 };

  expect(c.add('anchor-1', chunk1)).toBeNull(); // 半截不产出
  expect(c.add('anchor-1', chunk2)).toBeNull();
  const merged = c.add('anchor-1', chunk0);
  expect(merged).not.toBeNull();
  expect(merged!.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  expect(merged!.full).toBe(true);
  // 无分片 body 直通
  expect(c.add(undefined, full)).toBe(full);
});

// ---------- history.page 落库 ----------

test('history.page：msgKey 幂等归并（重投/重叠页零重复）；notFound 清会话行与消息', async () => {
  const { db, messages } = fakeDb();
  const page = {
    sessionId: 's1',
    done: false,
    messages: [
      { msgKey: 'user:t0', role: 'user', kind: 'text' as const, ts: '2026-09-10T00:00:00.000Z', text: '问' },
      { msgKey: 'assistant:t1', role: 'assistant', kind: 'text' as const, ts: '2026-09-10T00:01:00.000Z', text: '答', reasoningContent: '思考', thinkingDurationMs: 300 },
    ],
  };
  expect(await applyHistoryPage(db, AGENT, page)).toBe(2);
  // 重投（尾部拉齐重叠）→ 幂等
  expect(await applyHistoryPage(db, AGENT, page)).toBe(2);
  expect(messages.size).toBe(2);
  const row = messages.get(`${AGENT}|s1|assistant:t1`);
  expect(JSON.parse(row!.payloadJson!)).toEqual({ reasoningContent: '思考', thinkingDurationMs: 300 });

  // notFound：会话已被桌面删除 → 清本地行与消息
  await db.upsertSession({ agentId: AGENT, sessionId: 's1', projectId: null, title: 't', titleSource: null, workdir: null, createdAt: '', updatedAt: '', preview: '' });
  expect(await applyHistoryPage(db, AGENT, { sessionId: 's1', messages: [], done: true, notFound: true })).toBe(0);
  expect(messages.size).toBe(0);
  expect((await db.getSessionsVersionMap(AGENT))['s1']).toBeUndefined();
});

// ---------- session.event 分派 ----------

test('session.event：metadata.upsert/title.changed/session.created 落库；catalogTouched 标记', async () => {
  const { db } = fakeDb();
  const fx = async (b: SessionEventBody) => applySessionEvent(db, AGENT, b, null);

  expect((await fx({ kind: 'session.created', session: meta('s1', '2026-09-10T00:01:00.000Z') })).catalogTouched).toBe(true);
  expect((await db.getSessionsVersionMap(AGENT))['s1']).toBe('2026-09-10T00:01:00.000Z');

  // title.changed：改名不动 updatedAt
  const r = await fx({ kind: 'title.changed', sessionId: 's1', title: '改名了', titleSource: 'manual' });
  expect(r.catalogTouched).toBe(true);
  const list = await db.listSessions(AGENT);
  expect(list[0]?.title).toBe('改名了');
  expect(list[0]?.updatedAt).toBe('2026-09-10T00:01:00.000Z'); // 不动

  // metadata.upsert
  await fx({ kind: 'metadata.upsert', session: meta('s1', '2026-09-10T00:02:00.000Z', { preview: '新预览' }) });
  expect((await db.listSessions(AGENT))[0]?.preview).toBe('新预览');
});

test('session.event：session.deleted 删行；附着会话被删 → detachBecauseDeleted 副作用', async () => {
  const { db } = fakeDb();
  await applyCatalogState(db, AGENT, catalogBody({ full: true, sessions: [meta('s1', 't'), meta('s2', 't')] }));

  // 非附着会话被删：只删行
  const r1 = await applySessionEvent(db, AGENT, { kind: 'session.deleted', sessionId: 's2' }, 's1');
  expect(r1.catalogTouched).toBe(true);
  expect(r1.detachBecauseDeleted).toBeUndefined();

  // 附着会话被删：脱离副作用（session.ts 据此清意图 + 回发 attach{null} + 通知 UI）
  const r2 = await applySessionEvent(db, AGENT, { kind: 'session.deleted', sessionId: 's1' }, 's1');
  expect(r2.detachBecauseDeleted).toBe('s1');
  expect((await db.getSessionsVersionMap(AGENT))).toEqual({});
});

test('session.event：attached.changed/active.changed 值透传；history.invalidated 清副本', async () => {
  const { db, messages } = fakeDb();
  await db.insertMessages([{ agentId: AGENT, sessionId: 's1', msgKey: 'user:t0', role: 'user', ts: 't', kind: 'text', text: 'x', payloadJson: null }]);

  expect((await applySessionEvent(db, AGENT, { kind: 'attached.changed', sessionId: 's9' }, null)).attachedChanged).toBe('s9');
  expect((await applySessionEvent(db, AGENT, { kind: 'attached.changed', sessionId: null }, 's9')).attachedChanged).toBeNull();
  expect((await applySessionEvent(db, AGENT, { kind: 'active.changed', sessionId: 's2' }, null)).activeChanged).toBe('s2');

  const r = await applySessionEvent(db, AGENT, { kind: 'history.invalidated', sessionId: 's1' }, 's1');
  expect(r.invalidatedSessionId).toBe('s1');
  expect(messages.size).toBe(0); // 副本已清（UI 据此重拉）
});

// ---------- catalog.sync 组包 / resetPairing 清库 ----------

test('catalog.sync 组包：预算内原样上报；超 45KB 退化为空 body（请求全量）', () => {
  const small = packCatalogSyncBody({ projectsRev: 'rev-1', sessions: { s1: 't1' } }, 45 * 1024);
  expect(small).toEqual({ sessions: { s1: 't1' }, projectsRev: 'rev-1' });
  // 无 projectsRev（未同步过）→ 不携带
  expect(packCatalogSyncBody({ projectsRev: null, sessions: {} }, 45 * 1024)).toEqual({ sessions: {} });
  // 超预算：退化全量
  const big: Record<string, string> = {};
  for (let i = 0; i < 3000; i++) big[`session-id-${i}`] = '2026-09-10T00:00:00.000Z';
  expect(packCatalogSyncBody({ projectsRev: 'rev-1', sessions: big }, 45 * 1024)).toEqual({});
});

test('resetPairing 清库：wipeAll 清空全部副本表（agents/projects/sessions/messages/syncState）', async () => {
  const { db, agents, sessions, messages, syncStates } = fakeDb();
  await db.upsertAgent({ agentId: AGENT, name: '桌面', deskPub: 'pub', addedAt: 't' });
  await applyCatalogState(db, AGENT, catalogBody({ full: true, sessions: [meta('s1', 't')] }));
  await db.insertMessages([{ agentId: AGENT, sessionId: 's1', msgKey: 'k', role: 'user', ts: 't', kind: 'text', text: 'x', payloadJson: null }]);
  expect(agents.length).toBe(1);
  await db.wipeAll(); // session.resetPairing 的调用点（Keychain 清除之外）
  expect(agents.length).toBe(0);
  expect(sessions.size).toBe(0);
  expect(messages.size).toBe(0);
  expect(syncStates.size).toBe(0);
});


// ---------- M6b：lastChatSessionId 悬空处理（第一层：catalog deletes 命中即清） ----------

test('M6b 入口记忆悬空：catalog deletes 命中 lastChatSessionId → 清记忆并返回 true；未命中不动', async () => {
  const { db, syncStates } = fakeDb();
  await applyCatalogState(db, AGENT, catalogBody({ full: true, sessions: [meta('s1', 't'), meta('s2', 't2')] }));
  await db.putSyncState({
    agentId: AGENT,
    attachedSessionId: null,
    projectsRev: 'rev-1',
    catalogSyncedAt: null,
    expandedProjectsJson: null,
    lastChatSessionId: 's1',
  });
  // deletes 未命中 → 不动
  const r1 = await applyCatalogState(db, AGENT, catalogBody({ full: false, sessions: [], deletes: ['s2'], projectsRev: 'rev-2' }));
  expect(r1).toBe(false);
  expect(syncStates.get(AGENT)?.lastChatSessionId).toBe('s1');
  // deletes 命中 → 清
  const r2 = await applyCatalogState(db, AGENT, catalogBody({ full: false, sessions: [], deletes: ['s1'], projectsRev: 'rev-3' }));
  expect(r2).toBe(true);
  expect(syncStates.get(AGENT)?.lastChatSessionId).toBeNull();
});

test('附着悬空清理：catalog deletes 命中 attachedSessionId → 置空（防 attach 幽灵会话无效流量）', async () => {
  const { db, syncStates } = fakeDb();
  await applyCatalogState(db, AGENT, catalogBody({ full: true, sessions: [meta('s1', 't'), meta('s2', 't2')] }));
  await db.putSyncState({
    agentId: AGENT,
    attachedSessionId: 's2',
    projectsRev: 'rev-1',
    catalogSyncedAt: null,
    expandedProjectsJson: null,
    lastChatSessionId: null,
  });
  // deletes 未命中 → 附着不动
  await applyCatalogState(db, AGENT, catalogBody({ full: false, sessions: [meta('s9', 't')], deletes: [] }));
  expect(syncStates.get(AGENT)?.attachedSessionId).toBe('s2');
  // deletes 命中附着会话 → 清空（与 lastChatSessionId 同款悬空处理）
  await applyCatalogState(db, AGENT, catalogBody({ full: false, sessions: [], deletes: ['s2'], projectsRev: 'rev-2' }));
  expect(syncStates.get(AGENT)?.attachedSessionId).toBeNull();
});

test('v8 收件卡归属：精确匹配（孤儿行不兜底串场）+ deleteSession 级联清收件行', async () => {
  const { db } = fakeDb();
  await applyCatalogState(db, AGENT, catalogBody({ full: true, sessions: [meta('s1', 't')] }));
  const row = (fileId: string, sessionId: string | null): ReceivedFileRow => ({
    fileId,
    sessionId,
    name: `${fileId}.pptx`,
    mime: 'application/octet-stream',
    size: 1,
    sha256: 'a'.repeat(64),
    staticJson: '{}',
    expiresAt: null,
    state: 'offered',
    stagingPath: null,
    contentUri: null,
    error: null,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    anchorFloorTs: null,
    anchorTs: null,
  });
  await db.putReceivedFile(row('f-ok', 's1'));
  await db.putReceivedFile(row('f-null', null));
  await db.putReceivedFile(row('f-gone', 's-gone'));
  // 精确匹配：s1 只看到自己的行——无归属/归属已删的行不再兜底显示（孤儿回退退役，不串场）
  expect((await db.listReceivedFilesForSession('s1')).map((r) => r.fileId)).toEqual(['f-ok']);
  // 删除 s1 → 级联清归属行；其他会话/无归属行不受影响
  await applyCatalogState(db, AGENT, catalogBody({ full: false, sessions: [], deletes: ['s1'] }));
  expect(await db.getReceivedFile('f-ok')).toBeNull();
  expect((await db.getReceivedFile('f-null'))?.fileId).toBe('f-null');
  expect((await db.getReceivedFile('f-gone'))?.fileId).toBe('f-gone');
});

test('M6b 入口记忆悬空：full 全量中消失（残留清除路径）→ 同样清记忆', async () => {
  const { db, syncStates } = fakeDb();
  await applyCatalogState(db, AGENT, catalogBody({ full: true, sessions: [meta('s1', 't')] }));
  await db.putSyncState({
    agentId: AGENT,
    attachedSessionId: null,
    projectsRev: 'rev-1',
    catalogSyncedAt: null,
    expandedProjectsJson: null,
    lastChatSessionId: 's1',
  });
  const r = await applyCatalogState(db, AGENT, catalogBody({ full: true, sessions: [], projects: [], projectsRev: 'rev-9' }));
  expect(r).toBe(true);
  expect(syncStates.get(AGENT)?.lastChatSessionId).toBeNull();
});

// ---------- M7 board.state 落库 ----------

function wireRow(id: string, over: Partial<BoardRowWire> = {}): BoardRowWire {
  return {
    itemId: id,
    title: `任务${id}`,
    assignee: 'explore·A',
    status: 'in_progress',
    label: '进行中',
    progressText: '推进中',
    claimedAt: 1000,
    detail: { result: '结果' },
    ...over,
  };
}

function boardBody(over: Partial<BoardStateBody>): BoardStateBody {
  return {
    sessionId: 's-b',
    rev: '1',
    rows: [wireRow('b1')],
    strip: { status: 'running', countText: '0/1', needsYou: true },
    needsYou: { needed: true, count: 1 },
    windowed: false,
    full: true,
    ...over,
  };
}

test('M7 board.state：落库（行序=协议 rows 序）+ 标量进 boardMeta', async () => {
  const { db, boardItems, boardMeta } = fakeDb();
  const ok = await applyBoardState(db, AGENT, boardBody({ rows: [wireRow('b2'), wireRow('b1')], rev: '3' }));
  expect(ok).toBe(true);
  const rows = await db.listBoardItems(AGENT, 's-b');
  expect(rows.map((r) => r.itemId)).toEqual(['b2', 'b1']); // sortOrder=协议序，不自排
  expect(rows[0]!.label).toBe('进行中');
  expect(rows[0]!.detailJson).toContain('结果');
  const meta = boardMeta.get(`${AGENT}|s-b`)!;
  expect(meta.rev).toBe('3');
  expect(meta.stripJson).toContain('0/1');
  expect(meta.needsYouJson).toContain('"needed":true');
  expect(boardItems.size).toBe(2);
});

test('M7 rev LWW：旧 rev 丢弃不覆盖（数字比较防字符串序陷阱）', async () => {
  const { db, boardMeta } = fakeDb();
  await applyBoardState(db, AGENT, boardBody({ rev: '10', rows: [wireRow('new', { title: '新行' })] }));
  const ok = await applyBoardState(db, AGENT, boardBody({ rev: '9', rows: [wireRow('stale', { title: '旧旧行' })] }));
  expect(ok).toBe(false);
  const rows = await db.listBoardItems(AGENT, 's-b');
  expect(rows.map((r) => r.itemId)).toEqual(['new']);
  expect(boardMeta.get(`${AGENT}|s-b`)!.rev).toBe('10');
  // 等 rev 幂等重放=无损接受（重投收敛）
  const replay = await applyBoardState(db, AGENT, boardBody({ rev: '10', rows: [wireRow('new', { title: '新行' })] }));
  expect(replay).toBe(true);
});

test('M7 full=true 整表替换 + 残留清除；full=false 仅 upsert 不清残留', async () => {
  const { db } = fakeDb();
  await applyBoardState(db, AGENT, boardBody({ rev: '1', rows: [wireRow('a'), wireRow('b')] }));
  // full=false 纯确认（rows 空）：残留保留
  await applyBoardState(db, AGENT, boardBody({ rev: '2', full: false, rows: [] }));
  expect((await db.listBoardItems(AGENT, 's-b')).map((r) => r.itemId)).toEqual(['a', 'b']);
  // full=true 新全量：b 残留清除
  await applyBoardState(db, AGENT, boardBody({ rev: '3', rows: [wireRow('a', { title: '改过' })] }));
  const rows = await db.listBoardItems(AGENT, 's-b');
  expect(rows.map((r) => r.itemId)).toEqual(['a']);
  expect(rows[0]!.title).toBe('改过');
});

test('M7 chunk 归组：同 replyTo 集齐合并（chunk0 骨架 + rows 拼接）；半截不应用', async () => {
  const c = new BoardChunkCollector();
  const part0 = boardBody({ rev: '5', rows: [wireRow('r1')], chunk: 0, chunks: 2 });
  const part1 = { ...boardBody({ rev: '5', rows: [wireRow('r2')], chunk: 1, chunks: 2 }), strip: part0.strip, needsYou: part0.needsYou, windowed: part0.windowed, full: true };
  expect(c.add('rep-1', part1)).toBeNull(); // 乱序：1 先到不齐
  const complete = c.add('rep-1', part0);
  expect(complete).not.toBeNull();
  expect(complete!.rows.map((r) => r.itemId)).toEqual(['r1', 'r2']);
  expect(complete!.rev).toBe('5');
  // 无分片=完整直接返回
  expect(c.add(undefined, boardBody({ rev: '6' }))!.rev).toBe('6');
  const { db } = fakeDb();
  await applyBoardState(db, AGENT, complete!);
  expect((await db.listBoardItems(AGENT, 's-b')).map((r) => r.itemId)).toEqual(['r1', 'r2']);
});

test('M7 级联清：session.deleted → deleteSession 连带清 boardItems/boardMeta', async () => {
  const { db, boardItems, boardMeta } = fakeDb();
  await applyBoardState(db, AGENT, boardBody({ rev: '2', rows: [wireRow('x')] }));
  expect(boardItems.size).toBe(1);
  await applySessionEvent(db, AGENT, { kind: 'session.deleted', sessionId: 's-b' }, null);
  expect(boardItems.size).toBe(0);
  expect(boardMeta.size).toBe(0);
});

test('M7 board.sync 组包：带已知 rev 对账 / 无已知=全量', () => {
  expect(packBoardSyncBody('s-b', '3')).toEqual({ sessionId: 's-b', rev: '3' });
  expect(packBoardSyncBody('s-b', null)).toEqual({ sessionId: 's-b' });
});

test('user_version 迁移（至 v7）：v0 全量建表 / 各级旧库只补增量 / v7 幂等无动作（只升不降）', () => {
  const run = (from: number) => {
    const sqls: string[] = [];
    applySyncDbMigrations({ executeSync: (s: string) => { sqls.push(s); return { rows: [] }; } }, from);
    return sqls;
  };
  // 全新库（v0）：V1 建表（messages 已含 refsJson/clientId——新装列齐）+ v2-v7 各级新表 + 终态 pragma=7；无 ALTER
  const fresh = run(0);
  expect(fresh.some((s) => s.includes('CREATE TABLE IF NOT EXISTS agents'))).toBe(true);
  expect(fresh.some((s) => s.includes('ALTER TABLE'))).toBe(false);
  expect(fresh.filter((s) => s.includes('boardItems')).length).toBe(1);
  expect(fresh.some((s) => s.includes('CREATE TABLE IF NOT EXISTS sentAttachments'))).toBe(true);
  expect(fresh.some((s) => s.includes('CREATE TABLE IF NOT EXISTS receivedFiles'))).toBe(true);
  expect(fresh.some((s) => s.includes('CREATE TABLE IF NOT EXISTS workPlanMeta'))).toBe(true);
  expect(fresh.includes('PRAGMA user_version = 7;')).toBe(true);
  // 新装库 v9 无 ALTER（SCHEMA_V5 建表已含锚定双列），只跑回填（零行幂等）+ 终版 PRAGMA
  expect(fresh.some((s) => s.includes('ALTER TABLE receivedFiles'))).toBe(false);
  expect(fresh.some((s) => s.includes('UPDATE receivedFiles SET anchorTs'))).toBe(true);
  expect(fresh.includes('PRAGMA user_version = 9;')).toBe(true);
  // v1 旧库：补 v2 ALTER + v4 ALTER（messages.refsJson）+ v5 新表 + v6 ALTER（messages.clientId）+ v7 新表
  const fromV1 = run(1);
  expect(fromV1.some((s) => s.includes('ALTER TABLE syncState ADD COLUMN lastChatSessionId'))).toBe(true);
  expect(fromV1.some((s) => s.includes('ALTER TABLE messages ADD COLUMN refsJson'))).toBe(true);
  expect(fromV1.some((s) => s.includes('CREATE TABLE IF NOT EXISTS receivedFiles'))).toBe(true);
  expect(fromV1.some((s) => s.includes('ALTER TABLE messages ADD COLUMN clientId'))).toBe(true);
  expect(fromV1.some((s) => s.includes('CREATE TABLE IF NOT EXISTS workPlanMeta'))).toBe(true);
  expect(fromV1.includes('PRAGMA user_version = 9;')).toBe(true);
  // v2 旧库：补看板新表 + v4（refsJson ALTER 只对旧库执行）+ v5 新表 + v6 ALTER + v7 新表
  const fromV2 = run(2);
  expect(fromV2.some((s) => s.includes('CREATE TABLE IF NOT EXISTS boardItems'))).toBe(true);
  expect(fromV2.some((s) => s.includes('ALTER TABLE messages ADD COLUMN refsJson'))).toBe(true);
  expect(fromV2.some((s) => s.includes('ALTER TABLE messages ADD COLUMN clientId'))).toBe(true);
  expect(fromV2.some((s) => s.includes('CREATE TABLE IF NOT EXISTS workPlanMeta'))).toBe(true);
  expect(fromV2.includes('PRAGMA user_version = 9;')).toBe(true);
  // v3 旧库（覆盖安装带真实数据）：只补 v4+v5+v6+v7——sentAttachments/receivedFiles/workPlanMeta 新表 + messages.refsJson/clientId 列
  const fromV3 = run(3);
  expect(fromV3.some((s) => s.includes('CREATE TABLE IF NOT EXISTS sentAttachments'))).toBe(true);
  expect(fromV3.some((s) => s.includes('ALTER TABLE messages ADD COLUMN refsJson'))).toBe(true);
  expect(fromV3.some((s) => s.includes('CREATE TABLE IF NOT EXISTS receivedFiles'))).toBe(true);
  expect(fromV3.some((s) => s.includes('ALTER TABLE messages ADD COLUMN clientId'))).toBe(true);
  expect(fromV3.some((s) => s.includes('CREATE TABLE IF NOT EXISTS workPlanMeta'))).toBe(true);
  expect(fromV3.includes('PRAGMA user_version = 9;')).toBe(true);
  // v4 旧库（覆盖安装带真实数据）：只补 v5 新表 + v6 ALTER（messages.clientId）+ v7 新表
  const fromV4 = run(4);
  expect(fromV4.some((s) => s.includes('CREATE TABLE IF NOT EXISTS receivedFiles'))).toBe(true);
  expect(fromV4.some((s) => s.includes('ALTER TABLE messages ADD COLUMN refsJson'))).toBe(false);
  expect(fromV4.some((s) => s.includes('ALTER TABLE messages ADD COLUMN clientId'))).toBe(true);
  expect(fromV4.some((s) => s.includes('CREATE TABLE IF NOT EXISTS workPlanMeta'))).toBe(true);
  expect(fromV4.includes('PRAGMA user_version = 9;')).toBe(true);
  // v5 旧库（覆盖安装带真实数据）：只补 v6 ALTER + v7 新表 + v9 锚定双列 ALTER 与回填
  const fromV5 = run(5);
  expect(fromV5.some((s) => s.includes('ALTER TABLE messages ADD COLUMN clientId'))).toBe(true);
  expect(fromV5.some((s) => s.includes('CREATE TABLE IF NOT EXISTS workPlanMeta'))).toBe(true);
  expect(fromV5.some((s) => s.includes('ALTER TABLE receivedFiles ADD COLUMN anchorFloorTs'))).toBe(true);
  expect(fromV5.some((s) => s.includes('UPDATE receivedFiles SET anchorTs'))).toBe(true);
  expect(fromV5.includes('PRAGMA user_version = 9;')).toBe(true);
  // v6 旧库（覆盖安装带真实数据）：补 v7 新表 + v9 锚定双列（v6 后 receivedFiles 已存在，走 ALTER）
  const fromV6 = run(6);
  expect(fromV6.some((s) => s.includes('CREATE TABLE IF NOT EXISTS workPlanMeta'))).toBe(true);
  expect(fromV6.some((s) => s.includes('ALTER TABLE receivedFiles ADD COLUMN anchorTs'))).toBe(true);
  expect(fromV6.includes('PRAGMA user_version = 9;')).toBe(true);
  // v7 旧库（覆盖安装带真实数据）：升 v8 = 孤儿收件行一次性清扫（无 DDL 纯数据修复）+ v9 锚定双列与回填
  const fromV7 = run(7);
  expect(
    fromV7.some(
      (s) => s.includes('DELETE FROM receivedFiles') && s.includes('IS NULL') && s.includes('NOT IN'),
    ),
  ).toBe(true);
  expect(fromV7.some((s) => s.includes('ALTER TABLE receivedFiles ADD COLUMN anchorFloorTs'))).toBe(true);
  expect(fromV7.includes('PRAGMA user_version = 9;')).toBe(true);
  // v8 现库：只补 v9 锚定双列 + 存量回填
  const fromV8 = run(8);
  expect(fromV8.some((s) => s.includes('ALTER TABLE receivedFiles ADD COLUMN anchorFloorTs'))).toBe(true);
  expect(fromV8.some((s) => s.includes('UPDATE receivedFiles SET anchorTs'))).toBe(true);
  expect(fromV8.includes('PRAGMA user_version = 9;')).toBe(true);
  // v9 现库：零动作（只升不降）
  expect(run(9)).toEqual([]);
});

test('v5 阅后即焚：clearReceivedFileSecret 清密钥列（done/expired 后密钥不持久化）；状态跃迁不动 staticJson（failed 保留供重试）', async () => {
  const { db } = fakeDb();
  const row: ReceivedFileRow = {
    fileId: 'f-burn-1',
    sessionId: 's-b',
    name: '报告.pdf',
    mime: 'application/pdf',
    size: 123,
    sha256: 'a'.repeat(64),
    staticJson: JSON.stringify({ name: 'ab'.repeat(16) + '.bin', key: 'SECRET-KEY', fmt: 2, wireSize: 163, nonce: 'NONCE' }),
    expiresAt: null,
    state: 'offered',
    stagingPath: null,
    contentUri: null,
    error: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    anchorFloorTs: null,
    anchorTs: null,
  };
  await db.putReceivedFile(row);
  // 状态跃迁（offered→pulling→failed）不动密钥列——重试需要指针+密钥
  await db.updateReceivedFileState('f-burn-1', 'pulling');
  await db.updateReceivedFileState('f-burn-1', 'failed', { error: 'network down' });
  expect((await db.getReceivedFile('f-burn-1'))!.staticJson).toContain('SECRET-KEY');
  // 阅后即焚：done/expired 落定后清密钥列，行保留（contentUri 供 done 卡 [打开]）
  await db.updateReceivedFileState('f-burn-1', 'done', { contentUri: 'content://downloads/1' });
  await db.clearReceivedFileSecret('f-burn-1');
  const burnt = (await db.getReceivedFile('f-burn-1'))!;
  expect(burnt.staticJson).toBe('');
  expect(burnt.state).toBe('done');
  expect(burnt.contentUri).toBe('content://downloads/1');
});

test('v9 迟到锚定状态流：updateReceivedFileAnchors 后已锚卡退出 listUnanchoredReceivedFiles 扫描（显式谓词 anchorTs IS NULL 语义）', async () => {
  const { db } = fakeDb();
  await applyCatalogState(db, AGENT, catalogBody({ full: true, sessions: [meta('s1', 't')] }));
  const mk = (fileId: string, floor: number | null): ReceivedFileRow => ({
    fileId,
    sessionId: 's1',
    name: `${fileId}.bin`,
    mime: 'application/octet-stream',
    size: 1,
    sha256: 'a'.repeat(64),
    staticJson: '{}',
    expiresAt: null,
    state: 'offered',
    stagingPath: null,
    contentUri: null,
    error: null,
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    anchorFloorTs: floor,
    anchorTs: null,
  });
  await db.putReceivedFile(mk('f-1', 1000));
  await db.putReceivedFile(mk('f-2', 1000));
  // 未锚：两卡均在扫描
  expect((await db.listUnanchoredReceivedFiles('s1')).map((r) => r.fileId)).toEqual(['f-1', 'f-2']);
  // 锚定 f-1（锚值会被后续消息"超越"——显式态不受影响）
  await db.updateReceivedFileAnchors([{ fileId: 'f-1', anchorTs: 2001 }]);
  // 已锚卡退出扫描（幂等：永不重扫）；未锚卡保留待下一钩子
  expect((await db.listUnanchoredReceivedFiles('s1')).map((r) => r.fileId)).toEqual(['f-2']);
  // 重复锚定写入幂等（值不回退）
  await db.updateReceivedFileAnchors([{ fileId: 'f-1', anchorTs: 2001 }]);
  expect((await db.getReceivedFile('f-1'))!.anchorTs).toBe(2001);
});

// ---------- V2 feed.subagent overlay（latest-wins 归并,不落库） ----------

function fact(over: Partial<import('../src/relay/envelope').FeedSubagentBody>): import('../src/relay/envelope').FeedSubagentBody {
  return {
    toolCallId: 'tc-f1',
    toolName: 'read_file',
    kind: 'builtin',
    argsSummary: 'args',
    status: 'running',
    at: 1,
    taskId: 'tc-task',
    ...over,
  };
}

test('V2 FeedOverlay：同 toolCallId latest-wins（running→success 归并;乱序旧帧丢弃）', () => {
  const ov = new FeedOverlay();
  expect(ov.apply(fact({ status: 'running', at: 100 }))).toBe(true);
  expect(ov.apply(fact({ status: 'success', at: 200, resultSummary: '好', durationMs: 9 }))).toBe(true);
  expect(ov.size()).toBe(1); // 归并到一条
  expect(ov.listByTask('tc-task')[0]!.status).toBe('success');
  // 乱序旧帧（at 更小）丢弃
  expect(ov.apply(fact({ status: 'running', at: 50 }))).toBe(false);
  expect(ov.listByTask('tc-task')[0]!.status).toBe('success');
  // 同 at 后写胜出
  expect(ov.apply(fact({ status: 'failed', at: 200 }))).toBe(true);
  expect(ov.listByTask('tc-task')[0]!.status).toBe('failed');
});

test('V2 FeedOverlay：listByTask 按任务过滤+最新在前;prune 有界保新弃旧;clear 清空', () => {
  const ov = new FeedOverlay();
  ov.apply(fact({ toolCallId: 'a', taskId: 't1', at: 1 }));
  ov.apply(fact({ toolCallId: 'b', taskId: 't1', at: 2 }));
  ov.apply(fact({ toolCallId: 'c', taskId: 't2', at: 3 }));
  expect(ov.listByTask('t1').map((f) => f.toolCallId)).toEqual(['b', 'a']);
  expect(ov.listByTask('t2').map((f) => f.toolCallId)).toEqual(['c']);
  for (let i = 0; i < 10; i++) ov.apply(fact({ toolCallId: `x${i}`, taskId: 't3', at: 100 + i }));
  ov.prune(5);
  expect(ov.size()).toBe(5);
  expect(ov.listByTask('t3', 5).length).toBe(5); // 保新弃旧后 t3 全为最新
  ov.clear();
  expect(ov.size()).toBe(0);
  // 无锚事实拒绝落位
  expect(ov.apply(fact({ toolCallId: '' }))).toBe(false);
});


// ---------- workplan.state（工作计划树副本；rev LWW + full 整树替换，照 board.state 先例） ----------

function wpItem(id: string, over: Partial<import('../src/relay/envelope').WorkPlanItemWire> = {}): import('../src/relay/envelope').WorkPlanItemWire {
  return { id, content: `事项${id}`, status: 'pending', ...over };
}

function wpBody(over: Partial<WorkPlanStateBody>): WorkPlanStateBody {
  return {
    sessionId: 's-w',
    rev: '1',
    full: true,
    items: [wpItem('t1')],
    ...over,
  };
}

test('workplan.state：full=true 整树 JSON 落库（children 嵌套随行）', async () => {
  const { db, workPlanMeta } = fakeDb();
  const ok = await applyWorkPlanState(db, AGENT, wpBody({
    rev: '3',
    items: [wpItem('t1', { status: 'in_progress' }), wpItem('t2', { children: [wpItem('t2a', { status: 'completed' })] })],
  }));
  expect(ok).toBe(true);
  const meta = workPlanMeta.get(`${AGENT}|s-w`)!;
  expect(meta.rev).toBe('3');
  const tree = JSON.parse(meta.treeJson) as import('../src/relay/envelope').WorkPlanItemWire[];
  expect(tree.map((t) => t.id)).toEqual(['t1', 't2']); // 顶层序=协议 items 序
  expect(tree[1]!.children![0]!.id).toBe('t2a'); // children 嵌套随行不重组
});

test('workplan rev LWW：旧 rev 丢弃不覆盖（数字比较）；等 rev 幂等重放=无损接受', async () => {
  const { db, workPlanMeta } = fakeDb();
  await applyWorkPlanState(db, AGENT, wpBody({ rev: '10', items: [wpItem('new', { content: '新树' })] }));
  const ok = await applyWorkPlanState(db, AGENT, wpBody({ rev: '9', items: [wpItem('stale', { content: '旧树' })] }));
  expect(ok).toBe(false);
  const meta = workPlanMeta.get(`${AGENT}|s-w`)!;
  expect(meta.rev).toBe('10');
  expect(meta.treeJson).toContain('新树');
  const replay = await applyWorkPlanState(db, AGENT, wpBody({ rev: '10', items: [wpItem('new', { content: '新树' })] }));
  expect(replay).toBe(true);
});

test('workplan full=true 整树替换；full=false 纯对账确认（树保留、rev 前进）', async () => {
  const { db, workPlanMeta } = fakeDb();
  await applyWorkPlanState(db, AGENT, wpBody({ rev: '1', items: [wpItem('a'), wpItem('b')] }));
  // full=false（items 空）：树不动、rev 前进
  await applyWorkPlanState(db, AGENT, wpBody({ rev: '2', full: false, items: [] }));
  let meta = workPlanMeta.get(`${AGENT}|s-w`)!;
  expect(meta.rev).toBe('2');
  expect(JSON.parse(meta.treeJson).map((t: { id: string }) => t.id)).toEqual(['a', 'b']);
  // full=true 新全量：b 残留清除（整树替换语义）
  await applyWorkPlanState(db, AGENT, wpBody({ rev: '3', items: [wpItem('a', { content: '改过' })] }));
  meta = workPlanMeta.get(`${AGENT}|s-w`)!;
  const tree = JSON.parse(meta.treeJson) as import('../src/relay/envelope').WorkPlanItemWire[];
  expect(tree.map((t) => t.id)).toEqual(['a']);
  expect(tree[0]!.content).toBe('改过');
});

test('workplan chunk 归组：同 replyTo 集齐合并（chunk0 骨架 + items 拼接）；半截不应用', async () => {
  const c = new WorkPlanChunkCollector();
  const part0 = wpBody({ rev: '5', items: [wpItem('r1')], chunk: 0, chunks: 2 });
  const part1 = wpBody({ rev: '5', items: [wpItem('r2')], chunk: 1, chunks: 2 });
  expect(c.add('rep-1', part1)).toBeNull(); // 乱序：1 先到不齐
  const complete = c.add('rep-1', part0);
  expect(complete).not.toBeNull();
  expect(complete!.items.map((t) => t.id)).toEqual(['r1', 'r2']);
  expect(complete!.rev).toBe('5');
  // 无分片=完整直接返回
  expect(c.add(undefined, wpBody({ rev: '6' }))!.rev).toBe('6');
  const { db, workPlanMeta } = fakeDb();
  await applyWorkPlanState(db, AGENT, complete!);
  expect(JSON.parse(workPlanMeta.get(`${AGENT}|s-w`)!.treeJson).map((t: { id: string }) => t.id)).toEqual(['r1', 'r2']);
});

test('workplan 级联清：session.deleted → deleteSession 连带清 workPlanMeta', async () => {
  const { db, workPlanMeta } = fakeDb();
  await applyWorkPlanState(db, AGENT, wpBody({ rev: '2' }));
  expect(workPlanMeta.size).toBe(1);
  await applySessionEvent(db, AGENT, { kind: 'session.deleted', sessionId: 's-w' }, null);
  expect(workPlanMeta.size).toBe(0);
});

test('workplan.sync 组包：带已知 rev 对账 / 无已知=全量', () => {
  expect(packWorkPlanSyncBody('s-w', '3')).toEqual({ sessionId: 's-w', rev: '3' });
  expect(packWorkPlanSyncBody('s-w', null)).toEqual({ sessionId: 's-w' });
});
