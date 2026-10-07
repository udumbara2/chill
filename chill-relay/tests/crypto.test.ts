import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPair,
  ecdhShared,
  deriveSecrets,
  mailboxIdFromPub,
  pairingMAC,
  encryptEnvelope,
  decryptEnvelope,
  makeEnvelope,
  truncateToBudget,
  isTsFresh,
  DedupeSet,
  b64uEncode,
  PLAINTEXT_BUDGET_BYTES,
  TS_SKEW_MS,
} from '../src/shared/envelope.js';

function setup() {
  const desk = generateKeyPair();
  const phone = generateKeyPair();
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey));
  const deskBox = mailboxIdFromPub(desk.publicKey);
  const phoneBox = mailboxIdFromPub(phone.publicKey);
  return { desk, phone, secrets, deskBox, phoneBox };
}

test('加密往返：双方向各自成立', () => {
  const { secrets, deskBox, phoneBox } = setup();
  const m2d = makeEnvelope('chat.user', phoneBox, deskBox, { text: '手机→桌面' });
  const w1 = encryptEnvelope(secrets.keyM2D, deskBox, 'm2d', m2d)!;
  const d1 = decryptEnvelope(secrets.keyM2D, deskBox, 'm2d', w1);
  assert.equal(d1.ok, true);
  if (d1.ok) assert.deepEqual(d1.envelope.body, { text: '手机→桌面' });

  const d2m = makeEnvelope('chat.event', deskBox, phoneBox, { kind: 'final', text: '桌面→手机' });
  const w2 = encryptEnvelope(secrets.keyD2M, phoneBox, 'd2m', d2m)!;
  const d2 = decryptEnvelope(secrets.keyD2M, phoneBox, 'd2m', w2);
  assert.equal(d2.ok, true);
});

test('反射攻击必败：密文重投到对向信箱 / 用对向钥解都失败', () => {
  const { secrets, deskBox, phoneBox } = setup();
  const env = makeEnvelope('chat.user', phoneBox, deskBox, { text: 'x' });
  const wire = encryptEnvelope(secrets.keyM2D, deskBox, 'm2d', env)!;
  // 反射到手机信箱（AAD 不符）
  assert.equal(decryptEnvelope(secrets.keyD2M, phoneBox, 'd2m', wire).ok, false);
  // 同信箱错方向钥
  assert.equal(decryptEnvelope(secrets.keyD2M, deskBox, 'm2d', wire).ok, false);
  // 同钥错方向标签
  assert.equal(decryptEnvelope(secrets.keyM2D, deskBox, 'd2m', wire).ok, false);
});

test('AAD 篡改必败：mailboxId 换一个字符即解不开', () => {
  const { secrets, deskBox } = setup();
  const env = makeEnvelope('chat.user', 'f', deskBox, { text: 'x' });
  const wire = encryptEnvelope(secrets.keyM2D, deskBox, 'm2d', env)!;
  const tamperedBox = (deskBox[0] === 'a' ? 'b' : 'a') + deskBox.slice(1);
  assert.equal(decryptEnvelope(secrets.keyM2D, tamperedBox, 'm2d', wire).ok, false);
});

test('错钥必败；垃圾输入 fail-closed 不抛', () => {
  const { secrets, deskBox, phoneBox } = setup();
  const other = deriveSecrets(ecdhShared(generateKeyPair().secretKey, generateKeyPair().publicKey));
  const env = makeEnvelope('chat.user', phoneBox, deskBox, { text: 'x' });
  const wire = encryptEnvelope(secrets.keyM2D, deskBox, 'm2d', env)!;
  assert.equal(decryptEnvelope(other.keyM2D, deskBox, 'm2d', wire).ok, false);
  assert.equal(decryptEnvelope(secrets.keyM2D, deskBox, 'm2d', 'not-base64!!!').ok, false);
  assert.equal(decryptEnvelope(secrets.keyM2D, deskBox, 'm2d', b64uEncode(new Uint8Array(4))).ok, false);
  assert.equal(decryptEnvelope(secrets.keyM2D, deskBox, 'm2d', wire.slice(0, -4) + 'AAAA').ok, false);
});

test('status 篡改 phonePub → pairingMAC 不等 → 配对必败', () => {
  const { desk, phone } = setup();
  const token = b64uEncode(new Uint8Array(32).fill(7));
  const mac = pairingMAC(token, desk.publicKey, phone.publicKey);
  // MITM 篡改 status 返回的 phonePub
  const evilPhone = generateKeyPair();
  const macTampered = pairingMAC(token, desk.publicKey, evilPhone.publicKey);
  assert.notEqual(mac, macTampered);
  // hello 里携带的 mac 与桌面重算不符 → 校验失败（fail-closed 报警路径）
  assert.notEqual(mac, pairingMAC(token, desk.publicKey, generateKeyPair().publicKey));
  // 正确情形相等
  assert.equal(mac, pairingMAC(token, desk.publicKey, phone.publicKey));
});

test('明文预算：45KB 内不动，超出截断且不破坏 UTF-8', () => {
  const ok = truncateToBudget('a'.repeat(PLAINTEXT_BUDGET_BYTES));
  assert.equal(ok.truncated, false);
  const over = truncateToBudget('汉'.repeat(PLAINTEXT_BUDGET_BYTES)); // 3B/字
  assert.equal(over.truncated, true);
  assert.ok(Buffer.byteLength(over.text, 'utf8') <= PLAINTEXT_BUDGET_BYTES);
  // 截断结果是合法 UTF-8（无替换字符）
  assert.ok(!over.text.includes('\uFFFD'), `含替换字符: ${JSON.stringify(over.text.slice(-6))}`);
});

test('超线上上限：encryptEnvelope 返回 null', () => {
  const { secrets, deskBox, phoneBox } = setup();
  const env = makeEnvelope('chat.user', phoneBox, deskBox, { text: 'x'.repeat(200 * 1024) });
  assert.equal(encryptEnvelope(secrets.keyM2D, deskBox, 'm2d', env), null);
});

test('ts 粗筛：单向边界（只拒未来，不拒迟到的离线留言）', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(isTsFresh(t0, () => t0), true);
  assert.equal(isTsFresh(t0 + TS_SKEW_MS, () => t0), true);
  assert.equal(isTsFresh(t0 + TS_SKEW_MS + 1, () => t0), false);
  assert.equal(isTsFresh(t0 - 365 * 86400_000, () => t0), true);
});

test('DedupeSet：去重 + LRU 淘汰 + 持久化注入点往返', () => {
  const d = new DedupeSet(3);
  assert.equal(d.mark('a'), true);
  assert.equal(d.mark('a'), false);
  d.mark('b');
  d.mark('c');
  d.mark('d'); // 淘汰 a
  assert.equal(d.has('a'), false);
  assert.equal(d.has('d'), true);
  const restored = new DedupeSet(3, d.snapshot());
  assert.equal(restored.has('d'), true);
  assert.equal(restored.mark('d'), false);
});
