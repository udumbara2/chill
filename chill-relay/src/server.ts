/**
 * server.ts — 盲中继服务：http(+tls) + ws，8 接口 + 频控 + 心跳 + 异常兜底。
 * 不引入框架（原生 http + ws）。单进程前提（多实例破坏原子语义）。
 *
 * 可选静态发布通道（PUBLISH_TOKEN 未配置则两条路由均不注册）：
 * - PUT /publish（Bearer 发布令牌——独立低权凭据，与 operatorKey 分层；截图/APK 上传）
 * - GET /static/*（只读产物；不可猜文件名即访问凭据；shots/ 按 TTL 过期；apk/ 发布点淘汰保留
 *   最近 N 版[feed 引用豁免]；成功不记路径日志）
 *
 * 投递正确性（设计 §4.1 钉死）：
 * - 补投/直推竞态：先注册连接 → 同步块内查未 ACK 记入 in-flight → 直推查重。
 *   better-sqlite3 同步 + 单线程事件循环，注册与查询之间无任何投递可插入。
 * - 任何消息只凭 ACK 删除，不存在"乐观标记"（at-least-once）。
 * - 单活跃读者：新连接建立踢掉旧连接。
 */
import http from 'node:http';
import https from 'node:https';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Store, DEAD_LETTER_ATTEMPTS } from './store.js';
import { issueToken, pairStatus, redeem, parseRedeemBody } from './pairing.js';
import { tokenHash, MAX_WIRE_BYTES, isB64u } from './shared/envelope.js';

const MAX_BODY_BYTES = 128 * 1024; // HTTP body 硬上限（边读边掐，超限 413 断连）
const WS_MAX_PAYLOAD = 96 * 1024;

export interface RateLimits {
  tokensPerMin: number;
  statusPerMin: number;
  redeemPerMin: number;
  wsAuthFailPerMin: number; // 限未鉴权握手每 IP
  boxBytesPerMin: number; // 字节制
  boxMsgsPerMin: number; // 条数兜底
  /** 探活直答路由（GET /box/:id/presence，按请求方信箱计频）——桌面在线性查询，additive（中继投递流控规划 M2.2） */
  presencePerMin: number;
  heartbeatMs: number;
  sweepIntervalMs: number;
}

export const DEFAULT_LIMITS: RateLimits = {
  tokensPerMin: 10,
  statusPerMin: 30,
  redeemPerMin: 10,
  wsAuthFailPerMin: 5,
  boxBytesPerMin: 512 * 1024,
  boxMsgsPerMin: 600,
  presencePerMin: 30, // 手机前台探活 30s 一拍天然 <30/min；防滥用另设独立小额频控
  heartbeatMs: 30_000,
  sweepIntervalMs: 60_000,
};

/** 静态发布通道限额（单文件 / static 总量 / 频次 / shots 保留期）。 */
export interface PublishLimits {
  publishPerMin: number;
  publishMaxFileBytes: number;
  publishMaxTotalBytes: number;
  shotTtlMs: number;
  /** apk/ 保留最近 N 版（mtime 序；feed 清单当前引用的包豁免）——回退走源码重建重推，磁盘须自动收敛 */
  apkKeepLatest: number;
}

export const DEFAULT_PUBLISH_LIMITS: PublishLimits = {
  publishPerMin: 10,
  publishMaxFileBytes: 200 * 1024 * 1024,
  publishMaxTotalBytes: 5 * 1024 * 1024 * 1024,
  shotTtlMs: 48 * 60 * 60 * 1000,
  apkKeepLatest: 20,
};

/** 媒体直传通道限额（write_token 配对凭据；次数/字节率/单文件/总量/成品TTL/半成品TTL）。 */
export interface MediaLimits {
  /** 会话创建次数/分（只计 offset==0 的创建——分片追加不计数，防 100MB=200 次撞死次数帽） */
  mediaPerMin: number;
  /** 字节速率窗/分（分片按增量记账；物理速率 ~12MB/min，此值 ×4 余量防将来管道提速撞墙） */
  mediaBytesPerMin: number;
  /** 通道物理帽（策略帽 MEDIA_MAX_BYTES 在 core 单源——relay 只守通道上限） */
  mediaMaxFileBytes: number;
  mediaMaxTotalBytes: number;
  /** 成品 TTL */
  mediaTtlMs: number;
  /** .part 半成品 TTL（追加自动刷新 mtime → 实际语义 = 最后活动起算；勿"修"） */
  mediaPartTtlMs: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  mediaPerMin: 10,
  mediaBytesPerMin: 50 * 1024 * 1024,
  mediaMaxFileBytes: 200 * 1024 * 1024,
  mediaMaxTotalBytes: 2 * 1024 * 1024 * 1024,
  mediaTtlMs: 48 * 60 * 60 * 1000,
  mediaPartTtlMs: 24 * 60 * 60 * 1000,
};

export interface RelayOptions {
  store: Store;
  operatorKey: string;
  now?: () => number;
  tls?: { key: string | Buffer; cert: string | Buffer };
  limits?: Partial<RateLimits>;
  logger?: (msg: string) => void;
  /** 发布令牌（低权，独立于 operatorKey）；未配置则 /publish 与 /static 均不注册。 */
  publishToken?: string;
  /** static 根目录；启用发布通道时必传（main() 缺省 DB 同目录 static/）。 */
  staticDir?: string;
  publishLimits?: Partial<PublishLimits>;
  /** 媒体直传限额（staticDir 配置即启用 media 路由——与发布令牌无关）。 */
  mediaLimits?: Partial<MediaLimits>;
}

