import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import type { IKeyValueStore } from '../../interfaces/IKeyValueStore'
import type { ISecureStorage } from '../../interfaces/ISecureStorage'
import type { MCPServerConfig } from '../../types/mcp'
import * as path from 'path'

interface ConnectionState {
  connected: boolean
  lastConnected?: number
}

const SENSITIVE_HEADER_KEYS = ['authorization', 'api-key', 'x-api-key', 'bearer', 'token', 'api_key', 'x_api_key']
const REGISTRY_FILE = '_registry.json'
const LEGACY_KV_KEY = 'mcp-configured-servers'
const KV_SERVER_PREFIX = 'mcp-server:'
const KV_NAMES_KEY = 'mcp-server-names'

function hasSensitiveHeaders(headers?: Record<string, string>): boolean {
  if (!headers) return false
  return Object.keys(headers).some(k => SENSITIVE_HEADER_KEYS.includes(k.toLowerCase()))
}

export class MCPConfigPersistence {
  private store: IKeyValueStore
  private secureStorage?: ISecureStorage
  private fs?: IFileSystemProvider
  private serverDir?: string
  private _migrated = false

  constructor(
    store: IKeyValueStore,
    secureStorage?: ISecureStorage,
    fsProvider?: IFileSystemProvider,
    serverDir?: string
  ) {
    this.store = store
    this.secureStorage = secureStorage
    this.fs = fsProvider
    this.serverDir = serverDir
  }

  private get _useFileStorage(): boolean {
    return !!(this.fs && this.serverDir)
  }

  // ── file-based read / write ──

  private _serverPath(name: string): string {
    return path.join(this.serverDir!, `${name}.json`)
  }

  private _registryPath(): string {
    return path.join(this.serverDir!, REGISTRY_FILE)
  }

  private async _fileRead(filePath: string): Promise<string | null> {
    if (!this.fs) return null
    const r = await this.fs.readFile(filePath)
    return r.success ? (typeof r.data === 'string' ? r.data : r.data?.content) ?? null : null
  }

  private async _fileWrite(filePath: string, content: string): Promise<boolean> {
    if (!this.fs) return false
    const r = await this.fs.writeFile(filePath, content)
    return r.success
  }

  private async _fileDelete(filePath: string): Promise<void> {
    if (!this.fs) return
    await this.fs.deleteFile(filePath)
  }

  private async _fileExists(filePath: string): Promise<boolean> {
    if (!this.fs) return false
    const r = await this.fs.fileExists(filePath)
    return r.success && r.data === true
  }

  // ── file-based load / save helpers ──

  private async _fileLoadOne(name: string): Promise<MCPServerConfig | null> {
    const raw = await this._fileRead(this._serverPath(name))
    if (!raw) return null
    try { return JSON.parse(raw) as MCPServerConfig } catch { return null }
  }

  private async _fileSaveOne(config: MCPServerConfig): Promise<void> {
    const name = config.name || 'unnamed'
    await this._fileWrite(this._serverPath(name), JSON.stringify(config, null, 2))
  }

  private async _fileDeleteOne(name: string): Promise<void> {
    await this._fileDelete(this._serverPath(name))
  }

  private async _fileLoadNames(): Promise<string[]> {
    const raw = await this._fileRead(this._registryPath())
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }

  private async _fileSaveNames(names: string[]): Promise<void> {
    await this._fileWrite(this._registryPath(), JSON.stringify(names, null, 2))
  }

  // ── KV-based helpers (fallback / migration source) ──

  private _kvLoadNames(): string[] {
    const raw = this.store.getItem(KV_NAMES_KEY)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }

  private _kvLoadOne(name: string): MCPServerConfig | null {
    const raw = this.store.getItem(`${KV_SERVER_PREFIX}${name}`)
    if (!raw) return null
    try { return JSON.parse(raw) as MCPServerConfig } catch { return null }
  }

  // ── migration ──

