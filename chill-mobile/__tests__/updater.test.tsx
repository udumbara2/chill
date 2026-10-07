/**
 * updater.test.tsx — 更新器纯逻辑三分区：URL 路由白名单 / 降级闸解析比对 / 状态机转移。
 * 原生模块全 mock（NativeModules.DownloadModule + AppState + 事件发射）。
 */
import { NativeModules, NativeAppEventEmitter, AppState } from 'react-native';
import { routeStaticUrl } from '../src/updater/routeStaticUrl';
import { compareVersions, extractSnapshotFromUrl, parseSnapshotStamp } from '../src/updater/versionGate';

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

// 事件发射器 mock（DownloadProgress / InstallResult 回执通道）
const listeners = new Map<string, Set<(e: unknown) => void>>();
const fire = (event: string, payload: unknown): void => {
  listeners.get(event)?.forEach((fn) => fn(payload));
};
jest.spyOn(NativeAppEventEmitter, 'addListener').mockImplementation(((event: string, fn: (e: unknown) => void) => {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
  return { remove: () => listeners.get(event)!.delete(fn) } as never;
}) as never);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { updater } = require('../src/updater/updater') as typeof import('../src/updater/updater');

const RELAY = 'https://relay.example.test:8443';
const APK = `${RELAY}/static/apk/app-m20260923-214234.apk`;
const SHOT = `${RELAY}/static/shots/x.png`;

beforeEach(() => {
  jest.clearAllMocks();
  listeners.clear();
  isMetered.mockResolvedValue(false);
  verifyPackage.mockResolvedValue(true);
  canRequestPackageInstalls.mockResolvedValue(true);
  openUnknownSourcesSettings.mockResolvedValue(undefined);
  fetchToCache.mockResolvedValue({ path: '/cache/updates/a.apk', bytes: 10 });
  // installApk resolve='started'（系统页已发起）→ 结果走 InstallResult 回执（mock 自动 success）
  installApk.mockImplementation(async () => {
    fire('InstallResult', { status: 'success' });
    return 'started';
  });
  (AppState as unknown as { currentState: string }).currentState = 'active';
  updater.reset();
});

// ---------- D1：URL 路由白名单 ----------
describe('routeStaticUrl', () => {
  it('本中继 apk/shot 链接 → 接管', () => {
    expect(routeStaticUrl(APK, RELAY)).toEqual({ kind: 'apk', url: APK });
    expect(routeStaticUrl(SHOT, RELAY)).toEqual({ kind: 'shot', url: SHOT });
  });
  it('伪造域 / 子域伪装 / 端口不一致 → external', () => {
    expect(routeStaticUrl('https://evil.com/static/apk/a.apk', RELAY).kind).toBe('external');
    expect(routeStaticUrl('https://relay.example.test.evil.com/static/apk/a.apk', RELAY).kind).toBe('external');
    expect(routeStaticUrl('https://relay.example.test:8444/static/apk/a.apk', RELAY).kind).toBe('external');
  });
  it('userinfo 伪装（@ 前置假 host）→ URL 解析后 host 不等 → external', () => {
    expect(routeStaticUrl(`https://relay.example.test:8443@evil.com/static/apk/a.apk`, RELAY).kind).toBe('external');
  });
  it('路径穿越：树内 .. 被 URL 规范化（按落点路由）；逃逸出 static/ → external', () => {
    // WHATWG URL 消解点段：/static/apk/../shots/x.png → /static/shots/x.png（合法 shot）
    expect(routeStaticUrl(`${RELAY}/static/apk/../shots/x.png`, RELAY).kind).toBe('shot');
    // 逃逸出 static/ 树 → external
    expect(routeStaticUrl(`${RELAY}/static/apk/../../etc/passwd`, RELAY).kind).toBe('external');
    expect(routeStaticUrl(`${RELAY}/static/apk/%2e%2e/x`, RELAY).kind).toBe('external');
    expect(routeStaticUrl(`${RELAY}/static/other/a.apk`, RELAY).kind).toBe('external');
  });
  it('尾斜杠/默认端口归一化后仍接管；relay 为空 → external', () => {
    expect(routeStaticUrl(APK, `${RELAY}/`).kind).toBe('apk');
    expect(routeStaticUrl('https://example.com/static/apk/a.apk', 'https://example.com:443').kind).toBe('apk');
    expect(routeStaticUrl(APK, null).kind).toBe('external');
    expect(routeStaticUrl('not a url', RELAY).kind).toBe('external');
  });
});

