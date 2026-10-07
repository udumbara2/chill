/**
 * e2e-node.mts — 用 App 真实 session.ts 对本机 ws 中继跑协议全链路（先于真机包）。
 * 用法：
 *   node --experimental-transform-types --import ./scripts/e2e-harness/registerHook.mjs \
 *     scripts/e2e-harness/e2e-node.mts pair <qrJsonPath>   # 配对 + 收发
 *   ... resume                                             # 恢复态上线收离线留言
 *   ... sync <qrJsonPath> <workDir>                        # M6：pair → catalog 全量 → attach →
 *                                                          #   history 拉取 → 发言收流 → 尾部拉齐
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import { RelaySession, type FileCardInfo } from '../../src/relay/session';
import type { AskTriageCard, WorkPlanItemWire } from '../../src/relay/envelope';
import { validateTriageCard } from '../../src/screens/triageLogic';
import { getSyncDb, closeSyncDb } from '../../src/db/syncDb';
// 与 resolve-hook 重定向同一份模块实例（session.ts 的 'react-native' → 本桩）：
// d→m 场景把 MediaStoreModule 交付桩挂进 NativeModules（Node 无原生模块，真机走 Kotlin 实现）
import { NativeModules as rnNativeModules } from './react-native-stub.mts';

(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;

// ---------- 媒体直传 XHR shim（Node e2e 专用——RN 运行时天然有 XHR，Node 没有） ----------
// 复刻 putMedia/putChunk 用到的最小 XHR 面（open/setRequestHeader/send/upload.onprogress/
// onreadystatechange/status/responseText）；覆盖 http/https、进度一次性 100%、v2 offset 头。
(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class XhrShim {
  status = 0;
  readyState = 0;
  timeout = 0;
  responseText = '';
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private method = 'GET';
  private url = '';
  private headers: Record<string, string> = {};
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  send(body?: Uint8Array): void {
    const u = new URL(this.url);
    const mod = u.protocol === 'https:' ? https : http;
    const buf = body ? Buffer.from(body) : undefined;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: this.method,
        headers: { ...this.headers, ...(buf ? { 'content-length': String(buf.length) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          this.status = res.statusCode ?? 0;
          this.responseText = Buffer.concat(chunks).toString('utf8');
          this.readyState = 4;
          if (buf) this.upload.onprogress?.({ lengthComputable: true, loaded: buf.length, total: buf.length });
          this.onreadystatechange?.();
        });
      },
    );
    req.on('error', () => {
      this.status = 0;
      this.readyState = 4;
      this.onreadystatechange?.();
    });
    if (buf) req.write(buf);
    req.end();
  }
};

const mode = process.argv[2];
const session = new RelaySession();
let pairedAt = 0;

const log = (...a: unknown[]) => console.log('[app-side]', ...a);
const fail = (msg: string): never => {
  console.error('[app-side] E2E_FAIL:', msg);
  process.exit(2);
};
/** 步骤看门狗：cond 在 timeout 内满足（轮询 100ms）否则判负 */
async function waitStep(name: string, cond: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) {
      log(`step ✔ ${name}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`步骤超时: ${name}`);
}

// ---------- M6 sync 场景的断言状态 ----------
let catalogSessions = 0;
let attachedConfirmed = false;
let historyRows = 0;
let gotDelta = false;
let gotFinal = false;
/** 裁决卡 additive 字段过线断言（ask.request.card → validateTriageCard 接受） */
let gotTriageCard = false;
/** 裁决卡原地翻页场景：开庭卡捕获（inplace+batch 双标记区分于 V3 固定卡） */
let courtAsk: { askId: string; card: AskTriageCard } | null = null;
let tailedRow = false;
/** M6b 'new' 场景断言状态 */
let newAttachedId: string | null = null;
let gotNewFinal = false;
let newInCatalog = false;
/** M7 增量 3：轮次失败回执断言（桥 settle 失败 → notice「本轮处理失败」） */
let gotFailNotice = false;
/** 本地镜像轮实时流断言（规划 v2 T4 运行时实证）：无锚 delta 经合成锚聚合显示（stream-mirror-*）。
 *  修复前：无锚 delta 被 processChatEvent 丢弃（「桌面恒定带锚」错误假设）→ 此断言永假；
 *  修复后：合成轮次锄归位渲染 → 真。桌面侧本地轮一幕（+9s）供给无锚流。 */
let gotMirrorDelta = false;
/** M8 命令面断言状态：cmd.result 回流捕获（replyTo 幂等匹配；M2 断言 request→result→state 序列） */
let cmdResultInfo: { replyTo: string; ok: boolean; code?: string } | null = null;
let cmdResultData: Record<string, unknown> | undefined;
const SYNC_TARGET = 'e2e-s1';
const SYNC_TEXT = 'e2e 同步测试：你好电脑';
const NEW_TEXT = 'e2e 新会话第一句';
const LONG_TEXT = 'E2E_LONG_ROUND';
/** 消息接管根治断言状态：发送气泡 id（= chat.user 信封 id）按文本捕获，与 DB 行 clientId 对账 */
const bubbleIds = new Map<string, string>();
/** 长轮页预算截断证据：尾部拉齐的最新页（工具行≥10）不含长轮用户行 → 置真（随后连续性链补拉愈合） */
let longGapSeen = false;
/** M7 增量 2：桌面会在 +15s/+18.5s 演"失败回流 → 带 board_item_id 重派成功"的同一条活 */
const REDO_TITLE = 'e2e 会被重派的活';
/** 工作计划树（workplan.* MVP）：workplan.state 落库事件计数（对账应答到达的观测信号） */
let workplanEvents = 0;

session.on((e) => {
  if (e.type === 'state') {
    log('state:', e.state, e.detail ?? '');
    if (e.state === 'paired') {
      pairedAt = Date.now();
      if (mode === 'pair') {
        void (async () => {
          // 等桌面 --say 的消息先到的窗口，然后回发
          setTimeout(() => {
            void session.sendChat('手机→桌面：你好电脑').then(() => log('sent: 手机→桌面：你好电脑'));
          }, 1500);
        })();
      }
    }
    if (e.state === 'conflict' || e.state === 'expired' || e.state === 'error') process.exit(2);
  } else if (e.type === 'message') {
    log(`msg[${e.message.dir}][${e.message.kind}]:`, e.message.text.slice(0, 80));
    if (mode === 'sync') {
      if (e.message.dir === 'out') bubbleIds.set(e.message.text, e.message.id); // 气泡 id=信封 id（clientId 对账源）
      if (e.message.kind === 'delta') gotDelta = true;
      if (e.message.kind === 'delta' && e.message.id.startsWith('stream-mirror-')) gotMirrorDelta = true;
      if (e.message.kind === 'final' && e.message.text.includes('e2e 回复')) gotFinal = true;
      if (e.message.kind === 'final' && e.message.text.includes(NEW_TEXT)) gotNewFinal = true;
      if (e.message.kind === 'notice' && e.message.text.includes('本轮处理失败')) gotFailNotice = true;
      // 裁决卡字段过线断言（additive card：ask.request 携带 card → validateTriageCard 必须接受）
      if (e.message.kind === 'ask' && e.message.ask?.card && validateTriageCard(e.message.ask.card)) {
        gotTriageCard = true;
        // 原地翻页场景：开庭卡捕获（inplace 能力声明 + batch 游标，区分于 V3 固定卡）
        if (e.message.ask.card.inplace === true && e.message.ask.card.batch) {
          courtAsk = { askId: e.message.ask.id, card: e.message.ask.card };
        }
      }
    }
  } else if (e.type === 'connection') {
    log('connection:', e.connected);
  } else if (e.type === 'alarm') {
    log('ALARM:', e.text);
  } else if (e.type === 'cmdResult') {
    cmdResultInfo = { replyTo: e.replyTo, ok: e.ok, code: e.error?.code };
    cmdResultData = e.data;
    log('cmdResult:', JSON.stringify(cmdResultInfo));
  } else if (e.type === 'peer') {
    log('peer:', e.name);
  } else if (e.type === 'catalog' && mode === 'sync') {
    void (async () => {
      const rows = await getSyncDb().listSessions(session.getAgentId());
      catalogSessions = rows.length;
      if (newAttachedId !== null && rows.some((r) => r.sessionId === newAttachedId)) newInCatalog = true;
      log('catalog landed: sessions =', catalogSessions, rows.map((r) => `${r.title}@${r.projectId ?? '未分组'}`).join(', '));
    })();
  } else if (e.type === 'attached' && mode === 'sync') {
    log('attached.changed:', e.sessionId);
    if (e.sessionId === SYNC_TARGET) attachedConfirmed = true;
    // M6b 'new'：轮前附着回流的真实新会话 id（≠ 已知 fixture 会话）
    if (e.sessionId !== null && e.sessionId !== SYNC_TARGET && e.sessionId.startsWith('e2e-new-')) newAttachedId = e.sessionId;
  } else if (e.type === 'history' && mode === 'sync') {
    void (async () => {
      const rows = await getSyncDb().listMessages(session.getAgentId(), e.sessionId);
      historyRows = rows.length;
      if (rows.some((r) => r.text.includes(`e2e 回复：${SYNC_TEXT}`))) tailedRow = true;
      // 页预算截断证据：长轮工具行已落库但用户行尚未进窗（连续性链补拉前的豁口态）
      if (rows.filter((r) => r.msgKey.startsWith('tool:tc-long-')).length >= 10 && !rows.some((r) => r.role === 'user' && r.text === LONG_TEXT)) longGapSeen = true;
      log(`history landed: ${e.sessionId} rows=${rows.length}`);
    })();
  } else if (e.type === 'activeSession' && mode === 'sync') {
    log('activeSession:', e.sessionId);
  } else if (e.type === 'board' && mode === 'sync') {
    log('board landed:', e.sessionId);
  } else if (e.type === 'workplan' && mode === 'sync') {
    workplanEvents += 1;
    log('workplan landed:', e.sessionId, `(#${workplanEvents})`);
  } else if (e.type === 'feed' && mode === 'sync') {
    log('feed landed:', e.taskId ?? '(无任务)');
  }
});

