import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, makePair, TestWsClient, sleep, type TestServer } from './helpers.js';
import { makeEnvelope, encryptEnvelope } from '../src/shared/envelope.js';

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

async function postText(p: Awaited<ReturnType<typeof makePair>>, box: string, dir: 'm2d' | 'd2m', text: string) {
  const key = dir === 'm2d' ? p.secrets.keyM2D : p.secrets.keyD2M;
  const from = dir === 'm2d' ? p.phoneBox : p.deskBox;
  const to = dir === 'm2d' ? p.deskBox : p.phoneBox;
  const env = makeEnvelope('chat.user', from, to, { text });
  const wire = encryptEnvelope(key, to, dir, env)!;
  const r = await api(srv, 'POST', `/box/${to}`, { token: p.secrets.writeToken, body: { blob: wire } });
  assert.equal(r.status, 201);
  return (r.json as { id: number }).id;
}

test('补投：离线期间投递的消息，上线全量按序收到', async () => {
  const p = await makePair(srv);
  await postText(p, p.phoneBox, 'd2m', 'm1');
  await postText(p, p.phoneBox, 'd2m', 'm2');
  await postText(p, p.phoneBox, 'd2m', 'm3');
  const c = await TestWsClient.connect(srv, p.phoneBox, p.secrets.readToken);
  assert.equal(await c.waitFor(3), true);
  const ids = c.msgs.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b)); // 按 id 升序
  assert.equal(new Set(ids).size, 3); // 不重
  c.close();
});

test('补投/直推竞态：补投进行中直推新消息，不重不漏', async () => {
  const p = await makePair(srv);
  // 先制造一批离线消息
  for (let i = 0; i < 10; i++) await postText(p, p.phoneBox, 'd2m', `offline-${i}`);
  // 连接的同时立刻直推一条（投递路径先查 in-flight 去重）
  const cP = TestWsClient.connect(srv, p.phoneBox, p.secrets.readToken);
  const newId = await postText(p, p.phoneBox, 'd2m', 'live-1');
  const c = await cP;
  assert.equal(await c.waitFor(11), true);
  const ids = c.msgs.map((m) => m.id);
  assert.equal(new Set(ids).size, 11, `收到 ${ids.length} 条，去重后 ${new Set(ids).size} 条`);
  assert.ok(ids.includes(newId));
  c.close();
});

test('单活跃读者：新连接踢旧连接，未 ACK 消息向新连接重投', async () => {
  const p = await makePair(srv);
  await postText(p, p.deskBox, 'm2d', 'to-desk');
  const c1 = await TestWsClient.connect(srv, p.deskBox, p.secrets.readToken);
  assert.equal(await c1.waitFor(1), true);
  const c2 = await TestWsClient.connect(srv, p.deskBox, p.secrets.readToken);
  // c1 被踢（4000）
  const start = Date.now();
  while (c1.closedCode === null && Date.now() - start < 3000) await sleep(20);
  assert.equal(c1.closedCode, 4000);
  // c2 收到重投（c1 未 ACK）
  assert.equal(await c2.waitFor(1), true);
  c2.close();
});

test('ACK 后不重投', async () => {
  const p = await makePair(srv);
  const id = await postText(p, p.deskBox, 'm2d', 'ack-me');
  const c1 = await TestWsClient.connect(srv, p.deskBox, p.secrets.readToken);
  assert.equal(await c1.waitFor(1), true);
  const ack = await api(srv, 'POST', `/box/${p.deskBox}/ack`, { token: p.secrets.readToken, body: { id } });
  assert.equal(ack.status, 204);
  c1.close();
  await sleep(100);
  const c2 = await TestWsClient.connect(srv, p.deskBox, p.secrets.readToken);
  await sleep(300);
  assert.equal(c2.msgs.length, 0);
  c2.close();
});

test('未 ACK 断线必重投（at-least-once）', async () => {
  const p = await makePair(srv);
  await postText(p, p.deskBox, 'm2d', 'must-redeliver');
  const c1 = await TestWsClient.connect(srv, p.deskBox, p.secrets.readToken);
  assert.equal(await c1.waitFor(1), true);
  c1.terminate(); // 异常断线，未 ACK
  await sleep(100);
  const c2 = await TestWsClient.connect(srv, p.deskBox, p.secrets.readToken);
  assert.equal(await c2.waitFor(1), true);
  c2.close();
});
