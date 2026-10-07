/**
 * I2 验收：身份/绑定分层 + 请求字段纯化（任务 12）
 *
 * 覆盖：
 * 1. 同身份绑两域生成两项、请求字段无本地名（apiModelId/defaultModel/availableModels 只装上游 ID）、
 *    显示名拼装「身份 · 通道短名」、合并层白名单（customConfig 不得覆盖凭证/端点）
 * 2. 旧格式卡可加载、modify 后转新格式（补齐 apiModelId）
 * 3. 状态 ✓/✗ 与运行时取 key 同轨（含显式 credentialRealm 绑定的模型）
 * 4. modify 换绑（base_url）同步重派生 credentialRealm（防陈旧显式域）
 * 5. 写入口校验：model_name 安全字符集、apiModelId 不得填他卡本地注册名、派生消歧链
 *
 * 单例服务（ProviderManager/ModelInfoService 等）要求文件级子进程隔离：本文件独立运行，
 * 不与其他场景共用进程（同 addModelEndpointDefault.test.ts 纪律）。
 */
import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { providerManager, resolveCredentialId, resolveKeySlotId } from '../../src/services/models/providerManager'
import { modelInfoService } from '../../src/services/models/modelInfoService'
import { modelServiceFactory, ModelServiceFactory, stripCredentialOverrides } from '../../src/services/models/modelServiceFactory'
import {
  resolveApiModelId,
  deriveLocalName,
  realmSlug,
  assertUpstreamIdentityFields,
  assertNotLocalAliasAsUpstreamId,
  assertFinalNameAvailable,
  composeBindingDisplayName,
} from '../../src/services/models/modelIdentity'
import { SecureStorageService } from '../../src/services/secureStorageService'
import { SelectedModelsService } from '../../src/services/selectedModelsService'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor'
import type { IFileSystemProvider, FileSystemResult } from '../../src/interfaces/IFileSystemProvider'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore'

const tmp = mkdtempSync(join(tmpdir(), 'chill-binding-identity-'))
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

// --- 装配（providerManager 的 fileSystemProvider 必须先设，否则 loadProviders 跳过、种子不进 Map）---
providerManager.setFileSystemProvider(fsProvider)
providerManager.setProvidersDir(modelsDir)
await providerManager.loadProviders()
modelInfoService.setFileSystemProvider(fsProvider)
modelInfoService.setModelsDir(modelsDir)
await modelInfoService.loadAllModels()
SecureStorageService.initialize(memStorage)
modelInfoService.setSecureStorage(memStorage)
SelectedModelsService.setDefaultStore(memKV)
ModelServiceFactory.initialize(memStorage)

const executor = new BuiltInToolExecutor(
  fsProvider,
  { requestConfirmation: async () => ({ approved: true }) } as any,
  { calculate: async () => 0 } as any,
  { execute: async () => ({ success: true }) } as any
)

test.after(() => { rmSync(tmp, { recursive: true, force: true }) })

