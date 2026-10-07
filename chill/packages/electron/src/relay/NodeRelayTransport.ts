/**
 * NodeRelayTransport.ts — electron 主进程 relay 传输（ws + tls CA pinning）。
 *
 * 红线：主进程禁被未捕获错误杀死——全部回调 try/catch 自封闭，错误只经 onError 回调上报。
 * 消息经 registerForwarder 推给渲染进程（解密/bridge 在 renderer，core 纯逻辑）。
 */
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import { WS_KEEPALIVE_PING_INTERVAL_MS, keepaliveAction } from '@assistant-ai/core'

/**
 * 纯接收向长连的僵尸防御（同 CLI NodeWsTransport，2026-10-03）：策略单源在 core
 * wsKeepalive（常数+判死），此处只做定时器编排——pong 陈旧判死 terminate →
 * events.onClose(1006) → 上层（渲染层 relayService）退避重连。
 */
export interface MainTransportEvents {
  onMessage: (msg: { id: number; blob: string }) => void
  onClose: (code: number) => void
  onError: (message: string) => void
}

export class NodeRelayTransport {
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

  connect(events: MainTransportEvents): Promise<void> {
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

  /** 主动探活（见文件头注释）：周期 ping + pong 陈旧判死 */
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
