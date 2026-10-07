export interface ISecureStorage {
  storeApiKey(provider: string, apiKey: string): Promise<boolean>
  getApiKey(provider: string): Promise<string | null>
  hasApiKey(provider: string): Promise<boolean>
  deleteApiKey(provider: string): Promise<boolean>
  getAllProviders(): Promise<string[]>
}
