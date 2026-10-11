/**
 * pairingTrust.test.ts — 信任判定 + 引导取材单测（规划迭代 B + 配对小码 R3）。
 * 四态五分支 SSOT=src/relay/trust.ts；执行层（CaTrustModule）由真机矩阵覆盖。
 */
import {
  resolvePairingTrust,
  cleartextWarning,
  bootstrapPairingCa,
  caBytesToDerB64,
  caBytesMatchFp,
  caB64ToBytes,
  type CaFetcher,
} from '../src/relay/trust';
import type { PhoneState } from '../src/relay/storage';
import { CA_FP } from '../src/relay/ca-bundle';
import { createHash } from 'node:crypto';

describe('resolvePairingTrust 五分支（规划 R3）', () => {
  it('QR 带 caCert（合法 base64，旧桌面过渡）→ 严格钉住', () => {
    const r = resolvePairingTrust({ caCert: 'MIIBvzCCAYagAwIBAgIUAAA', caFP: 'somefp' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tls).toEqual({ mode: 'pinned', caB64: 'MIIBvzCCAYagAwIBAgIUAAA' });
  });

  it('caFP≠内置 + wss → bootstrap（新常态：材料经指纹锚鉴别获取）', () => {
    const r = resolvePairingTrust({ caFP: 'external-fp', relay: 'wss://relay.example.com:8443' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bootstrap).toBe(true);
      expect(r.tls).toBeUndefined();
    }
  });

  it('caFP==内置 → legacy 直通（作者场景零网络）', () => {
    const r = resolvePairingTrust({ caFP: CA_FP, relay: 'wss://relay.example.com:8443' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bootstrap).toBeUndefined();
      expect(r.tls).toBeUndefined();
    }
  });

  it('caFP≠内置 + 非 wss → abort（畸形载荷：CA 模式只存在于 wss）', () => {
    const r = resolvePairingTrust({ caFP: 'external-fp', relay: 'ws://192.168.1.5:8443' });
    expect(r.ok).toBe(false);
  });

  it('caCert 非 base64 / 类型非法 → 拒绝', () => {
    expect(resolvePairingTrust({ caCert: '不是合法base64!!' }).ok).toBe(false);
    expect(resolvePairingTrust({ caCert: 123 }).ok).toBe(false);
  });

  it('两者皆无（公共证书）→ system；钉住态不与 caFP 交叉校验（安全剧场留痕）', () => {
    const r = resolvePairingTrust({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tls).toEqual({ mode: 'system' });
    const a = resolvePairingTrust({ caCert: 'AAA', caFP: 'x' });
    const b = resolvePairingTrust({ caCert: 'AAA' });
    expect(a).toEqual(b);
  });
});

describe('bootstrapPairingCa 引导取材（获取≠信任）', () => {
  const certPem = '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(400) + '\n-----END CERTIFICATE-----\n';
  const certBytes = new TextEncoder().encode(certPem);
  const goodFp = createHash('sha256').update(certBytes).digest('base64url');

  it('取材成功 → caB64 透传（锚校验在调用方）', async () => {
    const fetcher: CaFetcher = async () => JSON.stringify({ caB64: Buffer.from(certBytes).toString('base64') });
    const r = await bootstrapPairingCa({ relay: 'wss://127.0.0.1:8443', caFP: goodFp }, fetcher);
    expect('error' in r).toBe(false);
  });

  it('fetch 抛错 → 可行动 error（中继旧/网络）', async () => {
    const fetcher: CaFetcher = async () => {
      throw new Error('HTTP 410');
    };
    const r = await bootstrapPairingCa({ relay: 'wss://x:1', caFP: 'f'.repeat(43) }, fetcher);
    expect('error' in r && r.error).toContain('取材失败');
  });

  it('非 JSON 响应 / 缺 caB64 → error', async () => {
    const bad: CaFetcher = async () => 'not json';
    expect('error' in (await bootstrapPairingCa({ relay: 'wss://x:1', caFP: 'f'.repeat(43) }, bad))).toBe(true);
    const empty: CaFetcher = async () => '{}';
    expect('error' in (await bootstrapPairingCa({ relay: 'wss://x:1', caFP: 'f'.repeat(43) }, empty))).toBe(true);
  });
});

describe('锚校验与 DER 提取', () => {
  const pem = '-----BEGIN CERTIFICATE-----\n' + 'AB'.repeat(200) + '\n-----END CERTIFICATE-----\n';
  const bytes = new TextEncoder().encode(pem);

  it('caBytesMatchFp：sha256(PEM 字节) base64url 与 node 口径一致', () => {
    const nodeFp = createHash('sha256').update(bytes).digest('base64url');
    expect(caBytesMatchFp(bytes, nodeFp)).toBe(true);
    expect(caBytesMatchFp(bytes, 'wrong')).toBe(false);
  });

  it('caBytesToDerB64：PEM 提取证书体（标准 base64 原样）；裸 DER 直接编码', () => {
    const derB64 = caBytesToDerB64(bytes);
    expect(derB64).toBe('AB'.repeat(200));
    const der = new Uint8Array(100).map((_, i) => i);
    const derB642 = caBytesToDerB64(der);
    expect(derB642).toBe(Buffer.from(der).toString('base64'));
    expect(caBytesToDerB64(new TextEncoder().encode('-----BEGIN TRUST STORE-----x'))).toBeNull();
  });

  it('caB64ToBytes：标准/ url 变体/缺 padding 均可解码；坏输入 null', () => {
    const b = new Uint8Array([1, 2, 3, 250]);
    const std = Buffer.from(b).toString('base64');
    expect(Array.from(caB64ToBytes(std)!)).toEqual([1, 2, 3, 250]);
    const url = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(Array.from(caB64ToBytes(url)!)).toEqual([1, 2, 3, 250]);
    expect(caB64ToBytes('!!!')).toBeNull();
  });
});

describe('cleartextWarning 明文警示（决策现场）', () => {
  it('ws:// 中继 → 警示含明文与家庭网络建议', () => {
    const w = cleartextWarning('ws://192.168.1.5:8443');
    expect(w).toContain('ws://');
    expect(w).toContain('家庭网络');
  });

  it('wss:// 中继 → 无警示', () => {
    expect(cleartextWarning('wss://relay.example.com:8443')).toBe('');
  });
});

describe('PhoneState.tls 持久化 round-trip（keychain JSON 载荷形状）', () => {
  it('pinned 态序列化/反序列化保形', () => {
    const s: PhoneState = {
      secretKey: 'k',
      publicKey: 'p',
      token: 't',
      deskPub: 'd',
      relay: 'wss://relay.example.com:8443',
      name: 'n',
      confirmed: true,
      helloSent: true,
      tls: { mode: 'pinned', caB64: 'MIIBvzCCAYagAwIBAgIUAAA' },
    };
    const back = JSON.parse(JSON.stringify(s)) as PhoneState;
    expect(back.tls).toEqual({ mode: 'pinned', caB64: 'MIIBvzCCAYagAwIBAgIUAAA' });
  });

  it('system 态 round-trip 保形；undefined 序列化自然剔键（legacy 兼容）', () => {
    const s = { relay: 'wss://x', tls: { mode: 'system' as const } };
    expect((JSON.parse(JSON.stringify(s)) as PhoneState).tls).toEqual({ mode: 'system' });
    const legacy = { relay: 'wss://x', tls: undefined };
    expect('tls' in (JSON.parse(JSON.stringify(legacy)) as object)).toBe(false);
  });
});
