/**
 * 能力网关：安全存储（M1.5 四件套之二）
 *
 * 与 CLI 的 CLISecureStorage 同一信任根：core AESGCMCrypto 主钥 + ~/.chill/keys/ 编码文件名
 * （storageKeyFor）+ 凭据索引。逻辑 API 面 = ISecureStorage 五方法（迁移原语不暴露——
 * 那是 CLI 迁移器的专用通道）。已知债：CLISecureStorage 与本类的加密落盘逻辑高度重合，
 * rule of three 凑齐（CLI/Electron/daemon）后按规划第七节下沉 core（届时本类变薄壳）。
 */
import {
  NodePathProvider,
  AESGCMCrypto,
  storageKeyFor,
  loadCredentialIndex,
  saveCredentialIndex,
  upsertCredentialEntry,
  logicalNameForStorageStem,
  type KeyDirTextOps,
} from '@assistant-ai/core'
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const KEYS_DIR = 'keys'

export class WebSecureStorage {
  private basePath: string
  private masterKey: Buffer

  constructor(userDataPath?: string) {
    this.basePath = userDataPath ?? new NodePathProvider().getUserDataPath()
    mkdirSync(this.basePath, { recursive: true })
    this.masterKey = AESGCMCrypto.initMasterKey(this.basePath)
  }

  private keysDir(): string {
    const dir = join(this.basePath, KEYS_DIR)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private keyFilePath(logicalId: string): string {
    return join(this.keysDir(), `${storageKeyFor(logicalId)}.key`)
  }

  private legacyFilePath(logicalId: string): string {
    return join(this.keysDir(), `${logicalId}.key`)
  }

  private existingPathFor(logicalId: string): string | null {
    const encoded = this.keyFilePath(logicalId)
    if (existsSync(encoded)) return encoded
    const legacy = this.legacyFilePath(logicalId)
    if (existsSync(legacy)) return legacy
    return null
  }

  private indexOps(): KeyDirTextOps {
    const dir = this.keysDir()
    return {
      readText: (name) => {
        try {
          return readFileSync(join(dir, name), 'utf-8')
        } catch {
          return null
        }
      },
      writeText: (name, content) => {
        try {
          writeFileSync(join(dir, name), content)
          return true
        } catch {
          return false
        }
      },
      rename: () => false, // 迁移原语不在 web 面暴露，恒不调用
      remove: (name) => {
        try {
          unlinkSync(join(dir, name))
        } catch { /* 幂等 */ }
      },
    }
  }

  async storeApiKey(provider: string, apiKey: string): Promise<boolean> {
    try {
      const filePath = this.keyFilePath(provider)
      writeFileSync(filePath, AESGCMCrypto.encrypt(this.masterKey, apiKey))
      chmodSync(filePath, 0o600)
      const ops = this.indexOps()
      const idx = loadCredentialIndex(ops)
      upsertCredentialEntry(idx, provider, storageKeyFor(provider))
      saveCredentialIndex(ops, idx)
      return true
    } catch {
      return false
    }
  }

  async getApiKey(provider: string): Promise<string | null> {
    try {
      const filePath = this.existingPathFor(provider)
      if (!filePath) return null
      return AESGCMCrypto.decrypt(this.masterKey, readFileSync(filePath))
    } catch {
      return null
    }
  }

  async deleteApiKey(provider: string): Promise<boolean> {
    try {
      for (const p of [this.keyFilePath(provider), this.legacyFilePath(provider)]) {
        if (existsSync(p)) unlinkSync(p)
      }
      return true
    } catch {
      return false
    }
  }

  async getAllProviders(): Promise<string[]> {
    try {
      const ops = this.indexOps()
      const idx = loadCredentialIndex(ops)
      return readdirSync(this.keysDir())
        .filter(f => f.endsWith('.key'))
        .map(f => f.slice(0, -4))
        .map(stem => logicalNameForStorageStem(stem, idx))
    } catch {
      return []
    }
  }
}
