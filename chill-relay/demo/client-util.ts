/**
 * client-util.ts — demo 双端共用的最小传输 helper（Node 侧，ws/wss + 证书固定）。
 * 注意：demo 严禁 QR 之外的回传信道——桌面只能通过 GET /pair/status 拿 phonePub。
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

export interface TlsOpt {
  ca?: Buffer;
}

export function loadCa(path?: string): TlsOpt {
  return path ? { ca: readFileSync(path) } : {};
}

export interface HttpResult {
  status: number;
  json: unknown;
}

/** 最小 HTTP JSON 客户端（wss 模式带 CA pin）。 */
export function httpJson(
  method: string,
  urlStr: string,
  opts: { token?: string; body?: unknown; ca?: Buffer } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isTls = u.protocol === 'https:' || u.protocol === 'wss:';
    const mod = isTls ? https : http;
    const payload = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body), 'utf8') : null;
    const headers: Record<string, string> = {};
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (isTls ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        ...(opts.ca ? { ca: opts.ca, rejectUnauthorized: true } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* 204 等无 body */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export interface BoxMsg {
  id: number;
  blob: string;
}

/** 读信箱长连（read_token 鉴权，wss 带 CA pin）。 */
export function connectBox(
  relayUrl: string,
  mailboxId: string,
  readToken: string,
  tls: TlsOpt,
  onMsg: (msg: BoxMsg) => void,
  onClose?: () => void,
): WebSocket {
  const base = relayUrl.replace(/\/$/, '');
  const ws = new WebSocket(`${base}/box/${mailboxId}`, {
    headers: { authorization: `Bearer ${readToken}` },
    ...(tls.ca ? { ca: tls.ca, rejectUnauthorized: true } : {}),
  });
  ws.on('message', (data: Buffer) => {
    try {
      const m = JSON.parse(data.toString('utf8')) as BoxMsg;
      if (typeof m.id === 'number' && typeof m.blob === 'string') onMsg(m);
    } catch {
      /* ignore */
    }
  });
  if (onClose) ws.on('close', onClose);
  return ws;
}

/** relay URL 的 http(s) 形态（ws→http, wss→https）。 */
export function httpBase(relayUrl: string): string {
  return relayUrl.replace(/^ws/, 'http').replace(/\/$/, '');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
