/**
 * relayMain.ts — electron 主进程 relay 驻留（照 MCP 先例进程内常驻）：
 * 租约仲裁（~/.chill/relay.lock，与 CLI 共享同一把锁——谁先在线谁跑）+ WS 生命周期 +
 * HTTP 代理（CA pinning 需主进程 tls）+ 消息转发渲染进程（解密/bridge 在 renderer）。
 * before-quit 由 electron-main 调 stopRelayForQuit 清理。
 *
 * W1 Phase B（2026-10-11）：内胆全部换 core relayNodeRuntime（NodeRelayBoxTransport/
 * relayNodeHttp* 三件/FileRelayLockStore/RelayLeaseHost）——本地拷贝退役，三壳单源。
 * IPC 通道与语义一字不动；行为差异仅一处（改进）：租约丢失 onLeaseLost 一次性触发并停心跳
 * （旧版每 5s 重复发送 lease-lost 空转）。
 */
import { readFileSync } from 'node:fs'
import { open as fsOpen, stat as fsStat } from 'node:fs/promises'
import { join, dirname, isAbsolute, normalize, resolve as pathResolve } from 'node:path'
import { homedir } from 'node:os'
import { ipcMain, type BrowserWindow } from 'electron'
import {
  NodeRelayBoxTransport,
  relayNodeHttpRequest,
  relayNodeHttpGetBinary,
  relayNodeHttpPutBinary,
  FileRelayLockStore,
  RelayLeaseHost,
  NodeDeviceStore,
  caFingerprint,
  type PairedDevice,
} from '@assistant-ai/core'
import { IPC_CHANNELS } from '../ipcChannels'

// ---------- 主进程状态 ----------
let lease: RelayLeaseHost | null = null
let transport: NodeRelayBoxTransport | null = null
let getWindow: () => BrowserWindow | null = () => null

function send(channel: string, payload: unknown): void {
  try {
    getWindow()?.webContents.send(channel, payload)
  } catch {
    /* 窗口已销毁等场景忽略 */
  }
}

function relayLockPath(): string {
  return join(homedir(), '.chill', 'relay.lock')
}

/** 配对账本（devices.json 单源，账本单源化 2026-10-12）——与 CLI/daemon 同一 core 实现 */
const devicesStore = new NodeDeviceStore(join(homedir(), '.chill', 'relay', 'devices.json'))

function ensureLease(): RelayLeaseHost {
  if (!lease) {
    lease = new RelayLeaseHost({
      lockStore: new FileRelayLockStore(relayLockPath()),
      ownerId: `electron:${process.pid}`,
      // M3.2（版本切换接续规划）：体验窗不连 relay——workcopy 目录探测（与 CLI 侧 sessionService.isPreview
      // 同源约定，__dirname 含 'chill-workcopy' 段即体验形态）；候补都不当：验收期手机确定性由旧版本
      // 正式实例服务。渲染端对非 'started' 一律静默让位（同 held-by-other 通路，零 UI 侵入）
      isPreviewGuard: () => typeof __dirname === 'string' && __dirname.includes('chill-workcopy'),
      onLeaseLost: () => {
        try {
          transport?.close()
        } catch {
          /* ignore */
        }
        send(IPC_CHANNELS.RELAY_LEASE_LOST, {})
      },
    })
  }
  return lease
}

// ---------- d→m 文件发送读侧（渲染进程无任意路径读能力；主进程 fs 执行） ----------

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
async function relayStatFile(opts: {
  path: string
}): Promise<{ size: number; mtimeMs: number; isFile: boolean } | null> {
  try {
    const st = await fsStat(opts.path)
    return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }
  } catch {
    return null
  }
}

