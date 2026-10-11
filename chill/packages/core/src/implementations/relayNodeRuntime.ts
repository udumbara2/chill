/**
 * relayNodeRuntime.ts — relay 客户端的 Node 侧 I/O 运行时（W1《WebUI中继支持》A1 下沉）。
 *
 * rule of three 判例（NodeFileSystemProvider M3 先例）：WS 传输/CA pinning HTTP/锁文件/租约编排
 * 原在 electron 主进程（relayMain.ts + NodeRelayTransport.ts）与 CLI（relayClient 侧）各有一份近亲，
 * web daemon 成为第三消费者 → 按立法"壳不依赖壳、共用 core 单源"下沉至此。
 *
 * 放置纪律：services/relay/** 保持 Node-free 红线（手机端同步与纯逻辑测试面），Node 实现按
 * NodeFileSystemProvider 先例住 implementations/，仅经 core 主入口导出；渲染层产物靠静态 ESM
 * 摇树隔离（本模块 import ws——UI 构建不得包含它，A1-6 发布门验证）。
 *
 * 语义来源：① NodeRelayBoxTransport 自 electron NodeRelayTransport.ts 逐字迁移（events 回调形态：
 * 读长连纯接收向 + core wsKeepalive 探活——租约约定 #5 立法"新壳做 relay 读传输同款必备"）；
 * ② relayNodeHttp* 自 relayMain.ts:77-218 迁移（CA pinning/Range/分片头/409 current）；
 * ③ FileRelayLockStore 逐字迁移（tmp+rename 原子写）；④ RelayLeaseHost 提炼 relayMain.ts:272-308
 * 的 start/stop/status 编排为宿主无关骨架——**传输拆卸不在本类**（onLeaseLost 回调归宿主，D3 边界）。
 */
import http from 'node:http'
import https from 'node:https'
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import WebSocket from 'ws'
import {
  RelayLockArbiter,
  RELAY_LOCK_HEARTBEAT_MS,
  type RelayLockStore,
  type RelayLockState,
} from '../services/relay/relayLock'
import { WS_KEEPALIVE_PING_INTERVAL_MS, keepaliveAction } from '../services/relay/wsKeepalive'

// ==================== ① WS 传输（读长连，纯接收向） ====================

export interface NodeRelayBoxTransportEvents {
  onMessage: (msg: { id: number; blob: string }) => void
  onClose: (code: number) => void
  onError: (message: string) => void
}

/**
 * 纯接收向长连的僵尸防御（同 CLI NodeWsTransport，2026-10-03）：策略单源在 core
 * wsKeepalive（常数+判死），此处只做定时器编排——pong 陈旧判死 terminate →
 * events.onClose(1006) → 上层（宿主转发渲染层 relayService）退避重连。
 * 红线：宿主进程禁被未捕获错误杀死——全部回调 try/catch 自封闭，错误只经 onError 上报。
 */
export class NodeRelayBoxTransport {
  private ws: WebSocket | null = null
  private url: string
  private readToken: string
  private ca: Buffer | undefined
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastAliveAt = 0
  /** 当前保活归属的 ws 实例（重连复用同一 transport，防旧实例 close 误停新保活） */
  private keepaliveWs: WebSocket | null = null

