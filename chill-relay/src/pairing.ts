/**
 * pairing.ts — 配对三接口的纯逻辑：签发 / status / redeem（3 态幂等状态机）。
 * 状态机冻结见 src/shared/PROTOCOL-FROZEN.md；探测行为只记日志，无烧毁机制。
 *
 * 注：redeem 载荷除「手机公钥+设备名」外还含 deskPub 与三个令牌哈希——
 * write/read/revoke 令牌派生自双端 shared_secret，服务器无法自算，
 * 必须由消费方在唯一可建信箱的入口（redeem）登记其哈希。
 */
import nacl from 'tweetnacl';
import { b64uEncode, b64uDecode, isB64u, tokenHash, mailboxIdFromPub } from './shared/envelope.js';
import type { Store } from './store.js';

export const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 分钟过期
export const TOKEN_BYTES = 32; // 256bit ≥ 128bit

export interface IssuedToken {
  token: string; // base64url，只返回不落明文
  expires: number;
}

export function issueToken(store: Store, now: () => number): IssuedToken {
  const token = b64uEncode(nacl.randomBytes(TOKEN_BYTES));
  const expires = now() + TOKEN_TTL_MS;
  store.createToken(tokenHash(token), expires);
  return { token, expires };
}

export type StatusResult =
  | { code: 200; state: 'pending' }
  | { code: 200; state: 'expired' }
  | { code: 200; state: 'redeemed'; phonePub: string; device: string }
  | { code: 401 };

export function pairStatus(store: Store, token: string, now: () => number): StatusResult {
  const row = store.getToken(tokenHash(token));
  if (!row) return { code: 401 };
  if (row.used === 1) {
    return { code: 200, state: 'redeemed', phonePub: row.phone_pub!, device: row.device! };
  }
  if (row.expires <= now()) return { code: 200, state: 'expired' };
  return { code: 200, state: 'pending' };
}

export interface RedeemBody {
  phonePub: string;
  deskPub: string;
  device: string;
  writeHash: string;
  readHash: string;
  revokeHash: string;
}

export function parseRedeemBody(x: unknown): RedeemBody | null {
  if (typeof x !== 'object' || x === null) return null;
  const b = x as Record<string, unknown>;
  const okKey = (s: unknown) => typeof s === 'string' && isB64u(s) && b64uDecode(s).length === 32;
  const okHash = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
  const okDevice = (s: unknown) => typeof s === 'string' && s.length >= 1 && s.length <= 64;
  if (
    !okKey(b['phonePub']) ||
    !okKey(b['deskPub']) ||
    !okDevice(b['device']) ||
    !okHash(b['writeHash']) ||
    !okHash(b['readHash']) ||
    !okHash(b['revokeHash'])
  ) {
    return null;
  }
  return {
    phonePub: b['phonePub'] as string,
    deskPub: b['deskPub'] as string,
    device: b['device'] as string,
    writeHash: b['writeHash'] as string,
    readHash: b['readHash'] as string,
    revokeHash: b['revokeHash'] as string,
  };
}

export type RedeemResult =
  | { code: 200; replay: boolean; phoneBox: string; deskBox: string }
  | { code: 400 | 401 | 409 | 410 };

/**
 * redeem 状态机（单向单调 pending→redeemed|expired）：
 * 1. token 不存在 → 401（不计数、不区分）
 * 2. 已消费 + 同 phone_pub → 200 幂等重放（无条件优先，任何状态不拦截）
 * 3. 已消费 + 异 phone_pub → 409
 * 4. 未消费 + 已过期 → 410
 * 5. 未消费 + 有效 → 事务消费
 */
export function redeem(
  store: Store,
  token: string,
  body: RedeemBody,
  now: () => number,
  log: (msg: string) => void = () => {},
): RedeemResult {
  const hash = tokenHash(token);
  const row = store.getToken(hash);
  if (!row) {
    log(`redeem: unknown token probe (no state change)`);
    return { code: 401 };
  }
  if (row.used === 1) {
    if (row.phone_pub === body.phonePub) {
      // 幂等重放无条件优先——即使行已过期也回 200
      return {
        code: 200,
        replay: true,
        phoneBox: mailboxIdFromPub(body.phonePub),
        deskBox: mailboxIdFromPub(body.deskPub),
      };
    }
    log(`redeem: token_conflict (registered device=${row.device ?? '?'})`);
    return { code: 409 };
  }
  if (row.expires <= now()) return { code: 410 };
  const phoneBox = mailboxIdFromPub(body.phonePub);
  const deskBox = mailboxIdFromPub(body.deskPub);
  const ok = store.redeemTokenTransaction(hash, body.phonePub, body.device, [
    {
      box: phoneBox,
      writeHash: body.writeHash,
      readHash: body.readHash,
      revokeHash: body.revokeHash,
      device: body.device,
    },
    {
      box: deskBox,
      writeHash: body.writeHash,
      readHash: body.readHash,
      revokeHash: body.revokeHash,
      device: 'desktop',
    },
  ]);
  if (!ok) {
    // 并发下被另一请求抢先消费：按已消费重判（单进程 + 同步事务下实际不可达，留作防御）
    const again = store.getToken(hash);
    if (again && again.used === 1 && again.phone_pub === body.phonePub) {
      return { code: 200, replay: true, phoneBox, deskBox };
    }
    return { code: 409 };
  }
  return { code: 200, replay: false, phoneBox, deskBox };
}
