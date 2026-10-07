import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, DEAD_LETTER_ATTEMPTS } from '../src/store.js';
import { T0 } from './helpers.js';

/** 死信上限（M7增量3·决策32）：毒消息不可能永驻信箱——投满阈值即入 dead_messages */
test('死信：投递尝试累加，≥ DEAD_LETTER_ATTEMPTS 后移入 dead_messages 不再出现在 pending', () => {
  const store = new Store(':memory:', () => T0);
  try {
    store.createMailbox('b1', 'w', 'r', 'v', 'dev');
    const poison = store.insertMessage('b1', '毒消息');
    const normal = store.insertMessage('b1', '正常消息');
    // 模拟 20 次重连重投（server.onWsAuthed 每次投递前 bump）
    let attempts = 0;
    for (let i = 0; i < DEAD_LETTER_ATTEMPTS; i++) {
      attempts = store.bumpDeliverAttempt('b1', poison);
    }
    assert.equal(attempts, DEAD_LETTER_ATTEMPTS);
    // 第 21 次（超过阈值）→ 死信
    attempts = store.bumpDeliverAttempt('b1', poison);
    assert.ok(attempts > DEAD_LETTER_ATTEMPTS);
    assert.equal(store.deadLetter('b1', poison), true);
    const pending = store.pendingMessages('b1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, normal);
    // 死信可查（保留原文与尝试次数）
    const dead = store.listDeadMessages('b1');
    assert.equal(dead.length, 1);
    assert.equal(dead[0]!.id, poison);
    assert.equal(dead[0]!.deliver_attempts, DEAD_LETTER_ATTEMPTS + 1);
    // 配额随死信释放
    assert.equal(store.boxBytes('b1'), '正常消息'.length);
  } finally {
    store.close();
  }
});

test('死信：未达阈值不误伤（19 次投递仍在 pending）', () => {
  const store = new Store(':memory:', () => T0);
  try {
    store.createMailbox('b1', 'w', 'r', 'v', 'dev');
    store.insertMessage('b1', '还在忍耐');
    for (let i = 0; i < DEAD_LETTER_ATTEMPTS - 1; i++) store.bumpDeliverAttempt('b1', 1);
    const pending = store.pendingMessages('b1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.deliver_attempts, DEAD_LETTER_ATTEMPTS - 1);
  } finally {
    store.close();
  }
});

function memStore(t0 = T0): { store: Store; setNow: (t: number) => void } {
  let t = t0;
  const store = new Store(':memory:', () => t);
  return { store, setNow: (nt: number) => (t = nt) };
}

test('TTL 清扫：未到期不删，到期删', () => {
  const { store, setNow } = memStore();
  try {
    store.createMailbox('b1', 'w', 'r', 'v', 'dev');
    store.insertMessage('b1', 'x', 1000);
    setNow(T0 + 999);
    assert.equal(store.sweepMessages(), 0);
    setNow(T0 + 1001);
    assert.equal(store.sweepMessages(), 1);
    assert.equal(store.pendingMessages('b1').length, 0);
  } finally {
    store.close();
  }
});

test('配额实时算：±1 字节精确，ACK 删除立即释放', () => {
  const { store } = memStore();
  try {
    store.createMailbox('b1', 'w', 'r', 'v', 'dev');
    assert.equal(store.boxBytes('b1'), 0);
    const id = store.insertMessage('b1', 'a'.repeat(100));
    assert.equal(store.boxBytes('b1'), 100);
    store.insertMessage('b1', 'b'.repeat(1));
    assert.equal(store.boxBytes('b1'), 101);
    assert.equal(store.boxCount('b1'), 2);
    assert.equal(store.ackMessage('b1', id), true);
    assert.equal(store.boxBytes('b1'), 1); // ACK 释放
  } finally {
    store.close();
  }
});

test('ACK 双条件：跨信箱 ACK 无效', () => {
  const { store } = memStore();
  try {
    store.createMailbox('a', 'w', 'r', 'v', 'dev');
    store.createMailbox('b', 'w', 'r', 'v', 'dev');
    const idA = store.insertMessage('a', 'hello');
    store.insertMessage('b', 'world'); // 全局自增 id，不与 idA 相同
    assert.equal(store.ackMessage('b', idA), false); // 知道 id 也删不了别人信箱
    assert.equal(store.pendingMessages('a').length, 1);
    assert.equal(store.ackMessage('a', idA), true);
    assert.equal(store.pendingMessages('a').length, 0);
  } finally {
    store.close();
  }
});

test('孤儿信箱 GC：创建 24h 零次成功读才注销', () => {
  const { store, setNow } = memStore();
  try {
    store.createMailbox('orphan', 'w', 'r', 'v', 'dev', T0);
    store.createMailbox('active', 'w', 'r', 'v', 'dev', T0);
    store.markRead('active');
    setNow(T0 + 24 * 3600 * 1000 - 1);
    assert.deepEqual(store.gcMailboxes(), []);
    setNow(T0 + 24 * 3600 * 1000 + 1);
    assert.deepEqual(store.gcMailboxes(), ['orphan']);
    assert.equal(store.getMailbox('orphan'), undefined);
    assert.notEqual(store.getMailbox('active'), undefined);
  } finally {
    store.close();
  }
});

test('pair_tokens 行保留：unused 过期 1h 才扫，redeemed 留 24h', () => {
  const { store, setNow } = memStore();
  try {
    const expires = T0 + 600_000;
    store.createToken('unused', expires);
    store.createToken('used', expires);
    store.redeemTokenTransaction('used', 'pub', 'dev', []);
    setNow(expires + 1); // 刚过 10min 过期：都不扫
    assert.equal(store.sweepTokens(), 0);
    setNow(expires + 3600_000 + 1); // 过期 1h：unused 扫，used 留
    assert.equal(store.sweepTokens(), 1);
    assert.notEqual(store.getToken('used'), undefined);
    setNow(expires + 24 * 3600_000 + 1); // 过期 24h：used 也扫
    assert.equal(store.sweepTokens(), 1);
  } finally {
    store.close();
  }
});

test('redeemTokenTransaction：原子建双信箱，重复消费返回 false', () => {
  const { store } = memStore();
  try {
    store.createToken('h', T0 + 600_000);
    const boxes = [
      { box: 'phonebox', writeHash: 'w', readHash: 'r', revokeHash: 'v', device: 'p' },
      { box: 'deskbox', writeHash: 'w', readHash: 'r', revokeHash: 'v', device: 'd' },
    ];
    assert.equal(store.redeemTokenTransaction('h', 'pub1', 'dev1', boxes), true);
    assert.notEqual(store.getMailbox('phonebox'), undefined);
    assert.notEqual(store.getMailbox('deskbox'), undefined);
    const row = store.getToken('h');
    assert.equal(row?.used, 1);
    assert.equal(row?.phone_pub, 'pub1');
    // 并发语义：used=0 守卫，第二次必然 false
    assert.equal(store.redeemTokenTransaction('h', 'pub2', 'dev2', boxes), false);
  } finally {
    store.close();
  }
});

test('重配对（密钥轮换）：同一对公钥再次 redeem 已有信箱时 UPSERT 而非冲突', () => {
  const { store } = memStore();
  try {
    // 第一次配对
    store.createToken('h1', T0 + 600_000);
    const boxes1 = [
      { box: 'phonebox', writeHash: 'w1', readHash: 'r1', revokeHash: 'v1', device: 'p' },
      { box: 'deskbox', writeHash: 'w1', readHash: 'r1', revokeHash: 'v1', device: 'd' },
    ];
    assert.equal(store.redeemTokenTransaction('h1', 'pub1', 'dev1', boxes1), true);
    // revoke 后再配（或不 revoke 直接重配）同一对公钥 → 新令牌哈希应刷新，不得 UNIQUE 冲突
    store.createToken('h2', T0 + 600_000);
    const boxes2 = [
      { box: 'phonebox', writeHash: 'w2', readHash: 'r2', revokeHash: 'v2', device: 'p' },
      { box: 'deskbox', writeHash: 'w2', readHash: 'r2', revokeHash: 'v2', device: 'd' },
    ];
    assert.equal(store.redeemTokenTransaction('h2', 'pub1', 'dev1', boxes2), true);
    assert.equal(store.getMailbox('deskbox')?.write_hash, 'w2');
  } finally {
    store.close();
  }
});

test('重配对清空旧密钥加密的残留消息（防 fail-closed 无限重投循环）', () => {
  const { store } = memStore();
  try {
    store.createToken('h1', T0 + 600_000);
    const boxes = [
      { box: 'phonebox', writeHash: 'w', readHash: 'r', revokeHash: 'v', device: 'p' },
      { box: 'deskbox', writeHash: 'w', readHash: 'r', revokeHash: 'v', device: 'd' },
    ];
    store.redeemTokenTransaction('h1', 'pub1', 'dev1', boxes);
    // 旧配对期间信箱里有未取走的消息
    store.insertMessage('deskbox', 'old-ciphertext');
    assert.equal(store.pendingMessages('deskbox').length, 1);
    // 重配对 → 残留消息被清空
    store.createToken('h2', T0 + 600_000);
    store.redeemTokenTransaction('h2', 'pub1', 'dev1', boxes);
    assert.equal(store.pendingMessages('deskbox').length, 0);
  } finally {
    store.close();
  }
});

test('dropMailbox 连消息一起删', () => {
  const { store } = memStore();
  try {
    store.createMailbox('b1', 'w', 'r', 'v', 'dev');
    store.insertMessage('b1', 'x');
    assert.equal(store.dropMailbox('b1'), true);
    assert.equal(store.pendingMessages('b1').length, 0);
    assert.equal(store.dropMailbox('b1'), false);
  } finally {
    store.close();
  }
});
