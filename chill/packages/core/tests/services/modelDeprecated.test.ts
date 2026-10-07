/**
 * 退役两阶段（deprecated）e2e（迭代 4 验收）
 *
 * 覆盖场景：
 * 1. deprecated 卡注册可用、可显式命中；未被选中键引用时不物化、不落盘
 * 2. 物化移交：current-model-name 引用 → 落盘 builtIn:false 自包含副本
 * 3. 物化移交扫描其余选中键（selected-models / model-parameters / default*Model）
 * 4. 磁盘已有同名用户文件 → 跳过（不覆盖用户数据）
 * 5. 墓碑名单中的 deprecated 卡 → 不物化
 * 6. 二次启动幂等：物化副本不被影子迁移删除、不被改写
 * 7. 阶段二模拟（临时移除种子卡）：已物化用户不受影响；未物化卡干净消失
 *
 * deprecated 种子卡通过临时替换 ModelInfoService.getBuiltInSeedModels 静态方法模拟
 * （机制测试，不动 modelSeeds.ts——当前出厂卡无一标记）。
 * 单例服务要求文件级子进程隔离：本文件独立运行，不与其他场景共用进程。
 */
import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { ModelInfoService, modelInfoService } from '../../src/services/models/modelInfoService'
import { providerManager } from '../../src/services/models/providerManager'
import type { IFileSystemProvider, FileSystemResult } from '../../src/interfaces/IFileSystemProvider'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore'

const tmp = mkdtempSync(join(tmpdir(), 'chill-deprecated-e2e-'))
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

// --- 内存 KV Store（绝不触碰 ~/.chill）---
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

// --- 种子卡临时改造辅助（各测试用例用后即恢复，互不影响）---
const originalGetSeeds = ModelInfoService.getBuiltInSeedModels

/** 临时给指定种子卡打 deprecated 标记（模拟退役阶段一）；返回恢复函数 */
function markSeedDeprecated(...names: string[]): () => void {
  ;(ModelInfoService as any).getBuiltInSeedModels = () =>
    originalGetSeeds().map(m => (names.includes(m.name) ? { ...m, deprecated: true } : m))
  return () => { ;(ModelInfoService as any).getBuiltInSeedModels = originalGetSeeds }
}

/** 临时从种子移除指定卡（模拟退役阶段二）；返回恢复函数 */
function removeSeeds(...names: string[]): () => void {
  ;(ModelInfoService as any).getBuiltInSeedModels = () =>
    originalGetSeeds().filter(m => !names.includes(m.name))
  return () => { ;(ModelInfoService as any).getBuiltInSeedModels = originalGetSeeds }
}

test.after(() => { rmSync(tmp, { recursive: true, force: true }) })

test('deprecated 卡注册可用、可显式命中；未被选中键引用时不物化', async () => {
  const restore = markSeedDeprecated('deepseek-flash')
  await modelInfoService.loadAllModels()
  restore()

  const m = modelInfoService.getModelInfoByName('deepseek-flash')
  assert.ok(m, 'deprecated 卡仍注册进内存视图（getModelInfoByName 显式命中）')
  assert.equal(m!.deprecated, true)
  assert.equal(m!.builtIn, true, '未被引用时不出让所有权')
  assert.ok(!existsSync(join(modelsDir, 'deepseek-flash.json')), '未被引用时不落盘')
})

test('物化移交：current-model-name 引用 deprecated 卡 → 落盘 builtIn:false 自包含副本', async () => {
  memKV.setItem('current-model-name', 'kimi-k2.7-code')
  const restore = markSeedDeprecated('kimi-k2.7-code')
  await modelInfoService.loadAllModels()
  restore()
  memKV.removeItem('current-model-name')

  const p = join(modelsDir, 'kimi-k2.7-code.json')
  assert.ok(existsSync(p), '选中键引用的 deprecated 卡应物化落盘')
  const card = JSON.parse(readFileSync(p, 'utf-8'))
  assert.equal(card.builtIn, false, '物化副本归用户所有')
  assert.equal(card.deprecated, true, '退役标记随副本保留')
  // 副本自包含：折叠后的厂商级字段都在卡上（阶段二种子移除后仍可用）
  assert.equal(card.adapterConfig.baseURL, 'https://api.moonshot.cn/v1')
  assert.equal(card.adapterConfig.protocol, 'openai-chat')

  const mem = modelInfoService.getModelInfoByName('kimi-k2.7-code')!
  assert.equal(mem.builtIn, false, '内存视图同步为用户副本')
})

