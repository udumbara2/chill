import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, makePair, OPERATOR, type TestServer } from './helpers.js';
import { generateKeyPair, tokenHash, deriveSecrets, ecdhShared } from '../src/shared/envelope.js';

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

test('GET /health 无鉴权 200', async () => {
  const r = await api(srv, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test('POST /pair/tokens：无/错运营者密钥 401，正确 200', async () => {
  assert.equal((await api(srv, 'POST', '/pair/tokens')).status, 401);
  assert.equal((await api(srv, 'POST', '/pair/tokens', { token: 'wrong' })).status, 401);
  const r = await api(srv, 'POST', '/pair/tokens', { token: OPERATOR });
  assert.equal(r.status, 200);
  const body = r.json as { token: string; expires: number };
  assert.ok(body.token.length >= 22); // ≥128bit base64url
  assert.ok(body.expires > srv.now());
});

test('GET /pair/status：无令牌/垃圾令牌 401', async () => {
  assert.equal((await api(srv, 'GET', '/pair/status')).status, 401);
  assert.equal((await api(srv, 'GET', '/pair/status', { token: 'garbage' })).status, 401);
});

test('POST /pair/redeem：坏 JSON 400、缺字段 400、未知令牌 401、成功 200 幂等 409 410', async () => {
  // 坏 JSON
  const bad = await api(srv, 'POST', '/pair/redeem', { token: 'x', rawBody: Buffer.from('{oops') });
  assert.equal(bad.status, 400);
  // 未知令牌（先拿一个合法体）
  const desk = generateKeyPair();
  const phone = generateKeyPair();
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey));
  const body = {
    phonePub: phone.publicKey,
    deskPub: desk.publicKey,
    device: 'dev',
    writeHash: tokenHash(secrets.writeToken),
    readHash: tokenHash(secrets.readToken),
    revokeHash: tokenHash(secrets.revokeToken),
  };
  assert.equal((await api(srv, 'POST', '/pair/redeem', { token: 'unknown', body })).status, 401);
  // 缺字段
  const tr = await api(srv, 'POST', '/pair/tokens', { token: OPERATOR });
  const { token } = tr.json as { token: string };
  assert.equal((await api(srv, 'POST', '/pair/redeem', { token, body: { phonePub: 1 } })).status, 400);
  // 成功 + 幂等 + 409
  assert.equal((await api(srv, 'POST', '/pair/redeem', { token, body })).status, 200);
  assert.equal((await api(srv, 'POST', '/pair/redeem', { token, body })).status, 200);
  const conflict = await api(srv, 'POST', '/pair/redeem', {
    token,
    body: { ...body, phonePub: generateKeyPair().publicKey },
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json, { error: 'token_conflict' }); // 裸 body
  // 410：过期令牌
  const tr2 = await api(srv, 'POST', '/pair/tokens', { token: OPERATOR });
  const { token: token2 } = tr2.json as { token: string };
  srv.setNow(srv.now() + 601_000);
  assert.equal((await api(srv, 'POST', '/pair/redeem', { token: token2, body })).status, 410);
});

test('box 投递：未知信箱/错令牌 401 不区分，read_token 写 403，合法 201', async () => {
  const p = await makePair(srv);
  assert.equal((await api(srv, 'POST', `/box/${'0'.repeat(32)}`, { token: 'x', body: { blob: 'a' } })).status, 401);
  assert.equal((await api(srv, 'POST', `/box/${p.deskBox}`, { token: 'wrong', body: { blob: 'a' } })).status, 401);
  assert.equal(
    (await api(srv, 'POST', `/box/${p.deskBox}`, { token: p.secrets.readToken, body: { blob: 'a' } })).status,
    403,
  );
  const ok = await api(srv, 'POST', `/box/${p.deskBox}`, {
    token: p.secrets.writeToken,
    body: { blob: 'aGVsbG8' },
  });
  assert.equal(ok.status, 201);
  assert.equal(typeof (ok.json as { id: number }).id, 'number');
});

test('box 投递：非 base64url 400、blob>64KB 413、body>128KB 413 且进程存活', async () => {
  const p = await makePair(srv);
  assert.equal(
    (await api(srv, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, body: { blob: '!!' } })).status,
    400,
  );
  const big = await api(srv, 'POST', `/box/${p.deskBox}`, {
    token: p.secrets.writeToken,
    body: { blob: 'a'.repeat(64 * 1024 + 1) },
  });
  assert.equal(big.status, 413);
  // >128KB 硬上限（断连式响应——fetch 可能收到 413 或连接重置，二者都接受）
  const huge = Buffer.from(JSON.stringify({ blob: 'a'.repeat(129 * 1024) }));
  const r = await api(srv, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, rawBody: huge }).catch(
    () => ({ status: 413, json: null }),
  );
  assert.equal(r.status, 413);
  // 进程存活
  assert.equal((await api(srv, 'GET', '/health')).status, 200);
});

