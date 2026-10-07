/**
 * mirrorAnchor.test.ts — 本地镜像轮合成锚（规划 v2 T3）：
 * 桌面本地轮（回流/定时/goalTick/桌面输入）按协议无 replyTo 锚（PROTOCOL-FROZEN:54），手机端为此
 * 实例化合成轮次锚（mirror-<sessionId>-<n>），走与手机轮同等的聚合路径——修复"子智能体任务返回后
 * 手机端只剩工具痕迹、无实时 thinking/正文"（提案 [2026-10-06]）。
 *
 * 覆盖：判据状态机（resolveMirrorAnchor/closeMirrorAnchor/markMirrorOpen）+ 集成路径
 * （processChatEvent 直调——未配对态 ack 为 no-op、emit 同步分发可断言）。
 * round.settled→closeMirrorAnchor 的完整接线（含尾拉/UI 收口）由 e2e 双进程与真机覆盖。
 */
import { test, expect } from '@jest/globals';
import { RelaySession } from '../src/relay/session';
import { ANCHORED_STREAM } from '../src/screens/syncUiLogic';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SID = 'sess-1';

/** 无锚 chat.event 信封（本地镜像轮流） */
function mirrorEnv(kind: 'delta' | 'reasoning', text: string, beat: number, extra: Record<string, unknown> = {}): any {
  return {
    id: `env-${Math.random().toString(36).slice(2, 8)}`,
    type: 'chat.event',
    ts: Date.now(),
    body: { kind, text, sessionId: SID, beat, ...extra },
    // 无 replyTo —— 本地轮特征
  };
}

/** 有锚信封（手机轮流） */
function phoneEnv(kind: 'delta' | 'reasoning', text: string, beat: number, replyTo: string): any {
  return {
    id: `env-${Math.random().toString(36).slice(2, 8)}`,
    type: 'chat.event',
    ts: Date.now(),
    replyTo,
    body: { kind, text, sessionId: SID, beat },
  };
}

function harness(): { s: RelaySession; anyS: any; emitted: any[] } {
  const s = new RelaySession();
  const emitted: any[] = [];
  s.on((e: any) => {
    if (e.type === 'message') emitted.push(e.message);
  });
  return { s, anyS: s as any, emitted };
}

/** running.changed(true)（TURN_STARTED 开门信号）——handleSessionEvent 在 db 守卫之前分派，无配对态可达 */
function turnStarted(anyS: any, sid = SID): void {
  void anyS.handleSessionEvent({ id: 'se-1', type: 'session.event', ts: Date.now(), body: { kind: 'running.changed', sessionId: sid, running: true } });
}

/** round.settled 对锚的作用（handleSessionEvent 的 db 守卫在 jest 无配对态拦截后半段——直接驱动等效目标） */
function roundSettled(anyS: any, sid = SID): void {
  anyS.closeMirrorAnchor(sid);
}

test('① 无锚 delta 经合成锚聚合显示：开门后 chunk 聚合为 stream-mirror-<sid>-<n>-<beat>，同节拍追加全文', async () => {
  const { s, anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('delta', 'He', 0, { seq: 0 }), 1);
  await anyS.processChatEvent(mirrorEnv('delta', 'llo', 0, { seq: 1 }), 2);
  expect(emitted.length).toBe(2);
  for (const m of emitted) {
    expect(m.id).toBe('stream-mirror-sess-1-1-0'); // 锚=第 1 个合成锚实例，节拍 0
    expect(m.kind).toBe('delta');
    expect(m.dir).toBe('in');
    expect(m.streaming).toBe(true);
    expect(m.sessionId).toBe(SID); // 归属戳随行（UI 按会话归位）
  }
  expect(emitted[1].text).toBe('Hello'); // 聚合全文
});