test('同身份绑两域生成两项：请求字段无本地名 + 显示名拼装「身份 · 通道短名」', async () => {
  const r1 = await executor.executeAddModel({
    model_name: 'itest-mimo-a',
    provider: '小米MiMo',
    request_model: 'itest-upstream-m1',
    api_key: 'sk-a',
    supported_modalities: 'text',
    max_context_tokens: 128000,
    max_output_tokens: 8192,
    supports_thinking: false,
    alias_models: 'itest-upstream-m1-alt'
  } as any)
  assert.ok(r1.success, `绑定 A 应成功：${(r1 as any).error ?? ''}`)

  const r2 = await executor.executeAddModel({
    model_name: 'itest-mimo-b',
    provider: '小米MiMo',
    base_url: 'https://token-plan-cn.xiaomimimo.com/v1',
    request_model: 'itest-upstream-m1',
    api_key: 'tp-b',
    supported_modalities: 'text',
    max_context_tokens: 128000,
    max_output_tokens: 8192,
    supports_thinking: false
  } as any)
  assert.ok(r2.success, `绑定 B 应成功：${(r2 as any).error ?? ''}`)

  const a = modelInfoService.getModelInfoByName('itest-mimo-a')!
  const b = modelInfoService.getModelInfoByName('itest-mimo-b')!
  assert.ok(a && b, '同身份绑两域应生成两项')
  assert.equal(SelectedModelsService.getInstance().getSelectedModels().length >= 2, true, '切换列表应有两项')

  // 请求字段无本地名：apiModelId/defaultModel/availableModels 只装上游 ID
  assert.equal(a.apiModelId, 'itest-upstream-m1')
  assert.equal(b.apiModelId, 'itest-upstream-m1')
  assert.equal(a.adapterConfig?.defaultModel, 'itest-upstream-m1')
  assert.equal(b.adapterConfig?.defaultModel, 'itest-upstream-m1')
  assert.deepEqual(a.availableModels, ['itest-upstream-m1', 'itest-upstream-m1-alt'])
  assert.ok(!a.availableModels.includes('itest-mimo-a'), 'availableModels 不得含本地注册名')
  assert.ok(!b.availableModels.includes('itest-mimo-b'), 'availableModels 不得含本地注册名')

  // 凭证域固化：模板端点 → 裸 id；token-plan → provider#host/path
  assert.equal(a.credentialRealm, 'xiaomi')
  assert.equal(b.credentialRealm, 'xiaomi#token-plan-cn.xiaomimimo.com/v1')
  assert.equal(resolveCredentialId(a), 'xiaomi')
  assert.equal(resolveCredentialId(b), 'xiaomi#token-plan-cn.xiaomimimo.com/v1')
  assert.ok(memKeys.has('xiaomi') && memKeys.get('xiaomi') === 'sk-a')
  assert.ok(memKeys.has('xiaomi#token-plan-cn.xiaomimimo.com/v1') && memKeys.get('xiaomi#token-plan-cn.xiaomimimo.com/v1') === 'tp-b')

  // 显示名拼装「身份 · 通道短名」
  assert.equal(a.displayName, composeBindingDisplayName('itest-upstream-m1', 'xiaomi', a.provider))
  assert.equal(b.displayName, composeBindingDisplayName('itest-upstream-m1', 'xiaomi#token-plan-cn.xiaomimimo.com/v1', b.provider))
  assert.ok(a.displayName.includes(' · '), `多绑定显示名应含拼装分隔：${a.displayName}`)

  // 运行时请求 config 的 model 字段 = 上游 ID（无本地名）
  const svc = await modelServiceFactory.createModelService(a.type, undefined, 'itest-mimo-a')
  assert.equal(svc.getConfig().model, 'itest-upstream-m1', '请求 model 字段不得是本地注册名')
  const svc2 = await modelServiceFactory.createModelService(b.type, undefined, 'itest-mimo-b')
  assert.equal(svc2.getConfig().model, 'itest-upstream-m1')
  assert.equal(svc2.getConfig().baseURL, 'https://token-plan-cn.xiaomimimo.com/v1')
  assert.equal(svc2.getConfig().apiKey, 'tp-b', '取 key 与状态同轨（显式 credentialRealm）')
})

test('合并层白名单：customConfig 的凭证/端点覆盖被剔除，采样参数可覆盖', async () => {
  const a = modelInfoService.getModelInfoByName('itest-mimo-a')!
  const svc = await modelServiceFactory.createModelService(a.type, {
    apiKey: 'evil-key',
    api_key: 'evil-key-2',
    baseURL: 'https://evil.example/v1',
    base_url: 'https://evil.example/v2',
    temperature: 0.1,
  } as any, 'itest-mimo-a')
  const cfg = svc.getConfig()
  assert.equal(cfg.apiKey, 'sk-a', '凭证不得被 customConfig 覆盖')
  assert.equal(cfg.baseURL, 'https://api.xiaomimimo.com/v1', '端点不得被 customConfig 覆盖')
  assert.equal(cfg.temperature, 0.1, '采样参数可覆盖')
  assert.equal(stripCredentialOverrides({ apiKey: 'x', api_key: 'y', baseURL: 'z', base_url: 'w', topP: 0.9 }).topP, 0.9)
  assert.equal(Object.keys(stripCredentialOverrides({ apiKey: 'x', api_key: 'y', baseURL: 'z', base_url: 'w' })).length, 0)
})

