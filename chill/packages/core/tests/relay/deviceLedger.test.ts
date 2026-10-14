import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NodeDeviceStore,
  defaultDevicesPath,
} from '../../src/implementations/relayNodeRuntime.ts'
import { PairingManager, type PairedDevice, type DeviceStore } from '../../src/services/relay/PairingManager.ts'

/**
 * 《配对账本单源化》M1.4：NodeDeviceStore 行为钉死 + F7 fail-loud。
 * （遗留迁移已按用户 2026-10-13 裁定整体撤销——存量机从零安装重配，无迁移矩阵。）
 */

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'chill-ledger-'))
}

test('NodeDeviceStore：写读回环（tmp+rename 原子写，全量替换）', async () => {
  const home = freshHome()
  try {
    const store = new NodeDeviceStore(defaultDevicesPath(home))
    assert.deepEqual(await store.read(), [], '无文件 → 空')
    const d: PairedDevice = { phonePub: 'pub-1', device: 'Phone', pairedAt: '2026-10-12T00:00:00.000Z' }
    await store.write([d])
    assert.deepEqual(await store.read(), [d])
    const d2: PairedDevice = { phonePub: 'pub-2', device: 'Phone2', pairedAt: '2026-10-13T00:00:00.000Z' }
    await store.write([d2])
    assert.deepEqual(await store.read(), [d2], '重配对=替换（单设备语义）')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('NodeDeviceStore：read 对非数组/损坏文件返回空（自愈面：重配对覆写重建）', async () => {
  const home = freshHome()
  try {
    mkdirSync(join(home, 'relay'), { recursive: true })
    writeFileSync(defaultDevicesPath(home), '{"a":1}', 'utf8') // 非数组
    const store = new NodeDeviceStore(defaultDevicesPath(home))
    assert.deepEqual(await store.read(), [])
    writeFileSync(defaultDevicesPath(home), 'not-json', 'utf8') // 损坏
    assert.deepEqual(await store.read(), [])
    // 垃圾条目（缺 phonePub）被形状过滤剔除
    writeFileSync(defaultDevicesPath(home), JSON.stringify([{ device: 'X' }]), 'utf8')
    assert.deepEqual(await store.read(), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------- F7：配对路径持久化 fail-loud ----------

function fakeSecureStorage(ok: boolean) {
  const stored = new Map<string, string>()
  return {
    stored,
    impl: {
      storeApiKey: async (_p: string, k: string) => {
        if (ok) stored.set(_p, k)
        return ok
      },
      getApiKey: async (p: string) => stored.get(p) ?? null,
      hasApiKey: async (p: string) => stored.has(p),
      deleteApiKey: async (p: string) => (stored.delete(p), true),
      getAllProviders: async () => [...stored.keys()],
    },
  }
}

function memDeviceStore(): DeviceStore & { data: PairedDevice[] } {
  return {
    data: [] as PairedDevice[],
    async read() {
      return this.data
    },
    async write(d: PairedDevice[]) {
      this.data = d
    },
  }
}

test('F7：completePairing 令牌写失败 → 抛错（不再静默）', async () => {
  const pm = new PairingManager({ secureStorage: fakeSecureStorage(false).impl, deviceStore: memDeviceStore() })
  await assert.rejects(
    () => pm.completePairing('pub-1', 'Phone', 'tok-1'),
    /配对令牌写入安全存储失败/,
  )
})

test('F7：savePairingToken 写失败 → 抛错', async () => {
  const pm = new PairingManager({ secureStorage: fakeSecureStorage(false).impl, deviceStore: memDeviceStore() })
  await assert.rejects(() => pm.savePairingToken('tok-1'), /配对令牌写入安全存储失败/)
})

test('F7：成功路径——令牌落库、设备清单替换（单设备语义）', async () => {
  const sec = fakeSecureStorage(true)
  const ds = memDeviceStore()
  const pm = new PairingManager({ secureStorage: sec.impl, deviceStore: ds })
  await pm.completePairing('pub-1', 'Phone', 'tok-1')
  assert.deepEqual(ds.data, [{ phonePub: 'pub-1', device: 'Phone', pairedAt: ds.data[0]!.pairedAt }])
  assert.equal(await pm.getPairingToken(), 'tok-1')
})
