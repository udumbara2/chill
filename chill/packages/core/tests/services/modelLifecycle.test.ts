/**
 * I4 验收（任务 18）：生命周期分层——共享域删除不陪葬、缺 key 换绑被拒、rotate 后全通道绑定可用
 *
 * 删除三层（V7）：删绑定 ≠ 删域（引用计数）≠ 删身份（停用）；builtIn 墓碑语义不变。
 * 换绑事务：新域无已验证凭证即提交前拒绝（取代事后警告）。域级 rotate：写 + 回读重验证 + 全通道生效。
 *
 * 单例服务要求文件级子进程隔离：本文件独立运行（同 addModelEndpointDefault.test.ts 纪律）。
 */
import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { providerManager, resolveCredentialId, resolveKeySlotId } from '../../src/services/models/providerManager'
import { modelInfoService } from '../../src/services/models/modelInfoService'
import { ModelServiceFactory, modelServiceFactory } from '../../src/services/models/modelServiceFactory'
import { SecureStorageService } from '../../src/services/secureStorageService'
import { SelectedModelsService } from '../../src/services/selectedModelsService'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor'
import type { IFileSystemProvider, FileSystemResult } from '../../src/interfaces/IFileSystemProvider'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore'

const tmp = mkdtempSync(join(tmpdir(), 'chill-lifecycle-'))
const modelsDir = join(tmp, 'models')
mkdirSync(modelsDir, { recursive: true })

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

providerManager.setFileSystemProvider(fsProvider)
providerManager.setProvidersDir(modelsDir)
await providerManager.loadProviders()
modelInfoService.setFileSystemProvider(fsProvider)
modelInfoService.setModelsDir(modelsDir)
await modelInfoService.loadAllModels()
SecureStorageService.initialize(memStorage)
modelInfoService.setSecureStorage(memStorage)
modelInfoService.setKeyValueStore(memKV)
SelectedModelsService.setDefaultStore(memKV)
ModelServiceFactory.initialize(memStorage)

const executor = new BuiltInToolExecutor(
  fsProvider,
  { requestConfirmation: async () => ({ approved: true }) } as any,
  { calculate: async () => 0 } as any,
  { execute: async () => ({ success: true }) } as any
)

test.after(() => { rmSync(tmp, { recursive: true, force: true }) })

const addModel = (params: Record<string, unknown>) => executor.executeAddModel({
  supported_modalities: 'text',
  max_context_tokens: 128000,
  max_output_tokens: 8192,
  supports_thinking: false,
  ...params,
} as any)

test('共享域删除不陪葬（域级引用计数）', async () => {
  const r1 = await addModel({ model_name: 'shared-a', provider: 'LifeProv', request_model: 'shared-up-a', base_url: 'https://life.example/v1', protocol: 'openai-chat', api_key: 'life-key-1' })
  assert.ok(r1.success, `${(r1 as any).error ?? ''}`)
  const r2 = await addModel({ model_name: 'shared-b', provider: 'LifeProv', request_model: 'shared-up-b', base_url: 'https://life.example/v1', protocol: 'openai-chat' })
  assert.ok(r2.success, `同域已有凭证自动复用：${(r2 as any).error ?? ''}`)

  const realm = providerManager.idFor('LifeProv')
  assert.equal(memKeys.get(realm), 'life-key-1')

  // 删第一个绑定：同域还有 shared-b → key 不陪葬
  const rm1 = await executor.executeRemoveModel({ model_name: 'shared-a' } as any)
  assert.ok(r1.success, `${(rm1 as any).error ?? ''}`)
  assert.ok(memKeys.has(realm), '共享域删除不陪葬：同域仍有绑定时 key 必须保留')
  assert.ok(((rm1 as any).data as string).includes('已停用'), `单绑定身份删除后应报告身份停用：${(rm1 as any).data}`)
  assert.ok(!((rm1 as any).data as string).includes('已清除'), '域未空不得清 key')

  // 删最后一个绑定：域引用计数归零 → 删 key
  const rm2 = await executor.executeRemoveModel({ model_name: 'shared-b' } as any)
  assert.ok(rm2.success)
  assert.ok(!memKeys.has(realm), '域引用计数归零才删 key')
  assert.ok(((rm2 as any).data as string).includes('已清除'), `应报告 key 已清除：${(rm2 as any).data}`)
  assert.ok(((rm2 as any).data as string).includes('已停用'))
})

