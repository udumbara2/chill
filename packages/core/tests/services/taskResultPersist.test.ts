import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adoptTaskResult,
  setTaskResultPersister,
  TASK_RESULT_INLINE_LIMIT_BYTES,
} from '../../src/services/delegation/delegationTools.ts'

/**
 * 委派结果兜底（T2）：adoptTaskResult 四态——
 * 未超限直通 / 超限落盘+信封 / 未注册 persister 直通 / persister 抛异常直通。
 * 铁律：任何分支都不丢数据，写盘绝不能影响任务执行。
 */

/** 必超限的大文本（'长' UTF-8 3 字节/字） */
const bigText = () => '长'.repeat(TASK_RESULT_INLINE_LIMIT_BYTES)

test('adoptTaskResult: 未超限原样直通（即使已注册 persister）', (t) => {
  t.after(() => setTaskResultPersister(null))
  setTaskResultPersister(() => '/tmp/x.md')
  assert.equal(adoptTaskResult('tc-1', '短文本'), '短文本')
})

test('adoptTaskResult: 超限且已注册 persister → 落盘全文 + 信封（路径 + 预览 + read_file 指引）', (t) => {
  t.after(() => setTaskResultPersister(null))
  const big = bigText()
  const saved: Array<[string, string]> = []
  setTaskResultPersister((id, text) => {
    saved.push([id, text])
    return '/home/u/.chill/task-results/1-tc-1.md'
  })
  const out = adoptTaskResult('tc-1', big)
  assert.equal(saved.length, 1)
  assert.equal(saved[0][0], 'tc-1')
  assert.equal(saved[0][1], big, '落盘内容为完整全文')
  assert.ok(out.includes('【结果全文已保存】'))
  assert.ok(out.includes('/home/u/.chill/task-results/1-tc-1.md'))
  assert.ok(out.includes('read_file'))
  assert.ok(out.length < big.length, '信封远小于全文')
})

test('adoptTaskResult: 超限但未注册 persister → 直通全文（宁可占上下文，永不丢数据）', (t) => {
  t.after(() => setTaskResultPersister(null))
  setTaskResultPersister(null)
  const big = bigText()
  assert.equal(adoptTaskResult('tc-1', big), big)
})

test('adoptTaskResult: persister 抛异常 → 直通全文（写盘绝不能影响任务执行）', (t) => {
  t.after(() => setTaskResultPersister(null))
  setTaskResultPersister(() => {
    throw new Error('disk full')
  })
  const big = bigText()
  assert.equal(adoptTaskResult('tc-1', big), big)
})
