import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProviderManager, SEED_PROVIDERS } from '../../src/services/models/providerManager.ts'

/**
 * 合并测试·Fresh（独立文件 = 独立 node --test 子进程，规避单例状态串场）：
 * 空目录（新装用户）loadProviders 后，Map 应恰好是种子全集，不落盘。
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

test('Fresh：空目录加载后 = 种子全集，且不写盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fresh-'))
  try {
    const pm = ProviderManager.getInstance()
    pm.setFileSystemProvider(makeFsProvider())
    pm.setProvidersDir(dir)
    await pm.loadProviders()

    const all = pm.getAllProviders()
    assert.equal(all.length, SEED_PROVIDERS.length)
    for (const seed of SEED_PROVIDERS) {
      assert.deepEqual(pm.getProvider(seed.id), seed, `${seed.id} 应与种子一致`)
    }
    // 空目录加载不主动落盘（providers.json 由 addProvider/迁移路径创建）
    assert.equal(fs.existsSync(path.join(dir, 'providers.json')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
