/**
 * add_model 端点默认派生 e2e（P0.7 验收）
 *
 * 覆盖三条链路：
 * 1. 内置供应商 + 省略 base_url/protocol → 从种子卡端点模板派生，成功落盘，且不重复建供应商
 * 2. 未知供应商 + 省略 base_url → 明确报错（提示非内置供应商、缺哪个字段）
 * 3. 未知供应商 + 显式 base_url/protocol → 正常新建供应商并落盘
 *
 * 单例服务（ProviderManager 等）要求文件级子进程隔离：本文件独立运行，不与其他场景共用进程。
 */
import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { providerManager } from '../../src/services/models/providerManager'
import { modelInfoService } from '../../src/services/models/modelInfoService'
import { SecureStorageService } from '../../src/services/secureStorageService'
import { SelectedModelsService } from '../../src/services/selectedModelsService'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor'
import type { IFileSystemProvider, FileSystemResult } from '../../src/interfaces/IFileSystemProvider'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore'

const tmp = mkdtempSync(join(tmpdir(), 'chill-addmodel-e2e-'))
const modelsDir = join(tmp, 'models')
mkdirSync(modelsDir, { recursive: true })

// --- Node fs 版 IFileSystemProvider（仅供本测试隔离使用）---
const fsProvider: IFileSystemProvider = {
  async readFile(p: string): Promise<FileSystemResult> {
    try {
      return { success: true, data: readFileSync(p, 'utf-8') }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  },
  async writeFile(p: string, content: string): Promise<FileSystemResult> {
    try {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  },
  async deleteFile(p: string): Promise<FileSystemResult> {
    try {
      unlinkSync(p)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  },
  async listDirectory(p: string): Promise<FileSystemResult> {
    try {
      return { success: true, data: readdirSync(p) }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  },
  getCurrentDirectory: () => null,
  async fileExists(p: string): Promise<FileSystemResult<boolean>> {
    return { success: true, data: existsSync(p) }
  },
  async getPathType(p: string): Promise<FileSystemResult> {
    try {
      return { success: true, data: statSync(p).isDirectory() ? 'directory' : 'file' }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }
}

// --- 内存 SecureStorage / KV Store（绝不触碰 ~/.chill）---
const memKeys = new Map<string, string>()
const memStorage: ISecureStorage = {
  async storeApiKey(id: string, key: string) { memKeys.set(id, key); return true },
  async getApiKey(id: string) { return memKeys.get(id) ?? null },
  async hasApiKey(id: string) { return memKeys.has(id) },
  async deleteApiKey(id: string) { return memKeys.delete(id) },
  async getAllProviders() { return [...memKeys.keys()] }
}
const memKV: IKeyValueStore = {
  store: new Map<string, string>(),
  getItem(k: string) { return this.store.get(k) ?? null },
  setItem(k: string, v: string) { this.store.set(k, v) },
  removeItem(k: string) { this.store.delete(k) },
  clear() { this.store.clear() }
}

// --- 装配（注意：providerManager 的 fileSystemProvider 必须先设，否则 loadProviders 直接跳过，种子也不进 Map）---
providerManager.setFileSystemProvider(fsProvider)
providerManager.setProvidersDir(modelsDir)
await providerManager.loadProviders()
modelInfoService.setFileSystemProvider(fsProvider)
modelInfoService.setModelsDir(modelsDir)
await modelInfoService.loadAllModels()
SecureStorageService.initialize(memStorage)
SelectedModelsService.setDefaultStore(memKV)

const executor = new BuiltInToolExecutor(
  fsProvider,
  { requestConfirmation: async () => ({ approved: true }) } as any,
  { calculate: async () => 0 } as any,
  { execute: async () => ({ success: true }) } as any
)

test.after(() => { rmSync(tmp, { recursive: true, force: true }) })

test('内置供应商：省略 base_url/protocol → 端点模板派生 + 不重复建供应商', async () => {
  const r = await executor.executeAddModel({
    model_name: 'doubao-seed-2-0-lite-260215',
    provider: '火山方舟',
    api_key: 'test-key-volc',
    supported_modalities: 'text',
    max_context_tokens: 256000,
    max_output_tokens: 32768,
    supports_thinking: true
  } as any)

  assert.ok(r.success, `应成功：${(r as any).error ?? ''}`)
  const cardPath = join(modelsDir, 'doubao-seed-2-0-lite-260215.json')
  assert.ok(existsSync(cardPath), '模型卡应落盘')
  const card = JSON.parse(readFileSync(cardPath, 'utf-8'))
  assert.equal(card.adapterConfig.baseURL, 'https://ark.cn-beijing.volces.com/api/v3', 'baseURL 应从种子卡模板派生')
  assert.equal(card.adapterConfig.protocol, 'openai-chat')
  assert.equal(card.provider, '火山方舟')
  assert.equal(card.builtIn, false)
  // 火山方舟是种子供应商：不应触发 addProvider 写盘（providers.json 不应被创建）
  assert.ok(!existsSync(join(modelsDir, 'providers.json')), '内置供应商归属不应写出 providers.json')
  assert.ok(memKeys.has('volcengine'), 'Key 应存到稳定 id 命名空间 volcengine')
})

test('未知供应商：省略 base_url → 明确报错并指出缺失字段', async () => {
  const r = await executor.executeAddModel({
    model_name: 'mystery-model-x',
    provider: '某未知厂商',
    api_key: 'test-key-x',
    supported_modalities: 'text',
    max_context_tokens: 128000,
    max_output_tokens: 8192,
    supports_thinking: false
  } as any)

  assert.ok(!r.success, '未知供应商缺端点应失败')
  const err = (r as any).error as string
  assert.ok(err.includes('base_url'), `错误应指出缺 base_url：${err}`)
  assert.ok(err.includes('不是内置供应商'), `错误应说明非内置供应商：${err}`)
  assert.ok(!existsSync(join(modelsDir, 'mystery-model-x.json')), '失败路径不应落模型卡')
})

test('未知供应商：显式 base_url/protocol → 新建供应商并落盘', async () => {
  const r = await executor.executeAddModel({
    model_name: 'mystery-model-y',
    provider: '某未知厂商',
    api_key: 'test-key-y',
    supported_modalities: 'text',
    max_context_tokens: 128000,
    max_output_tokens: 8192,
    supports_thinking: false,
    base_url: 'https://api.mystery.example/v1',
    protocol: 'openai-chat'
  } as any)

  assert.ok(r.success, `应成功：${(r as any).error ?? ''}`)
  const card = JSON.parse(readFileSync(join(modelsDir, 'mystery-model-y.json'), 'utf-8'))
  assert.equal(card.adapterConfig.baseURL, 'https://api.mystery.example/v1')
  assert.ok(existsSync(join(modelsDir, 'providers.json')), '未知供应商应写出 providers.json')
  const providers = JSON.parse(readFileSync(join(modelsDir, 'providers.json'), 'utf-8'))
  assert.ok(providers.some((p: any) => p.name === '某未知厂商' && p.builtIn === false), '应新建自定义供应商条目')
})