  constructor(relayUrl: string, mailboxId: string, readToken: string, caPath?: string) {
    this.url = `${relayUrl.replace(/\/$/, '')}/box/${mailboxId}`
    this.readToken = readToken
    if (caPath) this.ca = readFileSync(caPath)
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  connect(events: NodeRelayBoxTransportEvents): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      try {
        const ws = new WebSocket(this.url, {
          headers: { authorization: `Bearer ${this.readToken}` },
          ...(this.ca ? { ca: this.ca, rejectUnauthorized: true } : {}),
        })
        this.ws = ws
        ws.on('open', () => {
          settled = true
          this.startKeepalive(ws)
          resolve()
        })
        ws.on('error', (err: Error) => {
          try {
            events.onError(String(err))
          } catch {
            /* 回调异常不外溢 */
          }
          if (!settled) {
            settled = true
            reject(err)
          }
        })
        ws.on('message', (data: Buffer) => {
          try {
            const m = JSON.parse(data.toString('utf8')) as { id: number; blob: string }
            if (typeof m.id === 'number' && typeof m.blob === 'string') events.onMessage(m)
          } catch {
            /* 畸形帧忽略 */
          }
        })
        ws.on('close', (code: number) => {
          if (this.keepaliveWs === ws) this.stopKeepalive()
          try {
            events.onClose(code)
          } catch {
            /* 回调异常不外溢 */
          }
        })
        ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
          const err = new Error(`WS 握手被拒: HTTP ${res.statusCode ?? '?'}`)
          try {
            events.onError(String(err))
          } catch {
            /* 回调异常不外溢 */
          }
          if (!settled) {
            settled = true
            reject(err)
          }
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** 主动探活（见类注释）：周期 ping + pong 陈旧判死 */
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive()
    this.keepaliveWs = ws
    this.lastAliveAt = Date.now()
    ws.on('pong', () => {
      if (this.keepaliveWs === ws) this.lastAliveAt = Date.now()
    })
    this.pingTimer = setInterval(() => {
      if (keepaliveAction(this.lastAliveAt, Date.now()) === 'terminate') {
        this.stopKeepalive()
        try {
          ws.terminate()
        } catch {
          /* ignore */
        }
        return
      }
      try {
        ws.ping()
      } catch {
        /* ignore */
      }
    }, WS_KEEPALIVE_PING_INTERVAL_MS)
    this.pingTimer.unref?.()
  }

  private stopKeepalive(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.keepaliveWs = null
  }

  close(): void {
    this.stopKeepalive()
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }
}

// ==================== ② HTTP 三件（CA pinning；出向全走 HTTP——读 WS 纯接收向） ====================

export interface RelayNodeHttpBase {
  relayUrl: string
  path: string
  caPath?: string
}

/** JSON 请求（配对铸令牌/redeem 轮询/信封投递 POST /box/:id 等） */
export function relayNodeHttpRequest(opts: {
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

/** 二进制 GET（媒体直传密文拉取；base64 回传宿主边界；v2 带 Range） */
export function relayNodeHttpGetBinary(opts: {
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
 * 二进制 PUT（d→m 文件发送：密文分片上传 PUT /media/<name>；与 getBinary 同信任根）。
 * 头：Bearer write_token + Media-Offset/Media-Total；base64 入参（宿主边界）；409 的 { current } 随 json 回传。
 */
export function relayNodeHttpPutBinary(opts: {
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

// ==================== ③ relay.lock 文件存储（tmp+rename 原子写） ====================

/** 与各壳同路径（~/.chill/relay.lock）——谁先在线谁跑的仲裁真相源 */
export class FileRelayLockStore implements RelayLockStore {
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

// ==================== ④ 租约宿主骨架（编排提炼；传输拆卸归壳——D3 边界） ====================

export type RelayLeaseStartResult = 'started' | 'held-by-other' | 'preview-no-relay'

export interface RelayLeaseHostDeps {
  lockStore: RelayLockStore
  /** 持有者标识（如 'web:<pid>' / 'electron:<pid>'） */
  ownerId: string
  /** 心跳间隔（缺省 RELAY_LOCK_HEARTBEAT_MS；测试可注入小值） */
  heartbeatMs?: number
  /** 预览/体验形态守卫（返回 true → 不连，照 electron M3.2 约定：验收期手机确定性由正式实例服务） */
  isPreviewGuard?: () => boolean
  /** 租约丢失回调（renew 失败=已被他端接管）——只发信号，传输/清理归宿主 */
  onLeaseLost?: () => void
}

/**
 * start/stop/status 的宿主无关骨架（自 electron relayMain.ts:272-308 提炼）：
 * tryAcquire → 心跳 renew → 失败即 **一次性** onLeaseLost（并停心跳——续约只能续自己的约，
 * 丢失后继续空转无意义；宿主收到信号后自行关传输/让位）→ stop 幂等释放。
 * 不含等待态重试（租约约定 #3 既知欠账，三端一致的面）。
 */
export class RelayLeaseHost {
  private arbiter: RelayLockArbiter | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private lostFired = false

  constructor(private deps: RelayLeaseHostDeps) {}

  private ensureArbiter(): RelayLockArbiter {
    if (!this.arbiter) {
      this.arbiter = new RelayLockArbiter(this.deps.lockStore, this.deps.ownerId)
    }
    return this.arbiter
  }

  async start(): Promise<RelayLeaseStartResult> {
    if (this.deps.isPreviewGuard?.()) return 'preview-no-relay'
    const a = this.ensureArbiter()
    const r = await a.tryAcquire()
    if (r !== 'acquired') return 'held-by-other'
    if (!this.heartbeat) {
      this.lostFired = false
      const interval = setInterval(() => {
        void this.ensureArbiter()
          .renew()
          .then((ok) => {
            if (!ok && !this.lostFired) {
              this.lostFired = true
              this.stopHeartbeat()
              try {
                this.deps.onLeaseLost?.()
              } catch {
                /* 宿主回调异常不杀宿主 */
              }
            }
          })
          .catch(() => {
            /* 存储异常不杀宿主；下轮心跳再试 */
          })
      }, this.deps.heartbeatMs ?? RELAY_LOCK_HEARTBEAT_MS)
      this.heartbeat = interval
    }
    return 'started'
  }

  /** 幂等停止：清心跳 + 退租 */
  async stop(): Promise<void> {
    this.stopHeartbeat()
    if (this.arbiter) await this.arbiter.release().catch(() => {})
  }

  isRunning(): boolean {
    return this.heartbeat !== null
  }

  async currentHolder(): Promise<string | null> {
    return this.ensureArbiter().currentHolder()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }
}
