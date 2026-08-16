import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProviderManager, SEED_PROVIDERS } from '../../src/services/models/providerManager.ts'

/**
 * 合并测试·Collision（独立文件 = 独立子进程，与 Fresh 互不污染单例）：
 * 磁盘 providers.json 已有同名不同 id 条目（旧版 add_model 自建）与无 id 旧条目时：
 * - 名称感知抑制：不再叠加种子副本，一个显示名只有一个条目，磁盘条目优先；
 * - 旧条目无 id：按 LEGACY_PROVIDER_ID_MAP/slug 当场赋 id，不产生重复。
 */

function makeFsProvider() {
  return {
    readFile: async (p: string) => {
      try {
        return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } }
      } catch {
        return { success: false, error: '读取失败' }
      }
    },
    writeFile: async (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf-8')
      return { success: true }
    },
  } as any
}

test('Collision：同名不同 id 抑制种子副本；无 id 旧条目按映射归一', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-coll-'))
  try {
    // 场景：① 自建"DeepSeek"（id=deepseek-old，Key 文件挂在旧 id 上）② 无 id 的"智谱AI"（legacy map → zhipu）
    // ③ 纯自定义条目 ④ 一个与种子同 id 的条目（应保持磁盘内容不被覆盖）
    const persisted = [
      { name: 'DeepSeek', id: 'deepseek-old', builtIn: false },
      { name: '智谱AI', builtIn: false },
      { name: 'Kimi Code', id: 'kimicode', builtIn: false },
      { name: 'Moonshot AI', id: 'moonshot', builtIn: false },
    ]
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(persisted), 'utf-8')

    const pm = ProviderManager.getInstance()
    pm.setFileSystemProvider(makeFsProvider())
    pm.setProvidersDir(dir)
    await pm.loadProviders()

    const all = pm.getAllProviders()

    // 名称感知：DeepSeek 只剩磁盘条目（旧 id 优先，不叠加 zhipu 式的 deepseek 种子副本）
    const ds = all.filter(p => p.name === 'DeepSeek')
    assert.equal(ds.length, 1)
    assert.equal(ds[0].id, 'deepseek-old')

    // legacy map：无 id 的"智谱AI"归一到 zhipu（与种子同 id，磁盘内容不覆盖即同一份）
    const zhipuEntries = all.filter(p => p.name === '智谱AI')
    assert.equal(zhipuEntries.length, 1)
    assert.equal(zhipuEntries[0].id, 'zhipu')

    // 自定义条目保留
    assert.ok(all.some(p => p.id === 'kimicode'))

    // 无新增重复：总数 = 磁盘有效条目（4）+ 未占名/未占 id 的种子
    const seedNamesTaken = new Set(persisted.map(p => p.name))
    const expectedExtra = SEED_PROVIDERS.filter(s => !seedNamesTaken.has(s.name) && !(s.id === 'moonshot'))
    assert.equal(all.length, 4 + expectedExtra.length)

    // 同名归一后 resolveId/displayName 仍可用
    assert.equal(pm.resolveId('智谱AI'), 'zhipu')
    assert.equal(pm.getDisplayName('deepseek-old'), 'DeepSeek')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