test('删除只影响该项：同身份跨域共享 + 内置墓碑不动 key', async () => {
  // 同一身份（life-up-x）绑两个域：xiaomi 模板域 + Token Plan 域
  const r1 = await addModel({ model_name: 'life-x1', provider: '小米MiMo', request_model: 'life-up-x', api_key: 'sk-life-x' })
  assert.ok(r1.success, `${(r1 as any).error ?? ''}`)
  const r2 = await addModel({ model_name: 'life-x2', provider: '小米MiMo', request_model: 'life-up-x', base_url: 'https://token-plan-cn.xiaomimimo.com/v1', api_key: 'tp-life-x' })
  assert.ok(r2.success, `${(r2 as any).error ?? ''}`)

  // 内置卡墓碑：zhipu key 预置
  await memStorage.storeApiKey('zhipu', 'zhipu-key-x')

  // 删模板域绑定：另一域绑定与其 key 不受影响；身份仍余 1 个绑定
  const rm1 = await executor.executeRemoveModel({ model_name: 'life-x1' } as any)
  assert.ok(rm1.success)
  assert.ok(modelInfoService.getModelInfoByName('life-x2'), '同身份另一域绑定必须存活')
  assert.ok(memKeys.has('xiaomi'), '模板域 key 陪葬与否由域引用计数决定（种子绑定仍在）')
  assert.equal(memKeys.get('xiaomi#token-plan-cn.xiaomimimo.com/v1'), 'tp-life-x', '另一域 key 不陪葬')
  assert.ok(((rm1 as any).data as string).includes('仍余 1 个绑定'), `身份未空应报告余量：${(rm1 as any).data}`)

  // 内置卡删除 = 墓碑（绑定停用兼容实现），不动 key、重启不复活语义保留
  const rmSeed = await executor.executeRemoveModel({ model_name: 'glm-5.3' } as any)
  assert.ok(rmSeed.success)
  assert.ok(((rmSeed as any).data as string).includes('重启后也不会再出现'), `墓碑语义不变：${(rmSeed as any).data}`)
  assert.ok(memKeys.has('zhipu'), '墓碑 ≠ 卸载供应商：key 必须保留')
  assert.ok(!modelInfoService.getModelInfoByName('glm-5.3'), '墓碑后内存不复活')

  // 删 Token Plan 域绑定：该域引用计数归零 → 域 key 删除；身份停用
  const rm2 = await executor.executeRemoveModel({ model_name: 'life-x2' } as any)
  assert.ok(rm2.success)
  assert.ok(!memKeys.has('xiaomi#token-plan-cn.xiaomimimo.com/v1'), '域空删 key')
  assert.ok(((rm2 as any).data as string).includes('已停用'), `最后一个绑定删除 = 身份停用：${(rm2 as any).data}`)
})

