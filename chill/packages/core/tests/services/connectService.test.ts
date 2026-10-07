/**
 * I3 验收（任务 15）：connectService 假传输层单测 + connect schema ≡ add_model 工具定义字段集
 *
 * 覆盖：P0 key 形态定域与冲突拒绝、P1 复用语义、P2 探测解析 / 退化最小 chat 鉴权 / 鉴权失败零残留、
 * P3 能力来源标记（probed/catalog/declared）、P4 失败补偿（凭证除外）与 tmp+rename 落盘、匿名域跳过 P1。
 *
 * 单例服务要求文件级子进程隔离：本文件独立运行（同 addModelEndpointDefault.test.ts 纪律）。
 */
import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { providerManager, resolveCredentialId } from '../../src/services/models/providerManager'
import { modelInfoService, ModelInfoService } from '../../src/services/models/modelInfoService'
import { connectModels, type ConnectTransport } from '../../src/services/models/connectService'
import { CONNECT_PARAM_SCHEMA } from '../../src/services/models/connectSchema'
import { builtInToolDefinitions } from '../../src/services/builtInTools'
import { SecureStorageService } from '../../src/services/secureStorageService'
import { SelectedModelsService } from '../../src/services/selectedModelsService'
import type { IFileSystemProvider, FileSystemResult } from '../../src/interfaces/IFileSystemProvider'
import type { ISecureStorage } from '../../src/interfaces/ISecureStorage'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore'

const tmp = mkdtempSync(join(tmpdir(), 'chill-connect-'))
const modelsDir = join(tmp, 'models')
mkdirSync(modelsDir, { recursive: true })

/** 按路径子串注入写失败（P4 补偿测试用） */
let failPathContains: string | null = null
const renameCalls: Array<[string, string]> = []

