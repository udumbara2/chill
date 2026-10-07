/**
 * 凭证存储键编解码（唯一事实点）
 *
 * 逻辑 ID（如 `xiaomi#token-plan-cn.xiaomimimo.com/v1`、`relay.operatorKey`）永不直接
 * 当文件名——经本模块编码为文件名安全存储键，双射可逆，寻址正确性只依赖编解码本身，
 * 不依赖任何索引状态（V2）。
 *
 * 编码形态（大小写不敏感文件系统安全，纯大写）：
 * - 完整式：`B` + base32(UTF-8(逻辑ID))，可逆（storageKeyToLogical + 往返校验）
 * - 超长式：`B` + base32(截断) + `-` + base32(FNV-1a-64)，寻址仍确定性，解码不可逆
 *   （展示名走 keys/index.json）；`-` 不在 base32 字母表，可作截断标记
 *
 * 纪律：凡「逻辑名 → 文件名」转换必须经本模块；models/ 卡文件名走安全字符集校验（同 V2）。
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const B32_LOOKUP: Record<string, number> = {}
for (let i = 0; i < B32_ALPHABET.length; i++) B32_LOOKUP[B32_ALPHABET[i]] = i

/** 完整式输出上限（留足 .key 后缀与目录路径余量）；超过走截断式 */
const MAX_STEM = 180
const TRUNC_KEEP = 120

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b)
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(s: string): Uint8Array | null {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s) {
    const idx = B32_LOOKUP[ch]
    if (idx === undefined) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** FNV-1a 64 位（纯 JS，Node-free）；仅用于超长式的消歧后缀 */
function fnv1a64(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const b of bytes) {
    hash ^= BigInt(b)
    hash = (hash * prime) & mask
  }
  return hash
}

function hashSuffixBase32(logicalId: string): string {
  const h = fnv1a64(utf8Encode(logicalId))
  const bytes = new Uint8Array(8)
  let v = h
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return base32Encode(bytes)
}

/** 逻辑 ID → 文件名安全存储键（确定性、幂等） */
export function storageKeyFor(logicalId: string): string {
  const b32 = base32Encode(utf8Encode(logicalId))
  const full = 'B' + b32
  if (full.length <= MAX_STEM) return full
  return 'B' + b32.slice(0, TRUNC_KEEP) + '-' + hashSuffixBase32(logicalId)
}

/**
 * 存储键 → 逻辑 ID（可逆式经往返校验后解码；超长式与非编码名返回 null）。
 * 往返校验 = storageKeyFor(解码值) 必须等于输入，杜绝把存量裸名误解为编码名。
 */
export function storageKeyToLogical(storageKey: string): string | null {
  if (!/^B[A-Z2-7]*$/.test(storageKey)) return null
  const bytes = base32Decode(storageKey.slice(1))
  if (!bytes) return null
  const logical = utf8Decode(bytes)
  if (storageKeyFor(logical) !== storageKey) return null
  return logical
}

/** 是否本模块产出的存储键形态（含超长式）；用于迁移/列表的形态识别 */
export function isEncodedStorageKey(stem: string): boolean {
  return /^B[A-Z2-7]*(-[A-Z2-7]+)?$/.test(stem)
}

/** 模型卡文件名安全字符集（V2 全屋同规的 models/ 侧）：禁路径/Windows 非法字符与空白，允许 `-` `.` `@` 等 */
export function isSafeCardName(name: string): boolean {
  return /^[^\\/:*?"<>|\s\x00-\x1f]+$/.test(name) && name.length > 0 && name.length <= 120
}