test('② 无锚 reasoning 经合成锚聚合显示：增量追加 + closed 快照长者胜覆盖', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('reasoning', '思考A', 0, { seq: 0 }), 1);
  await anyS.processChatEvent(mirrorEnv('reasoning', '思考AB', 0, { closed: true }), 2); // 关闭快照（全文）
  const ids = emitted.map((m: any) => m.id);
  expect(ids.every((id: string) => id === 'think-mirror-sess-1-1-0')).toBe(true);
  expect(emitted[0].kind).toBe('reasoning');
  expect(emitted[0].streaming).toBe(true); // 增量中
  expect(emitted[1].text).toBe('思考AB'); // 长者胜整体覆盖
  expect(emitted[1].streaming).toBe(false); // 已收敛
});

test('③ round.settled 收口：活锚入 closedAnchors、节拍缓冲同步释放、openSignal 清零', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('delta', '正文', 0), 1);
  const st = anyS.mirrorAnchors.get(SID);
  expect(st.active).toBe('mirror-sess-1-1');
  roundSettled(anyS);
  expect(anyS.closedAnchors.has('mirror-sess-1-1')).toBe(true); // 迟到丢弃防线登记
  expect(anyS.beats.has('mirror-sess-1-1')).toBe(false); // 节拍缓冲同步删（对齐 final 路径纪律）
  expect(st.active).toBeNull();
  expect(st.openSignal).toBe(false);
  expect(emitted.length).toBe(1); // 收口不产生新 emit
});

test('④ 已关轮迟到重投丢弃：settle 后无开门、beat ≤ 见过最大节拍 → 不 emit', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('delta', '正文', 3), 1); // 见过最大节拍 = 3
  roundSettled(anyS);
  const before = emitted.length;
  await anyS.processChatEvent(mirrorEnv('delta', '旧轮迟到重投', 3), 2); // 重放同节拍
  await anyS.processChatEvent(mirrorEnv('reasoning', '旧轮迟到思考', 1), 3); // 更低节拍
  expect(emitted.length).toBe(before); // 全部丢弃（内容经尾拉/DB REPLACE 收敛不丢）
});

test('⑤ 与手机轮锚互不干扰：有锚 chunk 恒走真锚路径，合成锚状态不参与', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS); // 开门信号存在也不影响有锚路径
  await anyS.processChatEvent(phoneEnv('delta', '手机轮正文', 0, 'env-phone-1'), 1);
  await anyS.processChatEvent(phoneEnv('reasoning', '手机轮思考', 0, 'env-phone-1'), 2);
  expect(emitted[0].id).toBe('stream-env-phone-1-0');
  expect(emitted[1].id).toBe('think-env-phone-1-0');
  expect(anyS.mirrorAnchors.get(SID).active).toBeNull(); // 合成锚未被有锚路径触碰
});

test('⑥ 合成锚卡 id 形态匹配 ANCHORED_STREAM（UI roundSettled 闭锚 + 回声退休零改动接管的前提）', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('delta', 'x', 0), 1);
  await anyS.processChatEvent(mirrorEnv('reasoning', 'y', 0), 2);
  for (const m of emitted) {
    const t = ANCHORED_STREAM.exec(m.id);
    expect(t).not.toBeNull();
    expect(t![1]).toBe('mirror-sess-1-1'); // 锚捕获组
    expect(t![2]).toBe('0'); // 节拍捕获组
  }
});

test('⑦ 连续多回流轮（beat 接续递增）：settle 后新轮凭 beat > 见过最大节拍开新锚，两轮卡不串台', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('delta', '轮1正文', 0), 1);
  await anyS.processChatEvent(mirrorEnv('delta', '轮1续', 2), 2); // 节拍 0→2（中间节拍省略）
  roundSettled(anyS); // 轮 1 落定；见过最大节拍 = 2
  // 轮 2：开门信号丢失（竞态/丢失场景），beat 接续 3 > 2 → 兜底判据开新锚
  await anyS.processChatEvent(mirrorEnv('delta', '轮2正文', 3), 3);
  const ids = new Set(emitted.map((m: any) => m.id));
  expect(ids.has('stream-mirror-sess-1-1-0')).toBe(true); // 轮 1 卡
  expect(ids.has('stream-mirror-sess-1-2-3')).toBe(true); // 轮 2 新锚新节拍
  expect(anyS.closedAnchors.has('mirror-sess-1-1')).toBe(true); // 旧锚已关——迟到不串入
});

