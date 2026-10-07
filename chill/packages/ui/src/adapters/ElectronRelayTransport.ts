/**
 * ElectronRelayTransport.ts — UI 渲染进程 relay 传输/HTTP 适配器。
 * 进程边界（M2a）：真实 WS 与 tls 在 electron 主进程（CA pinning），
 * 本适配器把 core RelayTransport/RelayHttp 接口桥到 IPC；解密/bridge 留在渲染进程（core 纯逻辑）。
 */
import type { RelayTransport, RelayHttp, RelayHttpResult, BoxMessage } from '@assistant-ai/core'
import { getHostAPI } from '../host/hostApi'

export class ElectronRelayTransport implements RelayTransport {
  private msgCb: (msg: BoxMessage) => void = () => {}
  private closeCb: (code: number) => void = () => {}
  private open = false
  private wired = false

  /** 主进程事件订阅（幂等；connect 前调用一次） */
  private wire(): void {
    if (this.wired) return
    this.wired = true
    getHostAPI().onRelayTransportMessage((msg) => this.msgCb(msg))
    getHostAPI().onRelayTransportClosed(({ code }) => {
      this.open = false
      this.closeCb(code)
    })
    getHostAPI().onRelayTransportError(() => {
      /* 错误详情经 connect reject / 状态条呈现，此处不重复上报 */
    })
  }

  get connected(): boolean {
    return this.open
  }

  async connect(): Promise<void> {
    this.wire()
    // connect 参数由 attach() 注入（见下方 attach 模式）
    if (!this.pending) throw new Error('ElectronRelayTransport: 未 attach 连接参数')
    await getHostAPI().relayTransportConnect(this.pending)
    this.open = true
  }

  close(): void {
    this.open = false
    void getHostAPI().relayTransportClose()
  }

  onMessage(cb: (msg: BoxMessage) => void): void {
    this.msgCb = cb
  }

  onClose(cb: (code: number) => void): void {
    this.closeCb = cb
  }

  // ---------- attach 模式：连接参数先入主进程 ----------
  private pending: { relayUrl: string; mailboxId: string; readToken: string; caPath?: string } | null = null
  attach(params: { relayUrl: string; mailboxId: string; readToken: string; caPath?: string }): void {
    this.pending = params
  }
}

export class ElectronRelayHttp implements RelayHttp {
  constructor(
    private relayUrl: string,
    private caPath?: string,
  ) {}

  async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<RelayHttpResult> {
    const r = await getHostAPI().relayHttpRequest({
      method,
      relayUrl: this.relayUrl,
      path,
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(this.caPath ? { caPath: this.caPath } : {}),
    })
    return { status: r.status, json: r.json }
  }

  /** 二进制 GET（媒体直传密文拉取；经主进程 IPC——同一 CA pinning 信任根，base64 解码回 Uint8Array；v2 带 Range） */
  async getBinary(path: string, range?: string): Promise<{ status: number; bytes: Uint8Array | null }> {
    const r = await getHostAPI().relayHttpGetBinary({
      relayUrl: this.relayUrl,
      path,
      ...(this.caPath ? { caPath: this.caPath } : {}),
      ...(range ? { range } : {}),
    })
    if (!r.base64) return { status: r.status, bytes: null }
    const bin = atob(r.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { status: r.status, bytes }
  }

  /**
   * 二进制 PUT（d→m 文件发送：密文分片上传 PUT /media/<name>；getBinary 的对偶——
   * 同一 CA pinning 信任根，base64 过桥；409 的 current 原样回传给桥层再同步）。
   */
  async putBinary(
    path: string,
    bytes: Uint8Array,
    opts: { token: string; offset: number; total: number },
  ): Promise<{ status: number; current?: number }> {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
    const r = await getHostAPI().relayHttpPutBinary({
      relayUrl: this.relayUrl,
      path,
      base64: btoa(bin),
      token: opts.token,
      offset: opts.offset,
      total: opts.total,
      ...(this.caPath ? { caPath: this.caPath } : {}),
    })
    const cur = (r.json as { current?: unknown } | null)?.current
    return { status: r.status, ...(typeof cur === 'number' ? { current: cur } : {}) }
  }
}
