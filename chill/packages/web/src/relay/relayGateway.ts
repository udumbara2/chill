/**
 * relayGateway.ts — web daemon 的 relay I/O 网关（W1《WebUI中继支持》A2）。
 *
 * 形态与 electron 主进程 relayMain.ts 严格同构：解密/bridge 在渲染层（浏览器），
 * 本进程只做 I/O 代理（WS 传输 + CA pinning HTTP + 租约 + 文件读侧）与事件转发
 * （broadcast → ev 帧）。全部原语消费 core relayNodeRuntime（A1 下沉件）——壳不自持拷贝。
 *
 * 生命周期挂靠（D4，本设计的安全核心）：
 * - owner 追踪：relay:transport-connect 的调用连接 = owner（serve.ts 特判传入，照 session:watch
 *   先例）；owner 断开 → 关传输+退租+广播 relay:lease-lost（桥在页面里，页面死了桥必死，
 *   续持租约=僵尸锁挡 serve 接管）；
 * - 最后连接断开 → 全拆（双保险，防 owner 追踪漏网的任何路径）；
 * - daemon shutdown（SIGINT/SIGTERM/换版自重启）→ stop() 释放（serve.ts 既有单点收口）；
 * - 服务端未 ACK 消息本就重放（onWsAuthed pendingMessages）——拆除无损。
 */
