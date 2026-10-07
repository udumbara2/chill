/**
 * relayClient.ts — CLI 侧 RelayClient：租约仲裁 + 传输 + RelayBridge 装配（进程内常驻）。
 *
 * 语义（M2 计划步骤 5/6）：
 * - 租约仲裁（~/.chill/relay.lock）：先抢得者跑 + 心跳续约（5s，租约 15s）+ 过期接管；
 *   续约失败 = 已被他端接管 → 停传输退租。
 * - 断线指数退避重连（nextBackoffMs 1s→30s）；before-quit/SIGINT 由 cli.ts 调 stop() 清理。
 * - 配对前无对端信息（hello 投桌面信箱须有人读）：/pair 完成 redeem 后 attachPeer 挂载桥；
 *   已配对设备启动时自动挂载（MVP 单设备：取 devices[0]）。
 */
import {
  PairingManager,
  RelayBridge,
  RelayLockArbiter,
  RELAY_LOCK_HEARTBEAT_MS,
  nextBackoffMs,
  nextLeaseRetryMs,
  decorativeFingerprint,
  createEngineEnqueue,
  wireApprovalChannel,
  wireToolStatus,
  wireBeatBoundary,
  wireAskChannel,
  wirePermissionMode,
  wireTurnStream,
  wireHistoryInvalidated,
  wireTurnSettled,
  wireRunningTransitions,
  wireActiveSession,
  wireSessionCatalogWatch,
  wireBoard,
  wireWorkPlan,
  wireFeedSubagent,
  wireCommandState,
  makeGetCommandState,
  makeExecuteCommand,
  makeSessionSyncBridgeDeps,
  makeBoardSyncBridgeDeps,
  makeWorkPlanSyncBridgeDeps,
  makeRecoveryBridgeDeps,
  makeFileTransferBridgeDeps,
  makeEnsureActiveSession,
  makeEnsureNewSession,
  createEngineEnqueueBy,
  makeResolveApproval,
  makeListPendingApprovals,
  makeListRecentSettledApprovals,
  makeResolveAsk,
  makeListPendingAsks,
  makeListRecentSettledAsks,
  type PairedDevice,
  type ProjectRecord,
  type SessionRecord,
} from '@assistant-ai/core'
import type { ChatEngine } from '@assistant-ai/core'
import { AttachmentManager, eventBus, EVENTS } from '@assistant-ai/core'
import { stat as fsStat, open as fsOpen } from 'node:fs/promises'
import { homedir } from 'node:os'
import nodePath from 'node:path'
import { NodeRelayHttp } from './NodeRelayHttp.js'
import { NodeWsTransport } from './NodeWsTransport.js'
import { FileRelayLockStore, NodeDeviceStore, defaultRelayLockPath, defaultDevicesPath, makeSeenIdsStore, makePendingRoundsStore } from './relayNodeStores.js'
import type { DesktopControlDeps } from '@assistant-ai/core'

/** 稳定在线判定阈值:连接保持此时长未断才计为恢复(防乒乓日志) */
const RELAY_STABLE_MS = 15_000