// ---------- M7 看板断言辅助（waitStep 直查副本库） ----------
const boardRowsOf = async (sessionId: string) =>
  getSyncDb().listBoardItems(session.getAgentId(), sessionId);
const boardMetaOf = async (sessionId: string) =>
  getSyncDb().getBoardMeta(session.getAgentId(), sessionId);

if (mode === 'pair') {
  const qr = readFileSync(process.argv[3]!, 'utf8');
  await session.pair(qr);
} else if (mode === 'resume') {
  await session.start();
} else if (mode === 'sync') {
  // DB 落 workDir（隔离；不碰仓库目录）
  process.chdir(process.argv[4]!);
  const qr = readFileSync(process.argv[3]!, 'utf8');
  await session.pair(qr);
  // 前台探活（真实 App 前台语义）：presence ping 携带 caps=['file-recv']——
  // 桌面 d→m 发送的 caps 门以此放行（不发 ping = 桌面诚实报"手机尚未上线"）
  session.setPresenceActive(true);

  // pair → catalog 全量（冷启动对账自动发 catalog.sync → 桌面回 full）
  await waitStep('paired', () => pairedAt > 0, 90_000);
  await waitStep('catalog 全量落库（≥2 会话）', () => catalogSessions >= 2);

  // ---------- M8 命令面：连接自动发 cmd.sync → cmd.state 全量+目录落定（含 D8 未知类型容忍——后续步骤仍过即证明） ----------
  await waitStep('cmd.state 落定（快照+目录）', () => session.getCommandState() !== null && session.getCommandCatalog() !== null, 30_000);
  {
    const s = session.getCommandState()!;
    const cat = session.getCommandCatalog()!;
    if (s.model?.name !== 'GLM-5.3' || s.model.effort !== 'high') fail(`cmd.state model 不符: ${JSON.stringify(s.model)}`);
    if (s.ctx?.used !== 48200 || s.ctx?.max !== 200000) fail(`cmd.state ctx 不符: ${JSON.stringify(s.ctx)}`);
    if (s.sessionId !== 'e2e-s1') fail(`cmd.state sessionId 不符: ${s.sessionId}`);
    if (cat.length < 10) fail(`catalog 条目不足: ${cat.length}`);
    if (cat.some((c) => c.id === 'model.list' || c.id === 'front.list')) fail('internal 选项源不应出现在目录');
    log('cmd.state/catalog ✔（快照口径 + internal 排除 + 未知类型已容忍）');
  }
  // ---------- M2 命令执行闭环：request→result→state 序列（落定唯一来源 cmd.state 回流） ----------
  await session.sendCmdRequest('e2e-req-1', 'model.list');
  await waitStep('model.list 应答（options）', () => cmdResultInfo?.replyTo === 'e2e-req-1' && cmdResultInfo.ok === true, 30_000);
  {
    const options = (cmdResultData?.['options'] as Array<{ name: string; efforts: string[] }>) ?? [];
    if (options.length !== 2) fail(`model.list options 不符: ${JSON.stringify(options)}`);
    const glm = options.find((o) => o.name === 'GLM-5.3');
    const kimi = options.find((o) => o.name === 'Kimi-K3');
    if (!glm?.efforts.includes('max')) fail(`GLM efforts 不符: ${JSON.stringify(glm)}`);
    if (!kimi?.efforts.includes('xhigh')) fail(`Kimi efforts 不符（枚举随模型定义）: ${JSON.stringify(kimi)}`);
    log('model.list ✔（惰性拉取 + 枚举随模型）');
  }
  await session.sendCmdRequest('e2e-req-2', 'model.set', { name: 'Kimi-K3' });
  await waitStep('model.set 应答 ok', () => cmdResultInfo?.replyTo === 'e2e-req-2' && cmdResultInfo.ok === true, 30_000);
  await waitStep('cmd.state 回流落定（model.name=Kimi-K3，执行后必推）', () => session.getCommandState()?.model?.name === 'Kimi-K3', 30_000);
  await session.sendCmdRequest('e2e-req-3', 'model.param', { param: 'reasoning_effort', value: 'xhigh' });
  await waitStep('model.param 应答 ok', () => cmdResultInfo?.replyTo === 'e2e-req-3' && cmdResultInfo.ok === true, 30_000);
  await waitStep('cmd.state 回流落定（effort=xhigh）', () => session.getCommandState()?.model?.effort === 'xhigh', 30_000);
  await session.sendCmdRequest('e2e-req-4', 'turn.stop');
  await waitStep('turn.stop 应答 ok（abort 空转幂等）', () => cmdResultInfo?.replyTo === 'e2e-req-4' && cmdResultInfo.ok === true, 30_000);
  {
    const s = session.getCommandState()!;
    if (s.model?.name !== 'Kimi-K3' || s.model.effort !== 'xhigh') fail(`命令面终态不符: ${JSON.stringify(s.model)}`);
    log('M2 命令闭环 ✔（request→result→state 三段全过，终态 Kimi-K3·xhigh）');
  }

  // ---------- M3 前台/规划/压缩 ----------
  await session.sendCmdRequest('e2e-req-5', 'front.list');
  await waitStep('front.list 应答（本地模板候选）', () => cmdResultInfo?.replyTo === 'e2e-req-5' && cmdResultInfo.ok === true, 30_000);
  {
    const options = (cmdResultData?.['options'] as Array<{ type: string }>) ?? [];
    if (!options.some((o) => o.type === 'coder')) fail(`front.list 候选不符: ${JSON.stringify(options)}`);
  }
  await session.sendCmdRequest('e2e-req-6', 'front.set', { type: 'coder' });
  await waitStep('front.set 应答 ok', () => cmdResultInfo?.replyTo === 'e2e-req-6' && cmdResultInfo.ok === true, 30_000);
  await waitStep('cmd.state 回流（front=coder）', () => session.getCommandState()?.front === 'coder', 30_000);
  await session.sendCmdRequest('e2e-req-7', 'front.set', { type: null });
  await waitStep('front.set(null) 应答 + 回流（front=null 裸模型）', async () => {
    if (cmdResultInfo?.replyTo !== 'e2e-req-7' || !cmdResultInfo.ok) return false;
    return session.getCommandState()?.front === null;
  }, 30_000);
  await session.sendCmdRequest('e2e-req-8', 'plan.set', { on: true });
  await waitStep('plan.set(on) 应答 + 回流（plan=true）', async () => {
    if (cmdResultInfo?.replyTo !== 'e2e-req-8' || !cmdResultInfo.ok) return false;
    return session.getCommandState()?.plan === true;
  }, 30_000);
  await session.sendCmdRequest('e2e-req-9', 'plan.set', { on: false });
  await waitStep('plan.set(off) 应答 + 回流（plan=false）', async () => {
    if (cmdResultInfo?.replyTo !== 'e2e-req-9' || !cmdResultInfo.ok) return false;
    return session.getCommandState()?.plan === false;
  }, 30_000);
  await session.sendCmdRequest('e2e-req-10', 'compact', { guidance: 'e2e 保留登录细节' });
  await waitStep('compact 应答 ok + ctx 回流（approx 估值空窗口径）', async () => {
    if (cmdResultInfo?.replyTo !== 'e2e-req-10' || !cmdResultInfo.ok) return false;
    const ctx = session.getCommandState()?.ctx;
    return ctx?.used === 9100 && ctx.approx === true && ctx.max === 200000;
  }, 30_000);
  log('M3 命令闭环 ✔（front/plan/compact 全过，ctx=约 9.1k/200k approx）');

  // ---------- M4 目标生命周期：set（设定即开工）→ pause → resume → abandon ----------
  await session.sendCmdRequest('e2e-req-11', 'goal.set', { objective: 'e2e 目标：修好登录', criteria: 'npm test 绿', maxRounds: 12 });
  await waitStep('goal.set 应答 ok + 回流（active 0/12）', async () => {
    if (cmdResultInfo?.replyTo !== 'e2e-req-11' || !cmdResultInfo.ok) return false;
    const g = session.getCommandState()?.goal;
    return g?.status === 'active' && g.round === 0 && g.maxRounds === 12 && g.objective === 'e2e 目标：修好登录';
  }, 30_000);
  await session.sendCmdRequest('e2e-req-12', 'goal.pause');
  await waitStep('goal.pause 应答 + 回流（paused）', async () => {
    if (cmdResultInfo?.replyTo !== 'e2e-req-12' || !cmdResultInfo.ok) return false;
    return session.getCommandState()?.goal?.status === 'paused';
  }, 30_000);
  await session.sendCmdRequest('e2e-req-13', 'goal.resume');
  await waitStep('goal.resume 应答 + 回流（active）', async () => {
    if (cmdResultInfo?.replyTo !== 'e2e-req-13' || !cmdResultInfo.ok) return false;
    return session.getCommandState()?.goal?.status === 'active';
  }, 30_000);
  await session.sendCmdRequest('e2e-req-14', 'goal.abandon');
  await waitStep('goal.abandon 应答 + 回流（goal=null 长条零渲染态）', async () => {
    if (cmdResultInfo?.replyTo !== 'e2e-req-14' || !cmdResultInfo.ok) return false;
    return session.getCommandState()?.goal === null;
  }, 30_000);
  log('M4 目标生命周期 ✔（set/pause/resume/abandon 全过）');

  // attach（请求-确认制）
  await session.sendAttach(SYNC_TARGET);
  await waitStep('attach 确认（attached.changed）', () => attachedConfirmed);

  // ---------- M7 看板：attach 后 board.sync 自动拉板 → boardItems 落库 + strip/needsYou 映射 ----------
  await waitStep('board.state 落库（s1 看板 ≥3 行，协议序）', async () => (await boardRowsOf(SYNC_TARGET)).length >= 3);
  await waitStep('strip/needsYou 映射（running 计数 1/3 + 要你信号）', async () => {
    const meta = await boardMetaOf(SYNC_TARGET);
    if (!meta?.stripJson || !meta.needsYouJson) return false;
    const strip = JSON.parse(meta.stripJson) as { status: string; countText: string; needsYou: boolean };
    const needs = JSON.parse(meta.needsYouJson) as { needed: boolean; count: number };
    return strip.status === 'running' && strip.countText === '1/3' && strip.needsYou === true && needs.needed === true && needs.count === 1;
  });
  {
    const rows = await boardRowsOf(SYNC_TARGET);
    const labels = rows.map((r) => r.label);
    if (!labels.includes('待认领') || !labels.includes('已交付')) fail(`行态 label 映射不符: ${labels.join(',')}`);
    const done = rows.find((r) => r.status === 'completed')!;
    if (!done.detailJson?.includes('自动结项')) fail(`自动结项标注缺失: ${done.detailJson}`);
    log('strip/needsYou/label 映射 ✔');
  }
  // 空板态：无板会话 board.state 全量空行（长条不显示的形态=rowCount 0）
  await session.sendBoardSync('e2e-no-board');
  await waitStep('空板态（无板会话 0 行 + meta 就位）', async () => {
    const rows = await boardRowsOf('e2e-no-board');
    const meta = await boardMetaOf('e2e-no-board');
    return rows.length === 0 && meta !== null;
  });

  // 级联清靶子：先拉 s2 看板行（1 行），稍后桌面删 s2 → session.deleted 级联清
  await session.sendBoardSync('e2e-s2');
  await waitStep('s2 看板行落库（级联清靶子）', async () => (await boardRowsOf('e2e-s2')).length >= 1);

  // history 拉取（fixture 会话 3 条消息）
  await session.sendHistoryRequest(SYNC_TARGET);
  await waitStep('history.page 落库（≥3 条）', () => historyRows >= 3);
  // 发言即附着 + 收流（delta/final 经 chat.event 实时镜像）
  await session.sendChat(SYNC_TEXT, SYNC_TARGET);
  await waitStep('收流 delta', () => gotDelta);
  await waitStep('收流 final', () => gotFinal);
  // 尾部拉齐：桌面轮落定落盘 → metadata.upsert → 拉齐 → DB 出现新行
  await waitStep('尾部拉齐（DB 出现新回复行）', () => tailedRow, 30_000);

  // 消息接管根治断言①：clientId 贯穿——DB 用户行 clientId === 气泡信封 id（env.id → 桥 → 引擎落盘 → history.page → 副本库）
  await waitStep('clientId 贯穿（DB 用户行 clientId === 气泡信封 id）', async () => {
    const rows = await getSyncDb().listMessages(session.getAgentId(), SYNC_TARGET);
    const userRow = rows.find((r) => r.role === 'user' && r.text === SYNC_TEXT);
    return userRow?.clientId != null && userRow.clientId === bubbleIds.get(SYNC_TEXT);
  }, 30_000);
  log('clientId 贯穿 ✔（气泡与 DB 行同身份——回声确认退休的匹配键）');

  // ---------- V3 需拍板/信号：ask 挂起 → 条目 blocked + needsYou 计数升（长条信号亮） ----------
  // 计数语义(V1.4 锁):待认领∪需拍板∪待裁决 ∪ pendingAsk ∪ pendingApproval——
  // 板联动 ask 同时体现为 blocked 行(1)与挂起 ask(1):1 待认领 + 1 需拍板 + 1 挂起 ask = 3
  await waitStep('需拍板：条目 blocked + needsYou 计数升到 3', async () => {
    const rows = await boardRowsOf(SYNC_TARGET);
    const meta = await boardMetaOf(SYNC_TARGET);
    const askRow = rows.find((r) => r.title === 'e2e 拍板活');
    const needs = meta?.needsYouJson ? (JSON.parse(meta.needsYouJson) as { count: number }) : null;
    return (
      askRow?.status === 'blocked' &&
      askRow.label === '需拍板' &&
      (askRow.detailJson ?? '').includes('blockedReason') &&
      needs?.count === 3
    );
  }, 30_000);

  // ---------- 裁决卡 additive 字段过线（ask.request.card → 手机形状校验接受） ----------
  await waitStep('裁决卡 card 字段过线（validateTriageCard 接受）', () => gotTriageCard, 30_000);

  // ---------- M7：级联清（桌面删 s2 → session.deleted → 看板行+meta 清空） ----------
  await waitStep('级联清（s2 看板行与 meta 清空）', async () => {
    const rows = await boardRowsOf('e2e-s2');
    const meta = await boardMetaOf('e2e-s2');
    return rows.length === 0 && meta === null;
  }, 30_000);
  // ---------- M7：rev LWW（桌面 300ms 时投过 rev=1 旧快照[含 stale-row]——旧 rev 不覆盖） ----------
  await waitStep('rev LWW（旧 rev 不覆盖：无 stale-row、真实行仍在）', async () => {
    const rows = await boardRowsOf(SYNC_TARGET);
    const meta = await boardMetaOf(SYNC_TARGET);
    return (
      rows.length >= 2 &&
      !rows.some((r) => r.itemId === 'stale-row') &&
      meta !== null &&
      Number(meta.rev) > 1
    );
  });
  log('rev LWW ✔（stale-row 被丢弃）');

  // ---------- V3 ask 落定恢复：条目回 in_progress + needsYou 计数回落（长条信号灭） ----------
  // 必须在 'new' 场景之前断言：'new' 轮前附着把桥切到新会话后，e2e-s1 的恢复推送会被附着门控（决策 15）正当挡掉
  await waitStep('ask 落定恢复：条目回 in_progress + needsYou 回落 1', async () => {
    const rows = await boardRowsOf(SYNC_TARGET);
    const meta = await boardMetaOf(SYNC_TARGET);
    const askRow = rows.find((r) => r.title === 'e2e 拍板活');
    const needs = meta?.needsYouJson ? (JSON.parse(meta.needsYouJson) as { count: number }) : null;
    return askRow?.status === 'in_progress' && askRow.label === '进行中' && needs?.count === 1;
  }, 30_000);

  // ---------- 断线重连板对账（chat.sync → resyncBoard 补推；PROTOCOL-FROZEN M4e 重连语义） ----------
  // 同样必须在 'new' 场景之前：'new' 轮前附着切桥后，附着门控（决策 15）会把 e2e-s1 的补推正当挡掉（V3 先例）。
  // 桌面在首轮 chat +6.5s 挂了「e2e 重连补挂」（推送正常到达）；手机随后清行+清 rev，
  // 造出「推送丢失/离线期间陈旧副本」的重连前状态（净状态与"推送从未到达"等价），
  // 再发 chat.sync（重连语义）→ 桌面 handleSyncPing → resyncBoard → board.state 全量 → 收敛到桌面真相。
  await waitStep('重连补挂条目经推送到达（重连前基线）', async () =>
    (await boardRowsOf(SYNC_TARGET)).some((r) => r.title === 'e2e 重连补挂'),
  );
  const rowsBeforeWipe = (await boardRowsOf(SYNC_TARGET)).length;
  const revBeforeWipe = (await boardMetaOf(SYNC_TARGET))?.rev ?? '0';
  if (rowsBeforeWipe < 4) fail(`重连前基线异常：${rowsBeforeWipe} 行`);
  await getSyncDb().clearBoardItems(session.getAgentId(), SYNC_TARGET);
  await getSyncDb().putBoardMeta({
    agentId: session.getAgentId(),
    sessionId: SYNC_TARGET,
    rev: '0',
    stripJson: null,
    needsYouJson: null,
    windowed: 0,
    updatedAt: new Date().toISOString(),
  });
  if ((await boardRowsOf(SYNC_TARGET)).length !== 0) fail('重连前状态未造出（行未清空）');
  log(`重连前状态已造出：0 行 / rev 0（基线 ${rowsBeforeWipe} 行 / rev ${revBeforeWipe}）`);

  await session.sendSyncPing(); // 重连语义：chat.sync → 桌面 ACK 后从真相源重推（含 resyncBoard）
  await waitStep('断线重连板对账：board.state 全量收敛（行数/rev/关键字段一致）', async () => {
    const rows = await boardRowsOf(SYNC_TARGET);
    const meta = await boardMetaOf(SYNC_TARGET);
    return (
      rows.length === rowsBeforeWipe &&
      rows.some((r) => r.title === 'e2e 重连补挂') &&
      meta?.rev === revBeforeWipe
    );
  }, 30_000);
  // full=true 到达的运行时证明：行集清空后只有 full=true 的 board.state 能带回行
  // （协议：full=false 为纯确认、rows 恒空——0→N 的恢复即 full=true 已到达）
  log(`断线重连板对账 ✔（${rowsBeforeWipe} 行 / rev ${revBeforeWipe} 全量恢复）`);

  // ---------- 裁决卡单卡原地翻页（improve 召唤 → inplace 卡 → improve.page 翻页落账 → 收卷） ----------
  // 时机论证：置于断线重连对账之后（chat.sync 的 resyncPendingAsks 不会重推开庭卡干扰捕获）、
  // 'new' 场景之前（附着仍在 e2e-s1，魔法核对消息走附着会话）；桌面退出码兜底收卷/落账双闸。
  {
    // ① 召唤开庭（cmd 通道真实路径：catalog 的 improve 行 → 桌面开庭 → ask.request 推卡）
    const summon = await session.requestCmd('e2e-improve-1', 'improve', {});
    if (!summon.ok) fail(`improve 召唤失败: ${JSON.stringify(summon.error)}`);
    if (summon.data?.['court'] !== 'issued') fail(`improve 回执不符: ${JSON.stringify(summon.data)}`);
    await waitStep('裁决卡开庭到达（inplace:true + batch 游标 + validateTriageCard 接受）', () => courtAsk !== null, 30_000);
    const court = courtAsk as unknown as { askId: string; card: AskTriageCard };
    const card = court.card;
    if (card.inplace !== true) fail('裁决卡缺 inplace 能力声明');
    if (!card.batch || card.batch.offset !== 0 || card.batch.total !== 25) fail(`裁决卡游标不符: ${JSON.stringify(card.batch)}`);
    const firstCluster = card.clusters[0]!;
    const firstTitle = firstCluster.entries?.[0]?.title ?? '';
    if (!firstTitle) fail('裁决卡首簇无 entries（降级链应保留 {n,title}）');

    // ② 原地翻页：本页点选（确认首簇）随翻页先落账，cmdResult 返回新页卡
    const turn = await session.requestCmd('triage-page-e2e', 'improve.page', {
      dir: 'next',
      decisions: [{ action: 'confirm', clusterId: firstCluster.id }],
    });
    if (!turn.ok) fail(`improve.page 翻页失败: ${JSON.stringify(turn.error)}`);
    const nextCard = validateTriageCard(turn.data?.['card']);
    if (!nextCard) fail('新页卡未过 validateTriageCard');
    if (!nextCard.batch || nextCard.batch.offset !== card.clusters.length) {
      fail(`新页卡游标不符: ${JSON.stringify(nextCard.batch)}（期望 offset=${card.clusters.length}）`);
    }
    if (nextCard.inplace !== true) fail('新页卡缺 inplace');
    log(`原地翻页 ✔（${card.clusters.length} 簇页 → offset ${nextCard.batch!.offset}；首簇 ${firstCluster.id} 随翻页确认落账）`);

    // ③ 落账核对（桌面读临时账本断言首簇条目进「已确认」区；核对结果计入桌面退出码）
    await session.sendChat(`E2E_VERIFY_COURT ${firstTitle}`, SYNC_TARGET);
    await new Promise((r) => setTimeout(r, 800)); // 给桌面一拍核对（退出码兜底，手机不等回执）

    // ④ 收卷（「完成本轮」语义）：sendAskResponse 带累计文本 + 剩余 decisions（跳过新页首簇）
    await session.sendAskResponse(court.askId, `y ${firstCluster.id}（翻页已落账） s ${nextCard.clusters[0]!.id}`, [
      { action: 'skip', clusterId: nextCard.clusters[0]!.id },
    ]);
    log('裁决卡收卷已发（ask 落定由桌面退出码兜底断言）');
    log('裁决卡单卡原地翻页 ✔（召唤 → inplace 卡 → 翻页落账 → 新页卡 → 收卷）');
  }

  // ---------- 本地轮总结同步（真机 bug2：桌面发起的轮无 final，总结/占位改写只能靠 round.settled 尾拉） ----------
  // 桌面 +9s 跑本地轮（无锚流式尾巴 + 工具占位 + 落盘总结/占位改写 + settle），settle 后 +300ms
  // 还有一发迟到无锚 delta 重新点亮活轮记账——settle 触发的尾拉必须 force，否则这唯一一次尾拉
  // 被永久跳过、总结永远到不了手机（真机症状）。
  // 规划 v2 T4 实证前置：实时流必须已经合成锄渲染到达（修复前此步红=丢弃，修复后绿=显示）。
  await waitStep('本地轮实时流经合成锄显示（stream-mirror-*）', () => gotMirrorDelta, 30_000);
  log('本地轮实时流 ✔（合成锄：修复前丢弃/修复后显示——T4 运行时实证）');
  await waitStep('本地轮总结 + 占位改写经尾拉落库', async () => {
    const rows = await getSyncDb().listMessages(session.getAgentId(), SYNC_TARGET);
    return (
      rows.some((r) => r.text.includes('e2e 本地轮总结')) &&
      rows.some((r) => r.text.includes('e2e 占位改写结果'))
    );
  }, 30_000);
  log('本地轮总结同步 ✔（force 尾拉：迟到冲刷未杀掉尾拉）');

  // ---------- M6b 'new' 场景：新会话发言 → 桌面自动建会话 → 轮前附着 → 收流 → 目录出现 ----------
  await session.sendChat(NEW_TEXT, 'new');
  await waitStep("'new' 轮前附着回流真实 id", () => newAttachedId !== null);
  await waitStep("新会话收流 final", () => gotNewFinal);
  await waitStep('catalog 出现新会话（session.created 落库）', () => newInCatalog, 30_000);

  // ---------- V2：feed 事实流归并（latest-wins;跨窗乱序旧帧被丢弃） + 点行明细数据 ----------
  await new Promise((r) => setTimeout(r, 1500)); // 等跨窗旧帧（t≈2.8s）投递完毕再断言
  await waitStep('feed overlay 归并（tc-f1→success / tc-f2→failed,旧帧丢弃）', () => {
    const facts = session.getFeedFacts('tc-e2e-board');
    const f1 = facts.find((f) => f.toolCallId === 'tc-f1');
    const f2 = facts.find((f) => f.toolCallId === 'tc-f2');
    return facts.length === 2 && f1?.status === 'success' && f2?.status === 'failed';
  }, 30_000);
  {
    const rows = await boardRowsOf(SYNC_TARGET);
    const row = rows.find((r) => (r.detailJson ?? '').includes('tc-e2e-board'));
    if (!row) fail('点行明细数据缺位：board 行无 claimedByTaskId');
    log('feed 归并 + 点行明细数据 ✔');
  }

  // ---------- M7 增量 1：团队板并入（团队板独立 CAS → 并集投影；full=true 全量收敛） ----------
  // 桌面 +12s 建临时团队（归属 e2e-s1）并挂两条待认领：此刻桥已随 'new' 场景切走附着，
  // 团队板变更推送被附着门控（决策 15）正当挡掉——手机重附着回 s1 再 chat.sync 触发
  // resyncBoard 全量补推即收敛。不断言 rev：团队板是独立 CAS，数值 rev 无法表达并集
  // （core 侧含团队板行一律 full=true 的协议后果）。
  attachedConfirmed = false;
  await session.sendAttach(SYNC_TARGET);
  await waitStep('重附着回 e2e-s1（团队板收口前置）', () => attachedConfirmed, 20_000);
  let teamPings = 0;
  await waitStep('团队板行并入（2 行待认领 + strip 聚焦团队批 0/2）', async () => {
    const rows = await boardRowsOf(SYNC_TARGET);
    const a = rows.find((r) => r.title === 'e2e 团队待认领甲');
    const b = rows.find((r) => r.title === 'e2e 团队待认领乙');
    const meta = await boardMetaOf(SYNC_TARGET);
    const strip = meta?.stripJson ? (JSON.parse(meta.stripJson) as { status: string; countText: string }) : null;
    const ok =
      a?.status === 'pending' && a.label === '待认领' &&
      b?.status === 'pending' && b.label === '待认领' &&
      strip?.status === 'running' && strip.countText === '0/2';
    if (!ok && teamPings < 15) {
      teamPings += 1;
      await session.sendSyncPing();
    }
    return ok;
  }, 40_000);
  log('团队板并入 ✔（并集投影 + 全量收敛；手机零协议改动）');

  // ---------- M7 增量 2：重派复用同一行（幽灵不可现） ----------
  // 桌面 +15s 让一条行第 1 次尝试失败（回流认领池）→ 手机应看到它显示「待重派」而不是「待认领」；
  // +18.5s 桌面带 board_item_id 重派成功 → 手机上它仍是**同一行**（终态已交付，进展行含第 1 次失败）。
  await waitStep('回流态行徽章=待重派（判据=带 system 留痕；不同轮召回池的"待认领"）', async () => {
    const rows = await boardRowsOf(SYNC_TARGET);
    const row = rows.find((r) => r.title === REDO_TITLE);
    return (
      row?.status === 'pending' && row.label === '待重派' && (row.detailJson ?? '').includes('交付失败(第 1 次)')
    );
  }, 30_000);
  await waitStep('带 board_item_id 重派后：该活仍只有一行、终态已交付、失败史留存', async () => {
    const rows = await boardRowsOf(SYNC_TARGET);
    const mine = rows.filter((r) => r.title === REDO_TITLE);
    if (mine.length !== 1) return false;
    const detail = mine[0]!.detailJson ?? '';
    return mine[0]!.status === 'completed' && detail.includes('重派成功') && detail.includes('交付失败(第 1 次)');
  }, 30_000);
  log('重派复用同一行 ✔（待重派徽章 → 同一行结项，幽灵不可现）');

  // ---------- M7 增量 3：轮次失败必有回执（永不沉默） ----------
  // 手机发魔法前缀消息：桌面假引擎 onIngested（收录+ACK）后抛错 → 手机必须收到
  // 「本轮处理失败」notice——收录后的失败不许再靠扣 ACK 表达（2026-09-26 事故根治项）。
  // 2026-10-05：改显式目标——缺省目标会路由到 desk active（此时已随 'new' 场景漂移到
  // e2e-new-*），notice 盖他会章被手机的他会展流过滤正确丢弃（跨会话渲染=串台本体，
  // 新 App 发消息永远显式目标；旧手机跑旧代码无过滤、legacy 兼容不受影响）。
  await session.sendChat('E2E_FAIL_ROUND：这轮注定失败', SYNC_TARGET);
  await waitStep('轮次失败 → notice 回执（已收录仍必有回音）', () => gotFailNotice, 20_000);
  log('轮次失败回执 ✔（ACK 已发仍回失败通知，无重投堆积）');

  // ---------- file.* 协议族：手机上传附件 → receipt → chat.user attachments → 媒体行落库 ----------
  // 压轴场景（置于全部既有场景之后：附件轮的 settled/板重推不再干扰团队板编排时间线——实测教训）。
  // 迭代 2 起走真实 sendWithAttachments（uploadAttachment 分解 API + receipt 门控的真实代码路径）。
  {
    let attachFinal = false;
    let attachNotice = '';
    const offAttach = session.on((e) => {
      if (e.type === 'message') {
        if (e.message.kind === 'final' && e.message.text.includes('附件轮完成')) attachFinal = true;
        if (e.message.kind === 'notice' && /附件/.test(e.message.text)) attachNotice = e.message.text;
      }
    });
    const payload = new TextEncoder().encode('e2e 附件内容：一张 1x1 的图');
    await session.sendWithAttachments(
      'E2E 附件消息（带图）',
      [{ fileId: 'e2e-file-1', name: 'e2e-photo.jpg', mime: 'image/jpeg', bytes: payload }],
      SYNC_TARGET,
    );
    await waitStep('附件轮 final（receipt ok 的可观测效果）', () => attachFinal || attachNotice !== '', 30_000);
    if (attachNotice) fail(`附件轮被拒：${attachNotice}`);
    offAttach();
    // 尾部拉齐后：DB 出现 media 行（attachmentRefs 消息 → kind=media；refsJson 落库断言属迭代 2）
    await waitStep('附件媒体行落库（kind=media）', async () => {
      const rows = await getSyncDb().listMessages(session.getAgentId(), SYNC_TARGET);
      return rows.some((r) => r.kind === 'media');
    }, 30_000);
    log('file.* 上传闭环 ✔（真实 sendWithAttachments：offer→chunk→receipt→attachments→media 行落库）');
  }

  // ---------- v2 大文件分片直传（fmt:2 确定性 nonce + offset 续传 + Range 分片拉取） ----------
  // blob-util mock（Node e2e 专用——真机由 src/relay/blobUtil.ts 惰性 require 真实模块兜底，
  // 此处注入仅覆盖默认值；曾假设"RN 运行时天然有 globalThis 挂名"，2026-09-28 d→m 拉取必败即此假设）：
  // 内存 FS（e2eFiles）承载 readStream（上传切片）与 d→m 拉取暂存五件套（appendFile/stat/hash/mv/unlink + dirs/isDir/mkdir）
  const e2eFiles = new Map<string, Uint8Array>();
  const e2eDirs = new Set<string>(['e2e://docs']);
  (globalThis as unknown as Record<string, unknown>)['ReactNativeBlobUtil'] = {
    fs: {
      dirs: { DocumentDir: 'e2e://docs' },
      readStream: (path: string, _enc: string, start: number, end: number) => ({
        open() {},
        onData(cb: (d: string) => void) {
          const bytes = e2eFiles.get(path);
          if (!bytes) throw new Error(`e2e blob-util: file not found ${path}`);
          cb(Buffer.from(bytes.subarray(start, end + 1)).toString('base64'));
        },
        onEnd(cb: () => void) { setTimeout(cb, 1); },
        onError(_cb: unknown) {},
      }),
      isDir: async (p: string) => e2eDirs.has(p),
      mkdir: async (p: string) => { e2eDirs.add(p); },
      // ls：文件名形态（对齐真机 File.list() 语义——条目无目录前缀）；目录不存在 reject
      // ENOENT（与真机前置检查同构，session 对账侧 catch 后跳过）；内存 map 键为全路径，
      // 提取 basename 返回。e2e 与真机同形态：归一化谓词以真实形态被覆盖，不掩盖差异
      ls: async (p: string) => {
        if (!e2eDirs.has(p)) throw new Error('ENOENT');
        const prefix = `${p}/`;
        const names = new Set<string>();
        for (const k of e2eFiles.keys()) {
          if (k.startsWith(prefix)) names.add(k.slice(prefix.length));
        }
        return [...names];
      },
      appendFile: async (p: string, b64: string, _enc: string) => {
        const cur = e2eFiles.get(p) ?? new Uint8Array(0);
        const add = new Uint8Array(Buffer.from(b64, 'base64'));
        const next = new Uint8Array(cur.length + add.length);
        next.set(cur);
        next.set(add, cur.length);
        e2eFiles.set(p, next);
      },
      stat: async (p: string) => {
        const b = e2eFiles.get(p);
        if (!b) throw new Error('ENOENT');
        return { size: b.length };
      },
      hash: async (p: string, _algo: string) => {
        const b = e2eFiles.get(p);
        if (!b) throw new Error('ENOENT');
        return createHash('sha256').update(Buffer.from(b)).digest('hex');
      },
      mv: async (from: string, to: string) => {
        const b = e2eFiles.get(from);
        if (!b) throw new Error('ENOENT');
        e2eFiles.set(to, b);
        e2eFiles.delete(from);
      },
      unlink: async (p: string) => { e2eFiles.delete(p); },
    },
  };
  {
    // 6MB 载荷（12 片 × 512KB——超过 v2 阈值 5MB）
    const v2Size = 6 * 1024 * 1024;
    const v2Payload = new Uint8Array(v2Size);
    for (let i = 0; i < v2Size; i++) v2Payload[i] = (i * 31 + 7) % 251;
    const v2Path = 'e2e://v2-large.bin';
    e2eFiles.set(v2Path, v2Payload);

    const v2Progress: number[] = [];
    const v2Stages: string[] = [];
    const r = await session.uploadAttachment(
      { fileId: 'e2e-file-v2', name: 'e2e-video.mp4', mime: 'video/mp4', bytes: v2Payload, localPath: v2Path },
      (pct) => { if (pct % 20 === 0) v2Progress.push(pct); },
      (stage) => { v2Stages.push(stage); },
    );
    if (!r.ok) fail(`v2 大文件失败：${r.error}`);
    log(`v2 stages: ${v2Stages.join(' → ')}`);
    if (!v2Stages.includes('hashing')) fail('v2 缺少 hashing 阶段');
    if (!v2Stages.includes('uploading')) fail('v2 缺少 uploading 阶段');
    log('v2 大文件分片直传 ✔（流式哈希 → 12 片确定性加密+逐片 offset 上传 → offer fmt:2 → receipt）');
  }

  // ---------- d→m 文件往返（桌面 sendFileToMobile → offer 落库建卡 → 点收断点拉取解密 → sha256 对账 → 交付 → receipt） ----------
  // 触发=魔法消息 E2E_SEND_FILE（手机控时——全部既有场景落定后才发，避免时序耦合）；
  // 桌面侧=真 RelayBridge.sendFileToMobile（path 模式全校验链 + PUT 分片上传 + waitFileReceipt），
  // 手机侧=真 receiveFile（Range 分片 → 逐片 openMediaChunk → 拼装 → hashTemp 对账 → deliverToDownloads）。
  {
    const D2M_SIZE = 600 * 1024; // >512KB=2 片分片路径；期望矢量与桌面侧同公式
    const expected = new Uint8Array(D2M_SIZE);
    for (let i = 0; i < D2M_SIZE; i++) expected[i] = (i * 17 + 5) % 251;

    let offerCard: FileCardInfo | null = null;
    const states: string[] = [];
    const progressSeen: Array<[number, number]> = [];
    let doneContentUri: string | null = null;
    let delivered: { name: string; bytes: Uint8Array } | null = null;

    // 交付层桩（与真机 Kotlin MediaStoreModule 同接口：读暂存 → 返 content URI；字节留痕供对账）
    rnNativeModules['MediaStoreModule'] = {
      saveToDownloads: async (srcPath: string, displayName: string, _mime: string) => {
        const bytes = e2eFiles.get(srcPath);
        if (!bytes) throw Object.assign(new Error('暂存文件不存在'), { code: 'io' });
        delivered = { name: displayName, bytes };
        return `content://downloads/${encodeURIComponent(displayName)}`;
      },
      openFile: async () => {},
    };

    const offD2m = session.on((e) => {
      if (e.type === 'fileOffer') {
        offerCard = e.card;
        log('fileOffer 卡:', e.card.name, `${e.card.size}B`, 'state=', e.card.state, 'sid=', e.card.sessionId);
      } else if (e.type === 'fileProgress') {
        progressSeen.push([e.received, e.total]);
      } else if (e.type === 'fileState') {
        states.push(e.state);
        if (e.state === 'done' && e.contentUri) doneContentUri = e.contentUri;
        log('fileState:', e.state, e.error ?? e.contentUri ?? '');
      }
    });

    await session.sendChat('E2E_SEND_FILE', SYNC_TARGET); // 魔法消息触发桌面 d→m 场景
    await waitStep('d→m fileOffer 卡到达', () => offerCard !== null, 30_000);
    const card = offerCard as unknown as FileCardInfo;
    if (card.sessionId !== SYNC_TARGET) fail(`d→m 卡归属不符: ${card.sessionId}`);
    if (card.name !== 'e2e-d2m-report.bin' || card.size !== D2M_SIZE || card.state !== 'offered') {
      fail(`d→m 卡字段不符: ${JSON.stringify(card)}`);
    }
    // 落库断言（receivedFiles 持久真相源：offered + 归属 + 密钥在库[交付前]）
    {
      const row = await getSyncDb().getReceivedFile(card.fileId);
      if (!row || row.state !== 'offered' || row.sessionId !== SYNC_TARGET || !row.staticJson.includes('"key"')) {
        fail(`receivedFiles 落库不符: ${JSON.stringify(row)}`);
      }
    }
    // 点[接收]：真实拉取链（await=拉取+交付+回执投递全程完成）
    await session.receiveFile(card.fileId);
    if (!states.includes('pulling') || !states.includes('done')) fail(`d→m 状态机不符: ${states.join('→')}`);
    if (progressSeen.length === 0 || progressSeen[progressSeen.length - 1]![0] !== D2M_SIZE) {
      fail(`d→m 进度不符: ${JSON.stringify(progressSeen)}`);
    }
    if (!doneContentUri) fail('d→m done 无 contentUri');
    if (!delivered) fail('d→m 交付未发生');
    const got = delivered as unknown as { name: string; bytes: Uint8Array };
    if (got.name !== 'e2e-d2m-report.bin') fail(`d→m 交付名不符: ${got.name}`);
    if (!Buffer.from(got.bytes).equals(Buffer.from(expected))) fail('d→m 交付字节与原文不符（解密/拼装错）');
    // 阅后即焚 + 暂存清场（done 后密钥列清空；chill-recv 下无 .part/暂存明文残留）
    {
      const row = (await getSyncDb().getReceivedFile(card.fileId))!;
      if (row.state !== 'done' || row.staticJson !== '') {
        fail(`阅后即焚不符: state=${row.state} staticJson=${row.staticJson.slice(0, 30)}`);
      }
      const leftovers = [...e2eFiles.keys()].filter((k) => k.includes('chill-recv'));
      if (leftovers.length > 0) fail(`暂存未清场: ${leftovers.join(',')}`);
    }
    offD2m();
    // 给桌面一拍处理 receipt（回执投递已 await，WS 投递为近即时——桌面退出码判负兜底）
    await new Promise((r) => setTimeout(r, 1500));
    log('d→m 文件往返 ✔（offer→卡归属→分片拉取→逐片解密→sha256 对账→交付→receipt→阅后即焚清场）');
  }

  // ---------- 长轮页预算截断（消息接管根治）：26 行轮 > 20 条页预算 → 最新页不含用户行 ----------
  // 压轴场景（置于全部既有场景之后：不干扰团队板编排时间线——附件场景同款实测教训）。
  // 同构复现"气泡消失"事故的 DB 侧条件；UI 层"气泡不消失/不双份"由 jest（retireConfirmedOverlay 全分支）覆盖，
  // 此处断言协议链：截断场景成立 → 连续性链自动补拉 → 用户行 clientId === 气泡信封 id + 中间节拍行进窗
  await session.sendChat(LONG_TEXT, SYNC_TARGET);
  await waitStep('长轮工具行尾部拉齐落库（≥10 行）', async () => {
    const rows = await getSyncDb().listMessages(session.getAgentId(), SYNC_TARGET, undefined, 100);
    return rows.filter((r) => r.msgKey.startsWith('tool:tc-long-')).length >= 10;
  }, 30_000);
  // 页预算截断证据在 history 事件流中捕获（最新页含工具行但不含用户行的豁口态先于补拉出现）
  await waitStep('页预算截断场景成立（最新页不含长轮用户行）', () => longGapSeen, 30_000);
  log('页预算截断场景成立 ✔（最新页不含长轮用户行——气泡消失事故的同构条件）');
  // 连续性链自动补拉（session 侧 tailChain：最新页与副本零重叠 → before=本页最早键链式补拉到对齐）——
  // 豁口行（用户行+早期节拍）必须无需人工上翻自动进窗
  await waitStep('连续性链自动补拉：长轮用户行与全部中间节拍行进窗', async () => {
    const rows = await getSyncDb().listMessages(session.getAgentId(), SYNC_TARGET, undefined, 100);
    const userRow = rows.find((r) => r.role === 'user' && r.text === LONG_TEXT);
    const beatRows = rows.filter((r) => r.text.startsWith('e2e 长轮节拍'));
    return userRow?.clientId != null && beatRows.length >= 12;
  }, 30_000);
  {
    const rows = await getSyncDb().listMessages(session.getAgentId(), SYNC_TARGET, undefined, 100);
    const userRow = rows.find((r) => r.role === 'user' && r.text === LONG_TEXT)!;
    const bubbleId = bubbleIds.get(LONG_TEXT);
    if (!bubbleId) fail('未捕获到长轮气泡（overlay emit 缺失）');
    if (userRow.clientId !== bubbleId) fail(`长轮 clientId 不符：DB=${userRow.clientId} vs 气泡=${bubbleId}`);
    log(`长轮接管 ✔（用户行 clientId === 气泡信封 id；中间节拍 ${rows.filter((r) => r.text.startsWith('e2e 长轮节拍')).length} 行全在）`);
  }

  // ---------- 工作计划树（workplan.* MVP 场景）：TASK_* → 镜像 → workplan.state → workPlanMeta 落库 + rev 对账 ----------
  // 桌面收魔法消息后：① TASK_LIST_CREATED ×3 → ② +600ms TASK_STATUS_UPDATED ×2（终态防抖推）。
  // 迭代 2 起树是双源（清单项+看板行根层并列）且 BOARD_CHANGED 共用 rev 计数器——
  // 不断言 rev 绝对值与树总长度，按 id 找清单项断言形状。
  await session.sendChat('E2E_WORKPLAN', SYNC_TARGET);
  await waitStep('workplan.state 落库（清单 3 项终态：甲 completed + 乙 in_progress + 丙 pending）', async () => {
    const meta = await getSyncDb().getWorkPlanMeta(session.getAgentId(), SYNC_TARGET);
    if (!meta) return false;
    const tree = JSON.parse(meta.treeJson) as WorkPlanItemWire[];
    const byId = (id: string) => tree.find((t) => t.id === id);
    const t1 = byId('e2e-wp-1');
    const t2 = byId('e2e-wp-2');
    const t3 = byId('e2e-wp-3');
    return (
      t1?.status === 'completed' && t1.result === 'e2e 事项甲完成' &&
      t2?.status === 'in_progress' &&
      t3?.status === 'pending'
    );
  }, 30_000);
  log('workplan.state 推送 ✔（TASK_* → 镜像 → 防抖推 → workPlanMeta 落库，顶层序=协议序）');

  // rev 对账（core 实际行为已核实：rev 一致 → decideWorkPlanSync 'ack' → full:false、items 空纯确认）。
  // 判负式观测：本地 treeJson 塞哨兵项（rev 不动）再发 workplan.sync——应答若是全量会冲掉哨兵；
  // 哨兵存活 + rev 不变 = 收到的是 full:false 纯确认（未收全量）。
  {
    const db = getSyncDb();
    const agentId = session.getAgentId();
    const meta = (await db.getWorkPlanMeta(agentId, SYNC_TARGET))!;
    const revBefore = meta.rev;
    const tree = JSON.parse(meta.treeJson) as Array<Record<string, unknown>>;
    const lenBefore = tree.length;
    tree.push({ id: 'e2e-wp-sentinel', content: '哨兵（full:false 才应存活）', status: 'pending' });
    await db.setWorkPlanMeta({ ...meta, treeJson: JSON.stringify(tree) });
    const eventsBefore = workplanEvents;
    await session.sendWorkPlanSync(SYNC_TARGET); // 带已知 rev 对账
    await waitStep('workplan.sync 对账应答到达', () => workplanEvents > eventsBefore, 20_000);
    const after = (await db.getWorkPlanMeta(agentId, SYNC_TARGET))!;
    if (after.rev !== revBefore) fail(`workplan.sync 对账后 rev 不符: ${after.rev} ≠ ${revBefore}`);
    const afterTree = JSON.parse(after.treeJson) as Array<{ id: string }>;
    if (afterTree.length !== lenBefore + 1 || !afterTree.some((t) => t.id === 'e2e-wp-sentinel')) {
      fail('workplan.sync rev 一致仍回全量（哨兵被冲掉——应为 full:false 纯确认）');
    }
    log('workplan.sync 对账 ✔（rev 一致 → full:false 纯确认：哨兵存活、树未被全量冲写）');
  }

  // ---------- 工作计划树双源（迭代 2 压轴场景）：清单项 + 看板行（有链嵌套 / 无链根层 / 行级 needsYou） ----------
  // 桌面：TASK_LIST_CREATED ×2（e2e-tree-root/e2e-tree-other）→ 会话板挂 2 行——
  // 挂链行（parentTaskId=e2e-tree-root，claim 给 explore·A）应嵌进 root.children；
  // 无链待认领行应在根层（actor='待认领'；**不**标 needsYou——待认领=灰调等待，琥珀只留给需拍板档）。
  await session.sendChat('E2E_WORKPLAN_TREE', SYNC_TARGET);
  await waitStep('workplan 树双源（有链嵌套 children / 无链根层并列 / 待认领非 needsYou）', async () => {
    const meta = await getSyncDb().getWorkPlanMeta(session.getAgentId(), SYNC_TARGET);
    if (!meta) return false;
    const tree = JSON.parse(meta.treeJson) as WorkPlanItemWire[];
    const root = tree.find((t) => t.id === 'e2e-tree-root');
    const other = tree.find((t) => t.id === 'e2e-tree-other');
    const linked = root?.children?.find((c) => c.content === 'e2e 树挂链子活');
    const unlinked = tree.find((t) => t.content === 'e2e 树无链待认领');
    return (
      root !== undefined && other !== undefined &&
      linked?.actor === 'explore·A' && linked.status === 'in_progress' &&
      unlinked !== undefined && (unlinked.children ?? []).length === 0 &&
      unlinked.actor === '待认领' && unlinked.needsYou === undefined && unlinked.status === 'pending'
    );
  }, 30_000);
  log('workplan 树双源 ✔（有链看板行嵌父项 children[actor=explore·A] / 无链行根层并列[待认领·非 needsYou]）');

  // ---------- 运行态标志压轴（E2E_RUNNING，2026-10-04）：会话列表"运行中"转圈的端到端断言 ----------
  // 桌面假轮：TURN_STARTED → 2.5s 窗口 → TURN_SETTLED。手机断言两态翻转：
  // ①轮中集合含目标会话（running.changed(true) 送达——经 runningAll 整替语义，快照错则此步失败）
  // ②落定后集合清空（running.changed(false)+快照收敛）。通道=桥 wiring 全真、协议全真。
  await session.sendChat('E2E_RUNNING', SYNC_TARGET);
  await waitStep('运行态：轮中集合含目标会话（转圈亮）', async () => {
    const running = session.getRunningSessions();
    return running.has(SYNC_TARGET) && running.size === 1;
  }, 15_000);
  await waitStep('运行态：落定后集合清空（转圈熄）', async () => {
    return !session.getRunningSessions().has(SYNC_TARGET);
  }, 15_000);
  log('运行态标志 ✔（轮中亮 runningAll 整替 / 落定熄）');

  log('E2E_SYNC_OK');
  closeSyncDb();
  process.exit(0);
} else {
  console.error('usage: e2e-node.mts pair <qr.json> | resume | sync <qr.json> <workDir>');
  process.exit(2);
}

// 收发窗口后退出（配对态给足 confirm+demo-desktop 回复时间）
const budget = mode === 'pair' ? 25_000 : 8_000;
setTimeout(() => {
  log(`done (paired=${pairedAt > 0})`);
  process.exit(0);
}, budget);
