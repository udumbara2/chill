/**
 * NodeWsTransport.ts — CLI 侧 RelayTransport 实现（Node ws + tls CA pinning）。
 */
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import type { RelayTransport, BoxMessage } from '@assistant-ai/core'
import {
  WS_KEEPALIVE_PING_INTERVAL_MS,
  keepaliveAction,
} from '@assistant-ai/core'

/**
 * 纯接收向长连的僵尸防御（2026-10-03 根治"手机端显示桌面离线"事故）：这条 WS 唯一的
 * 出向流量是被动 pong——路径静默死亡后无来包触发应答、无 TCP 出向重传、无 close 帧。
 * 主动探活策略（常数+判死）单源在 core wsKeepalive，此处只做定时器编排：周期 ping、
 * pong 陈旧判死 terminate → 既有 onClose 单环重连；重连后服务器重放积压，桌面自愈。
 */
export class NodeWsTransport implements RelayTransport {
  private ws: WebSocket | null = null
  private msgCb: (msg: BoxMessage) => void = () => {}
  private closeCb: (code: number) => void = () => {}
  private url: string
  private readToken: string
  private ca: Buffer | undefined
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastAliveAt = 0
  /** 当前保活归属的 ws 实例（connect 复用同一 transport 重连，防旧实例的 close 误停新保活） */
  private keepaliveWs: WebSocket | null = null

  constructor(relayUrl: string, mailboxId: string, readToken: string, caPath?: string) {
    this.url = `${relayUrl.replace(/\/$/, '')}/box/${mailboxId}`
    this.readToken = readToken
    if (caPath) this.ca = readFileSync(caPath)
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: { authorization: `Bearer ${this.readToken}` },
        ...(this.ca ? { ca: this.ca, rejectUnauthorized: true } : {}),
      })
      this.ws = ws
      const onOpen = () => {
        cleanup()
        this.startKeepalive(ws)
        resolve()
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        ws.off('open', onOpen)
        ws.off('error', onError)
      }
      ws.on('open', onOpen)
      ws.on('error', onError)
      ws.on('message', (data: Buffer) => {
        try {
          const m = JSON.parse(data.toString('utf8')) as BoxMessage
          if (typeof m.id === 'number' && typeof m.blob === 'string') this.msgCb(m)
        } catch {
          /* 畸形帧忽略 */
        }
      })
      ws.on('close', (code: number) => {
        if (this.keepaliveWs === ws) this.stopKeepalive()
        this.closeCb(code)
      })
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
        // 判死：terminate 不发 close 帧（对端路径已死收不到），本地立即触发 close(1006) → 单环重连
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

  onMessage(cb: (msg: BoxMessage) => void): void {
    this.msgCb = cb
  }

  onClose(cb: (code: number) => void): void {
    this.closeCb = cb
  }
}
