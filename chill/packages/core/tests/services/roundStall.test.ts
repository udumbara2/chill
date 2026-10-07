import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickStalledRounds, ROUND_STALL_MS, type RoundActivitySnapshot } from '../../src/services/sessionRegistry/roundStall.ts'

/** F-3（迭代 F）轮次停滞判定：isRunning × 零进展超阈值 */

const NOW = 1_000_000_000_000

function snap(over: Partial<RoundActivitySnapshot> & { sessionId: string }): RoundActivitySnapshot {
  return { isRunning: true, lastActivityAt: NOW - ROUND_STALL_MS - 1, ...over }
}

test('停滞判定：running 且零进展超阈值 → 报；非 running / 有进展 → 不报', () => {
  const out = pickStalledRounds(
    [
      snap({ sessionId: 'stalled' }),
      snap({ sessionId: 'fresh', lastActivityAt: NOW - 1000 }),
      snap({ sessionId: 'idle', isRunning: false }),
    ],
    { now: NOW },
  )
  assert.deepEqual(out, ['stalled'])
})

test('阈值边界与自定义阈值', () => {
  const atBoundary = NOW - ROUND_STALL_MS
  assert.deepEqual(
    pickStalledRounds([snap({ sessionId: 'edge', lastActivityAt: atBoundary })], { now: NOW }),
    ['edge'],
    '恰达阈值即报（≥语义）',
  )
  assert.deepEqual(
    pickStalledRounds([snap({ sessionId: 'custom', lastActivityAt: NOW - 5000 })], { now: NOW, stallMs: 5000 }),
    ['custom'],
    '自定义阈值生效',
  )
})
