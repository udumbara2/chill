import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextKillChordState, KILL_CHORD_CONFIRM_MS } from '../../src/utils/killChord.ts'

test('双击确认: 首次触发 → arm，确认窗 = now + 3000', () => {
  const r = nextKillChordState(null, 10000)
  assert.equal(r.action, 'arm')
  assert.equal(r.confirmUntil, 10000 + KILL_CHORD_CONFIRM_MS)
})

test('双击确认: 确认窗内第二次 → confirm，窗作废', () => {
  const armed = nextKillChordState(null, 10000)
  const r = nextKillChordState(armed.confirmUntil, 11000)
  assert.equal(r.action, 'confirm')
  assert.equal(r.confirmUntil, null)
})

test('双击确认: 确认窗过期后触发 → 视为新的 arm', () => {
  const armed = nextKillChordState(null, 10000)
  const r = nextKillChordState(armed.confirmUntil, 10000 + KILL_CHORD_CONFIRM_MS + 1)
  assert.equal(r.action, 'arm')
  assert.equal(r.confirmUntil, 10000 + KILL_CHORD_CONFIRM_MS + 1 + KILL_CHORD_CONFIRM_MS)
})

test('双击确认: 边界值 now == confirmUntil 仍算窗内（confirm）', () => {
  const armed = nextKillChordState(null, 10000)
  const r = nextKillChordState(armed.confirmUntil, armed.confirmUntil!)
  assert.equal(r.action, 'confirm')
})

test('双击确认: confirm 后再次触发 → 重新 arm（状态自复位）', () => {
  const armed = nextKillChordState(null, 10000)
  const confirmed = nextKillChordState(armed.confirmUntil, 11000)
  const r = nextKillChordState(confirmed.confirmUntil, 12000)
  assert.equal(r.action, 'arm')
})
