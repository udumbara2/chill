import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendLengthCapWarning } from '../../src/orchestrator/isolation/workers/lengthCapWarning.ts'

/** Worker 输出长度封顶的诚实标记（T3）：非空输出顶到 maxTokens → 尾部警告；未顶到 → 原样 */

test('appendLengthCapWarning: 未顶到配额原样返回', () => {
  assert.equal(appendLengthCapWarning('报告正文', 3999, 4000), '报告正文')
})

test('appendLengthCapWarning: 顶到配额尾部追加警告（含上限值与调大指引）', () => {
  const out = appendLengthCapWarning('被剪断的报告', 4000, 4000)
  assert.ok(out.startsWith('被剪断的报告'))
  assert.ok(out.includes('【警告】'))
  assert.ok(out.includes('4000'))
  assert.ok(out.includes('override_parameters.max_tokens'))
})
