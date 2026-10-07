/**
 * updater.ts — App 内更新器状态机（模块级单例；纯逻辑部分入 jest）。
 *
 * 流程（第一性定案 2/3/4 + 交互定案）：
 *   begin → [降级闸：URL 版本比对，下载前先判（省流量）] → [计量确认] → 下载
 *   → 包名预检 → 自动走安装（前台才弹；后台记 ready 回前台再弹）→ 系统确认页 → done/failed
 *   offer（更新发现）→ 比对快照（四态：仅 newer 弹卡；same/older/unknown 一律静默）→ available 卡片
 *   → 免流量时静默预下载（点按秒装）→ confirmInstall / dismiss（稍后）
 * 单飞：进行中再请求 → 返回 'busy'（状态不动，UI 提示"更新进行中"）；
 * 用户取消系统页 → failed 可重试、不自动重弹。
 * 存储无关：dismissed 持久化由 App 钩子经订阅缝落 PhoneState（updater 只留内存去重锚）。
 */
import { NativeAppEventEmitter, NativeModules, AppState, type AppStateStatus } from 'react-native';
import { compareVersions, extractSnapshotFromUrl } from './versionGate';
import { BUILD_STAMP } from './buildStamp';
import type { UpdateManifest } from './feed';

export type UpdatePhase =
  | 'idle'
  | 'busy'
  | 'available' // 更新发现：有新版待用户决定（稍后/立即安装）
  | 'downgrade-confirm' // 旧版本：等用户显式"回退安装"
  | 'metered-confirm' // 计量网络：等用户确认流量
  | 'downloading'
  | 'ready' // 已就绪待前台（不空降系统页）
  | 'installing'
  | 'done'
  | 'failed';

export interface UpdateState {
  phase: UpdatePhase;
  url: string | null;
  filePath: string | null;
  receivedBytes: number;
  totalBytes: number;
  error: string | null;
  /** available：清单携带的快照号/说明/预下载就绪标记 */
  snapshot?: string;
  notes?: string;
  preloaded?: boolean;
  /** 清单哈希（装前对账；点链接路径无清单则缺省跳过） */
  expectedSha256?: string;
}

const Native = NativeModules.DownloadModule as {
  isMetered(): Promise<boolean>;
  fetchToCache(url: string, destName: string): Promise<{ path: string; bytes: number; sha256?: string }>;
  cancelDownload(): void;
  verifyPackage(filePath: string): Promise<boolean>;
  installApk(filePath: string): Promise<void>;
  canRequestPackageInstalls(): Promise<boolean>;
  openUnknownSourcesSettings(): Promise<void>;
};

type Listener = (s: UpdateState) => void;

const BUSY_PHASES: ReadonlySet<UpdatePhase> = new Set(['downloading', 'installing', 'ready']);

export class Updater {
  private state: UpdateState = {
    phase: 'idle',
    url: null,
    filePath: null,
    receivedBytes: 0,
    totalBytes: 0,
    error: null,
  };
  private listeners = new Set<Listener>();
  private appStateSub: { remove: () => void } | null = null;

  /** currentStamp 可注入（测试钉降级分支）；缺省 = 构建戳 */
  constructor(private readonly currentStamp: string = BUILD_STAMP) {}