export interface RelayClientDeps {
  userDataPath: string
  ownerId: string
  pairingManager: PairingManager
  getEngine: () => ChatEngine
  /** M5：权限模式读/写闭包（壳经 ctx.builtInExecutor 供；set 内做合法值校验，非法返 false） */
  getPermissionMode: () => string
  setPermissionMode: (mode: string, by: string) => boolean
  /** M6：会话真相源目录（sessions-index.jsonl 所在；catalog 构建与目录监听共用） */
  sessionsDir: string
  /** M6：项目真相源读取（projects.json；catalog 构建的 projects 字段与悬空归一化数据源） */
  listProjects: () => Promise<ProjectRecord[]>
  /** M6：单会话读取（history.request 应答；SessionPersistence.load 适配，null=不存在） */
  loadSessionRecord: (sessionId: string) => Promise<SessionRecord | null>
  /** 命令面 session.rename 执行面（SessionPersistence.patchTitle 适配；CliSessionService 薄转发） */
  patchSessionTitle: (id: string, title: string) => Promise<{ success: boolean; error?: string }>
  /** 命令面 session.delete 执行面（SessionPersistence.delete 适配；CliSessionService 薄转发） */
  deleteSessionRecord: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 配对确认提问（壳侧实现：CLI readline / TUI ask） */
  askConfirm: (device: string, fingerprint: string) => Promise<boolean>
  /**
   * D12 接力闭环：手机消息 enqueue 前锚定（盘比内存新=对端壳写过 → 先采纳再入队）。
   * 写者无关、对所有宿主模式生效；可选=无则直通。自包含实现由壳侧注入
   * （loadIfNewer + reloadSession 两原语；见 cli.ts 装配点注释）。
   * M1（多会话并行）：入参 = enqueue 输入（serve 形态按 input.sessionId 锚定目标会话；
   * 单引擎交互 CLI 忽略入参行为不变）。
   */
  anchorBeforeEnqueue?: (input: { sessionId?: string }) => Promise<void>
  /**
   * M1（多会话并行）serve 形态注入点——三选一可选，缺省走单引擎既有装配：
   * - resolveEngine：enqueue 按 sessionId 直寻引擎（createEngineEnqueueBy；M0.1′）；
   * - ensureActiveSession/ensureNewSession：桥守卫的 registry 版（已开切指针/未开装载）；
   * - wireActiveSessionDisabled：serve 不装 wireActiveSession（active.changed 由
   *   serveSessions.setActive 经 pushActiveChanged 直推——多引擎事件互踩，UI 先例）。
   */
  resolveEngine?: (sessionId: string | undefined) => ChatEngine
  ensureActiveSessionOverride?: (sessionId: string) => Promise<'ok' | 'busy' | 'notfound'>
  ensureNewSessionOverride?: () => Promise<'ok' | 'busy'>
  wireActiveSessionDisabled?: boolean
  /** F-2（迭代 F）：附着变更通告透传（serve attach 即激活——控制盲区根治；见桥 deps 同名注释） */
  onSessionAttached?: (sessionId: string | null) => void
  /**
   * 运行态标志：运行中会话全集现读（serve=serveSessions.runningSessionIds 薄包 core registry 单源；
   * 交互 CLI=单引擎闭包）。注入后桥推 running.changed（含 runningAll 随行）+ catalog.state 携带
   * runningSessionIds；缺省=旧语义（字段省略，手机侧不动）。
   */
  getRunningSessionIds?: () => string[]
  /**
   * 宿主级开关执行面（命令面 desktop.set/autoswitch.set）：壳经 ctx 组装
   * （keyValueStore + engine + desktopController + builtInExecutor；单一事实点在 core desktopControl）。
   * 可选：未装配时两命令诚实回 unsupported（UI 壳同款降级）；store 同时兼作 cmd.state 快照读面。
   */
  desktopControlPort?: DesktopControlDeps
  log?: (msg: string) => void
}

export interface RelayClientStatus {
  running: boolean
  holder: string | null
  connected: boolean
  peerDevice: string | null
  /** 等待态：本端想跑 relay 但租约在他端，正在静默自动重试 */
  waiting: boolean
}

export class CliRelayClient {
  private deps: RelayClientDeps
  private arbiter: RelayLockArbiter
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private transport: NodeWsTransport | null = null
  private bridge: RelayBridge | null = null
  private http: NodeRelayHttp | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  /** 连续失败/断开已打过头条日志(降噪:状态变化才打,稳定恢复时复位) */
  private failureLogged = false
  /** 稳定在线计时:连上后满 RELAY_STABLE_MS 才计为恢复(防乒乓每次循环各打两条) */
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = false
  private peer: PairedDevice | null = null
  private log: (msg: string) => void
  /** M4：事件总线订阅的退订函数（stopTransportOnly 时调用，防多实例/重启后重复订阅） */
  private wiringUnsubscribers: (() => void)[] = []
  /** 租约意图：用户/自启希望本端跑 relay 即为 true（/relay stop 置假并取消等待重试） */
  private wantLease = false
  /** 等待态重试定时器（start 抢锁失败 / 续约发现租约被夺 → 统一进入等待态） */
  private leaseRetryTimer: ReturnType<typeof setTimeout> | null = null
  private leaseRetryAttempt = 0