test('ACK：无令牌 401、write_token 403、未知 id 幂等 204、合法 204', async () => {
  const p = await makePair(srv);
  const post = await api(srv, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, body: { blob: 'eA' } });
  const { id } = post.json as { id: number };
  assert.equal((await api(srv, 'POST', `/box/${p.deskBox}/ack`, { body: { id } })).status, 401);
  assert.equal(
    (await api(srv, 'POST', `/box/${p.deskBox}/ack`, { token: p.secrets.writeToken, body: { id } })).status,
    403,
  );
  assert.equal(
    (await api(srv, 'POST', `/box/${p.deskBox}/ack`, { token: p.secrets.readToken, body: { id: 99999 } })).status,
    204,
  );
  assert.equal(
    (await api(srv, 'POST', `/box/${p.deskBox}/ack`, { token: p.secrets.readToken, body: { id } })).status,
    204,
  );
  assert.equal(srv.store.pendingMessages(p.deskBox).length, 0);
});

test('DELETE /box：revoke_token 注销 204，注销后一切 401（不区分）', async () => {
  const p = await makePair(srv);
  assert.equal((await api(srv, 'DELETE', `/box/${p.phoneBox}`, { token: p.secrets.writeToken })).status, 403);
  assert.equal((await api(srv, 'DELETE', `/box/${p.phoneBox}`, { token: p.secrets.revokeToken })).status, 204);
  assert.equal((await api(srv, 'DELETE', `/box/${p.phoneBox}`, { token: p.secrets.revokeToken })).status, 401);
  assert.equal(
    (await api(srv, 'POST', `/box/${p.phoneBox}`, { token: p.secrets.writeToken, body: { blob: 'eA' } })).status,
    401,
  );
});

test('未知路由 404；信箱路径错误方法 404', async () => {
  assert.equal((await api(srv, 'GET', '/nope')).status, 404);
  const p = await makePair(srv);
  assert.equal((await api(srv, 'PUT', `/box/${p.deskBox}`, { token: p.secrets.writeToken })).status, 404);
});

test('频控 429：tokens/status 每 IP 上限', async () => {
  const tight = await startServer({ limits: { tokensPerMin: 3, statusPerMin: 2 } });
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await api(tight, 'POST', '/pair/tokens', { token: OPERATOR })).status, 200);
    }
    assert.equal((await api(tight, 'POST', '/pair/tokens', { token: OPERATOR })).status, 429);
  } finally {
    await tight.close();
  }
  const tight2 = await startServer({ limits: { statusPerMin: 2 } });
  try {
    const tk = (await api(tight2, 'POST', '/pair/tokens', { token: OPERATOR })).json as { token: string };
    assert.equal((await api(tight2, 'GET', '/pair/status', { token: tk.token })).status, 200);
    assert.equal((await api(tight2, 'GET', '/pair/status', { token: tk.token })).status, 200);
    assert.equal((await api(tight2, 'GET', '/pair/status', { token: tk.token })).status, 429);
  } finally {
    await tight2.close();
  }
});

test('投递字节制频控 429 + 信箱 5MB 配额 429 quota_exceeded', async () => {
  const tight = await startServer({ limits: { boxBytesPerMin: 1024 } });
  try {
    const p = await makePair(tight);
    const blob = 'a'.repeat(600);
    assert.equal(
      (await api(tight, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, body: { blob } })).status,
      201,
    );
    assert.equal(
      (await api(tight, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, body: { blob } })).status,
      429,
    );
  } finally {
    await tight.close();
  }
  // 配额：默认大字节制下填满 5MB
  const srv2 = await startServer();
  try {
    const p = await makePair(srv2);
    const chunk = 'a'.repeat(64 * 1024); // 单条上限内
    for (let i = 0; i < 80; i++) {
      // 80 × 64KB = 5MB 整
      const r = await api(srv2, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, body: { blob: chunk } });
      assert.equal(r.status, 201, `第 ${i} 条应为 201`);
    }
    assert.equal(srv2.store.boxBytes(p.deskBox), 80 * 64 * 1024);
    const over = await api(srv2, 'POST', `/box/${p.deskBox}`, { token: p.secrets.writeToken, body: { blob: 'YQ' } });
    assert.equal(over.status, 429);
    assert.deepEqual(over.json, { error: 'quota_exceeded' });
  } finally {
    await srv2.close();
  }
});
