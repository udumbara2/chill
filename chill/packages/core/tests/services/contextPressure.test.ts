import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateContextPressure,
  DEFAULT_COMPACT_THRESHOLD,
} from '../../src/services/contextPressure.ts'

/**
 * contextPressure 纯函数单测：判定顺序短路（开关 → 实测 → 分母 → 阈值）与边界值。
 */

const base = {
  autoCompactEnabled: true,
  compactThreshold: DEFAULT_COMPACT_THRESHOLD,
}

test('压力达阈值：占用/窗口 > 0.8 → 触发', () => {
  const d = evaluateContextPressure({ ...base, lastUsage: { promptTokens: 8000, completionTokens: 100 }, maxContextTokens: 10000 })
  assert.equal(d.shouldCompact, true)
  assert.equal(d.reason, 'threshold-exceeded')
  assert.ok(d.ratio !== null && d.ratio > 0.8)
})

test('边界值：恰好 0.8 不触发（严格大于）', () => {
  const d = evaluateContextPressure({ ...base, lastUsage: { promptTokens: 7900, completionTokens: 100 }, maxContextTokens: 10000 })
  assert.equal(d.shouldCompact, false)
  assert.equal(d.reason, 'below-threshold')
})

test('开关关：不判定（即使满载）', () => {
  const d = evaluateContextPressure({ ...base, autoCompactEnabled: false, lastUsage: { promptTokens: 9999, completionTokens: 1 }, maxContextTokens: 10000 })
  assert.equal(d.shouldCompact, false)
  assert.equal(d.reason, 'disabled')
})

test('无实测用量（新会话/压缩后未回报）：不判定', () => {
  const d = evaluateContextPressure({ ...base, lastUsage: null, maxContextTokens: 10000 })
  assert.equal(d.shouldCompact, false)
  assert.equal(d.reason, 'no-usage')
})

test('窗口未登记（maxContextTokens undefined/0/负）：宁可不压不可盲压', () => {
  for (const max of [undefined, 0, -1]) {
    const d = evaluateContextPressure({ ...base, lastUsage: { promptTokens: 9999, completionTokens: 1 }, maxContextTokens: max })
    assert.equal(d.shouldCompact, false, `max=${max}`)
    assert.equal(d.reason, 'no-window')
  }
})

test('自定义阈值生效；非法阈值（0/负/超1）回退默认 0.8', () => {
  const custom = evaluateContextPressure({ ...base, compactThreshold: 0.5, lastUsage: { promptTokens: 6000, completionTokens: 0 }, maxContextTokens: 10000 })
  assert.equal(custom.shouldCompact, true)

  const illegal = evaluateContextPressure({ ...base, compactThreshold: 2, lastUsage: { promptTokens: 8500, completionTokens: 0 }, maxContextTokens: 10000 })
  assert.equal(illegal.shouldCompact, true, '回退 0.8 后 0.85 触发')
  const illegal2 = evaluateContextPressure({ ...base, compactThreshold: 0, lastUsage: { promptTokens: 8500, completionTokens: 0 }, maxContextTokens: 10000 })
  assert.equal(illegal2.shouldCompact, true, '回退 0.8 后 0.85 触发')
})
