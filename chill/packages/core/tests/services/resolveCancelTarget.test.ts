import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTaskCancelTarget, type CancelTargetCandidate } from '../../src/services/delegation/resolveCancelTarget.ts'

const RUNNING: CancelTargetCandidate[] = [
  { toolCallId: 'tc-aaa', taskId: 'task-alpha', subagentType: 'code-reviewer', description: '审查 src/' },
  { toolCallId: 'tc-bbb', taskId: 'task-beta', subagentType: 'document-writer', description: '撰写文档' },
  { toolCallId: 'tc-ccc', taskId: 'task-gamma', subagentType: 'reviewer', description: '评审结果' },
]

test('寻址: 序号命中（1 起的 running 行号）', () => {
  const r = resolveTaskCancelTarget(RUNNING, '2')
  assert.deepEqual(r, { ok: true, toolCallId: 'tc-bbb' })
})

test('寻址: 序号越界 → 报错并提示实时清单', () => {
  const r = resolveTaskCancelTarget(RUNNING, '5')
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.error.includes('共 3 个'))
})

test('寻址: taskId 唯一前缀命中', () => {
  const r = resolveTaskCancelTarget(RUNNING, 'task-al')
  assert.deepEqual(r, { ok: true, toolCallId: 'tc-aaa' })
})

test('寻址: toolCallId 唯一前缀命中', () => {
  const r = resolveTaskCancelTarget(RUNNING, 'tc-cc')
  assert.deepEqual(r, { ok: true, toolCallId: 'tc-ccc' })
})

test('寻址: 前缀不存在 → 明确报错', () => {
  const r = resolveTaskCancelTarget(RUNNING, 'nope')
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.error.includes('未找到'))
})

test('寻址: 前缀不唯一 → 报错并列出候选', () => {
  const r = resolveTaskCancelTarget(RUNNING, 'task-')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.ok(r.error.includes('3 个'))
    assert.ok(r.error.includes('code-reviewer'))
    assert.ok(r.error.includes('document-writer'))
  }
})

test('寻址: 空目标 → 用法提示', () => {
  const r = resolveTaskCancelTarget(RUNNING, '  ')
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.error.includes('/tasks cancel'))
})

test('寻址: 空 running 列表 → 序号与前缀都报无可取消', () => {
  assert.equal(resolveTaskCancelTarget([], '1').ok, false)
  assert.equal(resolveTaskCancelTarget([], 'task-x').ok, false)
})
