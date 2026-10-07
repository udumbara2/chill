/**
 * http.ts — 最小 HTTP JSON 客户端（RN fetch → OkHttp → 主进程注入的私有 CA pinning 生效）。
 */

export interface HttpResult {
  status: number;
  json: unknown;
}

export function httpBase(relayUrl: string): string {
  return relayUrl.replace(/^ws/, 'http').replace(/\/$/, '');
}

export async function httpJson(
  method: 'GET' | 'POST' | 'DELETE',
  relayUrl: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${httpBase(relayUrl)}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 204 等无 body */
  }
  return { status: res.status, json };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
