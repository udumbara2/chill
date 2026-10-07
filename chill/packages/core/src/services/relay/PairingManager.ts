/**
 * PairingManager.ts — 配对管理（M2，Node-free）。
 *
 * 职责：设备密钥对生成/持久化（注入的 secureStorage）、POST /pair/tokens
 * （运营者密钥从 secureStorage 读）、QR JSON 组装、GET /pair/status 轮询状态机
 * （2s 间隔 / deadline = expires+30s / 终态即停）、配对记录落盘（注入的 DeviceStore，
 * 壳侧落到 ~/.chill/relay/devices.json）。
 * 网络（RelayHttp）与存储全部依赖注入，不直接 import node 模块。
 */
import { generateKeyPair, keyPairFromSecretKey, ecdhShared, deriveSecrets, mailboxIdFromPub, b64uDecode, b64uEncode, type KeyPairB64, type DerivedSecrets } from './envelope'
import { sha256 } from '@noble/hashes/sha256'
import type { ISecureStorage } from '../../interfaces/ISecureStorage'
import type { RelayHttp } from './RelayTransport'

/** 装饰性 6 位数字指纹（设计文档：仅为带外肉眼核对的装饰，非防御；QR+pairingMAC 才是信任锚） */
export function decorativeFingerprint(deskPubB64u: string, phonePubB64u: string): string {
  const d = b64uDecode(deskPubB64u)
  const p = b64uDecode(phonePubB64u)
  const both = new Uint8Array(d.length + p.length)
  both.set(d, 0)
  both.set(p, d.length)
  const h = sha256(both)
  const n = ((h[0]! | (h[1]! << 8) | (h[2]! << 16) | (h[3]! << 24)) >>> 0) % 1_000_000
  return String(n).padStart(6, '0')
}

/** QR caFP（冻结口径）：CA 证书文件字节的 SHA-256，base64url（手机端读取同一文件计算比对） */
export function caFingerprint(caFileBytes: Uint8Array): string {
  return b64uEncode(sha256(caFileBytes))
}

/** secureStorage 键（复用 API-key 形状的 provider 命名空间） */
export const RELAY_KEYS = {
  deviceSecretKey: 'relay.deviceSecretKey',
  operatorKey: 'relay.operatorKey',
  relayUrl: 'relay.relayUrl',
  caFP: 'relay.caFP',
  /** CA 证书文件路径（壳侧 TLS pinning 用；/pair config 写入） */
  caPath: 'relay.caPath',
  /** 配对令牌（pairingMAC 的本地 HMAC key；配对完成时留存供 hello/confirm 重验，revoke 时清除） */
  pairingToken: 'relay.pairingToken',
} as const

export interface PairedDevice {
  phonePub: string
  device: string
  pairedAt: string
}

/** 配对记录落盘适配器（壳侧：~/.chill/relay/devices.json） */
export interface DeviceStore {
  read(): Promise<PairedDevice[]>
  write(devices: PairedDevice[]): Promise<void>
}

export interface RelayConfig {
  relayUrl: string
  operatorKey: string
  caFP: string
}

/** QR JSON schema（PROTOCOL-FROZEN 冻结项） */
export interface QrPayload {
  v: 1
  relay: string
  deskPub: string
  caFP: string
  token: string
  name: string
}

export type PairingPollResult =
  | { state: 'redeemed'; phonePub: string; device: string }
  | { state: 'expired' }
  | { state: 'timeout' }

export interface PairingManagerDeps {
  secureStorage: ISecureStorage
  deviceStore: DeviceStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** status 轮询间隔（默认 2s，测试可注入缩短） */
  pollIntervalMs?: number
}

export class PairingManager {
  private secureStorage: ISecureStorage
  private deviceStore: DeviceStore
  private now: () => number
  private sleep: (ms: number) => Promise<void>
  private pollIntervalMs: number

  constructor(deps: PairingManagerDeps) {
    this.secureStorage = deps.secureStorage
    this.deviceStore = deps.deviceStore
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000
  }

  // ---------- 配置（/pair config 写入；代码零默认地址） ----------

  async getRelayConfig(): Promise<RelayConfig | null> {
    const [relayUrl, operatorKey] = await Promise.all([
      this.secureStorage.getApiKey(RELAY_KEYS.relayUrl),
      this.secureStorage.getApiKey(RELAY_KEYS.operatorKey),
    ])
    if (!relayUrl || !operatorKey) return null
    const caFP = (await this.secureStorage.getApiKey(RELAY_KEYS.caFP)) ?? ''
    return { relayUrl, operatorKey, caFP }
  }

  async saveRelayConfig(config: RelayConfig & { caPath?: string }): Promise<void> {
    await this.secureStorage.storeApiKey(RELAY_KEYS.relayUrl, config.relayUrl)
    await this.secureStorage.storeApiKey(RELAY_KEYS.operatorKey, config.operatorKey)
    await this.secureStorage.storeApiKey(RELAY_KEYS.caFP, config.caFP)
    if (config.caPath !== undefined) {
      await this.secureStorage.storeApiKey(RELAY_KEYS.caPath, config.caPath)
    }
  }