  private async _tryMigrate(): Promise<void> {
    if (this._migrated) return
    this._migrated = true

    if (!this._useFileStorage) return

    // If file registry already exists, nothing to migrate
    if (await this._fileExists(this._registryPath())) return

    // Try KV per-server keys first
    const names = this._kvLoadNames()

    if (names.length > 0) {
      for (const name of names) {
        const cfg = this._kvLoadOne(name)
        if (cfg) {
          await this._fileSaveOne(cfg)
          this.store.removeItem(`${KV_SERVER_PREFIX}${name}`)
        }
      }
      await this._fileSaveNames(names)
      this.store.removeItem(KV_NAMES_KEY)
    }

    // Try legacy single-key format
    const legacyRaw = this.store.getItem(LEGACY_KV_KEY)
    if (legacyRaw) {
      try {
        const legacy: MCPServerConfig[] = JSON.parse(legacyRaw)
        if (Array.isArray(legacy) && legacy.length > 0) {
          const fileNames = await this._fileLoadNames()
          const merged = new Set([...fileNames, ...names])
          for (const server of legacy) {
            const n = server.name || 'unnamed'
            if (!merged.has(n)) {
              await this._fileSaveOne(server)
              merged.add(n)
            }
          }
          await this._fileSaveNames([...merged])
        }
      } catch { /* ignore */ }
      this.store.removeItem(LEGACY_KV_KEY)
    }
  }

  // ── public API ──

  async loadServers(): Promise<MCPServerConfig[]> {
    await this._tryMigrate()

    if (this._useFileStorage) {
      return this._loadServersFromFiles()
    }
    return this._loadServersFromKV()
  }

  private async _loadServersFromFiles(): Promise<MCPServerConfig[]> {
    const names = await this._fileLoadNames()
    const servers: MCPServerConfig[] = []

    if (!this.secureStorage) {
      for (const name of names) {
        const cfg = await this._fileLoadOne(name)
        if (cfg) servers.push(cfg)
      }
      return servers
    }

    for (const name of names) {
      const cfg = await this._fileLoadOne(name)
      if (!cfg) continue
      const encryptedHeaders = await this.secureStorage.getApiKey(`mcp-${name}`)
      if (encryptedHeaders) {
        try { servers.push({ ...cfg, headers: JSON.parse(encryptedHeaders) }) }
        catch { servers.push(cfg) }
      } else {
        servers.push(cfg)
      }
    }
    return servers
  }

  private async _loadServersFromKV(): Promise<MCPServerConfig[]> {
    const names = this._kvLoadNames()
    const servers: MCPServerConfig[] = []

    if (!this.secureStorage) {
      for (const name of names) {
        const cfg = this._kvLoadOne(name)
        if (cfg) servers.push(cfg)
      }
      return servers
    }

    for (const name of names) {
      const cfg = this._kvLoadOne(name)
      if (!cfg) continue
      const encryptedHeaders = await this.secureStorage.getApiKey(`mcp-${name}`)
      if (encryptedHeaders) {
        try { servers.push({ ...cfg, headers: JSON.parse(encryptedHeaders) }) }
        catch { servers.push(cfg) }
      } else {
        servers.push(cfg)
      }
    }
    return servers
  }

  async saveServers(servers: MCPServerConfig[]): Promise<void> {
    await this._tryMigrate()

    if (this._useFileStorage) {
      await this._saveServersToFiles(servers)
    } else {
      await this._saveServersToKV(servers)
    }
  }

  private async _saveServersToFiles(servers: MCPServerConfig[]): Promise<void> {
    const newNames = new Set(servers.map(s => s.name || 'unnamed'))
    const oldNames = await this._fileLoadNames()

    for (const oldName of oldNames) {
      if (!newNames.has(oldName)) {
        await this._fileDeleteOne(oldName)
      }
    }

    const names: string[] = []
    for (const server of servers) {
      const name = server.name || 'unnamed'
      names.push(name)
      if (this.secureStorage && hasSensitiveHeaders(server.headers)) {
        await this.secureStorage.storeApiKey(`mcp-${name}`, JSON.stringify(server.headers))
        const { headers, ...rest } = server
        await this._fileSaveOne(rest as MCPServerConfig)
      } else {
        await this._fileSaveOne(server)
      }
    }
    await this._fileSaveNames(names)
  }

