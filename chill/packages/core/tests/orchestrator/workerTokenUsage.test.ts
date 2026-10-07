import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTokenUsage } from '../../src/orchestrator/isolation/workers/workerTokenUsage.ts'
import type { ModelResponse } from '../../src/types/models.ts'

test('cumulativeUsage 优先:累计量纲出账(多轮聚合,非末轮假精确)', () => {
  const r = buildTokenUsage({
    content: 'ok',
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }, // 末轮
    cumulativeUsage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 }, // 累计
  } as ModelResponse)
  assert.deepEqual(r, { input: 300, output: 150, total: 450 })
})

test('estimated 透传:估值累计 → tokenUsage.estimated=true', () => {
  const r = buildTokenUsage({
    content: 'ok',
    cumulativeUsage: { promptTokens: 30, completionTokens: 15, totalTokens: 45, estimated: true },
  } as ModelResponse)
  assert.deepEqual(r, { input: 30, output: 15, total: 45, estimated: true })
})

test('cumulativeUsage 缺失(asyncTask 不计量)回退末轮 usage(现状语义)', () => {
  const r = buildTokenUsage({
    content: 'ok',
    usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
  } as ModelResponse)
  assert.deepEqual(r, { input: 7, output: 3, total: 10 })
})

test('两者皆无 → 全 0(无 estimated 标记)', () => {
  const r = buildTokenUsage({ content: 'ok' } as ModelResponse)
  assert.deepEqual(r, { input: 0, output: 0, total: 0 })
})
