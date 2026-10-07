/**
 * presence.test.ts — 探活直答路由（M2.2，中继投递流控规划）
 *
 * 覆盖：对端 WS 在线→online:true / 断开→false / 错 token 401（防枚举同款）
 * / 无 peer 参数 400 / 独立频控 429（不占信箱字节预算）。
 * 运行：随 npm test（node --import tsx --test）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, makePair, TestWsClient, type TestServer } from './helpers.js';

let srv: TestServer;
before(async () => {
  srv = await startServer({ limits: { presencePerMin: 3 } });
});
after(async () => {
  await srv.close();
});

test('presence：对端 WS 在线 → online:true；断开 → false；未连过 → false', async () => {
  const p = await makePair(srv);
  // 请求方 = 桌面（read token 查手机在线性）；初始手机无 WS
  let r = await api(srv, 'GET', `/box/${p.deskBox}/presence?peer=${p.phoneBox}`, { token: p.secrets.readToken });
  assert.equal(r.status, 200);
  assert.equal((r.json as { online: boolean }).online, false, '手机未连 WS → 离线');
  // 手机连上 WS → 在线
  const ws = await TestWsClient.connect(srv, p.phoneBox, p.secrets.readToken);
  try {
    r = await api(srv, 'GET', `/box/${p.deskBox}/presence?peer=${p.phoneBox}`, { token: p.secrets.readToken });
    assert.equal((r.json as { online: boolean }).online, true, '手机 WS 在场 → 在线');
  } finally {
    ws.close();
  }
  await new Promise((res) => setTimeout(res, 50)); // 等 close 传播
  r = await api(srv, 'GET', `/box/${p.deskBox}/presence?peer=${p.phoneBox}`, { token: p.secrets.readToken });
  assert.equal((r.json as { online: boolean }).online, false, 'WS 关闭 → 立即离线');
});

test('presence：错 token 401（不区分信箱不存在，防枚举）；缺 peer 400', async () => {
  const p = await makePair(srv);
  assert.equal((await api(srv, 'GET', `/box/${p.deskBox}/presence?peer=${p.phoneBox}`, { token: 'wrong' })).status, 401);
  assert.equal((await api(srv, 'GET', `/box/${'0'.repeat(32)}/presence?peer=${p.phoneBox}`, { token: p.secrets.readToken })).status, 401);
  assert.equal((await api(srv, 'GET', `/box/${p.deskBox}/presence`, { token: p.secrets.readToken })).status, 400);
  assert.equal((await api(srv, 'GET', `/box/${p.deskBox}/presence?peer=xyz`, { token: p.secrets.readToken })).status, 400);
});

test('presence：独立频控 429（presencePerMin=3，不占信箱字节预算）', async () => {
  const p = await makePair(srv);
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await api(srv, 'GET', `/box/${p.deskBox}/presence?peer=${p.phoneBox}`, { token: p.secrets.readToken })).status);
  }
  assert.equal(codes.filter((c) => c === 200).length, 3, '前 3 次 200');
  assert.equal(codes.filter((c) => c === 429).length, 2, '第 4-5 次 429');
});