const fsProvider: IFileSystemProvider = {
  async readFile(p: string): Promise<FileSystemResult> {
    try {
      return { success: true, data: readFileSync(p, 'utf-8') }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  },
  async writeFile(p: string, content: string): Promise<FileSystemResult> {
    if (failPathContains && p.includes(failPathContains)) {
      return { success: false, error: '磁盘写入失败（测试注入）' }
    }
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
  async renameFile(from: string, to: string): Promise<FileSystemResult> {
    try {
      renameSync(from, to)
      renameCalls.push([from, to])
      return { success: true }
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
SelectedModelsService.setDefaultStore(memKV)

test.after(() => { rmSync(tmp, { recursive: true, force: true }) })

/** 假传输层工厂：记录调用、可控行为 */
function fakeTransport(behavior: {
  listModels?: string[] | null | Error
  minimalAuth?: Error | null
  probe?: Record<string, any> | null
}): { transport: ConnectTransport; calls: { list: number; auth: string[]; probe: string[] } } {
  const calls = { list: 0, auth: [] as string[], probe: [] as string[] }
  const transport: ConnectTransport = {
    async listModels() {
      calls.list++
      if (behavior.listModels instanceof Error) throw behavior.listModels
      return behavior.listModels ?? null
    },
    async minimalChatAuth(_b, _k, apiModelId) {
      calls.auth.push(apiModelId)
      if (behavior.minimalAuth) throw behavior.minimalAuth
    },
    async probeCapabilities(_b, _k, apiModelId) {
      calls.probe.push(apiModelId)
      return behavior.probe ?? null
    },
  }
  return { transport, calls }
}

test('P2 探测解析：/models 命中 → 发现清单 + 能力标 probed', async () => {
  const { transport, calls } = fakeTransport({
    listModels: ['probe-up-1', 'other'],
    probe: { maxContextTokens: 222222, supportsThinking: true },
  })
  const outcome = await connectModels({
    provider: '小米MiMo',
    credential: 'sk-probe-1',
    identities: [{ apiModelId: 'probe-up-1' }],
    transport,
  })
  assert.equal(calls.list, 1, '应调用 /models 探测')
  assert.deepEqual(outcome.discovered, ['probe-up-1', 'other'])
  assert.equal(outcome.credentialAction, 'stored')
  assert.equal(calls.auth.length, 0, '/models 命中时不应走最小 chat 退化')
  assert.deepEqual(calls.probe, ['probe-up-1'])

  const card = modelInfoService.getModelInfoByName(outcome.bindings[0].name)!
  assert.equal(card.maxContextTokens, 222222, '探测值生效')
  assert.equal(card.capabilitySources?.maxContextTokens, 'probed')
  assert.equal(card.capabilitySources?.supportsThinking, 'probed')
  assert.equal(card.credentialRealm, 'xiaomi', 'sk- 形态定域到按量付费域（模板域）')
  await memStorage.deleteApiKey('xiaomi')
})

test('P2 退化：无 /models → 声明清单 + 最小 chat 鉴权', async () => {
  const { transport, calls } = fakeTransport({ listModels: null })
  const outcome = await connectModels({
    provider: '小米MiMo',
    credential: 'sk-degrade-1',
    baseURL: 'https://api.xiaomimimo.com/v1',
    identities: [{ apiModelId: 'degrade-up-1' }],
    transport,
  })
  assert.equal(calls.list, 1)
  assert.equal(outcome.discovered, null)
  assert.deepEqual(calls.auth, ['degrade-up-1'], '退化路径应发最小 chat 鉴权')
  assert.ok(modelInfoService.getModelInfoByName(outcome.bindings[0].name), '声明清单照常提交')
  await memStorage.deleteApiKey('xiaomi')
})

test('P2 鉴权失败：零残留（本次新写凭证清理、不注册）；复用凭证不动', async () => {
  // 新写凭证 + 鉴权被拒 → key 删除、无卡
  const { transport } = fakeTransport({ listModels: new Error('401：鉴权被拒，这可能是按量 key 被填到了 Token Plan 通道') })
  await assert.rejects(
    () => connectModels({
      provider: '小米MiMo',
      credential: 'sk-bad-1',
      identities: [{ apiModelId: 'bad-up-1' }],
      transport,
    }),
    /鉴权被拒/,
  )
  assert.ok(!memKeys.has('xiaomi'), '鉴权失败须清理本次新写凭证（零残留）')
  assert.ok(!existsSync(join(modelsDir, 'bad-up-1.json')), '不注册')
  assert.ok(!modelInfoService.getModelInfoByName('bad-up-1'), '内存零痕迹')

  // 既有凭证 + 鉴权被拒 → 凭证不动（不带走既有 key）
  await memStorage.storeApiKey('xiaomi', 'sk-preexisting')
  await assert.rejects(
    () => connectModels({
      provider: '小米MiMo',
      credential: 'sk-ignored',
      identities: [{ apiModelId: 'bad-up-2' }],
      transport,
    }),
    /鉴权被拒/,
  )
  assert.equal(memKeys.get('xiaomi'), 'sk-preexisting', '复用凭证不得被清理')
  await memStorage.deleteApiKey('xiaomi')
})

test('P1 复用：同域已有凭证 → 传入值忽略', async () => {
  await memStorage.storeApiKey('xiaomi', 'sk-original')
  const outcome = await connectModels({
    provider: '小米MiMo',
    credential: 'sk-should-be-ignored',
    identities: [{ apiModelId: 'reuse-up-1' }],
  })
  assert.equal(outcome.credentialAction, 'reused')
  assert.equal(memKeys.get('xiaomi'), 'sk-original', '传入凭证必须忽略（防误粘贴覆盖在用 key）')
  await memStorage.deleteApiKey('xiaomi')
})

test('匿名域：跳过 P1（无凭证也成功）', async () => {
  const outcome = await connectModels({
    provider: '本地厂商',
    anonymous: true,
    baseURL: 'http://127.0.0.1:11434/v1',
    protocol: 'openai-chat',
    identities: [{ apiModelId: 'local-up-1' }],
  })
  assert.equal(outcome.credentialAction, 'anonymous')
  assert.ok(!memKeys.has('本地厂商') && !memKeys.has('本地厂商'.toLowerCase()), '匿名域不得写凭证')
  const card = modelInfoService.getModelInfoByName(outcome.bindings[0].name)!
  assert.equal(resolveCredentialId(card), providerManager.idFor('本地厂商'))
})

test('P0 key 形态定域：tp- 形态 → Token Plan 域 + 域规范端点；形态与端点冲突拒绝', async () => {
  const outcome = await connectModels({
    provider: '小米MiMo',
    credential: 'tp-shape-1',
    identities: [{ apiModelId: 'shape-up-1' }],
  })
  const card = modelInfoService.getModelInfoByName(outcome.bindings[0].name)!
  assert.equal(card.credentialRealm, 'xiaomi#token-plan-cn.xiaomimimo.com/v1', 'key 形态定域（声明表），结果固化')
  assert.equal(card.adapterConfig?.baseURL, 'https://token-plan-cn.xiaomimimo.com/v1', '端点缺省取该域规范端点')
  assert.equal(card.displayName, 'shape-up-1', '单绑定显示名 = 身份标签')

  // 形态指向按量域、端点指向 Token Plan → 报错拒绝（防 key 填错通道）
  await assert.rejects(
    () => connectModels({
      provider: '小米MiMo',
      credential: 'sk-conflict-1',
      baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
      identities: [{ apiModelId: 'conflict-up-1' }],
    }),
    /疑似 key 填错通道/,
  )
  assert.ok(!modelInfoService.getModelInfoByName('conflict-up-1'), '冲突路径零痕迹')
})

test('P3 能力来源：catalog / declared 收敛与标记', async () => {
  // catalog：同厂商同身份的出厂种子（mimo-v2.6-pro）为能力来源（绑 Token Plan 域——模板域已有种子绑定）
  const outcome = await connectModels({
    provider: '小米MiMo',
    credential: 'tp-cat-1',
    identities: [{ apiModelId: 'mimo-v2.6-pro' }],
  })
  const card = modelInfoService.getModelInfoByName(outcome.bindings[0].name)!
  const seed = ModelInfoService.getBuiltInSeedModels().find(s => s.name === 'mimo-v2.6-pro')!
  assert.equal(card.credentialRealm, 'xiaomi#token-plan-cn.xiaomimimo.com/v1')
  assert.equal(card.maxContextTokens, seed.maxContextTokens, '目录能力值生效')
  assert.equal(card.supportsThinking, seed.supportsThinking)
  assert.equal(card.capabilitySources?.maxContextTokens, 'catalog')
  assert.equal(card.capabilitySources?.supportsThinking, 'catalog')
  assert.equal(card.capabilitySources?.supportedModalities, 'catalog')

  // 同身份同域重复连接 → 拒绝（绑定 = 身份 × 域）
  await assert.rejects(
    () => connectModels({
      provider: '小米MiMo',
      credential: 'tp-cat-1',
      identities: [{ apiModelId: 'mimo-v2.6-pro' }],
    }),
    /已有绑定/,
  )

  // declared：用户显式声明恒标 declared 且优先
  const outcome2 = await connectModels({
    provider: '小米MiMo',
    credential: 'sk-cat-2',
    baseURL: 'https://api.xiaomimimo.com/v1',
    identities: [{
      apiModelId: 'decl-up-1',
      capabilities: { max_context_tokens: 111111, supports_thinking: false, supported_modalities: 'text' },
    }],
  })
  const card2 = modelInfoService.getModelInfoByName(outcome2.bindings[0].name)!
  assert.equal(card2.maxContextTokens, 111111)
  assert.equal(card2.supportsThinking, false)
  assert.equal(card2.capabilitySources?.maxContextTokens, 'declared')
  assert.equal(card2.capabilitySources?.supportsThinking, 'declared')
  await memStorage.deleteApiKey('xiaomi')
  await memStorage.deleteApiKey('xiaomi#token-plan-cn.xiaomimimo.com/v1')
})

test('P4 失败补偿：第二张卡落盘失败 → 已落盘卡删除、凭证保留、内存零痕迹', async () => {
  failPathContains = 'comp-up-2'
  try {
    await assert.rejects(
      () => connectModels({
        provider: 'CompTestProv',
        credential: 'comp-key-1',
        baseURL: 'https://comp.example/v1',
        protocol: 'openai-chat',
        identities: [{ apiModelId: 'comp-up-1' }, { apiModelId: 'comp-up-2' }],
      }),
      /模型卡落盘失败/,
    )
  } finally {
    failPathContains = null
  }
  assert.ok(!existsSync(join(modelsDir, 'comp-up-1.json')), '已落盘卡应补偿删除')
  assert.ok(!existsSync(join(modelsDir, 'comp-up-2.json')), '失败卡无残留')
  assert.ok(!modelInfoService.getModelInfoByName('comp-up-1') && !modelInfoService.getModelInfoByName('comp-up-2'), '内存零痕迹')
  assert.equal(memKeys.get(providerManager.idFor('CompTestProv')), 'comp-key-1', '凭证保留（两向语义）')
  await memStorage.deleteApiKey(providerManager.idFor('CompTestProv'))
})

test('P4 tmp+rename 落盘（宿主实现 renameFile 时逐项原子写）', async () => {
  renameCalls.length = 0
  const outcome = await connectModels({
    provider: 'CompTestProv',
    credential: 'comp-key-2',
    baseURL: 'https://comp.example/v1',
    protocol: 'openai-chat',
    identities: [{ apiModelId: 'tmp-up-1' }],
  })
  const name = outcome.bindings[0].name
  assert.ok(existsSync(join(modelsDir, `${name}.json`)), '卡应落盘')
  assert.ok(renameCalls.some(([from, to]) => from.endsWith('.tmp') && to === join(modelsDir, `${name}.json`)), '应经 tmp+rename')
  const residue = readdirSync(modelsDir).filter(f => f.endsWith('.tmp'))
  assert.deepEqual(residue, [], '不得留 .tmp 残渣')
  await memStorage.deleteApiKey(providerManager.idFor('CompTestProv'))
})

test('connect schema ≡ add_model 工具定义字段集（防壳侧漂移）', () => {
  const addModelDef = builtInToolDefinitions.find(d => d.function.name === 'add_model')
  assert.ok(addModelDef, 'add_model 工具定义应存在')
  assert.deepEqual(
    Object.keys(addModelDef!.function.parameters.properties).sort(),
    Object.keys(CONNECT_PARAM_SCHEMA.properties).sort(),
    'connect schema 与 add_model 工具定义字段集必须一致（壳只做投影）',
  )
  assert.deepEqual(
    [...addModelDef!.function.parameters.required].sort(),
    [...CONNECT_PARAM_SCHEMA.required].sort(),
  )
})
