/**
 * 覆盖语义 + 墓碑 + 物化接管 e2e（迭代 3 验收）
 *
 * 覆盖场景：
 * 1. 覆盖卡赢出厂（同名磁盘 builtIn:false 卡生效）
 * 2. 影子文件迁移两分支（内容与出厂一致 → 删；不一致 → 保留）
 * 3. modify 内置卡 → 物化落盘、副本自包含、reload 后修改保留
 * 4. 升级场景模拟：物化副本存在时重跑 loadAllModels，用户副本不受出厂层影响
 * 5. 恢复出厂：删除覆盖文件 + reload → 出厂卡露出
 * 6. remove 内置卡 → 墓碑写入、内存即时消失、重载不复活、Key 未被删除
 * 7. 无 kv 注入时降级不崩（无墓碑，出厂层全显示）
 *
 * 单例服务要求文件级子进程隔离：本文件独立运行，不与其他场景共用进程。
 */
import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { ModelInfoService, modelInfoService } from '../../src/services/models/modelInfoService'
import { providerManager } from '../../src/services/models/providerManager'
import { SecureStorageService } from '../../src/services/secureStorageService'
import { SelectedModelsService } from '../../src/services/selectedModelsService'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor'
import type { IFileSystemProvider, FileSystemResult } from '../../src/interfaces/IFileSystemProvider'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore'

const tmp = mkdtempSync(join(tmpdir(), 'chill-overlay-e2e-'))
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

// --- 装配 ---
providerManager.setFileSystemProvider(fsProvider)
providerManager.setProvidersDir(modelsDir)
await providerManager.loadProviders()
modelInfoService.setFileSystemProvider(fsProvider)
modelInfoService.setModelsDir(modelsDir)
modelInfoService.setKeyValueStore(memKV)
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

test('覆盖卡赢出厂：同名磁盘卡（内容不一致的影子）保留并生效', async () => {
  // 造一张与出厂卡同名但内容不同的 builtIn:false 磁盘卡
  const seed = ModelInfoService.getBuiltInSeedModels().find(m => m.name === 'deepseek-flash')!
  const override = { ...seed, builtIn: false, displayName: '我的 DeepSeek 定制版', maxOutputTokens: 12345 }
  writeFileSync(join(modelsDir, 'deepseek-flash.json'), JSON.stringify(override, null, 2))

  await modelInfoService.loadAllModels()
  const m = modelInfoService.getModelInfoByName('deepseek-flash')!
  assert.equal(m.displayName, '我的 DeepSeek 定制版', '用户覆盖卡应赢出厂卡')
  assert.equal(m.builtIn, false)
  assert.equal(m.maxOutputTokens, 12345)
  assert.ok(existsSync(join(modelsDir, 'deepseek-flash.json')), '内容不一致的覆盖文件应保留')
})

test('影子文件迁移：内容与出厂卡一致的 builtIn:false 文件被删除（幂等）', async () => {
  // 造一张与折叠后出厂卡内容完全一致、仅 builtIn 标记不同的影子文件
  const seed = ModelInfoService.getBuiltInSeedModels().find(m => m.name === 'kimi-k2.7-code')!
  const shadow = { ...seed, builtIn: false }
  writeFileSync(join(modelsDir, 'kimi-k2.7-code.json'), JSON.stringify(shadow, null, 2))

  await modelInfoService.loadAllModels()
  assert.ok(!existsSync(join(modelsDir, 'kimi-k2.7-code.json')), '内容一致的影子文件应被删除')
  const m = modelInfoService.getModelInfoByName('kimi-k2.7-code')!
  assert.equal(m.builtIn, true, '影子删除后露出的是出厂卡')
  // 幂等：再跑一次不应报错、状态不变
  await modelInfoService.loadAllModels()
  assert.equal(modelInfoService.getModelInfoByName('kimi-k2.7-code')!.builtIn, true)
})