test('物化移交扫描其余选中键：selected-models / model-parameters / defaultEvaluatorModel', async () => {
  memKV.setItem('selected-models', JSON.stringify(['qwen3.8-max']))
  memKV.setItem('model-parameters', JSON.stringify([{ modelName: 'qwen3.8-2.4t-a95b', parameters: { temperature: 0.5 } }]))
  memKV.setItem('defaultEvaluatorModel', 'MiniMax-M3')
  const restore = markSeedDeprecated('qwen3.8-max', 'qwen3.8-2.4t-a95b', 'MiniMax-M3')
  await modelInfoService.loadAllModels()
  restore()
  memKV.removeItem('selected-models')
  memKV.removeItem('model-parameters')
  memKV.removeItem('defaultEvaluatorModel')

  for (const n of ['qwen3.8-max', 'qwen3.8-2.4t-a95b', 'MiniMax-M3']) {
    assert.ok(existsSync(join(modelsDir, `${n}.json`)), `${n} 应物化落盘`)
    const card = JSON.parse(readFileSync(join(modelsDir, `${n}.json`), 'utf-8'))
    assert.equal(card.builtIn, false)
  }
})

test('磁盘已有同名用户文件 → 跳过物化（不覆盖用户数据）', async () => {
  const seed = originalGetSeeds().find(m => m.name === 'kimi-k3')!
  const userCard = { ...seed, builtIn: false, displayName: '用户自管的 K3', maxOutputTokens: 9999 }
  writeFileSync(join(modelsDir, 'kimi-k3.json'), JSON.stringify(userCard, null, 2))

  memKV.setItem('current-model-name', 'kimi-k3')
  const restore = markSeedDeprecated('kimi-k3')
  await modelInfoService.loadAllModels()
  restore()
  memKV.removeItem('current-model-name')

  const after = JSON.parse(readFileSync(join(modelsDir, 'kimi-k3.json'), 'utf-8'))
  assert.equal(after.displayName, '用户自管的 K3', '已有用户文件不被物化覆盖')
  assert.equal(after.maxOutputTokens, 9999)
  assert.equal(modelInfoService.getModelInfoByName('kimi-k3')!.displayName, '用户自管的 K3', '内存视图为用户卡（用户层赢）')

  // 清理：恢复出厂露出，不影响后续用例
  unlinkSync(join(modelsDir, 'kimi-k3.json'))
  await modelInfoService.reloadFromDisk()
})

test('墓碑名单中的 deprecated 卡 → 不物化', async () => {
  modelInfoService.addDeletedSeedModel('glm-5.3')
  memKV.setItem('selected-models', JSON.stringify(['glm-5.3']))
  const restore = markSeedDeprecated('glm-5.3')
  await modelInfoService.loadAllModels()
  restore()
  memKV.removeItem('selected-models')

  assert.equal(modelInfoService.getModelInfoByName('glm-5.3'), undefined, '墓碑过滤优先：不进内存视图')
  assert.ok(!existsSync(join(modelsDir, 'glm-5.3.json')), '墓碑中的卡不物化')

  // 清理墓碑，不影响后续用例
  memKV.removeItem('deletedSeedModels')
})

test('二次启动幂等：物化副本不被影子迁移删除、不被改写', async () => {
  // kimi-k2.7-code 在前述用例已物化；此时无选中键引用。
  // 种子再次标记 deprecated 时，副本内容与种子一致（仅 builtIn 不同）——
  // 若无 migrateBuiltInFiles 的 deprecated 守卫，副本会被影子迁移误删
  const p = join(modelsDir, 'kimi-k2.7-code.json')
  const before = readFileSync(p, 'utf-8')

  const restore = markSeedDeprecated('kimi-k2.7-code')
  await modelInfoService.loadAllModels()
  restore()

  assert.ok(existsSync(p), 'deprecated 出厂卡的物化副本不被影子迁移删除')
  assert.equal(readFileSync(p, 'utf-8'), before, '二次启动不改写物化副本')
  assert.equal(modelInfoService.getModelInfoByName('kimi-k2.7-code')!.builtIn, false)
})

test('阶段二模拟（临时移除种子卡）：已物化用户不受影响；未物化卡干净消失', async () => {
  // kimi-k2.7-code 已物化（副本自包含）；deepseek-flash 曾标记 deprecated 但从未物化
  const restore = removeSeeds('kimi-k2.7-code', 'deepseek-flash')
  await modelInfoService.loadAllModels()
  restore()

  const m = modelInfoService.getModelInfoByName('kimi-k2.7-code')
  assert.ok(m, '种子移除后物化副本从磁盘加载，用户不报「模型未注册」')
  assert.equal(m!.builtIn, false)
  assert.equal(m!.adapterConfig!.baseURL, 'https://api.moonshot.cn/v1', '副本自包含，不依赖种子/profile')

  assert.equal(modelInfoService.getModelInfoByName('deepseek-flash'), undefined, '未物化卡随种子移除干净消失')

  // 种子恢复后 deepseek-flash 重新露出（出厂层从未被改动）
  await modelInfoService.loadAllModels()
  assert.equal(modelInfoService.getModelInfoByName('deepseek-flash')!.builtIn, true)

  // 清理物化副本
  unlinkSync(join(modelsDir, 'kimi-k2.7-code.json'))
  await modelInfoService.reloadFromDisk()
})
