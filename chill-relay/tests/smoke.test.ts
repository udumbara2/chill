import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makePairDirect, TestWsClient, type TestServer } from './helpers.js';

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

test('冒烟：突发 500 条分 10 信箱，10 秒内无错序、不重不漏', async () => {
  const BOXES = 10;
  const PER_BOX = 50;
  const pairs = Array.from({ length: BOXES }, () => makePairDirect(srv));

  const start = Date.now();
  // 突发投递（直接经 store 灌入，聚焦投递正确性而非 HTTP 吞吐）
  const expected = new Map<string, number[]>();
  for (const p of pairs) {
    const ids: number[] = [];
    for (let i = 0; i < PER_BOX; i++) {
      ids.push(srv.store.insertMessage(p.phoneBox, `blob-${i}`));
    }
    expected.set(p.phoneBox, ids);
  }

  // 10 个读者同时上线补投
  const clients = await Promise.all(
    pairs.map((p) => TestWsClient.connect(srv, p.phoneBox, p.secrets.readToken)),
  );
  for (let i = 0; i < BOXES; i++) {
    const c = clients[i]!;
    const p = pairs[i]!;
    assert.equal(await c.waitFor(PER_BOX, 8000), true, `box ${i} 未收满`);
    const got = c.msgs.map((m) => m.id);
    assert.deepEqual(got, expected.get(p.phoneBox), `box ${i} 错序或漏重`);
  }
  for (const c of clients) c.close();
  assert.ok(Date.now() - start < 10_000, '超过 10 秒');
});
