/**
 * e2e-sync-desktop.mts — M6 类五 e2e 的"桌面"侧：真实 chill core（RelayBridge + relayEngineWiring +
 * SessionSyncService，dist 直引）+ 进程内盲中继（chill-relay dist）+ 假引擎（eventBus 直发
 * TURN_STREAM_CHUNK/TOOL_CALL_STATUS_CHANGED——引擎广播路径单测已覆盖，此线束验证桥+协议+手机链路）。
 *
 * 隔离：全部状态在临时目录（sessions  fixtures / pairing 设备记录 / relay sqlite / 副本库），
 * 不碰真实 ~/.chill；relay 跑 127.0.0.1 随机端口 plain ws（QR 不带 caFP → 手机侧跳过 CA 校验）。
 *
 * 用法：node --experimental-transform-types --import ./scripts/e2e-harness/registerHook.mjs \
 *   scripts/e2e-harness/e2e-sync-desktop.mts <workDir>
 * 产物：<workDir>/qr.json（手机扫码信道模拟）；就绪打 DESKTOP_READY；收发打 [desk] 日志。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const workDir = process.argv[2]!;
if (!workDir) {
  console.error('usage: e2e-sync-desktop.mts <workDir>');
  process.exit(2);
}
const sessionsDir = join(workDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });

// ---------- 中继（进程内，plain ws 随机端口） ----------
const relayRootUrl = new URL('../../../chill-relay/dist/src/', import.meta.url);
const { createRelayServer } = await import(new URL('server.js', relayRootUrl).href);
const { Store } = await import(new URL('store.js', relayRootUrl).href);
const store = new Store(join(workDir, 'relay.db'));
// e2e 本地中继：放宽频控（默认 30 次/分会被轮询打爆——实测 429 风暴使 redeem 检测错过手机确认窗口）
const server = createRelayServer({
  store,
  operatorKey: 'e2e-operator-key',
  // 媒体直传：staticDir 即启用 /media 写 + /static 读（与 PUBLISH_TOKEN 解耦——本中继无发布令牌）
  staticDir: join(workDir, 'static'),
  limits: { tokensPerMin: 1000, statusPerMin: 1000, redeemPerMin: 1000, wsAuthFailPerMin: 1000, boxMsgsPerMin: 10000 },
});
const port = await server.listen(0, '127.0.0.1');
const relayUrl = `ws://127.0.0.1:${port}`;
console.log(`[desk] relay up: ${relayUrl}`);

// ---------- core ----------
// 注意：core dist ESM 入口（dist/index.js）含 './types' 目录式导出，Node 原生 ESM 不吃
// （bundler-only 形态）；e2e 走 CJS 构建（dist/cjs，同一产物，内容等价）。
import { createRequire } from 'node:module';
const requireCjs = createRequire(import.meta.url);
const core = requireCjs('../../../chill/packages/core/dist/cjs/index.js') as Record<string, any>;
const envelopeMod = requireCjs('../../../chill/packages/core/dist/cjs/services/relay/envelope.js') as Record<string, any>;
const {
  RelayBridge,
  PairingManager,
  eventBus,
  EVENTS,
  wireTurnStream,
  wireTurnSettled,
  wireRunningTransitions,
  wireHistoryInvalidated,
  wireActiveSession,
  wireSessionCatalogWatch,
  wireBeatBoundary,
  wireToolStatus,
  wireBoard,
  wireFeedSubagent,
  wireBoardAskBridge,
  wireWorkPlan,
  makeSessionSyncBridgeDeps,
  makeBoardSyncBridgeDeps,
  makeWorkPlanSyncBridgeDeps,
  makeFileTransferBridgeDeps,
  makeEnsureNewSession,
  SessionBoardService,
  BoardStore,
  setSessionBoardService,
  TeamRuntimeService,
  setTeamRuntimeService,
  getAskChannel,
  buildCommandState,
  executeCommand,
  wireCommandState,
  wireAskChannel,
  makeResolveAsk,
  makeListPendingAsks,
  makeListRecentSettledAsks,
  improvementLedger,
} = core;

/** M8 命令面假模型服务状态（getCommandState 读 / executeCmd 写，同一真相） */
const cmdModels = { current: 'GLM-5.3', params: { reasoning_effort: 'high' } as Record<string, unknown> };

// ---------- 会话 fixtures（真相源：两个会话 + 一个项目） ----------
const T = '2026-09-15T10:00:00.000Z';
const mkMsg = (role: string, content: string, ts: string, extra: Record<string, unknown> = {}) => ({
  role, content, timestamp: ts, ...extra,
});
writeFileSync(join(sessionsDir, 'e2e-s1.json'), JSON.stringify({
  id: 'e2e-s1', title: 'e2e 会话一', titleSource: 'default', projectId: 'p-e2e', workdir: 'C:/e2e',
  createdAt: T, updatedAt: '2026-09-15T10:02:00.000Z',
  messages: [
    mkMsg('user', 'e2e 第一条问题', T),
    mkMsg('assistant', 'e2e 第一条回答', '2026-09-15T10:01:00.000Z'),
    mkMsg('tool', '{"content":"读取完成"}', '2026-09-15T10:01:30.000Z', { toolCallId: 'tc-fixture', toolCallStatus: 'success' }),
  ],
}));
writeFileSync(join(sessionsDir, 'e2e-s2.json'), JSON.stringify({
  id: 'e2e-s2', title: 'e2e 未分组会话', createdAt: T, updatedAt: '2026-09-15T11:00:00.000Z',
  messages: [mkMsg('user', '另一条', T)],
}));
const projects = [{ id: 'p-e2e', name: 'e2e 项目', createdAt: T, updatedAt: T, order: 1 }];

