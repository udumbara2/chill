import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { WebSocket } from 'ws';
import { startServer, TestWsClient, fixture, type TestServer } from './helpers.js';
import { makeEnvelope, encryptEnvelope } from '../src/shared/envelope.js';

let srv: TestServer;
before(async () => {
  srv = await startServer({ tls: { key: fixture('server.key'), cert: fixture('server.crt') } });
});
after(async () => {
  await srv.close();
});

function httpsGet(url: string, ca: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', ca, rejectUnauthorized: true },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('wss 正例：测试 CA 信任下 /health 连通', async () => {
  const status = await httpsGet(`${srv.base}/health`, fixture('ca.crt'));
  assert.equal(status, 200);
});

test('wss 反例：错 CA 必拒（TLS 握手失败）', async () => {
  await assert.rejects(httpsGet(`${srv.base}/health`, fixture('wrong-ca.crt')));
  // 无 CA（系统信任库不含私有 CA）也必拒
  await assert.rejects(
    new Promise((resolve, reject) => {
      const u = new URL(`${srv.base}/health`);
      const req = https.request(
        { hostname: u.hostname, port: u.port, path: u.pathname, rejectUnauthorized: true },
        resolve,
      );
      req.on('error', reject);
      req.end();
    }),
  );
});

test('wss WS：正确 CA 连通收信，错 CA 必拒', async () => {
  // 用 https.Agent 驱动配对（fetch 不支持自定义 CA）
  const ca = fixture('ca.crt');
  const agent = new https.Agent({ ca, rejectUnauthorized: true });
  const req = (method: string, path: string, token?: string, body?: unknown) =>
    new Promise<{ status: number; json: Record<string, never> | null }>((resolve, reject) => {
      const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const u = new URL(srv.base + path);
      const r = https.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method,
          agent,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const t = Buffer.concat(chunks).toString('utf8');
            let j = null;
            try {
              j = t ? JSON.parse(t) : null;
            } catch {
              /* empty */
            }
            resolve({ status: res.statusCode ?? 0, json: j });
          });
        },
      );
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });

  // 配对
  const { generateKeyPair, ecdhShared, deriveSecrets, tokenHash, mailboxIdFromPub } = await import(
    '../src/shared/envelope.js'
  );
  const tr = await req('POST', '/pair/tokens', 'test-operator-key');
  assert.equal(tr.status, 200);
  const token = (tr.json as unknown as { token: string }).token;
  const desk = generateKeyPair();
  const phone = generateKeyPair();
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey));
  const phoneBox = mailboxIdFromPub(phone.publicKey);
  const rr = await req('POST', '/pair/redeem', token, {
    phonePub: phone.publicKey,
    deskPub: desk.publicKey,
    device: 'wss-test-phone',
    writeHash: tokenHash(secrets.writeToken),
    readHash: tokenHash(secrets.readToken),
    revokeHash: tokenHash(secrets.revokeToken),
  });
  assert.equal(rr.status, 200);

  // 投递一条，WS（带 CA pin）收
  const env = makeEnvelope('chat.event', mailboxIdFromPub(desk.publicKey), phoneBox, { kind: 'final', text: 'wss ok' });
  const wire = encryptEnvelope(secrets.keyD2M, phoneBox, 'd2m', env)!;
  const pr = await req('POST', `/box/${phoneBox}`, secrets.writeToken, { blob: wire });
  assert.equal(pr.status, 201);

  const c = await TestWsClient.connect(srv, phoneBox, secrets.readToken, { ca });
  assert.equal(await c.waitFor(1), true);
  c.close();

  // 错 CA 的 WS 必拒
  const wrong = new WebSocket(`${srv.wsBase}/box/${phoneBox}`, {
    headers: { authorization: `Bearer ${secrets.readToken}` },
    ca: fixture('wrong-ca.crt'),
    rejectUnauthorized: true,
  });
  await assert.rejects(
    new Promise((resolve, reject) => {
      wrong.on('open', resolve);
      wrong.on('error', reject);
    }),
  );
});

test('wss 错 token 的 WS 握手被拒（401），且不击穿服务', async () => {
  const bad = new WebSocket(`${srv.wsBase}/box/${'0'.repeat(32)}`, {
    headers: { authorization: 'Bearer wrong' },
    ca: fixture('ca.crt'),
    rejectUnauthorized: true,
  });
  await assert.rejects(
    new Promise((resolve, reject) => {
      bad.on('open', resolve);
      bad.on('error', reject);
      bad.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    }),
    /401/,
  );
  const status = await httpsGet(`${srv.base}/health`, fixture('ca.crt'));
  assert.equal(status, 200);
});
