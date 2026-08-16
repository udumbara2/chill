/**
 * node-fetch 的原生 fetch 替身
 *
 * bundle 构建（cli / electron / worker）时经 esbuild `alias: { 'node-fetch': 本文件 }` 整体替换 node-fetch v2。
 * 背景：node-fetch v2 → whatwg-url → tr46 → punycode 触发 DEP0040 警告，其内部 url.parse() 触发 DEP0169；
 * openai@4 的 node 运行时 shim 会静态 import node-fetch，esbuild 打平后在 bundle 加载期就发出警告。
 * Node 18+ / 浏览器均自带 fetch 全家桶，运行时行为不受影响（core 客户端也已显式传入原生 fetch）。
 */
const nativeFetch = globalThis.fetch.bind(globalThis)

// 显式标注为 any：Node 的 fetch 全局类型来自 undici-types，declaration 产出不可移植（TS2742）；
/* eslint-disable @typescript-eslint/no-explicit-any */
export default nativeFetch as any
export const fetch: any = nativeFetch
export const Headers: any = globalThis.Headers
export const Request: any = globalThis.Request
export const Response: any = globalThis.Response
/* eslint-enable @typescript-eslint/no-explicit-any */

export class FetchError extends Error {
  code?: string
  errno?: string
  type?: string

  constructor(message: string, type?: string, systemError?: { code?: string; errno?: string }) {
    super(message)
    this.name = 'FetchError'
    this.type = type
    this.code = systemError?.code
    this.errno = systemError?.errno
  }
}

export class AbortError extends Error {
  type = 'aborted'

  constructor(message: string) {
    super(message)
    this.name = 'AbortError'
  }
}

export const isRedirect = (code: number): boolean =>
  code === 301 || code === 302 || code === 303 || code === 307 || code === 308
