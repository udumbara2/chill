/**
 * demo-desktop.ts — 命令行"桌面"端 demo。
 *
 * 协议义务实现：
 * - 出 QR（写 demo/qr.json 模拟扫码信道，desktop→phone 唯一带外通道）
 * - 轮询 GET /pair/status（Bearer 配对令牌，2s 间隔，deadline = expires+30s）——
 *   桌面拿 phonePub 的唯一合法信道（严禁 QR 外回传）
 * - hello 解密/MAC 失败统一 fail-closed 报警，禁止静默重试；6 位数字指纹仅装饰
 * - confirm 前收到非 pair 信封丢弃+计数
 *
 * 用法：
 *   OPERATOR_KEY=... node demo-desktop.ts [--relay ws://127.0.0.1:8080] [--name 测试电脑]
 *        [--ca tests/fixtures/ca.crt] [--auto-confirm]
 *        [--say "文本"] [--no-reply] [--once] [--reset]
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

interface DeskState {
  secretKey: string;
  publicKey: string;
  phonePub: string | null;
  phoneDevice: string | null;
  name: string;
  confirmed: boolean;
  token: string | null; // 配对令牌：pairingMAC 重验所需（redeemed 行服务器留 24h，本地与之对齐留存）
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

const STATE_PATH = 'demo/.state/desktop.json';
const QR_PATH = 'demo/qr.json';

function saveState(s: DeskState): void {
  mkdirSync('demo/.state', { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function loadState(): DeskState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as DeskState;
  } catch {
    return null;
  }
}

/** 装饰性 6 位数字指纹（设计文档：仅为装饰性核对，非防御） */
function decorativeFingerprint(deskPub: string, phonePub: string): string {
  const d = b64uDecode(deskPub);
  const p = b64uDecode(phonePub);
  const both = new Uint8Array(d.length + p.length);
  both.set(d, 0);
  both.set(p, d.length);
  const h = sha256(both);
  const n = ((h[0]! | (h[1]! << 8) | (h[2]! << 16) | (h[3]! << 24)) >>> 0) % 1_000_000;
  return String(n).padStart(6, '0');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (has(argv, '--reset')) {
    rmSync(STATE_PATH, { force: true });
    rmSync(QR_PATH, { force: true });
    console.log('[desktop] 本地状态已清除');
    return;
  }
  const relay = arg(argv, '--relay') ?? 'ws://127.0.0.1:8080';
  const name = arg(argv, '--name') ?? '测试电脑';
  const caPath = arg(argv, '--ca');
  const tls: TlsOpt = loadCa(caPath);
  const autoConfirm = has(argv, '--auto-confirm');
  const say = arg(argv, '--say');
  const noReply = has(argv, '--no-reply');
  const once = has(argv, '--once');
  const base = httpBase(relay);

  let state = loadState();
  let token: string | null = null;

  if (!state || !state.phonePub) {
    // ---- 配对模式：出码 + 轮询 status ----
    const operatorKey = process.env['OPERATOR_KEY'];
    if (!operatorKey) {
      console.error('[desktop] 配对需要 OPERATOR_KEY 环境变量（POST /pair/tokens 鉴权）');
      process.exit(1);
    }
    const kp = generateKeyPair();
    const tr = await httpJson('POST', `${base}/pair/tokens`, { token: operatorKey, ...tls });
    if (tr.status !== 200) {
      console.error(`[desktop] 签发配对令牌失败: HTTP ${tr.status}`);
      process.exit(1);
    }
    const { token: tk, expires } = tr.json as { token: string; expires: number };
    token = tk;
    state = {
      secretKey: kp.secretKey,
      publicKey: kp.publicKey,
      phonePub: null,
      phoneDevice: null,
      name,
      confirmed: false,
      token,
    };
    saveState(state);

    const qr = {
      v: 1,
      relay,
      deskPub: kp.publicKey,
      caFP: tls.ca ? b64uEncode(sha256(tls.ca)) : '',
      token,
      name,
    };
    writeFileSync(QR_PATH, JSON.stringify(qr));
    console.log('┌──────────────── 配对二维码（模拟，已写 demo/qr.json）────────────────');
    console.log(JSON.stringify(qr, null, 2));
    console.log('└── 用手机端扫码（demo: --qr-file demo/qr.json）；配对完成后请清屏 ──');

    // 轮询：2s 间隔，deadline = expires + 30s；expired → 提示重新出码（无警报）
    const deadline = expires + 30_000;
    for (;;) {
      if (Date.now() > deadline) {
        console.error('[desktop] 配对超时，请重新出码');
        process.exit(3);
      }
      const sr = await httpJson('GET', `${base}/pair/status`, { token, ...tls });
      if (sr.status === 200) {
        const s = sr.json as { state: string; phonePub?: string; device?: string };
        if (s.state === 'redeemed') {
          state.phonePub = s.phonePub!;
          state.phoneDevice = s.device!;
          saveState(state);
          console.log(`[desktop] 手机已登记：${s.device}（等待 pair.hello 密钥确认…）`);
          break;
        }
        if (s.state === 'expired') {
          console.error('[desktop] 令牌已过期，请重新出码');
          process.exit(3);
        }
      }
      await sleep(2000);
    }
  } else {
    // 恢复模式：密钥对必须自洽；token 用于 pair.hello 的 MAC 重验
    const kp = keyPairFromSecretKey(state.secretKey);
    state.publicKey = kp.publicKey;
    token = state.token;
    console.log(`[desktop] 恢复已配对设备：${state.phoneDevice ?? state.phonePub}`);
  }

  const phonePub = state.phonePub!;
  const shared = ecdhShared(state.secretKey, phonePub);
  const secrets = deriveSecrets(shared);
  const myBox = mailboxIdFromPub(state.publicKey);
  const phoneBox = mailboxIdFromPub(phonePub);
  // token 只在配对模式持有；恢复模式下 pairingMAC 已在首次配对时验过
  const mac = token ? pairingMAC(token, state.publicKey, phonePub) : null;

  const dedupe = new DedupeSet();
  let confirmed = state.confirmed;
  let droppedPreConfirm = 0;
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
      const dec = decryptEnvelope(secrets.keyM2D, myBox, 'm2d', msg.blob);
      if (!dec.ok) {
        console.error(`[desktop] ❌ 信封解密/AAD 校验失败（msg id=${msg.id}），fail-closed 不 ACK`);
        return;
      }
      const env = dec.envelope;
      if (env.from !== phoneBox || env.to !== myBox) {
        console.error(`[desktop] ❌ from/to 与预期对端不符，丢弃并告警（from=${env.from}）`);
        return;
      }
      if (!isTsFresh(env.ts)) {
        console.error(`[desktop] ❌ ts 偏离 ±5min，丢弃（id=${env.id}）`);
        return;
      }
      if (!dedupe.mark(env.id)) return;
      if (!KNOWN_TYPES.has(env.type)) return;

      if (env.type === 'pair.hello') {
        if (!mac || env.body['mac'] !== mac) {
          console.error('[desktop] ❌ pair.hello MAC 校验失败，fail-closed 报警（可能 MITM/伪造），禁止静默重试');
          return;
        }
        const dev = String(env.body['device'] ?? state.phoneDevice ?? '?');
        console.log('┌──────────────── 配对确认 ────────────────');
        console.log(`│ 手机设备名：${dev}`);
        console.log(`│ 装饰性指纹（带外肉眼核对）：${decorativeFingerprint(state!.publicKey, phonePub)}`);
        console.log('└──────────────────────────────────────────');
        void ack(msg.id);
        if (autoConfirm) {
          void sendConfirm();
        } else {
          process.stdout.write('[desktop] 输入 y 确认配对：');
        }
        return;
      }
      if (!confirmed) {
        if (!env.type.startsWith('pair.')) {
          droppedPreConfirm++;
          console.log(`[desktop] confirm 前收到非 pair 信封，丢弃（累计 ${droppedPreConfirm}）`);
        }
        return;
      }
      if (env.type === 'chat.user') {
        const text = String(env.body['text'] ?? '');
        console.log(`[手机] ${text}${env.body['truncated'] ? '（已截断）' : ''}`);
        void ack(msg.id);
        if (replyResolve) replyResolve(text);
        else if (once) onceMsgs.push(text);
        return;
      }
      void ack(msg.id);
    },
    () => console.log('[desktop] WS 断开'),
  );

  function ack(id: number): Promise<void> {
    return httpJson('POST', `${base}/box/${myBox}/ack`, {
      token: secrets.readToken,
      body: { id },
      ...tls,
    }).then(() => undefined);
  }

  async function sendConfirm(): Promise<void> {
    const env = makeEnvelope('pair.confirm', myBox, phoneBox, { device: name, mac: mac! });
    const wire = encryptEnvelope(secrets.keyD2M, phoneBox, 'd2m', env)!;
    const r = await httpJson('POST', `${base}/box/${phoneBox}`, {
      token: secrets.writeToken,
      body: { blob: wire },
      ...tls,
    });
    if (r.status !== 201) throw new Error(`confirm 投递失败 HTTP ${r.status}`);
    confirmed = true;
    state!.confirmed = true;
    saveState(state!);
    console.log('[desktop] ✅ pair.confirm 已回投，配对完成');
    confirmResolve(true);
  }

  await new Promise<void>((r) => ws.on('open', () => r()));

  if (!confirmed) {
    if (!autoConfirm) {
      // 交互确认
      const rl0 = createInterface({ input: process.stdin });
      rl0.on('line', (line) => {
        if (!confirmed && line.trim().toLowerCase() === 'y') {
          rl0.close();
          void sendConfirm();
        }
      });
    }
    await confirmedP;
  }

  async function sendChat(text: string): Promise<void> {
    const { text: t, truncated } = truncateToBudget(text);
    const env = makeEnvelope('chat.event', myBox, phoneBox, {
      kind: 'final',
      text: t,
      ...(truncated ? { truncated: true } : {}),
    });
    const wire = encryptEnvelope(secrets.keyD2M, phoneBox, 'd2m', env);
    if (!wire) throw new Error('消息超线上字节上限');
    const r = await httpJson('POST', `${base}/box/${phoneBox}`, {
      token: secrets.writeToken,
      body: { blob: wire },
      ...tls,
    });
    if (r.status !== 201) throw new Error(`投递失败 HTTP ${r.status}`);
  }

  if (once) {
    await sleep(Number(arg(argv, '--quiet-ms') ?? 1500));
    ws.close();
    if (onceMsgs.length === 0) console.log('[desktop] （无离线留言）');
    process.exit(0);
  }

  if (say !== undefined) {
    await sendChat(say);
    console.log(`[desktop] 已发送: ${say}`);
    if (!noReply) {
      const waitMs = Number(arg(argv, '--wait-ms') ?? 15000);
      const reply = await Promise.race([
        new Promise<string>((r) => (replyResolve = r)),
        sleep(waitMs).then(() => null),
      ]);
      if (reply === null) {
        console.log('[desktop] （等待回复超时）');
        process.exit(6);
      }
    }
    ws.close();
    process.exit(0);
  }

  console.log('[desktop] 进入聊天（输入行回车发送，Ctrl+C 退出）');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text) void sendChat(text).catch((e) => console.error(`[desktop] 发送失败: ${String(e)}`));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[desktop] fatal:', err);
    process.exit(1);
  });
}
