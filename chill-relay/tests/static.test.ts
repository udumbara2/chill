/** 静态发布通道：PUT /publish + GET /static/*（鉴权分层/白名单/配额/清理/日志防枚举）。 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import {
  startServer,
  startPublishServer,
  cleanupStaticDir,
  api,
  type TestServer,
} from './helpers.js';
import { createRelayServer } from '../src/server.js';
import { Store } from '../src/store.js';

// 小限额：单文件 64B / 总量 200B / shots TTL 1s（注入时钟）
let srv: TestServer & { staticDir: string; token: string };
let plainSrv: TestServer; // 未配置发布通道

before(async () => {
  srv = await startPublishServer({
    publishPerMin: 100_000,
    publishMaxFileBytes: 64,
    publishMaxTotalBytes: 200,
    shotTtlMs: 1000,
  });
  plainSrv = await startServer();
});
after(async () => {
  await srv.close();
  cleanupStaticDir(srv.staticDir);
  await plainSrv.close();
});

test('未配置静态家族（无 publishToken/staticDir）：/publish 与 /static 均 404（路由不注册）', async () => {
  assert.equal(
    (
      await api(plainSrv, 'PUT', '/publish?name=shots/a.png', {
        token: 'x',
        rawBody: Buffer.from('x'),
      })
    ).status,
    404,
  );
  assert.equal((await api(plainSrv, 'GET', '/static/shots/a.png')).status, 404);
});

test('publish 鉴权：无/错 token 401', async () => {
  assert.equal(
    (await api(srv, 'PUT', '/publish?name=shots/a.png', { rawBody: Buffer.from('x') })).status,
    401,
  );
  assert.equal(
    (
      await api(srv, 'PUT', '/publish?name=shots/a.png', {
        token: 'wrong',
        rawBody: Buffer.from('x'),
      })
    ).status,
    401,
  );
});

test('publish 非法名拒：无前缀/穿越/坏扩展/空/缺参', async () => {
  for (const name of ['evil.png', 'shots/../relay.db', 'shots/a.txt', '']) {
    const q = '/publish?name=' + encodeURIComponent(name);
    assert.equal(
      (await api(srv, 'PUT', q, { token: srv.token, rawBody: Buffer.from('x') })).status,
      400,
      `name=${name}`,
    );
  }
  assert.equal(
    (await api(srv, 'PUT', '/publish', { token: srv.token, rawBody: Buffer.from('x') })).status,
    400,
  );
});

test('publish + GET 正常往返：201/落盘/字节一致/类型头/nosniff', async () => {
  const payload = Buffer.from('PNGDATA-001');
  const r = await api(srv, 'PUT', '/publish?name=shots/ok1.png', {
    token: srv.token,
    rawBody: payload,
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { url: '/static/shots/ok1.png' });
  assert.ok(existsSync(join(srv.staticDir, 'shots/ok1.png')));
  assert.equal(readFileSync(join(srv.staticDir, 'shots/ok1.png'), 'utf8'), 'PNGDATA-001');
  const g = await fetch(`${srv.base}/static/shots/ok1.png`);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'image/png');
  assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await g.arrayBuffer()).byteLength, payload.length);
});

test('GET：不存在 404 / 根 404 / 编码穿越 404', async () => {
  assert.equal((await api(srv, 'GET', '/static/shots/missing.png')).status, 404);
  assert.equal((await api(srv, 'GET', '/static/')).status, 404);
  assert.equal(
    (await api(srv, 'GET', '/static/shots/' + encodeURIComponent('../db.sqlite'))).status,
    404,
  );
});

test('apk 类型头 application/vnd.android.package-archive', async () => {
  const r = await api(srv, 'PUT', '/publish?name=apk/app-m1.apk', {
    token: srv.token,
    rawBody: Buffer.alloc(16, 1),
  });
  assert.equal(r.status, 201);
  const g = await fetch(`${srv.base}/static/apk/app-m1.apk`);
  assert.equal(g.headers.get('content-type'), 'application/vnd.android.package-archive');
});

test('单文件超限（声明超限）→ 413 too_large', async () => {
  const r = await api(srv, 'PUT', '/publish?name=shots/big.png', {
    token: srv.token,
    rawBody: Buffer.alloc(65, 7),
  });
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { error: 'too_large' });
  assert.ok(!existsSync(join(srv.staticDir, 'shots/big.png')));
});

test('总量超限 → 413 quota_exceeded（事前声明检查）', async () => {
  const b64 = Buffer.alloc(64, 3);
  assert.equal(
    (await api(srv, 'PUT', '/publish?name=apk/q1.apk', { token: srv.token, rawBody: b64 })).status,
    201,
  );
  assert.equal(
    (await api(srv, 'PUT', '/publish?name=apk/q2.apk', { token: srv.token, rawBody: b64 })).status,
    201,
  );
  // 已用：11 + 16 + 64*2 = 155；q3 声明 64 → 219 > 200 → 拒
  const r = await api(srv, 'PUT', '/publish?name=apk/q3.apk', { token: srv.token, rawBody: b64 });
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { error: 'quota_exceeded' });
  assert.ok(!existsSync(join(srv.staticDir, 'apk/q3.apk')));
});

test('分块超限（无声明、流式中途掐断）→ 413 或连接错，无残留', async () => {
  const res = await new Promise<{ status: number | null }>((resolve) => {
    const req = httpRequest(
      new URL('/publish?name=shots/chunk.png', srv.base),
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${srv.token}` },
      },
      (r) => resolve({ status: r.statusCode ?? null }),
    );
    req.on('error', () => resolve({ status: null }));
    req.write(Buffer.alloc(40, 9));
    req.write(Buffer.alloc(40, 9)); // 80 > 64 → 流中掐断
    req.end();
  });
  assert.ok(res.status === 413 || res.status === null, `status=${res.status}`);
  assert.ok(await waitGone(join(srv.staticDir, 'shots/chunk.png')));
  assert.ok(await waitGone(join(srv.staticDir, 'shots/chunk.png.part')));
});

/** 轮询等待文件消失（Windows 句柄异步关闭的清理竞态容忍）。 */
async function waitGone(p: string): Promise<boolean> {
  for (let i = 0; i < 25 && existsSync(p); i++) {
    await new Promise((r) => setTimeout(r, 40));
  }
  return !existsSync(p);
}

