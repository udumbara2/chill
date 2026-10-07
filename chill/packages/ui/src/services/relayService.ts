/**
 * relayService.ts — UI 渲染进程 relay 装配与单例（M2a，照 chatEngine 单例模式）。
 *
 * 进程边界：PairingManager/RelayBridge（core 纯逻辑）在本进程；WS 与 HTTP（CA pinning）
 * 经 ElectronRelayTransport/ElectronRelayHttp 桥到主进程；relay.lock 租约也在主进程
 * （与 CLI 共享 ~/.chill/relay.lock——谁先在线谁跑）。
 * 配对记录存 KV（relay.devices，经 IPC 落主进程 state.json）。
 */
import { ref } from 'vue'
import { getHostAPI, tryGetHostAPI } from '../host/hostApi'
import {
  PairingManager,
  RelayBridge,
  nextBackoffMs,
  decorativeFingerprint,
  makeResolveApproval,
  makeListPendingApprovals,
  makeListRecentSettledApprovals,
  makeResolveAsk,
  makeListPendingAsks,
  makeListRecentSettledAsks,
  makeBoardSyncBridgeDeps,
  makeWorkPlanSyncBridgeDeps,
  makeSessionSyncBridgeDeps,
  makeRecoveryBridgeDeps,
  makeFileTransferBridgeDeps,
  wireApprovalChannel,
  wireToolStatus,
  wireBeatBoundary,
  wireAskChannel,
  wirePermissionMode,
  wireCommandState,
  makeGetCommandState,
  makeExecuteCommand,
  wireTurnStream,
  wireHistoryInvalidated,
  wireTurnSettled,
  wireBoard,
  wireWorkPlan,
  wireFeedSubagent,
  builtInToolExecutor,
  eventBus,
  EVENTS,
  type PairedDevice,
  type DeviceStore,
  type QrPayload,
  type PendingRoundEntry,
  type FileReceiptPayload,
} from '@assistant-ai/core'
import { ElectronSecureStorage } from '../adapters/ElectronSecureStorage'
import { IPCKeyValueStore } from '../adapters/IPCKeyValueStore'
import { ElectronRelayTransport, ElectronRelayHttp } from '../adapters/ElectronRelayTransport'
import { loadProjectList } from '../adapters/projectStorage'
import { loadSession } from '../adapters/sessionStorage'
import { usePermissionModeStore } from '../stores/permissionModeStore'
import { getChatEngine, getActiveSessionId, getActiveEngineOrNull, openSession, getEngineWorkDir, closeSession } from './chatEngine'

const DEVICES_KV_KEY = 'relay.devices'