  private async _saveServersToKV(servers: MCPServerConfig[]): Promise<void> {
    const newNames = new Set(servers.map(s => s.name || 'unnamed'))
    const oldNames = this._kvLoadNames()
    for (const oldName of oldNames) {
      if (!newNames.has(oldName)) {
        this.store.removeItem(`${KV_SERVER_PREFIX}${oldName}`)
      }
    }

    const names: string[] = []
    for (const server of servers) {
      const name = server.name || 'unnamed'
      names.push(name)
      if (this.secureStorage && hasSensitiveHeaders(server.headers)) {
        await this.secureStorage.storeApiKey(`mcp-${name}`, JSON.stringify(server.headers))
        const { headers, ...rest } = server
        this.store.setItem(`${KV_SERVER_PREFIX}${name}`, JSON.stringify(rest))
      } else {
        this.store.setItem(`${KV_SERVER_PREFIX}${name}`, JSON.stringify(server))
      }
    }
    this.store.setItem(KV_NAMES_KEY, JSON.stringify(names))
  }

  async addServer(config: MCPServerConfig): Promise<void> {
    await this._tryMigrate()

    const name = config.name || 'unnamed'

    if (this._useFileStorage) {
      if (this.secureStorage && hasSensitiveHeaders(config.headers)) {
        await this.secureStorage.storeApiKey(`mcp-${name}`, JSON.stringify(config.headers))
        const { headers, ...rest } = config
        await this._fileSaveOne(rest as MCPServerConfig)
      } else {
        await this._fileSaveOne(config)
      }
      const names = await this._fileLoadNames()
      if (!names.includes(name)) {
        names.push(name)
        await this._fileSaveNames(names)
      }
    } else {
      if (this.secureStorage && hasSensitiveHeaders(config.headers)) {
        await this.secureStorage.storeApiKey(`mcp-${name}`, JSON.stringify(config.headers))
        const { headers, ...rest } = config
        this.store.setItem(`${KV_SERVER_PREFIX}${name}`, JSON.stringify(rest))
      } else {
        this.store.setItem(`${KV_SERVER_PREFIX}${name}`, JSON.stringify(config))
      }
      const names = this._kvLoadNames()
      if (!names.includes(name)) {
        names.push(name)
        this.store.setItem(KV_NAMES_KEY, JSON.stringify(names))
      }
    }
  }

  async removeServer(name: string): Promise<void> {
    await this._tryMigrate()

    if (this._useFileStorage) {
      await this._fileDeleteOne(name)
      const names = (await this._fileLoadNames()).filter(n => n !== name)
      await this._fileSaveNames(names)
    } else {
      this.store.removeItem(`${KV_SERVER_PREFIX}${name}`)
      const names = this._kvLoadNames().filter(n => n !== name)
      this.store.setItem(KV_NAMES_KEY, JSON.stringify(names))
    }

    try { await this.secureStorage?.deleteApiKey(`mcp-${name}`) } catch { /* ignore */ }
  }

  async updateServer(name: string, updates: Partial<MCPServerConfig>): Promise<void> {
    await this._tryMigrate()

    const existing = this._useFileStorage
      ? await this._fileLoadOne(name)
      : this._kvLoadOne(name)

    const merged = existing
      ? { ...existing, ...updates }
      : ({ name, ...updates } as MCPServerConfig)

    if (this._useFileStorage) {
      if (this.secureStorage && hasSensitiveHeaders(merged.headers)) {
        await this.secureStorage.storeApiKey(`mcp-${name}`, JSON.stringify(merged.headers))
        const { headers, ...rest } = merged
        await this._fileSaveOne(rest as MCPServerConfig)
      } else {
        await this._fileSaveOne(merged)
      }
      const names = await this._fileLoadNames()
      if (!names.includes(name)) {
        names.push(name)
        await this._fileSaveNames(names)
      }
    } else {
      if (this.secureStorage && hasSensitiveHeaders(merged.headers)) {
        await this.secureStorage.storeApiKey(`mcp-${name}`, JSON.stringify(merged.headers))
        const { headers, ...rest } = merged
        this.store.setItem(`${KV_SERVER_PREFIX}${name}`, JSON.stringify(rest))
      } else {
        this.store.setItem(`${KV_SERVER_PREFIX}${name}`, JSON.stringify(merged))
      }
      const names = this._kvLoadNames()
      if (!names.includes(name)) {
        names.push(name)
        this.store.setItem(KV_NAMES_KEY, JSON.stringify(names))
      }
    }
  }

  saveStates(states: Record<string, ConnectionState>): void {
    this.store.setItem('mcp-connection-states', JSON.stringify(states))
  }

  loadStates(): Record<string, ConnectionState> {
    const raw = this.store.getItem('mcp-connection-states')
    if (!raw) return {}
    try { return JSON.parse(raw) } catch { return {} }
  }
}