test('换绑事务：新域无已验证凭证 → 提交前拒绝', async () => {
  const r = await addModel({ model_name: 'rebind-a', provider: '小米MiMo', request_model: 'rebind-up-a', api_key: 'sk-rebind-a' })
  assert.ok(r.success, `${(r as any).error ?? ''}`)

  // 换绑到 Token Plan 域（无 key、本次也不提供）→ 当场拒绝、零变更
  const before = readFileSync(join(modelsDir, 'rebind-a.json'), 'utf-8')
  const miss = await executor.executeModifyModel({
    model_name: 'rebind-a',
    base_url: 'https://token-plan-cn.xiaomimimo.com/v1',
  } as any)
  assert.ok(!miss.success, '缺 key 换绑必须拒绝')
  const err = (miss as any).error as string
  assert.ok(err.includes('需要已验证凭证'), `错误应指出缺凭证：${err}`)
  assert.ok(err.includes('本次修改未提交'), `错误应可行动：${err}`)
  assert.equal(readFileSync(join(modelsDir, 'rebind-a.json'), 'utf-8'), before, '拒绝路径零变更（卡不得部分提交）')
  assert.equal(modelInfoService.getModelInfoByName('rebind-a')!.adapterConfig!.baseURL, 'https://api.xiaomimimo.com/v1', '内存零变更')

  // 新域已有已验证凭证（预存）→ 允许换绑
  await memStorage.storeApiKey('xiaomi#token-plan-cn.xiaomimimo.com/v1', 'tp-pre-verified')
  const okPre = await executor.executeModifyModel({
    model_name: 'rebind-a',
    base_url: 'https://token-plan-cn.xiaomimimo.com/v1',
  } as any)
  assert.ok(okPre.success, `新域已有凭证应放行：${(okPre as any).error ?? ''}`)
  assert.equal(modelInfoService.getModelInfoByName('rebind-a')!.credentialRealm, 'xiaomi#token-plan-cn.xiaomimimo.com/v1', '换绑后域重派生')
  await memStorage.deleteApiKey('xiaomi#token-plan-cn.xiaomimimo.com/v1')

  // 换绑 + 本次提供 api_key（写入回读验证）→ 允许
  const okWithKey = await executor.executeModifyModel({
    model_name: 'rebind-a',
    base_url: 'https://api.xiaomimimo.com/v1',
    api_key: 'sk-rebind-back',
  } as any)
  assert.ok(okWithKey.success, `${(okWithKey as any).error ?? ''}`)
  assert.equal(modelInfoService.getModelInfoByName('rebind-a')!.credentialRealm, 'xiaomi')
  assert.equal(memKeys.get('xiaomi'), 'sk-rebind-back')
})

test('域级 rotate：写 + 回读重验证 + 全通道绑定即时可用', async () => {
  const r1 = await addModel({ model_name: 'rot-a', provider: 'RotProv', request_model: 'rot-up-a', base_url: 'https://rot.example/v1', protocol: 'openai-chat', api_key: 'rot-key-old' })
  assert.ok(r1.success, `${(r1 as any).error ?? ''}`)
  const r2 = await addModel({ model_name: 'rot-b', provider: 'RotProv', request_model: 'rot-up-b', base_url: 'https://rot.example/v1', protocol: 'openai-chat' })
  assert.ok(r2.success, `${(r2 as any).error ?? ''}`)

  const a = modelInfoService.getModelInfoByName('rot-a')!
  const b = modelInfoService.getModelInfoByName('rot-b')!
  const realm = resolveCredentialId(a)
  assert.equal(realm, resolveCredentialId(b), '两绑定共享域')
  assert.equal(memKeys.get(realm), 'rot-key-old')

  // 旧 key 已进入缓存服务实例
  const svcA = await modelServiceFactory.createModelService(a.type, undefined, 'rot-a')
  assert.equal(svcA.getConfig().apiKey, 'rot-key-old')

  // 经其中一个绑定 rotate 域凭证
  const rot = await executor.executeModifyModel({ model_name: 'rot-a', api_key: 'rot-key-new' } as any)
  assert.ok(rot.success, `${(rot as any).error ?? ''}`)

  // 全通道可用：两绑定的取 key 同轨得到新 key
  assert.equal(await SecureStorageService.getApiKey(resolveCredentialId(a)), 'rot-key-new')
  assert.equal(await SecureStorageService.getApiKey(resolveCredentialId(b)), 'rot-key-new', 'rotate 后同域全部绑定即时生效')

  // 清缓存后新建服务实例拿到新 key（旧实例不再复用）
  modelServiceFactory.clearCache()
  const svcA2 = await modelServiceFactory.createModelService(a.type, undefined, 'rot-a')
  const svcB2 = await modelServiceFactory.createModelService(b.type, undefined, 'rot-b')
  assert.equal(svcA2.getConfig().apiKey, 'rot-key-new')
  assert.equal(svcB2.getConfig().apiKey, 'rot-key-new')
  assert.equal(svcB2.getConfig().model, 'rot-up-b', '请求字段仍为上游 ID')
})
