/**
 * selectedModelsService.test.ts — 「指针即入列」语义回归（2026-10-14 跨壳断链根治）。
 *
 * 根因背景：CLI 侧（首启向导 / /model switch）只写 current-model-name 不写 selected-models，
 * UI 聊天下拉列表独占读 selected-models——TUI 配好模型后打开桌面/Web UI 列表恒空、
 * 挂载自动恢复被 availableModels.some() 条件卡死。收口后语义：saveCurrentModelName
 * 查卡成功则 ensure-listed；查不到只写指针（不劣于旧版）。
 *
 * 用例：① 写指针即入列 ② 卡查不到只写指针 ③ 幂等 + 既有列表保留追加 ④ getCurrentModel 联动。
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SelectedModelsService } from '../../src/services/selectedModelsService'
import { modelInfoService } from '../../src/services/models/modelInfoService'
import { providerManager } from '../../src/services/models/providerManager'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore'
import type { IFileSystemProvider, FileSystemResult } from '../../src/interfaces/IFileSystemProvider'

const tmp = mkdtempSync(join(tmpdir(), 'chill-selected-models-'))
const modelsDir = join(tmp, 'models')
mkdirSync(modelsDir, { recursive: true })

// --- 空 fs 提供者（种子模型足够本测试；磁盘零依赖）---
const fsProvider: IFileSystemProvider = {
  async readFile(): Promise<FileSystemResult> { return { success: false, error: 'noop' } },
  async writeFile(): Promise<FileSystemResult> { return { success: true } },
  async deleteFile(): Promise<FileSystemResult> { return { success: true } },
  async listDirectory(): Promise<FileSystemResult> { return { success: true, data: [] } },
  getCurrentDirectory: () => null,
  async fileExists(): Promise<FileSystemResult<boolean>> { return { success: true, data: false } },
  async getPathType(): Promise<FileSystemResult<string>> { return { success: true, data: 'file' } },
}

// --- 内存 KV（绝不触碰 ~/.chill）---
const memKV: IKeyValueStore = {
  store: new Map<string, string>(),
  getItem(k: string) { return this.store.get(k) ?? null },
  setItem(k: string, v: string) { this.store.set(k, v) },
  removeItem(k: string) { this.store.delete(k) },
  clear() { this.store.clear() },
}

providerManager.setFileSystemProvider(fsProvider)
providerManager.setProvidersDir(modelsDir)
await providerManager.loadProviders()
modelInfoService.setFileSystemProvider(fsProvider)
modelInfoService.setModelsDir(modelsDir)
modelInfoService.setKeyValueStore(memKV)
await modelInfoService.loadAllModels()

const svc = SelectedModelsService.getInstance()
SelectedModelsService.setDefaultStore(memKV)

const SEED_MODEL = 'kimi-k3' // 内置种子卡（loadAllModels 必载）

test.after(() => { rmSync(tmp, { recursive: true, force: true }) })

test('① 写指针即入列：saveCurrentModelName 后 selected-models 含该模型', () => {
  memKV.clear()
  svc.saveCurrentModelName(SEED_MODEL)
  assert.equal(memKV.getItem('current-model-name'), SEED_MODEL)
  const list = JSON.parse(memKV.getItem('selected-models')!) as string[]
  assert.ok(list.includes(SEED_MODEL), `selected-models 应含 ${SEED_MODEL}，实际 ${JSON.stringify(list)}`)
})

test('② 卡查不到：只写指针，selected-models 不动（不劣于旧版）', () => {
  memKV.clear()
  svc.saveCurrentModelName('ghost-model-no-card')
  assert.equal(memKV.getItem('current-model-name'), 'ghost-model-no-card')
  assert.equal(memKV.getItem('selected-models'), null, '无卡不入列，列表键保持未写')
})

test('③ 幂等 + 既有列表保留追加', () => {
  memKV.clear()
  memKV.setItem('selected-models', JSON.stringify(['glm-5.3']))
  svc.saveCurrentModelName(SEED_MODEL)
  svc.saveCurrentModelName(SEED_MODEL) // 双写
  const list = JSON.parse(memKV.getItem('selected-models')!) as string[]
  assert.deepEqual(list, ['glm-5.3', SEED_MODEL], '既有项保留、新项恰一次追加')
})

test('④ 跨壳联动：getCurrentModel 解析指针为卡（UI 自动恢复的另一半）', async () => {
  memKV.clear()
  svc.saveCurrentModelName(SEED_MODEL)
  const card = svc.getCurrentModel()
  assert.ok(card, 'getCurrentModel 应解析出卡')
  assert.equal(card!.name, SEED_MODEL)
  const listed = svc.getSelectedModels()
  assert.ok(listed.some(m => m.name === SEED_MODEL), 'getSelectedModels（UI 下拉数据源）含当前模型——自动恢复条件成立')
})
