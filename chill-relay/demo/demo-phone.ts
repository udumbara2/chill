/**
 * demo-phone.ts — 命令行"手机"端 demo。
 *
 * 协议义务实现：
 * - redeem 首次发出前，密钥对+token 先持久化到 demo/.state/phone.json（重启恢复原对续传，严禁重新生成）
 * - 409 → 全屏错误"配对令牌已被使用，可能泄露，勿重试"（exit 2）
 * - 410 → 停止重试（exit 3）
 * - redeem 后 --confirm-timeout（默认 10 分钟）未收合法 pair.confirm → revoke_token 自注销双信箱（exit 4）
 * - confirm 前只处理 pair.*（chat 本地排队，confirm 后 flush）
 * - 解密/MAC 失败 fail-closed 报警，禁止静默重试
 *
 * 用法：
 *   node demo-phone.ts [--qr-file demo/qr.json] [--name 测试手机] [--ca tests/fixtures/ca.crt]
 *                      [--say "文本"] [--no-reply] [--once] [--reset]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { sha256 } from '@noble/hashes/sha256';
import {
  generateKeyPair,
  keyPairFromSecretKey,
  ecdhShared,
  deriveSecrets,
  tokenHash,
  mailboxIdFromPub,
  pairingMAC,
  encryptEnvelope,
  decryptEnvelope,
  makeEnvelope,
  isTsFresh,
  truncateToBudget,
  DedupeSet,
  b64uDecode,
  b64uEncode,
  KNOWN_TYPES,
  type Envelope,
} from '../src/shared/envelope.js';
import { httpJson, connectBox, httpBase, loadCa, sleep, type BoxMsg, type TlsOpt } from './client-util.js';

interface PhoneState {
  secretKey: string;
  publicKey: string;
  token: string;
  deskPub: string;
  relay: string;
  name: string;
  confirmed: boolean;
  helloSent: boolean;
}

interface QrPayload {
  v: number;
  relay: string;
  deskPub: string;
  caFP: string;
  token: string;
  name: string;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

const STATE_PATH = 'demo/.state/phone.json';

function saveState(s: PhoneState): void {
  mkdirSync('demo/.state', { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function loadState(): PhoneState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as PhoneState;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (has(argv, '--reset')) {
    rmSync(STATE_PATH, { force: true });
    console.log('[phone] 本地状态已清除');
    return;
  }
  const qrFile = arg(argv, '--qr-file') ?? 'demo/qr.json';
  const name = arg(argv, '--name') ?? '测试手机';
  const caPath = arg(argv, '--ca');
  const tls: TlsOpt = loadCa(caPath);
  const say = arg(argv, '--say');
  const noReply = has(argv, '--no-reply');
  const once = has(argv, '--once');
  const confirmTimeout = Number(arg(argv, '--confirm-timeout') ?? 10 * 60 * 1000);

  const qr = JSON.parse(readFileSync(qrFile, 'utf8')) as QrPayload;
  const relay = qr.relay;
  const base = httpBase(relay);

  // caFP 核对（QR 为信任锚）：提供 CA 时指纹必须一致
  if (qr.caFP && tls.ca) {
    const fp = b64uEncode(sha256(tls.ca));
    if (fp !== qr.caFP) {
      console.error('[phone] ❌ caFP 与 QR 不符，可能是伪造中继，中止');
      process.exit(5);
    }
  }

  // ---- 恢复或新建密钥对；redeem 发出前必须先持久化 ----
  let state = loadState();
  if (!state || state.token !== qr.token) {
    const kp = generateKeyPair();
    state = {
      secretKey: kp.secretKey,
      publicKey: kp.publicKey,
      token: qr.token,
      deskPub: qr.deskPub,
      relay,
      name,
      confirmed: false,
      helloSent: false,
    };
    saveState(state); // 先持久化，再 redeem
    console.log('[phone] 密钥对已生成并持久化（重启将恢复同一对续传）');
  } else {
    const kp = keyPairFromSecretKey(state.secretKey);
    state.publicKey = kp.publicKey; // 防御性校正
    console.log('[phone] 恢复已持久化的密钥对与配对状态');
  }

  const shared = ecdhShared(state.secretKey, state.deskPub);
  const secrets = deriveSecrets(shared);
  const myBox = mailboxIdFromPub(state.publicKey);
  const deskBox = mailboxIdFromPub(state.deskPub);
  const mac = pairingMAC(state.token, state.deskPub, state.publicKey);

  // ---- redeem（幂等；网络错误用同一持久化密钥对重试）----
  const redeemBody = {
    phonePub: state.publicKey,
    deskPub: state.deskPub,
    device: state.name,
    writeHash: tokenHash(secrets.writeToken),
    readHash: tokenHash(secrets.readToken),
    revokeHash: tokenHash(secrets.revokeToken),
  };
  let redeemed = false;
  for (let attempt = 1; attempt <= 5 && !redeemed; attempt++) {
    let r;
    try {
      r = await httpJson('POST', `${base}/pair/redeem`, { token: state.token, body: redeemBody, ...tls });
    } catch (err) {
      console.log(`[phone] redeem 网络错误（第 ${attempt} 次，同一密钥对续传）: ${String(err)}`);
      await sleep(2000);
      continue;
    }
    if (r.status === 200) {
      redeemed = true;
      break;
    }
    if (r.status === 409) {
      console.error('╔══════════════════════════════════════════════╗');
      console.error('║  ❌ 配对令牌已被使用，可能泄露，勿重试        ║');
      console.error('║  请在桌面 /pair list 审计设备并 revoke 后重配 ║');
      console.error('╚══════════════════════════════════════════════╝');
      process.exit(2);
    }
    if (r.status === 410) {
      console.error('[phone] 配对令牌已过期，停止重试。请在桌面重新出码。');
      process.exit(3);
    }
    console.error(`[phone] redeem 失败: HTTP ${r.status} ${JSON.stringify(r.json)}`);
    process.exit(1);
  }
  if (!redeemed) {
    console.error('[phone] redeem 多次网络失败，已保留密钥对，可重跑续传');
    process.exit(1);
  }
  console.log('[phone] redeem 成功（幂等安全）');

  // ---- 向桌面信箱投 pair.hello（含 pairingMAC）；只发一次，重启不重发 ----
  if (!state.helloSent) {
    const hello = makeEnvelope('pair.hello', myBox, deskBox, { device: state.name, mac });
    const helloWire = encryptEnvelope(secrets.keyM2D, deskBox, 'm2d', hello);
    if (!helloWire) throw new Error('hello 超预算');
    const hr = await httpJson('POST', `${base}/box/${deskBox}`, {
      token: secrets.writeToken,
      body: { blob: helloWire },
      ...tls,
    });
    if (hr.status !== 201) {
      console.error(`[phone] hello 投递失败: HTTP ${hr.status}`);
      process.exit(1);
    }
    state.helloSent = true;
    saveState(state);
    console.log(`[phone] pair.hello 已投递（msg id=${(hr.json as { id: number }).id}）`);
  }

  // ---- 读信箱：等 pair.confirm（唯一信任锚 = pairingMAC 互验）----
  const dedupe = new DedupeSet();
  const queuedChat: Envelope[] = [];
  let confirmed = state.confirmed;
  let confirmResolve!: (ok: boolean) => void;
  const confirmedP = new Promise<boolean>((r) => (confirmResolve = r));
  let replyResolve: ((text: string) => void) | null = null;
  const onceMsgs: string[] = [];

  const ws = connectBox(
    relay,
    myBox,
    secrets.readToken,
    tls,
    (msg: BoxMsg) => {
      const dec = decryptEnvelope(secrets.keyD2M, myBox, 'd2m', msg.blob);
      if (!dec.ok) {
        console.error(`[phone] ❌ 信封解密/AAD 校验失败（msg id=${msg.id}），fail-closed 不 ACK`);
        return;
      }
      const env = dec.envelope;
      if (env.from !== deskBox || env.to !== myBox) {
        console.error(`[phone] ❌ from/to 与预期对端不符，丢弃并告警（from=${env.from}）`);
        return;
      }
      if (!isTsFresh(env.ts)) {
        console.error(`[phone] ❌ ts 偏离 ±5min，丢弃（id=${env.id}）`);
        return;
      }
      if (!dedupe.mark(env.id)) return; // 重复投递去重
      if (!KNOWN_TYPES.has(env.type)) return; // 未识别 type 一律丢弃

      if (env.type === 'pair.confirm') {
        if (env.body['mac'] !== mac) {
          console.error('[phone] ❌ pair.confirm MAC 校验失败，fail-closed，不进入配对完成态');
          return;
        }
        confirmed = true;
        if (state) {
          state.confirmed = true;
          saveState(state);
        }
        console.log(`[phone] ✅ pair.confirm 验讫，与「${qr.name}」配对完成`);
        for (const c of queuedChat.splice(0)) console.log(`[phone] (补收排队消息) ${String(c.body['text'] ?? '')}`);
        void ack(msg.id);
        confirmResolve(true);
        return;
      }
      if (!confirmed) {
        // confirm 前只处理 pair.*；chat 本地排队
        queuedChat.push(env);
        return;
      }
      if (env.type === 'chat.event') {
        const text = String(env.body['text'] ?? '');
        console.log(`[桌面] ${text}${env.body['truncated'] ? '（已截断，完整内容请在桌面查看）' : ''}`);
        void ack(msg.id);
        if (replyResolve) replyResolve(text);
        else if (once) onceMsgs.push(text);
        return;
      }
      void ack(msg.id);
    },
    () => console.log('[phone] WS 断开'),
  );

  function ack(id: number): Promise<void> {
    return httpJson('POST', `${base}/box/${myBox}/ack`, {
      token: secrets.readToken,
      body: { id },
      ...tls,
    }).then(() => undefined);
  }

  await new Promise<void>((r) => ws.on('open', () => r()));

  if (!confirmed) {
    const ok = await Promise.race([confirmedP, sleep(confirmTimeout).then(() => false)]);
    if (!ok) {
      // 孤儿信箱自保：revoke 双信箱
      console.error('[phone] 对端未确认配对，revoke 双信箱自注销');
      await httpJson('DELETE', `${base}/box/${deskBox}`, { token: secrets.revokeToken, ...tls });
      await httpJson('DELETE', `${base}/box/${myBox}`, { token: secrets.revokeToken, ...tls });
      process.exit(4);
    }
  } else {
    console.log('[phone] 已恢复配对完成态');
  }

  // ---- 发送 helper ----
  async function sendChat(text: string): Promise<void> {
    const { text: t, truncated } = truncateToBudget(text);
    const env = makeEnvelope('chat.user', myBox, deskBox, { text: t, ...(truncated ? { truncated: true } : {}) });
    const wire = encryptEnvelope(secrets.keyM2D, deskBox, 'm2d', env);
    if (!wire) throw new Error('消息超线上字节上限');
    const r = await httpJson('POST', `${base}/box/${deskBox}`, {
      token: secrets.writeToken,
      body: { blob: wire },
      ...tls,
    });
    if (r.status !== 201) throw new Error(`投递失败 HTTP ${r.status}`);
  }

  if (once) {
    await sleep(Number(arg(argv, '--quiet-ms') ?? 1500));
    ws.close();
    if (onceMsgs.length === 0) console.log('[phone] （无离线留言）');
    process.exit(0);
  }

  if (say !== undefined) {
    await sendChat(say);
    console.log(`[phone] 已发送: ${say}`);
    if (!noReply) {
      const waitMs = Number(arg(argv, '--wait-ms') ?? 15000);
      const reply = await Promise.race([
        new Promise<string>((r) => (replyResolve = r)),
        sleep(waitMs).then(() => null),
      ]);
      if (reply === null) {
        console.log('[phone] （等待回复超时）');
        process.exit(6);
      }
    }
    ws.close();
    process.exit(0);
  }

  // 交互模式
  console.log('[phone] 进入聊天（输入行回车发送，Ctrl+C 退出）');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text) void sendChat(text).catch((e) => console.error(`[phone] 发送失败: ${String(e)}`));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[phone] fatal:', err);
    process.exit(1);
  });
}
