import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, makePair, type TestServer } from './helpers.js';

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

test('跨信箱 ACK 无效：知道对方消息 id 也删不了（双条件）', async () => {
  const p = await makePair(srv);
  const r1 = await api(srv, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, body: { blob: 'QQ' } });
  const { id: deskMsgId } = r1.json as { id: number };
  const r2 = await api(srv, 'POST', `/box/${p.phoneBox}`, { token: p.secrets.writeToken, body: { blob: 'Qg' } });
  assert.equal(r2.status, 201);
  // 用手机信箱端点 ACK 桌面信箱的消息 id → 204 但删不掉
  const ack = await api(srv, 'POST', `/box/${p.phoneBox}/ack`, {
    token: p.secrets.readToken,
    body: { id: deskMsgId },
  });
  assert.equal(ack.status, 204);
  assert.equal(srv.store.pendingMessages(p.deskBox).length, 1); // 仍在
  assert.equal(srv.store.pendingMessages(p.phoneBox).length, 1);
});

test('未知 id ACK 幂等 204，重复 ACK 幂等 204', async () => {
  const p = await makePair(srv);
  const r = await api(srv, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, body: { blob: 'Qw' } });
  const { id } = r.json as { id: number };
  assert.equal(
    (await api(srv, 'POST', `/box/${p.deskBox}/ack`, { token: p.secrets.readToken, body: { id: id + 100 } }))
      .status,
    204,
  );
  assert.equal(
    (await api(srv, 'POST', `/box/${p.deskBox}/ack`, { token: p.secrets.readToken, body: { id } })).status,
    204,
  );
  assert.equal(
    (await api(srv, 'POST', `/box/${p.deskBox}/ack`, { token: p.secrets.readToken, body: { id } })).status,
    204,
  );
  assert.equal(srv.store.pendingMessages(p.deskBox).length, 0);
});

test('ACK 计数为成功读：孤儿 GC 不回收有 ACK 的信箱', async () => {
  const p = await makePair(srv);
  const r = await api(srv, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, body: { blob: 'RA' } });
  const { id } = r.json as { id: number };
  await api(srv, 'POST', `/box/${p.deskBox}/ack`, { token: p.secrets.readToken, body: { id } });
  srv.setNow(srv.now() + 25 * 3600_000);
  const gc = srv.store.gcMailboxes();
  assert.ok(!gc.includes(p.deskBox));
  assert.ok(gc.includes(p.phoneBox)); // phoneBox 零读 → 被 GC
});
