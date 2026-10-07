/**
 * updateFeed.test.ts — 更新发现纯逻辑：feed 派生黄金向量（与 guardian mobile-push.js feedInfo 对齐）
 * + parseManifest 形状校验/体积帽/deskPubFp 自证 + offer 状态机四态/去重/BUSY/替换。
 * 原生 mock 先挂（updater 导入前）——同 updater.test.tsx 先例。
 */
import { NativeModules, NativeAppEventEmitter } from 'react-native';
import {
  updateFeedPath,
  deskPubFingerprint,
  parseManifest,
  MANIFEST_MAX_BYTES,
  shouldCheckUpdate,
  DISCOVERY_MIN_INTERVAL_MS,
} from '../src/updater/feed';

// ---- 原生 mock（须在 updater 导入前挂上）----
const fetchToCache = jest.fn();
const cancelDownload = jest.fn();
const verifyPackage = jest.fn();
const installApk = jest.fn();
const canRequestPackageInstalls = jest.fn();
const openUnknownSourcesSettings = jest.fn();
const isMetered = jest.fn();
NativeModules.DownloadModule = {
  fetchToCache,
  cancelDownload,
  verifyPackage,
  installApk,
  canRequestPackageInstalls,
  openUnknownSourcesSettings,
  isMetered,
};
jest.spyOn(NativeAppEventEmitter, 'addListener').mockImplementation((() => ({ remove: () => {} })) as never);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Updater } = require('../src/updater/updater') as typeof import('../src/updater/updater');

// 黄金向量：与桌面侧 node crypto 派生逐字对齐（guardian feedInfo 同式）
const GOLDEN_DESKPUB = 'VFB4P4byEUMwA06i30UjsrtnjL-bBRVebg05IkUfjTM';
const GOLDEN_FP = '7428ab8d8fd7100409e9e8ba';

const mkManifest = (over: Partial<import('../src/updater/feed').UpdateManifest> = {}) => ({
  snapshot: 'm20261231-235959',
  apkUrl: 'https://relay.example.test:8443/static/apk/app-m20261231-235959.apk',
  sha256: 'a'.repeat(64),
  size: 12345,
  builtAt: '2026-12-31T23:59:59.000Z',
  ...over,
});

describe('feed 派生（黄金向量）', () => {
  it('deskPub → 指纹 → feed 路径（与 guardian 对齐）', () => {
    expect(deskPubFingerprint(GOLDEN_DESKPUB)).toBe(GOLDEN_FP);
    expect(updateFeedPath(GOLDEN_DESKPUB)).toBe(`apk/feed-${GOLDEN_FP}.json`);
  });
  it('畸形输入（坏 base64url / 非 32 字节）→ null', () => {
    expect(deskPubFingerprint('!!!not-base64url!!!')).toBeNull();
    expect(deskPubFingerprint('AAAA')).toBeNull(); // 解码后 ≠32B
  });
});

describe('shouldCheckUpdate（发现频控）', () => {
  it('从未检查 → true；间隔内 → false；达到间隔 → true（旧版 1h 时代的钟也放行）', () => {
    const now = 1_700_000_000_000;
    expect(shouldCheckUpdate(undefined, now)).toBe(true);
    expect(shouldCheckUpdate(null, now)).toBe(true);
    expect(shouldCheckUpdate(now - 30_000, now)).toBe(false);
    expect(shouldCheckUpdate(now - DISCOVERY_MIN_INTERVAL_MS, now)).toBe(true);
    expect(shouldCheckUpdate(now - 3_600_000, now)).toBe(true);
  });
});