// ---------- 裁决卡原地翻页一幕：种子账本（25 簇 × 30 条长标题强制截批；落在 workDir，不碰真实 ~/.chill） ----------
// ImprovementLedger 经 init(fsProvider, pathProvider) 装配到本文件——开庭/improve.page 翻页落账全走真 core
const e2eLedgerFs = {
  readFile: async (p: string) => {
    try {
      return { success: true, data: { content: readFileSync(p, 'utf8') } };
    } catch {
      return { success: false, error: 'nf' };
    }
  },
  writeFile: async (p: string, content: string) => {
    try {
      writeFileSync(p, content);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
  renameFile: async (from: string, to: string) => {
    try {
      renameSync(from, to);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
  statFile: async (p: string) => {
    try {
      const s = statSync(p);
      return { success: true, data: { mtimeMs: s.mtimeMs, size: s.size } };
    } catch {
      return { success: false, error: 'nf' };
    }
  },
};
improvementLedger.init(e2eLedgerFs as never, { getUserDataPath: () => workDir } as never);
{
  const today = new Date().toISOString().slice(0, 10);
  const lines = ['# 改进候选', '', '## 待确认'];
  for (let c = 0; c < 25; c++) {
    for (let i = 0; i < 30; i++) {
      lines.push(`- [${today}] **功能**：e2e翻页簇${c}条目${i}·${'题'.repeat(40)}`);
      lines.push(`  **组**：C${90 + c} e2e翻页组${c}`);
      lines.push('  **难度**：低', '  **理由**：e2e 翻页场景种子', '  **收益**：e2e', '  **来源**：e2e 线束', '');
    }
  }
  lines.push('## 已确认', '（暂无）', '', '## 已实现', '（暂无）', '', '## 已关闭', '（暂无）', '');
  writeFileSync(join(workDir, 'improvement-proposals.md'), lines.join('\n'));
  console.log('[desk] 裁决卡种子账本就绪：25 簇 × 30 条（强制截批）');
}
/** 裁决卡场景判负数据源（计入退出码）：开庭卡 id / 收卷落定 / 落账核对 */
let courtAskId = '';
let courtSettledOk = false;
let courtLedgerOk = false;

// ---------- 假引擎（广播走真实 eventBus；append 落盘触发目录监听 → metadata.upsert → 尾部拉齐链） ----------
let activeSessionId: string | null = 'e2e-s1';
let newSeq = 0;
/** V2 feed 事实流一幕只演一次（'new' 场景的追问轮不重播） */
let feedSceneFired = false;
/** 本地轮一幕只演一次（桌面发起、无 final——真机 bug2 总结同步的靶） */
let localRoundScheduled = false;
const readRec = (id: string) =>
  existsSync(join(sessionsDir, `${id}.json`))
    ? JSON.parse(readFileSync(join(sessionsDir, `${id}.json`), 'utf8'))
    : null;
const engine: any = {
  onActiveSessionChanged: null,
  abortCount: 0,
  abort: () => {
    engine.abortCount += 1;
    console.log(`[desk] engine.abort() called (#${engine.abortCount})`);
  },
  planOn: false,
  frontAgent: undefined as string | undefined,
  ctxTokens: 48200,
  ctxApprox: false,
  goal: null as { objective: string; roundCount: number; maxRounds: number; active: boolean } | null,
  goalKicks: [] as string[],
  setGoal: (objective: string, _criteria?: string, maxRounds?: number) => {
    if (objective === 'THROW') throw new Error('另一个会话正在目标模式');
    engine.goal = { objective, roundCount: 0, maxRounds: maxRounds && maxRounds > 0 ? maxRounds : 20, active: true };
    console.log(`[desk] setGoal(${objective}, max=${engine.goal.maxRounds})`);
  },
  pauseGoal: () => {
    if (engine.goal) engine.goal.active = false;
    console.log('[desk] pauseGoal()');
  },
  resumeGoal: async () => {
    if (engine.goal) engine.goal.active = true;
    console.log('[desk] resumeGoal()');
  },
  clearGoal: () => {
    engine.goal = null;
    console.log('[desk] clearGoal()');
  },
  setPlanMode: (on: boolean) => {
    engine.planOn = on;
    console.log(`[desk] setPlanMode(${on})`);
  },
  setFrontAgent: (type?: string) => {
    engine.frontAgent = type;
    console.log(`[desk] setFrontAgent(${type ?? '∅'})`);
  },
  getFrontAgentCandidates: () => [{ type: 'coder', name: '代码审查员', description: '改动审查' }],
  compactHistory: async (guidance?: string, opts?: { trigger?: string }) => {
    console.log(`[desk] compactHistory(${guidance ?? ''}, ${opts?.trigger ?? ''})`);
    engine.ctxTokens = 9100; // 压缩后估值空窗（checkpoint approx——口径靶）
    engine.ctxApprox = true;
    return { checkpoint: {} };
  },
  getSessionState: () => ({
    sessionId: activeSessionId,
    // M8 命令面快照假件（buildCommandState 现读；变化推送由 wireCommandState 事件驱动）
    planMode: engine.planOn,
    frontAgent: engine.frontAgent,
    isRunning: false,
    goalMode: engine.goal
      ? { active: engine.goal.active, objective: engine.goal.objective, roundCount: engine.goal.roundCount, maxRounds: engine.goal.maxRounds }
      : undefined,
  }),
  getContextStatus: () => ({ usedTokens: engine.ctxTokens, usedTokensApprox: engine.ctxApprox, maxContextTokens: 200000 }),
  loadSession: async (id: string) => {
    if (!readRec(id)) return false;
    activeSessionId = id;
    engine.onActiveSessionChanged?.(id);
    return true;
  },
  // M6b：makeEnsureNewSession（core 真实现）的三件套接口
  getHistory: () => (activeSessionId ? (readRec(activeSessionId)?.messages ?? []) : []),
  startNewSession: () => {
    activeSessionId = null;
    engine.onActiveSessionChanged?.(null);
  },
  ensureSessionId: () => {
    if (!activeSessionId) {
      newSeq += 1;
      activeSessionId = `e2e-new-${Date.now()}-${newSeq}`;
      engine.onActiveSessionChanged?.(activeSessionId);
    }
    return activeSessionId;
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 最小传输（RelayHttp/RelayTransport 接口直实现；demo client-util 形态对齐） ----------
const http = {
  request: async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const url = `${relayUrl.replace('ws://', 'http://')}${path}`;
    console.log(`[desk-http] ${method} ${path}`);
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    console.log(`[desk-http] ${method} ${path} → ${r.status}`);
    return { status: r.status, json: await r.json().catch(() => ({})) };
  },
};

class WsTransport {
  connected = false;
  private ws: WebSocket | null = null;
  private msgCb: (m: { id: number; blob: string }) => void = () => {};
  private closeCb: (code: number) => void = () => {};
  constructor(private box: string, private readToken: string) {}
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${relayUrl}/box/${this.box}`, { headers: { authorization: `Bearer ${this.readToken}` } });
      this.ws = ws;
      ws.on('open', () => { this.connected = true; resolve(); });
      ws.on('message', (data) => {
        try {
          const m = JSON.parse(String(data));
          if (typeof m.id === 'number' && typeof m.blob === 'string') this.msgCb(m);
        } catch { /* 畸形帧忽略 */ }
      });
      ws.on('close', (code) => { this.connected = false; this.closeCb(code); });
      ws.on('error', (err) => reject(err));
    });
  }
  close(): void { this.ws?.close(); }
  onMessage(cb: (m: { id: number; blob: string }) => void): void { this.msgCb = cb; }
  onClose(cb: (code: number) => void): void { this.closeCb = cb; }
}

// ---------- 配对（PairingManager 真实路径 + 内存 secureStorage + workDir 设备记录） ----------
const memKv = new Map<string, string>();
const secureStorage = {
  storeApiKey: async (k: string, v: string) => { memKv.set(k, v); return true; },
  getApiKey: async (k: string) => memKv.get(k) ?? null,
  hasApiKey: async (k: string) => memKv.has(k),
  deleteApiKey: async (k: string) => { memKv.delete(k); return true; },
};
const devicesPath = join(workDir, 'devices.json');
const deviceStore = {
  read: async () => (existsSync(devicesPath) ? JSON.parse(readFileSync(devicesPath, 'utf8')) : []),
  write: async (devices: unknown) => writeFileSync(devicesPath, JSON.stringify(devices)),
};
const pm = new PairingManager({ secureStorage, deviceStore, pollIntervalMs: 500 } as never);
await pm.saveRelayConfig({ relayUrl, operatorKey: 'e2e-operator-key', caFP: '', caPath: '' } as never);

const { qr, expires } = await pm.startPairing(http as never, { relayUrl, operatorKey: 'e2e-operator-key', caFP: '' } as never, 'e2e 桌面');
writeFileSync(join(workDir, 'qr.json'), JSON.stringify({ ...qr, caFP: '' }));
console.log('[desk] QR written, waiting redeem…');
console.log('DESKTOP_READY');

const redeemed = await pm.waitForRedeem(http as never, qr.token, expires);
if (redeemed.state !== 'redeemed') {
  console.error(`[desk] pairing 未落定: ${redeemed.state}`);
  process.exit(2);
}
console.log(`[desk] redeemed by ${redeemed.device}`);
await pm.completePairing(redeemed.phonePub!, redeemed.device!, qr.token);

// ---------- 桥（真实 RelayBridge + wiring；onConfirmRequest 自动批准） ----------
const { secrets, myBox, peerBox } = await pm.deriveForDevice(redeemed.phonePub!);
const desk = await pm.getOrCreateDeviceKey();
const transport = new WsTransport(myBox, secrets.readToken);
/** file.* e2e：内存附件仓（saveAttachment 落点；readAsBase64 回读源） */
const e2eAttachments = new Map<string, Uint8Array>();
/** 运行态标志 e2e：假引擎运行全集（E2E_RUNNING 分支维护；桥 getRunningSessionIds 消费） */
const e2eRunning = new Set<string>();

const bridge = new RelayBridge({
  transport,
  http,
  secrets,
  myBox,
  peerBox,
  deskPub: desk.publicKey,
  phonePub: redeemed.phonePub!,
  deviceName: 'e2e 桌面',
  pairingToken: qr.token,
  confirmed: false,
  onConfirmRequest: async (device: string) => {
    console.log(`[desk] confirm request from ${device}`);
    return true; // e2e 自动化通道（对应 CLI CHILL_RELAY_AUTO_CONFIRM）
  },
  onAlarm: (m: string) => console.log(`[desk] ALARM: ${m}`),
  // 运行态标志（E2E_RUNNING 靶）：假引擎的运行全集——enqueue 分支维护，桥 runningAll 随行
  getRunningSessionIds: () => [...e2eRunning],
  // 审批/提问通道本场景不覆盖（类三/M5 单测已验），给空实现满足必填 deps
  resolveApproval: () => false,
  listPendingApprovals: () => [],
  // 裁决卡过线靶：ask 通道接线（card 字段随 ask.request 推送；手机回答回灌 resolveAsk）
  resolveAsk: makeResolveAsk(),
  listPendingAsks: makeListPendingAsks(),
  listRecentSettledAsks: makeListRecentSettledAsks(),
  enqueue: async (input: { text: string; contentParts?: Array<{ type: string; text?: string }>; attachmentRefs?: Array<{ ref: string; name: string; mime: string }>; clientId?: string }, opts?: { onIngested?: () => void | Promise<void> }) => {
    const sid = activeSessionId!;
    const text = input.text;
    console.log(`[desk] round on ${sid}: ${text.slice(0, 40)}${input.attachmentRefs?.length ? ` (+${input.attachmentRefs.length} 附件)` : ''}`);
    // file.* e2e：附件消息按引擎同构落盘（content=contentParts 数组 + attachmentRefs——
    // 手机历史拉回应命中 media 行 + refs 回填）
    if (input.contentParts?.length) {
      if (opts?.onIngested) await opts.onIngested();
      const file0 = join(sessionsDir, `${sid}.json`);
      const now0 = new Date().toISOString();
      const rec0 = readRec(sid) ?? { id: sid, title: '', titleSource: 'default', createdAt: now0, messages: [] };
      rec0.messages.push({
        role: 'user', timestamp: now0,
        content: input.contentParts as never,
        ...(input.attachmentRefs ? { attachmentRefs: input.attachmentRefs } : {}),
        ...(input.clientId ? { clientId: input.clientId } : {}),
      } as never);
      rec0.updatedAt = now0;
      writeFileSync(file0, JSON.stringify(rec0));
      console.log('[desk] 附件消息已落盘（expect 手机 history 命中 media+refs）');
      eventBus.emit(EVENTS.TURN_SETTLED, { sessionId: sid });
      return { content: `e2e 附件轮完成：${text.slice(0, 20)}`, aborted: false };
    }
    // M7 增量 3：失败回执一拍——魔法前缀消息：onIngested（收录+ACK，投递与处理解耦）后
    // 轮次抛错 → 桥必须向手机回执「本轮处理失败」（永不沉默）
    if (text.startsWith('E2E_FAIL_ROUND')) {
      if (opts?.onIngested) await opts.onIngested();
      throw new Error('e2e 预设轮次失败');
    }
    // V2 事实流一幕（仅首轮;taskId=看板行 claimedByTaskId）：running→终态 + 跨窗乱序旧帧
    if (!feedSceneFired) {
      feedSceneFired = true;
      const t0 = Date.now();
      const fact = (toolCallId: string, toolName: string, status: 'running' | 'success' | 'failed', at: number, extra: Record<string, unknown> = {}) => ({
        taskId: 'tc-e2e-board', toolCallId, toolName, kind: 'builtin',
        argsSummary: `{"t":"${toolName}"}`, status, at, ...extra,
      });
      eventBus.emit(EVENTS.SUBAGENT_TOOL_CALL, fact('tc-f1', 'read_file', 'running', t0));
      eventBus.emit(EVENTS.SUBAGENT_TOOL_CALL, fact('tc-f2', 'web_search', 'running', t0));
      setTimeout(() => {
        eventBus.emit(EVENTS.SUBAGENT_TOOL_CALL, fact('tc-f1', 'read_file', 'success', t0 + 500, { resultSummary: '读完', durationMs: 400 }));
        eventBus.emit(EVENTS.SUBAGENT_TOOL_CALL, fact('tc-f2', 'web_search', 'failed', t0 + 500, { resultSummary: '超时', durationMs: 1200 }));
      }, 1200);
      // 跨窗乱序旧帧（at 更早）：wiring 跨窗不拦,手机 overlay latest-wins 必须丢弃
      setTimeout(() => {
        eventBus.emit(EVENTS.SUBAGENT_TOOL_CALL, fact('tc-f1', 'read_file', 'running', t0 - 1000));
      }, 2500);
      // V3 需拍板一幕:ask 挂起 → 条目 blocked(needsYou 计数升) → 落定 → 恢复 in_progress
      setTimeout(() => {
        let askId = '';
        const capture = (p: { id: string }) => { askId = p.id; };
        eventBus.on(EVENTS.ASK_REQUESTED, capture);
        void getAskChannel()
          .ask('e2e 拍板问题：用 A 还是 B？', undefined, true, undefined, {
            sessionId: 'e2e-s1', itemId: askItem!.item.id, taskId: 'tc-e2e-ask',
          }, {
            // 裁决卡字段过线断言靶（additive card：手机侧 validateTriageCard 应接受）
            card: { digest: 'e2e 裁决卡 digest', clusters: [{ id: 'C1', name: 'e2e 簇', count: 1, recent: 0, difficulty: '低', latest: '2026-09-29' }] },
          })
          .finally(() => eventBus.off(EVENTS.ASK_REQUESTED, capture));
        setTimeout(() => {
          if (askId) getAskChannel().resolve(askId, '用 A');
          console.log('[desk] ask resolved（expect 条目恢复 in_progress）');
        }, 4800);
      }, 200);
      // 断线重连板对账靶（ask 恢复之后）:挂一条新条目——推送正常到达;
      // 手机随后清本地造"推送丢失/陈旧副本",再 chat.sync 触发 resyncBoard 全量收敛
      setTimeout(() => {
        void boardSvc
          .post('e2e-s1', { title: 'e2e 重连补挂', createdBy: 'lead', description: '重连对账靶', batchId: 'e2e-batch' })
          .then((item) => console.log(`[desk] 重连补挂条目已挂 [${item.id}]（expect 手机 chat.sync 后全量收敛）`))
          .catch((err) => console.log('[desk] 重连补挂失败', err));
      }, 6500);
    }
    // 本地轮一幕（桌面发起、无 final——真机 bug2 靶）：+9s 排定一次，
    // 落在重连板对账之后、'new' 场景之前（附着仍在 e2e-s1，settle 不被附着门控挡掉）
    if (!localRoundScheduled) {
      localRoundScheduled = true;
      setTimeout(() => runLocalRoundScene(), 9000);
    }
    // d→m 文件往返一幕触发（手机魔法消息）：真 sendFileToMobile（path 模式全校验链）→ PUT 分片 → offer → 等回执
    if (text.startsWith('E2E_SEND_FILE')) {
      console.log('[desk] d2m 文件场景触发（E2E_SEND_FILE）');
      void runFileSendScene();
    }
    // 裁决卡原地翻页一幕的落账核对（手机翻页后发魔法消息：读临时账本断言被确认簇条目进「已确认」区）
    if (text.startsWith('E2E_VERIFY_COURT')) {
      const title = text.slice('E2E_VERIFY_COURT'.length).trim();
      const md = readFileSync(join(workDir, 'improvement-proposals.md'), 'utf8');
      const confirmedSection = md.split('## 已确认')[1]?.split('## 已实现')[0] ?? '';
      courtLedgerOk = title.length > 0 && confirmedSection.includes(title);
      console.log(`[desk] 裁决卡落账核对: ${title.slice(0, 30)} → ${courtLedgerOk ? '已确认区命中 ✔' : '未命中 ✗'}`);
    }
    // 运行态标志压轴一幕（E2E_RUNNING）：假轮 TURN_STARTED → 2.5s 窗口 → TURN_SETTLED——
    // 手机断言"轮中集合含目标（转圈亮，经 runningAll 整替语义）→落定清空（转圈熄）"。
    // 与 E2E_LONG_ROUND 同构但只发起止两事件（本幕不验内容只验运行态通道）。
    if (text.startsWith('E2E_RUNNING')) {
      console.log('[desk] 运行态场景触发（TURN_STARTED → 2.5s → TURN_SETTLED）');
      if (opts?.onIngested) await opts.onIngested();
      e2eRunning.add(sid);
      eventBus.emit(EVENTS.TURN_STARTED, { sessionId: sid });
      await new Promise((r) => setTimeout(r, 2500));
      e2eRunning.delete(sid);
      eventBus.emit(EVENTS.TURN_SETTLED, { sessionId: sid });
      return { content: 'e2e 运行态轮完成', aborted: false };
    }
    // 长轮一幕（消息接管根治靶）：12 次工具调用=12 工具行+12 节拍行+用户行+final=26 行 > 20 条页预算——
    // 尾部拉齐的最新页必不含用户行（气泡消失事故的同构复现）；clientId 随用户行落盘供手机断言身份
    if (text.startsWith('E2E_LONG_ROUND')) {
      console.log('[desk] 长轮场景触发（>20 行页预算截断靶）');
      if (opts?.onIngested) await opts.onIngested();
      const fileL = join(sessionsDir, `${sid}.json`);
      const baseL = Date.now();
      const atL = (i: number) => new Date(baseL + i * 1000).toISOString();
      const recL = readRec(sid) ?? { id: sid, title: '', titleSource: 'default', createdAt: atL(0), messages: [] };
      recL.messages.push(mkMsg('user', text, atL(0), input.clientId ? { clientId: input.clientId } : {}));
      for (let i = 0; i < 12; i++) {
        eventBus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, {
          sessionId: sid,
          toolCallStatus: 'success',
          toolCall: { function: { name: 'read_file' } },
          toolCallId: `tc-long-${i}`,
          toolResult: { content: `第 ${i} 次工具结果预览` },
        });
        recL.messages.push(
          mkMsg('assistant', `e2e 长轮节拍${i}`, atL(1 + i * 2)),
          mkMsg('tool', `第 ${i} 次工具结果`, atL(2 + i * 2), { toolCallId: `tc-long-${i}`, toolCallStatus: 'success' }),
        );
      }
      recL.messages.push(mkMsg('assistant', 'e2e 长轮最终回答', atL(25)));
      recL.updatedAt = atL(25);
      writeFileSync(fileL, JSON.stringify(recL));
      // M6c 轮次落定广播——手机尾部拉齐只认 round.settled
      eventBus.emit(EVENTS.TURN_SETTLED, { sessionId: sid });
      return { content: 'e2e 长轮完成', aborted: false };
    }
    // 工作计划树双源一幕（迭代 2 压轴；树=清单项+看板行）：假引擎 TASK_LIST_CREATED ×2 →
    // 会话板挂 2 行（有链 parentTaskId=e2e-tree-root → 应嵌 children；无链待认领 → 应根层并列，非 needsYou）。
    // 早退自管（不走默认轮）；BOARD_CHANGED 与 TASK_* 同窗防抖共用 rev，两次变更合并为最终态推送。
    // 分支顺序红线：必须先于 E2E_WORKPLAN 判定——'E2E_WORKPLAN_TREE' 同样 startsWith('E2E_WORKPLAN')（实测踩过）。
    if (text.startsWith('E2E_WORKPLAN_TREE')) {
      console.log('[desk] workplan tree 场景触发（清单 2 项 + 看板 2 行：有链嵌套 / 无链根层）');
      if (opts?.onIngested) await opts.onIngested();
      const mkNode = (id: string, content: string) => ({
        id, content, status: 'pending' as const, createdAt: new Date(), updatedAt: new Date(),
      });
      eventBus.emit(EVENTS.TASK_LIST_CREATED, {
        sessionId: sid,
        source: 'main',
        tasks: [mkNode('e2e-tree-root', 'e2e 树根父项'), mkNode('e2e-tree-other', 'e2e 树另一事项')],
      });
      setTimeout(() => {
        void (async () => {
          // 有链行：parentTaskId 命中清单项 → 嵌为 e2e-tree-root 的 children；claim 给成员 → actor=explore·A、in_progress
          const linked = await boardSvc.post(sid, { title: 'e2e 树挂链子活', createdBy: 'lead', parentTaskId: 'e2e-tree-root' });
          await boardSvc.claim(sid, linked.id, { assignee: 'explore·A', claimedByTaskId: 'tc-e2e-tree' });
          console.log(`[desk] tree ①：挂链行已挂并认领 [${linked.id}]（expect 嵌进 e2e-tree-root.children，actor=explore·A）`);
          // 无链行：待认领 → 根层并列；actor='待认领'、不标 needsYou（灰调等待相位）
          await boardSvc.post(sid, { title: 'e2e 树无链待认领', createdBy: 'lead' });
          console.log('[desk] tree ②：无链待认领行已挂（expect 根层并列，actor=待认领·非 needsYou）');
        })().catch((err) => console.log('[desk] workplan tree scene 失败', err));
      }, 600);
      return { content: 'e2e workplan tree 场景完成', aborted: false };
    }
    // 工作计划树一幕（压轴场景；workplan.* MVP 协议链靶）：假引擎直发 TASK_* → wireWorkPlan 分键镜像
    // → 300ms 防抖 → workplan.state(full:true) 推送。早退自管（不走默认轮——避免旧 rev 板投/s2 删定时器尾随）
    if (text.startsWith('E2E_WORKPLAN')) {
      console.log('[desk] workplan 场景触发（TASK_LIST_CREATED ×3 → TASK_STATUS_UPDATED ×2）');
      if (opts?.onIngested) await opts.onIngested();
      const mkTask = (id: string, content: string) => ({
        id, content, status: 'pending' as const, createdAt: new Date(), updatedAt: new Date(),
      });
      eventBus.emit(EVENTS.TASK_LIST_CREATED, {
        sessionId: sid,
        source: 'main',
        tasks: [mkTask('e2e-wp-1', 'e2e 清单事项甲'), mkTask('e2e-wp-2', 'e2e 清单事项乙'), mkTask('e2e-wp-3', 'e2e 清单事项丙')],
      });
      // 错开防抖窗（>300ms）：先推建表全量，再推状态终态——手机须收敛终态
      //（迭代 2 起 BOARD_CHANGED 与 TASK_* 共用同一 rev 计数器，rev 绝对值不再可预言，手机按形状断言）
      setTimeout(() => {
        eventBus.emit(EVENTS.TASK_STATUS_UPDATED, {
          sessionId: sid, taskId: 'e2e-wp-1', status: 'completed', result: 'e2e 事项甲完成', source: 'main',
        });
        eventBus.emit(EVENTS.TASK_STATUS_UPDATED, { sessionId: sid, taskId: 'e2e-wp-2', status: 'in_progress', source: 'main' });
        console.log('[desk] workplan 状态更新已发（expect 手机终态：甲 completed + 乙 in_progress + 丙 pending）');
      }, 600);
      return { content: 'e2e workplan 场景完成', aborted: false };
    }
    eventBus.emit(EVENTS.TURN_STREAM_CHUNK, { sessionId: sid, kind: 'reasoning', text: 'e2e 思考片段' });
    await sleep(60);
    eventBus.emit(EVENTS.TURN_STREAM_CHUNK, { sessionId: sid, kind: 'delta', text: 'e2e 流式片段A' });
    await sleep(60);
    eventBus.emit(EVENTS.TURN_STREAM_CHUNK, { sessionId: sid, kind: 'delta', text: '片段B' });
    // 工具事件走既有 toolStatus 通道（不双源）
    eventBus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, {
      sessionId: sid,
      toolCallStatus: 'success',
      toolCall: { function: { name: 'read_file' } },
      toolCallId: 'tc-e2e-round',
      toolResult: { content: '文件内容预览' },
    });
    // 落定落盘（真相源追加）→ 目录监听 → metadata.upsert → 手机尾部拉齐链
    const file = join(sessionsDir, `${sid}.json`);
    const now = new Date().toISOString();
    const rec = readRec(sid) ?? {
      id: sid, title: '', titleSource: 'default', createdAt: now, messages: [],
    };
    rec.messages.push(mkMsg('user', text, now, input.clientId ? { clientId: input.clientId } : {}), mkMsg('assistant', `e2e 回复：${text}`, now));
    rec.updatedAt = now;
    writeFileSync(file, JSON.stringify(rec));
    // M6c 轮次落定广播（runTurn finally 等价物）——手机尾部拉齐只认 round.settled，缺失必超时
    eventBus.emit(EVENTS.TURN_SETTLED, { sessionId: sid });
    // M7 e2e 编排（借聊天轮当同步屏障）：
    // ①300ms 后投一封手工打造的旧 rev board.state（rev LWW 靶：手机必须丢弃不覆盖）；
    // ②3000ms 后删 s2 会话文件（目录监听 → session.deleted → 手机级联清 s2 看板行）
    setTimeout(() => {
      const staleEnv = envelopeMod.makeEnvelope('board.state', myBox, peerBox, {
        sessionId: 'e2e-s1',
        rev: '1',
        rows: [{
          itemId: 'stale-row', title: '旧旧行', assignee: null, status: 'pending', label: '待认领',
          progressText: '不应出现', detail: {},
        }],
        strip: { status: 'running', countText: '0/1', needsYou: true },
        needsYou: { needed: true, count: 1 },
        windowed: false,
        full: true,
      });
      const staleWire = envelopeMod.encryptEnvelope(secrets.keyD2M, peerBox, 'd2m', staleEnv);
      if (staleWire) {
        void http.request('POST', `/box/${peerBox}`, { token: secrets.writeToken, body: { blob: staleWire } });
        console.log('[desk] stale board.state sent (rev=1, expect phone LWW discard)');
      }
    }, 300);
    setTimeout(() => {
      try {
        unlinkSync(join(sessionsDir, 'e2e-s2.json'));
        console.log('[desk] e2e-s2 deleted (expect cascade clear of its board rows)');
      } catch { /* 已删即目标态 */ }
    }, 3000);
    return { content: `e2e 回复：${text}`, aborted: false };
  },
  ...makeSessionSyncBridgeDeps({
    sessionsDir,
    listProjects: async () => projects,
    loadSession: async (id: string) => readRec(id),
    getActiveSessionId: () => activeSessionId,
    ensureActiveSession: async (id: string) => ((await engine.loadSession(id)) ? 'ok' : 'notfound'),
    ensureNewSession: makeEnsureNewSession(engine), // M6b：core 真实现（假引擎三件套接口）
  }),
  // M7：共享看板 deps（SessionBoardService.getProjection 组包 + ask/approval 未决计数）
  ...makeBoardSyncBridgeDeps(),
  // 工作计划树 deps（分键清单镜像现读 + buildWorkPlanTree 投影；workplan.sync 应答/出向组包的唯一数据源）
  ...makeWorkPlanSyncBridgeDeps(),
  // file.* 协议族：真实工厂 + 内存附件仓（saveAttachment 存字节→savedRef；readAsBase64 回读；
  // 判据锚定 MEDIA_EXTENSIONS——jpg 走 base64 内联、其他走引用行，双路径都在本场景被压到）
  ...makeFileTransferBridgeDeps({
    saveAttachment: async (bytes, name) => {
      const ref = `e2e/${Date.now()}-${name}`;
      e2eAttachments.set(ref, bytes);
      console.log(`[desk] saveAttachment ${name} → ${ref} (${bytes.length}B)`);
      return ref;
    },
    readAsBase64: async (ref) => Buffer.from(e2eAttachments.get(ref) ?? new Uint8Array()).toString('base64'),
    getAbsolutePath: (ref) => `C:/e2e-att/${ref}`,
    // 媒体直传：密文拉取（Node fetch 二进制；v2 分片带 Range 头；同源=本中继 plain ws → http）
    fetchMedia: async (name: string, opts?: { range?: string }) => {
      const r = await fetch(`${relayUrl.replace('ws://', 'http://')}/static/media/${name}`, {
        ...(opts?.range ? { headers: { range: opts.range } } : {}),
      });
      if (!r.ok && r.status !== 206) throw new Error(`媒体拉取 HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      console.log(`[desk] fetchMedia ${name} → ${bytes.length}B`);
      return bytes;
    },
    // d→m 出向文件发送注入（sendFileToMobile 真实路径：PUT 分片 + 切片读 + stat 护栏 + 路径解析）
    putMedia: async (name: string, offset: number, total: number, bytes: Uint8Array) => {
      const r = await fetch(`${relayUrl.replace('ws://', 'http://')}/media/${name}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${secrets.writeToken}`,
          'content-type': 'application/octet-stream',
          'media-offset': String(offset),
          'media-total': String(total),
        },
        body: Buffer.from(bytes),
      });
      const j = (await r.json().catch(() => ({}))) as { current?: number };
      console.log(`[desk] putMedia ${name} @${offset}/${total} → ${r.status}`);
      return { status: r.status, ...(typeof j.current === 'number' ? { current: j.current } : {}) };
    },
    resolvePath: async (p: string) => p, // e2e 只传绝对路径（workDir 内）
    statFile: async (p: string) => {
      try {
        const s = statSync(p);
        return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile() };
      } catch {
        return null;
      }
    },
    readFileSlice: async (p: string, offset: number, length: number) => {
      const fh = await fsOpen(p, 'r');
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return new Uint8Array(buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    },
  }),
  // M8：命令面状态快照 + 命令执行（M2 激活：真 executeCommand，假 models/modelInfo——与快照共享状态）
  getCommandState: () =>
    buildCommandState({
      engine,
      models: { getCurrentModelName: () => cmdModels.current, getModelParameters: () => cmdModels.params },
    }),
  executeCmd: (cmd: string, args?: Record<string, unknown>) =>
    executeCommand(
      {
        engine,
        models: {
          getCurrentModelName: () => cmdModels.current,
          getModelParameters: () => cmdModels.params,
          saveCurrentModelName: (n: string) => {
            cmdModels.current = n;
          },
          getModelParameterSettings: () => ({ modelName: cmdModels.current, parameters: { ...cmdModels.params } }),
          saveModelParameterSettings: (s: { parameters: Record<string, unknown> }) => {
            cmdModels.params = { ...s.parameters };
          },
        },
        modelInfo: {
          // model.list 口径=CLI 同款：getAllModelsWithApiKeyStatus 全量+hasKey 状态（chat 模型经 deriveModelKind 过滤）
          getAllModelsWithApiKeyStatus: async () => [
            {
              hasApiKey: true,
              model: { name: 'GLM-5.3', displayName: 'GLM 5.3', provider: 'Z.ai', supportedParameters: [{ name: 'reasoning_effort', enumValues: ['low', 'high', 'max'] }] },
            },
            {
              hasApiKey: false,
              model: { name: 'Kimi-K3', provider: 'Moonshot', supportedParameters: [{ name: 'reasoning_effort', enumValues: ['low', 'medium', 'xhigh'] }] },
            },
          ],
        },
        // M4：目标首轮 kick（设定即开工；fire-and-forget——记录调用即证明语义）
        startGoalRound: async (objective: string) => {
          engine.goalKicks.push(objective);
          console.log(`[desk] goal first round kicked: ${objective}`);
        },
      },
      cmd,
      args,
    ),
} as never);

