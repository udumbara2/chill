import type { ISecureStorage } from '@assistant-ai/core'
import { getHostAPI } from '../host/hostApi'

export class ElectronSecureStorage implements ISecureStorage {
  async storeApiKey(provider: string, apiKey: string): Promise<boolean> {
    const result = await getHostAPI().storeApiKey(provider, apiKey)
    return result.success
  }

  async getApiKey(provider: string): Promise<string | null> {
    return getHostAPI().getApiKey(provider)
  }

  async hasApiKey(provider: string): Promise<boolean> {
    const apiKey = await this.getApiKey(provider)
    return apiKey !== null && apiKey.length > 0
  }

  async deleteApiKey(provider: string): Promise<boolean> {
    return getHostAPI().deleteApiKey(provider)
  }

  async getAllProviders(): Promise<string[]> {
    return getHostAPI().getAllProviders()
  }
}
