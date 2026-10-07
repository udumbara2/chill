import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickEvictableSessions,
  IDLE_EVICTION_IDLE_MS,
  type EngineIdleSnapshot,
} from '../../src/services/sessionRegistry/idleEviction.ts'

/** M2.1（多会话并行规划）闲置回收判定：三重守卫 + 阈值 + 软帽 LRU 补选 */

const NOW = 1_000_000_000_000

function snap(over: Partial<EngineIdleSnapshot> & { sessionId: string }): EngineIdleSnapshot {
  return { isActive: false, isRunning: false, runningTaskCount: 0, idleSince: NOW - IDLE_EVICTION_IDLE_MS - 1, ...over }
}

test('三重守卫：活跃/在途轮/有任务的会话永不回收', () => {
  const out = pickEvictableSessions(
    [
      snap({ sessionId: 'active' , isActive: true }),
      snap({ sessionId: 'running', isRunning: true }),
      snap({ sessionId: 'tasks', runningTaskCount: 2 }),
      snap({ sessionId: 'idle-ok' }),
    ],
    { now: NOW },
  )
  assert.deepEqual(out, ['idle-ok'])
})

test('阈值：未到 30min 的闲置不回收（LRU 序：最旧在前）', () => {
  const out = pickEvictableSessions(
    [
      snap({ sessionId: 'young', idleSince: NOW - 1000 }),
      snap({ sessionId: 'old', idleSince: NOW - IDLE_EVICTION_IDLE_MS * 3 }),
      snap({ sessionId: 'mid', idleSince: NOW - IDLE_EVICTION_IDLE_MS - 5000 }),
    ],
    { now: NOW },
  )
  assert.deepEqual(out, ['old', 'mid'], '到期者按 idleSince 升序（LRU）')
})

test('软帽：超帽时从守卫全过的未到期闲置里 LRU 补选；守卫不过者仍不入内', () => {
  const out = pickEvictableSessions(
    [
      snap({ sessionId: 'active', isActive: true }),
      snap({ sessionId: 'busy', isRunning: true }),
      snap({ sessionId: 'expired', idleSince: NOW - IDLE_EVICTION_IDLE_MS * 2 }),
      snap({ sessionId: 'unexpired-old', idleSince: NOW - 10 * 60 * 1000 }),
      snap({ sessionId: 'unexpired-new', idleSince: NOW - 1000 }),
      snap({ sessionId: 'unexpired-mid', idleSince: NOW - 5 * 60 * 1000 }),
    ],
    { now: NOW, maxEngines: 4 },
  )
  // 总 6 > 帽 4 → 需回收 2：expired 到期必收；补选 1 = unexpired 中最旧（unexpired-old）
  assert.deepEqual(out, ['expired', 'unexpired-old'])
})

test('无到期且未超帽 → 空集；超帽但守卫全过者耗尽 → 尽力而为', () => {
  assert.deepEqual(pickEvictableSessions([snap({ sessionId: 'a', idleSince: NOW - 1 })], { now: NOW }), [])
  const out = pickEvictableSessions(
    [
      snap({ sessionId: 'busy', isRunning: true }),
      snap({ sessionId: 'young', idleSince: NOW - 1 }),
    ],
    { now: NOW, maxEngines: 1 },
  )
  assert.deepEqual(out, ['young'], '超帽且无到期 → 未到期闲置按 LRU 补选；busy 永不入内')
})
