/**
 * mediaPublisher.test.ts — 媒体直传纯逻辑：发布（加密/名形/进度/失败分类）
 * + crypto 往返（seal→open 恢复明文）+ presence 门控回退决策矩阵。
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { openMediaBlob, MEDIA_NAME_RE, FILE_MAX_BYTES, b64uDecode } from '../src/relay/envelope';
import {
  publishMedia,
  randomMediaName,
  receiptWaitStep,
  STATIC_RECEIPT_ONLINE_WINDOW_MS,
  STATIC_WAIT_MAX_MS,
} from '../src/relay/mediaPublisher';

describe('publishMedia', () => {
  it('发布成功：名形/密钥 32B/sha256/size 全对；进度透传；密文可被 offer 密钥解回（crypto 往返）', async () => {
    const plain = new Uint8Array(500);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 13) % 251;
    const seenWire: Uint8Array[] = [];
    const progress: number[] = [];
    const r = await publishMedia({
      bytes: plain,
      put: async (name, wire, onProgress) => {
        expect(MEDIA_NAME_RE.test(name)).toBe(true);
        expect(name.startsWith('/')).toBe(false);
        seenWire.push(wire);
        onProgress?.(42);
        onProgress?.(100);
        return 201;
      },
      onProgress: (p) => progress.push(p),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.size).toBe(plain.length);
    expect(r.sha256).toBe(bytesToHex(sha256(plain)));
    expect(b64uDecode(r.key).length).toBe(32);
    expect(progress).toEqual([42, 100]);
    // 密文 ≠ 明文；且用返回的 key 能完整解回（桌面消费同款原语）
    expect(seenWire[0].length).toBeGreaterThan(plain.length);
    expect(openMediaBlob(seenWire[0], r.key)).toEqual(plain);
    expect(openMediaBlob(seenWire[0], 'AAAA')).toBeNull(); // 错钥 fail-closed
  });

  it('put 失败（404=旧 relay / 403 / 413 / 429 / 0=网络）→ {ok:false, put-failed, status}（调用方回退）', async () => {
    for (const status of [404, 403, 413, 429, 0]) {
      const r = await publishMedia({ bytes: new Uint8Array(4), put: async () => status });
      expect(r).toEqual({ ok: false, reason: 'put-failed', status });
    }
  });

  it('超 5MB 策略帽 → too-large（双路径同帽——回退对称性）', async () => {
    const r = await publishMedia({
      bytes: new Uint8Array(FILE_MAX_BYTES + 1),
      put: async () => 201,
    });
    expect(r).toEqual({ ok: false, reason: 'too-large' });
  });

  it('randomMediaName：恒匹配名形、彼此不同', () => {
    const names = new Set(Array.from({ length: 8 }, () => randomMediaName()));
    expect(names.size).toBe(8);
    for (const n of names) expect(MEDIA_NAME_RE.test(n)).toBe(true);
  });
});

describe('receiptWaitStep（presence 门控回退决策）', () => {
  it('离线恒 wait（不回退——否则媒体灌回信箱，复活离线旧病）', () => {
    expect(receiptWaitStep(false, 999_999, 1_000)).toBe('wait');
  });

  it('在线累计满窗（20s）无回执 → fallback（旧桌面判定）', () => {
    expect(receiptWaitStep(true, STATIC_RECEIPT_ONLINE_WINDOW_MS, 21_000)).toBe('fallback');
    expect(receiptWaitStep(true, STATIC_RECEIPT_ONLINE_WINDOW_MS - 1, 21_000)).toBe('wait');
  });

  it('presence 翻转清零在线累计（在线→离线→再在线，窗口重算）', () => {
    // 在线 18s → 掉线一拍（离线）→ wait 且调用方清零 → 再在线从零累计
    expect(receiptWaitStep(false, 18_000, 20_000)).toBe('wait');
    expect(receiptWaitStep(true, 2_000, 22_000)).toBe('wait');
  });

  it('总时长到顶（15 分钟）→ timeout-error（诚实失败；媒体在服务器 48h）', () => {
    expect(receiptWaitStep(false, 0, STATIC_WAIT_MAX_MS)).toBe('timeout-error');
    expect(receiptWaitStep(true, 0, STATIC_WAIT_MAX_MS + 1)).toBe('timeout-error');
  });
});
