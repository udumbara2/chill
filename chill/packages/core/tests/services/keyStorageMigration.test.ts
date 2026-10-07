/**
 * 存量迁移 e2e（4a 编码改名 + 4b key 归位保守启发）
 *
 * 单例服务要求文件级子进程隔离：本文件独立运行，不与其他场景共用进程。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { storageKeyFor, isEncodedStorageKey } from '../../src/services/credentials/storageKey'
import { runKeyStorageMigration } from '../../src/services/models/keyStorageMigration'
import { providerManager } from '../../src/services/models/providerManager'
import { modelInfoService } from '../../src/services/models/modelInfoService'
import { SecureStorageService } from '../../src/services/secureStorageService'
import { SelectedModelsService } from '../../src/services/selectedModelsService'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore'
import type { ModelInfo } from '../../src/types/models'

// --- 内存存储：物理 stem 文件层 + 逻辑 API（编码优先、裸名回退，同 CLISecureStorage 语义）---
const files = new Map<string, string>() // 物理 stem → secret
const memStorage: ISecureStorage & {
  listKeyFiles(): string[]
  renameKey(a: string, b: string): boolean
  backupKeysDir(): { name: string; created: boolean } | null
} = {
  async storeApiKey(id, key) {
    files.set(storageKeyFor(id), key)
    return true
  },
  async getApiKey(id) {
    return files.get(storageKeyFor(id)) ?? files.get(id) ?? null
  },
  async hasApiKey(id) {
    return files.has(storageKeyFor(id)) || files.has(id)
  },
  async deleteApiKey(id) {
    files.delete(storageKeyFor(id))
    files.delete(id)
    return true
  },
  async getAllProviders() {
    return [...files.keys()]
  },
  listKeyFiles: () => [...files.keys()].map(s => `${s}.key`),
  renameKey(a, b) {
    if (!files.has(a) || files.has(b)) return false
    files.set(b, files.get(a)!)
    files.delete(a)
    return true
  },
  backupKeysDir: () => ({ name: 'keys.backup-test', created: true }),
}

const memKV: IKeyValueStore & { store: Map<string, string> } = {
  store: new Map<string, string>(),
  getItem(k) {
    return this.store.get(k) ?? null
  },
  setItem(k, v) {
    this.store.set(k, v)
  },
  removeItem(k) {
    this.store.delete(k)
  },
  clear() {
    this.store.clear()
  },
}

SecureStorageService.initialize(memStorage)
SelectedModelsService.setDefaultStore(memKV)

function card(name: string, provider: string, baseURL: string, builtIn = false): ModelInfo {
  return {
    type: 'custom' as any,
    name,
    displayName: name,
    provider,
    builtIn,
    supportedModalities: [],
    availableModels: [],
    supportedParameters: [],
    supportsStreaming: true,
    supportsTools: true,
    supportsThinking: false,
    adapterConfig: { protocol: 'openai-chat', baseURL, defaultModel: 'mimo-x' },
  }
}

test('4a：编码改名（幂等）+ 逻辑 API 读回不依赖文件名形态', async () => {
  files.clear()
  files.set('zhipu', 'k-zhipu')
  files.set('relay.operatorKey', 'k-relay')

  const r1 = await runKeyStorageMigration(memStorage, () => {})
  assert.equal(r1.renamed.length, 2)
  assert.ok(files.has(storageKeyFor('zhipu')), '编码后按存储键寻址')
  assert.ok(files.has(storageKeyFor('relay.operatorKey')))
  assert.equal(await memStorage.getApiKey('zhipu'), 'k-zhipu', '逻辑 API 读回')
  assert.equal(await memStorage.getApiKey('relay.operatorKey'), 'k-relay')

  const r2 = await runKeyStorageMigration(memStorage, () => {})
  assert.equal(r2.renamed.length, 0, '幂等：二次运行不再改名')
})

test('4b：GLM Coding 形态——被引用用户绑定同指一个非模板域 → 裸 key 归位（种子卡不计）', async () => {
  files.clear()
  memKV.store.clear()
  modelInfoService.addModelInfo(card('glm-5.3', '智谱AI', 'https://open.bigmodel.cn/api/paas/v4', true)) // 出厂种子：恒绑模板域，不计
  modelInfoService.addModelInfo(card('glm-5.3-coding', '智谱AI', 'https://open.bigmodel.cn/api/coding/paas/v4'))
  modelInfoService.addModelInfo(card('glm-5.3-flash-coding', '智谱AI', 'https://open.bigmodel.cn/api/coding/paas/v4'))
  memKV.setItem('selected-models', JSON.stringify(['glm-5.3-coding', 'glm-5.3-flash-coding']))
  memKV.setItem('defaultEvaluatorModel', 'glm-5.3-flash-coding')
  // 存量裸名 key（迁移期形态）
  files.set('zhipu', 'k-coding')

  const r = await runKeyStorageMigration(memStorage, () => {})
  assert.equal(r.relocated.length, 1, `应归位一次：${JSON.stringify(r.relocated)}`)
  assert.equal(r.relocated[0].to, 'zhipu#open.bigmodel.cn/api/coding/paas/v4')
  assert.equal(await memStorage.getApiKey('zhipu#open.bigmodel.cn/api/coding/paas/v4'), 'k-coding', '通道域可取到 key')
  assert.equal(await memStorage.hasApiKey('zhipu'), false, '裸槽位已清空')
})

test('4b：模板域用户绑定同被引用 → 证据不清，不搬迁（V7）', async () => {
  files.clear()
  memKV.store.clear()
  modelInfoService.addModelInfo(card('my-template-model', '智谱AI', 'https://open.bigmodel.cn/api/paas/v4'))
  modelInfoService.addModelInfo(card('glm-5.3-coding', '智谱AI', 'https://open.bigmodel.cn/api/coding/paas/v4'))
  memKV.setItem('selected-models', JSON.stringify(['my-template-model', 'glm-5.3-coding']))
  files.set(storageKeyFor('zhipu'), 'k-bare')

  const r = await runKeyStorageMigration(memStorage, () => {})
  assert.equal(r.relocated.length, 0, '模板域被引用时禁止搬迁')
  assert.equal(await memStorage.getApiKey('zhipu'), 'k-bare', '裸 key 留原地')
})

test('4b：无任何引用 → 不搬迁', async () => {
  files.clear()
  memKV.store.clear()
  modelInfoService.addModelInfo(card('glm-5.3-coding', '智谱AI', 'https://open.bigmodel.cn/api/coding/paas/v4'))
  files.set(storageKeyFor('zhipu'), 'k-orphan')

  const r = await runKeyStorageMigration(memStorage, () => {})
  assert.equal(r.relocated.length, 0)
  assert.equal(await memStorage.getApiKey('zhipu'), 'k-orphan')
})

test('4a：备份幂等据点被尊重（backupKeysDir 非空即视为就绪；新建才播报）', async () => {
  files.clear()
  files.set('deepseek', 'k')
  const logs: string[] = []
  const r = await runKeyStorageMigration(memStorage, (m) => logs.push(m))
  assert.equal(r.backedUp, 'keys.backup-test')
  assert.equal(r.backupCreated, true)
  assert.equal(r.renamed.length, 1)
  assert.ok(isEncodedStorageKey(storageKeyFor('deepseek')))
  // 新建备份：应有一条播报（文案=已新建备份）
  assert.ok(logs.some((m) => m.includes('keys 目录已新建备份')), '新建备份应播报一次')
})

test('4a：复用已有备份时静默（启动不再重复播报"备份就绪"）', async () => {
  files.clear()
  files.set('deepseek', 'k')
  const reuseStorage = {
    ...memStorage,
    backupKeysDir: () => ({ name: 'keys.backup-test', created: false }),
  }
  const logs: string[] = []
  const r = await runKeyStorageMigration(reuseStorage, (m) => logs.push(m))
  assert.equal(r.backedUp, 'keys.backup-test') // 据点信息仍在（就绪）
  assert.equal(r.backupCreated, false)
  assert.ok(!logs.some((m) => m.includes('备份')), '复用备份不得播报任何备份相关日志')
})