/** 固定窗口限流器，now() 注入可拨时钟。 */
class FixedWindow {
  private m = new Map<string, { start: number; n: number }>();
  private limit: number;
  private windowMs: number;
  private nowFn: () => number;
  constructor(limit: number, windowMs: number, nowFn: () => number) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.nowFn = nowFn;
  }
  allow(key: string, cost = 1): boolean {
    const t = this.nowFn();
    let e = this.m.get(key);
    if (!e || t - e.start >= this.windowMs) {
      e = { start: t, n: 0 };
      this.m.set(key, e);
    }
    if (e.n + cost > this.limit) return false;
    e.n += cost;
    return true;
  }
}

interface ActiveConn {
  ws: WebSocket;
  inflight: Set<number>;
}

export interface RelayServer {
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  port(): number;
}

type BodyResult = { ok: true; value: unknown } | { ok: false; reason: 'too_large' | 'bad_json' };

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function noContent(res: http.ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const t = h.slice(7).trim();
  return t.length > 0 && t.length <= 256 ? t : null;
}

/** 边读边掐：>128KB 立即 413 并断连。 */
function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        json(res, 413, { error: 'too_large' });
        res.socket?.destroy();
        resolve({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, reason: 'bad_json' });
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve({ ok: false, reason: 'bad_json' });
      }
    });
  });
}

// ---------- 静态发布通道（可选，PUBLISH_TOKEN 启用）----------
// 产物名只允许 shots/ 或 apk/ 前缀 + 白名单字符文件名；扩展名与 GET 一致。
// json 供 apk/feed-<deskPub 指纹>.json 版本清单（手机自动更新发现；清单无敏感载荷，扩展名纪律同等适用）
const STATIC_NAME_RE = /^(shots|apk)\/[A-Za-z0-9._-]{1,100}$/;
const STATIC_EXT_RE = /\.(png|jpe?g|apk|json)$/i;
const STATIC_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  apk: 'application/vnd.android.package-archive',
  json: 'application/json',
};

/** static 根目录用量（字节）。产物数量级为百文件，同步遍历可承受。 */
function dirUsageBytes(root: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.endsWith('.part')) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) total += dirUsageBytes(p);
    else {
      try {
        total += statSync(p).size;
      } catch {
        /* 并发删除容忍 */
      }
    }
  }
  return total;
}

/** 清理 shots/ 下超期文件，返回清理数。 */
function cleanExpiredShots(shotsDir: string, ttlMs: number, nowMs: number): number {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(shotsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = join(shotsDir, e.name);
    try {
      if (nowMs - statSync(p).mtimeMs > ttlMs) {
        unlinkSync(p);
        n++;
      }
    } catch {
      /* 单文件失败不阻塞 */
    }
  }
  return n;
}

