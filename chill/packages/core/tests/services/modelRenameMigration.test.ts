/**
 * 出厂卡改名/退役的引用迁移（e2e）
 *
 * 覆盖场景：
 * 1. 引用改写：current-model-name / defaultEvaluatorModel / selected-models / model-parameters
 *    中的旧名 → 新名；退役卡名 → 承接卡名；数组保序去重、同名参数项合并保留首项
 * 2. 墓碑区分：改名跟着改（用户删过的卡位继续隐藏）；退役条目丢弃（不误隐藏新卡）
 * 3. 幂等与零副作用：无旧名引用时不改写任何键；重复执行结果不变
 * 4. 迁移后可解析：current-model-name 命中新卡；selected-models 无失效项、无重复
 *
 * 单例服务要求文件级子进程隔离：本文件独立运行（node --test 每文件独立进程）。
 */
import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { modelInfoService } from '../../src/services/models/modelInfoService'
import { providerManager } from '../../src/services/models/providerManager'
import type { IFileSystemProvider, FileSystemResult } from '../../src/interfaces/IFileSystemProvider'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore'

const tmp = mkdtempSync(join(tmpdir(), 'chill-model-rename-'))
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

test.after(() => { rmSync(tmp, { recursive: true, force: true }) })

test('B1 引用改写：改名与退役两类映射、保序去重、参数合并保留首项', async () => {
  memKV.clear()
  memKV.setItem('current-model-name', 'deepseek-v4-flash')
  memKV.setItem('defaultEvaluatorModel', 'deepseek-v4-flash')
  memKV.setItem('selected-models', JSON.stringify(['deepseek-v4-flash', 'deepseek-v4-pro', 'kimi-k3']))
  memKV.setItem('model-parameters', JSON.stringify([
    { modelName: 'deepseek-v4-flash', parameters: { max_tokens: 16000 } },
    { modelName: 'deepseek-v4-pro', parameters: { temperature: 1 } },
    { modelName: 'kimi-k3', parameters: {} }
  ]))

  await modelInfoService.loadAllModels()

  assert.equal(memKV.getItem('current-model-name'), 'deepseek-flash', '改名卡引用应改写')
  assert.equal(memKV.getItem('defaultEvaluatorModel'), 'deepseek-flash', '字符串键同类改写')
  assert.deepEqual(
    JSON.parse(memKV.getItem('selected-models')!),
    ['deepseek-flash', 'kimi-k3'],
    '退役并入新卡 + 保序去重'
  )
  const params = JSON.parse(memKV.getItem('model-parameters')!)
  assert.deepEqual(params.map((p: { modelName: string }) => p.modelName), ['deepseek-flash', 'kimi-k3'], '同名合并保留首项 + 保序')
  assert.deepEqual(params[0].parameters, { max_tokens: 16000 }, '保留首项的参数设置')
})

test('B2 墓碑：改名跟着改，退役条目丢弃', async () => {
  memKV.clear()
  memKV.setItem('deletedSeedModels', JSON.stringify(['deepseek-v4-flash', 'deepseek-v4-pro']))

  await modelInfoService.loadAllModels()

  assert.deepEqual(modelInfoService.getDeletedSeedModels(), ['deepseek-flash'], '改名跟改、退役丢弃')
  assert.equal(modelInfoService.getModelInfoByName('deepseek-flash'), undefined, '用户删过的卡位改名后继续隐藏')
  assert.ok(modelInfoService.getModelInfoByName('kimi-k3'), '无关卡不受影响')

  memKV.removeItem('deletedSeedModels')
  await modelInfoService.loadAllModels()
  assert.ok(modelInfoService.getModelInfoByName('deepseek-flash'), '墓碑清除后新卡露出')
})

test('B3 幂等与零副作用：无旧名引用时不改写任何键', async () => {
  memKV.clear()
  memKV.setItem('current-model-name', 'kimi-k3')
  memKV.setItem('selected-models', JSON.stringify(['kimi-k3', 'deepseek-flash']))
  const cur = memKV.getItem('current-model-name')
  const sel = memKV.getItem('selected-models')

  await modelInfoService.loadAllModels()
  assert.equal(memKV.getItem('current-model-name'), cur, '无旧名时不改写')
  assert.equal(memKV.getItem('selected-models'), sel, '无旧名时不改写')

  await modelInfoService.loadAllModels()
  assert.equal(memKV.getItem('selected-models'), sel, '重复执行结果不变')
})

test('B4 迁移后可解析：当前模型命中新卡、选中列表无失效无重复', async () => {
  memKV.clear()
  memKV.setItem('current-model-name', 'deepseek-v4-flash')
  memKV.setItem('selected-models', JSON.stringify(['deepseek-v4-flash', 'deepseek-v4-pro']))

  await modelInfoService.loadAllModels()

  const cur = memKV.getItem('current-model-name')!
  assert.ok(modelInfoService.getModelInfoByName(cur), `当前模型 ${cur} 应能解析到卡`)

  const names: string[] = JSON.parse(memKV.getItem('selected-models')!)
  assert.deepEqual(names, ['deepseek-flash'], '两项旧名引用合并为一项')
  for (const n of names) {
    assert.ok(modelInfoService.getModelInfoByName(n), `${n} 应能解析到卡（无失效条目）`)
  }
  assert.equal(new Set(names).size, names.length, '无重复项')
})