test('旧格式卡可加载、modify 后转新格式（补齐 apiModelId）', async () => {
  // 旧格式：无 apiModelId/credentialRealm，仅有 adapterConfig.defaultModel
  writeFileSync(join(modelsDir, 'legacy-card-x.json'), JSON.stringify({
    type: 'custom',
    name: 'legacy-card-x',
    displayName: '旧卡',
    provider: '小米MiMo',
    builtIn: false,
    adapterConfig: {
      protocol: 'openai-chat',
      baseURL: 'https://api.xiaomimimo.com/v1',
      defaultModel: 'legacy-upstream-1',
      defaultMaxTokens: 4096,
      defaultTemperature: 0.7
    },
    supportedModalities: ['text'],
    availableModels: ['legacy-upstream-1'],
    supportedParameters: [],
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    supportsStreaming: true,
    supportsTools: true,
    supportsThinking: false
  }, null, 2))
  await modelInfoService.reloadFromDisk()

  const legacy = modelInfoService.getModelInfoByName('legacy-card-x')!
  assert.ok(legacy, '旧格式卡可加载')
  assert.equal(resolveApiModelId(legacy), 'legacy-upstream-1', '旧卡读取回退 defaultModel')

  // 任意 modify 写入口 → 转新格式（apiModelId 落卡）
  const r1 = await executor.executeModifyModel({ model_name: 'legacy-card-x', display_name: '旧卡新名' } as any)
  assert.ok(r1.success, `modify 应成功：${(r1 as any).error ?? ''}`)
  let card = JSON.parse(readFileSync(join(modelsDir, 'legacy-card-x.json'), 'utf-8'))
  assert.equal(card.apiModelId, 'legacy-upstream-1', 'modify 后转新格式：apiModelId 从 defaultModel 归位')
  assert.equal(card.credentialRealm, 'xiaomi', 'modify 后 credentialRealm 固化')

  // request_model 语义并入 apiModelId
  const r2 = await executor.executeModifyModel({ model_name: 'legacy-card-x', request_model: 'legacy-upstream-2' } as any)
  assert.ok(r2.success, `modify request_model 应成功：${(r2 as any).error ?? ''}`)
  card = JSON.parse(readFileSync(join(modelsDir, 'legacy-card-x.json'), 'utf-8'))
  assert.equal(card.apiModelId, 'legacy-upstream-2')
  assert.equal(card.adapterConfig.defaultModel, 'legacy-upstream-2')
  assert.ok(!card.availableModels.includes('legacy-card-x'), 'availableModels 不得回写本地注册名')
})

test('状态 ✓/✗ 与运行时取 key 同轨（含显式 credentialRealm）', async () => {
  // 显式 credentialRealm（≠ 派生槽位）的绑定卡
  writeFileSync(join(modelsDir, 'itest-realm-card.json'), JSON.stringify({
    type: 'custom',
    name: 'itest-realm-card',
    displayName: '显式域卡',
    provider: '小米MiMo',
    builtIn: false,
    apiModelId: 'itest-upstream-r1',
    credentialRealm: 'itest-realm-x',
    adapterConfig: {
      protocol: 'openai-chat',
      baseURL: 'https://api.xiaomimimo.com/v1',
      defaultModel: 'itest-upstream-r1',
      defaultMaxTokens: 4096,
      defaultTemperature: 0.7
    },
    supportedModalities: ['text'],
    availableModels: ['itest-upstream-r1'],
    supportedParameters: [],
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    supportsStreaming: true,
    supportsTools: true,
    supportsThinking: false
  }, null, 2))
  await modelInfoService.reloadFromDisk()

  const card = modelInfoService.getModelInfoByName('itest-realm-card')!
  assert.ok(card, '显式域卡可加载')
  assert.equal(resolveCredentialId(card), 'itest-realm-x', 'resolveCredentialId 尊重显式 credentialRealm')
  assert.notEqual(resolveCredentialId(card), resolveKeySlotId(card.provider, card.adapterConfig?.baseURL), '显式域 ≠ 派生槽位')

  const statusOf = async () => (await modelInfoService.getAllModelsWithApiKeyStatus()).find(x => x.model.name === 'itest-realm-card')!
  let s = await statusOf()
  assert.equal(s.hasApiKey, false, '未存 key → ✗')
  assert.equal(await SecureStorageService.hasApiKey(resolveCredentialId(card)), false, '状态与取 key 同轨（同为 false）')

  await SecureStorageService.storeApiKey('itest-realm-x', 'rk-1')
  s = await statusOf()
  assert.equal(s.hasApiKey, true, '存 key 到显式域 → ✓')
  assert.equal(await SecureStorageService.getApiKey(resolveCredentialId(card)), 'rk-1', '运行时取 key 与状态同轨')

  // 全量对账：每张卡的状态 ≡ hasApiKey(resolveCredentialId(card))（V5）
  const all = await modelInfoService.getAllModelsWithApiKeyStatus()
  for (const { model, hasApiKey } of all) {
    assert.equal(hasApiKey, await SecureStorageService.hasApiKey(resolveCredentialId(model)), `状态须与取 key 同轨：${model.name}`)
  }
})

