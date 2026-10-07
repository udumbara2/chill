import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RelayLockArbiter,
  RELAY_LOCK_LEASE_MS,
  type RelayLockState,
  type RelayLockStore,
} from '../../src/services/relay/relayLock.ts'

/** 内存锁存储（测试用；生产的原子性由壳侧文件实现保证） */
function memStore(initial: RelayLockState | null = null) {
  let state = initial
  const store: RelayLockStore = {
    read: async () => state,
    write: async (s) => {
      state = s
    },
    remove: async () => {
      state = null
    },
  }
  return { store, get: () => state }
}

const T0 = 1_700_000_000_000

test('租约：无锁先抢得者跑；他端心跳鲜活时 held-by-other', async () => {
  const { store } = memStore()
  const a = new RelayLockArbiter(store, 'cli:1', () => T0)
  assert.equal(await a.tryAcquire(), 'acquired')
  const b = new RelayLockArbiter(store, 'electron:2', () => T0 + 1000)
  assert.equal(await b.tryAcquire(), 'held-by-other')
  assert.equal(await b.currentHolder(), 'cli:1')
})

test('租约：他端心跳过期 → 接管；接管后原主续约失败（应停传输）', async () => {
  const { store } = memStore({ owner: 'cli:1', heartbeatAt: T0 })
  const b = new RelayLockArbiter(store, 'electron:2', () => T0 + RELAY_LOCK_LEASE_MS + 1)
  assert.equal(await b.tryAcquire(), 'acquired')
  // 原主醒来续约：锁已被接管 → false
  const a = new RelayLockArbiter(store, 'cli:1', () => T0 + RELAY_LOCK_LEASE_MS + 2)
  assert.equal(await a.renew(), false)
  // 新主正常续约
  assert.equal(await b.renew(), true)
})

test('租约：release 只删自己的锁；他端持有时不误删', async () => {
  const { store, get } = memStore()
  const a = new RelayLockArbiter(store, 'cli:1', () => T0)
  await a.tryAcquire()
  const b = new RelayLockArbiter(store, 'electron:2', () => T0)
  await b.release() // b 不持有 → 不删
  assert.equal(get()?.owner, 'cli:1')
  await a.release()
  assert.equal(get(), null)
})

test('租约：currentHolder 对过期锁返回 null', async () => {
  const { store } = memStore({ owner: 'cli:1', heartbeatAt: T0 })
  const a = new RelayLockArbiter(store, 'cli:9', () => T0 + RELAY_LOCK_LEASE_MS)
  assert.equal(await a.currentHolder(), null)
})

test('接管：心跳鲜活但宿主探活判定锁主已死 → 立即接管（不等租约过期）', async () => {
  const { store } = memStore({ owner: 'cli:1', heartbeatAt: T0 })
  // 心跳仅 1s 前（远未过期），但探活返回 false
  const b = new RelayLockArbiter(store, 'cli:2', () => T0 + 1000, () => false)
  assert.equal(await b.tryAcquire(), 'acquired')
})

test('接管：心跳鲜活且锁主存活 → held-by-other（宁等勿抢）', async () => {
  const { store } = memStore({ owner: 'cli:1', heartbeatAt: T0 })
  const b = new RelayLockArbiter(store, 'cli:2', () => T0 + 1000, () => true)
  assert.equal(await b.tryAcquire(), 'held-by-other')
})

test('接管：未注入探活时心跳鲜活一律视为存活（安全缺省）', async () => {
  const { store } = memStore({ owner: 'cli:1', heartbeatAt: T0 })
  const b = new RelayLockArbiter(store, 'cli:2', () => T0 + 1000)
  assert.equal(await b.tryAcquire(), 'held-by-other')
})

test('接管：心跳过期时直接接管，无需探活（探活不被调用）', async () => {
  const { store } = memStore({ owner: 'cli:1', heartbeatAt: T0 })
  let probed = 0
  const b = new RelayLockArbiter(store, 'cli:2', () => T0 + RELAY_LOCK_LEASE_MS + 1, () => { probed++; return true })
  assert.equal(await b.tryAcquire(), 'acquired')
  assert.equal(probed, 0)
})

test('回读确认：写后被竞态方覆盖 → 按未获得处理（防双主）', async () => {
  // 模拟两个等待者交错：本端写入后、读回前，他端写入覆盖了 owner
  let state: RelayLockState | null = null
  const store: RelayLockStore = {
    read: async () => state,
    write: async (s) => {
      state = s
      // 模拟竞态：本端写完，他端紧跟着写（最后一次写赢）
      if (s.owner === 'cli:2') state = { owner: 'electron:3', heartbeatAt: s.heartbeatAt }
    },
    remove: async () => {
      state = null
    },
  }
  const b = new RelayLockArbiter(store, 'cli:2', () => T0)
  assert.equal(await b.tryAcquire(), 'held-by-other')
  assert.equal(state?.owner, 'electron:3')
})

test('重试策略：nextLeaseRetryMs 10s 起步、30s 封顶、抖动 ±20%', async () => {
  const { nextLeaseRetryMs } = await import('../../src/services/relay/relayLock.ts')
  // 零抖动下界（random=0 → ×0.8）
  assert.equal(nextLeaseRetryMs(0, () => 0), 8000)
  const v0 = nextLeaseRetryMs(0, () => 0.5)
  assert.ok(v0 >= 8000 && v0 <= 12_000)
  const v5 = nextLeaseRetryMs(5, () => 0.5)
  assert.ok(v5 >= 24_000 && v5 <= 36_000) // 封顶 30s × 抖动
})
