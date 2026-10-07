import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { issueToken, pairStatus, redeem, type RedeemBody } from '../src/pairing.js';
import { generateKeyPair, tokenHash, mailboxIdFromPub } from '../src/shared/envelope.js';
import { T0 } from './helpers.js';

function setup(t0 = T0) {
  let t = t0;
  const store = new Store(':memory:', () => t);
  const now = () => t;
  const desk = generateKeyPair();
  const phone = generateKeyPair();
  const other = generateKeyPair();
  const body: RedeemBody = {
    phonePub: phone.publicKey,
    deskPub: desk.publicKey,
    device: 'phone-1',
    writeHash: 'a'.repeat(64),
    readHash: 'b'.repeat(64),
    revokeHash: 'c'.repeat(64),
  };
  return {
    store,
    now,
    setNow: (nt: number) => (t = nt),
    desk,
    phone,
    other,
    body: (over: Partial<RedeemBody> = {}): RedeemBody => ({ ...body, ...over }),
  };
}

test('签发 + status pending → redeemed 全流', () => {
  const { store, now, body } = setup();
  try {
    const { token } = issueToken(store, now);
    assert.deepEqual(pairStatus(store, token, now), { code: 200, state: 'pending' });
    const r = redeem(store, token, body(), now);
    assert.equal(r.code, 200);
    assert.equal(r.code === 200 && r.replay, false);
    // 双信箱同事务建好
    assert.notEqual(store.getMailbox(mailboxIdFromPub(body().phonePub)), undefined);
    assert.notEqual(store.getMailbox(mailboxIdFromPub(body().deskPub)), undefined);
    const s = pairStatus(store, token, now);
    assert.equal(s.code === 200 && s.state, 'redeemed');
    assert.equal(s.code === 200 && s.state === 'redeemed' && s.phonePub, body().phonePub);
  } finally {
    store.close();
  }
});

test('幂等重放：同 phone_pub 无条件 200，即使行已过期也不拦截', () => {
  const { store, now, setNow, body } = setup();
  try {
    const { token } = issueToken(store, now);
    assert.equal(redeem(store, token, body(), now).code, 200);
    // 移动网络重试
    const replay = redeem(store, token, body(), now);
    assert.equal(replay.code, 200);
    assert.equal(replay.code === 200 && replay.replay, true);
    // 过期之后重放依然 200（无条件优先）
    setNow(T0 + 3600_000);
    assert.equal(redeem(store, token, body(), now).code, 200);
    // status 也仍可见 redeemed（行保留 24h）
    const s = pairStatus(store, token, now);
    assert.equal(s.code === 200 && s.state, 'redeemed');
  } finally {
    store.close();
  }
});

test('撞令牌：已消费 + 异 phone_pub → 409', () => {
  const { store, now, other, body } = setup();
  try {
    const { token } = issueToken(store, now);
    assert.equal(redeem(store, token, body(), now).code, 200);
    assert.equal(redeem(store, token, body({ phonePub: other.publicKey }), now).code, 409);
  } finally {
    store.close();
  }
});

test('过期：未消费 + 已过期 → 410，且反复探测不迁移状态（无烧毁机制）', () => {
  const { store, now, setNow, other, body } = setup();
  try {
    const { token, expires } = issueToken(store, now);
    setNow(expires);
    for (let i = 0; i < 10; i++) {
      assert.equal(redeem(store, token, body(), now).code, 410);
      assert.equal(redeem(store, token, body({ phonePub: other.publicKey }), now).code, 410);
    }
    // 状态未迁移：行仍 used=0
    assert.equal(store.getToken(tokenHash(token))?.used, 0);
  } finally {
    store.close();
  }
});

test('未知 token → 401，不计数不区分，任意次探测无状态变化', () => {
  const { store, now, body } = setup();
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal(redeem(store, 'nonexistent-token-' + i, body(), now).code, 401);
      assert.equal(pairStatus(store, 'nonexistent-token-' + i, now).code, 401);
    }
  } finally {
    store.close();
  }
});

test('过期边缘：expires-1 可消费，expires 即 410', () => {
  const { store, now, setNow, body } = setup();
  try {
    const { token, expires } = issueToken(store, now);
    setNow(expires - 1);
    assert.equal(redeem(store, token, body(), now).code, 200);
    const t2 = issueToken(store, now);
    setNow(t2.expires);
    assert.equal(redeem(store, t2.token, body(), now).code, 410);
  } finally {
    store.close();
  }
});