// ---------- M7 看板一幕（真实 SessionBoardService 驱动 → 经真实桥推/答 board.state） ----------
const boardSvc = new SessionBoardService(new BoardStore(join(workDir, 'boards')));
setSessionBoardService(boardSvc);
// s1：一行待认领（要你信号）+ 一行 spawn 即认领→交付（自动结项标注）+ 一行待拍板（ask 场景）；同批次（strip 焦点批次口径）
await boardSvc.post('e2e-s1', { title: 'e2e 待认领活', createdBy: 'lead', description: '发帖说明', batchId: 'e2e-batch' });
await boardSvc.autoPostAndClaim({
  sessionId: 'e2e-s1', batchId: 'e2e-batch', taskId: 'tc-e2e-board', subagentType: 'explore',
  title: 'e2e 已认领活', description: '自动认领演示',
});
await boardSvc.update('e2e-s1', (await boardSvc.readBoard('e2e-s1')).items[1]!.id, { note: '关键节点进展' }, { role: 'worker', assignee: 'explore·A' });
await boardSvc.settleByTaskId('tc-e2e-board', 'completed', { result: 'e2e 交付结果' });
// V3 ask 场景靶:一条 in_progress(绑 tc-e2e-ask,不结项)——ask 挂起→blocked→落定恢复
const askItem = await boardSvc.autoPostAndClaim({
  sessionId: 'e2e-s1', batchId: 'e2e-batch', taskId: 'tc-e2e-ask', subagentType: 'coder',
  title: 'e2e 拍板活', description: '等一个拍板',
});
await boardSvc.post('e2e-s2', { title: 'e2e 级联清靶', createdBy: 'lead' });
await boardSvc.claim('e2e-s2', (await boardSvc.readBoard('e2e-s2')).items[0]!.id, { assignee: 'explore·B' });
const realS1Rev = await boardSvc.getRevision('e2e-s1');
console.log('[desk] board scene ready: s1 rev =', realS1Rev);

