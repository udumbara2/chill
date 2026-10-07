/**
 * NodeRelayHttp.ts — CLI 侧 RelayHttp 实现（Node http/https + CA pinning）。
 * CA 从 /pair config 登记的路径读；wss 必须给 CA（私有 CA 不在系统信任库）。
 */
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import type { RelayHttp, RelayHttpResult } from '@assistant-ai/core'

/** relayUrl（ws:// 或 wss://）转 http(s) base */
export function relayHttpBase(relayUrl: string): string {
  return relayUrl.replace(/^ws/, 'http').replace(/\/$/, '')
}

export class NodeRelayHttp implements RelayHttp {
  private base: string
  private ca: Buffer | undefined

  constructor(relayUrl: string, caPath?: string) {
    this.base = relayHttpBase(relayUrl)
    if (caPath) this.ca = readFileSync(caPath)
  }

  request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<RelayHttpResult> {
    return new Promise((resolve, reject) => {
      const u = new URL(this.base + path)
      const isTls = u.protocol === 'https:'
      const mod = isTls ? https : http
      const payload = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body), 'utf8') : null
      const headers: Record<string, string> = {}
      if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
      if (payload) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = String(payload.length)
      }
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || (isTls ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers,
          ...(this.ca ? { ca: this.ca, rejectUnauthorized: true } : {}),
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
              /* 204 等无 body */
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

  /** 二进制 GET（媒体直传密文拉取；JSON 请求之外的同信任根通道——同一 CA pinning；v2 带 Range） */
  getBinary(path: string, range?: string): Promise<{ status: number; bytes: Buffer | null }> {
    return new Promise((resolve, reject) => {
      const u = new URL(this.base + path)
      const isTls = u.protocol === 'https:'
      const mod = isTls ? https : http
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || (isTls ? 443 : 80),
          path: u.pathname + u.search,
          method: 'GET',
          ...(range ? { headers: { range } } : {}),
          ...(this.ca ? { ca: this.ca, rejectUnauthorized: true } : {}),
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }))
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  /**
   * 二进制 PUT（d→m 文件发送：密文分片上传 PUT /media/<name>；与 getBinary 同信任根 CA pinning）。
   * 头：Bearer write_token（认令牌哈希不认方向——桌面天然持有同一凭据）+ Media-Offset/Media-Total。
   * 响应 JSON 原样返回（409 的 { current } 供桥层 409 再同步）。
   */
  putBinary(
    path: string,
    bytes: Buffer,
    opts: { token: string; offset: number; total: number },
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const u = new URL(this.base + path)
      const isTls = u.protocol === 'https:'
      const mod = isTls ? https : http
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
            'content-length': String(bytes.length),
          },
          ...(this.ca ? { ca: this.ca, rejectUnauthorized: true } : {}),
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
      req.write(bytes)
      req.end()
    })
  }
}