test('modify 内置卡：物化落盘、副本自包含、reload 后修改保留', async () => {
  const r = await (executor as any).executeModifyModel({
    model_name: 'kimi-k3',
    max_output_tokens: 64000
  })
  assert.ok(r.success, `应成功：${r.error ?? ''}`)
  assert.ok(String(r.data).includes('物化'), '返回值应说明已物化为用户副本')

  const cardPath = join(modelsDir, 'kimi-k3.json')
  assert.ok(existsSync(cardPath), '物化副本应落盘')
  const card = JSON.parse(readFileSync(cardPath, 'utf-8'))
  assert.equal(card.builtIn, false, '物化副本归用户所有')
  assert.equal(card.maxOutputTokens, 64000, '补丁应生效')
  // 副本自包含：折叠后的厂商级字段都在卡上
  assert.equal(card.adapterConfig.baseURL, 'https://api.moonshot.cn/v1')
  assert.equal(card.adapterConfig.protocol, 'openai-chat')
  assert.deepEqual(card.adapterConfig.fixedParams, { temperature: 1 })
  assert.deepEqual(card.adapterConfig.extraBodyParams, { tool_choice: 'auto' })

  // 内存同步更新
  const mem = modelInfoService.getModelInfoByName('kimi-k3')!
  assert.equal(mem.builtIn, false)
  assert.equal(mem.maxOutputTokens, 64000)

  // reload 后修改保留（用户层赢）
  await modelInfoService.reloadFromDisk()
  const reloaded = modelInfoService.getModelInfoByName('kimi-k3')!
  assert.equal(reloaded.builtIn, false)
  assert.equal(reloaded.maxOutputTokens, 64000)
})

test('升级场景模拟：物化副本存在时重跑 loadAllModels，用户副本不受出厂层影响', async () => {
  // 出厂层每次 loadAllModels 都从种子重建（等价于升级后种子变化）；用户副本应保持不动
  await modelInfoService.loadAllModels()
  const m = modelInfoService.getModelInfoByName('kimi-k3')!
  assert.equal(m.builtIn, false, '用户覆盖副本不被出厂层替换')
  assert.equal(m.maxOutputTokens, 64000, '用户改过的值不受出厂层影响')
  assert.ok(existsSync(join(modelsDir, 'kimi-k3.json')), '物化文件不被迁移删除（内容与出厂不一致）')
})

test('恢复出厂：删除覆盖文件 + reload → 出厂卡露出', async () => {
  unlinkSync(join(modelsDir, 'kimi-k3.json'))
  await modelInfoService.reloadFromDisk()
  const m = modelInfoService.getModelInfoByName('kimi-k3')!
  assert.equal(m.builtIn, true, '覆盖文件删除后出厂卡自动露出')
  assert.equal(m.maxOutputTokens, 131072, '出厂值恢复')
  assert.equal(m.adapterConfig!.baseURL, 'https://api.moonshot.cn/v1', '折叠仍生效')
})

test('remove 内置卡：墓碑写入、内存即时消失、重载不复活、Key 保留', async () => {
  await SecureStorageService.storeApiKey('zhipu', 'test-key-zhipu')

  const r = await (executor as any).executeRemoveModel({ model_name: 'glm-5.3' })
  assert.ok(r.success, `应成功：${r.error ?? ''}`)

  // 内存即时消失
  assert.equal(modelInfoService.getModelInfoByName('glm-5.3'), undefined)
  // 墓碑写入
  assert.deepEqual(modelInfoService.getDeletedSeedModels(), ['glm-5.3'])
  // Key 未被删除（墓碑 ≠ 卸载供应商；且智谱还有其他种子卡，本就不该清）
  assert.ok(memKeys.has('zhipu'), '内置卡移除不应触碰 API Key')
  // 重跑 loadAllModels（等价重启）不复活
  await modelInfoService.loadAllModels()
  assert.equal(modelInfoService.getModelInfoByName('glm-5.3'), undefined, '墓碑过滤：重启不复活')
  assert.deepEqual(modelInfoService.getDeletedSeedModels(), ['glm-5.3'], '墓碑名单持久')
})

test('remove 内置卡：同名覆盖文件一并删除（双壳时序：文件已落盘、内存仍是出厂卡）', async () => {
  // 模拟双壳场景：另一进程刚把 qwen3.8-max 物化落盘，本进程内存仍是 builtIn:true 的出厂卡
  const seed = ModelInfoService.getBuiltInSeedModels().find(m => m.name === 'qwen3.8-max')!
  const override = { ...seed, builtIn: false, maxOutputTokens: 32000 }
  writeFileSync(join(modelsDir, 'qwen3.8-max.json'), JSON.stringify(override, null, 2))

  const r = await (executor as any).executeRemoveModel({ model_name: 'qwen3.8-max' })
  assert.ok(r.success, `移除应成功：${r.error ?? ''}`)
  assert.equal(modelInfoService.getModelInfoByName('qwen3.8-max'), undefined)
  assert.ok(!existsSync(join(modelsDir, 'qwen3.8-max.json')), '同名覆盖文件应一并删除')
  assert.ok(modelInfoService.getDeletedSeedModels().includes('qwen3.8-max'))

  await modelInfoService.loadAllModels()
  assert.equal(modelInfoService.getModelInfoByName('qwen3.8-max'), undefined, '覆盖文件已删 + 墓碑：不复活')
})

