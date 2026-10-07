import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, chmodSync, renameSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import type { ISecureStorage } from '@assistant-ai/core'
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

const KEYS_DIR = 'keys'

/**
 * 分层语义（V2/V3）：
 * - 逻辑 API（store/get/has/delete/getAllProviders）收**逻辑 ID**，文件名经 storageKeyFor 编码；
 * - 文件原语（listKeyFiles/renameKey）保持**物理文件名**语义（迁移器依赖「拿物理名改文件」契约）；
 * - 迁移期兼容：编码名优先、存量裸名回退（迁移完成后自然消失）。
 */
export class CLISecureStorage implements ISecureStorage {
  private basePath: string
  private masterKey: Buffer

  constructor() {
    this.basePath = new NodePathProvider().getUserDataPath()
    mkdirSync(this.basePath, { recursive: true })
    this.masterKey = AESGCMCrypto.initMasterKey(this.basePath)
  }

  private getKeysDir(): string {
    const dir = join(this.basePath, KEYS_DIR)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 物理 stem 路径（文件原语/迁移用；不编码） */
  private rawFilePath(stem: string): string {
    return join(this.getKeysDir(), `${stem}.key`)
  }

  /** 逻辑 ID 路径（逻辑 API 用；经存储键编码） */
  private keyFilePath(logicalId: string): string {
    return this.rawFilePath(storageKeyFor(logicalId))
  }

  /** 迁移期兼容查找：编码名优先，存量裸名回退 */
  private existingPathFor(logicalId: string): string | null {
    const encoded = this.keyFilePath(logicalId)
    if (existsSync(encoded)) return encoded
    const legacy = this.rawFilePath(logicalId)
    if (existsSync(legacy)) return legacy
    return null
  }

  private indexOps(): KeyDirTextOps {
    const dir = this.getKeysDir()
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
      rename: (from, to) => {
        try {
          renameSync(join(dir, from), join(dir, to))
          return true
        } catch {
          return false
        }
      },
      remove: (name) => {
        try {
          unlinkSync(join(dir, name))
        } catch {
          /* 不存在即幂等 */
        }
      },
    }
  }

  async storeApiKey(provider: string, apiKey: string): Promise<boolean> {
    try {
      const filePath = this.keyFilePath(provider)
      const encrypted = AESGCMCrypto.encrypt(this.masterKey, apiKey)
      writeFileSync(filePath, encrypted)
      chmodSync(filePath, 0o600)
      const ops = this.indexOps()
      const idx = loadCredentialIndex(ops)
      upsertCredentialEntry(idx, provider, storageKeyFor(provider))
      saveCredentialIndex(ops, idx)
      return true
    } catch (error) {
      console.error(`[CLISecureStorage] 存储 API Key 失败 (${provider}):`, error)
      return false
    }
  }

  async getApiKey(provider: string): Promise<string | null> {
    try {
      const filePath = this.existingPathFor(provider)
      if (!filePath) return null
      const data = readFileSync(filePath)
      return AESGCMCrypto.decrypt(this.masterKey, data)
    } catch (error) {
      console.error(`[CLISecureStorage] 读取 API Key 失败 (${provider}):`, error)
      return null
    }
  }

  async hasApiKey(provider: string): Promise<boolean> {
    return this.existingPathFor(provider) !== null
  }

  async deleteApiKey(provider: string): Promise<boolean> {
    try {
      for (const p of [this.keyFilePath(provider), this.rawFilePath(provider)]) {
        if (existsSync(p)) unlinkSync(p)
      }
      return true
    } catch (error) {
      console.error(`[CLISecureStorage] 删除 API Key 失败 (${provider}):`, error)
      return false
    }
  }

  async getAllProviders(): Promise<string[]> {
    try {
      const ops = this.indexOps()
      const idx = loadCredentialIndex(ops)
      return readdirSync(this.getKeysDir())
        .filter(f => f.endsWith('.key'))
        .map(f => f.slice(0, -4))
        .map(stem => logicalNameForStorageStem(stem, idx))
    } catch {
      return []
    }
  }

  /** 列出 keys 目录下全部 .key 文件名（物理名，供 providerKeyMigration / keyStorageMigration 使用） */
  listKeyFiles(): string[] {
    try {
      return readdirSync(this.getKeysDir()).filter(f => f.endsWith('.key'))
    } catch {
      return []
    }
  }

  /** 重命名 key 文件（物理 stem → 物理 stem；目标已存在或源不存在时返回 false，不覆盖） */
  renameKey(oldName: string, newName: string): boolean {
    try {
      const oldPath = this.rawFilePath(oldName)
      const newPath = this.rawFilePath(newName)
      if (!existsSync(oldPath) || existsSync(newPath)) return false
      writeFileSync(newPath, readFileSync(oldPath))
      chmodSync(newPath, 0o600)
      unlinkSync(oldPath)
      return true
    } catch (error) {
      console.error(`[CLISecureStorage] 重命名 API Key 失败 (${oldName} -> ${newName}):`, error)
      return false
    }
  }

  /** 迁移前置备份（4a 幂等据点）：keys/ → keys.backup-<ts>/，已有备份则复用（created=false 静默） */
  backupKeysDir(): { name: string; created: boolean } | null {
    try {
      const dir = this.getKeysDir()
      const existing = readdirSync(this.basePath).find(n => n.startsWith('keys.backup-'))
      if (existing) return { name: existing, created: false }
      const name = `keys.backup-${Date.now()}`
      cpSync(dir, join(this.basePath, name), { recursive: true })
      return { name, created: true }
    } catch (error) {
      console.error('[CLISecureStorage] keys 目录备份失败:', error)
      return null
    }
  }
}