/** apk/ 保留最近 keep 版（mtime 序，新→旧）+ feed 清单当前引用的包豁免；feed-*.json 与 .part 半成品不碰。返回清理数。 */
function cleanOldApks(apkDir: string, keep: number): number {
  let entries;
  try {
    entries = readdirSync(apkDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  // feed 清单引用的 apk 受保护（更新发现通道的当前真相，旧桌面指纹的清单同样算数）
  const protect = new Set<string>();
  for (const e of entries) {
    if (!e.isFile() || !/^feed-[A-Za-z0-9._-]+\.json$/.test(e.name)) continue;
    try {
      const feed = JSON.parse(readFileSync(join(apkDir, e.name), 'utf8')) as { apkUrl?: unknown };
      if (typeof feed.apkUrl === 'string') {
        const base = feed.apkUrl.split('/').pop() ?? '';
        if (/^app-[A-Za-z0-9._-]{1,90}\.apk$/.test(base)) protect.add(base);
      }
    } catch {
      /* 坏清单不阻塞清扫 */
    }
  }
  const apks: { name: string; mtimeMs: number }[] = [];
  for (const e of entries) {
    if (!e.isFile() || !/^app-[A-Za-z0-9._-]{1,90}\.apk$/.test(e.name)) continue;
    try {
      apks.push({ name: e.name, mtimeMs: statSync(join(apkDir, e.name)).mtimeMs });
    } catch {
      /* 并发删除容忍 */
    }
  }
  apks.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let n = 0;
  apks.forEach((a, i) => {
    if (i < keep || protect.has(a.name)) return;
    try {
      unlinkSync(join(apkDir, a.name));
      n++;
    } catch {
      /* 单文件失败不阻塞 */
    }
  });
  return n;
}

// ---------- 媒体直传通道（staticDir 配置即启用；write_token 配对凭据鉴权） ----------

/** 媒体密文文件名形：<32hex>.bin（不可猜名即读取凭据——128-bit 熵；密钥在 E2E offer 里） */
const MEDIA_FILE_RE = /^[0-9a-f]{32}\.bin$/;
const MEDIA_REL_RE = /^media\/[0-9a-f]{32}\.bin$/;

/** 清理 media/ 超期成品（ttlMs）与超期 .part 半成品（partTtlMs），返回清理数。
 *  .part 的 mtime 随追加自动刷新——TTL 实际从最后活动起算（慢传输天然免疫，勿"修"）。 */
function cleanExpiredMedia(mediaDir: string, ttlMs: number, partTtlMs: number, nowMs: number): number {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(mediaDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = join(mediaDir, e.name);
    try {
      const ttl = e.name.endsWith('.part') ? partTtlMs : ttlMs;
      if (nowMs - statSync(p).mtimeMs > ttl) {
        unlinkSync(p);
        n++;
      }
    } catch {
      /* 单文件失败不阻塞 */
    }
  }
  return n;
}

export function createRelayServer(opts: RelayOptions): RelayServer {
  const now = opts.now ?? (() => Date.now());
  const log = opts.logger ?? ((m: string) => console.error(`[relay] ${m}`));
  const L: RateLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const store = opts.store;
  const operatorKey = opts.operatorKey;

  // 静态家族路由：publishToken 未配置 → /publish 不注册（404 兜底）。
  // staticDir 独立驱动 GET /static 与 PUT /media（媒体密文直传走配对凭据鉴权，不依赖发布令牌）。
  const publishToken = opts.publishToken ?? null;
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : null;
  const PL: PublishLimits = { ...DEFAULT_PUBLISH_LIMITS, ...opts.publishLimits };
  const ML: MediaLimits = { ...DEFAULT_MEDIA_LIMITS, ...opts.mediaLimits };

  const limTokens = new FixedWindow(L.tokensPerMin, 60_000, now);
  const limStatus = new FixedWindow(L.statusPerMin, 60_000, now);
  const limRedeem = new FixedWindow(L.redeemPerMin, 60_000, now);
  const limWsAuthFail = new FixedWindow(L.wsAuthFailPerMin, 60_000, now);
  const limBoxBytes = new FixedWindow(L.boxBytesPerMin, 60_000, now);
  const limBoxMsgs = new FixedWindow(L.boxMsgsPerMin, 60_000, now);
  const limPresence = new FixedWindow(L.presencePerMin, 60_000, now);
  const limPublish = new FixedWindow(PL.publishPerMin, 60_000, now);
  const limMediaCount = new FixedWindow(ML.mediaPerMin, 60_000, now);
  const limMediaBytes = new FixedWindow(ML.mediaBytesPerMin, 60_000, now);

  const boxConns = new Map<string, ActiveConn>();

  const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const ip = req.socket.remoteAddress ?? '?';

      if (method === 'GET' && path === '/health') return json(res, 200, { ok: true });

      // ---- POST /pair/tokens（运营者密钥）----
      if (method === 'POST' && path === '/pair/tokens') {
        if (bearer(req) !== operatorKey) return json(res, 401, { error: 'unauthorized' });
        if (!limTokens.allow(ip)) return json(res, 429, { error: 'rate_limited' });
        const t = issueToken(store, now);
        return json(res, 200, t);
      }

      // ---- GET /pair/status（Bearer 配对令牌）----
      if (method === 'GET' && path === '/pair/status') {
        const token = bearer(req);
        if (!token) return json(res, 401, { error: 'unauthorized' });
        if (!limStatus.allow(ip)) return json(res, 429, { error: 'rate_limited' });
        const r = pairStatus(store, token, now);
        if (r.code === 401) return json(res, 401, { error: 'unauthorized' });
        if (r.state === 'redeemed') {
          return json(res, 200, { state: 'redeemed', phonePub: r.phonePub, device: r.device });
        }
        return json(res, 200, { state: r.state });
      }

      // ---- POST /pair/redeem（Bearer 配对令牌）----
      if (method === 'POST' && path === '/pair/redeem') {
        const token = bearer(req);
        if (!token) return json(res, 401, { error: 'unauthorized' });
        if (!limRedeem.allow(ip)) return json(res, 429, { error: 'rate_limited' });
        const body = await readJsonBody(req, res);
        if (!body.ok) {
          if (body.reason === 'bad_json') return json(res, 400, { error: 'bad_request' });
          return; // too_large 已响应
        }
        const parsed = parseRedeemBody(body.value);
        if (!parsed) return json(res, 400, { error: 'bad_request' });
        const r = redeem(store, token, parsed, now, log);
        switch (r.code) {
          case 200:
            return json(res, 200, { ok: true, replay: r.replay });
          case 400:
            return json(res, 400, { error: 'bad_request' });
          case 401:
            return json(res, 401, { error: 'unauthorized' });
          case 409:
            return json(res, 409, { error: 'token_conflict' }); // 裸 body，不含登记信息
          case 410:
            return json(res, 410, { error: 'gone' });
        }
      }

      // ---- PUT /publish（Bearer 发布令牌——独立低权凭据，与 operatorKey 分层）----
      if (publishToken && staticDir && method === 'PUT' && path === '/publish') {
        const token = bearer(req);
        const ok =
          token !== null &&
          token.length === publishToken.length &&
          timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(publishToken, 'utf8'));
        if (!ok) return json(res, 401, { error: 'unauthorized' });
        if (!limPublish.allow(ip)) return json(res, 429, { error: 'rate_limited' });
        const name = url.searchParams.get('name') ?? '';
        if (!STATIC_NAME_RE.test(name) || !STATIC_EXT_RE.test(name)) {
          return json(res, 400, { error: 'bad_name' });
        }
        const dest = resolve(staticDir, name);
        if (!dest.startsWith(staticDir + sep)) return json(res, 400, { error: 'bad_name' });
        const declared = Number(req.headers['content-length'] ?? '0');
        if (declared > PL.publishMaxFileBytes) return json(res, 413, { error: 'too_large' });
        if (dirUsageBytes(staticDir) + declared > PL.publishMaxTotalBytes) {
          return json(res, 413, { error: 'quota_exceeded' });
        }
        mkdirSync(dirname(dest), { recursive: true });
        const tmp = dest + '.part';
        await new Promise<void>((resolveReq) => {
          let size = 0;
          let settled = false;
          let tmpNeedsCleanup = false;
          const out = createWriteStream(tmp);
          out.on('drain', () => {
            req.resume();
          });
          // Windows：句柄异步关闭时同步 unlink 可能 EBUSY，close 后兜底重试
          out.on('close', () => {
            if (tmpNeedsCleanup) {
              try {
                unlinkSync(tmp);
              } catch {
                /* 已清理或已被 rename */
              }
            }
          });
          out.on('error', () => {
            if (settled) return;
            settled = true;
            try {
              out.destroy();
              unlinkSync(tmp);
            } catch {
              /* ignore */
            }
            try {
              json(res, 500, { error: 'internal' });
            } catch {
              /* ignore */
            }
            resolveReq();
          });
          const failOver = (code: number, err: string) => {
            if (settled) return;
            settled = true;
            tmpNeedsCleanup = true;
            log(`publish aborted (${err})`); // 只记原因码，不记路径
            try {
              out.destroy();
              unlinkSync(tmp);
            } catch {
              /* ignore；close 兜底 */
            }
            try {
              json(res, code, { error: err });
            } catch {
              /* ignore */
            }
            res.socket?.destroy();
            resolveReq();
          };
          req.on('data', (c: Buffer) => {
            if (settled) return;
            size += c.length;
            if (size > PL.publishMaxFileBytes) {
              failOver(413, 'too_large');
              return;
            }
            if (!out.write(c)) req.pause();
          });
          req.on('end', () => {
            if (settled) return;
            out.end(() => {
              if (settled) return;
              settled = true;
              // 异步回调里的异常不受 requestHandler try/catch 保护——此处必须自兜，
              // 任何发布失败只能 500，绝不允许抛成 uncaughtException 杀死服务
              let renamed = false;
              try {
                renameSync(tmp, dest);
                renamed = true;
              } catch (err) {
                const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
                log(`publish finalize failed (${code})`); // 只记错误码，不记路径（防日志枚举）
                try {
                  unlinkSync(tmp);
                } catch {
                  /* ignore */
                }
              }
              if (!renamed) {
                json(res, 500, { error: 'internal' });
                resolveReq();
                return;
              }
              // 写后复核总量（防分块上传绕过事前声明检查）
              if (dirUsageBytes(staticDir) > PL.publishMaxTotalBytes) {
                try {
                  unlinkSync(dest);
                } catch {
                  /* ignore */
                }
                json(res, 413, { error: 'quota_exceeded' });
                resolveReq();
                return;
              }
              if (name.startsWith('shots/')) {
                const cleaned = cleanExpiredShots(join(staticDir, 'shots'), PL.shotTtlMs, now());
                if (cleaned > 0) log(`shots expired: ${cleaned}`);
              }
              // apk/ 新旧淘汰：每次发布落定后收敛到最近 N 版（积累只来自推送，发布点清理即完备）
              if (name.startsWith('apk/')) {
                const pruned = cleanOldApks(join(staticDir, 'apk'), PL.apkKeepLatest);
                if (pruned > 0) log(`apk pruned: ${pruned}`);
              }
              // 不记文件名（防日志枚举不可猜 URL），只记字节数
              log(`publish ok (${size}B)`);
              json(res, 201, { url: `/static/${name}` });
              resolveReq();
            });
          });
          req.on('error', () => failOver(400, 'bad_request'));
        });
        return;
      }

      // ---- PUT /media/<32hex>.bin（Bearer 信箱 write_token——配对令牌即凭据；媒体密文直传）----
      // 双语义（header 判别，v2）：无 Media-Offset = v1 整包（旧手机兼容，行为原样）；
      // 带 Media-Offset/Media-Total = 分片追加会话——会话即文件（.part 长度即真相，零会话表），
      // 文件长度崩溃安全，重启零恢复逻辑；.part 追加自动刷新 mtime → TTL 从最后活动起算。
      // E2E 密文直传（密钥随 E2E offer 走信箱）——relay 全程只见密文，盲性不变。
      if (staticDir && method === 'PUT' && path.startsWith('/media/')) {
        const filePart = path.slice('/media/'.length);
        if (!MEDIA_FILE_RE.test(filePart)) return json(res, 400, { error: 'bad_name' });
        const token = bearer(req);
        if (!token) return json(res, 401, { error: 'unauthorized' });
        // 撤销信箱 = 行已被 dropMailbox 删除 → 反查未命中即 401（不区分不存在/已撤销，防枚举）
        const mailbox = store.findBoxByWriteHash(tokenHash(token));
        if (!mailbox) return json(res, 401, { error: 'unauthorized' });
        const dev = mailbox.write_hash; // 按设备（令牌哈希）记账
        const mediaDir = join(staticDir, 'media');
        const name = `media/${filePart}`;
        const dest = resolve(staticDir, name);
        if (!dest.startsWith(staticDir + sep)) return json(res, 400, { error: 'bad_name' });

        // ---------- v2 分片追加会话 ----------
        const offRaw = req.headers['media-offset'];
        if (offRaw !== undefined) {
          const offset = Number(Array.isArray(offRaw) ? offRaw[0] : offRaw);
          const totRaw = req.headers['media-total'];
          const total = Number(Array.isArray(totRaw) ? totRaw[0] : totRaw);
          if (
            !Number.isInteger(offset) ||
            offset < 0 ||
            !Number.isInteger(total) ||
            total <= 0 ||
            total > ML.mediaMaxFileBytes
          ) {
            return json(res, 400, { error: 'bad_session' });
          }
          const creation = offset === 0;
          // 次数帽只计会话创建（分片追加不计数——100MB=200 次片不得撞死次数帽）
          if (creation && !limMediaCount.allow(dev)) return json(res, 429, { error: 'rate_limited' });
          const declared = Number(req.headers['content-length'] ?? '0');
          if (declared > 0 && !limMediaBytes.allow(dev, declared)) {
            return json(res, 429, { error: 'rate_limited' });
          }
          const part = dest + '.part';
          if (creation) {
            // 成品已存在（同名完整 .bin）→ 409（客户端换名重传）；.part 存在 = 显式重启（truncate）
            let done = false;
            try {
              statSync(dest);
              done = true;
            } catch {
              /* 无成品 */
            }
            if (done) return json(res, 409, { error: 'exists' });
            // 创建时按声明总量预检磁盘余量（防半途磁盘打满）
            if (dirUsageBytes(mediaDir) + total > ML.mediaMaxTotalBytes) {
              return json(res, 413, { error: 'quota_exceeded' });
            }
          } else {
            let cur: number;
            try {
              cur = statSync(part).size;
            } catch {
              return json(res, 409, { error: 'no_session', current: 0 });
            }
            // 偏移不匹配 → 409 + 服务端当前长度（客户端据此再同步续传；重复片自愈）
            if (cur !== offset) return json(res, 409, { error: 'offset_mismatch', current: cur });
          }
          mkdirSync(mediaDir, { recursive: true });
          const startLen = creation ? 0 : offset;
          await new Promise<void>((resolveReq) => {
            let size = startLen;
            let settled = false;
            let partNeedsCleanup = false;
            const out = createWriteStream(part, { flags: creation ? 'w' : 'a' });
            out.on('drain', () => {
              req.resume();
            });
            out.on('close', () => {
              if (partNeedsCleanup) {
                try {
                  unlinkSync(part);
                } catch {
                  /* 已清理或已被 rename */
                }
              }
            });
            out.on('error', () => {
              if (settled) return;
              settled = true;
              try {
                out.destroy();
              } catch {
                /* ignore */
              }
              log('media aborted (write_error)'); // 只记原因码，不记路径
              try {
                json(res, 500, { error: 'internal' });
              } catch {
                /* ignore */
              }
              resolveReq();
            });
            const failOver = (code: number, err: string) => {
              if (settled) return;
              settled = true;
              partNeedsCleanup = true;
              log(`media aborted (${err})`); // 只记原因码，不记路径
              try {
                out.destroy();
                unlinkSync(part);
              } catch {
                /* ignore；close 兜底 */
              }
              try {
                json(res, code, { error: err });
              } catch {
                /* ignore */
              }
              res.socket?.destroy();
              resolveReq();
            };
            req.on('data', (c: Buffer) => {
              if (settled) return;
              size += c.length;
              // 流中硬闸：会话累计超声明总量 = 客户端 bug/谎报——断连清场（会话作废，客户端重启）
              if (size > total) {
                failOver(413, 'too_large');
                return;
              }
              if (!out.write(c)) req.pause();
            });
            req.on('end', () => {
              if (settled) return;
              out.end(() => {
                if (settled) return;
                settled = true;
                // 完成判定：达到声明总量 → rename 先于应答（客户端收到 201 即成品就位）
                if (size >= total) {
                  let renamed = false;
                  try {
                    renameSync(part, dest);
                    renamed = true;
                  } catch (err) {
                    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
                    log(`media finalize failed (${code})`); // 只记错误码，不记路径
                    try {
                      unlinkSync(part);
                    } catch {
                      /* ignore */
                    }
                  }
                  if (!renamed) {
                    json(res, 500, { error: 'internal' });
                    resolveReq();
                    return;
                  }
                  // 事后补记增量（诚实分片带准确 content-length，delta 恒 0；chunked/谎报在此收敛）
                  const delta = size - startLen - declared;
                  if (delta > 0 && !limMediaBytes.allow(dev, delta)) {
                    try {
                      unlinkSync(dest);
                    } catch {
                      /* ignore */
                    }
                    json(res, 429, { error: 'rate_limited' });
                    resolveReq();
                    return;
                  }
                  if (dirUsageBytes(mediaDir) > ML.mediaMaxTotalBytes) {
                    try {
                      unlinkSync(dest);
                    } catch {
                      /* ignore */
                    }
                    json(res, 413, { error: 'quota_exceeded' });
                    resolveReq();
                    return;
                  }
                  const cleaned = cleanExpiredMedia(mediaDir, ML.mediaTtlMs, ML.mediaPartTtlMs, now());
                  if (cleaned > 0) log(`media expired: ${cleaned}`);
                  log(`media ok (${size}B)`); // 不记文件名（防日志枚举不可猜 URL）
                  json(res, 201, { url: `/static/${name}`, complete: true });
                  resolveReq();
                  return;
                }
                // 未完：返回当前偏移（客户端续传基准）
                json(res, 201, { current: size });
                resolveReq();
              });
            });
            req.on('error', () => failOver(400, 'bad_request'));
          });
          return;
        }

        // ---------- v1 整包（无 Media-Offset 头——旧手机兼容，行为与 v1 完全一致） ----------
        if (!limMediaCount.allow(dev)) return json(res, 429, { error: 'rate_limited' });
        const declared = Number(req.headers['content-length'] ?? '0');
        if (declared > ML.mediaMaxFileBytes) return json(res, 413, { error: 'too_large' });
        if (declared > 0 && !limMediaBytes.allow(dev, declared)) {
          return json(res, 429, { error: 'rate_limited' });
        }
        if (dirUsageBytes(mediaDir) + declared > ML.mediaMaxTotalBytes) {
          return json(res, 413, { error: 'quota_exceeded' });
        }
        mkdirSync(mediaDir, { recursive: true });
        const tmp = dest + '.part';
        await new Promise<void>((resolveReq) => {
          let size = 0;
          let settled = false;
          let tmpNeedsCleanup = false;
          const out = createWriteStream(tmp);
          out.on('drain', () => {
            req.resume();
          });
          // Windows：句柄异步关闭时同步 unlink 可能 EBUSY，close 后兜底
          out.on('close', () => {
            if (tmpNeedsCleanup) {
              try {
                unlinkSync(tmp);
              } catch {
                /* 已清理或已被 rename */
              }
            }
          });
          out.on('error', () => {
            if (settled) return;
            settled = true;
            try {
              out.destroy();
              unlinkSync(tmp);
            } catch {
              /* ignore */
            }
            try {
              json(res, 500, { error: 'internal' });
            } catch {
              /* ignore */
            }
            resolveReq();
          });
          const failOver = (code: number, err: string) => {
            if (settled) return;
            settled = true;
            tmpNeedsCleanup = true;
            log(`media aborted (${err})`); // 只记原因码，不记路径
            try {
              out.destroy();
              unlinkSync(tmp);
            } catch {
              /* ignore；close 兜底 */
            }
            try {
              json(res, code, { error: err });
            } catch {
              /* ignore */
            }
            res.socket?.destroy();
            resolveReq();
          };
          req.on('data', (c: Buffer) => {
            if (settled) return;
            size += c.length;
            // 流中硬闸（content-length 可谎报/缺省——chunked 时 declared=0）
            if (size > ML.mediaMaxFileBytes) {
              failOver(413, 'too_large');
              return;
            }
            if (!out.write(c)) req.pause();
          });
          req.on('end', () => {
            if (settled) return;
            out.end(() => {
              if (settled) return;
              settled = true;
              // 异步回调里的异常不受 requestHandler try/catch 保护——必须自兜（同 /publish 先例）
              let renamed = false;
              try {
                renameSync(tmp, dest);
                renamed = true;
              } catch (err) {
                const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
                log(`media finalize failed (${code})`); // 只记错误码，不记路径（防日志枚举）
                try {
                  unlinkSync(tmp);
                } catch {
                  /* ignore */
                }
              }
              if (!renamed) {
                json(res, 500, { error: 'internal' });
                resolveReq();
                return;
              }
              // 事后补记速率窗：只补声明未覆盖的增量（chunked declared=0 全额补记；谎报小额补差额）
              // ——声明预检已计过账的部分不重复计费，诚实客户端不会被误判超额（实测教训）
              const delta = size - declared;
              if (delta > 0 && !limMediaBytes.allow(dev, delta)) {
                try {
                  unlinkSync(dest);
                } catch {
                  /* ignore */
                }
                json(res, 429, { error: 'rate_limited' });
                resolveReq();
                return;
              }
              // 写后复核总量（防分块绕过事前声明检查）
              if (dirUsageBytes(mediaDir) > ML.mediaMaxTotalBytes) {
                try {
                  unlinkSync(dest);
                } catch {
                  /* ignore */
                }
                json(res, 413, { error: 'quota_exceeded' });
                resolveReq();
                return;
              }
              const cleaned = cleanExpiredMedia(mediaDir, ML.mediaTtlMs, ML.mediaPartTtlMs, now());
              if (cleaned > 0) log(`media expired: ${cleaned}`);
              log(`media ok (${size}B)`); // 不记文件名（防日志枚举不可猜 URL）
              json(res, 201, { url: `/static/${name}` });
              resolveReq();
            });
          });
          req.on('error', () => failOver(400, 'bad_request'));
        });
        return;
      }

      // ---- GET /static/*（只读产物；不可猜文件名即访问凭据；成功不记日志）----
      if (staticDir && method === 'GET' && path.startsWith('/static/')) {
        let rel: string;
        try {
          rel = decodeURIComponent(path.slice('/static/'.length));
        } catch {
          return json(res, 404, { error: 'not_found' });
        }
        // media/ 密文走独立名形（.bin 不在 STATIC_EXT_RE——密文无扩展名语义）
        const isMedia = rel.startsWith('media/');
        if (isMedia ? !MEDIA_REL_RE.test(rel) : !STATIC_NAME_RE.test(rel) || !STATIC_EXT_RE.test(rel)) {
          return json(res, 404, { error: 'not_found' });
        }
        const dest = resolve(staticDir, rel);
        if (!dest.startsWith(staticDir + sep)) return json(res, 404, { error: 'not_found' });
        let st;
        try {
          st = statSync(dest);
        } catch {
          return json(res, 404, { error: 'not_found' });
        }
        if (!st.isFile()) return json(res, 404, { error: 'not_found' });
        const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
        // Range 支持（v2 桌面分片拉取——单区间 bytes=a-b → 206 切片流；畸形头忽略回退 200 全量）
        if (isMedia) {
          const rngRaw = req.headers['range'];
          const rng = Array.isArray(rngRaw) ? rngRaw[0] : rngRaw;
          const m = /^bytes=(\d+)-(\d*)$/.exec(String(rng ?? ''));
          if (m) {
            const start = Number(m[1]);
            const end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
            if (start >= st.size || start > end) return json(res, 416, { error: 'range_not_satisfiable' });
            res.writeHead(206, {
              'content-type': 'application/octet-stream',
              'content-length': end - start + 1,
              'content-range': `bytes ${start}-${end}/${st.size}`,
              'x-content-type-options': 'nosniff',
              'cache-control': 'no-store',
            });
            createReadStream(dest, { start, end }).pipe(res);
            return;
          }
        }
        res.writeHead(200, {
          'content-type': isMedia ? 'application/octet-stream' : STATIC_TYPES[ext] ?? 'application/octet-stream',
          'content-length': st.size,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        createReadStream(dest).pipe(res);
        return;
      }

      // ---- GET /box/:mailboxId/presence?peer=<对端信箱>（read_token；探活直答，M2.2）----
      // 存在性证据 = 对端信箱的活跃 WS 读连接（租约持有者在岗即在线——等待态壳停传输，
      // 无 WS 不被作答=语义正确）。零桌面流量、不占信箱字节预算、additive（旧端永不调用）。
      // 不区分信箱不存在/令牌错误（防枚举，同 /box 族惯例）；独立小额频控按请求方信箱计。
      const pm = /^\/box\/([0-9a-f]{32})\/presence$/.exec(path);
      if (pm && method === 'GET') {
        const box = pm[1]!;
        const mailbox = store.getMailbox(box);
        const token = bearer(req);
        if (!mailbox || !token || tokenHash(token) !== mailbox.read_hash) {
          return json(res, 401, { error: 'unauthorized' });
        }
        if (!limPresence.allow(box)) return json(res, 429, { error: 'rate_limited' });
        const peer = url.searchParams.get('peer') ?? '';
        if (!/^[0-9a-f]{32}$/.test(peer)) return json(res, 400, { error: 'bad_request' });
        const conn = boxConns.get(peer);
        return json(res, 200, { online: conn !== undefined && conn.ws.readyState === WebSocket.OPEN });
      }

      // ---- /box/:mailboxId 族 ----
      const m = /^\/box\/([0-9a-f]{32})(\/ack)?$/.exec(path);
      if (m) {
        const box = m[1]!;
        const isAck = m[2] === '/ack';
        const mailbox = store.getMailbox(box);
        const token = bearer(req);
        // 不区分信箱不存在 / 令牌错误（防枚举）
        if (!mailbox || !token) return json(res, 401, { error: 'unauthorized' });
        const th = tokenHash(token);
        const match = (h: string) => th === h;

        if (method === 'POST' && !isAck) {
          // 投递：write_token
          if (!match(mailbox.write_hash)) {
            return match(mailbox.read_hash) || match(mailbox.revoke_hash)
              ? json(res, 403, { error: 'forbidden' })
              : json(res, 401, { error: 'unauthorized' });
          }
          const body = await readJsonBody(req, res);
          if (!body.ok) {
            if (body.reason === 'bad_json') return json(res, 400, { error: 'bad_request' });
            return;
          }
          const blob = (body.value as Record<string, unknown>)?.['blob'];
          if (typeof blob !== 'string' || !isB64u(blob)) {
            return json(res, 400, { error: 'bad_request' });
          }
          if (blob.length > MAX_WIRE_BYTES) return json(res, 413, { error: 'too_large' });
          if (!limBoxBytes.allow(box, blob.length) || !limBoxMsgs.allow(box)) {
            return json(res, 429, { error: 'rate_limited' });
          }
          if (store.boxBytes(box) + blob.length > 5 * 1024 * 1024) {
            return json(res, 429, { error: 'quota_exceeded' });
          }
          const id = store.insertMessage(box, blob);
          // 直推：先查 in-flight 去重（补投可能正在发同一条）
          const conn = boxConns.get(box);
          if (conn && conn.ws.readyState === WebSocket.OPEN && !conn.inflight.has(id)) {
            conn.inflight.add(id);
            conn.ws.send(JSON.stringify({ id, blob }));
          }
          return json(res, 201, { id });
        }

        if (method === 'POST' && isAck) {
          // ACK：read_token；幂等 204
          if (!match(mailbox.read_hash)) {
            return match(mailbox.write_hash) || match(mailbox.revoke_hash)
              ? json(res, 403, { error: 'forbidden' })
              : json(res, 401, { error: 'unauthorized' });
          }
          const body = await readJsonBody(req, res);
          if (!body.ok) {
            if (body.reason === 'bad_json') return json(res, 400, { error: 'bad_request' });
            return;
          }
          const id = (body.value as Record<string, unknown>)?.['id'];
          if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
            return json(res, 400, { error: 'bad_request' });
          }
          store.ackMessage(box, id); // DELETE WHERE box AND id，跨信箱/未知 id 同样 204
          store.markRead(box);
          return noContent(res);
        }

        if (method === 'DELETE' && !isAck) {
          // 注销信箱：revoke_token（设备撤销，任一端可注销对向）
          if (!match(mailbox.revoke_hash)) {
            return match(mailbox.write_hash) || match(mailbox.read_hash)
              ? json(res, 403, { error: 'forbidden' })
              : json(res, 401, { error: 'unauthorized' });
          }
          store.dropMailbox(box);
          const conn = boxConns.get(box);
          if (conn) {
            boxConns.delete(box);
            try {
              conn.ws.close(4001, 'revoked');
            } catch {
              /* ignore */
            }
          }
          log(`mailbox revoked: ${box}`);
          return noContent(res);
        }

        return json(res, 404, { error: 'not_found' });
      }

      return json(res, 404, { error: 'not_found' });
    } catch (err) {
      log(`handler error: ${String(err)}`);
      try {
        if (!res.headersSent) return json(res, 500, { error: 'internal' });
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
  };

  const httpServer = opts.tls
    ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, requestHandler)
    : http.createServer(requestHandler);

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });

  // ---- WS /box/:mailboxId（Bearer read_token）----
  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      const m = /^\/box\/([0-9a-f]{32})$/.exec(url.pathname);
      const ip = req.socket.remoteAddress ?? '?';
      const fail = (code: number) => {
        socket.write(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Too Many Requests'}\r\n\r\n`);
        socket.destroy();
      };
      if (!m) return fail(401);
      const box = m[1]!;
      const mailbox = store.getMailbox(box);
      const token = bearer(req);
      if (!mailbox || !token || tokenHash(token) !== mailbox.read_hash) {
        // 限未鉴权握手每 IP；已鉴权长连不按 IP 计数
        if (!limWsAuthFail.allow(ip)) return fail(429);
        return fail(401);
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        onWsAuthed(ws, box);
      });
    } catch (err) {
      log(`upgrade error: ${String(err)}`);
      socket.destroy();
    }
  });

  function onWsAuthed(ws: WebSocket, box: string): void {
    // 单活跃读者：踢旧
    const old = boxConns.get(box);
    if (old) {
      try {
        old.ws.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    // 定死顺序：先注册连接 → 同步块查未 ACK 记入 in-flight → 之后直推查重
    const conn: ActiveConn = { ws, inflight: new Set() };
    boxConns.set(box, conn);
    const pending = store.pendingMessages(box);
    for (const msg of pending) {
      // 死信上限（M7增量3·决策32）：同一消息投递 ≥ DEAD_LETTER_ATTEMPTS 次仍无 ACK
      //（毒消息/死端循环重投）→ 移入 dead_messages 不再投递，log 可查
      const attempts = store.bumpDeliverAttempt(box, msg.id);
      if (attempts > DEAD_LETTER_ATTEMPTS) {
        store.deadLetter(box, msg.id);
        log(`dead-letter box=${box.slice(0, 8)}… id=${msg.id} attempts=${attempts}（≥${DEAD_LETTER_ATTEMPTS} 次未 ACK，停止重投）`);
        continue;
      }
      conn.inflight.add(msg.id);
      ws.send(JSON.stringify({ id: msg.id, blob: msg.blob }));
    }
    store.markRead(box);
    (ws as { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as { isAlive?: boolean }).isAlive = true;
    });
    ws.on('message', () => {
      /* 服务器→客户端单向；客户端帧一律忽略 */
    });
    ws.on('error', (err) => log(`ws error box=${box}: ${String(err)}`));
    ws.on('close', () => {
      if (boxConns.get(box) === conn) boxConns.delete(box);
      // in-flight 随连接丢弃；未 ACK 消息仍在表内，下次连接必重投
    });
  }

  // 心跳：30s ping，踢死连接（防额度泄漏）
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        w.terminate();
        continue;
      }
      w.isAlive = false;
      try {
        w.ping();
      } catch {
        /* ignore */
      }
    }
  }, L.heartbeatMs);
  heartbeat.unref();

  // 定时清扫：messages TTL / pair_tokens 行保留 / 孤儿信箱 GC / media 密文 TTL
  const sweeper = setInterval(() => {
    try {
      store.sweepMessages(now());
      store.sweepTokens(now());
      for (const box of store.gcMailboxes(now())) {
        const conn = boxConns.get(box);
        if (conn) {
          boxConns.delete(box);
          try {
            conn.ws.close(4001, 'gc');
          } catch {
            /* ignore */
          }
        }
        log(`mailbox gc'd (orphan): ${box}`);
      }
      if (staticDir) {
        const cleaned = cleanExpiredMedia(join(staticDir, 'media'), ML.mediaTtlMs, ML.mediaPartTtlMs, now());
        if (cleaned > 0) log(`media expired: ${cleaned}`);
      }
    } catch (err) {
      log(`sweep error: ${String(err)}`);
    }
  }, L.sweepIntervalMs);
  sweeper.unref();

  return {
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          const addr = httpServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        clearInterval(heartbeat);
        clearInterval(sweeper);
        for (const ws of wss.clients) {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        }
        wss.close();
        httpServer.close(() => resolve());
        // closeAllConnections 兜底：避免 keep-alive 挂住
        httpServer.closeAllConnections?.();
      });
    },
    port() {
      const addr = httpServer.address();
      return typeof addr === 'object' && addr ? addr.port : 0;
    },
  };
}