test('modify 换绑（base_url）同步重派生 credentialRealm（防陈旧显式域）', async () => {
  // 带陈旧显式域的卡：换绑后必须重派生，不得残留旧域
  writeFileSync(join(modelsDir, 'itest-rebind.json'), JSON.stringify({
    type: 'custom',
    name: 'itest-rebind',
    displayName: '换绑卡',
    provider: '小米MiMo',
    builtIn: false,
    apiModelId: 'itest-upstream-4',
    credentialRealm: 'itest-stale-realm',
    adapterConfig: {
      protocol: 'openai-chat',
      baseURL: 'https://api.xiaomimimo.com/v1',
      defaultModel: 'itest-upstream-4',
      defaultMaxTokens: 4096,
      defaultTemperature: 0.7
    },
    supportedModalities: ['text'],
    availableModels: ['itest-upstream-4'],
    supportedParameters: [],
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    supportsStreaming: true,
    supportsTools: true,
    supportsThinking: false
  }, null, 2))
  await modelInfoService.reloadFromDisk()

  // 换绑 + 同步补 key：key 应落新域，credentialRealm 重派生
  const r = await executor.executeModifyModel({
    model_name: 'itest-rebind',
    base_url: 'https://token-plan-cn.xiaomimimo.com/v1',
    api_key: 'tp-rebind'
  } as any)
  assert.ok(r.success, `换绑应成功：${(r as any).error ?? ''}`)

  const card = JSON.parse(readFileSync(join(modelsDir, 'itest-rebind.json'), 'utf-8'))
  assert.equal(card.credentialRealm, 'xiaomi#token-plan-cn.xiaomimimo.com/v1', '换绑后 credentialRealm 重派生（陈旧显式域清除）')
  assert.equal(memKeys.get('xiaomi#token-plan-cn.xiaomimimo.com/v1'), 'tp-rebind', 'key 落新域')
  assert.ok(!memKeys.has('itest-stale-realm'), '不得写陈旧域')
})

test('写入口校验：安全字符集 + apiModelId 不得填他卡本地注册名', async () => {
  // model_name 安全字符集（禁路径字符——models/<name>.json 不得炸 ENOENT）
  const rBad = await executor.executeAddModel({
    model_name: 'foo/bar',
    provider: '小米MiMo',
    api_key: 'k',
    supported_modalities: 'text',
    max_context_tokens: 1000,
    max_output_tokens: 100,
    supports_thinking: false
  } as any)
  assert.ok(!rBad.success, '非法 model_name 必须拒绝')
  assert.ok(((rBad as any).error as string).includes('非法字符'), `错误应指出非法字符：${(rBad as any).error}`)

  // request_model 填他卡本地注册名（假名）→ 拒绝
  const rAlias = await executor.executeAddModel({
    model_name: 'itest-alias-user',
    provider: '小米MiMo',
    request_model: 'itest-mimo-a', // itest-mimo-a 是本地注册名，其上游 ID 是 itest-upstream-m1
    base_url: 'https://other.example/v1',
    api_key: 'k2',
    supported_modalities: 'text',
    max_context_tokens: 1000,
    max_output_tokens: 100,
    supports_thinking: false
  } as any)
  assert.ok(!rAlias.success, 'apiModelId 填本地注册名必须拒绝')
  assert.ok(((rAlias as any).error as string).includes('本地注册名'), `错误应指出假名：${(rAlias as any).error}`)
  assert.ok(!existsSync(join(modelsDir, 'itest-alias-user.json')), '拒绝路径零痕迹')
})