import { open as fsOpen, stat as fsStat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { isAbsolute, normalize, join, resolve as pathResolve } from 'node:path'
import { homedir } from 'node:os'
import {
  NodeRelayBoxTransport,
  type NodeRelayBoxTransportEvents,
  relayNodeHttpRequest,
  relayNodeHttpGetBinary,
  relayNodeHttpPutBinary,
  FileRelayLockStore,
  RelayLeaseHost,
  NodeDeviceStore,
  caFingerprint,
  buildCatalogStateBody,
  wireSessionCatalogWatch,
  type PairedDevice,
} from '@assistant-ai/core'

type Broadcast = (name: string, payload: unknown) => void
/** 浏览器连接句柄（serve.ts 的 ws；此处只当不透明对象用） */
export type RelayClientConn = object

/** 测试可注入的传输形态（缺省 NodeRelayBoxTransport） */
export interface TransportLike {
  connect(events: NodeRelayBoxTransportEvents): Promise<void>
  close(): void
  readonly connected: boolean
}

export type RelayTransportFactory = (
  relayUrl: string,
  mailboxId: string,
  readToken: string,
  caPath?: string,
) => TransportLike

export interface RelayGatewayDeps {
  broadcast: Broadcast
  /** 是否仍有浏览器连接（最后连接断开=全拆双保险） */
  hasClients: () => boolean
  /** relay.lock 路径（~/.chill/relay.lock——与 CLI/Electron 同一把锁） */
  lockPath: string
  /** 配对账本（~/.chill/relay/devices.json——三壳单源；账本单源化 2026-10-12） */
  devicesStore: NodeDeviceStore
  sessionsDir: string
  listProjects: () => Promise<unknown[]>
  /** 预览/体验形态守卫（照 electron M3.2 约定：体验形态不连 relay，确定性由正式实例服务） */
  isPreview: () => boolean
  /** 测试注入传输工厂 */
  transportFactory?: RelayTransportFactory
  /** 持有者标识（缺省 web:<pid>；契约测试注入固定值隔离同进程多网关） */
  ownerId?: string
}

function makeNodeTransport(
  relayUrl: string,
  mailboxId: string,
  readToken: string,
  caPath?: string,
): TransportLike {
  return new NodeRelayBoxTransport(relayUrl, mailboxId, readToken, caPath)
}

export class RelayGateway {
  private lease: RelayLeaseHost
  private transport: TransportLike | null = null
  private owner: RelayClientConn | null = null
  private deps: RelayGatewayDeps
  private mkTransport: RelayTransportFactory

  constructor(deps: RelayGatewayDeps) {
    this.deps = deps
    this.mkTransport = deps.transportFactory ?? makeNodeTransport
    this.lease = new RelayLeaseHost({
      lockStore: new FileRelayLockStore(deps.lockPath),
      ownerId: deps.ownerId ?? `web:${process.pid}`,
      isPreviewGuard: deps.isPreview,
      onLeaseLost: () => {
        // 心跳续约失败=被他端接管：关传输让位（桥侧由渲染层收 lease-lost 事件自行停）
        this.teardownTransport()
        deps.broadcast('relay:lease-lost', {})
      },
    })
  }

  /** 注册不依赖调用方连接的 relay:* dispatch 方法（transport-connect 由 serve.ts 特判走 transportConnect） */
  registerDispatch(d: Map<string, (...args: unknown[]) => unknown>): void {
    d.set('relay:start', () => this.start())
    d.set('relay:stop', async () => {
      await this.stop()
      return { ok: true }
    })
    d.set('relay:status', async () => ({
      running: this.lease.isRunning(),
      holder: await this.lease.currentHolder(),
      connected: this.transport?.connected ?? false,
    }))
    d.set('relay:http-request', (o) => relayNodeHttpRequest(o as never))
    d.set('relay:http-get-binary', (o) => relayNodeHttpGetBinary(o as never))
    d.set('relay:http-put-binary', (o) => relayNodeHttpPutBinary(o as never))
    d.set('relay:read-file-slice', (o) => relayReadFileSlice(o as never))
    d.set('relay:stat-file', (o) => relayStatFile(o as never))
    d.set('relay:resolve-path', (o) => relayResolvePath(o as never))
    d.set('relay:ca-fp', (o: { caPath: string }) => ({
      caFP: caFingerprint(new Uint8Array(readFileSync(o.caPath))),
    }))
    // CA 材料原始字节 base64 回传（配对小码上传用——渲染进程无 fs；读失败 reject 如实呈现）
    d.set('relay:ca-cert', (o: { caPath: string }) => ({
      caB64: readFileSync(o.caPath).toString('base64'),
    }))
    // 配对账本（devices.json 单源）：读=store.read（首读含惰性遗留收敛）；写=载荷形状校验+原子写，
    // 失败抛错 → serve.ts 回 ok:false → 渲染层 call() reject（配对 fail-loud，2026-10-12）
    d.set('relay:devices-get', async () => this.deps.devicesStore.read())
    d.set('relay:devices-set', async (devices: unknown) => {
      if (!Array.isArray(devices)) throw new Error('配对记录载荷必须是数组')
      for (const x of devices) {
        const e = x as Partial<PairedDevice> | null
        if (
          !e || typeof e !== 'object' ||
          typeof e.phonePub !== 'string' || e.phonePub.length === 0 ||
          typeof e.device !== 'string'
        ) {
          throw new Error('配对记录条目形状不合法（需 phonePub/device 字符串）')
        }
      }
      await this.deps.devicesStore.write(devices as PairedDevice[])
      return null
    })
    d.set('relay:transport-close', () => {
      this.teardownTransport()
      return { ok: true }
    })
    d.set('relay:catalog-state', (o) => this.catalogState(o as never))
  }

  /** 传输连接（serve.ts 对 relay:transport-connect 特判调用——携带调用方连接做 owner 追踪） */
  async transportConnect(
    conn: RelayClientConn,
    opts: { relayUrl: string; mailboxId: string; readToken: string; caPath?: string },
  ): Promise<{ ok: true }> {
    this.teardownTransport()
    const t = this.mkTransport(opts.relayUrl, opts.mailboxId, opts.readToken, opts.caPath)
    await t.connect({
      onMessage: (msg) => this.deps.broadcast('relay:transport-message', msg),
      onClose: (code) => this.deps.broadcast('relay:transport-closed', { code }),
      onError: (message) => this.deps.broadcast('relay:transport-error', { message }),
    })
    this.transport = t
    this.owner = conn
    return { ok: true }
  }

  /** catalog 组包（core 单一事实点 buildCatalogStateBody——与 electron 主进程同一函数） */
  private async catalogState(payload: { known: unknown; activeSessionId: string | null }): Promise<unknown> {
    return buildCatalogStateBody(
      {
        sessionsDir: this.deps.sessionsDir,
        listProjects: this.deps.listProjects,
        getActiveSessionId: () => payload?.activeSessionId ?? null,
      },
      payload?.known as never,
    )
  }

  /** sessions 目录常驻监听（fs.watch 只能在 Node 域；事件经 broadcast 推渲染端当前桥） */
  startCatalogWatch(): void {
    wireSessionCatalogWatch(
      { pushSessionEvent: (body: unknown) => this.deps.broadcast('relay:session-event', body) } as never,
      { sessionsDir: this.deps.sessionsDir, listProjects: this.deps.listProjects },
    )
  }

  async start(): Promise<'started' | 'held-by-other' | 'preview-no-relay'> {
    return this.lease.start()
  }

  /** 全拆（shutdown 单点与 relay:stop 共用；幂等） */
  async stop(): Promise<void> {
    this.teardownTransport()
    await this.lease.stop()
  }

  private teardownTransport(): void {
    try {
      this.transport?.close()
    } catch {
      /* ignore */
    }
    this.transport = null
    this.owner = null
  }

  /**
   * 浏览器连接断开钩子（serve.ts ws close 时调用）：
   * - 断的是 owner → 关传输+退租；仍有其他标签时广播 lease-lost（告知桥已拆——
   *   文案按"他端接管"呈现是既知瑕疵，见规划打磨项）；
   * - 最后一条连接断开 → 全拆（双保险——防 owner 追踪漏网的任何路径留下僵尸锁）。
   */
  onClientClose(conn: RelayClientConn, isLast: boolean): void {
    const ownerLeft = conn === this.owner
    if (!ownerLeft && !isLast) return
    const notifyOthers = ownerLeft && !isLast && this.deps.hasClients()
    void this.stop().finally(() => {
      if (notifyOthers) this.deps.broadcast('relay:lease-lost', {})
    })
  }
}

// ---------- d→m 文件发送读侧（渲染进程无任意路径读能力；daemon fs 执行——electron relayMain 平价） ----------

/** 文件切片读（fileSender 分片上传数据源；base64 回传） */
async function relayReadFileSlice(opts: {
  path: string
  offset: number
  length: number
}): Promise<{ success: boolean; base64?: string; error?: string }> {
  try {
    const fh = await fsOpen(opts.path, 'r')
    try {
      const buf = Buffer.alloc(opts.length)
      const { bytesRead } = await fh.read(buf, 0, opts.length, opts.offset)
      return { success: true, base64: buf.subarray(0, bytesRead).toString('base64') }
    } finally {
      await fh.close()
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 文件 stat（桥层契约：null = 不存在；isFile 供"不支持目录"判定；mtimeMs 供 mutated 护栏） */
async function relayStatFile(opts: { path: string }): Promise<{ size: number; mtimeMs: number; isFile: boolean } | null> {
  try {
    const st = await fsStat(opts.path)
    return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }
  } catch {
    return null
  }
}

/**
 * 路径解析（桥层 denylist 判定基准）：~ 展开、相对路径按会话工作目录解析、规范化；
 * 顺带回报 homeDir（~/.chill/** denylist 基准）与大小写敏感性（Windows 口径）。
 */
function relayResolvePath(opts: { input: string; workdir?: string }): {
  path: string
  homeDir: string
  caseInsensitive: boolean
} {
  let p = opts.input
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(1))
  if (!isAbsolute(p)) p = pathResolve(opts.workdir || process.cwd(), p)
  return { path: normalize(p), homeDir: homedir(), caseInsensitive: process.platform === 'win32' }
}
