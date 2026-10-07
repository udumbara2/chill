/**
 * WS 通道帧协议（WebUI 规划 M1.3）
 *
 * 三帧形态（方法名复用既有 IPC 通道名——preload 的翻译成本最低）：
 * - 请求  C→S { t:'req', id, m:'session:list-meta', a:[...] }
 * - 响应  S→C { t:'res', id, ok:true, r } / { t:'res', id, ok:false, e:'错误文案' }
 * - 事件  S→C { t:'ev', n:'kv:changed', d:{...} }（kv 快照/变更、会话变更等推送）
 *
 * 设计边界：订阅（onXxx）完全是 ws-host 客户端本地注册表——订阅方法不过线，
 * 线上只有服务端主动推的事件帧。
 */

export interface ReqFrame { t: 'req'; id: string; m: string; a: unknown[] }
export interface ResFrame { t: 'res'; id: string; ok: boolean; r?: unknown; e?: string }
export interface EvFrame { t: 'ev'; n: string; d: unknown }
export type Frame = ReqFrame | ResFrame | EvFrame

/** 解析单帧（畸形输入返回 null，由调用方关闭连接——fail-closed） */
export function parseFrame(raw: unknown): ReqFrame | null {
  if (typeof raw !== 'string' && !(raw instanceof Buffer)) return null
  let f: unknown
  try {
    f = JSON.parse(String(raw))
  } catch {
    return null
  }
  if (
    typeof f === 'object' && f !== null &&
    (f as { t?: unknown }).t === 'req' &&
    typeof (f as { id?: unknown }).id === 'string' &&
    typeof (f as { m?: unknown }).m === 'string' &&
    Array.isArray((f as { a?: unknown }).a)
  ) {
    return f as ReqFrame
  }
  return null
}

export function resFrame(id: string, ok: true, r: unknown): ResFrame
export function resFrame(id: string, ok: false, e: string): ResFrame
export function resFrame(id: string, ok: boolean, p: unknown): ResFrame {
  return ok ? { t: 'res', id, ok: true, r: p } : { t: 'res', id, ok: false, e: String(p) }
}

export function evFrame(n: string, d: unknown): EvFrame {
  return { t: 'ev', n, d }
}
