import type { ISecureStorage } from '../interfaces/ISecureStorage'

export class SecureStorageService {
  private static _storage: ISecureStorage | null = null

  public static initialize(storage: ISecureStorage): void {
    SecureStorageService._storage = storage
  }

  static async storeApiKey(provider: string, apiKey: string): Promise<boolean> {
    if (!this._storage) {
      throw new Error('SecureStorageService is not initialized. Call initialize() first.')
    }
    return this._storage.storeApiKey(provider, apiKey)
  }

  static async getApiKey(provider: string): Promise<string | null> {
    if (!this._storage) {
      throw new Error('SecureStorageService is not initialized. Call initialize() first.')
    }
    return this._storage.getApiKey(provider)
  }

  static async hasApiKey(provider: string): Promise<boolean> {
    if (!this._storage) {
      throw new Error('SecureStorageService is not initialized. Call initialize() first.')
    }
    return this._storage.hasApiKey(provider)
  }

  static async deleteApiKey(provider: string): Promise<boolean> {
    if (!this._storage) {
      throw new Error('SecureStorageService is not initialized. Call initialize() first.')
    }
    return this._storage.deleteApiKey(provider)
  }

  static async getAllProviders(): Promise<string[]> {
    if (!this._storage) {
      throw new Error('SecureStorageService is not initialized. Call initialize() first.')
    }
    return this._storage.getAllProviders()
  }
}
