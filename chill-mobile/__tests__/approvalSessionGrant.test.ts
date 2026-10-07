/**
 * approvalSessionGrant.test.ts — 手机「本次会话放行」第三钮（桌面操作审批，additive 协议）：
 * 1. handleApprovalEnvelope：sessionGrantable additive 读取 + resolved 重建保留（灰卡不丢标记）
 * 2. sendApprovalResponse：'session' → 线上 {decision:'approve', allowSession:true}
 *    （不发明 decision 新值——旧桌面对未知 decision 判 reject，违反旧端安全）；
 *    'approve'/'reject' 旧形态逐位不变
 * 加密走真实 encryptEnvelope/decryptEnvelope 往返（零 mock 加密），HTTP 经 fetch 桩捕获。
 */
import { test, expect, jest } from '@jest/globals';
import { RelaySession } from '../src/relay/session';
import { makeEnvelope, decryptEnvelope } from '../src/relay/envelope';

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = new Uint8Array(32).fill(7);

test('handleApprovalEnvelope：sessionGrantable 读取 + resolved 重建保留', () => {
  const s = new RelaySession();
  const anyS = s as any;
  anyS.handleApprovalEnvelope(
    makeEnvelope('approval.request', 'desk', 'me', { id: 'd1', kind: 'command', summary: '点击', sessionGrantable: true }),
  );
  expect(anyS.approvalCards.get('d1').sessionGrantable).toBe(true);
  // 无标记的普通审批不带字段（additive 缺省语义）
  anyS.handleApprovalEnvelope(
    makeEnvelope('approval.request', 'desk', 'me', { id: 'd2', kind: 'command', summary: 'ls' }),
  );
  expect(anyS.approvalCards.get('d2').sessionGrantable).toBeUndefined();
  // resolved 合并 prev 重建整卡保留标记（灰卡仍按桌面操作渲染）
  anyS.handleApprovalEnvelope(
    makeEnvelope('approval.resolved', 'desk', 'me', { id: 'd1', approved: true, by: 'phone' }),
  );
  expect(anyS.approvalCards.get('d1').sessionGrantable).toBe(true);
});

test("sendApprovalResponse：'session' 线上映射 decision:'approve'+allowSession；旧形态逐位不变", async () => {
  const s = new RelaySession();
  const anyS = s as any;
  anyS.confirmed = true;
  anyS.myBox = 'me';
  anyS.deskBox = 'desk';
  anyS.state = { relay: 'https://relay.example' };
  anyS.secrets = { keyM2D: KEY, writeToken: 'tok' };

  const posts: string[] = [];
  global.fetch = jest.fn(async (_url: unknown, init: any) => {
    posts.push(init.body);
    return { status: 201, text: async () => '' } as any;
  }) as any;

  const readLast = (): any => {
    const blob = JSON.parse(posts[posts.length - 1]).blob as string;
    const r = decryptEnvelope(KEY, 'desk', 'm2d', blob);
    expect(r.ok).toBe(true);
    return (r as { ok: true; envelope: any }).envelope;
  };

  await s.sendApprovalResponse('tc-1', 'session');
  let env = readLast();
  expect(env.type).toBe('approval.response');
  expect(env.body).toEqual({ id: 'tc-1', decision: 'approve', allowSession: true });

  await s.sendApprovalResponse('tc-2', 'approve');
  env = readLast();
  expect(env.body).toEqual({ id: 'tc-2', decision: 'approve' });

  await s.sendApprovalResponse('tc-3', 'reject');
  env = readLast();
  expect(env.body).toEqual({ id: 'tc-3', decision: 'reject' });
});
