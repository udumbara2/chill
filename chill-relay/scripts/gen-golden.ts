/** 一次性 golden vector 生成脚本（运行后把输出粘进 tests/golden-vectors.test.ts） */
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import {
  keyPairFromSecretKey,
  ecdhShared,
  deriveSecrets,
  mailboxIdFromPub,
  pairingMAC,
  b64uEncode,
  aadFor,
} from '../src/shared/envelope.js';
import { bytesToHex } from '@noble/hashes/utils';

const { decodeUTF8: utf8ToBytes } = util;

const desk = keyPairFromSecretKey(b64uEncode(new Uint8Array(32).fill(0x11)));
const phone = keyPairFromSecretKey(b64uEncode(new Uint8Array(32).fill(0x22)));
const shared = ecdhShared(desk.secretKey, phone.publicKey);
const s = deriveSecrets(shared);
const deskBox = mailboxIdFromPub(desk.publicKey);
const phoneBox = mailboxIdFromPub(phone.publicKey);
const token = b64uEncode(new Uint8Array(32).fill(0x33));
const mac = pairingMAC(token, desk.publicKey, phone.publicKey);

const env = {
  v: 1,
  type: 'chat.user',
  id: 'golden-fixed-id',
  ts: 1735689600000,
  from: phoneBox,
  to: deskBox,
  body: { text: 'golden hello' },
};
const aad = aadFor(deskBox, 'm2d', 1);
const plain = utf8ToBytes(aad + '\n' + JSON.stringify(env));
const nonce = new Uint8Array(24).fill(0x44);
const ct = nacl.secretbox(plain, nonce, s.keyM2D);
const wire = b64uEncode(new Uint8Array([...nonce, ...ct]));

console.log(
  JSON.stringify(
    {
      deskSecretKey: desk.secretKey,
      deskPublicKey: desk.publicKey,
      phoneSecretKey: phone.secretKey,
      phonePublicKey: phone.publicKey,
      sharedSecretHex: bytesToHex(shared),
      keyD2MHex: bytesToHex(s.keyD2M),
      keyM2DHex: bytesToHex(s.keyM2D),
      writeToken: s.writeToken,
      readToken: s.readToken,
      revokeToken: s.revokeToken,
      deskBox,
      phoneBox,
      token,
      pairingMAC: mac,
      aad,
      envelopeJson: JSON.stringify(env),
      wire,
    },
    null,
    2,
  ),
);