describe('parseManifest（fail-closed）', () => {
  const manifestJson = (m: Record<string, unknown>): string =>
    JSON.stringify({ v: 1, deskPubFp: GOLDEN_FP, ...m });

  it('合法清单解析通过（notes 可选）', () => {
    const m = parseManifest(manifestJson(mkManifest() as never), GOLDEN_DESKPUB);
    expect(m).not.toBeNull();
    expect(m!.snapshot).toBe('m20261231-235959');
    expect(m!.notes).toBeUndefined();
    const m2 = parseManifest(manifestJson({ ...mkManifest(), notes: '修好了拍照' } as never), GOLDEN_DESKPUB);
    expect(m2!.notes).toBe('修好了拍照');
  });

  it('形状不符拒：v≠1 / 坏 snapshot / 非 http URL / 坏 sha256 / 坏 size / 坏 builtAt / 超 200 字 notes', () => {
    const cases: Array<Record<string, unknown>> = [
      { v: 2 },
      { snapshot: 'has space' },
      { snapshot: '' },
      { apkUrl: 'ftp://x/a.apk' },
      { sha256: 'XYZ' + 'a'.repeat(61) },
      { size: 0 },
      { size: 1.5 },
      { builtAt: '' },
      { notes: 'x'.repeat(201) },
    ];
    for (const c of cases) {
      expect(parseManifest(manifestJson({ ...mkManifest(), ...c } as never), GOLDEN_DESKPUB)).toBeNull();
    }
  });

  it('deskPubFp 自证：与本机派生不符 → null（错喂/挪用他桌清单）', () => {
    const j = JSON.stringify({ v: 1, ...mkManifest(), deskPubFp: 'deadbeefdeadbeefdeadbeef' });
    expect(parseManifest(j, GOLDEN_DESKPUB)).toBeNull();
  });

  it('体积帽：超 MANIFEST_MAX_BYTES 一律拒（防清单炸弹）；畸形 JSON 拒', () => {
    const big = manifestJson({ ...mkManifest(), notes: 'x'.repeat(MANIFEST_MAX_BYTES) } as never);
    expect(big.length).toBeGreaterThan(MANIFEST_MAX_BYTES);
    expect(parseManifest(big, GOLDEN_DESKPUB)).toBeNull();
    expect(parseManifest('{not json', GOLDEN_DESKPUB)).toBeNull();
    expect(parseManifest('', GOLDEN_DESKPUB)).toBeNull();
  });
});