// ---------- CLI 入口 ----------
/** 从环境变量装配并启动服务（bin 入口 dist/src/cli.js 经 import 调用；直跑本文件同样生效） */
export function main(): void {
  const operatorKey = process.env['OPERATOR_KEY'];
  if (!operatorKey) {
    console.error('OPERATOR_KEY env required (openssl rand 32 | base64)');
    process.exit(1);
  }
  const port = Number(process.env['PORT'] ?? 8443);
  const dbPath = process.env['DB_PATH'] ?? 'relay.db';
  const tlsKeyPath = process.env['TLS_KEY_PATH'];
  const tlsCertPath = process.env['TLS_CERT_PATH'];
  const tls =
    tlsKeyPath && tlsCertPath
      ? { key: readFileSync(tlsKeyPath), cert: readFileSync(tlsCertPath) }
      : undefined;
  // 静态家族（可选）：PUBLISH_TOKEN 门 /publish；STATIC_DIR（或发布令牌）驱动 /static 读取与 /media 直传
  const publishToken = process.env['PUBLISH_TOKEN'];
  const staticDir = resolve(dirname(dbPath), 'static');
  const store = new Store(dbPath);
  const server = createRelayServer({
    store,
    operatorKey,
    ...(tls ? { tls } : {}),
    ...(publishToken || process.env['STATIC_DIR']
      ? {
          ...(publishToken ? { publishToken } : {}),
          staticDir: process.env['STATIC_DIR'] ?? staticDir,
        }
      : {}),
  });
  process.on('uncaughtException', (err) => {
    console.error('[relay] uncaughtException, exit for systemd restart:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[relay] unhandledRejection, exit for systemd restart:', err);
    process.exit(1);
  });
  void server.listen(port).then((p) => {
    console.log(`[relay] listening :${p} (${tls ? 'wss' : 'ws'}), db=${dbPath}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