  constructor(deps: RelayClientDeps) {
    this.deps = deps
    this.log = deps.log ?? ((m) => process.stdout.write(`[relay] ${m}\n`))
    this.arbiter = new RelayLockArbiter(
      new FileRelayLockStore(defaultRelayLockPath(deps.userDataPath)),
      deps.ownerId,
      Date.now,
      probeOwnerAlive,
    )
  }

  isRunning(): boolean {
    return this.heartbeat !== null
  }

  /**
   * d→m 文件发送公开入口（/send 命令与 mobile_send_file 工具共用；桥层是校验单点）。
   * 未持租约/桥未挂载 → 诚实报错（租约语义：谁先在线谁跑，未持锁的壳不假装能发）。
   */
  async sendFileToMobile(
    path: string,
    opts?: { sessionId?: string; onProgress?: (sentBytes: number, totalBytes: number) => void },
  ): Promise<{ fileId: string; expiresAt: number }> {
    if (!this.bridge || !this.isRunning()) {
      throw new Error('中继未在运行（未启动或租约由另一实例持有）——/relay status 查看，/relay start 启动')
    }
    return this.bridge.sendFileToMobile({
      path,
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    })
  }

  async status(): Promise<RelayClientStatus> {
    return {
      running: this.isRunning(),
      holder: await this.arbiter.currentHolder(),
      connected: this.transport?.connected ?? false,
      peerDevice: this.peer?.device ?? null,
      waiting: !this.isRunning() && this.wantLease,
    }
  }

  /**
   * M1（多会话并行）serve 形态的 active.changed 直推口：serveSessions.setActive 切换活跃
   * 时经此直推桥（serve 不装 wireActiveSession——多引擎引擎事件互踩，见装配点注释）。
   * 桥未挂载时 no-op（下次挂载由 catalog 全量带 activeSessionId 收敛）。
   */
  pushActiveChanged(sessionId: string | null): void {
    this.bridge?.pushSessionEvent({ kind: 'active.changed', sessionId })
  }

  /**
   * M2.1（多会话并行）闲置回收的桥运行时清理口：清 per-session 入向链条目 + 轮次流聚合格
   * （桥未挂载时 no-op——格子随桥重建湮灭）。
   */
  pruneSessionRuntime(sessionId: string): void {
    this.bridge?.pruneSessionRuntime(sessionId)
  }

  /**
   * 经租约尝试启动 relay。'started' = 本端持有租约并运行；'held-by-other' = 他端在线
   * （本端进入等待态：静默周期重试，他端退出/崩溃后自动接管；/relay stop 取消）。
   * 已配对设备存在时自动挂载桥；无设备时空跑（等 /pair attachPeer）。
   */
  async start(): Promise<'started' | 'held-by-other'> {
    if (this.isRunning()) return 'started'
    this.wantLease = true
    const r = await this.arbiter.tryAcquire()
    if (r !== 'acquired') {
      this.scheduleLeaseRetry()
      return 'held-by-other'
    }
    await this.beginHoldingLease()
    return 'started'
  }

  /** 拿到租约后的运行体（start 与等待态重试成功共用） */
  private async beginHoldingLease(): Promise<void> {
    this.cancelLeaseRetry()
    this.leaseRetryAttempt = 0
    this.stopping = false
    this.heartbeat = setInterval(() => {
      void this.arbiter.renew().then((ok) => {
        if (!ok && !this.stopping && this.wantLease) {
          // 租约被他端夺走（或锁文件损坏）→ 统一进等待态：停传输停心跳、静默重试夺回
          this.log('租约被他端接管，进入等待（将自动重试夺回）')
          void this.enterWaiting()
        }
      })
    }, RELAY_LOCK_HEARTBEAT_MS)
    this.heartbeat.unref?.()
    const devices = await this.deps.pairingManager.listDevices()
    if (devices.length > 0) {
      await this.attachPeer(devices[0]!, null, true)
    }
    this.log('relay 已启动（本端持有租约）')
  }

  /** 进入等待态：停心跳停传输、挂静默重试（start 失败 / 续约发现租约易主的统一入口） */
  private async enterWaiting(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    await this.stopTransportOnly()
    this.scheduleLeaseRetry()
  }

  private scheduleLeaseRetry(): void {
    if (!this.wantLease || this.isRunning() || this.leaseRetryTimer) return
    const delay = nextLeaseRetryMs(this.leaseRetryAttempt++)
    this.leaseRetryTimer = setTimeout(() => {
      this.leaseRetryTimer = null
      void this.retryAcquire()
    }, delay)
    this.leaseRetryTimer.unref?.()
  }