class KVDeviceStore implements DeviceStore {
  private kv = new IPCKeyValueStore()
  async read(): Promise<PairedDevice[]> {
    try {
      const raw = this.kv.getItem(DEVICES_KV_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  async write(devices: PairedDevice[]): Promise<void> {
    this.kv.setItem(DEVICES_KV_KEY, JSON.stringify(devices))
  }
}

let pairingManager: PairingManager | null = null

export function getPairingManager(): PairingManager {
  if (!pairingManager) {
    pairingManager = new PairingManager({
      secureStorage: new ElectronSecureStorage(),
      deviceStore: new KVDeviceStore(),
    })
  }
  return pairingManager
}

// ---------- 运行态（状态栏/手机 Tab 呈现） ----------
export const relayState = ref<{
  running: boolean
  connected: boolean
  peerDevice: string | null
  lastError: string | null
}>({ running: false, connected: false, peerDevice: null, lastError: null })

let transport: ElectronRelayTransport | null = null
let bridge: RelayBridge | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let stopped = true
/** userDataPath 惰性缓存（附件绝对路径纯派生：userDataPath/attachments/<ref>——不新增 electron IPC） */
let attachmentsRootCache: string | null = null
/** 桥 wiring 退订清单（桥重建/停止时对称回收；照 boardUnsub 先例收敛为一清单，防漏回收） */
let wiringUnsubs: Array<() => void> = []

/**
 * 3.7：壳切换点直推桥 active.changed（chatEngine.setActiveEngine 调用）——手机"●当前"
 * 徽标跟随桌面前台。core 接线函数（wireActiveSession 等引擎回调形态）保留 CLI 现用法不动；
 * 壳 getter 为新增形态（getActiveSessionId/ensureActiveSession/ensureNewSession 经桥 deps 注入）。
 */
export function pushActiveSessionChanged(sessionId: string | null): void {
  bridge?.pushSessionEvent({ kind: 'active.changed', sessionId })
}

/** 经主进程租约启动 relay（配置完成即自启的调用点；held-by-other 时静默让位） */
export async function startRelay(): Promise<'started' | 'held-by-other'> {
  const r = await getHostAPI().relayStart()
  relayState.value.running = r === 'started'
  if (r === 'started') {
    const devices = await getPairingManager().listDevices()
    if (devices.length > 0) await attachPeer(devices[0]!, null, true)
  }
  return r
}

export async function stopRelay(): Promise<void> {
  stopped = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  for (const off of wiringUnsubs) off()
  wiringUnsubs = []
  transport?.close()
  transport = null
  bridge = null
  relayState.value = { running: false, connected: false, peerDevice: null, lastError: null }
  await getHostAPI().relayStop()
}

/** 挂载桥（配对完成 / 已配对设备启动；MVP 单设备） */
export async function attachPeer(device: PairedDevice, pairingToken: string | null, confirmed: boolean): Promise<void> {
  stopped = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  for (const off of wiringUnsubs) off()
  wiringUnsubs = []
  transport?.close()

  const pm = getPairingManager()
  const config = await pm.getRelayConfig()
  if (!config) throw new Error('relay 未配置')
  const caPath = (await pm.getCaPath()) ?? undefined
  const { secrets, myBox, peerBox } = await pm.deriveForDevice(device.phonePub)
  const desk = await pm.getOrCreateDeviceKey()
  // M6：会话目录真实值（~/.chill/sessions——与主进程 SessionPersistence 同源；
  // buildCatalogState 已覆写为 IPC，此值供工厂语义完整与后续用途）
  const userDataPath = (await getHostAPI().getUserDataPath()).path ?? ''
  const sessionsDir = userDataPath ? `${userDataPath}/sessions` : ''
  // d→m 文件发送：denylist 判定基准（homeDir + 大小写敏感性）由主进程路径解析 IPC 一次取回
  //（渲染进程的 process 是 vite polyfill，无可靠 platform/homedir——平台事实只信主进程）
  const pathSys = await getHostAPI().relayResolvePath({ input: '~' })

  transport = new ElectronRelayTransport()
  transport.attach({ relayUrl: config.relayUrl, mailboxId: myBox, readToken: secrets.readToken, ...(caPath ? { caPath } : {}) })
  const relayHttp = new ElectronRelayHttp(config.relayUrl, caPath)
  bridge = new RelayBridge({
    transport,
    http: relayHttp,
    secrets,
    myBox,
    peerBox,
    deskPub: desk.publicKey,
    phonePub: device.phonePub,
    deviceName: 'chill 桌面',
    pairingToken,
    getPairingToken: () => pm.getPairingToken(),
    confirmed,
    // 3.7：壳侧 active getter（旧端兼容附着路径"桌面当前会话"判定 + M6b 'new' 分支）——
    // 现读活跃引擎，多会话切换后手机徽标/镜像与桌面前台保持一致；M6 起经 makeSessionSyncBridgeDeps
    // 同口供给（组包在 core；buildCatalogState 渲染端无 fs → 覆写为 IPC 回主进程同一函数）
    ...makeSessionSyncBridgeDeps({
      sessionsDir,
      listProjects: loadProjectList,
      loadSession: async (id) => (await loadSession(id)).record ?? null,
      getActiveSessionId: () => getActiveSessionId(),
      ensureActiveSession: async (sessionId) => {
        // 发言即激活：切壳侧 active 到目标会话（已在 registry 仅切指针；未加载装载并切）
        try {
          const engine = await openSession(sessionId)
          return engine ? 'ok' : 'notfound'
        } catch {
          return 'busy'
        }
      },
      ensureNewSession: async () => {
        // M6b 'new'：空会话复用 / 新开会话（registry.create 同步铸 id——返 ok 时 id 必已诞生）
        try {
          const engine = await openSession()
          return engine ? 'ok' : 'busy'
        } catch {
          return 'busy'
        }
      },
    }),
    // M6 catalog 组包覆写：渲染端无 fs（空 shim），buildCatalogStateBody 回主进程跑（与工厂同一函数）
    buildCatalogState: (known) =>
      getHostAPI().relayCatalogState({ known, activeSessionId: getActiveSessionId() }),
    // M4/M4e/M5 审批/ask/权限模式 deps：真相源在 core ApprovalChannel/AskChannel/builtInToolExecutor
    //（make* 闭包只做转发；setPermissionMode 合法值校验在此，非法返 false 不写真相源——照 CLI 口径）
    resolveApproval: makeResolveApproval(),
    listPendingApprovals: makeListPendingApprovals(),
    listRecentSettledApprovals: makeListRecentSettledApprovals(),
    resolveAsk: makeResolveAsk(),
    listPendingAsks: makeListPendingAsks(),
    listRecentSettledAsks: makeListRecentSettledAsks(),
    setPermissionMode: (mode, by) => {
      if (mode !== 'readonly' && mode !== 'boundary' && mode !== 'fullAccess') return false
      builtInToolExecutor.setPermissionMode(mode, by === 'phone' ? 'phone' : 'local')
      usePermissionModeStore().syncFromEngine() // UI 镜像跟随（手机改模式不落陈旧）
      return true
    },
    getPermissionMode: () => builtInToolExecutor.getPermissionMode(),
    // M8：命令面状态快照 + 命令执行（M2 激活；绑定逻辑唯一实现在 core commandSurface）
    getCommandState: makeGetCommandState(() => getChatEngine()),
    executeCmd: makeExecuteCommand(() => getChatEngine(), {
      // 改名裸转发（merge 优先级兜底，后台空闲引擎无写盘）；electron-main 直通 SessionPersistence
      patchTitle: (id, title) => getHostAPI().sessionPatchTitle(id, title),
      delete: async (id) => {
        // 后台引擎收口（幂等）：若 id 在注册表 → abort 封口→endSession→dispose；
        // 活动会话已被 core 执行器先行 detach——SessionRegistry 订阅引擎身份变化同步重键，
        // detach 返回时旧键必已清，此处的 closeSession(旧 id) 恒空转
        await closeSession(id)
        // 顺序即残留清理：close 的封口落盘若写回文件，紧随的 sessionDelete 删除（=retireDeletedSession"补删一次"同款）
        return getHostAPI().sessionDelete(id)
      },
    }),
    // 去重环持久化（照 CLI makeSeenIdsStore 语义；UI 存 IPC KV——重启不重放旧信封）
    loadSeenIds: async () => {
      try {
        const raw = new IPCKeyValueStore().getItem('relay.seen')
        return raw ? (JSON.parse(raw) as string[]) : []
      } catch {
        return []
      }
    },
    saveSeenIds: async (ids) => {
      new IPCKeyValueStore().setItem('relay.seen', JSON.stringify(ids))
    },
    // M7增量3·决策30/31：投递台账（崩溃恢复唯一事实源，IPC KV 持久化——照 relay.seen 先例）
    loadPendingRounds: async () => {
      try {
        const raw = new IPCKeyValueStore().getItem('relay.pendingRounds')
        return raw ? (JSON.parse(raw) as PendingRoundEntry[]) : []
      } catch {
        return []
      }
    },
    savePendingRounds: async (entries: PendingRoundEntry[]) => {
      new IPCKeyValueStore().setItem('relay.pendingRounds', JSON.stringify(entries))
    },
    // M7增量3·决策31：崩溃恢复（resumeRound 惰性取 active 引擎；peekSessionTail 读盘上真相源）
    ...makeRecoveryBridgeDeps({
      getEngine: () => getChatEngine(),
      loadSession: async (id) => (await loadSession(id)).record ?? null,
    }),
    // M7：共享看板 deps（getProjection 组包 + ask/approval 未决计数；组包在 relayEngineWiring）
    ...makeBoardSyncBridgeDeps(),
    // 工作计划树 deps（分键清单镜像 + buildWorkPlanTree 投影组包）
    ...makeWorkPlanSyncBridgeDeps(),
    // file.* 协议族：附件落盘 + 摄入装配（electron 零改动——既有 attachment IPC + getUserDataPath 纯派生路径）
    ...makeFileTransferBridgeDeps({
      saveAttachment: async (bytes, name) => {
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const r = await getHostAPI().saveAttachment(buf, name)
        if (!r.success || !r.fileId) throw new Error(r.error ?? 'attachment:save 失败')
        return r.fileId
      },
      readAsBase64: async (ref) => {
        const r = await getHostAPI().readAttachmentAsBase64(ref)
        if (!r.success || !r.base64) throw new Error(r.error ?? 'attachment:read-as-base64 失败')
        return r.base64
      },
      getAbsolutePath: async (ref) => {
        if (attachmentsRootCache === null) {
          try {
            const r = await getHostAPI().getUserDataPath()
            attachmentsRootCache = r.path ?? ''
          } catch {
            attachmentsRootCache = ''
          }
        }
        return `${attachmentsRootCache}/attachments/${ref}`
      },
      // 媒体直传：密文经主进程 IPC 二进制拉取（同一 CA pinning 信任根；v2 带 Range）
      fetchMedia: async (name, opts) => {
        const r = await relayHttp.getBinary(`/static/media/${name}`, opts?.range)
        if ((r.status !== 200 && r.status !== 206) || !r.bytes || r.bytes.length === 0) {
          throw new Error(`媒体拉取 HTTP ${r.status}`)
        }
        return r.bytes
      },
      // d→m 文件发送：密文分片 PUT（getBinary 对偶，同信任根）+ 读侧切片/stat/路径解析 IPC
      //（渲染进程无任意路径读能力——主进程执行；write_token 认哈希不认方向，中继零改动）
      putMedia: (name, offset, total, bytes) =>
        relayHttp.putBinary(`/media/${name}`, bytes, { token: secrets.writeToken, offset, total }),
      readFileSlice: async (p, offset, length) => {
        const r = await getHostAPI().relayReadFileSlice({ path: p, offset, length })
        if (!r.success || r.base64 === undefined) throw new Error(r.error ?? 'relay:read-file-slice 失败')
        const bin = atob(r.base64)
        const out = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
        return out
      },
      statFile: (p) => getHostAPI().relayStatFile({ path: p }),
      resolvePath: async (input) => {
        const workdir = getEngineWorkDir()
        const r = await getHostAPI().relayResolvePath({ input, ...(workdir ? { workdir } : {}) })
        return r.path
      },
      homeDir: pathSys.homeDir,
      caseInsensitivePaths: pathSys.caseInsensitive,
    }),
    enqueue: async (input, opts) => {
      // 3.7 核对钉住：enqueueExternalMessage 现读活跃引擎（getChatEngine 每次调用取 active 引擎）。
      // M7增量3·决策30：opts.onIngested 透传（用户消息持久化后、轮次开始前的两段式回调——桥据此 ACK）
      // file.* 协议族：input 携带 contentParts/attachmentRefs（手机附件注入路径）
      const result = await getChatEngine().enqueueExternalMessage(
        {
          text: input.text,
          origin: 'mobile',
          ...(input.contentParts ? { contentParts: input.contentParts } : {}),
          ...(input.attachmentRefs ? { attachmentRefs: input.attachmentRefs } : {}),
        },
        {
          streamCallback: (chunk) => {
            if (chunk.content) opts?.onDelta?.(chunk.content)
          },
          ...(opts?.onIngested ? { onIngested: opts.onIngested } : {}),
        },
      )
      return {
        content: result.content,
        aborted: result.aborted,
        ...(result.deniedReason !== undefined ? { deniedReason: result.deniedReason } : {}),
      }
    },
    onConfirmRequest: async (dev, fp) =>
      window.confirm(
        `手机「${dev}」请求配对\n装饰性指纹：${fp || decorativeFingerprint(desk.publicKey, device.phonePub)}（请与手机显示核对）\n\n确认配对？`,
      ),
    onAlarm: (m) => {
      relayState.value.lastError = m
      console.warn('[relay]', m)
    },
  })
  bridge.start()
  // mobile_send_file 工具的发送通道注入（T4）：sessionId 由注入 fn 惰性取当前活跃会话
  //（仿 CLI relayClient 先例）；桥未挂载/未持租约时诚实报错。setter 幂等覆盖，随桥重建重挂
  builtInToolExecutor.setRelayFileSender(({ path }) => {
    const b = bridge
    if (!b) return Promise.reject(new Error('中继未在运行（未启动或租约由另一实例持有）'))
    return b.sendFileToMobile({ path, sessionId: getActiveSessionId() ?? undefined })
  })
  // 桥 wiring 全量装配（照 CLI relayClient 清单，建/退订对称入 wiringUnsubs）：
  // M4 审批/M4e ask/M5 权限模式/M4b 工具行·节拍/M6 被动流·历史失效·轮次落定/M7 看板/V2 事实流。
  // wireActiveSession 不装：UI 多会话 registry 形态由壳切换点直推（pushActiveSessionChanged），
  // 注释见该函数。目录监听（wireSessionCatalogWatch）在主进程常驻（渲染端无 fs），事件经
  // onRelaySessionEvent 转发当前桥。
  wiringUnsubs = [
    wireApprovalChannel(bridge),
    wireToolStatus(bridge),
    wireBeatBoundary(bridge),
    wireAskChannel(bridge),
    wirePermissionMode(bridge),
    // M8：命令面状态广播（轮末/ctx 更新点/resync 三保底——命令执行后的必推在桥内）
    wireCommandState(bridge),
    wireTurnStream(bridge),
    wireHistoryInvalidated(bridge),
    wireTurnSettled(bridge),
    wireBoard(bridge),
    // 工作计划树：TASK_* 主会话写入 → 分键镜像 → 防抖合并 → workplan.state（附着门控在桥内；
    // 缺归因事件归引擎当前活动会话）
    wireWorkPlan(bridge, { getActiveSessionId }),
    // V2：Worker 事实流（fork 在主进程 → preload 转发桥补喂；与 eventBus 订阅并联）
    wireFeedSubagent(bridge, {
      extraSubscribe: (fn) => {
        tryGetHostAPI()?.onSubagentToolCall?.((p: unknown) => fn(p as never))
        return () => {
          /* preload 通道无 off 语义；wireFeedSubagent 退订后以 stopped 短路残余回调 */
        }
      },
    }),
  ]
  relayState.value.peerDevice = device.device
  stopped = false
  connectWithBackoff()
}

function connectWithBackoff(): void {
  if (stopped || !transport) return
  transport.onClose(() => {
    relayState.value.connected = false
    if (stopped) return
    const delay = nextBackoffMs(reconnectAttempt++)
    reconnectTimer = setTimeout(() => connectWithBackoff(), delay)
  })
  transport
    .connect()
    .then(() => {
      reconnectAttempt = 0
      relayState.value.connected = true
      // 连接成功补推（对齐 CLI relayClient 清单）：未决审批/ask、权限模式、附着会话看板——
      // 重连前的可操作状态经此收敛（latest-wins/幂等重放）
      bridge?.resyncPendingApprovals()
      bridge?.resyncPendingAsks()
      bridge?.resyncModeState()
      bridge?.resyncBoard()
      // 工作计划树快照补推（同 resyncBoard 先例）
      bridge?.resyncWorkPlan()
    })
    .catch((err) => {
      if (stopped) return
      relayState.value.lastError = String(err)
      const delay = nextBackoffMs(reconnectAttempt++)
      reconnectTimer = setTimeout(() => connectWithBackoff(), delay)
    })
}

// 租约被他端夺走（CLI 接管等）：主进程推 RELAY_LEASE_LOST → 本端停传输呈现让位
getHostAPI().onRelayLeaseLost(() => {
  relayState.value.connected = false
  relayState.value.lastError = 'relay 已由另一 chill 端接管'
  transport?.close()
})

// M6 目录元数据监听事件（主进程 wireSessionCatalogWatch → 渲染端投当前桥；桥未挂时丢弃，
// 手机 catalog.sync 按需拉兜底）。模块级单次订阅（preload 通道无 off 语义）
getHostAPI().onRelaySessionEvent((payload) => {
  bridge?.pushSessionEvent(payload as never)
})

// d→m 文件发送回执落会话提示（FILE_RECEIPT；无等待器的迟到 receipt 同样到此——送达事实须
// 让用户可见）：仅归属会话仍是活跃会话时写历史（跨会话不写错历史）；提示行渲染（synthetic
// fileReceipt，MessageItem 白名单）。模块级单次订阅（同 onRelaySessionEvent 先例）
eventBus.on(EVENTS.FILE_RECEIPT, (p: FileReceiptPayload) => {
  const label = p.name ? `《${p.name}》` : '文件'
  const text = p.ok ? `手机已接收${label}` : `手机接收${label}失败：${p.error ?? '未知原因'}`
  if (p.sessionId && p.sessionId !== getActiveSessionId()) return
  getActiveEngineOrNull()?.appendSyntheticMessage(`（📱 ${text}）`, 'fileReceipt')
})

// ---------- 配对流程（手机 Tab 调用） ----------
export interface PairingSession {
  qr: QrPayload
  expires: number
  wait: () => Promise<{ ok: boolean; message: string }>
}

export async function startPairingSession(name: string): Promise<PairingSession> {
  const pm = getPairingManager()
  const config = await pm.getRelayConfig()
  if (!config) throw new Error('请先配置中继（relay 地址/运营者密钥/CA 路径）')
  const startResult = await startRelay()
  const caPath = (await pm.getCaPath()) ?? undefined
  const http = new ElectronRelayHttp(config.relayUrl, caPath)
  const { qr, expires } = await pm.startPairing(http, config, name)
  // 配对令牌即刻落 secureStorage：跨端配对时当前在线端的 bridge 懒读它验 pairingMAC
  await pm.savePairingToken(qr.token)
  return {
    qr,
    expires,
    wait: async () => {
      const result = await pm.waitForRedeem(http, qr.token, expires)
      if (result.state !== 'redeemed') {
        return { ok: false, message: result.state === 'expired' ? '配对令牌已过期，请重新出码' : '配对超时，请重新出码' }
      }
      await pm.completePairing(result.phonePub, result.device, qr.token)
      if (startResult === 'started') {
        await attachPeer({ phonePub: result.phonePub, device: result.device, pairedAt: new Date().toISOString() }, qr.token, false)
        return { ok: true, message: `手机已登记：${result.device}，请在弹窗中确认配对` }
      }
      return { ok: true, message: '配对确认将出现在当前在线的 chill 端' }
    },
  }
}