test('json 白名单：apk/ 版本清单与 shots/ json 均放行（类型头 application/json）；非白名单扩展仍拒', async () => {
  // 手机自动更新发现的 feed 清单（apk/feed-<deskPub 指纹>.json）；shots/json 同样放行（无害，配额兜底）
  const r = await api(srv, 'PUT', '/publish?name=apk/feed-test000000000000.json', {
    token: srv.token,
    rawBody: Buffer.from('{"v":1}'),
  });
  assert.equal(r.status, 201);
  const g = await fetch(`${srv.base}/static/apk/feed-test000000000000.json`);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'application/json');
  assert.equal(await g.text(), '{"v":1}');
  assert.equal(
    (await api(srv, 'PUT', '/publish?name=shots/z.json', { token: srv.token, rawBody: Buffer.from('z') }))
      .status,
    201,
  );
  // 非白名单扩展仍拒（xml/html/exe 一律 400——白名单只加了 json，没开别的口子）
  for (const name of ['shots/a.xml', 'apk/b.html', 'apk/c.exe']) {
    const q = '/publish?name=' + encodeURIComponent(name);
    assert.equal(
      (await api(srv, 'PUT', q, { token: srv.token, rawBody: Buffer.from('x') })).status,
      400,
      `name=${name}`,
    );
  }
});

test('shots TTL 清理：过期即删、apk 永存', async () => {
  const r = await api(srv, 'PUT', '/publish?name=shots/old.png', {
    token: srv.token,
    rawBody: Buffer.alloc(8, 5),
  });
  assert.equal(r.status, 201, `old.png status=${r.status} body=${JSON.stringify(r.json)}`);
  assert.ok(existsSync(join(srv.staticDir, 'shots/old.png')));
  // 模拟时间流逝：回拨旧图 mtime——注入时钟与真实 mtime 是两个钟，直接跳钟会让
  // 刚上传的新图同时"变老"被误删（测试假象，非生产语义；生产两钟合一恒为真实时间）
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(srv.staticDir, 'shots/old.png'), past, past);
  srv.setNow(Date.now() + 100); // 小幅越过真实时间线（注入时钟 T0 落后于真实时间）
  const r2 = await api(srv, 'PUT', '/publish?name=shots/new.png', {
    token: srv.token,
    rawBody: Buffer.alloc(8, 5),
  });
  assert.equal(r2.status, 201);
  assert.ok(!existsSync(join(srv.staticDir, 'shots/old.png')), '过期 shot 应被清理');
  assert.ok(existsSync(join(srv.staticDir, 'shots/new.png')), '新 shot 不应被误清');
  assert.ok(existsSync(join(srv.staticDir, 'apk/app-m1.apk')), 'apk 不受 TTL 影响');
});