  private cancelLeaseRetry(): void {
    if (this.leaseRetryTimer) {
      clearTimeout(this.leaseRetryTimer)
      this.leaseRetryTimer = null
    }
  }

  /** 等待态重试：拿到租约则进入运行体；拿不到继续等（静默，状态迁移才打日志） */
  private async retryAcquire(): Promise<void> {
    if (!this.wantLease || this.isRunning()) return
    const r = await this.arbiter.tryAcquire()
    if (r !== 'acquired') {
      this.scheduleLeaseRetry()
      return
    }
    this.log('已接管 relay 租约（自动重试成功）')
    await this.beginHoldingLease()
  }

  /** /pair redeem 后挂载桥（confirmed=false，等 hello/confirm 走完配对） */
  async attachPeer(device: PairedDevice, pairingToken: string | null, confirmed: boolean): Promise<void> {
    await this.stopTransportOnly()
    this.failureLogged = false // 新一轮连接,重置降噪状态
    this.peer = device
    const pm = this.deps.pairingManager
    const config = await pm.getRelayConfig()
    if (!config) throw new Error('relay 未配置（先 /pair config）')
    const caPath = (await pm.getCaPath()) ?? undefined
    const { secrets, myBox, peerBox } = await pm.deriveForDevice(device.phonePub)
    const desk = await pm.getOrCreateDeviceKey()
    this.http = new NodeRelayHttp(config.relayUrl, caPath)
    const nodeHttp = this.http // 闭包内属性窄化不保留（fetchMedia 延迟执行）——本地常量固化非空
    this.transport = new NodeWsTransport(config.relayUrl, myBox, secrets.readToken, caPath)
    // D12：入队前锚定包装（无条件——手机路径与本地路径同规格，anchorFromDisk 先例）；
    // 锚定闭包自带轮中守卫（isRunning 跳过，防在途轮内存换底），此处只做直通组装。
    // M1（多会话并行）：serve 形态注入 resolveEngine → enqueue 按 sessionId 直寻（M0.1′）
    const rawEnqueue = this.deps.resolveEngine
      ? createEngineEnqueueBy(this.deps.resolveEngine)
      : createEngineEnqueue(this.deps.getEngine())
    this.bridge = new RelayBridge({
      transport: this.transport,
      http: this.http,
      secrets,
      myBox,
      peerBox,
      deskPub: desk.publicKey,
      phonePub: device.phonePub,
      deviceName: 'chill CLI',
      pairingToken,
      getPairingToken: () => pm.getPairingToken(),
      confirmed,
      // M4：引擎流/审批通道装配全部在 core 的 relayEngineWiring（环境单例单点收口，壳内零映射逻辑）
      enqueue: async (input, opts) => {
        await this.deps.anchorBeforeEnqueue?.(input)
        return rawEnqueue(input, opts)
      },
      // F-2：附着变更通告透传（serve attach 即激活）
      ...(this.deps.onSessionAttached ? { onSessionAttached: this.deps.onSessionAttached } : {}),
      // M6：会话同步 deps（catalog/history 闭包 + 发言即激活 + 当前会话现读；组包在 relayEngineWiring）
      // M1：serve 形态注入 registry 版守卫（已开切指针/未开装载）；单引擎缺省既有装配
      ...makeSessionSyncBridgeDeps({
        sessionsDir: this.deps.sessionsDir,
        listProjects: this.deps.listProjects,
        loadSession: this.deps.loadSessionRecord,
        getActiveSessionId: () => this.deps.getEngine().getSessionState().sessionId,
        ensureActiveSession:
          this.deps.ensureActiveSessionOverride ?? makeEnsureActiveSession(this.deps.getEngine()),
        ensureNewSession:
          this.deps.ensureNewSessionOverride ?? makeEnsureNewSession(this.deps.getEngine()),
        ...(this.deps.getRunningSessionIds ? { getRunningSessionIds: this.deps.getRunningSessionIds } : {}),
      }),
      // M7：共享看板 deps（getProjection 组包 + ask/approval 未决计数）
      ...makeBoardSyncBridgeDeps(),
      // 工作计划树 deps（分键清单镜像 + buildWorkPlanTree 投影组包）
      ...makeWorkPlanSyncBridgeDeps(),
      resolveApproval: makeResolveApproval(),
      listPendingApprovals: makeListPendingApprovals(),
      listRecentSettledApprovals: makeListRecentSettledApprovals(),
      resolveAsk: makeResolveAsk(),
      listPendingAsks: makeListPendingAsks(),
      listRecentSettledAsks: makeListRecentSettledAsks(),
      setPermissionMode: (mode, by) => this.deps.setPermissionMode(mode, by),
      getPermissionMode: () => this.deps.getPermissionMode(),
      // M8：命令面状态快照 + 命令执行（M2 激活：executeCommand 绑定逻辑唯一事实点在 core）
      getCommandState: makeGetCommandState(this.deps.getEngine, this.deps.desktopControlPort?.store),
      executeCmd: makeExecuteCommand(this.deps.getEngine, {
        patchTitle: this.deps.patchSessionTitle,
        delete: this.deps.deleteSessionRecord,
        // task.detail 的非活动会话数据源（活动会话在执行器内走 engine.getHistory 内存直读）
        readMessages: async (id) => (await this.deps.loadSessionRecord(id))?.messages ?? null,
      }, this.deps.desktopControlPort),
      onConfirmRequest: (dev, fp) =>
        this.deps.askConfirm(dev, fp || decorativeFingerprint(desk.publicKey, device.phonePub)),
      onAlarm: (m) => this.log(`⚠️ ${m}`),
      // M1.3（中继投递流控规划）：429 背压事实转发 eventBus（壳订阅判定持续>2min 告警）
      onDeliveryThrottled: (info) => eventBus.emit(EVENTS.RELAY_DELIVERY_THROTTLED, info),
      ...(() => {
        const seen = makeSeenIdsStore(this.deps.userDataPath)
        return { loadSeenIds: seen.load, saveSeenIds: seen.save }
      })(),
      // M7增量3·决策31：崩溃恢复（引擎重跑尾部未回复轮 + 盘上尾部窥视）
      ...makeRecoveryBridgeDeps({ getEngine: () => this.deps.getEngine(), loadSession: this.deps.loadSessionRecord }),
      // M7增量3·决策30：投递台账（崩溃恢复唯一事实源；save 失败上抛 → 桥不 ACK）
      ...(() => {
        const ledger = makePendingRoundsStore(this.deps.userDataPath)
        return {
          loadPendingRounds: async () => (await ledger.load()) as import('@assistant-ai/core').PendingRoundEntry[],
          savePendingRounds: (entries: import('@assistant-ai/core').PendingRoundEntry[]) => ledger.save(entries),
        }
      })(),
      // file.* 协议族：附件落盘 + 摄入装配（CLI 直连 AttachmentManager——进程内 Node fs；判据锚定 MEDIA_EXTENSIONS）
      // 媒体直传：密文拉取走 NodeRelayHttp.getBinary（同一 CA pinning 信任根；URL 由壳自身 relay 配置拼）
      // d→m 文件发送：putMedia 走 NodeRelayHttp.putBinary（同信任根）+ Node fs 切片读/stat + 路径解析
      ...makeFileTransferBridgeDeps({
        saveAttachment: (bytes, name) => AttachmentManager.saveAttachment(Buffer.from(bytes), name),
        readAsBase64: (ref) => AttachmentManager.readAsBase64(ref),
        getAbsolutePath: (ref) => AttachmentManager.getAttachmentPath(ref),
        fetchMedia: async (name, opts) => {
          const r = await nodeHttp.getBinary(`/static/media/${name}`, opts?.range)
          if ((r.status !== 200 && r.status !== 206) || !r.bytes || r.bytes.length === 0) {
            throw new Error(`媒体拉取 HTTP ${r.status}`)
          }
          return r.bytes
        },
        // d→m 出向：密文分片 PUT（write_token 认哈希不认方向——桌面天然持有同一凭据，中继零改动）
        putMedia: async (name, offset, total, bytes) => {
          const r = await nodeHttp.putBinary(
            `/media/${name}`,
            Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            { token: secrets.writeToken, offset, total },
          )
          const cur = (r.json as { current?: unknown } | null)?.current
          return { status: r.status, ...(typeof cur === 'number' ? { current: cur } : {}) }
        },
        readFileSlice: async (p, offset, length) => {
          const fh = await fsOpen(p, 'r')
          try {
            const buf = Buffer.alloc(length)
            const { bytesRead } = await fh.read(buf, 0, length, offset)
            return new Uint8Array(buf.subarray(0, bytesRead))
          } finally {
            await fh.close()
          }
        },
        statFile: async (p) => {
          try {
            const st = await fsStat(p)
            return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }
          } catch {
            return null // 不存在（ENOENT 等）——桥层据此诚实报"文件不存在"
          }
        },
        // 路径解析（denylist 判定基准）：~ 展开为真实用户目录；相对路径按会话工作目录解析
        resolvePath: async (input) => {
          let p = input
          if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = nodePath.join(homedir(), p.slice(1))
          if (!nodePath.isAbsolute(p)) p = nodePath.resolve(this.deps.getEngine().getWorkDir(), p)
          return nodePath.normalize(p)
        },
        homeDir: homedir(),
        caseInsensitivePaths: process.platform === 'win32',
      }),
    })
    this.wiringUnsubscribers = [
      wireApprovalChannel(this.bridge),
      wireToolStatus(this.bridge),
      wireBeatBoundary(this.bridge),
      wireAskChannel(this.bridge),
      wirePermissionMode(this.bridge),
      // M8：命令面状态广播（轮末/ctx 更新点/resync 三保底——命令执行后的必推在桥内）
      wireCommandState(this.bridge),
      // M6：被动流镜像 / 历史失效 / 当前会话通告 / 目录元数据监听 / 轮次落定（M6c）
      wireTurnStream(this.bridge),
      wireHistoryInvalidated(this.bridge),
      wireTurnSettled(this.bridge),
      // 运行态标志：TURN_STARTED/SETTLED → running.changed（后台会话也推）+ 5min 周期快照重申
      wireRunningTransitions(this.bridge),
      // M1（多会话并行）：serve 形态不装——多引擎 active-changed 互踩；active.changed 由
      // serveSessions.setActive 经 pushActiveChanged 直推（UI 多会话 registry 先例）
      ...(this.deps.wireActiveSessionDisabled ? [] : [wireActiveSession(this.bridge, this.deps.getEngine())]),
      wireSessionCatalogWatch(this.bridge, {
        sessionsDir: this.deps.sessionsDir,
        listProjects: this.deps.listProjects,
      }),
      // M7：看板变更 → 防抖合并 → board.state（附着会话门控在桥内）
      wireBoard(this.bridge),
      // 工作计划树：TASK_* 主会话写入 → 分键镜像 → 防抖合并 → workplan.state（附着门控在桥内；
      // 缺归因事件归引擎当前活动会话）
      wireWorkPlan(this.bridge, { getActiveSessionId: () => this.deps.getEngine().getSessionState().sessionId }),
      // V2：Worker 事实流 → 合并窗口 → feed.subagent（附着门控在桥内）
      wireFeedSubagent(this.bridge),
    ]
    this.bridge.start()
    this.connectWithBackoff()
  }

  /** 重连编排单环纪律（2026-10-03 根治 4000 乒乓环）：onClose 与 connect.catch 两条路径共享
   *  一个定时器槽——先清后置；连接尝试在途时拒绝再次发起（connectBusy 门）。
   *  病灶：双路径各排定时器互不清除 → 两条 WS 并发 → 服务器"单活跃读者"踢先到者（4000 replaced）
   *  → 被踢者再排重连 → 与活连接竞争 → 自维持乒乓（服务器重启/断连风暴触发，单进程即可复现）。 */
  private connectBusy = false
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const delay = nextBackoffMs(this.reconnectAttempt++)
    this.reconnectTimer = setTimeout(() => this.connectWithBackoff(), delay)
    this.reconnectTimer.unref?.()
  }

  private connectWithBackoff(): void {
    if (this.stopping || !this.transport) return
    if (this.connectBusy) return // 已有连接尝试在途——单环纪律，防双定时器并发连出两条 WS
    this.connectBusy = true
    this.transport.onClose((code) => {
      if (this.stopping) return
      if (this.stableTimer) {
        clearTimeout(this.stableTimer)
        this.stableTimer = null
      }
      // 降噪(与连接失败同策略):只在首次断开打一条并带关闭码(诊断服务器为何踢线),
      // 乒乓期间静默,稳定在线后打恢复——防"连上即被踢"循环刷屏盖住会话输出
      if (!this.failureLogged) {
        this.failureLogged = true
        this.log(`连接断开（关闭码 ${code}），将退避重试（最长 30s/次），恢复后自动连接；/relay status 查看，/relay stop 停止`)
      }
      this.scheduleReconnect()
    })
    this.transport
      .connect()
      .then(() => {
        this.connectBusy = false
        this.reconnectAttempt = 0
        // M4 重连再同步：审批是可操作状态（非纯展示），每次连接成功从真相源重建手机视图
        this.bridge?.resyncPendingApprovals()
        // M4e 同理：未决提问从 AskChannel 真相源重推
        this.bridge?.resyncPendingAsks()
        // M5：权限模式标量真相补推（手机徽标收敛）
        this.bridge?.resyncModeState()
        // M7：看板快照补推（附着会话；latest-wins 收敛）
        this.bridge?.resyncBoard()
        // 工作计划树快照补推（同 resyncBoard 先例）
        this.bridge?.resyncWorkPlan()
        // M6 owner 易主/桥重建：附着归零一次性通告（手机按 syncState 对账重 announce；实例内幂等）
        this.bridge?.announceAttachReset()
        // 稳定在线 15s 才计为恢复并打印(防"连上即被踢"的乒乓每次循环各打两条)
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null
          this.log(this.failureLogged ? '已连接中继（连接已恢复）' : '已连接中继')
          this.failureLogged = false
        }, RELAY_STABLE_MS)
        this.stableTimer.unref?.()
      })
      .catch((err) => {
        this.connectBusy = false
        if (this.stopping) return
        // 降噪:连续失败只在首次打一条(状态变化才打),退避重试静默进行,恢复时打一条;
        // 否则服务器长时间不可用时刷屏盖住会话输出
        if (!this.failureLogged) {
          this.failureLogged = true
          this.log(`连接失败（${String(err)}），将退避重试（最长 30s/次），恢复后自动连接；/relay status 查看，/relay stop 停止`)
        }
        this.scheduleReconnect()
      })
  }

  /** 只停传输与桥（租约保留或已失） */
  private async stopTransportOnly(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
    this.transport?.close()
    this.transport = null
    for (const off of this.wiringUnsubscribers) off()
    this.wiringUnsubscribers = []
    this.bridge = null
  }

  /** 停 relay：取消等待重试 + 停传输 + 清心跳 + 退租（用户显式停用是最高优先级意图） */
  async stop(): Promise<void> {
    this.wantLease = false
    this.cancelLeaseRetry()
    this.leaseRetryAttempt = 0
    this.stopping = true
    this.bridge?.stop() // M1.1：取消在途 429 退避等待（防 35s 挂住优雅退出口）
    await this.stopTransportOnly()
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    await this.arbiter.release()
    this.stopping = false
    this.failureLogged = false
    this.log('relay 已停止')
  }
}

/** 宿主探活（注入 core 租约仲裁）：ownerId 解析 pid 探活；解析不明一律视为存活（宁等勿抢） */
function probeOwnerAlive(ownerId: string): boolean {
  const m = /:(\d+)$/.exec(ownerId)
  if (!m) return true
  try {
    process.kill(Number(m[1]), 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM' // 无权限发送信号 = 进程存在
  }
}

/** 装配 PairingManager（CliContext.createAdapters 调用点） */
export function createCliPairingManager(deps: {
  secureStorage: ConstructorParameters<typeof PairingManager>[0]['secureStorage']
  userDataPath: string
}): PairingManager {
  return new PairingManager({
    secureStorage: deps.secureStorage,
    deviceStore: new NodeDeviceStore(defaultDevicesPath(deps.userDataPath)),
  })
}

/** /pair config 写入（含 caPath） */
export async function saveCliRelayConfig(
  pm: PairingManager,
  config: { relayUrl: string; operatorKey: string; caFP: string; caPath: string },
): Promise<void> {
  await pm.saveRelayConfig(config)
}