test('移除已接管（物化）的副本 = 删自定义卡：不写墓碑，出厂卡下次加载重新露出', async () => {
  // modify 物化后内存卡已是 builtIn:false（用户数据），remove 走自定义卡路径
  const r1 = await (executor as any).executeModifyModel({ model_name: 'qwen3.8-2.4t-a95b', max_output_tokens: 32000 })
  assert.ok(r1.success, `物化应成功：${r1.error ?? ''}`)
  assert.ok(existsSync(join(modelsDir, 'qwen3.8-2.4t-a95b.json')))

  const r2 = await (executor as any).executeRemoveModel({ model_name: 'qwen3.8-2.4t-a95b' })
  assert.ok(r2.success, `移除应成功：${r2.error ?? ''}`)
  assert.equal(modelInfoService.getModelInfoByName('qwen3.8-2.4t-a95b'), undefined)
  assert.ok(!existsSync(join(modelsDir, 'qwen3.8-2.4t-a95b.json')))
  assert.ok(!modelInfoService.getDeletedSeedModels().includes('qwen3.8-2.4t-a95b'), '用户副本不写墓碑')
  // 阿里云百炼还剩 qwen3.8-max 出厂卡……但该卡已被上一用例墓碑，供应商下无剩余模型 → Key 会被清。
  // 这里只断言墓碑语义，Key 分支由下一用例（纯自定义供应商）精确覆盖。

  await modelInfoService.loadAllModels()
  const back = modelInfoService.getModelInfoByName('qwen3.8-2.4t-a95b')!
  assert.equal(back.builtIn, true, '出厂卡重新露出（恢复出厂语义）')
  assert.equal(back.maxOutputTokens, 131072)
})

test('remove 自定义卡：原有行为不变（含供应商无剩余模型时清理 Key）', async () => {
  const r1 = await executor.executeAddModel({
    model_name: 'my-custom-model',
    provider: '某独立厂商',
    api_key: 'test-key-custom',
    supported_modalities: 'text',
    max_context_tokens: 128000,
    max_output_tokens: 8192,
    supports_thinking: false,
    base_url: 'https://api.custom.example/v1',
    protocol: 'openai-chat'
  } as any)
  assert.ok(r1.success, `添加应成功：${(r1 as any).error ?? ''}`)

  const r2 = await (executor as any).executeRemoveModel({ model_name: 'my-custom-model' })
  assert.ok(r2.success, `移除应成功：${r2.error ?? ''}`)
  assert.equal(modelInfoService.getModelInfoByName('my-custom-model'), undefined)
  assert.ok(!existsSync(join(modelsDir, 'my-custom-model.json')))
  assert.ok(!memKeys.has('某独立厂商'), '自定义卡供应商无剩余模型时应清理 Key')
  assert.ok(!modelInfoService.getDeletedSeedModels().includes('my-custom-model'), '自定义卡不写墓碑')
})

test('remove 正在使用的内置卡：既有检查对内置卡同样生效', async () => {
  SelectedModelsService.getInstance().saveCurrentModelName('MiniMax-M3')
  const r = await (executor as any).executeRemoveModel({ model_name: 'MiniMax-M3' })
  assert.ok(!r.success, '正在使用中的内置卡不可移除')
  assert.ok(String(r.error).includes('正在使用中'))
  assert.ok(!modelInfoService.getDeletedSeedModels().includes('MiniMax-M3'), '拒绝时不写墓碑')
  SelectedModelsService.getInstance().clearCurrentModel()
})

test('无 kv 注入时降级不崩：无墓碑，出厂层全显示', async () => {
  // 用独立实例模拟未注入 kv 的环境（如最小装配）
  const svc = new (ModelInfoService as any)() as ModelInfoService
  svc.setFileSystemProvider(fsProvider)
  svc.setModelsDir(modelsDir)
  await svc.loadAllModels()
  // 无墓碑 → 出厂层全显示（本测试进程里 glm-5.3 已被墓碑，但独立实例无 kv，不受影响）
  assert.ok(svc.getModelInfoByName('glm-5.3'), '无 kv 注入时不过滤任何出厂卡')
  assert.equal(svc.getModelInfoByName('glm-5.3')!.builtIn, true)
  assert.deepEqual(svc.getDeletedSeedModels(), [])
})
