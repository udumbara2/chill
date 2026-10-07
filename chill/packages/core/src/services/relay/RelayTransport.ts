/**
 * RelayTransport.ts — relay 传输接口定义（M2）。
 *
 * 本目录红线：全部 Node-free（禁 node:* 导入与 Buffer，renderer/RN 安全）。
 * 传输实现留壳侧：CLI = Node ws + tls CA pinning；electron = main 进程 ws + IPC 桥；
 * RN = OkHttp 自定义 TrustManager。core 只依赖这里的接口。
 */

/** 服务器推下来的信箱消息（id 服务器生成，ACK 凭它） */
export interface BoxMessage {
  id: number
  blob: string
}

/** 读信箱长连（WS /box/:mailboxId，Bearer read_token 由实现方内部持有） */
export interface RelayTransport {
  /** 完成握手（含鉴权）后 resolve；失败 reject */
  connect(): Promise<void>
  close(): void
  readonly connected: boolean
  onMessage(cb: (msg: BoxMessage) => void): void
  onClose(cb: (code: number) => void): void
}

/** 最小 HTTP JSON 客户端（tokens/redeem/status/投 blob/ACK/revoke；CA pin 由实现方内部处理） */
export interface RelayHttpResult {
  status: number
  json: unknown
}

export interface RelayHttp {
  request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts?: { token?: string; body?: unknown },
  ): Promise<RelayHttpResult>
}

/** 断线指数退避（1s → 30s 封顶，抖动 ±20%；纯函数，壳侧重连循环用） */
export function nextBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt))
  const jitter = 0.8 + random() * 0.4
  return Math.round(base * jitter)
}
