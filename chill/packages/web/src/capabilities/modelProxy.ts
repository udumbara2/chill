/**
 * 模型代理（WebUI 规划 M2.1）
 *
 * 浏览器无 CORS 豁免（Electron 靠 webSecurity:false），模型 API 一律经 daemon 转发：
 *   浏览器 → http://127.0.0.1:<port>/model-proxy/<b64url(真实baseURL)>/<rest>
 *   daemon → 真实 baseURL/<rest>（鉴权头原样透传，SSE/分块流式 pipe 不缓冲）
 *
 * baseURL 重写在 file:read 单点：models 目录下的 JSON 含 adapterConfig.baseURL/
 * apiURL 时改写为代理前缀（core 零改动；渲染层与桌面共用的模型装配代码无感知）。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'

function b64uEncode(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64url')
}

function b64uDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf-8')
}

/** 代理路径前缀判定 */
export function isModelProxyPath(urlPath: string): boolean {
  return urlPath === '/model-proxy' || urlPath.startsWith('/model-proxy/')
}

/** 改写：baseURL → 代理前缀绝对地址 */
export function toProxyBaseURL(original: string, port: number): string {
  return `http://127.0.0.1:${port}/model-proxy/${b64uEncode(original)}`
}

/** models 目录 JSON 的 baseURL/apiURL 改写（file:read 单点；已改写的幂等跳过） */
export function rewriteModelJsonBaseURLs(content: string, port: number): string {
  try {
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) return content
    let changed = false
    const obj = parsed as Record<string, unknown>
    const adapter = obj.adapterConfig
    if (typeof adapter === 'object' && adapter !== null) {
      const a = adapter as Record<string, unknown>
      if (typeof a.baseURL === 'string' && !a.baseURL.includes('/model-proxy/')) {
        a.baseURL = toProxyBaseURL(a.baseURL, port)
        changed = true
      }
    }
    if (typeof obj.apiURL === 'string' && !obj.apiURL.includes('/model-proxy/')) {
      obj.apiURL = toProxyBaseURL(obj.apiURL, port)
      changed = true
    }
    return changed ? JSON.stringify(parsed) : content
  } catch {
    return content // 非 JSON/畸形：原样（诚实失败优于猜测改写）
  }
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, accept',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': '*',
  'access-control-max-age': '86400',
}

/** 处理代理请求（含 OPTIONS 预检）；流式透传——req/res 全程 pipe，零缓冲 */
export function handleModelProxy(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const parts = url.pathname.replace(/^\/model-proxy\//, '').split('/')
  const encoded = parts.shift()
  if (!encoded) {
    res.writeHead(400, CORS_HEADERS).end('missing upstream')
    return
  }
  let upstreamBase: string
  try {
    upstreamBase = b64uDecode(encoded)
    const u = new URL(upstreamBase)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol')
  } catch {
    res.writeHead(400, CORS_HEADERS).end('bad upstream encoding')
    return
  }
  const rest = parts.join('/')
  const target = new URL(`${upstreamBase.replace(/\/+$/, '')}/${rest}${url.search}`)
  const doRequest = target.protocol === 'https:' ? httpsRequest : httpRequest
  // 转发头：去掉 host/origin/referer（上游按自身域名校验）与连接管理头
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'origin', 'referer', 'connection', 'accept-encoding'].includes(k)) continue
    if (typeof v === 'string') headers[k] = v
    else if (Array.isArray(v)) headers[k] = v.join(', ')
  }
  headers.host = target.host
  const upstream = doRequest(
    { method: req.method ??='GET', hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname + target.search, headers, timeout: 120_000 },
    (up) => {
      const outHeaders: Record<string, string | number> = { ...CORS_HEADERS }
      for (const [k, v] of Object.entries(up.headers)) {
        if (k.toLowerCase() === 'access-control-allow-origin') continue // 上游 CORS 头让位本代理
        outHeaders[k] = Array.isArray(v) ? v.join(', ') : (v as string | number)
      }
      res.writeHead(up.statusCode ?? 502, outHeaders)
      up.pipe(res) // 流式透传（SSE 逐块抵达逐块转发，不缓冲）
    },
  )
  upstream.on('timeout', () => { upstream.destroy(new Error('upstream timeout')) })
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, CORS_HEADERS)
    res.end(`upstream error: ${err.message}`)
  })
  req.pipe(upstream) // 请求体同样流式（大请求/流式上传不占内存）
}