test('⑧ settle 丢失自愈：活锚期间新轮开门信号到达 → 关旧开新，两轮不拼同一张卡', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('delta', '轮1正文', 0), 1);
  // 轮 1 的 round.settled 丢失（fire-and-forget）——活锚悬挂
  turnStarted(anyS); // 轮 2 TURN_STARTED 先于其首 chunk 到达
  await anyS.processChatEvent(mirrorEnv('delta', '轮2正文', 1), 2);
  expect(anyS.closedAnchors.has('mirror-sess-1-1')).toBe(true); // 旧锚被开门信号收口
  const last = emitted[emitted.length - 1];
  expect(last.id).toBe('stream-mirror-sess-1-2-1'); // 轮 2 独立成卡（非拼接）
  expect(last.text).toBe('轮2正文');
});

test('⑨ attach 切走再切回不拼卡：切换附着收口悬挂活锚，重附后新轮开门开新锚', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('delta', '旧轮正文', 0), 1);
  await anyS.setAttachedIntent(SID); // 进入会话
  await anyS.setAttachedIntent(null); // 切走：悬挂活锚收口
  expect(anyS.closedAnchors.has('mirror-sess-1-1')).toBe(true);
  turnStarted(anyS); // 切走期间桌面新轮开启（running.changed 无镜像门控照达）
  await anyS.setAttachedIntent(SID); // 切回
  await anyS.processChatEvent(mirrorEnv('delta', '新轮正文', 1), 2);
  const last = emitted[emitted.length - 1];
  expect(last.id).toBe('stream-mirror-sess-1-2-1');
  expect(last.text).toBe('新轮正文'); // 不与旧轮拼接
});

test('⑩ 桌面 cell 复位场景（手机轮后本地轮 beat 归零）：开门信号是唯一可辨依据，正确开新锚不误丢弃', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('delta', '本地轮1', 5), 1); // 见过最大节拍 = 5
  roundSettled(anyS);
  turnStarted(anyS); // 手机轮后桌面 cell 复位（beatIndex 归零），新本地轮 TURN_STARTED 开门
  await anyS.processChatEvent(mirrorEnv('delta', '复位后新轮', 0), 2); // beat 0 ≤ 5，凭开门开新锚
  const last = emitted[emitted.length - 1];
  expect(last.id).toBe('stream-mirror-sess-1-2-0'); // 归零节拍进新锚
  expect(last.text).toBe('复位后新轮');
});

test('⑪ 开门后迟到重投边界（声明行为固化）：开门信号后到达的旧轮重投会开新锚短暂渲染——回声退休收敛、不丢内容不崩溃', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  await anyS.processChatEvent(mirrorEnv('delta', '旧轮正文', 4), 1);
  roundSettled(anyS);
  turnStarted(anyS); // 新轮开门
  await anyS.processChatEvent(mirrorEnv('delta', '旧轮迟到重投', 4), 2); // 实为旧轮重投（beat 4 ≤ 5 场景同族）
  const last = emitted[emitted.length - 1];
  expect(last.id).toBe('stream-mirror-sess-1-2-4'); // 判据设计内行为：开门优先于 beat 判定
  // 后续 DB 回声退休（UI 层）接管收敛——本用例仅固化 session 层行为不崩溃不丢 emit
});

test('⑫ 无戳无锚 chunk 保持既有丢弃（识别条件=戳存在；null 放行归属防线后由本条件兜住）', async () => {
  const { anyS, emitted } = harness();
  turnStarted(anyS);
  const env = mirrorEnv('delta', '无戳', 0);
  delete env.body.sessionId;
  await anyS.processChatEvent(env, 1);
  expect(emitted.length).toBe(0);
  const st = anyS.mirrorAnchors.get(SID);
  expect(st ? st.active : null).toBeNull(); // 开门信号可登记（markMirrorOpen 职责��，但无戳不进合成锚路径——未开锚
});
