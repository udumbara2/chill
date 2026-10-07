/** diag-read.ts — 用桌面真实凭据读桌面信箱：验证 read_token 有效性 + 消息可解密性 */
import { PairingManager, decryptEnvelope, b64uDecode } from '@assistant-ai/core'
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
const devices = await pm.listDevices()
console.log('devices:', devices.length)
const d = devices[0]!
const { secrets, myBox } = await pm.deriveForDevice(d.phonePub)
console.log('desk box:', myBox)

const config = await pm.getRelayConfig()
const caPath = await pm.getCaPath()
const http = new NodeRelayHttp(config.relayUrl, caPath ?? undefined)

// 用 read_token 拉 WS
const t = new NodeWsTransport(config.relayUrl, myBox, secrets.readToken, caPath ?? undefined)
t.onClose((c) => console.log('CLOSE:', c))
try {
  await t.connect()
  console.log('WS_CONNECTED（read_token 有效）')
} catch (e) {
  console.log('WS_CONNECT_ERR:', String(e))
  process.exit(1)
}
t.onMessage((m) => {
  console.log('收到消息 id=', m.id, '尝试解密…')
  const env = decryptEnvelope(secrets.keyM2D, myBox, 'm2d', m.blob)
  console.log('解密结果:', env ? JSON.stringify({ type: env.type, from: env.from, body: env.body }) : '❌ 解密失败')
})
setTimeout(() => process.exit(0), 10000)
