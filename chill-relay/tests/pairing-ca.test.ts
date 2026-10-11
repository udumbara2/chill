/**
 * pairing-ca.test.ts — 配对小码·指纹寻址缓存（规划 R1）：上传/寻址/过期/超帽/坏载荷。
 * 口径：fp = b64u(sha256(CA 文件原始字节))，服务端计算；材料 base64 往返逐位一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startServer, OPERATOR, T0, type TestServer } from './helpers.js';
import { b64uEncode } from '../src/shared/envelope.js';

function fpOf(bytes: Buffer): string {
  return b64uEncode(createHash('sha256').update(bytes).digest());
}

async function mintCa(s: TestServer, caBytes: Buffer, bearerKey = OPERATOR): Promise<{ status: number; fp: string }> {
  const r = await fetch(`${s.base}/pair/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearerKey}` },
    body: JSON.stringify({ caB64: caBytes.toString('base64') }),
  });
  return { status: r.status, fp: fpOf(caBytes) };
}

async function fetchCa(s: TestServer, fp: string): Promise<{ status: number; caB64: string | undefined }> {
  const r = await fetch(`${s.base}/pair/ca/${fp}`);
  const j = (r.status === 200 ? await r.json() : {}) as { caB64?: string };
  return { status: r.status, caB64: j.caB64 };
}

test('上传 + 寻址：材料 base64 往返逐位一致；fp 服务端计算同口径', async () => {
  const s = await startServer();
  try {
    const ca = Buffer.from('-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(400) + '\n-----END CERTIFICATE-----\n');
    const { status, fp } = await mintCa(s, ca);
    assert.equal(status, 200);
    const got = await fetchCa(s, fp);
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(got.caB64!, 'base64').equals(ca), true); // 字节同一性铁律
  } finally {
    await s.close();
  }
});

test('未存/未知 fp → 410（不区分存在过与否）', async () => {
  const s = await startServer();
  try {
    const unknown = fpOf(Buffer.alloc(200, 7));
    assert.equal((await fetchCa(s, unknown)).status, 410);
  } finally {
    await s.close();
  }
});

test('过期：expires+宽限 之后取材 410；重复铸造同 CA 幂等续期', async () => {
  const s = await startServer();
  try {
    const ca = Buffer.alloc(500, 1);
    const { fp } = await mintCa(s, ca);
    // 令牌 TTL 10min + 宽限 5min：过期前可取
    s.setNow(T0 + 14 * 60 * 1000);
    assert.equal((await fetchCa(s, fp)).status, 200);
    // 过宽限后 410
    s.setNow(T0 + 16 * 60 * 1000);
    assert.equal((await fetchCa(s, fp)).status, 410);
    // 重新铸造（时间已过）→ 同 fp 续期复活
    const again = await mintCa(s, ca);
    assert.equal(again.status, 200);
    assert.equal((await fetchCa(s, fp)).status, 200);
  } finally {
    await s.close();
  }
});

test('超帽拒：decoded > 8KB → 400；过小（<64B）→ 400；坏载荷（非字符串）→ 400', async () => {
  const s = await startServer();
  try {
    assert.equal((await mintCa(s, Buffer.alloc(9 * 1024, 3))).status, 400);
    assert.equal((await mintCa(s, Buffer.alloc(10, 3))).status, 400);
    const r = await fetch(`${s.base}/pair/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OPERATOR}` },
      body: JSON.stringify({ caB64: 123 }),
    });
    assert.equal(r.status, 400);
  } finally {
    await s.close();
  }
});

test('空 body 旧客户端兼容：无 caB64 字段照常铸造（QR 无 caFP 场景）', async () => {
  const s = await startServer();
  try {
    const r = await fetch(`${s.base}/pair/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OPERATOR}`, 'content-length': '0' },
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { token: string };
    assert.ok(j.token.length > 0);
    // 无 body 的 POST（content-length 缺省）也兼容
    const r2 = await fetch(`${s.base}/pair/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    assert.equal(r2.status, 200);
  } finally {
    await s.close();
  }
});

test('fp 形状闸：路径 fp 非 43 字符 b64u → 路由不匹配（404 兜底；410 只留给格式对而未存/过期）', async () => {
  const s = await startServer();
  try {
    const r = await fetch(`${s.base}/pair/ca/short`);
    assert.equal(r.status, 404);
    const r2 = await fetch(`${s.base}/pair/ca/${'x'.repeat(44)}`);
    assert.equal(r2.status, 404);
  } finally {
    await s.close();
  }
});
