/**
 * NodeRelayHttp.ts — CLI 侧 RelayHttp 实现（core relayNodeHttp* 薄委托）。
 *
 * W1 Phase C（2026-10-11）：http/https + CA pinning 的实现在 core
 * `relayNodeHttpRequest/GetBinary/PutBinary` 单源（三壳收敛）；本类保持 CLI 既有
 * 消费面（构造 relayUrl+caPath；Buffer 进出）零改动。CA 从 /pair config 登记的路径读；
 * wss 必须给 CA（私有 CA 不在系统信任库）。
 */
import { readFileSync } from 'node:fs'
import type { RelayHttp, RelayHttpResult } from '@assistant-ai/core'
import { relayNodeHttpRequest, relayNodeHttpGetBinary, relayNodeHttpPutBinary } from '@assistant-ai/core'

/** relayUrl（ws:// 或 wss://）转 http(s) base */
export function relayHttpBase(relayUrl: string): string {
  return relayUrl.replace(/^ws/, 'http').replace(/\/$/, '')
}

export class NodeRelayHttp implements RelayHttp {
  private relayUrl: string
  private caPath: string | undefined

  constructor(relayUrl: string, caPath?: string) {
    this.relayUrl = relayUrl
    // 构造期校验 CA 可读（旧版构造期读入并缓存；现在读路径透传给 core，构造期 stat 一下保持"配错即刻报"）
    if (caPath) {
      readFileSync(caPath)
      this.caPath = caPath
    }
  }

  request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<RelayHttpResult> {
    return relayNodeHttpRequest({
      method,
      relayUrl: this.relayUrl,
      path,
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(this.caPath ? { caPath: this.caPath } : {}),
    })
  }

  /** 二进制 GET（媒体直传密文拉取；同一 CA pinning 信任根；v2 带 Range） */
  async getBinary(path: string, range?: string): Promise<{ status: number; bytes: Buffer | null }> {
    const r = await relayNodeHttpGetBinary({
      relayUrl: this.relayUrl,
      path,
      ...(this.caPath ? { caPath: this.caPath } : {}),
      ...(range ? { range } : {}),
    })
    return { status: r.status, bytes: r.base64 ? Buffer.from(r.base64, 'base64') : null }
  }

  /**
   * 二进制 PUT（d→m 文件发送：密文分片上传 PUT /media/<name>；与 getBinary 同信任根）。
   * 头：Bearer write_token + Media-Offset/Media-Total；响应 JSON 原样返回（409 的 { current } 供桥层再同步）。
   */
  async putBinary(
    path: string,
    bytes: Buffer,
    opts: { token: string; offset: number; total: number },
  ): Promise<{ status: number; json: unknown }> {
    return relayNodeHttpPutBinary({
      relayUrl: this.relayUrl,
      path,
      base64: bytes.toString('base64'),
      token: opts.token,
      offset: opts.offset,
      total: opts.total,
      ...(this.caPath ? { caPath: this.caPath } : {}),
    })
  }
}