  getState(): UpdateState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn(this.state);
  }

  /**
   * 入口：点 apk 链接。返回落定的初始相位（UI 据此弹对应卡片）。
   * 单飞 → 降级闸（URL 比对，下载前）→ 计量闸（确认后 confirmProceed）→ 下载。
   */
  async beginUpdate(url: string): Promise<UpdatePhase> {
    if (BUSY_PHASES.has(this.state.phase)) return 'busy';
    // 同 URL 重试保留清单哈希（完整性对账不因重试降级；新 URL=点链接路径无清单，照旧跳过）
    this.set({
      phase: 'idle',
      url,
      filePath: null,
      receivedBytes: 0,
      totalBytes: 0,
      error: null,
      expectedSha256: url === this.state.url ? this.state.expectedSha256 : undefined,
    });
    const verdict = compareVersions(extractSnapshotFromUrl(url), this.currentStamp);
    if (verdict === 'older') {
      this.set({ phase: 'downgrade-confirm' });
      return 'downgrade-confirm';
    }
    return this.afterGates(url, false);
  }

  // ---------- 更新发现（offer / available / dismiss） ----------

  /** 内存去重锚：本会话已 offer 过的快照（跨会话去重靠 PhoneState.dismissedSnapshot，App 钩子经订阅缝持久化） */
  private lastOfferedSnapshot: string | null = null;
  private dismissedSnap: string | null = null;

  /** App 钩子消费：dismiss 落定的快照号（一次性取走并持久化到 PhoneState） */
  consumeDismissed(): string | null {
    const s = this.dismissedSnap;
    this.dismissedSnap = null;
    return s;
  }

  /**
   * 更新发现入口（清单解析成功后由 App 钩子调用）。
   * 四态全定义：仅 newer 弹卡；same/older/unknown 一律静默（降级闸的"自动流"语义不可照搬进发现逻辑
   * ——unknown 含活树 debug 构建戳 'unknown' 与自定义名快照，弹卡即骚扰）。
   * BUSY（下载/安装中）静默忽略；available 期间又发现更新快照 → 原地替换卡片（旧卡不残留）。
   * persistedDismissed = PhoneState 里的"稍后"快照（跨会话去重）。
   */
  async offer(manifest: UpdateManifest, persistedDismissed?: string | null): Promise<UpdatePhase> {
    if (BUSY_PHASES.has(this.state.phase)) return this.state.phase;
    if (this.state.phase === 'available' && this.state.snapshot === manifest.snapshot) return 'available';
    const verdict = compareVersions(manifest.snapshot, this.currentStamp);
    if (verdict !== 'newer') return this.state.phase;
    if (persistedDismissed === manifest.snapshot) return this.state.phase;
    this.lastOfferedSnapshot = manifest.snapshot;
    this.set({
      phase: 'available',
      url: manifest.apkUrl,
      snapshot: manifest.snapshot,
      notes: manifest.notes,
      expectedSha256: manifest.sha256,
      preloaded: false,
      filePath: null,
      receivedBytes: 0,
      totalBytes: manifest.size,
      error: null,
    });
    // 免流量 → 静默预下载（点按秒装；失败静默——点按时走正式下载）
    try {
      if (!(await Native.isMetered())) void this.preload(manifest.apkUrl);
    } catch {
      /* 计量查不了照常：点按时再走计量闸 */
    }
    return 'available';
  }

  /** available 卡片的"立即安装"：预下载已就绪 → 直达安装；否则走计量闸+下载全程 */
  async confirmInstall(): Promise<UpdatePhase> {
    if (this.state.phase !== 'available' || !this.state.url) return this.state.phase;
    if (this.state.preloaded && this.state.filePath) {
      const ok = await Native.verifyPackage(this.state.filePath).catch(() => false);
      if (!ok) {
        this.set({ phase: 'failed', error: 'not-our-package' });
        return 'failed';
      }
      this.set({ phase: 'ready' });
      this.installWhenForeground();
      return 'ready';
    }
    return this.afterGates(this.state.url, false);
  }

  // ---------- 单飞下载：同一 URL 全程只有一条原生下载（预下载与正式链共享在途） ----------

  private inflightDownload: {
    url: string;
    promise: Promise<{ path: string; bytes: number; sha256?: string }>;
  } | null = null;

  /**
   * 取共享下载：在途同 URL 直接收编（实测教训：点「立即安装」时预下载正在途，
   * 另起第二条 68MB——两条挤同一根细管互减速度，且第二条开跑时删掉第一条的临时文件）。
   * 进度事件是原生全局广播（DownloadProgress），后附着的监听照样收到——收编即可见进度。
   */
  private fetchShared(url: string): Promise<{ path: string; bytes: number; sha256?: string }> {
    if (this.inflightDownload && this.inflightDownload.url === url) return this.inflightDownload.promise;
    const destName = (url.split('/').pop() || 'update.apk').replace(/[^A-Za-z0-9._-]/g, '_');
    const promise = Native.fetchToCache(url, destName);
    this.inflightDownload = { url, promise };
    // 双分支 then 清锚（不产生浮动 rejection 链；错误由各消费方自行 catch）
    void promise.then(
      () => {
        if (this.inflightDownload?.promise === promise) this.inflightDownload = null;
      },
      () => {
        if (this.inflightDownload?.promise === promise) this.inflightDownload = null;
      },
    );
    return promise;
  }

  /** available 卡片的"稍后"：清卡 + 落 dismissed 锚（订阅缝持久化；新快照自然再现） */
  dismiss(): void {
    if (this.state.phase !== 'available') return;
    this.dismissedSnap = this.state.snapshot ?? null;
    this.lastOfferedSnapshot = null;
    this.reset();
  }

  /** 静默预下载（available 相位内）：成功 → preloaded 就绪；失败/校验不符 → 静默留白（点按走正式链） */
  private async preload(url: string): Promise<void> {
    try {
      const res = await this.fetchShared(url);
      if (this.state.phase !== 'available' || this.state.url !== url) return; // 已推进/换卡 → 弃
      if (this.state.expectedSha256 && res.sha256 && res.sha256 !== this.state.expectedSha256) return;
      this.set({ preloaded: true, filePath: res.path });
    } catch {
      /* 静默 */
    }
  }

  /** downgrade-confirm / metered-confirm 的"确认继续"（用户已知情——跳过计量再确认） */
  async confirmProceed(url: string): Promise<UpdatePhase> {
    return this.afterGates(url, true);
  }

  private async afterGates(url: string, skipMetered: boolean): Promise<UpdatePhase> {
    if (!skipMetered) {
      try {
        if (await Native.isMetered()) {
          this.set({ phase: 'metered-confirm' });
          return 'metered-confirm';
        }
      } catch {
        /* 查不了计量状态就照常走 */
      }
    }
    void this.runDownload(url);
    return 'downloading';
  }

  private async runDownload(url: string): Promise<void> {
    this.set({ phase: 'downloading' });
    const sub = NativeAppEventEmitter.addListener(
      'DownloadProgress',
      (e: { received: number; total: number }) => {
        this.set({ receivedBytes: e.received, totalBytes: e.total });
      },
    );
    try {
      const res = await this.fetchShared(url);
      sub.remove();
      // 清单哈希对账（装前完整性闭环；点链接路径无清单 → 跳过）
      if (this.state.expectedSha256 && res.sha256 && res.sha256 !== this.state.expectedSha256) {
        this.set({ phase: 'failed', error: 'checksum-mismatch' });
        return;
      }
      const ok = await Native.verifyPackage(res.path);
      if (!ok) {
        this.set({ phase: 'failed', error: 'not-our-package' });
        return;
      }
      this.set({ phase: 'ready', filePath: res.path });
      this.installWhenForeground();
    } catch (e) {
      sub.remove();
      const msg = String((e as Error)?.message ?? e);
      this.set({ phase: 'failed', error: msg.toLowerCase().includes('cancel') ? 'canceled' : msg });
    }
  }

  /** 交互定案：完成时 App 不在前台则不空降系统页——记 ready，回前台再弹 */
  private installWhenForeground(): void {
    const fire = (): void => {
      this.appStateSub?.remove();
      this.appStateSub = null;
      void this.runInstall();
    };
    if (AppState.currentState === 'active') {
      fire();
      return;
    }
    this.appStateSub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') fire();
    }) as unknown as { remove: () => void };
  }

  private async runInstall(): Promise<void> {
    const path = this.state.filePath;
    if (!path) return;
    this.set({ phase: 'installing' });
    // 结果回执：PackageInstaller 确认页 → InstallResultReceiver → 'InstallResult' 事件
    const sub = NativeAppEventEmitter.addListener(
      'InstallResult',
      (e: { status: string; statusMessage?: string }) => {
        sub.remove();
        if (e.status === 'success') this.set({ phase: 'done' });
        else if (e.status === 'canceled') this.set({ phase: 'failed', error: 'canceled' });
        else this.set({ phase: 'failed', error: e.statusMessage ? `install-failed:${e.statusMessage}` : 'install-failed' });
      },
    );
    try {
      // API≥26 需"安装未知应用"授权；24-25 canRequest 恒 true（系统默认放行侧载）
      const allowed = await Native.canRequestPackageInstalls().catch(() => true);
      if (!allowed) {
        sub.remove();
        await Native.openUnknownSourcesSettings().catch(() => {});
        this.set({ phase: 'failed', error: 'need-install-permission' });
        return;
      }
      await Native.installApk(path); // resolve='started'（系统页已发起）；落定走 InstallResult
    } catch (e) {
      sub.remove();
      this.set({ phase: 'failed', error: String((e as Error)?.message ?? e) });
    }
  }

  /** 用户显式取消（下载中） */
  cancel(): void {
    if (this.state.phase !== 'downloading') return;
    try {
      Native.cancelDownload();
    } catch {
      /* ignore */
    }
    this.set({ phase: 'failed', error: 'canceled' });
  }

  /** 失败重试（同 url 重走，含闸门） */
  retry(): void {
    const url = this.state.url;
    if (!url || this.state.phase !== 'failed') return;
    void this.beginUpdate(url);
  }

  /** 覆盖安装完成后的"重启生效"收尾（清 ready/installing 残留） */
  reset(): void {
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.lastOfferedSnapshot = null;
    this.set({
      phase: 'idle',
      url: null,
      filePath: null,
      receivedBytes: 0,
      totalBytes: 0,
      error: null,
      snapshot: undefined,
      notes: undefined,
      preloaded: undefined,
      expectedSha256: undefined,
    });
  }
}

export const updater = new Updater();

/** shot 流：同一下载原语取到本地（缓存生命周期=下次 fetchToCache 清旧件，防吃满磁盘） */
export async function fetchShotToCache(url: string): Promise<string> {
  const destName = (url.split('/').pop() || 'shot.png').replace(/[^A-Za-z0-9._-]/g, '_');
  const res = await Native.fetchToCache(url, destName);
  return res.path;
}
