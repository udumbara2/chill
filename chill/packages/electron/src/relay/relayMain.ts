/**
 * relayMain.ts — electron 主进程 relay 驻留（照 MCP 先例进程内常驻）：
 * 租约仲裁（~/.chill/relay.lock，与 CLI 共享同一把锁——谁先在线谁跑）+ WS 生命周期 +
 * HTTP 代理（CA pinning 需主进程 tls）+ 消息转发渲染进程（解密/bridge 在 renderer）。
 * before-quit 由 electron-main 调 stopRelayForQuit 清理。
 */
import http from 'node:http'
import https from 'node:https'
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { open as fsOpen, stat as fsStat } from 'node:fs/promises'
import { join, dirname, isAbsolute, normalize, resolve as pathResolve } from 'node:path'
import { homedir } from 'node:os'
import { ipcMain, type BrowserWindow } from 'electron'
import {
  RelayLockArbiter,
  RELAY_LOCK_HEARTBEAT_MS,
  caFingerprint,
  type RelayLockStore,
  type RelayLockState,
} from '@assistant-ai/core'
import { NodeRelayTransport } from './NodeRelayTransport'
import { IPC_CHANNELS } from '../ipcChannels'

// ---------- relay.lock 文件存储（与 CLI 同路径 ~/.chill/relay.lock；tmp+rename 原子写） ----------
class FileRelayLockStore implements RelayLockStore {
  constructor(private filePath: string) {}
  async read(): Promise<RelayLockState | null> {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as RelayLockState
      if (typeof raw.owner !== 'string' || typeof raw.heartbeatAt !== 'number') return null
      return raw
    } catch {
      return null
    }
  }
  async write(state: RelayLockState): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(state), 'utf8')
    renameSync(tmp, this.filePath)
  }
  async remove(): Promise<void> {
    try {
      unlinkSync(this.filePath)
    } catch {
      /* 不存在即目标态 */
    }
  }
}

// ---------- 主进程状态 ----------
let arbiter: RelayLockArbiter | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let transport: NodeRelayTransport | null = null
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

function ensureArbiter(): RelayLockArbiter {
  if (!arbiter) {
    arbiter = new RelayLockArbiter(new FileRelayLockStore(relayLockPath()), `electron:${process.pid}`)
  }
  return arbiter
}

// ---------- HTTP 代理（渲染进程无 tls/CA pinning 能力，经主进程执行） ----------
function relayHttpRequest(opts: {
  method: 'GET' | 'POST' | 'DELETE'
  relayUrl: string
  path: string
  token?: string
  body?: unknown
  caPath?: string
}): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const base = opts.relayUrl.replace(/^ws/, 'http').replace(/\/$/, '')
    const u = new URL(base + opts.path)
    const isTls = u.protocol === 'https:'
    const mod = isTls ? https : http
    const payload = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body), 'utf8') : null
    const headers: Record<string, string> = {}
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const ca = opts.caPath ? readFileSync(opts.caPath) : undefined
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (isTls ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method,
        headers,
        ...(ca ? { ca, rejectUnauthorized: true } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            /* 无 body */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 二进制 GET（媒体直传密文拉取；同 relayHttpRequest 的信任根——CA pinning；base64 回传渲染端；v2 带 Range） */
function relayHttpGetBinary(opts: {
  relayUrl: string
  path: string
  caPath?: string
  range?: string
}): Promise<{ status: number; base64: string | null }> {
  return new Promise((resolve, reject) => {
    const base = opts.relayUrl.replace(/^ws/, 'http').replace(/\/$/, '')
    const u = new URL(base + opts.path)
    const isTls = u.protocol === 'https:'
    const mod = isTls ? https : http
    const ca = opts.caPath ? readFileSync(opts.caPath) : undefined
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (isTls ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        ...(opts.range ? { headers: { range: opts.range } } : {}),
        ...(ca ? { ca, rejectUnauthorized: true } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({ status: res.statusCode ?? 0, base64: bytes.length > 0 ? bytes.toString('base64') : null })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * 二进制 PUT（d→m 文件发送：密文分片上传 PUT /media/<name>；与 relayHttpGetBinary 同信任根）。
 * 头：Bearer write_token + Media-Offset/Media-Total；base64 入参（IPC 边界）；409 的 { current } 随 json 回传。
 */
function relayHttpPutBinary(opts: {
  relayUrl: string
  path: string
  caPath?: string
  token: string
  offset: number
  total: number
  base64: string
}): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const base = opts.relayUrl.replace(/^ws/, 'http').replace(/\/$/, '')
    const u = new URL(base + opts.path)
    const isTls = u.protocol === 'https:'
    const mod = isTls ? https : http
    const payload = Buffer.from(opts.base64, 'base64')
    const ca = opts.caPath ? readFileSync(opts.caPath) : undefined
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (isTls ? 443 : 80),
        path: u.pathname + u.search,
        method: 'PUT',
        headers: {
          authorization: `Bearer ${opts.token}`,
          'media-offset': String(opts.offset),
          'media-total': String(opts.total),
          'content-type': 'application/octet-stream',
          'content-length': String(payload.length),
        },
        ...(ca ? { ca, rejectUnauthorized: true } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            /* 无 body */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
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

  ipcMain.handle(IPC_CHANNELS.RELAY_START, async () => {
    // M3.2（版本切换接续规划）：体验窗不连 relay——workcopy 目录探测（与 CLI 侧 sessionService.isPreview
    // 同源约定，__dirname 含 'chill-workcopy' 段即体验形态）；候补都不当：验收期手机确定性由旧版本
    // 正式实例服务。渲染端对非 'started' 一律静默让位（同 held-by-other 通路，零 UI 侵入）
    if (typeof __dirname === 'string' && __dirname.includes('chill-workcopy')) return 'preview-no-relay'
    const a = ensureArbiter()
    const r = await a.tryAcquire()
    if (r !== 'acquired') return 'held-by-other'
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        void a.renew().then((ok) => {
          if (!ok) {
            try {
              transport?.close()
            } catch {
              /* ignore */
            }
            send(IPC_CHANNELS.RELAY_LEASE_LOST, {})
          }
        })
      }, RELAY_LOCK_HEARTBEAT_MS)
    }
    return 'started'
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_STOP, async () => {
    await stopRelayForQuit()
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_STATUS, async () => {
    return {
      running: heartbeat !== null,
      holder: await ensureArbiter().currentHolder(),
      connected: transport?.connected ?? false,
    }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_HTTP_REQUEST, async (_e, opts: Parameters<typeof relayHttpRequest>[0]) => {
    return relayHttpRequest(opts)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_HTTP_GET_BINARY, async (_e, opts: Parameters<typeof relayHttpGetBinary>[0]) => {
    return relayHttpGetBinary(opts)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_HTTP_PUT_BINARY, async (_e, opts: Parameters<typeof relayHttpPutBinary>[0]) => {
    return relayHttpPutBinary(opts)
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

  ipcMain.handle(
    IPC_CHANNELS.RELAY_TRANSPORT_CONNECT,
    async (_e, opts: { relayUrl: string; mailboxId: string; readToken: string; caPath?: string }) => {
      try {
        transport?.close()
      } catch {
        /* ignore */
      }
      transport = new NodeRelayTransport(opts.relayUrl, opts.mailboxId, opts.readToken, opts.caPath)
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
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  if (arbiter) await arbiter.release().catch(() => {})
}