describe('offer 状态机（四态全定义）', () => {
  let u: import('../src/updater/updater').Updater;
  beforeEach(() => {
    jest.clearAllMocks();
    isMetered.mockResolvedValue(false);
    fetchToCache.mockResolvedValue({ path: '/cache/x.apk', bytes: 1, sha256: 'a'.repeat(64) });
    verifyPackage.mockResolvedValue(true);
    canRequestPackageInstalls.mockResolvedValue(true);
    openUnknownSourcesSettings.mockResolvedValue(undefined);
    installApk.mockResolvedValue(undefined);
    const RN = require('react-native') as { AppState: { currentState: string } };
    RN.AppState.currentState = 'active';
    u = new Updater('m20260101-000000');
  });

  it('newer → available；same/older/unknown 一律静默（unknown 含 debug 构建戳占位）', async () => {
    expect(await u.offer(mkManifest())).toBe('available');
    expect(u.getState().phase).toBe('available');
    expect(u.getState().snapshot).toBe('m20261231-235959');
    // same
    const u2 = new Updater('m20261231-235959');
    await u2.offer(mkManifest());
    expect(u2.getState().phase).toBe('idle');
    // older（自动发现不推降级卡）
    const u3 = new Updater('m20270101-000000');
    await u3.offer(mkManifest());
    expect(u3.getState().phase).toBe('idle');
    // unknown：自定义名快照 / 当前戳 'unknown'（活树 debug 占位）
    const u4 = new Updater('m20260101-000000');
    await u4.offer(mkManifest({ snapshot: 'm6-baseline' }));
    expect(u4.getState().phase).toBe('idle');
    const u5 = new Updater('unknown');
    await u5.offer(mkManifest());
    expect(u5.getState().phase).toBe('idle');
  });

  it('免流量 → 静默预下载就绪（preloaded）；confirmInstall 直达安装', async () => {
    await u.offer(mkManifest());
    await new Promise<void>((r) => setImmediate(r));
    expect(fetchToCache).toHaveBeenCalled();
    expect(u.getState().preloaded).toBe(true);
    expect(u.getState().filePath).toBe('/cache/x.apk');
    verifyPackage.mockResolvedValue(true);
    installApk.mockResolvedValue(undefined);
    await u.confirmInstall();
    await new Promise<void>((r) => setImmediate(r)); // runInstall 经 void 异步发射——断言前等一拍微任务
    expect(installApk).toHaveBeenCalledWith('/cache/x.apk');
  });

  it('预下载 sha256 与清单不符 → 不置 preloaded（留给正式下载报 checksum-mismatch）', async () => {
    fetchToCache.mockResolvedValue({ path: '/cache/x.apk', bytes: 1, sha256: 'b'.repeat(64) });
    await u.offer(mkManifest());
    await new Promise<void>((r) => setImmediate(r));
    expect(u.getState().preloaded).toBe(false);
  });

  it('dismiss（稍后）：清卡 + 落 dismissed 锚；同快照不再打扰、更新快照再现', async () => {
    await u.offer(mkManifest());
    u.dismiss();
    expect(u.getState().phase).toBe('idle');
    expect(u.consumeDismissed()).toBe('m20261231-235959');
    expect(u.consumeDismissed()).toBeNull(); // 一次性取走
    // 同快照再来（含持久化 dismissed 注入）→ 静默
    await u.offer(mkManifest(), 'm20261231-235959');
    expect(u.getState().phase).toBe('idle');
    // 更新快照 → 卡片再现
    await u.offer(mkManifest({ snapshot: 'm20270101-000000' }));
    expect(u.getState().phase).toBe('available');
  });

  it('available 期间又发现更新快照 → 原地替换（旧卡不残留）', async () => {
    await u.offer(mkManifest());
    await u.offer(mkManifest({ snapshot: 'm20270101-000000' }));
    expect(u.getState().phase).toBe('available');
    expect(u.getState().snapshot).toBe('m20270101-000000');
  });

  it('BUSY（下载中）期间 offer 静默忽略', async () => {
    fetchToCache.mockReturnValue(new Promise(() => {}));
    await u.beginUpdate('https://relay.example.test:8443/static/apk/app-m20271231-000000.apk');
    expect(u.getState().phase).toBe('downloading');
    await u.offer(mkManifest());
    expect(u.getState().phase).toBe('downloading');
  });

  it('单飞下载：预下载在途时点立即安装 → 收编同一条（fetchToCache 全程只调一次）', async () => {
    let resolveFetch: (v: { path: string; bytes: number; sha256?: string }) => void = () => {};
    fetchToCache.mockReturnValue(
      new Promise<{ path: string; bytes: number; sha256?: string }>((r) => {
        resolveFetch = r;
      }),
    );
    await u.offer(mkManifest()); // available + 预下载启动（在途）
    expect(fetchToCache).toHaveBeenCalledTimes(1);
    await u.confirmInstall(); // 点按 → 收编在途下载，不另起第二条
    expect(u.getState().phase).toBe('downloading');
    expect(fetchToCache).toHaveBeenCalledTimes(1); // 核心回归断言：同 URL 永不重复开跑
    resolveFetch({ path: '/cache/x.apk', bytes: 1, sha256: 'a'.repeat(64) });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    expect(installApk).toHaveBeenCalledWith('/cache/x.apk'); // 共享结果落定 → 哈希过 → 包名过 → 安装
  });

  it('重试保留清单哈希：同 URL 的 beginUpdate 不清 expectedSha256（完整性闭环不因重试降级）', async () => {
    fetchToCache.mockReturnValue(new Promise(() => {}));
    await u.offer(mkManifest());
    expect(u.getState().expectedSha256).toBe('a'.repeat(64));
    await u.confirmInstall();
    expect(u.getState().phase).toBe('downloading');
    u.cancel(); // → failed(canceled)，重试走 beginUpdate 同 URL
    await u.beginUpdate(mkManifest().apkUrl);
    expect(u.getState().expectedSha256).toBe('a'.repeat(64));
    u.cancel(); // 再次落 failed（BUSY 中 beginUpdate 会被单飞挡回）
    await u.beginUpdate('https://relay.example.test:8443/static/apk/app-m20271231-000000.apk');
    expect(u.getState().expectedSha256).toBeUndefined();
  });

  it('清单哈希对账：manifest 驱动链（offer→计量→confirmInstall）下载 sha256 不符 → failed(checksum-mismatch)', async () => {
    isMetered.mockResolvedValue(true); // 阻断预下载 → confirmInstall 走正式下载链（expectedSha256 保留）
    fetchToCache.mockResolvedValue({ path: '/cache/x.apk', bytes: 1, sha256: 'c'.repeat(64) });
    await u.offer(mkManifest()); // offer 时 isMetered=true → 不预下载
    await u.confirmInstall(); // afterGates：计量闸又查一次 → mock 仍 true → metered-confirm？
    // 计量闸会拦：confirmInstall 的正式链也要过流量确认——直接以 confirmProceed 走通
    if (u.getState().phase === 'metered-confirm') await u.confirmProceed(mkManifest().apkUrl);
    expect(u.getState().phase).toBe('failed');
    expect(u.getState().error).toBe('checksum-mismatch');
  });

  it('点链接路径（无清单）：无 expectedSha256 则跳过哈希对账（向后兼容）', async () => {
    fetchToCache.mockResolvedValue({ path: '/cache/x.apk', bytes: 1, sha256: 'c'.repeat(64) });
    await u.beginUpdate('https://relay.example.test:8443/static/apk/app-m20271231-000000.apk');
    await new Promise<void>((r) => setImmediate(r));
    expect(u.getState().phase).not.toBe('failed');
  });
});
