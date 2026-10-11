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
import type { RelayHttp, RelayHttpResult } from './RelayTransport'

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

/** 终端半块码可扫载荷上限（2026-10-11 真机实测教训）：终端码有反色 + 字符纵横比失真两重天生缺陷，
 *  历史小配对码（~450B）勉强可扫，载荷过千后是彻头彻尾的不可扫之墙——超限一律不出终端码 */
export const QR_TERMINAL_MAX_BYTES = 600

/** 大载荷阈值（含 caCert 的配对码 ~1.9KB 落在此档） */
export const QR_BIG_PAYLOAD_BYTES = 1024

/**
 * QR 渲染物理计划（纯函数，三壳共用单源）：**渲染参数必须随载荷自适应**——QR 模块数随载荷增长，
 * 任何固定宽度/固定策略的渲染都注定在某个载荷尺寸下翻车（2026-10-11 实测：固定 480px/EC M 的
 * PNG 与终端半块码在 1.9KB 配对码上全部扫不出）。大载荷档：纠错降 L（容量优先=版本更低=模块更少
 * 更大）+ 每模块像素加宽 + 静区加大；壳侧只补各自的显示像素预算（CLI 查看器预算宽 / UI 卡片预算宽），
 * 严禁壳侧再写死渲染参数。
 */
export function qrRenderPlan(payloadBytes: number): {
  terminalOk: boolean
  errorCorrectionLevel: 'L' | 'M'
  pxPerModule: number
  margin: number
} {
  const terminalOk = payloadBytes <= QR_TERMINAL_MAX_BYTES
  const big = payloadBytes > QR_BIG_PAYLOAD_BYTES
  return {
    terminalOk,
    errorCorrectionLevel: big ? 'L' : 'M',
    pxPerModule: big ? 5 : 4,
    margin: big ? 4 : 2,
  }
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

/** QR JSON schema（PROTOCOL-FROZEN 冻结项；additive 字段只增不改不删） */
export interface QrPayload {
  v: 1
  relay: string
  deskPub: string
  caFP: string
  token: string
  name: string
  /**
   * CA 证书（additive；**发射侧已退役**——配对小码规划 R2：QR 只承载锚，材料经
   * GET /pair/ca/:fp 指纹寻址取材）。类型保留供手机端过渡期消费旧桌面出的码；
   * 双份契约另一侧=chill-mobile src/relay/session.ts QrPayload（手维护互指）。
   */
  caCert?: string
}

export type PairingPollResult =
  | { state: 'redeemed'; phonePub: string; device: string }
  | { state: 'expired' }
  | { state: 'timeout' }
  /** 用户关闭二维码视图等主动取消（2026-10-12：手动收码后 /pair 命令被 waitForRedeem
   *  占道最长 10min——取消谓词让流程即刻干净退场；取消前终检防"扫上了却被当取消"） */
  | { state: 'aborted' }

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
   *
   * caMaterial（可选，规划·配对小码 R2）：base64(CA 文件原始字节)——随铸造上传中继的
   * 指纹寻址缓存；QR 只承载锚（caFP），证书材料由手机经 GET /pair/ca/:fp 取材并按锚校验。
   * 上传后**回读自校验**（信任锚不静默降级）：寻址不通/往返不一致 → 硬错误（多为中继
   * 版本过旧，文案可行动）。不传（公共证书/家庭 ws）= 无 CA 场景，行为与旧版逐位一致。
   */
  async startPairing(
    http: RelayHttp,
    config: RelayConfig,
    name: string,
    caMaterial?: { caB64: string },
  ): Promise<{ qr: QrPayload; expires: number }> {
    const desk = await this.getOrCreateDeviceKey()
    const r = await http.request('POST', '/pair/tokens', {
      token: config.operatorKey,
      ...(caMaterial ? { body: { caB64: caMaterial.caB64 } } : {}),
    })
    if (r.status !== 200) throw new Error(`签发配对令牌失败: HTTP ${r.status}`)
    const { token, expires } = r.json as { token: string; expires: number }
    if (caMaterial) {
      if (!config.caFP) throw new Error('配置缺 caFP（CA 模式必须与 caPath 成对）——请重新 /pair config')
      const verify = await http.request('GET', `/pair/ca/${config.caFP}`, {})
      if (verify.status !== 200) {
        throw new Error(
          `配对证书缓存未生效（HTTP ${verify.status}，中继版本过旧或存储失败）——请升级服务器上的 @assistant-ai/chill-relay 后重试`,
        )
      }
      const got = (verify.json as { caB64?: string } | null)?.caB64
      if (got !== caMaterial.caB64) throw new Error('配对证书缓存往返不一致（中继存储异常）——请检查 chill-relay')
    }
    const qr: QrPayload = { v: 1, relay: config.relayUrl, deskPub: desk.publicKey, caFP: config.caFP, token, name }
    return { qr, expires }
  }

  /**
   * status 轮询状态机：2s 间隔，deadline = expires + 30s；
   * redeemed → 携带 phonePub/device；expired → 提示重新出码（无警报）；终态即停。
   * cancelled（可选 promise，resolve/reject 均视为放弃）：经 race 让 sleep/在途请求即刻让位——
   * 取消延迟=一次终检 RTT，而非最长 2s 轮询拍（"关码后马上重输 /pair 不吃命令门"）。
   * 取消前终态复查：redeemed 优先于 aborted（关码前手机可能刚好扫上，2s 轮询窗内的
   * 竞态以服务器事实为准，防"手机已登记、桌面无记录"的半截配对）。
   */
  async waitForRedeem(
    http: RelayHttp,
    token: string,
    expires: number,
    cancelled?: Promise<unknown>,
  ): Promise<PairingPollResult> {
    const deadline = expires + 30_000
    const CANCELLED = Symbol('pairing-cancelled')
    let cancelSeen = false
    const onGiveUp = (): symbol => {
      cancelSeen = true
      return CANCELLED
    }
    // 哑信号：未传 cancelled 时永不 resolve——race 语义等价于无取消
    const cancelRace = cancelled ? cancelled.then(onGiveUp, onGiveUp) : new Promise<symbol>(() => {})
    for (;;) {
      if (this.now() > deadline) return { state: 'timeout' }
      if (cancelSeen) {
        const r = await http.request('GET', '/pair/status', { token })
        if (r.status === 200) {
          const s = r.json as { state: string; phonePub?: string; device?: string }
          if (s.state === 'redeemed') return { state: 'redeemed', phonePub: s.phonePub!, device: s.device! }
        }
        return { state: 'aborted' }
      }
      const raced = await Promise.race([http.request('GET', '/pair/status', { token }), cancelRace])
      if (raced === CANCELLED) continue // 回循环顶走终检→aborted（sleep 已被 race 即刻唤醒，零等待）
      const r = raced as RelayHttpResult
      if (r.status === 200) {
        const s = r.json as { state: string; phonePub?: string; device?: string }
        if (s.state === 'redeemed') return { state: 'redeemed', phonePub: s.phonePub!, device: s.device! }
        if (s.state === 'expired') return { state: 'expired' }
      }
      await Promise.race([this.sleep(this.pollIntervalMs), cancelRace])
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
