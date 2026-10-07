/**
 * attribution.test.ts — 归因分流核心逻辑（规划 v5 手机侧）：
 * viewingSessionId 三方法（同值幂等/clear-if-mine 两臂/通知语义）、getCardsSnapshot TTL 窗口、
 * ask 信封归因读取与 resolved 整卡保留。组件级分流行为（message 过滤/门控/浮层）由 e2e 与真机场景①-⑧覆盖。
 */
import { test } from '@jest/globals';
import { RelaySession } from '../src/relay/session';
import { makeEnvelope } from '../src/relay/envelope';
import type { AskCardInfo, ApprovalCardInfo } from '../src/relay/session';

/* eslint-disable @typescript-eslint/no-explicit-any */

function sess(): RelaySession {
  return new RelaySession();
}

test('viewingSessionId：set/get + 同值幂等（不通知）+ 变化通知订阅者', () => {
  const s = sess();
  const seen: (string | null)[] = [];
  const off = s.onViewingSessionChange((id) => seen.push(id));
  s.setViewingSessionId('A');
  expect(s.getViewingSessionId()).toBe('A');
  s.setViewingSessionId('A'); // 同值幂等：不通知
  expect(seen).toEqual(['A']);
  s.setViewingSessionId('B');
  expect(s.getViewingSessionId()).toBe('B');
  expect(seen).toEqual(['A', 'B']);
  off();
  s.setViewingSessionId('C');
  expect(seen).toEqual(['A', 'B']); // 退订后不通知
  expect(s.getViewingSessionId()).toBe('C');
});

test('clear-if-mine：命中臂（当前值===mine 清 null+通知）/ 不命中臂（Chat→Chat push 倒挂终值保持新屏）', () => {
  const s = sess();
  const seen: (string | null)[] = [];
  s.onViewingSessionChange((id) => seen.push(id));
  // 不命中臂：push 倒挂序列 set(B) → 旧屏 blur clearIfMine(A) —— A≠B 不动，终值 B（评审 v4-R1 的直接锚定）
  s.setViewingSessionId('B');
  s.clearViewingSessionIdIfMine('A');
  expect(s.getViewingSessionId()).toBe('B');
  // 命中臂：pop 返回序列 clearIfMine(B) —— 命中清 null，前屏 focus 随后重写
  s.clearViewingSessionIdIfMine('B');
  expect(s.getViewingSessionId()).toBe(null);
  // 空值清除幂等（null 时不清也不通知）
  s.clearViewingSessionIdIfMine('X');
  expect(seen).toEqual(['B', null]);
});

test('getCardsSnapshot：pending 全量保留 + 灰卡 30min TTL 内保留/超窗剔除（读取时惰性）', () => {
  const s = sess();
  const now = Date.now();
  const anyS = s as any;
  anyS.askCards.set('k-pending', { id: 'k-pending', question: 'q', sessionId: 'S1' } as AskCardInfo);
  anyS.askCards.set('k-fresh', { id: 'k-fresh', question: 'q', sessionId: 'S1', settled: { answer: 'ok', by: 'phone' }, settledAt: now - 60_000 } as AskCardInfo);
  anyS.askCards.set('k-stale', { id: 'k-stale', question: 'q', sessionId: 'S1', settled: { answer: 'ok', by: 'phone' }, settledAt: now - 31 * 60_000 } as AskCardInfo);
  anyS.approvalCards.set('a-pending', { id: 'a-pending', kind: 'write', summary: 's' } as ApprovalCardInfo);
  const snap = s.getCardsSnapshot();
  expect(snap.ask.map((c) => c.id).sort()).toEqual(['k-fresh', 'k-pending']);
  expect(snap.approval.map((c) => c.id)).toEqual(['a-pending']);
  // 超窗灰卡已被惰性剔除（二次读取不再出现）
  const snap2 = s.getCardsSnapshot();
  expect(snap2.ask.some((c) => c.id === 'k-stale')).toBe(false);
});

test('ask 信封归因读取：request 带/不带 sessionId（additive：不带→null）；resolved 整卡保留归因 + settledAt', () => {
  const s = sess();
  const events: Array<{ kind: string; sessionId?: string | null; settled?: unknown }> = [];
  s.on((e) => {
    if (e.type === 'message' && (e.message.kind === 'ask' || e.message.kind === 'approval')) {
      events.push({
        kind: e.message.kind,
        sessionId: e.message.kind === 'ask' ? e.message.ask?.sessionId : e.message.approval?.sessionId,
        settled: e.message.kind === 'ask' ? e.message.ask?.settled : e.message.approval?.settled,
      });
    }
  });
  const anyS = s as any;
  anyS.handleAskEnvelope(makeEnvelope('ask.request', 'from', 'to', { id: 'q1', question: '会话内请示', sessionId: 'S9' }));
  anyS.handleAskEnvelope(makeEnvelope('ask.request', 'from', 'to', { id: 'q2', question: '全局请示' }));
  expect(events[0]).toMatchObject({ kind: 'ask', sessionId: 'S9' });
  expect(events[1]).toMatchObject({ kind: 'ask', sessionId: null });
  anyS.handleAskEnvelope(makeEnvelope('ask.resolved', 'from', 'to', { id: 'q1', answer: '好', by: 'phone' }));
  expect(events[2]).toMatchObject({ kind: 'ask', sessionId: 'S9', settled: { answer: '好', by: 'phone' } });
  const snap = s.getCardsSnapshot();
  expect(snap.ask.find((c) => c.id === 'q1')?.settledAt).toBeGreaterThan(0);
  expect(snap.ask.find((c) => c.id === 'q2')?.sessionId).toBe(null);
});

test('approval 信封归因读取：request 带 sessionId / resolved 保留', () => {
  const s = sess();
  const anyS = s as any;
  anyS.handleApprovalEnvelope(makeEnvelope('approval.request', 'from', 'to', { id: 'apr-1', kind: 'write', summary: '写文件', sessionId: 'S7' }));
  let snap = s.getCardsSnapshot();
  expect(snap.approval.find((c) => c.id === 'apr-1')?.sessionId).toBe('S7');
  anyS.handleApprovalEnvelope(makeEnvelope('approval.resolved', 'from', 'to', { id: 'apr-1', approved: true, by: 'phone' }));
  snap = s.getCardsSnapshot();
  const settled = snap.approval.find((c) => c.id === 'apr-1');
  expect(settled?.sessionId).toBe('S7'); // 灰卡保留归因
  expect(settled?.settled?.approved).toBe(true);
  expect(settled?.settledAt).toBeGreaterThan(0);
});
