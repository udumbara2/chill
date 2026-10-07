/** 测试辅助：起服务（注入 now/频控）、完整密码学配对、WS 读信箱客户端。 */
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  createRelayServer,
  type RelayServer,
  type RateLimits,
  type PublishLimits,
  type MediaLimits,
} from '../src/server.js';
import { Store } from '../src/store.js';
import {
  generateKeyPair,
  ecdhShared,
  deriveSecrets,
  tokenHash,
  mailboxIdFromPub,
  type DerivedSecrets,
  type KeyPairB64,
} from '../src/shared/envelope.js';

export const OPERATOR = 'test-operator-key';
export const T0 = 1_700_000_000_000;

export interface TestServer {
  port: number;
  base: string;
  wsBase: string;
  store: Store;
  server: RelayServer;
  now: () => number;
  setNow: (t: number) => void;
  close: () => Promise<void>;
}

export async function startServer(opts: {
  limits?: Partial<RateLimits>;
  tls?: { key: Buffer; cert: Buffer };
  publish?: { token: string; staticDir: string; limits?: Partial<PublishLimits> };
  /** 媒体直传通道：staticDir 即启用（无发布令牌——GET /static 与 PUT /media 由 staticDir 驱动） */
  media?: { staticDir: string; limits?: Partial<MediaLimits> };
} = {}): Promise<TestServer> {
  let t = T0;
  const store = new Store(':memory:', () => t);
  const generous: Partial<RateLimits> = {
    tokensPerMin: 100_000,
    statusPerMin: 100_000,
    redeemPerMin: 100_000,
    wsAuthFailPerMin: 100_000,
    boxBytesPerMin: 1 << 30,
    boxMsgsPerMin: 1_000_000,
    heartbeatMs: 60_000,
    sweepIntervalMs: 3_600_000, // 测试里手动调 sweep
  };
  const server = createRelayServer({
    store,
    operatorKey: OPERATOR,
    now: () => t,
    limits: { ...generous, ...opts.limits },
    logger: () => {},
    ...(opts.tls ? { tls: opts.tls } : {}),
    ...(opts.publish
      ? {
          publishToken: opts.publish.token,
          staticDir: opts.publish.staticDir,
          ...(opts.publish.limits ? { publishLimits: opts.publish.limits } : {}),
        }
      : {}),
    ...(opts.media
      ? {
          staticDir: opts.media.staticDir,
          ...(opts.media.limits ? { mediaLimits: opts.media.limits } : {}),
        }
      : {}),
  });
  const port = await server.listen(0, '127.0.0.1');
  const scheme = opts.tls ? 'https' : 'http';
  const wsScheme = opts.tls ? 'wss' : 'ws';
  return {
    port,
    base: `${scheme}://127.0.0.1:${port}`,
    wsBase: `${wsScheme}://127.0.0.1:${port}`,
    store,
    server,
    now: () => t,
    setNow: (nt: number) => {
      t = nt;
    },
    close: async () => {
      await server.close();
      store.close();
    },
  };
}

/** 起带发布通道的服务 + 一次性 static 临时目录（after 里 rmSync）。 */
export async function startPublishServer(
  publishLimits: Partial<PublishLimits> = {},
): Promise<TestServer & { staticDir: string; token: string }> {
  const staticDir = mkdtempSync(join(tmpdir(), 'relay-static-'));
  const token = 'test-publish-token';
  const srv = await startServer({ publish: { token, staticDir, limits: publishLimits } });
  return { ...srv, staticDir, token };
}

/** 起仅媒体通道的服务（无 PUBLISH_TOKEN——staticDir 驱动 /static 与 /media；/publish 应 404）。 */
export async function startMediaServer(
  mediaLimits: Partial<MediaLimits> = {},
): Promise<TestServer & { staticDir: string }> {
  const staticDir = mkdtempSync(join(tmpdir(), 'relay-media-'));
  const srv = await startServer({ media: { staticDir, limits: mediaLimits } });
  return { ...srv, staticDir };
}

export function cleanupStaticDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface ApiResult {
  status: number;
  json: unknown;
}

export async function api(
  srv: TestServer,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; rawBody?: Buffer } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  let body: string | Buffer | undefined;
  if (opts.rawBody) {
    body = opts.rawBody;
    headers['content-type'] = 'application/json';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${srv.base}${path}`, { method, headers, ...(body ? { body } : {}) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

export interface Paired {
  token: string;
  desk: KeyPairB64;
  phone: KeyPairB64;
  secrets: DerivedSecrets;
  deskBox: string;
  phoneBox: string;
}

/** 走真实 HTTP 接口完成一次配对（密码学全量真实，仅跳过 hello/confirm）。 */
export async function makePair(srv: TestServer): Promise<Paired> {
  const tr = await api(srv, 'POST', '/pair/tokens', { token: OPERATOR });
  if (tr.status !== 200) throw new Error(`tokens: ${tr.status}`);
  const { token } = (tr.json ?? {}) as { token: string };
  const desk = generateKeyPair();
  const phone = generateKeyPair();
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey));
  const rr = await api(srv, 'POST', '/pair/redeem', {
    token,
    body: {
      phonePub: phone.publicKey,
      deskPub: desk.publicKey,
      device: 'test-phone',
      writeHash: tokenHash(secrets.writeToken),
      readHash: tokenHash(secrets.readToken),
      revokeHash: tokenHash(secrets.revokeToken),
    },
  });
  if (rr.status !== 200) throw new Error(`redeem: ${rr.status}`);
  return {
    token,
    desk,
    phone,
    secrets,
    deskBox: mailboxIdFromPub(desk.publicKey),
    phoneBox: mailboxIdFromPub(phone.publicKey),
  };
}

/** 直接经 store 配对（冒烟等批量场景，绕过 HTTP）。 */
export function makePairDirect(srv: TestServer): Paired {
  const token = 'direct-' + Math.random().toString(36).slice(2);
  const desk = generateKeyPair();
  const phone = generateKeyPair();
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey));
  const deskBox = mailboxIdFromPub(desk.publicKey);
  const phoneBox = mailboxIdFromPub(phone.publicKey);
  const wh = tokenHash(secrets.writeToken);
  const rh = tokenHash(secrets.readToken);
  const vh = tokenHash(secrets.revokeToken);
  srv.store.createMailbox(deskBox, wh, rh, vh, 'test-desktop');
  srv.store.createMailbox(phoneBox, wh, rh, vh, 'test-phone');
  return { token, desk, phone, secrets, deskBox, phoneBox };
}

export interface BoxMsg {
  id: number;
  blob: string;
}

/** WS 读信箱客户端（收集消息）。 */
export class TestWsClient {
  msgs: BoxMsg[] = [];
  closedCode: number | null = null;
  private ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString('utf8')) as BoxMsg;
      this.msgs.push(m);
    });
    ws.on('close', (code: number) => {
      this.closedCode = code;
    });
  }

  static async connect(
    srv: TestServer,
    box: string,
    readToken: string,
    opts: { ca?: Buffer } = {},
  ): Promise<TestWsClient> {
    const ws = new WebSocket(`${srv.wsBase}/box/${box}`, {
      headers: { authorization: `Bearer ${readToken}` },
      ...(opts.ca ? { ca: opts.ca, rejectUnauthorized: true } : {}),
    });
    // 先挂监听器再等 open：服务器握手完成即补投，晚挂会丢首批消息
    const client = new TestWsClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    return client;
  }

  /** 等到收满 n 条（超时即失败返回 false）。 */
  async waitFor(n: number, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    while (this.msgs.length < n && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.msgs.length >= n;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  terminate(): void {
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
  }
}

export function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
