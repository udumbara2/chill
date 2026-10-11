import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PairingManager,
  RELAY_KEYS,
  qrRenderPlan,
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

test('startPairing：caMaterial 随铸造上传 + 回读自校验；不传则无 body、QR 无 caCert 键', async () => {
  const { manager } = makeManager()
  const caB64 = Buffer.from('fake-ca-bytes').toString('base64')
  const cfg = { ...CONFIG, caFP: 'fp-1' }
  {
    const { http, requests, queue } = fakeHttp()
    queue.push({ status: 200, json: { token: 'tok-2', expires: 1 } })
    queue.push({ status: 200, json: { caB64 } }) // GET /pair/ca/fp-1 自校验回读
    const { qr } = await manager.startPairing(http, cfg, '测试电脑', { caB64 })
    assert.equal(requests[0]!.method, 'POST')
    assert.equal(requests[0]!.path, '/pair/tokens')
    assert.deepEqual(requests[0]!.body, { caB64 }) // 上传载荷=原始文件字节 base64
    assert.equal(requests[1]!.method, 'GET')
    assert.equal(requests[1]!.path, '/pair/ca/fp-1') // 指纹寻址回读
    assert.equal('caCert' in qr, false) // QR 只承载锚（R2：发射侧退役）
    assert.equal(qr.caFP, 'fp-1')
  }
  {
    const { http: h2, requests: r2, queue: q2 } = fakeHttp()
    q2.push({ status: 200, json: { token: 'tok-3', expires: 1 } })
    const { qr: qr2 } = await manager.startPairing(h2, CONFIG, '测试电脑')
    assert.equal('body' in r2[0]!, false) // 无 CA 场景不带上传体（旧中继零感知）
    assert.equal('caCert' in qr2, false)
    assert.equal(r2.length, 1) // 无自校验 GET
  }
})

test('startPairing 自校验：寻址不通（旧中继）→ 可行动硬错误；往返不一致 → 硬错误', async () => {
  const { manager } = makeManager()
  const cfg = { ...CONFIG, caFP: 'fp-1' }
  const caB64 = Buffer.from('fake-ca-bytes').toString('base64')
  {
    const { http, queue } = fakeHttp()
    queue.push({ status: 200, json: { token: 'tok', expires: 1 } })
    queue.push({ status: 404, json: null }) // 旧中继无 /pair/ca 路由
    await assert.rejects(
      () => manager.startPairing(http, cfg, '测试电脑', { caB64 }),
      /版本过旧/,
    )
  }
  {
    const { http, queue } = fakeHttp()
    queue.push({ status: 200, json: { token: 'tok', expires: 1 } })
    queue.push({ status: 200, json: { caB64: 'different' } }) // 往返不一致
    await assert.rejects(
      () => manager.startPairing(http, cfg, '测试电脑', { caB64 }),
      /往返不一致/,
    )
  }
})

test('qrRenderPlan：渲染参数随载荷自适应（2026-10-11 真机实测教训回归锚）', async () => {
  const small = qrRenderPlan(400)
  assert.equal(small.terminalOk, true) // 小载荷终端码仍可用
  assert.equal(small.errorCorrectionLevel, 'M')
  const mid = qrRenderPlan(800)
  assert.equal(mid.terminalOk, false) // 超终端上限即弃终端码（行数洪泛控制）
  const big = qrRenderPlan(1900)
  assert.equal(big.terminalOk, false)
  assert.equal(big.errorCorrectionLevel, 'L') // 容量优先 → 版本更低 → 模块更少更大
  assert.ok(big.pxPerModule >= 5 && big.margin >= 4)
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

test('waitForRedeem 取消谓词：关码即 aborted（终检后即刻退场，不再轮询）', async () => {
  const { manager } = makeManager()
  const { http, requests, setFallback } = fakeHttp()
  setFallback({ status: 200, json: { state: 'pending' } }) // 常规拍与终检都=未扫上
  const r = await manager.waitForRedeem(http, 'tok', 1_700_000_600_000, Promise.resolve())
  assert.deepEqual(r, { state: 'aborted' })
  // 至多"一拍常规轮询 + 一次终态复查"即退场（首拍前信号已 resolve 时微任务时序不定，
  // 两种合法路径：直接终检=1 次 / 先常规拍再终检=2 次——不会更多）
  assert.ok(requests.length >= 1 && requests.length <= 2)
  assert.ok(requests.every((q) => q.path === '/pair/status'))
})

test('waitForRedeem 取消竞态：关码前手机刚好扫上 → redeemed 优先于 aborted', async () => {
  const { manager } = makeManager()
  const { http, requests, queue } = fakeHttp()
  queue.push({ status: 200, json: { state: 'redeemed', phonePub: 'phone-pub', device: '测试手机' } })
  const r = await manager.waitForRedeem(http, 'tok', 1_700_000_600_000, Promise.resolve())
  assert.deepEqual(r, { state: 'redeemed', phonePub: 'phone-pub', device: '测试手机' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/pair/status')
})

test('waitForRedeem 取消即时性：sleep 期间信号到达 → race 即刻唤醒，不等剩余轮询拍', async () => {
  // 真 sleep + 短轮询拍（50ms）：验证关码→aborted 的延迟远小于一个轮询拍
  const manager2 = new PairingManager({
    secureStorage: fakeSecureStorage(),
    deviceStore: fakeDeviceStore(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs: 50,
  })
  const { http, setFallback } = fakeHttp()
  setFallback({ status: 200, json: { state: 'pending' } })
  let giveUp!: () => void
  const cancelled = new Promise<void>((resolve) => (giveUp = resolve))
  const p = manager2.waitForRedeem(http, 'tok', Date.now() + 600_000, cancelled)
  await new Promise((r) => setTimeout(r, 80)) // 让第一拍轮询进入 sleep
  const t0 = Date.now()
  giveUp()
  const r = await p
  assert.deepEqual(r, { state: 'aborted' })
  assert.ok(Date.now() - t0 < 40, '取消应在远小于 50ms 轮询拍内完成（race 即刻唤醒）')
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
