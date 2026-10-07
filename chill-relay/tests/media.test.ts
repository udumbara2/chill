/** 媒体直传通道：PUT /media（write_token 配对凭据/名形/五重配额/流中硬闸/TTL）+ GET /static/media 解耦。 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import {
  startServer,
  startMediaServer,
  cleanupStaticDir,
  api,
  makePairDirect,
  type TestServer,
  type Paired,
} from './helpers.js';
import { createRelayServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { tokenHash } from '../src/shared/envelope.js';

// 小限额：单文件 64B / 总量 200B / TTL 1s（次数与字节率给足，频控专项单独起服务）
let srv: TestServer & { staticDir: string };
let plainSrv: TestServer; // 未配置任何静态家族（无 staticDir）
let pair: Paired;

const n = (c: string): string => c.repeat(32) + '.bin';

before(async () => {
  srv = await startMediaServer({
    mediaPerMin: 100_000,
    mediaBytesPerMin: 1 << 20,
    mediaMaxFileBytes: 64,
    mediaMaxTotalBytes: 200,
    mediaTtlMs: 1000,
    mediaPartTtlMs: 1000,
  });
  pair = makePairDirect(srv);
  plainSrv = await startServer();
});
after(async () => {
  await srv.close();
  cleanupStaticDir(srv.staticDir);
  await plainSrv.close();
});

test('未配置 staticDir：/media 与 /static 均 404（路由不注册）', async () => {
  assert.equal(
    (await api(plainSrv, 'PUT', `/media/${n('a')}`, { token: 'x', rawBody: Buffer.from('x') }))
      .status,
    404,
  );
  assert.equal((await api(plainSrv, 'GET', `/static/media/${n('a')}`)).status, 404);
});

test('解耦不反向开口：staticDir-only 服务上 /publish 仍 404', async () => {
  assert.equal(
    (await api(srv, 'PUT', '/publish?name=shots/a.png', { token: 'x', rawBody: Buffer.from('x') }))
      .status,
    404,
  );
});

test('media 鉴权（配对令牌即凭据）：无/错/read_token/未配对 → 401', async () => {
  const body = Buffer.alloc(8, 1);
  assert.equal((await api(srv, 'PUT', `/media/${n('a')}`, { rawBody: body })).status, 401);
  assert.equal(
    (await api(srv, 'PUT', `/media/${n('a')}`, { token: 'wrong', rawBody: body })).status,
    401,
  );
  // read_token 不是写凭据（哈希不匹配 write_hash）
  assert.equal(
    (await api(srv, 'PUT', `/media/${n('a')}`, { token: pair.secrets.readToken, rawBody: body }))
      .status,
    401,
  );
  // 未配对（随机 token）
  assert.equal(
    (await api(srv, 'PUT', `/media/${n('a')}`, { token: 'not-a-paired-token', rawBody: body }))
      .status,
    401,
  );
});

test('已撤销信箱 → 401（撤销=行已删，反查未命中；不区分不存在/已撤销防枚举）', async () => {
  const s2 = await startMediaServer();
  try {
    const p2 = makePairDirect(s2);
    s2.store.dropMailbox(p2.deskBox);
    s2.store.dropMailbox(p2.phoneBox);
    assert.equal(
      (
        await api(s2, 'PUT', `/media/${n('a')}`, {
          token: p2.secrets.writeToken,
          rawBody: Buffer.alloc(8, 1),
        })
      ).status,
      401,
    );
  } finally {
    await s2.close();
    cleanupStaticDir(s2.staticDir);
  }
});

test('media 名形拒绝：非 hex/短/大写/穿越/坏扩展 → 400', async () => {
  for (const name of [
    'evil.bin',
    'a'.repeat(31) + '.bin',
    'A'.repeat(32) + '.bin',
    'g'.repeat(32) + '.bin',
    n('a') + '/../../relay.db',
    'a'.repeat(32) + '.txt',
  ]) {
    assert.equal(
      (
        await api(srv, 'PUT', `/media/${encodeURIComponent(name)}`, {
          token: pair.secrets.writeToken,
          rawBody: Buffer.alloc(4, 1),
        })
      ).status,
      400,
      `name=${name}`,
    );
  }
});

test('media 正常往返：201/落盘/GET 字节一致/octet-stream/不占信箱预算', async () => {
  const name = n('f');
  const payload = Buffer.alloc(8, 7);
  const r = await api(srv, 'PUT', `/media/${name}`, {
    token: pair.secrets.writeToken,
    rawBody: payload,
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { url: `/static/media/${name}` });
  assert.ok(existsSync(join(srv.staticDir, 'media', name)));
  const g = await fetch(`${srv.base}/static/media/${name}`);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'application/octet-stream');
  assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await g.arrayBuffer()), payload);
  // 数据面独立于控制面：媒体字节不计入任何信箱配额
  assert.equal(srv.store.boxBytes(pair.deskBox), 0);
  assert.equal(srv.store.boxBytes(pair.phoneBox), 0);
});

test('GET：不存在 404 / 旧白名单名形（png 等）在 media 前缀外照旧', async () => {
  assert.equal((await api(srv, 'GET', `/static/media/${n('0')}`)).status, 404);
  assert.equal((await api(srv, 'GET', '/static/media/../../etc/passwd')).status, 404);
  assert.equal((await api(srv, 'GET', '/static/shots/x.png')).status, 404);
});

test('单文件超限（声明超限）→ 413 too_large，无落盘', async () => {
  const r = await api(srv, 'PUT', `/media/${n('b')}`, {
    token: pair.secrets.writeToken,
    rawBody: Buffer.alloc(65, 1),
  });
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { error: 'too_large' });
  assert.ok(!existsSync(join(srv.staticDir, 'media', n('b'))));
});

test('分块超限（无声明、流中掐断）→ 413 或断连，.part 无残留', async () => {
  const name = n('c');
  const res = await new Promise<{ status: number | null }>((resolve) => {
    const req = httpRequest(
      new URL(`/media/${name}`, srv.base),
      { method: 'PUT', headers: { authorization: `Bearer ${pair.secrets.writeToken}` } },
      (r) => resolve({ status: r.statusCode ?? null }),
    );
    req.on('error', () => resolve({ status: null }));
    req.write(Buffer.alloc(40, 9));
    req.write(Buffer.alloc(40, 9)); // 80 > 64 → 流中硬闸
    req.end();
  });
  assert.ok(res.status === 413 || res.status === null, `status=${res.status}`);
  assert.ok(await waitGone(join(srv.staticDir, 'media', name)));
  assert.ok(await waitGone(join(srv.staticDir, 'media', name + '.part')));
});

test('次数频控（mediaPerMin，按设备=write_token 哈希）→ 429', async () => {
  const s2 = await startMediaServer({ mediaPerMin: 2 });
  try {
    const p2 = makePairDirect(s2);
    const b = Buffer.alloc(4, 1);
    assert.equal((await api(s2, 'PUT', `/media/${n('1')}`, { token: p2.secrets.writeToken, rawBody: b })).status, 201);
    assert.equal((await api(s2, 'PUT', `/media/${n('2')}`, { token: p2.secrets.writeToken, rawBody: b })).status, 201);
    assert.equal((await api(s2, 'PUT', `/media/${n('3')}`, { token: p2.secrets.writeToken, rawBody: b })).status, 429);
  } finally {
    await s2.close();
    cleanupStaticDir(s2.staticDir);
  }
});

test('字节率频控（mediaBytesPerMin，声明预检）→ 429', async () => {
  const s2 = await startMediaServer({ mediaBytesPerMin: 8, mediaPerMin: 100_000 });
  try {
    const p2 = makePairDirect(s2);
    assert.equal(
      (await api(s2, 'PUT', `/media/${n('1')}`, { token: p2.secrets.writeToken, rawBody: Buffer.alloc(8, 1) }))
        .status,
      201,
    );
    assert.equal(
      (await api(s2, 'PUT', `/media/${n('2')}`, { token: p2.secrets.writeToken, rawBody: Buffer.alloc(8, 1) }))
        .status,
      429,
    );
  } finally {
    await s2.close();
    cleanupStaticDir(s2.staticDir);
  }
});

test('media 总量帽（mediaMaxTotalBytes，独立于发布总量）→ 413 quota_exceeded', async () => {
  const s2 = await startMediaServer({ mediaMaxTotalBytes: 16, mediaPerMin: 100_000, mediaBytesPerMin: 1 << 20 });
  try {
    const p2 = makePairDirect(s2);
    assert.equal(
      (await api(s2, 'PUT', `/media/${n('1')}`, { token: p2.secrets.writeToken, rawBody: Buffer.alloc(8, 1) }))
        .status,
      201,
    );
    assert.equal(
      (await api(s2, 'PUT', `/media/${n('2')}`, { token: p2.secrets.writeToken, rawBody: Buffer.alloc(8, 1) }))
        .status,
      201,
    );
    const r = await api(s2, 'PUT', `/media/${n('3')}`, {
      token: p2.secrets.writeToken,
      rawBody: Buffer.alloc(8, 1),
    });
    assert.equal(r.status, 413);
    assert.deepEqual(r.json, { error: 'quota_exceeded' });
    assert.ok(!existsSync(join(s2.staticDir, 'media', n('3'))));
  } finally {
    await s2.close();
    cleanupStaticDir(s2.staticDir);
  }
});

test('media TTL 清理 + .part 残件清理（成功上传顺带清扫）', async () => {
  const old = n('d');
  assert.equal(
    (
      await api(srv, 'PUT', `/media/${old}`, {
        token: pair.secrets.writeToken,
        rawBody: Buffer.alloc(8, 1),
      })
    ).status,
    201,
  );
  // 人为制造：超期密文（回拨 mtime）+ 超期 .part 残件（残件清扫阈值 10 分钟，回拨 20 分钟）
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(srv.staticDir, 'media', old), past, past);
  const stalePart = join(srv.staticDir, 'media', n('e') + '.part');
  writeFileSync(stalePart, Buffer.alloc(4, 1));
  utimesSync(stalePart, new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 20 * 60_000));
  srv.setNow(Date.now() + 100); // 小幅越过真实时间线（注入时钟 T0 落后于真实时间）
  const fresh = n('f');
  assert.equal(
    (
      await api(srv, 'PUT', `/media/${fresh}`, {
        token: pair.secrets.writeToken,
        rawBody: Buffer.alloc(8, 1),
      })
    ).status,
    201,
  );
  assert.ok(!existsSync(join(srv.staticDir, 'media', old)), '超期密文应被清扫');
  assert.ok(await waitGone(stalePart), '超期 .part 残件应被清扫');
  assert.ok(existsSync(join(srv.staticDir, 'media', fresh)), '新密文不应被误清');
});

test('日志不含媒体文件名（防 journald 枚举）', async () => {
  const staticDir2 = mkdtempSync(join(tmpdir(), 'relay-media-log-'));
  const logs: string[] = [];
  const store = new Store(':memory:');
  const server = createRelayServer({
    store,
    operatorKey: 'op',
    staticDir: staticDir2,
    logger: (m) => logs.push(m),
  });
  const port = await server.listen(0, '127.0.0.1');
  try {
    const wt = 'test-write-token';
    store.createMailbox('ab'.repeat(16), tokenHash(wt), tokenHash('r'), tokenHash('v'), 'd');
    const secret = n('5');
    const p = await fetch(`${staticUrl(port)}/media/${secret}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${wt}` },
      body: 'zz',
    });
    assert.equal(p.status, 201);
    const g = await fetch(`${staticUrl(port)}/static/media/${secret}`);
    assert.equal(g.status, 200);
    for (const m of logs) assert.ok(!m.includes(secret), `日志泄漏媒体名: ${m}`);
  } finally {
    await server.close();
    store.close();
    rmSync(staticDir2, { recursive: true, force: true });
  }
});

function staticUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** 轮询等待文件消失（Windows 句柄异步关闭的清理竞态容忍）。 */
async function waitGone(p: string): Promise<boolean> {
  for (let i = 0; i < 25 && existsSync(p); i++) {
    await new Promise((r) => setTimeout(r, 40));
  }
  return !existsSync(p);
}
