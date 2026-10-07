// golden vectors 裸跑验证（RN 侧拷贝件的确定性输出）
import { keyPairFromSecretKey, ecdhShared, deriveSecrets, mailboxIdFromPub, pairingMAC, decryptEnvelope } from '../src/relay/envelope.ts';
import { bytesToHex } from '@noble/hashes/utils';
const desk = keyPairFromSecretKey('ERERERERERERERERERERERERERERERERERERERERERE');
const phone = keyPairFromSecretKey('IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI');
const assert = (name, actual, expected) => {
  if (actual !== expected) { console.error(`✖ ${name}: ${actual} != ${expected}`); process.exit(1); }
  console.log(`✔ ${name}`);
};
const shared = ecdhShared(desk.secretKey, phone.publicKey);
assert('shared_secret', bytesToHex(shared), '8abe7c8ae6800b76d4f5986b04b77f6e9b4f332403c90df02428336e8bd9b525');
const s = deriveSecrets(shared);
assert('keyD2M', bytesToHex(s.keyD2M), 'ff2ead5a3e2bac4514906a334b10d6cb9e2fded3402748108923077768f8228a');
assert('keyM2D', bytesToHex(s.keyM2D), 'de08ff1bfc49158f07cfa6b74e698b43b8e8b7f8c516bef0a641d45f5fbd95f8');
assert('writeToken', s.writeToken, 'OQMrjK6xT9S_udJrslNaJizt-nGXbiAmLG9mTt3-Xb8');
assert('readToken', s.readToken, 'WEBYJfTTAETHDh4DBEkFTzcOtrduDZ8fehfFWemCLxU');
assert('revokeToken', s.revokeToken, 'aCVKAXN6G8affljKEKDckSAbVDDICxzVGIY3v-MutBI');
assert('deskBox', mailboxIdFromPub(desk.publicKey), 'd19bf3f082782c87b783fe7134698aef');
assert('phoneBox', mailboxIdFromPub(phone.publicKey), '65cf5c9b1de5d41f758cb67f2d05f3e3');
assert('pairingMAC', pairingMAC('MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM', desk.publicKey, phone.publicKey), 'ZyN8QpyqBGCHTOfZufKfKzQQ5hKTM4rOSSbsMuNiI-4');
const wire = 'REREREREREREREREREREREREREREREREX6D6lkR34u4mEO9oT6a0CUcfQjfLhIxL5iQmQFvTDSjB6v74CGmrw43AWEcKNK1p2zKtU6GC8mSDvB8oajhj82PsOTC76C_6ySsg-08yQDZh173GJFUo_4kCBtoPvvqZCmz6jPHNsm_WyDdl5gLFIptsx_glBbhdPy_fFEUE4Smcf6Ln1CvuMHPqGpQwVD1z_GjZ2W4XY9K7cg_UtGscdo7Px-s11bV1QV3W63Bx8T-o10WPhUeqSKkH8cVJz37ueunyEhgDoI_PDbCOlwQFb_7E8kLn_fLxHnKWgkaPlFC56h_ci3mWL6jWx9s';
const d = decryptEnvelope(s.keyM2D, 'd19bf3f082782c87b783fe7134698aef', 'm2d', wire);
if (!d.ok || JSON.stringify(d.envelope) !== '{"v":1,"type":"chat.user","id":"golden-fixed-id","ts":1735689600000,"from":"65cf5c9b1de5d41f758cb67f2d05f3e3","to":"d19bf3f082782c87b783fe7134698aef","body":{"text":"golden hello"}}') { console.error('✖ 密文解密'); process.exit(1); }
console.log('✔ golden 密文解密');
console.log('GOLDEN_ALL_GREEN');
