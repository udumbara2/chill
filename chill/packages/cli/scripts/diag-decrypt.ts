/** diag-decrypt.ts — 逐步分解 msg 32 的解密过程，定位失败环节 */
import nacl from '../../../node_modules/.pnpm/tweetnacl@1.0.3/node_modules/tweetnacl/nacl-fast.js'
import { PairingManager, b64uDecode, aadFor, tokenHash, deriveSecrets, ecdhShared, mailboxIdFromPub } from '@assistant-ai/core'
import { CLISecureStorage } from '../src/security/CLISecureStorage.js'
import { NodeDeviceStore, defaultDevicesPath } from '../src/relay/relayNodeStores.js'
import { NodeRelayHttp } from '../src/relay/NodeRelayHttp.js'
import { NodeWsTransport } from '../src/relay/NodeWsTransport.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const userDataPath = join(homedir(), '.chill')
const pm = new PairingManager({
  secureStorage: new CLISecureStorage(),
  deviceStore: new NodeDeviceStore(defaultDevicesPath(userDataPath)),
})
const d = (await pm.listDevices())[0]!
console.log('phonePub:', d.phonePub)
const { secrets, myBox } = await pm.deriveForDevice(d.phonePub)
console.log('desk box:', myBox)
console.log('readToken(前16):', secrets.readToken.slice(0, 16))
console.log('writeToken hash(前16):', tokenHash(secrets.writeToken).slice(0, 16))

const config = await pm.getRelayConfig()
const caPath = await pm.getCaPath()
const t = new NodeWsTransport(config.relayUrl, myBox, secrets.readToken, caPath ?? undefined)
await t.connect()
console.log('WS OK')
t.onMessage((m) => {
  console.log('=== msg id=', m.id, '===')
  const raw = b64uDecode(m.blob)
  const nLen = nacl.secretbox.nonceLength
  const nonce = raw.slice(0, nLen)
  const ct = raw.slice(nLen)
  const plain = nacl.secretbox.open(ct, nonce, secrets.keyM2D)
  if (!plain) {
    console.log('① AEAD open 失败（密钥不匹配或密文被篡改）')
    // 再试 d2m 方向钥（排除方向搞反）
    const p2 = nacl.secretbox.open(ct, nonce, secrets.keyD2M)
    console.log('② 用 keyD2M 试:', p2 ? '竟然能解开（方向真的反了）' : '也失败')
    process.exit(0)
  }
  const text = new TextDecoder().decode(plain)
  const nl = text.indexOf('\n')
  const aad = text.slice(0, nl)
  console.log('AEAD open OK, 首行 AAD =', JSON.stringify(aad))
  console.log('期望 AAD =', JSON.stringify(aadFor(myBox, 'm2d')))
  console.log('AAD 匹配:', aad === aadFor(myBox, 'm2d'))
  process.exit(0)
})
setTimeout(() => { console.log('超时无消息'); process.exit(1) }, 10000)