// ---------- 降级闸：解析/比对 ----------
describe('versionGate', () => {
  it('时间戳形解析与字典序比对', () => {
    expect(parseSnapshotStamp('m20260923-214234')).toBe('20260923-214234');
    expect(compareVersions('m20260923-214234', 'm20260923-203356')).toBe('newer');
    expect(compareVersions('m20260923-203356', 'm20260923-214234')).toBe('older');
    expect(compareVersions('m20260923-214234', 'm20260923-214234')).toBe('same');
  });
  it('自定义名（m6-baseline）/缺戳 = 未知 → 自动流', () => {
    expect(parseSnapshotStamp('m6-baseline')).toBeNull();
    expect(compareVersions('m6-baseline', 'm20260923-214234')).toBe('unknown');
    expect(compareVersions('m20260923-214234', 'unknown')).toBe('unknown');
    expect(compareVersions(null, null)).toBe('unknown');
  });
  it('URL 文件名提取', () => {
    expect(extractSnapshotFromUrl(APK)).toBe('m20260923-214234');
    expect(extractSnapshotFromUrl(`${RELAY}/static/apk/app-m6-baseline.apk`)).toBe('m6-baseline');
    expect(extractSnapshotFromUrl(SHOT)).toBeNull();
    expect(extractSnapshotFromUrl('bogus')).toBeNull();
  });
});

// ---------- 状态机 ----------
describe('updater 状态机', () => {
  it('新版链接：下载 → 预检过 → 前台自动安装 → done', async () => {
    const phase = await updater.beginUpdate(`${RELAY}/static/apk/app-m20270101-000000.apk`);
    expect(phase).toBe('downloading');
    await new Promise<void>((r) => setImmediate(r));
    expect(installApk).toHaveBeenCalledWith('/cache/updates/a.apk');
    expect(updater.getState().phase).toBe('done');
  });

  it('降级链接：停在 downgrade-confirm，不下载不安装；confirm 后走全程', async () => {
    // 构造注入当前戳（2027 版看 214234 → older）；无需模块黑魔法
    const { Updater } = require('../src/updater/updater') as typeof import('../src/updater/updater');
    const u = new Updater('m20270101-000000');
    const phase = await u.beginUpdate(APK); // 214234 < 20270101 → older
    expect(phase).toBe('downgrade-confirm');
    expect(fetchToCache).not.toHaveBeenCalled();
    expect(installApk).not.toHaveBeenCalled();
    const p2 = await u.confirmProceed(APK);
    expect(p2).toBe('downloading');
    await new Promise<void>((r) => setImmediate(r));
    expect(installApk).toHaveBeenCalled();
  });

  it('他包预检拒绝：不进安装流', async () => {
    verifyPackage.mockResolvedValue(false);
    await updater.beginUpdate(`${RELAY}/static/apk/app-m20270101-000000.apk`);
    await new Promise<void>((r) => setImmediate(r));
    expect(installApk).not.toHaveBeenCalled();
    expect(updater.getState().phase).toBe('failed');
    expect(updater.getState().error).toBe('not-our-package');
  });

  it('单飞：下载中再请求 → busy（状态不动）', async () => {
    let release!: (v: unknown) => void;
    fetchToCache.mockReturnValue(new Promise((r) => (release = r)));
    const p1 = updater.beginUpdate(`${RELAY}/static/apk/app-m20270101-000000.apk`);
    await new Promise<void>((r) => setImmediate(r));
    expect(updater.getState().phase).toBe('downloading');
    const p2 = await updater.beginUpdate(`${RELAY}/static/apk/app-m20270202-000000.apk`);
    expect(p2).toBe('busy');
    expect(updater.getState().phase).toBe('downloading');
    release({ path: '/cache/updates/a.apk', bytes: 1 });
    await p1;
    await new Promise<void>((r) => setImmediate(r));
  });

  it('计量网络 → metered-confirm；确认后继续', async () => {
    isMetered.mockResolvedValue(true);
    const phase = await updater.beginUpdate(`${RELAY}/static/apk/app-m20270101-000000.apk`);
    expect(phase).toBe('metered-confirm');
    expect(fetchToCache).not.toHaveBeenCalled();
    await updater.confirmProceed(`${RELAY}/static/apk/app-m20270101-000000.apk`);
    await new Promise<void>((r) => setImmediate(r));
    expect(fetchToCache).toHaveBeenCalled();
  });

  it('无安装授权 → 引导设置页 + failed（不弹系统页）', async () => {
    canRequestPackageInstalls.mockResolvedValue(false);
    await updater.beginUpdate(`${RELAY}/static/apk/app-m20270101-000000.apk`);
    await new Promise<void>((r) => setImmediate(r));
    expect(openUnknownSourcesSettings).toHaveBeenCalled();
    expect(installApk).not.toHaveBeenCalled();
    expect(updater.getState().error).toBe('need-install-permission');
  });

  it('取消下载 → failed(canceled)', async () => {
    fetchToCache.mockReturnValue(new Promise(() => {}));
    void updater.beginUpdate(`${RELAY}/static/apk/app-m20270101-000000.apk`);
    await new Promise<void>((r) => setImmediate(r));
    updater.cancel();
    expect(cancelDownload).toHaveBeenCalled();
    expect(updater.getState().phase).toBe('failed');
    expect(updater.getState().error).toBe('canceled');
  });
});
