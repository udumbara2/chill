import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils';
import {
  keyPairFromSecretKey,
  ecdhShared,
  deriveSecrets,
  mailboxIdFromPub,
  pairingMAC,
  aadFor,
  decryptEnvelope,
} from '../src/shared/envelope.js';
import { bytesToHex } from '@noble/hashes/utils';

// ── 硬编码期望值（scripts/gen-golden.ts 固定种子生成，改任何冻结项都会打破本测试）──
const G = {
  deskSecretKey: 'ERERERERERERERERERERERERERERERERERERERERERE',
  deskPublicKey: 'e06Qm75__kTEZaIgA31gjuNYl9Me-XLwf3SJLLD3PxM',
  phoneSecretKey: 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI',
  phonePublicKey: 'D6poTtKIZ7l_Smot7l34zpdOdrcBjj8iocTPJnhXDyA',
  sharedSecretHex: '8abe7c8ae6800b76d4f5986b04b77f6e9b4f332403c90df02428336e8bd9b525',
  keyD2MHex: 'ff2ead5a3e2bac4514906a334b10d6cb9e2fded3402748108923077768f8228a',
  keyM2DHex: 'de08ff1bfc49158f07cfa6b74e698b43b8e8b7f8c516bef0a641d45f5fbd95f8',
  writeToken: 'OQMrjK6xT9S_udJrslNaJizt-nGXbiAmLG9mTt3-Xb8',
  readToken: 'WEBYJfTTAETHDh4DBEkFTzcOtrduDZ8fehfFWemCLxU',
  revokeToken: 'aCVKAXN6G8affljKEKDckSAbVDDICxzVGIY3v-MutBI',
  deskBox: 'd19bf3f082782c87b783fe7134698aef',
  phoneBox: '65cf5c9b1de5d41f758cb67f2d05f3e3',
  token: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
  pairingMAC: 'ZyN8QpyqBGCHTOfZufKfKzQQ5hKTM4rOSSbsMuNiI-4',
  aad: 'd19bf3f082782c87b783fe7134698aef|m2d|1',
  envelopeJson:
    '{"v":1,"type":"chat.user","id":"golden-fixed-id","ts":1735689600000,"from":"65cf5c9b1de5d41f758cb67f2d05f3e3","to":"d19bf3f082782c87b783fe7134698aef","body":{"text":"golden hello"}}',
  wire: 'REREREREREREREREREREREREREREREREX6D6lkR34u4mEO9oT6a0CUcfQjfLhIxL5iQmQFvTDSjB6v74CGmrw43AWEcKNK1p2zKtU6GC8mSDvB8oajhj82PsOTC76C_6ySsg-08yQDZh173GJFUo_4kCBtoPvvqZCmz6jPHNsm_WyDdl5gLFIptsx_glBbhdPy_fFEUE4Smcf6Ln1CvuMHPqGpQwVD1z_GjZ2W4XY9K7cg_UtGscdo7Px-s11bV1QV3W63Bx8T-o10WPhUeqSKkH8cVJz37ueunyEhgDoI_PDbCOlwQFb_7E8kLn_fLxHnKWgkaPlFC56h_ci3mWL6jWx9s',
} as const;

test('golden: 固定种子 → 密钥对 / shared_secret / 5 派生物 / mailboxId 全部等于硬编码值', () => {
  const desk = keyPairFromSecretKey(G.deskSecretKey);
  const phone = keyPairFromSecretKey(G.phoneSecretKey);
  assert.equal(desk.publicKey, G.deskPublicKey);
  assert.equal(phone.publicKey, G.phonePublicKey);

  const shared = ecdhShared(G.deskSecretKey, G.phonePublicKey);
  assert.equal(bytesToHex(shared), G.sharedSecretHex);
  // 对称性：对端计算结果一致
  assert.equal(bytesToHex(ecdhShared(G.phoneSecretKey, G.deskPublicKey)), G.sharedSecretHex);

  const s = deriveSecrets(shared);
  assert.equal(bytesToHex(s.keyD2M), G.keyD2MHex);
  assert.equal(bytesToHex(s.keyM2D), G.keyM2DHex);
  assert.equal(s.writeToken, G.writeToken);
  assert.equal(s.readToken, G.readToken);
  assert.equal(s.revokeToken, G.revokeToken);

  assert.equal(mailboxIdFromPub(G.deskPublicKey), G.deskBox);
  assert.equal(mailboxIdFromPub(G.phonePublicKey), G.phoneBox);

  assert.equal(pairingMAC(G.token, G.deskPublicKey, G.phonePublicKey), G.pairingMAC);
  assert.equal(aadFor(G.deskBox, 'm2d', 1), G.aad);
});

test('golden: 硬编码密文用派生钥解密 == 硬编码信封明文', () => {
  const s = deriveSecrets(hexToBytes(G.sharedSecretHex));
  const d = decryptEnvelope(s.keyM2D, G.deskBox, 'm2d', G.wire);
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(JSON.stringify(d.envelope), G.envelopeJson);
});

test('红线：envelope.ts 保持 Buffer-free 且禁 node: import（renderer/RN 安全）', () => {
  const src = readFileSync(new URL('../src/shared/envelope.ts', import.meta.url), 'utf8');
  // 去除注释与字符串后扫描，防误报
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'[^'\n]*'|"[^"\n]*"/g, "''");
  assert.ok(!/\bBuffer\b/.test(stripped), 'envelope.ts 不得引用 Buffer');
  assert.ok(!/from\s*'node:/.test(stripped), 'envelope.ts 不得 import node:*');
  assert.ok(!/\brequire\s*\(/.test(stripped), 'envelope.ts 必须纯 import');
});