  /** CA 证书文件路径（壳侧 TLS pinning 用；未配置为 null） */
  async getCaPath(): Promise<string | null> {
    return this.secureStorage.getApiKey(RELAY_KEYS.caPath)
  }

  // ---------- 设备密钥对（生成一次，持久化复用） ----------

  async getOrCreateDeviceKey(): Promise<KeyPairB64> {
    const existing = await this.secureStorage.getApiKey(RELAY_KEYS.deviceSecretKey)
    if (existing) return keyPairFromSecretKey(existing)
    const kp = generateKeyPair()
    await this.secureStorage.storeApiKey(RELAY_KEYS.deviceSecretKey, kp.secretKey)
    return kp
  }

  // ---------- 配对流程 ----------

  /**
   * 出码：POST /pair/tokens（运营者密钥鉴权）→ QR JSON 组装。
   * 调用方应同时启动 waitForRedeem 轮询，并（经租约仲裁）确保 relay 传输在线。
   */
  async startPairing(http: RelayHttp, config: RelayConfig, name: string): Promise<{ qr: QrPayload; expires: number }> {
    const desk = await this.getOrCreateDeviceKey()
    const r = await http.request('POST', '/pair/tokens', { token: config.operatorKey })
    if (r.status !== 200) throw new Error(`签发配对令牌失败: HTTP ${r.status}`)
    const { token, expires } = r.json as { token: string; expires: number }
    const qr: QrPayload = { v: 1, relay: config.relayUrl, deskPub: desk.publicKey, caFP: config.caFP, token, name }
    return { qr, expires }
  }

  /**
   * status 轮询状态机：2s 间隔，deadline = expires + 30s；
   * redeemed → 携带 phonePub/device；expired → 提示重新出码（无警报）；终态即停。
   */
  async waitForRedeem(http: RelayHttp, token: string, expires: number): Promise<PairingPollResult> {
    const deadline = expires + 30_000
    for (;;) {
      if (this.now() > deadline) return { state: 'timeout' }
      const r = await http.request('GET', '/pair/status', { token })
      if (r.status === 200) {
        const s = r.json as { state: string; phonePub?: string; device?: string }
        if (s.state === 'redeemed') return { state: 'redeemed', phonePub: s.phonePub!, device: s.device! }
        if (s.state === 'expired') return { state: 'expired' }
      }
      await this.sleep(this.pollIntervalMs)
    }
  }

  /**
   * 配对落定：配对记录落盘 + 配对令牌留存 secureStorage（pairingMAC 重验的本地 HMAC key）。
   * 密钥派生物不落盘——每次会话由 deviceSecretKey + phonePub 现算（见 deriveForDevice）。
   */
  async completePairing(phonePub: string, device: string, pairingToken: string): Promise<void> {
    // 单设备 MVP 语义：重配对 = 替换全部旧配对。
    // 服务器侧 redeem 会用最新共享密钥的令牌哈希覆盖桌面信箱（UPSERT），
    // 旧配对的凭据在服务器上随之失效——本地若保留旧记录，bridge 会拿死令牌连出 401/1006 循环。
    const next = [{ phonePub, device, pairedAt: new Date(this.now()).toISOString() }]
    await this.deviceStore.write(next)
    await this.secureStorage.storeApiKey(RELAY_KEYS.pairingToken, pairingToken)
  }

  async listDevices(): Promise<PairedDevice[]> {
    return this.deviceStore.read()
  }

  /** 派生某台已配对设备的五个凭据（现算，不落盘） */
  async deriveForDevice(phonePub: string): Promise<{ secrets: DerivedSecrets; myBox: string; peerBox: string }> {
    const desk = await this.getOrCreateDeviceKey()
    const secrets = deriveSecrets(ecdhShared(desk.secretKey, phonePub))
    return {
      secrets,
      myBox: mailboxIdFromPub(desk.publicKey),
      peerBox: mailboxIdFromPub(phonePub),
    }
  }

  /** 留存的配对令牌（hello/confirm 的 pairingMAC 重验用；可能为 null） */
  async getPairingToken(): Promise<string | null> {
    return this.secureStorage.getApiKey(RELAY_KEYS.pairingToken)
  }

  /** 提前留存配对令牌（/pair 出码即存：跨端配对时当前在线端的 bridge 懒读它验 pairingMAC） */
  async savePairingToken(token: string): Promise<void> {
    await this.secureStorage.storeApiKey(RELAY_KEYS.pairingToken, token)
  }

  /**
   * revoke：DELETE /box/:mailboxId（revoke_token，任一端可注销对向）+ 删除本地记录 + 本地配对令牌作废。
   * 手机丢失场景的止血动作，无需 SSH 上服务器。
   */
  async revokeDevice(http: RelayHttp, phonePub: string): Promise<{ ok: boolean; status: number }> {
    const { secrets, peerBox } = await this.deriveForDevice(phonePub)
    const r = await http.request('DELETE', `/box/${peerBox}`, { token: secrets.revokeToken })
    const devices = await this.deviceStore.read()
    await this.deviceStore.write(devices.filter((d) => d.phonePub !== phonePub))
    await this.secureStorage.deleteApiKey(RELAY_KEYS.pairingToken)
    return { ok: r.status === 204, status: r.status }
  }
}
