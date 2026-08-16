import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { ISecureStorage } from '@assistant-ai/core'
import { NodePathProvider, AESGCMCrypto } from '@assistant-ai/core'

const KEYS_DIR = 'keys'

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

  private keyFilePath(provider: string): string {
    return join(this.getKeysDir(), `${provider}.key`)
  }

  async storeApiKey(provider: string, apiKey: string): Promise<boolean> {
    try {
      const filePath = this.keyFilePath(provider)
      const encrypted = AESGCMCrypto.encrypt(this.masterKey, apiKey)
      writeFileSync(filePath, encrypted)
      chmodSync(filePath, 0o600)
      return true
    } catch (error) {
      console.error(`[CLISecureStorage] 存储 API Key 失败 (${provider}):`, error)
      return false
    }
  }

  async getApiKey(provider: string): Promise<string | null> {
    try {
      const filePath = this.keyFilePath(provider)
      if (!existsSync(filePath)) return null
      const data = readFileSync(filePath)
      return AESGCMCrypto.decrypt(this.masterKey, data)
    } catch (error) {
      console.error(`[CLISecureStorage] 读取 API Key 失败 (${provider}):`, error)
      return null
    }
  }

  async hasApiKey(provider: string): Promise<boolean> {
    return existsSync(this.keyFilePath(provider))
  }

  async deleteApiKey(provider: string): Promise<boolean> {
    try {
      const filePath = this.keyFilePath(provider)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
      return true
    } catch (error) {
      console.error(`[CLISecureStorage] 删除 API Key 失败 (${provider}):`, error)
      return false
    }
  }

  async getAllProviders(): Promise<string[]> {
    try {
      const keysDir = this.getKeysDir()
      return readdirSync(keysDir)
        .filter(f => f.endsWith('.key'))
        .map(f => f.replace('.key', ''))
    } catch {
      return []
    }
  }

  /** 列出 keys 目录下全部 .key 文件名（供 providerKeyMigration 使用） */
  listKeyFiles(): string[] {
    try {
      return readdirSync(this.getKeysDir()).filter(f => f.endsWith('.key'))
    } catch {
      return []
    }
  }

  /** 重命名 key 文件（目标已存在或源不存在时返回 false，不覆盖） */
  renameKey(oldName: string, newName: string): boolean {
    try {
      const oldPath = this.keyFilePath(oldName)
      const newPath = this.keyFilePath(newName)
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
}
