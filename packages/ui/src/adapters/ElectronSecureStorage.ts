/// <reference path="../env.d.ts" />

import type { ISecureStorage } from '@assistant-ai/core'

export class ElectronSecureStorage implements ISecureStorage {
  async storeApiKey(provider: string, apiKey: string): Promise<boolean> {
    const result = await window.electronAPI.storeApiKey(provider, apiKey)
    return result.success
  }

  async getApiKey(provider: string): Promise<string | null> {
    return window.electronAPI.getApiKey(provider)
  }

  async hasApiKey(provider: string): Promise<boolean> {
    const apiKey = await this.getApiKey(provider)
    return apiKey !== null && apiKey.length > 0
  }

  async deleteApiKey(provider: string): Promise<boolean> {
    return window.electronAPI.deleteApiKey(provider)
  }

  async getAllProviders(): Promise<string[]> {
    return window.electronAPI.getAllProviders()
  }
}