test('publish 频控 → 429', async () => {
  const s2 = await startPublishServer({ publishPerMin: 2 });
  try {
    const b = Buffer.from('x');
    assert.equal(
      (await api(s2, 'PUT', '/publish?name=shots/r1.png', { token: s2.token, rawBody: b })).status,
      201,
    );
    assert.equal(
      (await api(s2, 'PUT', '/publish?name=shots/r2.png', { token: s2.token, rawBody: b })).status,
      201,
    );
    assert.equal(
      (await api(s2, 'PUT', '/publish?name=shots/r3.png', { token: s2.token, rawBody: b })).status,
      429,
    );
  } finally {
    await s2.close();
    cleanupStaticDir(s2.staticDir);
  }
});

test('日志不含产物文件名（防 journald 枚举）', async () => {
  const staticDir2 = mkdtempSync(join(tmpdir(), 'relay-static-log-'));
  const logs: string[] = [];
  const store = new Store(':memory:');
  const server = createRelayServer({
    store,
    operatorKey: 'op',
    publishToken: 'pt',
    staticDir: staticDir2,
    logger: (m) => logs.push(m),
  });
  const port = await server.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${port}`;
    const p = await fetch(`${base}/publish?name=shots/secret-name.png`, {
      method: 'PUT',
      headers: { authorization: 'Bearer pt' },
      body: 'zz',
    });
    assert.equal(p.status, 201);
    const g = await fetch(`${base}/static/shots/secret-name.png`);
    assert.equal(g.status, 200);
    for (const m of logs) assert.ok(!m.includes('secret-name'), `日志泄漏文件名: ${m}`);
  } finally {
    await server.close();
    store.close();
    rmSync(staticDir2, { recursive: true, force: true });
  }
});

test('apk/ 保留最近 N 版：超出淘汰最旧（mtime 序），feed 清单引用的包豁免', async () => {
  const apkSrv = await startPublishServer({
    publishPerMin: 100_000,
    publishMaxFileBytes: 1 << 20,
    publishMaxTotalBytes: 1 << 24,
    apkKeepLatest: 3,
  });
  try {
    const put = (name: string, body: string) =>
      api(apkSrv, 'PUT', `/publish?name=${name}`, { token: apkSrv.token, rawBody: Buffer.from(body) });
    const apkPath = (n: string) => join(apkSrv.staticDir, 'apk', n);
    // 连续发 5 版；utimesSync 钉死 mtime 序（v1 最旧 … v5 最新）——淘汰每次发布落定即触发
    for (let i = 1; i <= 5; i++) {
      assert.equal((await put(`apk/app-v${i}.apk`, `APK-${i}`)).status, 201);
      utimesSync(apkPath(`app-v${i}.apk`), new Date(2026, 0, i), new Date(2026, 0, i));
    }
    // keep=3 → 只剩 v3/v4/v5
    assert.ok(!existsSync(apkPath('app-v1.apk')));
    assert.ok(!existsSync(apkPath('app-v2.apk')));
    for (const n of ['app-v3.apk', 'app-v4.apk', 'app-v5.apk']) assert.ok(existsSync(apkPath(n)), n);

    // feed 清单引用最旧的存活版 v3 → 后续淘汰豁免它
    assert.equal(
      (
        await put(
          'apk/feed-abcd1234.json',
          JSON.stringify({ v: 1, apkUrl: 'https://relay.example/static/apk/app-v3.apk' }),
        )
      ).status,
      201,
    );
    // 坏清单不阻塞清扫（直接落一个畸形 feed，再发新版触发淘汰）
    writeFileSync(apkPath('feed-broken.json'), '{not json');
    for (const i of [6, 7]) {
      assert.equal((await put(`apk/app-v${i}.apk`, `APK-${i}`)).status, 201);
      utimesSync(apkPath(`app-v${i}.apk`), new Date(2026, 0, i), new Date(2026, 0, i));
    }
    // 最新 3 版 = v5/v6/v7；v3 因 feed 引用豁免保留；v4 淘汰
    assert.ok(existsSync(apkPath('app-v3.apk')), 'feed 引用的包须豁免');
    assert.ok(!existsSync(apkPath('app-v4.apk')));
    for (const n of ['app-v5.apk', 'app-v6.apk', 'app-v7.apk']) assert.ok(existsSync(apkPath(n)), n);
    // feed 文件本身永不被动
    assert.ok(existsSync(apkPath('feed-abcd1234.json')));
    assert.ok(existsSync(apkPath('feed-broken.json')));
  } finally {
    await apkSrv.close();
    cleanupStaticDir(apkSrv.staticDir);
  }
});