/**
 * 路径解析（桥层 denylist 判定基准）：~ 展开为真实用户目录、相对路径按会话工作目录解析、
 * 规范化绝对路径；顺带回报 homeDir（~/.chill/** denylist 基准）与大小写敏感性（Windows 口径）。
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

/** IPC 装配（electron-main 在窗口创建后调用一次） */
export function registerRelayIpc(getMainWindow: () => BrowserWindow | null): void {
  getWindow = getMainWindow

  ipcMain.handle(IPC_CHANNELS.RELAY_START, async () => ensureLease().start())

  ipcMain.handle(IPC_CHANNELS.RELAY_STOP, async () => {
    await stopRelayForQuit()
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_STATUS, async () => ({
    running: ensureLease().isRunning(),
    holder: await ensureLease().currentHolder(),
    connected: transport?.connected ?? false,
  }))

  ipcMain.handle(IPC_CHANNELS.RELAY_HTTP_REQUEST, async (_e, opts: Parameters<typeof relayNodeHttpRequest>[0]) => {
    return relayNodeHttpRequest(opts)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_HTTP_GET_BINARY, async (_e, opts: Parameters<typeof relayNodeHttpGetBinary>[0]) => {
    return relayNodeHttpGetBinary(opts)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_HTTP_PUT_BINARY, async (_e, opts: Parameters<typeof relayNodeHttpPutBinary>[0]) => {
    return relayNodeHttpPutBinary(opts)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_READ_FILE_SLICE, async (_e, opts: Parameters<typeof relayReadFileSlice>[0]) => {
    return relayReadFileSlice(opts)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_STAT_FILE, async (_e, opts: Parameters<typeof relayStatFile>[0]) => {
    return relayStatFile(opts)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_RESOLVE_PATH, async (_e, opts: Parameters<typeof relayResolvePath>[0]) => {
    return relayResolvePath(opts)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_CA_FP, async (_e, opts: { caPath: string }) => {
    return { caFP: caFingerprint(new Uint8Array(readFileSync(opts.caPath))) }
  })

  // 配对小码规划 R2：CA 文件原始字节 base64 回传（供铸造上传——渲染进程无 fs，UI-only
  // 配对依赖此通道）；读失败 reject 由渲染层呈现（信任锚不静默降级）
  ipcMain.handle(IPC_CHANNELS.RELAY_CA_CERT, async (_e, opts: { caPath: string }) => {
    return { caB64: readFileSync(opts.caPath).toString('base64') }
  })

  // 配对账本（devices.json 单源，账本单源化 2026-10-12）：读=store（首读含惰性遗留收敛）；
  // 写=载荷形状校验+原子写，失败 throw → invoke reject 回渲染层（配对 fail-loud）
  ipcMain.handle(IPC_CHANNELS.RELAY_DEVICES_GET, async () => {
    return devicesStore.read()
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_DEVICES_SET, async (_e, devices: unknown) => {
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
    await devicesStore.write(devices as PairedDevice[])
    return null
  })

  ipcMain.handle(
    IPC_CHANNELS.RELAY_TRANSPORT_CONNECT,
    async (_e, opts: { relayUrl: string; mailboxId: string; readToken: string; caPath?: string }) => {
      try {
        transport?.close()
      } catch {
        /* ignore */
      }
      transport = new NodeRelayBoxTransport(opts.relayUrl, opts.mailboxId, opts.readToken, opts.caPath)
      await transport.connect({
        onMessage: (msg) => send(IPC_CHANNELS.RELAY_TRANSPORT_MESSAGE, msg),
        onClose: (code) => send(IPC_CHANNELS.RELAY_TRANSPORT_CLOSED, { code }),
        onError: (message) => send(IPC_CHANNELS.RELAY_TRANSPORT_ERROR, { message }),
      })
      return { ok: true }
    },
  )

  ipcMain.handle(IPC_CHANNELS.RELAY_TRANSPORT_CLOSE, async () => {
    transport?.close()
    transport = null
    return { ok: true }
  })
}

/** before-quit 清理（幂等） */
export async function stopRelayForQuit(): Promise<void> {
  try {
    transport?.close()
  } catch {
    /* ignore */
  }
  transport = null
  if (lease) await lease.stop()
}
