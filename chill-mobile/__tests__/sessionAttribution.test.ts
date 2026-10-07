/**
 * sessionAttribution.test.ts — 会话内容归位修复（串场根治 + 灰卡/pending 卡钉位）：
 * 1. allowsMessageForSession 三分支：无戳放行（旧桌面兜底）/ 归属=本屏放行 / 归属错配丢弃
 * 2. handleAskEnvelope requestTs：request 首次捕获、重推（新信封新 ts）不刷新、resolved 透传
 * 3. handleApprovalEnvelope requestTs 同构
 * chat.event 流式 emit 归属透传与回显三段式盖戳在 handleBoxMessage/sendChatInternal 投递路径内
 * （测试环境无配对密钥不可直测），由真机场景①④⑤覆盖。
 */
import { test } from '@jest/globals';
import { RelaySession } from '../src/relay/session';
import { makeEnvelope } from '../src/relay/envelope';
import { allowsMessageForSession } from '../src/screens/syncUiLogic';
import type { ChatMessage } from '../src/relay/session';

/* eslint-disable @typescript-eslint/no-explicit-any */

function msg(sessionId?: string): ChatMessage {
  return { id: 'stream-x-1', dir: 'in', text: 't', kind: 'delta', ts: 1, ...(sessionId !== undefined ? { sessionId } : {}) };
}

test('allowsMessageForSession：无戳放行（旧桌面兜底，与 943 防线 null 放行对齐）/ 归属=本屏放行 / 他会流丢弃', () => {
  expect(allowsMessageForSession(msg(), 'A')).toBe(true); // 无归属（字段缺省）——旧桌面兼容
  expect(allowsMessageForSession(msg('A'), 'A')).toBe(true); // 归属匹配（pop 回旧屏流继续）
  expect(allowsMessageForSession(msg('B'), 'A')).toBe(false); // 他会流丢弃（'new' 屏串场根治）
});

test('handleAskEnvelope requestTs：首次捕获 + 重推不刷新（钉首次）+ resolved 透传', () => {
  const s = new RelaySession();
  const anyS = s as any;
  const t1 = 1_000;
  const t2 = 9_000;
  const mk = (type: 'ask.request' | 'ask.resolved', body: Record<string, unknown>, ts: number) => {
    const env = makeEnvelope(type, 'desk', 'me', body);
    env.ts = ts;
    return env;
  };
  anyS.handleAskEnvelope(mk('ask.request', { id: 'k1', question: 'q', sessionId: 'S1' }, t1));
  expect(anyS.askCards.get('k1').requestTs).toBe(t1);
  // 重连重推：新信封新 ts——钉首次，不刷新（漂移 pending 变体的根治点）
  anyS.handleAskEnvelope(mk('ask.request', { id: 'k1', question: 'q', sessionId: 'S1' }, t2));
  expect(anyS.askCards.get('k1').requestTs).toBe(t1);
  // resolved 合并 prev 透传不丢
  anyS.handleAskEnvelope(mk('ask.resolved', { id: 'k1', answer: 'a', by: 'phone' }, t2 + 1));
  const card = anyS.askCards.get('k1');
  expect(card.requestTs).toBe(t1);
  expect(card.settled).toEqual({ answer: 'a', by: 'phone' });
});

test('handleApprovalEnvelope requestTs 同构：首次捕获 + 重推不刷新 + resolved 透传', () => {
  const s = new RelaySession();
  const anyS = s as any;
  const t1 = 2_000;
  const t2 = 8_000;
  const mk = (type: 'approval.request' | 'approval.resolved', body: Record<string, unknown>, ts: number) => {
    const env = makeEnvelope(type, 'desk', 'me', body);
    env.ts = ts;
    return env;
  };
  anyS.handleApprovalEnvelope(mk('approval.request', { id: 'a1', kind: 'write', summary: 's', sessionId: 'S1' }, t1));
  expect(anyS.approvalCards.get('a1').requestTs).toBe(t1);
  anyS.handleApprovalEnvelope(mk('approval.request', { id: 'a1', kind: 'write', summary: 's', sessionId: 'S1' }, t2));
  expect(anyS.approvalCards.get('a1').requestTs).toBe(t1);
  anyS.handleApprovalEnvelope(mk('approval.resolved', { id: 'a1', approved: true, by: 'phone' }, t2 + 1));
  const card = anyS.approvalCards.get('a1');
  expect(card.requestTs).toBe(t1);
  expect(card.settled).toEqual({ approved: true, by: 'phone' });
});


