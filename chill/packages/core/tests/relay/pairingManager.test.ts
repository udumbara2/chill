import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PairingManager,
  RELAY_KEYS,
  type PairedDevice,
  type DeviceStore,
} from '../../src/services/relay/PairingManager.ts'
import { mailboxIdFromPub, deriveSecrets, ecdhShared, generateKeyPair } from '../../src/services/relay/envelope.ts'
import type { RelayHttp, RelayHttpResult } from '../../src/services/relay/RelayTransport.ts'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage.ts'

/** Map 版 fake secureStorage（ISecureStorage 的 API-key 形状） */
function fakeSecureStorage(): ISecureStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    storeApiKey: async (p, k) => (map.set(p, k), true),
    getApiKey: async (p) => map.get(p) ?? null,
    hasApiKey: async (p) => map.has(p),
    deleteApiKey: async (p) => map.delete(p),
    getAllProviders: async () => [...map.keys()],
  }
}

function fakeDeviceStore(initial: PairedDevice[] = []): DeviceStore & { devices: PairedDevice[] } {
  const devices = [...initial]
  return {
    devices,
    read: async () => [...devices],
    write: async (d) => {
      devices.length = 0
      devices.push(...d)
    },
  }
}

/** 可编程 fake http：按 [method,path] 排队响应；记录全部请求 */
function fakeHttp() {
  const requests: { method: string; path: string; token?: string; body?: unknown }[] = []
  const queue: RelayHttpResult[] = []
  let fallback: RelayHttpResult = { status: 404, json: null }
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      requests.push({ method, path, ...(opts.token !== undefined ? { token: opts.token } : {}), ...(opts.body !== undefined ? { body: opts.body } : {}) })
      return queue.length > 0 ? queue.shift()! : fallback
    },
  }
  return { http, requests, queue, setFallback: (r: RelayHttpResult) => (fallback = r) }
}

const CONFIG = { relayUrl: 'wss://relay.example:8443', operatorKey: 'op-key', caFP: 'cafp' }

function makeManager(over: Partial<ConstructorParameters<typeof PairingManager>[0]> = {}) {
  const secureStorage = fakeSecureStorage()
  const deviceStore = fakeDeviceStore()
  let t = 1_700_000_000_000
  const manager = new PairingManager({
    secureStorage,
    deviceStore,
    now: () => t,
    sleep: async (ms) => {
      t += ms
    },
    pollIntervalMs: 2000,
    ...over,
  })
  return { manager, secureStorage, deviceStore, setNow: (nt: number) => (t = nt), getNow: () => t }
}

test('配置：未配置返回 null；saveRelayConfig 后可读全量', async () => {
  const { manager } = makeManager()
  assert.equal(await manager.getRelayConfig(), null)
  await manager.saveRelayConfig(CONFIG)
  assert.deepEqual(await manager.getRelayConfig(), CONFIG)
})

test('设备密钥对：生成一次持久化，二次调用复用同一对', async () => {
  const { manager, secureStorage } = makeManager()
  const k1 = await manager.getOrCreateDeviceKey()
  assert.ok(secureStorage.map.get(RELAY_KEYS.deviceSecretKey))
  const k2 = await manager.getOrCreateDeviceKey()
  assert.deepEqual(k1, k2)
})

test('startPairing：POST /pair/tokens 用运营者密钥，QR schema 冻结字段齐', async () => {
  const { manager } = makeManager()
  const { http, requests, queue } = fakeHttp()
  queue.push({ status: 200, json: { token: 'tok-1', expires: 1_700_000_600_000 } })
  const { qr, expires } = await manager.startPairing(http, CONFIG, '测试电脑')
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].path, '/pair/tokens')
  assert.equal(requests[0].token, 'op-key')
  assert.equal(qr.v, 1)
  assert.equal(qr.relay, CONFIG.relayUrl)
  assert.equal(qr.token, 'tok-1')
  assert.equal(qr.caFP, 'cafp')
  assert.equal(qr.name, '测试电脑')
  assert.ok(qr.deskPub.length > 0)
  assert.equal(expires, 1_700_000_600_000)
})

test('waitForRedeem 状态机：pending 轮询 → redeemed 终态即停', async () => {
  const { manager } = makeManager()
  const { http, requests, queue } = fakeHttp()
  queue.push({ status: 200, json: { state: 'pending' } })
  queue.push({ status: 200, json: { state: 'pending' } })
  queue.push({ status: 200, json: { state: 'redeemed', phonePub: 'phone-pub', device: '测试手机' } })
  const expires = 1_700_000_600_000
  const r = await manager.waitForRedeem(http, 'tok-1', expires)
  assert.deepEqual(r, { state: 'redeemed', phonePub: 'phone-pub', device: '测试手机' })
  assert.equal(requests.length, 3) // 终态即停
  assert.ok(requests.every((q) => q.path === '/pair/status' && q.token === 'tok-1'))
})

test('waitForRedeem：expired 提示重新出码；deadline=expires+30s 超时', async () => {
  const { manager } = makeManager()
  const { http, queue } = fakeHttp()
  queue.push({ status: 200, json: { state: 'expired' } })
  assert.deepEqual(await manager.waitForRedeem(http, 'tok', 1_700_000_600_000), { state: 'expired' })

  // 一直 pending → deadline（每次 sleep 推进注入时钟 2s）
  const { http: http2, setFallback } = fakeHttp()
  setFallback({ status: 200, json: { state: 'pending' } })
  const r = await manager.waitForRedeem(http2, 'tok', 1_700_000_000_000 + 60_000)
  assert.deepEqual(r, { state: 'timeout' })
})

test('completePairing / listDevices / revokeDevice 全流', async () => {
  const { manager, deviceStore } = makeManager()
  const desk = await manager.getOrCreateDeviceKey()
  const phone = generateKeyPair()
  const phonePub = phone.publicKey
  await manager.completePairing(phonePub, '测试手机', 'pair-token-1')
  assert.deepEqual(await manager.listDevices(), [
    { phonePub, device: '测试手机', pairedAt: deviceStore.devices[0].pairedAt },
  ])
  assert.equal(await manager.getPairingToken(), 'pair-token-1')

  // revoke：DELETE 手机信箱（revoke_token）+ 本地记录删除 + 配对令牌作废
  const { http, requests, queue } = fakeHttp()
  queue.push({ status: 204, json: null })
  const r = await manager.revokeDevice(http, phonePub)
  assert.equal(r.ok, true)
  const del = requests.find((q) => q.method === 'DELETE')!
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phonePub))
  assert.equal(del.path, `/box/${mailboxIdFromPub(phonePub)}`)
  assert.equal(del.token, secrets.revokeToken)
  assert.deepEqual(await manager.listDevices(), [])
  assert.equal(await manager.getPairingToken(), null)
})