test('本地注册名派生消歧链（确定性）', () => {
  const taken = new Set<string>()
  const isTaken = (n: string) => taken.has(n)

  const n1 = deriveLocalName('MiMo-V2.6-Pro', 'xiaomi#token-plan-cn.xiaomimimo.com/v1', { isTaken })
  assert.equal(n1, 'MiMo-V2.6-Pro')
  taken.add(n1)

  const n2 = deriveLocalName('MiMo-V2.6-Pro', 'xiaomi#token-plan-cn.xiaomimimo.com/v1', { isTaken })
  assert.equal(n2, 'MiMo-V2.6-Pro@token-plan-cn', '第二级：@域安全slug（host 标签形态）')
  taken.add(n2)

  const n3 = deriveLocalName('MiMo-V2.6-Pro', 'xiaomi#token-plan-cn.xiaomimimo.com/v1', { dialect: 'anthropic', isTaken })
  assert.equal(n3, 'MiMo-V2.6-Pro@token-plan-cn-anthropic', '第三级：@slug-方言')
  taken.add(n3)

  const n4 = deriveLocalName('MiMo-V2.6-Pro', 'xiaomi#token-plan-cn.xiaomimimo.com/v1', { dialect: 'anthropic', isTaken })
  assert.equal(n4, 'MiMo-V2.6-Pro@token-plan-cn-anthropic-2', '仍冲突追加 -N')

  assert.equal(realmSlug('xiaomi'), 'xiaomi')
  assert.equal(realmSlug('xiaomi#token-plan-cn.xiaomimimo.com/v1'), 'token-plan-cn')
  assert.equal(realmSlug('custom#api.deepseek.com/v1'), 'api')

  // 同名不同供应商（中转 vs 官方）：跨身份占用同样推进消歧链
  const taken2 = new Set(['claude-3'])
  const n5 = deriveLocalName('claude-3', 'myproxy#relay.example.com/v1', { isTaken: (n) => taken2.has(n) })
  assert.equal(n5, 'claude-3@relay')
})

test('写入口校验纯函数：上游 ID 字段拒绝本地名 / 最终名不同身份占用报错', () => {
  assert.throws(() => assertUpstreamIdentityFields({ localName: 'fake-name', apiModelId: 'up-1', defaultModel: 'fake-name' }), /本地注册名/)
  assert.throws(() => assertUpstreamIdentityFields({ localName: 'fake-name', apiModelId: 'up-1', availableModels: ['up-1', 'fake-name'] }), /本地注册名/)
  assert.throws(() => assertUpstreamIdentityFields({ localName: 'x', apiModelId: '  ' }), /不得为空/)
  // 旧契约同串（model_name 即请求编码）放行
  assertUpstreamIdentityFields({ localName: 'same-id', apiModelId: 'same-id', defaultModel: 'same-id', availableModels: ['same-id'] })

  const cards = new Map<string, any>([
    ['alias-card', { provider: 'p', apiModelId: 'real-up' }],
    ['same-id', { provider: 'p', apiModelId: 'same-id' }],
  ])
  const lookup = (n: string) => cards.get(n)
  assert.throws(() => assertNotLocalAliasAsUpstreamId('alias-card', lookup), /本地注册名/)
  assertNotLocalAliasAsUpstreamId('real-up', lookup) // 上游 ID 本身放行
  assertNotLocalAliasAsUpstreamId('same-id', lookup) // 同串（真名即注册名）放行

  assert.throws(
    () => assertFinalNameAvailable('alias-card', 'p\u0000other-up', lookup),
    /拒绝覆盖/,
  )
  assertFinalNameAvailable('brand-new', 'p\u0000other-up', lookup)
})