// ---------- M7 增量 1：团队运行时（真 TeamRuntimeService + e2e 临时目录 node fs） ----------
// 团队板是与会话板独立的 CAS：core 侧并集投影（归属会话匹配才并入），协议与手机零改动。
const teamSvc = new TeamRuntimeService(
  {
    getCurrentDirectory: () => workDir,
    readFile: async (p: string) => {
      try {
        return { success: true, data: { content: readFileSync(p, 'utf8') } };
      } catch {
        return { success: false, error: 'nf' };
      }
    },
    writeFile: async (p: string, content: string) => {
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
    deleteFile: async (p: string) => {
      try {
        unlinkSync(p);
      } catch {
        /* 已删即目标态 */
      }
      return { success: true };
    },
    renameFile: async (from: string, to: string) => {
      try {
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
    fileExists: async (p: string) => ({ success: true, data: existsSync(p) }),
    listDirectory: async () => ({ success: false, error: 'e2e 未实现' }),
  } as never,
  join(workDir, 'team'),
);
setTeamRuntimeService(teamSvc);

const unsubs = [
  wireTurnStream(bridge),
  wireTurnSettled(bridge),
  wireRunningTransitions(bridge),
  wireHistoryInvalidated(bridge),
  wireActiveSession(bridge, engine),
  wireBeatBoundary(bridge),
  wireToolStatus(bridge),
  wireSessionCatalogWatch(bridge, { sessionsDir, listProjects: async () => projects, debounceMs: 20 }),
  wireBoard(bridge),
  wireWorkPlan(bridge, { getActiveSessionId: () => activeSessionId }), // 工作计划树：TASK_* → 分键镜像 → 300ms 防抖 → workplan.state（照 relayClient.ts:400 装配先例）
  wireFeedSubagent(bridge, { windowMs: 300 }), // e2e 收紧窗口;语义与缺省 1s 同（测试已锁）
  wireBoardAskBridge(), // V3:ask 挂起→blocked / 落定→unblock
  wireAskChannel(bridge), // 裁决卡过线靶：ASK_REQUESTED → pushAskRequest（含 card 透传）
  wireCommandState(bridge), // M8：轮末/ctx 事件点推 cmd.state（resync 在桥内）
];
void unsubs;

// 裁决卡原地翻页一幕：开庭卡 id 捕获（inplace 标记区分于 V3 固定卡）+ 收卷落定观测（退出码数据源）
eventBus.on(EVENTS.ASK_REQUESTED, (p: { id: string; card?: { inplace?: boolean } }) => {
  if (p.card?.inplace === true) {
    courtAskId = p.id;
    console.log(`[desk] 裁决卡开庭发出: ${p.id}（inplace ✔）`);
  }
});
eventBus.on(EVENTS.ASK_SETTLED, (s: { id: string; by: string }) => {
  if (courtAskId && s.id === courtAskId) {
    courtSettledOk = true;
    console.log(`[desk] 裁决卡收卷落定（by=${s.by}）`);
  }
});

/**
 * 本地轮一幕（真机 bug2：前台总结/占位改写不同步到手机）。
 * 形态=真实本地轮（桌面发起、不经 chat.user）：流式尾巴进聚合缓冲 → 工具占位 → 落盘
 * （用户消息 + 前台总结 + writeBackToolResult 式占位改写，均无对应事件推送）→ TURN_SETTLED。
 * 时序靶两腿：
 * ① 尾批在 settle 时仍在 200ms 聚合缓冲里——settle 前必须冲刷（迟到 delta 会把手机活轮记账
 *    重新点亮、把唯一的尾拉永久跳过）；
 * ② settle 处理完成后 +300ms 再补一发迟到无锚 delta——settle 触发的尾拉必须是 force 欠账拉，
 *    否则活轮守卫会把这唯一一次尾拉跳过（总结/占位改写双双丢失）。
 */
function runLocalRoundScene(): void {
  const sid = 'e2e-s1';
  console.log('[desk] local round scene start（expect 本地轮总结经尾拉落库）');
  eventBus.emit(EVENTS.TURN_STREAM_CHUNK, { sessionId: sid, kind: 'delta', text: 'e2e 本地轮流式尾巴' });
  eventBus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, {
    sessionId: sid,
    toolCallStatus: 'running',
    toolCall: { function: { name: 'task' } },
    toolCallId: 'tc-local-round',
  });
  // 落盘=writeBackToolResult 等价物（占位改写只落盘不发事件——手机只能靠尾拉拿到）
  const file = join(sessionsDir, `${sid}.json`);
  const now = new Date().toISOString();
  const rec = readRec(sid) ?? { id: sid, title: '', titleSource: 'default', createdAt: now, messages: [] };
  rec.messages.push(
    mkMsg('user', 'e2e 本地轮提问（桌面发起）', now),
    mkMsg('assistant', 'e2e 本地轮总结：两个子任务已交付', now),
    mkMsg('tool', 'e2e 占位改写结果：本地任务交付', now, { toolCallId: 'tc-local-round', toolCallStatus: 'success' }),
  );
  rec.updatedAt = now;
  writeFileSync(file, JSON.stringify(rec));
  // 轮次落定（真机时序：尾批此时还在聚合缓冲——settle 前冲刷是保序不变量）
  eventBus.emit(EVENTS.TURN_SETTLED, { sessionId: sid });
  // 迟到无锚 delta（settle 处理完成后）：活轮记账被重新点亮——force 欠账拉的靶
  setTimeout(() => {
    const lateEnv = envelopeMod.makeEnvelope('chat.event', myBox, peerBox, {
      kind: 'delta', text: 'e2e 迟到尾巴（无锚）', sessionId: sid, beat: 9,
    });
    const lateWire = envelopeMod.encryptEnvelope(secrets.keyD2M, peerBox, 'd2m', lateEnv);
    if (lateWire) {
      void http.request('POST', `/box/${peerBox}`, { token: secrets.writeToken, body: { blob: lateWire } });
      console.log('[desk] late unanchored delta sent（expect force 尾拉不受活轮守卫拦截）');
    }
  }, 300);
}

/**
 * M7 增量 1 团队板一幕（+12s 定时）：临时团队登记归属本会话 + 挂两条待认领。
 * 时机刻意压在早期板计数不变量断言（needsYou 计数 / strip 焦点批次）之后，且此时手机附着已切到
 * 'new' 会话——团队板变更推送被附着门控（决策 15）正当挡掉；手机末尾"重附着回 s1 + chat.sync
 * 的 resyncBoard 全量"是收敛口（全量推送把并集投影整个带回，不依赖数值 rev 单调）。
 */
async function runTeamBoardScene(): Promise<void> {
  console.log('[desk] team board scene start（expect 手机并集：2 行待认领 + strip 0/2）');
  await teamSvc.formFromDefinition(
    { name: 'e2e-team', version: 1, members: [{ agent: 'explore' }] } as never,
    'e2e-s1',
  );
  await teamSvc.boardPost({ title: 'e2e 团队待认领甲', description: '团队板发帖说明', createdBy: 'lead' });
  await teamSvc.boardPost({ title: 'e2e 团队待认领乙', description: '团队板发帖说明', createdBy: 'lead' });
  const st = teamSvc.getActiveTeam();
  console.log(
    `[desk] team board scene ready: runId=${st?.runId ?? '∅'} 归属=${st?.sessionId ?? '∅'} 行=${teamSvc.boardList()?.items.length ?? 0}`,
  );
}

bridge.start();
await transport.connect();
bridge.announceAttachReset();
console.log('[desk] bridge connected');

// M8 D8：未知信封类型静默容忍靶（数据前向兼容——未来桌面推新类型，旧手机必须 ACK 忽略不断链；
// 手机侧"后续步骤仍全过"即容忍的运行时证明）
setTimeout(() => {
  const unkEnv = envelopeMod.makeEnvelope('cmd.progress', myBox, peerBox, { anything: 1 });
  const unkWire = envelopeMod.encryptEnvelope(secrets.keyD2M, peerBox, 'd2m', unkEnv);
  if (unkWire) {
    void http.request('POST', `/box/${peerBox}`, { token: secrets.writeToken, body: { blob: unkWire } });
    console.log('[desk] unknown-type cmd.progress sent（expect phone silent-ACK ignore）');
  }
}, 800);

// M7 增量 1：团队板一幕（+12s——见 runTeamBoardScene 注释的时机论证）
setTimeout(() => {
  void runTeamBoardScene().catch((err) => console.log('[desk] team board scene 失败', err));
}, 12_000);

// M7 增量 2：重派复用同一行一幕（+25s 第 1 次尝试失败回流 → +28.5s 带 board_item_id 重派成功）
// 手机侧在两拍之间断言「待重派」徽章（判据分流），之后断言"该活仅一行 + 终态已交付 + 失败史留存"（幽灵不可现）。
// 时序注：本幕原 +15s/+18.5s，会把 strip 焦点在团队板 0/2 窗口（+12s 起）落定前切走——手机"团队板行并入"
// 步（重附着+全量收敛路径）到达时焦点已是本批/已结项，窗口只有 ~3s 一碰就碎（run-3/4 实测连挂）；
// 推迟到 +25s/+28.5s 让团队板 0/2 窗口宽到 13s，且与手机步骤顺序（先团队板并入、后重派断言）对齐
const REDO_TITLE = 'e2e 会被重派的活';
let redoItemId = '';
setTimeout(() => {
  void (async () => {
    try {
      const posted = await boardSvc.autoPostAndClaim({
        sessionId: 'e2e-s1',
        batchId: 'e2e-redo-batch',
        taskId: 'tc-e2e-redo',
        subagentType: 'explore',
        title: REDO_TITLE,
        description: '第一轮尝试（将失败）',
      });
      redoItemId = posted?.item.id ?? '';
      console.log(`[desk] redo ①：挂项并认领 [${redoItemId}]`);
      await boardSvc.settleByTaskId('tc-e2e-redo', 'failed');
      console.log('[desk] redo ①：第 1 次尝试失败 → 回流认领池（expect 手机「待重派」+ 交付失败(第 1 次)）');
    } catch (err) {
      console.log('[desk] redo ① 失败', err);
    }
  })();
}, 25_000);
setTimeout(() => {
  void (async () => {
    try {
      if (!redoItemId) return;
      await boardSvc.attachAttempt('e2e-s1', redoItemId, {
        claimedByTaskId: 'tc-e2e-redo-2',
        subagentType: 'explore',
      });
      console.log(`[desk] redo ②：带 board_item_id 重派 → 同一行第二次尝试 [${redoItemId}]（不新增行）`);
      await boardSvc.settleByTaskId('tc-e2e-redo-2', 'completed', { result: '第二轮交付：重派成功' });
      console.log('[desk] redo ②：第二次尝试交付 → 同一行结项（expect 手机仅一行、已交付、带失败史）');
    } catch (err) {
      console.log('[desk] redo ② 失败', err);
    }
  })();
}, 28_500);

// 存活等待（手机侧跑完后由编排方 kill）
// d→m 场景判负数据源：发送已触发但回执未 ok（超时/失败/异常）→ SIGTERM 退出码 2（回执是送达的唯一真相源）
let d2mSent = false;
let d2mReceiptOk = false;
let d2mReceiptEventOk = false; // FILE_RECEIPT 事件旁证（wiring 转发链）
eventBus.on(EVENTS.FILE_RECEIPT, (p: { fileId: string; ok: boolean; error?: string }) => {
  console.log(`[desk] FILE_RECEIPT event: ${JSON.stringify(p)}`);
  if (p.ok) d2mReceiptEventOk = true;
});

/** d→m 文件往返一幕（手机 E2E_SEND_FILE 魔法消息触发；600KB=2 片分片路径，矢量公式与手机侧一致） */
async function runFileSendScene(): Promise<void> {
  try {
    const size = 600 * 1024;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 17 + 5) % 251;
    const fp = join(workDir, 'e2e-d2m-report.bin');
    writeFileSync(fp, Buffer.from(payload));
    d2mSent = true;
    const { fileId, expiresAt } = await bridge.sendFileToMobile({
      path: fp,
      sessionId: 'e2e-s1',
      onProgress: (s: number, t: number) => console.log(`[desk] d2m upload ${s}/${t}`),
    });
    console.log(`[desk] d2m offer sent: fileId=${fileId} expiresAt=${new Date(expiresAt).toISOString()}（expect 手机 fileOffer 卡 → 拉取解密 → receipt ok）`);
    const r = await bridge.waitFileReceipt(fileId, 120_000);
    d2mReceiptOk = r?.ok === true;
    console.log(`[desk] d2m receipt: ${JSON.stringify(r ?? '超时')}`);
  } catch (e) {
    console.log('[desk] d2m 发送异常:', e);
  } finally {
    if (d2mSent) {
      // d→m 是收官场景：回执落定后留 8s 给手机收尾断言，桌面按结果自行退出。
      // （Windows 下 MSYS kill 对原生 node.exe 只能 TerminateProcess——SIGTERM 处理器收不到，
      //  "两侧退出码均 0"语义只能靠自行退出承载；SIGTERM 处理器保留为 POSIX 兜底）
      // 裁决卡原地翻页一幕同闸计入：收卷落定 + 落账核对缺一判负
      const courtOk = courtSettledOk && courtLedgerOk;
      setTimeout(() => {
        console.log(`[desk] DESK_DONE (receiptOk=${d2mReceiptOk} eventOk=${d2mReceiptEventOk} courtSettled=${courtSettledOk} courtLedger=${courtLedgerOk})`);
        process.exit(d2mReceiptOk && d2mReceiptEventOk && courtOk ? 0 : 2);
      }, 8000);
    }
  }
}

process.on('SIGTERM', () => process.exit((d2mSent && !(d2mReceiptOk && d2mReceiptEventOk)) || !(courtSettledOk && courtLedgerOk) ? 2 : 0));
setInterval(() => {}, 60_000);
