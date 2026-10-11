/**
 * NodeWsTransport.ts — CLI 侧 RelayTransport 实现（RelayTransport 接口薄适配）。
 *
 * W1 Phase C（2026-10-11）：WS+tls+探活的实现在 core `NodeRelayBoxTransport` 单源
 * （三壳收敛，rule of three）；本类只做接口形状适配（回调字段制 vs events 参数制），
 * 保持 CLI relayClient 的既有消费面零改动。探活/判死/重连语义逐位不变
 * （策略单源在 core wsKeepalive；pong 陈旧判死 terminate → onClose 单环重连）。
 */
import { NodeRelayBoxTransport } from '@assistant-ai/core'
import type { RelayTransport, BoxMessage } from '@assistant-ai/core'

export class NodeWsTransport implements RelayTransport {
  private inner: NodeRelayBoxTransport | null = null
  private msgCb: (msg: BoxMessage) => void = () => {}
  private closeCb: (code: number) => void = () => {}

  constructor(
    private relayUrl: string,
    private mailboxId: string,
    private readToken: string,
    private caPath?: string,
  ) {}

  get connected(): boolean {
    return this.inner?.connected ?? false
  }

  async connect(): Promise<void> {
    const inner = new NodeRelayBoxTransport(this.relayUrl, this.mailboxId, this.readToken, this.caPath)
    try {
      await inner.connect({
        onMessage: (m) => this.msgCb(m),
        onClose: (code) => this.closeCb(code),
        onError: () => {
          /* 错误详情经 connect reject / 日志通道呈现，此处不重复上报 */
        },
      })
      this.inner = inner
    } catch (err) {
      try {
        inner.close()
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  close(): void {
    this.inner?.close()
    this.inner = null
  }

  onMessage(cb: (msg: BoxMessage) => void): void {
    this.msgCb = cb
  }

  onClose(cb: (code: number) => void): void {
    this.closeCb = cb
  }
}
